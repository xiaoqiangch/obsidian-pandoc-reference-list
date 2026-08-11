import { RawLayoutBlock } from '../rag/layout';

export interface MineruChunkResult {
  mdContent: string;
  imageCount: number;
  footnotes: string;
  layout: RawLayoutBlock[];
}

export const MINERU_FOOTNOTE_TYPES = new Set([
  'page_footnote',
  'footer',
  'aside_text',
  'ref_text',
]);

/** Split a page range into [start, end] chunks of at most maxPages pages. */
export function buildPageChunks(totalPages: number, maxPages: number): [number, number][] {
  if (totalPages <= 0) return [[1, 1]];
  const chunks: [number, number][] = [];
  let start = 1;
  while (start <= totalPages) {
    const end = Math.min(start + maxPages - 1, totalPages);
    chunks.push([start, end]);
    start = end + 1;
  }
  return chunks;
}

/** Scale the MinerU poll timeout with the chunk size. */
export function computeMaxAttempts(chunkPages: number, base = 300): number {
  if (!Number.isFinite(base) || base <= 0) base = 300;
  return Math.max(base, chunkPages * 2);
}

/**
 * Merge several page-range chunk results into one document. Chunk layout page
 * numbers are offset so they refer to the original PDF pages; footnotes are
 * rebuilt from the merged layout so page headings stay correct.
 */
export function mergeChunkResults(
  results: MineruChunkResult[],
  chunkStarts: number[]
): MineruChunkResult {
  const mdParts: string[] = [];
  const layout: RawLayoutBlock[] = [];
  let imageCount = 0;

  results.forEach((r, i) => {
    if (r.mdContent && r.mdContent.trim()) mdParts.push(r.mdContent.trim());
    imageCount += r.imageCount;
    const offset = chunkStarts[i] - 1;
    for (const b of r.layout) {
      layout.push({ ...b, page: b.page + offset });
    }
  });

  const mdContent = mdParts.join('\n\n');
  const footnotes = buildFootnotesFromLayout(mdContent, layout);
  return { mdContent, imageCount, footnotes, layout };
}

/**
 * Build the footnotes / references markdown section from normalized layout
 * blocks (1-based pages).
 */
export function buildFootnotesFromLayout(mdContent: string, layout: RawLayoutBlock[]): string {
  const byPage = new Map<number, string[]>();
  for (const b of layout) {
    if (!MINERU_FOOTNOTE_TYPES.has(b.type)) continue;
    const text = (b.text || '').trim();
    if (!text) continue;
    const list = byPage.get(b.page) || [];
    list.push(text);
    byPage.set(b.page, list);
  }

  if (byPage.size === 0) return '';

  const pageNums = [...byPage.keys()].sort((a, b) => a - b);
  const lines: string[] = ['', '<!-- MINERU_FOOTNOTES -->', '## 页下注与注释', ''];
  let added = 0;

  for (const page of pageNums) {
    const pageText = (byPage.get(page) || []).join('\n').trim();
    if (!pageText) continue;
    // Skip pages whose footnote text is already present in the markdown body.
    const fingerprint = pageText.slice(0, 40).replace(/\s+/g, ' ');
    if (mdContent.includes(fingerprint)) continue;

    lines.push(`### 第 ${page} 页`, '');
    for (const line of pageText.split('\n')) {
      const trimmed = line.trim();
      lines.push(trimmed ? `> ${trimmed}` : '>');
    }
    lines.push('');
    added++;
  }

  if (added === 0) return '';
  return lines.join('\n');
}
