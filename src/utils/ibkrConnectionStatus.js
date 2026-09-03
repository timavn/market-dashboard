import { isFreshForToday } from './dateFreshness';

/**
 * Human-readable IBKR connection state for sidebar status UI.
 * Distinguishes backend unreachable vs sidecar vs Gateway offline.
 */
export function getIbkrConnectionDisplay({ status, error }) {
  if (error) {
    const msg = String(error);
    if (/network error|ECONNREFUSED|ERR_NETWORK|failed to fetch|timeout/i.test(msg)) {
      return {
        connected: false,
        label: 'Backend offline',
        title: 'Express backend unreachable at localhost:3001 — run npm run dev or npm run server',
        warn: null,
        kind: 'backend_offline',
      };
    }
    return { connected: false, label: 'Offline', title: msg, warn: null, kind: 'offline' };
  }

  if (status?.ibkr?.connected) {
    return {
      connected: true,
      label: 'Live',
      title: 'IBKR Gateway connected via sidecar',
      warn: null,
      kind: 'connected',
    };
  }

  const ibkrStatus = status?.ibkr?.status;

  if (ibkrStatus === 'sidecar_offline') {
    return {
      connected: false,
      label: 'Sidecar offline',
      title: 'IBKR sidecar unreachable on :8765 - run npm run ibkr-sidecar',
      warn: null,
      kind: 'sidecar_offline',
    };
  }

  if (ibkrStatus === 'sidecar_unresponsive') {
    return {
      connected: false,
      label: 'Sidecar wedged',
      title: 'IBKR sidecar is listening but not responding - restart the existing sidecar process',
      warn: null,
      kind: 'sidecar_unresponsive',
    };
  }

  if (ibkrStatus === 'tws_offline' || ibkrStatus === 'gateway_offline' || ibkrStatus === 'gateway_timeout') {
    return {
      connected: false,
      label: ibkrStatus === 'gateway_timeout' ? 'Gateway timeout' : 'Gateway offline',
      title: ibkrStatus === 'gateway_timeout'
        ? 'Timed out while checking IB Gateway - verify Gateway is responsive and API is enabled'
        : 'IB Gateway not connected - log in with socket API enabled',
      warn: null,
      kind: ibkrStatus === 'gateway_timeout' ? 'gateway_timeout' : 'gateway_offline',
    };
  }

  return {
    connected: false,
    label: 'Offline',
    title: status?.ibkr?.message || 'IBKR offline',
    warn: null,
    kind: 'offline',
  };
}

export function getPreferredIbkrAccount(status, savedAccount = '') {
  const accounts = status?.ibkr?.accounts || status?.portfolio?.ibkr?.accounts || [];
  // An explicit user selection is authoritative across transient sidecar
  // discovery gaps. The account-scoped live endpoints still reject a genuine
  // ACCOUNT_NOT_MANAGED or account mismatch; provider polling must not turn a
  // reconnect into an implicit account switch that erases reference values.
  if (savedAccount) return savedAccount;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return '';
  }

  const streamedAccount =
    status?.ibkr?.sidecar?.stream?.portfolio_account ||
    status?.portfolio?.ibkr?.sidecar?.stream?.portfolio_account ||
    '';

  if (streamedAccount && accounts.includes(streamedAccount)) {
    return streamedAccount;
  }

  return accounts[0];
}

export const OFFLINE_SETUP_STEPS = [
  { id: 'gateway', label: 'IB Gateway logged in with API enabled' },
  { id: 'sidecar', label: 'IBKR sidecar reachable on :8765' },
];

/**
 * Setup checklist with per-step done state (infra only — not portfolio sync).
 */
export function getOfflineSetupSteps(connection) {
  const gatewayDone =
    connection?.kind === 'connected';
  const sidecarDone =
    connection?.connected === true ||
    connection?.kind === 'gateway_offline' ||
    connection?.kind === 'gateway_timeout' ||
    connection?.kind === 'sidecar_unresponsive';

  return OFFLINE_SETUP_STEPS.map((step) => ({
    ...step,
    done: step.id === 'gateway' ? gatewayDone : sidecarDone,
  }));
}

/**
 * When IBKR infra is up but /api/portfolio still returned ibkr_offline.
 */
export function isPortfolioSyncPending({ connection, portfolioData }) {
  return (
    portfolioData?.dataSource === 'ibkr_offline' &&
    connection?.connected === true
  );
}

/**
 * Offline panel copy — setup checklist vs "connected, refresh portfolio".
 */
