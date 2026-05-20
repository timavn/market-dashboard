const ibkr = require('./ibkr/ibkrMarketDataProvider');
const yahoo = require('./yahoo/yahooMarketDataProvider');
const { toLegacyQuote } = require('./normalize/legacyQuoteAdapter');
const { setMarketMeta } = require('./providerStatus');
const { resolveInstrument } = require('./instruments/instrumentResolver');

/** @type {((symbol: string) => Promise<object|null>)|null} */
let fetchSpecialQuoteFn = null;

function setSpecialQuoteFetcher(fn) {
  fetchSpecialQuoteFn = fn;
}

/**
 * FRED / intl bonds / stooq — injected from server.js
 */
async function trySpecialQuote(symbol) {
  if (!fetchSpecialQuoteFn) return null;
  return fetchSpecialQuoteFn(symbol);
}

async function getCanonicalQuote(symbolOrInstrument) {
  const symbol =
    typeof symbolOrInstrument === 'object'
      ? symbolOrInstrument.symbol
      : String(symbolOrInstrument).toUpperCase();

  const instrument = resolveInstrument(symbolOrInstrument);
  if (!instrument.supported && instrument.reason !== 'forecast_event_todo') {
    const yahooResult = await yahoo.getQuote(symbol);
    if (yahooResult.canonical?.valid) {
      setMarketMeta('yahoo', yahooResult.canonical.warning);
      return yahooResult.canonical;
    }
    return null;
  }

  const ibkrResult = await ibkr.getQuote(symbolOrInstrument);
  if (ibkrResult.canonical?.valid) {
    setMarketMeta('ibkr', ibkrResult.canonical.warning);
    return ibkrResult.canonical;
  }

  const yahooResult = await yahoo.getQuote(symbol);
  if (yahooResult.canonical) {
    yahooResult.canonical.source = 'yahoo';
    yahooResult.canonical.warning = [
      ibkrResult.error ? `ibkr: ${ibkrResult.error}` : 'ibkr_unavailable',
      yahooResult.canonical.warning,
    ]
      .filter(Boolean)
      .join('; ');
    yahooResult.canonical.valid = yahooResult.canonical.valid && Boolean(yahooResult.canonical.mark);
    setMarketMeta('yahoo', yahooResult.canonical.warning);
    return yahooResult.canonical.valid ? yahooResult.canonical : null;
  }

  setMarketMeta(null, 'no_quote_available');
  return null;
}

async function getQuote(symbolOrInstrument) {
  const symbol =
    typeof symbolOrInstrument === 'object'
      ? symbolOrInstrument.symbol
      : String(symbolOrInstrument).toUpperCase();

  const special = await trySpecialQuote(symbol);
  if (special?.legacy) {
    setMarketMeta(special.legacy.source || 'fred', null);
    return special.legacy;
  }

  const canonical = await getCanonicalQuote(symbolOrInstrument);
  if (!canonical) return null;
  return toLegacyQuote(canonical);
}

async function getQuotes(symbols) {
  const list = Array.isArray(symbols) ? symbols : [];
  const out = {};
  for (const s of list) {
    const q = await getQuote(s);
    if (q) out[(q.symbol || s).toUpperCase()] = q;
  }
  return out;
}

async function getHistoricalBars(symbol, range, interval) {
  const ibkrBars = await ibkr.getHistoricalBars(symbol, range, interval);
  if (ibkrBars.bars?.length) return ibkrBars;
  return yahoo.getHistoricalBars(symbol, range, interval);
}

async function getProviderStatus() {
  const ibkrSt = await ibkr.getProviderStatus();
  const snapshot = require('./providerStatus').getProviderStatusSnapshot();
  return {
    ibkr: { ...ibkrSt, ...snapshot.ibkr },
    yahoo: yahoo.getProviderStatus(),
    market: snapshot.market,
    portfolio: snapshot.portfolio,
  };
}

module.exports = {
  getQuote,
  getQuotes,
  getHistoricalBars,
  getProviderStatus,
  getCanonicalQuote,
  setSpecialQuoteFetcher,
};
