import { EditorView } from '@codemirror/view';
import CSL from 'citeproc';
import ReferenceList from '../main';
import { PartialCSLEntry } from './types';
import Fuse from 'fuse.js';
import {
  bibToCSL,
  getBibPath,
  getCSLLocale,
  getCSLStyle,
  getItemJSONFromCiteKeys,
  getZBib,
  refreshZBib,
} from './helpers';
import {
  PromiseCapability,
  copyElToClipboard,
  getVaultRoot,
  debugLog,
  showDetailedTooltip,
} from '../helpers';
import {
  RenderedCitation,
  getCitationSegments,
  getCitations,
} from '../parser/parser';
import LRUCache from 'lru-cache';
import { Keymap, MarkdownView, TFile, setIcon } from 'obsidian';
import { cite } from '../parser/citeproc';
import { setCiteKeyCache } from '../editorExtension';
import equal from 'fast-deep-equal';
import { t } from '../lang/helpers';

const path = require('path');
const fs = require('fs');

import crypto from 'crypto';

const fuseSettings = {
  includeMatches: true,
  threshold: 0.35,
  minMatchCharLength: 2,
  keys: [
    { name: 'id', weight: 0.7 },
    { name: 'title', weight: 0.3 },
    { name: 'author.family', weight: 0.2 },
    { name: 'author.given', weight: 0.1 },
  ],
};

interface ScopedSettings {
  style?: string;
  lang?: string;
  bibliography?: string | string[];
}

export interface FileCache {
  keys: Set<string>;
  resolvedKeys: Set<string>;
  unresolvedKeys: Set<string>;
  bib: HTMLElement;
  citations: RenderedCitation[];
  citeBibMap: Map<string, string>;

  settings: ScopedSettings | null;

  source: {
    bibCache?: Map<string, PartialCSLEntry>;
    fuse?: Fuse<PartialCSLEntry>;
    engine?: any;
  };
}

function getScopedSettings(file: TFile): ScopedSettings {
  const metadata = app.metadataCache.getFileCache(file);
  const output: ScopedSettings = {};

  if (!metadata?.frontmatter) {
    return null;
  }

  const { frontmatter } = metadata;

  if (frontmatter.bibliography) {
    if (Array.isArray(frontmatter.bibliography)) {
      output.bibliography = frontmatter.bibliography.map((b: string) => b.trim());
    } else {
      output.bibliography = frontmatter.bibliography.split(',').map((b: string) => b.trim());
      if ((output.bibliography as string[]).length === 1) {
        output.bibliography = (output.bibliography as string[])[0];
      }
    }
  }

  output.style =
    frontmatter.csl?.trim() ||
    frontmatter['citation-style']?.trim() ||
    undefined;
  output.lang =
    frontmatter.lang?.trim() ||
    frontmatter['citation-language']?.trim() ||
    undefined;

  if (Object.values(output).every((v) => !v)) {
    return null;
  }

  // Checks whether the bibliography is a relative path and replaces the path with an absolute one
  const processPath = (bibPath: string) => {
    if (existsSync(path.join(getVaultRoot(), path.dirname(file.path), bibPath))) {
      return path.join(getVaultRoot(), path.dirname(file.path), bibPath);
    }
    return bibPath;
  };

  if (output.bibliography) {
    if (Array.isArray(output.bibliography)) {
      output.bibliography = output.bibliography.map(processPath);
    } else {
      output.bibliography = processPath(output.bibliography);
    }
  }

  return output;
}

function extractRawLocales(style: string, localeName?: string) {
  const locales = ['en-US'];
  if (localeName) {
    locales.push(localeName);
  }
  if (style) {
    const matches = style.match(/locale="[^"]+"/g);
    if (matches) {
      for (const match of matches) {
        const vals = match.slice(0, -1).slice(8).split(/\s+/);
        for (const val of vals) {
          locales.push(val);
        }
      }
    }
  }
  return normalizeLocales(locales);
}

function normalizeLocales(locales: string[]) {
  const obj: Record<string, boolean> = {};
  for (let locale of locales) {
    locale = locale.split('-').slice(0, 2).join('-');
    if (CSL.LANGS[locale]) {
      obj[locale] = true;
    } else {
      locale = locale.split('-')[0];
      if (CSL.LANG_BASES[locale]) {
        locale = CSL.LANG_BASES[locale].split('_').join('-');
        obj[locale] = true;
      }
    }
  }
  return Object.keys(obj);
}

export class BibManager {
  plugin: ReferenceList;
  fileCache: LRUCache<TFile, FileCache>;
  initPromise: PromiseCapability<void>;
  private reinitTask: Promise<void> | null = null;
  private pendingClearCache = false;

  langCache: Map<string, string> = new Map();
  styleCache: Map<string, string> = new Map();

