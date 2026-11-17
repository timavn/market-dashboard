const { withQuoteObservation, validateQuoteObservation } = require('./normalize/quoteContract.cjs');
const ibkr = require('./ibkr/ibkrMarketDataProvider');
const yahoo = require('./yahoo/yahooMarketDataProvider');
const { toLegacyQuote } = require('./normalize/legacyQuoteAdapter');
const { setMarketMeta, getProviderStatusSnapshot } = require('./providerStatus');
const { resolveInstrument, instrumentCacheKey } = require('./instruments/instrumentResolver');

// An instrument IBKR could not quote a moment ago is not waited on again at
// once: a failed read holds its caller for the whole quote wait, on every
// poll, before Yahoo answers anyway. While a miss is remembered, requests go
// straight to Yahoo and IBKR is retried in the background, after 30 seconds,
// then a minute, then every two minutes. The first success, or a new Gateway
// session, puts the instrument back on IBKR.
const IBKR_MISS_RETRY_MS = [30_000, 60_000, 120_000];
const IBKR_MISS_LIMIT = 500;
// Answered without waiting, and not the instrument's doing.
const IBKR_NOT_ASKED = new Set(['not_connected', 'connection_changed', 'ibkr_disabled']);
const ibkrMisses = new Map();

function ibkrSession() {
  return getProviderStatusSnapshot().ibkr?.connectionGeneration ?? null;
}

function recordIbkrResult(key, result) {
  if (result?.canonical?.valid) {
    ibkrMisses.delete(key);
    return;
  }
  const previous = ibkrMisses.get(key);
  if (IBKR_NOT_ASKED.has(result?.error)) {
    // IBKR was not consulted, so nothing was learned; look again shortly.
    if (previous) {
      previous.retrying = false;
      previous.retryAt = Date.now() + IBKR_MISS_RETRY_MS[0];
    }
    return;
  }
  const misses = (previous?.misses || 0) + 1;
  ibkrMisses.delete(key);
  ibkrMisses.set(key, {
    misses,
    error: result?.error || null,
    session: ibkrSession(),
    retryAt: Date.now() + IBKR_MISS_RETRY_MS[Math.min(misses, IBKR_MISS_RETRY_MS.length) - 1],
    retrying: false,
  });
  if (ibkrMisses.size > IBKR_MISS_LIMIT) ibkrMisses.delete(ibkrMisses.keys().next().value);
}

function rememberedIbkrMiss(key) {
  const miss = ibkrMisses.get(key);
  if (!miss) return null;
  if (miss.session !== ibkrSession()) {
    ibkrMisses.delete(key);
    return null;
  }
  return miss;
}

function retryIbkrInBackground(key, symbolOrInstrument, miss) {
  if (miss.retrying) return;
  miss.retrying = true;
  const settle = (result) => {
    // A newer miss, or a new Gateway session, has replaced this one.
    if (ibkrMisses.get(key) === miss) recordIbkrResult(key, result);
  };
  Promise.resolve()
    .then(() => ibkr.getQuote(symbolOrInstrument))
    .then(settle, (error) => settle({ canonical: null, error: error?.message || 'ibkr_retry_failed' }));
}

function resetIbkrMisses() {
  ibkrMisses.clear();
}

// True while IBKR is being skipped for this instrument, after at least
// `minMisses` failed attempts in a row.
function hasIbkrMiss(symbolOrInstrument, minMisses = 1) {
  const miss = rememberedIbkrMiss(instrumentCacheKey(symbolOrInstrument));
  return Boolean(miss && miss.misses >= minMisses);
}

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

  // An IBKR-only instrument has nowhere else to go, so it is always asked.
  const missKey = ibkrOnly ? null : instrumentCacheKey(symbolOrInstrument);
  const miss = missKey ? rememberedIbkrMiss(missKey) : null;
  let ibkrResult;
  if (miss) {
    if (Date.now() >= miss.retryAt) retryIbkrInBackground(missKey, symbolOrInstrument, miss);
    ibkrResult = { canonical: null, error: miss.error };
  } else {
    ibkrResult = await ibkr.getQuote(symbolOrInstrument);
    if (missKey) recordIbkrResult(missKey, ibkrResult);
  }
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
    const quote = withQuoteObservation(special.legacy, { instrument: symbolOrInstrument, receivedAt: special.legacy.receivedAt ?? Date.now() });
    return validateQuoteObservation(quote, { instrument: symbolOrInstrument }).valid ? quote : null;
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
  resetIbkrMisses,
  hasIbkrMiss,
};
