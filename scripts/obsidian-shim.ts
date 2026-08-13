/**
 * Obsidian runtime shim for the standalone convert-all CLI.
 *
 * The plugin's converter modules import `requestUrl` / `Notice` from
 * `obsidian` and read the vault root through the global `app`. In the CLI we
 * are running under plain Node, so we provide minimal equivalents:
 *
 *  - `requestUrl`  -> Node https GET/POST returning { status, json, text }.
 *  - `Notice`      -> console logging.
 *  - `app`         -> global object exposing `vault.adapter.getBasePath()`,
 *                     set at startup from the resolved vault root.
 *
 * esbuild is configured to treat `obsidian` as external for the main plugin
 * build, but for the CLI build we alias `obsidian` to this module.
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface RequestUrlParamShim {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

function doRequest(param: RequestUrlParamShim): Promise<any> {
  const u = new URL(param.url);
  const mod = u.protocol === 'http:' ? http : https;
  const method = (param.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(param.headers || {}) };
  let body: Buffer | null = null;
  if (param.body !== undefined) {
    body = Buffer.from(param.body as string);
    headers['Content-Length'] = String(body.length);
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      { method, headers },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf-8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          const resp = {
            status: res.statusCode || 0,
            headers: res.headers || {},
            text,
            json,
            arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          };
          if ((param.throw !== false) && resp.status >= 400) {
            const err: any = new Error(
              `Request failed with status ${resp.status}: ${text.slice(0, 200)}`
            );
            err.status = resp.status;
            reject(err);
            return;
          }
          resolve(resp);
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export const requestUrl = (param: RequestUrlParamShim): Promise<any> => doRequest(param);

export class Notice {
  constructor(message: string) {
    // eslint-disable-next-line no-console
    console.log(`[Notice] ${message}`);
  }
}

export function setGlobalApp(vaultRoot: string): void {
  const g = globalThis as any;
  g.app = {
    vault: {
      adapter: {
        getBasePath: () => vaultRoot,
      },
    },
  };
  // Some plugin helpers reference the global `window` (e.g. bib/helpers.ts
  // getGlobal() for setTimeout). Provide a stub so they fall back to Node's
  // setTimeout without throwing.
  if (!g.window) {
    g.window = {
      setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: any) => clearTimeout(id),
      requestIdleCallback: (fn: Function) => setTimeout(fn, 0),
      activeWindow: undefined,
    };
  }
}

export const App = class App {};
export const Plugin = class Plugin {};
export const TFile = class TFile {};
export const TFolder = class TFolder {};
export const Component = class Component {
  register() {}
};
export const setIcon = () => {};
export const parseYaml = (s: string) => ({});
export const moment = (t?: string) => ({ format: () => t || '' });
export const htmlToMarkdown = (s: string) => s;
