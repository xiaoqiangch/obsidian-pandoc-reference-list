# 文献搜索窗口外部链接功能实现说明

本文档旨在向开发者介绍如何在文献搜索弹出窗口（`LiteratureSearchPopover`）中实现指向 CNKI 和 Google Scholar 的外部搜索链接功能。

## 功能概述

在文献搜索结果的每一项中，插件提供了两个快捷图标，允许用户一键跳转到知网（CNKI）或谷歌学术（Google Scholar）搜索该文献的标题。这有助于用户快速验证文献信息或获取全文。

## 核心实现逻辑

该功能主要在 [`src/modals/literature-search-modal.ts`](src/modals/literature-search-modal.ts) 文件的 `LiteratureSearchPopover` 类中实现。

### 1. 获取文献标题

首先，从 BibTeX 条目中提取文献标题。如果标题不存在，则回退到条目的引用键（key）。

```typescript
const entryTitle = entry.fields.title || entry.key;
```

### 2. 构建搜索链接

通过将标题进行 URL 编码，并拼接到对应平台的搜索接口 URL 中，生成最终的跳转链接。

#### CNKI 搜索链接实现

CNKI 的搜索链接使用了其高级检索的接口，并指定了相关的数据库 ID。

```typescript
// 在 CNKI 中搜索
const cnkiLink = btnContainer.createEl('a', {
    cls: 'clickable-icon pdf-plus-bib-icon',
    href: `https://kns.cnki.net/kns8s/defaultresult/index?crossids=YSTT4HG0%2CLSTPFY1C%2CJUP3MUPD%2CMPMFIG1A%2CWQ0UVIAA%2CBLZOG7CK%2CPWFIRAGL%2CEMRPGLPA%2CNLBO1Z6R%2CNN3FJMUV&korder=TI&kw=${encodeURIComponent(entryTitle)}`,
});
cnkiLink.ariaLabel = '在 CNKI 中搜索';
setIcon(cnkiLink, 'lucide-edit-3'); // 使用编辑图标表示
cnkiLink.onclick = (e) => {
    e.preventDefault();
    window.open(cnkiLink.href, '_blank');
};
```

#### Google Scholar 搜索链接实现

Google Scholar 的链接相对简单，直接将查询参数 `q` 设置为文献标题。

```typescript
// 在 Google Scholar 中搜索
const scholarLink = btnContainer.createEl('a', {
    cls: 'clickable-icon pdf-plus-bib-icon',
    href: `https://scholar.google.com/scholar?q=${encodeURIComponent(entryTitle)}`,
});
scholarLink.ariaLabel = '在 Google Scholar 中搜索';
setIcon(scholarLink, 'lucide-info'); // 使用信息图标表示
scholarLink.onclick = (e) => {
    e.preventDefault();
    window.open(scholarLink.href, '_blank');
};
```

## 技术要点总结

- **URL 编码**：必须使用 `encodeURIComponent` 对标题进行编码，以确保包含特殊字符（如空格、冒号等）的标题能被正确解析。
- **DOM 操作**：利用 Obsidian 提供的 `createEl` 方法动态创建 `<a>` 标签，并设置其 `href` 属性。
- **事件处理**：通过 `onclick` 事件调用 `window.open(url, '_blank')` 在新窗口中打开链接，同时使用 `e.preventDefault()` 阻止默认的锚点跳转行为，以获得更好的交互控制。
- **图标与提示**：使用 `setIcon` 设置 Lucide 图标，并通过 `ariaLabel` 提供悬停提示，增强用户体验。
