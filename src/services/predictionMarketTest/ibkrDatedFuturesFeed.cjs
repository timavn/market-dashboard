const {
  sidecarRequest,
} = require('../providers/ibkrSidecarClient');
const {
  CONTRACT_REGISTRY,
} = require('./registry.cjs');

const DEFAULT_POLL_MS = 2_500;
const DEFAULT_QUOTE_MAX_AGE_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const FUTURES_MONTHS = Object.freeze({
  F: 1,
  G: 2,
  H: 3,
  J: 4,
  K: 5,
  M: 6,
  N: 7,
  Q: 8,
  U: 9,
  V: 10,
  X: 11,
  Z: 12,
});
const FUTURE_ROOTS = Object.freeze({
  CL: Object.freeze({ exchange: 'NYMEX', multiplier: '1000' }),
  GC: Object.freeze({ exchange: 'COMEX', multiplier: '100' }),
  ES: Object.freeze({ exchange: 'CME', multiplier: '50' }),
  NQ: Object.freeze({ exchange: 'CME', multiplier: '20' }),
});
const ACCEPTED_LIVE_ENTITLEMENTS = new Set(['live', 'tick_by_tick']);
const FORBIDDEN_SOURCE_PATTERN = /(?:^|[_\s-])(cache|cached|delayed|fixture|mock|portfolio|seed|seeded|synthetic|upload|yahoo|databento)(?:$|[_\s-])/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finitePositive(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeMessage(error, fallback = 'IBKR live futures quotes are unavailable.') {
  return String(error?.message || error || fallback)
    .replace(/[\r\n]+/g, ' ')
    .replace(/(token|password|secret|api[_-]?key)=[^\s&]+/gi, '$1=[redacted]')
    .trim()
    .slice(0, 300) || fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}

function parseFutureSymbol(value) {
  const match = normalizeText(value).match(/^([A-Z]{1,3})([FGHJKMNQUVXZ])(\d{1,4})$/);
  if (!match) return null;
  return {
    root: match[1],
    monthCode: match[2],
    month: FUTURES_MONTHS[match[2]],
    yearToken: match[3],
  };
}

/**
 * Turn the registry's compact and display symbols into an unambiguous IBKR
 * contract month. A one-digit year is never expanded without corroboration
 * from the registry's longer display symbol.
 */
function datedFutureIdentity(feed = {}) {
  const raw = parseFutureSymbol(feed.symbol);
  const display = parseFutureSymbol(feed.displaySymbol);
  if (!raw || !display) return null;
  if (raw.root !== display.root || raw.monthCode !== display.monthCode) return null;
  if (display.yearToken.length !== 2 && display.yearToken.length !== 4) return null;
  const year = display.yearToken.length === 4
    ? Number(display.yearToken)
    : 2000 + Number(display.yearToken);
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return null;
  if (!String(year).endsWith(raw.yearToken) || !String(year).endsWith(display.yearToken)) return null;
  const month = String(raw.month).padStart(2, '0');
  return {
    root: raw.root,
    localSymbol: normalizeText(feed.symbol),
    displaySymbol: normalizeText(feed.displaySymbol),
    monthCode: raw.monthCode,
    year,
    month: raw.month,
    contractMonth: `${year}${month}`,
  };
}

function buildRegistryFutureSpecs(registry = CONTRACT_REGISTRY) {
  const specs = [];
  const seenSymbols = new Set();
  for (const product of registry) {
    if (!product?.feed?.symbol) continue;
    const identity = datedFutureIdentity(product.feed);
    if (!identity) continue;
    const rootConfig = FUTURE_ROOTS[identity.root];
    if (!rootConfig) {
      throw new Error(`Unsupported Resolver Test IBKR future root: ${identity.root}`);
    }
    if (seenSymbols.has(identity.localSymbol)) {
      throw new Error(`Duplicate Resolver Test future symbol: ${identity.localSymbol}`);
    }
    seenSymbols.add(identity.localSymbol);
    specs.push(Object.freeze({
      productId: product.id,
      role: product.feed.role,
      exact: product.feed.exact === true,
      warning: product.feed.warning || null,
      expectedExpirationStart: product.feed.expectedExpirationStart || null,
      expectedExpirationEnd: product.feed.expectedExpirationEnd || null,
      ...identity,
      exchange: rootConfig.exchange,
      currency: 'USD',
      secType: 'FUT',
      tradingClass: identity.root,
      multiplier: rootConfig.multiplier,
    }));
  }
  return Object.freeze(specs);
}

function instrumentForSpec(spec) {
  return {
    symbol: spec.root,
    secType: spec.secType,
    exchange: spec.exchange,
    currency: spec.currency,
    lastTradeDateOrContractMonth: spec.contractMonth,
    tradingClass: spec.tradingClass,
    multiplier: spec.multiplier,
  };
}

function initialSymbolState(spec) {
  return {
    symbol: spec.localSymbol,
    definition: null,
    quote: null,
    trade: null,
    settlements: {},
    marketStatus: null,
    error: null,
  };
}

function evidenceSource(payload) {
  return [
    payload?.source,
    payload?.provider,
    payload?.dataOrigin,
    payload?.data_origin,
    payload?.verification,
    payload?.mode,
  ].filter(Boolean).join(' ');
}

function forbiddenEvidence(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (
    payload.fromCache === true
    || payload.from_cache === true
    || payload.cacheOnly === true
    || payload.cache_only === true
    || payload.cached === true
    || payload.delayed === true
    || payload.isDelayed === true
    || payload.is_delayed === true
    || payload.mock === true
    || payload.isMock === true
    || payload.is_mock === true
    || payload.seeded === true
    || payload.synthetic === true
    || payload.portfolioDerived === true
    || payload.portfolio_derived === true
  ) return true;
  return FORBIDDEN_SOURCE_PATTERN.test(evidenceSource(payload));
}

function quoteIdentityCode(raw, spec) {
  if (normalizeText(raw?.localSymbol) !== spec.localSymbol) return 'LOCAL_SYMBOL_MISMATCH';
  if (normalizeText(raw?.symbol) !== spec.root) return 'ROOT_SYMBOL_MISMATCH';
  if (normalizeText(raw?.secType) !== spec.secType) return 'SECURITY_TYPE_MISMATCH';
  if (normalizeText(raw?.exchange) !== spec.exchange) return 'EXCHANGE_MISMATCH';
  if (normalizeText(raw?.currency) !== spec.currency) return 'CURRENCY_MISMATCH';
  if (!Number.isInteger(Number(raw?.conId)) || Number(raw.conId) <= 0) return 'CONTRACT_ID_MISSING';
  return null;
}

function validateLiveQuote(raw, spec, {
  nowDate = new Date(),
  maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS,
  requestStartedAt = null,
} = {}) {
  if (!raw || typeof raw !== 'object') return { valid: false, code: 'QUOTE_MISSING' };
  if (forbiddenEvidence(raw)) return { valid: false, code: 'NON_LIVE_SOURCE_REJECTED' };
  const identityCode = quoteIdentityCode(raw, spec);
  if (identityCode) return { valid: false, code: identityCode };
  if (String(raw.dataType || '').trim().toLowerCase() !== 'live') {
    return { valid: false, code: 'LIVE_MARKET_DATA_REQUIRED' };
  }
  if (String(raw.priceState || '').trim().toLowerCase() !== 'market_mark') {
    return { valid: false, code: 'LIVE_MARKET_MARK_REQUIRED' };
  }
  const entitlement = String(raw.entitlementStatus || '').trim().toLowerCase();
  if (!ACCEPTED_LIVE_ENTITLEMENTS.has(entitlement)) {
    return { valid: false, code: 'LIVE_ENTITLEMENT_REQUIRED' };
  }
  if (requestStartedAt) {
    const materializedMs = Date.parse(String(raw.fetched_at || raw.fetchedAt || ''));
    const requestStartedMs = requestStartedAt instanceof Date
      ? requestStartedAt.getTime()
      : Date.parse(String(requestStartedAt || ''));
    // fetched_at is not market evidence. It is used only to prove that the
    // sidecar materialized this response after this refresh began, so an old
    // stream-cache object cannot cross into the Resolver Test feed.
    if (
      !Number.isFinite(materializedMs)
      || !Number.isFinite(requestStartedMs)
      || materializedMs < requestStartedMs
    ) {
      return { valid: false, code: 'SIDECAR_CACHE_REJECTED' };
    }
  }
  const observedAt = isoTimestamp(raw.timestamp);
  const observedMs = Date.parse(observedAt || '');
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : Number.NaN;
  const ageMs = Number.isFinite(observedMs) && Number.isFinite(nowMs)
    ? nowMs - observedMs
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > maxAgeMs) {
    return { valid: false, code: 'QUOTE_STALE_OR_UNTIMESTAMPED' };
  }
  const bid = finitePositive(raw.bid);
  const ask = finitePositive(raw.ask);
  const last = finitePositive(raw.last);
  if (bid != null && ask != null && bid > ask) {
    return { valid: false, code: 'CROSSED_MARKET_REJECTED' };
  }
  if (last == null && !(bid != null && ask != null)) {
    return { valid: false, code: 'LIVE_PRICE_MISSING' };
  }
  return {
    valid: true,
    code: 'VERIFIED_IBKR_LIVE_DATED_FUTURE',
    observedAt,
    ageMs: Math.max(0, ageMs),
    bid,
    ask,
    last,
    bidSize: finiteNumber(raw.bidSize ?? raw.bid_size),
    askSize: finiteNumber(raw.askSize ?? raw.ask_size),
    lastSize: finiteNumber(raw.lastSize ?? raw.last_size),
    conId: Number(raw.conId),
  };
}

