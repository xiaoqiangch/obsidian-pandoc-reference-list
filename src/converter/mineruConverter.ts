import { requestUrl } from 'obsidian';
import { debugLog } from '../helpers';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const MINERU_BASE = 'https://mineru.net/api/v4';
const MAX_POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 3000;

export interface MineruConvertSettings {
  apiToken: string;
  modelVersion?: string;
}

export interface MineruConvertResult {
  mdContent: string;
  imageCount: number;
  footnotes: string;
}

type MineruProgressFn = (current: number, total: number, message?: string) => void;

/**
 * Convert a PDF to Markdown using the MinerU extraction API.
 *
 * Handles images, formulas (LaTeX), tables and references automatically.
 * Workflow:
 *   1. Request a presigned upload URL for the PDF.
 *   2. Upload the PDF bytes to the presigned URL.
 *   3. Poll the batch extract result until the task is done.
 *   4. Download the result zip archive.
 *   5. Extract full.md and the associated images, saving images into imagesDir and
 *      rewriting the image references in the markdown to point at the saved files.
 */
export async function convertPdfWithMineru(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  settings: MineruConvertSettings,
  onProgress?: MineruProgressFn
): Promise<MineruConvertResult> {
  if (!settings.apiToken) {
    throw new Error('Please configure the MinerU API token in settings.');
  }

  const modelVersion = settings.modelVersion || 'vlm';
  const fileName = path.basename(pdfPath);
  const dataId = fileName.replace(/\.[^.]+$/, '');

  debugLog('MineruConverter', 'Starting MinerU conversion', { fileName, modelVersion });

  onProgress?.(0, 1, 'Requesting MinerU upload URL...');
  const { batchId, uploadUrl } = await getUploadUrls(fileName, dataId, modelVersion, settings.apiToken);

  onProgress?.(0, 1, 'Uploading PDF to MinerU...');
  await uploadFile(uploadUrl, pdfPath);

  onProgress?.(0, 1, 'MinerU is processing the PDF...');
  const result = await pollBatchResult(batchId, settings.apiToken, onProgress);

  onProgress?.(0, 1, 'Downloading MinerU result...');
  const zipPath = path.join(imagesDir, `${dataId}-mineru-result.zip`);
  await downloadFile(result.fullZipUrl, zipPath, settings.apiToken);

  const extracted = extractZip(zipPath, imagesDir, imageRelativePrefix);

  if (extracted.footnotes && extracted.footnotes.trim().length > 0) {
    extracted.mdContent = extracted.mdContent.trim() + '\n\n' + extracted.footnotes + '\n';
  }

  // Keep the raw MinerU result zip for inspection / debugging.
  debugLog('MineruConverter', 'MinerU result zip preserved', { zipPath });

  debugLog('MineruConverter', 'MinerU conversion completed', {
    mdLength: extracted.mdContent.length,
    imageCount: extracted.imageCount,
    footnoteLength: extracted.footnotes?.length || 0,
  });

  return extracted;
}

async function getUploadUrls(
  fileName: string,
  dataId: string,
  modelVersion: string,
  token: string
): Promise<{ batchId: string; uploadUrl: string }> {
  const response = await requestUrl({
    url: `${MINERU_BASE}/file-urls/batch`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      files: [{ name: fileName, data_id: dataId }],
      model_version: modelVersion,
    }),
  }).catch((e: any) => {
    throw new Error(
      `MinerU upload URL request failed (${e?.status ?? 'error'})${e?.message ? `: ${e.message}` : ''}.`
    );
  });

  const json = response.json;
  if (!json || json.code !== 0) {
    throw new Error(json?.msg || 'Failed to request MinerU upload URL.');
  }

  const batchId = json.data?.batch_id;
  const uploadUrl = json.data?.file_urls?.[0];
  if (!batchId || !uploadUrl) {
    throw new Error('MinerU did not return an upload URL.');
  }

  debugLog('MineruConverter', 'Upload URL obtained', { batchId, uploadUrl });
  return { batchId, uploadUrl };
}

