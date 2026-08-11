export interface TextChunk {
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Split markdown text into overlapping line-based chunks for embedding.
 * Line numbers are 1-based (matching the md file line numbers used by
 * layout.json), so a semantic hit can be mapped back to an MD line range
 * and, via the layout index, to a PDF page / bbox.
 *
 * A chunk closes once adding the next line would exceed `maxChars`; the next
 * chunk starts `overlapChars` worth of characters back so boundary passages
 * are not lost.
 */
export function chunkByLines(
  text: string,
  maxChars = 1000,
  overlapChars = 100
): TextChunk[] {
  const lines = text.split('\n');
  const chunks: TextChunk[] = [];

  let curText = '';
  let curStartLine = 1;
  let startIndex = 0;

  const flush = (endIndex: number): void => {
    if (!curText) return;
    chunks.push({
      startLine: curStartLine,
      endLine: endIndex,
      text: curText,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (!curText) {
      curText = lineText;
      curStartLine = i + 1;
      startIndex = i;
      continue;
    }
    const would = curText.length + 1 + lineText.length;
    if (would > maxChars) {
      flush(i);
      // Rewind to cover the tail of the closed chunk (overlap window).
      let budget = overlapChars;
      let newStart = i;
      while (newStart > startIndex && budget > 0) {
        newStart--;
        budget -= lines[newStart].length + 1;
      }
      curText = lines.slice(newStart, i).join('\n');
      curStartLine = newStart + 1;
      startIndex = newStart;
      curText += (curText ? '\n' : '') + lineText;
    } else {
      curText += '\n' + lineText;
    }
  }

  if (curText) flush(lines.length);
  return chunks;
}
