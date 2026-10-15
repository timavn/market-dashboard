import { verifiedHistoricalRecords, verifiedReferenceQuote } from './legacyMarketDisplay';

const quote = { symbol: 'SP500', price: 6100, source: 'ibkr', timestamp: '2026-08-31T20:00:00Z' };
const history = { symbol: '^VIX', data: [{ date: '2026-08-31', close: 17.25 }] };

test('dated references preserve actual values and leave absent changes unknown', () => {
  expect(verifiedReferenceQuote(quote, 'SP500')).toEqual({
    value: 6100, source: 'ibkr', asOf: quote.timestamp, change: null, changePercent: null,
  });
  expect(verifiedHistoricalRecords(history, '^VIX')).toEqual([
    { date: '2026-08-31', close: 17.25, dateObj: new Date('2026-08-31') },
  ]);
});

test.each([
  { mock: true }, { seeded: true }, { inferred: true }, { fallback: true },
  { synthetic: true }, { stale: true }, { fromCache: true }, { source: 'portfolio-derived' },
  { status: 'offline' }, { status: 'disconnected' }, { availability: 'unavailable' },
  { timestamp: null }, { price: null }, { price: NaN }, { timestamp: '2999-01-01' },
  { source: 'unknown' }, { symbol: 'GOLD' }, { price: true }, { price: [6100] },
  { status: 'error' }, { liveSessionVerified: false }, { freshness: 'stale' }, { cacheOnly: true },
])('rejects unverified quote evidence %j', (changes) => {
  expect(verifiedReferenceQuote({ ...quote, ...changes }, 'SP500')).toBeNull();
});

test.each([
  { mock: true }, { seeded: true }, { source: 'synthetic' }, { status: 'offline' },
  { status: 'error' }, { symbol: '^VVIX' }, { data: [{ date: 'invalid', close: 17 }] },
  { data: [{ date: '2026-08-31', close: null }] },
  { data: [{ date: '2026-08-31', close: 18, mock: true }] },
])('rejects fabricated, wrong-instrument or missing historical evidence %j', (changes) => {
  expect(verifiedHistoricalRecords({ ...history, ...changes }, '^VIX')).toEqual([]);
});

test('missing inputs remain unavailable', () => {
  expect(verifiedReferenceQuote(undefined, 'SP500')).toBeNull();
  expect(verifiedHistoricalRecords(undefined, '^VIX')).toEqual([]);
});