function uploadFile(uploadUrl: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(uploadUrl);
    const mod = urlObj.protocol === 'http:' ? http : https;
    const fileSize = fs.statSync(filePath).size;

    // The MinerU presigned OSS URL only signs the PUT method + host header.
    // Sending extra headers such as Content-Type breaks the signature and
    // causes a 403 SignatureDoesNotMatch, so omit them. Content-Length is
    // required to avoid Transfer-Encoding: chunked.
    const req = mod.request(
      urlObj,
      {
        method: 'PUT',
        headers: {
          'Content-Length': fileSize,
        },
      },
      (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `MinerU upload failed with status ${res.statusCode}${body ? `: ${body}` : ''}.`
              )
            );
          }
        });
      }
    );

    req.on('error', (e: any) => reject(e));
    fs.createReadStream(filePath)
      .on('error', (e: any) => reject(e))
      .pipe(req);
  });
}

async function pollBatchResult(
  batchId: string,
  token: string,
  onProgress?: MineruProgressFn
): Promise<{ fullZipUrl: string; errMsg?: string }> {
  const url = `${MINERU_BASE}/extract-results/batch/${batchId}`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    }).catch((e: any) => {
      throw new Error(
        `MinerU result query failed (${e?.status ?? 'error'})${e?.message ? `: ${e.message}` : ''}.`
      );
    });

    const json = response.json;
    if (!json || json.code !== 0) {
      throw new Error(json?.msg || 'Failed to query MinerU extraction result.');
    }

    const result = json.data?.extract_result?.[0];
    if (!result) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const state = result.state;
    if (state === 'done') {
      if (!result.full_zip_url) {
        throw new Error('MinerU task completed but no result archive was returned.');
      }
      return { fullZipUrl: result.full_zip_url, errMsg: result.err_msg };
    }

    if (state === 'failed') {
      throw new Error(result.err_msg || 'MinerU extraction failed.');
    }

    const progress = result.extract_progress;
    if (progress) {
      onProgress?.(
        progress.extracted_pages || 0,
        progress.total_pages || 1,
        `MinerU is extracting pages (${progress.extracted_pages || 0}/${progress.total_pages || 1})...`
      );
    } else {
      onProgress?.(0, 1, 'MinerU is processing the PDF...');
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('MinerU extraction timed out.');
}

function downloadFile(url: string, destPath: string, token?: string, useAuth?: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'http:' ? http : https;
    const options: any = useAuth && token ? { headers: { Authorization: `Bearer ${token}` } } : {};

    const handle = (res: any) => {
      if (
        res.statusCode &&
        (res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 303 ||
          res.statusCode === 307 ||
          res.statusCode === 308)
      ) {
        res.resume();
        if (res.headers.location) {
          downloadFile(new URL(res.headers.location, url).toString(), destPath, token, useAuth).then(
            resolve,
            reject
          );
          return;
        }
        reject(new Error('MinerU download redirect with no location.'));
        return;
      }

      if (res.statusCode === 403 && token && !useAuth) {
        res.resume();
        downloadFile(url, destPath, token, true).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`MinerU result download failed with status ${res.statusCode}.`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (e: any) => {
        try {
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup errors
        }
        reject(e);
      });
    };

    mod.get(urlObj, options, handle).on('error', (e: any) => reject(e));
  });
}

