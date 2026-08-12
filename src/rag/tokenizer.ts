const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to',
  'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'not', 'no',
  'so', 'than', 'too', 'very', 'just', 'do', 'does', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'shall', 'about', 'into', 'over',
  'after', 'before', 'under', 'again', 'further', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too', 'up', 'down',
  'out', 'off', 'what', 'which', 'who', 'whom',
]);

/**
 * Tokenize mixed English / CJK text.
 * - Latin words are lowercased and split on non-alphanumeric boundaries.
 * - CJK runs are emitted as overlapping character bigrams (plus the single
 *   character for runs of length 1).
 *
 * Bigrams are only used as an inverted-index key for candidate generation;
 * matching semantics for CJK are enforced separately via {@link extractCjkRuns}
 * substring verification in the search layer (Obsidian-style whole-phrase match).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  const n = lower.length;

  while (i < n) {
    const ch = lower[i];

    if (CJK_RE.test(ch)) {
      let j = i;
      const run: string[] = [];
      while (j < n && CJK_RE.test(lower[j])) {
        run.push(lower[j]);
        j++;
      }
      if (run.length === 1) {
        tokens.push(run[0]);
      } else {
        for (let k = 0; k < run.length - 1; k++) {
          tokens.push(run[k] + run[k + 1]);
        }
      }
      i = j;
      continue;
    }

    if (/[a-z0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9]/.test(lower[j])) j++;
      const word = lower.substring(i, j);
      if (!STOPWORDS.has(word)) tokens.push(word);
      i = j;
      continue;
    }

    i++;
  }

  return tokens;
}

/**
 * Extract every maximal CJK run in the text (contiguous CJK characters),
 * lowercased. Used for whole-phrase substring matching: a CJK query phrase
 * must appear contiguously inside one of these runs to be a match.
 */
export function extractCjkRuns(text: string): string[] {
  const runs: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  const n = lower.length;

  while (i < n) {
    if (CJK_RE.test(lower[i])) {
      let j = i;
      while (j < n && CJK_RE.test(lower[j])) j++;
      runs.push(lower.substring(i, j));
      i = j;
      continue;
    }
    i++;
  }

  return runs;
}

export interface ParsedQuery {
  /** Lowercased latin words (stopwords removed). */
  latin: string[];
  /** Maximal CJK runs, each matched as a whole contiguous substring. */
  cjkRuns: string[];
}

/**
 * Split a raw query into latin words and CJK runs. Latin words keep
 * per-term (AND/OR by coverage) semantics; every CJK run must appear as a
 * contiguous substring in a document for it to match — the same behavior as
 * Obsidian's native full-text search for CJK.
 */
export function parseQuery(text: string): ParsedQuery {
  const latin: string[] = [];
  const cjkRuns: string[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  const n = lower.length;

  while (i < n) {
    const ch = lower[i];

    if (CJK_RE.test(ch)) {
      let j = i;
      while (j < n && CJK_RE.test(lower[j])) j++;
      cjkRuns.push(lower.substring(i, j));
      i = j;
      continue;
    }

    if (/[a-z0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[a-z0-9]/.test(lower[j])) j++;
      const word = lower.substring(i, j);
      if (!STOPWORDS.has(word)) latin.push(word);
      i = j;
      continue;
    }

    i++;
  }

  return { latin, cjkRuns };
}
