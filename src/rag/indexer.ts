import { App, TFile } from 'obsidian';
import { debugLog, getCacheRoot, getVaultRoot } from '../helpers';
import { Bm25Index, RagDocMeta } from './bm25';

const fs = require('fs');
const path = require('path');

const EXCLUDE_DIR_RE = /(^|\/)(\.trash|\.obsidian|\.git|\.openclaw|_bib-links)(\/|$)/;
/** Folder names excluded from indexing by default (user-configurable). */
export const DEFAULT_EXCLUDE_FOLDERS = ['node_modules', '.yarn', 'bower_components'];
// v4 stores the search payload as a compact binary file (rag-postings.bin):
// postings are raw int32 typed arrays loaded as zero-copy Int32Array views,
// so the renderer never materializes the multi-hundred-MB JSON object graph.
// v3 was a 515MB JSON whose `JSON.parse` inflated to >1GB of V8 heap objects
// and crashed the renderer with "JavaScript heap out of memory" (the DevTools
// "connection lost" symptom).
const CACHE_VERSION = 4;
const IDLE_BATCH = 40;
// iCloud / APFS on-demand materialization can briefly shift a file's mtime
// without the content changing; a small tolerance avoids spurious re-indexes.
const ICLOUD_MTIME_TOLERANCE_MS = 2000;

export interface IndexerOptions {
  /** Index files inside folders that are symbolic links (default true). */
  followSymlinks: boolean;
  /** Folder names whose content is never indexed (e.g. node_modules). */
  excludeFolders: string[];
}

// Cache of checked absolute directory paths -> whether that component is a
// symlink. Symlinked folders (e.g. project folders pointed into the vault)
// can pull in external content like node_modules READMEs.
const symlinkCache = new Map<string, boolean>();

/**
 * Returns true when any path component below the vault root (or the file
 * itself) is a symlink, i.e. the file lives in a folder that was linked into
 * the vault rather than stored in it.
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

/** True when any directory component of relPath equals the folder name. */
function matchesAnyDir(relPath: string, name: string): boolean {
  if (!name) return false;
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === name) return true;
  }
  return false;
}

