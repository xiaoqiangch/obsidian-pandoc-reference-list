/* eslint-disable @typescript-eslint/ban-ts-comment */

import path from 'path';
import {
  bibToCSL,
  getCSLLocale,
  getCSLStyle,
  // getZBib,
  getZUserGroups,
  isZoteroRunning,
} from '../helpers';

// @ts-ignore
import testCSL from './test.json';
// @ts-ignore
import testBIBCSL from './test.bib.json';
// @ts-ignore
import testBIB2CSL from './test2.bib.json';
// @ts-ignore
import testYAMLCSL from './test.yaml.json';
// @ts-ignore
// import library from './My Library.json';
import { existsSync, rmSync } from 'fs';

/**
 * A minimal EventEmitter-style response stream so mocked https/http requests
 * can emit data/end just like Node's real `http.IncomingMessage`.
 */
function mockResponseStream(body: string) {
  const listeners: Record<string, Array<(payload?: any) => void>> = {};
  const stream: any = {
    setEncoding() {},
    on(event: string, cb: (payload?: any) => void) {
      (listeners[event] = listeners[event] || []).push(cb);
      return stream;
    },
    _emit(event: string, payload?: any) {
      for (const cb of listeners[event] || []) cb(payload);
    },
  };
  // Deliver the body asynchronously so awaiting code paths run correctly.
  setTimeout(() => stream._emit('data', body), 0);
  setTimeout(() => stream._emit('end'), 1);
  return stream;
}

// Mock all network modules so the suite is deterministic (no live Zotero,
// GitHub raw, or locale/style downloads).
jest.mock('https', () => {
  const actual = jest.requireActual('https');
  return {
    ...actual,
    get: jest.fn((url: string, cb: (res: any) => void) => {
      const body = url.includes('locales-') ? '<locale>bg-BG</locale>' : '<style>test-style</style>';
      cb(mockResponseStream(body));
      return { on() {}, setTimeout() {} };
    }),
  };
});

jest.mock('download', () =>
  jest.fn(() => Promise.resolve(Buffer.from('ready')))
);

jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    request: jest.fn((_opts: any, cb?: (res: any) => void) => {
      const stream = mockResponseStream(
        JSON.stringify({
          result: [
            { id: 1, name: 'My Library' },
            { id: 2, name: 'test' },
          ],
        })
      );
      if (cb) cb(stream);
      const req = {
        on() {
          return req;
        },
        setTimeout() {
          return req;
        },
        write() {},
        end() {},
      };
      return req;
    }),
  };
});

/**
 * bibToCSL stamps every entry with runtime metadata (`sourceFile` = the
 * absolute bibliography path, `addDate` = file mtime / bib add_date). The
 * fixtures are static snapshots without these, so strip them before
 * comparing to keep the assertions deterministic.
 */
function stripDynamicMeta(entries: any[]): any[] {
  return entries.map((e) => {
    const { sourceFile, addDate, line, ...rest } = e;
    void sourceFile;
    void addDate;
    void line;
    return rest;
  });
}

describe('bibToCSL()', () => {
  it('returns json from json', async () => {
    expect(
      stripDynamicMeta(
        await bibToCSL(
          path.join(__dirname, 'test.json'),
          '/opt/homebrew/bin/pandoc'
        )
      )
    ).toEqual(testCSL);
  });

  it('returns json from bib', async () => {
    expect(
      stripDynamicMeta(
        await bibToCSL(
          path.join(__dirname, 'test.bib'),
          '/opt/homebrew/bin/pandoc'
        )
      )
    ).toEqual(testBIBCSL);
  });

  it('returns json from bib2', async () => {
    expect(
      stripDynamicMeta(
        await bibToCSL(
          path.join(__dirname, 'test2.bib'),
          '/opt/homebrew/bin/pandoc'
        )
      )
    ).toEqual(testBIB2CSL);
  });

  it('returns json from yaml', async () => {
    expect(
      stripDynamicMeta(
        await bibToCSL(
          path.join(__dirname, 'test.yaml'),
          '/opt/homebrew/bin/pandoc'
        )
      )
    ).toEqual(testYAMLCSL);
  });
});

// @ts-ignore
global.setImmediate =
  // @ts-ignore
  global.setImmediate || ((fn, ...args) => global.setTimeout(fn, 0, ...args));

describe('getLocale()', () => {
  it('fetches a locale', async () => {
    const cache = new Map<string, string>();
    jest.spyOn(navigator, 'onLine', 'get').mockReturnValueOnce(true);
    const locale = await getCSLLocale(cache, __dirname, 'bg-BG');
    expect(typeof locale).toBe('string');
    expect(existsSync(path.join(__dirname, 'locales-bg-BG.xml'))).toBe(true);
    await getCSLLocale(cache, __dirname, 'bg-BG');
    rmSync(path.join(__dirname, 'locales-bg-BG.xml'));
  });
});

describe('getStyle()', () => {
  it('fetches a style', async () => {
    const cache = new Map<string, string>();
    jest.spyOn(navigator, 'onLine', 'get').mockReturnValueOnce(true);
    const style = await getCSLStyle(
      cache,
      __dirname,
      'https://www.zotero.org/styles/australian-guide-to-legal-citation-3rd-edition'
    );
    expect(typeof style).toBe('string');
    expect(
      existsSync(
        path.join(__dirname, 'australian-guide-to-legal-citation-3rd-edition')
      )
    ).toBe(true);
    await getCSLStyle(
      cache,
      __dirname,
      'australian-guide-to-legal-citation-3rd-edition'
    );
    rmSync(
      path.join(__dirname, 'australian-guide-to-legal-citation-3rd-edition')
    );
  });
});

describe('getZUserGroups()', () => {
  it('retrieves user groups', async () => {
    expect(await getZUserGroups('23119')).toEqual([
      { id: 1, name: 'My Library' },
      { id: 2, name: 'test' },
    ]);
  });
});

// describe('getZBib()', () => {
//   it('retrieves bib', async () => {
//     expect(await getZBib(new Map(), '23119', 1, 'My Library')).toEqual(library);
//   });
// });

describe('isZoteroRunning()', () => {
  it('runs', async () => {
    expect(await isZoteroRunning('23119')).toBe(true);
  });
});