export function getPortfolioOfflinePanel({ connection, portfolioData }) {
  const steps = getOfflineSetupSteps(connection);
  const syncPending = isPortfolioSyncPending({ connection, portfolioData });

  if (syncPending) {
    return {
      heading: 'IBKR connected — live positions unavailable; refresh to retry',
      detail: portfolioData?.error || 'The live IBKR position snapshot was not verified.',
      steps: null,
      syncPending: true,
    };
  }

  if (connection?.kind === 'sidecar_unresponsive') {
    return {
      heading: 'IBKR sidecar is running but unresponsive',
      detail: null,
      steps: [
        {
          id: 'restart-sidecar',
          label: "Restart sidecar: pkill -f 'uvicorn app:app' && npm run ibkr-sidecar",
          done: false,
        },
      ],
      syncPending: false,
    };
  }

  if (connection?.kind === 'sidecar_offline') {
    return {
      heading: 'Start the IBKR sidecar',
      detail: null,
      steps: [
        { id: 'sidecar', label: 'Run npm run ibkr-sidecar in a terminal', done: false },
      ],
      syncPending: false,
    };
  }

  if (connection?.kind === 'gateway_offline' || connection?.kind === 'gateway_timeout') {
    return {
      heading: connection?.kind === 'gateway_timeout'
        ? 'IB Gateway check timed out'
        : 'Connect IB Gateway to load live data',
      detail: null,
      steps,
      syncPending: false,
    };
  }

  return {
    heading: 'Connect to load live data',
    detail: null,
    steps,
    syncPending: false,
  };
}

/**
 * Sidebar banner below NLV — empty connected account only (offline uses setup card).
 * @returns {{ type: 'empty', message: string } | null}
 */
export function getPortfolioSidebarBanner({ portfolioData, selectedAccount }) {
  const dataSource = portfolioData?.dataSource;
  const isOffline = dataSource === 'ibkr_offline';
  if (isOffline) return null;

  const isEmptyAccount =
    dataSource === 'ibkr_api' && portfolioData?.empty;

  if (isEmptyAccount) {
    const acct = selectedAccount || portfolioData?.accountId || 'this account';
    return {
      type: 'empty',
      message: `No positions in ${acct}. Switch accounts to see exposure.`,
    };
  }

  return null;
}

const IBKR_PORTFOLIO_FRESH_MS = 60 * 1000;
const IBKR_PORTFOLIO_STALE_MS = 5 * 60 * 1000;
const INTEREST_VALIDATION_STATUS_MAX_AGE_MS = 2 * 60 * 1000;
const INTEREST_VALIDATION_FUTURE_TOLERANCE_MS = 5 * 1000;
const PREDICTION_MARKET_STATUS_LABELS = {
  connected: 'Connected',
  connected_no_contracts: 'IBKR connected, no event contracts discovered',
  connected_positions_only: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
  gateway_half_connected: 'Gateway half-connected: account data stale/timeouts',
  gateway_offline: 'Gateway offline',
  sidecar_offline: 'Sidecar offline',
  tws_offline: 'IB Gateway offline',
  auth_required: 'Login required',
  stale: 'Stale',
  error: 'Error',
  unknown: 'Unknown',
};

export function getIbkrPortfolioFreshness(updatedAt, now = Date.now()) {
  if (!updatedAt) {
    return 'defective';
  }

  const updated =
    updatedAt instanceof Date ? updatedAt : new Date(updatedAt);

  if (Number.isNaN(updated.getTime())) {
    return 'defective';
  }

  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  const ageMs = currentTime - updated.getTime();
  if (ageMs <= IBKR_PORTFOLIO_FRESH_MS) {
    return 'current';
  }
  if (ageMs <= IBKR_PORTFOLIO_STALE_MS) {
    return 'stale';
  }
  return 'defective';
}

function makeStatusDetail(id, text) {
  return { id, text, acknowledgeable: false };
}

function uniqueDetailRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row?.text || seen.has(row.text)) return false;
    seen.add(row.text);
    return true;
  });
}

function getDatePart(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const dateMatch = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (dateMatch) return dateMatch[0];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA');
}

function formatCounts(longCount, shortCount) {
  return `${longCount ?? '-'}/${shortCount ?? '-'}`;
}

function formatGmailPipelineReason(errorCode, reason) {
  const rawReason = String(reason || '').trim();
  if (
    errorCode === 'SERVICE_HEARTBEAT_ACCESS_DENIED'
    || (
      /access.?denied|not authorized/i.test(rawReason)
      && /MarketDashboardServiceHeartbeats|dynamodb:Query/i.test(rawReason)
    )
  ) {
    return 'market-dashboard-local cannot query MarketDashboardServiceHeartbeats. '
      + 'Admin fix: apply infra/iam/local-readiness-catalog-policy.json with '
      + 'infra/scripts/install_local_principal_policies.sh.';
  }
  if (/invalid_grant/i.test(rawReason)) {
    return 'Gmail rejected the OAuth refresh token (invalid_grant). '
      + 'Reauthorize Gmail and ensure the OAuth consent app is in Production.';
  }
  return rawReason || 'The upstream pipeline is not current.';
}