  bibCache: Map<string, PartialCSLEntry> = new Map();
  fuse: Fuse<PartialCSLEntry>;
  engine: any;

  zCitekeyToLinks: Map<string, string> = new Map();
  zCitekeyToAttachmentLinks: Map<string, string[]> = new Map();

  watcherCache: Map<string, FSWatcher> = new Map();

  constructor(plugin: ReferenceList) {
    this.plugin = plugin;
    this.initPromise = new PromiseCapability();
    this.fileCache = new LRUCache({
      max: 10,
      noDisposeOnSet: true,
      dispose: (cache) => {
        if (cache.settings?.bibliography) {
          const bibs = Array.isArray(cache.settings.bibliography)
            ? cache.settings.bibliography
            : [cache.settings.bibliography];
          bibs.forEach((b) => this.clearWatcher(b));
        }
      },
    });
  }

  destroy() {
    this.fileCache.clear();

    for (const watcher of this.watcherCache.values()) {
      watcher.close();
    }

    this.watcherCache.clear();
    this.langCache.clear();
    this.styleCache.clear();
    this.bibCache.clear();
    this.fuse = null;
    this.engine = null;
    this.plugin = null;
  }

  clearWatcher(path: string) {
    if (this.watcherCache.has(path)) {
      this.watcherCache.get(path).close();
      this.watcherCache.delete(path);
    }
  }

  async reinit(clearCache: boolean) {
    if (clearCache) this.pendingClearCache = true;

    if (this.reinitTask) {
      await this.reinitTask;
      return;
    }

    this.reinitTask = (async () => {
      const shouldClear = this.pendingClearCache;
      this.pendingClearCache = false;

      this.initPromise = new PromiseCapability();
      this.fileCache.clear();
      if (shouldClear) this.bibCache.clear();

      try {
        if (this.plugin.settings.pullFromZotero) {
          await this.loadGlobalZBib(false);
        } else {
          await this.loadGlobalBibFile();
        }
      } finally {
        this.initPromise.resolve();
      }
    })();

    try {
      await this.reinitTask;
    } finally {
      this.reinitTask = null;
    }
  }

  setFuse(data: PartialCSLEntry[] = []) {
    console.log(`BibManager: setFuse called with ${data.length} entries`);
    if (!this.fuse) {
      this.fuse = new Fuse(data, fuseSettings);
    } else {
      this.fuse.setCollection(data);
    }
  }

  updateFuse(data: Map<string, PartialCSLEntry>) {
    if (!this.fuse) return;

    this.fuse.remove((doc) => {
      return data.has(doc.id);
    });

    for (const doc of data.values()) {
      this.fuse.add(doc);
    }
  }

