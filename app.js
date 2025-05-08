const net = require('net');
const WebSocket = require('ws');
const crypto = require('crypto');

const RELAY_LISTEN_PORT = 8100; // Node.js 中继服务监听的端口
const CONNECTION_TIMEOUT = 15000; // 15秒连接超时 (连接到最终目标)
const UPSTREAM_TIMEOUT = 30000; // 30秒上游数据传输超时

console.log(`[RELAY] WebSocket Relay Server starting on port ${RELAY_LISTEN_PORT}`);

const wsServer = new WebSocket.Server({ port: RELAY_LISTEN_PORT });

wsServer.on('connection', (workerSocket, request) => {
    const workerAddress = request.socket.remoteAddress;
    const workerPort = request.socket.remotePort;
    console.log(`[RELAY] CF Worker connected from <span class="math-inline">\{workerAddress\}\:</span>{workerPort}`);

    let targetHost = '';
    let targetPort = 0;
    let targetInfoReceived = false;
    let upstreamSocket = null;
    let connectTimer = null;
    let handshakeCompleted = false; // 标记握手是否完成 (target parsed and upstream connected)
    let sha224Password = null; // Will be extracted from the first WebSocket message

    const cleanup = (errorMessage) => {
        if (connectTimer) clearTimeout(connectTimer);
        if (workerSocket.readyState === WebSocket.OPEN) {
            if (errorMessage && !handshakeCompleted) {
                try {
                    workerSocket.send(Buffer.from([1])); // Send failure status as Buffer
                } catch (e) {
                    console.error("[RELAY] Error sending failure status:", e);
                }
            }
            workerSocket.close(1011, errorMessage); // Close with an error code
        }
        if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
        }
        console.log(`[RELAY] Cleaned up connection for <span class="math-inline">\{workerAddress\}\:</span>{workerPort}. ${errorMessage || ''}`);
    };

    connectTimer = setTimeout(() => {
        cleanup('Timeout waiting for Trojan header or upstream connection');
    }, CONNECTION_TIMEOUT);

    workerSocket.on('message', async (message) => {
        if (handshakeCompleted && upstreamSocket && !upstreamSocket.destroyed) {
            // Target info processed, upstream connected, forward WebSocket payload as Buffer
            if (message instanceof Buffer) {
                if (!upstreamSocket.write(message)) {
                    workerSocket.pause();
                    upstreamSocket.once('drain', () => {
                        if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                    });
                }
            } else {
                console.warn("[RELAY] Received non-buffer data after handshake, ignoring.");
            }
            return;
        }

        if (!targetInfoReceived) {
            if (!(message instanceof Buffer)) {
                return cleanup('Expected Buffer for Trojan header.');
            }

            try {
                const parsedInfo = await parseTrojanHeader(message);
                if (parsedInfo.hasError) {
                    return cleanup(parsedInfo.message);
                }
                targetHost = parsedInfo.addressRemote;
                targetPort = parsedInfo.portRemote;
                sha224Password = parsedInfo.password;
                targetInfoReceived = true;

                console.log(`[RELAY] Parsed target from Worker: <span class="math-inline">\{targetHost\}\:</span>{targetPort}`);

                upstreamSocket = net.connect({ host: targetHost, port: targetPort }, () => {
                    if (connectTimer) clearTimeout(connectTimer);
                    connectTimer = null;
                    handshakeCompleted = true;
                    console.log(`[RELAY] Connected to target: <span class="math-inline">\{targetHost\}\:</span>{targetPort}`);
                    try {
                        workerSocket.send(Buffer.from([0])); // Send success status as Buffer
                        console.log(`[RELAY] Sent success status to Worker for <span class="math-inline">\{targetHost\}\:</span>{targetPort}`);

                        // Forward remaining data (if any) after the header
                        if (parsedInfo.rawClientData && parsedInfo.rawClientData.length > 0) {
                            if (!upstreamSocket.write(parsedInfo.rawClientData)) {
                                workerSocket.pause();
                                upstreamSocket.once('drain', () => {
                                    if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                                });
                            }
                        }

                        // Pipe data between WebSocket and TCP socket
                        workerSocket.on('message', (msg) => {
                            if (msg instanceof Buffer) {
                                if (!upstreamSocket.write(msg)) {
                                    workerSocket.pause();
                                    upstreamSocket.once('drain', () => {
                                        if (workerSocket.readyState === WebSocket.OPEN) workerSocket.resume();
                                    });
                                }
                            }
                        });

                        upstreamSocket.on('data', (data) => {
                            if (workerSocket.readyState === WebSocket.OPEN) {
                                workerSocket.send(data);
                            }
                        });

                    } catch (writeErr) {
                        cleanup(`Error writing success status to worker: ${writeErr.message}`);
                    }
                });

                upstreamSocket.on('error', (err) => {
                    cleanup(`Upstream connection error to <span class="math-inline">\{targetHost\}\:</span>{targetPort}: ${err.message}`);
                });

                upstreamSocket.on('close', () => {
                    console.log(`[RELAY] Upstream connection to <span class="math-inline">\{targetHost\}\:</span>{targetPort} closed.`);
                    if (workerSocket.readyState === WebSocket.OPEN) workerSocket.close();
                    if (connectTimer) clearTimeout(connectTimer);
                });

                upstreamSocket.setTimeout(UPSTREAM_TIMEOUT, () => {
                    cleanup(`Upstream connection to <span class="math-inline">\{targetHost\}\:</span>{targetPort} timed out after ${UPSTREAM_TIMEOUT}ms`);
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
        console.log(`[RELAY] CF Worker WebSocket connection closed with code ${code} and reason: ${reason}`);
        cleanup();
    });

    workerSocket.on('pong', () => {
        // Respond to pings from the worker if needed
    });

    // Send a ping to the worker to check the connection (optional)
    const pingInterval = setInterval(() => {
        if (workerSocket.readyState === WebSocket.OPEN) {
            workerSocket.ping();
        }
    }, 30000); // Ping every 30 seconds

    workerSocket.on('close', () => {
        clearInterval(pingInterval);
    });

    // Initial timeout if no data received
    workerSocket.setTimeout(CONNECTION_TIMEOUT, () => {
        if (!targetInfoReceived) {
            cleanup(`Worker WebSocket timed out before Trojan header received after ${CONNECTION_TIMEOUT}ms.`);
        }
    });
});

wsServer.on('error', (err) => {
    console.error(`[RELAY] WebSocket Server error: ${err.message}`);
});

function calculateSHA224(input) {
    return crypto.createHash('sha224').update(input).digest('hex');
}

async function parseTrojanHeader(buffer) {
    if (buffer.byteLength < 56) {
        return { hasError: true, message: "Invalid data: Trojan header too short." };
    }

    const passwordBuffer = buffer.subarray
