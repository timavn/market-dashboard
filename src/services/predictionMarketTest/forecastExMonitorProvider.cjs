const {
  sidecarRequest,
} = require('../providers/ibkrSidecarClient');
const { formatInTimeZone } = require('date-fns-tz');

const QUOTE_MAX_AGE_MS = 90_000;
const CATALOG_TTL_MS = 5 * 60_000;
const MAX_DISCOVERY_STRIKES = 100;
const REFRESH_INTERVAL_MS = 30_000;
const MONITOR_PRODUCTS = Object.freeze({
  sp500: 'FES',
  wti: 'COMCO',
  nasdaq100: 'FNQ',
  gold: 'METLG',
  silver: 'METLS',
});
const MONITOR_BROKER_IDENTITIES = Object.freeze({
  sp500: Object.freeze({
    productCode: 'FES',
    symbol: 'ES',
    secType: 'FOP',
    exchange: 'FORECASTX',
    currency: 'USD',
    tradingClass: 'FES',
  }),
});
const FORBIDDEN = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived|portfolio/i;

function finiteNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function selectDiscoveryStrikes(contracts = [], maximum = MAX_DISCOVERY_STRIKES) {
  const lines = (Array.isArray(contracts) ? contracts : [])
    .filter((line) => finiteNumber(line?.strike) != null)
    .sort((left, right) => left.strike - right.strike);
  if (lines.length <= maximum) return lines.map((line) => Number(line.strike));
  const ranked = [...lines].sort((left, right) => (
    Number(right.openInterest || 0) - Number(left.openInterest || 0)
    || Math.abs(lines.indexOf(left) - (lines.length - 1) / 2) - Math.abs(lines.indexOf(right) - (lines.length - 1) / 2)
  ));
  return [...new Set(ranked.slice(0, maximum).map((line) => Number(line.strike)))].sort((left, right) => left - right);
}

function monitorContext(context) {
  const targetStrikes = selectDiscoveryStrikes(context.contracts);
  return {
    marketId: context.marketId,
    productCode: context.productCode,
    generationKey: context.generationKey,
    eventPrefix: context.generationKey,
    closeTime: context.closeTime,
    targetStrikes,
  };
}

function generationExpiry(generationKey) {
  const match = String(generationKey || '').match(/^[A-Z0-9]+_(\d{2})(\d{2})(\d{2})$/);
  return match ? `20${match[3]}${match[1]}${match[2]}` : null;
}

function brokerContractIdentity(context) {
  const marketId = String(context?.marketId || '').trim().toLowerCase();
  const productCode = String(context?.productCode || '').trim().toUpperCase();
  const configured = MONITOR_BROKER_IDENTITIES[marketId];
  if (configured?.productCode === productCode) return configured;
  return {
    productCode,
    symbol: productCode,
    secType: 'OPT',
    exchange: 'FORECASTX',
    currency: 'USD',
    tradingClass: productCode,
  };
}

function exactQualificationRequests(context) {
  const expiry = generationExpiry(context.generationKey);
  if (!expiry) return [];
  const identity = brokerContractIdentity(context);
  return (Array.isArray(context.contracts) ? context.contracts : []).flatMap((line) => {
    const strike = finiteNumber(line?.strike);
    if (!line?.contractId || strike == null) return [];
    return ['C', 'P'].map((right) => ({
      publicContractId: String(line.contractId).toUpperCase(),
      contractId: String(line.contractId).toUpperCase(),
      productCode: identity.productCode,
      symbol: identity.symbol,
      underlying: identity.symbol,
      secType: identity.secType,
      exchange: identity.exchange,
      currency: identity.currency,
      lastTradeDateOrContractMonth: expiry,
      tradingClass: identity.tradingClass,
      strike,
      right,
      quote_side: right === 'C' ? 'YES' : 'NO',
      releaseKey: context.generationKey,
      close_time: context.closeTime,
      expiration_time: context.closeTime,
      question: line.question || null,
      contract_title: line.question || line.contractId,
      event_title: line.eventDisplayName || context.generationKey,
      settlement_source: line.rulesUrl || null,
      url: line.rulesUrl || null,
      min_tick: 0.01,
      max_payout_per_contract: 1,
    }));
  });
}

