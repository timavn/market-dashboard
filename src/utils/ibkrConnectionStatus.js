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
      title: 'IBKR sidecar unreachable on :8765 — run npm run ibkr-sidecar',
      warn: null,
      kind: 'sidecar_offline',
    };
  }

  if (ibkrStatus === 'tws_offline') {
    return {
      connected: false,
      label: 'Gateway offline',
      title: 'IB Gateway not connected — log in with socket API enabled',
      warn: null,
      kind: 'gateway_offline',
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

export const OFFLINE_SETUP_STEPS = [
  { id: 'gateway', label: 'IB Gateway logged in with API enabled' },
  { id: 'sidecar', label: 'Run npm run ibkr-sidecar in a terminal' },
];

/**
 * Setup checklist with per-step done state (infra only — not portfolio sync).
 */
export function getOfflineSetupSteps(connection) {
  const gatewayDone =
    connection?.kind === 'connected' ||
    connection?.kind === 'sidecar_offline';
  const sidecarDone = connection?.connected === true;

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
  const infraReady = steps.every((s) => s.done);
  const syncPending = isPortfolioSyncPending({ connection, portfolioData });

  if (syncPending) {
    return {
      heading: 'IBKR connected — refresh to load portfolio',
      steps: null,
      syncPending: true,
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
  tws_offline: 'Gateway offline',
  gateway_offline: 'Gateway offline',
  backend_offline: 'Backend offline',
  offline: 'Offline',
};

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
    aggregateStatus = 'active';
    emoji = '🟢';
  } else if (
    connection?.connected &&
    portfolioData?.dataSource === 'ibkr_offline'
  ) {
    aggregateStatus = 'stale';
    emoji = '🔵';
  } else if (
    connection?.kind === 'sidecar_offline' ||
    connection?.kind === 'gateway_offline' ||
    connection?.kind === 'offline'
  ) {
    aggregateStatus = 'stale';
    emoji = '🔵';
  }

  return {
    status: aggregateStatus,
    emoji,
    label: 'IBKR',
    overallLabel: 'IBKR status',
    updatedAt: portfolioData?.accountSummary?.lastUpdated || null,
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
        status: portfolioData?.dataSource === 'ibkr_api' ? 'current' : 'defective',
      },
    ],
  };
}
