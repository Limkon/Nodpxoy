const net = require('net');
const dgram = require('dgram');
// const url = require('url'); // URL constructor is global in modern Node.js

// --- 配置 ---
const LOCAL_TCP_PROXY_PORT = 8100; // Node.js TCP 代理监听的本地端口 (HTTP代理端口)
// DEFAULT_TARGET_TCP_IP 和 DEFAULT_TARGET_TCP_PORT 不再用于动态确定HTTP目标。
// 如果需要一个“捕获所有”或真正的默认回退，需要更复杂的逻辑。
// const DEFAULT_TARGET_TCP_IP = '1.0.0.5'; // 已不再直接用于动态HTTP转发
// const DEFAULT_TARGET_TCP_PORT = 80;      // 已不再直接用于动态HTTP转发

const LOCAL_UDP_PROXY_PORT = 8100; // Node.js UDP 代理监听的本地端口
const TARGET_UDP_IP = '1.0.0.5';  // UDP 目标服务器 IP (UDP部分仍需此配置)
const TARGET_UDP_PORT = 443;      // UDP 目标服务器端口 (UDP部分仍需此配置)

// --- TCP 代理实现 (支持 HTTPS CONNECT 隧道 和 动态目标 HTTP 请求) ---
const tcpProxyServer = net.createServer((clientSocket) => {
    console.log(`[TCP] 客户端已连接: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
    const KEEPALIVE_INTERVAL = 60000; // 60 秒
    clientSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);

    let upstreamSocket; // 连接到目标服务器的socket
    let buffer = Buffer.alloc(0); // 用于暂存客户端初始数据

    clientSocket.on('data', (data) => {
        if (!upstreamSocket) { // 还没有建立到目标服务器的连接，这是初始请求
            buffer = Buffer.concat([buffer, data]);
            const requestStr = buffer.toString('utf8');

            const firstLineEnd = requestStr.indexOf('\r\n');
            if (firstLineEnd === -1) {
                if (buffer.length > 8192) {
                    console.error('[TCP] 初始请求头过大或不完整，关闭连接。');
                    clientSocket.end();
                    return;
                }
                return; // 继续等待数据，直到收到完整的请求行
            }

            const requestLine = requestStr.substring(0, firstLineEnd);
            const [method, targetUrlString, httpVersion] = requestLine.split(' ');

            console.log(`[TCP] 收到请求行: ${requestLine}`);

            if (method === 'CONNECT') {
                const [targetHost, targetPortStr] = targetUrlString.split(':');
                const targetPort = parseInt(targetPortStr, 10);

                if (!targetHost || isNaN(targetPort)) {
                    console.error(`[TCP] 无效的 CONNECT 请求目标: ${targetUrlString}`);
                    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                    return;
                }

                console.log(`[TCP] CONNECT 请求到: ${targetHost}:${targetPort}`);
                upstreamSocket = new net.Socket();
                upstreamSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);

                upstreamSocket.connect(targetPort, targetHost, () => {
                    console.log(`[TCP] CONNECT: 已连接到目标 ${targetHost}:${targetPort}`);
                    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
                    // 后续数据将通过pipe传输
                });
                
                clientSocket.pipe(upstreamSocket);
                upstreamSocket.pipe(clientSocket);

                upstreamSocket.on('error', (err) => {
                    console.error(`[TCP] CONNECT: 连接到目标 ${targetHost}:${targetPort} 错误: ${err.message}`);
                    if (!clientSocket.destroyed) {
                        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
                    }
                });
                upstreamSocket.on('end', () => {
                    console.log(`[TCP] CONNECT: 与目标 ${targetHost}:${targetPort} 的连接已关闭`);
                    if (!clientSocket.destroyed) clientSocket.end();
                });
                upstreamSocket.on('close', () => {
                    console.log(`[TCP] CONNECT: 与目标 ${targetHost}:${targetPort} 的套接字已关闭`);
                    if (!clientSocket.destroyed) clientSocket.destroy();
                });

            } else { // 处理普通的 HTTP 请求 (非 CONNECT) - 动态确定目标
                console.log(`[TCP] 非CONNECT请求 (${method})，尝试从URL动态确定目标: ${targetUrlString}`);
                let parsedTargetUrl;
                let dynamicHost;
                let dynamicPort;

                try {
                    // 客户端向代理发送请求时，应使用绝对URI，例如 GET http://example.com/path HTTP/1.1
                    if (!targetUrlString.startsWith('http://') && !targetUrlString.startsWith('https://')) {
                        // 如果不是绝对URL，我们无法确定Host，除非解析Host头部（当前未实现）
                        // 为了简单起见，我们这里要求绝对URL
                        throw new Error('非CONNECT请求需要绝对URL (http://... 或 https://...) 来确定目标。');
                    }
                    parsedTargetUrl = new URL(targetUrlString);
                    dynamicHost = parsedTargetUrl.hostname;
                    dynamicPort = parsedTargetUrl.port || (parsedTargetUrl.protocol === 'https:' ? 443 : 80);

                    if (parsedTargetUrl.protocol !== 'http:') {
                         // 这个简单的HTTP转发器不应该直接处理目标是HTTPS的请求
                         // 客户端应该使用CONNECT方法来请求HTTPS资源
                        console.error(`[TCP] HTTP: 拒绝转发到非HTTP协议的目标: ${targetUrlString}. 请使用CONNECT方法访问HTTPS资源.`);
                        clientSocket.end(`HTTP/1.1 400 Bad Request\r\n\r\nCannot proxy plain HTTP to ${parsedTargetUrl.protocol} target. Use CONNECT for HTTPS.\r\n\r\n`);
                        return;
                    }

                } catch (e) {
                    console.error(`[TCP] HTTP: 解析目标URL '${targetUrlString}' 失败: ${e.message}`);
                    clientSocket.end(`HTTP/1.1 400 Bad Request\r\n\r\nInvalid target URL for HTTP request.\r\n\r\n`);
                    return;
                }

                console.log(`[TCP] HTTP: 动态目标解析为: ${dynamicHost}:${dynamicPort}`);
                upstreamSocket = new net.Socket();
                upstreamSocket.setKeepAlive(true, KEEPALIVE_INTERVAL);

                upstreamSocket.connect(dynamicPort, dynamicHost, () => {
                    console.log(`[TCP] HTTP: 已连接到动态目标 ${dynamicHost}:${dynamicPort}`);
                    // 将客户端发送的原始请求（已缓冲）发送到目标服务器
                    // 注意：更健壮的代理可能会修改请求行（例如，从绝对URI改为相对路径）
                    // 并正确处理/转发Host头部。这里我们发送原始缓冲区。
                    upstreamSocket.write(buffer);
                    clientSocket.pipe(upstreamSocket);
                    upstreamSocket.pipe(clientSocket);
                    buffer = null; // 清空已发送的buffer
                });

                upstreamSocket.on('error', (err) => {
                    console.error(`[TCP] HTTP: 连接到动态目标 ${dynamicHost}:${dynamicPort} 错误: ${err.message}`);
                    if (!clientSocket.destroyed) {
                        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
                    }
                });
                upstreamSocket.on('end', () => {
                    console.log(`[TCP] HTTP: 与动态目标 ${dynamicHost}:${dynamicPort} 的连接已关闭`);
                     if (!clientSocket.destroyed) clientSocket.end();
                });
                upstreamSocket.on('close', () => {
                    console.log(`[TCP] HTTP: 与动态目标 ${dynamicHost}:${dynamicPort} 的套接字已关闭`);
                    if (!clientSocket.destroyed) clientSocket.destroy();
                });
            }
        } else {
            // upstreamSocket 已经建立，数据由 pipe 自动处理
            // 此处无需额外代码
        }
    });

    clientSocket.on('error', (err) => {
        console.error(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接错误: ${err.message}`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    clientSocket.on('end', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接已关闭`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.end();
    });
    clientSocket.on('close', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 套接字已关闭`);
        if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
    });
});

