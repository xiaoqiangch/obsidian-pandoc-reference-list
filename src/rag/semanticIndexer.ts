import { App, TFile } from 'obsidian';
import { debugLog, getCacheRoot } from '../helpers';
import { SemanticVectorIndex, SemanticVectorHit } from './vectorIndex';
import { chunkByLines } from './chunker';
import { embedTexts, EmbeddingSettings } from './embedding';
import { shouldIndexPath, isLiteraturePath, docChanged } from './indexer';
import { extractTitle } from './bm25';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
// Every file costs embedding API calls, so yield between files more often.
const IDLE_BATCH = 5;

export interface SemanticIndexerSettings {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
}

export interface IndexProgress {
  done: number;
  total: number;
  path: string;
  /** Number of files skipped because embedding / reading failed. */
  failed: number;
}

/**
 * Builds and maintains a semantic (embedding) index over vault markdown files.
 * - Incremental: only changed / added / removed files are re-embedded.
 * - Persisted: JSON metadata + raw binary vector payload under
 *   a vault-external cache dir (semantic-index.json / semantic-vectors.bin).
 * - Background: processing yields to idle callbacks; embedding is batched.
 */
export class SemanticIndexer {
  index = new SemanticVectorIndex();
  /** True while a build / incremental update is running. */
  building = false;
  /** Latest progress of the running build (null when idle). */
  progress: IndexProgress | null = null;
  /** Files skipped in the current build because reading / embedding failed. */
  failedCount = 0;
  /** Number of vault md files missing from the index or changed since last
   *  embed (stale). -1 until first computed. */
  pendingCount = -1;
  private app: App;
  private outputPath: string;
  private cacheJsonPath: string;
  private cacheBinPath: string;
  private settings: SemanticIndexerSettings;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;
  private lastQueryCache: { q: string; vec: number[] } | null = null;

  constructor(app: App, outputPath: string, settings: SemanticIndexerSettings) {
    this.app = app;
    this.outputPath = outputPath;
    this.settings = settings;
    this.cacheJsonPath = path.join(getCacheRoot(), 'semantic-index.json');
    this.cacheBinPath = path.join(getCacheRoot(), 'semantic-vectors.bin');
  }

  get enabled(): boolean {
    // An API key is not strictly required: local Docker embedding services
    // (jina-embeddings-v5-omni, ...) expose the same OpenAI-compatible
    // endpoint with no authentication.
    return this.settings.enabled;
  }

  private embedSettings(): EmbeddingSettings {
    return {
      apiUrl: this.settings.apiUrl,
      apiKey: this.settings.apiKey,
      model: this.settings.model,
    };
  }

