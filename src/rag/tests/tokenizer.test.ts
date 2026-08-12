import { tokenize, extractCjkRuns, parseQuery } from '../tokenizer';

describe('tokenizer', () => {
  test('splits latin words and lowercases', () => {
    expect(tokenize('The Digital Economy')).toEqual(['digital', 'economy']);
  });

  test('emits CJK character bigrams', () => {
    expect(tokenize('数字经济')).toEqual(['数字', '字经', '经济']);
    expect(tokenize('数字经济')).toContain('数字');
  });

  test('single CJK char is emitted alone', () => {
    expect(tokenize('数')).toEqual(['数']);
  });

  test('mixed English and CJK', () => {
    const tokens = tokenize('ETF 数字经济');
    expect(tokens).toContain('etf');
    expect(tokens).toContain('数字');
    expect(tokens).toContain('字经');
  });

  test('strips punctuation and stopwords', () => {
    expect(tokenize('Hello, world! This is a test.')).toEqual(['hello', 'world', 'test']);
  });

  test('keeps numbers', () => {
    expect(tokenize('DID 2020')).toContain('2020');
  });
});

describe('extractCjkRuns', () => {
  test('returns maximal contiguous CJK runs', () => {
    expect(extractCjkRuns('二十四桥明月夜 economy 数字经济')).toEqual(['二十四桥明月夜', '数字经济']);
  });

  test('handles a single run spanning markdown emphasis', () => {
    expect(extractCjkRuns('**二十四桥**')).toEqual(['二十四桥']);
  });

  test('empty for latin-only text', () => {
    expect(extractCjkRuns('digital economy')).toEqual([]);
  });
});

describe('parseQuery', () => {
  test('separates latin words and CJK runs', () => {
    expect(parseQuery('二十四桥 economy')).toEqual({ latin: ['economy'], cjkRuns: ['二十四桥'] });
  });

  test('handles mixed multi-word queries', () => {
    expect(parseQuery('digital economy 数字经济 growth')).toEqual({
      latin: ['digital', 'economy', 'growth'],
      cjkRuns: ['数字经济'],
    });
  });

  test('drops latin stopwords', () => {
    expect(parseQuery('the 二十四桥 of')).toEqual({ latin: [], cjkRuns: ['二十四桥'] });
  });
});
