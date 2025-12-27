// English

export default {
  // src/settings.ts
  'Path to bibliography file': 'Path to bibliography file',
  'The absolute path to your desired bibliography file. This can be overridden on a per-file basis by setting "bibliography" in the file\'s frontmatter.':
    'The absolute path to your desired bibliography file. This can be overridden on a per-file basis by setting "bibliography" in the file\'s frontmatter.',
  'Select a bibliography file.': 'Select a bibliography file.',
  'Custom citation style': 'Custom citation style',
  'Citation style': 'Citation style',
  'Citation style language': 'Citation style language',
  'Search...': 'Search...',
  'Path to a CSL file. This can be an absolute path or one relative to your vault. This will override the style selected above. This can be overridden on a per-file basis by setting "csl" or "citation-style" in the file\'s frontmatter. A URL can be supplied when setting the style via frontmatter.':
    'Path to a CSL file. This can be an absolute path or one relative to your vault. This will override the style selected above. This can be overridden on a per-file basis by setting "csl" or "citation-style" in the file\'s frontmatter. A URL can be supplied when setting the style via frontmatter.',
  'Select a CSL file located on your computer':
    'Select a CSL file located on your computer',
  'Fallback path to Pandoc': 'Fallback path to Pandoc',
  "The absolute path to the Pandoc executable. This plugin will attempt to locate pandoc for you and will use this path if it fails to do so. To find pandoc, use the output of 'which pandoc' in a terminal on Mac/Linux or 'Get-Command pandoc' in powershell on Windows.":
    "The absolute path to the Pandoc executable. This plugin will attempt to locate pandoc for you and will use this path if it fails to do so. To find pandoc, use the output of 'which pandoc' in a terminal on Mac/Linux or 'Get-Command pandoc' in powershell on Windows.",
  'Attempt to find Pandoc automatically':
    'Attempt to find Pandoc automatically',
  'Unable to find pandoc on your system. If it is installed, please manually enter a path.':
    'Unable to find pandoc on your system. If it is installed, please manually enter a path.',
  'Hide links in references': 'Hide links in references',
  'Replace links with link icons to save space.':
    'Replace links with link icons to save space.',
  'Show citekey tooltips': 'Show citekey tooltips',
  'When enabled, hovering over citekeys will open a tooltip containing a formatted citation.':
    'When enabled, hovering over citekeys will open a tooltip containing a formatted citation.',
  'Tooltip delay': 'Tooltip delay',
  'Set the amount of time (in milliseconds) to wait before displaying tooltips.':
    'Set the amount of time (in milliseconds) to wait before displaying tooltips.',
  'Validate Pandoc configuration': 'Validate Pandoc configuration',
  Validate: 'Validate',
  'Validation successful': 'Validation successful',
  'Show citekey suggestions': 'Show citekey suggestions',
  'When enabled, an autocomplete dialog will display when typing citation keys.':
    'When enabled, an autocomplete dialog will display when typing citation keys.',
  'Pull bibliography from Zotero': 'Pull bibliography from Zotero',
  'When enabled, bibliography data will be pulled from Zotero rather than a bibliography file. The Better Bibtex plugin must be installed in Zotero.':
    'When enabled, bibliography data will be pulled from Zotero rather than a bibliography file. The Better Bibtex plugin must be installed in Zotero.',
  'Zotero port': 'Zotero port',
  "Use 24119 for Juris-M or specify a custom port if you have changed Zotero's default.":
    "Use 24119 for Juris-M or specify a custom port if you have changed Zotero's default.",
  'Render live preview inline citations':
    'Render live preview inline citations',
  'Render reading mode inline citations':
    'Render reading mode inline citations',
  'Convert [@pandoc] citations to formatted inline citations in live preview mode.':
    'Convert [@pandoc] citations to formatted inline citations in live preview mode.',
  'Convert [@pandoc] citations to formatted inline citations in reading mode.':
    'Convert [@pandoc] citations to formatted inline citations in reading mode.',
  'Process citations in links': 'Process citations in links',
  'Include [[@pandoc]] citations in the reference list and format them as inline citations in live preview mode.':
    'Include [[@pandoc]] citations in the reference list and format them as inline citations in live preview mode.',
  // src/view.ts
  'Please provide the path to pandoc in the Bib Shower plugin settings.':
    'Please provide the path to pandoc in the Bib Shower plugin settings.',
  'Click to copy': 'Click to copy',
  'Copy list': 'Copy list',
  'No citations found in the current document.':
    'No citations found in the current document.',
  References: 'References',
  'This can be overridden on a per-file basis by setting "lang" or "citation-language" in the file\'s frontmatter. A language code must be used when setting the language via frontmatter.':
    'This can be overridden on a per-file basis by setting "lang" or "citation-language" in the file\'s frontmatter. A language code must be used when setting the language via frontmatter.',
  'See here for a list of available language codes':
    'See here for a list of available language codes',
  'Cannot connect to Zotero': 'Cannot connect to Zotero',
  'Start Zotero and try again.': 'Start Zotero and try again.',
  'Libraries to include in bibliography':
    'Libraries to include in bibliography',
  'Please provide the path to your pandoc compatible bibliography file in the Bib Shower plugin settings.':
    'Please provide the path to your pandoc compatible bibliography file in the Bib Shower plugin settings.',
  'Refresh bibliography': 'Refresh bibliography',
  'Pandoc reference list settings': 'Bib Shower settings',
  'Additional bibliography files': 'Additional bibliography files',
  'Add more bibliography files to be searched.': 'Add more bibliography files to be searched.',
  Add: 'Add',
  Bibliography: 'Bibliography',
  Remove: 'Remove',
  'Open attachment': 'Open attachment',
  // src/tooltip.ts
  'No citation found for ': 'No citation found for ',

  // src/main.ts
  'Show reference list': 'Show reference list',
  'Open reference manager': 'Open reference manager',
  'Reference Manager': 'Reference Manager',
  'Search references...': 'Search references...',
  'Add Reference': 'Add Reference',
  'Actions': 'Actions',
  'Title': 'Title',
  'Author': 'Author',
  'Year': 'Year',
  'Copy Citekey': 'Copy Citekey',
  'Insert Citation': 'Insert Citation',
  'Open PDF': 'Open PDF',
  'Open EPUB': 'Open EPUB',
  'Edit in Bib file': 'Edit in Bib file',
  'Citekey copied to clipboard': 'Citekey copied to clipboard',
  'Paste text or URL here...': 'Paste text or URL here...',
  'Process': 'Process',
  'Processing...': 'Processing...',
  'Preview Extracted References': 'Preview Extracted References',
  'Save Selected': 'Save Selected',
  'References saved successfully.': 'References saved successfully.',
  'Failed to save': 'Failed to save',
  'Please configure bibliography path in settings.': 'Please configure bibliography path in settings.',
  'Please configure DeepSeek API Key in settings.': 'Please configure DeepSeek API Key in settings.',
  'AI & Attachment Settings': 'AI & Attachment Settings',
  'DeepSeek API URL': 'DeepSeek API URL',
  'DeepSeek API Key': 'DeepSeek API Key',
  'Attachment directory': 'Attachment directory',
  'No bibliography loaded or engine not initialized.': 'No bibliography loaded or engine not initialized.',
  'No entries to display.': 'No entries to display.',
  'Error rendering bibliography.': 'Error rendering bibliography.',

  // src/view.ts
  'Open literature note': 'Open literature note',
  'Open in Zotero': 'Open in Zotero',
  'Current References': 'Current References',
  'All References': 'All References',
  'Show All References': 'Show All References',
  'Show Current References': 'Show Current References',
  'Insert citation': 'Insert citation',
  'Edit in VS Code': 'Edit in VS Code',
  'No active markdown editor found.': 'No active markdown editor found.',
  'Load More': 'Load More',
  'Cancel': 'Cancel',
  'Show details': 'Show details',
  'Copy citekey': 'Copy citekey',
  'Browser Bookmarklet': 'Browser Bookmarklet',
  'Click the button to copy the bookmarklet to your clipboard. You can then add it as a bookmark in Safari or Edge.': 'Click the button to copy the bookmarklet to your clipboard. You can then add it as a bookmark in Safari or Edge.',
  'Copy Bookmarklet': 'Copy Bookmarklet',
  'Bookmarklet copied to clipboard!': 'Bookmarklet copied to clipboard!',
};
