# Pandoc Reference List 插件安装脚本

为 Obsidian 插件 "Pandoc Reference List" 提供的 macOS 安装脚本。

## 脚本说明

### 1. `install.sh` - 完整安装脚本
- 交互式脚本，会检查所有必要文件
- 如果 `main.js` 不存在会提示用户
- 提供详细的安装指引

### 2. `install-simple.sh` - 极简安装脚本  
- 非交互式，直接复制文件
- 如果 `main.js` 不存在会显示警告
- 最简单直接的安装方式

## 使用方法

### 前提条件
1. 确保目标 Obsidian 仓库存在：`../testBrain`
2. 确保在插件项目根目录运行脚本

### 安装步骤

```bash
# 1. 给脚本添加执行权限
chmod +x install-simple.sh

# 2. 运行安装脚本
./install-simple.sh

# 3. 如果需要，先构建插件
npm install
npm run build

# 4. 再次运行脚本复制 main.js
./install-simple.sh
```

### 或者使用完整脚本
```bash
chmod +x install.sh
./install.sh
```

## 文件说明

安装脚本会复制以下文件到目标目录：
- `manifest.json` - 插件清单文件（必需）
- `styles.css` - 样式文件（必需）
- `main.js` - 主JavaScript文件（构建后生成）

目标目录：`../testBrain/.obsidian/plugins/obsidian-pandoc-reference-list/`

## 在 Obsidian 中启用插件

1. 打开 Obsidian
2. 打开仓库 `../testBrain`
3. 进入设置 → 社区插件
4. 找到 "Pandoc Reference List" 并启用
5. 可能需要重启 Obsidian

## 注意事项

- 如果 `main.js` 不存在，需要先构建插件：`npm run build` 或 `yarn build`
- 确保在插件项目根目录运行脚本（包含 `package.json` 的目录）
- 脚本仅适用于 macOS/Linux 系统