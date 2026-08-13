import { parseRerankResponse, rerankTexts, resolveRerankSettings } from '../rerank';
import { isLocalApiUrl } from '../../helpers';

jest.mock('../httpClient', () => ({
  postJson: jest.fn(),
}));

import { postJson } from '../httpClient';
const mockPostJson = postJson as jest.Mock;

describe('rerankTexts endpoint selection', () => {
  beforeEach(() => {
    mockPostJson.mockReset();
  });

  test('rewrites Aliyun compatible-mode URLs to the native rerank endpoint', async () => {
    mockPostJson.mockResolvedValue({
      status: 200,
      json: { output: { results: [{ index: 1, relevance_score: 0.9 }] } },
    });
    await rerankTexts('query', ['doc'], {
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
      model: 'qwen3-rerank',
      topN: 5,
      minScore: 0,
    });
    const [url, body, headers] = mockPostJson.mock.calls[0];
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank'
    );
    // DashScope compatible-mode has no rerank; the rewritten native endpoint
    // requires the input-wrapped body.
    expect((body as any).model).toBe('qwen3-rerank');
    expect((body as any).input).toEqual({ query: 'query', documents: ['doc'] });
    expect((body as any).parameters).toEqual({ top_n: 1 });
    expect((body as any).query).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });

  test('uses /reranks + flat body for non-compatible Aliyun endpoints', async () => {
    mockPostJson.mockResolvedValue({
      status: 200,
      json: { results: [{ index: 0, relevance_score: 0.8 }] },
    });
    await rerankTexts('query', ['doc'], {
      apiUrl: 'https://api.aliyuncs.com/v1',
      apiKey: 'sk',
      model: 'qwen3-rerank',
      topN: 5,
      minScore: 0,
    });
    const [url, body] = mockPostJson.mock.calls[0];
    expect(url).toBe('https://api.aliyuncs.com/v1/reranks');
    expect((body as any).query).toBe('query');
    expect((body as any).documents).toEqual(['doc']);
    expect((body as any).input).toBeUndefined();
  });

  test('uses /rerank for local Docker and no key header when empty', async () => {
    mockPostJson.mockResolvedValue({
      status: 200,
      json: { results: [{ index: 0, relevance_score: 0.8 }] },
    });
    await rerankTexts('query', ['doc'], {
      apiUrl: 'http://localhost:8081/v1',
      apiKey: '',
      model: 'jina-reranker-v3',
      topN: 5,
      minScore: 0,
    });
    const [url, , headers] = mockPostJson.mock.calls[0];
    expect(url).toBe('http://localhost:8081/v1/rerank');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('Aliyun native rerank: full URL + input-wrapped body', async () => {
    mockPostJson.mockResolvedValue({
      status: 200,
      json: { output: { results: [{ index: 1, relevance_score: 0.9 }] } },
    });
    await rerankTexts('query', ['d1', 'd2', 'd3'], {
      apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
      apiKey: 'sk-test',
      model: 'qwen3-rerank',
      topN: 5,
      minScore: 0,
    });
    const [url, body, headers] = mockPostJson.mock.calls[0];
    expect(url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank'
    );
    expect((body as any).model).toBe('qwen3-rerank');
    expect((body as any).input).toEqual({ query: 'query', documents: ['d1', 'd2', 'd3'] });
    expect((body as any).parameters).toEqual({ top_n: 3 });
    expect((body as any).query).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });

  test('filters below minScore', async () => {
    mockPostJson.mockResolvedValue({
      status: 200,
      json: { results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.7 }] },
    });
    const out = await rerankTexts('query', ['d1', 'd2'], {
      apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk',
      model: 'qwen3-rerank',
      topN: 5,
      minScore: 0.5,
    });
    expect(out).toEqual([{ index: 1, score: 0.7 }]);
  });
});

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

  test('parses the Aliyun native shape (results wrapped under output)', () => {
    const parsed = parseRerankResponse({
      output: {
        results: [
          { index: 0, relevance_score: 0.4 },
          { index: 2, relevance_score: 0.9 },
        ],
      },
      usage: { total_tokens: 10 },
    });
    expect(parsed.map((r) => r.index)).toEqual([2, 0]);
    expect(parsed[0].score).toBeCloseTo(0.9);
  });

  test('ignores malformed entries and empty responses', () => {
    expect(parseRerankResponse({ results: [{ index: 'x' }, { foo: 1 }] })).toEqual([]);
    expect(parseRerankResponse({})).toEqual([]);
    expect(parseRerankResponse(null)).toEqual([]);
  });
});

describe('resolveRerankSettings', () => {
  test('hardcoded override wins over caller settings', () => {
    const out = resolveRerankSettings({
      apiUrl: 'http://localhost:8081/v1',
      apiKey: '',
      model: 'jina-reranker-v3',
      topN: 5,
      minScore: 0.5,
    });
    expect(out.apiUrl).toContain('dashscope.aliyuncs.com');
    expect(out.apiKey).toBeTruthy();
    expect(out.model).toBe('qwen3-rerank');
    expect(out.topN).toBe(20);
    expect(out.minScore).toBe(0);
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
