import { expectedSizingSession } from './volatilitySizingBand.cjs';

const ACCOUNT_MAX_AGE = 5 * 60 * 1000;
const numeric = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const forbidden = (value, ignoreStatus = false) => Boolean(value && (
  ['stale', 'cacheOnly', 'cached', 'fromCache', 'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'synthetic', 'inferred', 'fallback', 'offline', 'disconnected'].some(key => value[key] === true)
  || value.connected === false || value.liveSessionVerified === false || value.available === false
  || value.ok === false || value.success === false || value.error
  || (!ignoreStatus && /^(offline|disconnected|error|failed|unavailable|stale|cached|cache-only|mock|seeded)$/.test(String(value.status || value.state || '').toLowerCase()))
));

// This worksheet uses one completed-close basis for every position, independent
// of live ticks. Positions and NAV still require the current broker session.
// The projected holdings are only for factor attribution, never quotes or sizing.
export function getPortfolioExposureValuation(portfolio, { now = Date.now(), loading = false } = {}) {
  const fresh = (value, maxAge) => {
    const age = now - Date.parse(String(value || ''));
    return Number.isFinite(age) && age >= -5000 && age <= maxAge;
  };
  const unavailable = reason => ({ available: false, mode: loading ? 'loading' : 'unavailable', reason, holdings: [], unavailableHoldings: [], asOf: null, expiresAt: null });
  const account = portfolio?.accountSummary;
  if (loading) return unavailable('Loading portfolio valuation');
  if (!portfolio || portfolio.dataSource !== 'ibkr_api' || portfolio.liveSessionVerified !== true
    || portfolio.fromCache !== false || !Array.isArray(portfolio.holdings)
    || [portfolio, portfolio._cache, account].some(value => forbidden(value))) return unavailable('Current broker portfolio unavailable');
  const accountTimes = [portfolio.fetchedAt, portfolio.socketVerifiedAt, account?.lastUpdated, account?.socketVerifiedAt];
  if (account?.source !== 'ibkr_live_session' || !(numeric(account.netLiquidation) > 0)
    || !accountTimes.every(time => fresh(time, ACCOUNT_MAX_AGE))) return unavailable('Refresh broker positions and NAV');

  const quality = portfolio.dataQuality;
  // The provider calls a verified closing-price valuation "stale". Its mark
  // state distinguishes that from a stale/offline payload; each price is still
  // independently checked below, including its exact completed-session date.
  const datedQuality = ['reference', 'mixed', 'warming'].includes(quality?.markState)
    && ['stale', 'partial'].includes(quality?.status);
  if (forbidden(quality, datedQuality)) return unavailable('Portfolio valuation unavailable');

  const expected = expectedSizingSession(now);
  const holdings = [];
  const unavailableHoldings = [];
  const expirations = accountTimes.map(time => Date.parse(time) + ACCOUNT_MAX_AGE);
  for (const holding of portfolio.holdings) {
    const close = numeric(holding.referenceClose);
    const quantity = numeric(holding.quantity);
    const positionValid = holding.positionSource === 'ibkr_live_session'
      && ![holding, holding._cache, holding.dataQuality].some(item => forbidden(item))
      && !holding.markPending && !holding.markFailure && quantity !== null;
    const observed = Date.parse(String(holding.referenceCloseObservedAt || ''));
    const reference = positionValid && close > 0
      && holding.referenceCloseSource === 'ibkr_historical_daily_close'
      && holding.referenceCloseSessionDate === expected
      && Number.isFinite(observed) && observed >= Date.parse(`${expected}T00:00:00Z`) && observed <= now + 5000;
    if (reference) {
      holdings.push({
        ...holding,
        price: close,
        marketValue: quantity * close,
        priceState: 'historical_close',
        marketValueState: 'historical_close',
        priceSource: holding.referenceCloseSource,
        priceSessionDate: expected,
        priceObservedAt: holding.referenceCloseObservedAt,
      });
    } else unavailableHoldings.push(holding);
  }
  const available = holdings.length > 0 || portfolio.holdings.length === 0;
  return {
    available,
    mode: available ? 'reference' : 'unavailable',
    holdings, unavailableHoldings, asOf: available ? expected : null,
    expiresAt: Math.min(...expirations),
    reason: unavailableHoldings.length
      ? `Missing verified ${expected} close for ${unavailableHoldings.map(holding => holding.symbol).join(', ')}. Affected factor totals are unavailable.`
      : null,
  };
}
