import { Bm25Index } from '../bm25';

describe('Bm25Index', () => {
  test('indexes and retrieves documents', () => {
    const idx = new Bm25Index();
    idx.addDoc('literature/a.md', 'The digital economy transforms markets.', { literature: true, citekey: 'a' });
    idx.addDoc('journal/b.md', 'Climate change affects agriculture.', {});

    expect(idx.docCount).toBe(2);

    const hits = idx.search('economy', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('literature/a.md');
    expect(hits[0].doc.literature).toBe(true);
    expect(hits[0].doc.citekey).toBe('a');
  });

  test('ranks by term frequency and document length', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'economy economy economy and more', {});
    idx.addDoc('b.md', 'economy only once', {});
    const hits = idx.search('economy', 10);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('CJK bigram query matches', () => {
    const idx = new Bm25Index();
    idx.addDoc('c.md', '本文研究数字经济的增长效应。', {});
    const hits = idx.search('数字经济', 10);
    expect(hits.length).toBe(1);
  });

  test('removeDoc removes a document from results', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy', {});
    idx.addDoc('b.md', 'climate change', {});
    idx.removeDoc('a.md');
    expect(idx.docCount).toBe(1);
    expect(idx.search('digital', 10).length).toBe(0);
  });

  test('serialize / load round trip', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy growth', {});
    idx.addDoc('b.md', 'climate change research', {});
    const data = idx.serialize();
    const idx2 = new Bm25Index();
    idx2.load(data);
    expect(idx2.docCount).toBe(2);
    const hits = idx2.search('economy', 10);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('addDoc replaces an existing document', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy', {});
    idx.addDoc('a.md', 'climate change', {});
    expect(idx.docCount).toBe(1);
    expect(idx.search('digital', 10).length).toBe(0);
    expect(idx.search('climate', 10).length).toBe(1);
  });
});
