import { App, TFile } from 'obsidian';
import { debugLog, getCacheRoot, getVaultRoot } from '../helpers';
import { SemanticVectorIndex, SemanticVectorHit } from './vectorIndex';
import { chunkByLines } from './chunker';
import { embedTexts, EmbeddingSettings, isEmbeddingServiceAvailable } from './embedding';
import { shouldIndexPath, isLiteraturePath, docChanged } from './indexer';
import { extractTitle } from './bm25';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
// Every file costs embedding API calls, so yield between files more often.
const IDLE_BATCH = 5;
// A background (auto) run — startup or a file event — embeds only *small*
// deltas (a note the user just created or edited). When more than this many
// files are pending, the auto run skips entirely and leaves the backlog to a
// manual "重建语义索引" / "增量更新". Auto-draining a large backlog (e.g. the
// first build of a big vault) would keep the embedding service / CPU pegged
// for an unbounded time.
const MAX_AUTO_RUN_FILES = 20;

export interface SemanticIndexerSettings {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  model: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  /** Where the index lives: 'vault' (inside the vault, synced) or 'local'
   *  (~/.bib-manager-index). */
  indexLocation: 'vault' | 'local';
  /** Index files inside folders that are symbolic links (default true). */
  followSymlinks: boolean;
  /** Folder names whose content is never indexed (e.g. node_modules). */
  excludeFolders: string[];
}

export interface IndexProgress {
  done: number;
  total: number;
  path: string;
  /** Number of files skipped because embedding / reading failed. */
  failed: number;
}

/**
 * Options for build/update runs. `auto` marks background runs (startup, file
 * events): auto incremental runs embed only small deltas (≤ maxFiles pending
 * files) and skip large backlogs, leaving them to manual runs; auto build runs
 * never rebuild from scratch. Manual runs (commands / settings buttons) are
 * unbounded and always perform a full sync.
 */
export interface IndexRunOptions {
  auto?: boolean;
  maxFiles?: number;
}

