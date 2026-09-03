import {
  computeRiskRangeActionability,
  resolveReferencePrice,
  computeRiskRangePercents,
  formatRiskRangePercent,
} from './riskRangePercents';

describe('resolveReferencePrice', () => {
  it('uses live spot when source is ibkr', () => {
    expect(
      resolveReferencePrice({ spot: 100.5, previousClose: 99, source: 'ibkr' })
    ).toBe(100.5);
  });

  it('uses live spot when spot differs from previous close', () => {
    expect(
      resolveReferencePrice({ spot: 105, previousClose: 100, source: 'yahoo' })
    ).toBe(105);
  });

  it('uses previous close when spot equals close (market closed)', () => {
    expect(
      resolveReferencePrice({ spot: 100, previousClose: 100, source: 'yahoo' })
    ).toBe(100);
  });

  it('falls back to spot when no previous close', () => {
    expect(resolveReferencePrice({ spot: 50, previousClose: null })).toBe(50);
  });

  it('returns null when no valid prices', () => {
    expect(resolveReferencePrice({})).toBeNull();
  });
});

describe('computeRiskRangePercents', () => {
  it('matches Hedgeye momo convention (MSTR example)', () => {
    const { upsidePct, downsidePct } = computeRiskRangePercents(167, 148, 172);
    expect(upsidePct).toBeCloseTo(2.99, 1);
    expect(downsidePct).toBeCloseTo(-11.38, 1);
  });

  it('returns null for invalid inputs', () => {
    expect(computeRiskRangePercents(0, 148, 172)).toBeNull();
    expect(computeRiskRangePercents(100, null, 172)).toBeNull();
  });
});

describe('computeRiskRangeActionability', () => {
  it('ranks the largest reported move and preserves separate upside and downside magnitudes', () => {
    const metrics = computeRiskRangeActionability(100, 80, 110);
    expect(metrics).toEqual({
      largestMovePct: 20,
      upsidePct: 10,
      downsidePct: 20,
    });
  });

  it('does not rank incomplete source ranges', () => {
    expect(computeRiskRangeActionability(100, null, 110)).toBeNull();
    expect(computeRiskRangeActionability(null, 80, 110)).toBeNull();
  });
});

describe('formatRiskRangePercent', () => {
  it('formats one decimal place', () => {
    expect(formatRiskRangePercent(3.456)).toBe('3.5%');
  });

  it('returns em dash for null', () => {
    expect(formatRiskRangePercent(null)).toBe('—');
  });
});
