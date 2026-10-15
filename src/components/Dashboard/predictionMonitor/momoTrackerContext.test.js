import {
  currentMomoSpot,
  newYorkDateKey,
  normalizeMomoTrackerSnapshot,
  normalizeVerifiedMomoTrackerSpots,
} from './momoTrackerContext';

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('keeps publication acceptance tied to the New York date across midnight without mutating the source', () => {
  const beforeMidnight = Date.parse('2026-09-11T03:59:59.999Z');
  const tickers = ['MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA'];
  const payload = freeze({
    date: '2026-09-10', snapshotType: 'momo-tracker', reportType: 'momo-tracker',
    publishedAt: '2026-09-10T12:15:00.000Z', meta: { stockCount: 8 },
    data: Object.fromEntries(tickers.map((ticker, index) => [ticker, {
      buyTrade: 100 + index, sellTrade: 110 + index, upside: 1.2, downside: -2.3,
      trend: 'BULLISH', rangeStatus: 'available', index,
    }])),
  });
  const before = JSON.stringify(payload);
  expect(newYorkDateKey(beforeMidnight)).toBe('2026-09-10');
  expect(newYorkDateKey(beforeMidnight + 1)).toBe('2026-09-11');
  const normalized = normalizeMomoTrackerSnapshot(payload, beforeMidnight);
  expect(normalized).toMatchObject({ status: 'available', publicationDate: '2026-09-10', publishedAt: payload.publishedAt });
  expect(normalized.rows.map((row) => row.ticker)).toEqual(tickers);
  expect(normalizeMomoTrackerSnapshot(payload, beforeMidnight + 1)).toEqual({
    status: 'unavailable', rows: [], publicationDate: null, publishedAt: null,
    reason: "Today's Hedgeye MOMO Tracker is not published yet. Latest publication: 2026-09-10.",
  });
  expect(JSON.stringify(payload)).toBe(before);
});

test('preserves direct-live spot age boundaries, normalization, identity and offline rejection', () => {
  const nowMs = Date.parse('2026-09-10T18:00:00.000Z');
  const ages = { MSFT: 60_000, NVDA: -5_000, OLD: 60_001, FUTURE: -5_001 };
  const quotes = freeze(Object.fromEntries(Object.entries(ages).map(([symbol, age]) => [symbol, {
    symbol, last: '500.25', timestamp: new Date(nowMs - age).toISOString(),
    source: ' IBKR ', dataType: ' LIVE ', entitlementStatus: 'entitled',
  }])));
  const tickers = [' msft ', 'MSFT', 'NVDA', 'OLD', 'FUTURE'];
  const normalized = normalizeVerifiedMomoTrackerSpots(tickers, quotes, { ibkr: { connected: true } }, nowMs);
  expect(Object.keys(normalized)).toEqual(['MSFT', 'NVDA', 'OLD', 'FUTURE']);
  expect(normalized.MSFT).toMatchObject({ ticker: 'MSFT', status: 'live', price: 500.25, source: 'ibkr' });
  expect(normalized.NVDA.status).toBe('live');
  expect(normalized.OLD).toMatchObject({ status: 'unavailable', price: null, asOf: null, source: null });
  expect(normalized.FUTURE.status).toBe('unavailable');
  expect(currentMomoSpot(normalized.MSFT, nowMs)).toBe(normalized.MSFT);
  expect(currentMomoSpot(normalized.MSFT, nowMs + 1)).toBeNull();
  expect(Object.values(normalizeVerifiedMomoTrackerSpots(tickers, quotes, { ibkr: { connected: false } }, nowMs))
    .every((value) => value.status === 'unavailable' && value.price === null)).toBe(true);
  expect(quotes.MSFT.last).toBe('500.25');
});

test.each([
  ['explicit flag', { refreshFailed: true }],
  ['warning marker', { warning: 'refresh-failed' }],
  ['source-status marker', { sourceStatus: 'refresh_failed' }],
  ['freshness marker', { freshness: 'refresh failed' }],
])('rejects a failed spot refresh despite a fresh observation: %s', (_label, flags) => {
  const nowMs = Date.parse('2026-09-10T18:00:00.000Z');
  const quote = freeze({
    symbol: 'MSFT', last: 500.25, timestamp: new Date(nowMs).toISOString(),
    source: 'ibkr', dataType: 'live', ...flags,
  });
  expect(normalizeVerifiedMomoTrackerSpots(['MSFT'], { MSFT: quote }, { ibkr: { connected: true } }, nowMs))
    .toEqual({ MSFT: { ticker: 'MSFT', status: 'unavailable', price: null, asOf: null, source: null } });
});

test('keeps an explicitly successful refresh eligible and independent from a failed peer', () => {
  const nowMs = Date.parse('2026-09-10T18:00:00.000Z');
  const quote = { last: 500.25, timestamp: new Date(nowMs).toISOString(), source: 'ibkr', dataType: 'live' };
  const result = normalizeVerifiedMomoTrackerSpots(['MSFT', 'NVDA'], {
    MSFT: { ...quote, symbol: 'MSFT', refreshFailed: false },
    NVDA: { ...quote, symbol: 'NVDA', refreshFailed: true },
  }, { ibkr: { connected: true } }, nowMs);
  expect(result.MSFT).toMatchObject({ status: 'live', price: 500.25, asOf: quote.timestamp, source: 'ibkr' });
  expect(result.NVDA).toMatchObject({ status: 'unavailable', price: null, asOf: null, source: null });
});
