const net = require('net');
const dgram = require('dgram');
const url = require('url'); // 用于解析CONNECT请求中的主机和端口

// --- 配置 ---
const LOCAL_TCP_PROXY_PORT = 8100; // Node.js TCP 代理监听的本地端口 (现在是HTTP代理端口)
// 对于CONNECT隧道，以下两个目标配置主要用于非CONNECT的普通HTTP请求的默认转发目标
const DEFAULT_TARGET_TCP_IP = '1.0.0.5';  // 默认TCP目标服务器 IP (用于非CONNECT HTTP请求)
const DEFAULT_TARGET_TCP_PORT = 80;       // 默认TCP目标服务器端口 (建议为80,如果目标是443则需要下面进一步处理)

const LOCAL_UDP_PROXY_PORT = 8100; // Node.js UDP 代理监听的本地端口
const TARGET_UDP_IP = '1.0.0.5';  // UDP 目标服务器 IP
const TARGET_UDP_PORT = 443;      // UDP 目标服务器端口

// --- TCP 代理实现 (支持 HTTPS CONNECT 隧道) ---
const tcpProxyServer = net.createServer((clientSocket) => {
    console.log(`[TCP] 客户端已连接: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
    let KEEPALIVE_INTERVAL = 60000; // 60 秒

    clientSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);


    let upstreamSocket; // 连接到目标服务器的socket
    let buffer = Buffer.alloc(0); // 用于暂存客户端初始数据

    clientSocket.on('data', (data) => {
        if (!upstreamSocket) { // 还没有建立到目标服务器的连接，这是初始请求
            buffer = Buffer.concat([buffer, data]);
            const requestStr = buffer.toString('utf8');

            // 尝试解析 HTTP 请求行 (例如 "CONNECT example.com:443 HTTP/1.1" 或 "GET / HTTP/1.1")
            const endOfHeaders = requestStr.indexOf('\r\n\r\n');
            // 我们只需要请求行来判断是否是CONNECT
            const firstLineEnd = requestStr.indexOf('\r\n');
            if (firstLineEnd === -1) { // 请求头不完整，继续等待
                if (buffer.length > 8192) { // 防止buffer过大
                    console.error('[TCP] 初始请求头过大或不完整，关闭连接。');
                    clientSocket.end();
                    return;
                }
                return;
            }

            const requestLine = requestStr.substring(0, firstLineEnd);
            const [method, targetUrl, httpVersion] = requestLine.split(' ');

            console.log(`[TCP] 收到请求行: ${requestLine}`);

            if (method === 'CONNECT') {
                const [targetHost, targetPortStr] = targetUrl.split(':');
                const targetPort = parseInt(targetPortStr, 10);

                if (!targetHost || isNaN(targetPort)) {
                    console.error(`[TCP] 无效的 CONNECT 请求目标: ${targetUrl}`);
                    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                    return;
                }

                console.log(`[TCP] CONNECT 请求到: ${targetHost}:${targetPort}`);
                upstreamSocket = new net.Socket();
                upstreamSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);


                upstreamSocket.connect(targetPort, targetHost, () => {
                    console.log(`[TCP] CONNECT: 已连接到目标 ${targetHost}:${targetPort}`);
                    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
                    // 如果buffer中除了CONNECT请求头还有其他数据 (通常不会，但以防万一)
                    // 一般来说，CONNECT 握手后，后续数据才是加密的SSL/TLS流量
                    // clientSocket.pipe(upstreamSocket) 会处理后续数据
                    // upstreamSocket.pipe(clientSocket)
                });
                
                // 将CONNECT请求建立后，后续的clientSocket数据直接pipe给upstreamSocket
                clientSocket.pipe(upstreamSocket);
                upstreamSocket.pipe(clientSocket);


                upstreamSocket.on('error', (err) => {
                    console.error(`[TCP] CONNECT: 连接到目标 ${targetHost}:${targetPort} 错误: ${err.message}`);
                    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
                });
                upstreamSocket.on('end', () => {
                    console.log(`[TCP] CONNECT: 与目标 ${targetHost}:${targetPort} 的连接已关闭`);
                    clientSocket.end();
                });
                upstreamSocket.on('close', () => {
                    console.log(`[TCP] CONNECT: 与目标 ${targetHost}:${targetPort} 的套接字已关闭`);
                    clientSocket.destroy();
                });


            } else {
                // 处理普通的 HTTP 请求 (非 CONNECT) - 转发到默认目标
                // 注意：如果 DEFAULT_TARGET_TCP_PORT 是 443 (HTTPS)，这里的简单转发仍然会导致
                // "plain HTTP request was sent to HTTPS port" 错误。
                // 要正确处理这种情况，代理需要作为HTTPS客户端连接到默认目标。
                // 为简单起见，这里我们还是做纯TCP转发。
                // 一个更完善的实现会检查 DEFAULT_TARGET_TCP_PORT，如果它是443，
                // 则使用 `https` 模块来请求。

                console.log(`[TCP] 非CONNECT请求 (${method})，尝试转发到默认目标: ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT}`);
                upstreamSocket = new net.Socket();
                upstreamSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);

                upstreamSocket.connect(DEFAULT_TARGET_TCP_PORT, DEFAULT_TARGET_TCP_IP, () => {
                    console.log(`[TCP] HTTP: 已连接到默认目标 ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT}`);
                    upstreamSocket.write(buffer); // 发送已缓冲的初始数据
                    clientSocket.pipe(upstreamSocket);
                    upstreamSocket.pipe(clientSocket);
                    buffer = null; // 清空buffer
                });

                upstreamSocket.on('error', (err) => {
                    console.error(`[TCP] HTTP: 连接到默认目标 ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT} 错误: ${err.message}`);
                    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`); // 或者其他合适的错误
                });
                 upstreamSocket.on('end', () => {
                    console.log(`[TCP] HTTP: 与默认目标 ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT} 的连接已关闭`);
                    clientSocket.end();
                });
                upstreamSocket.on('close', () => {
                    console.log(`[TCP] HTTP: 与默认目标 ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT} 的套接字已关闭`);
                    clientSocket.destroy();
                });
            }
        } else {
            // upstreamSocket 已经建立，这部分代码在新的pipe模式下通常不会直接执行
            // 因为 clientSocket.pipe(upstreamSocket) 会处理数据转发
        }
    });

    clientSocket.on('error', (err) => {
        console.error(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接错误: ${err.message}`);
        if (upstreamSocket) upstreamSocket.destroy();
    });

    clientSocket.on('end', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接已关闭`);
        if (upstreamSocket) upstreamSocket.end();
    });
    clientSocket.on('close', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 套接字已关闭`);
        if (upstreamSocket && !upstreamSocket.destroyed) {
             upstreamSocket.destroy();
        }
    });

});

tcpProxyServer.on('error', (err) => {
    console.error(`[TCP] 代理服务器错误: ${err.message}`);
});


// --- UDP 代理实现 (保持不变) ---
const udpProxyServer = dgram.createSocket('udp4');
const udpClientMap = new Map();
const UDP_CLIENT_TIMEOUT_MS = 5 * 60 * 1000;

udpProxyServer.on('error', (err) => {
    console.error(`[UDP] 代理服务器错误:\n${err.stack}`);
    udpProxyServer.close();
});
udpProxyServer.on('message', (msg, rinfo) => {
    console.log(`[UDP] 从客户端 ${rinfo.address}:${rinfo.port} 收到消息，长度 ${msg.length}`);
    const clientKey = `${rinfo.address}:${rinfo.port}`;
    udpClientMap.set(clientKey, { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
    udpProxyServer.send(msg, 0, msg.length, TARGET_UDP_PORT, TARGET_UDP_IP, (err) => {
        if (err) {
            console.error(`[UDP] 转发到 ${TARGET_UDP_IP}:${TARGET_UDP_PORT} 失败:`, err);
        } else {
            console.log(`[UDP] 消息已转发到 ${TARGET_UDP_IP}:${TARGET_UDP_PORT}`);
        }
    });
});
udpProxyServer.on('listening', () => {
    const address = udpProxyServer.address();
    console.log(`[UDP] 代理服务器正在监听 ${address.address}:${address.port}`);
});
setInterval(() => {
    const now = Date.now();
    for (const [key, clientInfo] of udpClientMap.entries()) {
        if (now - clientInfo.lastSeen > UDP_CLIENT_TIMEOUT_MS) {
            console.log(`[UDP] 清理过期的客户端映射: ${key}`);
            udpClientMap.delete(key);
        }
    }
}, 60 * 1000);


// --- 启动代理服务器 ---
tcpProxyServer.listen(LOCAL_TCP_PROXY_PORT, () => {
    console.log(`TCP 代理服务器 (支持CONNECT) 已启动，正在监听端口 ${LOCAL_TCP_PROXY_PORT}`);
    console.log(`  配置为HTTP代理: localhost:${LOCAL_TCP_PROXY_PORT}`);
    console.log(`  非CONNECT请求将尝试转发到默认目标: ${DEFAULT_TARGET_TCP_IP}:${DEFAULT_TARGET_TCP_PORT}`);
});

udpProxyServer.bind(LOCAL_UDP_PROXY_PORT, () => {
    console.log(`UDP 代理服务器已启动，正在监听端口 ${LOCAL_UDP_PROXY_PORT}`);
    console.log(`  将 UDP 流量 (发送到localhost:${LOCAL_UDP_PROXY_PORT}) 转发到 ${TARGET_UDP_IP}:${TARGET_UDP_PORT}`);
});

console.log("TCP (CONNECT enabled) 和 UDP 代理正在启动...");

// 优雅关闭处理 (保持不变)
process.on('SIGINT', () => {
    console.log("\n收到 SIGINT，正在关闭服务器...");
    tcpProxyServer.close(() => {
        console.log("TCP 代理服务器已关闭。");
    });
    udpProxyServer.close(() => {
        console.log("UDP 代理服务器已关闭。");
        // 等待两个服务器都关闭后再退出
        // 不过，tcpProxyServer.close() 的回调和 udpProxyServer.close() 的回调
        // 可能需要一个计数器或 Promise.all 来确保两者都完成后再 exit
        // 为简单起见，这里直接在最后一个关闭的回调中退出
        process.exit(0);
    });

    setTimeout(() => {
        console.error("无法在规定时间内正常关闭服务器，强制退出。");
        process.exit(1);
    }, 5000);
});
