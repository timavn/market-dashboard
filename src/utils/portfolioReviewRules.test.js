import { evaluatePortfolioRule, portfolioPositionNeedsAttention, PORTFOLIO_WEIGHT_TOLERANCE_PP, sortPortfolioConflicts, sortPortfolioPositions, summarizePortfolioRules } from './portfolioReviewRules';

const asOf = '2026-09-04T20:05:00Z';
const beta = value => ({ value, observations: 252, status: 'verified_history', source: 'adjusted daily returns', asOf: '2026-09-04' });
const holding = (extra = {}) => ({ holding: 'IGV', heldSide: 'LONG', trade: 'BULLISH', trend: 'NEUTRAL', weightPct: 4, sizingInputs: { beta: beta(1) }, ...extra });

test('reports the unchanged sizing basis independently from security classification', () => {
  const managedFutures = evaluatePortfolioRule(holding({ holding: 'DBMF', securityName: 'Captured DBMF name', sizingInputs: { beta: beta(0.2) } }), asOf);
  expect(managedFutures).toMatchObject({ securityName: 'Captured DBMF name', sizingBasis: 'Beta sizing', minWeight: 4 });
  const commodity = evaluatePortfolioRule(holding({ holding: 'IBIT', sizingInputs: {} }), asOf);
  expect(commodity).toMatchObject({ sizingBasis: 'Commodity policy', minWeight: 1 });
});

test('IGV Trend break uses the canonical beta-derived MIN and NLV percentage points', () => {
  const row = evaluatePortfolioRule(holding(), asOf);
  expect(row).toMatchObject({ status: 'conflict', action: 'REDUCE', targetWeight: 2, reduction: 2, targetLabel: 'MIN' });
  expect(evaluatePortfolioRule(holding({ sizingInputs: { beta: beta(2) } }), asOf).targetWeight).toBe(1);
  expect(evaluatePortfolioRule(holding({ sizingInputs: { beta: beta(0.5) } }), asOf).status).toBe('aligned');
});

test.each([0.75, 2])('Trend break at/below MIN does not request an increase (%s)', weightPct => {
  expect(evaluatePortfolioRule(holding({ weightPct }), asOf).status).toBe('aligned');
});

