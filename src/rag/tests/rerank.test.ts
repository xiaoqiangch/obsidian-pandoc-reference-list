import { parseRerankResponse } from '../rerank';
import { isLocalApiUrl } from '../../helpers';

describe('parseRerankResponse', () => {
  test('parses results and sorts by relevance score desc', () => {
    const parsed = parseRerankResponse({
      results: [
        { index: 0, relevance_score: 0.3 },
        { index: 1, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.6 },
      ],
    });
    expect(parsed.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(parsed[0].score).toBeCloseTo(0.9);
  });

  test('supports the alternate score field', () => {
    const parsed = parseRerankResponse({ results: [{ index: 3, score: 0.75 }] });
    expect(parsed).toEqual([{ index: 3, score: 0.75 }]);
  });

  test('ignores malformed entries and empty responses', () => {
    expect(parseRerankResponse({ results: [{ index: 'x' }, { foo: 1 }] })).toEqual([]);
    expect(parseRerankResponse({})).toEqual([]);
    expect(parseRerankResponse(null)).toEqual([]);
  });
});

describe('isLocalApiUrl', () => {
  test('recognizes loopback and local hosts', () => {
    expect(isLocalApiUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLocalApiUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalApiUrl('http://0.0.0.0:8080')).toBe(true);
    expect(isLocalApiUrl('http://[::1]:8080')).toBe(true);
    expect(isLocalApiUrl('http://mybox.local:8080')).toBe(true);
  });

  test('rejects remote hosts and junk', () => {
    expect(isLocalApiUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(false);
    expect(isLocalApiUrl('http://example.com')).toBe(false);
    expect(isLocalApiUrl('')).toBe(false);
    expect(isLocalApiUrl('not a url')).toBe(false);
  });
});
