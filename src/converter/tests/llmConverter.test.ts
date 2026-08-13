jest.mock('shell-path', () => () => Promise.resolve(''));

import { buildReferenceCandidate } from '../llmConverter';

describe('buildReferenceCandidate', () => {
  test('returns whole text when under the cap', () => {
    const chunks = buildReferenceCandidate('References\n\n' + 'ref text '.repeat(100));
    expect(chunks.length).toBe(1);
  });

  test('terminates when region length hits an exact chunk boundary', () => {
    const line = 'x'.repeat(100) + '\n';
    const refs = 'References\n\n' + line.repeat(201);
    const chunks = buildReferenceCandidate(refs);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(10);
  });

  test('handles empty content', () => {
    expect(buildReferenceCandidate('')).toEqual([]);
  });
});
