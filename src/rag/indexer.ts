import { App, TFile } from 'obsidian';
import { debugLog } from '../helpers';
import { Bm25Index, RagDocMeta } from './bm25';

const fs = require('fs');
const path = require('path');

const EXCLUDE_DIR_RE = /(^|\/)(\.trash|\.obsidian|\.git|\.openclaw|_bib-links)(\/|$)/;
const CACHE_VERSION = 1;
const IDLE_BATCH = 40;

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
 * - Persisted: the index is serialized to .bib-manager-temp/rag-index.json.
 */
export class RagIndexer {
  index = new Bm25Index();
  private app: App;
  private vaultRoot: string;
  private outputPath: string;
  private cachePath: string;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;

  constructor(app: App, vaultRoot: string, outputPath: string) {
    this.app = app;
    this.vaultRoot = vaultRoot;
    this.outputPath = outputPath;
    this.cachePath = path.join(vaultRoot, '.bib-manager-temp', 'rag-index.json');
  }

  isLiteraturePath(relPath: string): boolean {
    return relPath.startsWith(this.outputPath + '/') && relPath.endsWith('.md');
  }

  shouldIndex(relPath: string): boolean {
    if (!relPath.toLowerCase().endsWith('.md')) return false;
    if (EXCLUDE_DIR_RE.test(relPath)) return false;
    if (relPath.startsWith('.') || relPath.indexOf('/.') >= 0) return false;
    return true;
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
        this.indexFile(f);
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
        if (meta && (meta.mtime !== f.stat.mtime || meta.size !== f.stat.size)) {
          changed.push(f);
        }
      }

      for (let i = 0; i < changed.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        this.indexFile(changed[i]);
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

  private indexFile(f: TFile): void {
    try {
      const abs = path.join(this.vaultRoot, f.path);
      const content = fs.readFileSync(abs, 'utf-8');
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

  search(query: string, topK: number) {
    return this.index.search(query, topK);
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
