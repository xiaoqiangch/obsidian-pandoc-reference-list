import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import https from 'https';
import download from 'download';
import { request } from 'http';
import { CSLList, PartialCSLEntry } from './types';
import crypto from 'crypto';

export const DEFAULT_ZOTERO_PORT = '23119';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getBibPath(bibPath: string, getVaultRoot?: () => string) {
  if (!fs.existsSync(bibPath)) {
    const orig = bibPath;
    if (getVaultRoot) {
      bibPath = path.join(getVaultRoot(), bibPath);
      if (!fs.existsSync(bibPath)) {
        throw new Error(`bibToCSL: cannot access bibliography file '${bibPath}'.`);
      }
    } else {
      throw new Error(`bibToCSL: cannot access bibliography file '${orig}'.`);
    }
  }

  return bibPath;
}

export async function bibToCSL(
  bibPath: string,
  pathToPandoc: string,
  getVaultRoot?: () => string,
  cacheDir?: string
): Promise<PartialCSLEntry[]> {
  bibPath = getBibPath(bibPath, getVaultRoot);

  const parsed = path.parse(bibPath);
  const stats = fs.statSync(bibPath);
  const cacheKey = crypto.createHash('md5').update(`${bibPath}_${stats.mtimeMs}_${stats.size}`).digest('hex');
  const cacheFile = cacheDir ? path.join(cacheDir, `csl-cache-${cacheKey}.json`) : null;

  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      console.log(`bibToCSL: loading from cache ${cacheFile}`);
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      console.log(`bibToCSL: loaded ${data.length} entries from cache`);
      return data;
    } catch (e) {
      console.warn(`bibToCSL: failed to load cache ${cacheFile}`, e);
    }
  }

  if (parsed.ext === '.json') {
    return new Promise((res, rej) => {
      console.log(`bibToCSL: reading JSON file ${bibPath}`);
      fs.readFile(bibPath, (err, data) => {
        if (err) {
          console.error(`bibToCSL: failed to read JSON file ${bibPath}`, err);
          return rej(err);
        }
        try {
          const json = JSON.parse(data.toString());
          console.log(`bibToCSL: parsed ${json.length} entries from JSON`);
          res(json);
        } catch (e) {
          console.error(`bibToCSL: failed to parse JSON file ${bibPath}`, e);
          rej(e);
        }
      });
    });
  }

  if (!pathToPandoc) {
    throw new Error('bibToCSL: path to pandoc is required for non CSL files.');
  }

  if (!fs.existsSync(pathToPandoc)) {
    throw new Error(`bibToCSL: cannot access pandoc at '${pathToPandoc}'.`);
  }

  const args = [bibPath, '-t', 'csljson', '--quiet'];

  console.log(`bibToCSL: executing ${pathToPandoc} ${args.join(' ')} (File size: ${stats.size} bytes)`);
  const startTime = Date.now();
  let csl: PartialCSLEntry[];
  
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    try {
      const res = await execa(pathToPandoc, args, { timeout: 120000 });
      console.log(`bibToCSL: pandoc finished in ${Date.now() - startTime}ms`);

      if (res.stderr) {
        console.warn(`bibToCSL: pandoc stderr: ${res.stderr}`);
      }

      csl = JSON.parse(res.stdout) as PartialCSLEntry[];
      console.log(`bibToCSL: parsed ${csl.length} entries from pandoc output`);
      break; // Success
    } catch (e) {
      attempts++;
      console.error(`bibToCSL: pandoc attempt ${attempts} failed for ${bibPath}`, e);
      if (attempts >= maxAttempts) throw e;
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // If it's a bib file, try to extract the 'file' field which pandoc drops
  if (parsed.ext === '.bib') {
    try {
      const bibContent = fs.readFileSync(bibPath, 'utf-8');
      const extraMap = new Map<string, { file?: string; line?: number }>();
      
      const lines = bibContent.split('\n');
      let currentEntry: { id: string; line: number } | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^\s*@\w+\s*\{\s*([^,]+),/);
        if (match) {
          currentEntry = { id: match[1].trim(), line: i + 1 };
          extraMap.set(currentEntry.id, { line: currentEntry.line });
        } else if (currentEntry) {
          const fileMatch = line.match(/file\s*=\s*[\{\"]([^\"\}]+)[\}\"]/i);
          if (fileMatch) {
            const existing = extraMap.get(currentEntry.id);
            extraMap.set(currentEntry.id, { ...existing, file: fileMatch[1].trim() });
          }
          const dateMatch = line.match(/add_date\s*=\s*[\{\"]([^\"\}]+)[\}\"]/i);
          if (dateMatch) {
            const existing = extraMap.get(currentEntry.id);
            (existing as any).addDate = dateMatch[1].trim();
            extraMap.set(currentEntry.id, existing);
          }
        }
      }

      for (const entry of csl) {
        if (extraMap.has(entry.id)) {
          const extra = extraMap.get(entry.id);
          entry.file = extra.file;
          entry.line = extra.line;
          entry.addDate = (extra as any).addDate;
          entry.sourceFile = bibPath;
        }
        
        // Map CSL fields to our PartialCSLEntry fields if they are different
        if ((entry as any)['container-title'] && !entry.journal && !entry.booktitle) {
          entry.journal = (entry as any)['container-title'];
        }
        if ((entry as any)['issued']?.['date-parts']?.[0]?.[0]) {
          entry.year = (entry as any)['issued']['date-parts'][0][0].toString();
        }
        if ((entry as any)['URL']) entry.url = (entry as any)['URL'];
        if ((entry as any)['DOI']) entry.doi = (entry as any)['DOI'];
        if ((entry as any)['abstract']) entry.abstract = (entry as any)['abstract'];
        if ((entry as any)['note']) entry.note = (entry as any)['note'];
        if ((entry as any)['publisher']) entry.publisher = (entry as any)['publisher'];
        if ((entry as any)['volume']) entry.volume = (entry as any)['volume'];
        if ((entry as any)['issue']) entry.number = (entry as any)['issue'];
        if ((entry as any)['page']) entry.pages = (entry as any)['page'];
      }
    } catch (e) {
      console.error('Error extracting extra fields from bib file:', e);
    }
  }

  if (cacheFile) {
    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(cacheFile, JSON.stringify(csl), 'utf-8');
      console.log(`bibToCSL: saved to cache ${cacheFile}`);
    } catch (e) {
      console.warn(`bibToCSL: failed to save cache ${cacheFile}`, e);
    }
  }

  return csl;
}

export async function getCSLLocale(
  localeCache: Map<string, string>,
  cacheDir: string,
  lang: string
) {
  if (localeCache.has(lang)) {
    return localeCache.get(lang);
  }

  const url = `https://raw.githubusercontent.com/citation-style-language/locales/master/locales-${lang}.xml`;
  const outpath = path.join(cacheDir, `locales-${lang}.xml`);

  ensureDir(cacheDir);
  if (fs.existsSync(outpath)) {
    const localeData = fs.readFileSync(outpath).toString();
    localeCache.set(lang, localeData);
    return localeData;
  }

  const str = await new Promise<string>((res, rej) => {
    const req = https.get(url, (result) => {
      let output = '';

      result.setEncoding('utf8');
      result.on('data', (chunk) => (output += chunk));
      result.on('error', (e) => rej(`Downloading locale: ${e}`));
      result.on('end', () => {
        if (/^404: Not Found/.test(output)) {
          rej(new Error('Error downloading locale: 404: Not Found'));
        } else {
          res(output);
        }
      });
    });
    req.on('error', (e) => rej(`Downloading locale: ${e}`));
    req.setTimeout(10000, () => {
      req.destroy();
      rej(new Error('Downloading locale: Timeout'));
    });
  });

  fs.writeFileSync(outpath, str);
  localeCache.set(lang, str);
  return str;
}

export async function getCSLStyle(
  styleCache: Map<string, string>,
  cacheDir: string,
  url: string,
  explicitPath?: string
) {
  if (explicitPath) {
    if (styleCache.has(explicitPath)) {
      return styleCache.get(explicitPath);
    }

    if (!fs.existsSync(explicitPath)) {
      throw new Error(
        `Error: retrieving citation style; Cannot find file '${explicitPath}'.`
      );
    }

    const styleData = fs.readFileSync(explicitPath).toString();
    styleCache.set(explicitPath, styleData);
    return styleData;
  }

  if (styleCache.has(url)) {
    return styleCache.get(url);
  }

  const fileFromURL = url.split('/').pop();
  const outpath = path.join(cacheDir, fileFromURL);

  ensureDir(cacheDir);
  if (fs.existsSync(outpath)) {
    const styleData = fs.readFileSync(outpath).toString();
    styleCache.set(url, styleData);
    return styleData;
  }

  const str = await new Promise<string>((res, rej) => {
    const req = https.get(url, (result) => {
      let output = '';

      result.setEncoding('utf8');
      result.on('data', (chunk) => (output += chunk));
      result.on('error', (e) => rej(`Error downloading CSL: ${e}`));
      result.on('end', () => {
        try {
          res(output);
        } catch (e) {
          rej(e);
        }
      });
    });
    req.on('error', (e) => rej(`Error downloading CSL: ${e}`));
    req.setTimeout(10000, () => {
      req.destroy();
      rej(new Error('Error downloading CSL: Timeout'));
    });
  });

  fs.writeFileSync(outpath, str);
  styleCache.set(url, str);
  return str;
}

export const defaultHeaders = {
  'Content-Type': 'application/json',
  'User-Agent': 'obsidian/zotero',
  Accept: 'application/json',
  Connection: 'keep-alive',
};

function getGlobal() {
  if (window?.activeWindow) return activeWindow;
  if (window) return window;
  return global;
}

export async function getZUserGroups(
  port: string = DEFAULT_ZOTERO_PORT
): Promise<Array<{ id: number; name: string }>> {
  if (!(await isZoteroRunning(port))) return null;

  return new Promise((res, rej) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'user.groups',
    });

    const postRequest = request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/better-bibtex/json-rpc',
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (result) => {
        let output = '';

        result.setEncoding('utf8');
        result.on('data', (chunk) => (output += chunk));
        result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
        result.on('close', () => {
          rej(new Error('Error: cannot connect to Zotero'));
        });
        result.on('end', () => {
          try {
            res(JSON.parse(output).result);
          } catch (e) {
            rej(e);
          }
        });
      }
    );

    postRequest.write(body);
    postRequest.end();
  });
}

