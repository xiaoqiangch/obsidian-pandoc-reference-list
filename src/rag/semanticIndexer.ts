import { App, Notice, TFile } from 'obsidian';
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
// Background (auto) run bounds. These were tuned for a CPU-bound local
// embedding service (bge-m3 via Docker) where the drain had to be paced to
// avoid pinning the CPU. The engine now runs on the Metal GPU (several
// thousand tok/s), so the drain is much looser: bigger batches, short gaps.
const MAX_AUTO_RUN_FILES = 100;
const MIN_AUTO_RUN_INTERVAL_MS = 2000;
// Estimated-chunk budget per auto batch, so a few huge notes cannot monopolize
// a batch (a 1MB note alone would embed ~1k chunks in a single run).
const AUTO_CHUNK_BUDGET = 1500;
// Auto runs only embed files estimated below this many chunks. Whole books
// converted to markdown (a 24MB 资治通鉴 is ~10k chunks) would otherwise
// monopolize a run for tens of minutes and make the drain look stuck; they
// stay pending and are embedded by the manual "增量更新" run instead.
const AUTO_DEFER_CHUNKS = 600;
// Embedding requests run concurrently so the GPU's idle cycles between
// per-batch scheduling are filled. Measured on bge-m3 / M4 Pro Metal: 3-way
// concurrency ≈ 1.6x the serial throughput. Batches stay at 32 texts (see
// embedding.ts) — larger batches measured *slower*.
const EMBED_CONCURRENCY = 3;
// Files that fail to embed (read error, embedding error, or no embeddable
// content — e.g. iCloud placeholders / empty notes) are retried with an
// exponential backoff instead of occupying a batch slot every single run,
// which previously let a handful of permanently-failing files starve the
// whole drain loop down to a trickle.
const FAIL_RETRY_BASE_MS = 30000;
const FAIL_RETRY_MAX_MS = 10 * 60 * 1000;
// Minimum gap between background cache writes. Each write rewrites the full
// vectors payload (hundreds of MB) and re-uploads it when the index lives
// inside the iCloud-synced vault, so writing more often than every 5 minutes
// kept freezing Obsidian's renderer. Manual runs flush immediately via
// {@link SemanticIndexer.flushCache}.
const MIN_CACHE_WRITE_INTERVAL_MS = 5 * 60 * 1000;

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
 * events): auto incremental runs embed at most `maxFiles` files per run and
 * space out large-backlog batches by {@link MIN_AUTO_RUN_INTERVAL_MS} so the
 * index keeps progressing without pinning the CPU / embedding service; auto
 * build runs never rebuild from scratch. Manual runs (commands / settings
 * buttons) are unbounded and always perform a full sync.
 */
export interface IndexRunOptions {
  auto?: boolean;
  maxFiles?: number;
}

interface FilePoolHooks {
  onIndexed: (f: TFile) => void;
  onEmpty?: (f: TFile) => void;
  onFailed: (f: TFile, e: Error) => void;
  onProgress: (done: number, total: number, f: TFile) => void;
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
  /** Total vault md files eligible for indexing; set by countPendingFiles(). */
  eligibleTotal = 0;
  private app: App;
  private outputPath: string;
  private settings: SemanticIndexerSettings;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;
  private followUpTimer: any = null;
  /** Timestamp of the last auto-run batch that drained part of a backlog. */
  private lastAutoRunAt = 0;
  /**
   * Per-path failure tracker for auto runs: consecutive failure count and the
   * timestamp before which the file must not be retried. Files that keep
   * failing (unreadable iCloud placeholders, embedding errors, notes with no
   * embeddable text) would otherwise be re-attempted in every batch forever,
   * starving the drain loop. Cleared on a successful embed.
   */
  private failStreak = new Map<string, { fails: number; retryAt: number }>();
  /** Timestamp of the last actual cache write, used to throttle background saves. */
  private lastCacheWriteAt = 0;
  private lastQueryCache: { q: string; vec: number[] } | null = null;
  /** In-flight semantic searches keyed by query|topK|min, so duplicate calls
   *  in the same tick share one scan (see {@link search}). */
  private searchInflight = new Map<string, Promise<SemanticVectorHit[]>>();
  /** Last completed search result keyed the same way; a repeat of the exact
   *  same query returns it without re-scanning 570k chunks. */
  private lastHitsCache: { key: string; hits: SemanticVectorHit[] } | null = null;
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

