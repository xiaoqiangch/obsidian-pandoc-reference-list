import { SemanticVectorIndex, normalize, quantize } from '../vectorIndex';

function unit(dim: number, hot: number): number[] {
  const v = new Array(dim).fill(0.02);
  v[hot] = 1;
  return v;
}

describe('SemanticVectorIndex', () => {
  test('ranks chunks by cosine similarity', () => {
    const idx = new SemanticVectorIndex();
    idx.upsertDoc(
      'a.md',
      '文档A',
      false,
      undefined,
      1,
      10,
      [{ startLine: 1, endLine: 2, text: '关于莱茵河的军事论述' }],
      [unit(16, 3)]
    );
    idx.upsertDoc(
      'b.md',
      '文档B',
      false,
      undefined,
      1,
      10,
      [{ startLine: 1, endLine: 2, text: '关于金融市场的分析' }],
      [unit(16, 12)]
    );

    const hits = idx.search(unit(16, 3), 5);
    expect(hits.length).toBe(2);
    expect(hits[0].path).toBe('a.md');
    expect(hits[0].startLine).toBe(1);
    expect(hits[0].similarity).toBeGreaterThan(0);
    expect(hits[1].path).toBe('b.md');
  });

  test('filters hits below the min-similarity threshold', () => {
    const idx = new SemanticVectorIndex();
    idx.upsertDoc(
      'a.md',
      '文档A',
      false,
      undefined,
      1,
      10,
      [{ startLine: 1, endLine: 2, text: '关于莱茵河的军事论述' }],
      [unit(16, 3)]
    );
    idx.upsertDoc(
      'b.md',
      '文档B',
      false,
      undefined,
      1,
      10,
      [{ startLine: 1, endLine: 2, text: '关于金融市场的分析' }],
      [unit(16, 12)]
    );

    // Query targets a.md strongly; with a strict threshold only a.md survives.
    const hits = idx.search(unit(16, 3), 5, 0.5);
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('a.md');
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.5);

    // With no threshold both docs come back.
    const all = idx.search(unit(16, 3), 5);
    expect(all.length).toBe(2);
  });

  test('persists and restores vectors via serialize/load', () => {
    const idx = new SemanticVectorIndex();
    idx.model = 'test-model';
    idx.upsertDoc(
      'a.md',
      '文档A',
      true,
      'citeA',
      1,
      10,
      [
        { startLine: 1, endLine: 2, text: 'x' },
        { startLine: 3, endLine: 4, text: 'y' },
      ],
      [unit(16, 0), unit(16, 5)]
    );
    idx.upsertDoc(
      'b.md',
      '文档B',
      false,
      undefined,
      2,
      20,
      [{ startLine: 1, endLine: 1, text: 'z' }],
      [unit(16, 9)]
    );

    const json = idx.toJSON();
    const bin = idx.toVectorBuffer();

    const idx2 = new SemanticVectorIndex();
    idx2.loadFrom(json, bin);
    expect(idx2.docCount).toBe(2);
    expect(idx2.chunkCount).toBe(3);
    expect(idx2.dim).toBe(16);
    expect(idx2.getMeta('a.md')?.citekey).toBe('citeA');

    const hits = idx2.search(unit(16, 5), 5);
    expect(hits[0].path).toBe('a.md');
    expect(hits[0].startLine).toBe(3);
  });

  test('removeDoc removes chunks', () => {
    const idx = new SemanticVectorIndex();
    idx.upsertDoc('a.md', 'A', false, undefined, 1, 1, [{ startLine: 1, endLine: 1, text: 'x' }], [unit(8, 1)]);
    idx.upsertDoc('b.md', 'B', false, undefined, 1, 1, [{ startLine: 1, endLine: 1, text: 'y' }], [unit(8, 2)]);
    expect(idx.chunkCount).toBe(2);
    idx.removeDoc('a.md');
    expect(idx.docCount).toBe(1);
    expect(idx.chunkCount).toBe(1);
    expect(idx.hasPath('a.md')).toBe(false);
  });

  test('quantize/normalize produce int8 unit vectors', () => {
    const q = quantize(normalize([3, 4, 0]));
    expect(q.length).toBe(3);
    // normalized unit vector [0.6, 0.8, 0] -> int8
    expect(q[0]).toBe(76);
    expect(q[1]).toBe(102);
  });
});
