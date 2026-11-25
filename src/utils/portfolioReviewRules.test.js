import { evaluatePortfolioRule, portfolioPositionNeedsAttention, PORTFOLIO_WEIGHT_TOLERANCE_PP, sortPortfolioConflicts, sortPortfolioPositions, summarizePortfolioRules } from './portfolioReviewRules';

const asOf = '2026-09-04T20:05:00Z';
const metric = (value, observations) => ({ value, observations, status: 'verified_history', source: 'adjusted daily bars', asOf: '2026-09-04' });
const atr = value => metric(value, 14);
const price = value => metric(value, 1);
const beta = value => ({ ...metric(value, 252), source: 'adjusted daily returns' });
// ATR 2.5 on a 100 reference price: 2 × 2.5% = 5% stop distance, so MIN = 0.125 / 5% = 2.5 and MAX = 0.25 / 5% = 5.
const inputs = (atrValue = 2.5, priceValue = 100) => ({ atr14: atr(atrValue), referencePrice: price(priceValue) });
const holding = (extra = {}) => ({ holding: 'IGV', heldSide: 'LONG', trade: 'BULLISH', trend: 'NEUTRAL', weightPct: 4, sizingInputs: inputs(), ...extra });

test('every security, including managed futures and IBIT, is sized from its own ATR', () => {
  const managedFutures = evaluatePortfolioRule(holding({ holding: 'DBMF', securityName: 'Captured DBMF name' }), asOf);
  expect(managedFutures).toMatchObject({ securityName: 'Captured DBMF name', sizingBasis: 'ATR sizing', minWeight: 2.5, maxWeight: 5 });
  expect(evaluatePortfolioRule(holding({ holding: 'IBIT' }), asOf)).toMatchObject({ sizingBasis: 'ATR sizing', minWeight: 2.5, maxWeight: 5 });
  expect(evaluatePortfolioRule(holding({ holding: 'IBIT', sizingInputs: {} }), asOf)).toMatchObject({ sizingBasis: 'ATR sizing', minWeight: null, maxWeight: null });
});

test('IGV Trend break uses the canonical ATR-derived MIN and NLV percentage points', () => {
  const row = evaluatePortfolioRule(holding(), asOf);
  expect(row).toMatchObject({ status: 'conflict', action: 'REDUCE', targetWeight: 2.5, reduction: 1.5, targetLabel: 'MIN' });
  // ATR 5 on 100: 10% stop distance → MIN 1.25.
  expect(evaluatePortfolioRule(holding({ sizingInputs: inputs(5) }), asOf).targetWeight).toBe(1.25);
  // ATR 1 on 100 is below the 1.25% floor → MIN 5, so 4% is already below MIN.
  expect(evaluatePortfolioRule(holding({ sizingInputs: inputs(1) }), asOf)).toMatchObject({ status: 'aligned', minWeight: 5, maxWeight: 10 });
});

test('MIN, MAX and the stop come from the 14-day ATR and reference price', () => {
  // ATR 2 on 100: 4% stop distance → MIN roundUp(3.125) = 3.25, MAX roundDown(6.25) = 6.25.
  const long = evaluatePortfolioRule(holding({ trend: 'BULLISH', weightPct: 5, sizingInputs: inputs(2) }), asOf);
  expect(long).toMatchObject({ sizingBasis: 'ATR sizing', minWeight: 3.25, maxWeight: 6.25, stopPrice: 96, atrFloorApplied: false, volatilityBlocked: false });
  expect(long.atrPct).toBeCloseTo(2);
  expect(long.stopDistancePct).toBeCloseTo(4);
  expect(long.stopLossPctNlv).toBeCloseTo(0.2);
  const short = evaluatePortfolioRule(holding({ heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -5, sizingInputs: inputs(2) }), asOf);
  expect(short).toMatchObject({ minWeight: 3.25, maxWeight: 6.25, stopPrice: 104 });
  for (const removed of ['beta', 'atrCapWeight', 'atrCapBelowMin']) expect(long).not.toHaveProperty(removed);
});

