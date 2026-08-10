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
