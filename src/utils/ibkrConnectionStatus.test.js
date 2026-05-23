import {
  getIbkrConnectionDisplay,
  getPortfolioSidebarBanner,
  OFFLINE_PORTFOLIO_HINT,
} from './ibkrConnectionStatus';

describe('getIbkrConnectionDisplay', () => {
  it('returns connected when ibkr.connected is true', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: true } },
      error: null,
    });
    expect(result.connected).toBe(true);
    expect(result.label).toBe('connected');
  });

  it('returns backend offline on network errors', () => {
    const result = getIbkrConnectionDisplay({
      status: null,
      error: 'Network Error',
    });
    expect(result.label).toBe('backend offline');
    expect(result.warn).toMatch(/Backend unreachable/);
  });

  it('returns sidecar offline when status is sidecar_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'sidecar_offline' } },
      error: null,
    });
    expect(result.label).toBe('sidecar offline');
  });

  it('returns gateway offline when status is tws_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'tws_offline' } },
      error: null,
    });
    expect(result.label).toBe('gateway offline');
    expect(result.title).toMatch(/4001/);
  });
});

describe('OFFLINE_PORTFOLIO_HINT', () => {
  it('mentions live and paper ports', () => {
    expect(OFFLINE_PORTFOLIO_HINT).toMatch(/4001/);
    expect(OFFLINE_PORTFOLIO_HINT).toMatch(/4002/);
  });
});

describe('getPortfolioSidebarBanner', () => {
  it('returns offline banner for ibkr_offline', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_offline', empty: true },
      selectedAccount: 'U123',
    });
    expect(result?.type).toBe('offline');
    expect(result?.message).toBe(OFFLINE_PORTFOLIO_HINT);
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
    expect(result?.type).not.toBe('offline');
  });
});