test('the 1.25% ATR floor caps MAX at 10% while the stop keeps the measured ATR', () => {
  const floored = evaluatePortfolioRule(holding({ trend: 'BULLISH', weightPct: 5, sizingInputs: inputs(1) }), asOf);
  expect(floored).toMatchObject({ minWeight: 5, maxWeight: 10, atrFloorApplied: true, stopPrice: 98 });
  expect(floored.atrPct).toBeCloseTo(1);
  expect(floored.stopDistancePct).toBeCloseTo(2);
  expect(floored.stopLossPctNlv).toBeCloseTo(0.1);
  expect(evaluatePortfolioRule(holding({ sizingInputs: inputs(1.25) }), asOf)).toMatchObject({ minWeight: 5, maxWeight: 10, atrFloorApplied: false, stopPrice: 97.5 });
});

test('beta inputs are ignored and never produce a band on their own', () => {
  const withBeta = evaluatePortfolioRule(holding({ sizingInputs: { ...inputs(), beta: beta(3) } }), asOf);
  expect(withBeta).toMatchObject({ minWeight: 2.5, maxWeight: 5, targetWeight: 2.5 });
  expect(evaluatePortfolioRule(holding({ sizingInputs: { beta: beta(1) } }), asOf)).toMatchObject({
    status: 'verification', reason: 'Trend changed; MIN comparison needs verified ATR and price', minWeight: null, maxWeight: null,
    atrPct: null, stopPrice: null, stopDistancePct: null, stopLossPctNlv: null,
  });
});

test.each([0.75, 2.5])('Trend break at/below MIN does not request an increase (%s)', weightPct => {
  expect(evaluatePortfolioRule(holding({ weightPct }), asOf).status).toBe('aligned');
});

test('Trade break overrides Trend and missing ATR; existing short aligned with bearish Trade is not an exit', () => {
  expect(evaluatePortfolioRule(holding({ trade: 'BEARISH', trend: null, sizingInputs: {} }), asOf)).toMatchObject({ status: 'conflict', action: 'EXIT', targetWeight: 0 });
  expect(evaluatePortfolioRule(holding({ heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH' }), asOf).status).not.toBe('conflict');
  expect(evaluatePortfolioRule(holding({ heldSide: 'SHORT', trade: 'BULLISH', trend: 'BEARISH' }), asOf).action).toBe('EXIT');
});

test('unavailable signals, NLV weights, ATR/price and future inputs never become numeric recommendations', () => {
  for (const row of [holding({ trade: null }), holding({ trend: null }), holding({ weightPct: null }), holding({ sizingInputs: {} }),
    holding({ sizingInputs: { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-09-05' } } }), holding({ sizingInputs: { ...inputs(), atr14: { ...atr(2.5), observations: 13 } } }),
    holding({ sizingInputs: { ...inputs(), referencePrice: { ...price(100), asOf: '2026-09-05' } } })]) {
    expect(evaluatePortfolioRule(row, asOf)).toMatchObject({ status: 'verification', targetWeight: null, reduction: null });
  }
});

test('exits precede reductions and missing signals are excluded from conflict count', () => {
  const result = summarizePortfolioRules({ asOf, holdings: [holding(), holding({ holding: 'HYG', trade: 'BEARISH' }), holding({ holding: 'FBY', trade: null })] });
  expect(result.conflicts.map(row => row.holding)).toEqual(['HYG', 'IGV']);
  expect(result.gaps).toHaveLength(1);
  expect(result.checked).toBe(2);
});

const sizedHolding = (extra = {}) => holding({
  trend: 'BULLISH', netLiquidation: 100000, lrr: 90, hrr: 110, ...extra,
});

test('a cash-like holding has no size limit', () => {
  const result = evaluatePortfolioRule(sizedHolding({ holding: 'TBIL', weightPct: 60 }), asOf);
  expect(result).toMatchObject({ minWeight: 0, maxWeight: 100, weightStatus: null });
  expect(result.rule).not.toBe('ABOVE_MAX');
  expect(evaluatePortfolioRule({ ...sizedHolding({ holding: 'TBIL', weightPct: 60 }), sizingInputs: {} }, asOf).rule).toBeUndefined();
});

test('verified ATR/range inputs enforce the ATR-derived MAX', () => {
  const result = evaluatePortfolioRule(sizedHolding({ weightPct: 8 }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'ABOVE_MAX', targetWeight: 5, reduction: 3 });
});

test('new sizing inputs are dated to the research review, separately from closing holdings', () => {
  const data = { asOf: '2026-09-02T01:28:00Z', reviewedAt: '2026-09-07T22:00:00Z', holdings: [sizedHolding({ weightPct: 6.1, valuationPrice: 1, sizingInputs: inputs() })] };
  expect(summarizePortfolioRules(data).rows[0]).toMatchObject({ minWeight: 2.5, maxWeight: 5, stopPrice: 95, rule: 'ABOVE_MAX', weightPct: 6.1 });
  data.holdings[0].sizingInputs = { ...inputs(), referencePrice: null };
  expect(summarizePortfolioRules(data).rows[0]).toMatchObject({ minWeight: null, maxWeight: null, stopPrice: null });
  data.holdings[0].sizingInputs = { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-09-08' } };
  expect(summarizePortfolioRules(data).rows[0].minWeight).toBeNull();
});

test.each([
  {},
  { trade: null, trend: null, lrr: null, hrr: null },
  { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -6.1 },
])('6.1%% exceeds the verified 5%% MAX even with missing signals/ranges or a short position (%j)', extra => {
  const result = evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, ...extra }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'ABOVE_MAX', weightPct: 6.1, minWeight: 2.5, maxWeight: 5, targetWeight: 5 });
  expect(result.reduction).toBeCloseTo(1.1);
});

test('Trade exits and Trend reductions to MIN take priority over overweight trims', () => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, trade: 'BEARISH' }), asOf)).toMatchObject({ rule: 'TRADE_BREAK', targetWeight: 0 });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, trend: 'BEARISH' }), asOf)).toMatchObject({ rule: 'TREND_BREAK', targetWeight: 2.5 });
});

