/** @typedef {'Index'|'Rates'|'Inflation'|'Labor'|'Growth'|'Commodities'|'FX'|'Crypto'|'Credit'|'Other Macro'} MacroCategory */

const FINANCIAL_KEYWORDS = [
  'spx', 'spy', 's&p', 'nasdaq', 'qqq', 'dow', 'dia', 'iwm', 'russell',
  'fed', 'fomc', 'rate', 'cpi', 'pce', 'ppi', 'gdp', 'payroll', 'jobs',
  'unemployment', 'nonfarm', 'nfp', 'treasury', 'yield', 'recession',
  'inflation', 'oil', 'wti', 'brent', 'gold', 'dxy', 'dollar', 'eur',
  'bitcoin', 'btc', 'eth', 'vix', 'retail sales', 'industrial production',
  'housing', 'ism', 'pmi', 'earnings', 'ecb', 'boe', 'debt ceiling',
];

const EXCLUDE_KEYWORDS = [
  'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball',
  'tennis', 'golf', 'olympics', 'grammy', 'oscar', 'movie', 'weather',
  'temperature', 'hurricane', 'snowfall',
];

const MACRO_SETTLEMENT_SOURCES = [
  'bls', 'bea', 'fred', 'federal reserve', 'treasury', 'cme', 'cboe',
  'bloomberg', 'refinitiv', 'noaa', 'forecastex',
];

const KALSHI_FINANCIAL_CATEGORIES = new Set([
  'economics',
  'financials',
  'finance',
  'fed',
  'inflation',
  'employment',
  'gdp',
  'markets',
  'crypto',
  'commodities',
]);

const STATUS_OPEN = new Set(['open', 'active', 'unopened']);

const WIDE_SPREAD_THRESHOLD = 0.08;
const THIN_LIQUIDITY_THRESHOLD = 100;
const STALE_QUOTE_MS_DEFAULT = 5 * 60 * 1000;

module.exports = {
  FINANCIAL_KEYWORDS,
  EXCLUDE_KEYWORDS,
  MACRO_SETTLEMENT_SOURCES,
  KALSHI_FINANCIAL_CATEGORIES,
  STATUS_OPEN,
  WIDE_SPREAD_THRESHOLD,
  THIN_LIQUIDITY_THRESHOLD,
  STALE_QUOTE_MS_DEFAULT,
};
