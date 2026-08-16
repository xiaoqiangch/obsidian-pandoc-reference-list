import { Bm25Index } from '../bm25';

describe('Bm25Index binary postings format', () => {
  test('binary serialize/load round trip with realistic data', () => {
    const idx = new Bm25Index();
    // Simulate realistic mixed CJK + latin corpus
    for (let i = 0; i < 50; i++) {
      idx.addDoc(`note${i}.md`, `数字经济和人工智能的融合增长效应 research paper ${i} quantum computing`, {
        mtime: i, size: 1000 + i,
      });
    }
    const buf = idx.serializeSearch();
    const idx2 = new Bm25Index();
    idx2.loadMeta(idx.serializeMeta());
    idx2.loadSearch(buf);

    // Postings must be typed arrays (off-heap backing)
    for (const arr of idx2.postings.values()) {
      expect(arr).toBeInstanceOf(Int32Array);
    }
    // Search works identically (topK caps results at 10)
    expect(idx2.search('数字经济', 50).length).toBe(50);
    expect(idx2.search('quantum', 50).length).toBe(50);
    expect(idx2.search('research', 50).length).toBe(50);

    // Removal still works (finds the doc's terms via a postings scan; the
    // full reverse map is never materialized)
    idx2.removeDoc('note0.md');
    expect(idx2.search('quantum', 50).length).toBe(49);
  });

  test('binary format handles empty and single-doc index', () => {
    const idx = new Bm25Index();
    const buf = idx.serializeSearch();
    const idx2 = new Bm25Index();
    idx2.loadSearch(buf);
    expect(idx2.postings.size).toBe(0);

    idx.addDoc('a.md', 'hello world', {});
    const buf2 = idx.serializeSearch();
    const idx3 = new Bm25Index();
    idx3.loadMeta(idx.serializeMeta());
    idx3.loadSearch(buf2);
    expect(idx3.search('hello', 10).length).toBe(1);
  });
});