test('compliant longs, aligned shorts, and a Trend break already at MIN stay unflagged', () => {
  for (const extra of [{ weightPct: 5 }, { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -5 }, { trend: 'NEUTRAL', weightPct: 2.5 }]) {
    expect(evaluatePortfolioRule(sizedHolding(extra), asOf)).toMatchObject({ status: 'aligned', maxWeight: 5, targetWeight: null, reduction: null });
  }
});

test('missing or invalid ATR/price evidence never produces a verified MAX', () => {
  for (const extra of [
    { sizingInputs: {} },
    { sizingInputs: { beta: beta(1.2) } },
    { sizingInputs: { referencePrice: price(100) } },
    { sizingInputs: { atr14: atr(2.5) } },
    { sizingInputs: { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-09-05' } } },
    { sizingInputs: { ...inputs(), referencePrice: { ...price(100), status: 'stale' } } },
  ]) {
    expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6.1, ...extra }), asOf)).toMatchObject({
      status: 'verification', reason: 'Position limits need verified ATR and price', maxWeight: null, stopPrice: null, targetWeight: null, reduction: null,
    });
  }
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: null }), asOf)).toMatchObject({ status: 'verification', maxWeight: 5, targetWeight: null });
  // Without a captured reference price the valuation price stands in.
  expect(evaluatePortfolioRule(sizedHolding({ valuationPrice: 100, sizingInputs: { atr14: atr(2.5) } }), asOf)).toMatchObject({ minWeight: 2.5, maxWeight: 5, stopPrice: 95 });
});

// ATR 60 on 100: MIN rounds up to 0.25 while MAX rounds down to 0, so no band exists.
const tooVolatile = () => inputs(60);

test('an ATR too large to size still requires an exit when signals are missing', () => {
  const result = evaluatePortfolioRule(sizedHolding({ trade: null, trend: null, sizingInputs: tooVolatile() }), asOf);
  expect(result).toMatchObject({ status: 'conflict', rule: 'RISK_CAP', action: 'EXIT', targetWeight: 0, volatilityBlocked: true, minWeight: 0.25, maxWeight: 0 });
  // At exactly half the price MIN and MAX meet at 0.25, which is still a band.
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 0.25, sizingInputs: inputs(50) }), asOf)).toMatchObject({ status: 'aligned', volatilityBlocked: false, minWeight: 0.25, maxWeight: 0.25 });
});

const publishedTrend = (extra = {}) => holding({
  holding: 'AMZN', trade: null, trend: 'BEARISH', weightPct: 2.9,
  sources: { trend: { publishedAt: '2026-09-04T14:30:00Z', citation: { id: 'published-trend', title: 'Risk Ranges' } } },
  signalContext: { trade: { status: 'unavailable', value: null }, trend: { status: 'published', value: 'BEARISH' } },
  ...extra,
});

