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
 * Postings are stored as flat Int32Array arrays [docId, tf, docId, tf, ...].
 * Typed arrays back their data with ArrayBuffers (allocated outside the V8
 * GC-managed old space), which keeps the renderer's JS heap low — a 515MB JSON
 * postings file previously inflated to >1GB of tagged `number[]` values +
 * per-array object overhead and caused renderer "JavaScript heap out of
 * memory" crashes (Obsidian renderer dies, DevTools disconnects).
 *
 * `docTerms` (docId -> term list, used by removeDoc) is built lazily so that
 * loading the search payload never duplicates every term reference again.
 */
export class Bm25Index {
  documents = new Map<number, RagDocMeta>();
  postings = new Map<string, Int32Array>();
  docIdByPath = new Map<string, number>();
  private docTerms = new Map<number, string[]>();
  private docTermsBuilt = false;
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
      this.appendPosting(t, id, count);
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

  /** Append a (docId, tf) pair to a term's postings list (grow by copy). */
  private appendPosting(term: string, docId: number, tf: number): void {
    const old = this.postings.get(term);
    if (!old) {
      this.postings.set(term, Int32Array.of(docId, tf));
      return;
    }
    const next = new Int32Array(old.length + 2);
    next.set(old);
    next[old.length] = docId;
    next[old.length + 1] = tf;
    this.postings.set(term, next);
  }

