import {
  buildPortfolioFactorExposure,
  buildPortfolioQuadExposure,
  holdingMatchesFactorExposure,
} from './portfolioFactorExposure';
import { HEDGEYE_EXPOSURE_LIST } from '../constants/quadExposureCatalog';

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

describe('buildPortfolioQuadExposure', () => {
  test('includes every worksheet factor and zeros for unheld factors', () => {
    const rows = buildPortfolioQuadExposure([
      { symbol: 'OIH', marketValue: 4500 },
      { symbol: 'OIH', marketValue: -1500 },
    ], 100000, true);
    expect(rows.map(row => row.id)).toEqual(HEDGEYE_EXPOSURE_LIST.map(factor => factor.id));
    expect(rows.find(row => row.label === 'Energy')).toMatchObject({
      longPct: 4.5, shortPct: 1.5, netPct: 3, grossPct: 6,
      quadFits: { q2: { status: 'best', rank: 4 }, q4: { status: 'worst', rank: 1 } },
    });
    expect(rows.find(row => row.label === 'Utilities')).toMatchObject({ longPct: 0, shortPct: 0, netPct: 0 });
    expect(rows.find(row => row.label === 'Equities').longPct).toBe(4.5);
  });

  test.each([null, 0, NaN])('keeps ranks but withholds exposure without valid NAV (%s)', nav => {
    const rows = buildPortfolioQuadExposure([{ symbol: 'OIH', marketValue: 4500 }], nav, true);
    expect(rows.every(row => row.longPct === null && row.shortPct === null && row.netPct === null)).toBe(true);
    expect(rows.find(row => row.label === 'Energy').quadFits.q3).toEqual({ status: 'best', rank: 2 });
  });

  test('does not turn unavailable portfolio values into zero exposure', () => {
    const rows = buildPortfolioQuadExposure([{ symbol: 'OIH', marketValue: 4500 }], 100000, false);
    expect(rows.every(row => row.longPct === null && row.shortPct === null && row.netPct === null)).toBe(true);
  });

  test('excludes custom and unclassified categories without reassigning their exposure', () => {
    const rows = buildPortfolioQuadExposure([
      { symbol: 'OIH', marketValue: 4500 },
      { symbol: 'IBIT', marketValue: 10000 },
      { symbol: 'DBMF', marketValue: 3000 },
      { symbol: 'UNREVIEWED', marketValue: -2500 },
    ], 100000, true);
    expect(rows).toHaveLength(45);
    expect(rows.map(row => row.label)).not.toEqual(expect.arrayContaining(['Cash', 'Cryptocurrency', 'Managed Futures', 'Unclassified']));
    expect(rows.find(row => row.label === 'Energy').netPct).toBe(4.5);
    expect(rows.find(row => row.label === 'Equities').netPct).toBe(4.5);
  });
});
