import { requestUrl, Notice } from 'obsidian';
import { debugLog } from '../helpers';
import { RawLayoutBlock } from '../rag/layout';
import { getPdfPageCount } from './pdfRenderer';
import { buildPageChunks, computeMaxAttempts, mergeChunkResults, MINERU_FOOTNOTE_TYPES } from './mineruChunks';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const MINERU_BASE = 'https://mineru.net/api/v4';
const MAX_POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 3000;

// MinerU Precision Extract API limits (mineru.net/apiManage/docs).
const MAX_FILE_SIZE_MB = 200;
const MAX_PAGES_PER_TASK = 200;
const DAILY_PAGE_QUOTA = 1000;

export interface MineruConvertSettings {
  apiToken: string;
}

export interface MineruConvertResult {
  mdContent: string;
  imageCount: number;
  footnotes: string;
  layout: RawLayoutBlock[];
}

export interface MineruAutoResult {
  result: MineruConvertResult;
  backend: 'cloud' | 'local';
}

// Hardcoded MinerU options (removed from the settings panel as redundant).
const MINERU_MODEL_VERSION = 'vlm';
const LOCAL_MINERU_PATH = 'mineru';
const LOCAL_MINERU_DEVICE = 'mps';

/**
 * Well-known locations of a `mineru` CLI that is installed but not on the PATH
 * Obsidian inherits. MinerU is normally installed into a dedicated venv (the
 * upstream install instructions use `uv`/`venv`), so the executable lives in
 * that venv's bin dir and is only visible after the venv is activated — which
 * a GUI app never does. Relying on bare `spawn('mineru')` therefore failed with
 * ENOENT on a machine where mineru works fine in the terminal.
 */
const LOCAL_MINERU_CANDIDATES = [
  '~/mineru/.venv/bin/mineru',
  '~/.venv/bin/mineru',
  '~/.local/bin/mineru',
  '/opt/homebrew/bin/mineru',
  '/usr/local/bin/mineru',
];

/**
 * Resolve an executable `mineru` path, preferring PATH lookup and falling back
 * to the known venv locations. Returns the bare command when nothing is found
 * so the resulting error message still mentions `mineru`.
 */
export function resolveLocalMineruPath(
  candidates: string[] = LOCAL_MINERU_CANDIDATES,
  pathEnv: string = process.env.PATH || ''
): string {
  const isExecutable = (p: string): boolean => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  // 1) Normal PATH lookup: honours a system-wide / already-activated install.
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, LOCAL_MINERU_PATH);
    if (isExecutable(candidate)) return candidate;
  }

  // 2) Known venv / user-local install locations.
  for (const candidate of candidates) {
    const expanded = expandHome(candidate);
    if (isExecutable(expanded)) return expanded;
  }

  return LOCAL_MINERU_PATH;
}

type MineruProgressFn = (current: number, total: number, message?: string) => void;

interface MineruTaskOptions {
  apiToken: string;
  modelVersion: string;
  pageRanges?: string;
  zipSuffix?: string;
  maxAttempts?: number;
}

/**
 * Convert a PDF to Markdown using the MinerU extraction API.
 *
 * Handles images, formulas (LaTeX), tables and references automatically.
 * Workflow:
 *   1. Pre-check the file size / page count against the API limits.
 *   2. Split documents above the page limit into page-range chunks and process
 *      each chunk as its own MinerU task (upload once per chunk).
 *   3. Upload the PDF bytes to the presigned URL.
 *   4. Poll the batch extract result until the task is done.
 *   5. Download the result zip archive.
 *   6. Extract full.md and the associated images, saving images into imagesDir and
 *      rewriting the image references in the markdown to point at the saved files.
 *   7. Merge chunk markdown / layout / footnotes so page numbers stay correct.
 */
