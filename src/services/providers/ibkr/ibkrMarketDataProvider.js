const { sidecarRequest, getSidecarProviderStatus } = require('../ibkrSidecarClient');
const { normalizeIbkrRaw } = require('../normalize/normalizeQuote');
const {
  resolveInstrument,
  instrumentCacheKey,
  canUseSymbolStream,
} = require('../instruments/instrumentResolver');
const { getCachedCanonical, STREAM_ENABLED } = require('../../ibkr/ibkrStreamBridge');
const {
  setIbkrConnected,
  setIbkrLastQuoteAt,
  getProviderStatusSnapshot,
} = require('../providerStatus');

const CACHE_TTL_MS = Number(process.env.IBKR_QUOTE_CACHE_TTL_MS || 3000);
const ENABLED = process.env.IBKR_MARKET_DATA_ENABLED !== 'false';
const quoteCache = new Map();

async function checkConnection() {
  try {
    const status = await getSidecarProviderStatus('ibkr');
    const connected = Boolean(status.connected);
    setIbkrConnected(connected, status.message || null);
    return connected;
  } catch (err) {
    setIbkrConnected(false, err.message);
    return false;
  }
}

async function getProviderStatus() {
  const status = await getSidecarProviderStatus('ibkr');
  setIbkrConnected(Boolean(status.connected), status.message);
  return status;
}

/**
 * @param {string|object} symbolOrInstrument
 */
async function getQuote(symbolOrInstrument) {
  if (!ENABLED) {
    return { canonical: null, error: 'ibkr_disabled' };
  }

  const instrument = resolveInstrument(symbolOrInstrument);
  if (!instrument.supported) {
    return { canonical: null, error: instrument.reason || 'unsupported' };
  }

  const key = instrumentCacheKey(symbolOrInstrument);
  const cached = quoteCache.get(key);
  const providerState = getProviderStatusSnapshot().ibkr;
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS && providerState.connected) {
    return { canonical: { ...cached.data, source: 'ibkr' }, fromCache: true };
  }
  if (cached && !providerState.connected) {
    quoteCache.delete(key);
  }

  if (STREAM_ENABLED && canUseSymbolStream(symbolOrInstrument)) {
    const streamCached = getCachedCanonical(instrument.symbol);
    if (streamCached?.valid) {
      setIbkrLastQuoteAt(streamCached.timestamp || new Date().toISOString());
      return { canonical: { ...streamCached, source: 'ibkr' }, fromStreamCache: true };
    }
  }

  const connected = await checkConnection();
  if (!connected) {
    return { canonical: null, error: 'not_connected' };
  }

  try {
    const body = {
      instruments: [
        {
          symbol: instrument.symbol,
          secType: instrument.secType,
          exchange: instrument.exchange,
          currency: instrument.currency,
          conId: instrument.conid,
        },
      ],
    };
    const res = await sidecarRequest('/quotes', { method: 'POST', body });
    if (!res.ok || !res.quotes?.length) {
      return { canonical: null, error: res.message || 'no_quote' };
    }
    const canonical = normalizeIbkrRaw(res.quotes[0]);
    if (canonical.valid) {
      setIbkrLastQuoteAt(new Date().toISOString());
      quoteCache.set(key, { data: canonical, ts: Date.now() });
    }
    return { canonical, error: canonical.valid ? null : 'invalid_quote' };
  } catch (err) {
    return { canonical: null, error: err.message };
  }
}

async function getQuotes(symbolsOrInstruments) {
  const list = Array.isArray(symbolsOrInstruments) ? symbolsOrInstruments : [];
  const results = await Promise.all(list.map((s) => getQuote(s)));
  return results.map((r) => r.canonical).filter(Boolean);
}

async function getHistoricalBars(symbolOrInstrument, range, interval) {
  if (!ENABLED) return { bars: [], error: 'ibkr_disabled' };
  const instrument = resolveInstrument(symbolOrInstrument);
  if (!instrument.supported) return { bars: [], error: 'unsupported' };

  const connected = await checkConnection();
  if (!connected) return { bars: [], error: 'not_connected' };

  try {
    const res = await sidecarRequest('/historical', {
      method: 'POST',
      body: { instrument, range, interval },
    });
    return { bars: res.bars || [], source: 'ibkr' };
  } catch (err) {
    return { bars: [], error: err.message };
  }
}

module.exports = {
  getQuote,
  getQuotes,
  getHistoricalBars,
  getProviderStatus,
  checkConnection,
  ENABLED,
};
