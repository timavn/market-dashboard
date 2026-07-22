const { KALSHI_FINANCIAL_CATEGORIES } = require('../constants');
const { normalizeEvent } = require('../normalize/normalizeEvent');
const { isFinancialMacroEvent } = require('../filter/isFinancialMacroEvent');
const { setProviderStatus } = require('../cache');
const { paginateKalshi, kalshiFetch } = require('./kalshiClient');
const { normalizeCpiMonthId } = require('../cpiRelease');

const CPI_MONTHS = {
  JANUARY: 'JAN',
  FEBRUARY: 'FEB',
  MARCH: 'MAR',
  APRIL: 'APR',
  MAY: 'MAY',
  JUNE: 'JUN',
  JULY: 'JUL',
  AUGUST: 'AUG',
  SEPTEMBER: 'SEP',
  OCTOBER: 'OCT',
  NOVEMBER: 'NOV',
  DECEMBER: 'DEC',
};

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

function getCpiYoyEventTicker(cpi = {}) {
  const metric = String(cpi.metric || '').toUpperCase();
  if (metric && !/\bYOY\b|\bY\/Y\b|YEAR/i.test(metric)) return null;

  const values = [cpi.releaseCode, cpi.reportMonth, cpi.forecastMonth];
  for (const value of values) {
    const text = String(value || '').toUpperCase();
    const match = text.match(
      /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b\D*(\d{2,4})/,
    );
    if (!match) continue;
    const month = CPI_MONTHS[match[1]] || match[1].slice(0, 3);
    const year = match[2].slice(-2);
    return `KXCPIYOY-${year}${month}`;
  }
  return null;
}

function normalizeKalshiCpiMarket(market, eventTicker, cpi = {}) {
  const event = normalizeEvent({
    market,
    series: {
      ticker: 'KXCPIYOY',
      title: 'Headline CPI YoY',
      category: 'Economics',
      settlement_sources: [{ name: 'Bureau of Labor Statistics' }],
    },
    event: {
      event_ticker: eventTicker,
      title: market.title || 'Headline CPI YoY',
      category: 'Economics',
    },
  }, 'kalshi');
  const threshold = market.subtitle ?? market.floor_strike ?? '';
  return {
    ...event,
    releaseKey: cpi.releaseKey || null,
    reportMonthId: cpi.reportMonthId || normalizeCpiMonthId(cpi.reportMonth || cpi.forecastMonth || eventTicker),
    forecastMonth: cpi.forecastMonth || null,
    releaseDate: cpi.releaseDate || null,
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    event_title: market.title || event.event_title || 'Headline CPI YoY',
    contract_title: threshold !== '' ? `Above ${threshold}%` : event.contract_title,
    question: market.title || event.question,
  };
}

async function fetchKalshiCpiEvents(cpi = {}, options = {}) {
  const eventTicker = getCpiYoyEventTicker(cpi);
  if (!eventTicker) return [];

  try {
    const markets = await paginateKalshi(
      '/markets',
      { event_ticker: eventTicker, status: 'open' },
      'markets',
      options.maxPages || 2,
    );
    const normalized = markets
      .filter((market) => {
        if (String(market.status || '').toLowerCase() !== 'active') return false;
        const closesAt = Date.parse(market.close_time || market.expiration_time || '');
        return !Number.isFinite(closesAt) || closesAt > Date.now();
      })
      .map((market) => normalizeKalshiCpiMarket(market, eventTicker, cpi));

    const quoteBearing = normalized.filter((event) => (
      Number.isFinite(Number(event.yes_bid)) && Number.isFinite(Number(event.yes_ask))
      && Number.isFinite(Number(event.no_bid)) && Number.isFinite(Number(event.no_ask))
    ));

    setProviderStatus('kalshi', {
      status: normalized.length === 0
        ? 'connected_no_contracts'
        : quoteBearing.length === 0 ? 'connected_no_quotes' : 'connected_live',
      last_success_at: new Date().toISOString(),
      message: normalized.length === 0
        ? `No active Kalshi contracts found for ${eventTicker}.`
        : quoteBearing.length === 0 ? `Kalshi returned ${normalized.length} contract(s) without complete native books.` : null,
      releaseKey: cpi.releaseKey || null,
      contracts_total: normalized.length,
      quote_contracts: quoteBearing.length,
    });
    return normalized;
  } catch (err) {
    console.warn('[Kalshi] targeted CPI fetch error:', err.message);
    setProviderStatus('kalshi', {
      status: err.status === 401 ? 'auth_required' : 'error',
      message: err.message,
      last_success_at: null,
    });
    return [];
  }
}

async function fetchKalshiEvents(options = {}) {
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

module.exports = {
  fetchKalshiEvents,
  fetchFinancialSeries,
  fetchKalshiCpiEvents,
  getCpiYoyEventTicker,
  normalizeKalshiCpiMarket,
};
