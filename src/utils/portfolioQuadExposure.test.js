import {
  aggregatePortfolioQuadExposures,
  classifyPositionAlignment,
  compareQuadFit,
  getPortfolioExposureAvailability,
} from './portfolioQuadExposure';

const liveHolding = ({
  symbol,
  conid,
  quantity = 1,
  marketValue,
  ...overrides
}) => ({
  symbol,
  conid,
  accountId: 'U1',
  quantity,
  marketValue,
  price: Math.abs(marketValue / quantity),
  priceState: 'live',
  marketValueState: 'live',
  priceSource: 'ibkr_live_last',
  priceObservedAt: '2026-07-26T18:00:00.000Z',
  positionSource: 'ibkr_live_session',
  secType: 'STK',
  currency: 'USD',
  exchange: 'SMART',
  ...overrides,
});

const livePortfolio = (holdings, overrides = {}) => ({
  accountId: 'U1',
  dataSource: 'ibkr_api',
  liveSessionVerified: true,
  fromCache: false,
  summary: { totalValue: 100000 },
  accountSummary: { netLiquidation: 100000 },
  dataQuality: { status: 'ok', markState: 'live' },
  holdings,
  ...overrides,
});

const exposureByLabel = (result, label) => (
  result.exposures.find((exposure) => exposure.label === label)
);

