import { extractReferencesSection } from './llmConverter';
import { debugLog } from '../helpers';

interface RefPart {
  index: number;
  value: string;
}

/**
 * Convert the references/bibliography section of a converted markdown document into
 * BibTeX (.bib) content. Works locally without any LLM API key, so references are
 * always saved to the bibs folder even when using the MinerU engine.
 */
export function markdownReferencesToBibtex(markdownContent: string): string {
  const refsSection = extractReferencesSection(markdownContent);
  if (!refsSection || refsSection.trim().length === 0) {
    debugLog('BibtexConverter', 'No references section found in markdown');
    return '';
  }

  const parts = splitEntries(refsSection);
  if (parts.length === 0) return '';

  const entries: string[] = [];
  for (const part of parts) {
    const bib = entryToBibtex(part.value);
    if (bib) entries.push(bib);
  }

  debugLog('BibtexConverter', 'References converted to BibTeX', {
    entries: entries.length,
    parts: parts.length,
  });

  return entries.join('\n\n');
}

function splitEntries(section: string): RefPart[] {
  const lines = section.split('\n');

  // Numbered markers: [12], 12., 12)
  let numbered = false;
  for (const line of lines) {
    if (/^\s*(?:\[\d+\]|\d+[.)])\s+/.test(line)) {
      numbered = true;
      break;
    }
  }

  if (numbered) {
    const parts: RefPart[] = [];
    let current = '';
    let currentIndex = 0;
    const push = () => {
      const trimmed = current.trim();
      if (trimmed) parts.push({ index: currentIndex, value: trimmed });
    };

    for (const line of lines) {
      if (/^#{1,6}\s+/.test(line)) {
        push();
        continue;
      }
      const m = line.match(/^(\s*(?:\[\d+\]|\d+[.)]))\s+(.*)$/);
      if (m) {
        push();
        currentIndex = parseInt(m[1].replace(/\D/g, ''), 10) || parts.length + 1;
        current = m[2];
      } else {
        current += '\n' + line;
      }
    }
    push();
    return parts;
  }

  // Fallback: split on blank lines / double newlines
  return section
    .split(/\n\s*\n/)
    .map((block, i) => ({ index: i + 1, value: block.trim() }))
    .filter((p) => p.value.length > 0 && !/^#{1,6}\s+/.test(p.value));
}

function entryToBibtex(entry: string): string | null {
  const text = normalize(entry);
  if (text.length === 0) return null;

  const cleaned = text.replace(/^\[\d+\]\s*/, '').trim();

  // DOI
  const doiMatch = cleaned.match(
    /(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/(?:10\.\d{4,9}\/[-._;()/:A-Z0-9]+))([^.\s]+)?/i
  );
  let doi = '';
  if (doiMatch) {
    const m = cleaned.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    if (m) doi = m[0].replace(/[.,;:]+$/, '');
  }

  // URL
  const urlMatch = cleaned.match(/https?:\/\/[^\s]+/);
  const url = urlMatch ? urlMatch[0].replace(/[.,;:)\]]+$/, '') : '';

  // Year
  const yearParen = cleaned.match(/\((\d{4})\)/);
  const yearGeneric = cleaned.match(/\b((?:19|20)\d{2})\b/);
  const year = yearParen ? yearParen[1] : yearGeneric ? yearGeneric[1] : '';

  // Authors: everything before the year token
  let authorText = cleaned;
  const yearAnchor = yearParen
    ? cleaned.indexOf(yearParen[0])
    : yearGeneric
    ? cleaned.indexOf(yearGeneric[1])
    : -1;
  if (yearAnchor > 0) {
    authorText = cleaned.substring(0, yearAnchor);
  }
  const authors = cleanAuthors(authorText);

  // Body after year -> title / journal
  let afterYear = cleaned;
  if (yearAnchor > 0) {
    afterYear = cleaned
      .substring(yearAnchor + (yearParen ? yearParen[0].length : 4))
      .replace(/^[.,;:\s.]+/, '');
  }
  afterYear = afterYear.replace(/\s*https?:\/\/\S+.*$/, '').trim();

  // Strip trailing period(s)
  afterYear = afterYear.replace(/\.+$/, '').trim();

  // Try to separate journal using a volume/pages pattern:
  //   "Title. Journal, 34(2), 3-28" / "Title. Journal, 7, 88-102" / "Title. Journal vol. 7"
  const split = splitTitleJournal(afterYear);
  const title = split.title;
  const journal = split.journal;

  const type = 'article';
  const key = buildKey(authors, year, title);

  const lines = [`@${type}{${key},`];
  if (authors) lines.push(`  author = {${escapeBib(authors)}},`);
  if (title) lines.push(`  title = {${escapeBib(title)}},`);
  if (journal) lines.push(`  journal = {${escapeBib(journal)}},`);
  if (year) lines.push(`  year = {${year}},`);
  if (doi) lines.push(`  doi = {${doi}},`);
  if (url) lines.push(`  url = {${url}},`);
  lines.push('}');
  return lines.join('\n');
}

