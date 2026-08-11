import { buildPageChunks, computeMaxAttempts, mergeChunkResults, buildFootnotesFromLayout } from '../mineruChunks';

describe('buildPageChunks', () => {
  test('splits pages into chunks of at most maxPages', () => {
    expect(buildPageChunks(450, 200)).toEqual([
      [1, 200],
      [201, 400],
      [401, 450],
    ]);
  });

  test('single chunk when under the limit', () => {
    expect(buildPageChunks(150, 200)).toEqual([[1, 150]]);
  });

  test('handles zero pages', () => {
    expect(buildPageChunks(0, 200)).toEqual([[1, 1]]);
  });
});

describe('computeMaxAttempts', () => {
  test('scales with chunk size above the base', () => {
    expect(computeMaxAttempts(200, 300)).toBe(400);
    expect(computeMaxAttempts(50, 300)).toBe(300);
  });

  test('falls back to a sane base when called with a single argument', () => {
    expect(computeMaxAttempts(200)).toBe(400);
    expect(computeMaxAttempts(50)).toBe(300);
  });
});

describe('mergeChunkResults', () => {
  const chunk1 = {
    mdContent: '# 第一章',
    imageCount: 3,
    footnotes: '',
    layout: [
      { type: 'text', page: 1, bbox: [0, 0, 1, 1], text: '正文一' },
      { type: 'page_footnote', page: 1, bbox: [0, 0, 1, 1], text: '脚注 A' },
    ],
  };
  const chunk2 = {
    mdContent: '# 第二章',
    imageCount: 5,
    footnotes: '',
    layout: [
      { type: 'text', page: 1, bbox: [0, 0, 1, 1], text: '正文二' },
      { type: 'page_footnote', page: 2, bbox: [0, 0, 1, 1], text: '脚注 B' },
    ],
  };

  test('merges markdown, offsets page numbers and sums images', () => {
    const merged = mergeChunkResults([chunk1, chunk2], [1, 201]);
    expect(merged.mdContent).toContain('# 第一章');
    expect(merged.mdContent).toContain('# 第二章');
    expect(merged.imageCount).toBe(8);

    // chunk2 blocks are offset by 200 pages
    const page201 = merged.layout.find((b) => b.text === '正文二');
    expect(page201!.page).toBe(201);
    const footnotePage202 = merged.layout.find((b) => b.text === '脚注 B');
    expect(footnotePage202!.page).toBe(202);
  });

  test('footnotes are rebuilt with correct global page numbers', () => {
    const merged = mergeChunkResults([chunk1, chunk2], [1, 201]);
    expect(merged.footnotes).toContain('### 第 1 页');
    expect(merged.footnotes).toContain('脚注 A');
    expect(merged.footnotes).toContain('### 第 202 页');
    expect(merged.footnotes).toContain('脚注 B');
  });
});

describe('buildFootnotesFromLayout', () => {
  test('renders footnote blocks with dedupe', () => {
    const layout = [
      { type: 'page_footnote', page: 3, bbox: null, text: '参考文献条目' },
      { type: 'text', page: 3, bbox: null, text: '正文内容' },
    ];
    const md = '正文内容';
    const out = buildFootnotesFromLayout(md, layout);
    expect(out).toContain('### 第 3 页');
    expect(out).toContain('> 参考文献条目');
  });
});
