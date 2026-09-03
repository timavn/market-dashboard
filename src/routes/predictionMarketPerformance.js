const express = require('express');
const crypto = require('node:crypto');
const {
  ACTIVE_STATUSES,
  DISPLAY_STATUSES,
  SCHEDULE_REPAIR_REASONS,
  applyContractSchedule,
  createLedgerStore,
  createReconciler,
  createRevisionRecord,
  finalizeLifecycle,
  forecastExThresholdIdentity,
  loadPerformance,
  loadPerformanceExecutions,
  performanceSummaryKeys,
  requestedPerformanceMarket,
  emptyPerformanceSummary,
  sortPerformanceRows,
} = require('../services/predictionMarketPerformanceLedger.cjs');
const {
  applyContractMark,
  applyResolverSettlementDetails,
  applyPreliminaryResolverReferences,
  exactKalshiMarketTicker,
  markActivePerformanceRows,
  resolveForecastExOfficialSettlementMarks,
  summarizeTrackedRows,
  verifiedResolverSettlement,
} = require('../services/predictionMarketPerformanceMarks.cjs');
const { createSpxFesResearchService } = require('../services/spxFesResearchService.cjs');

const DEFAULT_READ_ENRICHMENT_TIMEOUT_MS = 750;
const OPTIONAL_READ_TIMEOUT = Symbol('optional_read_timeout');

async function boundedOptionalRead(task, { timeoutMs, fallback, onTimeout, onError } = {}) {
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(task),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(OPTIONAL_READ_TIMEOUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === OPTIONAL_READ_TIMEOUT) {
      onTimeout?.();
      return fallback;
    }
    return result;
  } catch (error) {
    onError?.(error);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function markRowsForPerformanceRead(rows = [], providers = {}) {
  return Promise.all(rows.map(async (row) => {
    const identity = forecastExThresholdIdentity(row);
    if (String(row?.status || '').toLowerCase() === 'awaiting_resolution'
      && identity?.productCode === 'FES') {
      // FES expiry rows are valued only from an exact resolver reference here.
      // The reconciler owns the official complementary YES/NO settlement read.
      return applyContractMark(row, null);
    }
    const [marked] = await markActivePerformanceRows([row], providers);
    return marked || applyContractMark(row, null);
  }));
}

function normalizedEventTicker(value) {
  return String(value || '').trim().toUpperCase().replace(/_/g, '-');
}

function exactEventTicker(record = {}) {
  const explicit = normalizedEventTicker(record.eventTicker);
  if (explicit) return explicit;
  const source = normalizedEventTicker(`${record.contractKey || ''} ${record.contractLabel || ''}`);
  return source.match(/\b(KX(?:WTI[A-Z]*|INX[A-Z]*|CPI[A-Z0-9]*)-\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\d{0,4}(?:H\d{4})?)?)\b/)?.[1] || null;
}

function contractOutcomeIsYes(record, observed, { equalityWins = false } = {}) {
  const rule = String(record.contractRule || '').toLowerCase();
  if (/between|bucket|range/.test(rule)) return null;
  if (/below|less/.test(rule)) return equalityWins ? Number(observed) <= Number(record.strike) : Number(observed) < Number(record.strike);
  if (/above|greater/.test(rule)) return equalityWins ? Number(observed) >= Number(record.strike) : Number(observed) > Number(record.strike);
  return null;
}