function panNum(n: number) {
  if (n < 10) return `0${n}`;
  return n.toString();
}

function timestampToZDate(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${panNum(d.getUTCMonth() + 1)}-${panNum(
    d.getUTCDate()
  )} ${panNum(d.getUTCHours())}:${panNum(d.getUTCMinutes())}:${panNum(
    d.getUTCSeconds()
  )}`;
}

export async function getZModified(
  port: string = DEFAULT_ZOTERO_PORT,
  groupId: number,
  since: number
): Promise<CSLList> {
  if (!(await isZoteroRunning(port))) return null;

  return new Promise((res, rej) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'item.search',
      params: [[['dateModified', 'isAfter', timestampToZDate(since)]], groupId],
    });

    const postRequest = request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/better-bibtex/json-rpc',
        method: 'POST',
        headers: {
          ...defaultHeaders,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (result) => {
        let output = '';

        result.setEncoding('utf8');
        result.on('data', (chunk) => (output += chunk));
        result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
        result.on('close', () => {
          rej(new Error('Error: cannot connect to Zotero'));
        });
        result.on('end', () => {
          try {
            res(JSON.parse(output).result);
          } catch (e) {
            rej(e);
          }
        });
      }
    );

    postRequest.write(body);
    postRequest.end();
  });
}

function applyGroupID(list: CSLList, groupId: number) {
  return list.map((item) => {
    item.groupID = groupId;
    return item;
  });
}

export async function getZBib(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  loadCached?: boolean
) {
  const isRunning = await isZoteroRunning(port);
  const cached = path.join(cacheDir, `zotero-library-${groupId}.json`);

  ensureDir(cacheDir);
  if (loadCached || !isRunning) {
    if (fs.existsSync(cached)) {
      return applyGroupID(
        JSON.parse(fs.readFileSync(cached).toString()) as CSLList,
        groupId
      );
    }
    if (!isRunning) {
      return null;
    }
  }

  const bib = await download(
    `http://127.0.0.1:${port}/better-bibtex/export/library?/${groupId}/library.json`
  );

  const str = bib.toString();

  fs.writeFileSync(cached, str);

  return applyGroupID(JSON.parse(str) as CSLList, groupId);
}