  // ------------------------------------------------------------------
  // Lazy vector loading
  //
  // The full vector payload (this vault: ~560MB) and its JSON metadata
  // (~20MB -> ~100MB+ of V8 objects) used to be loaded into the renderer at
  // startup and held forever, which — combined with the RAG cjkText heap and
  // Obsidian's own memory — pushed the renderer past its heap budget and
  // crashed it ("DevTools connection lost" after prolonged use).
  //
  // Now only a tiny per-document meta sidecar (path -> mtime/size/chunkCount)
  // is read at startup; that is enough for accurate pending-count / diff
  // logic. The vectors themselves are loaded exactly once, on first semantic
  // search or when an incremental run actually has work to do.
  // ------------------------------------------------------------------
  private vectorsLoaded = false;
  private vectorsLoadPromise: Promise<boolean> | null = null;
  private metaMap = new Map<string, { mtime: number; size: number; chunks: number }>();

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
  private cachePaths(): { json: string; bin: string; meta: string } {
    const root =
      this.settings.indexLocation === 'vault'
        ? path.join(getVaultRoot(), '.bib-manager')
        : getCacheRoot();
    return {
      json: path.join(root, 'semantic-index.json'),
      bin: path.join(root, 'semantic-vectors.bin'),
      meta: path.join(root, 'semantic-meta.json'),
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

  /**
   * Load only the tiny per-document metadata sidecar (no vectors). Called at
   * startup so pending-count / diff logic is accurate without pulling the
   * multi-hundred-MB vector payload into the renderer. On the first run after
   * an upgrade there is no sidecar yet — the full JSON is read once just to
   * extract the per-doc metadata, then discarded (vectors stay unloaded).
   */
  async loadCache(): Promise<boolean> {
    try {
      const { json: cacheJsonPath, meta: metaPath } = this.cachePaths();
      const metaRaw = await this.readVaultFile(metaPath);
      if (metaRaw) {
        try {
          const parsed = JSON.parse(metaRaw);
          if (parsed?.version === 1 && parsed.docs) {
            this.metaMap = new Map(
              Object.entries(parsed.docs) as [
                string,
                { mtime: number; size: number; chunks: number }
              ][]
            );
            this.index.model = parsed.model || '';
            this.vectorsLoaded = false;
            debugLog('SemanticIndexer', 'Meta sidecar loaded', {
              docs: this.metaMap.size,
            });
            return this.metaMap.size > 0;
          }
        } catch (e) {
          debugLog('SemanticIndexer', 'Failed to parse meta sidecar', { error: e });
        }
      }

      // Upgrade path: no sidecar yet. Read the full JSON once, keep only the
      // per-doc metadata, and persist it as the sidecar for next startup.
      const rawText = await this.readVaultFile(cacheJsonPath);
      if (rawText == null) return false;
      const raw = JSON.parse(rawText);
      if (!raw || raw.version !== CACHE_VERSION) return false;
      if (raw.model && this.settings.model && raw.model !== this.settings.model) return false;
      const docs: Record<string, { mtime: number; size: number; chunks: number }> = {};
      for (const d of raw.docs || []) {
        if (d?.path) {
          docs[d.path] = { mtime: d.mtime, size: d.size, chunks: d.chunks?.length ?? 0 };
        }
      }
      this.metaMap = new Map(Object.entries(docs));
      this.vectorsLoaded = false;
      void this.writeMetaSnapshot();
      debugLog('SemanticIndexer', 'Meta extracted from full JSON (upgrade)', {
        docs: this.metaMap.size,
      });
      return this.metaMap.size > 0;
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to load meta cache', { error: e });
      return false;
    }
  }

  /** Number of indexed documents (meta sidecar when vectors are not loaded). */
  get docCount(): number {
    return this.vectorsLoaded ? this.index.docCount : this.metaMap.size;
  }

  /** Number of indexed chunks (meta sidecar when vectors are not loaded). */
  get chunkCount(): number {
    if (this.vectorsLoaded) return this.index.chunkCount;
    let n = 0;
    for (const m of this.metaMap.values()) n += m.chunks;
    return n;
  }

  /**
   * Load the full vector payload + JSON metadata into memory exactly once.
   * Returns true when an index was actually loaded. Search and embedding runs
   * call this lazily; routine startup / pending-counting never does.
   */
  ensureVectorsLoaded(): Promise<boolean> {
    if (this.vectorsLoaded) return Promise.resolve(true);
    if (this.vectorsLoadPromise) return this.vectorsLoadPromise;
    this.vectorsLoadPromise = this.doLoadVectors();
    this.vectorsLoadPromise.catch(() => {
      this.vectorsLoadPromise = null;
    });
    return this.vectorsLoadPromise;
  }

  private async doLoadVectors(): Promise<boolean> {
    try {
      const { json: cacheJsonPath, bin: cacheBinPath } = this.cachePaths();
      const rawText = await this.readVaultFile(cacheJsonPath);
      if (rawText == null) return false;
      const raw = JSON.parse(rawText);
      if (!raw || raw.version !== CACHE_VERSION) return false;
      if (raw.model && this.settings.model && raw.model !== this.settings.model) return false;
      const bin = await this.readVaultBinary(cacheBinPath);
      if (bin == null) return false;
      this.index.loadFrom(raw, bin);
      this.index.model = raw.model || '';
      this.vectorsLoaded = true;
      this.refreshMetaFromIndex();
      debugLog('SemanticIndexer', 'Vectors loaded', {
        docs: this.index.docCount,
        chunks: this.index.chunkCount,
        dim: this.index.dim,
      });
      return this.index.docCount > 0;
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to load vectors', { error: e });
      return false;
    }
  }

  private refreshMetaFromIndex(): void {
    this.metaMap = new Map();
    for (const p of this.index.docKeys()) {
      const m = this.index.getMeta(p);
      if (m) {
        this.metaMap.set(p, { mtime: m.mtime, size: m.size, chunks: m.chunks.length });
      }
    }
  }

  private async writeMetaSnapshot(): Promise<void> {
    try {
      const { meta: metaPath } = this.cachePaths();
      const dir = path.dirname(metaPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: { version: number; model: string; docs: Record<string, unknown> } = {
        version: 1,
        model: this.settings.model || '',
        docs: Object.fromEntries(this.metaMap),
      };
      await fs.promises.writeFile(metaPath, JSON.stringify(payload), 'utf-8');
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to write meta sidecar', { error: e });
    }
  }

  private getDocMeta(path: string): { mtime: number; size: number } | null {
    if (this.vectorsLoaded) return this.index.getMeta(path);
    return this.metaMap.get(path) ?? null;
  }

  docKeys(): string[] {
    return this.vectorsLoaded ? this.index.docKeys() : Array.from(this.metaMap.keys());
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
    // The local-cache fallback must use the async API: this payload is
    // hundreds of MB (semantic-vectors.bin), and a synchronous readFileSync
    // here blocked the renderer main thread for seconds on the first search,
    // which together with the following JSON.parse + scan pushed the renderer
    // into a V8 heap OOM ("DevTools connection lost").
    return fs.existsSync(absPath) ? await fs.promises.readFile(absPath) : null;
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
    // Background writes are rate-limited: each write rewrites the full vector
    // payload (hundreds of MB) and re-uploads it when the index lives inside
    // an iCloud-synced vault. A 5-minute floor keeps the drain from freezing
    // Obsidian's main thread every minute with a synchronous serialize+write;
    // embedding progress is only ever lost on a crash within that window.
    const elapsed = Date.now() - this.lastCacheWriteAt;
    const delay = Math.max(5000, MIN_CACHE_WRITE_INTERVAL_MS - elapsed);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.cacheDirty) {
        this.cacheDirty = false;
        void this.writeCache();
      }
    }, delay);
  }

