const { sidecarRequest, getSidecarProviderStatus } = require('../ibkrSidecarClient');
const { normalizeIbkrPosition } = require('../normalize/normalizePosition');
const { normalizeAccountSummary } = require('../normalize/normalizeAccountSummary');
const { getLongShortPositionSnapshot } = require('../../../utils/portfolioPositionSides.cjs');
const {
  setIbkrConnected,
  setIbkrLastPortfolioAt,
} = require('../providerStatus');

const ENABLED = process.env.IBKR_PORTFOLIO_ENABLED !== 'false';
const ACCOUNT_ID = process.env.IBKR_ACCOUNT_ID || '';
const LIVE_EVIDENCE_MAX_AGE_MS = Number(process.env.IBKR_LIVE_EVIDENCE_MAX_AGE_MS || 5 * 60_000);
const LIVE_LAST_MAX_AGE_MS = Number(process.env.IBKR_LIVE_LAST_MAX_AGE_MS || 60_000);

function isOpenPosition(row) {
  return Number(row?.position || 0) !== 0 || Number(row?.marketValue || 0) !== 0;
}

async function getAccounts() {
  const res = await sidecarRequest('/accounts');
  if (!res.ok) return [];
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

function verifiedFundingReferenceResponse(response) {
  return Boolean(
    response?.ok === true
    && response?.connected === true
    && response?.status === 'reference'
    && response?.source === 'ibkr_completed_session_reference'
    && response?.funding == null
    && isFreshEvidence(response?.observed_at)
    && isFreshEvidence(response?.socket_verified_at)
  );
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
      .filter(Boolean),
  ];
  const pending = [];
  const pendingConIds = new Set();
  for (const row of response.pending) {
    const conid = finiteNumber(row?.conId ?? row?.conid);
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
    const normalized = normalizeBrokerMark(row, acct, requestedConIds);
    const conid = finiteNumber(row?.conId ?? row?.conid);
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

function normalizeLiveFunding(response, accountId) {
  const rawSummary = response?.summary || {};
  const rawFunding = response?.funding || {};
  const baseCurrency = String(
    rawSummary.baseCurrency
    || rawSummary.currency
    || rawFunding.baseCurrency
    || '',
  ).toUpperCase();
  const shortEvidence = Array.isArray(rawFunding.shortPositionEvidence)
    ? rawFunding.shortPositionEvidence
    : null;
  const rawPositionScope = rawFunding.positionScope;
  const positionScope = typeof rawPositionScope === 'string'
    ? rawPositionScope
    : rawPositionScope?.allStock === true
      && rawPositionScope?.allBaseCurrency === true
      ? 'stocks_only'
      : null;

  return {
    accountId,
    accountReady: (rawSummary.AccountReady ?? rawFunding.accountReady) === true
      || String(rawSummary.AccountReady ?? rawFunding.accountReady ?? '').toLowerCase() === 'true',
    baseCurrency,
    currency: baseCurrency,
    netLiquidation: finiteNumber(rawSummary.NetLiquidation),
    totalCashValue: finiteNumber(rawSummary.TotalCashValue),
    totalCashValueSecurities: finiteNumber(rawSummary['TotalCashValue-S']),
    totalCashValueCommodities: finiteNumber(rawSummary['TotalCashValue-C']),
    commodityMaintenanceMargin: finiteNumber(rawSummary['MaintMarginReq-C']),
    grossPositionValue: finiteNumber(
      rawSummary['GrossPositionValue-S'] ?? rawSummary.GrossPositionValue,
    ),
    stockMarketValue: finiteNumber(rawSummary.StockMarketValue),
    accruedCashSecurities: finiteNumber(
      rawSummary['AccruedCash-S'] ?? rawSummary.AccruedCash,
    ),
    settledCashByDateSecurities: rawSummary['SettledCashByDate-S'] || null,
    settledCashByDateCommodities: rawSummary['SettledCashByDate-C'] || null,
    cashBalances: rawFunding.cashBalances || rawSummary.CashBalance || {},
    shortPositions: shortEvidence
      ? shortEvidence.map((row) => ({
        conId: row.conId ?? row.conid ?? null,
        symbol: row.symbol || null,
        quantity: finiteNumber(row.quantity),
        priorClose: finiteNumber(row.priorClose),
        priorCloseSource: row.priorCloseSource || null,
        priorCloseSessionDate: row.priorCloseSessionDate || null,
        priorCloseObservedAt: row.priorCloseObservedAt || null,
        currentPrice: finiteNumber(row.currentPrice),
        currentPriceSource: row.currentPriceSource || null,
        directAsk: finiteNumber(row.directAsk),
        directBid: finiteNumber(row.directBid),
        directLast: finiteNumber(row.directLast),
        currency: typeof row.currency === 'string' ? row.currency : null,
        snapshotTimestamp: row.snapshotTimestamp || null,
        marketDataType: row.marketDataType ?? null,
      }))
      : null,
    shortStockPriorCloseValue: finiteNumber(rawFunding.shortStockPriorCloseValue),
    openPositionCount: finiteNumber(rawFunding.openPositionCount),
    shortPositionCount: finiteNumber(rawFunding.shortPositionCount),
    openOrderCount: finiteNumber(rawFunding.openOrderCount),
    settledShortPositionsVerified:
      rawFunding.settledShortPositionsVerified === true
        ? true
        : rawFunding.settledShortPositionsVerified === false
          ? false
          : null,
    settlementStatus:
      typeof rawFunding.settlementStatus === 'string'
        ? rawFunding.settlementStatus
        : null,
    settlementDate:
      typeof rawFunding.settlementDate === 'string'
        ? rawFunding.settlementDate
        : null,
    noSameDayExecutionsVerified:
      rawFunding.noSameDayExecutionsVerified === true
        ? true
        : rawFunding.noSameDayExecutionsVerified === false
          ? false
          : null,
    sameDayExecutionCount:
      typeof rawFunding.sameDayExecutionCount === 'number' &&
      Number.isFinite(rawFunding.sameDayExecutionCount)
        ? rawFunding.sameDayExecutionCount
        : null,
    positionScope,
    accountValuesObservedAt: rawFunding.accountValuesObservedAt || null,
    status: 'live',
    source: response.source,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    fromCache: false,
  };
}

function normalizeFundingReference(response, accountId) {
  const rawSummary = response?.summary;
  const rawReference = response?.fundingReference;
  const shortEvidence = rawReference?.shortPositionReferenceEvidence;
  if (
    !verifiedFundingReferenceResponse(response)
    || response?.account !== accountId
    || rawSummary?.account !== accountId
    || !rawSummary
    || !rawReference
    || rawReference.schemaVersion !== 1
    || rawReference.referenceOnly !== true
    || rawReference.actionable !== false
    || rawReference.referenceKind
      !== 'completed_market_session_with_current_settlement_ladder'
    || rawReference.settlementVerification
      !== 'reference_segment_ladders_double_snapshot'
    || !validReferenceSessionDate(rawReference.referenceSessionDate)
    || !validReferenceSessionDate(rawReference.cashLedgerObservedDate)
    || !validReferenceSessionDate(rawReference.settlementHorizonDate)
    || !isFreshEvidence(rawReference.accountValuesObservedAt)
    || !Array.isArray(shortEvidence)
    || rawReference.positionScope?.allStock !== true
    || rawReference.positionScope?.allBaseCurrency !== true
  ) {
    return null;
  }

  const referenceSessionMs = Date.parse(
    `${rawReference.referenceSessionDate}T00:00:00Z`,
  );
  const cashObservedMs = Date.parse(
    `${rawReference.cashLedgerObservedDate}T00:00:00Z`,
  );
  const settlementHorizonMs = Date.parse(
    `${rawReference.settlementHorizonDate}T00:00:00Z`,
  );
  if (
    referenceSessionMs >= cashObservedMs
    || settlementHorizonMs < referenceSessionMs
  ) {
    return null;
  }

  const openOrderCount = finiteNumber(rawReference.openOrderCount);
  const openPositionCount = finiteNumber(rawReference.openPositionCount);
  const shortPositionCount = finiteNumber(rawReference.shortPositionCount);
  const executionCountObserved = finiteNumber(
    rawReference.executionCountObserved,
  );
  const shortStockReferenceCloseValue = finiteNumber(
    rawReference.shortStockReferenceCloseValue,
  );
  if (
    !Number.isInteger(openOrderCount)
    || openOrderCount !== 0
    || !Number.isInteger(openPositionCount)
    || openPositionCount < shortEvidence.length
    || !Number.isInteger(shortPositionCount)
    || shortPositionCount !== shortEvidence.length
    || !Number.isInteger(executionCountObserved)
    || executionCountObserved < 0
    || shortStockReferenceCloseValue == null
    || shortStockReferenceCloseValue < 0
  ) {
    return null;
  }

  const forbiddenLiveFields = [
    'currentPrice',
    'currentPriceSource',
    'directAsk',
    'directBid',
    'directLast',
    'marketDataType',
    'snapshotTimestamp',
    'priorClose',
    'priorCloseSource',
  ];
  const seenConIds = new Set();
  const normalizedShorts = [];
  for (const row of shortEvidence) {
    const conId = finiteNumber(row?.conId ?? row?.conid);
    const quantity = finiteNumber(row?.quantity);
    const referenceClose = finiteNumber(row?.referenceClose);
    if (
      !Number.isSafeInteger(conId)
      || conId <= 0
      || seenConIds.has(conId)
      || quantity == null
      || quantity >= 0
      || referenceClose == null
      || referenceClose <= 0
      || String(row?.currency || '').toUpperCase() !== 'USD'
      || row?.referenceCloseSource !== 'ibkr_historical_daily_close'
      || row?.referenceCloseSessionDate
        !== rawReference.referenceSessionDate
      || !isFreshEvidence(row?.referenceCloseObservedAt)
      || forbiddenLiveFields.some((field) => (
        Object.prototype.hasOwnProperty.call(row, field)
      ))
    ) {
      return null;
    }
    seenConIds.add(conId);
    normalizedShorts.push({
      conId,
      symbol: typeof row.symbol === 'string' ? row.symbol : null,
      currency: 'USD',
      quantity,
      referenceClose,
      referenceCloseSource: row.referenceCloseSource,
      referenceCloseSessionDate: row.referenceCloseSessionDate,
      referenceCloseObservedAt: row.referenceCloseObservedAt,
    });
  }

  const baseCurrency = String(
    rawSummary.baseCurrency || rawSummary.currency || '',
  ).toUpperCase();
  return {
    schemaVersion: 1,
    referenceOnly: true,
    actionable: false,
    referenceKind: rawReference.referenceKind,
    accountId,
    accountReady: rawSummary.AccountReady === true
      || String(rawSummary.AccountReady || '').toLowerCase() === 'true',
    baseCurrency,
    currency: baseCurrency,
    netLiquidation: finiteNumber(rawSummary.NetLiquidation),
    totalCashValue: finiteNumber(rawSummary.TotalCashValue),
    totalCashValueSecurities: finiteNumber(rawSummary['TotalCashValue-S']),
    totalCashValueCommodities: finiteNumber(rawSummary['TotalCashValue-C']),
    commodityMaintenanceMargin: finiteNumber(rawSummary['MaintMarginReq-C']),
    grossPositionValue: finiteNumber(
      rawSummary['GrossPositionValue-S'] ?? rawSummary.GrossPositionValue,
    ),
    stockMarketValue: finiteNumber(rawSummary.StockMarketValue),
    accruedCashSecurities: finiteNumber(
      rawSummary['AccruedCash-S'] ?? rawSummary.AccruedCash,
    ),
    settledCashByDateSecurities:
      rawSummary['SettledCashByDate-S'] || null,
    settledCashByDateCommodities:
      rawSummary['SettledCashByDate-C'] || null,
    cashBalances: rawReference.cashBalances || rawSummary.CashBalance || {},
    shortPositionReferences: normalizedShorts,
    shortStockReferenceCloseValue,
    openPositionCount,
    shortPositionCount,
    openOrderCount,
    executionCountObserved,
    positionScope: 'stocks_only',
    referenceSessionDate: rawReference.referenceSessionDate,
    cashLedgerObservedDate: rawReference.cashLedgerObservedDate,
    settlementHorizonDate: rawReference.settlementHorizonDate,
    settlementVerification: rawReference.settlementVerification,
    accountValuesObservedAt: rawReference.accountValuesObservedAt,
    status: 'reference',
    source: response.source,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    fromCache: false,
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

async function resolveAccountId(accountId) {
  const requested = accountId || ACCOUNT_ID || null;
  const accounts = await getAccounts();
  if (requested) return accounts.includes(requested) ? requested : null;
  return accounts[0] || null;
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

async function getLiveFundingSnapshot(accountId) {
  const acct = String(accountId || '').trim();
  if (!acct) return null;

  const res = await sidecarRequest(
    `/portfolio/live-funding?account=${encodeURIComponent(acct)}`,
    { timeoutMs: 25_000 },
  );
  const liveResponse = (
    verifiedLiveResponse(res)
    && res.account === acct
    && res.summary
    && res.funding
  );
  const fundingReference = liveResponse
    ? null
    : normalizeFundingReference(res, acct);
  if (!liveResponse && !fundingReference) {
    return null;
  }

  const accountSummary = normalizeAccountSummary({
    ...res.summary,
    currency: res.summary.baseCurrency || res.summary.currency,
    GrossPositionValue:
      res.summary.GrossPositionValue ?? res.summary['GrossPositionValue-S'],
    fetched_at: res.observed_at,
    source: res.source,
    socket_verified_at: res.socket_verified_at,
  });

  return {
    accountSummary,
    funding: liveResponse ? normalizeLiveFunding(res, acct) : null,
    fundingReference,
    fundingUnavailableReason:
      fundingReference ? 'non_settlement_day' : null,
  };
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

async function getLiveFundingSnapshotBestEffort(accountId) {
  try {
    return await getLiveFundingSnapshot(accountId);
  } catch (err) {
    let finalError = err;
    if (
      ['FUNDING_SNAPSHOT_TIMEOUT', 'GATEWAY_UNAVAILABLE']
        .includes(err?.sidecarCode)
    ) {
      try {
        return await getLiveFundingSnapshot(accountId);
      } catch (retryError) {
        finalError = retryError;
      }
    }
    const unavailableReasonByCode = {
      NON_SETTLEMENT_DAY: 'non_settlement_day',
      UNSETTLED_SECURITIES_ACTIVITY: 'unsettled_securities_activity',
    };
    const fundingUnavailableReason =
      unavailableReasonByCode[finalError?.sidecarCode];
    if (fundingUnavailableReason) {
      console.warn(
        '[Portfolio] IBKR live funding snapshot unavailable:',
        fundingUnavailableReason,
      );
      return {
        accountSummary: null,
        funding: null,
        fundingReference: null,
        fundingUnavailableReason,
      };
    }
    console.warn(
      '[Portfolio] IBKR live funding snapshot failed:',
      finalError?.message,
    );
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
  const predictionMarketContracts = holdings
    .filter((h) => Number(h.quantity || 0) !== 0 && h.isPredictionMarket)
    .map((h) => h.symbol || h.description)
    .filter(Boolean);
  const zeroQuantityFiltered = Math.max(0, raw.length - holdings.length);
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
    predictionMarketContractCount: predictionMarketContracts.length,
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

  // Reference history uses an isolated read-only client, so it can run while
  // the serialized funding snapshot is in flight without blocking the live
  // stream or overlapping the account/PnL requests on their clients.
  const referenceMarksPromise = raw.length > 0
    ? getReferenceMarks(acct, raw).catch(
      () => unavailableReferenceMarks(acct, 'REFERENCE_MARKS_REQUEST_FAILED'),
    )
    : null;

  // Avoid overlapping account/PnL socket requests; IB Gateway can otherwise
  // time them out under the dashboard's polling load.
  const liveFunding = acct ? await getLiveFundingSnapshotBestEffort(acct) : null;
  const accountSummary = liveFunding?.accountSummary
    || (acct ? await getAccountSummaryBestEffort(acct) : null);
  const pnl = acct ? await getPnLBestEffort(acct) : null;

  if (!raw.length) {
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
      funding: liveFunding?.funding || null,
      fundingReference: liveFunding?.fundingReference || null,
      fundingUnavailableReason:
        liveFunding?.fundingUnavailableReason || null,
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
  const holdings = raw
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
    funding: liveFunding?.funding || null,
    fundingReference: liveFunding?.fundingReference || null,
    fundingUnavailableReason:
      liveFunding?.fundingUnavailableReason || null,
    fromCache: false,
  };
}

async function getProviderStatus() {
  const status = await getSidecarProviderStatus('ibkr_portfolio');
  setIbkrConnected(Boolean(status.connected), status.message);
  return status;
}

module.exports = {
  getAccounts,
  getPositions,
  getBalances,
  getAccountSummary,
  getLiveFundingSnapshot,
  getPortfolioSnapshot,
  getOpenOrders,
  getPnL,
  getProviderStatus,
  ENABLED,
};
