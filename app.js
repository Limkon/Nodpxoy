const net = require('net');
const dgram = require('dgram');

// --- 配置 ---
const LOCAL_TCP_PROXY_PORT = 8100; // Node.js TCP 代理监听的本地端口
const TARGET_TCP_IP = '1.0.0.5';  // TCP 目标服务器 IP
const TARGET_TCP_PORT = 443;          // TCP 目标服务器端口

const LOCAL_UDP_PROXY_PORT = 8100; // Node.js UDP 代理监听的本地端口
const TARGET_UDP_IP = '1.0.0.5';  // UDP 目标服务器 IP
const TARGET_UDP_PORT = 443;      // UDP 目标服务器端口

// --- TCP 代理实现 ---
const tcpProxyServer = net.createServer((clientSocket) => {
    console.log(`[TCP] 客户端已连接: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);

    const targetSocket = new net.Socket();

    targetSocket.connect(TARGET_TCP_PORT, TARGET_TCP_IP, () => {
        console.log(`[TCP] 已连接到目标: ${TARGET_TCP_IP}:${TARGET_TCP_PORT}`);
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', (err) => {
        console.error(`[TCP] 连接到目标 ${TARGET_TCP_IP}:${TARGET_TCP_PORT} 错误: ${err.message}`);
        clientSocket.end();
    });

    targetSocket.on('end', () => {
        console.log(`[TCP] 与目标 ${TARGET_TCP_IP}:${TARGET_TCP_PORT} 的连接已关闭`);
        clientSocket.end();
    });

    targetSocket.on('close', () => {
        console.log(`[TCP] 与目标 ${TARGET_TCP_IP}:${TARGET_TCP_PORT} 的套接字已关闭`);
    });

    clientSocket.on('error', (err) => {
        console.error(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接错误: ${err.message}`);
        targetSocket.destroy(); // 使用 destroy 确保立即关闭
    });

    clientSocket.on('end', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 连接已关闭`);
        targetSocket.end();
    });

    clientSocket.on('close', () => {
        console.log(`[TCP] 客户端 ${clientSocket.remoteAddress}:${clientSocket.remotePort} 套接字已关闭`);
    });
});

tcpProxyServer.on('error', (err) => {
    console.error(`[TCP] 代理服务器错误: ${err.message}`);
});

// --- UDP 代理实现 ---
const udpProxyServer = dgram.createSocket('udp4');

// 用于存储UDP客户端的映射，以便将响应转发回正确的源
// 键: "sourceAddress:sourcePort", 值: { address: sourceAddress, port: sourcePort, lastSeen: Date.now() }
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

    // 将消息转发到目标UDP服务器
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

// 清理过期的UDP客户端映射
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
    console.log(`TCP 代理服务器已启动，正在监听端口 ${LOCAL_TCP_PROXY_PORT}`);
    console.log(`  将 TCP 流量发送到 localhost:${LOCAL_TCP_PROXY_PORT} 以转发到 ${TARGET_TCP_IP}:${TARGET_TCP_PORT}`);
});

udpProxyServer.bind(LOCAL_UDP_PROXY_PORT, () => {
    // udpProxyServer.on('listening') 事件中已经有日志了
    console.log(`UDP 代理服务器已启动，正在监听端口 ${LOCAL_UDP_PROXY_PORT}`);
    console.log(`  将 UDP 流量发送到 localhost:${LOCAL_UDP_PROXY_PORT} 以转发到 ${TARGET_UDP_IP}:${TARGET_UDP_PORT}`);
});

console.log("TCP 和 UDP 代理正在启动...");

// 优雅关闭处理
process.on('SIGINT', () => {
    console.log("\n收到 SIGINT，正在关闭服务器...");
    tcpProxyServer.close(() => {
        console.log("TCP 代理服务器已关闭。");
    });
    udpProxyServer.close(() => {
        console.log("UDP 代理服务器已关闭。");
        process.exit(0);
    });

    // 如果服务器在短时间内没有关闭，则强制退出
    setTimeout(() => {
        console.error("无法在规定时间内正常关闭服务器，强制退出。");
        process.exit(1);
    }, 5000);
});
