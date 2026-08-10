import { tokenize } from '../tokenizer';

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
