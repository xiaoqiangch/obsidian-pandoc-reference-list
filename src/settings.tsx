import { Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import which from 'which';

import { t } from './lang/helpers';
import { debugLog } from './helpers';
import { testEmbeddingConnection } from './rag/embedding';
import { testRerankConnection, resolveRerankSettings } from './rag/rerank';
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
import {
  collectAttachmentStats,
  runBatchConversion,
  getBatchProgress,
  AttachmentStat,
} from './converter/convertAll';

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
  mineruApiToken: '',
  enableRagSearch: true,
  ragSnippetLength: 180,
  ragMinTermCoverage: 1,
  indexFollowSymlinks: true,
  indexExcludeFolders: ['node_modules', '.yarn', 'bower_components'],
  enableNativeSemantic: false,
  semanticIndexLocation: 'vault',
  semanticEmbedApiUrl: 'http://localhost:11434/v1',
  semanticEmbedApiKey: '',
  semanticEmbedModel: 'bge-m3',
  semanticChunkSize: 1200,
  semanticChunkOverlap: 120,
  semanticTopK: 20,
  semanticMinScore: 0.3,
  rerankApiKey: '',
  rerankCandidateCount: 30,
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
  mineruApiToken: string;
  enableRagSearch?: boolean;
  ragSnippetLength?: number;
  ragMinTermCoverage?: number;
  /** Index files inside folders that are symbolic links (default true). */
  indexFollowSymlinks?: boolean;
  /** Folder names whose content is never indexed (e.g. node_modules). */
  indexExcludeFolders?: string[];
  enableNativeSemantic?: boolean;
  /** Where the semantic embedding index is stored: 'vault' (inside the Obsidian
   *  vault, synced with the vault) or 'local' (~/.bib-manager-index). */
  semanticIndexLocation?: 'vault' | 'local';
  semanticEmbedApiUrl?: string;
  semanticEmbedApiKey?: string;
  semanticEmbedModel?: string;
  semanticChunkSize?: number;
  semanticChunkOverlap?: number;
  semanticTopK?: number;
  semanticMinScore?: number;
  rerankApiKey?: string;
  rerankCandidateCount?: number;
}

export class ReferenceListSettingsTab extends PluginSettingTab {
  plugin: ReferenceList;
  private semanticStatusTimer: number | null = null;
  private batchStatusTimer: number | null = null;

