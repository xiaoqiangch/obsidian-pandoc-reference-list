import { postJson } from './httpClient';

export interface RerankSettings {
  apiUrl: string;
  model: string;
  /** Number of top documents to request from the reranker. */
  topN: number;
  /** Optional relevance floor in [0,1]; results below it are dropped. */
  minScore: number;
}

export interface RerankResult {
  /** Index into the `documents` array passed to {@link rerankTexts}. */
  index: number;
  /** Relevance score in [0,1] (higher = more relevant). */
  score: number;
}

/**
 * Re-rank a list of candidate passages against a query with a cross-encoder
 * reranker. Targets the local Docker jina-reranker-v3 service, which serves a
 * `POST /rerank` (or `/v1/rerank`) route with the body
 * `{ model, query, documents, top_n }` and returns
 * `{ results: [{ index, relevance_score }] }`. Results below `minScore` are
 * dropped here, so callers only ever receive the filtered set.
 */
export async function rerankTexts(
  query: string,
  documents: string[],
  settings: RerankSettings
): Promise<RerankResult[]> {
  if (!query.trim() || documents.length === 0) return [];

  const url = settings.apiUrl.replace(/\/+$/, '') + '/rerank';
  const body = {
    model: settings.model,
    query,
    documents,
    top_n: Math.max(1, Math.min(settings.topN, documents.length)),
  };

  let response;
  try {
    response = await postJson(url, body, {});
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
 * Parse a reranker response body into a score-sorted result list. Exported
 * separately so it can be unit-tested without network access.
 */
export function parseRerankResponse(json: any): RerankResult[] {
  const results = Array.isArray(json?.results) ? json.results : [];
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