test('Trade break overrides Trend and missing beta; existing short aligned with bearish Trade is not an exit', () => {
  expect(evaluatePortfolioRule(holding({ trade: 'BEARISH', trend: null, sizingInputs: {} }), asOf)).toMatchObject({ status: 'conflict', action: 'EXIT', targetWeight: 0 });
  expect(evaluatePortfolioRule(holding({ heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH' }), asOf).status).not.toBe('conflict');
  expect(evaluatePortfolioRule(holding({ heldSide: 'SHORT', trade: 'BULLISH', trend: 'BEARISH' }), asOf).action).toBe('EXIT');
});

test('unavailable signals, NLV weights, beta and future inputs never become numeric recommendations', () => {
  for (const row of [holding({ trade: null }), holding({ trend: null }), holding({ weightPct: null }), holding({ sizingInputs: {} }), holding({ sizingInputs: { beta: { ...beta(1), asOf: '2026-09-05' } } }), holding({ sizingInputs: { beta: { ...beta(1), observations: 10 } } })]) {
    expect(evaluatePortfolioRule(row, asOf)).toMatchObject({ status: 'verification', targetWeight: null, reduction: null });
  }
});

test('exits precede reductions and missing signals are excluded from conflict count', () => {
  const result = summarizePortfolioRules({ asOf, holdings: [holding(), holding({ holding: 'HYG', trade: 'BEARISH' }), holding({ holding: 'FBY', trade: null })] });
  expect(result.conflicts.map(row => row.holding)).toEqual(['HYG', 'IGV']);
  expect(result.gaps).toHaveLength(1);
  expect(result.checked).toBe(2);
});

test('verified ATR/range inputs enforce the existing MAX cap', () => {
  const result = evaluatePortfolioRule(holding({ weightPct: 8, trend: 'BULLISH', valuationPrice: 100, netLiquidation: 100000, lrr: 90, hrr: 110, sizingInputs: { beta: beta(1), atr14: { ...beta(1), observations: 20 } } }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'ABOVE_MAX', targetWeight: 6, reduction: 2 });
});

const sizedHolding = (extra = {}) => holding({
  trend: 'BULLISH', valuationPrice: 100, netLiquidation: 100000, lrr: 90, hrr: 110,
  sizingInputs: { beta: beta(1.2), atr14: { ...beta(1), observations: 20 } }, ...extra,
});

test('new sizing inputs are dated to the research review, separately from closing holdings', () => {
  const inputs = { beta: beta(1.2), atr14: { ...beta(1), observations: 14 }, referencePrice: { ...beta(100), observations: 1 } };
  const data = { asOf: '2026-09-02T01:28:00Z', reviewedAt: '2026-09-07T22:00:00Z', holdings: [sizedHolding({ weightPct: 6.1, valuationPrice: 1, sizingInputs: inputs })] };
  expect(summarizePortfolioRules(data).rows[0]).toMatchObject({ minWeight: 2, maxWeight: 5, rule: 'ABOVE_MAX', weightPct: 6.1 });
  data.holdings[0].sizingInputs = { ...inputs, referencePrice: null };
  expect(summarizePortfolioRules(data).rows[0].maxWeight).toBeNull();
  data.holdings[0].sizingInputs = { ...inputs, beta: { ...inputs.beta, asOf: '2026-09-08' } };
  expect(summarizePortfolioRules(data).rows[0].minWeight).toBeNull();
});

test.each([
  {},
  { trade: null, trend: null, lrr: null, hrr: null },
  { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -6.1 },
])('6.1%% exceeds the verified 5%% MAX even with missing signals/ranges or a short position (%j)', extra => {
  const result = evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, ...extra }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'ABOVE_MAX', weightPct: 6.1, minWeight: 2, maxWeight: 5, targetWeight: 5 });
  expect(result.reduction).toBeCloseTo(1.1);
});

test('Trade exits and Trend reductions to MIN take priority over overweight trims', () => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, trade: 'BEARISH' }), asOf)).toMatchObject({ rule: 'TRADE_BREAK', targetWeight: 0 });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, trend: 'BEARISH' }), asOf)).toMatchObject({ rule: 'TREND_BREAK', targetWeight: 2 });
});

test('compliant longs, aligned shorts, and a Trend break already at MIN stay unflagged', () => {
  for (const extra of [{ weightPct: 5 }, { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -5 }, { trend: 'NEUTRAL', weightPct: 2 }]) {
    expect(evaluatePortfolioRule(sizedHolding(extra), asOf)).toMatchObject({ status: 'aligned', maxWeight: 5, targetWeight: null, reduction: null });
  }
});

test('missing or invalid sizing evidence never turns the beta ceiling into a verified MAX', () => {
  for (const extra of [
    { sizingInputs: {} },
    { sizingInputs: { beta: beta(1.2) } },
    { sizingInputs: { beta: beta(1.2), atr14: { ...beta(1), asOf: '2026-09-05' } } },
    { valuationPrice: null },
  ]) {
    expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, ...extra }), asOf)).toMatchObject({ status: 'verification', maxWeight: null, targetWeight: null, reduction: null });
  }
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: null }), asOf)).toMatchObject({ status: 'verification', maxWeight: 5, targetWeight: null });
});

test('a verified ATR cap below MIN still requires an exit when signals are missing', () => {
  const result = evaluatePortfolioRule(sizedHolding({ trade: null, trend: null, sizingInputs: { beta: beta(1.2), atr14: beta(30) } }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'RISK_CAP', action: 'EXIT', targetWeight: 0 });
});

