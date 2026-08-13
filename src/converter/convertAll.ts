import { Notice } from 'obsidian';
import { getVaultRoot, debugLog } from '../helpers';
import {
  getAttachmentPath,
  convertToMarkdown,
  isConversionInProgress,
  forceReconvert,
  ConvertSettings,
  ConvertProgress,
} from './index';
import type { PartialCSLEntry } from '../bib/types';

const fs = require('fs');
const path = require('path');
const os = require('os');

export interface AttachmentStat {
  total: number;
  converted: number;
  pending: number;
  inProgress: number;
  failed: number;
  noAttachment: number;
}

export interface BatchItem {
  entry: PartialCSLEntry;
  attachment: string;
  status: 'pending' | 'converted' | 'in_progress' | 'failed' | 'no_attachment';
}

export interface BatchProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  currentCitekey: string | null;
  currentMessage: string | null;
  items: BatchItem[];
  // Per-citekey conversion progress (page/total), set during conversion.
  pageProgress: { citekey: string; current: number; total: number; message?: string } | null;
}

/** Snapshot object shared with the settings tab via get/set. */
const state: BatchProgress = {
  running: false,
  done: 0,
  total: 0,
  failed: 0,
  currentCitekey: null,
  currentMessage: null,
  items: [],
  pageProgress: null,
};

const QUOTA_ERROR_RE = /429|quota|QuotaExceeded|AccountQuotaExceeded/i;

/**
 * Ground-truth "converted" check: a conversion is done when the output .md
 * exists and is non-empty. The ConversionStateManager may still hold a
 * `failed`/`in_progress` status for such a document (e.g. MinerU finished the
 * extraction and wrote the md, but a later step such as BibTeX extraction hit
 * a quota error and flipped the state to failed). Treating the file as the
 * source of truth prevents re-converting documents that already have output.
 */
function isConvertedOnDisk(plugin: any, citekey: string): boolean {
  try {
    const outputPath = plugin.settings?.convertOutputPath || 'literature';
    const vaultRoot = getVaultRoot();
    const mdPath = path.join(vaultRoot, outputPath, `${citekey}.md`);
    return fs.existsSync(mdPath) && fs.statSync(mdPath).size > 0;
  } catch {
    return false;
  }
}

/**
 * MinerU free tier caps. The 429 handler stops the batch when the server says
 * the account quota is exhausted; on top of that we pre-track the number of
 * PDF pages submitted today so a long batch pauses *before* hammering the API
 * with requests that will all fail.
 */
const MINERU_DAILY_PAGE_QUOTA = 1000;

interface QuotaState {
  date: string;
  pages: number;
}

function quotaStateFile(): string {
  return path.join(os.tmpdir(), 'bib-manager-convert-quota.json');
}

function readQuotaState(): QuotaState {
  try {
    const f = quotaStateFile();
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const today = new Date().toISOString().slice(0, 10);
      if (d.date === today) return d;
    }
  } catch {
    // ignore corrupt state
  }
  return { date: new Date().toISOString().slice(0, 10), pages: 0 };
}

function writeQuotaState(q: QuotaState): void {
  try {
    fs.writeFileSync(quotaStateFile(), JSON.stringify(q), 'utf-8');
  } catch {
    // ignore write errors
  }
}

async function pdfPageCount(filePath: string): Promise<number> {
  const { getPdfPageCount } = await import('./pdfRenderer');
  return getPdfPageCount(filePath);
}

export function getBatchProgress(): BatchProgress {
  return state;
}

/**
 * Enumerate every entry in the loaded bibliography and classify its
 * attachment conversion state. Uses the same attachment resolution as the
 * in-app "转换MD" button (getAttachmentPath), so counts match what the user
 * sees in the reference list.
 */
