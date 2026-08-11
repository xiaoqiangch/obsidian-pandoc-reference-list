import { chunkByLines } from '../chunker';

describe('chunkByLines', () => {
  const content = [
    '第一行',
    '第二行内容较长的测试',
    '第三行',
    '第四行',
    '第五行',
    '第六行',
  ].join('\n');

  test('produces chunks covering all lines', () => {
    const chunks = chunkByLines(content, 20, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(6);
    expect(chunks.every((c) => c.startLine <= c.endLine)).toBe(true);
  });

  test('single small text yields one chunk', () => {
    const chunks = chunkByLines('只有一行', 1000, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
    expect(chunks[0].text).toBe('只有一行');
  });

  test('consecutive chunks overlap', () => {
    const chunks = chunkByLines(content, 15, 6);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
    }
  });

  test('empty text yields no chunks', () => {
    expect(chunkByLines('')).toHaveLength(0);
  });
});
