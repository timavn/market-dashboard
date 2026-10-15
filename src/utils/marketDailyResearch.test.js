import { describeMarketDailyResearch, projectMarketDailyResearch } from './marketDailyResearch';

const marketDate = '2026-09-24';
const now = Date.parse('2026-09-24T18:00:00Z');
const sourceUrl = 'https://app.hedgeye.com/feed_items/123';
const fixture = (ticker = 'IGV') => {
  const evidence = {
    marketDate, productId: 'risk-ranges', sourceUrl, qualityStatus: 'indexed',
    publishedAt: `${marketDate}T12:00:00Z`, sourceEventId: 'report-1',
  };
  return {
    schemaVersion: 2, marketDate,
    bySymbol: {
      [ticker]: {
        symbol: ticker,
        products: {
          'risk-ranges': {
            id: 'risk-ranges', label: 'Risk Ranges', marketDate, status: 'available',
            pipelineStatus: 'indexed', fields: { trend: { ...evidence, value: 'BULLISH', authority: true } },
          },
        },
        directReferences: [{
          ...evidence, matchType: 'direct', matchedText: ticker, kind: 'primary_risk_range',
          value: { trend: 'BULLISH', lrr: 100, hrr: 110 }, direction: 'BULLISH',
        }],
      },
    },
  };
};
const project = (response, options = {}) => projectMarketDailyResearch(response, {
  marketDate, tickers: ['IGV'], now, ...options,
});

test('projects a same-day exact-instrument direction with its linked publication', () => {
  expect(project(fixture())).toEqual([expect.objectContaining({
    ticker: 'IGV', horizon: 'Trend', direction: 'BULLISH', authoritative: true,
    sourceTitle: 'Risk Ranges', sourceUrl, publicationDate: marketDate,
    text: 'IGV Trend is Bullish in Hedgeye’s Risk Ranges.',
  })]);
});

test('does not relabel a cash-index alias as an ETF signal', () => {
  const response = fixture('SPY');
  Object.assign(response.bySymbol.SPY.directReferences[0], { matchedText: 'SPX', matchType: 'direct_alias' });
  expect(project(response, { tickers: ['SPY'] })).toEqual([]);
});

test('accepts an exact published ticker within a security name', () => {
  const response = fixture();
  response.bySymbol.IGV.directReferences[0].matchedText = 'iShares Expanded Tech-Software Sector ETF (IGV)';
  expect(project(response)).toHaveLength(1);
});

test('does not use prior-day, future, missing-date, or unsupported-schema evidence', () => {
  expect(project(fixture(), { marketDate: '2026-09-23' })).toEqual([]);
  expect(project(fixture(), { marketDate: undefined })).toEqual([]);
  expect(project({ ...fixture(), schemaVersion: 1 })).toEqual([]);
  const response = fixture();
  response.bySymbol.IGV.products['risk-ranges'].fields.trend.publishedAt = '2026-09-25T12:00:00Z';
  expect(project(response)).toEqual([]);
});

test.each(['offline', 'stale', 'seeded', 'mock', 'cacheOnly', 'fromCache', 'inferred'])(
  'rejects %s research evidence without retaining a direction', (flag) => {
    const response = fixture();
    response.bySymbol.IGV.products['risk-ranges'].fields.trend[flag] = true;
    expect(project(response)).toEqual([]);
  },
);

test.each(['response', 'security', 'product', 'reference'])('rejects disconnected evidence at %s level', (level) => {
  const response = fixture();
  const target = {
    response, security: response.bySymbol.IGV,
    product: response.bySymbol.IGV.products['risk-ranges'], reference: response.bySymbol.IGV.directReferences[0],
  }[level];
  target.metadata = { connected: false };
  expect(project(response)).toEqual([]);
});

test('requires the field and original reference to agree on source, date, and direction', () => {
  ['sourceUrl', 'marketDate', 'publishedAt', 'direction'].forEach((key) => {
    const response = fixture();
    const reference = response.bySymbol.IGV.directReferences[0];
    reference[key] = key === 'direction' ? 'BEARISH' : 'unmatched';
    if (key === 'direction') reference.value.trend = 'BEARISH';
    expect(project(response)).toEqual([]);
  });
});

test('omits invalid URLs and a derived list-membership signal', () => {
  const response = fixture();
  response.bySymbol.IGV.products['risk-ranges'].fields.trend.sourceUrl = 'javascript:alert(1)';
  expect(project(response)).toEqual([]);
  const membership = fixture();
  membership.bySymbol.IGV.products['risk-ranges'].fields.trend.rule = 'portfolio-solutions-listed';
  expect(project(membership)).toEqual([]);
});

test('keeps independently verified Trend when only another field is disputed or product is unavailable', () => {
  const response = fixture();
  Object.assign(response.bySymbol.IGV.products['risk-ranges'], { status: 'conflict', conflicts: ['riskRange'] });
  response.bySymbol.IGV.products['momo-tracker'] = { status: 'unavailable' };
  expect(project(response)).toHaveLength(1);
  response.bySymbol.IGV.products['risk-ranges'].conflicts.push('trend');
  expect(project(response)).toEqual([]);
});

test('deduplicates requested tickers and includes Trade only with Trade evidence', () => {
  const response = fixture();
  const security = response.bySymbol.IGV;
  const product = security.products['risk-ranges'];
  product.fields.trade = { ...product.fields.trend };
  expect(project(response, { tickers: ['IGV', 'igv'] })).toHaveLength(1);
  security.directReferences.push({ ...security.directReferences[0], kind: 'tracker_trade', value: 'BULLISH' });
  expect(project(response).map((item) => item.horizon)).toEqual(['Trade', 'Trend']);
});

test.each([
  ['BULLISH', 0.4, 'IGV’s session gain shares the direction of its published Bullish Trend.'],
  ['BULLISH', -0.4, 'IGV is lower this session while its published Trend is Bullish.'],
  ['BEARISH', 0.4, 'IGV is higher this session while its published Trend is Bearish.'],
  ['BEARISH', -0.4, 'IGV’s session decline shares the direction of its published Bearish Trend.'],
  ['NEUTRAL', -0.4, 'IGV is lower this session; its published Trend is Neutral.'],
  ['BULLISH', 0, 'IGV is unchanged this session; its published Trend is Bullish.'],
])('compares %s research to a %s session return without claiming confirmation', (direction, change, expected) => {
  expect(describeMarketDailyResearch({ ticker: 'IGV', horizon: 'Trend', direction }, change)).toBe(expected);
});

test('retains the published horizon and gives literal research context when the move is unavailable', () => {
  const item = { ticker: 'IGV', horizon: 'Trade', direction: 'BULLISH', text: 'IGV Trade is Bullish in Hedgeye’s Tracker.' };
  expect(describeMarketDailyResearch(item, 1)).toContain('Bullish Trade');
  [null, undefined, NaN, '1'].forEach((value) => expect(describeMarketDailyResearch(item, value)).toBe(item.text));
  expect(describeMarketDailyResearch({ ...item, horizon: 'Daily' }, 1)).toBe('');
});
