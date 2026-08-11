import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

export interface EmbeddingSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

const EMBED_TIMEOUT_MS = 120000;
const BATCH_SIZE = 32;

/**
 * Embed a list of texts via a text-embedding API (Volcengine Ark / OpenAI
 * compatible /embeddings endpoint). Inputs are sent in batches; each request
 * returns one embedding per input item.
 */
export async function embedTexts(
  texts: string[],
  settings: EmbeddingSettings
): Promise<number[][]> {
  if (!settings.apiKey) {
    throw new Error('语义嵌入 API Key 未配置，请在设置中填写火山方舟 Embedding API Key。');
  }
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vecs = await embedBatch(batch, settings);
    if (vecs.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配（期望 ${batch.length}，实际 ${vecs.length}）。`);
    }
    out.push(...vecs);
  }
  return out;
}

async function embedBatch(
  batch: string[],
  settings: EmbeddingSettings
): Promise<number[][]> {
  const url = settings.apiUrl.replace(/\/+$/, '') + '/embeddings';
  const body = JSON.stringify({ model: settings.model, input: batch });

  let response: RequestUrlResponse;
  try {
    response = await requestUrlWithTimeout({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (e: any) {
    throw new Error(`嵌入请求失败: ${e.message}`);
  }

  const json = response.json;
  if (!Array.isArray(json?.data)) {
    const err = json?.error || {};
    throw new Error(err?.message || err?.code || '嵌入请求失败');
  }

  const sorted = [...json.data].sort(
    (a: any, b: any) => (a.index ?? 0) - (b.index ?? 0)
  );
  return sorted.map((d: any) =>
    Array.isArray(d.embedding) ? (d.embedding as number[]) : []
  );
}

export async function testEmbeddingConnection(settings: EmbeddingSettings): Promise<number> {
  const vecs = await embedTexts(['测试语义嵌入连接'], settings);
  if (!vecs[0]) throw new Error('嵌入返回为空');
  return vecs[0].length;
}

function requestUrlWithTimeout(opts: RequestUrlParam): Promise<RequestUrlResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`嵌入请求超时(${EMBED_TIMEOUT_MS}ms)`)),
      EMBED_TIMEOUT_MS
    );
  });
  return Promise.race([requestUrl(opts), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
