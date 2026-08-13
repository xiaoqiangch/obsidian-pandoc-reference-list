import { postJson } from './httpClient';

export interface RerankSettings {
  apiUrl: string;
  /** Optional Bearer token for cloud rerank services (阿里云百炼等). */
  apiKey: string;
  model: string;
  /** Number of top documents to request from the reranker. */
  topN: number;
  /** Optional relevance floor in [0,1]; results below it are dropped. */
  minScore: number;
}

/**
 * 硬编码的重排序配置（覆盖设置面板，个人使用无需在设置里再配置）。
 * 需要更换服务时直接改这里即可。API Key 与候选数仍由设置面板控制。
 */
export const RERANK_OVERRIDE: {
  enabled: boolean;
  apiUrl: string;
  model: string;
  topN: number;
  minScore: number;
} = {
  enabled: true,
  apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
  model: 'qwen3-rerank',
  topN: 20,
  minScore: 0,
};

/** Apply the hardcoded rerank override on top of the user-supplied API key. */
export function resolveRerankSettings(user: Pick<RerankSettings, 'apiKey'>): RerankSettings {
  return {
    apiUrl: RERANK_OVERRIDE.apiUrl,
    apiKey: user.apiKey || '',
    model: RERANK_OVERRIDE.model,
    topN: RERANK_OVERRIDE.topN,
    minScore: RERANK_OVERRIDE.minScore,
  };
}

export interface RerankResult {
  /** Index into the `documents` array passed to {@link rerankTexts}. */
  index: number;
  /** Relevance score in [0,1] (higher = more relevant). */
  score: number;
}

/**
 * Re-rank a list of candidate passages against a query with a cross-encoder
 * reranker. Supports OpenAI-compatible rerank endpoints:
 * - 本地 Docker jina-reranker-v3: `POST {apiUrl}/rerank`
 * - 阿里云百炼 qwen3-rerank（OpenAI 兼容）: `POST {apiUrl}/reranks`（Bearer key，
 *   扁平体 `{ model, query, documents, top_n }`）
 * - 阿里云百炼 qwen3-rerank（原生 API）: 直接使用配置的完整端点
 *   `/api/v1/services/rerank/text-rerank/text-rerank`，body 需 input 包装
 *   `{ model, input: { query, documents }, parameters: { top_n } }`
 * 响应统一为 `{ results: [{ index, relevance_score }] }`（原生 API 包在 `output` 下）。
 * Results below `minScore` are dropped here, so callers only ever receive the
 * filtered set.
 */
export async function rerankTexts(
  query: string,
  documents: string[],
  settings: RerankSettings
): Promise<RerankResult[]> {
  if (!query.trim() || documents.length === 0) return [];

  const base = settings.apiUrl.replace(/\/+$/, '');
  // 原生 rerank 端点（/api/v1/services/rerank/...）用完整 URL + input 包装体；
  // 阿里云百炼 OpenAI 兼容用 /reranks（复数，扁平体）；本地 Docker 及其他兼容服务用 /rerank。
  // 百炼的兼容模式（/compatible-mode/...）并不提供 rerank，只有原生 rerank 服务有——
  // 若用户配的是 compatible-mode 地址，自动改写为原生端点，避免拼出 404 路径。
  const isAliyunNative = /\/services\/rerank\//i.test(base);
  const isAliyunCompatible =
    !isAliyunNative &&
    /aliyuncs\.com|maas\.aliyuncs\.com/i.test(base) &&
    /\/compatible-mode(\/v1)?\/?$/i.test(base);
  const useNative = isAliyunNative || isAliyunCompatible;
  const url = useNative
    ? isAliyunNative
      ? base
      : base.replace(
          /\/compatible-mode(\/v1)?\/?$/i,
          '/api/v1/services/rerank/text-rerank/text-rerank'
        )
    : /aliyuncs\.com|maas\.aliyuncs\.com/i.test(base)
    ? base + '/reranks'
    : base + '/rerank';
  const topN = Math.max(1, Math.min(settings.topN, documents.length));
  const body = useNative
    ? {
        model: settings.model,
        input: { query, documents },
        parameters: { top_n: topN },
      }
    : {
        model: settings.model,
        query,
        documents,
        top_n: topN,
      };
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

  let response;
  try {
    response = await postJson(url, body, headers);
  } catch (e: any) {
    throw new Error(`重排序请求失败: ${e.message}`);
  }

  const parsed = parseRerankResponse(response.json);
  if (parsed.length === 0) {
    throw new Error('重排序返回为空');
  }
  const min = Math.max(0, Math.min(1, settings.minScore || 0));
  return min > 0 ? parsed.filter((r) => r.score >= min) : parsed;
}

/**
 * Parse a reranker response body into a score-sorted result list. Handles both
 * the flat shape `{ results: [...] }` (OpenAI-compatible / local) and the
 * Aliyun native shape `{ output: { results: [...] } }`. Exported separately so
 * it can be unit-tested without network access.
 */
export function parseRerankResponse(json: any): RerankResult[] {
  const results = Array.isArray(json?.results)
    ? json.results
    : Array.isArray(json?.output?.results)
    ? json.output.results
    : [];
  const out: RerankResult[] = [];
  for (const r of results) {
    const score = Number(r?.relevance_score ?? r?.score);
    const index = Number(r?.index);
    if (Number.isFinite(index) && Number.isFinite(score)) {
      out.push({ index, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export async function testRerankConnection(
  query: string,
  documents: string[],
  settings: RerankSettings
): Promise<number> {
  const results = await rerankTexts(query, documents, settings);
  if (results.length === 0) throw new Error('重排序返回为空');
  return results.length;
}