  async loadScopedEngine(settings: ScopedSettings) {
    if (!settings) return this;

    const pluginSettings = this.plugin.settings;
    let style =
      pluginSettings.cslStyleURL ??
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    let lang = pluginSettings.cslLang ?? 'en-US';
    let bibCache = this.bibCache;
    let fuse = this.fuse;
    let langs = [settings.lang];

    if (settings.style) {
      try {
        const isURL = /^http/.test(settings.style);
        const styleObj = isURL
          ? { id: settings.style }
          : { id: settings.style, explicitPath: settings.style };
        const styles = await this.loadStyles([styleObj]);
        for (const styleStr of styles) {
          langs = extractRawLocales(styleStr, settings.lang);
        }
        style = settings.style;
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    if (settings.lang) {
      try {
        await this.loadLangs(langs);
        lang = settings.lang;
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    if (settings.bibliography) {
      try {
        const bibPaths = Array.isArray(settings.bibliography)
          ? settings.bibliography
          : [settings.bibliography];
        
        bibCache = new Map();
        const allEntries: PartialCSLEntry[] = [];

        for (const bibPath of bibPaths) {
          const bib = await bibToCSL(
            bibPath,
            this.plugin.settings.pathToPandoc,
            getVaultRoot,
            this.plugin.cacheDir
          );

          for (const entry of bib) {
            bibCache.set(entry.id, entry);
            allEntries.push(entry);
          }
        }

        fuse = new Fuse(allEntries, fuseSettings);
      } catch (e) {
        console.error(e);
        return this;
      }
    }

    try {
      const engine = this.buildEngine(
        lang,
        this.langCache,
        style,
        this.styleCache,
        bibCache
      );

      return {
        bibCache,
        fuse,
        engine,
      };
    } catch (e) {
      console.error(e);
      return this;
    }
  }

  async loadGlobalBibFile() {
    debugLog('BibManager', 'loadGlobalBibFile called', { bibCacheSize: this.bibCache.size });
    const { settings } = this.plugin;

    const bibPaths = [];
    if (settings.pathToBibliography) bibPaths.push(settings.pathToBibliography);
    if (Array.isArray(settings.bibliographyPaths)) {
      bibPaths.push(...settings.bibliographyPaths);
    }

    debugLog('BibManager', 'bibPaths to load', bibPaths);

    if (bibPaths.length === 0) {
      debugLog('BibManager', 'no bibliography paths configured');
      return;
    }

    console.log('BibManager: loading bib files', bibPaths);
    const newCache = new Map<string, PartialCSLEntry>();
    const allBibEntries: PartialCSLEntry[] = [];

    for (const pathToBib of bibPaths) {
      try {
        debugLog('BibManager', `loading ${pathToBib}`);
        const bib = await bibToCSL(
          pathToBib,
          settings.pathToPandoc,
          getVaultRoot,
          this.plugin.cacheDir
        );

        console.log(`BibManager: loaded ${bib.length} entries from ${pathToBib}`);

        const bibPath = getBibPath(pathToBib, getVaultRoot);

        if (bibPath && !this.watcherCache.has(bibPath)) {
          let dbTimer = 0;
          this.watcherCache.set(
            bibPath,
            fs.watch(bibPath, (evt: string) => {
              if (evt === 'change') {
                clearTimeout(dbTimer);
                dbTimer = window.setTimeout(() => {
                  this.reinit(true).then(() => {
                    this.plugin.processReferences();
                  });
                }, 500);
              } else {
                this.clearWatcher(bibPath);
              }
            })
          );
        }

        for (const entry of bib) {
          newCache.set(entry.id, entry);
          allBibEntries.push(entry);
        }
      } catch (e) {
        debugLog('BibManager', `Error loading bibliography file ${pathToBib}`, e);
        console.error(`Error loading bibliography file ${pathToBib}:`, e);
      }
    }

    this.bibCache = newCache;
    this.setFuse(allBibEntries);

    const style =
      settings.cslStylePath ||
      settings.cslStyleURL ||
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    const lang = settings.cslLang || 'en-US';

    debugLog('BibManager', 'loading lang and style', { lang, style });
    await this.getLangAndStyle(lang, {
      id: style,
      explicitPath: settings.cslStylePath,
    });
    
    debugLog('BibManager', 'getLangAndStyle finished', { 
      hasStyle: this.styleCache.has(style), 
      style, 
      lang,
      bibCacheSize: this.bibCache.size 
    });

    if (!this.styleCache.has(style)) {
      debugLog('BibManager', `style ${style} not found in cache`);
      console.error(`BibManager: style ${style} not found in cache`);
      return;
    }

    try {
      this.engine = this.buildEngine(
        lang,
        this.langCache,
        style,
        this.styleCache,
        this.bibCache
      );
      debugLog('BibManager', 'engine built successfully');
    } catch (e) {
      debugLog('BibManager', 'failed to build engine', e);
      console.error('BibManager: failed to build engine', e);
    }
  }

  async loadAndRefreshGlobalZBib() {
    await this.loadGlobalZBib(true);
    await this.refreshGlobalZBib();
  }

  async loadGlobalZBib(fromCache?: boolean) {
    const { settings, cacheDir } = this.plugin;
    if (!settings.zoteroGroups?.length) return;

    const bib: PartialCSLEntry[] = [];
    for (const group of settings.zoteroGroups) {
      try {
        const list = await getZBib(
          settings.zoteroPort,
          cacheDir,
          group.id,
          fromCache
        );
        if (list?.length) {
          bib.push(...list);
          group.lastUpdate = Date.now();
        }
      } catch (e) {
        console.error('Error fetching bibliography from Zotero', e);
        continue;
      }
    }

    this.plugin.saveSettings();

    this.bibCache = new Map();
    for (const entry of bib) {
      this.bibCache.set(entry.id, entry);
    }

    this.setFuse(bib);

    const style =
      settings.cslStylePath ||
      settings.cslStyleURL ||
      'https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl';
    const lang = settings.cslLang || 'en-US';

    await this.getLangAndStyle(lang, {
      id: style,
      explicitPath: settings.cslStylePath,
    });
    
    console.log('BibManager: getLangAndStyle finished', { 
      hasStyle: this.styleCache.has(style), 
      style, 
      lang,
      bibCacheSize: this.bibCache.size 
    });

    if (!this.styleCache.has(style)) {
      console.error(`BibManager: style ${style} not found in cache`);
      return;
    }

    try {
      this.engine = this.buildEngine(
        lang,
        this.langCache,
        style,
        this.styleCache,
        this.bibCache
      );
      console.log('BibManager: engine built successfully');
    } catch (e) {
      console.error('BibManager: failed to build engine', e);
    }
  }

  async refreshGlobalZBib() {
    const { settings, cacheDir } = this.plugin;
    if (!settings.zoteroGroups?.length) return;

    const bib: PartialCSLEntry[] = [];
    const modifiedEntries: Map<string, PartialCSLEntry> = new Map();

    for (const group of settings.zoteroGroups) {
      try {
        const res = await refreshZBib(
          settings.zoteroPort,
          cacheDir,
          group.id,
          group.lastUpdate
        );
        if (!res) continue;
        if (res.list?.length) {
          bib.push(...res.list);
          group.lastUpdate = Date.now();
        }

        for (const [k, v] of res.modified.entries()) {
          modifiedEntries.set(k, v);
          this.bibCache.set(k, v);
        }
      } catch (e) {
        console.error('Error fetching bibliography from Zotero', e);
        continue;
      }
    }

    this.plugin.saveSettings();
    this.updateFuse(modifiedEntries);
    this.fileCache.clear();
    this.plugin.processReferences();
  }

  buildEngine(
    lang: string,
    langCache: Map<string, string>,
    style: string,
    styleCache: Map<string, string>,
    bibCache: Map<string, PartialCSLEntry>
  ) {
    const styleXML = styleCache.get(style);
    if (!styleXML) {
      throw new Error(
        'attempting to build citproc engine with empty CSL style'
      );
    }
    if (!langCache.get(lang)) {
      throw new Error(
        'attempting to build citproc engine with empty CSL locale'
      );
    }
    const engine = new CSL.Engine(
      {
        retrieveLocale: (id: string) => {
          return langCache.get(id);
        },
        retrieveItem: (id: string) => {
          return bibCache.get(id);
        },
      },
      styleXML,
      lang
    );
    engine.opt.development_extensions.wrap_url_and_doi = true;
    return engine;
  }

  async getLangAndStyle(
    lang: string,
    style: { id: string; explicitPath?: string }
  ) {
    let styles: string[] = [];
    if (!this.styleCache.has(style.id)) {
      try {
        styles = await this.loadStyles([style]);
      } catch (e) {
        console.error('Error loading style', style, e);
        this.initPromise.resolve();
        return;
      }
    }

    let locales = [lang];
    for (const styleStr of styles) {
      locales = extractRawLocales(styleStr, lang);
    }

    try {
      await this.loadLangs(locales);
    } catch (e) {
      console.error('Error loading lang', lang, e);
      this.initPromise.resolve();
      return;
    }
  }

  async loadLangs(langs: string[]) {
    for (const lang of langs) {
      if (!lang) continue;
      if (!this.langCache.has(lang)) {
        await getCSLLocale(this.langCache, this.plugin.cacheDir, lang);
      }
    }
  }

  async loadStyles(styles: { id?: string; explicitPath?: string }[]) {
    const res: string[] = [];
    for (const style of styles) {
      if (!style.id && !style.explicitPath) continue;
      if (!this.styleCache.has(style.explicitPath ?? style.id)) {
        res.push(
          await getCSLStyle(
            this.styleCache,
            this.plugin.cacheDir,
            style.id,
            style.explicitPath
          )
        );
      }
    }
    return res;
  }

  getNoteForNoteIndex(file: TFile, index: string) {
    if (!this.fileCache.has(file)) {
      return null;
    }

    const cache = this.fileCache.get(file);
    const noteIndex = parseInt(index);

    const cite = cache.citations.find((c) => c.noteIndex === noteIndex);

    if (!cite.note) {
      return null;
    }

    const doc = new DOMParser().parseFromString(cite.note, 'text/html');
    return Array.from(doc.body.childNodes);
  }

  getBibForCiteKey(file: TFile, key: string) {
    if (!this.fileCache.has(file)) {
      return null;
    }

    const cache = this.fileCache.get(file);
    if (!cache.keys.has(key)) {
      return null;
    }

    const html = cache.citeBibMap.get(key);
    if (!html) {
      return null;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.body.firstElementChild as HTMLElement;
    if (el) {
      el.dataset.citekey = key;
      return this.prepBibHTML(el, file, true, cache.source.bibCache);
    }
    return el;
  }

  async getReferenceList(file: TFile, content: string) {
    debugLog('BibManager', 'getReferenceList started', file.path);
    await this.plugin.initPromise.promise;
    await this.initPromise.promise;
    debugLog('BibManager', 'getReferenceList promises resolved');

    const segs = getCitationSegments(
      content,
      !this.plugin.settings.renderLinkCitations
    );
    debugLog('BibManager', 'getCitationSegments finished', { count: segs.length });
    const processed = segs.map((s) => getCitations(s));

    if (!processed.length) return null;

    const citeKeys = new Set<string>();
    const unresolvedKeys = new Set<string>();
    const resolvedKeys = new Set<string>();
    const cachedDoc = this.fileCache.has(file)
      ? this.fileCache.get(file)
      : null;
    const citeBibMap = new Map<string, string>();
    const settings = getScopedSettings(file);

    processed.forEach((p) =>
      p.citations.forEach((c) => {
        if (c.id && !citeKeys.has(c.id)) {
          citeKeys.add(c.id);
        }
      })
    );

    const areSettingsEqual =
      equal(settings?.bibliography, cachedDoc?.settings?.bibliography) &&
      settings?.style === cachedDoc?.settings?.style &&
      settings?.lang === cachedDoc?.settings?.lang;

    if (!areSettingsEqual && cachedDoc?.settings?.bibliography) {
      const oldBibs = Array.isArray(cachedDoc.settings.bibliography)
        ? cachedDoc.settings.bibliography
        : [cachedDoc.settings.bibliography];
      oldBibs.forEach((b) => this.clearWatcher(b));
    }

    const source =
      cachedDoc?.source && areSettingsEqual
        ? cachedDoc.source
        : await this.loadScopedEngine(settings);

    if (settings?.bibliography) {
      const bibPaths = Array.isArray(settings.bibliography)
        ? settings.bibliography
        : [settings.bibliography];

      for (const pathToBib of bibPaths) {
        try {
          const bibPath = getBibPath(pathToBib, getVaultRoot);
          if (!this.watcherCache.has(bibPath)) {
            let dbTimer = 0;
            this.watcherCache.set(
              bibPath,
              fs.watch(bibPath, (evt: string) => {
                if (evt === 'change') {
                  clearTimeout(dbTimer);
                  dbTimer = window.setTimeout(() => {
                    this.reinit(true).then(() => {
                      this.plugin.processReferences();
                    });
                  }, 500);
                } else {
                  this.clearWatcher(bibPath);
                }
              })
            );
          }
        } catch (e) {
          console.error(`Error watching bibliography file ${pathToBib}:`, e);
        }
      }
    }

    const setNull = (): null => {
      const result: FileCache = {
        keys: citeKeys,
        resolvedKeys,
        unresolvedKeys,
        bib: null,
        citations: [],
        citeBibMap,
        settings: null,
        source,
      };

      this.fileCache.set(file, result);
      this.dispatchResult(file, result);

      return null;
    };

    if (!source?.engine) {
      return setNull();
    }

    citeKeys.forEach((k) => {
      if (source.bibCache.has(k)) {
        resolvedKeys.add(k);
      } else {
        unresolvedKeys.add(k);
      }
    });

    const filtered = processed.filter((s) =>
      s.citations.every((c) => {
        const resolved = source.bibCache.has(c.id);
        if (resolved) {
          resolvedKeys.add(c.id);
        } else {
          unresolvedKeys.add(c.id);
        }
        return resolved;
      })
    );

    // Do we need this?
    // source.engine.updateItems(Array.from(resolvedKeys));

    const citations = cite(source.engine, filtered);

    if (
      cachedDoc &&
      equal(cachedDoc.citations, citations) &&
      areSettingsEqual
    ) {
      return cachedDoc.bib;
    }

    const bib = source.engine.makeBibliography();

    if (!bib?.length) {
      return setNull();
    }

    const metadata = bib[0];
    const entries = bib[1];
    const htmlStr = [metadata.bibstart];

    metadata.entry_ids?.forEach((e: string, i: number) => {
      entries[i] = entries[i].replace(/<([a-z0-9]+)/i, `<$1 data-citekey="${e[0]}"`);
      citeBibMap.set(e[0], entries[i]);
    });

    for (const entry of entries) htmlStr.push(entry);

    htmlStr.push(metadata.bibend);
    let parsed = entries.length
      ? (new DOMParser().parseFromString(htmlStr.join(''), 'text/html').body
          .firstElementChild as HTMLElement)
      : null;

    if (parsed) {
      if (this.plugin.settings.pullFromZotero && !settings?.bibliography) {
        await this.getZLinksForKeys(resolvedKeys);
      }
      parsed = this.prepBibHTML(parsed, file, false, source.bibCache);
    }

    const result: FileCache = {
      keys: citeKeys,
      resolvedKeys,
      unresolvedKeys,
      bib: parsed,
      citations,
      citeBibMap,
      settings,
      source,
    };

    this.fileCache.set(file, result);
    this.dispatchResult(file, result);

    return result.bib;
  }

  async getZLinksForKeys(citekeys: Set<string>) {
    const queries: Record<number, string[]> = {};

    citekeys.forEach((key) => {
      if (!this.zCitekeyToLinks.has(key)) {
        if (!this.bibCache.has(key)) return;
        const item = this.bibCache.get(key);
        const id = item.groupID;
        if (id === undefined) return;
        if (!queries[id]) {
          queries[id] = [];
        }
        queries[id].push(key);
      }
    });

    for (const id of Object.keys(queries)) {
      const groupId = Number(id);
      try {
        const items = await getItemJSONFromCiteKeys(
          this.plugin.settings.zoteroPort,
          queries[groupId],
          groupId
        );
        if (items?.length) {
          for (const item of items) {
            const key = item.citekey || item.citationKey;
            const link = item.select;
            if (key && link) {
              this.zCitekeyToLinks.set(key, link);
              if (item.attachments?.length) {
                const attLinks: string[] = [];
                for (const att of item.attachments) {
                  if (/\.(pdf|epub)$/i.test(att.path)) {
                    attLinks.push(att.path);
                  }
                }
                if (attLinks.length) {
                  this.zCitekeyToAttachmentLinks.set(key, attLinks);
                }
              }
            }
          }
        }
      } catch {
        //
      }
    }
  }

  prepBibHTML(
    parsed: HTMLElement,
    file: TFile,
    inTooltip?: boolean,
    bibCache?: Map<string, PartialCSLEntry>
  ) {
    if (this.plugin.settings.hideLinks) {
      parsed?.findAll('a').forEach((l) => {
        l.setAttribute('aria-label', l.innerText);
      });
    }

    if (parsed?.hasClass('csl-entry')) {
      const entry = parsed;
      parsed = createDiv();
      parsed.append(entry);
    }

    const cache = bibCache || this.bibCache;

    parsed?.findAll('.csl-entry').forEach((e, i) => {
      if (!inTooltip) {
        e.setAttribute('aria-label', t('Click to copy'));
        e.onClickEvent(() => copyElToClipboard(e));
      }

      const wrapper = createDiv({ cls: 'csl-entry-wrapper' });
      e.parentElement.insertBefore(wrapper, e);
      wrapper.append(e);

      const target = e.querySelector('.csl-right-inline') || e;
      const btnContainer = target.createSpan({ cls: 'pwc-entry-btns' });

      const citekey = e.dataset.citekey || metadata.entry_ids?.[i]?.[0];
      if (citekey) {
        const zLink = this.zCitekeyToLinks.get(citekey);
        let linkText = '@' + citekey;
        let linkDest = app.metadataCache.getFirstLinkpathDest(
          linkText,
          file.path
        );
        if (!linkDest) {
          linkText = citekey;
          linkDest = app.metadataCache.getFirstLinkpathDest(
            linkText,
            file.path
          );
        }

        const entry = cache.get(citekey);
        const zAttachmentLinks = this.zCitekeyToAttachmentLinks.get(citekey) || [];
        const localAttachmentLinks = this.parseBibFileField(entry?.file);
        const allAttachmentLinks = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];

        // Copy Citekey Button
        btnContainer.createDiv('clickable-icon', (div) => {
          setIcon(div, 'copy');
          div.setAttr('aria-label', t('Copy citekey'));
          div.onClickEvent(async () => {
            await navigator.clipboard.writeText(`[@${citekey}]`);
            new Notice(t('Citekey copied to clipboard'));
          });
        });

        // Edit Button
        if (entry?.sourceFile) {
          btnContainer.createDiv('clickable-icon', (div) => {
            setIcon(div, 'edit');
            div.setAttr('aria-label', t('Edit in VS Code'));
            div.onClickEvent(() => {
              const path = entry.sourceFile;
              const line = entry.line || 1;
              const url = `vscode://file${path}:${line}`;
              window.open(url);
            });
          });
        }

        // Info Button
        if (entry) {
          btnContainer.createDiv('clickable-icon', (div) => {
            setIcon(div, 'info');
            div.setAttr('aria-label', t('Show details'));
            div.onClickEvent((ev) => {
              ev.stopPropagation();
              showDetailedTooltip(entry, div);
            });
          });

          // Get Attachment Button
          const hasAttachment = allAttachmentLinks.length > 0;
          if (!hasAttachment) {
            btnContainer.createDiv('clickable-icon', (div) => {
              setIcon(div, 'download');
              div.setAttr('aria-label', t('Get attachment'));
              div.onClickEvent(async (ev) => {
                ev.stopPropagation();
                const view = this.plugin.view;
                if (view) {
                  await view.getAttachment(entry);
                }
              });
            });
          }
        }

        if (linkDest) {
          btnContainer.createDiv('clickable-icon', (div) => {
            setIcon(div, 'sticky-note');
            div.setAttr('aria-label', t('Open literature note'));
            div.onClickEvent((e) => {
              const newPane = Keymap.isModEvent(e);
              app.workspace.openLinkText(linkText, file.path, newPane);
            });
          });
        }

        if (zLink) {
          btnContainer.createDiv('clickable-icon', (div) => {
            setIcon(div, 'lucide-external-link');
            div.setAttr('aria-label', t('Open in Zotero'));
            div.onClickEvent(() => {
              activeWindow.open(zLink, '_blank');
            });
          });
        }

        if (allAttachmentLinks.length) {
          allAttachmentLinks.forEach((link) => {
            if (fs.existsSync(link)) {
              btnContainer.createDiv('clickable-icon', (div) => {
                const isPDF = link.toLowerCase().endsWith('.pdf');
                setIcon(div, isPDF ? 'lucide-file-text' : 'lucide-book-open');
                div.setAttr(
                  'aria-label',
                  t('Open attachment') + ': ' + (link.split(/[\\\/]/).pop() || (isPDF ? 'PDF' : 'EPUB'))
                );
                div.onClickEvent(async () => {
                  const vaultRoot = getVaultRoot();
                  let relativePath = '';
                  let isInsideVault = false;

                  if (link.startsWith(vaultRoot)) {
                    isInsideVault = true;
                    relativePath = link
                      .substring(vaultRoot.length)
                      .replace(/^[\\\/]/, '');
                  }

                  if (isInsideVault) {
                    const tfile = app.vault.getAbstractFileByPath(relativePath);
                    if (tfile instanceof TFile) {
                      const leaf = app.workspace.getRightLeaf(false);
                      await leaf.openFile(tfile);
                      
                      if (isPDF) {
                        // Attempt to enable annotation mode and show tools
                        setTimeout(() => {
                          const view = leaf.view as any;
                          if (view.type === 'pdf') {
                            if (view.viewer) {
                              if (view.viewer.then) {
                                view.viewer.then((v: any) => {
                                  if (v && v.setAnnotationMode) v.setAnnotationMode(true);
                                });
                              } else if (view.viewer.setAnnotationMode) {
                                view.viewer.setAnnotationMode(true);
                              }
                            }
                            
                            const toolbar = view.contentEl.querySelector('.pdf-toolbar');
                            if (toolbar) {
                              toolbar.style.display = 'flex';
                              const annotateBtn = toolbar.querySelector('.pdf-toolbar-button.annotate') as HTMLElement;
                              if (annotateBtn && !annotateBtn.hasClass('is-active')) {
                                annotateBtn.click();
                              }
                            }
                          }
                        }, 1000);
                      }

                      app.workspace.revealLeaf(leaf);
                      return;
                    }
                  }

                  // For external files, use virtual link (symlink) to open in Obsidian
                  await this.openExternalFileInternal(link);
                });
              });
            }
          });
        }
      }
    });

    return parsed;
  }

  async openExternalFileInternal(link: string) {
    const vaultRoot = getVaultRoot();
    const linksDirName = '.bib-links';
    const oldLinksDirName = '_bib-links';
    const linksDir = path.join(vaultRoot, linksDirName);
    const oldLinksDir = path.join(vaultRoot, oldLinksDirName);

    if (fs.existsSync(oldLinksDir) && !fs.existsSync(linksDir)) {
      try {
        fs.renameSync(oldLinksDir, linksDir);
      } catch (e) {
        console.error('Failed to rename old bib-links directory', e);
      }
    }

    if (!fs.existsSync(linksDir)) {
      fs.mkdirSync(linksDir, { recursive: true });
    }

    const hash = crypto.createHash('md5').update(link).digest('hex');
    const ext = path.extname(link);
    const fileName = `${path.parse(link).name}_${hash.slice(0, 8)}${ext}`;
    const linkPath = path.join(linksDir, fileName);

    if (!fs.existsSync(linkPath)) {
      try {
        fs.symlinkSync(link, linkPath, 'file');
      } catch (e) {
        if (e.code !== 'EEXIST') {
          console.error('Failed to create symlink', e);
          // Fallback to shell open if symlink fails
          require('electron').shell.openPath(link);
          return;
        }
      }
    }

    // Wait for Obsidian to see the file
    let tfile = app.vault.getAbstractFileByPath(`${linksDirName}/${fileName}`);
    let attempts = 0;
    while (!tfile && attempts < 30) {
      await new Promise((r) => setTimeout(r, 100));
      tfile = app.vault.getAbstractFileByPath(`${linksDirName}/${fileName}`);
      attempts++;
    }

    if (tfile instanceof TFile) {
      const leaf = app.workspace.getRightLeaf(false);
      await leaf.openFile(tfile);
      
      if (ext.toLowerCase() === '.pdf') {
        // Attempt to enable annotation mode and show tools
        setTimeout(() => {
          const view = leaf.view as any;
          if (view.type === 'pdf') {
            // 1. Try internal API
            if (view.viewer) {
              if (view.viewer.then) {
                view.viewer.then((v: any) => {
                  if (v && v.setAnnotationMode) v.setAnnotationMode(true);
                });
              } else if (view.viewer.setAnnotationMode) {
                view.viewer.setAnnotationMode(true);
              }
            }
            
            // 2. Force toolbar visibility via DOM
            const toolbar = view.contentEl.querySelector('.pdf-toolbar');
            if (toolbar) {
              toolbar.style.display = 'flex';
              const annotateBtn = toolbar.querySelector('.pdf-toolbar-button.annotate') as HTMLElement;
              if (annotateBtn && !annotateBtn.hasClass('is-active')) {
                annotateBtn.click();
              }
            }
          }
        }, 1000);
      }

      app.workspace.revealLeaf(leaf);
    } else {
      // If Obsidian still doesn't see it, try opening via shell
      require('electron').shell.openPath(link);
    }
  }

  parseBibFileField(fileField: string): string[] {
    if (!fileField) return [];
    const files = fileField.split(';');
    const paths: string[] = [];
    for (const f of files) {
      const parts = f.split(':');
      let p = parts.length >= 2 ? parts[1] : f;

      if (p) {
        p = p.trim();
        p = p.replace(/^[\{\"]|[\}\"]$/g, '');

        if (p) {
          if (path.isAbsolute(p)) {
            paths.push(p);
          } else {
            paths.push(path.join(getVaultRoot(), p));
          }
        }
      }
    }
    return paths.filter((p) => {
      const ext = p.toLowerCase();
      return ext.endsWith('.pdf') || ext.endsWith('.epub');
    });
  }

  dispatchResult(file: TFile, result: FileCache) {
    app.workspace.getLeavesOfType('markdown').forEach((l) => {
      const view = l.view as MarkdownView;
      if (view.file === file) {
        const renderer = (view.previewMode as any).renderer;
        if (renderer) {
          renderer.lastText = null;
          for (const section of renderer.sections) {
            if (
              !section.el.hasClass('mod-header') &&
              !section.el.hasClass('mod-footer')
            ) {
              section.rendered = false;
              section.el.empty();
            }
          }
          renderer.queueRender();
        }

        const cm = (view.editor as any).cm as EditorView;
        if (cm.dispatch) {
          cm.dispatch({
            effects: [setCiteKeyCache.of(result)],
          });
        }
      }
    });
  }

  getCacheForPath(filePath: string) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      return cache;
    }

    return null;
  }

  getResolution(filePath: string, key: string) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      return {
        isResolved: cache.resolvedKeys.has(key),
        isUnresolved: cache.unresolvedKeys.has(key),
      };
    }

    return {
      isResolved: false,
      isUnresolved: false,
    };
  }

  getCitationsForSection(filePath: string, lineStart: number, lineEnd: number) {
    const file = app.vault.getAbstractFileByPath(filePath);
    if (file && file instanceof TFile && this.fileCache.has(file)) {
      const cache = this.fileCache.get(file);
      const mCache = app.metadataCache.getCache(filePath);

      const section = mCache.sections?.find(
        (s) =>
          s.position.start.line === lineStart && s.position.end.line === lineEnd
      );

      if (!section) return [];

      const startOffset = section.position.start.offset;
      const endOffset = section.position.end.offset;

      const cites = cache.citations.filter(
        (c) => c.from >= startOffset && c.to <= endOffset
      );
      return cites;
    }

    return [];
  }

  async updateEntryFile(citekey: string, attachmentPath: string) {
    const entry = this.bibCache.get(citekey);
    if (!entry || !entry.sourceFile) {
      throw new Error('Entry not found or source file unknown.');
    }

    const bibPath = entry.sourceFile;
    let content = fs.readFileSync(bibPath, 'utf-8');
    
    const entryRegex = new RegExp(`(@\\w+\\s*\\{\\s*${citekey}\\s*,[\\s\\S]*?\\n\\})`, 'g');
    const match = entryRegex.exec(content);
    
    if (match) {
      let entryBlock = match[1];
      const fileFieldRegex = /file\s*=\s*[\{\"]([^\"\}]*)[\}\"]/i;
      
      if (fileFieldRegex.test(entryBlock)) {
        entryBlock = entryBlock.replace(fileFieldRegex, `file = {${attachmentPath}}`);
      } else {
        // Add new file field before the closing brace, ensuring exactly one comma
        let newBlock = entryBlock.trim().replace(/\}\s*$/, '').trim();
        // Remove any existing trailing commas (handles previous corruption)
        newBlock = newBlock.replace(/,+$/, '');
        // Add exactly one comma and the new field
        newBlock += `,\n  file = {${attachmentPath}}\n}`;
        entryBlock = newBlock;
      }
      
      content = content.replace(match[1], entryBlock);
      fs.writeFileSync(bibPath, content, 'utf-8');
    } else {
      throw new Error('Could not find entry block in bib file.');
    }
  }
}
