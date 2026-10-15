// The funding guard may need fresh IBKR daily bars for symbols whose live
// stream omits the prior-close tick. Keep the full portfolio/funding refresh
// below IBKR historical-data pacing while remaining inside the guard's
// freshness window.
export const PORTFOLIO_POLL_MS = 50000;
export const REFERENCE_DATA_POLL_MS = 5 * 60 * 1000;
export const PROVIDER_STATUS_POLL_MS = 5000;
export const PROVIDER_STATUS_POLL_OFFLINE_MS = 15000;
export const PROVIDER_STATUS_TIMEOUT_MS = 3500;
export const PORTFOLIO_REQUEST_TIMEOUT_MS = 60 * 1000;
export const PORTFOLIO_LIVE_MAX_AGE_MS = 5 * 60 * 1000;
export const MARKET_QUOTES_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;
export const MARKET_PERIOD_RETURNS_POLL_MS = 15 * 60 * 1000;
