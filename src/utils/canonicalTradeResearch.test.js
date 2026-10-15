const { canonicalTradeResearch } = require('./canonicalTradeResearch.cjs');

const date = '2026-09-25';
const evidence = (fields = {}) => ({
  status: 'available', value: 'BEARISH', sourceId: 'early-look', sourceLabel: 'Early Look',
  sourceDate: date, sourceTicker: 'SPX', sourceUrl: 'https://app.hedgeye.com/feed_items/123',
  publishedAt: `${date}T11:30:00Z`,
  signalProvenance: { field: 'trade', sourceField: 'article.bodyText', method: 'explicit-statement', sourceText: 'SPX is BEARISH on TRADE.' },
  ...fields,
});
const payload = (trade = evidence(), retained = null) => ({
  schemaVersion: 2, marketDate: date,
  bySymbol: { SPX: { decision: { trade, trend: { status: 'available', value: 'BULLISH' } }, lastVerifiedDecision: { trade: retained } } },
});

test('keeps explicit Trade independent from opposing Trend and preserves exact source evidence', () => {
  expect(canonicalTradeResearch(payload(), 'SPX')).toMatchObject({
    status: 'available', direction: 'BEARISH', ticker: 'SPX', date,
    source: 'early-look', sourceUrl: evidence().sourceUrl, asOf: evidence().publishedAt,
    signalProvenance: evidence().signalProvenance, executable: false,
  });
});

test('retains the last independently published Trade without relabeling its date or enabling a same-session score', () => {
  const retained = evidence({ status: 'historical', sourceDate: '2026-08-03', publishedAt: '2026-08-03T11:30:00Z' });
  const snapshot = payload({ status: 'unavailable' }, retained);
  expect(canonicalTradeResearch(snapshot, 'SPX')).toMatchObject({ status: 'available', date: '2026-08-03', retainedPublication: true });
  expect(canonicalTradeResearch(snapshot, 'SPX', { date, sameSession: true })).toMatchObject({ status: 'unavailable', direction: null, date: '2026-08-03' });
});

test.each([
  ['old tracker field without proof', { signalProvenance: null }],
  ['Trend provenance', { signalProvenance: { ...evidence().signalProvenance, field: 'trend' } }],
  ['proxy instrument', { sourceTicker: 'SPY' }],
  ['missing exact instrument', { sourceTicker: null }],
  ['future publication', { sourceDate: '2026-09-28' }],
  ['invalid publication date', { sourceDate: '2026-02-30' }],
  ['unverified source URL', { sourceUrl: 'https://example.com/123' }],
  ['mock', { mock: true }], ['seed', { seeded: true }],
  ['offline', { offline: true }], ['stale', { stale: true }],
  ['cache-only', { cacheOnly: true }], ['refresh failure', { refreshFailed: true }],
  ['nested provider error', { metadata: { providerStatus: { status: 'error' } } }],
])('withholds %s', (_label, fields) => {
  expect(canonicalTradeResearch(payload(evidence(fields)), 'SPX')).toMatchObject({ status: 'unavailable', direction: null });
});

test('does not hide a newer conflict behind retained evidence or copy a different security', () => {
  expect(canonicalTradeResearch(payload({ status: 'conflict' }, evidence()), 'SPX').status).toBe('unavailable');
  expect(canonicalTradeResearch(payload(), 'SPY').status).toBe('unavailable');
});

test('resolves verified instrument aliases without treating an ETF as its index', () => {
  const snapshot = { schemaVersion: 2, marketDate: date, bySymbol: {
    BITCOIN: { decision: { trade: evidence({ sourceTicker: 'BITCOIN' }) } },
  } };
  expect(canonicalTradeResearch(snapshot, 'BTC')).toMatchObject({ status: 'available', ticker: 'BITCOIN', direction: 'BEARISH' });
  expect(canonicalTradeResearch(payload(), 'SPY').status).toBe('unavailable');
});

test('preserves a date-only publication without interpreting synthetic UTC midnight as the prior local day', () => {
  const snapshot = payload(evidence({ publishedAt: `${date}T00:00:00+00:00` }));
  expect(canonicalTradeResearch(snapshot, 'SPX')).toMatchObject({ date, asOf: date, sourcePublishedAt: null });
  expect(snapshot.bySymbol.SPX.decision.trade.publishedAt).toBe(`${date}T00:00:00+00:00`);
});
