import { prepareReferenceComparisonSnapshot, markReferenceRefreshFailed } from './dashboardReferenceProjection';
import { mergeMarketDataPreservingPeriods } from './dashboardMarketPeriods';

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const safeReference = () => ({
  available: true, current: true, comparisonSafe: true, referenceOnly: false,
  dataAvailability: { current: true, comparisonSafe: true, referenceOnly: false, canonicalSourceVerified: true },
  dataQuality: { status: 'ok', warnings: [] }, rows: [{ ticker: 'TEST' }],
  generatedAt: '2026-09-10T12:00:00Z', _cache: { stale: false },
});

test('reference projection requires explicit comparison safety without changing source identity or dates', () => {
  const reference = freeze(safeReference());
  const result = prepareReferenceComparisonSnapshot(reference, { requireAvailable: true });
  expect(result.comparisonAvailable).toBe(true);
  expect(result.rows).toBe(reference.rows);
  expect(result._cache).toBe(reference._cache);
  expect(result.generatedAt).toBe(reference.generatedAt);
  for (const change of [{ current: false }, { comparisonSafe: false }, { referenceOnly: true }, { available: false }, { dataAvailability: null }, { dataQuality: { status: 'warning' } }]) {
    expect(prepareReferenceComparisonSnapshot({ ...reference, ...change }, { requireAvailable: true }).comparisonAvailable).toBe(false);
  }
});

test('reference projection labels stale context and failed refresh without refreshing its original timestamps', () => {
  const reference = freeze({ ...safeReference(), _cache: { stale: true }, dataQuality: { status: 'ok', warnings: ['already known', 'stale reference'] } });
  const stale = prepareReferenceComparisonSnapshot(reference, { staleWarning: 'stale reference' });
  expect(stale).toMatchObject({ comparisonAvailable: false, dataQuality: { status: 'warning', warnings: ['already known', 'stale reference'] } });
  const failed = markReferenceRefreshFailed(stale, { warning: 'refresh failed', error: 'failure detail' });
  expect(failed).toMatchObject({ available: false, comparisonAvailable: false, refreshError: 'failure detail', dataQuality: { status: 'error', warnings: ['already known', 'stale reference', 'refresh failed'] } });
  expect(failed.rows).toBe(reference.rows);
  expect(failed.generatedAt).toBe(reference.generatedAt);
  expect(failed._cache).toBe(reference._cache);
  expect(reference.dataQuality.status).toBe('ok');
});

test('reference projection preserves strict availability and empty-response semantics', () => {
  expect(prepareReferenceComparisonSnapshot(null)).toEqual({ available: false, comparisonAvailable: false, dataQuality: { status: 'error', warnings: ['Reference response was unavailable.'] } });
  const reference = safeReference();
  delete reference.available;
  expect(prepareReferenceComparisonSnapshot(reference).comparisonAvailable).toBe(true);
  expect(prepareReferenceComparisonSnapshot(reference, { requireAvailable: true }).comparisonAvailable).toBe(false);
  expect(markReferenceRefreshFailed(null, { emptyState: { rows: [] }, warning: 'failed' })).toMatchObject({ rows: [], available: false, comparisonAvailable: false, refreshError: 'failed' });
});

test('period merge keeps current quote evidence separate from original dated return metadata', () => {
  const previous = freeze({ us: [{ symbol: 'SPX', price: 1, monthChangePct: 3, periodReturnsAsOf: '2026-09-09', periodReturnsSource: 'period provider', availability: 'reference', displayDelayed: true, lastVerifiedAt: 'old', sparklineData: [1, 2] }] });
  const next = freeze({ us: [{ symbol: 'SPX', price: 2, monthChangePct: null, periodReturnsAsOf: 'new quote date', source: 'quote provider', quoteAsOf: '2026-09-10', availability: 'live', sparklineData: [] }] });
  const row = mergeMarketDataPreservingPeriods(previous, next).us[0];
  expect(row).toMatchObject({ price: 2, monthChangePct: 3, periodReturnsAsOf: '2026-09-09', periodReturnsSource: 'period provider', quoteAsOf: '2026-09-10', availability: 'live' });
  expect(row).not.toHaveProperty('lastVerifiedAt');
  expect(row).not.toHaveProperty('displayDelayed');
  expect(row.sparklineData).toBe(previous.us[0].sparklineData);
  expect(next.us[0].monthChangePct).toBeNull();
});

