const { cryptoTrackerRiskRangeEnvelope, cryptoTrackerRiskRangeHistory, trackerPublicationDates } = require('./cryptoRiskRangeProvider.cjs');

const NOW = new Date('2026-09-14T18:00:00.000Z');
const AS_OF = '2026-09-14T11:19:18.000Z';
const publication = (overrides = {}) => ({
  snapshotType: 'bitcoin-trend-tracker', date: '2026-09-14',
  scrapedAt: AS_OF, publishedAt: '2026-09-14T00:00:00.000Z',
  source: 'gmail-html', sourceMessageId: 'verified-source-message',
  data: { cryptos: { ETH: { buyTrade: 2408, sellTrade: 2598, price: 2518, trend: 'BULLISH' } } },
  ...overrides,
});

test('uses only the expected tracker publication and keeps its original provenance without inventing a previous close', () => {
  const envelope = cryptoTrackerRiskRangeEnvelope([publication()], { ticker: 'ETH', now: NOW });
  expect(envelope).toMatchObject({
    available: true, status: 'current',
    manifest: { publicationDate: '2026-09-14', expectedDate: '2026-09-14', latestUpdatedAt: AS_OF },
    ranges: { ETH: {
      lrr: 2408, hrr: 2598, previousClose: null, trend: 'BULLISH', asOf: AS_OF,
      source: 'hedgeye_bitcoin_trend_tracker', sourceType: 'bitcoin-trend-tracker',
      sourceDate: '2026-09-14', sourceMessageId: 'verified-source-message', sourceProvider: 'gmail-html',
    } },
  });
  expect(cryptoTrackerRiskRangeEnvelope([publication({ date: '2026-09-04' })], { ticker: 'ETH', now: NOW }))
    .toMatchObject({ available: false, ranges: {} });
});

test.each([
  ['offline', { connected: false }],
  ['stale', { stale: true }],
  ['cache-only', { cachedOnly: true }],
  ['cached', { cached: true }],
  ['offline flag', { offline: true }],
  ['mock', { mock: true }],
  ['seed', { seeded: true }],
  ['failed refresh', { refreshFailed: true }],
  ['future receipt', { scrapedAt: '2026-09-15T10:00:00.000Z' }],
  ['missing timestamp', { scrapedAt: null, publishedAt: null }],
])('rejects a %s tracker without carrying older levels forward', (_label, flags) => {
  expect(cryptoTrackerRiskRangeEnvelope([publication(flags)], { ticker: 'ETH', now: NOW }))
    .toMatchObject({ available: false, ranges: {} });
});

test('rejects tainted row provenance and invalid canonical bounds', () => {
  for (const slot of [{ lrr: true, hrr: 2598 }, { lrr: 2600, hrr: 2400 }, { buyTrade: 2408, sellTrade: 2598, source: 'mock' }, { trackerRange: { lrr: 2408, hrr: 2598, stale: true } }]) {
    expect(cryptoTrackerRiskRangeEnvelope([publication({ data: { cryptos: { ETH: slot } } })], { ticker: 'ETH', now: NOW }))
      .toMatchObject({ available: false, ranges: {} });
  }
});

test('selects each exact dated tracker for chart history and never substitutes another date or ticker', () => {
  const history = cryptoTrackerRiskRangeHistory([
    publication(), publication({ date: '2026-09-11', scrapedAt: '2026-09-11T11:00:00.000Z' }),
  ], { ticker: 'ETH', dates: ['2026-09-10', '2026-09-11', '2026-09-14'], nowMs: NOW.getTime() });
  expect(Object.keys(history.ranges)).toEqual(['2026-09-11', '2026-09-14']);
  expect(history.missingDates).toEqual(['2026-09-10']);
  expect(history.ranges['2026-09-11']).toMatchObject({ sourceDate: '2026-09-11', asOf: '2026-09-11T11:00:00.000Z' });
  expect(cryptoTrackerRiskRangeHistory([publication()], { ticker: 'OTHER', dates: ['2026-09-14'], nowMs: NOW.getTime() }))
    .toMatchObject({ ranges: {}, missingDates: ['2026-09-14'] });
});

test('uses Friday as the expected weekend publication without changing its date or timestamp', () => {
  const friday = publication({ date: '2026-09-11', scrapedAt: '2026-09-11T11:00:00.000Z' });
  expect(cryptoTrackerRiskRangeEnvelope([friday], { ticker: 'ETH', now: new Date('2026-09-13T18:00:00.000Z') }))
    .toMatchObject({ available: true, ranges: { ETH: { date: '2026-09-11', asOf: '2026-09-11T11:00:00.000Z' } } });
});

test('accepts the already-published current tracker before the morning deadline', () => {
  const early = new Date('2026-09-14T11:30:00.000Z');
  const friday = publication({ date: '2026-09-11', scrapedAt: '2026-09-11T11:00:00.000Z' });
  expect(trackerPublicationDates(early)).toEqual(['2026-09-14', '2026-09-11']);
  expect(cryptoTrackerRiskRangeEnvelope([friday, publication()], { ticker: 'ETH', now: early }))
    .toMatchObject({ available: true, manifest: { publicationDate: '2026-09-14', expectedDate: '2026-09-14' },
      ranges: { ETH: { sourceDate: '2026-09-14', asOf: AS_OF } } });
});

test('uses the prior expected publication only until the morning deadline when today is missing', () => {
  const friday = publication({ date: '2026-09-11', scrapedAt: '2026-09-11T11:00:00.000Z' });
  expect(cryptoTrackerRiskRangeEnvelope([friday], { ticker: 'ETH', now: new Date('2026-09-14T11:30:00.000Z') }))
    .toMatchObject({ available: true, ranges: { ETH: { sourceDate: '2026-09-11', asOf: '2026-09-11T11:00:00.000Z' } } });
  const deadline = new Date('2026-09-14T12:15:00.000Z');
  expect(trackerPublicationDates(deadline)).toEqual(['2026-09-14']);
  expect(cryptoTrackerRiskRangeEnvelope([friday], { ticker: 'ETH', now: deadline }))
    .toMatchObject({ available: false, ranges: {} });
});