test('AMZN independently published opposing Trend highlights a MIN breach without inventing missing Trade or an exit', () => {
  const result = evaluatePortfolioRule(publishedTrend(), asOf);
  expect(result).toMatchObject({ holding: 'AMZN', trade: null, trend: 'BEARISH', status: 'conflict', rule: 'TREND_BREAK', action: 'REDUCE', targetLabel: 'MIN', targetWeight: 2.5 });
  expect(result.reduction).toBeCloseTo(0.4);
  const summary = summarizePortfolioRules({ asOf, holdings: [publishedTrend()] });
  expect(summary.conflicts).toHaveLength(1);
  expect(summary.checked).toBe(0);
});

test.each([2.5, 2.599, 2.6, 2.6000000000000005])('a missing-Trade Trend break at %s%% stays unflagged within the 10bp MIN buffer', weightPct => {
  expect(PORTFOLIO_WEIGHT_TOLERANCE_PP).toBe(0.10);
  expect(evaluatePortfolioRule(publishedTrend({ weightPct }), asOf)).toMatchObject({ status: 'verification', trade: null, targetWeight: null, reduction: null });
});

test.each([2.6001, 2.61])('a published Trend break beyond the 10bp buffer (%s%%) keeps the original MIN target', weightPct => {
  const result = evaluatePortfolioRule(publishedTrend({ weightPct }), asOf);
  expect(result).toMatchObject({ status: 'conflict', targetWeight: 2.5, rule: 'TREND_BREAK' });
  expect(result.reduction).toBeCloseTo(weightPct - 2.5);
});

test('the same independent Trend and absolute weight comparison applies to short positions', () => {
  const source = publishedTrend();
  const short = { ...source, heldSide: 'SHORT', trend: 'BULLISH', weightPct: -2.61,
    signalContext: { ...source.signalContext, trend: { status: 'published', value: 'BULLISH' } } };
  expect(evaluatePortfolioRule(short, asOf)).toMatchObject({ status: 'conflict', rule: 'TREND_BREAK', trade: null, weightPct: 2.61, targetWeight: 2.5, stopPrice: 105 });
  expect(evaluatePortfolioRule({ ...short, weightPct: -2.6 }, asOf).status).toBe('verification');
  expect(evaluatePortfolioRule({ ...short, trend: 'BEARISH', signalContext: {} }, asOf).status).toBe('verification');
});

test('published Trade-break exits keep priority regardless of the MIN buffer', () => {
  const row = publishedTrend({ trade: 'BEARISH', weightPct: 2.55, signalContext: {} });
  expect(evaluatePortfolioRule(row, asOf)).toMatchObject({ status: 'conflict', rule: 'TRADE_BREAK', action: 'EXIT', targetWeight: 0 });
  expect(evaluatePortfolioRule(holding({ weightPct: 2.55 }), asOf)).toMatchObject({ status: 'aligned', targetWeight: null, reason: 'Within 10 bp of MIN' });
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
    { sizingInputs: {} }, { sizingInputs: { beta: beta(1) } }, { sizingInputs: { ...inputs(), atr14: { ...atr(2.5), source: ' ' } } },
    { sizingInputs: { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-08-20' } } },
    { sizingInputs: { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-09-05' } } },
    { sizingInputs: { ...inputs(), atr14: { ...atr(2.5), observations: 13 } } },
    { sizingInputs: { ...inputs(), referencePrice: { ...price(100), asOf: '2026-09-05' } } },
    ...['stale', 'offline', 'cache-only', 'mock', 'seeded', 'inferred'].map(status => ({ sizingInputs: { ...inputs(), atr14: { ...atr(2.5), status } } })),
    ...['stale', 'cacheOnly', 'mock', 'seeded'].map(flag => ({ sizingInputs: { ...inputs(), atr14: { ...atr(2.5), [flag]: true } } })),
    ...['stale', 'mock'].map(flag => ({ sizingInputs: { ...inputs(), referencePrice: { ...price(100), [flag]: true } } })),
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
  expect(under).toMatchObject({ weightPct: 1, minWeight: 2.5, weightStatus: 'underweight', weightDeviation: 1.5, status: 'verification', targetWeight: null, reduction: null });
  expect(under.action).toBeUndefined();
  expect(portfolioPositionNeedsAttention(under)).toBe(true);
});

test.each([2.4, 2.4000000000000004, 2.3999999999999995, 2.5, 5, 5.1, 5.1000000000000005])('weight %s%% stays within the inclusive 10bp band buffer', weightPct => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct }), asOf)).toMatchObject({ weightStatus: null, weightDeviation: null });
});

