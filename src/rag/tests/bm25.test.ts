import { Bm25Index, extractTitle } from '../bm25';

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

  test('default coverage filters partial CJK bigram collisions', () => {
    const idx = new Bm25Index();
    // 哈德良 -> bigrams [哈德, 德良]; 哈德斯 -> [哈德, 德斯]
    idx.addDoc('hadrian.md', '哈德良是罗马皇帝。', {});
    idx.addDoc('hades.md', '哈德斯是冥界之神。', {});

    const hits = idx.search('哈德良', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('hadrian.md');
  });

  test('CJK whole-phrase match: 二十四桥 does not match a doc with only 二十', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '二十四桥明月夜，玉人何处教吹箫。', {});
    idx.addDoc('b.md', '二十世纪以来的经济变迁。', {});
    idx.addDoc('c.md', '二十四节气与农业生产。', {});

    const hits = idx.search('二十四桥', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('CJK phrase matches inside a longer run', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '此处提及二十四桥明月夜一句。', {});
    const hits = idx.search('二十四桥', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('CJK run split by non-CJK characters does not match the whole phrase', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '二十与四桥是两处不同的东西。', {});
    expect(idx.search('二十四桥', 10).length).toBe(0);
  });

  test('mixed CJK phrase + latin term requires both', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '二十四桥明月夜 economy', {});
    idx.addDoc('b.md', '二十四桥明月夜 art', {});
    idx.addDoc('c.md', 'economy growth', {});

    const hits = idx.search('二十四桥 economy', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('returned terms include the full CJK phrase for highlighting', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '二十四桥明月夜', {});
    const hits = idx.search('二十四桥', 10);
    expect(hits[0].terms).toContain('二十四桥');
    // Bigrams should not leak into the highlight terms.
    expect(hits[0].terms).not.toContain('二十');
  });

  test('multiple keywords require all terms by default (AND)', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy growth model', {});
    idx.addDoc('b.md', 'digital art exhibition', {});
    idx.addDoc('c.md', 'economy of scale', {});

    const hits = idx.search('digital economy', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('lower minTermCoverage relaxes the match', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy growth model', {});
    idx.addDoc('b.md', 'digital art exhibition', {});

    const hits = idx.search('digital economy', 10, 0.5);
    expect(hits.length).toBe(2);
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

  test('serialize / load round trip preserves CJK whole-phrase matching', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', '二十四桥明月夜', {});
    idx.addDoc('b.md', '二十世纪', {});
    const data = idx.serialize();
    const idx2 = new Bm25Index();
    idx2.load(data);
    const hits = idx2.search('二十四桥', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.path).toBe('a.md');
  });

  test('split meta/search payload round trip (startup fast-path + lazy postings)', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy growth', { mtime: 1, size: 100 });
    idx.addDoc('b.md', '二十四桥明月夜', { mtime: 2, size: 200 });

    // serializeMeta must NOT carry cjkText (that is what keeps it tiny).
    const meta = idx.serializeMeta();
    for (const d of meta.docs) expect((d as any).cjkText).toBeUndefined();

    const idx2 = new Bm25Index();
    idx2.loadMeta(meta);
    // Diff works with meta only (docIdByPath / documents are populated).
    expect(idx2.docCount).toBe(2);
    expect(idx2.getDocId('a.md')).toBeDefined();

    // Before the search payload is loaded, search yields nothing.
    expect(idx2.search('economy', 10).length).toBe(0);

    idx2.loadSearch(idx.serializeSearch());
    expect(idx2.search('economy', 10)[0].doc.path).toBe('a.md');
    const cjk = idx2.search('二十四桥', 10);
    expect(cjk.length).toBe(1);
    expect(cjk[0].doc.path).toBe('b.md');
    expect((idx2 as any).searchReady).toBe(true);
  });

  test('addDoc after loadMeta keeps postings consistent only once search payload is loaded', () => {
    const idx = new Bm25Index();
    idx.addDoc('a.md', 'digital economy', {});
    const idx2 = new Bm25Index();
    idx2.loadMeta(idx.serializeMeta());
    idx2.loadSearch(idx.serializeSearch());
    idx2.addDoc('c.md', 'climate change', {});
    expect(idx2.search('climate', 10)[0].doc.path).toBe('c.md');
    expect(idx2.search('economy', 10)[0].doc.path).toBe('a.md');
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

describe('extractTitle', () => {
  test('returns the first heading', () => {
    expect(extractTitle('# Hello World\n\nBody text')).toBe('Hello World');
  });

  test('skips a YAML frontmatter block', () => {
    const md = '---\ntitle: "Foo"\ntags: [a, b]\n---\n# Real Title\n\nBody';
    expect(extractTitle(md)).toBe('Real Title');
  });

  test('does not return the frontmatter delimiter as title', () => {
    const md = '---\ntitle: Foo\n---\nFirst line of body';
    expect(extractTitle(md)).not.toBe('---');
  });

  test('skips a leading thematic break with no closing delimiter', () => {
    expect(extractTitle('---\n\nBody text')).toBe('Body text');
  });

  test('returns empty string for blank content', () => {
    expect(extractTitle('')).toBe('');
    expect(extractTitle('\n\n  \n')).toBe('');
  });
});