tcpProxyServer.on('error', (err) => {
    console.error(`[TCP] 代理服务器错误: ${err.message}`);
});

// --- UDP 代理实现 (保持不变, 仍需固定目标配置) ---
const udpProxyServer = dgram.createSocket('udp4');
// ... (UDP代码与上一版本相同，此处省略以减少重复，请从上一版本复制)
// 为了完整性，我将它包含进来：
const udpClientMap = new Map();
const UDP_CLIENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时

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
}, 60 * 1000); // 每分钟检查一次

// --- 启动代理服务器 ---
tcpProxyServer.listen(LOCAL_TCP_PROXY_PORT, () => {
    console.log(`TCP 代理服务器 (支持CONNECT和动态HTTP目标) 已启动，正在监听端口 ${LOCAL_TCP_PROXY_PORT}`);
    console.log(`  配置为HTTP代理: localhost:${LOCAL_TCP_PROXY_PORT}`);
    console.log(`  HTTP请求应使用绝对URL (例如 GET http://example.com/path HTTP/1.1)`);
});

if (TARGET_UDP_IP) { // 仅当配置了UDP目标时才启动UDP代理
    udpProxyServer.bind(LOCAL_UDP_PROXY_PORT, () => {
        console.log(`UDP 代理服务器已启动，正在监听端口 ${LOCAL_UDP_PROXY_PORT}`);
        console.log(`  将 UDP 流量 (发送到localhost:${LOCAL_UDP_PROXY_PORT}) 转发到 ${TARGET_UDP_IP}:${TARGET_UDP_PORT}`);
    });
} else {
    console.log("未配置 TARGET_UDP_IP，UDP 代理未启动。");
}


console.log("TCP (CONNECT, 动态HTTP) 和 UDP (如果已配置) 代理正在启动...");

// 优雅关闭处理 (保持不变)
process.on('SIGINT', () => {
    console.log("\n收到 SIGINT，正在关闭服务器...");
    let tcpClosed = false;
    let udpClosed = !TARGET_UDP_IP; // 如果UDP未启动，则视为已关闭

    const tryExit = () => {
        if (tcpClosed && udpClosed) {
            process.exit(0);
        }
    };

    tcpProxyServer.close(() => {
        console.log("TCP 代理服务器已关闭。");
        tcpClosed = true;
        tryExit();
    });

    if (TARGET_UDP_IP) {
        udpProxyServer.close(() => {
            console.log("UDP 代理服务器已关闭。");
            udpClosed = true;
            tryExit();
        });
    }


    setTimeout(() => {
        console.error("无法在规定时间内正常关闭服务器，强制退出。");
        process.exit(1);
    }, 5000);
});
