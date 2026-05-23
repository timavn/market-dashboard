const {
  normalizeCboeTreasuryYield,
  isTreasuryYieldSymbol,
} = require('./treasuryYieldScale.cjs');

describe('treasuryYieldScale', () => {
  describe('normalizeCboeTreasuryYield', () => {
    test('leaves modern percent quotes unchanged', () => {
      expect(normalizeCboeTreasuryYield(4.577)).toBeCloseTo(4.577, 3);
      expect(normalizeCboeTreasuryYield(5.111)).toBeCloseTo(5.111, 3);
    });

    test('scales legacy yield×10 quotes', () => {
      expect(normalizeCboeTreasuryYield(45.77)).toBeCloseTo(4.577, 3);
    });

    test('returns null for invalid input', () => {
      expect(normalizeCboeTreasuryYield(null)).toBeNull();
      expect(normalizeCboeTreasuryYield('')).toBeNull();
      expect(normalizeCboeTreasuryYield(NaN)).toBeNull();
    });
  });

  describe('isTreasuryYieldSymbol', () => {
    test('matches UST yield proxies', () => {
      expect(isTreasuryYieldSymbol('UST10Y')).toBe(true);
      expect(isTreasuryYieldSymbol('ust2y')).toBe(true);
    });

    test('does not match bond ETFs', () => {
      expect(isTreasuryYieldSymbol('LQD')).toBe(false);
      expect(isTreasuryYieldSymbol('HYG')).toBe(false);
      expect(isTreasuryYieldSymbol('TLT')).toBe(false);
    });
  });
});
