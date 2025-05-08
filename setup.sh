#!/bin/bash
set -e

echo "🚀 开始安装项目..."

# GitHub 仓库信息
GITHUB_USER="Limkon"
REPO_NAME="liuyanshi"
BRANCH="master"

echo "👤 GitHub 用户名: $GITHUB_USER"
echo "📦 仓库名: $REPO_NAME"
echo "🌿 分支: $BRANCH"

# 下载链接
TAR_URL="https://github.com/$GITHUB_USER/$REPO_NAME/archive/refs/heads/$BRANCH.tar.gz"
echo "📦 下载链接: $TAR_URL"

# 验证下载链接是否可访问
if ! curl -fsSL --head "$TAR_URL" >/dev/null 2>&1; then
    echo "❌ 错误：无法访问 $TAR_URL，可能是网络问题"
    exit 1
fi

# 获取当前目录
PROJECT_DIR=$(pwd)
echo "📁 项目目录: $PROJECT_DIR"

# 创建临时目录并解压项目
TEMP_DIR=$(mktemp -d)
echo "📂 临时目录: $TEMP_DIR"
if ! curl -fsSL "$TAR_URL" | tar -xz -C "$TEMP_DIR" --strip-components=1; then
    echo "❌ 错误：下载或解压 $TAR_URL 失败"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# 删除 .github 目录（如果存在）
rm -rf "$TEMP_DIR/.github"

# 复制文件到项目目录，排除 . 开头文件
# shopt -s extglob dotglob # To include dotfiles if needed, but !(.*) excludes them.
# Using * is simpler if you want all non-dotfiles. If dotfiles (except .git) are needed, adjust.
cd "$TEMP_DIR"
# Copy all files and directories, including those starting with a dot (like .env if present in repo)
# except for . and ..
# A robust way to copy all content:
if find . -maxdepth 1 -mindepth 1 -exec cp -rf '{}' "$PROJECT_DIR/" \;; then
    echo "✅ 文件已复制到 $PROJECT_DIR"
else
    echo "❌ 错误：复制文件到 $PROJECT_DIR 失败"
    rm -rf "$TEMP_DIR"
    exit 1
fi
# Original copy command for reference (excludes dotfiles):
# if ! cp -rf !(.*) "$PROJECT_DIR"; then
#     echo "❌ 错误：复制文件到 $PROJECT_DIR 失败"
#     rm -rf "$TEMP_DIR"
#     # shopt -u extglob dotglob
#     exit 1
# fi
# shopt -u extglob dotglob

rm -rf "$TEMP_DIR"
cd "$PROJECT_DIR" # 确保后续操作在项目目录中

# --- Node.js 和 npm 检查 ---
echo "🔧 检查系统 Node.js 环境..."

# 1. 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: Node.js 未安装。请先安装 Node.js (推荐 v18 或更高版本) 然后重试。"
    echo "   例如，在 Ubuntu/Debian 上: sudo apt update && sudo apt install nodejs npm"
    echo "   或从 NodeSource: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

# 2. 检查 npm 是否安装
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: npm 未安装。请确保 npm 与 Node.js 一起安装。"
    exit 1
fi

# 3. 检查 Node.js 版本 (需要 v18 或更高)
NODE_VERSION_OUTPUT=$(node -v)
# Regex to extract major version, e.g., v18.12.0 -> 18
NODE_MAJOR_VERSION=$(echo "$NODE_VERSION_OUTPUT" | sed -E 's/v([0-9]+)\..*/\1/')

DESIRED_MAJOR_VERSION="18"
if [ "$NODE_MAJOR_VERSION" -lt "$DESIRED_MAJOR_VERSION" ]; then
    echo "❌ 错误: Node.js 版本过低。需要 v$DESIRED_MAJOR_VERSION 或更高版本, 当前版本: $NODE_VERSION_OUTPUT"
    echo "   请升级您的 Node.js 版本。"
    exit 1
else
    echo "✅ Node.js 版本检查通过: $NODE_VERSION_OUTPUT"
fi
# --- Node.js 和 npm 检查结束 ---

echo "🧩 当前使用 Node: $(which node) (版本: $(node -v))"
echo "🧩 当前使用 npm: $(which npm) (版本: $(npm -v))"

# 创建最小 package.json（如果不存在）
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "📝 $PROJECT_DIR/package.json 未找到，创建空的 package.json。"
    echo "{}" > "$PROJECT_DIR/package.json"
else
    echo "👍 $PROJECT_DIR/package.json 已存在。"
fi

# 安装依赖
echo "📦 安装依赖..."
# 使用 --save-dev 或 --save-prod 根据需要将依赖项添加到 package.json 中，
# 如果仓库中的 package.json 已包含这些依赖, 单独执行 npm install 即可
# 这里按原脚本逻辑逐个安装，并假设它们是生产依赖
# 如果 package.json 已经存在且包含依赖， `npm install` 就足够了。
# 这个显式安装会添加它们到 package.json (如果它是空的或者没有这些依赖)
if npm install axios express ws cookie-parser body-parser http-proxy-middleware; then
    echo "✅ 依赖安装成功。"
else
    echo "❌ 依赖安装过程中发生错误。"
    exit 1 # npm install 失败时脚本会因 set -e 退出，这里显式退出确保清晰
fi

# 获取 node 的绝对路径，用于开机启动项
NODE_EXEC_PATH=$(command -v node)
if [ -z "$NODE_EXEC_PATH" ]; then
    echo "❌ 致命错误：无法找到 node 执行路径，即使之前检查通过。这不应该发生。"
    exit 1
fi

# 创建开机启动项
mkdir -p "$HOME/.config/autostart"
AUTOSTART_FILE="$HOME/.config/autostart/tcr-startup.desktop"
echo "🚀 创建开机启动项: $AUTOSTART_FILE"
cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Exec=bash -c "cd $PROJECT_DIR && $NODE_EXEC_PATH server.js"
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=Chatroom Server (liuyanshi)
Comment=Start liuyanshi Server automatically
EOF
chmod +x "$AUTOSTART_FILE" # 确保 desktop 文件可执行（某些桌面环境可能需要）

echo "✅ 项目安装完成！系统重启后将自动启动服务器 (liuyanshi)。"
echo "   请检查 $AUTOSTART_FILE 的内容。"
echo "   手动启动服务器: cd $PROJECT_DIR && node server.js"
