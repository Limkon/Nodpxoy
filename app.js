const net = require('net');
const WebSocket = require('ws');
// const crypto = require('crypto'); // No longer needed for SHA224 password

// Configuration
const RELAY_LISTEN_PORT = 8100; // Node.js relay server listening port
const CONNECTION_TIMEOUT = 15000; // 15 seconds connection timeout (to the final target)
const UPSTREAM_TIMEOUT = 30000; // 30 seconds upstream data transfer timeout

// Allowed VLESS UUID(s) - taken from your VLESS link
// In a real app, load this from a config file or environment variable
const ALLOWED_UUIDS = ['0058c4cc-82a2-4cd0-92ed-fe8286d261d2'.replace(/-/g, '')]; // Store without hyphens for easier comparison

console.log(`[VLESS-RELAY] WebSocket VLESS Relay Server starting on port ${RELAY_LISTEN_PORT}`);
console.log(`[VLESS-RELAY] Allowed UUIDs: ${ALLOWED_UUIDS.join(', ')}`);

const wsServer = new WebSocket.Server({ port: RELAY_LISTEN_PORT });

wsServer.on('connection', (workerSocket, request) => {
    const workerAddress = request.socket.remoteAddress;
    const workerPort = request.socket.remotePort;
    console.log(`[VLESS-RELAY] Client connected from ${workerAddress}:${workerPort}`);

    let targetHost = '';
    let targetPort = 0;
    let upstreamSocket = null;
    let connectTimer = null;
    let handshakeCompleted = false;
    let headerInfoReceived = false; // To ensure header is processed only once

    const cleanup = (errorMessage, errorCode = 1011) => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;

        if (workerSocket.readyState === WebSocket.OPEN) {
            if (errorMessage && !handshakeCompleted) {
                try {
                    // Send failure status (Buffer.from([1])) if handshake didn't complete
                    workerSocket.send(Buffer.from([1]));
                    console.log(`[VLESS-RELAY] Sent failure status to client ${workerAddress}:${workerPort} due to: ${errorMessage}`);
                } catch (e) {
                    console.error("[VLESS-RELAY] Error sending failure status:", e.message);
                }
            }
            workerSocket.close(errorCode, errorMessage || 'Connection closed');
        }
        if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
        }
        upstreamSocket = null;
        console.log(`[VLESS-RELAY] Cleaned up connection for ${workerAddress}:${workerPort}. ${errorMessage || ''}`);
    };

    connectTimer = setTimeout(() => {
        cleanup('Timeout waiting for VLESS header or upstream connection');
    }, CONNECTION_TIMEOUT);

    workerSocket.on('message', async (message) => {
        if (!Buffer.isBuffer(message)) {
            console.warn("[VLESS-RELAY] Received non-buffer data, ignoring.");
            return;
        }

        if (handshakeCompleted) {
            if (upstreamSocket && !upstreamSocket.destroyed && upstreamSocket.writable) {
                if (!upstreamSocket.write(message)) {
                    workerSocket.pause();
                    upstreamSocket.once('drain', () => {
                        if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                    });
                }
            } else {
                cleanup("Upstream socket unavailable post-handshake.");
            }
            return;
        }

        if (!headerInfoReceived) {
            headerInfoReceived = true;

            try {
                const parsedInfo = parseVlessHeader(message);
                if (parsedInfo.hasError) {
                    return cleanup(parsedInfo.message);
                }

                // Authenticate UUID
                if (!ALLOWED_UUIDS.includes(parsedInfo.uuid)) {
                    return cleanup(`Invalid or disallowed UUID: ${parsedInfo.uuid}`);
                }
                console.log(`[VLESS-RELAY] UUID Authenticated: ${parsedInfo.uuid}`);

                targetHost = parsedInfo.addressRemote;
                targetPort = parsedInfo.portRemote;

                if (parsedInfo.command !== 0x01) { // TCP command
                    return cleanup(`Unsupported VLESS command: ${parsedInfo.command}`);
                }

                console.log(`[VLESS-RELAY] Parsed target from client: ${targetHost}:${targetPort}`);

                upstreamSocket = net.connect({ host: targetHost, port: targetPort }, () => {
                    if (connectTimer) clearTimeout(connectTimer);
                    connectTimer = null;
                    handshakeCompleted = true;
                    console.log(`[VLESS-RELAY] Connected to target: ${targetHost}:${targetPort}`);

                    try {
                        if (workerSocket.readyState === WebSocket.OPEN) {
                            // Send success status (non-standard for VLESS, but kept for potential CF Worker compatibility)
                            workerSocket.send(Buffer.from([0]));
                            console.log(`[VLESS-RELAY] Sent success status to client for ${targetHost}:${targetPort}`);
                        } else {
                           throw new Error("Client socket closed before sending success status.");
                        }

                        if (parsedInfo.rawClientData && parsedInfo.rawClientData.length > 0) {
                            if (upstreamSocket.writable) {
                                if (!upstreamSocket.write(parsedInfo.rawClientData)) {
                                    workerSocket.pause();
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
                                cleanup(`WS send error: ${err.message}`);
                            }
                        });
                    }
                });

                upstreamSocket.on('error', (err) => {
                    cleanup(`Upstream connection error to ${targetHost}:${targetPort}: ${err.message}`);
                });

                upstreamSocket.on('close', () => {
                    console.log(`[VLESS-RELAY] Upstream connection to ${targetHost}:${targetPort} closed.`);
                    if (workerSocket.readyState === WebSocket.OPEN) workerSocket.close(1000, "Upstream closed");
                });

                upstreamSocket.setTimeout(UPSTREAM_TIMEOUT, () => {
                    cleanup(`Upstream connection to ${targetHost}:${targetPort} timed out after ${UPSTREAM_TIMEOUT}ms`);
                });

            } catch (e) {
                cleanup(`Error processing VLESS header or connecting: ${e.toString()}`);
            }
        }
    });

    workerSocket.on('error', (err) => {
        cleanup(`Client WebSocket error: ${err.message}`);
    });

    workerSocket.on('close', (code, reason) => {
        const reasonText = reason instanceof Buffer ? reason.toString() : reason;
        console.log(`[VLESS-RELAY] Client WebSocket connection from ${workerAddress}:${workerPort} closed with code ${code}, reason: ${reasonText}`);
        clearInterval(pingInterval);
        cleanup(null, code); // Pass null to avoid sending error message if already closed cleanly
    });

    const pingInterval = setInterval(() => {
        if (workerSocket.readyState === WebSocket.OPEN) {
            workerSocket.ping((err) => {
                if (err) {
                    console.warn(`[VLESS-RELAY] Ping to ${workerAddress}:${workerPort} failed: ${err.message}.`);
                }
            });
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

wsServer.on('error', (err) => {
    console.error(`[VLESS-RELAY] WebSocket Server error: ${err.message}`);
});

function parseVlessHeader(buffer) {
    let offset = 0;

    // 1. VLESS Version (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "VLESS header too short for Version." };
    }
    const version = buffer[offset];
    offset += 1;
    if (version !== 0x00) {
        return { hasError: true, message: `Unsupported VLESS version: ${version}` };
    }

    // 2. UUID (16 bytes)
    if (buffer.byteLength < offset + 16) {
        return { hasError: true, message: "VLESS header too short for UUID." };
    }
    const uuid = buffer.subarray(offset, offset + 16).toString('hex');
    offset += 16;

    // 3. Addons Length (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "VLESS header too short for Addons Length." };
    }
    const addonsLength = buffer[offset];
    offset += 1;

    // 4. Addons Data (skip for this simple relay)
    if (buffer.byteLength < offset + addonsLength) {
        return { hasError: true, message: "VLESS header too short for Addons Data." };
    }
    // const addonsData = buffer.subarray(offset, offset + addonsLength); // If needed
    offset += addonsLength;

    // 5. Command (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "VLESS header too short for Command." };
    }
    const command = buffer[offset]; // 0x01: TCP, 0x02: UDP, 0x03: MUX
    offset += 1;

    // 6. Target Port (2 bytes, Big Endian)
    if (buffer.byteLength < offset + 2) {
        return { hasError: true, message: "VLESS header too short for Target Port." };
    }
    const portRemote = buffer.readUInt16BE(offset);
    offset += 2;

    // 7. Address Type (ATYP) (1 byte)
    if (buffer.byteLength < offset + 1) {
        return { hasError: true, message: "VLESS header too short for Address Type." };
    }
    const atyp = buffer[offset];
    offset += 1;

    let addressRemote = '';
    const ATYP_IPV4 = 0x01;
    const ATYP_DOMAIN = 0x02; // Note: VLESS uses 0x02 for domain
    const ATYP_IPV6 = 0x03; // Note: VLESS uses 0x03 for IPv6

    // 8. Target Address (variable length)
    if (atyp === ATYP_IPV4) {
        if (buffer.byteLength < offset + 4) {
            return { hasError: true, message: "VLESS header too short for IPv4 address." };
        }
        addressRemote = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
        offset += 4;
    } else if (atyp === ATYP_DOMAIN) {
        if (buffer.byteLength < offset + 1) { // Domain length byte
            return { hasError: true, message: "VLESS header too short for domain length." };
        }
        const domainLength = buffer[offset];
        offset += 1;
        if (buffer.byteLength < offset + domainLength) {
            return { hasError: true, message: "VLESS header too short for domain name." };
        }
        addressRemote = buffer.toString('utf8', offset, offset + domainLength);
        offset += domainLength;
    } else if (atyp === ATYP_IPV6) {
        if (buffer.byteLength < offset + 16) {
            return { hasError: true, message: "VLESS header too short for IPv6 address." };
        }
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(buffer.readUInt16BE(offset + i).toString(16));
        }
        addressRemote = parts.join(':');
        // Ensure correct IPv6 formatting (e.g., ::ffff: for IPv4-mapped IPv6 if needed, but net.connect usually handles various forms)
        // A common way to canonicalize for IPv6 is more complex, but this should work for net.connect
        offset += 16;
    } else {
        return { hasError: true, message: `Unsupported VLESS address type: ${atyp}` };
    }

    // 9. Remaining data is initial payload
    const rawClientData = buffer.subarray(offset);

    return {
        hasError: false,
        uuid: uuid,
        command: command,
        addressRemote: addressRemote,
        portRemote: portRemote,
        rawClientData: rawClientData
    };
}

console.log("[VLESS-RELAY] Setup complete. Waiting for connections...");
