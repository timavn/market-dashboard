const {
  buildCorrelationCacheKey,
  buildCorrelationRequestSignature,
  computePortfolioCorrelationConcentration,
  getCorrelationScorableSymbols,
  resolveExpectedValueLabel,
} = require('./portfolioCorrelationConcentration');

function historyFromReturns(returns, start = 100) {
  let close = start;
  const rows = [{ date: '2026-01-01', close }];
  returns.forEach((ret, index) => {
    close *= Math.exp(ret);
    const day = String(index + 2).padStart(2, '0');
    rows.push({ date: `2026-01-${day}`, close });
  });
  return rows;
}

const goldReturns = Array.from({ length: 40 }, (_, index) => (
  index % 5 === 0 ? 0.012 : index % 3 === 0 ? -0.006 : 0.004
));

describe('portfolio correlation concentration', () => {
  test('clusters AAAU, GLD, and Newmont-style exposure as one gold concentration', () => {
    const result = computePortfolioCorrelationConcentration({
      holdings: [
        { symbol: 'AAAU', description: 'Gold Trust', marketValue: 10000, quantity: 100 },
        { symbol: 'GLD', description: 'Gold', marketValue: 15000, quantity: 50 },
        { symbol: 'NEM', description: 'Newmont Mining', marketValue: 8000, quantity: 120 },
      ],
      totalValue: 100000,
      histories: {
        AAAU: historyFromReturns(goldReturns, 25),
        GLD: historyFromReturns(goldReturns.map((ret) => ret * 1.01), 180),
        NEM: historyFromReturns(goldReturns.map((ret, index) => ret * 1.15 + (index % 2 ? 0.0003 : -0.0003)), 45),
      },
      windows: [30],
      primaryWindow: 30,
      asOf: '2026-06-10T00:00:00.000Z',
    });

    expect(result.coverage.scoredCount).toBe(3);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].label).toBe('Gold');
    expect(result.clusters[0].grossClusterPct).toBeCloseTo(33, 1);
    expect(result.clusters[0].members.map((member) => member.symbol).sort()).toEqual(['AAAU', 'GLD', 'NEM']);
  });

  test('shows high gross cluster exposure but reduced net exposure for a long/short pair', () => {
    const result = computePortfolioCorrelationConcentration({
      holdings: [
        { symbol: 'GLD', description: 'Gold', marketValue: 10000, quantity: 50 },
        { symbol: 'NEM', description: 'Newmont Mining', marketValue: -10000, quantity: -120 },
      ],
      totalValue: 100000,
      histories: {
        GLD: historyFromReturns(goldReturns, 180),
        NEM: historyFromReturns(goldReturns.map((ret) => ret * 1.1), 45),
      },
      windows: [30],
      primaryWindow: 30,
    });

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].grossClusterPct).toBeCloseTo(20, 1);
    expect(result.clusters[0].netClusterPct).toBeCloseTo(0, 1);
    expect(result.scores.grossPct).toBeCloseTo(20, 1);
    expect(result.scores.netPct).toBeCloseTo(0, 1);
  });

  test('excludes cash and flags unscored instruments explicitly', () => {
    const result = computePortfolioCorrelationConcentration({
      holdings: [
        { symbol: 'CASH', description: 'Cash & Cash Investments', marketValue: 20000, quantity: 1, assetClass: 'cash' },
        { symbol: 'GLD', description: 'Gold', marketValue: 10000, quantity: 50 },
        { symbol: 'SPY 240621C00500000', description: 'SPY call option', marketValue: 5000, quantity: 1, assetClass: 'Options' },
        { symbol: 'THIN', description: 'No History Name', marketValue: 5000, quantity: 10 },
      ],
      totalValue: 100000,
      histories: {
        GLD: historyFromReturns(goldReturns, 180),
      },
      windows: [30],
      primaryWindow: 30,
    });

    expect(result.coverage.scoredCount).toBe(1);
    expect(result.coverage.cashPct).toBeCloseTo(20, 1);
    expect(result.coverage.unscoredCount).toBe(2);
    expect(result.unscored.map((item) => item.symbol).sort()).toEqual(['SPY 240621C00500000', 'THIN']);
  });

  test('inherits +EV label from nearest correlated anchor for an unmapped ticker', () => {
    const result = computePortfolioCorrelationConcentration({
      holdings: [
        { symbol: 'GLD', description: 'Gold', marketValue: 10000, quantity: 50 },
        { symbol: 'MINR', description: 'Acme Royalty Co', marketValue: 7000, quantity: 100 },
      ],
      totalValue: 100000,
      histories: {
        GLD: historyFromReturns(goldReturns, 180),
        MINR: historyFromReturns(goldReturns.map((ret) => ret * 0.9), 35),
      },
      windows: [30],
      primaryWindow: 30,
    });

    const inherited = result.clusters[0].members.find((member) => member.symbol === 'MINR');
    expect(inherited.label).toBe('Gold');
    expect(inherited.labelSource).toBe('correlated-anchor');
  });
});