function definitionFromVerifiedQuote(raw, spec, validation, observedAt) {
  return {
    rawSymbol: spec.localSymbol,
    instrumentId: validation.conId,
    instrumentClass: 'FUT',
    expiration: null,
    contractMonth: spec.contractMonth,
    localSymbol: spec.localSymbol,
    exchange: spec.exchange,
    currency: spec.currency,
    validation: {
      valid: true,
      code: 'VERIFIED_IBKR_LIVE_DATED_FUTURE',
    },
    provenance: {
      provider: 'ibkr',
      requested: instrumentForSpec(spec),
      qualified: {
        symbol: normalizeText(raw.symbol),
        localSymbol: normalizeText(raw.localSymbol),
        conId: validation.conId,
        secType: normalizeText(raw.secType),
        exchange: normalizeText(raw.exchange),
        currency: normalizeText(raw.currency),
      },
      maturity: {
        displaySymbol: spec.displaySymbol,
        localSymbol: spec.localSymbol,
        monthCode: spec.monthCode,
        year: spec.year,
        month: spec.month,
        contractMonth: spec.contractMonth,
        expectedExpirationStart: spec.expectedExpirationStart,
        expectedExpirationEnd: spec.expectedExpirationEnd,
      },
    },
    asOf: observedAt,
    source: 'ibkr_qualified_dated_future',
  };
}