function datePart(value) {
  const raw = String(value || '').trim();
  const calendar = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
  if (calendar) {
    const candidate = `${calendar[1]}-${calendar[2]}-${calendar[3]}`;
    const parsed = Date.parse(`${candidate}T00:00:00Z`);
    if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === candidate) return candidate;
  }
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  const parsed = compact
    ? Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]))
    : Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function addUtcDays(value, days) {
  const date = datePart(value);
  if (!date) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`) + Number(days) * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function officialNumericValue(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?%?$/.test(raw)) return null;
  const parsed = Number(raw.replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function contractMonth(record) {
  const eventIdentity = `${record.eventTicker || ''} ${record.contractKey || ''}`.toUpperCase();
  const eventMonth = eventIdentity.match(/KXCPI[A-Z0-9]*[-_](\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/);
  const months = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  if (eventMonth) return `20${eventMonth[1]}-${months[eventMonth[2]]}`;

  const source = String(record.expiration || '').toUpperCase();
  const isoMonth = source.match(/(20\d{2})[-_](0[1-9]|1[0-2])/);
  if (isoMonth) return `${isoMonth[1]}-${isoMonth[2]}`;
  const compactMonth = source.match(/\b(20\d{2})(0[1-9]|1[0-2])\b/);
  if (compactMonth) return `${compactMonth[1]}-${compactMonth[2]}`;
  const compact = source.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/);
  if (!compact) return null;
  const nowYear = new Date().getUTCFullYear();
  const century = Math.floor(nowYear / 100) * 100;
  return `${century + Number(compact[1])}-${months[compact[2]]}`;
}

function buildSettlementProviders({
  getRecentSettledWtiSessions,
  getRecentSettledSpxCloseSessions,
  loadOfficialCpiFinals,
  loadOfficialForecastExPrices,
  getResolverSettlements,
  kalshiFetch,
} = {}) {
  async function exactResolverSettlement(record) {
    if (typeof getResolverSettlements !== 'function') return null;
    try {
      const observations = await getResolverSettlements({ records: [record] });
      return verifiedResolverSettlement(record, Array.isArray(observations) ? observations : []);
    } catch (_error) {
      return null;
    }
  }

  async function forecastExThreshold(record) {
    const identity = forecastExThresholdIdentity(record);
    if (!identity
      || !identity.resolutionDate
      || identity.contractSide !== record.contractSide
      || typeof loadOfficialForecastExPrices !== 'function') return { matched: false };
    for (let offset = 0; offset <= 7; offset += 1) {
      const dataDate = addUtcDays(identity.resolutionDate, offset);
      let snapshot;
      try {
        snapshot = await loadOfficialForecastExPrices({ dataDate });
      } catch (error) {
        if (error?.code === 'FORECASTEX_PRICES_NOT_PUBLISHED') continue;
        throw error;
      }
      if (snapshot?.ok !== true
        || snapshot?.source !== 'forecastex_official_prices'
        || snapshot?.snapshotType !== 'settled_outcome_candidates'
        || snapshot?.dataDate !== dataDate) continue;
      const rows = (snapshot.rows || []).filter(
        (row) => String(row.eventContract || '').toUpperCase() === identity.eventContract.toUpperCase(),
      );
      if (rows.length !== 2 || new Set(rows.map((row) => row.subtype)).size !== 2) continue;
      const yes = rows.find((row) => row.subtype === 'YES');
      const no = rows.find((row) => row.subtype === 'NO');
      if (![yes?.settlementPrice, no?.settlementPrice].every((value) => value === 0 || value === 1)
        || yes.settlementPrice + no.settlementPrice !== 1) continue;
      const settlementDates = new Set(rows.map((row) => datePart(row.expirationDate)).filter(Boolean));
      if (settlementDates.size > 1) continue;
      const held = record.contractSide === 'YES' ? yes : no;
      const payout = held.settlementPrice;
      const outcome = yes.settlementPrice === 1 ? 'YES' : 'NO';
      const settlementDate = [...settlementDates][0] || identity.resolutionDate;
      const resolverSettlement = await exactResolverSettlement(record);
      return {
        matched: true,
        paid: Number(record.paid || 0) + Number(record.netQuantity || 0) * payout,
        resolvedDate: settlementDate,
        resolutionType: 'expiry',
        evidence: {
          source: 'forecastex_official_prices',
          productCode: identity.productCode,
          eventContract: identity.eventContract,
          contractSide: record.contractSide,
          settlementPayout: payout,
          payoutPerContract: payout,
          outcome,
          outcomeObservedAt: snapshot.fetchedAt,
          payoutAt: record.payoutAt || null,
          settlementDate,
          dataDate,
          sourceUrl: snapshot.url,
          sourceHash: snapshot.sha256,
          observedAt: snapshot.fetchedAt,
          ...(resolverSettlement ? {
            underlyingSettlementValue: resolverSettlement.value,
            underlyingSettlementSource: resolverSettlement.source,
            underlyingSettlementObservedAt: resolverSettlement.observedAt,
            underlyingSettlementStatus: resolverSettlement.status,
            underlyingSettlementSymbol: resolverSettlement.symbol,
            underlyingSettlementSourceUrl: resolverSettlement.sourceUrl,
            underlyingSettlementSourceHash: resolverSettlement.sourceHash,
          } : {}),
        },
      };
    }
    return { matched: false };
  }

  async function exactKalshiSettlement(record, expectedPrefix) {
    if (typeof kalshiFetch !== 'function') return null;
    const ticker = exactKalshiMarketTicker(record);
    if (!ticker || (expectedPrefix && !ticker.startsWith(expectedPrefix))) return null;
    const payload = await kalshiFetch(`/markets/${encodeURIComponent(ticker)}`);
    const market = payload?.market;
    if (!market || normalizedEventTicker(market.ticker) !== normalizedEventTicker(ticker)) return null;
    const venueStatus = String(market.status || '').trim().toLowerCase();
    const outcome = String(market.result || '').trim().toUpperCase();
    const outcomeObservedAt = market.settlement_ts || market.settled_time;
    const settlementValue = officialNumericValue(market.expiration_value);
    if (!['finalized', 'settled'].includes(venueStatus)
      || !['YES', 'NO'].includes(outcome)
      || !Number.isFinite(Date.parse(outcomeObservedAt || ''))
      || !Number.isFinite(settlementValue)) return null;
    const payoutPerContract = outcome === record.contractSide ? 1 : 0;
    return {
      matched: true,
      paid: Number(record.paid || 0) + Number(record.netQuantity || 0) * payoutPerContract,
      resolvedDate: datePart(outcomeObservedAt),
      resolutionType: 'expiry',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        eventTicker: ticker,
        outcome,
        outcomeObservedAt,
        payoutPerContract,
        payoutAt: outcomeObservedAt,
        settlementDate: datePart(outcomeObservedAt),
        settlementValue,
        settlementSymbol: market.custom_strike?.front_month_contract || record.settlementSymbol || null,
        sourceUrl: `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`,
        sourceHash: crypto.createHash('sha256').update(JSON.stringify(market)).digest('hex'),
        observedAt: new Date().toISOString(),
      },
    };
  }

  async function wti(record) {
    const forecastExIdentity = forecastExThresholdIdentity(record);
    if (forecastExIdentity?.productCode === 'COMCO') return forecastExThreshold(record);
    const exact = await exactKalshiSettlement(record, 'KXWTI');
    if (exact) return exact;
    if (typeof getRecentSettledWtiSessions !== 'function' || record.strike == null || !record.contractSide) return { matched: false };
    const expectedTicker = exactEventTicker(record);
    if (!expectedTicker || !/^KXWTI/.test(expectedTicker)) return { matched: false };
    const cadence = /KXWTIW/i.test(`${record.eventTicker} ${record.contractKey}`) ? 'weekly' : 'daily';
    const result = await getRecentSettledWtiSessions({ cadence, limit: 15 });
    if (result?.ok !== true || result?.historicalOnly !== true || result?.snapshotType !== 'settled_outcome') return { matched: false };
    const session = (result.sessions || []).find((candidate) => (
      normalizedEventTicker(candidate.eventTicker) === expectedTicker
    ));
    if (!session) return { matched: false };
    if (session.snapshotType !== 'settled_outcome' || session.settlementValue == null) return { matched: false };
    const isYes = contractOutcomeIsYes(record, session.settlementValue);
    if (isYes == null) return { matched: false };
    const won = record.contractSide === 'YES' ? isYes : !isYes;
    const outcome = isYes ? 'YES' : 'NO';
    const outcomeObservedAt = session.settlementTime || session.closeTime || session.eventDate;
    return {
      matched: true,
      paid: Number(record.paid || 0) + Number(record.netQuantity || 0) * (won ? 1 : 0),
      resolvedDate: datePart(outcomeObservedAt),
      resolutionType: 'expiry',
      evidence: {
        source: 'kalshi_settled_wti',
        eventTicker: session.eventTicker,
        outcome,
        outcomeObservedAt,
        payoutPerContract: won ? 1 : 0,
        payoutAt: outcomeObservedAt,
        settlementDate: datePart(outcomeObservedAt),
        settlementValue: session.settlementValue,
      },
    };
  }

  async function sp500(record) {
    const forecastExIdentity = forecastExThresholdIdentity(record);
    if (forecastExIdentity?.productCode === 'FES') return forecastExThreshold(record);
    const exact = await exactKalshiSettlement(record, 'KXINX');
    if (exact) return exact;
    if (typeof getRecentSettledSpxCloseSessions !== 'function' || record.strike == null || !record.contractSide) return { matched: false };
    const expectedTicker = exactEventTicker(record);
    if (!expectedTicker || !/^KXINX/.test(expectedTicker)) return { matched: false };
    const result = await getRecentSettledSpxCloseSessions({ limit: 15 });
    if (result?.ok !== true || result?.historicalOnly !== true || result?.snapshotType !== 'settled_outcome') return { matched: false };
    const targetDate = datePart(record.expiration);
    if (!targetDate) return { matched: false };
    const session = (result.sessions || []).find((candidate) => {
      const candidateDate = datePart(candidate.settlementTime || candidate.closeTime);
      return candidateDate === targetDate && normalizedEventTicker(candidate.eventTicker) === expectedTicker;
    });
    if (!session) return { matched: false };
    if (session.snapshotType !== 'settled_outcome' || session.closeValue == null) return { matched: false };
    const isYes = contractOutcomeIsYes(record, session.closeValue, { equalityWins: true });
    if (isYes == null) return { matched: false };
    const won = record.contractSide === 'YES' ? isYes : !isYes;
    const outcome = isYes ? 'YES' : 'NO';
    const outcomeObservedAt = session.settlementTime || session.closeTime || targetDate;
    return {
      matched: true,
      paid: Number(record.paid || 0) + Number(record.netQuantity || 0) * (won ? 1 : 0),
      resolvedDate: datePart(session.settlementTime || session.closeTime || targetDate),
      resolutionType: 'expiry',
      evidence: {
        source: 'kalshi_settled_sp500',
        eventTicker: session.eventTicker,
        outcome,
        outcomeObservedAt,
        payoutPerContract: won ? 1 : 0,
        payoutAt: outcomeObservedAt,
        settlementDate: datePart(session.settlementTime || session.closeTime || targetDate),
        settlementValue: session.closeValue,
      },
    };
  }

  async function gold(record) {
    const forecastExIdentity = forecastExThresholdIdentity(record);
    if (forecastExIdentity?.productCode !== 'METLG') return { matched: false };
    return forecastExThreshold(record);
  }

  async function cpi(record) {
    const forecastExIdentity = forecastExThresholdIdentity(record);
    if (forecastExIdentity?.productCode === 'CPIY') return forecastExThreshold(record);
    const exactTicker = exactKalshiMarketTicker(record);
    const exact = await exactKalshiSettlement(record, 'KXCPIYOY');
    if (exact) return exact;
    // Once an exact Kalshi market identity is available, the venue's own
    // finalized result is required. A BLS observation cannot substitute for
    // the contract-specific payout evidence.
    if (exactTicker?.startsWith('KXCPIYOY')) return { matched: false };
    if (typeof loadOfficialCpiFinals !== 'function' || record.strike == null || !record.contractSide) return { matched: false };
    if (record.cpiMeasurement !== 'headline_yoy'
      || record.cpiSeriesId !== 'CUUR0000SA0'
      || Number(record.cpiRoundingDecimals) !== 1
      || !['above', 'below'].includes(String(record.contractRule || '').toLowerCase())) return { matched: false };
    const month = contractMonth(record);
    if (!month) return { matched: false };
    const finals = await loadOfficialCpiFinals();
    const final = (finals?.finals || []).find((candidate) => candidate.id === month);
    if (!final || Number(final.value) == null || !/^bls_/i.test(String(final.source || finals?.source || ''))) return { matched: false };
    const isYes = contractOutcomeIsYes(record, final.value);
    if (isYes == null) return { matched: false };
    const won = record.contractSide === 'YES' ? isYes : !isYes;
    return {
      matched: true,
      paid: Number(record.paid || 0) + Number(record.netQuantity || 0) * (won ? 1 : 0),
      resolvedDate: datePart(record.expiration) || new Date().toISOString().slice(0, 10),
      resolutionType: 'expiry',
      evidence: {
        source: final.source || finals.source,
        month,
        settlementDate: datePart(record.expiration) || new Date().toISOString().slice(0, 10),
        settlementValue: final.value,
        seriesId: 'CUUR0000SA0',
        roundingDecimals: 1,
      },
    };
  }
  // Exact finalized Kalshi evidence is market-classification independent. A
  // supported ticker must settle even when the UI market bucket is "other".
  return {
    cpi,
    gold,
    sp500,
    wti,
    exactKalshi: (record) => exactKalshiSettlement(record),
  };
}

function createPredictionMarketPerformanceRoutes({
  dynamodb,
  sidecarRequest,
  tableName,
  settlementProviders = {},
  markProviders = {},
  loadContractSchedule,
  getResolverSettlements,
  getManagedAccounts,
  getKnownAccounts,
  getExpectedAccounts,
  readHistoricalExecutions,
  marketMonitorCoordinator,
  loadOfficialForecastExPrices,
  researchService: injectedResearchService = null,
  readEnrichmentTimeoutMs = Number(
    process.env.PREDICTION_MARKET_PERFORMANCE_READ_ENRICHMENT_TIMEOUT_MS
      || DEFAULT_READ_ENRICHMENT_TIMEOUT_MS,
  ),
  performanceProjectionMaxAgeMs = Number(
    process.env.PREDICTION_MARKET_PERFORMANCE_PROJECTION_MAX_AGE_MS || 90_000,
  ),
  liveCaptureMaxAgeMs = Number(
    process.env.PREDICTION_MARKET_PERFORMANCE_LIVE_CAPTURE_MAX_AGE_MS || 180_000,
  ),
  logger = console,
} = {}) {
  const router = express.Router();
  const store = createLedgerStore({ dynamodb, tableName });
  const researchService = injectedResearchService || createSpxFesResearchService({
    store,
    marketMonitorCoordinator,
    loadOfficialForecastExPrices,
    logger,
  });
  const optionalReadTimeoutMs = Number.isFinite(Number(readEnrichmentTimeoutMs))
    ? Math.max(1, Number(readEnrichmentTimeoutMs))
    : DEFAULT_READ_ENRICHMENT_TIMEOUT_MS;
  const projectionMaxAgeMs = Number.isFinite(Number(performanceProjectionMaxAgeMs))
    ? Math.max(1, Number(performanceProjectionMaxAgeMs))
    : 90_000;
  const captureMaxAgeMs = Number.isFinite(Number(liveCaptureMaxAgeMs))
    ? Math.max(1, Number(liveCaptureMaxAgeMs))
    : 180_000;
  const optionalReadWarnings = new Map();
  const performanceProjections = new Map();
  const performanceProjectionReads = new Map();
  const performanceProjectionGenerations = new Map();

  function normalizeAccountIds(accounts = []) {
    return [...new Set((Array.isArray(accounts) ? accounts : [])
      .map((account) => String(account?.accountId || account?.account || account || '').trim())
      .filter(Boolean))].sort();
  }

  async function resolveAccountCatalog({ includeHistory = true } = {}) {
    const [liveResult, knownResult, expectedResult, registeredResult] = await Promise.allSettled([
      typeof getManagedAccounts === 'function' ? getManagedAccounts() : Promise.resolve([]),
      typeof getKnownAccounts === 'function' ? getKnownAccounts() : Promise.resolve([]),
      typeof getExpectedAccounts === 'function' ? getExpectedAccounts() : Promise.resolve([]),
      typeof store.listRegisteredManagedAccounts === 'function'
        ? store.listRegisteredManagedAccounts()
        : Promise.resolve([]),
    ]);
    const liveDiscoveryAvailable = typeof getManagedAccounts === 'function'
      && liveResult.status === 'fulfilled'
      && Array.isArray(liveResult.value);
    const liveAccountIds = liveDiscoveryAvailable ? normalizeAccountIds(liveResult.value) : [];
    const knownAccountIds = knownResult.status === 'fulfilled' ? normalizeAccountIds(knownResult.value) : [];
    const expectedAccountIds = expectedResult.status === 'fulfilled' ? normalizeAccountIds(expectedResult.value) : [];
    const registeredAccountIds = registeredResult.status === 'fulfilled'
      ? normalizeAccountIds(registeredResult.value)
      : [];
    // An explicit expected-account list is the Contract P&L allowlist. Ledger
    // registrations and Flex history may contain accounts used elsewhere, but
    // they must not silently expand this trading surface beyond its configured
    // live Gateway account.
    const trackedAccountIds = expectedAccountIds.length
      ? expectedAccountIds
      : normalizeAccountIds([
        ...knownAccountIds,
        ...registeredAccountIds,
        ...liveAccountIds,
      ]);
    const scopedLiveAccountIds = liveAccountIds.filter((accountId) => trackedAccountIds.includes(accountId));
    const historyStatuses = includeHistory
      ? await Promise.all(trackedAccountIds.map((accountId) => accountHistoryStatus(accountId)))
      : trackedAccountIds.map((accountId) => ({ accountId, complete: false, status: 'not_loaded' }));
    const historyByAccount = new Map(historyStatuses.map((history) => [history.accountId, history]));
    const availableAccounts = trackedAccountIds.map((accountId) => {
      const history = historyByAccount.get(accountId) || {};
      const liveConnected = scopedLiveAccountIds.includes(accountId);
      return {
        accountId,
        live: liveConnected,
        liveConnected,
        liveStatus: !liveDiscoveryAvailable ? 'unknown' : (liveConnected ? 'connected' : 'not_connected'),
        history: history.complete === true,
        historyComplete: history.complete === true,
        historyStatus: history.status || 'unavailable',
        historyFromDate: history.fromDate || null,
        historyThroughDate: history.toDate || null,
        historyMessage: history.message || null,
      };
    });
    const coverageTargets = expectedAccountIds.length ? expectedAccountIds : trackedAccountIds;
    const missingLiveAccountIds = coverageTargets.filter((accountId) => !scopedLiveAccountIds.includes(accountId));
    const complete = liveDiscoveryAvailable
      && coverageTargets.length > 0
      && missingLiveAccountIds.length === 0;
    const observedAt = new Date().toISOString();
    return {
      trackedAccountIds,
      liveAccountIds: scopedLiveAccountIds,
      liveDiscoveryAvailable,
      availableAccounts,
      historyByAccount,
      accountCoverage: {
        status: complete
          ? 'complete'
          : (liveDiscoveryAvailable ? 'partial_account_coverage' : 'unavailable'),
        complete,
        expected: coverageTargets,
        expectedAccountIds: coverageTargets,
        connected: scopedLiveAccountIds,
        connectedAccountIds: scopedLiveAccountIds,
        missingLiveAccounts: missingLiveAccountIds,
        missingLiveAccountIds,
        observedAt,
        timestamp: observedAt,
      },
    };
  }

  async function knownAccountIds() {
    const catalog = await resolveAccountCatalog({ includeHistory: false });
    return catalog.trackedAccountIds;
  }

  function warnOptionalReadOnce(key, message) {
    const now = Date.now();
    if (now - Number(optionalReadWarnings.get(key) || 0) < 60_000) return;
    optionalReadWarnings.set(key, now);
    logger.warn?.(message);
  }

  async function assertManagedAccount(accountId, suppliedCatalog = null) {
    if (!accountId) {
      const error = new Error('An exact IBKR account is required.');
      error.statusCode = 400;
      error.code = 'ACCOUNT_REQUIRED';
      throw error;
    }
    const catalog = suppliedCatalog || await resolveAccountCatalog({ includeHistory: false });
    const allowed = catalog.trackedAccountIds;
    const lookupAvailable = allowed.length > 0;
    if (allowed.includes(accountId)) return accountId;
    if (!lookupAvailable && await store.isRegisteredManagedAccount(accountId)) return accountId;
    if (!lookupAvailable) {
      const error = new Error('Managed IBKR account authorization is unavailable.');
      error.statusCode = 503;
      error.code = 'ACCOUNT_AUTHORIZATION_UNAVAILABLE';
      throw error;
    }
    if (!allowed.includes(accountId)) {
      const error = new Error('The requested IBKR account is not managed by this dashboard.');
      error.statusCode = 403;
      error.code = 'ACCOUNT_NOT_MANAGED';
      throw error;
    }
    return accountId;
  }

  function hasCurrentLiveCapture(tracker = {}, liveConnected = false) {
    if (!liveConnected || tracker.health !== 'capturing') return false;
    const capturedAt = Date.parse(String(tracker.lastSuccessfulCaptureAt || ''));
    if (!Number.isFinite(capturedAt)) return false;
    const ageMs = Date.now() - capturedAt;
    return ageMs >= -5_000 && ageMs <= captureMaxAgeMs;
  }

  function rowFallsWithinHistory(row = {}, history = {}) {
    if (history.complete !== true || !history.toDate) return false;
    const resolvedDate = datePart(
      row.settlementDate || row.resolvedDate || row.resolutionAt || row.expiration,
    );
    return Boolean(resolvedDate && resolvedDate <= history.toDate);
  }

  function invalidatePerformanceProjection(accountId) {
    if (!accountId) return;
    performanceProjections.delete(accountId);
    performanceProjectionGenerations.set(
      accountId,
      Number(performanceProjectionGenerations.get(accountId) || 0) + 1,
    );
  }

  async function loadPerformanceProjection(accountId, { force = false } = {}) {
    const now = Date.now();
    const cached = performanceProjections.get(accountId);
    if (!force && cached && now - cached.observedAt <= projectionMaxAgeMs) {
      return { ...cached, source: 'projection' };
    }
    const generation = Number(performanceProjectionGenerations.get(accountId) || 0);
    const currentRead = performanceProjectionReads.get(accountId);
    if (currentRead?.generation === generation) return currentRead.promise;
    const promise = loadPerformance({
      store,
      accountId,
      market: 'all',
      sort: 'date',
      direction: 'desc',
    }).then((performance) => {
      const projection = { performance, observedAt: Date.now(), source: 'dynamodb' };
      if (Number(performanceProjectionGenerations.get(accountId) || 0) === generation) {
        performanceProjections.set(accountId, projection);
      }
      return projection;
    }).finally(() => {
      if (performanceProjectionReads.get(accountId)?.promise === promise) {
        performanceProjectionReads.delete(accountId);
      }
    });
    performanceProjectionReads.set(accountId, { generation, promise });
    return promise;
  }

  function selectPerformanceProjection(projection, market, sort, direction) {
    const performance = projection.performance;
    const rows = market === 'all'
      ? performance.rows || []
      : (performance.rows || []).filter((row) => row.market === market);
    const activeRows = market === 'all'
      ? performance.activeRows || []
      : (performance.activeRows || []).filter((row) => row.market === market);
    return {
      ...performance,
      rows: sortPerformanceRows(rows, sort, direction),
      activeRows: sortPerformanceRows(activeRows, sort, direction),
      summary: performance.summaries?.[market] || performance.summary,
    };
  }

  async function accountHistoryStatus(accountId) {
    if (typeof readHistoricalExecutions !== 'function') {
      return {
        accountId,
        complete: false,
        status: 'unconfigured',
        message: 'Historical activity source not configured.',
      };
    }
    try {
      const history = await readHistoricalExecutions(accountId);
      const message = history?.complete === true
        ? null
        : history?.status === 'disabled' || history?.status === 'missing_config'
          ? 'Historical activity source not configured.'
          : history?.status === 'coverage_gap'
            ? `Historical activity coverage gap: ${history.coverage?.fromDate || 'unknown'} through ${history.coverage?.toDate || 'unknown'}.`
            : history?.status === 'missing_sections'
              ? `Historical activity is missing required sections: ${(history.missingSections || []).join(', ')}.`
              : 'Historical activity coverage is incomplete.';
      return {
        accountId,
        complete: history?.complete === true,
        status: history?.status || 'unavailable',
        fromDate: history?.fromDate || null,
        toDate: history?.toDate || null,
        missingSections: history?.missingSections || [],
        message,
      };
    } catch (error) {
      return { accountId, complete: false, status: 'unavailable', message: error.message };
    }
  }

  function rowVenue(row = {}) {
    const identity = [row.exchange, row.contractKey, row.eventTicker, row.contractLabel]
      .filter(Boolean).join(' ').toUpperCase();
    if (identity.includes('FORECAST') || /(?:^|\s)(?:FES|COMCO|METLG|CPIY)[-_]/.test(identity)) return 'forecastex';
    if (/\bKX[A-Z0-9]+[-_]/.test(identity)) return 'kalshi';
    return 'unknown';
  }

  function executionEvidenceKey(execution = {}, fallbackAccountId = '') {
    const executionId = execution.brokerExecutionId
      || execution.execId
      || execution.executionId
      || execution.tradeId;
    if (!executionId) return null;
    const executionAccount = execution.accountId
      || execution.account
      || execution.acctNumber
      || fallbackAccountId;
    return `${String(executionAccount)}:${String(executionId)}`;
  }

  function mergeAccountExecutions(accountId, historicalExecutions = [], liveExecutions = []) {
    const keyed = new Map();
    const unkeyed = [];
    const economicSignature = (execution = {}) => {
      const rawSide = String(execution.side || execution.action || execution.buySell || execution.direction || '').toUpperCase();
      const side = ['BOT', 'BUY', 'B'].includes(rawSide)
        ? 'BUY'
        : (['SLD', 'SELL', 'S'].includes(rawSide) ? 'SELL' : rawSide);
      const rawTime = execution.executionTime || execution.time || execution.tradeDateTime || '';
      const parsedTime = Date.parse(rawTime);
      return JSON.stringify([
        Number(execution.conId ?? execution.conid),
        Number(execution.shares ?? execution.quantity ?? execution.qty),
        Number(execution.price ?? execution.tradePrice),
        Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : String(rawTime),
        side,
      ]);
    };
    // Flex carries the durable, full-period fee evidence, while the current
    // socket is the live provenance. Equivalent broker IDs become one record
    // containing both; contradictory economics pause the capture.
    [...liveExecutions, ...historicalExecutions].forEach((execution) => {
      const key = executionEvidenceKey(execution, accountId);
      if (!key) {
        unkeyed.push(execution);
        return;
      }
      const existing = keyed.get(key);
      if (!existing) {
        keyed.set(key, execution);
        return;
      }
      if (economicSignature(existing) !== economicSignature(execution)) {
        const error = new Error(`Live and Flex evidence conflict for broker execution ${key}.`);
        error.code = 'EXECUTION_EVIDENCE_CONFLICT';
        throw error;
      }
      const existingIsFlex = /ibkr_flex/i.test(String(existing.source || ''));
      const incomingIsFlex = /ibkr_flex/i.test(String(execution.source || ''));
      const live = existingIsFlex && !incomingIsFlex ? execution : existing;
      const flex = incomingIsFlex ? execution : (existingIsFlex ? existing : null);
      keyed.set(key, flex ? {
        ...flex,
        ...live,
        source: live.source || 'ibkr_live_execution',
        commission: flex.commission,
        commissionCurrency: flex.commissionCurrency || 'USD',
        tax: flex.tax,
        feeEvidenceSource: 'ibkr_flex_import',
        feeEvidenceFingerprint: flex.rawFingerprint || null,
      } : live);
    });
    return [...keyed.values(), ...unkeyed];
  }

  async function readEvidence(accountId) {
    let historical = null;
    if (typeof readHistoricalExecutions === 'function') {
      try {
        historical = await readHistoricalExecutions(accountId);
      } catch (_error) {
        historical = null;
      }
    }
    let liveAccounts = null;
    if (typeof getManagedAccounts === 'function') {
      try {
        const accounts = await getManagedAccounts();
        if (Array.isArray(accounts)) liveAccounts = normalizeAccountIds(accounts);
      } catch (_error) {
        liveAccounts = null;
      }
    }
    const liveConnected = Array.isArray(liveAccounts) && liveAccounts.includes(accountId);
    const historicalExecutions = historical?.complete === true
      && historical?.status === 'ready'
      && Array.isArray(historical.trades)
      ? historical.trades
      : [];
    if (!liveConnected) {
      if (historical?.complete === true && historical?.status === 'ready') {
        const fetchedAt = historical.fetchedAt || new Date().toISOString();
        const snapshotId = historical.snapshotId || `flex-${crypto.createHash('sha256').update(JSON.stringify({
          accountId,
          through: historical.toDate || null,
          executions: historicalExecutions.map((execution) => executionEvidenceKey(execution, accountId)),
        })).digest('hex').slice(0, 32)}`;
        const payload = {
          ok: true,
          complete: true,
          coverageComplete: true,
          account: accountId,
          status: 'historical_import',
          source: 'ibkr_flex_import',
          snapshotId,
          fetchedAt,
        };
        return {
          ...payload,
          positions: [],
          executions: historicalExecutions,
          positionsPayload: payload,
          executionsPayload: payload,
          evidenceMode: 'history_only',
          authoritativePositions: false,
          authoritativeThrough: historical.toDate || null,
          liveConnected: false,
        };
      }
      return {
        ok: false,
        account: accountId,
        status: liveAccounts == null ? 'live_account_discovery_unavailable' : 'account_not_live',
        source: 'ibkr_gateway',
        message: liveAccounts == null
          ? 'Gateway managed-account coverage is unavailable.'
          : 'This tracked account is not live in Gateway and verified Flex history is unavailable.',
        positions: [],
        executions: [],
        evidenceMode: 'unavailable',
        authoritativePositions: false,
        liveConnected: false,
      };
    }
    const evidence = await sidecarRequest(`/portfolio/prediction-market-evidence?account=${encodeURIComponent(accountId)}`, { timeoutMs: 15000 });
    return {
      ...evidence,
      executions: mergeAccountExecutions(
        accountId,
        historicalExecutions,
        Array.isArray(evidence.executions) ? evidence.executions : [],
      ),
      positionsPayload: evidence.positionsPayload || evidence,
      executionsPayload: evidence.executionsPayload || evidence,
      evidenceMode: 'live_plus_history',
      authoritativePositions: true,
      authoritativeThrough: historical?.complete === true ? historical.toDate || null : null,
      liveConnected: true,
    };
  }

  async function resolveSettlements({
    accountId,
    records = [],
    evidenceMode = null,
    authoritativeThrough = null,
  }) {
    const lifecycleRecords = records.filter((record) => (
      record?.itemType === 'lifecycle'
      && (ACTIVE_STATUSES.has(record.status) || DISPLAY_STATUSES.has(record.status))
    ) || (
      record?.itemType === 'lifecycle'
      && record.status === 'review'
      && SCHEDULE_REPAIR_REASONS.has(record.reviewReason)
      && Boolean(forecastExThresholdIdentity(record) || exactKalshiMarketTicker(record))
    ));
    if (!lifecycleRecords.length) return;
    const settlementCache = {};
    const scheduleCache = {};
    for (const record of lifecycleRecords) {
      if (evidenceMode === 'history_only') {
        const authorityDate = datePart(record.resolutionAt || record.expiration || record.resolvedDate);
        // Flex history is execution authority only through its declared date.
        // Do not use a newer external outcome to finalize a lifecycle whose
        // broker execution window is not yet covered.
        if (!authoritativeThrough || !authorityDate || authorityDate > authoritativeThrough) continue;
      }
      let working = record;
      let scheduleChanged = false;
      const needsSchedule = typeof loadContractSchedule === 'function'
        && (ACTIVE_STATUSES.has(record.status)
          || record.status === 'review'
          || !record.contractScheduleEvidence
          || !record.lastTradeAt
          || !record.resolutionAt
          || (!record.payoutAt && DISPLAY_STATUSES.has(record.status)));
      if (needsSchedule) {
        try {
          const scheduleKey = exactKalshiMarketTicker(record)
            || forecastExThresholdIdentity(record)?.eventContract
            || `${record.eventTicker || record.contractKey || record.conId}`;
          if (!scheduleCache[scheduleKey]) scheduleCache[scheduleKey] = await loadContractSchedule(record);
          const schedule = scheduleCache[scheduleKey];
          if (schedule) {
            const applied = applyContractSchedule(record, schedule);
            working = applied.record;
            scheduleChanged = applied.changed;
          }
        } catch (error) {
          logger.warn?.(`[Prediction P&L] exact schedule unavailable for ${record.recordKey}: ${error.message}`);
        }
      }

      const provider = settlementProviders[working.market];
      const exactKalshiProvider = settlementProviders.exactKalshi;
      let outcome = null;
      const historicalSnapshot = working.verification === 'ibkr_historical_position_snapshot'
        || Boolean(working.historicalImportId && working.positionSnapshotEvidence);
      if (ACTIVE_STATUSES.has(working.status)
        && (working.feesComplete !== false || historicalSnapshot)
        && (typeof exactKalshiProvider === 'function' || typeof provider === 'function')) {
        try {
          const cacheKey = [
            working.market,
            working.expiration || working.resolvedDate || 'recent',
            working.contractKey || working.eventTicker || working.strike || 'contract',
            working.strike ?? '',
            working.contractSide || '',
            working.contractRule || '',
          ].join(':');
          if (!settlementCache[cacheKey]) {
            const exact = typeof exactKalshiProvider === 'function'
              ? await exactKalshiProvider(working)
              : null;
            settlementCache[cacheKey] = exact?.matched === true
              ? exact
              : (typeof provider === 'function' ? await provider(working) : { matched: false });
          }
          outcome = settlementCache[cacheKey];
        } catch (error) {
          logger.warn?.(`[Prediction P&L] settlement resolution paused for ${working.recordKey}: ${error.message}`);
        }
      }

      if (outcome?.matched === true) {
        const next = finalizeLifecycle(working, outcome);
        const revision = createRevisionRecord({
          accountId,
          target: next,
          before: record,
          after: next,
          revisionType: 'verified_settlement',
          actor: outcome.evidence?.source || 'verified_settlement',
        });
        try {
          await store.transactSave([
            { item: next, expectedVersion: record.version },
            { item: revision, createOnly: true },
          ]);
        } catch (error) {
          logger.warn?.(`[Prediction P&L] settlement persistence paused for ${record.recordKey}: ${error.message}`);
        }
        continue;
      }

      if (scheduleChanged) {
        const revision = createRevisionRecord({
          accountId,
          target: working,
          before: record,
          after: working,
          revisionType: working.status === 'review' ? 'contract_schedule_conflict' : 'official_contract_schedule',
          actor: working.contractScheduleEvidence?.source || 'official_contract_schedule',
        });
        try {
          await store.transactSave([
            { item: working, expectedVersion: record.version },
            { item: revision, createOnly: true },
          ]);
        } catch (error) {
          logger.warn?.(`[Prediction P&L] schedule persistence paused for ${record.recordKey}: ${error.message}`);
        }
        continue;
      }

      if (DISPLAY_STATUSES.has(working.status)
        && working.resolutionType === 'expiry'
        && working.settlementEvidence
        && working.settlementEvidence.underlyingSettlementValue == null
        && typeof getResolverSettlements === 'function') {
        try {
          const observations = await getResolverSettlements({ records: [working] });
          const resolver = verifiedResolverSettlement(working, Array.isArray(observations) ? observations : []);
          if (!resolver) continue;
          const next = JSON.parse(JSON.stringify(working));
          next.settlementSymbol = next.settlementSymbol || resolver.symbol;
          next.settlementEvidence = {
            ...next.settlementEvidence,
            underlyingSettlementValue: resolver.value,
            underlyingSettlementSource: resolver.source,
            underlyingSettlementObservedAt: resolver.observedAt,
            underlyingSettlementStatus: resolver.status,
            underlyingSettlementSymbol: resolver.symbol,
            underlyingSettlementSourceUrl: resolver.sourceUrl,
            underlyingSettlementSourceHash: resolver.sourceHash,
          };
          next.version = Number(next.version || 0) + 1;
          next.updatedAt = new Date().toISOString();
          const revision = createRevisionRecord({
            accountId,
            target: next,
            before: working,
            after: next,
            revisionType: 'official_resolver_enrichment',
            actor: resolver.source,
          });
          await store.transactSave([
            { item: next, expectedVersion: working.version },
            { item: revision, createOnly: true },
          ]);
        } catch (error) {
          logger.warn?.(`[Prediction P&L] resolver enrichment paused for ${working.recordKey}: ${error.message}`);
        }
      }
    }
  }

  const reconciliationIntervalMs = Number(process.env.PREDICTION_MARKET_PERFORMANCE_POLL_MS || 60000);
  const reconciler = createReconciler({
    store,
    readEvidence,
    resolveSettlements,
    enrichCaptureResult: async (context) => {
      try {
        return await researchService.enrichCaptureResult(context);
      } catch (error) {
        logger.warn?.(`[FES Research] entry-context matching unavailable; core P&L capture continues: ${error.message}`);
        return context.result;
      }
    },
    intervalMs: reconciliationIntervalMs,
    onBeforeAccountWrite: ({ accountId }) => invalidatePerformanceProjection(accountId),
    onAfterAccountWrite: async ({ accountId }) => {
      try {
        await loadPerformanceProjection(accountId, { force: true });
      } catch (error) {
        // A failed warm-up must never revive an older projection. The next
        // request reads the durable ledger directly and fails closed if that
        // authority remains unavailable.
        invalidatePerformanceProjection(accountId);
        logger.warn?.(`[Prediction P&L] ledger projection warm-up failed for ${accountId}: ${error.message}`);
      }
    },
    logger,
  });

  router.post('/settlement-marks', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'official-settlement-history-only');
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : null;
    if (!positions || positions.length === 0 || positions.length > 100) {
      return res.status(400).json({
        status: 'invalid_request',
        rows: [],
        error: 'positions must contain between 1 and 100 exact ForecastEx contracts.',
      });
    }
    try {
      const rows = await resolveForecastExOfficialSettlementMarks(positions, {
        loadOfficialForecastExPrices,
        loadContractSchedule,
        getResolverSettlements,
      });
      const verifiedCount = rows.filter((row) => row.status === 'verified_settlement').length;
      const resolverDeterminedCount = rows.filter((row) => row.status === 'resolver_determined').length;
      const awaitingCount = rows.filter((row) => row.status === 'awaiting_settlement').length;
      const unavailableCount = rows.length - verifiedCount - resolverDeterminedCount - awaitingCount;
      return res.json({
        schemaVersion: 1,
        status: verifiedCount + resolverDeterminedCount === rows.length
          ? 'available'
          : (verifiedCount > 0 || resolverDeterminedCount > 0 || awaitingCount > 0 ? 'partial' : 'unavailable'),
        source: 'forecastex_and_exact_resolver_evidence',
        asOf: new Date().toISOString(),
        rows,
        coverage: {
          requestedCount: rows.length,
          verifiedSettlementCount: verifiedCount,
          resolverDeterminedCount,
          awaitingSettlementCount: awaitingCount,
          unavailableCount,
        },
        historicalOnly: true,
        executable: false,
      });
    } catch (error) {
      logger.warn?.(`[Prediction P&L] official settlement mark read failed: ${error.message}`);
      return res.status(503).json({
        schemaVersion: 1,
        status: 'unavailable',
        source: 'forecastex_official_prices',
        rows: [],
        historicalOnly: true,
        executable: false,
      });
    }
  });

  router.get('/research/sp500', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const accountId = String(req.query.account || '').trim();
      await assertManagedAccount(accountId);
      const window = String(req.query.window || 'all').toLowerCase();
      if (!['30d', '90d', 'all'].includes(window)) {
        return res.status(400).json({ error: 'window must be 30d, 90d, or all.', code: 'RESEARCH_WINDOW_INVALID' });
      }
      return res.json(await researchService.getResearch({ accountId, window }));
    } catch (error) {
      logger.warn?.(`[FES Research] read failed: ${error.message}`);
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      return res.status(503).json({
        schemaVersion: 1,
        researchVersion: 'spx-fes-poker-ledger-v1',
        generatedAt: new Date().toISOString(),
        status: 'unavailable',
        error: { code: error.code || 'SPX_FES_RESEARCH_UNAVAILABLE', message: 'ForecastEx FES research is unavailable.' },
      });
    }
  });

  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requestStartedAt = Date.now();
    try {
      const market = requestedPerformanceMarket(req.query.market);
      const requestedSort = String(req.query.sort || 'date').toLowerCase();
      const sortAliases = {
        resolves: 'resolutionAt',
        resolutionat: 'resolutionAt',
        settlementdate: 'settlementDate',
        settlementvalue: 'settlementValue',
      };
      const sortCandidate = sortAliases[requestedSort] || requestedSort;
      const sort = ['date', 'status', 'contract', 'resolutionAt', 'settlementDate', 'settlementValue', 'risk', 'risked', 'value', 'paid', 'pnl', 'roi'].includes(sortCandidate) ? sortCandidate : 'date';
      const direction = req.query.direction === 'asc' ? 'asc' : 'desc';
      const accountId = String(req.query.account || '').trim();
      const scope = String(req.query.scope || (accountId ? 'account' : 'all')).toLowerCase();
      if (!['all', 'account'].includes(scope)) {
        return res.status(400).json({ error: 'scope must be all or account.', code: 'PERFORMANCE_SCOPE_INVALID' });
      }
      const venue = String(req.query.venue || 'all').trim().toLowerCase();
      if (!['all', 'kalshi', 'forecastex'].includes(venue)) {
        return res.status(400).json({ error: 'venue must be all, kalshi, or forecastex.', code: 'PERFORMANCE_VENUE_INVALID' });
      }
      const accountCatalog = await resolveAccountCatalog({ includeHistory: true });
      let accountIds;
      if (scope === 'account') {
        await assertManagedAccount(accountId, accountCatalog);
        accountIds = [accountId];
      } else {
        accountIds = accountCatalog.trackedAccountIds;
      }
      const authorizationCompletedAt = Date.now();
      const accountResults = await Promise.all(accountIds.map(async (id) => {
        const projection = await loadPerformanceProjection(id);
        const history = accountCatalog.historyByAccount.get(id) || await accountHistoryStatus(id);
        const performance = selectPerformanceProjection(projection, market, sort, direction);
        const liveConnected = accountCatalog.liveAccountIds.includes(id);
        const currentDataComplete = hasCurrentLiveCapture(performance.tracker, liveConnected);
        const consolidationEligible = scope === 'account' || history.complete === true;
        const decorate = (row) => ({
          ...row,
          accountId: id,
          venue: rowVenue(row),
          liveConnected,
          currentDataComplete,
          historyComplete: history.complete,
          historyThroughDate: history.toDate || null,
          consolidationEligible,
          coverageMessage: history.message,
        });
        const settledRows = (performance.rows || [])
          .filter((row) => liveConnected || rowFallsWithinHistory(row, history))
          .map(decorate);
        const activeRows = currentDataComplete
          ? (performance.activeRows || []).map(decorate)
          : [];
        return {
          accountId: id,
          history,
          liveConnected,
          currentDataComplete,
          projectionSource: projection.source,
          projectionObservedAt: projection.observedAt,
          performance: {
            ...performance,
            rows: settledRows,
            activeRows,
            // Review rows can describe stale live position state. A history-only
            // account has no authoritative current position snapshot, so never
            // publish those rows as if they were current diagnostics.
            review: currentDataComplete
              ? (performance.review || []).map((item) => ({ ...item, accountId: id }))
              : [],
          },
        };
      }));
      const ledgerReadCompletedAt = Date.now();
      const venueMatches = (row) => venue === 'all' || row.venue === venue;
      const result = {
        rows: accountResults.flatMap((item) => item.performance.rows).filter(venueMatches),
        activeRows: accountResults.flatMap((item) => item.performance.activeRows).filter(venueMatches),
        review: accountResults.flatMap((item) => item.performance.review),
        scope,
        selectedAccount: scope === 'account' ? accountId : null,
        selectedVenue: venue,
        accounts: accountResults.map((item) => ({
          accountId: item.accountId,
          complete: item.history.complete,
          status: item.history.status,
          message: item.history.message,
          liveConnected: item.liveConnected,
          currentDataComplete: item.currentDataComplete,
          historyThroughDate: item.history.toDate || null,
        })),
        availableAccounts: accountCatalog.availableAccounts.map((account) => {
          const accountResult = accountResults.find((item) => item.accountId === account.accountId);
          return {
            ...account,
            captureStatus: accountResult?.performance.tracker?.health || null,
            currentDataComplete: accountResult ? accountResult.currentDataComplete === true : null,
          };
        }),
        accountCoverage: accountCatalog.accountCoverage,
        tracker: {
          ...(scope === 'account' ? (accountResults[0]?.performance.tracker || {}) : {}),
          status: scope === 'account'
            ? (!accountResults[0]?.liveConnected && accountResults[0]?.history.complete
              ? 'history_only'
              : (accountResults[0]?.currentDataComplete
                ? (accountResults[0]?.performance.tracker?.status || 'empty')
                : 'capture_paused'))
            : accountResults.length
              ? (!accountCatalog.accountCoverage.complete
                ? 'partial_account_coverage'
                : (!accountResults.every((item) => item.history.complete)
                  ? 'incomplete'
                  : (accountResults.every((item) => item.currentDataComplete)
                    ? 'ready'
                    : 'capture_paused')))
              : 'empty',
          scope,
          currentDataComplete: accountResults.length > 0
            && accountResults.every((item) => item.currentDataComplete),
          openCount: accountResults.reduce(
            (sum, item) => sum + item.performance.activeRows.filter((row) => row.displayState === 'OPEN').length,
            0,
          ),
          awaitingSettlementCount: accountResults.reduce(
            (sum, item) => sum + item.performance.activeRows.filter((row) => row.displayState === 'AWAITING_RESULT').length,
            0,
          ),
          trackingCount: accountResults.reduce(
            (sum, item) => sum + item.performance.activeRows.length,
            0,
          ),
          quarantinedEvidenceCount: accountResults.reduce(
            (sum, item) => sum + Number(item.performance.tracker?.quarantinedEvidenceCount || 0), 0,
          ),
          incompleteAccountCount: accountResults.filter((item) => !item.history.complete).length,
          historyMessage: accountResults.find((item) => !item.history.complete)?.history.message || null,
          accountStatuses: accountResults.map((item) => item.history),
          updatedAt: accountResults.map((item) => item.performance.tracker?.updatedAt).filter(Boolean).sort().at(-1) || null,
        },
      };
      const activeReadRows = result.activeRows || [];
      const unmarkedActiveRows = activeReadRows.map((row) => applyContractMark(row, null));
      // Settled rows already carry the durable resolver evidence written by
      // the reconciler. A read should only fetch ephemeral marks/references
      // for contracts that are still active; historical tabs must be instant.
      const resolverReadRows = activeReadRows.filter((row) => {
        const productCode = forecastExThresholdIdentity(row)?.productCode;
        return ['METLG', 'FES'].includes(productCode) && Boolean(row.settlementSymbol);
      });
      const [resolverSettlements, markedActiveRows] = await Promise.all([
        typeof getResolverSettlements === 'function' && resolverReadRows.length
          ? boundedOptionalRead(
            async () => {
              const observations = await getResolverSettlements({
                records: resolverReadRows,
                maxWaitMs: Math.max(1, optionalReadTimeoutMs - 100),
              });
              return Array.isArray(observations) ? observations : [];
            },
            {
              timeoutMs: optionalReadTimeoutMs,
              fallback: [],
              onTimeout: () => warnOptionalReadOnce(
                'resolver_timeout',
                `[Prediction P&L] read-time resolver enrichment exceeded ${optionalReadTimeoutMs}ms; returning the ledger with settlement fields pending.`,
              ),
              onError: (error) => warnOptionalReadOnce(
                'resolver_error',
                `[Prediction P&L] read-time resolver enrichment unavailable; returning the ledger with settlement fields pending: ${error.message}`,
              ),
            },
          )
          : Promise.resolve([]),
        activeReadRows.length ? boundedOptionalRead(
          () => markRowsForPerformanceRead(activeReadRows, markProviders),
          {
            timeoutMs: optionalReadTimeoutMs,
            fallback: unmarkedActiveRows,
            onTimeout: () => warnOptionalReadOnce(
              'mark_timeout',
              `[Prediction P&L] read-time contract marks exceeded ${optionalReadTimeoutMs}ms; returning active rows without a mark.`,
            ),
            onError: (error) => warnOptionalReadOnce(
              'mark_error',
              `[Prediction P&L] read-time contract marks unavailable; returning active rows without a mark: ${error.message}`,
            ),
          },
        ) : Promise.resolve([]),
      ]);
      const enrichmentCompletedAt = Date.now();
      const activeRows = applyPreliminaryResolverReferences(
        applyResolverSettlementDetails(
          markedActiveRows,
          resolverSettlements,
        ),
        resolverSettlements,
      );
      const settledRows = applyResolverSettlementDetails(result.rows || [], resolverSettlements);
      const rows = sortPerformanceRows([...activeRows, ...settledRows], sort, direction);
      const summaryRows = scope === 'all'
        ? rows.filter((row) => row.consolidationEligible !== false)
        : rows;
      const openRows = summaryRows.filter((row) => row.displayState === 'OPEN');
      const awaitingRows = summaryRows.filter((row) => row.displayState === 'AWAITING_RESULT');
      const realizedRows = summaryRows.filter((row) => ['CLOSED', 'SETTLED'].includes(row.displayState));
      const openSummary = summarizeTrackedRows(openRows);
      const awaitingSummary = summarizeTrackedRows(awaitingRows);
      const settledSummary = summarizeTrackedRows(realizedRows);
      const combinedSummary = summarizeTrackedRows(summaryRows);
      const historicalCoverageComplete = scope === 'account'
        ? accountResults[0]?.history.complete === true
        : result.tracker.incompleteAccountCount === 0;
      const currentCoverageComplete = scope === 'account'
        ? accountResults[0]?.currentDataComplete === true
        : accountCatalog.accountCoverage.complete
          && accountResults.every((item) => item.currentDataComplete);
      const consolidatedCoverageComplete = historicalCoverageComplete && currentCoverageComplete;
      const hasIncludedAccounts = scope === 'account'
        ? accountResults[0]?.history.complete === true || accountResults[0]?.liveConnected === true
        : result.accounts.some((account) => account.complete);
      const enforceCoverageState = (candidate) => {
        const next = {
          ...candidate,
          complete: candidate.complete && consolidatedCoverageComplete,
        };
        if (!hasIncludedAccounts) {
          ['risked', 'currentValue', 'paid', 'pnl', 'roi', 'openPnl', 'awaitingPnl', 'realizedPnl']
            .forEach((field) => { next[field] = null; });
        } else if (!currentCoverageComplete) {
          ['risked', 'currentValue', 'paid', 'pnl', 'roi', 'openPnl', 'awaitingPnl']
            .forEach((field) => { next[field] = null; });
          next.openCount = null;
          next.awaitingCount = null;
        }
        return next;
      };
      const summary = enforceCoverageState({
        ...combinedSummary,
        paid: combinedSummary.currentValue,
        openCount: openSummary.count,
        openPnl: openSummary.count ? openSummary.pnl : 0,
        awaitingCount: awaitingSummary.count,
        awaitingPnl: awaitingSummary.count ? awaitingSummary.pnl : 0,
        realizedCount: settledSummary.count,
        realizedPnl: settledSummary.count ? settledSummary.pnl : 0,
      });
      const summaries = performanceSummaryKeys().reduce((output, key) => {
        const scoped = key === 'all' ? summaryRows : summaryRows.filter((row) => row.market === key);
        const scopedOpen = scoped.filter((row) => row.displayState === 'OPEN');
        const scopedAwaiting = scoped.filter((row) => row.displayState === 'AWAITING_RESULT');
        const scopedSettled = scoped.filter((row) => ['CLOSED', 'SETTLED'].includes(row.displayState));
        const scopedOpenSummary = summarizeTrackedRows(scopedOpen);
        const scopedAwaitingSummary = summarizeTrackedRows(scopedAwaiting);
        const scopedSettledSummary = summarizeTrackedRows(scopedSettled);
        const combined = summarizeTrackedRows(scoped);
        output[key] = enforceCoverageState({
          ...combined,
          paid: combined.currentValue,
          openCount: scopedOpen.length,
          openPnl: scopedOpen.length ? scopedOpenSummary.pnl : 0,
          awaitingCount: scopedAwaiting.length,
          awaitingPnl: scopedAwaiting.length ? scopedAwaitingSummary.pnl : 0,
          realizedCount: scopedSettled.length,
          realizedPnl: scopedSettled.length ? scopedSettledSummary.pnl : 0,
        });
        return output;
      }, {});
      res.set('Server-Timing', [
        `authorization;dur=${authorizationCompletedAt - requestStartedAt}`,
        `ledger;dur=${ledgerReadCompletedAt - authorizationCompletedAt}`,
        `enrichment;dur=${enrichmentCompletedAt - ledgerReadCompletedAt}`,
      ].join(', '));
      const projectionSources = new Set(accountResults.map((item) => item.projectionSource));
      res.set('X-Data-Cache', projectionSources.size === 1 && projectionSources.has('projection')
        ? 'authoritative-ledger-projection'
        : 'dynamodb');
      const oldestProjectionAt = Math.min(...accountResults
        .map((item) => Number(item.projectionObservedAt))
        .filter(Number.isFinite));
      if (Number.isFinite(oldestProjectionAt)) {
        res.set('X-Data-Age', String(Math.max(0, Math.floor((Date.now() - oldestProjectionAt) / 1000))));
      }
      res.json({
        ...result,
        rows,
        activeRows,
        summary,
        summaries,
        consolidation: {
          complete: consolidatedCoverageComplete,
          historyComplete: historicalCoverageComplete,
          currentComplete: currentCoverageComplete,
          includedAccounts: result.accounts.filter((account) => account.complete || scope === 'account').map((account) => account.accountId),
          excludedAccounts: scope === 'all' ? result.accounts.filter((account) => !account.complete).map((account) => ({
            accountId: account.accountId,
            reason: account.message,
          })) : [],
        },
      });
    } catch (error) {
      logger.warn?.(`[Prediction P&L] read failed: ${error.message}`);
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      const empty = emptyPerformanceSummary();
      res.status(503).json({
        error: error.message || 'Prediction-market performance is unavailable.',
        code: error.code || 'PREDICTION_MARKET_PERFORMANCE_UNAVAILABLE',
        rows: [],
        activeRows: [],
        review: [],
        summary: empty,
        summaries: Object.fromEntries(performanceSummaryKeys().map((key) => [key, empty])),
        tracker: {
          status: 'unavailable',
          message: error.message || 'Prediction-market performance is unavailable.',
        },
      });
    }
  });

  router.get('/:id/executions', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const accountId = String(req.query.account || '').trim();
      await assertManagedAccount(accountId);
      const details = await loadPerformanceExecutions({
        store,
        accountId,
        id: String(req.params.id || '').trim(),
      });
      if (!details) return res.status(404).json({ error: 'Performance record not found.', code: 'PERFORMANCE_RECORD_NOT_FOUND' });
      return res.json(details);
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
      logger.warn?.(`[Prediction P&L] execution detail read failed: ${error.message}`);
      return res.status(503).json({ error: 'Performance execution details are unavailable.', code: 'PERFORMANCE_EXECUTIONS_UNAVAILABLE' });
    }
  });

  router.patch('/:id', (_req, res) => {
    res.status(405).json({
      error: 'Manual P&L confirmation is disabled. Only authoritative broker evidence can publish performance.',
      code: 'PERFORMANCE_MANUAL_REVIEW_DISABLED',
    });
  });


  return { router, reconciler, researchService, store, resolveSettlements };
}

module.exports = {
  buildSettlementProviders,
  createPredictionMarketPerformanceRoutes,
};
