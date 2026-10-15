const { normalizeDashboardNarrativeResearch } = require('./dashboardNarrativeResearch.cjs');

const NOW = '2026-09-25';
const snapshot = (bodyText, date = NOW, overrides = {}) => ({
  date, source: 'gmail-html', snapshotType: 'early-look', reportType: 'early-look',
  htmlSource: `hedgeye-email/messages/${date}/early-look/source.html`,
  article: { feedUrl: 'https://app.hedgeye.com/feed_items/187136', bodyText }, ...overrides,
});
const normalize = (rows) => normalizeDashboardNarrativeResearch(rows, { date: NOW });

test('retains original explicit CRB and Corn statements through later publications that omit them', () => {
  const corn = 'Corn corrected -1.2% last week and remains Bullish TREND, inflating +28.8% in the last 3-months';
  const crb = 'CRB Commodities Index is signaling Bullish TRADE and TREND with Ag breaking out and Copper coming off ATHs';
  const readings = normalize([
    snapshot(crb, '2026-08-18'), snapshot(corn, '2026-09-14'), snapshot('Gold remains Neutral TREND'),
  ]);
  expect(readings.CRB).toMatchObject({ trend: 'BULLISH', verified: true, date: '2026-08-18', lrr: null, hrr: null, evidenceText: crb });
  expect(readings.ZC).toMatchObject({
    trend: 'BULLISH', verified: true, date: '2026-09-14', lrr: null, hrr: null,
    evidenceText: corn, sourceTicker: 'CORN', basisLabel: 'underlying', referenceOnly: true,
    sourceUrl: 'https://app.hedgeye.com/feed_items/187136',
    trendEvidence: { date: '2026-09-14', evidenceText: corn }, rangeEvidence: null,
  });
});

test('replaces only with a newer explicit statement, independent of input order', () => {
  const rows = [snapshot('Corn remains Neutral TREND', '2026-09-24'), snapshot('Corn remains Bullish TREND', '2026-09-14')];
  expect(normalize(rows).ZC.trend).toBe('NEUTRAL');
  expect(normalize(rows.reverse()).ZC.date).toBe('2026-09-24');
});

test.each([
  'Corn (CORN) remains Bullish TREND',
  'Corn ETF remains Bullish TREND',
  'Corn remains Bullish TREND for the Teucrium fund',
  'Corn could be Bullish TREND',
  'Corn remains Bullish TREND if it breaks out',
  'Corn is not Bullish TREND',
  'Corn is no longer Bullish TREND',
  'Corn was Bullish TREND',
  'Corn previously was Bullish TREND',
  'Corn remains "Bullish TREND" in an old report',
  'Corn remains Bullish TREND; previously Bearish TREND',
  'Corn remains Bullish TREND from last year',
  'Corn remains Bullish TREND?',
  'An earlier report wrote:\nCorn remains Bullish TREND',
  '> Corn remains Bullish TREND',
  'Corn and Gold remain Bullish TREND',
  'If inflation rises, Corn remains Bullish TREND',
  'CRB Commodities Index closed at 383 with a Hedgeye Alpha Code of 362/365 (TRADE/TREND)',
  'CRB Index inflated another +1.6% last week, taking its TRENDING 3-month Return to +14.4%',
])('rejects unsupported or ambiguous narrative: %s', (body) => {
  expect(normalize([snapshot(body)])).toEqual({});
});

test.each([
  { mock: true }, { seeded: true }, { cacheOnly: true }, { stale: true }, { offline: true },
  { verified: false }, { source: 'model' }, { source: 'gmail-html', metadata: { source: 'portfolio' } },
  { source: 'unknown' }, { snapshotType: 'the-macro-show' }, { reportType: 'risk-ranges' },
  { htmlSource: 'unverified.html' }, { date: '2026-09-26' },
  { article: { feedUrl: 'https://example.com/187136', bodyText: 'Corn remains Bullish TREND' } },
  { article: { feedUrl: 'https://app.hedgeye.com/feed_items/187136', bodyText: 'Corn remains Bullish TREND', mock: true } },
])('rejects unverified or future publication: %j', (overrides) => {
  expect(normalize([snapshot('Corn remains Bullish TREND', NOW, overrides)])).toEqual({});
});

test('does not resolve conflicting statements from a single publication or publication date', () => {
  expect(normalize([snapshot('Corn remains Bullish TREND\nCorn remains Bearish TREND')])).toEqual({});
  expect(normalize([snapshot('Corn remains Bullish TREND'), snapshot('Corn remains Bearish TREND')])).toEqual({});
});

test('withholds a questioned Trend without discarding an independent asset', () => {
  expect(normalize([snapshot('Corn remains Bullish TREND\nCRB Index remains Bearish TREND', NOW, {
    sourceQuality: { issues: [{ ticker: 'CORN', field: 'trend' }] },
  })])).toMatchObject({ CRB: { trend: 'BEARISH' } });
  expect(normalize([snapshot('Corn remains Bullish TREND', NOW, {
    sourceQuality: { issues: [{ ticker: 'CORN', field: 'trend' }] },
  })])).not.toHaveProperty('ZC');
});
