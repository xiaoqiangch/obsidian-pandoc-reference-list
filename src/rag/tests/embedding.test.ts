jest.mock('shell-path', () => () => Promise.resolve(''));

import { isEmbeddingServiceAvailable, embedTexts } from '../embedding';

function embeddingResponse(input: string[]) {
  return {
    object: 'list',
    data: input.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: [text.length, 0.5],
    })),
  };
}

function okResponse(input: string[]) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(embeddingResponse(input)),
    json: async () => embeddingResponse(input),
  } as unknown as Response;
}

function tooLargeResponse() {
  const body = {
    error: {
      message:
        'input (2049 tokens) is too large to process. increase the physical batch size (current batch size: 2048)',
    },
  };
  return {
    ok: false,
    status: 400,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** Mock server: rejects any embedding batch whose total characters exceed 2000. */
function mockTokenLimitedEmbedder() {
  const calls: Array<{ input: string[]; ok: boolean }> = [];
  global.fetch = jest.fn((_url: string, init: any) => {
    const input: string[] = JSON.parse(init.body).input;
    const totalChars = input.reduce((n, t) => n + t.length, 0);
    const ok = totalChars <= 2000;
    calls.push({ input, ok });
    return Promise.resolve(ok ? okResponse(input) : tooLargeResponse());
  }) as any;
  return calls;
}

describe('embedTexts adaptive batch shrinking', () => {
  afterEach(() => {
    (global.fetch as any)?.mockRestore?.();
  });

  test('splits an oversized batch in halves until every request fits the server limit', async () => {
    const calls = mockTokenLimitedEmbedder();
    // Three 1000-char texts: any pair already crosses the 2000-char limit, so
    // the 3-text batch must be split until single texts are sent.
    const texts = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)];
    const vecs = await embedTexts(texts, {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'bge-m3',
    });
    // Vectors come back in original order (even though the request was split).
    expect(vecs.map((v) => v[0])).toEqual(texts.map((t) => t.length));
    // Splitting retries the full batch in halves, so each text is re-sent at
    // least once; the union of all sent inputs must equal the original texts.
    const sent = calls.flatMap((c) => c.input).join('');
    expect(texts.every((t) => sent.includes(t))).toBe(true);
    // The oversized first attempt was split away; every request that actually
    // succeeded was within the limit.
    expect(calls.some((c) => !c.ok)).toBe(true);
    expect(calls.filter((c) => c.ok).every((c) => c.input.reduce((n, t) => n + t.length, 0) <= 2000)).toBe(true);
  });

  test('does not split batches that already fit', async () => {
    const calls = mockTokenLimitedEmbedder();
    const texts = ['short', 'batch'];
    const vecs = await embedTexts(texts, {
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'bge-m3',
    });
    expect(vecs).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].ok).toBe(true);
  });

  test('rethrows when a single text alone exceeds the server limit', async () => {
    const calls = mockTokenLimitedEmbedder();
    await expect(
      embedTexts(['x'.repeat(5000)], {
        apiUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'bge-m3',
      })
    ).rejects.toThrow(/too large/i);
    // It tried once with the single text, no pointless resplits.
    expect(calls).toHaveLength(1);
  });
});

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
