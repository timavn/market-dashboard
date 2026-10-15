import {
  csvEscape,
  formatPct,
  formatPrice,
  getAssetClassAbbreviation,
  getPortfolioWeight,
  getQuadExposureLabels,
  getVerifiedDayGainLossPercent,
  getVerifiedHoldingMark,
  holdingSourceTitle,
} from './portfolioPositionsModel';

// Deterministic test-only observations. Runtime source eligibility remains in
// the parent; these fixtures never enter a provider or an executable surface.
const liveMark = (overrides = {}) => ({
  symbol: 'GLD',
  price: 201.5,
  marketValue: 10075,
  priceState: 'live',
  marketValueState: 'live',
  priceSource: 'ibkr_live_last',
  positionSource: 'ibkr_live_session',
  priceObservedAt: '2026-09-11T15:00:00.000Z',
  referenceClose: 200,
  referenceCloseSource: 'ibkr_historical_daily_close',
  referenceCloseObservedAt: '2026-09-10T20:00:00.000Z',
  referenceCloseSessionDate: '2026-09-10',
  dayChangeState: 'live_vs_reference_close',
  dayChangeSessionDate: '2026-09-10',
  dayChangePercent: 0.75,
  ...overrides,
});
const historicalMark = (overrides = {}) => liveMark({
  price: 200,
  priceState: 'historical_close',
  marketValueState: 'historical_close',
  priceSource: 'ibkr_historical_daily_close',
  priceObservedAt: '2026-09-10T20:00:00.000Z',
  priceSessionDate: '2026-09-10',
  previousClose: 198,
  previousCloseSessionDate: '2026-09-09',
  dayChangeState: 'historical_session',
  dayChangePercent: 1.01,
  ...overrides,
});

test('keeps absolute weights separate from evidence-gated market displays', () => {
  expect(getPortfolioWeight({ marketValue: '-2500' }, '100000')).toBe(2.5);
  expect(getPortfolioWeight({ marketValue: 0 }, 100000)).toBe(0);
  [null, undefined, '', NaN, Infinity].forEach((marketValue) => {
    expect(getPortfolioWeight({ marketValue }, 100000)).toBeNull();
  });
  [null, '', 0, -1, Infinity].forEach((nav) => {
    expect(getPortfolioWeight({ marketValue: 1000 }, nav)).toBeNull();
  });
});

test('preserves price precision, percentage signs, and reviewed Gold exposure labels', () => {
  expect(formatPrice(0.12345)).toBe('$0.1235');
  expect(formatPrice('201.5')).toBe('$201.50');
  expect(formatPrice(null)).toBe('—');
  expect(formatPct(2.5, 2, { signed: true })).toBe('+2.50%');
  expect(formatPct(-2.5, 1, { signed: true })).toBe('-2.5%');
  expect(formatPct(-0, 2, { signed: true })).toBe('0.00%');
  expect(getAssetClassAbbreviation({ symbol: 'GLD' })).toBe('FX');
  expect(getQuadExposureLabels({ symbol: 'GLD' })).toEqual(['Gold']);
});

test('returns the exact source-dated live mark and rejects a missing parent evidence gate', () => {
  const holding = Object.freeze(liveMark());
  expect(getVerifiedHoldingMark(holding, true)).toEqual({
    value: 201.5,
    state: 'live',
    ariaLabel: 'Live price $201.50',
    title: 'Verified live IBKR last · observed 2026-09-11T15:00:00.000Z',
    updatedAt: '2026-09-11T15:00:00.000Z',
  });
  [false, undefined, null, 1, 'true'].forEach((verified) => {
    expect(getVerifiedHoldingMark(holding, verified)).toBeNull();
    expect(getVerifiedDayGainLossPercent(holding, verified)).toBeNull();
  });
});

test('keeps a verified session close explicitly historical with its original market date', () => {
  expect(getVerifiedHoldingMark(Object.freeze(historicalMark()), true)).toEqual({
    value: 200,
    state: 'historical_close',
    statusLabel: 'LAST CLOSE · Sep 10',
    ariaLabel: 'Last close $200.00 from 2026-09-10',
    title: 'Last close · 2026-09-10 · reference only',
    updatedAt: '2026-09-10T20:00:00.000Z',
  });
});

test('does not accept invalid, derived, mismatched, or undated display marks', () => {
  [
    liveMark({ price: null }),
    liveMark({ price: Infinity }),
    liveMark({ priceSource: 'portfolio_derived' }),
    liveMark({ priceState: 'delayed' }),
    liveMark({ priceObservedAt: 'not-a-time' }),
    historicalMark({ referenceClose: 200.0001 }),
    historicalMark({ referenceCloseSource: 'portfolio_derived' }),
    historicalMark({ referenceCloseSessionDate: '2026-09-09' }),
    historicalMark({ referenceCloseObservedAt: null }),
  ].forEach((holding) => expect(getVerifiedHoldingMark(holding, true)).toBeNull());
});

test('uses provided verified day change without recomputing it from the displayed prices', () => {
  expect(getVerifiedDayGainLossPercent(liveMark({ dayChangePercent: '9.99' }), true)).toBe(9.99);
  expect(getVerifiedDayGainLossPercent(historicalMark({ dayChangePercent: -2 }), true)).toBe(-2);
  [
    liveMark({ dayChangeSessionDate: '2026-09-09' }),
    liveMark({ referenceCloseSource: 'portfolio_derived' }),
    liveMark({ dayChangePercent: NaN }),
    historicalMark({ previousCloseSessionDate: '2026-09-10' }),
    historicalMark({ previousClose: null }),
  ].forEach((holding) => expect(getVerifiedDayGainLossPercent(holding, true)).toBeNull());
});

test('preserves source-title ordering and exact CSV escaping', () => {
  expect(holdingSourceTitle(liveMark({ warning: 'Test warning' }))).toBe(
    'pos: ibkr_live_session · price: ibkr_live_last · observed: 2026-09-11T15:00:00.000Z · Test warning',
  );
  expect(csvEscape(null)).toBe('');
  expect(csvEscape('plain')).toBe('plain');
  expect(csvEscape('one,two')).toBe('"one,two"');
  expect(csvEscape('say "yes"\nnext')).toBe('"say ""yes""\nnext"');
});