function isCurrentMonitorContext(context, nowMs = Date.now()) {
  const marketId = String(context?.marketId || '').trim().toLowerCase();
  const productCode = String(context?.productCode || '').trim().toUpperCase();
  const generationKey = String(context?.generationKey || '').trim().toUpperCase();
  const closeMs = Date.parse(context?.closeTime || '');
  const generationMatch = generationKey.match(new RegExp(`^${productCode}_(\\d{2})(\\d{2})(\\d{2})$`));
  const closeDate = Number.isFinite(closeMs)
    ? formatInTimeZone(new Date(closeMs), 'America/Chicago', 'MMddyy')
    : null;
  return Boolean(marketId)
    && MONITOR_PRODUCTS[marketId] === productCode
    && /^[A-Z0-9]+$/.test(productCode)
    && Boolean(generationMatch)
    && generationMatch.slice(1).join('') === closeDate
    && Number.isFinite(closeMs)
    && closeMs > nowMs;
}

function eventContractId(event) {
  const raw = String(
    event?.publicContractId
    || event?.contractId
    || event?.api_raw_symbol
    || event?.contract_title
    || event?.question
    || '',
  ).trim().toUpperCase();
  return raw.replace(/_(?:YES|NO)$/i, '');
}

function normalizeLiveSnapshot(result, context, nowMs = Date.now()) {
  const fetchedAt = isoTimestamp(result?.fetched_at);
  const fetchedMs = Date.parse(fetchedAt || '');
  const provider = result?.providers?.ibkr || {};
  if (provider.status !== 'connected' || !fetchedAt || nowMs - fetchedMs < -5_000 || nowMs - fetchedMs > QUOTE_MAX_AGE_MS) {
    return {
      status: 'unavailable',
      fetchedAt: null,
      lines: [],
      errorCode: result?.errorCode || provider?.errorCode || 'FORECASTEX_IBKR_NOT_CONNECTED',
      reason: provider.message || 'ForecastEx IBKR live quotes are unavailable.',
    };
  }
  const identity = brokerContractIdentity(context);
  const grouped = new Map();
  (Array.isArray(result?.events) ? result.events : []).forEach((event) => {
    const contractId = eventContractId(event);
    const quoteSide = String(event?.quote_side || '').toUpperCase();
    const quoteAt = isoTimestamp(event?.exchange_timestamp);
    const quoteMs = Date.parse(quoteAt || '');
    const flags = Array.isArray(event?.data_quality_flags) ? event.data_quality_flags.join(' ') : '';
    const liveDataType = event?.dataType === 1 || String(event?.dataType).toLowerCase() === 'live';
    const identityValid = contractId.startsWith(`${context.generationKey}_`)
      && event?.releaseKey === context.generationKey
      && String(event?.productCode || '').toUpperCase() === identity.productCode
      && String(event?.underlying || '').toUpperCase() === identity.symbol
      && String(event?.secType || '').toUpperCase() === identity.secType
      && String(event?.exchange || '').toUpperCase() === identity.exchange
      && String(event?.tradingClass || '').toUpperCase() === identity.tradingClass
      && ['YES', 'NO'].includes(quoteSide);
    const fresh = quoteAt && nowMs - quoteMs >= -5_000 && nowMs - quoteMs <= QUOTE_MAX_AGE_MS;
    if (!identityValid || !liveDataType || !fresh || FORBIDDEN.test(flags)) return;
    const bid = finiteNumber(event?.native_bid, { min: 0, max: 1 });
    const ask = finiteNumber(event?.native_ask, { min: 0, max: 1 });
    const bidSize = finiteNumber(event?.native_bid_size, { min: 0 });
    const askSize = finiteNumber(event?.native_ask_size, { min: 0 });
    if (bid == null && ask == null) return;
    if (bid != null && ask != null && ask < bid) return;
    const line = grouped.get(contractId) || {
      contractId,
      yesBid: null,
      yesAsk: null,
      yesBidSize: null,
      yesAskSize: null,
      noBid: null,
      noAsk: null,
      noBidSize: null,
      noAskSize: null,
      updatedAt: quoteAt,
      dataType: 'live',
      directNative: true,
      provenance: 'ibkr_tws_native_forecastex',
    };
    if (quoteSide === 'YES') {
      line.yesBid = bid;
      line.yesAsk = ask;
      line.yesBidSize = bidSize;
      line.yesAskSize = askSize;
    } else {
      line.noBid = bid;
      line.noAsk = ask;
      line.noBidSize = bidSize;
      line.noAskSize = askSize;
    }
    if (Date.parse(quoteAt) > Date.parse(line.updatedAt || '')) line.updatedAt = quoteAt;
    grouped.set(contractId, line);
  });
  const lines = [...grouped.values()];
  return {
    status: lines.length ? 'available' : 'unavailable',
    fetchedAt,
    lines,
    errorCode: result?.errorCode || provider?.errorCode || null,
    reason: lines.length ? null : provider.message || 'IBKR returned no fresh native ForecastEx quotes for the current event generation.',
  };
}