const publishedTrend = (extra = {}) => holding({
  holding: 'AMZN', trade: null, trend: 'BEARISH', weightPct: 2.4,
  sources: { trend: { publishedAt: '2026-09-04T14:30:00Z', citation: { id: 'published-trend', title: 'Risk Ranges' } } },
  signalContext: { trade: { status: 'unavailable', value: null }, trend: { status: 'published', value: 'BEARISH' } },
  ...extra,
});

test('AMZN independently published opposing Trend highlights a MIN breach without inventing missing Trade or an exit', () => {
  const result = evaluatePortfolioRule(publishedTrend(), asOf);
  expect(result).toMatchObject({ holding: 'AMZN', trade: null, trend: 'BEARISH', status: 'conflict', rule: 'TREND_BREAK', action: 'REDUCE', targetLabel: 'MIN', targetWeight: 2 });
  expect(result.reduction).toBeCloseTo(0.4);
  const summary = summarizePortfolioRules({ asOf, holdings: [publishedTrend()] });
  expect(summary.conflicts).toHaveLength(1);
  expect(summary.checked).toBe(0);
});

test.each([2, 2.099, 2.1, 2.1000000000000005])('a missing-Trade Trend break at %s%% stays unflagged within the 10bp MIN buffer', weightPct => {
  expect(PORTFOLIO_WEIGHT_TOLERANCE_PP).toBe(0.10);
  expect(evaluatePortfolioRule(publishedTrend({ weightPct }), asOf)).toMatchObject({ status: 'verification', trade: null, targetWeight: null, reduction: null });
});

test.each([2.1001, 2.11])('a published Trend break beyond the 10bp buffer (%s%%) keeps the original MIN target', weightPct => {
  const result = evaluatePortfolioRule(publishedTrend({ weightPct }), asOf);
  expect(result).toMatchObject({ status: 'conflict', targetWeight: 2, rule: 'TREND_BREAK' });
  expect(result.reduction).toBeCloseTo(weightPct - 2);
});

test('the same independent Trend and absolute weight comparison applies to short positions', () => {
  const source = publishedTrend();
  const short = { ...source, heldSide: 'SHORT', trend: 'BULLISH', weightPct: -2.11,
    signalContext: { ...source.signalContext, trend: { status: 'published', value: 'BULLISH' } } };
  expect(evaluatePortfolioRule(short, asOf)).toMatchObject({ status: 'conflict', rule: 'TREND_BREAK', trade: null, weightPct: 2.11, targetWeight: 2 });
  expect(evaluatePortfolioRule({ ...short, weightPct: -2.1 }, asOf).status).toBe('verification');
  expect(evaluatePortfolioRule({ ...short, trend: 'BEARISH', signalContext: {} }, asOf).status).toBe('verification');
});

test('published Trade-break exits keep priority regardless of the MIN buffer', () => {
  const row = publishedTrend({ trade: 'BEARISH', weightPct: 2.05, signalContext: {} });
  expect(evaluatePortfolioRule(row, asOf)).toMatchObject({ status: 'conflict', rule: 'TRADE_BREAK', action: 'EXIT', targetWeight: 0 });
  expect(evaluatePortfolioRule(holding({ weightPct: 2.05 }), asOf)).toMatchObject({ status: 'aligned', targetWeight: null, reason: 'Within 10 bp of MIN' });
});

test.each([5, 5.099, 5.1, 5.1000000000000005])('MAX uses the same inclusive 10bp buffer (%s%%)', weightPct => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct }), asOf)).toMatchObject({ status: 'aligned', maxWeight: 5, targetWeight: null, reduction: null });
});

test('a MAX breach just beyond the buffer trims to MAX, not MAX plus the buffer', () => {
  const result = evaluatePortfolioRule(sizedHolding({ weightPct: 5.1001 }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'ABOVE_MAX', targetWeight: 5 });
  expect(result.reduction).toBeCloseTo(0.1001);
});

