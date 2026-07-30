import {
  buildPortfolioFactorExposure,
  holdingMatchesFactorExposure,
} from './portfolioFactorExposure';

describe('buildPortfolioFactorExposure', () => {
  test('splits multi-tagged positions equally within the selected dimension and nets both books', () => {
    const exposure = buildPortfolioFactorExposure([
      { symbol: 'QQQ', marketValue: 9000 },
      { symbol: 'QQQ', marketValue: -3000 },
    ], 100000, 'equityStyleFactors');

    expect(exposure.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'High Beta',
        longPct: 3,
        shortPct: 1,
        netPct: 2,
      }),
      expect.objectContaining({
        label: 'Momentum',
        longPct: 3,
        shortPct: 1,
        netPct: 2,
      }),
      expect.objectContaining({
        label: 'Secular Growth',
        longPct: 3,
        shortPct: 1,
        netPct: 2,
      }),
    ]));
    expect(exposure.coverage).toEqual({ classifiedPct: 12, unclassifiedPct: 0 });
  });

  test('tracks unclassified NAV separately and never assigns it to a factor', () => {
    const exposure = buildPortfolioFactorExposure([
      { symbol: 'QQQ', marketValue: 10000 },
      { symbol: 'NOT-A-REVIEWED-SYMBOL', marketValue: -5000 },
    ], 100000, 'equityStyleFactors');

    expect(exposure.coverage).toEqual({ classifiedPct: 10, unclassifiedPct: 5 });
    expect(exposure.rows.some(({ label }) => label === 'Unclassified')).toBe(false);
  });

  test('uses each tab dimension independently when assigning a holding', () => {
    const exposure = buildPortfolioFactorExposure([
      { symbol: 'QQQ', marketValue: 10000 },
    ], 100000, 'assetClasses');

    expect(exposure.rows).toEqual([
      expect.objectContaining({ label: 'Equities', longPct: 10, shortPct: 0, netPct: 10 }),
    ]);
  });

  test('matches a holding only when the requested reviewed factor is present', () => {
    expect(holdingMatchesFactorExposure(
      { symbol: 'QQQ' },
      'equityStyleFactors',
      'equity-style-factor-momentum',
    )).toBe(true);
    expect(holdingMatchesFactorExposure(
      { symbol: 'QQQ' },
      'equityStyleFactors',
      'equity-style-factor-value',
    )).toBe(false);
  });
});
