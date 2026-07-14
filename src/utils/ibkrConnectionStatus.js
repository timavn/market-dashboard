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
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return savedAccount || '';
  }

  if (savedAccount && accounts.includes(savedAccount)) {
    return savedAccount;
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
      heading: 'IBKR connected — refresh to load portfolio',
      steps: null,
      syncPending: true,
    };
  }

  if (connection?.kind === 'sidecar_unresponsive') {
    return {
      heading: 'IBKR sidecar is running but unresponsive',
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
      steps,
      syncPending: false,
    };
  }

  return {
    heading: 'Connect to load live data',
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
const PREDICTION_MARKET_STATUS_LABELS = {
  connected: 'Connected',
  connected_no_contracts: 'IBKR connected, no event contracts discovered',
  connected_positions_only: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
  gateway_half_connected: 'Gateway half-connected: account data stale/timeouts',
  gateway_offline: 'Gateway offline',
  sidecar_offline: 'Sidecar offline',
  tws_offline: 'IB Gateway offline',
  auth_required: 'Login required',
  stale: 'Error',
  error: 'Error',
  unknown: 'Unknown',
};

function getIbkrPortfolioFreshness(updatedAt) {
  if (!updatedAt) {
    return 'defective';
  }

  const updated =
    updatedAt instanceof Date ? updatedAt : new Date(updatedAt);

  if (Number.isNaN(updated.getTime())) {
    return 'defective';
  }

  const ageMs = Date.now() - updated.getTime();
  if (ageMs <= IBKR_PORTFOLIO_FRESH_MS) {
    return 'current';
  }
  if (ageMs <= IBKR_PORTFOLIO_STALE_MS) {
    return 'stale';
  }
  return 'defective';
}

function makeAcknowledgeableWarning(id, text) {
  return {
    id,
    text,
    acknowledgeable: true,
  };
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

function countEtfProRows(etfProSnapshot) {
  const rows = Array.isArray(etfProSnapshot?.rows) ? etfProSnapshot.rows : [];
  if (rows.length === 0) {
    return { available: false, longCount: null, shortCount: null };
  }
  return rows.reduce((acc, row) => {
    if (String(row?.call || '').toLowerCase() === 'short') {
      acc.shortCount += 1;
    } else {
      acc.longCount += 1;
    }
    return acc;
  }, { available: true, longCount: 0, shortCount: 0 });
}

function buildRtaStatusSource({ rtaPositions }) {
  const available = Boolean(rtaPositions?.available);
  const longCount = available ? Number(rtaPositions.longCount || 0) : null;
  const shortCount = available ? Number(rtaPositions.shortCount || 0) : null;
  const datePart = getDatePart(rtaPositions?.lastUpdated);
  const fresh = isFreshForToday(datePart);
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
    detailRows.push(makeStatusDetail('rta:missing', 'RTA positions unavailable'));
    detail = 'Error';
  }
  if (available && !fresh) {
    detailRows.push(makeStatusDetail(
      'rta:stale',
      `RTA stale${datePart ? `; latest stored RTA is ${datePart}` : ''}`,
    ));
    detail = 'Error';
  }
  reconstructionWarnings.forEach((warning, index) => {
    detailRows.push(makeStatusDetail(`rta:warning:${index}`, `RTA: ${warning}`));
  });
  if (reconstructionWarnings.length > 0 && fresh) {
    detail = 'Error';
  }

  return {
    id: 'rta',
    label: 'RTA',
    detail,
    detailRows: uniqueDetailRows(detailRows),
    status: detailRows.length > 0 ? 'stale' : 'current',
  };
}

function buildEtfProStatusSource({ etfProSnapshot }) {
  const { available, longCount, shortCount } = countEtfProRows(etfProSnapshot);
  const snapshotDate = etfProSnapshot?.meta?.snapshotDate || getDatePart(etfProSnapshot?.meta?.parsedAt);
  const fresh = isFreshForToday(snapshotDate);
  const dataQuality = etfProSnapshot?.dataQuality || etfProSnapshot?.meta?.dataQuality || {};
  const dataQualityStatus = dataQuality?.status;
  const dataQualityWarnings = Array.isArray(dataQuality?.warnings) ? dataQuality.warnings : [];
  const detailRows = [];
  let detail = `Current ${formatCounts(longCount, shortCount)}`;

  if (!available) {
    detailRows.push(makeStatusDetail('etf-pro:missing', 'ETF Pro positions unavailable'));
    detail = 'Error';
  }
  if (available && !fresh) {
    detailRows.push(makeStatusDetail(
      'etf-pro:stale',
      `ETF Pro stale${snapshotDate ? `; latest stored ETF Pro is ${snapshotDate}` : ''}`,
    ));
    detail = 'Error';
  }
  if (available && dataQualityStatus && dataQualityStatus !== 'ok') {
    detailRows.push(makeStatusDetail('etf-pro:data-quality', `ETF Pro data quality: ${dataQualityStatus}`));
    detail = 'Error';
  }
  dataQualityWarnings.forEach((warning, index) => {
    detailRows.push(makeStatusDetail(`etf-pro:warning:${index}`, warning));
  });

  return {
    id: 'etf-pro',
    label: 'ETF Pro',
    detail,
    detailRows: uniqueDetailRows(detailRows),
    status: detailRows.length > 0 ? 'stale' : 'current',
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
}) {
  if (loading && !connection) {
    return {
      status: 'stale',
      emoji: '🔵',
      label: 'IBKR',
      overallLabel: 'IBKR API Status',
      sources: [{ id: 'ibkr', label: 'IBKR', detail: 'Checking connection…', status: 'stale' }],
    };
  }

  const updatedAt =
    portfolioData?.accountSummary?.lastUpdated ||
    portfolioData?.lastUpdated ||
    null;
  const portfolioFreshness = getIbkrPortfolioFreshness(updatedAt);
  const dataQuality = portfolioData?.dataQuality || {};
  const missingMarketValueCount = Number(dataQuality.missingMarketValueCount || 0);
  const missingMarketValueSymbols = Array.isArray(dataQuality.missingMarketValueSymbols)
    ? dataQuality.missingMarketValueSymbols.filter(Boolean)
    : [];
  const hasPartialMarks =
    portfolioData?.dataSource === 'ibkr_api' &&
    (
      dataQuality.status === 'partial' ||
      missingMarketValueCount > 0
    );
  const partialMarksDetail = hasPartialMarks
    ? `Partial marks (${missingMarketValueCount || 'some'} missing market values)`
    : null;
  const partialMarksRows = hasPartialMarks
    ? [
        makeAcknowledgeableWarning(
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
              .map((warning) => makeAcknowledgeableWarning(`ibkr-portfolio-warning:${warning}`, warning))
          : []),
      ]
    : [];
  const portfolioDetail =
    portfolioData?.dataSource === 'ibkr_api'
      ? partialMarksDetail || 'Live'
      : portfolioData?.dataSource === 'ibkr_offline'
        ? connection?.connected
          ? 'Not synced — use refresh'
          : 'Offline'
        : portfolioData?.dataSource || '—';

  let aggregateStatus = 'inactive';
  let emoji = '🔴';
  if (connection?.connected && portfolioData?.dataSource === 'ibkr_api') {
    if (hasPartialMarks) {
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
      detailRows: partialMarksRows.length > 0
        ? partialMarksRows
        : [makeStatusDetail('portfolio:detail', portfolioDetail)],
      acknowledgeableDetails: true,
      acknowledgeableStatus: hasPartialMarks,
      acknowledgedStatus: portfolioFreshness,
      acknowledgedDetail: 'Partial marks acknowledged',
      status:
        portfolioData?.dataSource === 'ibkr_api'
          ? hasPartialMarks
            ? 'stale'
            : portfolioFreshness
          : portfolioData?.dataSource === 'ibkr_offline'
            ? 'stale'
            : 'defective',
    },
  ];

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

  const shouldIncludeDependencies = (
    rtaPositions !== undefined ||
    etfProSnapshot !== undefined ||
    predictionMarketProviderStatus !== undefined
  );
  if (shouldIncludeDependencies) {
    sources.push(
      buildRtaStatusSource({ portfolioData, rtaPositions }),
      buildEtfProStatusSource({ portfolioData, etfProSnapshot }),
      buildPredictionMarketStatusSource(predictionMarketProviderStatus),
    );
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
