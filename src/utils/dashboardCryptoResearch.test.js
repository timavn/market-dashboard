import { normalizeDashboardCryptoResearch } from './dashboardCryptoResearch';

const DATE = '2026-09-25';
const sourceUrl = 'https://app.hedgeye.com/feed_items/187643';
const row = (fields = {}) => ({ trend: 'BULLISH', buyTrade: 2525, sellTrade: 2862, price: 2700, ...fields });
const snapshot = (cryptos = { ETH: row() }, overrides = {}) => ({
  date: DATE, snapshotType: 'bitcoin-trend-tracker', reportType: 'crypto-quant', source: 'gmail-html',
  htmlSource: `hedgeye-email/messages/${DATE}/crypto-quant/source.html`, article: { feedUrl: sourceUrl },
  data: { cryptos }, ...overrides,
});
const normalize = (payload, date = DATE) => normalizeDashboardCryptoResearch(payload, { date });

test('fills published ETH, SOL and XRP from Crypto Quant stored under the legacy Tracker key', () => {
  const readings = normalize(snapshot({
    BTC: row({ buyTrade: 79664, sellTrade: 89001 }),
    ETH: row(), SOL: row({ buyTrade: 106, sellTrade: 125 }), XRP: row({ buyTrade: 1.4, sellTrade: 1.7 }),
  }));
  expect(Object.keys(readings)).toEqual(['BTC', 'ETH', 'SOL', 'XRP']);
  expect(readings.ETH).toMatchObject({ trend: 'BULLISH', lrr: 2525, hrr: 2862, date: DATE, source: 'Crypto Quant', sourceUrl, verified: true });
  expect(readings.ETH.trendEvidence).toEqual(readings.ETH.rangeEvidence);
  expect(readings.ETH.rangeEvidence).toMatchObject({ sourceTicker: 'ETH', reportType: 'crypto-quant', sourceUrl, date: DATE });
  expect(readings.BNB).toBeUndefined();
  expect(readings.ADA).toBeUndefined();
});

test.each(['BULLISH', 'NEUTRAL', 'BEARISH'])('preserves explicitly published %s without using the independent price or Trade field', (trend) => {
  expect(normalize(snapshot({ ETH: row({ trend, trade: 'BEARISH', price: 9999999, buyTrend: 1, sellTrend: 2 }) })).ETH)
    .toMatchObject({ trend, lrr: 2525, hrr: 2862 });
});

test('supports each front crypto row when that exact coin is explicitly published', () => {
  const readings = normalize(snapshot(Object.fromEntries(['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK'].map((symbol) => [symbol, row()]))));
  expect(Object.keys(readings)).toEqual(['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK']);
});

test('keeps the original date of latest published research across weekends and later days', () => {
  expect(normalize(snapshot(), '2026-09-28').ETH).toMatchObject({ date: DATE });
  expect(normalize(snapshot(), '2026-09-24')).toEqual({});
});

test('accepts a native Crypto Quant key or a source-linked Tracker HTML/PDF without changing product identity', () => {
  expect(normalize(snapshot(undefined, { snapshotType: 'crypto-quant' })).ETH.source).toBe('Crypto Quant');
  expect(normalize(snapshot(undefined, {
    reportType: 'bitcoin-trend-tracker', htmlSource: `hedgeye-email/messages/${DATE}/bitcoin-trend-tracker/source.html`,
  })).ETH.source).toBe('Bitcoin Tracker');
  const pdf = snapshot(undefined, {
    source: 'textract', reportType: undefined, htmlSource: undefined, article: undefined,
    pdfSource: `hedgeye-pdfs/${DATE}/bitcoin-tracker-${DATE}-123400.pdf`,
  });
  expect(normalize(pdf).ETH).toMatchObject({ source: 'Bitcoin Tracker', sourceUrl: `/api/hedgeye/screenshot/${DATE}/content?type=bitcoin-trend-tracker` });
  expect(normalize({ ...pdf, pdfSource: 'unknown.pdf' })).toEqual({});
});

