import { ItemView, MarkdownView, WorkspaceLeaf, setIcon, Notice, TFile } from 'obsidian';

import { copyElToClipboard, debounce, debugLog, showDetailedTooltip } from './helpers';
import { t } from './lang/helpers';
import ReferenceList from './main';
import { callDeepSeek } from './bib/aiHelper';
import { PartialCSLEntry } from './bib/types';
import * as fs from 'fs';

export const viewType = 'ReferenceListView';

export class ReferenceListView extends ItemView {
  plugin: ReferenceList;
  activeMarkdownLeaf: MarkdownView;
  mode: 'current' | 'all' = 'current';
  searchQuery = '';
  showAddSection = false;
  isProcessing = false;
  pendingEntries: PartialCSLEntry[] = [];
  selectedEntries: Set<number> = new Set();
  
  displayedCount = 50;
  allEntries: PartialCSLEntry[] = [];
  filteredEntries: PartialCSLEntry[] = [];

  private debouncedRender = debounce(() => {
    this.displayedCount = 50;
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
    debugLog('View', 'setViewContent started', { hasBib: !!bib, mode: this.mode });
    this.contentEl.empty();
    this.renderHeader();
    
    const container = this.contentEl.createDiv({ cls: 'pwc-view-content' });
    
    if (this.mode === 'current') {
      if (bib) {
        debugLog('View', 'appending bib to container');
        container.append(bib);
      } else {
        debugLog('View', 'no bib, showing empty message');
        container.createDiv({
          cls: 'pane-empty',
          text: t('No citations found in the current document.'),
        });
      }
    } else {
      debugLog('View', 'rendering all references list');
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
      cls: 'clickable-icon',
      attr: { 'aria-label': this.mode === 'current' ? t('Show All References') : t('Show Current References') }
    }, (btn) => {
      setIcon(btn, this.mode === 'current' ? 'library' : 'file-text');
      btn.onClickEvent(() => {
        this.mode = this.mode === 'current' ? 'all' : 'current';
        this.searchQuery = '';
        this.displayedCount = 50;
        this.showAddSection = false;
        this.pendingEntries = [];
        if (this.mode === 'all') {
          this.renderAllReferences();
        } else {
          this.plugin.processReferences();
        }
      });
    });

    if (this.mode === 'all') {
      // Add Reference Button
      actionsContainer.createDiv({
        cls: 'clickable-icon',
        attr: { 'aria-label': t('Add Reference') }
      }, (btn) => {
        setIcon(btn, 'plus');
        btn.onClickEvent(() => {
          this.showAddSection = !this.showAddSection;
          this.pendingEntries = [];
          this.renderAllReferencesList();
        });
      });
    }

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

    if (this.mode === 'all') {
      const searchContainer = header.createDiv({ cls: 'pwc-manager-search' });
      const searchInput = searchContainer.createEl('input', {
        attr: { type: 'text', placeholder: t('Search references...'), value: this.searchQuery }
      });
      
      if (this.searchQuery) {
        const clearBtn = searchContainer.createDiv({ cls: 'pwc-search-clear' });
        setIcon(clearBtn, 'x');
        clearBtn.onClickEvent(() => {
          this.searchQuery = '';
          this.debouncedRender();
        });
      }

      searchInput.addEventListener('input', (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.debouncedRender();
      });
    }
  }

  async renderAllReferences() {
    this.setViewContent(null);
  }

  async renderAllReferencesList(container?: HTMLElement) {
    debugLog('View', 'renderAllReferencesList started');
    const parent = container || this.contentEl;
    let listContainer = parent.querySelector('.pwc-manager-list') as HTMLElement;
    if (!listContainer) {
      listContainer = parent.createDiv({ cls: 'pwc-manager-list' });
    }
    listContainer.empty();
    
    if (this.showAddSection) {
      const addSection = listContainer.createDiv({ cls: 'pwc-add-section' });
      
      if (this.pendingEntries.length === 0) {
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
        this.allEntries.sort((a, b) => {
            const yearA = parseInt(a.year || '0') || 0;
            const yearB = parseInt(b.year || '0') || 0;
            return yearB - yearA;
        });
    }

    this.filteredEntries = this.searchQuery 
        ? this.allEntries.filter(entry => 
            entry.id.toLowerCase().includes(this.searchQuery) ||
            entry.title.toLowerCase().includes(this.searchQuery) ||
            (entry.author && entry.author.some(a => a.family?.toLowerCase().includes(this.searchQuery) || a.given?.toLowerCase().includes(this.searchQuery)))
        )
        : this.allEntries;

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

        let bib;
        try {
            this.plugin.bibManager.engine.updateItems(allIds);
            bib = this.plugin.bibManager.engine.makeBibliography();
        } catch (err) {
            console.error('Initial makeBibliography failed', err);
            bib = false;
        }

        if (!bib || bib.length < 2) {
            const entries: string[] = [];
            const entry_ids: string[][] = [];
            for (const id of allIds) {
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
                    entry_ids: entry_ids 
                }, entries];
            }
        }
        
        if (!bib || bib.length < 2) {
            bibContainer.createDiv({ text: t('No entries to display.'), cls: 'pane-empty' });
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
                    const paths = this.plugin.bibManager.parseBibFileField(entry.file);
                    
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

                    if (paths.length > 0) {
                        paths.forEach(link => {
                            const isPDF = link.toLowerCase().endsWith('.pdf');
                            const isEPUB = link.toLowerCase().endsWith('.epub');
                            if (isPDF || isEPUB) {
                                btnContainer.createDiv('clickable-icon', (div) => {
                                    setIcon(div, isPDF ? 'lucide-file-text' : 'lucide-book-open');
                                    div.setAttr('aria-label', t('Open attachment') + ': ' + (link.split(/[\\\/]/).pop()));
                                    div.onClickEvent(() => this.plugin.bibManager.openExternalFileInternal(link));
                                });
                            }
                        });
                    }
                }

                // Hover Tooltip Logic removed as per user request
            });
            bibContainer.append(parsed);
        }

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

  convertToBibtex(entry: PartialCSLEntry): string {
    let bib = `@article{${entry.id},\n`;
    bib += `  title = {${entry.title}},\n`;
    if (entry.author) {
        const authors = entry.author.map(a => `${a.family}, ${a.given}`).join(' and ');
        bib += `  author = {${authors}},\n`;
    }
    if (entry.year) bib += `  year = {${entry.year}},\n`;
    if (entry.journal) bib += `  journal = {${entry.journal}},\n`;
    if (entry.doi) bib += `  doi = {${entry.doi}},\n`;
    if (entry.url) bib += `  url = {${entry.url}},\n`;
    bib += `}`;
    return bib;
  }

  setNoContentMessage() {
    this.setMessage(t('No citations found in the current document.'));
  }

  setMessage(message: string) {
    this.contentEl.createDiv({
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
}
