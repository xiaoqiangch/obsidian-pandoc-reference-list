# Bib Manager 跨插件通信技术规范

为了实现 Shadow Writer Plus 与 Bib Manager 插件之间的无缝集成，Bib Manager 端实现了以下通信协议。

## 1. 通信机制
使用标准的 `window.postMessage` API 进行跨插件异步通信。

## 2. 接口定义

### A. 获取文献列表
**请求 (Shadow Writer Plus -> Bib Manager):**
```json
{
  "type": "BIB_MANAGER_ENTRIES_REQUEST"
}
```

**响应 (Bib Manager -> Shadow Writer Plus):**
```json
{
  "type": "BIB_MANAGER_ENTRIES_RESPONSE",
  "entries": [
    {
      "id": "Doe2023",
      "title": "Example Paper Title",
      "authors": "John Doe, Jane Smith",
      "year": "2023",
      "citeKey": "Doe2023",
      "hasPdf": true
    }
  ]
}
```
*字段说明：*
- `id`: 条目的唯一标识符（通常为 CiteKey）。
- `title`: 文献标题。
- `authors`: 作者列表字符串，格式为 "Given Family, Given Family"。
- `year`: 出版年份。
- `citeKey`: 用于引用的键值（与 `id` 一致）。
- `hasPdf`: 布尔值，表示该条目是否关联了可用的 PDF 附件。

### B. 获取 PDF 文件内容
**请求 (Shadow Writer Plus -> Bib Manager):**
```json
{
  "type": "BIB_MANAGER_FILE_REQUEST",
  "entryId": "Doe2023"
}
```

**响应 (Bib Manager -> Shadow Writer Plus):**
```json
{
  "type": "BIB_MANAGER_FILE_RESPONSE",
  "entryId": "Doe2023",
  "name": "Doe2023.pdf",
  "mimeType": "application/pdf",
  "data": "data:application/pdf;base64,JVBERi0xLjQK..." 
}
```
*数据传输规范：*
- `data`: 包含 MIME 类型的 Base64 Data URL。
- `entryId`: 对应请求中的条目 ID。
- `name`: PDF 文件名。

## 3. 安全性建议
- 接收端应验证 `event.source` 确保消息来自合法的窗口。
- 在生产环境中，建议校验 `event.origin`。

## 4. Bib Manager 端实现参考 (Typescript)

### 核心逻辑 (BibManager 类)
```typescript
// 获取所有条目
async getAllEntriesForIntegration() {
  await this.initPromise.promise;
  const entries = Array.from(this.bibCache.values());
  
  // 如果开启了 Zotero 同步，预取链接
  if (this.plugin.settings.pullFromZotero) {
    await this.getZLinksForKeys(new Set(entries.map(e => e.id)));
  }

  return entries.map(e => {
    const zAttachmentLinks = this.zCitekeyToAttachmentLinks.get(e.id) || [];
    const localAttachmentLinks = this.parseBibFileField(e.file);
    const allAttachmentLinks = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];
    const pdfLink = allAttachmentLinks.find(link => link.toLowerCase().endsWith('.pdf'));

    return {
      id: e.id,
      title: e.title,
      authors: e.author?.map(a => `${a.given} ${a.family}`).join(', ') || '',
      year: e.year || '',
      citeKey: e.id,
      hasPdf: !!pdfLink
    };
  });
}

// 获取 PDF 数据
async getPdfDataForIntegration(entryId: string) {
  await this.initPromise.promise;
  const entry = this.bibCache.get(entryId);
  if (!entry) return null;

  const zAttachmentLinks = this.zCitekeyToAttachmentLinks.get(entryId) || [];
  const localAttachmentLinks = this.parseBibFileField(entry.file);
  const allAttachmentLinks = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];
  const pdfPath = allAttachmentLinks.find(link => link.toLowerCase().endsWith('.pdf'));

  if (pdfPath && fs.existsSync(pdfPath)) {
    const data = fs.readFileSync(pdfPath);
    const base64 = data.toString('base64');
    return {
      name: path.basename(pdfPath),
      data: `data:application/pdf;base64,${base64}`
    };
  }
  return null;
}
```

### 消息监听器 (Main 类)
```typescript
this.registerDomEvent(window, 'message', async (event: MessageEvent) => {
  const { type, entryId } = event.data;

  if (type === 'BIB_MANAGER_ENTRIES_REQUEST') {
    const entries = await this.bibManager.getAllEntriesForIntegration();
    (event.source as WindowProxy)?.postMessage({
      type: 'BIB_MANAGER_ENTRIES_RESPONSE',
      entries,
    }, { targetOrigin: event.origin });
  }

  if (type === 'BIB_MANAGER_FILE_REQUEST' && entryId) {
    const fileData = await this.bibManager.getPdfDataForIntegration(entryId);
    if (fileData) {
      (event.source as WindowProxy)?.postMessage({
        type: 'BIB_MANAGER_FILE_RESPONSE',
        entryId,
        name: fileData.name,
        mimeType: 'application/pdf',
        data: fileData.data,
      }, { targetOrigin: event.origin });
    }
  }
});
```
