#!/bin/bash

# 增强版安装脚本 for Pandoc Reference List Obsidian 插件
# 目标仓库: ../testBrain
# 功能：检查依赖、自动编译、安装插件

# 设置颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}开始安装 Pandoc Reference List 插件...${NC}"

# 1. 检查环境依赖
echo -e "\n${YELLOW}步骤 1: 检查环境依赖...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}错误: 未找到 node.js。请先安装 Node.js。${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js 已安装: $(node -v)${NC}"

# 优先使用 yarn，如果没有则使用 npm
if command -v yarn &> /dev/null; then
    PKG_MANAGER="yarn"
elif command -v npm &> /dev/null; then
    PKG_MANAGER="npm"
else
    echo -e "${RED}错误: 未找到 npm 或 yarn。请先安装包管理器。${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 包管理器已找到: $PKG_MANAGER${NC}"

# 2. 检查项目文件
if [ ! -f "package.json" ] || [ ! -f "manifest.json" ]; then
    echo -e "${RED}错误: 当前目录似乎不是插件根目录（未找到 package.json 或 manifest.json）。${NC}"
    exit 1
fi

# 3. 安装依赖并编译
echo -e "\n${YELLOW}步骤 2: 安装依赖并编译项目...${NC}"

echo "正在安装依赖..."
if [ "$PKG_MANAGER" == "yarn" ]; then
    yarn install
else
    npm install
fi

if [ $? -ne 0 ]; then
    echo -e "${RED}错误: 依赖安装失败。${NC}"
    exit 1
fi

echo "正在编译插件..."
if [ "$PKG_MANAGER" == "yarn" ]; then
    yarn build
else
    npm run build
fi

if [ $? -ne 0 ]; then
    echo -e "${RED}错误: 编译失败。${NC}"
    exit 1
fi

if [ ! -f "main.js" ]; then
    echo -e "${RED}错误: 编译完成但未找到 main.js。${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 编译成功，已生成 main.js${NC}"

# 4. 安装到目标目录
echo -e "\n${YELLOW}步骤 3: 安装到 Obsidian 仓库...${NC}"

# 目标目录
TARGET="../testBrain/.obsidian/plugins/obsidian-pandoc-reference-list"

echo "目标目录: $TARGET"

# 创建目录
mkdir -p "$TARGET"

# 复制文件
cp manifest.json "$TARGET/"
echo -e "${GREEN}✓ 已复制 manifest.json${NC}"

if [ -f "styles.css" ]; then
    cp styles.css "$TARGET/"
    echo -e "${GREEN}✓ 已复制 styles.css${NC}"
fi

cp main.js "$TARGET/"
echo -e "${GREEN}✓ 已复制 main.js${NC}"

echo -e "\n${GREEN}======================================${NC}"
echo -e "${GREEN}安装完成!${NC}"
echo -e "插件位置: ${BLUE}$TARGET${NC}"
echo -e "\n${YELLOW}后续操作:${NC}"
echo -e "1. 打开 Obsidian 仓库 '${BLUE}../testBrain${NC}'"
echo -e "2. 设置 → 社区插件 → 启用 '${BLUE}Pandoc Reference List${NC}'"
echo -e "3. 如果插件已启用，请在插件列表中点击刷新或重启 Obsidian"
echo -e "${GREEN}======================================${NC}"
