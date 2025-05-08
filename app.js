const net = require('net');
const WebSocket = require('ws');
const crypto = require('crypto');

const RELAY_LISTEN_PORT = 8100; // Node.js relay server listening port
const CONNECTION_TIMEOUT = 15000; // 15 seconds connection timeout (to the final target)
const UPSTREAM_TIMEOUT = 30000; // 30 seconds upstream data transfer timeout

console.log(`[RELAY] WebSocket Relay Server starting on port ${RELAY_LISTEN_PORT}`);

const wsServer = new WebSocket.Server({ port: RELAY_LISTEN_PORT });

wsServer.on('connection', (workerSocket, request) => {
    const workerAddress = request.socket.remoteAddress;
    const workerPort = request.socket.remotePort;
    console.log(`[RELAY] CF Worker connected from ${workerAddress}:${workerPort}`);

    let targetHost = '';
    let targetPort = 0;
    let targetInfoReceived = false;
    let upstreamSocket = null;
    let connectTimer = null;
    let handshakeCompleted = false; // Flag to indicate if handshake (target parsed and upstream connected) is done
    // let sha224Password = null; // Will be extracted by parseTrojanHeader, not strictly needed as a separate var here if only used for logging/passing

    const cleanup = (errorMessage) => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null; // Ensure timer is nulled after clearing

        if (workerSocket.readyState === WebSocket.OPEN) {
            if (errorMessage && !handshakeCompleted) { // Only send error status if handshake hasn't succeeded
                try {
                    workerSocket.send(Buffer.from([1])); // Send failure status as Buffer
                    console.log(`[RELAY] Sent failure status to Worker for ${workerAddress}:${workerPort} due to: ${errorMessage}`);
                } catch (e) {
                    console.error("[RELAY] Error sending failure status:", e.message);
                }
            }
            workerSocket.close(1011, errorMessage || 'Connection closed'); // Use 1011 for internal server error or a generic message
        }
        if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
        }
        upstreamSocket = null; // Ensure socket is nulled after destroying
        console.log(`[RELAY] Cleaned up connection for ${workerAddress}:${workerPort}. ${errorMessage || ''}`);
    };

    connectTimer = setTimeout(() => {
        cleanup('Timeout waiting for Trojan header or upstream connection');
    }, CONNECTION_TIMEOUT);

    // This single message handler will manage both the initial header and subsequent data
    workerSocket.on('message', async (message) => {
        if (!Buffer.isBuffer(message)) {
             console.warn("[RELAY] Received non-buffer data, ignoring.");
             // Depending on strictness, you might want to cleanup:
             // return cleanup("Protocol error: received non-buffer data.");
             return;
        }

        if (handshakeCompleted) {
            // Target info processed, upstream connected, forward WebSocket payload
            if (upstreamSocket && !upstreamSocket.destroyed && upstreamSocket.writable) {
                if (!upstreamSocket.write(message)) {
                    workerSocket.pause();
                    upstreamSocket.once('drain', () => {
                        if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                    });
                }
            } else if (!upstreamSocket || upstreamSocket.destroyed) {
                console.warn("[RELAY] Upstream socket not available or destroyed when trying to write post-handshake data.");
                cleanup("Upstream socket unavailable post-handshake.");
            }
            return;
        }

        if (!targetInfoReceived) {
            targetInfoReceived = true; // Mark that we are processing the first message as header

            try {
                const parsedInfo = await parseTrojanHeader(message);
                if (parsedInfo.hasError) {
                    return cleanup(parsedInfo.message);
                }
                targetHost = parsedInfo.addressRemote;
                targetPort = parsedInfo.portRemote;
                // sha224Password = parsedInfo.password; // Available if needed

                console.log(`[RELAY] Parsed target from Worker: ${targetHost}:${targetPort} (Password hash: ${parsedInfo.password.substring(0, 8)}...)`);

                upstreamSocket = net.connect({ host: targetHost, port: targetPort }, () => {
                    if (connectTimer) clearTimeout(connectTimer); // Clear initial connection timeout
                    connectTimer = null;

                    handshakeCompleted = true;
                    console.log(`[RELAY] Connected to target: ${targetHost}:${targetPort}`);

                    try {
                        if (workerSocket.readyState === WebSocket.OPEN) {
                            workerSocket.send(Buffer.from([0])); // Send success status as Buffer
                            console.log(`[RELAY] Sent success status to Worker for ${targetHost}:${targetPort}`);
                        } else {
                           throw new Error("Worker socket closed before sending success status.");
                        }

                        // Forward remaining data (if any) from the header message
                        if (parsedInfo.rawClientData && parsedInfo.rawClientData.length > 0) {
                            if (upstreamSocket.writable) {
                                if (!upstreamSocket.write(parsedInfo.rawClientData)) {
                                    workerSocket.pause(); // Pause workerSocket if upstream is congested
                                    upstreamSocket.once('drain', () => {
                                        if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                                    });
                                }
                            } else {
                                throw new Error("Upstream socket not writable for initial payload.");
                            }
                        }
                    } catch (writeErr) {
                        return cleanup(`Error during post-connect operations: ${writeErr.message}`);
                    }
                });

                upstreamSocket.on('data', (data) => {
                    if (workerSocket.readyState === WebSocket.OPEN) {
                        workerSocket.send(data, (err) => {
                            if (err) {
                                console.error(`[RELAY] Error sending data to worker for ${targetHost}:${targetPort}: ${err.message}`);
                                cleanup(`WS send error: ${err.message}`);
                            }
                        });
                    }
                });

                upstreamSocket.on('error', (err) => {
                    cleanup(`Upstream connection error to ${targetHost}:${targetPort}: ${err.message}`);
                });

                upstreamSocket.on('close', () => {
                    console.log(`[RELAY] Upstream connection to ${targetHost}:${targetPort} closed.`);
                    // No need to call cleanup() here as workerSocket.close() will trigger its own 'close' event which calls cleanup.
                    if (workerSocket.readyState === WebSocket.OPEN) workerSocket.close(1000, "Upstream closed");
                });

                upstreamSocket.setTimeout(UPSTREAM_TIMEOUT, () => {
                    cleanup(`Upstream connection to ${targetHost}:${targetPort} timed out after ${UPSTREAM_TIMEOUT}ms`);
                });

            } catch (e) {
                cleanup(`Error processing Trojan header or connecting: ${e.message}`);
            }
        }
    });

    workerSocket.on('error', (err) => {
        cleanup(`Worker WebSocket error: ${err.message}`);
    });

    workerSocket.on('close', (code, reason) => {
        const reasonText = reason instanceof Buffer ? reason.toString() : reason;
        console.log(`[RELAY] CF Worker WebSocket connection from ${workerAddress}:${workerPort} closed with code ${code} and reason: ${reasonText}`);
        clearInterval(pingInterval); // Clear ping interval on close
        cleanup(); // Ensure full cleanup
    });

    // Optional: Ping to keep connection alive and check status
    const pingInterval = setInterval(() => {
        if (workerSocket.readyState === WebSocket.OPEN) {
            workerSocket.ping((err) => {
                if (err) {
                    console.warn(`[RELAY] Ping to ${workerAddress}:${workerPort} failed: ${err.message}. Worker might be unresponsive.`);
                    // Consider cleanup if ping fails consistently, but be cautious as pongs are optional.
                }
            });
        } else {
            clearInterval(pingInterval); // Stop pinging if socket is not open
        }
    }, 30000); // Ping every 30 seconds

    // Redundant timeout for workerSocket itself as connectTimer already covers the initial phase.
    // If the worker sends no data at all after connecting, connectTimer handles it.
    // If it sends something that's not a valid header, parseTrojanHeader or subsequent logic handles it.
    // workerSocket.setTimeout(CONNECTION_TIMEOUT, () => { ... });
});

