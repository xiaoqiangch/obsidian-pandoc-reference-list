import { LayoutBlock, readLayoutFile } from './layout';
import { ragLog } from './log';

const fs = require('fs');
const path = require('path');

export interface LayoutHit {
  page: number;
  bbox: number[] | null;
  text: string;
}

export interface RagSnippet {
  text: string;
  line: number;
}

/** A single search hit position inside a converted markdown document. */
export interface RagPosition {
  line: number;
  snippet: string;
  page?: number;
  bbox?: number[] | null;
}

/**
 * Display name for a search hit: the markdown file's own name.
 *
 * The indexer stores a `title` sniffed from the first meaningful line of the
 * document (see extractTitle in bm25.ts). For converted literature that line is
 * whatever MinerU happened to emit first — an empty `#` heading, an inline
 * `![](images/....jpg)`, a stray running head, a table row, or a fragment like
 * "元数据" / "感知力" — so the result list showed confusing body text instead of
 * identifying the paper. The file name is derived from the citekey and is both
 * stable and meaningful, so it is what the list shows.
 */
export function ragDisplayName(docPath: string): string {
  const base = (docPath || '').split(/[\\/]/).pop() || docPath || '';
  return base.replace(/\.md$/i, '') || docPath || '';
}

/**
 * First real ATX heading (`#`..`######`) of a markdown document, shown after the
 * file name as a secondary label so a hit is identifiable at a glance.
 *
 * Deliberately stricter than extractTitle():
 *  - only actual headings count, never arbitrary body text;
 *  - YAML frontmatter is skipped so a `#` inside it is not picked up;
 *  - fenced code blocks are skipped so a shell comment (`# rm -rf`) or a
 *    Python comment is never mistaken for a heading;
 *  - empty headings (MinerU emits a bare `#` on many converted PDFs) and
 *    headings that are only an inline image are ignored, and the search
 *    continues to the next candidate;
 *  - inline images / links are reduced to their text so the label stays short.
 *
 * Returns '' when the document has no usable heading, in which case the caller
 * shows the file name alone.
 */
export function firstMarkdownHeading(content: string, maxLen = 120): string {
  if (!content) return '';
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i++;

  // Skip a YAML frontmatter block.
  if (i < lines.length && /^-{3,}\s*$/.test(lines[i].trim())) {
    let j = i + 1;
    while (j < lines.length && !/^-{3,}\s*$/.test(lines[j].trim())) j++;
    if (j < lines.length) i = j + 1;
  }

  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (!m) continue;

    const text = cleanHeadingText(m[2]);
    if (!text) continue;
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  }

  return '';
}

