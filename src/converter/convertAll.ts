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

/**
 * Ground-truth "converted" check: a conversion is done when the output .md
 * exists and is non-empty. The ConversionStateManager may still hold a
 * `failed`/`in_progress` status for such a document (e.g. MinerU finished the
 * extraction and wrote the md, but a later step such as BibTeX extraction hit
 * an error and flipped the state to failed). Treating the file as the
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

export function getBatchProgress(): BatchProgress {
  return state;
}

/**
 * Make Zotero attachment links available before classification. The plugin
 * fills zCitekeyToAttachmentLinks lazily (only for citekeys rendered in the
 * reference pane), so stats run straight after startup would otherwise see an
 * empty map and report entries with Zotero-stored PDFs as "no attachment".
 * Entries that already have a resolvable local bib `file` path are skipped.
 */
async function ensureZoteroLinks(plugin: any, entries: PartialCSLEntry[]): Promise<void> {
  const bibManager = plugin.bibManager;
  if (!plugin.settings?.pullFromZotero || !bibManager?.getZLinksForKeys) return;

  const need: string[] = [];
  for (const entry of entries) {
    if (isConvertedOnDisk(plugin, entry.id)) continue;
    const local = bibManager.parseBibFileField(entry.file);
    if (!local.some((p: string) => fs.existsSync(p))) {
      need.push(entry.id);
    }
  }
  if (need.length === 0) return;
  try {
    await bibManager.getZLinksForKeys(new Set(need));
  } catch (e: any) {
    debugLog('ConvertAll', 'Zotero attachment lookup failed', { error: e.message });
  }
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

  // Fetch Zotero attachment links for entries with no local bib `file` first,
  // so Zotero-stored PDFs/EPUBs are not misclassified as "无附件".
  await ensureZoteroLinks(plugin, Array.from(bibCache.values()));

  for (const entry of bibCache.values()) {
    // Conversion state is decided by the output md, *before* attachment
    // resolution. An already-converted paper must keep counting as converted
    // even when its source attachment can no longer be resolved (the PDF was
    // moved/renamed, or the links live in Zotero and Zotero is not running so
    // zCitekeyToAttachmentLinks is empty). Resolving first made hundreds of
    // finished conversions show up under "无附件" and pushed "已转换" far below
    // the number of md files actually on disk.
    if (isConvertedOnDisk(plugin, entry.id)) {
      stat.converted++;
      continue;
    }
    const attachment = await getAttachmentPath(entry, plugin);
    if (!attachment) {
      stat.noAttachment++;
      continue;
    }
    if (isConversionInProgress(entry.id)) {
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

  await ensureZoteroLinks(plugin, Array.from(bibCache.values()));

  for (const entry of bibCache.values()) {
    // Same ordering rationale as collectAttachmentStats: an existing output md
    // means "converted" regardless of whether the attachment still resolves,
    // so a finished paper is never re-queued just because Zotero is offline.
    if (isConvertedOnDisk(plugin, entry.id)) {
      items.push({ entry, attachment: '', status: 'converted' });
      continue;
    }
    const attachment = await getAttachmentPath(entry, plugin);
    if (!attachment) {
      items.push({ entry, attachment: '', status: 'no_attachment' });
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
 * Each entry tries the MinerU cloud API first and falls back to the local
 * mineru CLI when the cloud is unavailable, so the batch never needs to pause
 * on a quota limit.
 */
export async function runBatchConversion(
  plugin: any,
  filter?: { only?: Set<string>; limit?: number }
): Promise<void> {
  if (state.running) {
    new Notice('批量转换已在进行中。');
    return;
  }

  const outputPath = plugin.settings?.convertOutputPath || 'literature';
  const mineruApiToken = plugin.settings?.mineruApiToken || '';

  let queue = (await buildBatchQueue(plugin)).filter((i) => i.status === 'pending');
  const onlyKeys = filter?.only;
  if (onlyKeys) {
    queue = queue.filter((i) => onlyKeys.has(i.entry.id));
  }
  if (filter?.limit !== undefined && queue.length > filter.limit) {
    queue = queue.slice(0, filter.limit);
  }
  if (queue.length === 0) {
    new Notice('没有待转换的附件。');
    return;
  }

  const convertSettings: ConvertSettings = {
    outputPath,
    mineru: { apiToken: mineruApiToken },
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

  try {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      state.done = i;
      state.currentCitekey = item.entry.id;
      state.currentMessage = '正在转换...';

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
    });
    new Notice(`批量转换完成：成功 ${state.total - state.failed}，失败 ${state.failed}。`);
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