export async function convertPdfWithMineru(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  settings: MineruConvertSettings,
  onProgress?: MineruProgressFn
): Promise<MineruConvertResult> {
  const modelVersion = MINERU_MODEL_VERSION;
  const fileName = path.basename(pdfPath);

  if (!settings.apiToken) {
    throw new Error('Please configure the MinerU API token in settings.');
  }

  debugLog('MineruConverter', 'Starting MinerU conversion', { fileName, modelVersion });

  // A. Pre-check: file size and page count against the API limits.
  const stat = fs.statSync(pdfPath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > MAX_FILE_SIZE_MB) {
    throw new Error(
      `PDF 文件大小 ${sizeMB.toFixed(1)}MB 超过 MinerU 单文件 ${MAX_FILE_SIZE_MB}MB 限制，请压缩后重试。`
    );
  }

  const totalPages = await getPdfPageCount(pdfPath);

  // D. Daily quota awareness.
  if (totalPages > DAILY_PAGE_QUOTA) {
    new Notice(
      `MinerU 每日免费额度为 ${DAILY_PAGE_QUOTA} 页，本文档共 ${totalPages} 页，超出部分将进入低优先级队列。`
    );
  }

  // B. Split large documents into page-range chunks.
  const chunks = buildPageChunks(totalPages, MAX_PAGES_PER_TASK);
  if (chunks.length > 1) {
    new Notice(
      `文档共 ${totalPages} 页，将分 ${chunks.length} 次转换（每次 ≤ ${MAX_PAGES_PER_TASK} 页），进度以分片显示。`
    );
  }

  const rawResults: MineruConvertResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const [start, end] = chunks[i];
    const chunkPages = end - start + 1;
    const label = chunks.length > 1 ? `分片 ${i + 1}/${chunks.length} (${start}-${end}页)` : '';

    onProgress?.(
      i,
      chunks.length,
      label ? `MinerU 正在转换 ${label}...` : 'MinerU 正在转换...'
    );

    const task = await runMineruTask(
      pdfPath,
      imagesDir,
      imageRelativePrefix,
      {
        apiToken: settings.apiToken,
        modelVersion,
        pageRanges: `${start}-${end}`,
        zipSuffix: chunks.length > 1 ? `chunk${i + 1}` : undefined,
        maxAttempts: computeMaxAttempts(chunkPages, MAX_POLL_ATTEMPTS),
      },
      onProgress
    );
    rawResults.push(task);
  }

  // Merge chunk results so page numbers (layout / footnotes) stay correct.
  let extracted: MineruConvertResult;
  if (rawResults.length === 1) {
    extracted = rawResults[0];
  } else {
    extracted = mergeChunkResults(rawResults, chunks.map((c) => c[0]));
  }

  if (extracted.footnotes && extracted.footnotes.trim().length > 0) {
    extracted.mdContent = extracted.mdContent.trim() + '\n\n' + extracted.footnotes + '\n';
  }

  debugLog('MineruConverter', 'MinerU conversion completed', {
    mdLength: extracted.mdContent.length,
    imageCount: extracted.imageCount,
    footnoteLength: extracted.footnotes?.length || 0,
    chunks: chunks.length,
  });

  return extracted;
}

/**
 * Convert a PDF preferring the cloud MinerU API; when the cloud backend is
 * unavailable (no API token, quota exhausted, or any API error), fall back to
 * a locally-installed mineru CLI. Returns which backend produced the result so
 * callers can surface the right message.
 */
export async function convertPdfWithMineruAuto(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  settings: MineruConvertSettings,
  onProgress?: MineruProgressFn
): Promise<MineruAutoResult> {
  if (settings.apiToken) {
    try {
      const result = await convertPdfWithMineru(pdfPath, imagesDir, imageRelativePrefix, settings, onProgress);
      return { result, backend: 'cloud' };
    } catch (e: any) {
      debugLog('MineruConverter', 'Cloud MinerU failed, falling back to local', {
        error: e?.message,
      });
      onProgress?.(0, 1, '云端 MinerU 不可用，正在回退到本地 MinerU 解析...');
    }
  } else {
    debugLog('MineruConverter', 'No cloud API token configured; using local MinerU');
    onProgress?.(0, 1, '未配置云端 MinerU Token，使用本地 MinerU 解析...');
  }

  const result = await convertPdfWithLocalMineru(
    pdfPath,
    imagesDir,
    imageRelativePrefix,
    resolveLocalMineruPath(),
    LOCAL_MINERU_DEVICE,
    onProgress
  );
  return { result, backend: 'local' };
}

