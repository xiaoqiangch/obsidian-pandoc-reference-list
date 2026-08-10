import { getVaultRoot, debugLog } from '../helpers';
import { ConversionStateManager, ConversionState } from './conversionState';
import { renderPdfPages, getPdfPageCount, RenderedPage, ExtractedImage } from './pdfRenderer';
import { parseEpub, htmlToMarkdown } from './epubParser';
import { convertImageToMarkdown, convertTextToMarkdown, extractReferencesToBib, extractAllReferencesToBib, LlmConvertSettings } from './llmConverter';
import { convertPdfWithMineru, MineruConvertSettings } from './mineruConverter';
import { markdownReferencesToBibtex } from './bibtexConverter';
import { PartialCSLEntry } from '../bib/types';

const fs = require('fs');
const path = require('path');

const PAGE_MARKER_RE = /<!--\s*PAGE:(\d+)\s*-->/g;

export type ConvertEngine = 'mineru' | 'llm';

export interface ConvertSettings {
  outputPath: string;
  engine?: ConvertEngine;
  llm: LlmConvertSettings;
  mineru?: MineruConvertSettings;
}

export interface ConvertProgress {
  citekey: string;
  currentPage: number;
  totalPages: number;
  status: ConversionState['status'];
  message?: string;
}

export type ProgressCallback = (progress: ConvertProgress) => void;

export async function getAttachmentPath(entry: PartialCSLEntry, plugin: any): Promise<string | null> {
  const zAttachmentLinks = plugin.bibManager.zCitekeyToAttachmentLinks.get(entry.id) || [];
  const localAttachmentLinks = plugin.bibManager.parseBibFileField(entry.file);
  const paths = [...new Set([...zAttachmentLinks, ...localAttachmentLinks])];
  const existing = paths.filter((p: string) => fs.existsSync(p));
  if (existing.length === 0) return null;

  const attachmentPath = existing[0];
  const ext = path.extname(attachmentPath).toLowerCase();
  if (ext !== '.pdf' && ext !== '.epub') return null;
  return attachmentPath;
}

export async function convertToMarkdown(
  entry: PartialCSLEntry,
  attachmentPath: string,
  settings: ConvertSettings,
  onProgress?: ProgressCallback
): Promise<{ mdPath: string; bibPath: string } | null> {
  const stateManager = new ConversionStateManager();
  const citekey = entry.id;

  const ext = path.extname(attachmentPath).toLowerCase();
  const attachmentType: 'pdf' | 'epub' = ext === '.pdf' ? 'pdf' : 'epub';

  const vaultRoot = getVaultRoot();
  const outputDir = path.join(vaultRoot, settings.outputPath);
  const bibDir = path.join(outputDir, 'bibs');
  const imagesDir = path.join(outputDir, 'images', citekey);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  if (!fs.existsSync(bibDir)) fs.mkdirSync(bibDir, { recursive: true });
  if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

  const mdPath = path.join(outputDir, `${citekey}.md`);
  const bibPath = path.join(bibDir, `${citekey}.bib`);

  let existingState = stateManager.get(citekey);
  if (existingState && existingState.status === 'completed') {
    debugLog('Converter', 'Already completed', { citekey });
    return { mdPath, bibPath };
  }

  if (existingState && existingState.status === 'in_progress' && existingState.attachmentPath !== attachmentPath) {
    debugLog('Converter', 'Attachment changed, restarting conversion', { citekey });
    stateManager.remove(citekey);
    existingState = null;
  }

  if (existingState && existingState.status === 'in_progress' && existingState.outputMdPath !== mdPath) {
    stateManager.remove(citekey);
    existingState = null;
  }

  let totalPages = 0;
  let startPage = 1;

  if (attachmentType === 'pdf') {
    totalPages = await getPdfPageCount(attachmentPath);
  } else {
    const { chapters } = await parseEpub(attachmentPath);
    totalPages = chapters.length;
  }

  if (existingState && existingState.status === 'in_progress') {
    startPage = existingState.convertedPages + 1;
    debugLog('Converter', 'Resuming from page', { citekey, startPage });
  }

  const state: ConversionState = existingState || {
    citekey,
    attachmentPath,
    attachmentType,
    outputMdPath: mdPath,
    bibPath,
    imagesDir,
    totalPages,
    convertedPages: 0,
    status: 'in_progress',
    startedAt: new Date().toISOString(),
  };

  state.totalPages = totalPages;
  stateManager.set(citekey, state);

  onProgress?.({
    citekey,
    currentPage: startPage - 1,
    totalPages,
    status: 'in_progress',
    message: 'Starting conversion...',
  });

  try {
    if (attachmentType === 'pdf') {
      await convertPdf(entry, attachmentPath, mdPath, bibPath, imagesDir, settings, state, stateManager, onProgress, startPage);
    } else {
      await convertEpub(entry, attachmentPath, mdPath, bibPath, imagesDir, settings, state, stateManager, onProgress, startPage);
    }

    stateManager.update(citekey, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      convertedPages: totalPages,
    });

    onProgress?.({
      citekey,
      currentPage: totalPages,
      totalPages,
      status: 'completed',
      message: 'Conversion completed!',
    });

    new Notice(`Conversion completed: ${citekey}`);
    return { mdPath, bibPath };
  } catch (e: any) {
    debugLog('Converter', 'Conversion failed', { citekey, error: e.message });
    stateManager.update(citekey, {
      status: 'failed',
      error: e.message,
    });
    onProgress?.({
      citekey,
      currentPage: state.convertedPages,
      totalPages,
      status: 'failed',
      message: e.message,
    });
    new Notice(`Conversion failed: ${e.message}`);
    return null;
  }
}