describe('resolveExpectedValueLabel', () => {
  test('uses direct +EV labels first', () => {
    expect(resolveExpectedValueLabel({ symbol: 'GLD' })).toMatchObject({
      label: 'Gold',
      labelSource: 'expected-value',
    });
  });
});

describe('correlation request normalization', () => {
  const baseHoldings = [
    { symbol: 'NEM', description: 'Newmont Mining', marketValue: -8000, quantity: -120, assetClass: 'Equity' },
    { symbol: 'GLD', description: 'Gold', marketValue: 10000, quantity: 50, assetClass: 'ETF' },
  ];

  test('builds the same signature for equivalent holdings with new identities/order', () => {
    const first = buildCorrelationRequestSignature(baseHoldings, 100000);
    const second = buildCorrelationRequestSignature([
      { ...baseHoldings[1] },
      { ...baseHoldings[0] },
    ], 100000);

    expect(second).toBe(first);
  });

  test('ignores market-value drift below the default weight bucket', () => {
    const first = buildCorrelationRequestSignature(baseHoldings, 100000);
    const drifted = buildCorrelationRequestSignature([
      { ...baseHoldings[0], marketValue: -8010 },
      { ...baseHoldings[1], marketValue: 10020 },
    ], 100000);

    expect(drifted).toBe(first);
  });

  test('changes signature for meaningful weight moves and side flips', () => {
    const first = buildCorrelationRequestSignature(baseHoldings, 100000);
    const weightMove = buildCorrelationRequestSignature([
      { ...baseHoldings[0] },
      { ...baseHoldings[1], marketValue: 10300 },
    ], 100000);
    const sideFlip = buildCorrelationRequestSignature([
      { ...baseHoldings[0], marketValue: 8000, quantity: 120 },
      { ...baseHoldings[1] },
    ], 100000);

    expect(weightMove).not.toBe(first);
    expect(sideFlip).not.toBe(first);
  });

  test('filters scorable symbols before backend history fetch selection', () => {
    const symbols = getCorrelationScorableSymbols([
      ...baseHoldings,
      { symbol: 'GLD', description: 'Duplicate gold', marketValue: 1000, quantity: 5, assetClass: 'ETF' },
      { symbol: 'CASH', description: 'Cash & Cash Investments', marketValue: 20000, assetClass: 'Cash' },
      { symbol: 'SPY 240621C00500000', description: 'SPY call option', marketValue: 5000, assetClass: 'Options' },
      { symbol: 'ZERO', description: 'Zero value', marketValue: 0, assetClass: 'Equity' },
      { symbol: '', description: 'Missing symbol', marketValue: 5000, assetClass: 'Equity' },
    ]);

    expect(symbols).toEqual(['GLD', 'NEM']);
  });

  test('builds identical cache keys for identical requests', () => {
    const first = buildCorrelationCacheKey({
      holdings: baseHoldings,
      totalValue: 100000,
      windows: [90, 30],
      primaryWindow: 90,
    });
    const second = buildCorrelationCacheKey({
      holdings: baseHoldings.map((holding) => ({ ...holding })),
      totalValue: 100000,
      windows: [30, 90],
      primaryWindow: 90,
    });

    expect(second).toBe(first);
  });
});
