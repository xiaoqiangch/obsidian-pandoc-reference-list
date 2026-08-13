import { debugLog } from '../helpers';

export function extractReferencesSection(markdownContent: string): string | null {
  const patterns = [
    /^#{1,3}\s*References?\s*$/im,
    /^#{1,3}\s*Bibliography\s*$/im,
    /^#{1,3}\s*参考文献\s*$/im,
    /^#{1,3}\s*Works Cited\s*$/im,
    /^#{1,3}\s*引用文献\s*$/im,
    /^#{1,3}\s*文獻\s*$/im,
    /^#{1,3}\s*Literature Cited\s*$/im,
    /^References?\s*\n/m,
    /^Bibliography\s*\n/m,
    /^参考文献\s*\n/m,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(markdownContent);
    if (match) {
      const startIdx = match.index;
      const headingLine = match[0];
      const headingLevelMatch = headingLine.match(/^(#+)/);
      const headingLevel = headingLevelMatch ? headingLevelMatch[1].length : 0;

      const afterHeading = markdownContent.substring(startIdx + headingLine.length);

      if (headingLevel > 0) {
        const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
        const nextMatch = nextHeadingRe.exec(afterHeading);
        if (nextMatch) {
          return headingLine + afterHeading.substring(0, nextMatch.index);
        }
      }

      return markdownContent.substring(startIdx);
    }
  }

  debugLog('LlmConverter', 'No references section found in markdown');
  return null;
}