async function convertPdf(
  entry: PartialCSLEntry,
  pdfPath: string,
  mdPath: string,
  bibPath: string,
  imagesDir: string,
  settings: ConvertSettings,
  state: ConversionState,
  stateManager: ConversionStateManager,
  onProgress: ProgressCallback | undefined,
  startPage: number
) {
  const engine = settings.engine || 'mineru';

  if (engine === 'mineru') {
    await convertPdfWithMineruBranch(
      entry,
      pdfPath,
      mdPath,
      bibPath,
      imagesDir,
      settings,
      state,
      stateManager,
      onProgress
    );
    return;
  }

  const titleHeader = buildTitleHeader(entry);
  let mdContent = '';

  if (startPage === 1) {
    mdContent = titleHeader + '\n\n';
  } else {
    if (fs.existsSync(mdPath)) {
      mdContent = fs.readFileSync(mdPath, 'utf-8');
    } else {
      mdContent = titleHeader + '\n\n';
    }
  }

  const existingPageMarkers = new Set<number>();
  let match;
  PAGE_MARKER_RE.lastIndex = 0;
  while ((match = PAGE_MARKER_RE.exec(mdContent)) !== null) {
    existingPageMarkers.add(parseInt(match[1]));
  }

  const pages: RenderedPage[] = [];
  const allPages = await renderPdfPages(pdfPath, imagesDir, (current, total) => {
    onProgress?.({
      citekey: entry.id,
      currentPage: current,
      totalPages: total,
      status: 'in_progress',
      message: `Rendering PDF page ${current}/${total}...`,
    });
  });

  for (const page of allPages) {
    if (page.pageNumber < startPage || existingPageMarkers.has(page.pageNumber)) {
      debugLog('Converter', 'Skipping already converted page', { page: page.pageNumber });
      continue;
    }
    pages.push(page);
  }

  if (pages.length === 0) {
    debugLog('Converter', 'No pages to convert, already done', { citekey: entry.id });
  }

  for (const page of pages) {
    onProgress?.({
      citekey: entry.id,
      currentPage: page.pageNumber,
      totalPages: state.totalPages,
      status: 'in_progress',
      message: `Converting page ${page.pageNumber}/${state.totalPages}...`,
    });

    const pageMd = await convertImageToMarkdown(
      page.imageDataUrl,
      settings.llm,
      `page ${page.pageNumber} of ${state.totalPages}`
    );

    const finalMd = replaceImagePlaceholders(pageMd, page.extractedImages, settings.outputPath, entry.id);

    mdContent += `<!-- PAGE:${page.pageNumber} -->\n${finalMd}\n\n`;

    fs.writeFileSync(mdPath, mdContent, 'utf-8');

    state.convertedPages = page.pageNumber;
    stateManager.update(entry.id, { convertedPages: page.pageNumber });

    debugLog('Converter', 'Page converted and saved', { page: page.pageNumber });
  }

  mdContent = mdContent.replace(new RegExp(PAGE_MARKER_RE.source, 'g'), '').trim();
  mdContent = titleHeader + '\n\n' + mdContent;
  fs.writeFileSync(mdPath, mdContent, 'utf-8');

  await extractAndSaveBib(mdContent, bibPath, settings);
}