  removeDoc(path: string): boolean {
    const id = this.docIdByPath.get(path);
    if (id === undefined) return false;

    this.ensureDocTerms();
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
      else this.postings.set(t, Int32Array.from(kept));
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
    for (const [t, arr] of this.postings) postings[t] = Array.from(arr);
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

  /**
   * Serialize the large search-time payload (inverted index + per-doc CJK
   * phrase text) as a compact binary Buffer. Postings are written as raw
   * int32 LE values, so loading them back produces Int32Array views over the
   * same ArrayBuffer (zero-copy, off the V8 GC-heap object budget). A 515MB
   * JSON postings file previously forced `JSON.parse` to materialize ~1GB of
   * tagged numbers + 2.4M string keys in the renderer's JS heap, which is what
   * crashed Obsidian with "JavaScript heap out of memory".
   *
   * Layout:
   *   magic 'BM25' (4B) | version u32 | termCount u32
   *   per term: keyLen u32, key utf8, count u32, count × int32LE postings
   *   cjkCount u32
   *   per cjk: docId u32, textLen u32, text utf8
   */
  serializeSearch(): Buffer {
    const parts: Buffer[] = [];
    const magic = Buffer.from('BM25', 'ascii');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(1, 0); // version
    header.writeUInt32LE(this.postings.size, 4); // termCount
    parts.push(magic, header);
    for (const [t, arr] of this.postings) {
      const key = Buffer.from(t, 'utf8');
      // Pad the key to a 4-byte boundary so the following int32 postings are
      // aligned (Int32Array requires a multiple-of-4 byteOffset).
      const pad = (4 - (key.length % 4)) % 4;
      const meta = Buffer.alloc(8 + key.length + pad);
      meta.writeUInt32LE(key.length + pad, 0);
      meta.writeUInt32LE(arr.length, 4);
      key.copy(meta, 8);
      const data = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      parts.push(meta, data);
    }
    const cjkEntries: Array<[number, Buffer]> = [];
    for (const [id, doc] of this.documents) {
      if (doc.cjkText) cjkEntries.push([id, Buffer.from(doc.cjkText, 'utf8')]);
    }
    const cjkCount = Buffer.alloc(4);
    cjkCount.writeUInt32LE(cjkEntries.length, 0);
    parts.push(cjkCount);
    for (const [id, text] of cjkEntries) {
      const meta = Buffer.alloc(8);
      meta.writeUInt32LE(id, 0);
      meta.writeUInt32LE(text.length, 4);
      parts.push(meta, text);
    }
    return Buffer.concat(parts);
  }

  /** Load only the small metadata payload (see {@link serializeMeta}). */
  loadMeta(data: { docs?: RagDocMeta[]; totalTokens?: number }): void {
    this.documents.clear();
    this.postings.clear();
    this.docIdByPath.clear();
    this.docTerms.clear();
    this.docTermsBuilt = false;
    this.totalTokens = data?.totalTokens || 0;
    this.nextId = 1;
    for (const doc of data?.docs || []) {
      this.documents.set(doc.id, doc);
      this.docIdByPath.set(doc.path, doc.id);
      if (doc.id >= this.nextId) this.nextId = doc.id + 1;
    }
  }

  /** Load the large search-time payload (binary from {@link serializeSearch})
   *  into a metadata-only index. Postings are kept as zero-copy Int32Array
   *  views over the Buffer's ArrayBuffer — never duplicated into JS objects —
   *  and docTerms is built lazily only when a document is actually removed. */
  loadSearch(buf: Buffer): void {
    this.postings.clear();
    this.docTerms.clear();
    this.docTermsBuilt = false;
    let o = 0;
    if (buf.length < 12) return;
    if (buf.toString('ascii', 0, 4) !== 'BM25') return;
    const version = buf.readUInt32LE(4);
    if (version !== 1) return;
    const termCount = buf.readUInt32LE(8);
    o = 12;
    for (let i = 0; i < termCount && o + 8 <= buf.length; i++) {
      const storedLen = buf.readUInt32LE(o);
      o += 4;
      const count = buf.readUInt32LE(o);
      o += 4;
      if (o + storedLen > buf.length) return;
      const key = buf.toString('utf8', o, o + storedLen).replace(/\u0000+$/, '');
      o += storedLen;
      if (o + count * 4 > buf.length) return;
      const view = new Int32Array(buf.buffer, buf.byteOffset + o, count);
      this.postings.set(key, view);
      o += count * 4;
    }
    if (o + 4 > buf.length) return;
    const cjkCount = buf.readUInt32LE(o);
    o += 4;
    for (let i = 0; i < cjkCount && o + 8 <= buf.length; i++) {
      const docId = buf.readUInt32LE(o);
      o += 4;
      const textLen = buf.readUInt32LE(o);
      o += 4;
      if (o + textLen > buf.length) return;
      const doc = this.documents.get(docId);
      if (doc) doc.cjkText = buf.toString('utf8', o, o + textLen);
      o += textLen;
    }
  }

  /** True once the search payload (postings + cjkText) is loaded. */
  get searchReady(): boolean {
    return this.postings.size > 0 || this.documents.size === 0;
  }

  /**
   * Build docTerms (docId -> term list) lazily on first removal. Loading the
   * search payload skips this entirely — it would duplicate every term
   * reference again (~170MB for this vault) just to support a rare delete.
   */
  private ensureDocTerms(): void {
    if (this.docTermsBuilt) return;
    this.docTermsBuilt = true;
    for (const [t, arr] of this.postings) {
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

  load(data: Bm25Serialized): void {
    this.documents.clear();
    this.postings.clear();
    this.docIdByPath.clear();
    this.docTerms.clear();
    this.docTermsBuilt = false;
    this.totalTokens = data.totalTokens || 0;
    this.nextId = 1;

    for (const doc of data.documents || []) {
      this.documents.set(doc.id, doc);
      this.docIdByPath.set(doc.path, doc.id);
      if (doc.id >= this.nextId) this.nextId = doc.id + 1;
    }
    for (const [t, arr] of Object.entries(data.postings || {})) {
      this.postings.set(t, Int32Array.from(arr));
    }
  }
}

/**
 * Intersect the postings lists of the given terms into a single doc-id set.
 * Postings are flat [docId, tf, docId, tf, ...] typed arrays; only the doc
 * ids are considered here.
 */
function intersectPostings(tokens: string[], postings: Map<string, Int32Array>): Set<number> {
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
