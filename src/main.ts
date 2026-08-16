import {
  Events,
  MarkdownView,
  Menu,
  Plugin,
  WorkspaceLeaf,
  debounce,
  setIcon,
  TFile,
  Notice,
  FileSystemAdapter,
} from 'obsidian';
import which from 'which';

import {
  citeKeyCacheField,
  citeKeyPlugin,
  bibManagerField,
  editorTooltipHandler,
} from './editorExtension';
import { t } from './lang/helpers';
import { processCiteKeys } from './markdownPostprocessor';
import { DEFAULT_SETTINGS, ReferenceListSettings } from './settingsDefaults';
import { LazySettingsTab } from './lazySettingsTab';
import { TooltipManager } from './tooltip';
import { ReferenceListView, viewType } from './view';
import { PromiseCapability, fixPath, getVaultRoot, debugLog, isLocalApiUrl } from './helpers';
import path from 'path';
import { BibManager } from './bib/bibManager';
import { CiteSuggest } from './citeSuggest/citeSuggest';
import { isZoteroRunning } from './bib/helpers';
import { RagIndexer } from './rag/indexer';
import { SemanticIndexer, IndexProgress } from './rag/semanticIndexer';
import { backfillLiteratureLayouts } from './rag/backfill';
import { reconcileStaleConversions } from './converter';
import * as fs from 'fs';

export default class ReferenceList extends Plugin {
  settings: ReferenceListSettings;
  emitter: Events;
  tooltipManager: TooltipManager;
  cacheDir: string;
  bibManager: BibManager;
  ragIndexer: RagIndexer;
  semanticIndexer: SemanticIndexer;
  _initPromise: PromiseCapability<void>;
  lastActiveFile: TFile | null = null;
  private lastMatchQuery: string = '';
  private lastMatchResult: string | null = null;

  get initPromise() {
    if (!this._initPromise) {
      return (this._initPromise = new PromiseCapability());
    }
    return this._initPromise;
  }

