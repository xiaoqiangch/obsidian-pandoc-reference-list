import { locateTextLines, writeLayoutFile, readLayoutFile } from '../layout';
import { mineruBboxToPdfUserSpace, buildSnippet, findLayoutHits, findLayoutBlocksByLines } from '../retrieval';
import { LayoutBlock } from '../layout';

const os = require('os');
const fs = require('fs');
const path = require('path');

describe('layout utilities', () => {
  test('locateTextLines finds the line range', () => {
    const md = '# Title\n\nline one\nline two with keyword\nline three\n';
    const loc = locateTextLines(md, 'line two with keyword');
    expect(loc).toEqual({ start: 4, end: 4 });
  });

  test('locateTextLines returns null when absent', () => {
    const loc = locateTextLines('# Title\nnothing here\n', 'missing text');
    expect(loc).toBeNull();
  });

  test('writeLayoutFile writes parseable json with line numbers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-layout-'));
    const md = '# Title\n\nSome body text here.\n';
    const blocks = writeLayoutFile(
      [{ type: 'text', page: 2, bbox: [10, 20, 800, 40], text: 'Some body text here.' }],
      md,
      dir
    );
    expect(blocks).toBeTruthy();
    expect(blocks![0].page).toBe(2);
    expect(blocks![0].lineStart).toBeGreaterThan(0);

    const read = readLayoutFile(dir);
    expect(read).toHaveLength(1);
    expect(read![0].bbox).toEqual([10, 20, 800, 40]);
  });
});

describe('mineruBboxToPdfUserSpace', () => {
  test('flips y-axis into PDF user space', () => {
    const bbox = [100, 200, 300, 400]; // normalized 0-1000, y-down
    const [x0, y0, x1, y1] = mineruBboxToPdfUserSpace(bbox, 1000, 500);
    expect(x0).toBe(100);
    expect(x1).toBe(300);
    // bottom of block (largest normalized y) maps to the smaller PDF y
    expect(y0).toBeCloseTo(500 - (400 / 1000) * 500); // 300
    expect(y1).toBeCloseTo(500 - (200 / 1000) * 500); // 400
  });
});

describe('snippet + layout hits', () => {
  test('buildSnippet returns the matching line window', () => {
    const content = 'line1\nline2\n中国经济快速发展 line3\nline4\n';
    const snip = buildSnippet(content, ['经济'], 200);
    expect(snip.text).toContain('中国经济快速发展');
    expect(snip.line).toBe(3);
  });

  test('findLayoutHits matches terms across blocks', () => {
    const layout: LayoutBlock[] = [
      { id: 'a', type: 'text', page: 1, bbox: [0, 0, 10, 10], text: '关于数字经济的讨论', lineStart: 1, lineEnd: 1 },
      { id: 'b', type: 'page_footnote', page: 2, bbox: [0, 0, 10, 10], text: '参考 Smith 2020', lineStart: 5, lineEnd: 5 },
    ];
    const hits = findLayoutHits(layout, ['数字'], 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(1);
  });

  test('findLayoutBlocksByLines maps line ranges to blocks', () => {
    const layout: LayoutBlock[] = [
      { id: 'a', type: 'text', page: 1, bbox: [0, 0, 10, 10], text: 'x', lineStart: 3, lineEnd: 4 },
      { id: 'b', type: 'text', page: 2, bbox: [0, 0, 10, 10], text: 'y', lineStart: 10, lineEnd: 11 },
    ];
    const hits = findLayoutBlocksByLines(layout, 3, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(1);
  });
});
