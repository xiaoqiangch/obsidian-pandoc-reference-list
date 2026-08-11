import { tokenize } from './tokenizer';

export interface RagDocMeta {
  id: number;
  path: string;
  mtime: number;
  size: number;
  title: string;
  totalTerms: number;
  literature: boolean;
  citekey?: string;
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

  search(query: string, topK: number): Bm25Hit[] {
    if (!query.trim() || this.docCount === 0) return [];

    const qTerms = Array.from(new Set(tokenize(query))).filter((t) => this.postings.has(t));
    if (qTerms.length === 0) return [];

    const N = this.docCount;
    const avgdl = this.avgdl;
    const scores = new Map<number, { score: number; terms: string[] }>();

    for (const term of qTerms) {
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

    return Array.from(scores.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, topK)
      .map(([docId, entry]) => ({
        doc: this.documents.get(docId)!,
        score: entry.score,
        terms: entry.terms,
      }));
  }

  serialize(): Bm25Serialized {
    const documents = Array.from(this.documents.values()).sort((a, b) => a.id - b.id);
    const postings: Record<string, number[]> = {};
    for (const [t, arr] of this.postings) postings[t] = arr;
    return { version: 1, documents, postings, totalTokens: this.totalTokens };
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
