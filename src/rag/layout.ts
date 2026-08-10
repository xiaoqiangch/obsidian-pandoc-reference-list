import { ragLog } from './log';

const fs = require('fs');
const path = require('path');

export interface LayoutBlock {
  id: string;
  type: string;
  page: number;
  bbox: number[] | null;
  text: string;
  lineStart: number;
  lineEnd: number;
}

export interface RawLayoutBlock {
  type: string;
  page: number;
  bbox: number[] | null;
  text: string;
}

/**
 * Best-effort locate the line range of a text block inside the generated
 * markdown. Used to bridge shadow-writer-plus chunk line numbers back to
 * layout blocks (page / bbox). Returns null when the block cannot be found.
 */
export function locateTextLines(mdContent: string, text: string): { start: number; end: number } | null {
  const probe = text.replace(/\s+/g, ' ').slice(0, 60);
  if (!probe) return null;
  const idx = mdContent.indexOf(probe);
  if (idx < 0) return null;

  let start = 1;
  for (let i = 0; i < idx; i++) {
    if (mdContent[i] === '\n') start++;
  }
  const end = start + probe.split('\n').length - 1;
  return { start, end };
}

export function writeLayoutFile(raw: RawLayoutBlock[], mdContent: string, imagesDir: string): LayoutBlock[] | null {
  try {
    const blocks: LayoutBlock[] = raw.map((b, i) => {
      const loc = locateTextLines(mdContent, b.text);
      return {
        id: `b${i}`,
        type: b.type,
        page: b.page,
        bbox: b.bbox,
        text: b.text,
        lineStart: loc ? loc.start : -1,
        lineEnd: loc ? loc.end : -1,
      };
    });
    fs.writeFileSync(path.join(imagesDir, 'layout.json'), JSON.stringify(blocks, null, 1), 'utf-8');
    return blocks;
  } catch (e) {
    ragLog('RagLayout', 'Failed to write layout.json', { imagesDir, error: e });
    return null;
  }
}

export function readLayoutFile(imagesDir: string): LayoutBlock[] | null {
  try {
    const file = path.join(imagesDir, 'layout.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) return null;
    return parsed as LayoutBlock[];
  } catch (e) {
    ragLog('RagLayout', 'Failed to read layout.json', { imagesDir, error: e });
    return null;
  }
}
