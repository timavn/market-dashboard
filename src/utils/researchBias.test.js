const {
  CANONICAL_RESEARCH_BIASES,
  isCanonicalResearchBias,
  normalizeResearchBias,
} = require('./researchBias.cjs');

describe('research bias vocabulary', () => {
  test.each([
    ['BULLISH', 'BULLISH'],
    ['bull', 'BULLISH'],
    ['LONG', 'BULLISH'],
    ['BUY', 'BULLISH'],
    ['POSITIVE', 'BULLISH'],
    ['BEARISH', 'BEARISH'],
    ['bear', 'BEARISH'],
    ['SHORT', 'BEARISH'],
    ['SELL', 'BEARISH'],
    ['NEGATIVE', 'BEARISH'],
    ['NEUTRAL', 'NEUTRAL'],
    ['hold', 'NEUTRAL'],
    ['flat', 'NEUTRAL'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeResearchBias(raw)).toBe(expected);
  });

  test('rejects unknown values and only recognizes canonical output labels', () => {
    expect(normalizeResearchBias('momentum is weak')).toBeNull();
    expect(normalizeResearchBias(null)).toBeNull();
    expect(isCanonicalResearchBias('BULLISH')).toBe(true);
    expect(isCanonicalResearchBias('NEGATIVE')).toBe(false);
    expect(CANONICAL_RESEARCH_BIASES).toEqual(['BULLISH', 'NEUTRAL', 'BEARISH']);
  });

  test('reads an explicit structured bias without treating arbitrary text as one', () => {
    expect(normalizeResearchBias({ value: 'BEARISH' })).toBe('BEARISH');
    expect(normalizeResearchBias({ trend: 'negative' })).toBe('BEARISH');
    expect(normalizeResearchBias({ side: 'SHORT' })).toBeNull();
  });
});
