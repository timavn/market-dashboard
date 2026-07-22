const { sidecarRequest } = require('../ibkrSidecarClient');
const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');

jest.mock('../ibkrSidecarClient', () => ({
  sidecarRequest: jest.fn(),
  getSidecarProviderStatus: jest.fn().mockResolvedValue({ connected: true }),
}));

function liveEvidence(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    connected: true,
    status: 'live',
    source: 'ibkr_live_session',
    accounts: ['U1'],
    positions: [],
    observed_at: observedAt,
    socket_verified_at: observedAt,
    ...overrides,
  };
}

function installLiveMocks({ positions = [], summary = { NetLiquidation: 190539.25 } } = {}) {
  sidecarRequest.mockImplementation(async (requestPath) => {
    if (requestPath === '/portfolio/live-positions') {
      return liveEvidence({ positions });
    }
    if (requestPath === '/accounts') {
      return { ok: true, accounts: ['U1'], fetched_at: new Date().toISOString() };
    }
    if (requestPath.startsWith('/portfolio/live-account-summary')) {
      return liveEvidence({
        account: 'U1',
        summary: { account: 'U1', currency: 'USD', ...summary },
      });
    }
    if (requestPath.startsWith('/portfolio/pnl')) return { ok: true, pnl: null };
    throw new Error(`Unexpected sidecar request: ${requestPath}`);
  });
}

describe('ibkrPortfolioDataProvider live-session integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds side counts only from a fresh socket-verified position snapshot', async () => {
    installLiveMocks({
      positions: [
        { account: 'U1', symbol: 'LONG_A', position: 10, secType: 'STK' },
        { account: 'U1', symbol: 'SHORT_A', position: -20, secType: 'STK' },
        { account: 'U1', symbol: 'CLOSED', position: 0, secType: 'STK' },
      ],
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fromCache: false,
      summary: { longCount: 1, shortCount: 1, positionCount: 2 },
    });
    expect(snapshot.holdings.map((holding) => holding.symbol)).not.toContain('CLOSED');
    expect(snapshot.holdings.every((holding) => holding.positionSource === 'ibkr_live_session')).toBe(true);
    expect(sidecarRequest.mock.calls.some(([requestPath]) => requestPath.startsWith('/cache/'))).toBe(false);
  });

  test('does not enrich missing IBKR values with cached or fallback quotes', async () => {
    installLiveMocks({
      positions: [{ account: 'U1', symbol: 'MISSING', position: 10, secType: 'STK' }],
    });
    const quoteFn = jest.fn().mockResolvedValue({
      MISSING: { mark: 12, source: 'yahoo', timestamp: new Date().toISOString() },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1', quoteFn);

    expect(quoteFn).not.toHaveBeenCalled();
    expect(snapshot.holdings[0]).toMatchObject({
      price: null,
      marketValue: null,
      priceSource: null,
      warning: 'missing_market_value',
    });
    expect(snapshot.dataQuality.status).toBe('partial');
  });

  test('accepts a verified empty portfolio and uses only live account-summary NLV', async () => {
    installLiveMocks();

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      holdings: [],
      liveSessionVerified: true,
      fromCache: false,
      accountSummary: {
        netLiquidation: 190539.25,
        source: 'ibkr_live_session',
      },
      summary: { totalValue: 190539.25, positionCount: 0 },
    });
    expect(sidecarRequest).toHaveBeenCalledWith('/portfolio/live-account-summary?account=U1');
  });

  test('fails closed on stale or unverified position evidence', async () => {
    sidecarRequest.mockResolvedValueOnce(liveEvidence({
      observed_at: '2026-07-15T12:00:00.000Z',
      socket_verified_at: '2026-07-15T12:00:00.000Z',
      positions: [{ account: 'U1', symbol: 'STALE', position: 1 }],
    }));

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      holdings: [],
      liveSessionVerified: false,
      accountSummary: null,
    });
    expect(snapshot.error).toMatch(/fresh socket-verified/i);
    expect(sidecarRequest).toHaveBeenCalledTimes(1);
  });

  test('never returns a prior PnL value after the live request stops producing data', async () => {
    let pnlAvailable = true;
    sidecarRequest.mockImplementation(async (requestPath) => {
      if (requestPath === '/accounts') return { ok: true, accounts: ['U1'] };
      if (requestPath.startsWith('/portfolio/pnl')) {
        return pnlAvailable
          ? liveEvidence({ account: 'U1', pnl: { dailyPnL: 25, dailyPnLPercent: 9.9 } })
          : { ok: false, pnl: null };
      }
      throw new Error(`Unexpected sidecar request: ${requestPath}`);
    });

    expect(await ibkrPortfolio.getPnL('U1')).toMatchObject({
      dailyPnL: 25,
      dailyPnLPercent: null,
      source: 'ibkr_live_session',
      fromCache: false,
    });
    pnlAvailable = false;
    expect(await ibkrPortfolio.getPnL('U1')).toBeNull();
  });
});
