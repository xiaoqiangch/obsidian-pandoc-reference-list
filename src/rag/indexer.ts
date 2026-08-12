import { App, TFile } from 'obsidian';
import { debugLog, getCacheRoot, getVaultRoot } from '../helpers';
import { Bm25Index, RagDocMeta } from './bm25';

const fs = require('fs');
const path = require('path');

const EXCLUDE_DIR_RE = /(^|\/)(\.trash|\.obsidian|\.git|\.openclaw|_bib-links)(\/|$)/;
const EXCLUDE_ANY_DIR_RE = /(^|\/)(node_modules|\.yarn|bower_components)(\/|$)/;
const CACHE_VERSION = 1;
const IDLE_BATCH = 40;
// iCloud / APFS on-demand materialization can briefly shift a file's mtime
// without the content changing; a small tolerance avoids spurious re-indexes.
const ICLOUD_MTIME_TOLERANCE_MS = 2000;

// Cache of checked absolute directory paths -> whether that component is a
// symlink. Symlinked folders (e.g. project folders pointed into the vault)
// pull in external content like node_modules READMEs that must not be indexed.
const symlinkCache = new Map<string, boolean>();

/**
 * Returns true when any path component below the vault root (or the file
 * itself) is a symlink, i.e. the file lives in a folder that was linked into
 * the vault rather than stored in it. Such external folders (project dirs,
 * node_modules, ...) are excluded from indexing.
 */
function pathTraversesSymlink(relPath: string, vaultRoot?: string): boolean {
  let root = vaultRoot;
  if (!root) {
    try {
      root = getVaultRoot();
    } catch {
      return false;
    }
  }
  const parts = relPath.split('/');
  let acc = root;
  for (const part of parts) {
    acc = path.join(acc, part);
    if (symlinkCache.has(acc)) {
      if (symlinkCache.get(acc)) return true;
      continue;
    }
    let isLink = false;
    try {
      isLink = fs.lstatSync(acc).isSymbolicLink();
    } catch {
      // Missing / inaccessible path: treat as a regular file.
    }
    symlinkCache.set(acc, isLink);
    if (isLink) return true;
  }
  return false;
}

export function shouldIndexPath(relPath: string, vaultRoot?: string): boolean {
  if (!relPath.toLowerCase().endsWith('.md')) return false;
  if (EXCLUDE_DIR_RE.test(relPath)) return false;
  if (EXCLUDE_ANY_DIR_RE.test(relPath)) return false;
  if (relPath.startsWith('.') || relPath.indexOf('/.') >= 0) return false;
  if (pathTraversesSymlink(relPath, vaultRoot)) return false;
  return true;
}

export function isLiteraturePath(outputPath: string, relPath: string): boolean {
  return relPath.startsWith(outputPath + '/') && relPath.endsWith('.md');
}

/**
 * Decide whether a previously-indexed document needs re-indexing based on
 * stat metadata. A pure mtime/size comparison is too strict for iCloud:
 * on-demand materialization can touch the mtime (and occasionally report
 * size 0 for not-yet-downloaded placeholders) without content changes.
 * - Missing meta or a size change => re-index (real edits usually change size).
 * - Size unchanged but mtime shifted by less than the tolerance => keep.
 * - Size unchanged but mtime shifted by more => re-index (preserves edits that
 *   rewrite the same byte count).
 */
export function docChanged(
  meta: { mtime: number; size: number } | null | undefined,
  stat: { mtime: number; size: number }
): boolean {
  if (!meta) return true;
  if (meta.size !== stat.size) return true;
  if (stat.size === 0) return true;
  return Math.abs(stat.mtime - meta.mtime) > ICLOUD_MTIME_TOLERANCE_MS;
}

export interface IndexProgress {
  done: number;
  total: number;
  path: string;
}

interface CacheFileMeta {
  mtime: number;
  size: number;
}

/**
 * Builds and maintains a whole-vault BM25 index over markdown files.
 * - Incremental: only changed / added / removed files are re-indexed.
 * - Background: processing is chunked and yields to idle callbacks.
 * - Persisted: the index is serialized to a vault-external cache dir.
 */
export class RagIndexer {
  index = new Bm25Index();
  private app: App;
  private outputPath: string;
  private cachePath: string;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;

