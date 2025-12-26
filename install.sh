#!/bin/bash

# 极简安装脚本 for Pandoc Reference List Obsidian 插件
# 目标仓库: ../testBrain
# 适用于macOS系统，无需用户交互

echo "安装 Pandoc Reference List 插件到 ../testBrain"

# 目标目录
TARGET="../testBrain/.obsidian/plugins/obsidian-pandoc-reference-list"

# 创建目录
mkdir -p "$TARGET"

# 复制文件（如果存在）
echo "复制文件..."
[ -f "manifest.json" ] && cp "manifest.json" "$TARGET/" && echo "✓ manifest.json"
[ -f "styles.css" ] && cp "styles.css" "$TARGET/" && echo "✓ styles.css"

if [ -f "main.js" ]; then
    cp "main.js" "$TARGET/"
    echo "✓ main.js"
else
    echo "⚠  main.js 不存在 - 需要先构建: npm run build"
    echo "   构建后手动复制: cp main.js \"$TARGET/\""
fi

echo ""
echo "安装完成!"
echo "插件位置: $TARGET"
echo ""
echo "在 Obsidian 中启用插件:"
echo "1. 打开仓库 '../testBrain'"
echo "2. 设置 → 社区插件 → 启用 'Pandoc Reference List'"
echo "3. 重启 Obsidian"