function extractZip(
  zipPath: string,
  imagesDir: string,
  imageRelativePrefix: string
): MineruConvertResult {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  let mdContent = '';
  let imageCount = 0;
  let contentList: any = null;

  for (const entry of entries) {
    const entryName = entry.entryName;
    if (entry.isDirectory) continue;

    if (/full\.md$/i.test(entryName)) {
      mdContent = entry.getData().toString('utf-8');
      continue;
    }

    if (/content_list(_v2)?\.json$/i.test(entryName)) {
      try {
        const parsed = JSON.parse(entry.getData().toString('utf-8'));
        // Prefer the v1 content_list.json; fall back to v2 only if v1 is absent.
        if (/content_list\.json$/i.test(entryName)) {
          contentList = parsed;
        } else if (!contentList) {
          contentList = parsed;
        }
      } catch (e) {
        debugLog('MineruConverter', 'Failed to parse content_list.json', { entryName, error: e });
      }
      continue;
    }

    if (/^images?\//i.test(entryName)) {
      const relName = entryName.replace(/^images?\//i, '');
      const destPath = path.join(imagesDir, relName);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      imageCount++;
    }
  }

  // Debug helper: dump the zip layout and detected blocks so reference-loss
  // issues can be diagnosed from the produced images directory.
  try {
    const dumpLines: string[] = ['=== zip entries ==='];
    for (const entry of entries) dumpLines.push(entry.entryName);
    const blocks: ContentBlock[] = [];
    collectContentBlocks(contentList, undefined, undefined, blocks);
    const typeCount: Record<string, number> = {};
    for (const b of blocks) typeCount[b.type] = (typeCount[b.type] || 0) + 1;
    dumpLines.push('=== content_list block types ===');
    dumpLines.push(JSON.stringify(typeCount));
    dumpLines.push('=== footnote-type blocks ===');
    for (const b of blocks) {
      if (FOOTNOTE_TYPES.has(b.type)) {
        dumpLines.push(`[p${b.pageIdx}][${b.type}] ${b.text.slice(0, 200)}`);
      }
    }
    fs.writeFileSync(path.join(imagesDir, '_mineru_debug.txt'), dumpLines.join('\n'), 'utf-8');
  } catch (e) {
    debugLog('MineruConverter', 'Debug dump failed', { error: e });
  }

  if (!mdContent) {
    mdContent = '';
  }

  const footnotes = buildFootnotesMarkdown(mdContent, contentList);

  if (imageCount > 0) {
    mdContent = mdContent.replace(/\]\((?!(?:https?:)?\/\/)images?\//gi, `](${imageRelativePrefix}/`);
    mdContent = mdContent.replace(/src="images?\//gi, `src="${imageRelativePrefix}/`);
  }

  return { mdContent, imageCount, footnotes };
}

interface ContentBlock {
  pageIdx: number;
  type: string;
  text: string;
}

const FOOTNOTE_TYPES = new Set(['page_footnote', 'footer', 'aside_text', 'ref_text']);

function buildFootnotesMarkdown(mdContent: string, contentList: any): string {
  if (!contentList) return '';

  const blocks: ContentBlock[] = [];
  collectContentBlocks(contentList, undefined, undefined, blocks);

  const byPage = new Map<number, string[]>();
  for (const block of blocks) {
    if (!FOOTNOTE_TYPES.has(block.type)) continue;
    const list = byPage.get(block.pageIdx) || [];
    list.push(block.text);
    byPage.set(block.pageIdx, list);
  }

  if (byPage.size === 0) return '';

  const pageNums = [...byPage.keys()].sort((a, b) => a - b);
  const lines: string[] = ['', '<!-- MINERU_FOOTNOTES -->', '## 页下注与注释', ''];
  let added = 0;

  for (const page of pageNums) {
    const texts = byPage.get(page);
    if (!texts) continue;
    const pageText = texts.join('\n').trim();
    if (!pageText) continue;
    // Skip pages whose footnote text is already present in the markdown body
    // to avoid duplication when the model already inlined the footnotes.
    const fingerprint = pageText.slice(0, 40).replace(/\s+/g, ' ');
    if (mdContent.includes(fingerprint)) continue;

    lines.push(`### 第 ${page + 1} 页`, '');
    for (const line of pageText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) lines.push(`> ${trimmed}`);
      else lines.push('>');
    }
    lines.push('');
    added++;
  }

  if (added === 0) return '';
  return lines.join('\n');
}

function collectContentBlocks(
  value: any,
  inheritedPage: number | undefined,
  inheritedType: string | undefined,
  out: ContentBlock[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectContentBlocks(item, inheritedPage, inheritedType, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const pageIdx = typeof value.page_idx === 'number' ? value.page_idx : inheritedPage;
  const ownType = typeof value.type === 'string' ? value.type : '';
  // A generic "text" leaf inside a v2 container inherits the container type.
  const type = ownType && ownType !== 'text' ? ownType : inheritedType || ownType;

  if (typeof value.text === 'string' && value.text.trim()) {
    out.push({ pageIdx: pageIdx ?? 0, type, text: value.text });
  }
  if (typeof value.content === 'string' && value.content.trim()) {
    out.push({ pageIdx: pageIdx ?? 0, type, text: value.content });
  }

  if (value.content && typeof value.content === 'object') {
    collectContentBlocks(value.content, pageIdx, type, out);
  }

  for (const key of Object.keys(value)) {
    if (['type', 'text', 'page_idx', 'bbox', 'content', 'sub_type', 'image_path'].includes(key)) {
      continue;
    }
    collectContentBlocks(value[key], pageIdx, type, out);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}