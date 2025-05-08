# 留言室应用

传信室 是一个简洁、现代的实时聊天应用，旨在为用户提供流畅的沟通体验。无论是朋友间的轻松对话还是团队协作，传信室都能通过直观的界面和强大的功能满足你的需求。项目采用 HTML、CSS 和 JavaScript 构建，支持深色模式、移动端适配以及房间管理功能。
特性
实时聊天：支持即时消息发送，左右气泡区分用户，沟通更清晰。

用户列表：实时显示在线用户，轻松掌握房间动态。

深色模式：切换明暗主题，保护眼睛，适应不同环境。

移动端适配：响应式设计，确保手机和平板上的流畅体验。

房间管理：创建、加入或销毁聊天房间，灵活控制会话。

轻量高效：简洁的代码结构，易于部署和扩展。


- 支持[alwaysdata](https://www.alwaysdata.com/en/)空间一键安装，SSH登陆后执行以下命令，安装完成后在alwaysdata空间设置中找到Command*添加node server.js
     ```bash
     bash <(curl -fsSL https://raw.githubusercontent.com/Limkon/liuyanshi/master/setup.sh)
     ```
## 项目结构

project/   
├── public/   
│   └── index.html   
├── server.js   
├── package.json   
└── node_modules/ (安装依赖后生成)   

- `index.html`: 客户端代码，提供聊天室界面和 WebSocket 交互。
- `server.js`: 服务器代码，处理 WebSocket 连接、消息广播和用户管理。
- `package.json`: 定义项目元数据和依赖。

## 环境要求

- **操作系统**: Windows、Linux 或 macOS
- **Node.js**: 版本 14.x 或更高（推荐 LTS 版本）
- **浏览器**: 支持 WebSocket 的现代浏览器（Chrome、Firefox、Edge 等）
- **网络**: 本地测试需开放指定端口（默认 8100）；云部署需配置防火墙和域名
- **依赖**: `express` 和 `ws`（WebSocket 库）

## 本地部署

### 1. 准备项目

1. **创建项目目录**:
   - 创建目录（例如 `chatroom`），将以下文件放入：
     - `public/index.html`（客户端代码）
     - `server.js`（服务器代码）

2. **初始化 `package.json`**:
   - 在项目根目录运行：
     ```bash
     npm init -y
     ```
   - 编辑 `package.json`，添加以下内容：
     ```json
     {
       "name": "chatroom",
       "version": "1.0.0",
       "scripts": {
         "start": "node server.js"
       },
       "dependencies": {
         "express": "^4.17.1",
         "ws": "^8.8.0"
       }
     }
     ```

### 2. 安装依赖

- 运行：
  ```bash
  npm install

这将安装 express 和 ws，并创建 node_modules/ 目录。

3. 启动服务器
运行：
bash

npm start

服务器将在端口 8100 运行，控制台输出：

服务器运行在端口 8100

4. 测试应用
打开浏览器，访问 http://localhost:8100。

输入用户名，点击“加入”，发送消息（支持回车键）。

打开多个浏览器窗口，测试多用户聊天和断开连接（关闭窗口）时聊天内容清除。

检查服务器控制台日志，确认 WebSocket 连接、消息发送和断开行为。

5. 调试
无法访问:
确保端口 8100 未被占用（netstat -an）。

检查防火墙是否允许 8100 端口。

WebSocket 连接失败:
确认 server.js 运行正常。

检查浏览器开发者工具（F12）的控制台和网络标签。