/** Strip inline markdown decoration from a heading so it reads as plain text. */
function cleanHeadingText(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // inline images carry no text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> their label
    .replace(/[*_`~]/g, '')
    .replace(/#+\s*$/, '') // trailing closing hashes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce a short highlightable snippet around the first line that matches any
 * query term. The view is responsible for actually highlighting the terms.
 */
export function buildSnippet(content: string, terms: string[], maxLen = 320): RagSnippet {
  const lines = content.split('\n');
  const lowerTerms = terms.map((t) => t.toLowerCase());
  let hitIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lowerTerms.some((t) => lower.includes(t))) {
      hitIdx = i;
      break;
    }
  }

  if (hitIdx < 0) {
    return { text: lines[0] || '', line: 1 };
  }

  // Expand the window around the matching line up to maxLen.
  let start = hitIdx;
  let end = hitIdx;
  let acc = lines[hitIdx];
  while (acc.length < maxLen && (start > 0 || end < lines.length - 1)) {
    if (start > 0) {
      start--;
      acc = lines[start] + '\n' + acc;
    }
    if (acc.length >= maxLen) break;
    if (end < lines.length - 1) {
      end++;
      acc = acc + '\n' + lines[end];
    }
  }

  let text = acc;
  if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
  return { text, line: hitIdx + 1 };
}

/**
 * Enumerate every line in the converted markdown that contains a query term.
 * Each position carries a snippet window around the matching line and, when a
 * layout block covers that line, the PDF page / bbox for precise positioning.
 */
export function findRagPositions(
  content: string,
  terms: string[],
  layout: LayoutBlock[] | null,
  snippetLen = 180
): RagPosition[] {
  const lines = content.split('\n');
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (lowerTerms.length === 0) return [];

  const out: RagPosition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (!lowerTerms.some((t) => lower.includes(t))) continue;

    const block = findLayoutBlockAt(layout, i + 1, lowerTerms);
    out.push({
      line: i + 1,
      snippet: buildWindow(lines, i, snippetLen),
      ...(block ? { page: block.page, bbox: block.bbox } : {}),
    });
  }
  return out;
}

function findLayoutBlockAt(
  layout: LayoutBlock[] | null,
  line: number,
  lowerTerms: string[]
): LayoutBlock | null {
  if (!layout) return null;
  let fallback: LayoutBlock | null = null;
  for (const b of layout) {
    if (b.lineStart < 0 || b.lineEnd < 0) continue;
    if (line < b.lineStart || line > b.lineEnd) continue;
    const lower = b.text.toLowerCase();
    if (lowerTerms.some((t) => lower.includes(t))) return b;
    if (!fallback) fallback = b;
  }
  return fallback;
}

function buildWindow(lines: string[], idx: number, maxLen: number): string {
  let start = idx;
  let end = idx;
  let acc = lines[idx] || '';
  while (acc.length < maxLen && (start > 0 || end < lines.length - 1)) {
    if (start > 0) {
      start--;
      acc = lines[start] + '\n' + acc;
    }
    if (acc.length >= maxLen) break;
    if (end < lines.length - 1) {
      end++;
      acc = acc + '\n' + lines[end];
    }
  }
  if (acc.length > maxLen) acc = acc.slice(0, maxLen) + '…';
  return acc;
}

export function literatureLayoutPath(vaultRoot: string, outputPath: string, citekey: string): string {
  return path.join(vaultRoot, outputPath, 'images', citekey, 'layout.json');
}

/** Find layout blocks that contain any query term, best matches first. */
export function findLayoutHits(layout: LayoutBlock[] | null, terms: string[], max = 3): LayoutHit[] {
  if (!layout || layout.length === 0) return [];
  const lowerTerms = terms.map((t) => t.toLowerCase());

  const scored: { hit: LayoutHit; count: number }[] = [];
  for (const b of layout) {
    const lower = b.text.toLowerCase();
    const count = lowerTerms.filter((t) => t.length > 0 && lower.includes(t)).length;
    if (count > 0) {
      scored.push({
        hit: { page: b.page, bbox: b.bbox, text: b.text.slice(0, 240) },
        count,
      });
    }
  }

  scored.sort((a, b) => b.count - a.count || a.hit.page - b.hit.page);
  return scored.slice(0, max).map((s) => s.hit);
}

/** Find layout blocks whose md line range overlaps the given range. */
export function findLayoutBlocksByLines(
  layout: LayoutBlock[] | null,
  startLine: number,
  endLine: number
): LayoutHit[] {
  if (!layout || layout.length === 0) return [];
  const out: LayoutHit[] = [];
  for (const b of layout) {
    if (b.lineStart < 0 || b.lineEnd < 0) continue;
    if (b.lineStart <= endLine && b.lineEnd >= startLine) {
      out.push({ page: b.page, bbox: b.bbox, text: b.text.slice(0, 240) });
    }
  }
  return out.slice(0, 5);
}

export function readLiteratureLayout(vaultRoot: string, outputPath: string, citekey: string): LayoutBlock[] | null {
  const p = literatureLayoutPath(vaultRoot, outputPath, citekey);
  try {
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as LayoutBlock[]) : null;
  } catch (e) {
    ragLog('RagRetrieval', 'Failed to read literature layout', { citekey, error: e });
    return null;
  }
}

/**
 * Convert a MinerU normalized bbox (0-1000, y-down, top-left origin) into PDF
 * user space coordinates ([x1, y1, x2, y2], y-up, bottom-left origin) as
 * consumed by pdf-plus `#page=N&rect=x1,y1,x2,y2`.
 */
export function mineruBboxToPdfUserSpace(
  bbox: number[],
  pageW: number,
  pageH: number
): [number, number, number, number] {
  const x0 = (bbox[0] / 1000) * pageW;
  const yTop = (bbox[1] / 1000) * pageH;
  const x1 = (bbox[2] / 1000) * pageW;
  const yBottom = (bbox[3] / 1000) * pageH;
  const pdfY0 = pageH - yBottom;
  const pdfY1 = pageH - yTop;
  return [x0, pdfY0, x1, pdfY1];
}

export { readLayoutFile };
