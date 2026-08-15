import { tokenize, parseQuery, extractCjkRuns } from './tokenizer';

/**
 * Separator between CJK runs stored in `RagDocMeta.cjkText`. Never appears in
 * CJK text, so a pure-CJK query phrase can never match across a run boundary.
 */
const CJK_TEXT_SEP = '\u0000';

export interface RagDocMeta {
  id: number;
  path: string;
  mtime: number;
  size: number;
  title: string;
  totalTerms: number;
  literature: boolean;
  citekey?: string;
  /**
   * Lowercased maximal CJK runs of the document, joined by CJK_TEXT_SEP.
   * Enables Obsidian-style whole-phrase substring matching ("二十四桥" only
   * matches documents that literally contain "二十四桥").
   */
  cjkText: string;
}

export interface Bm25Hit {
  doc: RagDocMeta;
  score: number;
  terms: string[];
}

export interface Bm25Serialized {
  version: number;
  documents: RagDocMeta[];
  postings: Record<string, number[]>;
  totalTokens: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * In-memory BM25 inverted index over vault markdown files.
 * Postings are stored as flat number arrays [docId, tf, docId, tf, ...] to
 * keep the in-memory and serialized footprint compact.
 */
export class Bm25Index {
  documents = new Map<number, RagDocMeta>();
  postings = new Map<string, number[]>();
  docIdByPath = new Map<string, number>();
  private docTerms = new Map<number, string[]>();
  private totalTokens = 0;
  private nextId = 1;

  get docCount(): number {
    return this.documents.size;
  }

  get avgdl(): number {
    return this.docCount ? this.totalTokens / this.docCount : 0;
  }

  hasPath(path: string): boolean {
    return this.docIdByPath.has(path);
  }

  getDocId(path: string): number | undefined {
    return this.docIdByPath.get(path);
  }

  addDoc(path: string, content: string, extra: Partial<RagDocMeta> = {}): number {
    if (this.docIdByPath.has(path)) {
      this.removeDoc(path);
    }

    const id = this.nextId++;
    const tokens = tokenize(content);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    const title = extractTitle(content);
    let totalTerms = 0;
    for (const t of tf.keys()) {
      const count = tf.get(t) || 0;
      totalTerms += count;
      let arr = this.postings.get(t);
      if (!arr) {
        arr = [];
        this.postings.set(t, arr);
      }
      arr.push(id, count);
    }

    const meta: RagDocMeta = {
      id,
      path,
      mtime: extra.mtime ?? 0,
      size: extra.size ?? 0,
      title,
      totalTerms,
      literature: extra.literature ?? false,
      citekey: extra.citekey,
      cjkText: extractCjkRuns(content).join(CJK_TEXT_SEP),
    };

    this.documents.set(id, meta);
    this.docIdByPath.set(path, id);
    this.docTerms.set(id, Array.from(tf.keys()));
    this.totalTokens += totalTerms;
    return id;
  }

  removeDoc(path: string): boolean {
    const id = this.docIdByPath.get(path);
    if (id === undefined) return false;

    const terms = this.docTerms.get(id) || [];
    const meta = this.documents.get(id);
    for (const t of terms) {
      const arr = this.postings.get(t);
      if (!arr) continue;
      const kept: number[] = [];
      let removed = 0;
      for (let i = 0; i < arr.length; i += 2) {
        if (arr[i] === id) {
          removed += arr[i + 1];
        } else {
          kept.push(arr[i], arr[i + 1]);
        }
      }
      if (kept.length === 0) this.postings.delete(t);
      else this.postings.set(t, kept);
      this.totalTokens -= removed;
    }

    this.documents.delete(id);
    this.docIdByPath.delete(path);
    this.docTerms.delete(id);
    void meta;
    return true;
  }

