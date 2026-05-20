const axios = require('axios');
const { normalizeYahooLegacy } = require('../normalize/normalizeQuote');

/** @type {((symbol: string) => { source: string, ticker: string })|null} */
let getTickerMappingFn = null;

function setTickerMappingResolver(fn) {
  getTickerMappingFn = fn;
}

function defaultMapping(symbol) {
  return { source: 'yahoo', ticker: String(symbol).toUpperCase() };
}

async function fetchYahooQuote(yahooTicker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`;
    const response = await axios.get(url, {
      params: { range: '1d', interval: '1d', includePrePost: 'false' },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000,
    });

    const data = response.data;
    if (data.chart?.error || !data.chart?.result?.length) return null;

    const result = data.chart.result[0];
    if (result.error) return null;

    const meta = result.meta || {};
    const isRateProxyTicker = yahooTicker === '^FVX' || yahooTicker === '^TNX' || yahooTicker === '^TYX';
    const scaleFactor = isRateProxyTicker ? 0.1 : 1;

    let currentPrice = null;
    let previousClose = null;

    if (meta.regularMarketPrice != null) {
      currentPrice = meta.regularMarketPrice;
      previousClose = meta.previousClose || meta.chartPreviousClose || currentPrice;
    } else if (meta.chartPreviousClose != null) {
      currentPrice = meta.chartPreviousClose;
      previousClose = meta.previousClose || currentPrice;
    } else if (meta.previousClose != null) {
      currentPrice = meta.previousClose;
      previousClose = currentPrice;
    } else if (result.indicators?.quote?.[0]?.close?.length) {
      const closes = result.indicators.quote[0].close;
      currentPrice = closes[closes.length - 1];
      previousClose = closes.length > 1 ? closes[closes.length - 2] : currentPrice;
    }

    if (currentPrice == null) return null;

    currentPrice *= scaleFactor;
    previousClose = (previousClose || currentPrice) * scaleFactor;

    return {
      price: currentPrice.toFixed(2),
      change: (currentPrice - previousClose).toFixed(2),
      changePercent: previousClose > 0 ? (((currentPrice - previousClose) / previousClose) * 100).toFixed(2) : '0.00',
      previousClose: previousClose.toFixed(2),
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function getQuote(symbolOrInstrument) {
  const symbol =
    typeof symbolOrInstrument === 'object'
      ? symbolOrInstrument.symbol
      : String(symbolOrInstrument).toUpperCase();
  const mapping = (getTickerMappingFn || defaultMapping)(symbol);
  if (mapping.source !== 'yahoo') {
    return { canonical: null, error: 'not_yahoo_symbol' };
  }

  const raw = await fetchYahooQuote(mapping.ticker);
  const canonical = normalizeYahooLegacy(raw, symbol);
  if (!canonical.valid) {
    canonical.warning = (canonical.warning ? `${canonical.warning}; ` : '') + 'yahoo_fallback';
  } else {
    canonical.warning = canonical.warning || 'yahoo_fallback';
  }
  return { canonical, error: canonical.valid ? null : 'invalid_yahoo' };
}

async function getQuotes(symbols) {
  const list = Array.isArray(symbols) ? symbols : [];
  const out = [];
  for (const s of list) {
    const { canonical } = await getQuote(s);
    if (canonical) out.push(canonical);
  }
  return out;
}

async function getHistoricalBars(symbolOrInstrument, range, interval) {
  const symbol =
    typeof symbolOrInstrument === 'object'
      ? symbolOrInstrument.symbol
      : String(symbolOrInstrument).toUpperCase();
  const mapping = (getTickerMappingFn || defaultMapping)(symbol);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(mapping.ticker)}`;
  try {
    const response = await axios.get(url, {
      params: { range, interval, includePrePost: false },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000,
    });
    const result = response.data?.chart?.result?.[0];
    const quotes = result?.indicators?.quote?.[0];
    const timestamps = result?.timestamp || [];
    if (!quotes?.close) return { bars: [], source: 'yahoo' };

    const bars = timestamps
      .map((ts, i) => ({
        date: new Date(ts * 1000).toISOString(),
        open: quotes.open?.[i],
        high: quotes.high?.[i],
        low: quotes.low?.[i],
        close: quotes.close?.[i],
        volume: quotes.volume?.[i],
      }))
      .filter((b) => b.close != null);

    return { bars, source: 'yahoo' };
  } catch (err) {
    return { bars: [], error: err.message, source: 'yahoo' };
  }
}

function getProviderStatus() {
  return { name: 'yahoo', connected: true, status: 'available' };
}

module.exports = {
  getQuote,
  getQuotes,
  getHistoricalBars,
  getProviderStatus,
  setTickerMappingResolver,
  fetchYahooQuote,
};