  async onload() {
    debugLog('Main', 'onload started');
    const { app } = this;

    await this.loadSettings();
    debugLog('Main', 'settings loaded', this.settings);

    this.initPromise.resolve();
    debugLog('Main', 'initPromise resolved');

    // Heavy startup work (bibliography loading, pandoc discovery, index
    // building) is deferred so it does not compete with Obsidian's own startup
    // on the main thread. The app gets to render first; these run a moment
    // later and pick up where they left off.
    const deferAfterStartup = (fn: () => void, delay = 3000) => {
      window.setTimeout(() => {
        try {
          fn();
        } catch (e) {
          debugLog('Main', 'Deferred startup task failed', { error: (e as any)?.message });
        }
      }, delay);
    };

    try {
      this.registerView(
        viewType,
        (leaf: WorkspaceLeaf) => new ReferenceListView(leaf, this)
      );
    } catch (e) {
      console.warn('ReferenceList: View type already registered');
    }

    this.cacheDir = path.join(getVaultRoot(), '.pandoc');
    this.emitter = new Events();
    this.bibManager = new BibManager(this);
    this.ragIndexer = new RagIndexer(
      this.app,
      this.settings.convertOutputPath || 'literature',
      {
        followSymlinks: this.settings.indexFollowSymlinks !== false,
        excludeFolders: this.settings.indexExcludeFolders || [],
      }
    );
    this.semanticIndexer = new SemanticIndexer(
      this.app,
      this.settings.convertOutputPath || 'literature',
      {
        enabled: !!this.settings.enableNativeSemantic,
        apiUrl: this.settings.semanticEmbedApiUrl,
        apiKey: this.settings.semanticEmbedApiKey || '',
        model: this.settings.semanticEmbedModel,
        chunkSize: this.settings.semanticChunkSize || 1200,
        chunkOverlap: this.settings.semanticChunkOverlap || 120,
        topK: this.settings.semanticTopK || 20,
        indexLocation: (this.settings.semanticIndexLocation || 'vault') === 'local' ? 'local' : 'vault',
        followSymlinks: this.settings.indexFollowSymlinks !== false,
        excludeFolders: this.settings.indexExcludeFolders || [],
      }
    );
    // Bibliography loading (cache parse / pandoc conversion + citeproc engine
    // + Fuse index build) used to start immediately inside onload(), adding
    // synchronous CPU work to Obsidian's startup window. Delay it briefly so
    // the app renders first; the status bar stays in "loading" until it's done.
    deferAfterStartup(() => {
      this.initPromise.promise
        .then(() => {
          debugLog('Main', 'initPromise.then started');
          // Always load bib files first, then optionally load Zotero
          return this.bibManager.loadGlobalBibFile().then(() => {
            if (this.settings.pullFromZotero) {
              debugLog('Main', 'pulling from Zotero');
              return this.bibManager.loadAndRefreshGlobalZBib();
            }
          });
        })
        .then(() => {
          debugLog('Main', 'bib files loaded successfully');
        })
        .catch((e) => {
          debugLog('Main', 'error during bib initialization', e);
          new Notice(`${t('Error rendering bibliography.')}: ${e.message}`);
        })
        .finally(() => {
          debugLog('Main', 'bibManager initPromise resolving');
          this.bibManager.initPromise.resolve();
        });
    }, 1500);

    // Safety timeout for bibManager initialization
    setTimeout(() => {
      if (!this.bibManager.initPromise.settled) {
        debugLog('Main', 'bibManager initPromise timed out, resolving anyway');
        this.bibManager.initPromise.resolve();
      }
    }, 60000);

    this.addSettingTab(new LazySettingsTab(this));
    this.registerEditorSuggest(new CiteSuggest(app, this));
    console.log('ReferenceList: CiteSuggest registered');
    this.tooltipManager = new TooltipManager(this);
    this.registerMarkdownPostProcessor(processCiteKeys(this));
    this.registerEditorExtension([
      bibManagerField.init(() => this.bibManager),
      citeKeyCacheField,
      citeKeyPlugin,
      editorTooltipHandler(this.tooltipManager),
    ]);

    // Periodically poll Zotero so items modified there (new attachments,
    // edited metadata, new entries) show up in the plugin without requiring a
    // manual refresh. refreshGlobalZBib() is cheap when nothing changed and
    // only re-renders the panel when actual modifications were detected.
    const zoteroInterval = (this.settings.zoteroRefreshInterval ?? 30) * 1000;
    if (zoteroInterval > 0) {
      this.registerInterval(
        window.setInterval(() => {
          if (!this.settings.pullFromZotero) return;
          this.bibManager
            .refreshGlobalZBib()
            .catch((e) => {
              debugLog('Main', 'periodic Zotero refresh failed', {
                error: (e as any)?.message,
              });
            });
        }, zoteroInterval)
      );
    }

    // Resolving the PATH (spawns a login shell) and probing for pandoc spawn
    // child processes; defer past the startup window.
    deferAfterStartup(() => {
      fixPath().then(async () => {
        if (!this.settings.pathToPandoc) {
          try {
            // Attempt to find if/where pandoc is located on the user's machine
            const pathToPandoc = await which('pandoc');
            this.settings.pathToPandoc = pathToPandoc;
            this.saveSettings();
          } catch {
            // We can ignore any errors here
          }
        }

        this.app.workspace.trigger('parse-style-settings');
      });
    }, 800);

    // Repair conversion state leaked by a previous session (plugin reload /
    // Obsidian quit mid-conversion). Deferred so the synchronous state-file
    // read does not add to the startup window; still runs long before any
    // conversion can begin.
    deferAfterStartup(() => {
      try {
        const repaired = reconcileStaleConversions();
        if (repaired.completed || repaired.failed) {
          debugLog('Main', 'Reconciled stale conversion state', repaired);
        }
      } catch (e) {
        debugLog('Main', 'Conversion state reconciliation failed', e);
      }
    }, 2000);

    // RAG full-text index: build in the background, keep it incrementally updated.
    // Deferred until after Obsidian finishes its own startup: loading the index
    // (hundreds of MB) synchronously at plugin load froze the whole app for
    // seconds. Running it a moment later keeps startup instant.
    deferAfterStartup(() => this.initRagIndex(), 2000);
    deferAfterStartup(() => this.initSemanticIndex(), 4000);

    // RAG full-text re-index is cheap and stat-based, so it stays near-real-time
    // on file changes. Semantic (embedding) indexing is deliberately debounced
    // much longer — embedding hundreds of MB of vectors into an iCloud-synced
    // vault is heavy and does not need to be real-time — so a burst of note
    // edits only triggers one re-embed well after the user has stopped typing.
    const ragUpdate = debounce(
      () => {
        if (this.settings.enableRagSearch) {
          this.ragIndexer.incrementalUpdate().catch(() => {});
        }
      },
      5000,
      false
    );
    // The availability of the embedding engine is re-probed inside
    // incrementalUpdate on every run, so a machine whose Ollama service comes
    // back online (or whose API config was fixed) automatically resumes
    // indexing without a plugin reload; an unreachable service is simply
    // skipped. Auto runs are bounded (see SemanticIndexer) so a large pending
    // backlog cannot pin the CPU / embedding service.
    const semanticUpdate = debounce(
      () => {
        if (this.semanticIndexer.enabled) {
          this.semanticIndexer.incrementalUpdate(undefined, { auto: true }).catch(() => {});
        }
      },
      15 * 60 * 1000,
      false
    );
    const onMdChanged = () => {
      ragUpdate();
      semanticUpdate();
    };
    this.registerEvent(
      app.vault.on('create', (file) => {
        if (file instanceof TFile && file.extension === 'md') onMdChanged();
      })
    );
    this.registerEvent(
      app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') onMdChanged();
      })
    );
    this.registerEvent(
      app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') onMdChanged();
      })
    );

    this.addCommand({
      id: 'focus-reference-list-view',
      name: t('Show Current References'),
      callback: async () => {
        const view = await this.initLeaf();
        if (view) {
          view.mode = 'current';
          this.processReferences();
        }
      },
    });

    this.addCommand({
      id: 'open-reference-manager',
      name: t('Show All References'),
      callback: async () => {
        const view = await this.initLeaf();
        if (view) {
          view.mode = 'all';
          view.renderAllReferences();
        }
      },
    });

    this.addCommand({
      id: 'rag-search-vault',
      name: t('Search full vault (RAG)'),
      callback: async () => {
        const view = await this.initLeaf();
        if (view) {
          view.mode = 'all';
          view.renderAllReferences();
          setTimeout(() => {
            const input = view.contentEl.querySelector(
              '.pwc-manager-search input'
            ) as HTMLInputElement;
            if (input) input.focus();
          }, 300);
        }
      },
    });

    this.addCommand({
      id: 'rebuild-semantic-index',
      name: '重建语义索引',
      callback: () => {
        this.rebuildSemanticIndex();
      },
    });

    this.addCommand({
      id: 'update-semantic-index',
      name: '增量更新语义索引',
      callback: () => {
        this.updateSemanticIndex();
      },
    });

    document.body.toggleClass(
      'pwc-tooltips',
      !!this.settings.showCitekeyTooltips
    );

    this.registerEvent(
      app.metadataCache.on(
        'changed',
        debounce(
          async (file) => {
            // Same rationale as editor-change: an 'all'-mode panel doesn't
            // depend on the active note's metadata, so skip the rebuild while
            // the user is typing/editing the note.
            if (this.view?.mode === 'all') return;

            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            const currentFile = activeView?.file || this.lastActiveFile;
            if (currentFile && file === currentFile) {
              this.processReferences();
            }
          },
          1000,
          false
        )
      )
    );

    this.registerEvent(
      app.workspace.on('editor-change', () => {
        // In 'all' mode the panel shows the full reference list or search
        // results, neither of which depends on the active editor's content.
        // Skipping here avoids a full panel re-render on every keystroke,
        // which previously made the panel flicker while typing.
        if (this.view?.mode === 'all') return;
        this.processReferencesDebounced();
      })
    );

    const bibReinit = debounce(
      () => {
        this.bibManager.reinit(true).then(() => this.processReferences());
      },
      1000,
      false
    );
    this.registerEvent(
      app.vault.on('modify', (file) => {
        if (file instanceof TFile && this.isBibliographySource(file)) {
          bibReinit();
        }
      })
    );

    this.registerEvent(
      app.workspace.on(
        'active-leaf-change',
        debounce(
          async (leaf) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            if (leaf && leaf.view instanceof MarkdownView) {
              this.lastActiveFile = leaf.view.file;
              this.processReferences();
            } else if (leaf && leaf.view.getViewType() === viewType) {
              this.processReferences();
            }
          },
          100,
          true
        )
      )
    );

    (async () => {
      this.initStatusBar();
      this.setStatusBarLoading();

      debugLog('Main', 'waiting for initPromise and bibManager.initPromise');
      await this.initPromise.promise;
      await this.bibManager.initPromise.promise;
      debugLog('Main', 'promises resolved, setting status bar idle');

      this.setStatusBarIdle();
      this.processReferences();
    })();

    try {
      this.registerObsidianProtocolHandler('bib-manager-add', async (params) => {
        const content = params.content;
        if (!content) return;

        const view = await this.initLeaf();
        if (view) {
          // Ensure the view is ready before processing
          setTimeout(() => {
            view.processExternalText(content);
          }, 500);
        }
      });

      this.registerObsidianProtocolHandler('bib-manager', (params) => {
        debugLog('Main', 'Protocol handler bib-manager called', params);
        if (params.action === 'focus' && (params.citekey || params.title)) {
          this.focusEntry(params.citekey, params.title);
        }
      });
    } catch (e) {
      console.warn('ReferenceList: Protocol handler already registered');
    }

    this.registerEvent(
      this.app.workspace.on(
        'bib-manager:focus-entry',
        (data: { citekey: string; title?: string }) => {
          debugLog('Main', 'Event bib-manager:focus-entry received', data);
          this.focusEntry(data.citekey, data.title);
        }
      )
    );

    // Hot Reload logic
    this.initHotReload();

    // Cross-plugin communication integration
    this.registerDomEvent(window, 'message', async (event: MessageEvent) => {
      const { type, entryId } = event.data;

      if (type === 'BIB_MANAGER_ENTRIES_REQUEST') {
        debugLog('Main', 'Received BIB_MANAGER_ENTRIES_REQUEST');
        const entries = await this.bibManager.getAllEntriesForIntegration();
        event.source?.postMessage(
          {
            type: 'BIB_MANAGER_ENTRIES_RESPONSE',
            entries,
          },
          { targetOrigin: '*' }
        );
      }

      if (type === 'BIB_MANAGER_FILE_REQUEST' && entryId) {
        debugLog('Main', 'Received BIB_MANAGER_FILE_REQUEST', entryId);
        const fileData = await this.bibManager.getPdfDataForIntegration(entryId);
        if (fileData) {
          event.source?.postMessage(
            {
              type: 'BIB_MANAGER_FILE_RESPONSE',
              entryId,
              name: fileData.name,
              mimeType: 'application/pdf',
              data: fileData.data,
            },
            { targetOrigin: '*' }
          );
        }
      }
    });
  }

  initHotReload() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const pluginDir = path.join(adapter.getBasePath(), this.manifest.dir);
    const hotReloadFile = path.join(pluginDir, '.hotreload');

    if (fs.existsSync(hotReloadFile)) {
      console.log('Bib Manager: Hot reload enabled');
      // Watch the directory instead of the file for better reliability
      fs.watch(pluginDir, (eventType, filename) => {
        if (filename === 'main.js' && eventType === 'change') {
          // Use a larger delay to ensure the file is fully written and Obsidian has time to process
          setTimeout(async () => {
            try {
              // disablePlugin/enablePlugin are not in the public Obsidian
              // types; call them via a relaxed plugin-manager reference for
              // hot-reload only (dev convenience, guarded by the try/catch).
              const plugins = (this.app as any).plugins;
              await plugins.disablePlugin(this.manifest.id);
              await plugins.enablePlugin(this.manifest.id);
              console.log('Bib Manager: Hot reloaded');
            } catch (e) {
              console.error('Hot reload failed', e);
            }
          }, 1000);
        }
      });
    }
  }

  onunload() {
    document.body.removeClass('pwc-tooltips');
    this.app.workspace
      .getLeavesOfType(viewType)
      .forEach((leaf) => leaf.detach());
    this.bibManager.destroy();
    this.ragIndexer.destroy();
    this.semanticIndexer.destroy();
  }

  /**
   * True only for vault files that are an actually configured bibliography
   * source, so a `modify` event should rebuild the bibliography.
   *
   * Matching on the bare extension (.bib/.json/.yaml) was far too broad: the
   * vault also holds the plugin's own caches (`.pandoc/csl-cache-*.json`,
   * `.pandoc/zotero-library-*.json`), `.bib-manager/semantic-index.json`,
   * per-paper `literature/<citekey>/layout.json`, and Obsidian's own
   * `.obsidian/*.json`. Any of those being written kicked off a full
   * `reinit(true)` + `processReferences()`, which in 'all' mode blanks and
   * re-renders the panel — the panel appeared to refresh itself at random
   * (and repeatedly during a conversion, since conversion writes layout.json).
   * Writing a CSL cache from inside that very reinit also made the loop
   * self-sustaining.
   */
  private isBibliographySource(file: TFile): boolean {
    const ext = file.extension;
    if (ext !== 'bib' && ext !== 'json' && ext !== 'yaml') return false;

    // Plugin- and app-owned paths are never bibliography input.
    const p = file.path;
    if (p === '.bib-manager' || p.startsWith('.bib-manager/')) return false;
    if (p === '.pandoc' || p.startsWith('.pandoc/')) return false;
    if (p.startsWith('.obsidian/')) return false;
    if (p.endsWith('/layout.json')) return false;

    const configured = [
      this.settings.pathToBibliography,
      ...(Array.isArray(this.settings.bibliographyPaths)
        ? this.settings.bibliographyPaths
        : []),
    ].filter((s): s is string => !!s);
    if (configured.length === 0) return false;

    // Configured paths may be absolute or vault-relative; compare both ways.
    const abs = path.join(getVaultRoot(), p);
    return configured.some((c) => {
      const norm = path.normalize(c);
      return norm === p || norm === abs || path.resolve(norm) === abs;
    });
  }

  async initRagIndex(): Promise<void> {
    if (!this.settings.enableRagSearch) return;
    try {
      const loaded = await this.ragIndexer.loadCache();
      if (loaded) {
        await this.ragIndexer.incrementalUpdate();
      } else {
        await this.ragIndexer.buildAll();
      }
      debugLog('Main', 'RAG index ready', { docs: this.ragIndexer.index.docCount });
      // Backfill layout.json from preserved MinerU zips in the background.
      setTimeout(() => {
        try {
          const n = backfillLiteratureLayouts(
            getVaultRoot(),
            this.settings.convertOutputPath || 'literature'
          );
          if (n > 0) debugLog('Main', 'Backfilled literature layouts', { count: n });
        } catch (e) {
          debugLog('Main', 'Layout backfill failed', e);
        }
      }, 3000);
    } catch (e) {
      debugLog('Main', 'RAG index initialization failed', e);
    }
  }

  private lastSemanticMilestone = 0;
  reportSemanticProgress(p: IndexProgress): void {
    const pct = Math.floor((p.done / p.total) * 100);
    const milestone = Math.floor(pct / 10) * 10;
    if (pct === 100 || milestone > this.lastSemanticMilestone) {
      this.lastSemanticMilestone = milestone;
      new Notice(`语义索引 ${p.done}/${p.total}（${pct}%）`);
    }
  }

  async initSemanticIndex(): Promise<void> {
    if (!this.semanticIndexer.enabled) return;
    if (!this.settings.semanticEmbedApiKey && !isLocalApiUrl(this.settings.semanticEmbedApiUrl || '')) {
      new Notice('语义检索：请先在设置中配置 Embedding API Key（本地 Ollama 服务可留空）。');
      return;
    }
    // Probe whether this machine can embed (runs Ollama) and load the cache in
    // parallel — the probe can take tens of seconds when Ollama is saturated,
    // and the cache load reads a ~120MB vector file, so sequencing them made
    // startup wait twice. On machines without the embedding service we only
    // load the iCloud-synced index read-only — never build or overwrite it.
    // Note: this is only a startup hint; every build/update re-probes inside
    // the indexer, so a service that comes back online later is picked up
    // automatically.
    const [available] = await Promise.all([
      this.semanticIndexer.ensureEmbeddingAvailable(),
      this.semanticIndexer.loadCache(),
    ]);
    const loaded = this.semanticIndexer.index.docCount > 0;
    debugLog('Main', 'Embedding service availability', { available, loaded });

    if (!available) {
      if (loaded) {
        new Notice('语义检索：本机无嵌入服务，已加载 iCloud 同步的语义索引（只读，不会重建/覆盖）。');
      } else {
        new Notice('语义检索：本机无嵌入服务，且无可用同步索引，请在有嵌入服务的设备上构建后同步。');
      }
      return;
    }
    if (!loaded) {
      const pending = this.semanticIndexer.countPendingFiles();
        new Notice(
          `语义索引未构建（共 ${pending} 个文件）：将在后台分批自动嵌入（GPU 并行，小文件优先）；超大文件（整本书）留给手动“增量更新”。`
        );
      await this.semanticIndexer.incrementalUpdate(undefined, { auto: true });
      this.semanticIndexer.countPendingFiles();
      debugLog('Main', 'Semantic index first build started (paced auto drain)', { files: pending });
    } else {
      const pending = this.semanticIndexer.countPendingFiles();
      if (pending > 0) {
        // Draining a large backlog is paced (see SemanticIndexer): at most a
        // few files per 30s, so the embedding service / CPU is never pegged
        // while the index still catches up in the background.
        new Notice(
          `语义索引有 ${pending} 个文件待嵌入：后台自动分批嵌入中（小文件优先）；超大文件建议手动点击“增量更新”。`
        );
        await this.semanticIndexer.incrementalUpdate(undefined, { auto: true });
        this.semanticIndexer.countPendingFiles();
        debugLog('Main', 'Semantic index backlog drain started (paced auto)', { files: pending });
      }
    }
  }

  async rebuildSemanticIndex(): Promise<void> {
    if (!this.semanticIndexer.enabled) {
      new Notice('语义检索未启用，请在设置中开启并配置 API Key。');
      return;
    }
    this.lastSemanticMilestone = 0;
    new Notice('开始重建语义索引...');
    try {
      await this.semanticIndexer.buildAll((p) => this.reportSemanticProgress(p));
      this.semanticIndexer.countPendingFiles();
      new Notice('语义索引重建完成');
    } catch (e: any) {
      new Notice(`语义索引重建失败：${e.message}`);
    }
  }

  async updateSemanticIndex(): Promise<void> {
    if (!this.semanticIndexer.enabled) {
      new Notice('语义检索未启用，请在设置中开启并配置 API Key。');
      return;
    }
    this.lastSemanticMilestone = 0;
    new Notice('开始增量更新语义索引...');
    try {
      await this.semanticIndexer.incrementalUpdate((p) => this.reportSemanticProgress(p));
      this.semanticIndexer.countPendingFiles();
      new Notice('语义索引增量更新完成');
    } catch (e: any) {
      new Notice(`语义索引增量更新失败：${e.message}`);
    }
  }

  /**
   * Re-probe the embedding service and re-run the auto-maintenance flow after
   * semantic-index settings change (API URL / key / model / enable toggle /
   * storage location). The probe cache is dropped first so the service is
   * checked immediately instead of reusing a stale "unavailable" result.
   */
  async reprobeSemanticIndex(): Promise<void> {
    if (!this.semanticIndexer.enabled) return;
    this.semanticIndexer.resetProbe();
    const available = await this.semanticIndexer.ensureEmbeddingAvailable();
    debugLog('Main', 'Semantic embedding service re-probed', { available });
    if (available) {
      // Service reachable: load cache and run the normal auto-maintain flow.
      await this.initSemanticIndex();
    } else {
      new Notice('语义检索：本机嵌入服务不可用，索引保持只读，请检查嵌入 API 地址与模型。');
    }
  }

  statusBarIcon: HTMLElement;
  initStatusBar() {
    const ico = (this.statusBarIcon = this.addStatusBarItem());
    ico.addClass('pwc-status-icon', 'clickable-icon');
    ico.setAttr('aria-label', t('Bib Manager settings'));
    ico.setAttr('data-tooltip-position', 'top');
    this.setStatusBarIdle();
    let isOpen = false;
    ico.addEventListener('click', () => {
      if (isOpen) return;
      const { settings } = this;
      const menu = (new Menu() as any)
        .addSections(['settings', 'actions'])
        .addItem((item: any) =>
          item
            .setSection('settings')
            .setIcon('lucide-message-square')
            .setTitle(t('Show citekey tooltips'))
            .setChecked(!!settings.showCitekeyTooltips)
            .onClick(() => {
              this.settings.showCitekeyTooltips = !settings.showCitekeyTooltips;
              this.saveSettings();
            })
        )
        .addItem((item: any) =>
          item
            .setSection('settings')
            .setIcon('lucide-at-sign')
            .setTitle(t('Show citekey suggestions'))
            .setChecked(!!settings.enableCiteKeyCompletion)
            .onClick(() => {
              this.settings.enableCiteKeyCompletion =
                !settings.enableCiteKeyCompletion;
              this.saveSettings();
            })
        )
        .addItem((item: any) =>
          item
            .setSection('actions')
            .setIcon('lucide-rotate-cw')
            .setTitle(t('Refresh bibliography'))
            .onClick(async () => {
              const activeView =
                this.app.workspace.getActiveViewOfType(MarkdownView);
              const file = activeView?.file || this.lastActiveFile;
              if (file) {
                if (this.bibManager.fileCache.has(file)) {
                  const cache = this.bibManager.fileCache.get(file);
                  if (cache.source !== this.bibManager) {
                    this.bibManager.fileCache.delete(file);
                    this.processReferences();
                    return;
                  }
                }
              }

              this.bibManager.reinit(true);
              await this.bibManager.initPromise.promise;
              this.processReferences();
            })
        );

      const rect = ico.getBoundingClientRect();
      menu.onHide(() => {
        isOpen = false;
      });
      menu.setParentElement(ico).showAtPosition({
        x: rect.x,
        y: rect.top - 5,
        width: rect.width,
        overlap: true,
        left: false,
      });
      isOpen = true;
    });
  }

  setStatusBarLoading() {
    this.statusBarIcon.addClass('is-loading');
    setIcon(this.statusBarIcon, 'lucide-loader');
  }

  setStatusBarIdle() {
    this.statusBarIcon.removeClass('is-loading');
    setIcon(this.statusBarIcon, 'lucide-at-sign');
  }

  get view(): ReferenceListView | null {
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    if (!leaves?.length) return null;
    const view = leaves[0].view;
    if (view.getViewType() === viewType) {
      return view as ReferenceListView;
    }
    return null;
  }

  async initLeaf(): Promise<ReferenceListView | null> {
    if (this.view) {
      this.revealLeaf();
      return this.view;
    }

    await this.app.workspace.getRightLeaf(false).setViewState({
      type: viewType,
    });

    this.revealLeaf();

    await this.initPromise.promise;
    await this.bibManager.initPromise.promise;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.lastActiveFile = activeView.file;
    }
    this.processReferences();
    return this.view;
  }

  revealLeaf() {
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    if (!leaves?.length) return;
    this.app.workspace.revealLeaf(leaves[0]);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // NOTE: do not call syncIndexSettings() here — the indexers are created
    // in onload() *after* loadSettings(), so they do not exist yet.
  }

  /** Push the current indexing-related settings into the indexers so changes
   *  take effect immediately (no plugin reload needed). */
  private syncIndexSettings() {
    if (!this.ragIndexer || !this.semanticIndexer) return;
    const followSymlinks = this.settings.indexFollowSymlinks !== false;
    const excludeFolders = this.settings.indexExcludeFolders || [];
    this.ragIndexer.updateOptions({ followSymlinks, excludeFolders });
    this.semanticIndexer.updateSettings({
      enabled: !!this.settings.enableNativeSemantic,
      apiUrl: this.settings.semanticEmbedApiUrl || '',
      apiKey: this.settings.semanticEmbedApiKey || '',
      model: this.settings.semanticEmbedModel || '',
      indexLocation: (this.settings.semanticIndexLocation || 'vault') === 'local' ? 'local' : 'vault',
      followSymlinks,
      excludeFolders,
    });
  }

  async saveSettings(cb?: () => void) {
    this.syncIndexSettings();
    document.body.toggleClass(
      'pwc-tooltips',
      !!this.settings.showCitekeyTooltips
    );

    // Refresh the reference list when settings change
    this.emitSettingsUpdate(cb);
    await this.saveData(this.settings);
  }

  emitSettingsUpdate = debounce(
    (cb?: () => void) => {
      if (this.initPromise.settled) {
        this.view?.contentEl.toggleClass(
          'collapsed-links',
          !!this.settings.hideLinks
        );

        cb && cb();

        this.processReferences();
      }
    },
    5000,
    true
  );

  processReferences = async () => {
    debugLog('Main', 'processReferences started');
    const { settings, view } = this;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = activeView?.file || this.lastActiveFile;

    let bib: HTMLElement | null = null;

    if (file) {
      debugLog('Main', 'file found', file.path);
      try {
        const fileContent = await this.app.vault.cachedRead(file);
        debugLog('Main', 'fileContent read', { length: fileContent.length });
        bib = await this.bibManager.getReferenceList(file, fileContent);
        debugLog('Main', 'getReferenceList finished', { hasBib: !!bib });
      } catch (e) {
        debugLog('Main', 'error in processReferences', e);
        console.error(e);
      }
    }

    if (view && view.mode === 'current') {
      const currentContent = view.contentEl.querySelector('.pwc-view-content');
      if (
        currentContent &&
        bib &&
        currentContent.innerHTML === bib.innerHTML
      ) {
        debugLog('Main', 'Content unchanged, skipping update');
        return;
      }
    }

    if (view && view.mode === 'all') {
      if (view.showAddSection) {
        return;
      }
      // Never blow away an active search: the panel then shows search results
      // (full-text / semantic / rerank hits), which do not depend on the active
      // note at all. Re-rendering here made results visibly flash and reset
      // scroll position while the user was reading them.
      if (view.searchQuery && view.searchQuery.trim()) {
        return;
      }
      if (typeof view.setViewContent === 'function') {
        view.setViewContent(null);
      }
      return;
    }

    if (!settings.pathToBibliography && !settings.pullFromZotero) {
      debugLog('Main', 'no bibliography configured');
      if (view && typeof view.setMessage === 'function') {
        view.setMessage(
          t(
            'Please provide the path to your pandoc compatible bibliography file in the Bib Manager plugin settings.'
          )
        );
      }
      return;
    }

    if (file) {
      const cache = this.bibManager.fileCache.get(file);
      if (
        !bib &&
        cache?.source === this.bibManager &&
        settings.pullFromZotero &&
        !(await isZoteroRunning(settings.zoteroPort)) &&
        this.bibManager.fileCache.get(file)?.keys.size
      ) {
        debugLog('Main', 'cannot connect to Zotero');
        if (view && typeof view.setMessage === 'function') {
          view.setMessage(t('Cannot connect to Zotero'));
        }
      } else {
        debugLog('Main', 'setting view content');
        if (view && typeof view.setViewContent === 'function') {
          view.setViewContent(bib);
        }
      }
    } else {
      debugLog('Main', 'no activeView or lastActiveFile found');
      if (view && typeof view.setNoContentMessage === 'function') {
        view.setNoContentMessage();
      }
    }
  };

  processReferencesDebounced = debounce(
    this.processReferences.bind(this),
    1000,
    false
  );

  /**
   * Checks if an entry exists in the library by title or DOI.
   * @param title The title of the literature
   * @param doi Optional DOI
   */
  public isEntryExists(title: string, doi?: string): boolean {
    return this.getMatchedKey(title, doi) !== null;
  }

  /**
   * Gets the BibTeX key for a matched entry.
   * @param title The title of the literature
   * @param doi Optional DOI
   */
  public getMatchedKey(title: string, doi?: string): string | null {
    const queryKey = `${title}|${doi}`;
    if (this.lastMatchQuery === queryKey) {
      return this.lastMatchResult;
    }

    debugLog('Main', 'getMatchedKey called', { title, doi });
    let result: string | null = null;

    // 1. Try matching by DOI if provided (O(1) via index)
    if (doi) {
      const cleanDoi = doi.trim().toLowerCase();
      const key = this.bibManager.doiToKey.get(cleanDoi);
      if (key) {
        debugLog('Main', 'Match found by DOI index', key);
        result = key;
      }
    }

    // 2. Try matching by exact title (O(1) via index)
    if (!result && title) {
      const cleanTitle = title.trim().toLowerCase();
      const key = this.bibManager.titleToKey.get(cleanTitle);
      if (key) {
        debugLog('Main', 'Match found by title index', key);
        result = key;
      }
    }

    this.lastMatchQuery = queryKey;
    this.lastMatchResult = result;
    return result;
  }

  /**
   * Focuses and displays a specific BibTeX entry in the Bib Manager view.
   * @param key The BibTeX citation key (e.g., "Smith2023")
   * @param title Optional title for fallback matching
   */
  public async focusEntry(key: string, title?: string) {
    debugLog('Main', 'focusEntry called', { key, title });
    await this.activateView();

    let entry = this.bibManager.bibCache.get(key);

    if (!entry && title) {
      debugLog('Main', 'Entry not found by key, trying exact title search', title);
      const cleanTitle = title.trim().toLowerCase();
      const matchedKey = this.bibManager.titleToKey.get(cleanTitle);
      if (matchedKey) {
        entry = this.bibManager.bibCache.get(matchedKey);
        debugLog('Main', 'Entry found by exact title search', entry?.id);
      }
    }

    if (entry) {
      debugLog('Main', 'Revealing entry', entry.id);
      this.view?.revealEntry(entry);
    } else {
      debugLog('Main', 'Entry not found', { key, title });
      new Notice(`Entry ${key} not found in library.`);
    }
  }

  public async activateView() {
    await this.initLeaf();
  }
}