  /** Write the cache immediately when dirty (end of manual runs, unload). */
  async flushCache(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.cacheDirty) {
      this.cacheDirty = false;
      await this.writeCache();
    }
  }

  private async writeCache(): Promise<void> {
    try {
      const { json: cacheJsonPath, bin: cacheBinPath } = this.cachePaths();
      const dir = path.dirname(cacheJsonPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // The in-memory index is the source of truth once vectors are loaded;
      // refresh the meta snapshot so startup never has to read the 20MB JSON.
      if (this.vectorsLoaded) this.refreshMetaFromIndex();
      const json = this.index.toJSON();
      json.version = CACHE_VERSION;
      const jsonStr = JSON.stringify(json);
      // Serialization (in-memory) is unavoidable on the main thread, but the
      // disk write of the multi-hundred-MB payload is moved off-thread so the
      // renderer never blocks on disk I/O into an iCloud-synced folder. Vectors
      // are streamed chunk-by-chunk (no second full-size buffer allocation).
      await Promise.all([
        fs.promises.writeFile(cacheJsonPath, jsonStr, 'utf-8'),
        this.writeVectorsFile(cacheBinPath),
        this.writeMetaSnapshot(),
      ]);
      this.lastCacheWriteAt = Date.now();
      debugLog('SemanticIndexer', 'Cache saved', {
        docs: this.index.docCount,
        chunks: this.index.chunkCount,
      });
    } catch (e) {
      debugLog('SemanticIndexer', 'Failed to save cache', { error: e });
    }
  }

  /** Stream the concatenated chunk vectors to disk with backpressure. */
  private writeVectorsFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunks = this.index.vectorChunks();
      const stream = fs.createWriteStream(filePath);
      stream.on('error', reject);
      stream.on('finish', resolve);
      let i = 0;
      const writeNext = (): void => {
        while (i < chunks.length) {
          if (!stream.write(chunks[i++])) {
            stream.once('drain', writeNext);
            return;
          }
        }
        stream.end();
      };
      writeNext();
    });
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
      // A fresh in-memory index is authoritative; never let a stale on-disk
      // copy overwrite it via ensureVectorsLoaded() during this run.
      this.vectorsLoaded = true;
      this.failedCount = 0;
      const targets = files.slice().sort((a, b) => (a.stat.size || 0) - (b.stat.size || 0));

      await this.runFilePool(targets, {
        onIndexed: (f) => this.clearFailed(f.path),
        onFailed: (f, e) => {
          this.failedCount++;
          debugLog('SemanticIndexer', 'indexFile failed, skipping', {
            path: f.path,
            error: e.message,
          });
        },
        onProgress: (done, total, f) => {
          this.progress = { done, total, path: f.path, failed: this.failedCount };
          onProgress?.(this.progress);
        },
      });

      this.refreshMetaFromIndex();
      this.scheduleSave();
      await this.flushCache();
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

      // Diff against the per-doc metadata (cheap sidecar when the vectors are
      // not loaded) so a routine run with nothing to do never loads the
      // multi-hundred-MB vector payload into the renderer.
      // Removed files
      const removedPaths: string[] = [];
      for (const docPath of this.docKeys()) {
        if (!current.has(docPath)) removedPaths.push(docPath);
      }

      // Added / changed files
      const changed: TFile[] = [];
      for (const f of files) {
        const meta = this.getDocMeta(f.path);
        if (docChanged(meta, f.stat)) {
          changed.push(f);
        }
      }

      // Files in failure cooldown are excluded from auto runs entirely: a
      // permanently-failing file (unreadable placeholder, no embeddable text)
      // would otherwise be retried in every run and occupy batch slots forever.
      // Auto runs also defer whole-book giants (> AUTO_DEFER_CHUNKS estimated
      // chunks) so one 20-min file cannot monopolize the drain; they stay
      // pending and are embedded by the manual "增量更新" run.
      let eligible = changed;
      if (opts?.auto) {
        eligible = changed.filter(
          (f) => !this.isInFailCooldown(f.path) && this.estChunks(f) <= AUTO_DEFER_CHUNKS
        );
        const skipped = changed.length - eligible.length;
        if (skipped > 0) {
          debugLog('SemanticIndexer', 'skipped cooldown/deferred files in auto run', { skipped });
        }
      }
      // Small files first: the index grows fast, search becomes usable quickly,
      // and progress is visible instead of a 20-minute single-file stall.
      eligible.sort((a, b) => (a.stat.size || 0) - (b.stat.size || 0));
      let targets = eligible;
      if (opts?.auto && eligible.length > (opts.maxFiles ?? MAX_AUTO_RUN_FILES)) {
        const elapsed = Date.now() - this.lastAutoRunAt;
        const remaining = MIN_AUTO_RUN_INTERVAL_MS - elapsed;
        if (remaining > 0) {
          // Throttled: skip this batch, schedule the next one when allowed.
          debugLog('SemanticIndexer', 'incrementalUpdate throttled (backlog drain rate limit)', {
            changed: eligible.length,
            nextInMs: remaining,
          });
          this.scheduleFollowUp(remaining);
          return;
        }
        this.lastAutoRunAt = Date.now();
        // Pick the first files for this batch, bounded by BOTH a file count and
        // an estimated chunk budget so one huge file cannot monopolize a batch.
        const maxFiles = opts.maxFiles ?? MAX_AUTO_RUN_FILES;
        targets = [];
        let estChunks = 0;
        for (const f of eligible) {
          if (targets.length >= maxFiles) break;
          const est = this.estChunks(f);
          if (estChunks + est > AUTO_CHUNK_BUDGET && targets.length > 0) break;
          estChunks += est;
          targets.push(f);
        }
        this.scheduleFollowUp(MIN_AUTO_RUN_INTERVAL_MS);
      }

      if (removedPaths.length === 0 && targets.length === 0) {
        debugLog('SemanticIndexer', 'incrementalUpdate: nothing to do (no vector load)');
        return;
      }

      // Mutations need the real index (in-memory vectors): load it once.
      await this.ensureVectorsLoaded();
      // After this point `this.index` is the in-memory source of truth (it was
      // loaded from disk, or we are about to build it fresh into memory).
      this.vectorsLoaded = true;
      let removed = 0;
      for (const docPath of removedPaths) {
        if (this.index.removeDoc(docPath)) removed++;
      }

      this.failedCount = 0;
      let indexed = 0;
      // Manual runs over a large pending backlog embed concurrently on the GPU;
      // surface the scale so the run does not look stalled.
      if (!opts?.auto && targets.length > 100) {
        new Notice(
          `增量更新：还有 ${targets.length} 个文件待嵌入（GPU 并发 ${EMBED_CONCURRENCY} 路），其中超大文件（如整本书）会较慢。`
        );
      }
      await this.runFilePool(targets, {
        onIndexed: (f) => {
          indexed++;
          this.clearFailed(f.path);
        },
        onEmpty: (f) => {
          // No embeddable text (empty note, iCloud placeholder): treat as a
          // failure for backoff purposes so it does not get retried every run.
          this.markFailed(f.path);
        },
        onFailed: (f, e) => {
          this.failedCount++;
          this.markFailed(f.path);
          debugLog('SemanticIndexer', 'indexFile failed during incremental update', {
            path: f.path,
            error: e.message,
          });
        },
        onProgress: (done, total, f) => {
          this.progress = { done, total, path: f.path, failed: this.failedCount };
          onProgress?.(this.progress);
        },
      });

      if (indexed > 0 || removed > 0) {
        this.refreshMetaFromIndex();
        this.scheduleSave();
      }
      if (!opts?.auto) await this.flushCache();
      // When files are left in failure cooldown, wake up at the earliest
      // cooldown expiry so the drain resumes without waiting for a new vault
      // event. The batch path above only chains follow-ups while more than
      // MAX_AUTO_RUN_FILES eligible files remain, so once the backlog drains
      // down to just cooled-down files it would otherwise stall until the next
      // edit or restart.
      if (opts?.auto) {
        const nextRetry = this.earliestRetryAt();
        if (nextRetry > 0) this.scheduleFollowUp(nextRetry - Date.now());
      }
      debugLog('SemanticIndexer', 'Incremental update finished', {
        changed: targets.length,
        indexed,
        removed,
        failed: this.failedCount,
        backlog: changed.length - targets.length,
      });
    } finally {
      this.busy = false;
      this.building = false;
      this.progress = null;
    }
  }

  /**
   * Schedule a follow-up background run so a large pending backlog keeps being
   * drained over time (see {@link MIN_AUTO_RUN_INTERVAL_MS}). Follow-ups use
   * the same bounded auto-run settings.
   */
  private scheduleFollowUp(delayMs: number): void {
    if (this.followUpTimer) return;
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null;
      if (!this.enabled) return;
      if (this.busy) {
        this.scheduleFollowUp(MIN_AUTO_RUN_INTERVAL_MS);
        return;
      }
      this.incrementalUpdate(undefined, { auto: true }).catch(() => {});
    }, Math.max(delayMs, 1000));
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
      if (modelMismatch || docChanged(this.getDocMeta(f.path), f.stat)) pending++;
    }
    this.pendingCount = pending;
    // Denominator for the overall-progress display in the settings panel.
    this.eligibleTotal = total;
    debugLog('SemanticIndexer', 'countPendingFiles', { total, pending, modelMismatch });
    return pending;
  }

  /** Total vault md files eligible for indexing (overall-progress denominator). */
  countEligibleFiles(): number {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (shouldIndexPath(f.path, undefined, this.indexOptions())) n++;
    }
    return n;
  }

  /**
   * Embed one file. Returns 'indexed' when vectors were (re-)written, 'empty'
   * when the file had no embeddable text (its index entry, if any, was
   * removed). Throws on read / embedding errors; callers decide whether the
   * failure should be tracked for backoff.
   */
  private async indexFile(f: TFile): Promise<'indexed' | 'empty'> {
    // Use Obsidian's native read so iCloud on-demand files are handled
    // correctly (direct fs.readFileSync fails with ENOENT for files whose
    // content has not been downloaded to the local filesystem yet).
    const content = await this.app.vault.cachedRead(f);
    const chunks = chunkByLines(content, this.settings.chunkSize, this.settings.chunkOverlap).filter(
      (c) => c.text.trim().length > 0
    );
    if (chunks.length === 0) {
      this.index.removeDoc(f.path);
      return 'empty';
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
    return 'indexed';
  }

  /** Estimated chunk count for a file (bytes / chunkSize), minimum 1. */
  private estChunks(f: TFile): number {
    return Math.max(1, Math.ceil((f.stat.size || 0) / Math.max(1, this.settings.chunkSize)));
  }

  /**
   * Embed a list of files with {@link EMBED_CONCURRENCY} workers. Concurrency
   * fills the GPU's idle cycles between per-request scheduling (measured ~1.6x
   * vs serial on bge-m3 / M4 Pro Metal); embedding itself stays serial within
   * a file (batches of 32 texts are already optimal). The main thread is freed
   * by the await points, and a yield-to-idle every IDLE_BATCH keeps the UI
   * responsive.
   */
  private async runFilePool(
    targets: TFile[],
    hooks: FilePoolHooks
  ): Promise<void> {
    if (targets.length === 0) return;
    let cursor = 0;
    let done = 0;
    const workers = Array.from(
      { length: Math.min(EMBED_CONCURRENCY, targets.length) },
      async () => {
        while (cursor < targets.length) {
          const f = targets[cursor++];
          try {
            const outcome = await this.indexFile(f);
            if (outcome === 'indexed') {
              hooks.onIndexed(f);
            } else {
              hooks.onEmpty?.(f);
            }
          } catch (e: any) {
            hooks.onFailed(f, e);
          }
          done++;
          hooks.onProgress(done, targets.length, f);
          if (done % IDLE_BATCH === 0) await yieldToIdle();
        }
      }
    );
    await Promise.all(workers);
  }

  /** Record a failed embed attempt and return the retry-after timestamp. */
  private markFailed(path: string): number {
    const prev = this.failStreak.get(path);
    const fails = (prev?.fails ?? 0) + 1;
    const backoff = Math.min(FAIL_RETRY_BASE_MS * 2 ** (fails - 1), FAIL_RETRY_MAX_MS);
    const retryAt = Date.now() + backoff;
    this.failStreak.set(path, { fails, retryAt });
    return retryAt;
  }

  private clearFailed(path: string): void {
    this.failStreak.delete(path);
  }

  /** Files currently in failure cooldown must not occupy auto-run batch slots. */
  private isInFailCooldown(path: string): boolean {
    const f = this.failStreak.get(path);
    return !!f && f.retryAt > Date.now();
  }

  /** Earliest future retryAt among cooled-down files, or 0 if none. */
  private earliestRetryAt(): number {
    let earliest = 0;
    const now = Date.now();
    for (const f of this.failStreak.values()) {
      if (f.retryAt > now && (earliest === 0 || f.retryAt < earliest)) earliest = f.retryAt;
    }
    return earliest;
  }

  /** Embed the query (cached) and return the top chunk hits. */
  async search(query: string, topK?: number, minSimilarity?: number): Promise<SemanticVectorHit[]> {
    if (!this.enabled || this.chunkCount === 0) return [];
    // An empty/undefined query would be sent to the embedding API as a
    // `[null]` input and rejected with HTTP 400.
    if (!query || !query.trim()) return [];
    const k = topK ?? this.settings.topK ?? 20;
    const min = minSimilarity ?? 0;
    const key = `${query}\u0000${k}\u0000${min}`;

    // One full scan per query, no matter how many call sites / render cycles
    // ask for it in the same tick: a keystroke triggers both the semantic
    // group and the rerank candidate search, and stale debounced cycles can
    // still be in flight when a new one starts. Without this, the 570k-chunk
    // dot-product scan ran 2-4 times per keystroke on the renderer main
    // thread — a direct contributor to the UI freeze + OOM crash.
    if (this.lastHitsCache && this.lastHitsCache.key === key) {
      return this.lastHitsCache.hits;
    }
    const inflight = this.searchInflight.get(key);
    if (inflight) return inflight;

    const promise = this.doSearch(query, k, min).then((hits) => {
      this.searchInflight.delete(key);
      this.lastHitsCache = { key, hits };
      return hits;
    });
    this.searchInflight.set(key, promise);
    return promise;
  }

  private async doSearch(
    query: string,
    topK: number,
    minSimilarity: number
  ): Promise<SemanticVectorHit[]> {
    // Without an embedding service we cannot embed the query, so semantic
    // search is unavailable on this machine (index may still be loaded from
    // iCloud for inspection, but query embedding requires the service).
    if (!(await this.ensureEmbeddingAvailable())) return [];
    // The vectors are only pulled into the renderer when search is actually
    // used (the startup path never touches them).
    const loaded = await this.ensureVectorsLoaded();
    if (!loaded) return [];

    let qVec = this.lastQueryCache?.q === query ? this.lastQueryCache.vec : null;
    if (!qVec) {
      const vecs = await embedTexts([query], this.embedSettings());
      qVec = vecs[0];
      if (!qVec) return [];
      this.lastQueryCache = { q: query, vec: qVec };
    }
    return this.index.search(qVec, topK, minSimilarity);
  }

  destroy(): void {
    if (this.followUpTimer) {
      clearTimeout(this.followUpTimer);
      this.followUpTimer = null;
    }
    // Fire-and-forget: on plugin unload the process stays alive long enough
    // for the async write to finish, and it must not block teardown.
    void this.flushCache();
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