  constructor(plugin: ReferenceList) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.semanticStatusTimer !== null) {
      window.clearInterval(this.semanticStatusTimer);
      this.semanticStatusTimer = null;
    }
    if (this.batchStatusTimer !== null) {
      window.clearInterval(this.batchStatusTimer);
      this.batchStatusTimer = null;
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
      .setName(t('MinerU API Token'))
      .setDesc(t('API token for MinerU PDF conversion. Create it on the API Management page at mineru.net. When the cloud quota is unavailable, conversion automatically falls back to the locally-installed mineru CLI.'))
      .addText((text) =>
        text
          .setPlaceholder('mineru_...')
          .setValue(this.plugin.settings.mineruApiToken)
          .onChange((value) => {
            this.plugin.settings.mineruApiToken = value.trim();
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
      .setName('索引符号链接文件夹')
      .setDesc('对符号链接（Symbolic Link）指向的文件夹内的文件也进行索引。默认开启；关闭后将跳过通过符号链接引入的外部文件夹。改动后需点击下方“重建索引”。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.indexFollowSymlinks !== false)
          .onChange(async (value) => {
            this.plugin.settings.indexFollowSymlinks = value;
            await this.plugin.saveSettings();
            new Notice('已更新符号链接索引设置，请在下方“重建索引”处重建索引。');
          })
      );

    new Setting(containerEl)
      .setName('排除索引的文件夹')
      .setDesc('以下名称的文件夹（含其所有子目录）不参与索引，多个用逗号分隔。默认已排除 node_modules、.yarn、bower_components。改动后需重建索引。')
      .addText((text) =>
        text
          .setPlaceholder('node_modules, .yarn, bower_components')
          .setValue((this.plugin.settings.indexExcludeFolders || []).join(', '))
          .onChange(async (value) => {
            this.plugin.settings.indexExcludeFolders = value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('原生语义检索（向量嵌入）')
      .setDesc('启用后，检索结果会额外叠加“语义命中”分组：对全库 markdown 分块建立向量索引，可按语义而非仅关键词匹配。默认指向本地 Ollama 的 bge-m3（OpenAI 兼容 /v1/embeddings 接口）。')
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.enableNativeSemantic)
          .onChange((value) => {
            this.plugin.settings.enableNativeSemantic = value;
            this.plugin.saveSettings();
            // Re-probe so toggling on immediately resumes maintenance even
            // when the startup probe previously marked the service unavailable.
            if (value) {
              this.plugin.reprobeSemanticIndex();
            }
          })
      );

    new Setting(containerEl)
      .setName('语义索引存放位置')
      .setDesc('嵌入索引文件的存储位置：仓库内 .bib-manager/（随 iCloud 同步共享——建议由配有 Ollama 嵌入服务的设备构建，其他无嵌入服务的设备会自动只读加载同步索引，不会重建/覆盖）或本地 ~/.bib-manager-index（仅本机，多设备各自构建）。切换后需在下方“重建语义索引”。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('vault', 'Obsidian 仓库内（.bib-manager/，随 iCloud 共享）')
          .addOption('local', '本地 ~/.bib-manager-index（仅本机）')
          .setValue(this.plugin.settings.semanticIndexLocation || 'vault')
          .onChange(async (value) => {
            const next = value === 'local' ? 'local' : 'vault';
            if (next === this.plugin.settings.semanticIndexLocation) return;
            this.plugin.settings.semanticIndexLocation = next;
            await this.plugin.saveSettings();
            new Notice('已切换语义索引存储位置，请在下方点击“重建语义索引”。');
          })
      );

    new Setting(containerEl)
      .setName('嵌入 API 地址')
      .setDesc('OpenAI 兼容嵌入接口基地址。本地 Ollama：http://localhost:11434/v1；火山方舟：https://ark.cn-beijing.volces.com/api/v3（Embedding 需 /api/v3 而非套餐 /api/plan/v3）。')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:11434/v1')
          .setValue(this.plugin.settings.semanticEmbedApiUrl || '')
          .onChange((value) => {
            this.plugin.settings.semanticEmbedApiUrl = value;
            this.plugin.saveSettings();
            this.plugin.reprobeSemanticIndex();
          })
      );

    new Setting(containerEl)
      .setName('嵌入 API Key')
      .setDesc('云端服务需要（如火山方舟）；本地 Docker 服务可留空。')
      .addText((text) =>
        text
          .setPlaceholder('本地 Docker 可留空')
          .setValue(this.plugin.settings.semanticEmbedApiKey || '')
          .onChange((value) => {
            this.plugin.settings.semanticEmbedApiKey = value.trim();
            this.plugin.saveSettings();
            this.plugin.reprobeSemanticIndex();
          })
      );

    new Setting(containerEl)
      .setName('嵌入模型')
      .setDesc('本地 Ollama：bge-m3；火山方舟：doubao-embedding-large-text-240915 等。')
      .addText((text) =>
        text
          .setPlaceholder('bge-m3')
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
      button.setIcon('plug').setTooltip('测试连接').onClick(async () => {
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
        .setIcon('list-numbers')
        .setTooltip('统计待嵌入')
        .onClick(() => {
          const pending = this.plugin.semanticIndexer.countPendingFiles();
          new Notice(
            pending > 0
              ? `还有 ${pending} 个文件需要嵌入。`
              : '索引已是最新，无需嵌入。'
          );
        })
    );
    semanticStatus.addButton((button) =>
      button
        .setIcon('play')
        .setTooltip('增量更新')
        .onClick(() => {
          this.plugin.updateSemanticIndex();
        })
    );
    semanticStatus.addButton((button) =>
      button
        .setIcon('wrench')
        .setTooltip('重建语义索引')
        .setWarning()
        .onClick(() => {
          this.plugin.rebuildSemanticIndex();
        })
    );

    const renderSemanticStatus = () => {
      const idx = this.plugin.semanticIndexer;
      semanticStatus.descEl.empty();
      const total = idx.eligibleTotal > 0 ? idx.eligibleTotal : idx.countEligibleFiles();
      const indexed = idx.index.docCount;
      if (idx.building && idx.progress) {
        const p = idx.progress;
        const batchPct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        const overallPct = total > 0 ? Math.round((indexed / total) * 100) : 0;
        semanticStatus.descEl.createDiv({
          cls: 'pwc-semantic-progress-text',
          text: `正在嵌入：批次 ${p.done}/${p.total} 个文件（${batchPct}%）${
            p.failed > 0 ? `，已跳过 ${p.failed} 个` : ''
          }`,
        });
        const bar = semanticStatus.descEl.createDiv({
          cls: 'pwc-conversion-progress-bar',
        });
        bar.createDiv({ cls: 'pwc-conversion-progress-bar-fill' }).style.width = `${batchPct}%`;
        if (p.path) {
          semanticStatus.descEl.createDiv({
            cls: 'pwc-semantic-progress-path',
            text: p.path,
          });
        }
        semanticStatus.descEl.createDiv({
          cls: 'pwc-semantic-progress-text',
          text: `整体进度：${indexed}/${total} 个文件（${overallPct}%）`,
        });
      } else {
        const overallPct = total > 0 ? Math.round((indexed / total) * 100) : 0;
        semanticStatus.descEl.createDiv({
          text: `已索引 ${indexed} 个文件 / ${idx.index.chunkCount} 个分块${
            idx.enabled ? '' : '（语义检索未启用）'
          }${idx.failedCount > 0 ? `（上次构建跳过 ${idx.failedCount} 个失败文件）` : ''}。`,
        });
        if (idx.pendingCount >= 0) {
          semanticStatus.descEl.createDiv({
            cls: 'pwc-semantic-pending-count',
            text:
              idx.pendingCount > 0
                ? `整体进度 ${overallPct}%（${indexed}/${total}），还有 ${idx.pendingCount} 个文件待嵌入。`
                : '索引已是最新，无需嵌入。',
          });
        }
        semanticStatus.descEl.createDiv({
          cls: 'pwc-semantic-status-hint',
          text: '语义索引自动维护：启动时自动构建/增量更新，新增或修改文件后自动同步嵌入（本地 Ollama 免费）。如需手动全量重建可点下方“重建语义索引”。索引缓存存于本机（不随 iCloud 同步），换电脑后需在本机重建一次。',
        });
      }
    };
    renderSemanticStatus();
    if (this.semanticStatusTimer !== null) {
      window.clearInterval(this.semanticStatusTimer);
    }
    // Refresh the pending/overall counts every few seconds so the displayed
    // numbers track the background drain (countPendingFiles walks the vault
    // file list, so it is throttled instead of run on every 500ms tick).
    let lastPendingRefresh = 0;
    this.semanticStatusTimer = window.setInterval(() => {
      const now = Date.now();
      if (now - lastPendingRefresh > 5000) {
        lastPendingRefresh = now;
        this.plugin.semanticIndexer.countPendingFiles();
      }
      renderSemanticStatus();
    }, 500);

    // ---- 批量转换（所有附件）----
    new Setting(containerEl).setName('批量转换（PDF/EPUB → MD）').setHeading();

    const batchSetting = new Setting(containerEl)
      .setName('附件转换统计')
      .setDesc('统计当前文献库中所有 PDF/EPUB 附件的转换状态。统计完成后可一键批量转换。');

    let batchStats: AttachmentStat | null = null;
    let batchStatsLoading = false;

    /**
     * Repaint the description from the last collected stats. Kept separate from
     * collection so the 500ms progress ticker can refresh the batch progress
     * bar without re-running the (whole-library, fs-touching) stats scan, and
     * so "刷新统计" can show a "统计中..." state and thus visibly acknowledge
     * the click even when the resulting numbers are unchanged.
     */
    const paintBatchStats = () => {
      batchSetting.descEl.empty();
      const b = getBatchProgress();
      const st = batchStats;
      if (batchStatsLoading) {
        batchSetting.descEl.createDiv({
          cls: 'pwc-semantic-status-hint',
          text: '统计中...',
        });
      } else if (st) {
        batchSetting.descEl.createDiv({
          cls: 'pwc-semantic-status-hint',
          text: `共 ${st.total} 条文献：已转换 ${st.converted}，待转换 ${st.pending}，进行中 ${st.inProgress}，无附件 ${st.noAttachment}。`,
        });
      } else {
        batchSetting.descEl.createDiv({
          cls: 'pwc-semantic-status-hint',
          text: '统计失败：请确认文献库已加载。',
        });
      }
      if (b.running) {
        const pct = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;
        batchSetting.descEl.createDiv({
          cls: 'pwc-semantic-progress-text',
          text: `批量转换中：${b.done}/${b.total}（${pct}%），失败 ${b.failed}。${
            b.currentCitekey ? `当前：${b.currentCitekey}` : ''
          }`,
        });
        const bar = batchSetting.descEl.createDiv({
          cls: 'pwc-conversion-progress-bar',
        });
        bar.createDiv({ cls: 'pwc-conversion-progress-bar-fill' }).style.width = `${pct}%`;
        if (b.pageProgress) {
          const pp = b.pageProgress;
          batchSetting.descEl.createDiv({
            cls: 'pwc-semantic-progress-path',
            text: `${pp.citekey}: ${pp.current}/${pp.total} ${pp.message || ''}`,
          });
        }
      }
    };

    const renderBatchStats = async () => {
      batchStatsLoading = true;
      paintBatchStats();
      try {
        batchStats = await collectAttachmentStats(this.plugin);
      } catch (e: any) {
        debugLog('Settings', 'collectAttachmentStats failed', { error: e.message });
        batchStats = null;
      }
      batchStatsLoading = false;
      paintBatchStats();
    };

    batchSetting.addButton((button) =>
      button.setIcon('refresh-cw').setTooltip('刷新统计').onClick(async () => {
        button.setDisabled(true);
        try {
          await renderBatchStats();
          const st = batchStats;
          new Notice(
            st
              ? `统计完成：已转换 ${st.converted}，待转换 ${st.pending}，进行中 ${st.inProgress}，无附件 ${st.noAttachment}（共 ${st.total}）。`
              : '统计失败：请确认文献库已加载。'
          );
        } finally {
          button.setDisabled(false);
        }
      })
    );

    batchSetting.addButton((button) =>
      button
        .setIcon('zap')
        .setTooltip('一键批量转换（仅待转换附件）')
        .setCta()
        .onClick(async () => {
          const b = getBatchProgress();
          if (b.running) {
            new Notice('批量转换已在进行中。');
            return;
          }
          await runBatchConversion(this.plugin);
          await renderBatchStats();
        })
    );

    batchSetting.addButton((button) =>
      button
        .setIcon('rotate-ccw')
        .setTooltip('转换全部（含已转换）')
        .setWarning()
        .onClick(async () => {
          const b = getBatchProgress();
          if (b.running) {
            new Notice('批量转换已在进行中。');
            return;
          }
          const { forceReconvertAll } = await import('./converter/convertAll');
          await forceReconvertAll(this.plugin);
          await renderBatchStats();
        })
    );

    renderBatchStats();
    if (this.batchStatusTimer !== null) {
      window.clearInterval(this.batchStatusTimer);
    }
    // The ticker only repaints (cheap). Re-collecting stats every 500ms meant a
    // full-library scan with an fs.existsSync per entry twice a second, and it
    // also made the "刷新统计" button look broken: the panel was already being
    // rewritten constantly, so a click produced no visible change.
    this.batchStatusTimer = window.setInterval(() => {
      if (getBatchProgress().running) paintBatchStats();
    }, 500);

    new Setting(containerEl).setName('交叉编码重排序（Rerank）').setHeading();

    new Setting(containerEl)
      .setName('重排序 API Key')
      .setDesc('阿里云百炼（DashScope）API Key。服务地址、模型等已内置硬编码，无需配置。')
      .addText((text) =>
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.rerankApiKey || '')
          .onChange((value) => {
            this.plugin.settings.rerankApiKey = value.trim();
            this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('重排序候选数')
      .setDesc('每次检索交给重排模型的候选片段数量（全文 + 语义合并去重后取前 N）。')
      .addSlider((slider) =>
        slider
          .setLimits(10, 80, 5)
          .setValue(this.plugin.settings.rerankCandidateCount || 30)
          .onChange((value) => {
            this.plugin.settings.rerankCandidateCount = value;
            this.plugin.saveSettings();
          })
      );

    const rerankTest = new Setting(containerEl).setName('重排序连接测试');
      rerankTest.addButton((button) =>
      button.setButtonText('测试重排序').onClick(async () => {
        try {
          const n = await testRerankConnection(
            '数字经济的增长效应',
            ['数字经济对区域增长的影响研究。', '二十四桥明月夜，玉人何处教吹箫。', 'climate change and agriculture'],
            resolveRerankSettings({
              apiKey: this.plugin.settings.rerankApiKey || '',
            })
          );
          new Notice(`重排序连接正常（返回 ${n} 条）`);
        } catch (e: any) {
          new Notice(`连接失败：${e.message}`);
        }
      })
    );

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

    new Setting(containerEl)
      .setName('关键词命中覆盖率')
      .setDesc(
        '英文多词查询时，命中结果必须包含的英文词比例（1 = 全部英文词都需命中）。中文按 Obsidian 全文检索语义整串匹配：搜“二十四桥”只会命中真的包含“二十四桥”的文件，不再拆成 bigram 命中“二十”。'
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 1, 0.05)
          .setValue(this.plugin.settings.ragMinTermCoverage ?? 1)
          .onChange((value) => {
            this.plugin.settings.ragMinTermCoverage = value;
            this.plugin.saveSettings();
          })
          .setDynamicTooltip()
      );
  }
}