test('missing, future, invalid or stale evidence cannot create the independent Trend warning', () => {
  const source = publishedTrend().sources.trend;
  const unsupported = [
    { sources: {} }, { sources: { trend: { ...source, citation: null } } },
    { sources: { trend: { ...source, publishedAt: 'not-a-date' } } },
    { sources: { trend: { ...source, publishedAt: '2026-09-05' } } },
    { sources: { trend: { ...source, stale: true } } },
    { signalContext: { trend: { status: 'conflict', value: 'BEARISH' } } },
    { heldSide: null }, { heldSide: 'BUY' }, { weightPct: null }, { weightPct: true },
    { sizingInputs: {} }, { sizingInputs: { beta: { ...beta(1), source: ' ' } } },
    { sizingInputs: { beta: { ...beta(1), asOf: '2026-08-20' } } },
    { sizingInputs: { beta: { ...beta(1), asOf: '2026-09-05' } } },
    { sizingInputs: { beta: { ...beta(1), observations: 20 } } },
    ...['stale', 'offline', 'cache-only', 'mock', 'seeded', 'inferred'].map(status => ({ sizingInputs: { beta: { ...beta(1), status } } })),
    ...['stale', 'cacheOnly', 'mock', 'seeded'].map(flag => ({ sizingInputs: { beta: { ...beta(1), [flag]: true } } })),
  ];
  for (const extra of unsupported) {
    expect(evaluatePortfolioRule(publishedTrend(extra), asOf)).toMatchObject({ status: 'verification', targetWeight: null, reduction: null });
  }
  expect(evaluatePortfolioRule(publishedTrend(), 'invalid')).toMatchObject({ status: 'verification', targetWeight: null });
});

test('product indications never fill missing published Trade or Trend or assert a Trade-break exit', () => {
  const row = publishedTrend();
  const indicatedTrade = { ...row, signalContext: { ...row.signalContext, trade: { status: 'indication', value: 'BEARISH' } } };
  expect(evaluatePortfolioRule(indicatedTrade, asOf)).toMatchObject({ status: 'conflict', trade: null, rule: 'TREND_BREAK', action: 'REDUCE' });
  expect(evaluatePortfolioRule({ ...indicatedTrade, trade: 'BEARISH' }, asOf)).toMatchObject({ trade: null, rule: 'TREND_BREAK', action: 'REDUCE' });
  for (const trend of [null, 'BEARISH']) {
    expect(evaluatePortfolioRule({ ...row, trend, signalContext: { trend: { status: 'indication', value: 'BEARISH' } } }, asOf))
      .toMatchObject({ trend: null, status: 'verification', targetWeight: null });
  }
});

test('catalog commodity policy establishes IBIT MIN without beta and still requires verified ATR for MAX', () => {
  const ibit = publishedTrend({ holding: 'IBIT', weightPct: 1.2, sizingInputs: {} });
  expect(evaluatePortfolioRule(ibit, asOf)).toMatchObject({ minWeight: 1, maxWeight: null, rule: 'TREND_BREAK', targetWeight: 1 });
  const aligned = { ...ibit, trade: 'BULLISH', trend: 'BULLISH', signalContext: {}, sources: {}, weightPct: 4.11,
    valuationPrice: 100, sizingInputs: { atr14: { ...beta(1), observations: 20 } } };
  expect(evaluatePortfolioRule(aligned, asOf)).toMatchObject({ minWeight: 1, maxWeight: 4, rule: 'ABOVE_MAX', targetWeight: 4 });
  expect(evaluatePortfolioRule({ ...aligned, sizingInputs: { atr14: { ...beta(1), status: 'stale' } } }, asOf))
    .toMatchObject({ minWeight: 1, maxWeight: null, status: 'verification', targetWeight: null });
});

