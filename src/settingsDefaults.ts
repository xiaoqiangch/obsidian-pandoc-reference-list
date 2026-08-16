/**
 * Lightweight settings module (no React / react-select / CSL lists).
 *
 * Kept separate from settings.tsx so the plugin's startup path only has to
 * evaluate a few kilobytes instead of pulling in react-dom, react-select and
 * the ~16k-line CSL style list. The heavy settings UI is loaded lazily the
 * first time the user actually opens the settings tab.
 */

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
  /** Seconds between automatic Zotero polls (0 disables). New entries and
   *  newly added attachments are picked up on the next poll. */
  zoteroRefreshInterval?: number;

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

export const DEFAULT_SETTINGS: ReferenceListSettings = {
  pathToPandoc: '',
  tooltipDelay: 400,
  zoteroGroups: [],
  zoteroRefreshInterval: 30,
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