function countEtfProRows(etfProSnapshot) {
  const activeRows = Array.isArray(etfProSnapshot?.rows) ? etfProSnapshot.rows : [];
  const referenceRows = Array.isArray(etfProSnapshot?.lastKnownGood?.rows)
    ? etfProSnapshot.lastKnownGood.rows
    : [];
  const available = etfProSnapshot?.available !== false && activeRows.length > 0;
  const referenceAvailable = !available && referenceRows.length > 0;
  const rows = available ? activeRows : referenceRows;
  if (rows.length === 0) {
    return {
      available: false,
      referenceAvailable: false,
      rowCount: 0,
      longCount: null,
      shortCount: null,
    };
  }
  return rows.reduce((acc, row) => {
    if (String(row?.call || '').toLowerCase() === 'short') {
      acc.shortCount += 1;
    } else {
      acc.longCount += 1;
    }
    return acc;
  }, {
    available,
    referenceAvailable,
    rowCount: rows.length,
    longCount: 0,
    shortCount: 0,
  });
}

function buildRtaStatusSource({ rtaPositions }) {
  const available = Boolean(rtaPositions?.available);
  const longCount = available ? Number(rtaPositions.longCount || 0) : null;
  const shortCount = available ? Number(rtaPositions.shortCount || 0) : null;
  const availability = rtaPositions?.dataAvailability || {};
  const datePart = availability.contentDate
    || getDatePart(availability.latestContentAt)
    || getDatePart(rtaPositions?.lastUpdated);
  const hasPipelineFreshness = typeof availability.current === 'boolean'
    || typeof rtaPositions?.current === 'boolean'
    || Boolean(availability.ingestionStatus);
  const current = available && (
    hasPipelineFreshness
      ? availability.current === true || (
          availability.current == null
          && rtaPositions?.current === true
        )
      : isFreshForToday(datePart)
  );
  const errorCode = availability.errorCode
    || rtaPositions?.sourceDiagnostics?.gmailIngestion?.errorCode
    || rtaPositions?.dataQuality?.invalidEvents?.[0]?.code
    || null;
  const upstreamReason = availability.reason
    || rtaPositions?.sourceDiagnostics?.gmailIngestion?.reason
    || null;
  const reconstructionWarnings = [
    ...(Array.isArray(rtaPositions?.sourceDiagnostics?.reconstructionWarnings)
      ? rtaPositions.sourceDiagnostics.reconstructionWarnings
      : []),
    ...(Array.isArray(rtaPositions?.reconstructionWarnings)
      ? rtaPositions.reconstructionWarnings
      : []),
  ].filter(Boolean);
  const detailRows = [];
  let detail = `Current ${formatCounts(longCount, shortCount)}`;

  if (!available) {
    detailRows.push(makeStatusDetail(
      'rta:missing',
      `RTA positions unavailable${errorCode ? ` (${errorCode})` : ''}.`,
    ));
    detail = 'Unavailable';
  } else if (!current) {
    detailRows.push(makeStatusDetail(
      'rta:stale',
      datePart
        ? `Last known RTA positions are from ${datePart}.`
        : 'RTA positions are last-known-good; the content date is unavailable.',
    ));
    detail = `Stale ${formatCounts(longCount, shortCount)}`;
  }
  if ((!current || !available) && (errorCode || upstreamReason)) {
    detailRows.push(makeStatusDetail(
      'rta:upstream',
      `Gmail ingestion${errorCode ? ` (${errorCode})` : ''}: ${
        formatGmailPipelineReason(errorCode, upstreamReason)
      }`,
    ));
  }
  reconstructionWarnings.forEach((warning, index) => {
    detailRows.push(makeStatusDetail(`rta:warning:${index}`, `RTA: ${warning}`));
  });
  if (reconstructionWarnings.length > 0 && current) {
    detail = `Warning ${formatCounts(longCount, shortCount)}`;
  }

  return {
    id: 'rta',
    label: 'RTA',
    detail,
    detailRows: uniqueDetailRows(detailRows),
    status: !available
      ? 'defective'
      : (!current || reconstructionWarnings.length > 0 ? 'stale' : 'current'),
  };
}