test('within each side confirmed exits and reductions sort first by deviation, then alphabetically without mutating rows', () => {
  const rows = [
    { holding: 'AAPL', status: 'aligned' }, { holding: 'ZGAP', status: 'verification' },
    { holding: 'ZEXIT', status: 'conflict', action: 'EXIT', reduction: 1 },
    { holding: 'AMZN', status: 'conflict', action: 'REDUCE', reduction: 0.4 },
    { holding: 'BIG', status: 'conflict', action: 'REDUCE', reduction: 2 },
    { holding: 'AEXIT', status: 'conflict', action: 'EXIT', reduction: 1 },
    { holding: 'ASMALL', status: 'conflict', action: 'REDUCE', reduction: 0.4 },
  ];
  const original = [...rows];
  expect(sortPortfolioPositions(rows).map(row => row.holding)).toEqual(['AEXIT', 'ZEXIT', 'BIG', 'AMZN', 'ASMALL', 'AAPL', 'ZGAP']);
  expect(rows).toEqual(original);
  expect(rows.filter(row => portfolioPositionNeedsAttention(row))).toHaveLength(5);
});

test('only captured confirmed stop coverage issues join flagged rows when explicitly enabled', () => {
  const row = (holding, status, extra = {}) => ({ holding, status: 'aligned', stopCheck: { status, ...extra } });
  const rows = [row('AAPL', 'covered'), row('ZSTOP', 'missing'), row('BSTOP', 'partial'), row('CSTOP', 'oversized'), row('DSTOP', 'wrong_side'), row('EVERIFY', 'verify'), row('FUNAVAILABLE', 'unavailable'), row('GSTALE', 'missing', { stale: true })];
  const options = { includeStopIssues: true };
  expect(sortPortfolioPositions(rows, options).map(item => item.holding)).toEqual(['BSTOP', 'CSTOP', 'DSTOP', 'ZSTOP', 'AAPL', 'EVERIFY', 'FUNAVAILABLE', 'GSTALE']);
  expect(rows.filter(item => portfolioPositionNeedsAttention(item, options))).toHaveLength(4);
  expect(rows.some(item => portfolioPositionNeedsAttention(item))).toBe(false);
  expect(sortPortfolioPositions(rows).map(item => item.holding)).toEqual(['AAPL', 'BSTOP', 'CSTOP', 'DSTOP', 'EVERIFY', 'FUNAVAILABLE', 'GSTALE', 'ZSTOP']);
});

test('weight flags compare captured absolute weights with displayed limits without requiring complete signals', () => {
  const over = evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, trade: null, trend: null, lrr: null, hrr: null }), asOf);
  expect(over).toMatchObject({ weightStatus: 'overweight', maxWeight: 5, action: 'REDUCE' });
  expect(over.weightDeviation).toBeCloseTo(1.1);
  const under = evaluatePortfolioRule(sizedHolding({ heldSide: 'SHORT', weightPct: -1, trade: null, trend: null }), asOf);
  expect(under).toMatchObject({ weightPct: 1, minWeight: 2, weightStatus: 'underweight', weightDeviation: 1, status: 'verification', targetWeight: null, reduction: null });
  expect(under.action).toBeUndefined();
  expect(portfolioPositionNeedsAttention(under)).toBe(true);
});

test.each([1.9, 1.9000000000000001, 1.8999999999999995, 2, 5, 5.1, 5.1000000000000005])('weight %s%% stays within the inclusive 10bp band buffer', weightPct => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct }), asOf)).toMatchObject({ weightStatus: null, weightDeviation: null });
});

test.each([
  [1.8999, 'underweight'],
  [5.1001, 'overweight'],
])('a weight of %s%% just beyond the band buffer is %s', (weightPct, weightStatus) => {
  const row = evaluatePortfolioRule(sizedHolding({ weightPct }), asOf);
  expect(row.weightStatus).toBe(weightStatus);
  expect(row.weightDeviation).toBeCloseTo(0.1001);
});