  async loadCache(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.cacheJsonPath) || !fs.existsSync(this.cacheBinPath)) return false;
      const raw = JSON.parse(fs.readFileSync(this.cacheJsonPath, 'utf-8'));
      if (!raw || raw.version !== CACHE_VERSION) return false;
      this.index.model = raw.model || '';
      const bin = fs.readFileSync(this.cacheBinPath);
      this.index.loadFrom(raw, bin);
      debugLog('SemanticIndexer', 'Cache loaded', {
        docs: this.index.docCount,
        chunks: this.index.chunkCount,
        dim: this.index.dim,
      });
      return this.index.docCount > 0;
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to load cache', { error: e });
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
      const dir = path.dirname(this.cacheJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const json = this.index.toJSON();
      json.version = CACHE_VERSION;
      fs.writeFileSync(this.cacheJsonPath, JSON.stringify(json), 'utf-8');
      fs.writeFileSync(this.cacheBinPath, this.index.toVectorBuffer());
      debugLog('SemanticIndexer', 'Cache saved', {
        docs: this.index.docCount,
        chunks: this.index.chunkCount,
      });
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to save cache', { error: e });
    }
  }

  /** Rebuild the semantic index from scratch for all eligible markdown files. */
  async buildAll(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.building = true;
    this.progress = null;
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => shouldIndexPath(f.path));
      this.index = new SemanticVectorIndex();
      this.index.model = this.settings.model;
      this.failedCount = 0;

      for (let i = 0; i < files.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        try {
          await this.indexFile(files[i]);
        } catch (e: any) {
          this.failedCount++;
          debugLog('SemanticIndexer', 'indexFile failed, skipping', {
            path: files[i].path,
            error: e.message,
          });
        }
        this.progress = {
          done: i + 1,
          total: files.length,
          path: files[i].path,
          failed: this.failedCount,
        };
        onProgress?.(this.progress);
      }

      this.scheduleSave();
      debugLog('SemanticIndexer', 'Full build finished', { files: files.length });
    } finally {
      this.busy = false;
      this.building = false;
      this.progress = null;
    }
  }

  /** Diff against the current file list and embed only what changed. */
  async incrementalUpdate(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.busy || !this.enabled) return;
    this.busy = true;
    this.building = true;
    this.progress = null;
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => shouldIndexPath(f.path));

      const current = new Set<string>();
      for (const f of files) current.add(f.path);

      // Removed files
      for (const docPath of Array.from(this.index.docKeys())) {
        if (!current.has(docPath)) this.index.removeDoc(docPath);
      }

      // Added / changed files
      const changed: TFile[] = [];
      for (const f of files) {
        const meta = this.index.getMeta(f.path);
        if (docChanged(meta, f.stat)) {
          changed.push(f);
        }
      }

      this.failedCount = 0;
      for (let i = 0; i < changed.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        try {
          await this.indexFile(changed[i]);
        } catch (e: any) {
          this.failedCount++;
          debugLog('SemanticIndexer', 'indexFile failed during incremental update', {
            path: changed[i].path,
            error: e.message,
          });
          continue;
        }
        this.progress = {
          done: i + 1,
          total: changed.length,
          path: changed[i].path,
          failed: this.failedCount,
        };
        onProgress?.(this.progress);
      }

      if (changed.length > 0 || current.size !== this.index.docCount) {
        this.scheduleSave();
      }
      debugLog('SemanticIndexer', 'Incremental update finished', { changed: changed.length });
    } finally {
      this.busy = false;
      this.building = false;
      this.progress = null;
    }
  }

  /**
   * Count vault md files that still need embedding: those missing from the
   * index or changed since their last embed. Pure stat comparison — no API
   * calls, no file reads — safe to run at startup and in the settings view.
   */
  countPendingFiles(): number {
    let pending = 0;
    let total = 0;
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (!shouldIndexPath(f.path)) continue;
      total++;
      if (docChanged(this.index.getMeta(f.path), f.stat)) pending++;
    }
    this.pendingCount = pending;
    debugLog('SemanticIndexer', 'countPendingFiles', { total, pending });
    return pending;
  }

  private async indexFile(f: TFile): Promise<void> {
    // Use Obsidian's native read so iCloud on-demand files are handled
    // correctly (direct fs.readFileSync fails with ENOENT for files whose
    // content has not been downloaded to the local filesystem yet).
    const content = await this.app.vault.cachedRead(f);
    const chunks = chunkByLines(content, this.settings.chunkSize, this.settings.chunkOverlap).filter(
      (c) => c.text.trim().length > 0
    );
    if (chunks.length === 0) {
      this.index.removeDoc(f.path);
      return;
    }

    const vectors = await embedTexts(
      chunks.map((c) => c.text),
      this.embedSettings()
    );
    const literature = isLiteraturePath(this.outputPath, f.path);
    const citekey = literature
      ? path.posix.basename(f.path).replace(/\.md$/, '')
      : undefined;
    this.index.upsertDoc(
      f.path,
      extractTitle(content),
      literature,
      citekey,
      f.stat.mtime,
      f.stat.size,
      chunks,
      vectors
    );
    this.scheduleSave();
  }

  /** Embed the query (cached) and return the top chunk hits. */
  async search(query: string, topK?: number, minSimilarity?: number): Promise<SemanticVectorHit[]> {
    if (!this.enabled || this.index.chunkCount === 0) return [];
    const k = topK ?? this.settings.topK ?? 20;
    const min = minSimilarity ?? 0;

    let qVec = this.lastQueryCache?.q === query ? this.lastQueryCache.vec : null;
    if (!qVec) {
      const vecs = await embedTexts([query], this.embedSettings());
      qVec = vecs[0];
      if (!qVec) return [];
      this.lastQueryCache = { q: query, vec: qVec };
    }
    return this.index.search(qVec, k, min);
  }

  docKeys(): string[] {
    return Array.from(this.index.docKeys());
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