async function convertPdfWithMineruBranch(
  entry: PartialCSLEntry,
  pdfPath: string,
  mdPath: string,
  bibPath: string,
  imagesDir: string,
  settings: ConvertSettings,
  state: ConversionState,
  stateManager: ConversionStateManager,
  onProgress: ProgressCallback | undefined
) {
  const titleHeader = buildTitleHeader(entry);
  const imageRelativePrefix = `images/${entry.id}`;

  const result = await convertPdfWithMineru(
    pdfPath,
    imagesDir,
    imageRelativePrefix,
    settings.mineru || { apiToken: '' },
    (current, total, message) => {
      onProgress?.({
        citekey: entry.id,
        currentPage: current,
        totalPages: total || state.totalPages,
        status: 'in_progress',
        message: message || `MinerU converting ${current}/${total}...`,
      });
    }
  );

  const mdContent = titleHeader + '\n\n' + result.mdContent.trim() + '\n';
  fs.writeFileSync(mdPath, mdContent, 'utf-8');

  state.convertedPages = state.totalPages;
  stateManager.update(entry.id, { convertedPages: state.totalPages });

  debugLog('Converter', 'MinerU conversion saved', {
    citekey: entry.id,
    mdLength: mdContent.length,
    imageCount: result.imageCount,
  });

  await extractAndSaveBib(mdContent, bibPath, settings);
}

async function convertEpub(
  entry: PartialCSLEntry,
  epubPath: string,
  mdPath: string,
  bibPath: string,
  imagesDir: string,
  settings: ConvertSettings,
  state: ConversionState,
  stateManager: ConversionStateManager,
  onProgress: ProgressCallback | undefined,
  startChapter: number
) {
  const { chapters, images } = await parseEpub(epubPath);

  for (const img of images) {
    const imgPath = path.join(imagesDir, img.name);
    fs.writeFileSync(imgPath, img.data);
  }

  const titleHeader = buildTitleHeader(entry);
  let mdContent = '';

  if (startChapter === 1) {
    mdContent = titleHeader + '\n\n';
  } else {
    if (fs.existsSync(mdPath)) {
      mdContent = fs.readFileSync(mdPath, 'utf-8');
    } else {
      mdContent = titleHeader + '\n\n';
    }
  }

  const existingPageMarkers = new Set<number>();
  let match;
  PAGE_MARKER_RE.lastIndex = 0;
  while ((match = PAGE_MARKER_RE.exec(mdContent)) !== null) {
    existingPageMarkers.add(parseInt(match[1]));
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapterNum = i + 1;
    if (chapterNum < startChapter || existingPageMarkers.has(chapterNum)) {
      continue;
    }

    onProgress?.({
      citekey: entry.id,
      currentPage: chapterNum,
      totalPages: chapters.length,
      status: 'in_progress',
      message: `Converting chapter ${chapterNum}/${chapters.length}: ${chapters[i].title}...`,
    });

    const chapterMd = htmlToMarkdown(chapters[i].html);

    let finalMd = chapterMd;
    try {
      const llmMd = await convertTextToMarkdown(
        chapterMd,
        settings.llm,
        `chapter ${chapterNum} (${chapters[i].title}) of ${chapters.length}`
      );
      if (llmMd && llmMd.trim().length > 0) {
        finalMd = llmMd;
      }
    } catch (e: any) {
      debugLog('Converter', 'LLM conversion failed for chapter, using raw HTML-to-MD', {
        chapter: chapterNum,
        error: e.message,
      });
    }

    mdContent += `<!-- PAGE:${chapterNum} -->\n## ${chapters[i].title}\n\n${finalMd}\n\n`;

    fs.writeFileSync(mdPath, mdContent, 'utf-8');

    state.convertedPages = chapterNum;
    stateManager.update(entry.id, { convertedPages: chapterNum });
  }

  mdContent = mdContent.replace(new RegExp(PAGE_MARKER_RE.source, 'g'), '').trim();
  mdContent = titleHeader + '\n\n' + mdContent;
  fs.writeFileSync(mdPath, mdContent, 'utf-8');

  await extractAndSaveBib(mdContent, bibPath, settings);
}

async function extractAndSaveBib(mdContent: string, bibPath: string, settings: ConvertSettings) {
  try {
    // Local deterministic conversion - always works without an LLM key.
    const localBib = markdownReferencesToBibtex(mdContent);
    let bibContent = localBib;

    // When an LLM key is available, prefer the LLM which can also recover
    // footnote (页下注) citations scattered throughout the document.
    if (settings.llm.apiKey) {
      const llmBib = await extractAllReferencesToBib(mdContent, settings.llm);
      if (llmBib && llmBib.trim().length > 0) {
        const llmCount = countBibEntries(llmBib);
        const localCount = countBibEntries(localBib);
        debugLog('Converter', 'Bib candidates', { llmCount, localCount });
        if (llmCount >= localCount || localCount === 0) {
          bibContent = llmBib;
        }
      }
    }

    // Legacy fallback: LLM-based extraction of only the trailing references section.
    if (!bibContent.trim() && settings.llm.apiKey) {
      const llmBib = await extractReferencesToBib(mdContent, settings.llm);
      if (llmBib && llmBib.trim().length > 0) {
        bibContent = llmBib;
      }
    }

    if (bibContent && bibContent.trim().length > 0) {
      fs.writeFileSync(bibPath, bibContent, 'utf-8');
      debugLog('Converter', 'Bib file saved', { bibPath, length: bibContent.length });
    } else {
      debugLog('Converter', 'No references to save to bib file', { bibPath });
    }
  } catch (e: any) {
    debugLog('Converter', 'Bib extraction failed', { error: e.message });
  }
}