function createIbkrDatedFuturesFeed({
  env = process.env,
  registry = CONTRACT_REGISTRY,
  sidecarRequestImpl = sidecarRequest,
  now = () => new Date(),
  logger = console,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const specs = buildRegistryFutureSpecs(registry);
  const specByLocalSymbol = new Map(specs.map((spec) => [spec.localSymbol, spec]));
  const exactSpecs = specs.filter((spec) => spec.exact);
  // Production health is defined by exact resolver inputs. A custom registry
  // containing only proxies still treats those configured symbols as required,
  // which keeps focused validation/test harnesses fail-closed.
  const requiredSpecs = exactSpecs.length ? exactSpecs : specs;
  const requiredSymbols = new Set(requiredSpecs.map((spec) => spec.localSymbol));
  const optionalSpecs = specs.filter((spec) => !requiredSymbols.has(spec.localSymbol));
  const symbols = Object.fromEntries(specs.map((spec) => [spec.localSymbol, initialSymbolState(spec)]));
  const enabled = String(env.IBKR_MARKET_DATA_ENABLED ?? 'true').toLowerCase() !== 'false';
  const pollMs = boundedInteger(
    env.PREDICTION_MARKET_IBKR_POLL_MS,
    DEFAULT_POLL_MS,
    500,
    60_000,
  );
  const maxAgeMs = boundedInteger(
    env.PREDICTION_MARKET_IBKR_QUOTE_MAX_AGE_MS,
    DEFAULT_QUOTE_MAX_AGE_MS,
    1_000,
    60_000,
  );
  const requestTimeoutMs = boundedInteger(
    env.PREDICTION_MARKET_IBKR_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    500,
    30_000,
  );
  let timer = null;
  let inFlight = null;
  let started = false;
  let generation = 0;
  const provider = {
    provider: 'ibkr',
    dataset: 'IBKR TWS/Gateway live market data',
    configured: enabled,
    connected: false,
    status: enabled ? 'starting' : 'disabled',
    message: enabled ? 'IBKR Resolver Test feed has not started.' : 'IBKR market data is disabled.',
    startedAt: null,
    connectedAt: null,
    lastMessageAt: null,
    lastErrorAt: null,
    requestedSymbolCount: requiredSpecs.length,
    verifiedSymbolCount: 0,
    rejectedSymbolCount: 0,
    coverageStatus: 'none',
    optionalSymbolCount: optionalSpecs.length,
    verifiedOptionalSymbolCount: 0,
    rejectedOptionalSymbolCount: optionalSpecs.length,
    optionalCoverageStatus: optionalSpecs.length ? 'none' : 'not_applicable',
    dataType: 'live_only',
    cachePolicy: 'no_fallback',
  };

  function stateHasFreshVerifiedQuote(state) {
    return Boolean(state?.definition?.validation?.valid && (state.quote || state.trade));
  }

  function updateCoverageCounts() {
    const verifiedRequired = requiredSpecs.filter((spec) => (
      stateHasFreshVerifiedQuote(symbols[spec.localSymbol])
    )).length;
    const verifiedOptional = optionalSpecs.filter((spec) => (
      stateHasFreshVerifiedQuote(symbols[spec.localSymbol])
    )).length;
    provider.verifiedSymbolCount = verifiedRequired;
    provider.rejectedSymbolCount = Math.max(0, requiredSpecs.length - verifiedRequired);
    provider.coverageStatus = requiredSpecs.length > 0 && verifiedRequired === requiredSpecs.length
      ? 'complete'
      : verifiedRequired > 0 ? 'partial' : 'none';
    provider.verifiedOptionalSymbolCount = verifiedOptional;
    provider.rejectedOptionalSymbolCount = Math.max(0, optionalSpecs.length - verifiedOptional);
    provider.optionalCoverageStatus = optionalSpecs.length === 0
      ? 'not_applicable'
      : verifiedOptional === optionalSpecs.length
        ? 'complete'
        : verifiedOptional > 0 ? 'partial' : 'none';
    return verifiedRequired;
  }

  function setStatusFromRequiredCoverage(nowDate) {
    const verified = updateCoverageCounts();
    if (requiredSpecs.length === 0 || verified === 0) {
      provider.status = 'unavailable';
      provider.message = 'No fresh verified live IBKR dated-futures quotes are available.';
      provider.lastErrorAt = nowDate.toISOString();
      return false;
    }
    if (verified < requiredSpecs.length) {
      provider.status = 'degraded';
      provider.message = `IBKR live coverage is partial (${verified}/${requiredSpecs.length} required dated futures verified).`;
      provider.lastErrorAt = nowDate.toISOString();
      return false;
    }
    provider.status = 'live';
    provider.message = null;
    return true;
  }

  function clearLiveObservations({ clearDefinitions = true } = {}) {
    Object.values(symbols).forEach((state) => {
      if (clearDefinitions) state.definition = null;
      state.quote = null;
      state.trade = null;
      state.marketStatus = null;
      state.error = null;
    });
    provider.verifiedSymbolCount = 0;
    provider.rejectedSymbolCount = 0;
    provider.coverageStatus = 'none';
    provider.verifiedOptionalSymbolCount = 0;
    provider.rejectedOptionalSymbolCount = optionalSpecs.length;
    provider.optionalCoverageStatus = optionalSpecs.length ? 'none' : 'not_applicable';
  }

  function setUnavailable(error, code = 'IBKR_LIVE_QUOTES_UNAVAILABLE') {
    provider.connected = false;
    provider.status = 'unavailable';
    provider.message = safeMessage(error);
    provider.lastErrorAt = now().toISOString();
    clearLiveObservations();
    Object.values(symbols).forEach((state) => {
      state.error = { code, message: provider.message };
    });
  }

  function expireStaleObservations() {
    const nowDate = now();
    for (const state of Object.values(symbols)) {
      if (!state.definition?.validation?.valid) continue;
      const timestamps = [state.quote?.asOf, state.trade?.asOf]
        .map((value) => Date.parse(value || ''))
        .filter(Number.isFinite);
      const freshest = timestamps.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
      const ageMs = nowDate.getTime() - freshest;
      if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > maxAgeMs) {
        state.definition = null;
        state.quote = null;
        state.trade = null;
        state.marketStatus = null;
        state.error = {
          code: 'QUOTE_STALE_OR_UNTIMESTAMPED',
          message: 'The last IBKR provider-timestamped quote is stale.',
        };
      }
    }
    if (provider.connected && ['live', 'degraded', 'unavailable'].includes(provider.status)) {
      setStatusFromRequiredCoverage(nowDate);
    } else {
      updateCoverageCounts();
    }
  }

  async function runRefresh(refreshGeneration) {
    if (!enabled) {
      provider.configured = false;
      provider.connected = false;
      provider.status = 'disabled';
      provider.message = 'IBKR market data is disabled.';
      clearLiveObservations();
      return false;
    }
    expireStaleObservations();
    if (!['live', 'degraded'].includes(provider.status)) {
      provider.status = 'starting';
      provider.message = 'Verifying the IBKR Gateway session and dated futures quotes.';
    }
    const requestStartedAt = now();
    try {
      const status = await sidecarRequestImpl('/status', { timeoutMs: Math.min(3_000, requestTimeoutMs) });
      if (refreshGeneration !== generation) return false;
      if (
        !status
        || status.connected !== true
        || forbiddenEvidence(status)
        || /(?:delayed|mock|seed|cache|portfolio)/i.test(String(status.status || ''))
      ) {
        const error = new Error(status?.message || 'IBKR Gateway is not connected to a verified live session.');
        error.code = 'IBKR_GATEWAY_NOT_CONNECTED';
        throw error;
      }
      provider.connected = true;
      provider.connectedAt = provider.connectedAt || now().toISOString();

      const response = await sidecarRequestImpl('/quotes', {
        method: 'POST',
        timeoutMs: requestTimeoutMs,
        body: {
          instruments: specs.map(instrumentForSpec),
        },
      });
      if (refreshGeneration !== generation) return false;
      if (!response || response.ok !== true || !Array.isArray(response.quotes) || forbiddenEvidence(response)) {
        const error = new Error(response?.message || 'IBKR live futures quote request failed verification.');
        error.code = 'IBKR_QUOTES_RESPONSE_REJECTED';
        throw error;
      }

      const nowDate = now();
      // Replace the prior batch atomically only after both sidecar calls have
      // succeeded. A missing/rejected symbol in this batch can never inherit
      // the previous batch's value.
      clearLiveObservations();
      const candidatesByLocalSymbol = new Map();
      for (const raw of response.quotes) {
        const localSymbol = normalizeText(raw?.localSymbol);
        if (!specByLocalSymbol.has(localSymbol)) continue;
        const current = candidatesByLocalSymbol.get(localSymbol) || [];
        current.push(raw);
        candidatesByLocalSymbol.set(localSymbol, current);
      }

      for (const spec of specs) {
        const state = symbols[spec.localSymbol];
        const candidates = candidatesByLocalSymbol.get(spec.localSymbol) || [];
        if (candidates.length !== 1) {
          state.error = {
            code: candidates.length ? 'AMBIGUOUS_CONTRACT_RESPONSE' : 'QUOTE_MISSING',
            message: candidates.length
              ? 'IBKR returned more than one quote for the exact local symbol.'
              : 'IBKR returned no quote for the exact local symbol.',
          };
          continue;
        }
        const raw = candidates[0];
        const validation = validateLiveQuote(raw, spec, {
          nowDate,
          maxAgeMs,
          requestStartedAt,
        });
        if (!validation.valid) {
          state.error = {
            code: validation.code,
            message: `IBKR quote rejected: ${validation.code}`,
          };
          continue;
        }
        state.definition = definitionFromVerifiedQuote(raw, spec, validation, validation.observedAt);
        if (validation.bid != null || validation.ask != null) {
          state.quote = {
            bid: validation.bid,
            ask: validation.ask,
            bidSize: validation.bidSize,
            askSize: validation.askSize,
            asOf: validation.observedAt,
            tsEvent: validation.observedAt,
            tsRecv: null,
            source: 'ibkr_live_market_data',
          };
        }
        if (validation.last != null) {
          state.trade = {
            price: validation.last,
            size: validation.lastSize,
            asOf: validation.observedAt,
            tsEvent: validation.observedAt,
            tsRecv: null,
            source: 'ibkr_live_market_data',
          };
        }
        // POST /quotes proves a current market observation, not the exchange's
        // session state. Leave marketStatus null unless a future sidecar
        // contract supplies authoritative session-status events.
        state.marketStatus = null;
      }

      provider.lastMessageAt = nowDate.toISOString();
      return setStatusFromRequiredCoverage(nowDate);
    } catch (error) {
      if (refreshGeneration !== generation) return false;
      setUnavailable(error, error?.code || 'IBKR_LIVE_QUOTES_UNAVAILABLE');
      return false;
    }
  }

  function refresh() {
    if (inFlight) return inFlight;
    const refreshGeneration = generation;
    inFlight = runRefresh(refreshGeneration).catch((error) => {
      if (refreshGeneration === generation) {
        setUnavailable(error);
        logger.warn?.('[Resolver Test] IBKR futures refresh failed:', safeMessage(error));
      }
      return false;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start() {
    if (!enabled) {
      provider.configured = false;
      provider.status = 'disabled';
      provider.message = 'IBKR market data is disabled.';
      return false;
    }
    if (started) return true;
    started = true;
    generation += 1;
    provider.startedAt = provider.startedAt || now().toISOString();
    void refresh();
    timer = setIntervalImpl(() => {
      void refresh();
    }, pollMs);
    timer?.unref?.();
    return true;
  }

  function stop() {
    started = false;
    generation += 1;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    provider.connected = false;
    provider.status = enabled ? 'unavailable' : 'disabled';
    provider.message = enabled ? 'IBKR Resolver Test feed stopped.' : 'IBKR market data is disabled.';
    clearLiveObservations();
  }

  function getSnapshot() {
    expireStaleObservations();
    return {
      provider: clone(provider),
      symbols: clone(Object.fromEntries(Object.entries(symbols).map(([symbol, state]) => [symbol, {
        symbol,
        role: specByLocalSymbol.get(symbol)?.role || null,
        exact: specByLocalSymbol.get(symbol)?.exact === true,
        required: requiredSymbols.has(symbol),
        status: state.definition?.validation?.valid && (state.quote || state.trade)
          ? 'live'
          : provider.status === 'disabled'
            ? 'disabled'
            : provider.status === 'starting' ? 'starting' : 'unavailable',
        definition: state.definition,
        quote: state.quote,
        trade: state.trade,
        settlements: state.settlements,
        marketStatus: state.marketStatus,
        error: state.error,
      }]))),
    };
  }

  function getHealth() {
    const snapshot = getSnapshot();
    return {
      ...snapshot.provider,
      symbols: Object.fromEntries(Object.entries(snapshot.symbols).map(([symbol, state]) => [symbol, {
        role: state.role,
        exact: state.exact,
        required: state.required,
        status: state.status,
        definition: state.definition?.validation || {
          valid: false,
          code: state.error?.code || 'DEFINITION_PENDING',
        },
        lastQuoteAt: state.quote?.asOf || null,
        lastTradeAt: state.trade?.asOf || null,
        settlementDates: [],
        error: state.error,
        provenance: state.definition?.provenance || null,
      }])),
    };
  }

  return {
    getHealth,
    getSnapshot,
    refresh,
    start,
    stop,
  };
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_QUOTE_MAX_AGE_MS,
  FUTURE_ROOTS,
  buildRegistryFutureSpecs,
  createIbkrDatedFuturesFeed,
  datedFutureIdentity,
  instrumentForSpec,
  validateLiveQuote,
};