/**
 * Builds and maintains a semantic (embedding) index over vault markdown files.
 * - Incremental: only changed / added / removed files are re-embedded.
 * - Persisted: JSON metadata + raw binary vector payload (semantic-index.json
 *   / semantic-vectors.bin) either inside the vault (.bib-manager/) — the
 *   default, so the index syncs with the vault — or under the vault-external
 *   ~/.bib-manager-index cache dir.
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
  private settings: SemanticIndexerSettings;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;
  private lastQueryCache: { q: string; vec: number[] } | null = null;
  /**
   * Whether the embedding service is reachable on this machine. When false the
   * index is treated as read-only (loaded from the iCloud-synced copy) and
   * never rebuilt or overwritten. The value is refreshed lazily on every
   * build/update/search via {@link ensureEmbeddingAvailable}, so a service that
   * comes back online (or a config fix) is picked up automatically instead of
   * freezing the index forever at the value probed during startup.
   */
  embeddingAvailable = true;
  /** Timestamp of the last probe, used to bound probe frequency. */
  private lastEmbeddingProbeAt = 0;

  constructor(app: App, outputPath: string, settings: SemanticIndexerSettings) {
    this.app = app;
    this.outputPath = outputPath;
    this.settings = settings;
  }

  /**
   * Lazily (re-)probe the embedding service, caching the result for a short
   * window so frequent file events do not hammer the probe endpoint. Whenever
   * the index is about to be built or updated this is checked so the engine
   * availability is decided *at update time*, not just at plugin startup.
   */
  async ensureEmbeddingAvailable(): Promise<boolean> {
    const PROBE_TTL_MS = 15000;
    if (Date.now() - this.lastEmbeddingProbeAt < PROBE_TTL_MS) {
      return this.embeddingAvailable;
    }
    const available = await isEmbeddingServiceAvailable(this.embedSettings());
    this.embeddingAvailable = available;
    this.lastEmbeddingProbeAt = Date.now();
    debugLog('SemanticIndexer', 'Embedding service probed', { available });
    return available;
  }

  /** Drop the probe cache so the next ensureEmbeddingAvailable() re-probes.
   *  Called when embedding settings change and the service should be checked
   *  immediately instead of within the TTL window. */
  resetProbe(): void {
    this.lastEmbeddingProbeAt = 0;
  }

  /** Resolve the current cache file paths from the storage-location setting. */
  private cachePaths(): { json: string; bin: string } {
    const root =
      this.settings.indexLocation === 'vault'
        ? path.join(getVaultRoot(), '.bib-manager')
        : getCacheRoot();
    return {
      json: path.join(root, 'semantic-index.json'),
      bin: path.join(root, 'semantic-vectors.bin'),
    };
  }

  /** Indexing options for {@link shouldIndexPath}. */
  private indexOptions(): { followSymlinks: boolean; excludeFolders: string[] } {
    return {
      followSymlinks: this.settings.followSymlinks,
      excludeFolders: this.settings.excludeFolders,
    };
  }

  /** Apply setting changes without recreating the indexer. */
  updateSettings(partial: Partial<SemanticIndexerSettings>): void {
    Object.assign(this.settings, partial);
  }

  get enabled(): boolean {
    // An API key is not strictly required: local Docker embedding services
    // (Ollama bge-m3 / jina-embeddings-v5-omni, ...) expose the same
    // OpenAI-compatible
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
      const { json: cacheJsonPath, bin: cacheBinPath } = this.cachePaths();
      // Use Obsidian's vault adapter to read the index so iCloud on-demand
      // files are fully downloaded before parsing — a direct fs.readFileSync
      // can hit a not-yet-synced placeholder (ENOENT / truncated JSON).
      const rawText = await this.readVaultFile(cacheJsonPath);
      if (rawText == null) return false;
      const raw = JSON.parse(rawText);
      if (!raw || raw.version !== CACHE_VERSION) return false;
      // A different embedding model produces vectors with a different
      // dimensionality; mixing them would yield garbage search results, so
      // treat a model change as cache-invalid and force a rebuild.
      if (raw.model && this.settings.model && raw.model !== this.settings.model) return false;
      this.index.model = raw.model || '';
      const bin = await this.readVaultBinary(cacheBinPath);
      if (bin == null) return false;
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

  /** Read a vault file through Obsidian's adapter (iCloud-aware), falling back
   *  to direct fs when the path is outside the vault or the adapter is
   *  unavailable. Returns null when the file is missing. */
  private async readVaultFile(absPath: string): Promise<string | null> {
    const adapter = this.app.vault?.adapter as any;
    if (adapter?.read) {
      const rel = this.toVaultRelative(absPath);
      if (rel) {
        try {
          if (await adapter.exists(rel)) return await adapter.read(rel);
        } catch {
          // fall through to fs
        }
      }
    }
    return fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : null;
  }

  private async readVaultBinary(absPath: string): Promise<Buffer | null> {
    const adapter = this.app.vault?.adapter as any;
    if (adapter?.readBinary) {
      const rel = this.toVaultRelative(absPath);
      if (rel) {
        try {
          if (await adapter.exists(rel)) {
            const ab = await adapter.readBinary(rel);
            return Buffer.from(ab);
          }
        } catch {
          // fall through to fs
        }
      }
    }
    return fs.existsSync(absPath) ? fs.readFileSync(absPath) : null;
  }

  private toVaultRelative(absPath: string): string | null {
    try {
      const vaultRoot = getVaultRoot();
      const rel = path.relative(vaultRoot, absPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    } catch {
      // fall back to absolute fs path
    }
    return null;
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
      const { json: cacheJsonPath, bin: cacheBinPath } = this.cachePaths();
      const dir = path.dirname(cacheJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const json = this.index.toJSON();
      json.version = CACHE_VERSION;
      fs.writeFileSync(cacheJsonPath, JSON.stringify(json), 'utf-8');
      fs.writeFileSync(cacheBinPath, this.index.toVectorBuffer());
      debugLog('SemanticIndexer', 'Cache saved', {
        docs: this.index.docCount,
        chunks: this.index.chunkCount,
      });
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to save cache', { error: e });
    }
  }

  /** Rebuild the semantic index from scratch for all eligible markdown files. */
  async buildAll(
    onProgress?: (p: IndexProgress) => void,
    opts?: IndexRunOptions
  ): Promise<void> {
    if (this.busy) return;
    if (!(await this.ensureEmbeddingAvailable())) {
      debugLog('SemanticIndexer', 'buildAll skipped: embedding service unavailable (read-only index)');
      return;
    }
    // Background (auto) runs never rebuild from scratch: building the whole
    // vault would flood the embedding service. A full rebuild is always manual.
    if (opts?.auto) {
      debugLog('SemanticIndexer', 'buildAll skipped: auto runs never rebuild from scratch');
      return;
    }
    this.busy = true;
    this.building = true;
    this.progress = null;
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => shouldIndexPath(f.path, undefined, this.indexOptions()));
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
  async incrementalUpdate(
    onProgress?: (p: IndexProgress) => void,
    opts?: IndexRunOptions
  ): Promise<void> {
    if (this.busy || !this.enabled) return;
    if (!(await this.ensureEmbeddingAvailable())) {
      debugLog('SemanticIndexer', 'incrementalUpdate skipped: embedding service unavailable (read-only index)');
      return;
    }
    this.busy = true;
    this.building = true;
    this.progress = null;
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => shouldIndexPath(f.path, undefined, this.indexOptions()));

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

      // Background (auto) runs only embed *small* deltas — e.g. a note the user
      // just created or edited. A large backlog (first build of a big vault, or
      // many pending files) is deliberately SKIPPED and left to a manual
      // "重建语义索引" / "增量更新": auto-draining thousands of files would keep
      // the embedding service (and CPU) pegged for an unbounded time, and is
      // exactly what happened during startup in large vaults.
      const targets = changed;
      if (opts?.auto && changed.length > (opts.maxFiles ?? MAX_AUTO_RUN_FILES)) {
        debugLog('SemanticIndexer', 'incrementalUpdate skipped: large backlog left to manual build', {
          changed: changed.length,
        });
        return;
      }

      this.failedCount = 0;
      for (let i = 0; i < targets.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        try {
          await this.indexFile(targets[i]);
        } catch (e: any) {
          this.failedCount++;
          debugLog('SemanticIndexer', 'indexFile failed during incremental update', {
            path: targets[i].path,
            error: e.message,
          });
          continue;
        }
        this.progress = {
          done: i + 1,
          total: targets.length,
          path: targets[i].path,
          failed: this.failedCount,
        };
        onProgress?.(this.progress);
      }

      if (targets.length > 0 || current.size !== this.index.docCount) {
        this.scheduleSave();
      }
      debugLog('SemanticIndexer', 'Incremental update finished', { changed: targets.length });
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
   *
   * When the currently configured model differs from the model the in-memory
   * index was built with (e.g. the user switched the embedding model), every
   * eligible file is considered pending so the misleading "索引已是最新" state
   * cannot appear before a rebuild.
   */
  countPendingFiles(): number {
    const modelMismatch =
      !!this.index.model && !!this.settings.model && this.index.model !== this.settings.model;
    let pending = 0;
    let total = 0;
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (!shouldIndexPath(f.path, undefined, this.indexOptions())) continue;
      total++;
      if (modelMismatch || docChanged(this.index.getMeta(f.path), f.stat)) pending++;
    }
    this.pendingCount = pending;
    debugLog('SemanticIndexer', 'countPendingFiles', { total, pending, modelMismatch });
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
    // Without an embedding service we cannot embed the query, so semantic
    // search is unavailable on this machine (index may still be loaded from
    // iCloud for inspection, but query embedding requires the service).
    if (!(await this.ensureEmbeddingAvailable())) return [];
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
