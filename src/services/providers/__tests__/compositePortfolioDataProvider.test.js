const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');
const { createCompositePortfolioDataProvider } = require('../compositePortfolioDataProvider');

jest.mock('../ibkr/ibkrPortfolioDataProvider');
jest.mock('../compositeMarketDataProvider', () => ({
  getCanonicalQuote: jest.fn().mockResolvedValue({ mark: 189, source: 'ibkr', valid: true }),
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

  it('uses upload when IBKR_PREFER_UPLOAD', async () => {
    process.env.IBKR_PREFER_UPLOAD = 'true';
    ibkrPortfolio.getProviderStatus.mockResolvedValue({ connected: true });
    uploadProvider.getPortfolioSnapshot.mockResolvedValue({
      holdings: [{ symbol: 'MSFT', positionSource: 'uploaded_statement' }],
      summary: { totalValue: 500 },
      empty: false,
      dataSource: 'uploaded_statement',
      timestamp: '2026-05-19T12:00:00Z',
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot();
    expect(snap.dataSource).toBe('uploaded_statement');
  });
});
