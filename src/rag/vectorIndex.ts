export interface SemanticChunkMeta {
  startLine: number;
  endLine: number;
}

export interface SemanticDocMeta {
  path: string;
  title: string;
  literature: boolean;
  citekey?: string;
  mtime: number;
  size: number;
  chunks: SemanticChunkMeta[];
}

export interface SemanticVectorHit {
  path: string;
  title: string;
  citekey?: string;
  literature: boolean;
  startLine: number;
  endLine: number;
  score: number;
  /** Normalized similarity in [0,1] (score scaled by the int8 dot-product max). */
  similarity: number;
}

/** Unit-normalize a dense vector. */
export function normalize(vec: number[]): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/** Quantize a unit vector to int8 in [-127, 127]. Dot product of two quantized
 *  unit vectors approximates cosine similarity (scaled). */
export function quantize(vec: number[] | Float32Array): Int8Array {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127)));
  }
  return out;
}

/**
 * In-memory flat vector index over document chunks.
 * Vectors are int8-quantized unit vectors; ranking is by quantized dot
 * product (approximate cosine). Persisted as a small JSON metadata file plus
 * a raw binary file holding all chunk vectors concatenated in docOrder.
 */
export class SemanticVectorIndex {
  private docs = new Map<string, { meta: SemanticDocMeta; vectors: Int8Array }>();
  private dimension = 0;
  model = '';

  get docCount(): number {
    return this.docs.size;
  }

  get chunkCount(): number {
    let n = 0;
    for (const d of this.docs.values()) n += d.meta.chunks.length;
    return n;
  }

  get dim(): number {
    return this.dimension;
  }

  hasPath(path: string): boolean {
    return this.docs.has(path);
  }

  docKeys(): string[] {
    return Array.from(this.docs.keys());
  }

  getMeta(path: string): SemanticDocMeta | null {
    return this.docs.get(path)?.meta ?? null;
  }

  upsertDoc(
    path: string,
    title: string,
    literature: boolean,
    citekey: string | undefined,
    mtime: number,
    size: number,
    chunks: { startLine: number; endLine: number; text: string }[],
    vectors: number[][]
  ): void {
    const dim = this.dimension || vectors[0]?.length || 0;
    if (!dim || chunks.length === 0) return;
    this.dimension = dim;

    const flat = new Int8Array(chunks.length * dim);
    for (let i = 0; i < chunks.length; i++) {
      flat.set(quantize(normalize(vectors[i])), i * dim);
    }

    this.docs.set(path, {
      meta: {
        path,
        title,
        literature,
        citekey,
        mtime,
        size,
        chunks: chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine })),
      },
      vectors: flat,
    });
  }

  removeDoc(path: string): boolean {
    return this.docs.delete(path);
  }

  search(queryVec: number[], topK: number, minSimilarity = 0): SemanticVectorHit[] {
    const dim = this.dimension;
    if (!dim || this.docs.size === 0) return [];
    const q = quantize(normalize(queryVec));

    // int8 dot product max ≈ 127*127 per the normalization; scale it so the
    // returned "similarity" approximates cosine similarity in [0,1].
    const scoreMax = 127 * 127;

    const scored: { score: number; path: string; startLine: number; endLine: number }[] = [];
    for (const [path, d] of this.docs) {
      const v = d.vectors;
      const chunks = d.meta.chunks;
      for (let c = 0; c < chunks.length; c++) {
        const off = c * dim;
        let s = 0;
        for (let j = 0; j < dim; j++) s += q[j] * v[off + j];
        scored.push({ score: s, path, startLine: chunks[c].startLine, endLine: chunks[c].endLine });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((r) => r.score / scoreMax >= minSimilarity)
      .slice(0, topK)
      .map((r) => {
        const meta = this.docs.get(r.path)!.meta;
        return {
          path: r.path,
          title: meta.title,
          citekey: meta.citekey,
          literature: meta.literature,
          startLine: r.startLine,
          endLine: r.endLine,
          score: r.score,
          similarity: Math.max(0, Math.min(1, r.score / scoreMax)),
        };
      });
  }

  toJSON(): { version: number; model: string; dimension: number; docOrder: string[]; docs: SemanticDocMeta[] } {
    const docOrder = Array.from(this.docs.keys());
    return {
      version: 1,
      model: this.model,
      dimension: this.dimension,
      docOrder,
      docs: docOrder.map((p) => this.docs.get(p)!.meta),
    };
  }

  /** Raw binary payload: all chunk vectors concatenated in docOrder. */
  toVectorBuffer(): Buffer {
    const total = this.chunkCount * this.dimension;
    const flat = new Int8Array(total);
    let off = 0;
    for (const [, d] of this.docs) {
      flat.set(d.vectors, off);
      off += d.vectors.length;
    }
    return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  }

  loadFrom(json: any, buffer: Buffer): void {
    this.docs.clear();
    this.dimension = json?.dimension || 0;
    this.model = json?.model || '';
    const dim = this.dimension;
    if (!dim) return;

    const arr = new Int8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let off = 0;
    for (const meta of json?.docs || []) {
      const chunks = meta?.chunks || [];
      const n = chunks.length;
      if (!n) continue;
      const vec = arr.subarray(off, off + n * dim);
      off += n * dim;
      this.docs.set(meta.path, { meta, vectors: vec });
    }
  }
}