function buildEtfProStatusSource({ etfProSnapshot }) {
  const {
    available,
    referenceAvailable,
    rowCount,
    longCount,
    shortCount,
  } = countEtfProRows(etfProSnapshot);
  const reference = referenceAvailable ? etfProSnapshot?.lastKnownGood : null;
  const availability = etfProSnapshot?.dataAvailability || {};
  const snapshotDate = etfProSnapshot?.meta?.snapshotDate
    || reference?.meta?.snapshotDate
    || getDatePart(etfProSnapshot?.meta?.parsedAt)
    || getDatePart(reference?.meta?.parsedAt);
  const hasPipelineFreshness = typeof availability.current === 'boolean'
    || typeof etfProSnapshot?.current === 'boolean'
    || Boolean(availability.ingestionStatus);
  const current = available && (
    hasPipelineFreshness
      ? availability.current === true || (
          availability.current == null
          && etfProSnapshot?.current === true
        )
      : isFreshForToday(snapshotDate)
  );
  const dataQuality = etfProSnapshot?.dataQuality
    || reference?.dataQuality
    || etfProSnapshot?.meta?.dataQuality
    || {};
  const dataQualityStatus = dataQuality?.status;
  const dataQualityWarnings = Array.isArray(dataQuality?.warnings) ? dataQuality.warnings : [];
  const errorCode = availability.errorCode || etfProSnapshot?.meta?.errorCode || null;
  const upstreamReason = availability.reason || etfProSnapshot?.meta?.reason || null;
  const detailRows = [];
  let detail = `Current ${formatCounts(longCount, shortCount)}`;

  if (!available && !referenceAvailable) {
    detailRows.push(makeStatusDetail(
      'etf-pro:missing',
      `ETF Pro positions unavailable${errorCode ? ` (${errorCode})` : ''}.`,
    ));
    detail = 'Unavailable';
  } else if (!current) {
    detailRows.push(makeStatusDetail(
      'etf-pro:stale',
      snapshotDate
        ? `Last known ETF Pro positions are from ${snapshotDate} (${rowCount} positions).`
        : `ETF Pro has ${rowCount} last-known-good positions with no content date.`,
    ));
    detail = `Stale ${formatCounts(longCount, shortCount)}`;
  }
  if ((!current || !available) && (errorCode || upstreamReason)) {
    detailRows.push(makeStatusDetail(
      'etf-pro:upstream',
      `Gmail ingestion${errorCode ? ` (${errorCode})` : ''}: ${
        formatGmailPipelineReason(errorCode, upstreamReason)
      }`,
    ));
  }
  if ((available || referenceAvailable) && dataQualityStatus && dataQualityStatus !== 'ok') {
    detailRows.push(makeStatusDetail('etf-pro:data-quality', `ETF Pro data quality: ${dataQualityStatus}`));
    detail = `Warning ${formatCounts(longCount, shortCount)}`;
  }
  dataQualityWarnings.forEach((warning, index) => {
    detailRows.push(makeStatusDetail(`etf-pro:warning:${index}`, warning));
  });

  return {
    id: 'etf-pro',
    label: 'ETF Pro',
    detail,
    detailRows: uniqueDetailRows(detailRows),
    status: !available && !referenceAvailable
      ? 'defective'
      : (
          !current ||
          (dataQualityStatus && dataQualityStatus !== 'ok') ||
          dataQualityWarnings.length > 0
            ? 'stale'
            : 'current'
        ),
  };
}

