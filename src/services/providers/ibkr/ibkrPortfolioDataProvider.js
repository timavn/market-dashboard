const {
  sidecarRequest,
  getSidecarProviderStatus,
  getSidecarPortfolioStatus,
} = require('../ibkrSidecarClient');
const {
  normalizeIbkrPosition,
  isPredictionMarketContract,
} = require('../normalize/normalizePosition');
const { normalizeAccountSummary } = require('../normalize/normalizeAccountSummary');
const { getLongShortPositionSnapshot } = require('../../../utils/portfolioPositionSides.cjs');
const {
  calculatePortfolioBalance,
  calculatePortfolioExposure,
  projectPortfolioBalance,
} = require('../../../utils/ibkrPortfolioBalance.cjs');
const {
  setIbkrConnected,
  setIbkrLastPortfolioAt,
} = require('../providerStatus');

const ENABLED = process.env.IBKR_PORTFOLIO_ENABLED !== 'false';
const ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || '';
const LIVE_EVIDENCE_MAX_AGE_MS = Number(process.env.IBKR_LIVE_EVIDENCE_MAX_AGE_MS || 5 * 60_000);
const LIVE_LAST_MAX_AGE_MS = Number(process.env.IBKR_LIVE_LAST_MAX_AGE_MS || 60_000);
const PORTFOLIO_BALANCE_MAX_AGE_MS = Number(
  process.env.IBKR_PORTFOLIO_BALANCE_MAX_AGE_MS || 45_000,
);
const EVENT_CONTRACT_POSITION_SCOPE = 'stocks_and_event_contracts';
const LEGACY_KALSHI_POSITION_SCOPE = 'stocks_and_kalshi';
const EVENT_ACCOUNTING_VERIFICATION =
  'ibkr_event_contract_commodity_segment_reconciled';
const LEGACY_KALSHI_ACCOUNTING_VERIFICATION =
  'ibkr_kalshi_commodity_segment_reconciled';
const SUPPORTED_EVENT_VENUES = new Set(['FORECASTX', 'KALSHI']);

// Only a producer-verified refused login establishes that the Gateway is
// down. Every other /accounts failure leaves the connection unverified.
const VERIFIED_ACCOUNTS_DISCONNECT_CODES = Object.freeze({
  gateway_not_authenticated: 'IBKR_GATEWAY_NOT_AUTHENTICATED',
});
const GATEWAY_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function isOpenPosition(row) {
  return Number(row?.position || 0) !== 0 || Number(row?.marketValue || 0) !== 0;
}

async function getAccounts({ requireLive = false } = {}) {
  const res = await sidecarRequest('/accounts');
  if (!res.ok) {
    if (requireLive) {
      const gatewayErrorCode = VERIFIED_ACCOUNTS_DISCONNECT_CODES[
        String(res.status || '').trim().toLowerCase()
      ];
      if (!gatewayErrorCode) {
        throw portfolioBalanceError(
          'The IBKR Gateway connection could not be verified for live account verification.',
          'IBKR_BALANCE_UNVERIFIED',
        );
      }
      throw Object.assign(portfolioBalanceError(
        'The IBKR Gateway connection is unavailable for live account verification.',
        'GATEWAY_UNAVAILABLE',
      ), { gatewayErrorCode });
    }
    return [];
  }
  setIbkrConnected(true);
  return res.accounts || [];
}

function isFreshEvidence(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= -5_000 && age <= LIVE_EVIDENCE_MAX_AGE_MS;
}

function isFreshLiveLast(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= -5_000 && age <= LIVE_LAST_MAX_AGE_MS;
}

function verifiedLiveResponse(response) {
  return Boolean(
    response?.ok === true
    && response?.connected === true
    && response?.status === 'live'
    && response?.source === 'ibkr_live_session'
    && isFreshEvidence(response?.observed_at)
    && isFreshEvidence(response?.socket_verified_at)
  );
}

function isFreshBalanceEvidence(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= -5_000 && age <= PORTFOLIO_BALANCE_MAX_AGE_MS;
}

