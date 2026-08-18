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
//
// Token counts are not predictable from character counts (CJK is several
// times denser per char than English), so a char-capped batch can still exceed
// the server's hard token limit — Ollama's llama-server is started with a
// physical batch size (observed -b 2048) and rejects any embedding request
// whose total input exceeds it with HTTP 400 "input (N tokens) is too large
// to process". Oversized batches are therefore re-embedded in halves
// ({@link embedBatchRecursive}) so the drain never gets stuck on 400s.
const MAX_BATCH_SIZE = 32;
const MAX_BATCH_CHARS = 32000;
/** Match Ollama / llama.cpp "input too large for physical batch" rejections. */
const TOO_LARGE_RE = /too large|batch size/i;

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
  // Never send empty / null / whitespace-only inputs to the embedding service:
  // Ollama rejects `input: []` / `[null]` with HTTP 400 "invalid input", and a
  // caller that passes undefined (e.g. a search without a query) would
  // otherwise surface as a 400 in the console.
  const clean = texts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  if (clean.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < clean.length; i += batchSizeFor(clean)) {
    const batch = clean.slice(i, i + batchSizeFor(clean));
    const vecs = await embedBatchRecursive(batch, settings);
    if (vecs.length !== batch.length) {
      throw new Error(`嵌入结果数量不匹配（期望 ${batch.length}，实际 ${vecs.length}）。`);
    }
    out.push(...vecs);
  }
  return out;
}

/**
 * Embed a batch, shrinking it in halves when the server rejects it because the
 * combined input exceeds the server's physical batch size (Ollama returns
 * HTTP 400 "input is too large to process" — see {@link TOO_LARGE_RE}). A
 * single text that still exceeds the limit is rethrown so the caller can treat
 * the file as failed instead of looping forever.
 */
async function embedBatchRecursive(
  batch: string[],
  settings: EmbeddingSettings
): Promise<number[][]> {
  try {
    return await embedBatch(batch, settings);
  } catch (e: any) {
    if (TOO_LARGE_RE.test(e?.message || '') && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await embedBatchRecursive(batch.slice(0, mid), settings);
      const right = await embedBatchRecursive(batch.slice(mid), settings);
      return [...left, ...right];
    }
    throw e;
  }
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

// The probe must wait longer than one embedding batch. Local CPU Ollama
// processes 32-text batches serially and each batch can take 30–60s, so an 8s
// probe times out (and gets aborted → server logs 400) as soon as the queue is
// backed up, falsely marking the service unavailable.
const PROBE_TIMEOUT_MS = 30000;
/** Delay between availability-probe retries (startup network warm-up). */
const PROBE_RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reachability probe for a local embedding service (Ollama). Used on machines
 * that may not run the embedding service at all: when the service is
 * unreachable, the plugin must NOT build / overwrite the synced index — it
 * should only read the iCloud-synced copy.
 *
 * For local hosts we issue a real one-shot POST to /embeddings (the same
 * endpoint embedding uses). A 200 with a `data` array proves the endpoint
 * actually serves embeddings; checking /api/version is insufficient because
 * another process may occupy the port and answer 200 to unrelated paths while
 * 404'ing /embeddings. For remote/cloud URLs we assume the service is
 * available when a key is set (the full connection test is done by the
 * settings panel's "测试连接").
 */
export async function isEmbeddingServiceAvailable(settings: EmbeddingSettings): Promise<boolean> {
  const base = settings.apiUrl.replace(/\/+$/, '');
  if (!isLocalApiUrl(base)) {
    return !!settings.apiKey;
  }
  // Use the same transport as real embedding requests (postJson → fetch +
  // res.text() + JSON.parse). Obsidian's renderer can transiently stall the
  // first localhost fetch right after startup (network stack still warming up
  // / shared with other plugins), so retry a couple of times before deciding
  // the engine is unavailable.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await postJson(
        base + '/embeddings',
        { model: settings.model, input: ['probe'] },
        {},
        PROBE_TIMEOUT_MS
      );
      const ok = Array.isArray(res.json?.data) && res.json.data.length > 0;
      if (ok) return true;
    } catch {
      // retry below
    }
    if (attempt < 2) await sleep(PROBE_RETRY_DELAY_MS);
  }
  return false;
}
