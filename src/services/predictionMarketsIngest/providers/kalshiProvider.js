const { KALSHI_FINANCIAL_CATEGORIES } = require('../constants');
const { normalizeEvent } = require('../normalize/normalizeEvent');
const { isFinancialMacroEvent } = require('../filter/isFinancialMacroEvent');
const { setProviderStatus } = require('../cache');
const { paginateKalshi, kalshiFetch } = require('./kalshiClient');

async function fetchFinancialSeries() {
  const data = await kalshiFetch('/series', {});
  const series = data.series || [];
  return series.filter((s) => {
    const cat = String(s.category || '').toLowerCase();
    if (KALSHI_FINANCIAL_CATEGORIES.has(cat)) return true;
    const tags = (s.tags || []).join(' ').toLowerCase();
    return /econom|financ|fed|cpi|gdp|rate|market|employ|inflation|treasury|spx|nasdaq/.test(
      `${cat} ${tags} ${s.title || ''}`
    );
  });
}

async function fetchKalshiEvents(options = {}) {
  const useMock = process.env.PM_USE_MOCK === 'true' || options.useMock;
  if (useMock) return [];

  const hasCreds =
    process.env.KALSHI_API_KEY_ID &&
    (process.env.KALSHI_PRIVATE_KEY_PEM || process.env.KALSHI_PRIVATE_KEY_PATH);

  if (!hasCreds) {
    setProviderStatus('kalshi', {
      status: 'error',
      message: 'Kalshi API credentials not configured',
      last_success_at: null,
    });
    return [];
  }

  try {
    const seriesList = await fetchFinancialSeries();
    const normalized = [];
    const seriesByTicker = new Map(seriesList.map((s) => [s.ticker, s]));

    for (const series of seriesList.slice(0, options.maxSeries || 50)) {
      let markets;
      try {
        markets = await paginateKalshi(
          '/markets',
          { status: 'open', series_ticker: series.ticker },
          'markets',
          options.maxPages || 5
        );
      } catch (err) {
        console.warn(`[Kalshi] markets for ${series.ticker}:`, err.message);
        continue;
      }

      for (const market of markets) {
        const event = normalizeEvent({ market, series }, 'kalshi');
        if (isFinancialMacroEvent(event)) {
          normalized.push(event);
        }
      }
    }

    setProviderStatus('kalshi', {
      status: 'connected',
      last_success_at: new Date().toISOString(),
      message: null,
    });

    return normalized;
  } catch (err) {
    console.error('[Kalshi] fetchKalshiEvents error:', err.message);
    setProviderStatus('kalshi', {
      status: err.status === 401 ? 'auth_required' : 'error',
      message: err.message,
      last_success_at: null,
    });
    return [];
  }
}

module.exports = { fetchKalshiEvents, fetchFinancialSeries };