  /**
   * Search the index for a query.
   *
   * Matching semantics:
   * - Latin words: exact token match, relaxed by `minTermCoverage` (1 = all
   *   words must match).
   * - CJK runs: every run must appear as a contiguous substring of the
   *   document (whole-phrase match, same as Obsidian's native search). This is
   *   unconditional — "二十四桥" can never match a document that merely
   *   contains "二十".
   *
   * @param query raw query text (tokenized internally)
   * @param topK  max results to return
   * @param minTermCoverage in [0,1]; the fraction of latin query words a
   *        document must match. Ignored for CJK runs.
   */
  search(query: string, topK: number, minTermCoverage = 1): Bm25Hit[] {
    if (!query.trim() || this.docCount === 0) return [];

    const { latin, cjkRuns } = parseQuery(query);
    if (latin.length === 0 && cjkRuns.length === 0) return [];

    const matchableLatin = latin.filter((t) => this.postings.has(t));

    // Candidate docs per CJK run: documents that contain every bigram of the
    // run (a superset of documents containing the whole run). This prunes the
    // substring verification below to a small set.
    const runCandidateSets: Set<number>[] = [];
    for (const run of cjkRuns) {
      const toks = tokenize(run).filter((t) => this.postings.has(t));
      if (toks.length === 0) return []; // no document can contain this run
      runCandidateSets.push(intersectPostings(toks, this.postings));
    }

    const allTokens = new Set<string>(matchableLatin);
    for (const run of cjkRuns) {
      for (const t of tokenize(run)) if (this.postings.has(t)) allTokens.add(t);
    }
    if (allTokens.size === 0) return [];

    const N = this.docCount;
    const avgdl = this.avgdl;
    const scores = new Map<number, { score: number; terms: string[] }>();

    for (const term of allTokens) {
      const arr = this.postings.get(term)!;
      const df = arr.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      if (idf <= 0) continue;

      for (let i = 0; i < arr.length; i += 2) {
        const docId = arr[i];
        const tf = arr[i + 1];
        const meta = this.documents.get(docId);
        if (!meta) continue;
        const dl = meta.totalTerms || 1;
        const denom = tf + K1 * (1 - B + (B * dl) / (avgdl || 1));
        const contribution = idf * ((tf * (K1 + 1)) / denom);
        let entry = scores.get(docId);
        if (!entry) {
          entry = { score: 0, terms: [] };
          scores.set(docId, entry);
        }
        entry.score += contribution;
        entry.terms.push(term);
      }
    }

    const threshold = Math.max(0, Math.min(1, minTermCoverage));
    const latinSet = new Set(matchableLatin);
    const out: Bm25Hit[] = [];

    for (const [docId, entry] of scores) {
      const meta = this.documents.get(docId);
      if (!meta) continue;

      // Whole-phrase CJK match: the full run must appear contiguously.
      if (cjkRuns.length > 0) {
        if (!runCandidateSets.every((s) => s.has(docId))) continue;
        const text = meta.cjkText ?? '';
        if (!cjkRuns.every((run) => text.includes(run))) continue;
      }

      // Latin word coverage.
      if (matchableLatin.length > 0) {
        let matched = 0;
        for (const t of entry.terms) if (latinSet.has(t)) matched++;
        if (matched / matchableLatin.length < threshold) continue;
      }

      // Returned terms drive snippet selection and highlighting: matched latin
      // words plus the full CJK phrases (so "二十四桥" is highlighted as one
      // unit, not as overlapping bigrams).
      const terms: string[] = entry.terms.filter((t) => latinSet.has(t));
      for (const run of cjkRuns) terms.push(run);
      out.push({ doc: meta, score: entry.score, terms });
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  serialize(): Bm25Serialized {
    const documents = Array.from(this.documents.values()).sort((a, b) => a.id - b.id);
    const postings: Record<string, number[]> = {};
    for (const [t, arr] of this.postings) postings[t] = arr;
    return { version: 1, documents, postings, totalTokens: this.totalTokens };
  }

  /**
   * Small per-document metadata payload (no postings / cjkText). Loaded at
   * startup so incremental diffs can run without reading the large postings
   * file. cjkText is stripped here — it is only needed at search time and is
   * restored by {@link loadSearch}.
   */
  serializeMeta(): { docs: RagDocMeta[]; totalTokens: number } {
    const docs = Array.from(this.documents.values())
      .sort((a, b) => a.id - b.id)
      .map((d) => {
        const { cjkText: _cjkText, ...rest } = d;
        return rest;
      });
    return { docs, totalTokens: this.totalTokens };
  }

  /** Large search-time payload: inverted index + per-doc CJK phrase text. */
  serializeSearch(): { postings: Record<string, number[]>; cjkText: Record<number, string> } {
    const postings: Record<string, number[]> = {};
    for (const [t, arr] of this.postings) postings[t] = arr;
    const cjkText: Record<number, string> = {};
    for (const [id, doc] of this.documents) {
      if (doc.cjkText) cjkText[id] = doc.cjkText;
    }
    return { postings, cjkText };
  }

  /** Load only the small metadata payload (see {@link serializeMeta}). */
  loadMeta(data: { docs?: RagDocMeta[]; totalTokens?: number }): void {
    this.documents.clear();
    this.postings.clear();
    this.docIdByPath.clear();
    this.docTerms.clear();
    this.totalTokens = data?.totalTokens || 0;
    this.nextId = 1;
    for (const doc of data?.docs || []) {
      this.documents.set(doc.id, doc);
      this.docIdByPath.set(doc.path, doc.id);
      if (doc.id >= this.nextId) this.nextId = doc.id + 1;
    }
  }

  /** Load the large search-time payload (postings + cjkText) into a
   *  metadata-only index. Safe to call after {@link loadMeta}. */
  loadSearch(data: { postings?: Record<string, number[]>; cjkText?: Record<number, string> }): void {
    this.postings.clear();
    this.docTerms.clear();
    for (const [t, arr] of Object.entries(data?.postings || {})) {
      this.postings.set(t, arr);
      for (let i = 0; i < arr.length; i += 2) {
        const docId = arr[i];
        let list = this.docTerms.get(docId);
        if (!list) {
          list = [];
          this.docTerms.set(docId, list);
        }
        list.push(t);
      }
    }
    for (const [id, text] of Object.entries(data?.cjkText || {})) {
      const doc = this.documents.get(Number(id));
      if (doc) doc.cjkText = text;
    }
  }

  /** True once the search payload (postings + cjkText) is loaded. */
  get searchReady(): boolean {
    return this.postings.size > 0 || this.documents.size === 0;
  }

  load(data: Bm25Serialized): void {
    this.documents.clear();
    this.postings.clear();
    this.docIdByPath.clear();
    this.docTerms.clear();
    this.totalTokens = data.totalTokens || 0;
    this.nextId = 1;

    for (const doc of data.documents || []) {
      this.documents.set(doc.id, doc);
      this.docIdByPath.set(doc.path, doc.id);
      if (doc.id >= this.nextId) this.nextId = doc.id + 1;
    }
    for (const [t, arr] of Object.entries(data.postings || {})) {
      this.postings.set(t, arr);
      for (let i = 0; i < arr.length; i += 2) {
        const docId = arr[i];
        let list = this.docTerms.get(docId);
        if (!list) {
          list = [];
          this.docTerms.set(docId, list);
        }
        list.push(t);
      }
    }
  }
}

/**
 * Intersect the postings lists of the given terms into a single doc-id set.
 * Postings are flat [docId, tf, docId, tf, ...] arrays; only the doc ids are
 * considered here.
 */
function intersectPostings(tokens: string[], postings: Map<string, number[]>): Set<number> {
  const set = new Set<number>();
  const first = postings.get(tokens[0]);
  if (!first) return set;
  for (let i = 0; i < first.length; i += 2) set.add(first[i]);
  for (let k = 1; k < tokens.length; k++) {
    const arr = postings.get(tokens[k]);
    if (!arr) continue;
    const next = new Set<number>();
    for (let i = 0; i < arr.length; i += 2) {
      if (set.has(arr[i])) next.add(arr[i]);
    }
    set.clear();
    for (const d of next) set.add(d);
  }
  return set;
}

/**
 * Extract a display title from a markdown document. Skips leading blank
 * lines, a YAML frontmatter block (--- ... ---), and thematic-break lines so
 * files that begin with frontmatter or a horizontal rule do not end up
 * titled "---". Returns '' when no meaningful line exists (the caller falls
 * back to the file path).
 */
export function extractTitle(content: string): string {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;

  if (i < lines.length && /^-{3,}\s*$/.test(lines[i].trim())) {
    let j = i + 1;
    while (j < lines.length && !/^-{3,}\s*$/.test(lines[j].trim())) j++;
    if (j < lines.length) i = j + 1;
  }

  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) continue;
    return trimmed.replace(/^#+\s*/, '').slice(0, 200);
  }
  return '';
}
