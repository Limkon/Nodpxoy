const net = require('net');

const RELAY_LISTEN_PORT = 8100; // Node.js 中继服务监听的端口
const CONNECTION_TIMEOUT = 15000; // 15秒连接超时 (连接到最终目标和Worker发送目标信息)
const UPSTREAM_TIMEOUT = 30000; // 30秒上游数据传输超时

console.log(`[RELAY] TCP Relay Server starting on port ${RELAY_LISTEN_PORT}`);

const server = net.createServer((workerSocket) => {
    console.log(`[RELAY] CF Worker connected from ${workerSocket.remoteAddress}:${workerSocket.remotePort}`);
    workerSocket.setNoDelay(true);
    workerSocket.setKeepAlive(true, 60000);


    let targetHost = '';
    let targetPort = 0;
    let targetInfoReceived = false;
    let upstreamSocket = null;
    let initialDataBuffer = []; // 缓冲在目标信息完全解析前收到的数据
    let connectTimer = null;
    let handshakeCompleted = false; // 标记握手是否完成，包括收到relay status

    const cleanup = (errorMessage) => {
        if (connectTimer) clearTimeout(connectTimer);
        if (!workerSocket.destroyed) {
            if (errorMessage && !handshakeCompleted) { // 如果握手未完成且有错误，发送失败状态
                 try { workerSocket.write(Buffer.from([1])); } catch (e) { /* ignore */ }
            }
            workerSocket.destroy(errorMessage ? new Error(errorMessage) : undefined);
        }
        if (upstreamSocket && !upstreamSocket.destroyed) {
            upstreamSocket.destroy();
        }
        console.log(`[RELAY] Cleaned up connection for ${workerSocket.remoteAddress}. ${errorMessage || ''}`);
    };
    
    connectTimer = setTimeout(() => {
        cleanup('Timeout waiting for target info or upstream connection');
    }, CONNECTION_TIMEOUT);

    workerSocket.on('data', async (data) => {
        if (handshakeCompleted && upstreamSocket && upstreamSocket.writable) {
            // 目标信息已处理，上游连接已建立，直接转发数据
            if (!upstreamSocket.write(data)) {
                workerSocket.pause();
                upstreamSocket.once('drain', () => {
                    if (!workerSocket.destroyed) workerSocket.resume();
                });
            }
            return;
        }
        
        initialDataBuffer.push(data);

        if (targetInfoReceived) { 
            // 目标信息已解析，但可能上游连接还未就绪，或正在等待relay status回传后才算握手完成
            // 数据将会在upstreamSocket连接成功并发送成功状态后，由该连接的回调处理
            return;
        }

        const combinedBuffer = Buffer.concat(initialDataBuffer);
        let consumedBytes = 0;

        try {
            // 协议: addressType (1 byte) | [addressLength (1 byte) if domain] | addressValue (var) | port (2 bytes BE)
            if (combinedBuffer.length < 1) return; // 至少需要 addressType
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
                for (let i = 0; i < 8; i++) { // 8 groups of 2 bytes
                    ipv6Bytes.push(combinedBuffer.readUInt16BE(consumedBytes + i * 2).toString(16));
                }
                targetHost = ipv6Bytes.join(':');
                consumedBytes += 16;
            } else {
                return cleanup(`Invalid addressType: ${addressType}`);
            }

            targetPort = combinedBuffer.readUInt16BE(consumedBytes);
            consumedBytes += 2;
            targetInfoReceived = true;
            
            // 任何在目标信息之后但在同一个数据块中的数据，都属于VLESS的原始负载
            const remainingVlessData = combinedBuffer.slice(consumedBytes);
            initialDataBuffer = [remainingVlessData]; // 保存，在连接到目标后发送

            console.log(`[RELAY] Received target from Worker: ${targetHost}:${targetPort}`);
            
            // 连接到真实目标
            upstreamSocket = new net.Socket();
            upstreamSocket.setNoDelay(true);
            upstreamSocket.setKeepAlive(true, 60000);


            upstreamSocket.connect({ host: targetHost, port: targetPort, family: (addressType === 1 ? 4 : (addressType === 3 ? 6 : undefined)) }, () => {
                if (connectTimer) clearTimeout(connectTimer); // 清除初始连接/握手超时
                connectTimer = null;

                console.log(`[RELAY] Connected to target: ${targetHost}:${targetPort}`);
                try {
                    workerSocket.write(Buffer.from([0])); // 发送 0 (成功) 给 Worker
                    handshakeCompleted = true; // 握手成功
                    console.log(`[RELAY] Sent success status to Worker for ${targetHost}:${targetPort}`);

                    // 发送任何已缓冲的VLESS初始负载
                    if (initialDataBuffer.length > 0) {
                        const headPayload = Buffer.concat(initialDataBuffer);
                        if (headPayload.length > 0) {
                            console.log(`[RELAY] Writing initial ${headPayload.length} bytes of VLESS data to target`);
                            if (!upstreamSocket.write(headPayload)) {
                                workerSocket.pause(); // 如果上游缓冲区满，暂停从Worker读取
                                upstreamSocket.once('drain', () => {
                                     if (!workerSocket.destroyed) workerSocket.resume();
                                });
                            }
                        }
                        initialDataBuffer = []; // 清空缓冲区
                    }

                    // 启动双向管道
                    workerSocket.pipe(upstreamSocket);
                    upstreamSocket.pipe(workerSocket);

                } catch (writeErr) {
                    cleanup(`Error writing success status to worker: ${writeErr.message}`);
                }
            });

            upstreamSocket.on('error', (err) => {
                cleanup(`Upstream connection error to ${targetHost}:${targetPort}: ${err.message}`);
            });

            upstreamSocket.on('close', () => {
                console.log(`[RELAY] Upstream connection to ${targetHost}:${targetPort} closed.`);
                if (!workerSocket.destroyed) workerSocket.destroy();
                if (connectTimer) clearTimeout(connectTimer);
            });

            upstreamSocket.setTimeout(UPSTREAM_TIMEOUT, () => {
                 cleanup(`Upstream connection to ${targetHost}:${targetPort} timed out after ${UPSTREAM_TIMEOUT}ms`);
            });


        } catch (e) {
            // RangeError通常意味着数据包不完整，等待更多数据
            if (e instanceof RangeError && e.message && e.message.toLowerCase().includes('out of range')) {
                // initialDataBuffer 已经包含了部分数据，等待下一次 'data' 事件
                return;
            }
            cleanup(`Error processing target info or connecting: ${e.message}`);
        }
    });

    workerSocket.on('error', (err) => {
        cleanup(`Worker socket error: ${err.message}`);
    });

    workerSocket.on('close', () => {
        console.log(`[RELAY] CF Worker connection closed by worker.`);
        cleanup(); // No error message, just clean up
    });
    
    workerSocket.setTimeout(CONNECTION_TIMEOUT, () => { // 初始超时
        if (!targetInfoReceived) {
            cleanup(`Worker socket timed out before target info fully received after ${CONNECTION_TIMEOUT}ms.`);
        }
    });
});

server.on('error', (err) => {
    console.error(`[RELAY] Server error: ${err.message}`);
});

server.listen(RELAY_LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[RELAY] Node.js TCP Relay server listening on 0.0.0.0:${RELAY_LISTEN_PORT}`);
});
