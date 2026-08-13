import { postJson } from './httpClient';
import { isLocalApiUrl } from '../helpers';

export interface EmbeddingSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

// 32 texts × ~800 chars is the sweet spot for local Ollama (bge-m3). For very
// large chunks we shrink the batch so a single request stays within the model
// context window and completes before the timeout.
const MAX_BATCH_SIZE = 32;
const MAX_BATCH_CHARS = 32000;

/**
 * Embed a list of texts via a text-embedding API (OpenAI-compatible
 * /embeddings endpoint). Works with Volcengine Ark and with local Ollama /
 * Docker services (bge-m3, jina-embeddings-v3/v5, ...) — the latter usually
 * expose the same endpoint without authentication, so `apiKey` is optional
 * and the Authorization header is only sent when a key is configured.
 * Inputs are sent in batches; each request returns one embedding per item.
 */
export async function embedTexts(
  texts: string[],
  settings: EmbeddingSettings
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSizeFor(texts)) {
    const batch = texts.slice(i, i + batchSizeFor(texts));
    const vecs = await embedBatch(batch, settings);
    if (vecs.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配（期望 ${batch.length}，实际 ${vecs.length}）。`);
    }
    out.push(...vecs);
  }
  return out;
}

/** Cap a batch so its total characters stay within a sane request size. */
function batchSizeFor(texts: string[]): number {
  if (texts.length <= MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  let chars = 0;
  let n = 0;
  for (const t of texts) {
    chars += t.length;
    n++;
    if (chars >= MAX_BATCH_CHARS || n >= MAX_BATCH_SIZE) break;
  }
  return Math.max(1, n);
}

async function embedBatch(
  batch: string[],
  settings: EmbeddingSettings
): Promise<number[][]> {
  const url = settings.apiUrl.replace(/\/+$/, '') + '/embeddings';
  const body = { model: settings.model, input: batch };
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

  let response;
  try {
    response = await postJson(url, body, headers);
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

const PROBE_TIMEOUT_MS = 3000;

/**
 * Fast reachability probe for a local embedding service (Ollama). Used on
 * machines that may not run the embedding service at all: when the service is
 * unreachable, the plugin must NOT build / overwrite the synced index — it
 * should only read the iCloud-synced copy.
 *
 * For local hosts we hit the Ollama version endpoint (cheap, no model load).
 * For remote/cloud URLs we assume the service is available when a key is set
 * (the full connection test is done by the settings panel's "测试连接").
 */
export async function isEmbeddingServiceAvailable(settings: EmbeddingSettings): Promise<boolean> {
  const base = settings.apiUrl.replace(/\/+$/, '');
  if (!isLocalApiUrl(base)) {
    return !!settings.apiKey;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      // Ollama exposes /api/version; a 200 means the service is up.
      const res = await fetch(base.replace(/\/v1$/, '') + '/api/version', {
        method: 'GET',
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