async function runMineruTask(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  opts: MineruTaskOptions,
  onProgress?: MineruProgressFn
): Promise<MineruConvertResult> {
  const fileName = path.basename(pdfPath);
  const dataId = fileName.replace(/\.[^.]+$/, '');
  const zipSuffix = opts.zipSuffix ? `-${opts.zipSuffix}` : '';

  onProgress?.(0, 1, 'Requesting MinerU upload URL...');
  const { batchId, uploadUrl } = await getUploadUrls(
    fileName,
    dataId,
    opts.modelVersion,
    opts.apiToken,
    opts.pageRanges
  );

  onProgress?.(0, 1, 'Uploading PDF to MinerU...');
  await uploadFile(uploadUrl, pdfPath);

  onProgress?.(0, 1, 'MinerU is processing the PDF...');
  const result = await pollBatchResult(
    batchId,
    opts.apiToken,
    onProgress,
    opts.maxAttempts
  );

  onProgress?.(0, 1, 'Downloading MinerU result...');
  const zipPath = path.join(imagesDir, `${dataId}${zipSuffix}-mineru-result.zip`);
  await downloadFile(result.fullZipUrl, zipPath, opts.apiToken);

  const extracted = extractZip(zipPath, imagesDir, imageRelativePrefix);

  // Keep the raw MinerU result zip for inspection / debugging.
  debugLog('MineruConverter', 'MinerU result zip preserved', { zipPath });

  return extracted;
}

// ---- Local mineru CLI backend ----

const LOCAL_CONVERT_TIMEOUT_MS = 3600 * 1000;

/**
 * Convert a PDF using a locally-installed mineru CLI (pipeline backend).
 *
 * The CLI runs against a temp output dir; afterwards the generated markdown,
 * content_list and images are ingested with the same post-processing as the
 * cloud result zip (footnotes, layout blocks, image path rewriting), so the
 * returned MineruConvertResult is identical in shape.
 */
async function convertPdfWithLocalMineru(
  pdfPath: string,
  imagesDir: string,
  imageRelativePrefix: string,
  mineruPath: string,
  device: string,
  onProgress?: MineruProgressFn
): Promise<MineruConvertResult> {
  const resolvedPath = expandHome(mineruPath || 'mineru');
  const fileName = path.basename(pdfPath);
  const dataId = fileName.replace(/\.[^.]+$/, '');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mineru-local-'));
  onProgress?.(0, 1, `本地 MinerU 正在解析（pipeline / ${device}）...`);

  debugLog('MineruConverter', 'Starting local MinerU conversion', {
    fileName,
    mineruPath: resolvedPath,
    device,
    tmpRoot,
  });

  await runLocalMineru(resolvedPath, pdfPath, tmpRoot, device);

  const result = ingestLocalOutput(tmpRoot, imagesDir, imageRelativePrefix, dataId);

  debugLog('MineruConverter', 'Local MinerU conversion completed', {
    mdLength: result.mdContent.length,
    imageCount: result.imageCount,
    footnoteLength: result.footnotes?.length || 0,
    tmpRoot,
  });

  return result;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function runLocalMineru(mineruPath: string, pdfPath: string, outRoot: string, device: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-p', pdfPath, '-o', outRoot, '-d', device, '-b', 'pipeline'];
    let stdout = '';
    let stderr = '';

    let child: any;
    try {
      child = spawn(mineruPath, args, {
        env: {
          ...process.env,
          // Local parsing needs no network; keep the auto-started local API on
          // loopback so proxy settings cannot break it.
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      });
    } catch (e: any) {
      reject(new Error(`无法启动本地 MinerU（${mineruPath}）: ${e.message}`));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(
        new Error(`本地 MinerU 解析超时（超过 ${Math.round(LOCAL_CONVERT_TIMEOUT_MS / 60000)} 分钟）。`)
      );
    }, LOCAL_CONVERT_TIMEOUT_MS);

    child.stdout.on('data', (d: any) => {
      stdout += d;
    });
    child.stderr.on('data', (d: any) => {
      stderr += d;
    });
    child.on('error', (e: any) => {
      clearTimeout(timer);
      if (e?.code === 'ENOENT') {
        reject(
          new Error(
            `找不到本地 MinerU 可执行文件（已尝试：${mineruPath}）。` +
              `MinerU 通常安装在独立虚拟环境中（如 ~/mineru/.venv/bin/mineru），` +
              `Obsidian 继承的 PATH 看不到它。请将 mineru 软链到 PATH 目录，例如：` +
              `ln -s ~/mineru/.venv/bin/mineru /opt/homebrew/bin/mineru`
          )
        );
        return;
      }
      reject(new Error(`本地 MinerU 进程错误: ${e.message}`));
    });
    child.on('close', (code: number) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`本地 MinerU 解析失败（exit ${code}）：${tailLog(stderr || stdout)}`));
    });
  });
}