test.each([
  null, {}, snapshot(undefined, { date: '2026-02-30' }),
  snapshot(undefined, { snapshotType: 'early-look' }), snapshot(undefined, { reportType: 'early-look' }),
  snapshot(undefined, { snapshotType: 'crypto-quant', reportType: 'bitcoin-trend-tracker' }),
  snapshot(undefined, { source: 'model' }), snapshot(undefined, { htmlSource: null }),
  snapshot(undefined, { htmlSource: 'hedgeye-email/messages/2026-09-24/crypto-quant/source.html' }),
  snapshot(undefined, { htmlSource: `hedgeye-email/messages/${DATE}/bitcoin-trend-tracker/source.html` }),
  snapshot(undefined, { article: { feedUrl: 'https://app.hedgeye.com.evil.invalid/feed_items/187643' } }),
  snapshot(undefined, { article: { feedUrl: 'http://app.hedgeye.com/feed_items/187643' } }),
  snapshot(undefined, { article: { feedUrl: 'https://user@app.hedgeye.com/feed_items/187643' } }),
])('requires matching publication type, date and source provenance %#', (payload) => {
  expect(normalize(payload)).toEqual({});
});

test.each([
  { offline: true }, { status: 'offline' }, { connected: false }, { cacheOnly: true }, { cachedOnly: true },
  { fromCache: true }, { stale: true }, { freshness: 'stale' }, { seeded: true }, { mock: true },
  { fixture: true }, { sourceVerified: false }, { verified: false }, { inferred: true }, { provider: 'portfolio' },
])('rejects compromised publication and row evidence independently %p', (flags) => {
  expect(normalize(snapshot(undefined, flags))).toEqual({});
  expect(normalize(snapshot(undefined, { meta: flags }))).toEqual({});
  const readings = normalize(snapshot({ ETH: row(flags), SOL: row() }));
  expect(readings.ETH).toBeUndefined();
  expect(readings.SOL).toMatchObject({ verified: true });
});

test('never transfers ETF, different-coin or stock values to a front cryptocurrency', () => {
  expect(normalize(snapshot({ ETHA: row(), ETH: row({ ticker: 'ETHA' }), SOL: row({ name: 'Ethereum' }), SPX: row() }))).toEqual({});
  expect(normalize(snapshot({}, { data: { stocks: { ETH: row() }, cryptos: {} } }))).toEqual({});
});

test('duplicate aliases are ambiguous without removing a different verified coin', () => {
  const readings = normalize(snapshot({ ETH: row(), ETHEREUM: row({ trend: 'BEARISH' }), SOL: row() }));
  expect(readings.ETH).toBeUndefined();
  expect(readings.SOL).toMatchObject({ verified: true });
});

test.each([
  { buyTrade: null }, { sellTrade: Infinity }, { buyTrade: '2525' }, { buyTrade: 3000 }, { buyTrade: -1 },
  { lrr: 2500, hrr: 2862 }, { trackerRange: { lrr: 2525, hrr: 2862, stale: true } },
])('keeps independently published Trend when its range is incomplete, conflicting or invalid %p', (fields) => {
  expect(normalize(snapshot({ ETH: row(fields) })).ETH).toMatchObject({ trend: 'BULLISH', lrr: null, hrr: null, rangeEvidence: null });
});

test('canonical Trade range aliases must agree and never use Trend threshold pairs', () => {
  expect(normalize(snapshot({ ETH: row({ lrr: 2525, hrr: 2862, trackerRange: { lrr: 2525, hrr: 2862 } }) })).ETH)
    .toMatchObject({ lrr: 2525, hrr: 2862 });
  expect(normalize(snapshot({ ETH: { trend: 'BULLISH', buyTrend: 2400, sellTrend: 3000 } })).ETH)
    .toMatchObject({ lrr: null, hrr: null, trend: 'BULLISH' });
});

test('unknown Trend is absent while the independently verified range remains', () => {
  expect(normalize(snapshot({ ETH: row({ trend: undefined, trade: 'BULLISH' }) })).ETH)
    .toMatchObject({ trend: null, trendEvidence: null, lrr: 2525, hrr: 2862 });
});

test('source quality findings withhold only disputed fields and retain their independent siblings', () => {
  const readings = normalize(snapshot({ ETH: row(), SOL: row({ sourceQuality: { issues: [{ field: 'trend' }] } }) }, {
    sourceQuality: { issues: [{ ticker: 'ETH', affectedFields: ['buyTrade'] }] },
  }));
  expect(readings.ETH).toMatchObject({ trend: 'BULLISH', lrr: null, hrr: null });
  expect(readings.SOL).toMatchObject({ trend: null, lrr: 2525, hrr: 2862 });
});
