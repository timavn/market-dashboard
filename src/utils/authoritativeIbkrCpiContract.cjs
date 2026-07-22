const NATIVE_IBKR_SOURCES = new Set(['IBKR_TWS_API', 'IBKR_CPAPI']);
const NATIVE_IBKR_VENUES = new Set(['IBKR', 'FORECASTEX', 'CME']);
const NON_EXECUTABLE_FLAGS = new Set([
  'cached',
  'catalog_missing',
  'expired_contract',
  'fallback',
  'mock',
  'no_live_quote',
  'portfolio_discovered',
  'portfolio_seed',
  'stale_quote',
  'unknown_contract_side',
  'wrong_release',
]);

function parseExpiry(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const compactDay = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compactDay) {
    const timestamp = Date.parse(`${compactDay[1]}-${compactDay[2]}-${compactDay[3]}T23:59:59.999Z`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const compactMonth = text.match(/^(\d{4})(\d{2})$/);
  if (compactMonth) {
    const year = Number(compactMonth[1]);
    const month = Number(compactMonth[2]);
    if (month < 1 || month > 12) return null;
    return Date.UTC(year, month, 1) - 1;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function finiteNativePrice(value) {
  if (value === null || value === undefined || value === '') return false;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 && price <= 1;
}

function hasNativeExecutableSide(event, side) {
  const prefix = String(side || '').toLowerCase();
  const bid = event?.[`${prefix}_bid`];
  const ask = event?.[`${prefix}_ask`];
  return finiteNativePrice(bid)
    && finiteNativePrice(ask)
    && Number(ask) > 0
    && Number(ask) >= Number(bid);
}

function qualificationFailures(event = {}, {
  releaseKey = null,
  now = new Date(),
  maxAgeSeconds = 120,
  requireExecutableQuote = true,
} = {}) {
  const failures = [];
  const nowMs = new Date(now).getTime();
  const source = String(event.source_api || '').toUpperCase();
  const venue = String(event.venue || '').toUpperCase();
  const conId = Number(event.conId ?? event.conid);
  const side = String(event.quote_side || event.native_side || '').toUpperCase();
  const eventReleaseKey = String(event.releaseKey || event.release_key || '');
  const timestamp = Date.parse(event.updated_at || event.fetched_at || '');
  const ageSeconds = (nowMs - timestamp) / 1000;
  const expiry = parseExpiry(event.expiration_time || event.lastTradeDateOrContractMonth);
  const flags = [...(event.data_quality_flags || []), ...(event.flags || [])];
  const status = String(event.status || '').toLowerCase();

  if (!NATIVE_IBKR_SOURCES.has(source)) failures.push('non_native_source');
  if (!NATIVE_IBKR_VENUES.has(venue)) failures.push('non_ibkr_venue');
  if (event.tradable_in_ibkr !== true) failures.push('not_explicitly_tradable');
  if (!Number.isInteger(conId) || conId <= 0) failures.push('missing_native_conid');
  if (!String(event.exchange || '').trim()) failures.push('missing_exchange');
  if (!String(event.tradingClass || '').trim()) failures.push('missing_trading_class');
  if (String(event.catalog_source || '') !== 'ibkr_contract_details') failures.push('unverified_catalog_source');
  if (!['YES', 'NO'].includes(side)) failures.push('unknown_native_side');
  if (!eventReleaseKey) failures.push('missing_release_key');
  else if (releaseKey && eventReleaseKey !== String(releaseKey)) failures.push('wrong_release');
  if (!['open', 'active'].includes(status)) failures.push('inactive_contract');
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiry) || expiry <= nowMs) failures.push('missing_or_expired_expiry');
  if (!Number.isFinite(timestamp) || !Number.isFinite(ageSeconds) || ageSeconds < -5 || ageSeconds > maxAgeSeconds) {
    failures.push('missing_or_stale_quote_timestamp');
  }
  if (flags.some((flag) => NON_EXECUTABLE_FLAGS.has(String(flag)))) failures.push('non_live_quality_flag');
  if (requireExecutableQuote && !hasNativeExecutableSide(event, side)) failures.push('missing_native_executable_book');

  return [...new Set(failures)];
}

function isAuthoritativeIbkrCpiContract(event, options = {}) {
  return qualificationFailures(event, options).length === 0;
}

module.exports = {
  NON_EXECUTABLE_FLAGS,
  NATIVE_IBKR_SOURCES,
  NATIVE_IBKR_VENUES,
  hasNativeExecutableSide,
  isAuthoritativeIbkrCpiContract,
  parseExpiry,
  qualificationFailures,
};
