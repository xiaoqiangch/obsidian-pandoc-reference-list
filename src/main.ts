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
import {
  DEFAULT_SETTINGS,
  ReferenceListSettings,
  ReferenceListSettingsTab,
} from './settings';
import { TooltipManager } from './tooltip';
import { ReferenceListView, viewType } from './view';
import { PromiseCapability, fixPath, getVaultRoot, debugLog } from './helpers';
import path from 'path';
import { BibManager } from './bib/bibManager';
import { CiteSuggest } from './citeSuggest/citeSuggest';
import { isZoteroRunning } from './bib/helpers';
import * as fs from 'fs';

export default class ReferenceList extends Plugin {
  settings: ReferenceListSettings;
  emitter: Events;
  tooltipManager: TooltipManager;
  cacheDir: string;
  bibManager: BibManager;
  _initPromise: PromiseCapability<void>;
  lastActiveFile: TFile | null = null;

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
    this.initPromise.promise
      .then(() => {
        debugLog('Main', 'initPromise.then started');
        if (this.settings.pullFromZotero) {
          debugLog('Main', 'pulling from Zotero');
          return this.bibManager.loadAndRefreshGlobalZBib();
        } else {
          debugLog('Main', 'loading global bib file');
          return this.bibManager.loadGlobalBibFile();
        }
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

    // Safety timeout for bibManager initialization
    setTimeout(() => {
      if (!this.bibManager.initPromise.settled) {
        debugLog('Main', 'bibManager initPromise timed out, resolving anyway');
        this.bibManager.initPromise.resolve();
      }
    }, 60000);

    this.addSettingTab(new ReferenceListSettingsTab(this));
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

    // No need to block execution
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

    document.body.toggleClass(
      'pwc-tooltips',
      !!this.settings.showCitekeyTooltips
    );

    this.registerEvent(
      app.metadataCache.on(
        'changed',
        debounce(
          async (file) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            const currentFile = activeView?.file || this.lastActiveFile;
            if (currentFile && file === currentFile) {
              this.processReferences();
            }
          },
          500,
          false
        )
      )
    );

    this.registerEvent(
      app.workspace.on('editor-change', () => {
        this.processReferencesDebounced();
      })
    );

    this.registerEvent(
      app.vault.on('modify', (file) => {
        if (
          file instanceof TFile &&
          (file.extension === 'bib' ||
            file.extension === 'json' ||
            file.extension === 'yaml')
        ) {
          this.bibManager.reinit(true).then(() => this.processReferences());
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
      this.registerObsidianProtocolHandler('bib-shower-add', async (params) => {
        const content = params.content;
        if (!content) return;

        const view = await this.initLeaf();
        if (view) {
          view.processExternalText(content);
        }
      });
    } catch (e) {
      console.warn('ReferenceList: Protocol handler already registered');
    }

    // Hot Reload logic
    this.initHotReload();
  }

  initHotReload() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const pluginDir = path.join(adapter.getBasePath(), this.manifest.dir);
    const hotReloadFile = path.join(pluginDir, '.hotreload');

    if (fs.existsSync(hotReloadFile)) {
      console.log('Bib Shower: Hot reload enabled');
      // Watch the directory instead of the file for better reliability
      fs.watch(pluginDir, (eventType, filename) => {
        if (filename === 'main.js' && eventType === 'change') {
          // Use a larger delay to ensure the file is fully written and Obsidian has time to process
          setTimeout(async () => {
            try {
              // @ts-ignore
              await this.app.plugins.disablePlugin(this.manifest.id);
              // @ts-ignore
              await this.app.plugins.enablePlugin(this.manifest.id);
              console.log('Bib Shower: Hot reloaded');
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
  }

  statusBarIcon: HTMLElement;
  initStatusBar() {
    const ico = (this.statusBarIcon = this.addStatusBarItem());
    ico.addClass('pwc-status-icon', 'clickable-icon');
    ico.setAttr('aria-label', t('Pandoc reference list settings'));
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
  }

  async saveSettings(cb?: () => void) {
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

    if (view && view.mode === 'all') {
      view.setViewContent(null);
      return;
    }

    if (!settings.pathToBibliography && !settings.pullFromZotero) {
      debugLog('Main', 'no bibliography configured');
      return view?.setMessage(
        t(
          'Please provide the path to your pandoc compatible bibliography file in the Bib Shower plugin settings.'
        )
      );
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
        view?.setMessage(t('Cannot connect to Zotero'));
      } else {
        debugLog('Main', 'setting view content');
        view?.setViewContent(bib);
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
    500,
    false
  );
}
