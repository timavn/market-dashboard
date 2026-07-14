const { sidecarRequest } = require('../ibkrSidecarClient');
const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');

jest.mock('../ibkrSidecarClient', () => ({
  sidecarRequest: jest.fn(),
  getSidecarProviderStatus: jest.fn().mockResolvedValue({ connected: true }),
}));

describe('ibkrPortfolioDataProvider side counts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds summary counts from market value first, quantity fallback', async () => {
    sidecarRequest.mockImplementation(async (path) => {
      if (path.startsWith('/cache/portfolio')) {
        return {
          ok: true,
          fetched_at: '2026-06-14T12:00:00Z',
          positions: [
            { account: 'U1', symbol: 'LONG_BY_VALUE', position: -100, marketValue: 5000, secType: 'STK' },
            { account: 'U1', symbol: 'SHORT_BY_VALUE', position: 100, marketValue: -2500, secType: 'STK' },
            { account: 'U1', symbol: 'LONG_BY_QTY', position: 10, marketValue: 0, secType: 'STK' },
            { account: 'U1', symbol: 'SHORT_BY_QTY', position: -20, marketValue: 0, secType: 'STK' },
            { account: 'U1', symbol: 'CLOSED', position: 0, marketValue: 0, secType: 'STK' },
          ],
        };
      }

      if (path.startsWith('/cache/account-summary')) {
        return { ok: false };
      }

      if (path.startsWith('/portfolio/account-summary')) {
        return { ok: false };
      }

      if (path.startsWith('/portfolio/pnl')) {
        return { ok: false };
      }

      return { ok: true };
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.summary.longCount).toBe(2);
    expect(snapshot.summary.shortCount).toBe(2);
    expect(snapshot.summary.positionCount).toBe(4);
    expect(snapshot.holdings.map((holding) => holding.symbol)).not.toContain('CLOSED');
  });

  test('requests quote enrichment only for positions missing market value', async () => {
    sidecarRequest.mockImplementation(async (path) => {
      if (path.startsWith('/cache/portfolio')) {
        return {
          ok: true,
          fetched_at: '2026-06-14T12:00:00Z',
          positions: [
            { account: 'U1', symbol: 'PRICED', position: 5, marketValue: 500, secType: 'STK' },
            { account: 'U1', symbol: 'MISSING', position: 10, marketValue: null, secType: 'STK' },
          ],
        };
      }

      if (path.startsWith('/cache/account-summary')) return { ok: false };
      if (path.startsWith('/portfolio/account-summary')) return { ok: false };
      if (path.startsWith('/portfolio/pnl')) return { ok: false };
      return { ok: true };
    });

    const quoteFn = jest.fn().mockResolvedValue({
      MISSING: { mark: 12, source: 'yahoo', timestamp: '2026-06-14T12:00:00Z' },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1', quoteFn);

    expect(quoteFn).toHaveBeenCalledWith(['MISSING']);
    expect(snapshot.holdings.find((holding) => holding.symbol === 'PRICED').marketValue).toBe(500);
    expect(snapshot.holdings.find((holding) => holding.symbol === 'MISSING').marketValue).toBe(120);
  });
});
