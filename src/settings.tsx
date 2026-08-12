import { Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import which from 'which';

import { t } from './lang/helpers';
import { testEmbeddingConnection } from './rag/embedding';
import ReferenceList from './main';
import ReactDOM from 'react-dom';
import React from 'react';
import { SettingItem } from './settings/SettingItem';
import AsyncSelect from 'react-select/async';
import {
  NoOptionMessage,
  customSelectStyles,
  loadCSLLangOptions,
  loadCSLOptions,
} from './settings/select.helpers';
import { cslListRaw } from './bib/cslList';
import { langListRaw } from './bib/cslLangList';
import { ZoteroPullSetting } from './settings/ZoteroPullSetting';

export const DEFAULT_SETTINGS: ReferenceListSettings = {
  pathToPandoc: '',
  tooltipDelay: 400,
  zoteroGroups: [],
  renderCitations: true,
  renderCitationsReadingMode: true,
  renderLinkCitations: true,
  bibliographyPaths: [],
  enableCiteKeyCompletion: true,
  showCitekeyTooltips: true,
  deepseekApiUrl: 'https://api.deepseek.com/v1',
  deepseekApiKey: '',
  attachmentDirectory: '',
  browserDownloadDirectory: '',
  convertOutputPath: 'literature',
  convertModelApiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  convertModelApiKey: '',
  convertModelName: 'doubao-seed-2-0-lite-260428',
  convertEngine: 'mineru',
  mineruApiToken: '',
  mineruModelVersion: 'vlm',
  enableRagSearch: true,
  ragSnippetLength: 180,
  enableNativeSemantic: false,
  semanticEmbedApiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  semanticEmbedApiKey: '',
  semanticEmbedModel: 'doubao-embedding-large-text-240915',
  semanticChunkSize: 1200,
  semanticChunkOverlap: 120,
  semanticTopK: 20,
  semanticMinScore: 0.3,
};

export interface ZoteroGroup {
  id: number;
  name: string;
  lastUpdate?: number;
}

export interface ReferenceListSettings {
  pathToPandoc: string;
  pathToBibliography?: string;
  bibliographyPaths: string[];

  cslStyleURL?: string;
  cslStylePath?: string;
  cslLang?: string;

  hideLinks?: boolean;
  showCitekeyTooltips?: boolean;
  tooltipDelay: number;
  enableCiteKeyCompletion?: boolean;
  renderCitations?: boolean;
  renderCitationsReadingMode?: boolean;
  renderLinkCitations?: boolean;

  pullFromZotero?: boolean;
  zoteroPort?: string;
  zoteroGroups: ZoteroGroup[];

  deepseekApiUrl: string;
  deepseekApiKey: string;
  attachmentDirectory: string;
  browserDownloadDirectory: string;
  convertOutputPath: string;
  convertModelApiUrl: string;
  convertModelApiKey: string;
  convertModelName: string;
  convertEngine: 'mineru' | 'llm';
  mineruApiToken: string;
  mineruModelVersion: string;
  enableRagSearch?: boolean;
  ragSnippetLength?: number;
  enableNativeSemantic?: boolean;
  semanticEmbedApiUrl?: string;
  semanticEmbedApiKey?: string;
  semanticEmbedModel?: string;
  semanticChunkSize?: number;
  semanticChunkOverlap?: number;
  semanticTopK?: number;
  semanticMinScore?: number;
}

export class ReferenceListSettingsTab extends PluginSettingTab {
  plugin: ReferenceList;
  private semanticStatusTimer: number | null = null;

  constructor(plugin: ReferenceList) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.semanticStatusTimer !== null) {
      window.clearInterval(this.semanticStatusTimer);
      this.semanticStatusTimer = null;
    }
    super.hide();
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName(t('Fallback path to Pandoc'))
      .setDesc(
        t(
          "The absolute path to the Pandoc executable. This plugin will attempt to locate pandoc for you and will use this path if it fails to do so. To find pandoc, use the output of 'which pandoc' in a terminal on Mac/Linux or 'Get-Command pandoc' in powershell on Windows."
        )
      )
      .then((setting) => {
        let input: TextComponent;
        setting.addText((text) => {
          input = text;
          text.setValue(this.plugin.settings.pathToPandoc).onChange((value) => {
            this.plugin.settings.pathToPandoc = value;
            this.plugin.saveSettings();
          });
        });

        setting.addExtraButton((b) => {
          b.setIcon('magnifying-glass');
          b.setTooltip(t('Attempt to find Pandoc automatically'));
          b.onClick(() => {
            which('pandoc')
              .then((pathToPandoc) => {
                if (pathToPandoc) {
                  input.setValue(pathToPandoc);

                  this.plugin.settings.pathToPandoc = pathToPandoc;
                  this.plugin.saveSettings();
                } else {
                  new Notice(
                    t(
                      'Unable to find pandoc on your system. If it is installed, please manually enter a path.'
                    )
                  );
                }
              })
              .catch((e) => {
                new Notice(
                  t(
                    'Unable to find pandoc on your system. If it is installed, please manually enter a path.'
                  )
                );
                console.error(e);
              });
          });
        });
      });

    new Setting(containerEl)
      .setName(t('Path to bibliography file'))
      .setDesc(
        t(
          'The absolute path to your desired bibliography file. This can be overridden on a per-file basis by setting "bibliography" in the file\'s frontmatter.'
        )
      )
      .then((setting) => {
        let input: TextComponent;
        setting.addText((text) => {
          input = text;
          text
            .setValue(this.plugin.settings.pathToBibliography)
            .onChange((value) => {
              const prev = this.plugin.settings.pathToBibliography;
              this.plugin.settings.pathToBibliography = value;
              this.plugin.saveSettings(() => {
                this.plugin.bibManager.clearWatcher(prev);
                this.plugin.bibManager.reinit(true);
              });
            });
        });

        setting.addExtraButton((b) => {
          b.setIcon('folder');
          b.setTooltip(t('Select a bibliography file.'));
          b.onClick(() => {
            const path = require('electron').remote.dialog.showOpenDialogSync({
              properties: ['openFile'],
            });

            if (path && path.length) {
              input.setValue(path[0]);

              this.plugin.settings.pathToBibliography = path[0];
              this.plugin.saveSettings(() =>
                this.plugin.bibManager.reinit(true)
              );
            }
          });
        });
      });

    new Setting(containerEl)
      .setName(t('Additional bibliography files'))
      .setDesc(t('Add more bibliography files to be searched.'))
      .addButton((button) => {
        button
          .setButtonText(t('Add'))
          .onClick(() => {
            const path = require('electron').remote.dialog.showOpenDialogSync({
              properties: ['openFile'],
            });

            if (path && path.length) {
              this.plugin.settings.bibliographyPaths.push(path[0]);
              this.plugin.saveSettings(() =>
                this.plugin.bibManager.reinit(true)
              );
              this.display();
            }
          });
      });

    this.plugin.settings.bibliographyPaths.forEach((bibPath, index) => {
      new Setting(containerEl)
        .setName(`${t('Bibliography')} ${index + 1}`)
        .setDesc(bibPath)
        .addExtraButton((b) => {
          b.setIcon('trash');
          b.setTooltip(t('Remove'));
          b.onClick(() => {
            this.plugin.settings.bibliographyPaths.splice(index, 1);
            this.plugin.saveSettings(() =>
              this.plugin.bibManager.reinit(true)
            );
            this.display();
          });
        });
    });

    ReactDOM.render(
      <ZoteroPullSetting plugin={this.plugin} />,
      containerEl.createDiv('setting-item pwc-setting-item-wrapper')
    );

    const defaultStyle = cslListRaw.find(
      (item) => item.value === this.plugin.settings.cslStyleURL
    );

    ReactDOM.render(
      <SettingItem name={t('Citation style')}>
        <AsyncSelect
          noOptionsMessage={NoOptionMessage}
          placeholder={t('Search...')}
          cacheOptions
          className="pwc-multiselect"
          defaultValue={defaultStyle}
          loadOptions={loadCSLOptions}
          isClearable
          onChange={(selection: any) => {
            this.plugin.settings.cslStyleURL = selection?.value;
            this.plugin.saveSettings(() =>
              this.plugin.bibManager.reinit(false)
            );
          }}
          styles={customSelectStyles}
        />
      </SettingItem>,
      containerEl.createDiv('pwc-setting-item setting-item')
    );

    new Setting(containerEl)
      .setName(t('Custom citation style'))
      .setDesc(
        t(
          'Path to a CSL file. This can be an absolute path or one relative to your vault. This will override the style selected above. This can be overridden on a per-file basis by setting "csl" or "citation-style" in the file\'s frontmatter. A URL can be supplied when setting the style via frontmatter.'
        )
      )
      .then((setting) => {
        let input: TextComponent;
        setting.addText((text) => {
          input = text;
          text.setValue(this.plugin.settings.cslStylePath).onChange((value) => {
            this.plugin.settings.cslStylePath = value;
            this.plugin.saveSettings(() =>
              this.plugin.bibManager.reinit(false)
            );
          });
        });

        setting.addExtraButton((b) => {
          b.setIcon('folder');
          b.setTooltip(t('Select a CSL file located on your computer'));
          b.onClick(() => {
            const path = require('electron').remote.dialog.showOpenDialogSync({
              properties: ['openFile'],
            });

            if (path && path.length) {
              input.setValue(path[0]);

              this.plugin.settings.cslStylePath = path[0];
              this.plugin.saveSettings(() =>
                this.plugin.bibManager.reinit(false)
              );
            }
          });
        });
      });

    const defaultLanguage = langListRaw.find(
      (item) => item.value === this.plugin.settings.cslLang
    );

    ReactDOM.render(
      <SettingItem
        name={t('Citation style language')}
        description={
          <>
            {t(
              `This can be overridden on a per-file basis by setting "lang" or "citation-language" in the file's frontmatter. A language code must be used when setting the language via frontmatter.`
            )}{' '}
            <a
              href="https://github.com/citation-style-language/locales/blob/master/locales.json"
              target="_blank"
            >
              {t('See here for a list of available language codes')}
            </a>
            .
          </>
        }
      >
        <AsyncSelect
          noOptionsMessage={NoOptionMessage}
          placeholder={t('Search...')}
          cacheOptions
          className="pwc-multiselect"
          defaultValue={defaultLanguage}
          loadOptions={loadCSLLangOptions}
          isClearable
          onChange={(selection: any) => {
            this.plugin.settings.cslLang = selection.value;
            this.plugin.saveSettings(() =>
              this.plugin.bibManager.reinit(false)
            );
          }}
          styles={customSelectStyles}
        />
      </SettingItem>,
      containerEl.createDiv('pwc-setting-item setting-item')
    );

    new Setting(containerEl)
      .setName(t('Hide links in references'))
      .setDesc(t('Replace links with link icons to save space.'))
      .addToggle((text) =>
        text.setValue(!!this.plugin.settings.hideLinks).onChange((value) => {
          this.plugin.settings.hideLinks = value;
          this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t('Render live preview inline citations'))
      .setDesc(
        t(
          'Convert [@pandoc] citations to formatted inline citations in live preview mode.'
        )
      )
      .addToggle((text) =>
        text
          .setValue(!!this.plugin.settings.renderCitations)
          .onChange((value) => {
            this.plugin.settings.renderCitations = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Render reading mode inline citations'))
      .setDesc(
        t(
          'Convert [@pandoc] citations to formatted inline citations in reading mode.'
        )
      )
      .addToggle((text) =>
        text
          .setValue(!!this.plugin.settings.renderCitationsReadingMode)
          .onChange((value) => {
            this.plugin.settings.renderCitationsReadingMode = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Process citations in links'))
      .setDesc(
        t(
          'Include [[@pandoc]] citations in the reference list and format them as inline citations in live preview mode.'
        )
      )
      .addToggle((text) =>
        text
          .setValue(!!this.plugin.settings.renderLinkCitations)
          .onChange((value) => {
            this.plugin.settings.renderLinkCitations = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Show citekey suggestions'))
      .setDesc(
        t(
          'When enabled, an autocomplete dialog will display when typing citation keys.'
        )
      )
      .addToggle((text) =>
        text
          .setValue(!!this.plugin.settings.enableCiteKeyCompletion)
          .onChange((value) => {
            this.plugin.settings.enableCiteKeyCompletion = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Show citekey tooltips'))
      .setDesc(
        t(
          'When enabled, hovering over citekeys will open a tooltip containing a formatted citation.'
        )
      )
      .addToggle((text) =>
        text
          .setValue(!!this.plugin.settings.showCitekeyTooltips)
          .onChange((value) => {
            this.plugin.settings.showCitekeyTooltips = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Tooltip delay'))
      .setDesc(
        t(
          'Set the amount of time (in milliseconds) to wait before displaying tooltips.'
        )
      )
      .addSlider((slider) => {
        slider
          .setDynamicTooltip()
          .setLimits(0, 7000, 100)
          .setValue(this.plugin.settings.tooltipDelay)
          .onChange((value) => {
            this.plugin.settings.tooltipDelay = value;
            this.plugin.saveSettings();
          });
      });

    containerEl.createEl('h3', { text: t('AI & Attachment Settings') });

    new Setting(containerEl)
      .setName(t('DeepSeek API URL'))
      .addText((text) =>
        text
          .setPlaceholder('https://api.deepseek.com/v1')
          .setValue(this.plugin.settings.deepseekApiUrl)
          .onChange((value) => {
            this.plugin.settings.deepseekApiUrl = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('DeepSeek API Key'))
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange((value) => {
            this.plugin.settings.deepseekApiKey = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Attachment directory'))
      .setDesc(t('Directory where PDF attachments are stored.'))
      .addText((text) =>
        text
          .setPlaceholder('/path/to/attachments')
          .setValue(this.plugin.settings.attachmentDirectory)
          .onChange((value) => {
            this.plugin.settings.attachmentDirectory = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Browser download directory'))
      .setDesc(t('Directory where your browser downloads files.'))
      .addText((text) =>
        text
          .setPlaceholder('/Users/name/Downloads')
          .setValue(this.plugin.settings.browserDownloadDirectory)
          .onChange((value) => {
            this.plugin.settings.browserDownloadDirectory = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Browser Bookmarklet'))
      .setDesc(t('Click the button to copy the bookmarklet to your clipboard. You can then add it as a bookmark in Safari or Edge.'))
      .addButton((btn) => {
        btn.setButtonText(t('Copy Bookmarklet')).onClick(async () => {
          const vaultName = encodeURIComponent(this.app.vault.getName());
          const bookmarklet = `javascript:(function(){var title=document.title;var url=window.location.href;var selection=window.getSelection().toString()||document.body.innerText.substring(0,2000);var content="Title: "+title+"\\nURL: "+url+"\\n\\nContent: "+selection;var obsidianUrl="obsidian://bib-manager-add?vault=${vaultName}&content="+encodeURIComponent(content);window.location.href=obsidianUrl;})();`;
          await navigator.clipboard.writeText(bookmarklet);
          new Notice(t('Bookmarklet copied to clipboard!'));
        });
      });

    containerEl.createEl('h3', { text: t('Document Conversion Settings') });

    new Setting(containerEl)
      .setName(t('Conversion output path'))
      .setDesc(t('Directory (relative to vault root) where converted markdown files and images will be saved.'))
      .addText((text) =>
        text
          .setPlaceholder('literature')
          .setValue(this.plugin.settings.convertOutputPath)
          .onChange((value) => {
            this.plugin.settings.convertOutputPath = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Conversion engine'))
      .setDesc(t('MinerU (default) handles images, formulas, tables and references accurately. The LLM vision model is kept as a backup.'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('mineru', t('MinerU (Recommended, default)'))
          .addOption('llm', t('LLM vision model (backup)'))
          .setValue(this.plugin.settings.convertEngine || 'mineru')
          .onChange((value: 'mineru' | 'llm') => {
            this.plugin.settings.convertEngine = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('MinerU API Token'))
      .setDesc(t('API token for MinerU PDF conversion. Create it on the API Management page at mineru.net.'))
      .addText((text) =>
        text
          .setPlaceholder('mineru_...')
          .setValue(this.plugin.settings.mineruApiToken)
          .onChange((value) => {
            this.plugin.settings.mineruApiToken = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('MinerU model version'))
      .setDesc(t('MinerU model version. Defaults to "vlm" which handles formulas, tables, OCR and code well.'))
      .addText((text) =>
        text
          .setPlaceholder('vlm')
          .setValue(this.plugin.settings.mineruModelVersion || 'vlm')
          .onChange((value) => {
            this.plugin.settings.mineruModelVersion = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Conversion model API URL'))
      .setDesc(t('OpenAI-compatible API URL for the LLM vision model (backup engine). Defaults to Volcengine ARK API.'))
      .addText((text) =>
        text
          .setPlaceholder('https://ark.cn-beijing.volces.com/api/v3')
          .setValue(this.plugin.settings.convertModelApiUrl)
          .onChange((value) => {
            this.plugin.settings.convertModelApiUrl = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Conversion model API Key'))
      .setDesc(t('API key for the LLM vision model (backup engine). Leave empty to use DeepSeek API Key.'))
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.convertModelApiKey)
          .onChange((value) => {
            this.plugin.settings.convertModelApiKey = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('Conversion model name'))
      .setDesc(t('Model name for the LLM vision model (backup engine). Supports any OpenAI-compatible vision model.'))
      .addText((text) =>
        text
          .setPlaceholder('doubao-seed-2-0-lite-260428')
          .setValue(this.plugin.settings.convertModelName)
          .onChange((value) => {
            this.plugin.settings.convertModelName = value;
            this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'RAG 全文检索' });

    new Setting(containerEl)
      .setName('启用 RAG 全文检索')
      .setDesc('对文献库（及全库）markdown 建立本地 BM25 索引，在文献库搜索框中可切换“文献库 / 全库”模式进行全文检索，文献库命中可定位到 PDF 原文。')
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.enableRagSearch)
          .onChange(async (value) => {
            this.plugin.settings.enableRagSearch = value;
            this.plugin.saveSettings();
            if (value) {
              new Notice('正在构建全文索引...');
              await this.plugin.ragIndexer.buildAll();
              new Notice('全文索引构建完成');
            }
          })
      );

    new Setting(containerEl)
      .setName('原生语义检索（向量嵌入）')
      .setDesc('启用后，检索结果会额外叠加“语义命中”分组：使用火山方舟文本嵌入模型对全库 markdown 分块建立向量索引，可按语义而非仅关键词匹配。')
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.enableNativeSemantic)
          .onChange((value) => {
            this.plugin.settings.enableNativeSemantic = value;
            this.plugin.saveSettings();
            if (value && this.plugin.settings.semanticEmbedApiKey) {
              this.plugin.initSemanticIndex();
            }
          })
      );

    new Setting(containerEl)
      .setName('嵌入 API 地址')
      .setDesc('火山方舟标准 API 地址（Embedding 需使用 /api/v3 而非套餐 /api/plan/v3）。')
      .addText((text) =>
        text
          .setPlaceholder('https://ark.cn-beijing.volces.com/api/v3')
          .setValue(this.plugin.settings.semanticEmbedApiUrl || '')
          .onChange((value) => {
            this.plugin.settings.semanticEmbedApiUrl = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('嵌入 API Key')
      .setDesc('火山方舟 API Key（需开通文本向量化模型；注意套餐 plan key 不支持 Embedding）。')
      .addText((text) =>
        text
          .setPlaceholder('ark 标准 API Key')
          .setValue(this.plugin.settings.semanticEmbedApiKey || '')
          .onChange((value) => {
            this.plugin.settings.semanticEmbedApiKey = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('嵌入模型')
      .addText((text) =>
        text
          .setPlaceholder('doubao-embedding-large-text-240915')
          .setValue(this.plugin.settings.semanticEmbedModel || '')
          .onChange((value) => {
            this.plugin.settings.semanticEmbedModel = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('分块大小（字符）')
      .setDesc('语义索引按此大小对文档分块嵌入。')
      .addSlider((slider) =>
        slider
          .setLimits(400, 3000, 100)
          .setValue(this.plugin.settings.semanticChunkSize || 1200)
          .onChange((value) => {
            this.plugin.settings.semanticChunkSize = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('语义命中条数')
      .setDesc('每次检索展示的语义命中数量。')
      .addSlider((slider) =>
        slider
          .setLimits(5, 60, 5)
          .setValue(this.plugin.settings.semanticTopK || 20)
          .onChange((value) => {
            this.plugin.settings.semanticTopK = value;
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('最低相似度阈值')
      .setDesc(
        '过滤掉低于此相似度的语义命中（0 表示不过滤）。用于剔除与检索词不相关的噪声结果。'
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 0.8, 0.05)
          .setValue(this.plugin.settings.semanticMinScore ?? 0.3)
          .onChange((value) => {
            this.plugin.settings.semanticMinScore = value;
            this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );

    const semanticStatus = new Setting(containerEl).setName('语义索引状态');
    semanticStatus.addButton((button) =>
      button.setButtonText('测试连接').onClick(async () => {
        try {
          const dim = await testEmbeddingConnection({
            apiUrl: this.plugin.settings.semanticEmbedApiUrl || '',
            apiKey: this.plugin.settings.semanticEmbedApiKey || '',
            model: this.plugin.settings.semanticEmbedModel || '',
          });
          new Notice(`嵌入连接正常（维度 ${dim}）`);
        } catch (e: any) {
          new Notice(`连接失败：${e.message}`);
        }
      })
    );
    semanticStatus.addButton((button) =>
      button
        .setButtonText('重建语义索引')
        .setWarning()
        .onClick(() => {
          this.plugin.rebuildSemanticIndex();
        })
    );

    const renderSemanticStatus = () => {
      const idx = this.plugin.semanticIndexer;
      semanticStatus.descEl.empty();
      if (idx.building && idx.progress) {
        const p = idx.progress;
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        semanticStatus.descEl.createDiv({
          cls: 'pwc-semantic-progress-text',
          text: `正在构建语义索引：${p.done}/${p.total} 个文件（${pct}%）${
            p.failed > 0 ? `，已跳过 ${p.failed} 个失败文件` : ''
          }`,
        });
        const bar = semanticStatus.descEl.createDiv({
          cls: 'pwc-conversion-progress-bar',
        });
        bar.createDiv({ cls: 'pwc-conversion-progress-bar-fill' }).style.width = `${pct}%`;
        if (p.path) {
          semanticStatus.descEl.createDiv({
            cls: 'pwc-semantic-progress-path',
            text: p.path,
          });
        }
      } else {
        semanticStatus.descEl.createDiv({
          text: `已索引 ${idx.index.docCount} 个文件 / ${idx.index.chunkCount} 个分块${
            idx.enabled ? '' : '（未启用或未配置 Key）'
          }${idx.failedCount > 0 ? `（上次构建跳过 ${idx.failedCount} 个失败文件）` : ''}。`,
        });
      }
    };
    renderSemanticStatus();
    if (this.semanticStatusTimer !== null) {
      window.clearInterval(this.semanticStatusTimer);
    }
    this.semanticStatusTimer = window.setInterval(renderSemanticStatus, 500);

    new Setting(containerEl)
      .setName('重建索引')
      .setDesc('清空缓存并重新索引整个仓库（首次启用或数据变化较大时使用）。')
      .addButton((button) =>
        button
          .setButtonText('立即重建')
          .onClick(async () => {
            new Notice('正在重建全文索引...');
            await this.plugin.ragIndexer.buildAll();
            new Notice('全文索引重建完成');
          })
      );

    new Setting(containerEl)
      .setName('片段长度')
      .setDesc('检索结果中显示的上下文片段最大字符数。')
      .addSlider((slider) =>
        slider
          .setLimits(80, 600, 20)
          .setValue(this.plugin.settings.ragSnippetLength || 180)
          .onChange((value) => {
            this.plugin.settings.ragSnippetLength = value;
            this.plugin.saveSettings();
          })
      );
  }
}
