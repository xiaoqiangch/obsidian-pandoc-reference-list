# Bib Shower (Obsidian Plugin)

**Bib Shower** 是一个基于 [Pandoc Reference List](https://github.com/mgmeyers/obsidian-pandoc-reference-list) 增强开发的 Obsidian 插件。它可以在侧边栏中为当前文档中的每个 Pandoc 引用键（citekey）显示格式化后的参考文献。

## 增强功能

相比原版插件，**Bib Shower** 增加了以下功能和改进：

1.  **智能输入增强**：
    *   支持使用中文括号 `【@` 触发引用提示，并在选择后自动转换为标准的英文格式 `[@citekey]`。
    *   自动处理 Obsidian 生成的闭合括号 `]`，避免在选择文献后出现重复括号（如 `[@citekey]]`）。
2.  **强大的模糊匹配**：
    *   搜索建议现在支持对 **Citekey (ID)**、**文章标题 (Title)** 以及 **作者姓名 (Author)** 进行多字段模糊匹配。
3.  **PDF 附件支持**：
    *   自动检测 Bib 条目中的 PDF 附件（支持 Zotero 链接和本地 `file` 字段）。
    *   如果文件存在，将在侧边栏显示“打开附件”按钮。
    *   点击按钮可直接在 Obsidian 内部（右侧栏）打开 PDF 文件，无需切换到外部阅读器。
4.  **健壮的安装脚本**：
    *   提供了全新的 `install.sh` 脚本，支持自动检查环境依赖（Node.js, Yarn/NPM）、自动编译源码并安装到指定仓库。
4.  **稳定性修复**：
    *   修复了原插件在某些情况下因初始化顺序导致的 `TypeError: Cannot read properties of undefined (reading 'bind')` 运行时错误。
    *   补全了默认设置，确保插件安装后即可直接使用提示功能。

## 安装说明

### 开发者安装（从源码编译）

1.  克隆本仓库。
2.  确保系统已安装 [Pandoc](https://pandoc.org/) (建议版本 >= 2.11)。
3.  运行根目录下的安装脚本：
    ```bash
    chmod +x install.sh
    ./install.sh
    ```
    *脚本会自动安装依赖、编译插件并将其安装到 `../testBrain` 目录（你可以根据需要修改脚本中的 `TARGET` 路径）。*

### 使用说明

1.  在 Obsidian 设置中启用 **Bib Shower** 插件。
2.  在插件设置中配置参考文献文件（.bib, .json, .yaml）的路径。
3.  （可选）配置 CSL 样式文件路径或 URL。
4.  通过命令面板运行 `Bib Shower: Show reference list` 来打开侧边栏的参考文献面板。

## 致谢

本项目是在 [mgmeyers/obsidian-pandoc-reference-list](https://github.com/mgmeyers/obsidian-pandoc-reference-list) 的基础上进行的二次开发。感谢原作者的杰出工作。

---

<img src="https://raw.githubusercontent.com/mgmeyers/obsidian-pandoc-reference-list/main/Screen%20Shot.png" alt="插件工作截图">