describe('portfolio Quad exposure aggregation', () => {
  test('counts every gold-linked security at full weight in the Gold overlap', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({ symbol: 'GLD', conid: 101, quantity: 100, marketValue: 10000 }),
        liveHolding({ symbol: 'GDX', conid: 102, quantity: 200, marketValue: 20000 }),
      ]),
      currentQuad: 'Quad 3',
      previousQuad: 'q2',
    });

    const gold = exposureByLabel(result, 'Gold');
    const materials = exposureByLabel(result, 'Materials');
    const equities = exposureByLabel(result, 'Equities');

    expect(result.availability.available).toBe(true);
    expect(gold).toMatchObject({
      longPct: 30,
      shortPct: 0,
      grossPct: 30,
      netPct: 30,
      positionCount: 2,
      currentFit: { status: 'favored', rank: 1 },
    });
    expect(materials.grossPct).toBe(20);
    expect(equities.grossPct).toBe(20);
    expect(gold.contributors.map((row) => row.symbol)).toEqual(['GDX', 'GLD']);
    expect(result.positions[1].labels.find((label) => label.label === 'Gold')).toMatchObject({
      isPrimary: false,
      quadFits: {
        q3: { status: 'favored', rank: 1 },
        q4: { status: 'favored', rank: 2 },
      },
    });
  });

  test('keeps long, short, gross, and net percentages distinct', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({ symbol: 'GLD', conid: 201, quantity: 60, marketValue: 60000 }),
        liveHolding({ symbol: 'GOLD', conid: 202, quantity: -25, marketValue: -25000 }),
      ]),
      currentQuad: 'q3',
      previousQuad: 'q2',
    });

    expect(exposureByLabel(result, 'Gold')).toMatchObject({
      longPct: 60,
      shortPct: 25,
      grossPct: 85,
      netPct: 35,
      alignment: 'mixed',
    });
  });

  test('marks long Credit as opposed when Q2 best deteriorates to Q3 worst', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({ symbol: 'CLOX', conid: 301, quantity: 200, marketValue: 20000 }),
      ]),
      currentQuad: 3,
      previousQuad: 2,
    });

    expect(exposureByLabel(result, 'Credit')).toMatchObject({
      previousFit: { status: 'favored', rank: 3 },
      currentFit: { status: 'unfavorable', rank: 1 },
      transition: 'deteriorated',
      alignment: 'opposed',
    });
    expect(
      result.positions[0].labels.find((label) => label.label === 'Credit'),
    ).toMatchObject({
      transition: 'deteriorated',
      alignment: 'opposed',
    });
  });

  test('keeps unknown symbols explicitly unclassified and reports their live weight', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({ symbol: 'ZZZZ', conid: 401, quantity: 150, marketValue: 15000 }),
      ]),
      currentQuad: 'q3',
      previousQuad: 'q2',
    });

    expect(result.positions[0]).toMatchObject({
      classificationStatus: 'unclassified',
      primaryExposureId: null,
      secondaryExposureIds: [],
      labels: [],
      grossWeightPct: 15,
      alignment: 'unscored',
    });
    expect(result.exposures).toEqual([]);
    expect(result.coverage).toMatchObject({
      totalPositionCount: 1,
      classifiedPositionCount: 0,
      unclassifiedPositionCount: 1,
      unclassifiedGrossWeightPct: 15,
      unclassifiedShareOfGrossPct: 100,
    });
  });

  test('uses account and conid to distinguish duplicate symbols', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({
          symbol: 'GLD',
          localSymbol: 'GLD',
          conid: 501,
          quantity: 10,
          marketValue: 10000,
        }),
        liveHolding({
          symbol: 'GLD',
          localSymbol: 'GLD JUL26 200 C',
          conid: 502,
          quantity: 5,
          marketValue: 5000,
        }),
      ]),
      currentQuad: 'q3',
    });

    expect(result.positions.map((position) => position.positionKey)).toEqual([
      'U1#501',
      'U1#502',
    ]);
    expect(result.positions[1]).toMatchObject({
      symbol: 'GLD',
      localSymbol: 'GLD JUL26 200 C',
      conid: 502,
      secType: 'STK',
      quantity: 5,
    });
  });

  test.each([
    ['stale quality', { dataQuality: { status: 'stale', markState: 'live' } }],
    ['partial quality', { dataQuality: { status: 'partial', markState: 'live' } }],
    ['missing quality proof', { dataQuality: { markState: 'live' } }],
    ['reference marks', { dataQuality: { status: 'stale', markState: 'reference' } }],
    ['cache', { fromCache: true }],
    ['cache-only', { cacheOnly: true }],
    ['mock', { mock: true }],
    ['seed', { seed: true }],
    ['offline', { liveSessionVerified: false }],
    ['uploaded source', { dataSource: 'uploaded_statement' }],
  ])('fails closed for %s but preserves reviewed labels', (_name, unsafeOverride) => {
    const portfolioData = livePortfolio([
      liveHolding({ symbol: 'GLD', conid: 601, quantity: 100, marketValue: 10000 }),
    ], unsafeOverride);
    const result = aggregatePortfolioQuadExposures({
      portfolioData,
      currentQuad: 'q3',
      previousQuad: 'q2',
    });

    expect(result.availability.available).toBe(false);
    expect(result.exposures).toEqual([]);
    expect(result.nav).toBeNull();
    expect(result.positions[0]).toMatchObject({
      classificationStatus: 'reviewed',
      marketValue: null,
      weightPct: null,
      grossWeightPct: null,
      weightAvailability: false,
    });
    expect(result.positions[0].labels.map((label) => label.label)).toContain('Gold');
    expect(result.coverage.classifiedGrossWeightPct).toBeNull();
    expect(result.coverage.unclassifiedGrossWeightPct).toBeNull();
  });

  test.each([
    ['missing market value', { marketValue: null }],
    ['reference price', { priceState: 'historical_close', marketValueState: 'historical_close' }],
    ['unverified price source', { priceSource: 'ibkr_portfolio' }],
    ['missing observation time', { priceObservedAt: null }],
    ['unverified source', { positionSource: 'uploaded_statement' }],
  ])('withholds all weighted rows when one holding has %s', (_name, holdingOverride) => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({ symbol: 'GLD', conid: 701, quantity: 100, marketValue: 10000 }),
        liveHolding({
          symbol: 'GDX',
          conid: 702,
          quantity: 50,
          marketValue: 5000,
          ...holdingOverride,
        }),
      ]),
      currentQuad: 'q3',
    });

    expect(result.availability.available).toBe(false);
    expect(result.exposures).toEqual([]);
    expect(result.positions.every((position) => (
      position.weightPct === null
      && position.grossWeightPct === null
      && position.marketValue === null
    ))).toBe(true);
  });

  test('requires a positive NAV and accepts summary total value when NLV is absent', () => {
    const holding = liveHolding({
      symbol: 'GLD',
      conid: 801,
      quantity: 10,
      marketValue: 5000,
    });
    const withoutNav = livePortfolio([holding], {
      summary: { totalValue: null },
      accountSummary: { netLiquidation: 0 },
    });
    expect(getPortfolioExposureAvailability(withoutNav)).toMatchObject({
      available: false,
      code: 'nav_unavailable',
    });

    const summaryNav = livePortfolio([holding], {
      summary: { totalValue: 50000 },
      accountSummary: { netLiquidation: null },
    });
    expect(getPortfolioExposureAvailability(summaryNav)).toMatchObject({
      available: true,
      nav: 50000,
      navSource: 'summary.totalValue',
    });
  });

  test('keeps derivatives labeled but unweighted without verified economic exposure', () => {
    const result = aggregatePortfolioQuadExposures({
      portfolioData: livePortfolio([
        liveHolding({
          symbol: 'GLD',
          localSymbol: 'GLD JUL26 200 C',
          conid: 901,
          secType: 'OPT',
          quantity: 1,
          marketValue: 1200,
        }),
      ]),
      currentQuad: 'q3',
    });

    expect(result.availability.available).toBe(true);
    expect(result.exposures).toEqual([]);
    expect(result.positions[0]).toMatchObject({
      classificationStatus: 'reviewed',
      secType: 'OPT',
      marketValue: null,
      weightPct: null,
      weightAvailability: false,
    });
    expect(result.positions[0].labels.map((label) => label.label)).toContain('Gold');
  });
});

describe('Quad fit helpers', () => {
  test('compares best/worst transitions and ranks', () => {
    expect(compareQuadFit(
      { status: 'best', rank: 3 },
      { status: 'worst', rank: 1 },
    )).toBe('deteriorated');
    expect(compareQuadFit({
      previousFit: { status: 'favored', rank: 4 },
      currentFit: { status: 'favored', rank: 1 },
    })).toBe('improved');
    expect(compareQuadFit(
      { status: 'worst', rank: 1 },
      { status: 'worst', rank: 5 },
    )).toBe('improved');
  });

  test('classifies position direction against normalized fit statuses', () => {
    expect(classifyPositionAlignment('long', { status: 'best', rank: 1 })).toBe('aligned');
    expect(classifyPositionAlignment('long', { status: 'worst', rank: 1 })).toBe('opposed');
    expect(classifyPositionAlignment({
      side: 'short',
      currentFit: { status: 'unfavorable', rank: 1 },
    })).toBe('aligned');
    expect(classifyPositionAlignment('short', { status: 'not-listed' })).toBe('unscored');
  });
});
