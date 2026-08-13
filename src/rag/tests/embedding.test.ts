jest.mock('shell-path', () => () => Promise.resolve(''));

import { isEmbeddingServiceAvailable } from '../embedding';

describe('isEmbeddingServiceAvailable', () => {
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

  test('returns false when local fetch throws (no service)', async () => {
    // Force fetch to reject: point at an unused local port.
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as any;
    const ok = await isEmbeddingServiceAvailable({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'm',
    });
    expect(ok).toBe(false);
  });
});
