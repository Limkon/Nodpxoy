const net = require('net');

const RELAY_LISTEN_PORT = 8100; // Node.js 中继服务监听的端口
const CONNECTION_TIMEOUT = 15000; // 15秒连接超时

const server = net.createServer((workerSocket) => {
    console.log(`[RELAY] CF Worker connected from ${workerSocket.remoteAddress}:${workerSocket.remotePort}`);
    workerSocket.setNoDelay(true);

    let targetHost = '';
    let targetPort = 0;
    let targetInfoReceived = false;
    let upstreamSocket = null;
    let initialDataBuffer = []; // Buffer for data received before target info

    const connectTimeout = setTimeout(() => {
        if (!targetInfoReceived || !upstreamSocket || !upstreamSocket.writable) {
            console.log(`[RELAY] Timeout waiting for target info or upstream connection for ${workerSocket.remoteAddress}`);
            workerSocket.destroy(new Error('Relay connection setup timeout'));
        }
    }, CONNECTION_TIMEOUT);

    workerSocket.on('data', async (data) => {
        if (upstreamSocket && upstreamSocket.writable) {
            // Target info already processed, forward data to upstream
            if (!upstreamSocket.write(data)) {
                workerSocket.pause();
                upstreamSocket.once('drain', () => workerSocket.resume());
            }
            return;
        }
        
        // Buffer initial data until target info is fully parsed or upstream is ready
        initialDataBuffer.push(data);

        if (targetInfoReceived) { // Target info parsed, but upstream not ready yet. Keep buffering.
            return;
        }

        // Try to parse target info from the combined buffer
        const combinedBuffer = Buffer.concat(initialDataBuffer);
        let consumedBytes = 0;

        try {
            // Protocol: addressType (1 byte) | [addressLength (1 byte) if domain] | addressValue (var) | port (2 bytes BE)
            if (combinedBuffer.length < 1) return; // Need at least addressType
            const addressType = combinedBuffer.readUInt8(0);
            consumedBytes = 1;

            if (addressType === 1) { // IPv4
                if (combinedBuffer.length < consumedBytes + 4 + 2) return; // IPv4 (4) + port (2)
                targetHost = `${combinedBuffer.readUInt8(consumedBytes++)}.${combinedBuffer.readUInt8(consumedBytes++)}.${combinedBuffer.readUInt8(consumedBytes++)}.${combinedBuffer.readUInt8(consumedBytes++)}`;
            } else if (addressType === 2) { // Domain name
                if (combinedBuffer.length < consumedBytes + 1) return; // addressLength (1)
                const addressLength = combinedBuffer.readUInt8(consumedBytes++);
                if (combinedBuffer.length < consumedBytes + addressLength + 2) return; // domain (var) + port (2)
                targetHost = combinedBuffer.toString('utf8', consumedBytes, consumedBytes + addressLength);
                consumedBytes += addressLength;
            } else if (addressType === 3) { // IPv6
                if (combinedBuffer.length < consumedBytes + 16 + 2) return; // IPv6 (16) + port (2)
                const ipv6Bytes = [];
                for (let i = 0; i < 16; i += 2) {
                    ipv6Bytes.push(combinedBuffer.readUInt16BE(consumedBytes + i).toString(16));
                }
                targetHost = ipv6Bytes.join(':');
                consumedBytes += 16;
            } else {
                throw new Error(`Invalid addressType: ${addressType}`);
            }

            targetPort = combinedBuffer.readUInt16BE(consumedBytes);
            consumedBytes += 2;
            targetInfoReceived = true;
            clearTimeout(connectTimeout); // Clear timeout once target info is received
            console.log(`[RELAY] Received target from Worker: ${targetHost}:${targetPort}`);

            // Extract any remaining data that was part of the VLESS payload
            const remainingVlessData = combinedBuffer.slice(consumedBytes);
            initialDataBuffer = [remainingVlessData]; // Save for sending after connection

            // Now connect to the actual target
            upstreamSocket = new net.Socket();
            upstreamSocket.setNoDelay(true);

            upstreamSocket.connect({ host: targetHost, port: targetPort }, () => {
                console.log(`[RELAY] Connected to target: ${targetHost}:${targetPort}`);
                workerSocket.write(Buffer.from([0])); // Send 0 (success) to Worker

                // Send any buffered VLESS initial payload
                if (initialDataBuffer.length > 0) {
                    const headPayload = Buffer.concat(initialDataBuffer);
                    if (headPayload.length > 0) {
                        console.log(`[RELAY] Writing initial ${headPayload.length} bytes of VLESS data to target`);
                        upstreamSocket.write(headPayload);
                    }
                    initialDataBuffer = []; // Clear buffer
                }

                // Start piping
                workerSocket.pipe(upstreamSocket);
                upstreamSocket.pipe(workerSocket);
            });

            upstreamSocket.on('error', (err) => {
                console.error(`[RELAY] Upstream connection error to ${targetHost}:${targetPort}: ${err.message}`);
                if (!workerSocket.destroyed) {
                    workerSocket.write(Buffer.from([1])); // Send 1 (failure) to Worker
                    workerSocket.destroy(err);
                }
                clearTimeout(connectTimeout);
            });

            upstreamSocket.on('close', () => {
                console.log(`[RELAY] Upstream connection to ${targetHost}:${targetPort} closed.`);
                if (!workerSocket.destroyed) workerSocket.destroy();
                clearTimeout(connectTimeout);
            });
            upstreamSocket.on('timeout', () => {
                console.error(`[RELAY] Upstream connection to ${targetHost}:${targetPort} timed out.`);
                 if (!workerSocket.destroyed) {
                    workerSocket.write(Buffer.from([1]));
                    workerSocket.destroy(new Error('Upstream timeout'));
                }
                clearTimeout(connectTimeout);
            });
            upstreamSocket.setTimeout(CONNECTION_TIMEOUT);


        } catch (e) {
            if (e instanceof RangeError && e.message.includes('Index out of range')) {
                // Not enough data yet to parse header, wait for more.
                // initialDataBuffer already contains the partial data.
                return;
            }
            console.error(`[RELAY] Error processing target info or connecting: ${e.message}`);
            if (!workerSocket.destroyed) {
                workerSocket.write(Buffer.from([1])); // Send 1 (failure)
                workerSocket.destroy(e);
            }
            clearTimeout(connectTimeout);
        }
    });

    workerSocket.on('error', (err) => {
        console.error(`[RELAY] Worker socket error: ${err.message}`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
        clearTimeout(connectTimeout);
    });

    workerSocket.on('close', () => {
        console.log(`[RELAY] CF Worker connection closed.`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
        clearTimeout(connectTimeout);
    });

    workerSocket.on('timeout', () => {
        console.error(`[RELAY] Worker socket timed out before target info processed.`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
        workerSocket.destroy(new Error('Worker socket timeout'));
        clearTimeout(connectTimeout);
    });
    workerSocket.setTimeout(CONNECTION_TIMEOUT);


});

server.on('error', (err) => {
    console.error(`[RELAY] Server error: ${err.message}`);
});

server.listen(RELAY_LISTEN_PORT, () => {
    console.log(`[RELAY] Node.js TCP Relay server listening on port ${RELAY_LISTEN_PORT}`);
});