test('below MIN remains informational for aligned, BENCH and EXIT holdings', () => {
  const active = evaluatePortfolioRule(sizedHolding({ weightPct: 1 }), asOf);
  const bench = evaluatePortfolioRule(sizedHolding({ weightPct: 1, trend: 'NEUTRAL' }), asOf);
  const exit = evaluatePortfolioRule(sizedHolding({ weightPct: 1, trade: 'BEARISH' }), asOf);
  for (const row of [active, bench]) {
    expect(row).toMatchObject({ status: 'aligned', weightStatus: 'underweight', weightDeviation: 1, targetWeight: null, reduction: null });
    expect(row.action).toBeUndefined();
  }
  expect(exit).toMatchObject({ status: 'conflict', rule: 'TRADE_BREAK', action: 'EXIT', weightStatus: 'underweight', weightDeviation: 1, targetWeight: 0, reduction: 1 });
  const summary = summarizePortfolioRules({ asOf, holdings: [sizedHolding({ weightPct: 1 })] });
  expect(summary.conflicts).toHaveLength(0);
  expect(portfolioPositionNeedsAttention(summary.rows[0])).toBe(true);
});

test('independent weight flags preserve stricter Trend MIN reductions and Trade exits', () => {
  const trend = evaluatePortfolioRule(sizedHolding({ weightPct: 6, trend: 'NEUTRAL' }), asOf);
  expect(trend).toMatchObject({ rule: 'TREND_BREAK', action: 'REDUCE', weightStatus: 'overweight', weightDeviation: 1, targetWeight: 2, reduction: 4 });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 4, trend: 'NEUTRAL' }), asOf))
    .toMatchObject({ rule: 'TREND_BREAK', targetWeight: 2, weightStatus: null, weightDeviation: null });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6, trade: 'BEARISH' }), asOf))
    .toMatchObject({ rule: 'TRADE_BREAK', action: 'EXIT', weightStatus: 'overweight', weightDeviation: 1, targetWeight: 0, reduction: 6 });
});

test('known MIN can establish underweight without a final MAX, but unavailable limits cannot establish a weight flag', () => {
  const minOnly = evaluatePortfolioRule(holding({ trend: 'BULLISH', weightPct: 1 }), asOf);
  expect(minOnly).toMatchObject({ minWeight: 2, maxWeight: null, weightStatus: 'underweight', weightDeviation: 1 });
  const fixedMin = evaluatePortfolioRule(holding({ holding: 'IBIT', weightPct: 0.5, sizingInputs: {} }), asOf);
  expect(fixedMin).toMatchObject({ minWeight: 1, maxWeight: null, weightStatus: 'underweight', weightDeviation: 0.5 });
  for (const extra of [
    { weightPct: 7, sizingInputs: { beta: beta(1.2) } },
    { weightPct: 7, sizingInputs: { beta: beta(1.2), atr14: { ...beta(1), stale: true } } },
    { weightPct: 7, sizingInputs: { beta: beta(1.2), atr14: beta(1), referencePrice: null } },
    { weightPct: 1, sizingInputs: {} },
    { weightPct: 1, sizingInputs: { beta: { ...beta(1.2), status: 'mock' } } },
    { weightPct: 1, sizingInputs: { beta: { ...beta(1.2), asOf: '2026-09-05' } } },
  ]) {
    expect(evaluatePortfolioRule(sizedHolding(extra), asOf)).toMatchObject({ weightStatus: null, weightDeviation: null });
  }
});

test('an ATR cap below MIN suppresses underweight but retains a verified MAX overage and exit', () => {
  const inputs = { beta: beta(1.2), atr14: beta(30) };
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 0.1, sizingInputs: inputs }), asOf))
    .toMatchObject({ minWeight: 2, maxWeight: 0.5, action: 'EXIT', rule: 'RISK_CAP', weightStatus: null, weightDeviation: null });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 1, sizingInputs: inputs }), asOf))
    .toMatchObject({ minWeight: 2, maxWeight: 0.5, action: 'EXIT', rule: 'RISK_CAP', weightStatus: 'overweight', weightDeviation: 0.5 });
});