test.each([
  [2.3999, 'underweight'],
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
    expect(row).toMatchObject({ status: 'aligned', weightStatus: 'underweight', weightDeviation: 1.5, targetWeight: null, reduction: null });
    expect(row.action).toBeUndefined();
  }
  expect(exit).toMatchObject({ status: 'conflict', rule: 'TRADE_BREAK', action: 'EXIT', weightStatus: 'underweight', weightDeviation: 1.5, targetWeight: 0, reduction: 1 });
  const summary = summarizePortfolioRules({ asOf, holdings: [sizedHolding({ weightPct: 1 })] });
  expect(summary.conflicts).toHaveLength(0);
  expect(portfolioPositionNeedsAttention(summary.rows[0])).toBe(true);
});

test('independent weight flags preserve stricter Trend MIN reductions and Trade exits', () => {
  const trend = evaluatePortfolioRule(sizedHolding({ weightPct: 6, trend: 'NEUTRAL' }), asOf);
  expect(trend).toMatchObject({ rule: 'TREND_BREAK', action: 'REDUCE', weightStatus: 'overweight', weightDeviation: 1, targetWeight: 2.5, reduction: 3.5 });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 4, trend: 'NEUTRAL' }), asOf))
    .toMatchObject({ rule: 'TREND_BREAK', targetWeight: 2.5, weightStatus: null, weightDeviation: null });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 6, trade: 'BEARISH' }), asOf))
    .toMatchObject({ rule: 'TRADE_BREAK', action: 'EXIT', weightStatus: 'overweight', weightDeviation: 1, targetWeight: 0, reduction: 6 });
});

test('verified ATR limits establish underweight without a risk range, but unavailable limits cannot establish a weight flag', () => {
  const noRange = evaluatePortfolioRule(holding({ trend: 'BULLISH', weightPct: 1 }), asOf);
  expect(noRange).toMatchObject({ minWeight: 2.5, maxWeight: 5, weightStatus: 'underweight', weightDeviation: 1.5 });
  for (const extra of [
    { weightPct: 7, sizingInputs: { beta: beta(1.2) } },
    { weightPct: 7, sizingInputs: { ...inputs(), atr14: { ...atr(2.5), stale: true } } },
    { weightPct: 7, sizingInputs: { ...inputs(), referencePrice: null } },
    { weightPct: 1, sizingInputs: {} },
    { weightPct: 1, sizingInputs: { ...inputs(), atr14: { ...atr(2.5), status: 'mock' } } },
    { weightPct: 1, sizingInputs: { ...inputs(), atr14: { ...atr(2.5), asOf: '2026-09-05' } } },
  ]) {
    expect(evaluatePortfolioRule(sizedHolding(extra), asOf)).toMatchObject({ weightStatus: null, weightDeviation: null });
  }
});

test('a volatility-blocked band suppresses underweight but retains the overage above its zero MAX and the exit', () => {
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 0.1, sizingInputs: tooVolatile() }), asOf))
    .toMatchObject({ minWeight: 0.25, maxWeight: 0, volatilityBlocked: true, action: 'EXIT', rule: 'RISK_CAP', weightStatus: null, weightDeviation: null });
  expect(evaluatePortfolioRule(sizedHolding({ weightPct: 1, sizingInputs: tooVolatile() }), asOf))
    .toMatchObject({ minWeight: 0.25, maxWeight: 0, volatilityBlocked: true, action: 'EXIT', rule: 'RISK_CAP', weightStatus: 'overweight', weightDeviation: 1 });
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

test('weight classification requires a valid review time even with verified ATR inputs and permits verified historical snapshots', () => {
  const fixed = holding({ weightPct: 0.5 });
  for (const invalidDate of [undefined, null, '', 'not-a-date']) {
    expect(evaluatePortfolioRule(fixed, invalidDate)).toMatchObject({ weightStatus: null, weightDeviation: null });
  }
  expect(evaluatePortfolioRule(sizedHolding({ historical: true, verifiedAtCapture: true, weightPct: 1 }), asOf))
    .toMatchObject({ weightStatus: 'underweight', weightDeviation: 1.5 });
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
