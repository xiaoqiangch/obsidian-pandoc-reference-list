import { requestUrl } from 'obsidian';
import type { RequestUrlParam } from 'obsidian';
import { isLocalApiUrl } from '../helpers';

export interface JsonResponse {
  status: number;
  json: any;
}

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * POST a JSON body and return the parsed response.
 *
 * Transport selection:
 * - Local URLs (localhost / 127.0.0.1 / ::1 / .local): use `fetch` +
 *   AbortController so the request is *really* aborted on timeout. Local
 *   services (Ollama) echo the `app://obsidian.md` origin, so CORS is fine.
 * - Remote URLs: use Obsidian's `requestUrl` (bypasses CORS). It has no
 *   abort API, so the timeout only stops *waiting* — the underlying request
 *   keeps running, which we accept for cloud endpoints.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<JsonResponse> {
  if (isLocalApiUrl(url)) {
    return localFetchJson(url, body, headers, timeoutMs);
  }
  return remoteRequestJson(url, body, headers, timeoutMs);
}

async function localFetchJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const detail = json?.error?.message ?? json?.detail ?? text.slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    return { status: res.status, json };
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`请求超时(${timeoutMs}ms)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function remoteRequestJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<JsonResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`请求超时(${timeoutMs}ms)`)), timeoutMs);
  });

  const param: RequestUrlParam = {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };

  try {
    const response = await Promise.race([requestUrl(param), timeout]);
    return { status: response.status, json: response.json };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