export async function collectAttachmentStats(plugin: any): Promise<AttachmentStat> {
  const stat: AttachmentStat = {
    total: 0,
    converted: 0,
    pending: 0,
    inProgress: 0,
    failed: 0,
    noAttachment: 0,
  };

  const bibCache = plugin.bibManager?.bibCache as Map<string, PartialCSLEntry> | undefined;
  if (!bibCache) return stat;
  stat.total = bibCache.size;

  for (const entry of bibCache.values()) {
    const attachment = await getAttachmentPath(entry, plugin);
    if (!attachment) {
      stat.noAttachment++;
      continue;
    }
    if (isConvertedOnDisk(plugin, entry.id)) {
      stat.converted++;
    } else if (isConversionInProgress(entry.id)) {
      stat.inProgress++;
    } else {
      stat.pending++;
    }
  }
  return stat;
}

/**
 * Build the ordered list of entries to convert in a batch (those with an
 * attachment that is not already completed).
 */
export async function buildBatchQueue(plugin: any): Promise<BatchItem[]> {
  const bibCache = plugin.bibManager?.bibCache as Map<string, PartialCSLEntry> | undefined;
  const items: BatchItem[] = [];
  if (!bibCache) return items;

  for (const entry of bibCache.values()) {
    const attachment = await getAttachmentPath(entry, plugin);
    if (!attachment) {
      items.push({ entry, attachment: '', status: 'no_attachment' });
      continue;
    }
    if (isConvertedOnDisk(plugin, entry.id)) {
      items.push({ entry, attachment, status: 'converted' });
      continue;
    }
    if (isConversionInProgress(entry.id)) {
      items.push({ entry, attachment, status: 'in_progress' });
      continue;
    }
    items.push({ entry, attachment, status: 'pending' });
  }
  return items;
}

/**
 * Serial batch conversion of every pending entry. Reuses the plugin's own
 * convertToMarkdown pipeline so output is identical to clicking "转换MD".
 * Stops early when MinerU quota is exhausted; skipped entries remain pending
 * so a later run continues from where it stopped.
 */