function splitTitleJournal(afterYear: string): { title: string; journal: string } {
  const volIdx = afterYear.search(
    /,\s*\d{1,4}\s*\(\s*\d{1,4}\s*\)\s*[:,-]\s*\d+[^,]*|,\s*\d{1,4}\s*[,:]\s*(?:pp?\.?\s*)?\d+\b|\bvol\.?\s*\d+\s*[,:]\s*\d*/
  );
  if (volIdx <= 0) {
    return { title: afterYear.replace(/\.+$/, '').trim(), journal: '' };
  }

  const containerPart = afterYear.substring(0, volIdx).trim().replace(/[.,;:]+$/, '');
  const sentences = containerPart.split(/(?<=\.)\s+(?=[A-Z0-9"'(])/);
  if (sentences.length > 1) {
    const journal = sentences[sentences.length - 1].trim().replace(/[.,;]+$/, '');
    const title = sentences.slice(0, -1).join('. ').trim().replace(/[.,;]+$/, '');
    return { title, journal };
  }
  return { title: containerPart, journal: '' };
}

function normalize(entry: string): string {
  return entry.replace(/\s+/g, ' ').trim();
}

function cleanAuthors(authorText: string): string {
  let text = authorText.replace(/^[([]?\d+[.)]?\s*/, '').trim();
  text = text.replace(/[.,;:]+$/, '').trim();
  if (text.length === 0) return '';
  // "Smith, J., & Doe, A." -> "Smith, J., and Doe, A."
  text = text.replace(/\s*&\s*/g, ' and ');
  return text;
}

function buildKey(authors: string, year: string, title: string): string {
  let base = '';
  if (authors) {
    const first = authors.split(/\s+and\s+/i)[0].trim();
    const familyMatch = first.match(/([A-Za-zÀ-ÿ'-]+),\s/);
    if (familyMatch) {
      base = familyMatch[1].replace(/[^A-Za-zÀ-ÿ'-]/g, '');
    } else {
      // "Chen et al." -> use the leading family name
      if (/\bet al\.?/i.test(first)) {
        base = first.split(/\s+/)[0].replace(/[^A-Za-zÀ-ÿ'-]/g, '');
      } else {
        const words = first.split(/\s+/);
        base = words[words.length - 1].replace(/[^A-Za-zÀ-ÿ'-]/g, '');
      }
    }
  }
  if (!base && title) {
    const words = title.split(/\s+/);
    base = words[0];
  }
  base = base || 'ref';
  let key = `${base}${year}`;
  key = key.replace(/[^A-Za-z0-9_]/g, '');
  return key || `ref${year}`;
}

function escapeBib(value: string): string {
  return value
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/_/g, '\\_')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#');
}