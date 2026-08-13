import { postJson } from '../httpClient';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}));

import { requestUrl } from 'obsidian';
const mockRequestUrl = requestUrl as jest.Mock;

describe('postJson remote transport', () => {
  beforeEach(() => mockRequestUrl.mockReset());

  test('always sends Content-Type: application/json on remote requests', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: { ok: true } });
    await postJson('https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank', { a: 1 }, {
      Authorization: 'Bearer sk-test',
    });
    const param = mockRequestUrl.mock.calls[0][0];
    expect(param.headers['Content-Type']).toBe('application/json');
    expect(param.headers['Authorization']).toBe('Bearer sk-test');
  });

  test('caller headers may override the default content type', async () => {
    mockRequestUrl.mockResolvedValue({ status: 200, json: {} });
    await postJson('https://example.com/api', {}, { 'Content-Type': 'text/plain' });
    expect(mockRequestUrl.mock.calls[0][0].headers['Content-Type']).toBe('text/plain');
  });
});