function verifiedLiveBalanceResponse(response, accountId) {
  return Boolean(
    response?.ok === true
    && response?.connected === true
    && response?.status === 'live'
    && response?.source === 'ibkr_live_session'
    && response?.from_cache === false
    && response?.account === accountId
    && response?.summary?.account === accountId
    && response?.balanceEvidence
    && isFreshBalanceEvidence(response?.observed_at)
    && isFreshBalanceEvidence(response?.socket_verified_at)
    && isFreshBalanceEvidence(
      response?.balanceEvidence?.accountValuesObservedAt,
    )
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeLiveMarginHealth(rawSummary, accountId) {
  const netLiquidation = finiteNumber(rawSummary?.NetLiquidation);
  const equityWithLoanValue = finiteNumber(rawSummary?.EquityWithLoanValue);
  const initialMarginRequirement = finiteNumber(rawSummary?.InitMarginReq);
  const maintenanceMarginRequirement = finiteNumber(rawSummary?.MaintMarginReq);
  const availableFunds = finiteNumber(rawSummary?.AvailableFunds);
  const excessLiquidity = finiteNumber(rawSummary?.ExcessLiquidity);
  const buyingPower = finiteNumber(rawSummary?.BuyingPower);
  if (
    netLiquidation === null
    || netLiquidation <= 0
    || equityWithLoanValue === null
    || initialMarginRequirement === null
    || initialMarginRequirement < 0
    || maintenanceMarginRequirement === null
    || maintenanceMarginRequirement < 0
    || availableFunds === null
    || excessLiquidity === null
    || buyingPower === null
  ) {
    throw portfolioBalanceError(
      'IBKR did not return complete broker-native margin health evidence.',
      'BALANCE_MARGIN_INVALID',
    );
  }

  const health = excessLiquidity < 0
    ? 'maintenance_deficit'
    : availableFunds < 0
      ? 'initial_deficit'
      : 'healthy';
  return {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    accountId,
    currency: String(rawSummary?.baseCurrency || '').toUpperCase(),
    health,
    actionable: false,
    netLiquidation,
    equityWithLoanValue,
    initialMarginRequirement,
    maintenanceMarginRequirement,
    availableFunds,
    excessLiquidity,
    buyingPower,
    initialDeficit: Math.max(0, -availableFunds),
    maintenanceDeficit: Math.max(0, -excessLiquidity),
    excessLiquidityPercent: (excessLiquidity / netLiquidation) * 100,
  };
}

function unavailableLiveMarginHealth(rawSummary, accountId) {
  return {
    available: false,
    status: 'unavailable',
    source: 'unavailable',
    accountId,
    currency: String(rawSummary?.baseCurrency || '').toUpperCase(),
    health: 'unavailable',
    actionable: false,
    errorCode: 'BALANCE_MARGIN_UNAVAILABLE',
    reason: 'broker_native_margin_evidence_unavailable',
  };
}

function normalizeSortedEventVenues(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const venues = value.map((venue) => String(venue || '').trim());
  if (
    venues.some((venue) => !SUPPORTED_EVENT_VENUES.has(venue))
    || new Set(venues).size !== venues.length
  ) return null;
  const sorted = [...venues].sort();
  return venues.every((venue, index) => venue === sorted[index])
    ? venues
    : null;
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validReferenceSessionDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function sanitizeMarkFailure(failure, accountId) {
  const conid = finiteNumber(failure?.conId ?? failure?.conid);
  const errorCode = String(failure?.errorCode || '').trim();
  const stage = String(failure?.stage || '').trim();
  if (
    failure?.account !== accountId
    || !/^[A-Z0-9_]+$/.test(errorCode)
    || !/^[a-z0-9_]+$/.test(stage)
  ) {
    return null;
  }
  return {
    account: accountId,
    conId: conid != null && conid > 0 ? conid : null,
    symbol: typeof failure?.symbol === 'string' ? failure.symbol : null,
    errorCode,
    stage,
    retryable: failure?.retryable === true,
    attemptCount:
      finiteNumber(failure?.attemptCount) != null
        ? finiteNumber(failure.attemptCount)
        : null,
    exhausted: failure?.exhausted === true,
    terminal: failure?.terminal === true,
    terminalReason:
      ['retry_budget_exhausted', 'non_retryable']
        .includes(failure?.terminalReason)
        ? failure.terminalReason
        : null,
    observedAt:
      Number.isFinite(Date.parse(String(failure?.observedAt || '')))
        ? failure.observedAt
        : null,
  };
}

function normalizeBrokerMark(row, accountId, requestedConIds) {
  const conid = finiteNumber(row?.conId ?? row?.conid);
  const price = finiteNumber(row?.price);
  const priceState = row?.priceState;
  if (
    row?.account !== accountId
    || conid == null
    || conid <= 0
    || !requestedConIds.has(conid)
    || price == null
    || price <= 0
    || !['live', 'historical_close'].includes(priceState)
  ) {
    return null;
  }

  const priceObservedAt = String(row?.priceObservedAt || '');
  if (!Number.isFinite(Date.parse(priceObservedAt))) return null;
  if (
    priceState === 'live'
    && (
      row?.priceSource !== 'ibkr_live_last'
      || Number(row?.marketDataType) !== 1
      || !isFreshLiveLast(priceObservedAt)
    )
  ) {
    return null;
  }
  if (
    priceState === 'historical_close'
    && (
      row?.priceSource !== 'ibkr_historical_daily_close'
      || !validReferenceSessionDate(row?.priceSessionDate)
    )
  ) {
    return null;
  }

  const referenceClose = finiteNumber(row?.referenceClose);
  const referenceCloseSessionDate = row?.referenceCloseSessionDate || null;
  const referenceCloseObservedAt = row?.referenceCloseObservedAt || null;
  const hasReferenceClose = referenceClose != null && referenceClose > 0;
  if (
    hasReferenceClose
    && (
      row?.referenceCloseSource !== 'ibkr_historical_daily_close'
      || !validReferenceSessionDate(referenceCloseSessionDate)
      || !Number.isFinite(Date.parse(String(referenceCloseObservedAt || '')))
    )
  ) {
    return null;
  }
  if (priceState === 'historical_close' && !hasReferenceClose) return null;
  if (
    priceState === 'historical_close'
    && (
      Math.abs(price - referenceClose) > 1e-9
      || row.priceSessionDate !== referenceCloseSessionDate
    )
  ) {
    return null;
  }

  const previousClose = finiteNumber(row?.previousClose);
  const previousCloseSessionDate = row?.previousCloseSessionDate || null;
  const hasPreviousClose =
    previousClose != null
    && previousClose > 0
    && validReferenceSessionDate(previousCloseSessionDate)
    && (
      !referenceCloseSessionDate
      || previousCloseSessionDate < referenceCloseSessionDate
    );
  return {
    mark: price,
    price,
    priceState,
    source: row.priceSource,
    priceSource: row.priceSource,
    timestamp: priceObservedAt,
    priceObservedAt,
    priceSessionDate: priceState === 'historical_close' ? row.priceSessionDate : null,
    marketDataType: priceState === 'live' ? 1 : null,
    referenceClose: hasReferenceClose ? referenceClose : null,
    referenceCloseSource: hasReferenceClose ? row.referenceCloseSource : null,
    referenceCloseSessionDate: hasReferenceClose ? referenceCloseSessionDate : null,
    referenceCloseObservedAt: hasReferenceClose ? referenceCloseObservedAt : null,
    referenceCloseCacheState:
      ['broker_historical_snapshot', 'broker_historical_snapshot_reused']
        .includes(row?.referenceCacheState)
        ? row.referenceCacheState
        : null,
    previousClose: hasPreviousClose ? previousClose : null,
    previousCloseSessionDate: hasPreviousClose ? previousCloseSessionDate : null,
  };
}

function unavailableReferenceMarks(accountId, errorCode) {
  const observedAt = new Date().toISOString();
  return {
    status: 'unavailable',
    source: 'unavailable',
    observedAt,
    socketVerifiedAt: null,
    requestedCount: 0,
    markCount: 0,
    referenceCloseCount: 0,
    liveMarkCount: 0,
    historicalMarkCount: 0,
    warming: false,
    warmingCount: 0,
    failureCount: 1,
    failures: [{
      account: accountId,
      conId: null,
      symbol: null,
      errorCode,
      stage: 'reference_marks_request',
      retryable: true,
      observedAt,
    }],
    progress: {
      state: 'blocked',
      requestedCount: 0,
      completedCount: 0,
      pendingCount: 0,
      exhaustedFailureCount: 1,
      progressPercent: 0,
      startedAt: null,
      updatedAt: observedAt,
      completedAt: null,
      socketVerifiedAt: null,
      positionsObservedAt: null,
      lastErrorCode: errorCode,
      lastErrorAt: observedAt,
    },
    pending: [],
    pendingConIds: new Set(),
    marksByConId: new Map(),
  };
}

function sanitizeReferenceProgress(progress, counts) {
  const state = String(progress?.state || '');
  const validState = ['idle', 'warming', 'complete', 'degraded', 'waiting', 'blocked']
    .includes(state)
    ? state
    : counts.pendingCount > 0
      ? 'warming'
      : counts.failureCount > 0
        ? 'degraded'
        : 'complete';
  const timestamp = (value) => (
    Number.isFinite(Date.parse(String(value || ''))) ? value : null
  );
  const lastErrorCode = /^[A-Z0-9_]+$/.test(String(progress?.lastErrorCode || ''))
    ? progress.lastErrorCode
    : null;
  return {
    state: validState,
    requestedCount: counts.requestedCount,
    completedCount: counts.completedCount,
    pendingCount: counts.pendingCount,
    exhaustedFailureCount: counts.failureCount,
    progressPercent:
      counts.requestedCount > 0
        ? Number(((counts.completedCount / counts.requestedCount) * 100).toFixed(1))
        : 100,
    startedAt: timestamp(progress?.startedAt),
    updatedAt: timestamp(progress?.updatedAt),
    completedAt: timestamp(progress?.completedAt),
    socketVerifiedAt: timestamp(progress?.socketVerifiedAt),
    positionsObservedAt: timestamp(progress?.positionsObservedAt),
    lastErrorCode,
    lastErrorAt: timestamp(progress?.lastErrorAt),
  };
}

async function getReferenceMarks(accountId, positions) {
  const acct = String(accountId || '').trim();
  const scopedPositions = positions
    .filter((position) => position.account === acct && isOpenPosition(position));
  const requestedConIds = new Set(
    scopedPositions
      .map((position) => finiteNumber(position.conId ?? position.conid))
      .filter((conid) => conid != null && conid > 0),
  );
  if (!acct) {
    return unavailableReferenceMarks(null, 'REFERENCE_MARKS_ACCOUNT_REQUIRED');
  }
  if (scopedPositions.length === 0) {
    return {
      status: 'empty',
      source: 'ibkr_portfolio_reference_marks',
      observedAt: new Date().toISOString(),
      socketVerifiedAt: null,
      requestedCount: 0,
      markCount: 0,
      referenceCloseCount: 0,
      liveMarkCount: 0,
      historicalMarkCount: 0,
      warming: false,
      warmingCount: 0,
      failureCount: 0,
      failures: [],
      pending: [],
      pendingConIds: new Set(),
      progress: sanitizeReferenceProgress(null, {
        requestedCount: 0,
        completedCount: 0,
        pendingCount: 0,
        failureCount: 0,
      }),
      marksByConId: new Map(),
    };
  }
  const identityFailures = scopedPositions
    .filter(
      (position) => {
        const conid = finiteNumber(position.conId ?? position.conid);
        return conid == null || conid <= 0;
      },
    )
    .map((position) => ({
      account: acct,
      conId: null,
      symbol: typeof position.symbol === 'string' ? position.symbol : null,
      errorCode: 'REFERENCE_MARK_CONID_MISSING',
      stage: 'identity',
      retryable: false,
      observedAt: new Date().toISOString(),
    }));
  if (requestedConIds.size === 0) {
    return {
      status: 'partial',
      source: 'unavailable',
      observedAt: new Date().toISOString(),
      socketVerifiedAt: null,
      requestedCount: scopedPositions.length,
      markCount: 0,
      referenceCloseCount: 0,
      liveMarkCount: 0,
      historicalMarkCount: 0,
      warming: false,
      warmingCount: 0,
      failureCount: identityFailures.length,
      failures: identityFailures,
      pending: [],
      pendingConIds: new Set(),
      progress: sanitizeReferenceProgress(null, {
        requestedCount: scopedPositions.length,
        completedCount: 0,
        pendingCount: 0,
        failureCount: identityFailures.length,
      }),
      marksByConId: new Map(),
    };
  }

  let response;
  try {
    response = await sidecarRequest(
      `/portfolio/reference-marks?account=${encodeURIComponent(acct)}&include_live=true`,
      { timeoutMs: 5_000 },
    );
  } catch (err) {
    return unavailableReferenceMarks(
      acct,
      err?.sidecarCode || (
        err?.reason === 'sidecar_timeout'
          ? 'REFERENCE_MARKS_REQUEST_TIMEOUT'
          : 'REFERENCE_MARKS_REQUEST_FAILED'
      ),
    );
  }

  if (
    response?.ok !== true
    || response?.connected !== true
    || response?.source !== 'ibkr_portfolio_reference_marks'
    || response?.account !== acct
    || !isFreshEvidence(response?.observed_at)
    || !isFreshEvidence(response?.socket_verified_at)
    || !Array.isArray(response?.marks)
    || !Array.isArray(response?.pending)
    || !Array.isArray(response?.failures)
  ) {
    return unavailableReferenceMarks(acct, 'REFERENCE_MARKS_RESPONSE_UNVERIFIED');
  }

  const failures = [
    ...identityFailures,
    ...response.failures
      .map((failure) => sanitizeMarkFailure(failure, acct))
      .filter((failure) => (
        failure
        && (failure.conId == null || requestedConIds.has(failure.conId))
      )),
  ];
  const pending = [];
  const pendingConIds = new Set();
  for (const row of response.pending) {
    const conid = finiteNumber(row?.conId ?? row?.conid);
    if (
      row?.account === acct
      && conid != null
      && conid > 0
      && !requestedConIds.has(conid)
    ) {
      continue;
    }
    if (
      row?.account !== acct
      || conid == null
      || conid <= 0
      || !requestedConIds.has(conid)
      || row?.state !== 'warming'
      || pendingConIds.has(conid)
    ) {
      failures.push({
        account: acct,
        conId: conid != null && conid > 0 ? conid : null,
        symbol: typeof row?.symbol === 'string' ? row.symbol : null,
        errorCode: 'REFERENCE_MARK_PENDING_INVALID',
        stage: 'reference_marks_validation',
        retryable: true,
        attemptCount: null,
        exhausted: false,
        observedAt: response.observed_at,
      });
      continue;
    }
    pendingConIds.add(conid);
    pending.push({
      account: acct,
      conId: conid,
      symbol: typeof row?.symbol === 'string' ? row.symbol : null,
      state: 'warming',
    });
  }
  if (response?.warming !== true && pendingConIds.size > 0) {
    for (const row of pending) {
      failures.push({
        account: acct,
        conId: row.conId,
        symbol: row.symbol,
        errorCode: 'REFERENCE_MARK_WARMING_STATE_INVALID',
        stage: 'reference_marks_validation',
        retryable: true,
        attemptCount: null,
        exhausted: false,
        observedAt: response.observed_at,
      });
    }
    pendingConIds.clear();
  }
  const marksByConId = new Map();
  const duplicateConIds = new Set();
  for (const row of response.marks) {
    const conid = finiteNumber(row?.conId ?? row?.conid);
    if (
      row?.account === acct
      && conid != null
      && conid > 0
      && !requestedConIds.has(conid)
    ) {
      continue;
    }
    const normalized = normalizeBrokerMark(row, acct, requestedConIds);
    if (!normalized || marksByConId.has(conid) || duplicateConIds.has(conid)) {
      const duplicate = marksByConId.has(conid) || duplicateConIds.has(conid);
      failures.push({
        account: acct,
        conId: conid != null && conid > 0 ? conid : null,
        symbol: typeof row?.symbol === 'string' ? row.symbol : null,
        errorCode: duplicate
          ? 'REFERENCE_MARK_DUPLICATE'
          : 'REFERENCE_MARK_INVALID',
        stage: 'reference_marks_validation',
        retryable: true,
        observedAt: response.observed_at,
      });
      marksByConId.delete(conid);
      if (duplicate && conid != null) duplicateConIds.add(conid);
      continue;
    }
    normalized.referencePending = pendingConIds.has(conid);
    marksByConId.set(conid, normalized);
  }
  const failedConIds = new Set(
    failures
      .map((failure) => failure.conId)
      .filter((conid) => conid != null),
  );
  for (const conid of failedConIds) {
    pendingConIds.delete(conid);
    const mark = marksByConId.get(conid);
    if (mark) mark.referencePending = false;
  }
  for (const conid of requestedConIds) {
    if (!marksByConId.has(conid) && !failedConIds.has(conid)) {
      if (pendingConIds.has(conid) && response?.warming === true) {
        continue;
      }
      failures.push({
        account: acct,
        conId: conid,
        symbol: (
          scopedPositions.find(
            (position) => finiteNumber(position.conId ?? position.conid) === conid,
          )?.symbol
        ) || null,
        errorCode: 'REFERENCE_MARK_MISSING',
        stage: 'reference_marks_validation',
        retryable: true,
        observedAt: response.observed_at,
      });
    }
  }

  const marks = [...marksByConId.values()];
  const liveMarkCount = marks.filter((mark) => mark.priceState === 'live').length;
  const historicalMarkCount =
    marks.filter((mark) => mark.priceState === 'historical_close').length;
  const referenceCloseCount =
    marks.filter((mark) => mark.referenceClose != null).length;
  const sanitizedPending = pending.filter((row) => pendingConIds.has(row.conId));
  const warming = response?.warming === true && pendingConIds.size > 0;
  const requestedCount = requestedConIds.size + identityFailures.length;
  const completedCount = Math.max(
    0,
    requestedCount - pendingConIds.size - failures.length,
  );
  const progress = sanitizeReferenceProgress(response?.progress, {
    requestedCount,
    completedCount,
    pendingCount: pendingConIds.size,
    failureCount: failures.length,
  });
  return {
    status: failures.length > 0
      ? 'partial'
      : warming
        ? 'warming'
      : historicalMarkCount > 0
        ? 'reference'
        : 'live',
    source: response.source,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    requestedCount,
    markCount: marksByConId.size,
    referenceCloseCount,
    liveMarkCount,
    historicalMarkCount,
    warming,
    warmingCount: pendingConIds.size,
    failureCount: failures.length,
    failures,
    pending: sanitizedPending,
    pendingConIds,
    progress,
    marksByConId,
  };
}

function portfolioBalanceError(message, code, status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeLivePortfolioBalance(response, accountId) {
  if (!verifiedLiveBalanceResponse(response, accountId)) {
    throw portfolioBalanceError(
      'The sidecar response was not a fresh, account-matched live balance snapshot.',
      'BALANCE_PROVENANCE_UNVERIFIED',
    );
  }

  const rawSummary = response.summary;
  const rawEvidence = response.balanceEvidence;
  const rawPositionScope = rawEvidence.positionScope || {};
  const positionScope = rawPositionScope.mode === EVENT_CONTRACT_POSITION_SCOPE
    && rawPositionScope.allSupportedForBalance === true
    && rawPositionScope.allBaseCurrency === true
    ? EVENT_CONTRACT_POSITION_SCOPE
    : rawPositionScope.mode === LEGACY_KALSHI_POSITION_SCOPE
      && rawPositionScope.allSupportedForBalance === true
      && rawPositionScope.allBaseCurrency === true
      ? LEGACY_KALSHI_POSITION_SCOPE
      : rawPositionScope.mode === 'stocks_only'
        && rawPositionScope.allSupportedForBalance === true
        && rawPositionScope.allStock === true
        && rawPositionScope.allBaseCurrency === true
        ? 'stocks_only'
        : rawPositionScope.mode === undefined
          && rawPositionScope.allStock === true
          && rawPositionScope.allBaseCurrency === true
          ? 'stocks_only'
          : null;
  const shortPositions = Array.isArray(rawEvidence.shortPositionEvidence)
    ? rawEvidence.shortPositionEvidence.map((row) => ({
      conId: row?.conId ?? row?.conid ?? null,
      symbol: typeof row?.symbol === 'string' ? row.symbol : null,
      quantity: finiteNumber(row?.quantity),
      currency: typeof row?.currency === 'string' ? row.currency : null,
      priorClose: finiteNumber(row?.priorClose),
      priorCloseSource: row?.priorCloseSource || null,
      priorCloseSessionDate: row?.priorCloseSessionDate || null,
      priorCloseObservedAt: row?.priorCloseObservedAt || null,
    }))
    : null;
  const positions = Array.isArray(rawEvidence.positionEvidence)
    ? rawEvidence.positionEvidence.map((row) => ({
      conId: row?.conId ?? row?.conid ?? null,
      symbol: typeof row?.symbol === 'string' ? row.symbol : null,
      quantity: finiteNumber(row?.quantity),
      currency: typeof row?.currency === 'string' ? row.currency : null,
    }))
    : null;
  const eventPositions = Array.isArray(rawEvidence.eventPositionEvidence)
    ? rawEvidence.eventPositionEvidence.map((row) => ({
      conId: row?.conId ?? row?.conid ?? null,
      symbol: typeof row?.symbol === 'string' ? row.symbol : null,
      localSymbol: typeof row?.localSymbol === 'string' ? row.localSymbol : null,
      tradingClass: typeof row?.tradingClass === 'string' ? row.tradingClass : null,
      exchange: typeof row?.exchange === 'string' ? row.exchange : null,
      secType: typeof row?.secType === 'string' ? row.secType : null,
      currency: typeof row?.currency === 'string' ? row.currency : null,
      multiplier: finiteNumber(row?.multiplier),
      quantity: finiteNumber(row?.quantity),
    }))
    : null;
  const rawEventAccounting = rawEvidence.eventAccounting || {};
  const eventAccountValues = rawEventAccounting.accountValues || {};
  const rawScopeEventPositionCount = finiteNumber(
    rawPositionScope.eventPositionCount,
  );
  const rawAccountingEventPositionCount = finiteNumber(
    rawEventAccounting.positionCount,
  );
  const eventPositionCount = rawScopeEventPositionCount
    ?? rawAccountingEventPositionCount;
  const eventContractQuantity = Array.isArray(eventPositions)
    ? eventPositions.reduce((total, row) => total + (row.quantity || 0), 0)
    : null;
  const rawScopeEventVenues = normalizeSortedEventVenues(
    rawPositionScope.eventVenues,
  );
  const legacyAccountingVenue = rawEventAccounting.venue === 'KALSHI'
    ? ['KALSHI']
    : null;
  const rawAccountingEventVenues = normalizeSortedEventVenues(
    rawEventAccounting.venues,
  ) || (
    positionScope === LEGACY_KALSHI_POSITION_SCOPE
      ? legacyAccountingVenue
      : null
  );
  const eventVenues = positionScope === EVENT_CONTRACT_POSITION_SCOPE
    && sameStringArray(rawScopeEventVenues, rawAccountingEventVenues)
    ? rawScopeEventVenues
    : positionScope === LEGACY_KALSHI_POSITION_SCOPE
      && sameStringArray(
        rawScopeEventVenues || ['KALSHI'],
        rawAccountingEventVenues,
      )
      ? rawAccountingEventVenues
      : null;
  const eventPositionVenues = Array.isArray(eventPositions)
    ? [...new Set(eventPositions.map((row) => row.exchange))].sort()
    : null;
  const eventPositionConIds = Array.isArray(eventPositions)
    ? eventPositions.map((row) => Number(row.conId))
    : [];
  const eventPositionRowsVerified = Array.isArray(eventPositions)
    && new Set(eventPositionConIds).size === eventPositionConIds.length
    && eventPositions.every((row) => (
      Number.isSafeInteger(Number(row.conId))
      && Number(row.conId) > 0
      && SUPPORTED_EVENT_VENUES.has(row.exchange)
      && (
        row.secType === 'OPT'
        || (row.exchange === 'FORECASTX' && row.secType === 'FOP')
      )
      && row.currency === 'USD'
      && row.multiplier === 1
      && Number.isFinite(row.quantity)
      && row.quantity !== 0
    ));
  const eventPositionCountsReconciled = positionScope === EVENT_CONTRACT_POSITION_SCOPE
    ? Number.isInteger(rawScopeEventPositionCount)
      && Number.isInteger(rawAccountingEventPositionCount)
      && rawScopeEventPositionCount === rawAccountingEventPositionCount
    : (
      rawScopeEventPositionCount === null
      || rawAccountingEventPositionCount === null
      || rawScopeEventPositionCount === rawAccountingEventPositionCount
    );
  const eventPositionEvidenceVerified = Boolean(
    eventVenues
    && eventPositionRowsVerified
    && sameStringArray(eventPositionVenues, eventVenues)
    && Number.isInteger(eventPositionCount)
    && eventPositionCount > 0
    && eventPositions.length === eventPositionCount
    && eventPositionCountsReconciled
  );
  const accountingVerification = rawEventAccounting.verification || null;
  const accountingVerificationAccepted =
    accountingVerification === EVENT_ACCOUNTING_VERIFICATION
    || (
      positionScope === LEGACY_KALSHI_POSITION_SCOPE
      && accountingVerification === LEGACY_KALSHI_ACCOUNTING_VERIFICATION
    );

  const exposure = calculatePortfolioExposure({
    accountId,
    accountReady: rawSummary.AccountReady === true
      || String(rawSummary.AccountReady || '').toLowerCase() === 'true',
    baseCurrency: String(rawSummary.baseCurrency || '').toUpperCase(),
    netLiquidation: finiteNumber(rawSummary.NetLiquidation),
    grossPositionValue: finiteNumber(
      rawSummary['GrossPositionValue-S'] ?? rawSummary.GrossPositionValue,
    ),
    stockMarketValue: finiteNumber(rawSummary.StockMarketValue),
  });
  if (exposure.available !== true) {
    throw portfolioBalanceError(
      'IBKR did not return complete live aggregate exposure evidence.',
      'BALANCE_EXPOSURE_INVALID',
    );
  }
  const capacityExplicitlyUnavailable = rawEvidence.capacityAvailable === false;
  let margin;
  try {
    margin = normalizeLiveMarginHealth(rawSummary, accountId);
  } catch (error) {
    if (
      !capacityExplicitlyUnavailable
      || error?.code !== 'BALANCE_MARGIN_INVALID'
    ) {
      throw error;
    }
    margin = unavailableLiveMarginHealth(rawSummary, accountId);
  }

  const calculation = calculatePortfolioBalance({
    accountId,
    accountReady: rawSummary.AccountReady === true
      || String(rawSummary.AccountReady || '').toLowerCase() === 'true',
    baseCurrency: String(rawSummary.baseCurrency || '').toUpperCase(),
    currency: String(rawSummary.baseCurrency || '').toUpperCase(),
    positionScope,
    netLiquidation: finiteNumber(rawSummary.NetLiquidation),
    totalCashValueSecurities: finiteNumber(rawSummary['TotalCashValue-S']),
    totalCashValueCommodities: finiteNumber(rawSummary['TotalCashValue-C']),
    commodityMaintenanceMargin: finiteNumber(rawSummary['MaintMarginReq-C']),
    eventMarketValue: finiteNumber(
      rawEventAccounting.marketValue ?? rawSummary['GrossPositionValue-C'],
    ),
    eventNetLiquidation: finiteNumber(
      eventAccountValues['NetLiquidation-C'] ?? rawSummary['NetLiquidation-C'],
    ),
    eventInitialMargin: finiteNumber(
      rawEventAccounting.initialMargin ?? rawSummary['InitMarginReq-C'],
    ),
    eventMaintenanceMargin: finiteNumber(
      rawEventAccounting.maintenanceMargin ?? rawSummary['MaintMarginReq-C'],
    ),
    eventAvailableFunds: finiteNumber(
      rawEventAccounting.availableFunds ?? rawSummary['AvailableFunds-C'],
    ),
    eventEquityWithLoanValue: finiteNumber(
      rawEventAccounting.equityWithLoanValue
        ?? rawSummary['EquityWithLoanValue-C'],
    ),
    eventContractQuantity,
    eventPositionCount,
    eventVenues,
    eventAccountingVerified:
      eventPositionEvidenceVerified && accountingVerificationAccepted,
    eventAccountingVerification: accountingVerification,
    grossPositionValue: finiteNumber(
      rawSummary['GrossPositionValue-S'] ?? rawSummary.GrossPositionValue,
    ),
    stockMarketValue: finiteNumber(rawSummary.StockMarketValue),
    accruedCashSecurities: finiteNumber(rawSummary['AccruedCash-S']),
    settledCashByDateSecurities: rawSummary['SettledCashByDate-S'] || null,
    settledCashByDateCommodities: rawSummary['SettledCashByDate-C'] || null,
    settlementLaddersVerified:
      rawEvidence.settlementLaddersVerified === true
      && rawEvidence.settlementVerification
        === 'segment_ladders_double_snapshot',
    activitySnapshotVerified: rawEvidence.activitySnapshotVerified === true,
    settlementState: rawEvidence.settlementState,
    settlementDate: rawEvidence.settlementDate,
    settlementHorizonDate: rawEvidence.settlementHorizonDate,
    openPositionCount: finiteNumber(rawEvidence.openPositionCount),
    shortPositionCount: finiteNumber(rawEvidence.shortPositionCount),
    openOrderCount: finiteNumber(rawEvidence.openOrderCount),
    sameDayExecutionCount: finiteNumber(rawEvidence.sameDayExecutionCount),
    shortPositions,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    accountValuesObservedAt: rawEvidence.accountValuesObservedAt,
  });
  const freshnessTimestamps = [
    response.observed_at,
    response.socket_verified_at,
    rawEvidence.accountValuesObservedAt,
  ].map((value) => Date.parse(value));
  const oldestEvidenceAt = Math.min(...freshnessTimestamps);
  const common = {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    accountId,
    currency: exposure.currency,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    accountValuesObservedAt: rawEvidence.accountValuesObservedAt,
    fromCache: false,
    exposure,
    margin,
    positions: positions || [],
    longPositions: (positions || []).filter((row) => Number(row.quantity) > 0),
    eventPositions: eventPositions || [],
    eventContracts: calculation.eventContracts || null,
    snapshotId: String(response.snapshotId || '').trim() || null,
    freshness: {
      status: 'fresh',
      maxAgeMs: PORTFOLIO_BALANCE_MAX_AGE_MS,
      oldestEvidenceAgeMs: Math.max(0, Date.now() - oldestEvidenceAt),
      accountReads: finiteNumber(response.freshness?.accountReads),
      positionReads: finiteNumber(response.freshness?.positionReads),
      activityReads: finiteNumber(response.freshness?.activityReads),
    },
    timing: response.timing || null,
  };

  if (calculation.available === true && rawEvidence.capacityAvailable !== false) {
    return {
      ...calculation,
      ...common,
      exposure: {
        ...calculation.exposure,
        available: true,
        status: 'live',
        source: 'ibkr_live_session',
        currency: exposure.currency,
      },
      capacity: {
        available: true,
        status: 'live',
        settlement: calculation.settlement,
        activity: calculation.activity,
        cash: calculation.cash,
        buffer: calculation.buffer,
      },
    };
  }

  const sidecarCode = String(
    rawEvidence.capacityUnavailableCode || '',
  ).trim().toUpperCase();
  const calculationReasons = Array.isArray(calculation.reasons)
    ? calculation.reasons
    : [calculation.reason].filter(Boolean);
  const reason = sidecarCode
    ? sidecarCode.toLowerCase()
    : calculation.reason || 'balance_capacity_evidence_unavailable';
  const openOrderCount = finiteNumber(rawEvidence.openOrderCount);
  const sameDayExecutionCount = finiteNumber(rawEvidence.sameDayExecutionCount);
  const activity = Number.isInteger(openOrderCount)
    && openOrderCount >= 0
    && Number.isInteger(sameDayExecutionCount)
    && sameDayExecutionCount >= 0
    ? {
      openOrderCount,
      sameDayExecutionCount,
      previewAvailable: false,
      previewUnavailableReason: 'capacity_unavailable',
    }
    : null;

  return {
    ...common,
    positionScope: positionScope || 'unsupported_or_unverified',
    settlement: null,
    activity,
    cash: null,
    buffer: null,
    shortPositions: [],
    capacity: {
      available: false,
      status: 'unavailable',
      errorCode: sidecarCode || 'BALANCE_EVIDENCE_INVALID',
      reason,
      reasons: sidecarCode ? [reason] : calculationReasons,
    },
  };
}

async function getPositions(accountId) {
  let res = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
    try {
      res = await sidecarRequest('/portfolio/live-positions', { timeoutMs: 45000 });
    } catch (err) {
      lastError = err;
    }
  }
  if (!res) {
    const message = lastError?.message || 'Fresh IBKR positions are unavailable.';
    setIbkrConnected(false, message);
    return {
      positions: [],
      accountId: accountId || ACCOUNT_ID || null,
      error: message,
      fetchedAt: new Date().toISOString(),
      liveSessionVerified: false,
    };
  }
  if (!verifiedLiveResponse(res) || !Array.isArray(res.accounts) || !Array.isArray(res.positions)) {
    const error = res?.message || 'The sidecar did not return a fresh socket-verified live position snapshot.';
    setIbkrConnected(false, error);
    return {
      positions: [],
      accountId: accountId || ACCOUNT_ID || null,
      error,
      fetchedAt: res?.observed_at || new Date().toISOString(),
      liveSessionVerified: false,
    };
  }

  const requested = accountId || ACCOUNT_ID || null;
  const counts = new Map(res.accounts.map((account) => [account, 0]));
  for (const position of res.positions) {
    if (counts.has(position.account) && isOpenPosition(position)) {
      counts.set(position.account, counts.get(position.account) + 1);
    }
  }
  const acct = requested || [...counts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  if (!acct || !res.accounts.includes(acct)) {
    const error = acct
      ? `Account ${acct} is not managed by the verified live IB session.`
      : 'The verified live IB session returned no managed account.';
    return {
      positions: [],
      accountId: acct,
      error,
      fetchedAt: res.observed_at,
      liveSessionVerified: false,
    };
  }

  const fetchedAt = res.observed_at;
  setIbkrConnected(true);
  setIbkrLastPortfolioAt(fetchedAt);
  return {
    positions: res.positions
      .filter((position) => position.account === acct)
      .filter(isOpenPosition)
      .map((position) => ({ ...position, fetched_at: fetchedAt })),
    accountId: acct,
    fetchedAt,
    socketVerifiedAt: res.socket_verified_at,
    liveSessionVerified: true,
    fromCache: false,
  };
}

async function resolveAccountId(accountId, options) {
  const requested = accountId || ACCOUNT_ID || null;
  const accounts = await getAccounts(options);
  if (requested) return accounts.includes(requested) ? requested : null;
  return accounts[0] || null;
}

async function requestLivePortfolioBalance(accountId) {
  const response = await sidecarRequest(
    `/portfolio/live-balance?account=${encodeURIComponent(accountId)}`,
    { timeoutMs: 13_000 },
  );
  return normalizeLivePortfolioBalance(response, accountId);
}

async function getPortfolioBalance(accountId) {
  try {
    const requestedAccount = String(accountId || '').trim();
    const acct = requestedAccount || await resolveAccountId(null, { requireLive: true });
    if (!acct) {
      throw portfolioBalanceError(
        'No exact live IBKR account is available for portfolio balance.',
        'BALANCE_ACCOUNT_REQUIRED',
        400,
      );
    }

    return await requestLivePortfolioBalance(acct);
  } catch (error) {
    // Account discovery and the balance read share this delivery boundary.
    // Preserve typed broker/authentication/integrity failures; only transport
    // failures identified by the shared client receive a delivery code here.
    if (!error?.sidecarCode && !error?.code) {
      if (error?.reason === 'sidecar_timeout') error.code = 'BALANCE_REQUEST_TIMEOUT';
      else if (error?.reason === 'sidecar_offline') error.code = 'BALANCE_SERVICE_UNAVAILABLE';
    }
    // A dedicated-client failure carries the producer's own Gateway
    // classification; only that code can establish a disconnect downstream.
    const gatewayErrorCode = error?.sidecarPayload?.gatewayErrorCode;
    if (!error?.gatewayErrorCode && GATEWAY_ERROR_CODE_PATTERN.test(String(gatewayErrorCode || ''))) {
      error.gatewayErrorCode = gatewayErrorCode;
    }
    throw error;
  }
}

function verifiedShortPreviewEvidence(response, accountId, conId, action) {
  return Boolean(
    response?.ok === true
    && response?.available === true
    && response?.connected === true
    && response?.status === 'live'
    && response?.source === 'ibkr_live_session'
    && response?.account === accountId
    && Number(response?.conId) === Number(conId)
    && response?.action === action
    && response?.from_cache === false
    && Number(response?.marketDataType) === 1
    && isFreshBalanceEvidence(response?.observed_at)
    && isFreshBalanceEvidence(response?.socket_verified_at)
    && isFreshLiveLast(response?.quoteObservedAt)
  );
}

function verifiedBatchPreviewEvidence(response, accountId, legs = []) {
  if (
    response?.ok !== true
    || response?.available !== true
    || response?.connected !== true
    || response?.status !== 'live'
    || response?.source !== 'ibkr_live_session'
    || response?.account !== accountId
    || response?.from_cache !== false
    || !isFreshBalanceEvidence(response?.observed_at)
    || !isFreshBalanceEvidence(response?.socket_verified_at)
    || !Array.isArray(response?.legs)
  ) return false;
  const requestedIds = new Set(legs.map((leg) => String(leg?.id || '').trim()));
  if (requestedIds.size === 0 || response.legs.length !== requestedIds.size) return false;
  return response.legs.every((row) => {
    const id = String(row?.id || '').trim();
    const action = String(row?.action || '').trim().toLowerCase();
    return requestedIds.has(id)
      && row?.available === true
      && ['buy_long', 'sell_long', 'add_short', 'cover_short'].includes(action)
      && Number(row?.conId) > 0
      && Number(row?.marketDataType) === 1
      && finiteNumber(row?.bid) > 0
      && finiteNumber(row?.ask) > 0
      && finiteNumber(row?.currentPrice) > 0
      && isFreshLiveLast(row?.quoteObservedAt)
      && (action !== 'add_short'
        || (finiteNumber(row?.shortableShares) !== null
          && finiteNumber(row?.shortableShares) >= 0))
      && (action === 'buy_long' || action === 'sell_long'
        || (finiteNumber(row?.priorClose) !== null
          && finiteNumber(row?.priorClose) > 0
          && row?.priorCloseSource === 'ibkr_historical_daily_close'
          && isFreshBalanceEvidence(row?.priorCloseObservedAt)));
  });
}

async function getPortfolioBalancePreview(request = {}) {
  const accountId = String(request.accountId || request.account || '').trim();
  if (!accountId) {
    throw portfolioBalanceError(
      'An account is required for a portfolio-balance preview.',
      'BALANCE_ACCOUNT_REQUIRED',
      400,
    );
  }
  const baseline = await getPortfolioBalance(accountId);
  if (baseline.capacity?.available !== true) {
    throw portfolioBalanceError(
      'Exact portfolio capacity requires complete live position and settlement evidence.',
      'BALANCE_CAPACITY_UNAVAILABLE',
      422,
    );
  }
  if (baseline.activity?.openOrderCount > 0) {
    throw portfolioBalanceError(
      'Open orders must be resolved before previewing another trade.',
      'OPEN_ORDERS_PRESENT',
      409,
    );
  }

  if (Array.isArray(request.legs)) {
    const legs = request.legs.map((leg, index) => ({
      ...leg,
      id: String(leg?.id || `leg-${index + 1}`).trim(),
      action: String(leg?.action || '').trim().toLowerCase(),
    }));
    if (!legs.length || legs.some((leg) => !leg.id || !leg.action)) {
      throw portfolioBalanceError(
        'At least one valid scenario leg is required.',
        'BALANCE_PREVIEW_REQUEST_INVALID',
        400,
      );
    }
    const response = await sidecarRequest(
      '/portfolio/live-balance/preview-evidence',
      {
        method: 'POST',
        timeoutMs: 30_000,
        body: { account: accountId, legs },
      },
    );
    if (!verifiedBatchPreviewEvidence(response, accountId, legs)) {
      throw portfolioBalanceError(
        'The scenario planner did not return verified live quote evidence for every leg.',
        'BALANCE_PREVIEW_EVIDENCE_UNVERIFIED',
      );
    }
    const evidence = {
      legs: Object.fromEntries(response.legs.map((row) => [row.id, {
        ...row,
        available: true,
        marketDataType: Number(row.marketDataType),
      }])),
    };
    const projection = projectPortfolioBalance(
      baseline,
      { ...request, accountId, legs },
      evidence,
    );
    if (projection.available !== true) {
      throw portfolioBalanceError(
        `Portfolio-balance scenario is unavailable: ${projection.reason}`,
        String(projection.reason || 'BALANCE_PREVIEW_INVALID').toUpperCase(),
        422,
      );
    }
    return projection;
  }

  const action = String(request.action || '').trim().toLowerCase();
  let shortEvidence = null;
  if (action === 'add_short' || action === 'cover_short') {
    const conId = finiteNumber(request.conId);
    const quantity = finiteNumber(request.quantity);
    if (!Number.isSafeInteger(conId) || conId <= 0 || quantity == null || quantity <= 0) {
      throw portfolioBalanceError(
        'A verified existing short and positive share quantity are required.',
        'BALANCE_PREVIEW_REQUEST_INVALID',
        400,
      );
    }
    const response = await sidecarRequest(
      '/portfolio/live-balance/preview-evidence',
      {
        method: 'POST',
        timeoutMs: 15_000,
        body: {
          account: accountId,
          conId,
          action,
          quantity,
        },
      },
    );
    if (!verifiedShortPreviewEvidence(response, accountId, conId, action)) {
      throw portfolioBalanceError(
        'The short preview did not return verified live quote evidence.',
        'BALANCE_PREVIEW_EVIDENCE_UNVERIFIED',
      );
    }
    shortEvidence = {
      available: true,
      conId,
      positionQuantity: finiteNumber(response.positionQuantity),
      bid: finiteNumber(response.bid),
      ask: finiteNumber(response.ask),
      currentPrice: finiteNumber(response.currentPrice),
      marketDataType: Number(response.marketDataType),
      shortableShares: finiteNumber(response.shortableShares),
      quoteObservedAt: response.quoteObservedAt,
      source: response.source,
    };
  }

  const projection = projectPortfolioBalance(
    baseline,
    { ...request, action },
    shortEvidence,
  );
  if (projection.available !== true) {
    throw portfolioBalanceError(
      `Portfolio-balance preview is unavailable: ${projection.reason}`,
      String(projection.reason || 'BALANCE_PREVIEW_INVALID').toUpperCase(),
      422,
    );
  }
  return projection;
}

async function getAccountSummary(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(
    `/portfolio/live-account-summary?account=${encodeURIComponent(acct)}`,
  );
  if (!verifiedLiveResponse(res) || !res.summary || res.account !== acct) return null;
  return normalizeAccountSummary({
    ...res.summary,
    fetched_at: res.observed_at || res.fetched_at,
    source: res.source,
    socket_verified_at: res.socket_verified_at,
  });
}

async function getBalances(accountId) {
  const summary = await getAccountSummary(accountId);
  if (!summary) return null;
  return {
    totalCashValue: summary.totalCashValue,
    settledCash: summary.settledCash,
    netLiquidation: summary.netLiquidation,
    currency: summary.currency,
  };
}

async function getOpenOrders(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return [];
  const res = await sidecarRequest(`/portfolio/open-orders?account=${encodeURIComponent(acct)}`);
  return res.orders || [];
}

async function getPnL(accountId) {
  const acct = await resolveAccountId(accountId);
  if (!acct) return null;
  const res = await sidecarRequest(`/portfolio/pnl?account=${encodeURIComponent(acct)}`);
  const pnl = res.pnl || null;
  const hasValidPnl =
    pnl &&
    ['dailyPnL', 'unrealizedPnL', 'realizedPnL'].some((key) => Number.isFinite(Number(pnl[key])));

  if (verifiedLiveResponse(res) && res.account === acct && hasValidPnl) {
    const dailyPnLPercent = pnl.dailyPnLPercentSource === 'ibkr_live_account_summary'
      && Number.isFinite(Number(pnl.dailyPnLPercent))
      ? Number(pnl.dailyPnLPercent)
      : null;
    return {
      ...pnl,
      dailyPnLPercent,
      dailyPnLPercentSource: dailyPnLPercent == null ? null : pnl.dailyPnLPercentSource,
      fetchedAt: res.observed_at,
      socketVerifiedAt: res.socket_verified_at,
      source: res.source,
      fromCache: false,
    };
  }
  return null;
}

async function getAccountSummaryBestEffort(accountId) {
  try {
    return await getAccountSummary(accountId);
  } catch (err) {
    console.warn('[Portfolio] IBKR account summary failed:', err.message);
    return null;
  }
}

async function getPnLBestEffort(accountId) {
  try {
    return await getPnL(accountId);
  } catch (err) {
    console.warn('[Portfolio] IBKR PnL failed:', err.message);
    return null;
  }
}

function buildSnapshotSummary(holdings, accountSummary) {
  // Position marks (including completed-session reference closes) are not NAV.
  // Never infer a sizing/weight denominator from signed holdings.
  const totalValue = finiteNumber(accountSummary?.netLiquidation);
  const { longCount, shortCount } = getLongShortPositionSnapshot(holdings);
  const openHoldings = holdings
    .filter((holding) => Number(holding.quantity || 0) !== 0);
  const gainLossValues = openHoldings
    .map((holding) => finiteNumber(holding.gainLoss));
  const totalGainLoss =
    openHoldings.length === 0
      ? 0
      : gainLossValues.every((value) => value != null)
        ? gainLossValues.reduce((sum, value) => sum + value, 0)
        : null;

  return {
    totalValue,
    totalGainLoss,
    positionCount: holdings.length,
    longCount,
    shortCount,
  };
}

function buildDataQuality(raw, holdings, fetchedAt, referenceMarks) {
  const missingMarketValueHoldings = holdings
    .filter((h) => Number(h.quantity || 0) !== 0 && h.marketValue == null && !h.isPredictionMarket);
  const missingMarketValue = missingMarketValueHoldings
    .map((h) => h.symbol)
    .filter(Boolean);
  const warmingMarketValueHoldings = missingMarketValueHoldings
    .filter((holding) => holding.markPending === true);
  const unavailableMarketValueHoldings = missingMarketValueHoldings
    .filter((holding) => holding.markPending !== true);
  const unavailableMarketValue = unavailableMarketValueHoldings
    .map((holding) => holding.symbol)
    .filter(Boolean);
  const predictionMarketPositions = raw
    .filter((position) => isOpenPosition(position) && isPredictionMarketContract(position));
  const predictionMarketContracts = predictionMarketPositions
    .map((position) => position.symbol || position.localSymbol || position.description)
    .filter(Boolean);
  const zeroQuantityFiltered = Math.max(
    0,
    raw.length - predictionMarketPositions.length - holdings.length,
  );
  const liveMarkCount = holdings
    .filter((holding) => holding.priceState === 'live')
    .length;
  const historicalMarkCount = holdings
    .filter((holding) => holding.priceState === 'historical_close')
    .length;
  const markFailures = Array.isArray(referenceMarks?.failures)
    ? referenceMarks.failures
    : [];
  const warming = referenceMarks?.warming === true;
  const markState =
    warming
      ? 'warming'
      : liveMarkCount > 0 && historicalMarkCount > 0
      ? 'mixed'
      : historicalMarkCount > 0
        ? 'reference'
        : liveMarkCount > 0
          ? 'live'
          : 'unavailable';
  const warnings = [];
  if (warming) {
    const completed = Number(referenceMarks?.progress?.completedCount || 0);
    const requested = Number(referenceMarks?.progress?.requestedCount || 0);
    warnings.push(
      `IBKR reference marks warming: ${completed} of ${requested} completed closes ready; ${referenceMarks?.warmingCount || 0} pending`,
    );
  }
  if (unavailableMarketValue.length > 0) {
    warnings.push(
      `IBKR missing market values for ${unavailableMarketValue.slice(0, 8).join(', ')}${unavailableMarketValue.length > 8 ? ` +${unavailableMarketValue.length - 8} more` : ''}`,
    );
  }
  if (historicalMarkCount > 0) {
    const sessions = [
      ...new Set(
        holdings
          .filter((holding) => holding.priceState === 'historical_close')
          .map((holding) => holding.priceSessionDate)
          .filter(Boolean),
      ),
    ].sort();
    warnings.push(
      `IBKR prior-close reference values are in use for ${historicalMarkCount} position${historicalMarkCount === 1 ? '' : 's'}${sessions.length ? ` (latest session ${sessions[sessions.length - 1]})` : ''}`,
    );
  }
  if (markFailures.length > 0) {
    warnings.push(
      `IBKR reference-mark diagnostics reported ${markFailures.length} contract failure${markFailures.length === 1 ? '' : 's'}`,
    );
  }
  if (zeroQuantityFiltered > 0) {
    warnings.push(`Filtered ${zeroQuantityFiltered} closed/zero-quantity IBKR rows`);
  }

  const referenceSessionDates = [
    ...new Set(
      holdings
        .map((holding) => holding.referenceCloseSessionDate)
        .filter(Boolean),
    ),
  ].sort();
  return {
    fetchedAt,
    missingMarketValueCount: missingMarketValue.length,
    missingMarketValueSymbols: missingMarketValue,
    warmingMarketValueCount: warmingMarketValueHoldings.length,
    unavailableMarketValueCount: unavailableMarketValueHoldings.length,
    unavailableMarketValueSymbols: unavailableMarketValue,
    markState,
    markWarmState: referenceMarks?.progress?.state || null,
    markProgress: referenceMarks?.progress || null,
    liveMarkCount,
    historicalMarkCount,
    markFailureCount: markFailures.length,
    markFailures,
    oldestReferenceSessionDate: referenceSessionDates[0] || null,
    latestReferenceSessionDate:
      referenceSessionDates[referenceSessionDates.length - 1] || null,
    predictionMarketContractCount: predictionMarketPositions.length,
    predictionMarketContractSymbols: predictionMarketContracts,
    zeroQuantityFiltered,
    warningCount: warnings.length,
    warnings,
    status:
      unavailableMarketValue.length > 0 || markFailures.length > 0
        ? 'partial'
        : warming
          ? 'stale'
        : historicalMarkCount > 0
          ? 'stale'
          : 'ok',
  };
}

async function getPortfolioSnapshot(accountId) {
  const {
    positions: raw,
    accountId: acct,
    error,
    fetchedAt,
    socketVerifiedAt,
    liveSessionVerified,
  } = await getPositions(accountId);

  if (error) {
    return {
      holdings: [],
      accountSummary: null,
      pnl: null,
      accountId: acct,
      error,
      summary: buildSnapshotSummary([], null),
      fetchedAt,
      liveSessionVerified: false,
    };
  }

  // Event contracts have their own live portfolio endpoint and must not enter
  // the securities ledger, its counts, exposure analytics, or research calls.
  const portfolioPositions = raw.filter(
    (position) => !isPredictionMarketContract(position),
  );

  // Reference history uses an isolated read-only client and remains separate
  // from the independently polled portfolio-balance endpoint.
  const referenceMarksPromise = portfolioPositions.length > 0
    ? getReferenceMarks(acct, portfolioPositions).catch(
      () => unavailableReferenceMarks(acct, 'REFERENCE_MARKS_REQUEST_FAILED'),
    )
    : null;

  // Avoid overlapping account/PnL socket requests; IB Gateway can otherwise
  // time them out under the dashboard's polling load. Balance evidence is
  // intentionally not attached to this slower portfolio snapshot.
  const accountSummary = acct ? await getAccountSummaryBestEffort(acct) : null;
  const pnl = acct ? await getPnLBestEffort(acct) : null;

  if (!portfolioPositions.length) {
    return {
      holdings: [],
      accountSummary,
      pnl,
      accountId: acct,
      summary: buildSnapshotSummary([], accountSummary),
      fetchedAt,
      dataSource: 'ibkr_api',
      liveSessionVerified,
      socketVerifiedAt,
      referenceMarks: {
        status: 'empty',
        source: 'ibkr_portfolio_reference_marks',
        observedAt: fetchedAt,
        socketVerifiedAt: socketVerifiedAt || null,
        requestedCount: 0,
        markCount: 0,
        referenceCloseCount: 0,
        liveMarkCount: 0,
        historicalMarkCount: 0,
        warming: false,
        warmingCount: 0,
        failureCount: 0,
        failures: [],
        pending: [],
        progress: sanitizeReferenceProgress(null, {
          requestedCount: 0,
          completedCount: 0,
          pendingCount: 0,
          failureCount: 0,
        }),
      },
      fromCache: false,
    };
  }

  const referenceMarks = await referenceMarksPromise;
  const failuresByConId = new Map();
  let snapshotMarkFailure = null;
  for (const failure of referenceMarks.failures) {
    if (failure.conId != null) {
      failuresByConId.set(failure.conId, failure);
    } else if (!snapshotMarkFailure) {
      snapshotMarkFailure = failure;
    }
  }
  const holdings = portfolioPositions
    .map((position) => {
      const conid = finiteNumber(position.conId ?? position.conid);
      const mark = conid != null
        ? referenceMarks.marksByConId.get(conid) || null
        : null;
      const warming = conid != null
        ? referenceMarks.pendingConIds.has(conid)
        : false;
      const failure = (
        conid != null ? failuresByConId.get(conid) : null
      ) || snapshotMarkFailure;
      return {
        ...normalizeIbkrPosition(
          position,
          mark || failure || warming
            ? {
                ...(mark || {}),
                failure: failure || null,
                warming,
                warning:
                  warming && !failure ? 'reference_mark_warming' : undefined,
              }
            : null,
        ),
        positionSource: 'ibkr_live_session',
      };
    })
    .filter((h) => Number(h.quantity || 0) !== 0 || Number(h.marketValue || 0) !== 0);

  const {
    marksByConId: _marksByConId,
    pendingConIds: _pendingConIds,
    ...referenceMarksMetadata
  } = referenceMarks;
  return {
    holdings,
    accountSummary,
    pnl,
    accountId: acct,
    summary: buildSnapshotSummary(holdings, accountSummary),
    fetchedAt,
    dataQuality: buildDataQuality(raw, holdings, fetchedAt, referenceMarksMetadata),
    referenceMarks: referenceMarksMetadata,
    dataSource: 'ibkr_api',
    liveSessionVerified,
    socketVerifiedAt,
    fromCache: false,
  };
}

async function getProviderStatus() {
  const status = typeof getSidecarPortfolioStatus === 'function'
    ? await getSidecarPortfolioStatus('ibkr_portfolio')
    : await getSidecarProviderStatus('ibkr_portfolio');
  setIbkrConnected(Boolean(status.connected), status.message);
  if (status.portfolioObservedAt) {
    setIbkrLastPortfolioAt(status.portfolioObservedAt);
  }
  return status;
}

module.exports = {
  getAccounts,
  getPositions,
  getBalances,
  getAccountSummary,
  getPortfolioBalance,
  getPortfolioBalancePreview,
  getPortfolioSnapshot,
  getOpenOrders,
  getPnL,
  getProviderStatus,
  ENABLED,
};
