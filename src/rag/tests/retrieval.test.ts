import { ragDisplayName, firstMarkdownHeading } from '../retrieval';

describe('ragDisplayName', () => {
  test('uses the markdown file name without extension', () => {
    expect(ragDisplayName('literature/Smith2020Networks.md')).toBe('Smith2020Networks');
  });

  test('handles a bare file name', () => {
    expect(ragDisplayName('Smith2020Networks.md')).toBe('Smith2020Networks');
  });

  test('handles nested and windows-style separators', () => {
    expect(ragDisplayName('a/b/c/Paper.md')).toBe('Paper');
    expect(ragDisplayName('a\\b\\Paper.md')).toBe('Paper');
  });

  test('keeps non-md paths intact apart from the directory', () => {
    expect(ragDisplayName('notes/Daily Note')).toBe('Daily Note');
  });

  test('is case-insensitive about the extension', () => {
    expect(ragDisplayName('literature/Paper.MD')).toBe('Paper');
  });

  test('does not strip dots inside the name', () => {
    expect(ragDisplayName('literature/2511.11086v1_3f8635f3.md')).toBe('2511.11086v1_3f8635f3');
  });

  test('tolerates empty input', () => {
    expect(ragDisplayName('')).toBe('');
  });
});

describe('firstMarkdownHeading', () => {
  test('returns the first ATX heading', () => {
    expect(firstMarkdownHeading('# Introduction\n\nBody')).toBe('Introduction');
  });

  test('accepts deeper heading levels', () => {
    expect(firstMarkdownHeading('body text\n\n### Methods\n')).toBe('Methods');
  });

  test('skips an empty heading (MinerU emits a bare #)', () => {
    const md = '# \n\n<!-- PAGE_BREAK: 1 -->\n\n# 正本清源\n';
    expect(firstMarkdownHeading(md)).toBe('正本清源');
  });

  test('skips a heading that is only an inline image', () => {
    const md = '# ![](images/abc.jpg)\n\n## Real Heading\n';
    expect(firstMarkdownHeading(md)).toBe('Real Heading');
  });

  test('ignores headings inside YAML frontmatter', () => {
    const md = '---\ntitle: "# not a heading"\n---\n\n# Actual\n';
    expect(firstMarkdownHeading(md)).toBe('Actual');
  });

  test('ignores comments inside fenced code blocks', () => {
    const md = '```sh\n# rm -rf /\n```\n\n# Safe Heading\n';
    expect(firstMarkdownHeading(md)).toBe('Safe Heading');
  });

  test('handles tilde fences too', () => {
    const md = '~~~py\n# comment\n~~~\n\n## Py Heading\n';
    expect(firstMarkdownHeading(md)).toBe('Py Heading');
  });

  test('strips inline decoration and closing hashes', () => {
    expect(firstMarkdownHeading('# **Bold** and `code` ##\n')).toBe('Bold and code');
  });

  test('reduces links to their label', () => {
    expect(firstMarkdownHeading('# See [the paper](http://x/y)\n')).toBe('See the paper');
  });

  test('requires a space after the hashes', () => {
    expect(firstMarkdownHeading('#hashtag\n\n# Heading\n')).toBe('Heading');
  });

  test('truncates very long headings', () => {
    const long = 'x'.repeat(200);
    const out = firstMarkdownHeading(`# ${long}\n`, 20);
    expect(out).toBe(`${'x'.repeat(20)}…`);
  });

  test('returns empty string when there is no heading', () => {
    expect(firstMarkdownHeading('just body text\n\nmore text')).toBe('');
    expect(firstMarkdownHeading('')).toBe('');
  });
});
