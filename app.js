const http = require('http');
const https = require('https');
const { URL } = require('url'); // Standard URL parser

const PROXY_PORT = 8100; // 中转服务监听的端口

const server = http.createServer((clientReq, clientRes) => {
    // clientReq.url 会是像 "/https://target-site.com/path?query=value" 这样的形式
    // 我们需要去掉第一个斜杠 "/" 来获取真正的目标 URL
    const targetUrlString = clientReq.url.substring(1);

    if (!targetUrlString) {
        console.log('[PROXY] 收到了空的目标 URL');
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
        clientRes.end('Target URL is missing.');
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlString);
    } catch (e) {
        console.error(`[PROXY] 无效的目标 URL: ${targetUrlString}. 错误: ${e.message}`);
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
        clientRes.end(`Invalid target URL: ${targetUrlString}`);
        return;
    }

    console.log(`[PROXY] CF Worker 请求: ${clientReq.method} ${clientReq.url}`);
    console.log(`[PROXY] 转发到 -> ${targetUrl.href}`);

    const options = {
        method: clientReq.method,
        headers: { ...clientReq.headers }, // 复制客户端请求的头部
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`, // 包含查询参数
        agent: false, // 关键：为每个请求创建新代理，避免keep-alive问题和头部混乱
        timeout: 30000, // 30秒超时
    };

    // 移除一些在 Node.js http.request 中不应该由我们手动设置的头部，
    // 或者需要特殊处理的头部。Node 会自动处理 'host'。
    // 'connection' 头部由 Node.js 管理。
    delete options.headers.host; // Node.js 会根据 targetUrl.hostname 自动设置 Host 头部
    // delete options.headers.connection; // 让 Node.js 处理 Connection 头部

    const httpModule = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = httpModule.request(options, (targetRes) => {
        console.log(`[PROXY] 收到来自 ${targetUrl.href} 的响应: ${targetRes.statusCode}`);
        // 将目标服务器的头部和状态码写回给原始客户端 (CF Worker)
        // 注意：某些头部可能需要特殊处理或过滤 (例如与 hop-by-hop 相关的头部)
        const responseHeaders = { ...targetRes.headers };
        // 通常不应该转发 hop-by-hop 头部
        delete responseHeaders['transfer-encoding'];
        delete responseHeaders['connection'];
        delete responseHeaders['keep-alive'];
        delete responseHeaders['proxy-authenticate'];
        delete responseHeaders['proxy-authorization'];
        delete responseHeaders['te'];
        delete responseHeaders['trailers'];
        delete responseHeaders['upgrade'];


        clientRes.writeHead(targetRes.statusCode, responseHeaders);
        targetRes.pipe(clientRes, { end: true }); // 将目标服务器的响应体 pipe 给原始客户端
    });

    proxyReq.on('timeout', () => {
        console.error(`[PROXY] 请求到 ${targetUrl.href} 超时`);
        proxyReq.destroy(); // 销毁请求
        if (!clientRes.headersSent) {
            clientRes.writeHead(504, { 'Content-Type': 'text/plain' });
        }
        clientRes.end('Gateway Timeout');
    });

    proxyReq.on('error', (e) => {
        console.error(`[PROXY] 转发到 ${targetUrl.href} 出错: ${e.message}`);
        if (!clientRes.headersSent) { // 确保只发送一次头部
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        clientRes.end(`Bad Gateway: ${e.message}`);
    });

    // 将原始客户端 (CF Worker) 的请求体 pipe 给目标服务器的请求
    // 只有在 GET/HEAD 等方法之外才有请求体
    if (clientReq.method !== 'GET' && clientReq.method !== 'HEAD') {
        clientReq.pipe(proxyReq, { end: true });
    } else {
        proxyReq.end(); // 对于 GET/HEAD 请求，没有请求体，直接结束请求
    }

    // 如果客户端意外断开连接
    clientReq.on('error', (err) => {
        console.error(`[PROXY] 客户端请求错误: ${err.message}`);
        proxyReq.destroy(); // 中断对目标服务器的请求
    });
    clientReq.on('close', () => {
        if (!clientRes.writableEnded) { // 如果响应还没有结束
            console.log('[PROXY] 客户端连接在响应完成前关闭');
            proxyReq.destroy(); // 中断对目标服务器的请求
        }
    });


});

server.on('clientError', (err, socket) => {
    console.error(`[PROXY] 客户端连接错误: ${err.message}`);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PROXY_PORT, () => {
    console.log(`[PROXY] 中转服务正在监听端口 ${PROXY_PORT}`);
    console.log(`[PROXY] CF Worker 使用示例: fetch('http://<中转IP>:${PROXY_PORT}/https://目标网站.com/路径')`);
});