export function shouldIndexPath(
  relPath: string,
  vaultRoot?: string,
  opts?: IndexerOptions
): boolean {
  if (!relPath.toLowerCase().endsWith('.md')) return false;
  if (EXCLUDE_DIR_RE.test(relPath)) return false;
  if (relPath.startsWith('.') || relPath.indexOf('/.') >= 0) return false;
  const excludeFolders = opts?.excludeFolders ?? DEFAULT_EXCLUDE_FOLDERS;
  if (excludeFolders.some((name) => matchesAnyDir(relPath, name))) return false;
  if ((opts?.followSymlinks ?? true) === false) {
    if (pathTraversesSymlink(relPath, vaultRoot)) return false;
  }
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
  private searchPath: string;
  private opts: IndexerOptions;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;
  /** Set once the large search payload (postings + cjkText) has been loaded. */
  private searchLoaded = false;
  private searchLoadPromise: Promise<void> | null = null;
  /** Set once the metadata cache has been read (successfully or not). */
  private cacheLoaded = false;

  constructor(app: App, outputPath: string, opts: IndexerOptions) {
    this.app = app;
    this.outputPath = outputPath;
    this.opts = opts;
    const root = getCacheRoot();
    this.cachePath = path.join(root, 'rag-index.json');
    this.searchPath = path.join(root, 'rag-postings.bin');
  }

  /** Apply indexing-option changes without recreating the indexer. */
  updateOptions(partial: Partial<IndexerOptions>): void {
    Object.assign(this.opts, partial);
  }

  isLiteraturePath(relPath: string): boolean {
    return isLiteraturePath(this.outputPath, relPath);
  }

  shouldIndex(relPath: string): boolean {
    return shouldIndexPath(relPath, undefined, this.opts);
  }

  /**
   * Load the metadata cache (fast, small file). Postings / cjkText are left
   * for {@link ensureSearchReady}, so startup never blocks on the multi-hundred-MB
   * parse. A legacy single-file cache (version 2) is loaded fully and
   * immediately re-saved in the split layout.
   */
  async loadCache(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.cachePath)) {
        this.cacheLoaded = true;
        return false;
      }
      const raw = JSON.parse(await fs.promises.readFile(this.cachePath, 'utf-8'));

      if (raw.version === 2) {
        // Legacy single-file cache: load everything, then migrate to split files.
        if (!raw.index) return false;
        this.index.load(raw.index);
        this.searchLoaded = true;
        this.scheduleSave();
        this.cacheLoaded = true;
        return true;
      }
      if (raw.version !== CACHE_VERSION) {
        this.cacheLoaded = true;
        return false;
      }

      this.index.loadMeta(raw.index);
      this.searchLoaded = false;
      this.cacheLoaded = true;
      debugLog('RagIndexer', 'Meta cache loaded', {
        docs: this.index.docCount,
      });
      return true;
    } catch (e) {
      debugLog('RagIndexer', 'Failed to load cache', { error: e });
      this.cacheLoaded = true;
      return false;
    }
  }

  /**
   * Load the large search payload (postings + cjkText) exactly once. Called
   * lazily from search() and incrementalUpdate(); the first call reads and
   * maps the multi-hundred-MB binary file as typed-array views (no JSON.parse
   * of the object graph), subsequent calls are no-ops.
   */
  ensureSearchReady(): Promise<void> {
    if (this.searchLoaded) return Promise.resolve();
    if (this.searchLoadPromise) return this.searchLoadPromise;
    this.searchLoadPromise = (async () => {
      try {
        if (fs.existsSync(this.searchPath)) {
          const raw = await fs.promises.readFile(this.searchPath);
          this.index.loadSearch(raw);
        }
        this.searchLoaded = true;
      } catch (e) {
        debugLog('RagIndexer', 'Failed to load search payload', { error: e });
        this.searchLoaded = true;
      }
    })();
    return this.searchLoadPromise;
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
      const meta = { version: CACHE_VERSION, index: this.index.serializeMeta() };
      fs.writeFileSync(this.cachePath, JSON.stringify(meta), 'utf-8');
      fs.writeFileSync(this.searchPath, this.index.serializeSearch());
      this.searchLoaded = true;
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
      // The fresh in-memory index already holds full postings; never let
      // ensureSearchReady() or loadCache() overwrite it from a stale on-disk copy.
      this.searchLoaded = true;
      this.cacheLoaded = true;

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
      // Load the metadata cache first when this is the first mutation since
      // startup (e.g. a file event fired before initRagIndex ran): with an
      // empty index every file would look "changed" and trigger a full rebuild.
      if (!this.cacheLoaded) {
        await this.loadCache();
      }

      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => this.shouldIndex(f.path));

      const current = new Map<string, CacheFileMeta>();
      for (const f of files) current.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });

      // Removed files
      const removedPaths: string[] = [];
      for (const docPath of Array.from(this.index.docIdByPath.keys())) {
        if (!current.has(docPath)) removedPaths.push(docPath);
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

      // Diffing needs only the small metadata cache. Postings + cjkText (a
      // multi-hundred-MB parse) are loaded lazily below — and not at all when
      // nothing changed, so a routine startup run stays in the tens of ms.
      if (removedPaths.length === 0 && changed.length === 0) {
        debugLog('RagIndexer', 'Incremental update: nothing changed (no search payload load)');
        return;
      }

      // Mutations (addDoc/removeDoc) update the postings in place, so the
      // search payload must be loaded before any diff is applied.
      await this.ensureSearchReady();

      for (const docPath of removedPaths) {
        this.index.removeDoc(docPath);
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

  async search(query: string, topK: number, minTermCoverage?: number) {
    await this.ensureSearchReady();
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