function tailLog(text: string, max = 800): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return '…' + t.slice(t.length - max);
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: any[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function findMarkdown(root: string, dataId: string): string | null {
  const candidates = walkFiles(root).filter((f) => /\.md$/i.test(f));
  if (candidates.length === 0) return null;
  const exact = candidates.find((f) => path.basename(f, '.md') === dataId);
  if (exact) return exact;
  const full = candidates.find((f) => path.basename(f) === 'full.md');
  if (full) return full;
  return candidates.find((f) => !path.basename(f).startsWith('_')) || candidates[0];
}

function findContentList(root: string): any {
  const files = walkFiles(root);
  const v1 = files.find((f) => /_content_list\.json$/i.test(f));
  const v2 = files.find((f) => /_content_list_v2\.json$/i.test(f));
  const clPath = v1 || v2;
  if (!clPath) return null;
  try {
    return JSON.parse(fs.readFileSync(clPath, 'utf-8'));
  } catch (e) {
    debugLog('MineruConverter', 'Failed to parse local content_list.json', { clPath, error: e });
    return null;
  }
}

/**
 * Read the local mineru output tree and convert it into the same
 * MineruConvertResult produced from the cloud result zip: md content, copied
 * images with rewritten references, footnotes and normalized layout blocks.
 */
function ingestLocalOutput(
  tmpRoot: string,
  imagesDir: string,
  imageRelativePrefix: string,
  dataId: string
): MineruConvertResult {
  const mdFile = findMarkdown(tmpRoot, dataId);
  if (!mdFile) {
    throw new Error('本地 MinerU 未生成 Markdown 结果。');
  }
  const subDir = path.dirname(mdFile);

  let mdContent = fs.readFileSync(mdFile, 'utf-8');
  const contentList = findContentList(subDir);

  let imageCount = 0;
  const imgSrcDir = path.join(subDir, 'images');
  const copied: string[] = [];
  if (fs.existsSync(imgSrcDir)) {
    for (const f of walkFiles(imgSrcDir)) {
      const rel = path.relative(imgSrcDir, f);
      const dest = path.join(imagesDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      imageCount++;
      copied.push(rel);
    }
  }

  // Debug helper: dump the local output tree and detected blocks so
  // reference-loss issues can be diagnosed from the images directory.
  try {
    const blocks: ContentBlock[] = [];
    collectContentBlocks(contentList, undefined, undefined, undefined, blocks);
    const typeCount: Record<string, number> = {};
    for (const b of blocks) typeCount[b.type] = (typeCount[b.type] || 0) + 1;
    const dumpLines: string[] = ['=== local output files ==='];
    dumpLines.push(...walkFiles(subDir).map((f) => path.relative(subDir, f)));
    dumpLines.push('=== content_list block types ===');
    dumpLines.push(JSON.stringify(typeCount));
    dumpLines.push('=== footnote-type blocks ===');
    for (const b of blocks) {
      if (MINERU_FOOTNOTE_TYPES.has(b.type)) {
        dumpLines.push(`[p${b.pageIdx}][${b.type}] ${b.text.slice(0, 200)}`);
      }
    }
    fs.writeFileSync(path.join(imagesDir, '_mineru_debug.txt'), dumpLines.join('\n'), 'utf-8');
  } catch (e) {
    debugLog('MineruConverter', 'Debug dump failed', { error: e });
  }

  const footnotes = buildFootnotesMarkdown(mdContent, contentList);

  if (imageCount > 0) {
    mdContent = mdContent.replace(/\]\((?!(?:https?:)?\/\/)images?\//gi, `](${imageRelativePrefix}/`);
    mdContent = mdContent.replace(/src="images?\//gi, `src="${imageRelativePrefix}/`);
  }

  const layout = normalizeLayout(contentList);

  return { mdContent, imageCount, footnotes, layout };
}

async function getUploadUrls(
  fileName: string,
  dataId: string,
  modelVersion: string,
  token: string,
  pageRanges?: string
): Promise<{ batchId: string; uploadUrl: string }> {
  const response = await requestUrl({
    url: `${MINERU_BASE}/file-urls/batch`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      files: [
        {
          name: fileName,
          data_id: dataId,
          ...(pageRanges ? { page_ranges: pageRanges } : {}),
        },
      ],
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

  debugLog('MineruConverter', 'Upload URL obtained', { batchId, uploadUrl, pageRanges });
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
  onProgress?: MineruProgressFn,
  maxAttempts: number = MAX_POLL_ATTEMPTS
): Promise<{ fullZipUrl: string; errMsg?: string }> {
  const url = `${MINERU_BASE}/extract-results/batch/${batchId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
    collectContentBlocks(contentList, undefined, undefined, undefined, blocks);
    const typeCount: Record<string, number> = {};
    for (const b of blocks) typeCount[b.type] = (typeCount[b.type] || 0) + 1;
    dumpLines.push('=== content_list block types ===');
    dumpLines.push(JSON.stringify(typeCount));
    dumpLines.push('=== footnote-type blocks ===');
    for (const b of blocks) {
      if (MINERU_FOOTNOTE_TYPES.has(b.type)) {
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

  const layout = normalizeLayout(contentList);

  return { mdContent, imageCount, footnotes, layout };
}

interface ContentBlock {
  pageIdx: number;
  type: string;
  text: string;
  bbox: number[] | null;
}

function buildFootnotesMarkdown(mdContent: string, contentList: any): string {
  if (!contentList) return '';

  const blocks: ContentBlock[] = [];
  collectContentBlocks(contentList, undefined, undefined, undefined, blocks);

  const byPage = new Map<number, string[]>();
  for (const block of blocks) {
    if (!MINERU_FOOTNOTE_TYPES.has(block.type)) continue;
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
  inheritedBbox: number[] | null,
  out: ContentBlock[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectContentBlocks(item, inheritedPage, inheritedType, inheritedBbox, out);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const pageIdx = typeof value.page_idx === 'number' ? value.page_idx : inheritedPage;
  const ownType = typeof value.type === 'string' ? value.type : '';
  // A generic "text" leaf inside a v2 container inherits the container type.
  const type = ownType && ownType !== 'text' ? ownType : inheritedType || ownType;
  const bbox = Array.isArray(value.bbox) && value.bbox.length === 4 ? value.bbox : inheritedBbox;

  if (typeof value.text === 'string' && value.text.trim()) {
    out.push({ pageIdx: pageIdx ?? 0, type, text: value.text, bbox });
  }
  if (typeof value.content === 'string' && value.content.trim()) {
    out.push({ pageIdx: pageIdx ?? 0, type, text: value.content, bbox });
  }

  if (value.content && typeof value.content === 'object') {
    collectContentBlocks(value.content, pageIdx, type, bbox, out);
  }

  for (const key of Object.keys(value)) {
    if (['type', 'text', 'page_idx', 'bbox', 'content', 'sub_type', 'image_path'].includes(key)) {
      continue;
    }
    collectContentBlocks(value[key], pageIdx, type, bbox, out);
  }
}

function normalizeLayout(contentList: any): RawLayoutBlock[] {
  const blocks: ContentBlock[] = [];
  collectContentBlocks(contentList, undefined, undefined, undefined, blocks);

  const seen = new Set<string>();
  const out: RawLayoutBlock[] = [];
  for (const b of blocks) {
    const text = b.text.trim();
    if (!text) continue;
    const dedupeKey = `${b.pageIdx}|${b.type}|${text.slice(0, 80)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      type: b.type,
      page: b.pageIdx + 1,
      bbox: b.bbox,
      text,
    });
  }
  return out;
}

/**
 * Parse the content_list from a preserved MinerU result zip and return the
 * normalized layout blocks, or null when the archive is missing/malformed.
 * Used to backfill layout.json for documents converted before layout output
 * existed.
 */
export function readMineruContentList(zipPath: string): RawLayoutBlock[] | null {
  try {
    if (!fs.existsSync(zipPath)) return null;
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    let contentList: any = null;
    for (const entry of zip.getEntries()) {
      if (/content_list(_v2)?\.json$/i.test(entry.entryName)) {
        const parsed = JSON.parse(entry.getData().toString('utf-8'));
        if (/content_list\.json$/i.test(entry.entryName)) {
          contentList = parsed;
        } else if (!contentList) {
          contentList = parsed;
        }
      }
    }
    if (!contentList) return null;
    return normalizeLayout(contentList);
  } catch (e) {
    debugLog('MineruConverter', 'readMineruContentList failed', { zipPath, error: e });
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}