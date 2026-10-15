import { getPortfolioExposureValuation } from './portfolioExposureValuation';
import { buildPortfolioQuadExposure } from './portfolioFactorExposure';

const NOW = Date.parse('2026-09-07T20:00:00Z');
const stamp = new Date(NOW).toISOString();
const current = () => ({
  dataSource: 'ibkr_api', liveSessionVerified: true, fromCache: false,
  fetchedAt: stamp, socketVerifiedAt: stamp,
  accountSummary: { source: 'ibkr_live_session', netLiquidation: 100000, lastUpdated: stamp, socketVerifiedAt: stamp },
  dataQuality: { status: 'ok', markState: 'live' },
  holdings: [{ symbol: 'OIH', quantity: 10, price: 400, marketValue: 4000, positionSource: 'ibkr_live_session',
    priceState: 'live', marketValueState: 'live', priceSource: 'ibkr_live_last', priceObservedAt: stamp }],
});
const dated = () => {
  const portfolio = current();
  portfolio.dataQuality = { status: 'stale', markState: 'reference' };
  Object.assign(portfolio.holdings[0], {
    priceState: 'historical_close', marketValueState: 'historical_close', priceSource: 'ibkr_historical_daily_close',
    priceSessionDate: '2026-09-04', priceObservedAt: '2026-09-04T20:16:00Z', referenceClose: 400,
    referenceCloseSource: 'ibkr_historical_daily_close', referenceCloseSessionDate: '2026-09-04', referenceCloseObservedAt: '2026-09-04T20:16:00Z',
  });
  return portfolio;
};
const valuation = portfolio => getPortfolioExposureValuation(portfolio, { now: NOW });

test('does not substitute a live quote when a verified completed close is missing', () => {
  expect(valuation(current())).toMatchObject({ available: false, holdings: [] });
});

test('values current positions at the latest verified close over a market holiday', () => {
  expect(valuation(dated())).toMatchObject({ available: true, mode: 'reference', asOf: '2026-09-04', expiresAt: NOW + 300000 });
});

test('keeps the same close valuation as live quotes change and expire without mutating the portfolio', () => {
  const portfolio = dated();
  const reference = valuation(portfolio);
  portfolio.dataQuality = { status: 'ok', markState: 'live' };
  Object.assign(portfolio.holdings[0], {
    price: 420, marketValue: 4200, priceState: 'live', marketValueState: 'live',
    priceSource: 'ibkr_live_last', priceObservedAt: stamp, priceSessionDate: null,
  });
  const before = JSON.stringify(portfolio);
  const live = valuation(portfolio);
  const expiredTick = getPortfolioExposureValuation(portfolio, { now: NOW + 61000 });
  for (const result of [reference, live, expiredTick]) {
    expect(result).toMatchObject({ available: true, mode: 'reference', asOf: '2026-09-04', expiresAt: NOW + 300000 });
    expect(result.holdings[0]).toMatchObject({ price: 400, marketValue: 4000, priceState: 'historical_close' });
  }
  expect(JSON.stringify(portfolio)).toBe(before);
});

test('updates exposure when verified quantities change, including a short position', () => {
  const portfolio = dated();
  portfolio.holdings[0].quantity = -15;
  expect(valuation(portfolio).holdings[0].marketValue).toBe(-6000);
});

test.each([
  ['offline', p => { p.connected = false; }],
  ['failed refresh', p => { p.error = 'refresh failed'; }],
  ['cache', p => { p.fromCache = true; }],
  ['cache-only', p => { p.cacheOnly = true; }],
  ['seed', p => { p.seeded = true; }],
  ['mock', p => { p.mock = true; }],
  ['stale flag', p => { p.stale = true; }],
  ['expired portfolio', p => { p.fetchedAt = '2020-01-01'; }],
  ['expired NAV', p => { p.accountSummary.lastUpdated = '2020-01-01'; }],
  ['missing NAV', p => { p.accountSummary.netLiquidation = null; }],
  ['stale quality', p => { p.dataQuality.stale = true; }],
  ['unverified source', p => { p.dataSource = 'uploaded_statement'; }],
])('withholds even a dated valuation for %s', (_label, mutate) => {
  const portfolio = dated();
  mutate(portfolio);
  expect(valuation(portfolio)).toMatchObject({ available: false, holdings: [] });
});

test.each([
  ['old session', h => { h.referenceCloseSessionDate = '2026-09-03'; }],
  ['wrong source', h => { h.referenceCloseSource = 'unknown'; }],
  ['missing timestamp', h => { h.referenceCloseObservedAt = null; }],
  ['invalid close', h => { h.referenceClose = 0; }],
  ['missing quantity', h => { h.quantity = null; }],
  ['future timestamp', h => { h.referenceCloseObservedAt = new Date(NOW + 60000).toISOString(); }],
  ['mock mark', h => { h.mock = true; }],
  ['stale position', h => { h.stale = true; }],
  ['cached position', h => { h.fromCache = true; }],
  ['cache-only position', h => { h.cacheOnly = true; }],
  ['seeded position', h => { h.seeded = true; }],
  ['pending close', h => { h.markPending = true; }],
  ['failed close', h => { h.markFailure = { errorCode: 'NO_MARK' }; }],
])('withholds a position with %s', (_label, mutate) => {
  const portfolio = dated();
  mutate(portfolio.holdings[0]);
  expect(valuation(portfolio)).toMatchObject({ available: false, holdings: [], unavailableHoldings: [portfolio.holdings[0]] });
});

test('does not blank unrelated factors or count a missing valuation as zero', () => {
  const portfolio = dated();
  portfolio.dataQuality = { status: 'partial', markState: 'mixed' };
  portfolio.holdings.push({ symbol: 'QQQ', quantity: 10, marketValue: null, positionSource: 'ibkr_live_session', markFailure: { errorCode: 'NO_MARK' } });
  const result = valuation(portfolio);
  const rows = buildPortfolioQuadExposure(result.holdings, 100000, result.available, result.unavailableHoldings);
  expect(result.available).toBe(true);
  expect(rows.find(row => row.label === 'Energy').netPct).toBe(4);
  expect(rows.find(row => row.label === 'Tech')).toMatchObject({ netPct: null, unavailableReason: 'Missing verified valuation for QQQ' });
  expect(rows.find(row => row.label === 'Equities').netPct).toBeNull();
  expect(rows.find(row => row.label === 'Utilities').netPct).toBe(0);
});

test('expires the account snapshot without treating missing exposure as zero', () => {
  expect(getPortfolioExposureValuation(dated(), { now: NOW + 300001 })).toMatchObject({ available: false, holdings: [] });
});

test('requires the new completed session after the closing-price publication window', () => {
  const now = Date.parse('2026-09-08T20:16:00Z');
  const portfolio = dated();
  portfolio.fetchedAt = portfolio.socketVerifiedAt = new Date(now).toISOString();
  portfolio.accountSummary.lastUpdated = portfolio.accountSummary.socketVerifiedAt = new Date(now).toISOString();
  expect(getPortfolioExposureValuation(portfolio, { now })).toMatchObject({ available: false, holdings: [] });
});

test('keeps completed factors during initial warming without turning pending holdings into zero', () => {
  const portfolio = dated();
  portfolio.dataQuality = { status: 'stale', markState: 'warming' };
  portfolio.holdings.push({ symbol: 'QQQ', quantity: 10, positionSource: 'ibkr_live_session', markPending: true });
  expect(valuation(portfolio)).toMatchObject({ available: true, holdings: [expect.objectContaining({ symbol: 'OIH' })], unavailableHoldings: [expect.objectContaining({ symbol: 'QQQ' })] });
});
