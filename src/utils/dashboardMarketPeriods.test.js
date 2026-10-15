import {
  mergeMarketDataPreservingPeriods,
  mergeMarketRowPreservingPeriods,
} from './dashboardMarketPeriods';

const indexHistory = (symbol = 'SPX', overrides = {}) => ({
  symbol,
  source: 'yahoo',
  price: 7695,
  fifteenDayChangePct: 2.75,
  monthChangePct: 4.87,
  threeMonthChangePct: 2.21,
  sixMonthChangePct: 8.74,
  ytdChangePct: 8.21,
  oneYearChangePct: 10.01,
  periodReturnsStatus: 'historical',
  periodReturnsAsOf: '2026-09-29',
  periodReturnsSource: 'yahoo',
  periodSourceSeriesId: symbol === 'SPX' ? '^GSPC' : '^RUT',
  periodObservationFrequency: 'daily',
  ...overrides,
});

const indexQuote = (symbol = 'SPX', overrides = {}) => ({
  symbol,
  source: 'ibkr',
  price: 7700,
  availability: 'current',
  quoteAsOf: '2026-09-30T15:00:00.000Z',
  periodReturnsStatus: 'unavailable',
  periodReturnsAsOf: null,
  periodReturnsSource: null,
  periodSourceSeriesId: null,
  periodObservationFrequency: null,
  fifteenDayChangePct: null,
  monthChangePct: null,
  threeMonthChangePct: null,
  sixMonthChangePct: null,
  ytdChangePct: null,
  oneYearChangePct: null,
  ...overrides,
});

test.each(['SPX', 'RUT'])('keeps native %s history when a live quote uses another provider', (symbol) => {
  const history = Object.freeze(indexHistory(symbol));
  const quote = Object.freeze(indexQuote(symbol));
  const [merged] = mergeMarketDataPreservingPeriods({ us: [history] }, { us: [quote] }).us;
  expect(merged).toMatchObject({
    source: 'ibkr', price: 7700, availability: 'current', quoteAsOf: quote.quoteAsOf,
    fifteenDayChangePct: 2.75, monthChangePct: 4.87, threeMonthChangePct: 2.21,
    sixMonthChangePct: 8.74, ytdChangePct: 8.21, oneYearChangePct: 10.01,
    periodReturnsStatus: 'historical', periodReturnsAsOf: history.periodReturnsAsOf,
    periodReturnsSource: 'yahoo', periodSourceSeriesId: history.periodSourceSeriesId,
    periodObservationFrequency: 'daily',
  });
  expect(merged.periodReturnProvenance.oneYearChangePct).toMatchObject({
    asOf: history.periodReturnsAsOf, source: 'yahoo', sourceSeriesId: history.periodSourceSeriesId,
    retained: true,
  });
  expect(quote.oneYearChangePct).toBeNull();
  expect(history.source).toBe('yahoo');
});

test('a partial daily calculation preserves each missing return and its original date', () => {
  const history = indexHistory();
  const incoming = indexHistory('SPX', {
    fifteenDayChangePct: null, monthChangePct: 0, oneYearChangePct: null,
    periodReturnsAsOf: '2026-09-30',
  });
  const merged = mergeMarketRowPreservingPeriods(history, incoming);
  expect(merged).toMatchObject({
    fifteenDayChangePct: 2.75, monthChangePct: 0, oneYearChangePct: 10.01,
    periodReturnsAsOf: '2026-09-30',
  });
  expect(merged.periodReturnProvenance.oneYearChangePct).toMatchObject({
    asOf: '2026-09-29', source: 'yahoo', sourceSeriesId: '^GSPC', retained: true,
  });
  const nextQuote = mergeMarketRowPreservingPeriods(merged, indexQuote());
  expect(nextQuote.periodReturnProvenance.oneYearChangePct.asOf).toBe('2026-09-29');
  expect(nextQuote.periodReturnProvenance.monthChangePct.asOf).toBe('2026-09-30');
});

test.each([
  { source: 'trading_economics', observationFrequency: 'daily' },
  { source: 'bundesbank', sourceSeriesId: 'DIFFERENT_DAILY', observationFrequency: 'daily' },
])('does not merge incompatible sovereign benchmark observations: %j', (current) => {
  const previous = indexHistory('BUND', {
    periodReturnsSource: 'bundesbank', periodSourceSeriesId: 'OFFICIAL_DAILY',
  });
  const incoming = indexQuote('BUND', current);
  const merged = mergeMarketRowPreservingPeriods(previous, incoming);
  expect(merged.monthChangePct).toBeNull();
  expect(merged.periodReturnsStatus).toBe('unavailable');
  expect(merged).not.toHaveProperty('periodReturnProvenance');
});

test('does not transfer monthly observations into a daily benchmark quote', () => {
  const previous = indexHistory('BUND', { periodObservationFrequency: 'monthly' });
  const merged = mergeMarketRowPreservingPeriods(previous, indexQuote('BUND', { observationFrequency: 'daily' }));
  expect(merged.fifteenDayChangePct).toBeNull();
  expect(merged.monthChangePct).toBeNull();
});

test('an explicit monthly calculation clears unsupported short horizons', () => {
  const previous = indexHistory('BUND', { periodObservationFrequency: 'monthly' });
  const incoming = indexHistory('BUND', {
    periodObservationFrequency: 'monthly', periodReturnsAsOf: '2026-09-30', fifteenDayChangePct: null,
  });
  expect(mergeMarketRowPreservingPeriods(previous, incoming).fifteenDayChangePct).toBeNull();
});

test('a different historical series cannot inherit missing fields from the prior series', () => {
  const previous = indexHistory('BUND', { periodSourceSeriesId: 'OFFICIAL_DAILY' });
  const incoming = indexHistory('BUND', {
    periodSourceSeriesId: 'DIFFERENT_DAILY', periodReturnsAsOf: '2026-09-30', oneYearChangePct: null,
  });
  const merged = mergeMarketRowPreservingPeriods(previous, incoming);
  expect(merged.oneYearChangePct).toBeNull();
  expect(merged).not.toHaveProperty('periodReturnProvenance');
});

test.each([
  { periodReturnsSource: 'mock' }, { periodReturnsSource: 'seed' },
  { periodReturnsSource: 'cache-only' }, { periodReturnsSource: 'portfolio' },
  { periodReturnsStatus: 'unavailable' }, { periodReturnsAsOf: 'invalid' },
])('does not inherit rejected independent period evidence: %j', (invalid) => {
  expect(mergeMarketRowPreservingPeriods(indexHistory('SPX', invalid), indexQuote()).oneYearChangePct).toBeNull();
});