wsServer.on('error', (err) => {
    console.error(`[RELAY] WebSocket Server error: ${err.message}`);
});

// This function is not used in the current relay logic but is kept if needed elsewhere.
// function calculateSHA224(input) {
//  return crypto.createHash('sha224').update(input).digest('hex');
// }

async function parseTrojanHeader(buffer) {
    const CMD_CONNECT = 0x01;
    // const CMD_UDPASSOCIATE = 0x03; // Example other command

    const ATYP_IPV4 = 0x01;
    const ATYP_DOMAIN = 0x03;
    const ATYP_IPV6 = 0x04;

    let offset = 0;

    // 1. Password (SHA224 Hex String - 56 characters, which means 28 bytes if it were raw bytes, but it's hex)
    // The Trojan protocol specifies 56 hex characters for the password.
    if (buffer.byteLength < offset + 56) {
        return { hasError: true, message: "Invalid data: Trojan header too short for password hash." };
    }
    const passwordHex = buffer.toString('utf8', offset, offset + 56); // Assuming password hash is sent as hex string
    // Validate if it's a hex string
    if (!/^[0-9a-fA-F]{56}$/.test(passwordHex)) {
        return { hasError: true, message: "Invalid Trojan password format: not 56 hex characters."}
    }
    offset += 56;

    // 2. CRLF
    if (buffer.byteLength < offset + 2 || buffer[offset] !== 0x0D || buffer[offset + 1] !== 0x0A) {
        return { hasError: true, message: "Invalid data: Trojan header missing CRLF after password." };
    }
    offset += 2;

    // 3. Command (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "Invalid data: Trojan header too short for command." };
    }
    const command = buffer[offset];
    offset += 1;

    if (command !== CMD_CONNECT) {
        // This relay primarily supports CONNECT. For other commands, behavior might need to differ.
        // For now, we'll proceed to parse address/port but you might want to reject unsupported commands.
        console.warn(`[RELAY] Received Trojan command ${command}, but only CONNECT (1) is fully processed by this relay logic for address/port extraction.`);
        // If you must reject: return { hasError: true, message: `Unsupported Trojan command: ${command}` };
    }

    // 4. Address Type (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "Invalid data: Trojan header too short for address type." };
    }
    const atyp = buffer[offset];
    offset += 1;

    let addressRemote = '';

    // 5. Destination Address (variable length)
    if (atyp === ATYP_IPV4) { // IPv4
        if (buffer.byteLength < offset + 4) {
            return { hasError: true, message: "Invalid data: Trojan header too short for IPv4 address." };
        }
        addressRemote = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
        offset += 4;
    } else if (atyp === ATYP_DOMAIN) { // Domain name
        if (buffer.byteLength < offset + 1) { // Length byte
            return { hasError: true, message: "Invalid data: Trojan header too short for domain length." };
        }
        const domainLength = buffer[offset];
        offset += 1;
        if (buffer.byteLength < offset + domainLength) {
            return { hasError: true, message: "Invalid data: Trojan header too short for domain name." };
        }
        addressRemote = buffer.toString('utf8', offset, offset + domainLength);
        offset += domainLength;
    } else if (atyp === ATYP_IPV6) { // IPv6
        if (buffer.byteLength < offset + 16) {
            return { hasError: true, message: "Invalid data: Trojan header too short for IPv6 address." };
        }
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(buffer.readUInt16BE(offset + i).toString(16));
        }
        addressRemote = parts.join(':');
        offset += 16;
    } else {
        return { hasError: true, message: `Unsupported address type: ${atyp}` };
    }

    // 6. Destination Port (2 bytes, Big Endian)
    if (buffer.byteLength < offset + 2) {
        return { hasError: true, message: "Invalid data: Trojan header too short for port." };
    }
    const portRemote = buffer.readUInt16BE(offset);
    offset += 2;

    // 7. CRLF
    if (buffer.byteLength < offset + 2 || buffer[offset] !== 0x0D || buffer[offset + 1] !== 0x0A) {
        return { hasError: true, message: "Invalid data: Trojan header missing CRLF after request." };
    }
    offset += 2;

    // 8. Remaining data in the buffer is the initial payload
    const rawClientData = buffer.subarray(offset);

    return {
        hasError: false,
        password: passwordHex, // The 56-char hex string of SHA224(password)
        command: command,
        addressRemote: addressRemote,
        portRemote: portRemote,
        rawClientData: rawClientData
    };
}

console.log("[RELAY] Setup complete. Waiting for connections...");
