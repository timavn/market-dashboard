import {
  getIbkrConnectionDisplay,
  getPortfolioOfflinePanel,
  getPortfolioSidebarBanner,
  OFFLINE_SETUP_STEPS,
} from './ibkrConnectionStatus';

describe('getIbkrConnectionDisplay', () => {
  it('returns connected when ibkr.connected is true', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: true } },
      error: null,
    });
    expect(result.connected).toBe(true);
    expect(result.label).toBe('Live');
  });

  it('returns backend offline on network errors', () => {
    const result = getIbkrConnectionDisplay({
      status: null,
      error: 'Network Error',
    });
    expect(result.label).toBe('Backend offline');
    expect(result.kind).toBe('backend_offline');
  });

  it('returns sidecar offline when status is sidecar_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'sidecar_offline' } },
      error: null,
    });
    expect(result.label).toBe('Sidecar offline');
  });

  it('returns gateway offline when status is tws_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'tws_offline' } },
      error: null,
    });
    expect(result.label).toBe('Gateway offline');
    expect(result.title).toMatch(/Gateway/);
  });
});

describe('OFFLINE_SETUP_STEPS', () => {
  it('lists gateway and sidecar steps only', () => {
    expect(OFFLINE_SETUP_STEPS).toHaveLength(2);
    expect(OFFLINE_SETUP_STEPS[0].label).toMatch(/Gateway/);
    expect(OFFLINE_SETUP_STEPS[1].label).toMatch(/ibkr-sidecar/);
  });
});

describe('getPortfolioOfflinePanel', () => {
  it('shows sync hint when IBKR connected but portfolio offline', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: true, kind: 'connected' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.syncPending).toBe(true);
    expect(panel.steps).toBeNull();
    expect(panel.heading).toMatch(/refresh/i);
  });

  it('shows setup steps when sidecar offline', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: false, kind: 'sidecar_offline' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.syncPending).toBe(false);
    expect(panel.steps).toHaveLength(2);
    expect(panel.steps[0].done).toBe(true);
    expect(panel.steps[1].done).toBe(false);
  });
});

describe('getPortfolioSidebarBanner', () => {
  it('returns null for ibkr_offline (setup card handles offline UI)', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_offline', empty: true },
      selectedAccount: 'U123',
    });
    expect(result).toBeNull();
  });

  it('returns empty banner for connected account with no positions', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: true, accountId: 'U25779973' },
      selectedAccount: 'U25779973',
    });
    expect(result?.type).toBe('empty');
    expect(result?.message).toMatch(/U25779973/);
    expect(result?.message).not.toMatch(/Connect IB Gateway/);
  });

  it('returns null when connected with holdings', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: false },
      selectedAccount: 'U25465536',
    });
    expect(result).toBeNull();
  });

  it('does not treat ibkr_api empty as offline', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: true },
      selectedAccount: 'U25779973',
    });
    expect(result?.type).toBe('empty');
  });
});