export async function refreshZBib(
  port: string = DEFAULT_ZOTERO_PORT,
  cacheDir: string,
  groupId: number,
  since: number
) {
  if (!(await isZoteroRunning(port))) {
    return null;
  }

  const cached = path.join(cacheDir, `zotero-library-${groupId}.json`);
  ensureDir(cacheDir);
  if (!fs.existsSync(cached)) {
    return null;
  }

  const mList = (await getZModified(port, groupId, since)) as CSLList;

  if (!mList?.length) {
    return null;
  }

  const modified: Map<string, PartialCSLEntry> = new Map();
  const newKeys: Set<string> = new Set();

  for (const mod of mList) {
    mod.id = (mod as any).citekey || (mod as any)['citation-key'];
    if (!mod.id) continue;
    modified.set(mod.id, mod);
    newKeys.add(mod.id);
  }

  const list = JSON.parse(fs.readFileSync(cached).toString()) as CSLList;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (modified.has(item.id)) {
      newKeys.delete(item.id);
      list[i] = modified.get(item.id);
    }
  }

  for (const key of newKeys) {
    list.push(modified.get(key));
  }

  fs.writeFileSync(cached, JSON.stringify(list));

  return {
    list: applyGroupID(list, groupId),
    modified,
  };
}

export async function isZoteroRunning(port: string = DEFAULT_ZOTERO_PORT) {
  const p = download(`http://127.0.0.1:${port}/better-bibtex/cayw?probe=true`);
  const res = await Promise.race([
    p,
    new Promise((res) => {
      getGlobal().setTimeout(() => {
        res(null);
        p.destroy();
      }, 150);
    }),
  ]);

  return res?.toString() === 'ready';
}

