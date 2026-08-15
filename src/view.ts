import { ItemView, MarkdownView, WorkspaceLeaf, setIcon, Notice, TFile } from 'obsidian';

import { copyElToClipboard, debounce, debugLog, showDetailedTooltip, openPdfInPreview, openEpubInDefaultReader, getVaultRoot } from './helpers';
import { t } from './lang/helpers';
import ReferenceList from './main';
import { callDeepSeek } from './bib/aiHelper';
import { PartialCSLEntry } from './bib/types';
import { convertToMarkdown, getOutputMdPath, isConversionCompleted, isConversionInProgress, forceReconvert, ConvertProgress } from './converter';
import { findRagPositions, findLayoutBlocksByLines, readLiteratureLayout, ragDisplayName, firstMarkdownHeading, RagPosition } from './rag/retrieval';
import { rerankTexts, RERANK_OVERRIDE, resolveRerankSettings } from './rag/rerank';
import { parseQuery } from './rag/tokenizer';
import { LayoutBlock } from './rag/layout';
import { SemanticVectorHit } from './rag/vectorIndex';

const fs = require('fs');
const path = require('path');

export const viewType = 'ReferenceListView';

type SortField = 'year' | 'title' | 'author' | 'addDate' | 'id';
type SortDirection = 'asc' | 'desc';

/** UI state captured before an 'all'-mode re-render so it can be restored
 *  afterwards (keeps scroll position and collapsed/expanded file groups when
 *  clicking an entry opens a note → active-leaf-change → re-render). */
interface ListState {
  scrollTop: number;
  knownPaths: Set<string>;
  openPaths: Set<string>;
  query: string;
}

/** Match an entry against the query across bibliographic metadata fields. */
function matchesMeta(entry: PartialCSLEntry, q: string): boolean {
  if (entry.id && entry.id.toLowerCase().includes(q)) return true;
  if (entry.title && entry.title.toLowerCase().includes(q)) return true;
  if (entry.journal && entry.journal.toLowerCase().includes(q)) return true;
  if (entry.booktitle && entry.booktitle.toLowerCase().includes(q)) return true;
  if (entry.publisher && entry.publisher.toLowerCase().includes(q)) return true;
  if (entry.keywords && entry.keywords.toLowerCase().includes(q)) return true;
  if (entry.doi && entry.doi.toLowerCase().includes(q)) return true;
  if (entry.url && entry.url.toLowerCase().includes(q)) return true;
  if (entry.year && String(entry.year).toLowerCase().includes(q)) return true;
  if (entry.type && entry.type.toLowerCase().includes(q)) return true;
  if (entry.author && entry.author.some((a) =>
    (a.family || '').toLowerCase().includes(q) ||
    (a.given || '').toLowerCase().includes(q)
  )) return true;
  return false;
}

export class ReferenceListView extends ItemView {
  plugin: ReferenceList;
  activeMarkdownLeaf: MarkdownView;
  mode: 'current' | 'all' = 'current';
  searchQuery = '';
  isRecentOnly = false;
  showAddSection = false;
  isProcessing = false;
  pendingEntries: PartialCSLEntry[] = [];
  selectedEntries: Set<number> = new Set();
  
  displayedCount = 50;
  allEntries: PartialCSLEntry[] = [];
  filteredEntries: PartialCSLEntry[] = [];

  sortField: SortField = 'year';
  sortDirection: SortDirection = 'desc';

  conversionProgress: Map<string, ConvertProgress> = new Map();

  /** Which search-result groups are currently toggled on (visible). */
  private ragGroupVisibility: Set<string> = new Set(['meta', 'rerank', 'fulltext', 'semantic']);
  private ragNavButtons: Map<string, HTMLElement> | null = null;

  /** Monotonic render generation. Each renderAllReferencesList() call bumps it;
   *  stale async render continuations check it and bail out before touching the
   *  DOM, so overlapping renders can't clobber each other (panel flashing). */
  private renderSeq = 0;
  private _pendingListState: ListState | null = null;
  private _skipStateCapture = false;

  /** path -> first markdown heading, filled in as documents are read for search
   *  results so the result header can show it without re-reading files. */
  private headingCache = new Map<string, string>();

  private debouncedRender = debounce(() => {
    this.displayedCount = 50;
    this.syncHeaderToMode();
    this.renderAllReferencesList();
  }, 300);

  constructor(leaf: WorkspaceLeaf, plugin: ReferenceList) {
    super(leaf);
    this.plugin = plugin;

    this.contentEl.addClass('pwc-reference-list');
    this.contentEl.toggleClass(
      'collapsed-links',
      !!this.plugin.settings.hideLinks
    );
    this.setViewContent(null);
  }

  setViewContent(bib: HTMLElement) {
    debugLog('View', 'setViewContent started', {
      hasBib: !!bib,
      mode: this.mode,
    });

    if (this.mode === 'current') {
      let container = this.contentEl.querySelector(
        '.pwc-view-content'
      ) as HTMLElement;
      if (!container) {
        this.contentEl.empty();
        this.renderHeader();
        container = this.contentEl.createDiv({ cls: 'pwc-view-content' });
      }

      if (bib) {
        if (container.innerHTML !== bib.innerHTML) {
          container.empty();
          container.append(bib);
          if (this.searchQuery) {
            this.filterCurrentReferences();
          }
        }
      } else {
        container.empty();
        container.createDiv({
          cls: 'pane-empty',
          text: t('No citations found in the current document.'),
        });
      }
    } else {
      // For 'all' mode, we still do a full refresh for now as it's less frequent
      this._pendingListState = this._skipStateCapture ? null : this.captureListState();
      this._skipStateCapture = false;
      this.contentEl.empty();
      this.renderHeader();
      const container = this.contentEl.createDiv({ cls: 'pwc-view-content' });
      this.renderAllReferencesList(container);
    }
  }

