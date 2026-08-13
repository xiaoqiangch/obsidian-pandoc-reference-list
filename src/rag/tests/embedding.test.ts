jest.mock('shell-path', () => () => Promise.resolve(''));

import { isEmbeddingServiceAvailable } from '../embedding';

describe('isEmbeddingServiceAvailable', () => {
  afterEach(() => {
    (global.fetch as any)?.mockRestore?.();
  });

  test('returns true for remote URL when a key is configured', async () => {
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'ark-test',
      model: 'm',
    });
    expect(ok).toBe(true);
  });

  test('returns false for remote URL without a key', async () => {
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(false);
  });

  test('returns false when local fetch throws (no service / connection refused)', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as any;
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(false);
  });

  test('returns false when the local endpoint answers 404 (port taken by non-embedding service)', async () => {
    const res = { ok: false, status: 404, text: async () => '', json: async () => ({}) } as Response;
    global.fetch = jest.fn(() => Promise.resolve(res)) as any;
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(false);
  });

  test('returns false when a local endpoint answers 200 but with an empty data array', async () => {
    const res = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
      json: async () => ({ data: [] }),
    } as unknown as Response;
    global.fetch = jest.fn(() => Promise.resolve(res)) as any;
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(false);
  });

  test('returns true when the local endpoint returns a valid embedding payload', async () => {
    const res = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
      json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    } as unknown as Response;
    global.fetch = jest.fn(() => Promise.resolve(res)) as any;
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(true);
  });
});
