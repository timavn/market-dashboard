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

const IBKR_STATUS_LABELS = {
  connected: 'Connected',
  sidecar_offline: 'Sidecar offline',
  sidecar_unresponsive: 'Sidecar wedged',
  tws_offline: 'Gateway offline',
  gateway_offline: 'Gateway offline',
  gateway_timeout: 'Gateway timeout',
  backend_offline: 'Backend offline',
  offline: 'Offline',
};

const IBKR_PORTFOLIO_FRESH_MS = 60 * 1000;
const IBKR_PORTFOLIO_STALE_MS = 5 * 60 * 1000;

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

/**
 * Status dot props aligned with dashboard StatusDot (green / blue / red emojis).
 */
export function getIbkrPortfolioStatusDot({ connection, portfolioData, loading }) {
  if (loading && !connection) {
    return {
      status: 'stale',
      emoji: '🔵',
      label: 'IBKR',
      overallLabel: 'IBKR status',
      sources: [{ id: 'ibkr', label: 'IBKR', detail: 'Checking connection…', status: 'stale' }],
    };
  }

  const ibkrStatus = connection?.connected ? 'connected' : connection?.kind || 'offline';
  const ibkrDetail = IBKR_STATUS_LABELS[ibkrStatus] || connection?.label || 'Unknown';
  const updatedAt =
    portfolioData?.accountSummary?.lastUpdated ||
    portfolioData?.lastUpdated ||
    null;
  const portfolioFreshness = getIbkrPortfolioFreshness(updatedAt);
  const portfolioDetail =
    portfolioData?.dataSource === 'ibkr_api'
      ? 'Live snapshot'
      : portfolioData?.dataSource === 'ibkr_offline'
        ? connection?.connected
          ? 'Not synced — use refresh'
          : 'Offline'
        : portfolioData?.dataSource || '—';

  let aggregateStatus = 'inactive';
  let emoji = '🔴';
  if (connection?.connected && portfolioData?.dataSource === 'ibkr_api') {
    if (portfolioFreshness === 'current') {
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

  return {
    status: aggregateStatus,
    emoji,
    label: 'IBKR',
    overallLabel: 'IBKR status',
    updatedAt,
    sources: [
      {
        id: 'ibkr',
        label: 'Connection',
        detail: ibkrDetail,
        status: connection?.connected ? 'current' : connection?.kind === 'backend_offline' ? 'defective' : 'stale',
      },
      {
        id: 'portfolio',
        label: 'Portfolio',
        detail: portfolioDetail,
        status:
          portfolioData?.dataSource === 'ibkr_api'
            ? portfolioFreshness
            : portfolioData?.dataSource === 'ibkr_offline'
              ? 'stale'
              : 'defective',
      },
    ],
  };
}
