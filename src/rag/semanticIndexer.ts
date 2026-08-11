import { App, TFile } from 'obsidian';
import { debugLog } from '../helpers';
import { SemanticVectorIndex, SemanticVectorHit } from './vectorIndex';
import { chunkByLines } from './chunker';
import { embedTexts, EmbeddingSettings } from './embedding';
import { shouldIndexPath, isLiteraturePath } from './indexer';
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
}

/**
 * Builds and maintains a semantic (embedding) index over vault markdown files.
 * - Incremental: only changed / added / removed files are re-embedded.
 * - Persisted: JSON metadata + raw binary vector payload under
 *   .bib-manager-temp/semantic-index.json and semantic-vectors.bin.
 * - Background: processing yields to idle callbacks; embedding is batched.
 */
export class SemanticIndexer {
  index = new SemanticVectorIndex();
  private app: App;
  private vaultRoot: string;
  private outputPath: string;
  private cacheJsonPath: string;
  private cacheBinPath: string;
  private settings: SemanticIndexerSettings;
  private busy = false;
  private cacheDirty = false;
  private saveTimer: any = null;
  private lastQueryCache: { q: string; vec: number[] } | null = null;

  constructor(app: App, vaultRoot: string, outputPath: string, settings: SemanticIndexerSettings) {
    this.app = app;
    this.vaultRoot = vaultRoot;
    this.outputPath = outputPath;
    this.settings = settings;
    this.cacheJsonPath = path.join(vaultRoot, '.bib-manager-temp', 'semantic-index.json');
    this.cacheBinPath = path.join(vaultRoot, '.bib-manager-temp', 'semantic-vectors.bin');
  }

  get enabled(): boolean {
    return this.settings.enabled && !!this.settings.apiKey;
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
    try {
      const files = this.app.vault
        .getMarkdownFiles()
        .filter((f) => shouldIndexPath(f.path));
      this.index = new SemanticVectorIndex();
      this.index.model = this.settings.model;

      for (let i = 0; i < files.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        try {
          await this.indexFile(files[i]);
        } catch (e: any) {
          debugLog('SemanticIndexer', 'indexFile failed, aborting build', { path: files[i].path, error: e.message });
          throw e;
        }
        onProgress?.({ done: i + 1, total: files.length, path: files[i].path });
      }

      this.scheduleSave();
      debugLog('SemanticIndexer', 'Full build finished', { files: files.length });
    } finally {
      this.busy = false;
    }
  }

  /** Diff against the current file list and embed only what changed. */
  async incrementalUpdate(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.busy || !this.enabled) return;
    this.busy = true;
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
        if (!meta || meta.mtime !== f.stat.mtime || meta.size !== f.stat.size) {
          changed.push(f);
        }
      }

      for (let i = 0; i < changed.length; i++) {
        if (i > 0 && i % IDLE_BATCH === 0) await yieldToIdle();
        try {
          await this.indexFile(changed[i]);
        } catch (e: any) {
          debugLog('SemanticIndexer', 'indexFile failed during incremental update', {
            path: changed[i].path,
            error: e.message,
          });
          break;
        }
        onProgress?.({ done: i + 1, total: changed.length, path: changed[i].path });
      }

      if (changed.length > 0 || current.size !== this.index.docCount) {
        this.scheduleSave();
      }
      debugLog('SemanticIndexer', 'Incremental update finished', { changed: changed.length });
    } finally {
      this.busy = false;
    }
  }

  private async indexFile(f: TFile): Promise<void> {
    const abs = path.join(this.vaultRoot, f.path);
    const content = fs.readFileSync(abs, 'utf-8');
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
  async search(query: string, topK?: number): Promise<SemanticVectorHit[]> {
    if (!this.enabled || this.index.chunkCount === 0) return [];
    const k = topK ?? this.settings.topK ?? 20;

    let qVec = this.lastQueryCache?.q === query ? this.lastQueryCache.vec : null;
    if (!qVec) {
      const vecs = await embedTexts([query], this.embedSettings());
      qVec = vecs[0];
      if (!qVec) return [];
      this.lastQueryCache = { q: query, vec: qVec };
    }
    return this.index.search(qVec, k);
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