  renderHeader() {
    const header = this.contentEl.createDiv({ cls: 'pwc-reference-list__header' });
    
    const titleContainer = header.createDiv({ cls: 'pwc-reference-list__title' });
    titleContainer.createDiv({ text: this.mode === 'current' ? t('Current References') : t('All References') });
    
    const actionsContainer = titleContainer.createDiv({ cls: 'pwc-reference-list__actions' });
    
    // Toggle Mode Button
    actionsContainer.createDiv({
      cls: `clickable-icon pwc-mode-toggle ${this.mode === 'all' ? 'is-active' : ''}`,
      attr: { 'aria-label': this.mode === 'current' ? t('Show All References') : t('Show Current References') }
    }, (btn) => {
      setIcon(btn, this.mode === 'current' ? 'library' : 'file-text');
      btn.onClickEvent(() => {
        this.mode = this.mode === 'current' ? 'all' : 'current';
        this.searchQuery = '';
        this.displayedCount = 50;
        this.showAddSection = false;
        this.pendingEntries = [];
        
        // Update button state and title immediately
        btn.toggleClass('is-active', this.mode === 'all');
        btn.setAttr('aria-label', this.mode === 'current' ? t('Show All References') : t('Show Current References'));
        setIcon(btn, this.mode === 'current' ? 'library' : 'file-text');
        titleContainer.firstChild.textContent = this.mode === 'current' ? t('Current References') : t('All References');

        if (this.mode === 'all') {
          this.renderAllReferences();
        } else {
          this.plugin.processReferences();
        }
      });
    });

    // Sort by Date Button
    actionsContainer.createDiv({
      cls: 'clickable-icon',
      attr: { 'aria-label': t('Show recently added') }
    }, (btn) => {
      setIcon(btn, 'history');
      btn.toggleClass('is-active', this.isRecentOnly);
      btn.onClickEvent(() => {
        this.isRecentOnly = !this.isRecentOnly;
        this.mode = 'all'; 
        this.setViewContent(null);
      });
    });

    // Add Reference Button
    actionsContainer.createDiv({
      cls: 'clickable-icon',
      attr: { 'aria-label': t('Add Reference') }
    }, (btn) => {
      setIcon(btn, 'plus');
      btn.onClickEvent(() => {
        this.showAddSection = !this.showAddSection;
        this.mode = 'all';
        this.pendingEntries = [];
        this.setViewContent(null);
      });
    });

    // Refresh Button
    actionsContainer.createDiv({
      cls: 'clickable-icon',
      attr: { 'aria-label': t('Refresh bibliography') }
    }, (btn) => {
      setIcon(btn, 'refresh-cw');
      btn.onClickEvent(async () => {
        new Notice(t('Refreshing bibliography...'));
        await this.plugin.bibManager.reinit(true);
        if (this.mode === 'all') {
          this.renderAllReferences();
        } else {
          this.plugin.processReferences();
        }
      });
    });

    const activeFile = this.plugin.app.workspace.getActiveFile() || this.plugin.lastActiveFile;
    const count = this.mode === 'current'
      ? (activeFile ? this.plugin.bibManager.fileCache.get(activeFile)?.keys.size || 0 : 0)
      : this.plugin.bibManager.bibCache.size;

    if (count > 0) {
      actionsContainer.createDiv({
        cls: 'pwc-reference-list__count',
        text: count.toString(),
      });
    }

    if (this.mode === 'current') {
      actionsContainer.createDiv({
        cls: 'clickable-icon',
        attr: { 'aria-label': t('Copy list') },
      }, (btn) => {
        setIcon(btn, 'lucide-copy');
        const bib = this.contentEl.querySelector('.csl-bib-body') as HTMLElement;
        if (bib) copyElToClipboard(bib);
      });
    }

    const searchContainer = header.createDiv({ cls: 'pwc-manager-search' });

    const searchInput = searchContainer.createEl('input', {
      attr: { type: 'text', placeholder: t('Search references...'), value: this.searchQuery }
    });
    
    if (this.searchQuery) {
      const clearBtn = searchContainer.createDiv({ cls: 'pwc-search-clear' });
      setIcon(clearBtn, 'x');
      clearBtn.onClickEvent(() => {
        this.searchQuery = '';
        if (this.mode === 'all') {
          this.debouncedRender();
        } else {
          this.filterCurrentReferences();
        }
      });
    }

    searchInput.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.mode = 'all';
      this.debouncedRender();
    });

  }

  /** Keep the header title in sync with the mode without a full re-render. */
  private syncHeaderToMode() {
    const header = this.contentEl.querySelector(
      '.pwc-reference-list__header'
    ) as HTMLElement | null;
    if (!header) return;
    const titleEl = header.querySelector('.pwc-reference-list__title')?.firstChild as HTMLElement | null;
    if (titleEl) {
      titleEl.textContent = this.mode === 'current' ? t('Current References') : t('All References');
    }
  }

  filterCurrentReferences() {
    const container = this.contentEl.querySelector('.pwc-view-content') as HTMLElement;
    if (!container) return;

    const entries = container.querySelectorAll('.csl-entry-wrapper');
    entries.forEach((entry: HTMLElement) => {
      const text = entry.innerText.toLowerCase();
      if (text.includes(this.searchQuery)) {
        entry.style.display = '';
      } else {
        entry.style.display = 'none';
      }
    });
  }

  async renderRagResults(container: HTMLElement, seq?: number) {
    const query = this.searchQuery.trim();
    if (!query) return;
    if (seq !== undefined && seq !== this.renderSeq) return;

    if (!this.plugin.settings.enableRagSearch) {
      container.createDiv({ cls: 'pane-empty', text: t('RAG search is disabled') });
      return;
    }

    const rag = this.plugin.ragIndexer;
    if (rag.index.docCount === 0) {
      container.createDiv({ cls: 'pane-empty', text: t('RAG index is being built...') });
      return;
    }

    // Render the full-text and semantic groups immediately so the user sees
    // results the moment they type. The cross-encoder rerank ("重排序命中")
    // is slower (it re-reads candidates then calls the rerank service), so it
    // is kicked off in the background and inserted only when ready — the panel
    // must never sit blank waiting for the rerank network round-trip.
    await this.renderFulltextResults(container, seq);
    if (seq !== undefined && seq !== this.renderSeq) return;
    if (this.plugin.settings.enableNativeSemantic) {
      await this.renderNativeSemanticResults(container, query, seq);
    }
    if (seq !== undefined && seq !== this.renderSeq) return;

    if (RERANK_OVERRIDE.enabled) {
      this.renderRerankedResults(container, seq)
        .then((ok) => {
          if (ok && seq === this.renderSeq) this.updateGroupNav();
        })
        .catch(() => {});
    }
  }

  /** Render the "正文命中" (full-text BM25) group. */
  async renderFulltextResults(container: HTMLElement, seq?: number) {
    const query = this.searchQuery.trim();
    if (!query) return;
    if (seq !== undefined && seq !== this.renderSeq) return;

    const rag = this.plugin.ragIndexer;
    if (rag.index.docCount === 0) return;

    const hits = await rag.search(query, 60, this.plugin.settings.ragMinTermCoverage ?? 1);

    const group = container.createDiv({ cls: 'pwc-rag-group' });
    group.setAttr('data-rag-group', 'fulltext');
    if (hits.length === 0) {
      group.createDiv({ cls: 'pwc-rag-group-title', text: t('Full-text hits') });
      group.createDiv({ cls: 'pane-empty', text: t('No results found in vault.') });
      return;
    }

    const vaultRoot = getVaultRoot();
    const outputPath = this.plugin.settings.convertOutputPath || 'literature';
    const snippetLen = this.plugin.settings.ragSnippetLength || 180;

    interface DocHits {
      doc: any;
      layout: LayoutBlock[] | null;
      positions: RagPosition[];
      terms: string[];
    }
    const results: DocHits[] = [];
    for (const hit of hits.slice(0, 30)) {
      const doc = hit.doc;
      let content = '';
      try {
        content = await this.readVaultText(doc.path);
      } catch {
        continue;
      }
      if (seq !== undefined && seq !== this.renderSeq) return;
      if (!content) continue;

      const layout =
        doc.literature && doc.citekey
          ? readLiteratureLayout(vaultRoot, outputPath, doc.citekey)
          : null;
      const positions = findRagPositions(content, hit.terms, layout, snippetLen);
      if (positions.length === 0) continue;
      results.push({ doc, layout, positions, terms: hit.terms });
    }

    if (results.length === 0) {
      group.createDiv({ cls: 'pane-empty', text: t('No results found in vault.') });
      return;
    }

    const totalHits = results.reduce((n, r) => n + r.positions.length, 0);
    group.createDiv({
      cls: 'pwc-rag-group-title',
      text: `${t('Full-text hits')} · 共 ${totalHits} 处（${results.length} 篇）`,
    });
    const resultContainer = group.createDiv({ cls: 'pwc-rag-files' });

    for (const { doc, layout, positions, terms } of results) {
      const entries = positions.map((p) => ({
        line: p.line,
        snippet: p.snippet,
        page: p.page,
        bbox: p.bbox,
      }));
      this.renderRagDocGroup(resultContainer, {
        title: doc.title || doc.path,
        path: doc.path,
        citekey: doc.literature ? doc.citekey : undefined,
        layout,
        hint: doc.literature,
      }, entries, terms);
    }
  }

  /** Terms used to locate positions / snippets: latin words + full CJK runs. */
  private queryTerms(query: string): string[] {
    const { latin, cjkRuns } = parseQuery(query);
    return [...latin, ...cjkRuns];
  }

  /**
   * Merged cross-encoder rerank of full-text + semantic candidates against the
   * Aliyun DashScope qwen3-rerank service (hardcoded). Runs in the background
   * after the plain full-text / semantic groups have been shown, and returns
   * true only when the "重排序命中" group was rendered (the caller then reveals
   * its nav icon); returns false on any failure so it simply stays hidden.
   */
  private async renderRerankedResults(
    container: HTMLElement,
    seq?: number
  ): Promise<boolean> {
    const settings = this.plugin.settings;
    const query = this.searchQuery.trim();
    if (!query) return false;
    if (seq !== undefined && seq !== this.renderSeq) return false;

    const rag = this.plugin.ragIndexer;
    if (!rag || rag.index.docCount === 0) return false;

    const terms = this.queryTerms(query);
    const vaultRoot = getVaultRoot();
    const outputPath = settings.convertOutputPath || 'literature';
    const snippetLen = settings.ragSnippetLength || 180;
    const candidateCount = settings.rerankCandidateCount || 30;

    interface Candidate {
      path: string;
      title: string;
      citekey?: string;
      literature: boolean;
      line: number;
      snippet: string;
      page?: number;
      bbox?: number[] | null;
    }

    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    const addCandidate = (c: Candidate) => {
      const key = `${c.path}|${c.line}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(c);
    };

    // Full-text (BM25) candidates: best matching position per document.
    const ftHits = await rag.search(
      query,
      candidateCount,
      settings.ragMinTermCoverage ?? 1
    );
    for (const hit of ftHits) {
      let content = '';
      try {
        content = await this.readVaultText(hit.doc.path);
      } catch {
        continue;
      }
      if (seq !== undefined && seq !== this.renderSeq) return false;
      if (!content) continue;
      const layout =
        hit.doc.literature && hit.doc.citekey
          ? readLiteratureLayout(vaultRoot, outputPath, hit.doc.citekey)
          : null;
      const positions = findRagPositions(content, terms, layout, snippetLen);
      if (positions.length === 0) continue;
      const p = positions[0];
      addCandidate({
        path: hit.doc.path,
        title: hit.doc.title || hit.doc.path,
        citekey: hit.doc.literature ? hit.doc.citekey : undefined,
        literature: hit.doc.literature,
        line: p.line,
        snippet: p.snippet,
        page: p.page,
        bbox: p.bbox,
      });
    }

    // Semantic (vector) candidates.
    const idx = this.plugin.semanticIndexer;
    if (idx?.enabled && idx.index.chunkCount > 0) {
      let vecHits: SemanticVectorHit[] = [];
      try {
        vecHits = await idx.search(
          query,
          settings.semanticTopK || 20,
          settings.semanticMinScore ?? 0
        );
      } catch (e: any) {
        debugLog('View', 'Semantic search failed during rerank', { error: e.message });
      }
      if (seq !== undefined && seq !== this.renderSeq) return false;
      for (const h of vecHits) {
        let content = '';
        try {
          content = await this.readVaultText(h.path);
        } catch {
          continue;
        }
        if (seq !== undefined && seq !== this.renderSeq) return false;
        if (!content) continue;
        const lines = content.split('\n');
        const start = Math.max(0, h.startLine - 1);
        const end = Math.min(lines.length, h.endLine);
        const snippet = lines.slice(start, end).join('\n').trim() || '...';
        let page: number | undefined;
        let bbox: number[] | null = null;
        if (h.citekey) {
          const layout = readLiteratureLayout(vaultRoot, outputPath, h.citekey);
          if (layout) {
            const blocks = findLayoutBlocksByLines(layout, h.startLine, h.endLine);
            if (blocks.length > 0) {
              page = blocks[0].page;
              bbox = blocks[0].bbox;
            }
          }
        }
        addCandidate({
          path: h.path,
          title: h.title || h.path,
          citekey: h.citekey,
          literature: h.literature,
          line: h.startLine,
          snippet,
          page,
          bbox,
        });
      }
    }

    if (candidates.length === 0) return false;

    // Rerank the candidate snippets.
    let reranked: { c: Candidate; score: number }[];
    try {
      const results = await rerankTexts(
        query,
        candidates.map((c) => c.snippet),
        resolveRerankSettings({
          apiKey: settings.rerankApiKey || '',
        })
      );
      reranked = results
        .filter((r) => r.index >= 0 && r.index < candidates.length)
        .map((r) => ({ c: candidates[r.index], score: r.score }));
    } catch (e: any) {
      debugLog('View', 'Rerank failed, falling back to plain groups', { error: e.message });
      return false;
    }
    if (seq !== undefined && seq !== this.renderSeq) return false;
    if (reranked.length === 0) return false;

    // Render one merged group, ordered by rerank score, grouped by document.
    const group = container.createDiv({ cls: 'pwc-rag-group' });
    group.setAttr('data-rag-group', 'rerank');
    group.createDiv({
      cls: 'pwc-rag-group-title',
      text: `重排序命中 · 共 ${reranked.length} 处`,
    });
    const resultContainer = group.createDiv({ cls: 'pwc-rag-files' });

    const byDoc = new Map<string, typeof reranked>();
    for (const r of reranked) {
      const list = byDoc.get(r.c.path) || [];
      list.push(r);
      byDoc.set(r.c.path, list);
    }

    for (const [docPath, list] of byDoc) {
      const first = list[0].c;
      const layout = first.citekey
        ? readLiteratureLayout(vaultRoot, outputPath, first.citekey)
        : null;
      const entries = list.map((r) => ({
        line: r.c.line,
        snippet: r.c.snippet,
        page: r.c.page,
        bbox: r.c.bbox,
        similarity: r.score,
      }));
      if (entries.length === 0) continue;
      this.renderRagDocGroup(
        resultContainer,
        {
          title: first.title || docPath,
          path: docPath,
          citekey: first.citekey,
          layout,
          hint: first.literature,
        },
        entries,
        terms
      );
    }

    // The plain groups were already rendered before rerank was kicked off, so
    // move this completed group above them to keep the highest-confidence
    // results at the top of the list.
    const anchor =
      container.querySelector('[data-rag-group="fulltext"]') ||
      container.querySelector('[data-rag-group="semantic"]');
    if (anchor) container.insertBefore(group, anchor);

    return true;
  }

  /**
   * Render one collapsible document group (native <details>/<summary>) with a
   * match entry per hit: snippet + "locate in MD" + optional "locate in PDF".
   */
  renderRagDocGroup(
    parent: HTMLElement,
    doc: { title: string; path: string; citekey?: string; layout: LayoutBlock[] | null; hint?: boolean },
    entries: { line: number; snippet: string; page?: number; bbox?: number[] | null; similarity?: number }[],
    terms: string[]
  ) {
    const details = parent.createEl('details', { cls: 'pwc-rag-file' });
    details.setAttr('data-path', doc.path);
    details.setAttr('open', '');

    const summary = details.createEl('summary', { cls: 'pwc-rag-file-header' });
    const icon = summary.createDiv({ cls: 'pwc-rag-file-icon' });
    setIcon(icon, 'chevron-down');
    // Always identify the hit by its file name. doc.title is sniffed from the
    // document body by the indexer and is frequently meaningless for converted
    // literature (empty heading, leading image, "元数据", a running head, ...).
    const nameEl = summary.createDiv({ cls: 'pwc-rag-file-name' });
    nameEl.createSpan({
      cls: 'pwc-rag-file-basename',
      text: ragDisplayName(doc.path) || doc.title,
    });
    // Secondary label: the document's own first heading, which names the actual
    // paper/chapter where the file name is only a citekey.
    const heading = this.headingCache.get(doc.path);
    if (heading) {
      nameEl.createSpan({ cls: 'pwc-rag-file-heading', text: heading });
    }
    const count = summary.createDiv({ cls: 'pwc-rag-file-count', text: String(entries.length) });
    count.setAttr('aria-label', `${entries.length} 处命中`);

    const matches = details.createDiv({ cls: 'pwc-rag-file-matches' });

    for (const entry of entries) {
      const match = matches.createDiv({ cls: 'pwc-rag-match' });
      const textEl = match.createDiv({ cls: 'pwc-rag-match-text' });
      this.appendHighlighted(textEl, entry.snippet, terms);

      const actions = match.createDiv({ cls: 'pwc-rag-card-actions' });
      if (entry.similarity !== undefined) {
        const sim = Math.round(entry.similarity * 100);
        const simEl = actions.createDiv({ cls: 'pwc-rag-match-sim' });
        simEl.setText(`${sim}%`);
        simEl.setAttr('aria-label', `相似度 ${sim}%`);
      }
      this.addIconAction(actions, 'file-text', `在 MD 中定位 第${entry.line}行`, () => {
        this.openNoteAtLine(doc.path, entry.line);
      });
      if (doc.citekey && entry.page) {
        this.addIconAction(actions, 'crosshair', `在 PDF 中定位 第${entry.page}页`, () => {
          this.locateLiteraturePdf(doc.citekey!, { page: entry.page!, bbox: entry.bbox ?? null });
        });
      }
    }

    if (doc.hint && doc.citekey && doc.layout === null) {
      matches.createDiv({ cls: 'pwc-rag-hint', text: t('Reconvert to enable precise positioning') });
    }
  }

  /** Render the native vector-search "语义命中" group. */
  async renderNativeSemanticResults(
    container: HTMLElement,
    query: string,
    seq?: number
  ) {
    const idx = this.plugin.semanticIndexer;
    if (!idx || !idx.enabled || idx.index.chunkCount === 0) return;
    if (seq !== undefined && seq !== this.renderSeq) return;

    let vecHits: SemanticVectorHit[];
    try {
      vecHits = await idx.search(
        query,
        this.plugin.settings.semanticTopK || 20,
        this.plugin.settings.semanticMinScore ?? 0
      );
    } catch (e: any) {
      debugLog('View', 'Semantic search failed', { error: e.message });
      return;
    }
    if (seq !== undefined && seq !== this.renderSeq) return;
    if (vecHits.length === 0) return;

    const vaultRoot = getVaultRoot();
    const outputPath = this.plugin.settings.convertOutputPath || 'literature';
    const snippetLen = this.plugin.settings.ragSnippetLength || 180;

    const group = container.createDiv({ cls: 'pwc-rag-group' });
    group.setAttr('data-rag-group', 'semantic');
    group.createDiv({ cls: 'pwc-rag-group-title', text: `语义命中 · ${vecHits.length} 处` });
    const resultContainer = group.createDiv({ cls: 'pwc-rag-files' });

    // Group hits by document, keeping per-doc order.
    const byDoc = new Map<string, SemanticVectorHit[]>();
    for (const h of vecHits) {
      const list = byDoc.get(h.path) || [];
      list.push(h);
      byDoc.set(h.path, list);
    }

    for (const [docPath, hits] of byDoc) {
      let content = '';
      try {
        content = await this.readVaultText(docPath);
      } catch {
        continue;
      }
      if (seq !== undefined && seq !== this.renderSeq) return;
      if (!content) continue;
      const lines = content.split('\n');
      const first = hits[0];
      const layout = first.citekey
        ? readLiteratureLayout(vaultRoot, outputPath, first.citekey)
        : null;

      const entries = hits
        .map((h) => {
          const start = Math.max(0, h.startLine - 1);
          const end = Math.min(lines.length, h.endLine);
          const snippet = lines.slice(start, end).join('\n').trim() || '...';
          let page: number | undefined;
          let bbox: number[] | null = null;
          if (layout) {
            const blocks = findLayoutBlocksByLines(layout, h.startLine, h.endLine);
            if (blocks.length > 0) {
              page = blocks[0].page;
              bbox = blocks[0].bbox;
            }
          }
          return {
            line: h.startLine,
            snippet: snippet.length > snippetLen ? snippet.slice(0, snippetLen) + '…' : snippet,
            page,
            bbox,
            similarity: h.similarity,
          };
        })
        .filter((e) => e.snippet && e.snippet !== '...');

      this.renderRagDocGroup(resultContainer, {
        title: first.title || docPath,
        path: docPath,
        citekey: first.citekey,
        layout,
        hint: first.literature,
      }, entries, query.trim().split(/\s+/).filter(Boolean));
    }
  }

  addIconAction(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
    const btn = parent.createDiv({ cls: 'clickable-icon pwc-rag-icon' }, (div) => {
      setIcon(div, icon);
    });
    btn.setAttr('aria-label', label);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /** Snapshot scroll + collapse state so it can be restored after a re-render
   *  (e.g. clicking an entry opens a note → active-leaf-change → re-render). */
  private captureListState(): ListState {
    const scrollEl = this.contentEl.querySelector('.pwc-view-content');
    const knownPaths = new Set<string>();
    const openPaths = new Set<string>();
    this.contentEl.querySelectorAll('details.pwc-rag-file').forEach((d) => {
      const path = (d as HTMLElement).getAttribute('data-path');
      if (!path) return;
      knownPaths.add(path);
      if ((d as HTMLDetailsElement).open) openPaths.add(path);
    });
    return {
      scrollTop: scrollEl ? (scrollEl as HTMLElement).scrollTop : 0,
      knownPaths,
      openPaths,
      query: this.searchQuery,
    };
  }

  /** Restore collapse state, and scroll position when the query didn't change
   *  (so revealEntry's own scrollIntoView isn't overridden). */
  private restoreListState(state: ListState) {
    if (!state) return;
    this.contentEl.querySelectorAll('details.pwc-rag-file').forEach((d) => {
      const path = (d as HTMLElement).getAttribute('data-path');
      if (!path) return;
      if (state.openPaths.has(path)) {
        (d as HTMLDetailsElement).setAttribute('open', '');
      } else if (state.knownPaths.has(path)) {
        (d as HTMLDetailsElement).removeAttribute('open');
      }
    });
    if (state.query === this.searchQuery) {
      const scrollEl = this.contentEl.querySelector('.pwc-view-content');
      if (scrollEl) {
        (scrollEl as HTMLElement).scrollTop = state.scrollTop;
      }
    }
  }

  /** Sticky quick-jump nav for the 文献条目 / 重排序命中 / 正文命中 / 语义命中
   *  groups: a back-to-top icon button plus one checkbox-style icon toggle per
   *  group. All toggles start on; clicking one hides/shows that group's results. */
  private renderGroupNav(container: HTMLElement) {
    const nav = container.createDiv({ cls: 'pwc-rag-nav' });
    this.ragNavButtons = new Map<string, HTMLElement>();

    const topBtn = nav.createEl('button', {
      cls: 'clickable-icon pwc-rag-nav-top',
      attr: { 'aria-label': t('Back to top') },
    });
    setIcon(topBtn, 'arrow-up');
    topBtn.addEventListener('click', () => this.jumpToGroup('top'));

    const groups = [
      { key: 'meta', label: t('Reference entries'), icon: 'lucide-book-open' },
      { key: 'rerank', label: '重排序命中', icon: 'lucide-list-restart' },
      { key: 'fulltext', label: t('Full-text hits'), icon: 'lucide-file-text' },
      { key: 'semantic', label: '语义命中', icon: 'lucide-sparkles' },
    ];
    for (const g of groups) {
      const visible = this.ragGroupVisibility.has(g.key);
      const btn = nav.createEl('button', {
        cls: 'clickable-icon pwc-rag-nav-toggle',
        attr: {
          'aria-label': g.label,
          'aria-pressed': visible ? 'true' : 'false',
          'data-group': g.key,
        },
      });
      setIcon(btn, g.icon);
      btn.toggleClass('is-active', visible);
      btn.addEventListener('click', () => this.toggleRagGroup(g.key, btn));
      this.ragNavButtons.set(g.key, btn);
    }
  }

  /** Toggle a group's visibility on/off (checkbox-style icon button). */
  private toggleRagGroup(key: string, btn: HTMLElement) {
    if (this.ragGroupVisibility.has(key)) {
      this.ragGroupVisibility.delete(key);
    } else {
      this.ragGroupVisibility.add(key);
    }
    const visible = this.ragGroupVisibility.has(key);
    btn.toggleClass('is-active', visible);
    btn.setAttr('aria-pressed', visible ? 'true' : 'false');
    this.applyGroupVisibility();
  }

  /** Show/hide each rendered result group according to the toggle state. */
  private applyGroupVisibility() {
    if (!this.ragNavButtons) return;
    this.ragNavButtons.forEach((_btn, key) => {
      const group = this.contentEl.querySelector(`[data-rag-group="${key}"]`) as HTMLElement | null;
      if (!group) return;
      group.style.display = this.ragGroupVisibility.has(key) ? '' : 'none';
    });
  }

  /** Hide nav buttons whose group did not render any results. */
  private updateGroupNav() {
    if (!this.ragNavButtons) return;
    this.ragNavButtons.forEach((btn, key) => {
      const group = this.contentEl.querySelector(`[data-rag-group="${key}"]`);
      const isEmpty = !group || !!group.querySelector('.pane-empty');
      btn.toggleClass('is-hidden', isEmpty);
    });
    this.applyGroupVisibility();
  }

  private jumpToGroup(key: string) {
    if (key === 'top') {
      const scrollEl = this.contentEl.querySelector('.pwc-view-content');
      if (scrollEl) {
        (scrollEl as HTMLElement).scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }

  /** Render bibliography entries (bib/Zotero metadata) matching the query.
   *  Uses the same standard CSL format (title / authors / action buttons) as
   *  the full reference list, so no extra "locate" step is needed. */
  async renderMetaHits(container: HTMLElement, query: string, seq?: number) {
    const q = query.trim().toLowerCase();
    if (!q) return;
    if (seq !== undefined && seq !== this.renderSeq) return;
    const matches = Array.from(this.plugin.bibManager.bibCache.values()).filter((entry) =>
      matchesMeta(entry, q)
    );
    if (matches.length === 0) return;

    const group = container.createDiv({ cls: 'pwc-rag-group' });
    group.setAttr('data-rag-group', 'meta');
    group.createDiv({ cls: 'pwc-rag-group-title', text: t('Reference entries') });
    await this.renderCslEntries(group, matches.slice(0, 20).map((e) => e.id), seq);
  }

  /**
   * Render a set of bibliography entries in the standard CSL format (shared by
   * both the full reference list and the "文献命中" search group). Attaches the
   * usual action buttons (copy citekey, edit, details, CNKI/Scholar, URL,
   * Zotero, attachments, convert, …) to each entry.
   */
  private async renderCslEntries(container: HTMLElement, ids: string[], seq?: number): Promise<void> {
    if (!this.plugin.bibManager.engine) return;
    if (ids.length === 0) {
      container.createDiv({ text: t('No entries to display.'), cls: 'pane-empty' });
      return;
    }

    try {
      if (this.plugin.settings.pullFromZotero) {
        await this.plugin.bibManager.getZLinksForKeys(new Set(ids));
      }
      if (seq !== undefined && seq !== this.renderSeq) return;

      let bib;
      try {
        this.plugin.bibManager.engine.updateItems(ids);
        bib = this.plugin.bibManager.engine.makeBibliography();
      } catch (err) {
        console.error('Initial makeBibliography failed', err);
        bib = false;
      }

      if (!bib || bib.length < 2) {
        const entries: string[] = [];
        const entry_ids: string[][] = [];
        for (const id of ids) {
          try {
            this.plugin.bibManager.engine.updateItems([id]);
            const res = this.plugin.bibManager.engine.makeBibliography();
            if (res && res.length >= 2 && res[1].length > 0) {
              entries.push(res[1][0]);
              entry_ids.push(res[0].entry_ids[0]);
            }
          } catch (e) {
            console.warn(`Failed to render item ${id}:`, e);
          }
        }
        if (entries.length > 0) {
          bib = [{
            bibstart: '<div class="csl-bib-body">',
            bibend: '</div>',
            entry_ids: entry_ids,
          }, entries];
        }
      }

      if (!bib || bib.length < 2) {
        container.createDiv({ text: t('No entries to display.'), cls: 'pane-empty' });
        return;
      }

      const metadata = bib[0];
      const bibEntries = bib[1];
      const htmlStr = [metadata.bibstart];
      bibEntries.forEach((entry: string, i: number) => {
        const id = metadata.entry_ids[i][0];
        const injected = entry.replace(/<([a-z0-9]+)/i, `<$1 data-citekey="${id}"`);
        htmlStr.push(injected);
      });
      htmlStr.push(metadata.bibend);

      const parsed = new DOMParser().parseFromString(htmlStr.join(''), 'text/html').body.firstElementChild as HTMLElement;

      if (seq !== undefined && seq !== this.renderSeq) return;

      if (parsed) {
        parsed.findAll('.csl-entry').forEach((e, i) => {
          const id = e.dataset.citekey || metadata.entry_ids[i][0];
          const entry = this.plugin.bibManager.bibCache.get(id);

          const wrapper = createDiv({ cls: 'csl-entry-wrapper' });
          e.parentElement.insertBefore(wrapper, e);
          wrapper.append(e);

          const target = e.querySelector('.csl-right-inline') || e;
          const btnContainer = target.createSpan({ cls: 'pwc-entry-btns' });

          if (entry) {
            const zAttachmentLinks = this.plugin.bibManager.zCitekeyToAttachmentLinks.get(id) || [];
            const localAttachmentLinks = this.plugin.bibManager.parseBibFileField(entry.file);
            const paths = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];

            // Copy Citekey Button
            btnContainer.createDiv('clickable-icon', (div) => {
              setIcon(div, 'copy');
              div.setAttr('aria-label', t('Copy citekey'));
              div.onClickEvent(async () => {
                await navigator.clipboard.writeText(`[@${id}]`);
                new Notice(t('Citekey copied to clipboard'));
              });
            });

            // Edit Button
            if (entry.sourceFile) {
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
            btnContainer.createDiv('clickable-icon', (div) => {
              setIcon(div, 'info');
              div.setAttr('aria-label', t('Show details'));
              div.onClickEvent((ev) => {
                ev.stopPropagation();
                showDetailedTooltip(entry, div);
              });
            });

            // Search on CNKI
            btnContainer.createDiv('clickable-icon', (div) => {
              setIcon(div, 'search');
              div.setAttr('aria-label', t('Search on CNKI'));
              div.onClickEvent((ev) => {
                ev.stopPropagation();
                const entryTitle = entry.title || entry.id;
                const url = `https://kns.cnki.net/kns8s/defaultresult/index?crossids=YSTT4HG0%2CLSTPFY1C%2CJUP3MUPD%2CMPMFIG1A%2CWQ0UVIAA%2CBLZOG7CK%2CPWFIRAGL%2CEMRPGLPA%2CNLBO1Z6R%2CNN3FJMUV&korder=TI&kw=${encodeURIComponent(entryTitle)}`;
                window.open(url, '_blank');
              });
            });

            // Search on Google Scholar
            btnContainer.createDiv('clickable-icon', (div) => {
              setIcon(div, 'graduation-cap');
              div.setAttr('aria-label', t('Search on Google Scholar'));
              div.onClickEvent((ev) => {
                ev.stopPropagation();
                const entryTitle = entry.title || entry.id;
                const url = `https://scholar.google.com/scholar?q=${encodeURIComponent(entryTitle)}`;
                window.open(url, '_blank');
              });
            });

            // Open URL Button
            if (entry.url) {
              btnContainer.createDiv('clickable-icon', (div) => {
                setIcon(div, 'link');
                div.setAttr('aria-label', t('Open URL'));
                div.onClickEvent(async (ev) => {
                  ev.stopPropagation();
                  const leaf = this.plugin.app.workspace.getRightLeaf(false);
                  if (leaf && typeof (leaf as any).openUrl === 'function') {
                    await (leaf as any).openUrl(entry.url);
                    this.plugin.app.workspace.revealLeaf(leaf);
                  } else {
                    window.open(entry.url, '_blank');
                  }
                });
              });
            }

            // Open in Zotero (for Zotero entries)
            if (entry.groupID !== undefined) {
              btnContainer.createDiv('clickable-icon', (div) => {
                setIcon(div, 'lucide-external-link');
                div.setAttr('aria-label', t('Open in Zotero'));
                div.onClickEvent(async (ev) => {
                  ev.stopPropagation();
                  let link = this.plugin.bibManager.zCitekeyToLinks.get(id);
                  if (!link) {
                    await this.plugin.bibManager.getZLinksForKeys(new Set([id]));
                    link = this.plugin.bibManager.zCitekeyToLinks.get(id);
                  }
                  if (link) {
                    window.open(link, '_blank');
                  } else {
                    new Notice(t('Cannot connect to Zotero'));
                  }
                });
              });
            }

            // Get Attachment Button (only for entries with a local bib sourceFile,
            // since updateEntryFile needs to write the file field to a local bib)
            const existingPaths = paths.filter(p => fs.existsSync(p));
            const hasAttachment = existingPaths.length > 0;
            if (!hasAttachment && entry.sourceFile) {
              btnContainer.createDiv('clickable-icon', (div) => {
                setIcon(div, 'folder-open');
                div.setAttr('aria-label', t('Get attachment'));
                div.onClickEvent(async (ev) => {
                  ev.stopPropagation();
                  await this.getAttachment(entry);
                });
              });
            }

            if (existingPaths.length > 0) {
              existingPaths.forEach(link => {
                const isPDF = link.toLowerCase().endsWith('.pdf');
                const isEPUB = link.toLowerCase().endsWith('.epub');
                const isHTML = link.toLowerCase().endsWith('.html') || link.toLowerCase().endsWith('.htm');
                if (isPDF || isEPUB || isHTML) {
                  btnContainer.createDiv('clickable-icon', (div) => {
                    let icon = 'lucide-file-text';
                    if (isEPUB) icon = 'lucide-book-open';
                    if (isHTML) icon = 'lucide-globe';

                    setIcon(div, icon);
                    div.setAttr('aria-label', t('Open attachment') + ': ' + (link.split(/[\\/]/).pop()));
                    div.onClickEvent(() => {
                      if (isHTML) {
                        this.openHTMLInternal(link);
                      } else {
                        this.plugin.bibManager.openAttachment(link);
                      }
                    });
                  });
                }
                if (isPDF) {
                  btnContainer.createDiv('clickable-icon', (div) => {
                    setIcon(div, 'maximize');
                    div.setAttr('aria-label', t('Open in Preview (Full Screen)'));
                    div.onClickEvent(async (ev) => {
                      ev.stopPropagation();
                      await openPdfInPreview(link);
                    });
                  });
                }
                if (isEPUB) {
                  btnContainer.createDiv('clickable-icon', (div) => {
                    setIcon(div, 'maximize');
                    div.setAttr('aria-label', t('Open in Default Reader'));
                    div.onClickEvent(async (ev) => {
                      ev.stopPropagation();
                      await openEpubInDefaultReader(link);
                    });
                  });
                }
              });
            }

            // Convert to MD / Open MD buttons
            const hasConvertableAttachment = existingPaths.some(
              (p: string) => p.toLowerCase().endsWith('.pdf') || p.toLowerCase().endsWith('.epub')
            );
            if (hasConvertableAttachment) {
              const convertablePath = existingPaths.find(
                (p: string) => p.toLowerCase().endsWith('.pdf') || p.toLowerCase().endsWith('.epub')
              )!;

              // Open MD button (only if conversion is completed or md file exists)
              const mdPath = getOutputMdPath(id, this.plugin.settings.convertOutputPath || 'literature');
              if (mdPath && fs.existsSync(mdPath)) {
                btnContainer.createDiv('clickable-icon', (div) => {
                  setIcon(div, 'file-output');
                  div.setAttr('aria-label', t('Open MD'));
                  div.onClickEvent(async (ev) => {
                    ev.stopPropagation();
                    await this.openConvertedMd(mdPath);
                  });
                });
              }

              // Convert to MD button
              const isCompleted = isConversionCompleted(id);
              const isInProgress = isConversionInProgress(id);
              const progress = this.conversionProgress.get(id);

              btnContainer.createDiv({
                cls: `clickable-icon pwc-convert-btn ${isCompleted ? 'is-active' : ''}`,
                attr: {
                  'aria-label': isCompleted
                    ? t('Force re-convert')
                    : isInProgress
                    ? t('Conversion in progress')
                    : t('Convert to MD'),
                  'data-citekey': id,
                },
              }, (div) => {
                setIcon(div, isCompleted ? 'refresh-cw' : isInProgress ? 'loader' : 'file-down');
                div.onClickEvent(async (ev) => {
                  ev.stopPropagation();
                  await this.startConversion(entry, convertablePath);
                });

                // Show progress indicator if in progress
                if (progress && progress.status === 'in_progress') {
                  const progressDiv = div.createDiv({ cls: 'pwc-conversion-progress' });
                  const pct = progress.totalPages > 0
                    ? Math.round((progress.currentPage / progress.totalPages) * 100)
                    : 0;
                  const progressBar = progressDiv.createDiv({ cls: 'pwc-conversion-progress-bar' });
                  progressBar.createDiv({ cls: 'pwc-conversion-progress-bar-fill' })
                    .style.width = `${pct}%`;
                  progressDiv.createDiv({
                    cls: 'pwc-conversion-progress-text',
                    text: `${progress.currentPage}/${progress.totalPages}`,
                  });
                }
              });
            }
          }
        });
        container.append(parsed);
      }
    } catch (e) {
      console.error('Error rendering bibliography:', e);
      container.createDiv({ text: t('Error rendering bibliography.'), cls: 'pane-empty' });
    }
  }

  appendHighlighted(el: HTMLElement, text: string, terms: string[]) {
    let safe = text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
    const sorted = terms.slice().sort((a, b) => b.length - a.length);
    for (const term of sorted) {
      if (!term) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${escaped})`, 'gi');
      safe = safe.replace(re, '<mark>$1</mark>');
    }
    el.innerHTML = safe;
  }

  openNoteAtLine(relPath: string, line: number) {
    const file = this.plugin.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${relPath}`);
      return;
    }
    const leaf = this.plugin.app.workspace.getLeaf(false);
    leaf.openFile(file, { eState: { line: Math.max(0, line - 1) } }).then(() => {
      this.plugin.app.workspace.revealLeaf(leaf);
    });
  }

  /** Read a vault file via Obsidian's native API so iCloud on-demand files
   *  (not yet downloaded locally) resolve instead of throwing ENOENT. */
  private async readVaultText(relPath: string): Promise<string> {
    const file = this.plugin.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) return '';
    const content = await this.plugin.app.vault.cachedRead(file);
    // Every search-result group reads its documents through here, so this is
    // the one place that can cache the document's first heading for the result
    // header without adding extra file reads.
    if (!this.headingCache.has(relPath)) {
      this.headingCache.set(relPath, firstMarkdownHeading(content));
    }
    return content;
  }

  locateLiteraturePdf(citekey: string, layoutHit: { page: number; bbox: number[] | null }) {
    const entry = this.plugin.bibManager.bibCache.get(citekey);
    if (!entry) return;
    const zAttachmentLinks = this.plugin.bibManager.zCitekeyToAttachmentLinks.get(citekey) || [];
    const localAttachmentLinks = this.plugin.bibManager.parseBibFileField(entry.file);
    const paths = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];
    const pdf = paths.find((p) => p.toLowerCase().endsWith('.pdf') && fs.existsSync(p));
    if (!pdf) {
      new Notice(t('No attachment found for conversion'));
      return;
    }
    this.plugin.bibManager.openPdfAtLocation(pdf, layoutHit.page, layoutHit.bbox ?? undefined);
  }

  async processExternalText(text: string) {
    console.log('processExternalText: started', { textLength: text.length });
    
    // If the text is a URL, try to fetch it or just pass it to DeepSeek
    // The current implementation of callDeepSeek handles the text directly.
    
    this.mode = 'all';
    this.showAddSection = true;
    this.pendingEntries = [];
    this.isProcessing = true;
    
    // Re-render the entire view to ensure header and mode are correct
    this.setViewContent(null);

    try {
      if (!this.plugin.settings.deepseekApiKey) {
        new Notice(t('Please configure DeepSeek API Key in settings.'));
        this.isProcessing = false;
        this.renderAllReferencesList();
        return;
      }
      
      // If it's a URL, we might want to do something special, 
      // but for now callDeepSeek is designed to handle text/URLs via prompt.
      
      this.pendingEntries = await callDeepSeek(
        text,
        this.plugin.settings.deepseekApiUrl,
        this.plugin.settings.deepseekApiKey
      );
      console.log('processExternalText: entries received', this.pendingEntries.length);
      this.selectedEntries = new Set(this.pendingEntries.map((_, i) => i));
    } catch (e) {
      console.error('processExternalText: error', e);
      new Notice(e.message);
    } finally {
      this.isProcessing = false;
      this.renderAllReferencesList();
    }
  }

  async renderAllReferences() {
    this.setViewContent(null);
  }

  async renderAllReferencesList(container?: HTMLElement) {
    debugLog('View', 'renderAllReferencesList started');
    const parent = container || this.contentEl;
    const seq = ++this.renderSeq;
    const savedState = this._pendingListState;
    this._pendingListState = null;

    try {
      let listContainer = parent.querySelector('.pwc-manager-list') as HTMLElement;
      if (!listContainer) {
        listContainer = parent.createDiv({ cls: 'pwc-manager-list' });
      }
      listContainer.empty();

      if (this.searchQuery.trim()) {
        this.renderGroupNav(listContainer);
        await this.renderMetaHits(listContainer, this.searchQuery, seq);
        if (seq !== this.renderSeq) return;
        await this.renderRagResults(listContainer, seq);
        if (seq !== this.renderSeq) return;
        this.updateGroupNav();
        return;
      }
    
    if (this.showAddSection) {
      const addSection = listContainer.createDiv({ cls: 'pwc-add-section' });
      
      if (this.isProcessing && this.pendingEntries.length === 0) {
        addSection.createDiv({ cls: 'pwc-processing-container' }, (div) => {
          setIcon(div, 'loader');
          div.createDiv({ text: t('Processing...') });
        });
        
        const btnContainer = addSection.createDiv({ cls: 'pwc-modal-buttons' });
        const cancelBtn = btnContainer.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => {
          this.isProcessing = false;
          this.showAddSection = false;
          this.renderAllReferencesList();
        });
      } else if (this.pendingEntries.length === 0) {
        const textarea = addSection.createEl('textarea', { 
          attr: { placeholder: t('Paste text or URL here...') },
          cls: 'pwc-add-textarea'
        });

        const btnContainer = addSection.createDiv({ cls: 'pwc-modal-buttons' });
        const cancelBtn = btnContainer.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => {
          this.showAddSection = false;
          this.renderAllReferencesList();
        });

        const processBtn = btnContainer.createEl('button', { text: this.isProcessing ? t('Processing...') : t('Process'), cls: 'mod-cta' });
        processBtn.disabled = this.isProcessing;
        processBtn.addEventListener('click', async () => {
          const text = textarea.value.trim();
          if (!text) return;
          
          this.isProcessing = true;
          this.renderAllReferencesList();
          
          try {
            if (!this.plugin.settings.deepseekApiKey) {
              new Notice(t('Please configure DeepSeek API Key in settings.'));
              this.isProcessing = false;
              this.renderAllReferencesList();
              return;
            }
            this.pendingEntries = await callDeepSeek(text, this.plugin.settings.deepseekApiUrl, this.plugin.settings.deepseekApiKey);
            this.selectedEntries = new Set(this.pendingEntries.map((_, i) => i));
          } catch (e) {
            new Notice(e.message);
          } finally {
            this.isProcessing = false;
            this.renderAllReferencesList();
          }
        });
      } else {
        // Preview
        addSection.createEl('h3', { text: t('Preview Extracted References') });
        const list = addSection.createDiv({ cls: 'pwc-preview-list' });
        this.pendingEntries.forEach((entry, i) => {
          const item = list.createDiv({ cls: 'pwc-preview-item' });
          const cb = item.createEl('input', { attr: { type: 'checkbox', checked: this.selectedEntries.has(i) } });
          cb.addEventListener('change', () => {
            if (cb.checked) this.selectedEntries.add(i);
            else this.selectedEntries.delete(i);
          });
          item.createDiv({ text: `${entry.title} (${entry.year || '-'})`, cls: 'pwc-preview-info' });
        });

        const btnContainer = addSection.createDiv({ cls: 'pwc-modal-buttons' });
        const cancelBtn = btnContainer.createEl('button', { text: t('Cancel') });
        cancelBtn.addEventListener('click', () => {
          this.pendingEntries = [];
          this.renderAllReferencesList();
        });

        const saveBtn = btnContainer.createEl('button', { text: t('Save Selected'), cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
          const toSave = this.pendingEntries.filter((_, i) => this.selectedEntries.has(i));
          await this.saveEntries(toSave);
          this.pendingEntries = [];
          this.showAddSection = false;
          this.renderAllReferencesList();
        });
      }
    }

    const bibContainer = listContainer.createDiv({ cls: 'pwc-bib-container' });
    
    if (this.allEntries.length === 0 || this.plugin.bibManager.bibCache.size !== this.allEntries.length) {
        this.allEntries = Array.from(this.plugin.bibManager.bibCache.values());
    }

    this.filteredEntries = this.allEntries;

    if (this.searchQuery) {
        const q = this.searchQuery;
        this.filteredEntries = this.filteredEntries.filter(entry =>
            matchesMeta(entry, q)
        );
    }

    if (this.isRecentOnly) {
        this.filteredEntries = this.filteredEntries.filter(entry => !!entry.addDate);
    }

    const sortMultiplier = this.sortDirection === 'asc' ? 1 : -1;
    this.filteredEntries = [...this.filteredEntries].sort((a, b) => {
        let cmp = 0;
        switch (this.sortField) {
            case 'year': {
                const yearA = parseInt(a.year || '0') || 0;
                const yearB = parseInt(b.year || '0') || 0;
                cmp = yearA - yearB;
                break;
            }
            case 'title': {
                cmp = (a.title || '').localeCompare(b.title || '');
                break;
            }
            case 'author': {
                const authorA = a.author?.[0]?.family || a.author?.[0]?.given || '';
                const authorB = b.author?.[0]?.family || b.author?.[0]?.given || '';
                cmp = authorA.localeCompare(authorB);
                break;
            }
            case 'addDate': {
                cmp = (a.addDate || '').localeCompare(b.addDate || '');
                break;
            }
            case 'id': {
                cmp = a.id.localeCompare(b.id);
                break;
            }
        }
        if (cmp === 0) {
            const yearA = parseInt(a.year || '0') || 0;
            const yearB = parseInt(b.year || '0') || 0;
            cmp = yearA - yearB;
        }
        return cmp * sortMultiplier;
    });

    debugLog('View', 'renderAllReferencesList state', { 
        hasEngine: !!this.plugin.bibManager.engine, 
        bibCacheSize: this.plugin.bibManager.bibCache.size,
        allEntriesSize: this.allEntries.length,
        filteredEntriesSize: this.filteredEntries.length,
        mode: this.mode,
        initSettled: this.plugin.bibManager.initPromise.settled
    });

    if (!this.plugin.bibManager.engine) {
        if (!this.plugin.bibManager.initPromise.settled) {
            bibContainer.createDiv({ text: t('Processing...') + ' (BibCache Size: ' + this.plugin.bibManager.bibCache.size + ')', cls: 'pane-empty' });
        } else {
            bibContainer.createDiv({ text: t('No bibliography loaded or engine not initialized.'), cls: 'pane-empty' });
            bibContainer.createDiv({ 
                text: `Debug Info: BibCache Size: ${this.plugin.bibManager.bibCache.size}, Init Settled: ${this.plugin.bibManager.initPromise.settled}`,
                cls: 'pwc-debug-info'
            });
        }
        return;
    }

    try {
        const pageEntries = this.filteredEntries.slice(0, this.displayedCount);
        const allIds = pageEntries.map(e => e.id);

        if (allIds.length === 0) {
            bibContainer.createDiv({ text: t('No entries to display.'), cls: 'pane-empty' });
            return;
        }

        await this.renderCslEntries(bibContainer, allIds, seq);

        if (this.filteredEntries.length > this.displayedCount) {
            const loadMoreBtn = bibContainer.createEl('button', {
                text: t('Load More'),
                cls: 'pwc-load-more-btn'
            });
            loadMoreBtn.addEventListener('click', () => {
                this.displayedCount += 50;
                this.renderAllReferencesList();
            });
        }
    } catch (e) {
        console.error('Error rendering bibliography:', e);
        bibContainer.createDiv({ text: t('Error rendering bibliography.'), cls: 'pane-empty' });
    }
    } finally {
      if (seq === this.renderSeq) {
        this.restoreListState(savedState);
      }
    }
  }

  async openHTMLInternal(link: string) {
    const vaultRoot = (this.plugin.app.vault.adapter as any).getBasePath ? (this.plugin.app.vault.adapter as any).getBasePath() : '';
    let relativePath = '';
    let isInsideVault = false;

    if (vaultRoot && link.startsWith(vaultRoot)) {
        isInsideVault = true;
        relativePath = link.substring(vaultRoot.length).replace(/^[\\/]/, '');
    }

    if (isInsideVault) {
        const tfile = this.plugin.app.vault.getAbstractFileByPath(relativePath);
        if (tfile instanceof TFile) {
            const leaf = this.plugin.app.workspace.getRightLeaf(false);
            await leaf.openFile(tfile);
            this.plugin.app.workspace.revealLeaf(leaf);
            return;
        }
    }

    // If outside vault or not found, we can't easily use Obsidian's internal HTML viewer for arbitrary paths
    // unless we symlink it like openExternalFileInternal in bibManager.
    // However, the requirement says "软件内部的右侧新标签页中直接打开该 HTML 文件，确保使用内置视图进行预览".
    // Let's use the symlink approach if it's external.
    await this.plugin.bibManager.openAttachment(link);
  }

  async saveEntries(entries: PartialCSLEntry[]) {
    const bibPath = this.plugin.settings.pathToBibliography;
    if (!bibPath) {
        new Notice(t('Please configure bibliography path in settings.'));
        return;
    }
    const bibContent = entries.map(e => this.convertToBibtex(e)).join('\n\n') + '\n\n';
    try {
        if (fs.existsSync(bibPath)) {
            fs.appendFileSync(bibPath, bibContent, 'utf-8');
        } else {
            fs.writeFileSync(bibPath, bibContent, 'utf-8');
        }
        new Notice(t('References saved successfully.'));
        await this.plugin.bibManager.reinit(true);
    } catch (e) {
        new Notice(`${t('Failed to save')}: ${e.message}`);
    }
  }

  async getAttachment(entry: PartialCSLEntry) {
    const { attachmentDirectory } = this.plugin.settings;
    if (!attachmentDirectory) {
      new Notice(t('Please configure directories in settings.'));
      return;
    }

    if (!fs.existsSync(attachmentDirectory)) {
      fs.mkdirSync(attachmentDirectory, { recursive: true });
    }

    const result = require('electron').remote.dialog.showOpenDialogSync({
      title: t('Select attachment file'),
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'epub'] },
      ],
    });

    if (!result || result.length === 0) return;

    const sourcePath = result[0];
    const fileName = path.basename(sourcePath);
    const destPath = path.join(attachmentDirectory, fileName);

    try {
      fs.copyFileSync(sourcePath, destPath);

      await this.plugin.bibManager.updateEntryFile(entry.id, destPath);
      new Notice(t('Attachment added successfully.'));

      await this.plugin.bibManager.reinit(true);
      this.allEntries = [];
      if (this.mode === 'all') {
        this.renderAllReferencesList();
      } else {
        this.plugin.processReferences();
      }
    } catch (e) {
      console.error('Get attachment failed', e);
      new Notice(`${t('Failed to get attachment')}: ${e.message}`);
    }
  }

  convertToBibtex(entry: PartialCSLEntry): string {
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    let bib = `@article{${entry.id},\n`;
    bib += `  title = {${entry.title}},\n`;
    if (entry.author) {
        const authors = entry.author.map(a => {
            if (a.family && a.given) return `${a.family}, ${a.given}`;
            return a.family || a.given || '';
        }).filter(name => name !== '').join(' and ');
        bib += `  author = {${authors}},\n`;
    }
    if (entry.year) bib += `  year = {${entry.year}},\n`;
    if (entry.journal) bib += `  journal = {${entry.journal}},\n`;
    if (entry.doi) bib += `  doi = {${entry.doi}},\n`;
    if (entry.url) bib += `  url = {${entry.url}},\n`;
    bib += `  add_date = {${timestamp}}\n`;
    bib += `}`;
    return bib;
  }

  async startConversion(entry: PartialCSLEntry, attachmentPath: string) {
    const settings = this.plugin.settings;
    const convertOutputPath = settings.convertOutputPath || 'literature';

    if (this.conversionProgress.has(entry.id) &&
        this.conversionProgress.get(entry.id)!.status === 'in_progress') {
      new Notice(t('Conversion in progress'));
      return;
    }

    if (isConversionCompleted(entry.id)) {
      forceReconvert(entry.id, convertOutputPath);
      new Notice(t('Force re-convert started'));
    }

    const convertSettings = {
      outputPath: convertOutputPath,
      mineru: {
        apiToken: settings.mineruApiToken || '',
      },
    };

    this.conversionProgress.set(entry.id, {
      citekey: entry.id,
      currentPage: 0,
      totalPages: 0,
      status: 'in_progress',
      message: 'Starting...',
    });
    this.updateConvertButton(entry.id);

    try {
      await convertToMarkdown(entry, attachmentPath, convertSettings, (progress: ConvertProgress) => {
        this.conversionProgress.set(entry.id, progress);
        // Update only the entry's button in place. A full renderAllReferencesList()
        // here re-runs the whole search pipeline (BM25 + semantic + the paid
        // rerank API) on every page-progress tick, which made the search panel
        // constantly flicker and re-invoke rerank while a conversion ran.
        this.updateConvertButton(entry.id);
      });

      this.conversionProgress.delete(entry.id);
      this.updateConvertButton(entry.id);
    } catch (e: any) {
      console.error('Conversion error:', e);
      this.conversionProgress.set(entry.id, {
        citekey: entry.id,
        currentPage: 0,
        totalPages: 0,
        status: 'failed',
        message: e.message,
      });
      this.updateConvertButton(entry.id);
    }
  }

  /**
   * Update one entry's "转换MD" button in place (icon, label, progress bar)
   * without re-rendering the whole list. Safe to call when the view has been
   * closed (contentEl detached): the query simply finds nothing and no-ops, so
   * an in-flight conversion is never aborted by closing the pane.
   */
  private updateConvertButton(id: string) {
    try {
      const btn = this.contentEl.querySelector<HTMLElement>(
        `.pwc-convert-btn[data-citekey="${id}"]`
      );
      if (!btn || !this.contentEl.isConnected) return;

      const progress = this.conversionProgress.get(id);
      const isInProgress = progress?.status === 'in_progress';
      const isCompleted = isConversionCompleted(id);

      btn.setAttr(
        'aria-label',
        isCompleted
          ? t('Force re-convert')
          : isInProgress
          ? t('Conversion in progress')
          : t('Convert to MD')
      );
      btn.toggleClass('is-active', isCompleted);

      const oldIcon = btn.querySelector('svg');
      if (oldIcon) oldIcon.remove();
      setIcon(btn, isCompleted ? 'refresh-cw' : isInProgress ? 'loader' : 'file-down');

      btn.querySelector('.pwc-conversion-progress')?.remove();
      if (isInProgress && progress && progress.totalPages > 0) {
        const pct = Math.round((progress.currentPage / progress.totalPages) * 100);
        const progressDiv = btn.createDiv({ cls: 'pwc-conversion-progress' });
        const progressBar = progressDiv.createDiv({ cls: 'pwc-conversion-progress-bar' });
        progressBar.createDiv({ cls: 'pwc-conversion-progress-bar-fill' }).style.width = `${pct}%`;
        progressDiv.createDiv({
          cls: 'pwc-conversion-progress-text',
          text: `${progress.currentPage}/${progress.totalPages}`,
        });
      }
    } catch {
      // The view may be gone / mid-teardown; conversion must keep running.
    }
  }

  async openConvertedMd(mdPath: string) {
    const vaultRoot = (this.plugin.app.vault.adapter as any).getBasePath();
    let relativePath = mdPath;
    if (vaultRoot && mdPath.startsWith(vaultRoot)) {
      relativePath = mdPath.substring(vaultRoot.length).replace(/^[\\/]/, '');
    }

    if (relativePath !== mdPath) {
      const tfile = this.plugin.app.vault.getAbstractFileByPath(relativePath);
      if (tfile instanceof TFile) {
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(tfile);
        return;
      }
    }

    await this.plugin.bibManager.openAttachment(mdPath);
  }

  setNoContentMessage() {
    if (this.mode === 'current') {
      this.setViewContent(null);
    }
  }

  setMessage(message: string) {
    this.contentEl.empty();
    this.renderHeader();
    const container = this.contentEl.createDiv({ cls: 'pwc-view-content' });
    container.createDiv({
      cls: 'pane-empty',
      text: message,
    });
  }

  getViewType() {
    return viewType;
  }

  getDisplayText() {
    return t('References');
  }

  getIcon() {
    return 'quote-glyph';
  }

  public async revealEntry(entry: PartialCSLEntry) {
    debugLog('View', 'revealEntry called', entry.id);
    this.mode = 'all';
    this.searchQuery = entry.id.toLowerCase();
    this.displayedCount = 50;
    this.showAddSection = false;
    this._skipStateCapture = true;
    
    await this.renderAllReferences();
    
    const container = this.contentEl.querySelector('.pwc-view-content');
    const element = container?.querySelector(`[data-citekey="${entry.id}"]`)?.closest('.csl-entry-wrapper') as HTMLElement;
    
    if (element) {
      debugLog('View', 'Element found, scrolling and highlighting');
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.addClass('is-highlighted');
      setTimeout(() => element.removeClass('is-highlighted'), 3000);
    } else {
      debugLog('View', 'Element not found in DOM', entry.id);
    }
  }
}