export async function getItemJSONFromCiteKeys(
  port: string = DEFAULT_ZOTERO_PORT,
  citeKeys: string[],
  libraryID: number
) {
  if (!(await isZoteroRunning(port))) return null;

  let res: any;
  try {
    res = await new Promise((res, rej) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'item.export',
        params: [citeKeys, '36a3b0b5-bad0-4a04-b79b-441c7cef77db', libraryID],
      });

      const postRequest = request(
        {
          host: '127.0.0.1',
          port: port,
          path: '/better-bibtex/json-rpc',
          method: 'POST',
          headers: {
            ...defaultHeaders,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (result) => {
          let output = '';

          result.setEncoding('utf8');
          result.on('data', (chunk) => (output += chunk));
          result.on('error', (e) => rej(`Error connecting to Zotero: ${e}`));
          result.on('close', () => {
            rej(new Error('Error: cannot connect to Zotero'));
          });
          result.on('end', () => {
            try {
              res(JSON.parse(output));
            } catch (e) {
              rej(e);
            }
          });
        }
      );

      postRequest.write(body);
      postRequest.end();
    });
  } catch (e) {
    console.error(e);
    return null;
  }

  try {
    if (res.error?.message) {
      console.error(new Error(res.error.message));
      return null;
    }

    return Array.isArray(res.result)
      ? JSON.parse(res.result[2]).items
      : JSON.parse(res.result).items;
  } catch (e) {
    console.error(e);
    return null;
  }
}
