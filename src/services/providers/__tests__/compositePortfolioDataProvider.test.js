const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');
const { createCompositePortfolioDataProvider } = require('../compositePortfolioDataProvider');

jest.mock('../ibkr/ibkrPortfolioDataProvider');
jest.mock('../../ibkr/ibkrStreamBridge', () => ({
  getCachedCanonical: jest.fn().mockReturnValue(null),
}));
jest.mock('../ibkrSidecarClient', () => ({
  sidecarRequest: jest.fn().mockResolvedValue({ ok: true, quotes: [] }),
}));

describe('compositePortfolioDataProvider', () => {
  const uploadProvider = {
    getPortfolioSnapshot: jest.fn(),
    getProviderStatus: jest.fn().mockResolvedValue({ name: 'upload', connected: true }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.IBKR_PREFER_UPLOAD;
  });

  it('prefers IBKR when connected', async () => {
    ibkrPortfolio.ENABLED = true;
    ibkrPortfolio.getProviderStatus.mockResolvedValue({ connected: true });
    ibkrPortfolio.getPortfolioSnapshot.mockResolvedValue({
      holdings: [
        {
          symbol: 'AAPL',
          description: 'AAPL',
          quantity: 1,
          price: 100,
          marketValue: 100,
          costBasis: 90,
          gainLoss: 10,
          gainLossPercent: 11,
          assetType: 'STK',
          assetClass: 'Equities',
          positionSource: 'ibkr_api',
          priceSource: 'ibkr',
        },
      ],
      summary: { totalValue: 100, positionCount: 1, longCount: 1, shortCount: 0 },
      fetchedAt: new Date().toISOString(),
      dataSource: 'ibkr_api',
    });
    uploadProvider.getPortfolioSnapshot.mockResolvedValue({
      holdings: [],
      empty: true,
      dataSource: 'uploaded_statement',
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot();
    expect(snap.dataSource).toBe('ibkr_api');
  });

  it('uses upload when source=upload', async () => {
    ibkrPortfolio.getProviderStatus.mockResolvedValue({ connected: true });
    uploadProvider.getPortfolioSnapshot.mockResolvedValue({
      holdings: [{ symbol: 'MSFT', positionSource: 'uploaded_statement', marketValue: 500 }],
      summary: { totalValue: 500, positionCount: 1 },
      empty: false,
      dataSource: 'uploaded_statement',
      timestamp: '2026-05-19T12:00:00Z',
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot(null, { source: 'upload' });
    expect(snap.dataSource).toBe('uploaded_statement');
  });

  it('returns ibkr_offline when Gateway disconnected', async () => {
    ibkrPortfolio.ENABLED = true;
    ibkrPortfolio.getProviderStatus.mockResolvedValue({ connected: false });
    uploadProvider.getPortfolioSnapshot.mockResolvedValue({
      holdings: [{ symbol: 'MSFT' }],
      empty: false,
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot();
    expect(snap.dataSource).toBe('ibkr_offline');
    expect(uploadProvider.getPortfolioSnapshot).not.toHaveBeenCalled();
  });

  it('returns account summary when IBKR has no positions but NLV exists', async () => {
    ibkrPortfolio.ENABLED = true;
    ibkrPortfolio.getProviderStatus.mockResolvedValue({ connected: true });
    ibkrPortfolio.getPortfolioSnapshot.mockResolvedValue({
      holdings: [],
      accountSummary: {
        netLiquidation: 197478.25,
        totalCashValue: 30852.65,
        currency: 'USD',
      },
      accountId: 'U25779973',
      summary: { totalValue: 197478.25, positionCount: 0, longCount: 0, shortCount: 0 },
      fetchedAt: new Date().toISOString(),
      dataSource: 'ibkr_api',
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U25779973');
    expect(snap.dataSource).toBe('ibkr_api');
    expect(snap.empty).toBe(false);
    expect(snap.accountSummary.netLiquidation).toBe(197478.25);
    expect(snap.holdings).toHaveLength(0);
  });
});