test('period merge keeps incoming zeroes, nested rates, unchanged regions and exact replacement behavior', () => {
  const previous = freeze({ untouched: [{ symbol: 'GOLD' }], rates: { eu: [{ symbol: 'BUND', monthChangeBps: 5, monthChangePct: 2, periodReturnsStatus: 'historical', sparklineData: [1] }] } });
  const next = freeze({ rates: { eu: [{ symbol: 'BUND', monthChangeBps: 0, monthChangePct: null, sparklineData: [2] }, { symbol: 'NEW', price: 3 }], absent: null } });
  const merged = mergeMarketDataPreservingPeriods(previous, next);
  expect(merged.untouched).toBe(previous.untouched);
  expect(merged.rates.eu[0]).toMatchObject({ monthChangeBps: 0, monthChangePct: 2, periodReturnsStatus: 'historical', sparklineData: [2] });
  expect(merged.rates.eu[1]).toBe(next.rates.eu[1]);
  expect(merged.rates.absent).toBeNull();
  const replaced = mergeMarketDataPreservingPeriods(previous, next, { preservePeriods: false });
  expect(replaced.rates.eu[0].monthChangePct).toBeNull();
  expect(replaced.rates.eu[0]).not.toHaveProperty('periodReturnsStatus');
});

test('a new monthly calculation clears unsupported short periods rather than reviving cached returns', () => {
  const previous = { rates: [{ symbol: 'BUND', fifteenDayChangePct: 3.57,
    periodReturnsAsOf: '2026-07-01', periodReturnsStatus: 'historical' }] };
  const next = { rates: [{ symbol: 'BUND', fifteenDayChangePct: null, monthChangePct: 3.57,
    periodReturnsAsOf: '2026-08-01', periodReturnsStatus: 'historical', periodObservationFrequency: 'monthly' }] };
  expect(mergeMarketDataPreservingPeriods(previous, next).rates[0]).toEqual(next.rates[0]);
});

test('daily official observations do not borrow returns from a different monthly series', () => {
  const previous = { rates: [{ symbol: 'BUND', monthChangePct: 3.57,
    latestObservationChange: { interval: 'monthly' },
    periodReturnsAsOf: '2026-08-01', periodReturnsStatus: 'historical',
    periodSourceSeriesId: 'FRED_MONTHLY', periodObservationFrequency: 'monthly' }] };
  const next = { rates: [{ symbol: 'BUND', price: 3.58, sourceSeriesId: 'OFFICIAL_DAILY',
    observationFrequency: 'daily', periodReturnsStatus: 'unavailable' }] };
  const merged = mergeMarketDataPreservingPeriods(previous, next).rates[0];
  expect(merged).toEqual(next.rates[0]);
});

test('a daily fallback cannot inherit another provider benchmark history without a matching series', () => {
  const previous = { rates: [{ symbol: 'BUND', monthChangePct: 5,
    backdropPercentageReturns: { monthChangePct: 5 }, periodReturnsSource: 'bundesbank',
    periodSourceSeriesId: 'OFFICIAL_DAILY', periodObservationFrequency: 'daily',
    periodReturnsAsOf: '2026-09-25', periodReturnsStatus: 'historical' }] };
  const next = { rates: [{ symbol: 'BUND', price: 3.7, source: 'trading_economics',
    observationFrequency: 'daily', periodReturnsStatus: 'unavailable' }] };
  expect(mergeMarketDataPreservingPeriods(previous, next).rates[0]).toEqual(next.rates[0]);
});