function getPredictionMarketContractsTotal(ibkr = {}) {
  const values = [
    ibkr.contracts_total,
    ibkr.contractsTotal,
    ibkr.cpi_discovery?.contracts_total,
    ibkr.cpi_discovery?.contractsTotal,
    ibkr.cpiDiscovery?.contracts_total,
    ibkr.cpiDiscovery?.contractsTotal,
  ].map(Number).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function getPredictionMarketCpiDiscovery(ibkr = {}) {
  return ibkr.cpi_discovery || ibkr.cpiDiscovery || {};
}

function formatPredictionMarketStrikes(values = []) {
  return values.map((value) => `${Number(value).toFixed(1)}%`).join(', ');
}

function hasCompletePredictionMarketCpiCoverage(ibkr = {}) {
  const cpiDiscovery = getPredictionMarketCpiDiscovery(ibkr);
  const targetStrikes = cpiDiscovery.targetStrikes || [];
  const missingStrikes = cpiDiscovery.missingStrikes || [];
  const contractsTotal = getPredictionMarketContractsTotal(ibkr);
  if (targetStrikes.length === 0) return false;
  return missingStrikes.length === 0 && Number(contractsTotal || 0) >= targetStrikes.length;
}

function buildPredictionMarketStatusSource(predictionMarketProviderStatus) {
  const providers = predictionMarketProviderStatus?.providers || predictionMarketProviderStatus || {};
  const ibkr = providers?.ibkr || {};
  const status = ibkr.status || (predictionMarketProviderStatus?.error ? 'error' : null);
  const providerErrorCode = ibkr.errorCode
    || predictionMarketProviderStatus?.readiness?.ibkrExecution?.errorCode
    || predictionMarketProviderStatus?.errorCode
    || null;
  const rawProviderError = [
    predictionMarketProviderStatus?.error,
    ibkr.message,
    predictionMarketProviderStatus?.readiness?.ibkrExecution?.reason,
  ].filter(Boolean).join(' ');
  const catalogAccessDenied = providerErrorCode === 'PREDICTION_CATALOG_ACCESS_DENIED'
    || (
      /access.?denied|not authorized/i.test(rawProviderError)
      && /PredictionMarketCatalogV2|dynamodb:(?:Query|TransactWriteItems)/i.test(rawProviderError)
    );
  if (catalogAccessDenied) {
    return {
      id: 'prediction-markets',
      label: 'Prediction markets',
      detail: 'Error',
      detailRows: [
        makeStatusDetail(
          'prediction-markets:catalog-access-code',
          'Code: PREDICTION_CATALOG_ACCESS_DENIED',
        ),
        makeStatusDetail(
          'prediction-markets:catalog-access-principal',
          'market-dashboard-local lacks dynamodb:Query and dynamodb:TransactWriteItems on PredictionMarketCatalogV2.',
        ),
        makeStatusDetail(
          'prediction-markets:catalog-access-fix',
          'Admin fix: attach infra/iam/local-readiness-catalog-policy.json using infra/scripts/install_local_principal_policies.sh.',
        ),
      ],
      status: 'defective',
    };
  }
  const gatewayOk = ibkr.gateway?.ok;
  const contractsTotal = getPredictionMarketContractsTotal(ibkr);
  const cpiDiscovery = getPredictionMarketCpiDiscovery(ibkr);
  const targetStrikes = cpiDiscovery.targetStrikes || [];
  const missingStrikes = cpiDiscovery.missingStrikes || [];
  const portfolioSeedCount = ibkr.portfolio_seed_count ?? ibkr.portfolioSeedCount ?? 0;
  const completeCpiCoverage = hasCompletePredictionMarketCpiCoverage(ibkr);
  const message =
    predictionMarketProviderStatus?.error ||
    ibkr.message ||
    PREDICTION_MARKET_STATUS_LABELS[status] ||
    status ||
    'Prediction market provider status unavailable';
  const detailRows = [];
  let detail = 'Live';

  if (!status) {
    detailRows.push(makeStatusDetail('prediction-markets:missing', 'Prediction market provider status unavailable'));
    detail = 'Error';
  } else if (status !== 'connected' && !(status === 'connected_positions_only' && gatewayOk === true && completeCpiCoverage)) {
    detailRows.push(makeStatusDetail('prediction-markets:provider-status', `Prediction markets: ${message}`));
    detail = 'Error';
  }
  if (gatewayOk === false) {
    detailRows.push(makeStatusDetail('prediction-markets:gateway', 'Prediction markets: IB Gateway is not connected'));
    detail = 'Error';
  }
  if (status === 'connected' && (contractsTotal == null || Number(contractsTotal) <= 0)) {
    detailRows.push(makeStatusDetail('prediction-markets:no-contracts', 'Prediction markets: no executable CPI contracts discovered'));
    detail = 'Error';
  }
  if ((status === 'connected' || status === 'connected_positions_only') && targetStrikes.length > 0 && missingStrikes.length > 0) {
    detailRows.push(makeStatusDetail(
      'prediction-markets:missing-strikes',
      `Prediction markets: CPI contract catalog incomplete; missing strikes ${formatPredictionMarketStrikes(missingStrikes)}`,
    ));
    detail = 'Error';
  }
  if ((status === 'connected' || status === 'connected_positions_only') && targetStrikes.length > 0 && Number(contractsTotal || 0) < targetStrikes.length) {
    detailRows.push(makeStatusDetail(
      'prediction-markets:incomplete-catalog',
      `Prediction markets: discovered ${contractsTotal || 0} of ${targetStrikes.length} target CPI contracts`,
    ));
    detail = 'Error';
  }
  if (status === 'connected' && Number(contractsTotal || 0) > 0 && Number(portfolioSeedCount || 0) >= Number(contractsTotal || 0)) {
    detailRows.push(makeStatusDetail(
      'prediction-markets:portfolio-seeded',
      'Prediction markets: only portfolio-seeded CPI contracts are available; executable contract catalog is incomplete',
    ));
    detail = 'Error';
  }

  return {
    id: 'prediction-markets',
    label: 'Prediction markets',
    detail,
    detailRows: uniqueDetailRows(detailRows),
    status: detailRows.length > 0 ? 'stale' : 'current',
  };
}

function getAggregateStatusFromSources(baseStatus, sources) {
  const hardFailure = sources.some((source) => source.status === 'defective' || source.status === 'inactive');
  if (hardFailure || baseStatus === 'inactive' || baseStatus === 'defective') return 'inactive';
  if (sources.some((source) => source.status === 'stale') || baseStatus === 'stale') return 'stale';
  return 'active';
}

function buildInterestValidationStatusSource({
  interestValidation,
  loading = false,
  selectedAccount,
  now = Date.now(),
}) {
  const modelStatus = String(
    interestValidation?.modelStatus || interestValidation?.status || '',
  ).trim().toLowerCase();
  const generatedAt = Date.parse(String(interestValidation?.generatedAt || ''));
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  const ageMs = currentTime - generatedAt;
  const requestedAccount = String(
    interestValidation?.requestedAccount || '',
  ).trim();
  const currentAccount = String(selectedAccount || '').trim();
  const operational = (
    interestValidation?.source === 'ibkr_interest_validation'
    && interestValidation?.available === true
    && interestValidation?.accountMatched === true
    && currentAccount
    && requestedAccount === currentAccount
    && ['provisional', 'learning', 'validated'].includes(modelStatus)
    && Number.isFinite(generatedAt)
    && Number.isFinite(currentTime)
    && ageMs >= -INTEREST_VALIDATION_FUTURE_TOLERANCE_MS
    && ageMs <= INTEREST_VALIDATION_STATUS_MAX_AGE_MS
  );

  let stateLabel = 'Unavailable';
  let status = 'defective';
  if (operational) {
    stateLabel = modelStatus.charAt(0).toUpperCase() + modelStatus.slice(1);
    status = modelStatus === 'validated' ? 'current' : 'stale';
  } else if (loading) {
    stateLabel = 'Checking';
    status = 'loading';
  }

  return {
    id: 'interest-validation',
    label: 'Interest validation',
    stateLabel,
    detail: stateLabel,
    detailRows: [],
    status,
  };
}

/**
 * Status dot props aligned with dashboard StatusDot (green / blue / red emojis).
 */
export function getIbkrPortfolioStatusDot({
  connection,
  portfolioData,
  loading,
  rtaPositions,
  etfProSnapshot,
  predictionMarketProviderStatus,
  interestValidation,
  interestValidationLoading = false,
  selectedAccount,
  now = Date.now(),
}) {
  if (loading && !portfolioData) {
    return {
      status: 'stale',
      emoji: '🔵',
      label: 'IBKR',
      overallLabel: 'IBKR API Status',
      sources: [{ id: 'ibkr', label: 'IBKR', detail: 'Checking connection…', status: 'stale' }],
    };
  }

  const updatedAt =
    portfolioData?.socketVerifiedAt ||
    portfolioData?.dataQuality?.fetchedAt ||
    portfolioData?.funding?.observedAt ||
    portfolioData?.accountSummary?.lastUpdated ||
    portfolioData?.lastUpdated ||
    null;
  const portfolioFreshness = getIbkrPortfolioFreshness(updatedAt, now);
  const dataQuality = portfolioData?.dataQuality || {};
  const missingMarketValueCount = Number(dataQuality.missingMarketValueCount || 0);
  const unavailableMarketValueCount = Number(
    dataQuality.unavailableMarketValueCount ?? missingMarketValueCount,
  );
  const missingMarketValueSymbols = Array.isArray(dataQuality.missingMarketValueSymbols)
    ? dataQuality.missingMarketValueSymbols.filter(Boolean)
    : [];
  const markState = String(dataQuality.markState || '').trim().toLowerCase();
  const markProgress = dataQuality.markProgress || portfolioData?.referenceMarks?.progress || {};
  const progressNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  };
  const warmingMarkCount = Math.max(
    progressNumber(dataQuality.warmingMarkCount) || 0,
    progressNumber(dataQuality.warmingMarketValueCount) || 0,
    progressNumber(portfolioData?.referenceMarks?.warmingCount) || 0,
    progressNumber(markProgress.pendingCount) || 0,
  );
  const warmingRequestedCount = progressNumber(markProgress.requestedCount)
    ?? progressNumber(portfolioData?.referenceMarks?.requestedCount);
  const warmingCompletedCount = progressNumber(markProgress.completedCount)
    ?? (
      warmingRequestedCount != null
        ? Math.max(0, warmingRequestedCount - warmingMarkCount)
        : null
    );
  const hasWarmingMarks =
    portfolioData?.dataSource === 'ibkr_api'
    && (
      markState === 'warming'
      || portfolioData?.referenceMarks?.warming === true
      || String(markProgress.state || '').toLowerCase() === 'warming'
      || warmingMarkCount > 0
    );
  const historicalHoldings = Array.isArray(portfolioData?.holdings)
    ? portfolioData.holdings.filter((holding) => (
        holding?.priceState === 'historical_close' ||
        holding?.marketValueState === 'historical_close'
      ))
    : [];
  const historicalMarkCount = Math.max(
    Number(dataQuality.historicalMarkCount || 0),
    historicalHoldings.length,
  );
  const referenceSessionDates = [
    dataQuality.referenceCloseSessionDate,
    dataQuality.latestReferenceCloseSessionDate,
    dataQuality.latestReferenceSessionDate,
    dataQuality.referenceMarkSessionDate,
    ...(Array.isArray(dataQuality.referenceCloseSessionDates)
      ? dataQuality.referenceCloseSessionDates
      : []),
    ...historicalHoldings.flatMap((holding) => [
      holding?.referenceCloseSessionDate,
      holding?.priceSessionDate,
    ]),
  ].map(getDatePart).filter(Boolean).sort();
  const referenceAsOf = referenceSessionDates.at(-1) || null;
  const hasPartialMarks =
    portfolioData?.dataSource === 'ibkr_api' &&
    (
      dataQuality.status === 'partial' ||
      unavailableMarketValueCount > 0 ||
      (!hasWarmingMarks && (missingMarketValueCount > 0 || markState === 'unavailable'))
    );
  const hasReferenceMarks =
    portfolioData?.dataSource === 'ibkr_api' &&
    !hasPartialMarks &&
    !hasWarmingMarks &&
    (
      historicalMarkCount > 0 ||
      markState === 'reference' ||
      markState === 'mixed'
    );
  const partialMarksDetail = hasPartialMarks
    ? `Partial marks (${missingMarketValueCount || 'some'} missing market values)`
    : null;
  const referenceMarksDetail = hasReferenceMarks
    ? `Reference closes (${historicalMarkCount || 'some'} as of ${referenceAsOf || 'date unavailable'})`
    : null;
  const warmingMarksDetail = hasWarmingMarks
    ? `Reference closes warming (${
        warmingCompletedCount ?? historicalMarkCount
      }/${warmingRequestedCount ?? 'unknown'} complete; ${warmingMarkCount} pending)`
    : null;
  const markFailureRows = Array.isArray(dataQuality.markFailures)
    ? dataQuality.markFailures.slice(0, 3).map((failure, index) => {
        const symbol = failure?.symbol || failure?.localSymbol || 'Unknown ticker';
        const code = failure?.errorCode || failure?.code || 'MARK_UNAVAILABLE';
        const message = failure?.message || failure?.reason || 'IBKR did not return a usable mark.';
        return makeStatusDetail(
          `ibkr-portfolio-mark-failure:${symbol}:${code}:${index}`,
          `${symbol} (${code}): ${message}`,
        );
      })
    : [];
  const partialMarksRows = hasPartialMarks
    ? [
        makeStatusDetail(
          `ibkr-portfolio-missing-market-values:${missingMarketValueSymbols.join('|') || missingMarketValueCount || 'unknown'}`,
          `Missing tickers: ${
            missingMarketValueSymbols.length > 0
              ? `${missingMarketValueSymbols.slice(0, 16).join(', ')}${missingMarketValueSymbols.length > 16 ? ` +${missingMarketValueSymbols.length - 16} more` : ''}`
              : 'unavailable'
          }`,
        ),
        ...(Array.isArray(dataQuality.warnings)
          ? dataQuality.warnings
              .slice(0, 2)
              .map((warning) => makeStatusDetail(`ibkr-portfolio-warning:${warning}`, warning))
          : []),
        ...markFailureRows,
      ]
    : [];
  const referenceMarksRows = hasReferenceMarks
    ? [
        makeStatusDetail(
          'ibkr-portfolio-reference-closes',
          `${historicalMarkCount || 'Some'} position${
            historicalMarkCount === 1 ? '' : 's'
          } use the last completed IBKR daily close; positions are live, but those valuations are reference data.`,
        ),
        ...(referenceSessionDates.length > 1 && referenceSessionDates[0] !== referenceAsOf
          ? [makeStatusDetail(
              'ibkr-portfolio-reference-close-range',
              `Reference-close sessions span ${referenceSessionDates[0]} through ${referenceAsOf}.`,
            )]
          : []),
        ...(Array.isArray(dataQuality.warnings)
          ? dataQuality.warnings
              .slice(0, 2)
              .map((warning) => makeStatusDetail(`ibkr-portfolio-reference-warning:${warning}`, warning))
          : []),
        ...markFailureRows,
      ]
    : [];
  const warmingMarksRows = hasWarmingMarks
    ? [
        makeStatusDetail(
          'ibkr-portfolio-reference-warming',
          `IBKR is warming completed daily closes in the background (${
            warmingCompletedCount ?? historicalMarkCount
          }/${warmingRequestedCount ?? 'unknown'} complete; ${warmingMarkCount} pending).`,
        ),
        ...(historicalMarkCount > 0
          ? [makeStatusDetail(
              'ibkr-portfolio-reference-warming-ready',
              `${historicalMarkCount} completed reference close${
                historicalMarkCount === 1 ? ' is' : 's are'
              } already available; pending rows remain unavailable and cannot enable portfolio actions.`,
            )]
          : []),
      ]
    : [];
  const portfolioDetail =
    portfolioData?.dataSource === 'ibkr_api'
      ? partialMarksDetail || warmingMarksDetail || referenceMarksDetail || 'Live'
      : portfolioData?.dataSource === 'ibkr_offline'
        ? connection?.connected
          ? 'Not synced — use refresh'
          : 'Offline'
        : portfolioData?.dataSource || '—';

  let aggregateStatus = 'inactive';
  let emoji = '🔴';
  if (connection?.connected && portfolioData?.dataSource === 'ibkr_api') {
    if (hasPartialMarks) {
      aggregateStatus = 'inactive';
      emoji = '🔴';
    } else if (hasWarmingMarks || hasReferenceMarks) {
      aggregateStatus = 'stale';
      emoji = '🟡';
    } else if (portfolioFreshness === 'current') {
      aggregateStatus = 'active';
      emoji = '🟢';
    } else if (portfolioFreshness === 'stale') {
      aggregateStatus = 'stale';
      emoji = '🟡';
    } else {
      aggregateStatus = 'inactive';
      emoji = '🔴';
    }
  } else if (
    connection?.connected &&
    portfolioData?.dataSource === 'ibkr_offline'
  ) {
    aggregateStatus = 'stale';
    emoji = '🟡';
  } else if (
    connection?.kind === 'sidecar_offline' ||
    connection?.kind === 'sidecar_unresponsive' ||
    connection?.kind === 'gateway_offline' ||
    connection?.kind === 'gateway_timeout' ||
    connection?.kind === 'offline'
  ) {
    aggregateStatus = 'inactive';
    emoji = '🔴';
  }

  const sources = [
    {
      id: 'portfolio',
      label: 'Portfolio',
      detail: portfolioDetail,
      detailRows: (
        partialMarksRows.length > 0
        || warmingMarksRows.length > 0
        || referenceMarksRows.length > 0
      )
        ? [...partialMarksRows, ...warmingMarksRows, ...referenceMarksRows]
        : [makeStatusDetail('portfolio:detail', portfolioDetail)],
      acknowledgeableDetails: true,
      acknowledgeableStatus: false,
      acknowledgedStatus: portfolioFreshness,
      acknowledgedDetail: 'Partial marks acknowledged',
      status:
        portfolioData?.dataSource === 'ibkr_api'
          ? hasPartialMarks
            ? 'defective'
            : hasWarmingMarks || hasReferenceMarks
              ? 'stale'
              : portfolioFreshness
          : portfolioData?.dataSource === 'ibkr_offline'
            ? 'stale'
            : 'defective',
    },
  ];

  const shouldIncludeInterestValidation = (
    interestValidation != null
    || interestValidationLoading === true
  );
  if (shouldIncludeInterestValidation) {
    sources.push(buildInterestValidationStatusSource({
      interestValidation,
      loading: interestValidationLoading,
      selectedAccount,
      now,
    }));
  }

  if (connection?.statusRefreshDelayed) {
    sources.push({
      id: 'provider-status-refresh-delayed',
      label: 'Status refresh',
      detail: 'Delayed; showing last connected IBKR status',
      detailRows: [
        makeStatusDetail(
          'provider-status-refresh-delayed:detail',
          connection.statusRefreshError || 'Provider status refresh timed out.',
        ),
      ],
      status: 'current',
    });
  }

  const dependencySources = [];
  if (rtaPositions != null) {
    dependencySources.push(buildRtaStatusSource({ portfolioData, rtaPositions }));
  }
  if (etfProSnapshot != null) {
    dependencySources.push(buildEtfProStatusSource({ portfolioData, etfProSnapshot }));
  }
  if (predictionMarketProviderStatus != null) {
    dependencySources.push(buildPredictionMarketStatusSource(predictionMarketProviderStatus));
  }
  if (dependencySources.length > 0) {
    sources.push(...dependencySources);
    aggregateStatus = getAggregateStatusFromSources(aggregateStatus, sources);
    emoji = aggregateStatus === 'active' ? '🟢' : aggregateStatus === 'stale' ? '🟡' : '🔴';
  } else if (shouldIncludeInterestValidation) {
    aggregateStatus = getAggregateStatusFromSources(aggregateStatus, sources);
    emoji = aggregateStatus === 'active' ? '🟢' : aggregateStatus === 'stale' ? '🟡' : '🔴';
  }

  return {
    status: aggregateStatus,
    emoji,
    label: 'IBKR',
    overallLabel: 'IBKR API Status',
    updatedAt,
    sources,
  };
}
