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
  const instrument = resolveInstrument(symbolOrInstrument);
  const observedAt = () => new Date().toISOString();
  if (!['auto', 'ibkr', 'yahoo'].includes(instrument.provider)) {
    setMarketMeta(instrument.provider, `${instrument.provider}_quote_unavailable`);
    return null;
  }
  const ibkrOnly = instrument.provider === 'ibkr';
  if (ibkrOnly && !instrument.supported) {
    setMarketMeta(null, instrument.reason || 'ibkr_quote_unavailable');
    return null;
  }
  const shouldUseYahooDirectly = instrument.provider === 'yahoo'
    || (!instrument.supported && !ibkrOnly);
  if (shouldUseYahooDirectly && instrument.reason !== 'forecast_event_todo') {
    const yahooResult = await yahoo.getQuote(symbolOrInstrument);
    if (yahooResult.canonical?.valid) {
      setMarketMeta('yahoo', yahooResult.canonical.warning, observedAt());
      return yahooResult.canonical;
    }
    setMarketMeta(null, 'no_quote_available');
    return null;
  }

  const ibkrResult = await ibkr.getQuote(symbolOrInstrument);
  if (ibkrResult.canonical?.valid) {
    setMarketMeta('ibkr', ibkrResult.canonical.warning, observedAt());
    return ibkrResult.canonical;
  }

  if (ibkrOnly) {
    setMarketMeta(null, ibkrResult.error || 'ibkr_quote_unavailable');
    return null;
  }

  const yahooResult = await yahoo.getQuote(symbolOrInstrument);
  if (yahooResult.canonical) {
    yahooResult.canonical.source = 'yahoo';
    yahooResult.canonical.warning = [
      ibkrResult.error ? `ibkr: ${ibkrResult.error}` : 'ibkr_unavailable',
      yahooResult.canonical.warning,
    ]
      .filter(Boolean)
      .join('; ');
    yahooResult.canonical.valid = yahooResult.canonical.valid && Boolean(yahooResult.canonical.mark);
    if (yahooResult.canonical.valid) {
      setMarketMeta('yahoo', yahooResult.canonical.warning, observedAt());
      return yahooResult.canonical;
    }
    setMarketMeta(null, 'no_quote_available');
    return null;
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
    // FRED/Stooq observations are historical reference data, not current
    // market-provider evidence. Keep them out of the SYS market-data health
    // state so a rates lookup cannot overwrite the last IBKR/Yahoo quote.
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

async function getHistoricalBars(symbolOrInstrument, range, interval) {
  const instrument = resolveInstrument(symbolOrInstrument);
  const ibkrBars = await ibkr.getHistoricalBars(symbolOrInstrument, range, interval);
  if (ibkrBars.bars?.length || instrument.provider === 'ibkr') return ibkrBars;
  return yahoo.getHistoricalBars(symbolOrInstrument, range, interval);
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