  constructor(app: App, outputPath: string) {
    this.app = app;
    this.outputPath = outputPath;
    this.cachePath = path.join(getCacheRoot(), 'rag-index.json');
  }

  isLiteraturePath(relPath: string): boolean {
    return isLiteraturePath(this.outputPath, relPath);
  }

  shouldIndex(relPath: string): boolean {
    return shouldIndexPath(relPath);
  }

  async loadCache(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.cachePath)) return false;
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      if (!raw || raw.version !== CACHE_VERSION) return false;
      this.index.load(raw.index);
      debugLog('RagIndexer', 'Cache loaded', {
        docs: this.index.docCount,
        postings: raw.index?.postings ? Object.keys(raw.index.postings).length : 0,
      });
      return true;
    } catch (e) {
      debugLog('RagIndexer', 'Failed to load cache', { error: e });
      return false;
    }
  }

  scheduleSave(): void {
    this.cacheDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.cacheDirty) {
        this.cacheDirty = false;
        this.writeCache();
      }
    }, 5000);
  }

  private writeCache(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = { version: CACHE_VERSION, index: this.index.serialize() };
      fs.writeFileSync(this.cachePath, JSON.stringify(payload), 'utf-8');
      debugLog('RagIndexer', 'Cache saved', { docs: this.index.docCount });
    } catch (e) {
      debugLog('RagIndexer', 'Failed to save cache', { error: e });
    }
  }

  /** Rebuild the index from scratch for all eligible markdown files. */
  async buildAll(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = this.app.vault.getMarkdownFiles().filter((f) => this.shouldIndex(f.path));
      this.index = new Bm25Index();

      for (let i = 0; i < files.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        const f = files[i];
        await this.indexFile(f);
        onProgress?.({ done: i + 1, total: files.length, path: f.path });
      }

      this.scheduleSave();
      debugLog('RagIndexer', 'Full build finished', { files: files.length });
    } finally {
      this.busy = false;
    }
  }

  /** Diff against the current file list and index only what changed. */
  async incrementalUpdate(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => this.shouldIndex(f.path));

      const current = new Map<string, CacheFileMeta>();
      for (const f of files) current.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });

      // Removed files
      for (const docPath of Array.from(this.index.docIdByPath.keys())) {
        if (!current.has(docPath)) {
          this.index.removeDoc(docPath);
        }
      }

      // Added / changed files
      const changed: TFile[] = [];
      for (const f of files) {
        const docId = this.index.getDocId(f.path);
        if (docId === undefined) {
          changed.push(f);
          continue;
        }
        const meta = this.index.documents.get(docId);
        if (meta && docChanged(meta, f.stat)) {
          changed.push(f);
        }
      }

      for (let i = 0; i < changed.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        await this.indexFile(changed[i]);
        onProgress?.({ done: i + 1, total: changed.length, path: changed[i].path });
      }

      if (changed.length > 0 || current.size !== this.index.docCount) {
        this.scheduleSave();
      }
      debugLog('RagIndexer', 'Incremental update finished', { changed: changed.length });
    } finally {
      this.busy = false;
    }
  }

  private async indexFile(f: TFile): Promise<void> {
    try {
      // Use Obsidian's native read so iCloud on-demand files are handled
      // correctly (direct fs.readFileSync blocks on download / may ENOENT).
      const content = await this.app.vault.cachedRead(f);
      const literature = this.isLiteraturePath(f.path);
      const extra: Partial<RagDocMeta> = {
        mtime: f.stat.mtime,
        size: f.stat.size,
        literature,
      };
      if (literature) {
        const base = path.posix.basename(f.path);
        extra.citekey = base.replace(/\.md$/, '');
      }
      this.index.addDoc(f.path, content, extra);
    } catch (e) {
      debugLog('RagIndexer', 'Failed to index file', { path: f.path, error: e });
    }
  }

  search(query: string, topK: number, minTermCoverage?: number) {
    return this.index.search(query, topK, minTermCoverage);
  }

  destroy(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.cacheDirty) this.writeCache();
  }
}

function yieldToIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idl = (window as any).requestIdleCallback;
    if (typeof idl === 'function') {
      idl(() => resolve(), { timeout: 120 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