export async function runBatchConversion(plugin: any): Promise<void> {
  if (state.running) {
    new Notice('批量转换已在进行中。');
    return;
  }

  const settings = plugin.settings;
  const outputPath = settings.convertOutputPath || 'literature';
  const engine = settings.convertEngine || 'mineru';
  const apiUrl = settings.convertModelApiUrl || 'https://ark.cn-beijing.volces.com/api/v3';
  const apiKey = settings.convertModelApiKey || settings.deepseekApiKey;
  const modelName = settings.convertModelName || 'doubao-seed-2-0-lite-260428';

  if (engine === 'mineru' && !settings.mineruApiToken) {
    new Notice('请先在设置中配置 MinerU API Token。');
    return;
  }
  if (engine !== 'mineru' && !apiKey) {
    new Notice('请先配置转换模型设置。');
    return;
  }

  const queue = (await buildBatchQueue(plugin)).filter((i) => i.status === 'pending');
  if (queue.length === 0) {
    new Notice('没有待转换的附件。');
    return;
  }

  const convertSettings: ConvertSettings = {
    outputPath,
    engine,
    llm: { apiUrl, apiKey, modelName },
    mineru: {
      apiToken: settings.mineruApiToken || '',
      modelVersion: settings.mineruModelVersion || 'vlm',
    },
  };

  state.running = true;
  state.done = 0;
  state.total = queue.length;
  state.failed = 0;
  state.currentCitekey = null;
  state.currentMessage = null;
  state.items = await buildBatchQueue(plugin);
  state.pageProgress = null;
  debugLog('ConvertAll', 'Batch conversion started', { total: queue.length });

  let quotaExhausted = false;
  let quotaPaused = false;
  try {
    for (let i = 0; i < queue.length; i++) {
      if (quotaExhausted) break;
      const item = queue[i];
      state.done = i;
      state.currentCitekey = item.entry.id;
      state.currentMessage = '正在转换...';

      // MinerU daily page pre-check: pause before exceeding the free daily cap.
      let itemPages = 0;
      if (engine === 'mineru' && /\.pdf$/i.test(item.attachment)) {
        try {
          itemPages = await pdfPageCount(item.attachment);
          const quota = readQuotaState();
          if (quota.pages + itemPages > MINERU_DAILY_PAGE_QUOTA) {
            debugLog('ConvertAll', 'Daily MinerU quota would be exceeded; pausing', {
              citekey: item.entry.id,
              used: quota.pages,
              adding: itemPages,
              cap: MINERU_DAILY_PAGE_QUOTA,
            });
            new Notice(
              `MinerU 每日 ${MINERU_DAILY_PAGE_QUOTA} 页配额将超限（已用 ${quota.pages} 页，本文件 ${itemPages} 页），批量转换暂停。可明天重跑续传。`
            );
            quotaPaused = true;
            break;
          }
        } catch {
          // page count failure is non-fatal; let the conversion attempt anyway
        }
      }

      const onProgress = (p: ConvertProgress) => {
        state.pageProgress = {
          citekey: item.entry.id,
          current: p.currentPage,
          total: p.totalPages,
          message: p.message,
        };
      };

      try {
        const result = await convertToMarkdown(item.entry, item.attachment, convertSettings, onProgress);
        if (result) {
          const bq = state.items.find((b) => b.entry.id === item.entry.id);
          if (bq) bq.status = 'converted';
          // Accumulate the daily page count after a successful PDF conversion.
          if (engine === 'mineru' && itemPages > 0) {
            const quota = readQuotaState();
            quota.pages += itemPages;
            writeQuotaState(quota);
            debugLog('ConvertAll', 'MinerU daily page quota updated', {
              used: quota.pages,
              cap: MINERU_DAILY_PAGE_QUOTA,
            });
          }
          debugLog('ConvertAll', 'Converted', { citekey: item.entry.id });
        } else {
          state.failed++;
          const bq = state.items.find((b) => b.entry.id === item.entry.id);
          if (bq) bq.status = 'failed';
          debugLog('ConvertAll', 'Conversion returned null', { citekey: item.entry.id });
        }
      } catch (e: any) {
        state.failed++;
        const bq = state.items.find((b) => b.entry.id === item.entry.id);
        if (bq) bq.status = 'failed';
        debugLog('ConvertAll', 'Conversion failed', { citekey: item.entry.id, error: e.message });
        if (QUOTA_ERROR_RE.test(`${e?.status ?? ''} ${e?.message ?? ''}`)) {
          quotaExhausted = true;
          new Notice('MinerU 配额已耗尽，批量转换已暂停。可稍后重试继续剩余条目。');
        }
      }
      state.pageProgress = null;
    }
  } finally {
    state.running = false;
    state.currentCitekey = null;
    state.currentMessage = null;
    state.done = state.total;
    state.items = await buildBatchQueue(plugin);
    debugLog('ConvertAll', 'Batch finished', {
      total: queue.length,
      failed: state.failed,
      quotaExhausted,
      quotaPaused,
    });
    new Notice(
      quotaExhausted || quotaPaused
        ? `批量转换暂停：MinerU 配额限制（已完成 ${state.total - state.failed}/${state.total}）。`
        : `批量转换完成：成功 ${state.total - state.failed}，失败 ${state.failed}。`
    );
  }
}

/** Helper for the settings tab to know the vault output directory. */
export function getOutputPath(plugin: any): string {
  return plugin.settings.convertOutputPath || 'literature';
}

/**
 * Clear the conversion state and generated files for every entry that has an
 * attachment, so a subsequent batch run re-converts everything from scratch.
 */
export async function forceReconvertAll(plugin: any): Promise<void> {
  const outputPath = plugin.settings.convertOutputPath || 'literature';
  const bibCache = plugin.bibManager?.bibCache as Map<string, PartialCSLEntry> | undefined;
  if (!bibCache) return;

  let cleared = 0;
  for (const entry of bibCache.values()) {
    const attachment = await getAttachmentPath(entry, plugin);
    if (!attachment) continue;
    if (isConvertedOnDisk(plugin, entry.id) || isConversionInProgress(entry.id)) {
      forceReconvert(entry.id, outputPath);
      cleared++;
    }
  }
  debugLog('ConvertAll', 'forceReconvertAll cleared', { cleared });
  new Notice(`已清除 ${cleared} 条已转换/进行中记录的转换状态与文件。`);
}