function createForecastExMonitorProvider({
  request = sidecarRequest,
  now = Date.now,
} = {}) {
  const catalogs = new Map();
  const monitorStates = new Map();
  const nowMs = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  };

  async function loadCatalog(context) {
    const identity = brokerContractIdentity(context);
    const requestedContracts = exactQualificationRequests(context);
    const contractFingerprint = requestedContracts
      .map((contract) => `${contract.contractId}:${contract.right}`)
      .sort()
      .join(',');
    const cacheKey = `${context.marketId}:${context.productCode}:${context.generationKey}:${contractFingerprint}`;
    const cached = catalogs.get(cacheKey);
    const currentMs = nowMs();
    if (cached && currentMs < cached.expiresAt) return cached.contracts;
    const body = {
      monitor: monitorContext(context),
      catalogContracts: requestedContracts,
    };
    const discovered = await request('/discover', {
      method: 'POST',
      body,
      timeoutMs: 30_000,
    });
    if (discovered?.ok === false) {
      const error = new Error(
        discovered?.message
        || 'ForecastEx contract qualification failed before a current catalog could be verified.',
      );
      error.code = discovered?.errorCode || discovered?.error_code || 'FORECASTEX_QUALIFICATION_FAILED';
      throw error;
    }
    const contracts = (Array.isArray(discovered?.catalog_contracts) ? discovered.catalog_contracts : [])
      .filter((contract) => (
        contract?.releaseKey === context.generationKey
        && String(contract?.productCode || '').toUpperCase() === identity.productCode
        && String(contract?.symbol || contract?.underlying || '').toUpperCase() === identity.symbol
        && String(contract?.secType || '').toUpperCase() === identity.secType
        && String(contract?.exchange || '').toUpperCase() === identity.exchange
        && String(contract?.tradingClass || '').toUpperCase() === identity.tradingClass
        && String(contract?.publicContractId || contract?.contractId || '').toUpperCase().startsWith(`${context.generationKey}_`)
        && ['C', 'P'].includes(String(contract?.right || '').toUpperCase())
        && Number(contract?.conId) > 0
      ));
    if (!contracts.length) return [];
    const closeMs = Date.parse(context.closeTime || '');
    catalogs.set(cacheKey, {
      contracts,
      expiresAt: Math.min(
        Number.isFinite(closeMs) ? closeMs : currentMs + CATALOG_TTL_MS,
        currentMs + CATALOG_TTL_MS,
      ),
    });
    return contracts;
  }

  async function refreshSnapshot(context, state) {
    state.lastAttemptMs = nowMs();
    try {
      const contracts = await loadCatalog(context);
      state.brokerRoutable = contracts.length > 0;
      if (!contracts.length) {
        const completedMs = nowMs();
        state.snapshot = {
          status: 'unavailable', fetchedAt: null, lines: [],
          reason: 'No current ForecastEx IBKR contract generation could be qualified from official metadata.',
          errorCode: 'FORECASTEX_QUALIFICATION_EMPTY',
          lastAttemptAt: new Date(state.lastAttemptMs).toISOString(),
          lastSuccessfulObservationAt: state.lastSuccessMs ? new Date(state.lastSuccessMs).toISOString() : null,
          latencyMs: Math.max(0, completedMs - state.lastAttemptMs),
        };
        return state.snapshot;
      }
      const result = await request('/refresh', {
        method: 'POST',
        body: {
          monitor: monitorContext(context),
          catalogContracts: contracts,
          // ForecastEx contracts can take longer than the first bounded stream
          // window to publish their native top of book. Retry only contracts
          // for which the sidecar observed no current native quote.
          retryMissing: true,
        },
        timeoutMs: 40_000,
      });
      const completedMs = nowMs();
      const normalized = normalizeLiveSnapshot(result, context, completedMs);
      if (normalized.status === 'available') state.lastSuccessMs = completedMs;
      state.snapshot = {
        ...normalized,
        lastAttemptAt: new Date(state.lastAttemptMs).toISOString(),
        lastSuccessfulObservationAt: state.lastSuccessMs ? new Date(state.lastSuccessMs).toISOString() : null,
        latencyMs: Math.max(0, completedMs - state.lastAttemptMs),
      };
      return state.snapshot;
    } catch (error) {
      const completedMs = nowMs();
      state.snapshot = {
        status: 'unavailable',
        fetchedAt: null,
        lines: [],
        reason: String(error?.message || error || 'ForecastEx IBKR refresh failed.').slice(0, 240),
        errorCode: error?.code || error?.sidecarCode || 'FORECASTEX_IBKR_REFRESH_FAILED',
        refreshFailed: true,
        lastAttemptAt: new Date(state.lastAttemptMs).toISOString(),
        lastSuccessfulObservationAt: state.lastSuccessMs ? new Date(state.lastSuccessMs).toISOString() : null,
        latencyMs: Math.max(0, completedMs - state.lastAttemptMs),
      };
      return state.snapshot;
    } finally {
      state.inFlight = null;
    }
  }

  function currentStateSnapshot(state) {
    if (state.inFlight) {
      const previous = state.snapshot;
      const fetchedMs = Date.parse(previous?.fetchedAt || '');
      const previousFresh = previous?.status === 'available'
        && Number.isFinite(fetchedMs)
        && nowMs() - fetchedMs >= -5_000
        && nowMs() - fetchedMs <= QUOTE_MAX_AGE_MS;
      if (previousFresh) {
        return {
          ...previous,
          brokerRoutable: state.brokerRoutable === true,
          refreshing: true,
          refreshRetained: true,
          refreshFailed: false,
          refreshIssue: null,
          lastAttemptAt: Number.isFinite(state.lastAttemptMs) ? new Date(state.lastAttemptMs).toISOString() : null,
          lastSuccessfulObservationAt: Number.isFinite(state.lastSuccessMs) ? new Date(state.lastSuccessMs).toISOString() : null,
        };
      }
      return {
        status: 'unavailable',
        fetchedAt: null,
        lines: [],
        errorCode: null,
        reason: 'ForecastEx IBKR live quotes are refreshing.',
        brokerRoutable: state.brokerRoutable === true,
        refreshing: true,
        lastAttemptAt: Number.isFinite(state.lastAttemptMs) ? new Date(state.lastAttemptMs).toISOString() : null,
        lastSuccessfulObservationAt: Number.isFinite(state.lastSuccessMs) ? new Date(state.lastSuccessMs).toISOString() : null,
      };
    }
    const snapshot = state.snapshot || {
      status: 'unavailable', fetchedAt: null, lines: [],
      reason: 'ForecastEx IBKR live quotes are refreshing.',
    };
    const fetchedMs = Date.parse(snapshot.fetchedAt || '');
    const stale = snapshot.status === 'available'
      && (!Number.isFinite(fetchedMs) || nowMs() - fetchedMs > QUOTE_MAX_AGE_MS || nowMs() - fetchedMs < -5_000);
    return {
      ...(stale ? {
        status: 'unavailable', fetchedAt: null, lines: [],
        reason: 'ForecastEx IBKR live quotes expired and are refreshing.',
        errorCode: 'FORECASTEX_BOOK_STALE',
        lastAttemptAt: snapshot.lastAttemptAt || null,
        lastSuccessfulObservationAt: snapshot.lastSuccessfulObservationAt || null,
        latencyMs: snapshot.latencyMs ?? null,
      } : snapshot),
      brokerRoutable: state.brokerRoutable === true,
      refreshing: false,
    };
  }

  async function getSnapshot(context) {
    if (!isCurrentMonitorContext(context, nowMs())) {
      return {
        status: 'unavailable',
        fetchedAt: null,
        lines: [],
        brokerRoutable: false,
        refreshing: false,
        reason: 'ForecastEx monitor context is invalid, expired, or from a prior event generation.',
      };
    }
    const cacheKey = `${context.marketId}:${context.productCode}:${context.generationKey}`;
    const selectionFingerprint = (Array.isArray(context.contracts) ? context.contracts : [])
      .map((contract) => `${String(contract?.contractId || '')}:${finiteNumber(contract?.strike) ?? ''}`)
      .sort()
      .join(',');
    let state = monitorStates.get(cacheKey);
    if (!state) {
      state = {
        snapshot: null,
        brokerRoutable: false,
        inFlight: null,
        lastAttemptMs: null,
        lastSuccessMs: null,
        selectionFingerprint: null,
      };
      monitorStates.set(cacheKey, state);
    }
    const selectionChanged = state.selectionFingerprint !== selectionFingerprint;
    const due = selectionChanged
      || !Number.isFinite(state.lastAttemptMs)
      || nowMs() - state.lastAttemptMs >= REFRESH_INTERVAL_MS;
    if (due && !state.inFlight) {
      state.selectionFingerprint = selectionFingerprint;
      state.inFlight = refreshSnapshot(context, state);
    }
    return currentStateSnapshot(state);
  }

  return { getSnapshot };
}

module.exports = {
  MAX_DISCOVERY_STRIKES,
  QUOTE_MAX_AGE_MS,
  brokerContractIdentity,
  createForecastExMonitorProvider,
  exactQualificationRequests,
  generationExpiry,
  isCurrentMonitorContext,
  normalizeLiveSnapshot,
  selectDiscoveryStrikes,
};