function countBibEntries(bibtex: string): number {
  if (!bibtex) return 0;
  const matches = bibtex.match(/@(\w+)\s*\{/g);
  return matches ? matches.length : 0;
}

function replaceImagePlaceholders(
  md: string,
  extractedImages: ExtractedImage[],
  outputPath: string,
  citekey: string
): string {
  if (extractedImages.length === 0) return md;

  let imgIdx = 0;
  const placeholderRe = /!\[([^\]]*)\]\(image-placeholder\)/g;
  return md.replace(placeholderRe, (match, desc) => {
    if (imgIdx < extractedImages.length) {
      const img = extractedImages[imgIdx++];
      return `![${desc}](${outputPath}/images/${citekey}/${img.fileName})`;
    }
    return `*${desc || 'Figure'}*`;
  });
}

function buildTitleHeader(entry: PartialCSLEntry): string {
  let header = `# ${entry.title || entry.id}\n\n`;

  if (entry.author && entry.author.length > 0) {
    const authors = entry.author
      .map((a) => {
        if (a.family && a.given) return `${a.given} ${a.family}`;
        return a.family || a.given || '';
      })
      .filter((name) => name !== '')
      .join(', ');
    if (authors) header += `**Authors:** ${authors}\n\n`;
  }

  if (entry.year) header += `**Year:** ${entry.year}\n\n`;
  if (entry.journal) header += `**Journal:** ${entry.journal}\n\n`;
  if (entry.doi) header += `**DOI:** [${entry.doi}](https://doi.org/${entry.doi})\n\n`;
  if (entry.url) header += `**URL:** ${entry.url}\n\n`;

  header += `**Citekey:** \`${entry.id}\`\n\n`;
  header += `---\n\n`;

  return header;
}

export function isConversionCompleted(citekey: string): boolean {
  return new ConversionStateManager().isCompleted(citekey);
}

export function isConversionInProgress(citekey: string): boolean {
  return new ConversionStateManager().isInProgress(citekey);
}

export function forceReconvert(citekey: string, outputPath: string): void {
  const stateManager = new ConversionStateManager();
  const state = stateManager.get(citekey);
  const vaultRoot = getVaultRoot();
  const outputDir = path.join(vaultRoot, outputPath);

  if (state) {
    if (state.outputMdPath && fs.existsSync(state.outputMdPath)) {
      fs.unlinkSync(state.outputMdPath);
    }
    if (state.bibPath && fs.existsSync(state.bibPath)) {
      fs.unlinkSync(state.bibPath);
    }
    if (state.imagesDir && fs.existsSync(state.imagesDir)) {
      try {
        fs.rmSync(state.imagesDir, { recursive: true, force: true });
      } catch (e) {
        debugLog('Converter', 'Failed to remove old images dir', { imagesDir: state.imagesDir, error: e });
      }
    }
  } else {
    const mdPath = path.join(outputDir, `${citekey}.md`);
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
    const bibPath = path.join(outputDir, 'bibs', `${citekey}.bib`);
    if (fs.existsSync(bibPath)) fs.unlinkSync(bibPath);
    const imagesDir = path.join(outputDir, 'images', citekey);
    if (fs.existsSync(imagesDir)) {
      try {
        fs.rmSync(imagesDir, { recursive: true, force: true });
      } catch (e) {
        debugLog('Converter', 'Failed to remove old images dir', { imagesDir, error: e });
      }
    }
  }

  stateManager.remove(citekey);
  debugLog('Converter', 'Force reconvert: cleared state and files', { citekey });
}

export function getOutputMdPath(citekey: string, outputPath: string): string | null {
  const stateManager = new ConversionStateManager();
  const state = stateManager.get(citekey);
  if (state) return state.outputMdPath;

  const vaultRoot = getVaultRoot();
  const mdPath = path.join(vaultRoot, outputPath, `${citekey}.md`);
  return fs.existsSync(mdPath) ? mdPath : null;
}