test('invalid captured holding evidence, side or weight never produces a weight flag', () => {
  const invalid = [
    { available: false }, { verified: false }, { connected: false },
    ...['stale', 'offline', 'disconnected', 'cacheOnly', 'mock', 'seed', 'seeded', 'inferred', 'synthetic', 'fallback'].map(flag => ({ [flag]: true })),
    ...['unverified', 'stale', 'offline', 'cache-only', 'mock', 'seeded', 'error'].map(status => ({ status })),
    { freshness: 'stale' }, { heldSide: null }, { heldSide: 'BUY' },
    ...[null, true, '', NaN, Infinity, 'unknown'].map(weightPct => ({ weightPct })),
  ];
  for (const extra of invalid) {
    for (const weightPct of [1, 7]) {
      expect(evaluatePortfolioRule(sizedHolding({ weightPct, ...extra }), asOf))
        .toMatchObject({ weightStatus: null, weightDeviation: null });
    }
  }
});

test('weight classification requires a valid review time even for catalog MIN and permits verified historical snapshots', () => {
  const fixed = holding({ holding: 'IBIT', weightPct: 0.5, sizingInputs: {} });
  for (const invalidDate of [undefined, null, '', 'not-a-date']) {
    expect(evaluatePortfolioRule(fixed, invalidDate)).toMatchObject({ weightStatus: null, weightDeviation: null });
  }
  expect(evaluatePortfolioRule(sizedHolding({ historical: true, verifiedAtCapture: true, weightPct: 1 }), asOf))
    .toMatchObject({ weightStatus: 'underweight', weightDeviation: 1 });
});

test('optional weight sorting groups preferred flags first by deviation, then keeps existing conflict order', () => {
  const rows = [
    { holding: 'NORMAL', status: 'aligned' },
    { holding: 'UNDER_BIG', status: 'aligned', weightStatus: 'underweight', weightDeviation: 3 },
    { holding: 'OVER_SMALL', status: 'conflict', action: 'REDUCE', reduction: 1, weightStatus: 'overweight', weightDeviation: 1 },
    { holding: 'EXIT', status: 'conflict', action: 'EXIT', reduction: 5 },
    { holding: 'OVER_BIG', status: 'aligned', weightStatus: 'overweight', weightDeviation: 2 },
    { holding: 'OVER_EXIT', status: 'conflict', action: 'EXIT', reduction: 7, weightStatus: 'overweight', weightDeviation: 2 },
    { holding: 'UNDER_SMALL', status: 'aligned', weightStatus: 'underweight', weightDeviation: 0.5 },
    { holding: 'STOP', status: 'aligned', stopCheck: { status: 'missing' } },
  ];
  const original = [...rows];
  expect(sortPortfolioPositions(rows, { preferredWeightStatus: 'overweight' }).map(row => row.holding))
    .toEqual(['OVER_EXIT', 'OVER_BIG', 'OVER_SMALL', 'UNDER_BIG', 'UNDER_SMALL', 'EXIT', 'NORMAL', 'STOP']);
  expect(sortPortfolioPositions(rows, { preferredWeightStatus: 'underweight' }).map(row => row.holding))
    .toEqual(['UNDER_BIG', 'UNDER_SMALL', 'OVER_EXIT', 'OVER_BIG', 'OVER_SMALL', 'EXIT', 'NORMAL', 'STOP']);
  expect(sortPortfolioPositions(rows).map(row => row.holding))
    .toEqual(['OVER_EXIT', 'EXIT', 'OVER_SMALL', 'OVER_BIG', 'UNDER_BIG', 'UNDER_SMALL', 'NORMAL', 'STOP']);
  expect(sortPortfolioConflicts(rows.filter(row => row.status === 'conflict')).map(row => row.holding))
    .toEqual(['OVER_EXIT', 'EXIT', 'OVER_SMALL']);
  expect(rows).toEqual(original);
});
