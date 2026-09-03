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
const HISTORICAL_TIMEOUT_MS = Number(process.env.IBKR_HISTORICAL_TIMEOUT_MS || 15000);
const HISTORICAL_RECORD_TIMEOUT_MS = Number(process.env.IBKR_HISTORICAL_RECORD_TIMEOUT_MS || 120000);
const QUOTE_REQUEST_TIMEOUT_MS = Number(process.env.IBKR_QUOTE_REQUEST_TIMEOUT_MS || 10000);
const ENABLED = process.env.IBKR_MARKET_DATA_ENABLED !== 'false';
const FORBIDDEN_HISTORICAL_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived|yahoo/i;
const quoteCache = new Map();

function hasForbiddenHistoricalProvenance(payload) {
  const provenance = [
    payload?.warning,
    payload?.error,
    payload?.provenance,
    payload?.cacheStatus,
    payload?.cacheState,
    payload?.sourceStatus,
    payload?.fromCache ? 'cached' : '',
    payload?.cached ? 'cached' : '',
    payload?.cachedOnly ? 'cached-only' : '',
    payload?.cacheOnly ? 'cache-only' : '',
    payload?.cacheHit ? 'cache-hit' : '',
    payload?.mock ? 'mock' : '',
    payload?.seeded ? 'seeded' : '',
    payload?.fallback ? 'fallback' : '',
  ].filter(Boolean).join(' ');
  return FORBIDDEN_HISTORICAL_PROVENANCE.test(provenance);
}

function recordQuoteHeartbeat(canonical) {
  if (!canonical?.valid) return;
  const dataType = String(canonical.dataType || '').trim().toLowerCase();
  const availability = dataType === 'live'
    ? 'current'
    : dataType === 'delayed'
      ? 'delayed'
      : null;
  if (availability) {
    // Track when the dashboard received the verified observation; delayed
    // provider timestamps can be older than the receipt time by design.
    setIbkrLastQuoteAt(new Date().toISOString(), availability);
  }
}

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
      recordQuoteHeartbeat(streamCached);
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
          lastTradeDateOrContractMonth: instrument.lastTradeDateOrContractMonth,
          tradingClass: instrument.tradingClass,
          multiplier: instrument.multiplier,
        },
      ],
    };
    const res = await sidecarRequest('/quotes', {
      method: 'POST',
      body,
      timeoutMs: QUOTE_REQUEST_TIMEOUT_MS,
    });
    if (!res.ok || !res.quotes?.length) {
      return { canonical: null, error: res.message || 'no_quote' };
    }
    const rawQuote = res.quotes[0];
    const canonical = normalizeIbkrRaw(rawQuote);
    canonical.symbol = instrument.displaySymbol || canonical.symbol;
    canonical.providerSymbol = canonical.providerSymbol || rawQuote.symbol || instrument.symbol;
    if (canonical.valid) {
      recordQuoteHeartbeat(canonical);
      quoteCache.set(key, { data: canonical, ts: Date.now() });
    }
    return {
      canonical,
      error: canonical.valid ? null : (canonical.warning || 'invalid_quote'),
    };
  } catch (err) {
    return { canonical: null, error: err.message };
  }
}

async function getQuotes(symbolsOrInstruments) {
  const list = Array.isArray(symbolsOrInstruments) ? symbolsOrInstruments : [];
  const results = await Promise.all(list.map((s) => getQuote(s)));
  return results.map((r) => r.canonical).filter(Boolean);
}

async function getHistoricalBars(symbolOrInstrument, range, interval, { useRth = true } = {}) {
  if (!ENABLED) return { bars: [], error: 'ibkr_disabled' };
  const instrument = resolveInstrument(symbolOrInstrument);
  if (!instrument.supported) return { bars: [], error: 'unsupported' };

  try {
    const res = await sidecarRequest('/historical', {
      method: 'POST',
      body: {
        instrument: {
          ...instrument,
          conId: instrument.conid,
        },
        range,
        interval,
        useRth: useRth !== false,
      },
      timeoutMs: HISTORICAL_TIMEOUT_MS,
    });
    if (
      res?.ok !== true
      || res?.source !== 'ibkr'
      || !Array.isArray(res?.bars)
      || hasForbiddenHistoricalProvenance(res)
    ) {
      return { bars: [], source: null, error: res?.message || 'invalid_ibkr_historical_response' };
    }
    return {
      bars: res.bars,
      source: 'ibkr',
      asOf: res.fetched_at || null,
      contract: res.contract || null,
      useRth: res.use_rth !== false,
    };
  } catch (err) {
    return { bars: [], error: err.message };
  }
}

async function getHistoricalRecord(symbolOrInstrument, throughDate) {
  const unavailable = (reason) => ({
    status: 'unavailable',
    source: null,
    asOf: null,
    throughDate: /^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || '')) ? throughDate : null,
    recordHigh: null,
    recordDate: null,
    coverage: null,
    reason,
  });
  if (!ENABLED) return unavailable('ibkr_disabled');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || ''))) {
    return unavailable('invalid_through_date');
  }
  const instrument = resolveInstrument(symbolOrInstrument);
  if (!instrument.supported) return unavailable(instrument.reason || 'unsupported');

  try {
    const res = await sidecarRequest('/historical-record', {
      method: 'POST',
      body: {
        instrument: {
          ...instrument,
          conId: instrument.conid,
        },
        throughDate,
      },
      timeoutMs: HISTORICAL_RECORD_TIMEOUT_MS,
    });
    const recordHigh = Number(res?.record?.high);
    const recordDate = String(res?.record?.date || '');
    const coverage = res?.coverage;
    if (
      res?.ok !== true
      || res?.status !== 'available'
      || res?.source !== 'ibkr'
      || hasForbiddenHistoricalProvenance(res)
      || res?.through_date !== throughDate
      || !Number.isFinite(recordHigh)
      || recordHigh <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)
      || recordDate < coverage?.start_date
      || recordDate > throughDate
      || coverage?.complete !== true
      || coverage?.end_date !== throughDate
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(coverage?.start_date || ''))
      || coverage?.head_date !== coverage?.start_date
      || !(Number(coverage?.chunks) >= 1)
      || !(Number(coverage?.observations) >= 2)
    ) {
      return unavailable(res?.message || 'incomplete_ibkr_historical_record');
    }
    return {
      status: 'available',
      source: 'ibkr',
      dataset: 'historical_record',
      asOf: res.fetched_at || null,
      throughDate,
      recordHigh,
      recordDate,
      coverage: {
        complete: true,
        startDate: coverage.start_date,
        endDate: coverage.end_date,
        headDate: coverage.head_date,
        chunks: Number(coverage.chunks) || 0,
        observations: Number(coverage.observations) || 0,
      },
      reason: null,
    };
  } catch (err) {
    return unavailable(err.message);
  }
}

module.exports = {
  getQuote,
  getQuotes,
  getHistoricalBars,
  getHistoricalRecord,
  getProviderStatus,
  checkConnection,
  ENABLED,
};
