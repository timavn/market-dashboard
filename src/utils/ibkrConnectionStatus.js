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
        label: 'backend offline',
        title: 'Express backend unreachable at localhost:3001 — run npm run dev or npm run server',
        warn: 'Backend unreachable — is npm run dev running?',
      };
    }
    return { connected: false, label: 'offline', title: msg, warn: msg };
  }

  if (status?.ibkr?.connected) {
    return {
      connected: true,
      label: 'connected',
      title: 'IBKR Gateway connected via sidecar (market data + portfolio)',
      warn: null,
    };
  }

  const ibkrStatus = status?.ibkr?.status;
  const ibkrMsg = status?.ibkr?.message;

  if (ibkrStatus === 'sidecar_offline') {
    return {
      connected: false,
      label: 'sidecar offline',
      title: 'IBKR sidecar unreachable on :8765 — run npm run ibkr-sidecar',
      warn: 'Sidecar offline — run npm run ibkr-sidecar',
    };
  }

  if (ibkrStatus === 'tws_offline') {
    return {
      connected: false,
      label: 'gateway offline',
      title: 'IB Gateway not connected — log in with socket API enabled (live :4001, paper :4002)',
      warn: ibkrMsg || 'IB Gateway offline — check login and port (live :4001, paper :4002)',
    };
  }

  return {
    connected: false,
    label: 'offline',
    title: ibkrMsg || 'IBKR offline — log into IB Gateway, then npm run ibkr-sidecar',
    warn: ibkrMsg || null,
  };
}

export const OFFLINE_PORTFOLIO_HINT =
  'Connect IB Gateway (live :4001, paper :4002), run npm run ibkr-sidecar, then npm run dev for live portfolio data.';

/**
 * Sidebar banner below NLV — offline setup vs empty connected account.
 * @returns {{ type: 'offline' | 'empty', message: string } | null}
 */
export function getPortfolioSidebarBanner({ portfolioData, selectedAccount }) {
  const dataSource = portfolioData?.dataSource;
  const isOffline = dataSource === 'ibkr_offline';
  const isEmptyAccount =
    !isOffline && dataSource === 'ibkr_api' && portfolioData?.empty;

  if (isOffline) {
    return { type: 'offline', message: OFFLINE_PORTFOLIO_HINT };
  }

  if (isEmptyAccount) {
    const acct = selectedAccount || portfolioData?.accountId || 'this account';
    return {
      type: 'empty',
      message: `No positions in ${acct}. Switch accounts to see exposure.`,
    };
  }

  return null;
}
