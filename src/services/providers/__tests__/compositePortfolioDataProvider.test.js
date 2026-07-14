const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');
const compositeMarketData = require('../compositeMarketDataProvider');
const { createCompositePortfolioDataProvider } = require('../compositePortfolioDataProvider');

jest.mock('../ibkr/ibkrPortfolioDataProvider');
jest.mock('../compositeMarketDataProvider', () => ({
  getCanonicalQuote: jest.fn(),
}));
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
    compositeMarketData.getCanonicalQuote.mockResolvedValue(null);
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
    ibkrPortfolio.getPortfolioSnapshot.mockResolvedValue({
      error: 'Gateway disconnected',
      holdings: [],
      accountSummary: null,
      summary: { totalValue: 0, positionCount: 0 },
    });
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

  it('uses fallback market quotes for IBKR holdings missing cache marks', async () => {
    ibkrPortfolio.ENABLED = true;
    compositeMarketData.getCanonicalQuote.mockResolvedValue({
      symbol: 'CLOX',
      mark: 25.59,
      source: 'yahoo',
      warning: 'ibkr: invalid_quote; delayed_data',
      timestamp: '2026-06-18T18:40:29.008Z',
      valid: true,
    });
    ibkrPortfolio.getPortfolioSnapshot.mockImplementation(async (accountId, quoteFn) => {
      const quotes = await quoteFn(['CLOX']);
      const quote = quotes.CLOX;
      return {
        holdings: [
          {
            symbol: 'CLOX',
            description: 'CLOX',
            quantity: 10,
            price: quote?.mark ?? null,
            marketValue: quote?.mark != null ? quote.mark * 10 : null,
            costBasis: null,
            gainLoss: null,
            gainLossPercent: null,
            assetType: 'STK',
            assetClass: 'Equities',
            positionSource: 'ibkr_api',
            priceSource: quote?.source || null,
            warning: quote?.warning || 'missing_market_value',
          },
        ],
        summary: { totalValue: 255.9, positionCount: 1, longCount: 1, shortCount: 0 },
        dataQuality: { status: 'ok', missingMarketValueCount: 0, warnings: [] },
        fetchedAt: '2026-06-18T18:40:30.000Z',
        dataSource: 'ibkr_api',
      };
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U1');

    expect(compositeMarketData.getCanonicalQuote).toHaveBeenCalledWith('CLOX');
    expect(snap.holdings[0].marketValue).toBeCloseTo(255.9);
    expect(snap.holdings[0].priceSource).toBe('yahoo');
    expect(snap.holdings[0].warning).toContain('delayed_data');
    expect(snap.dataQuality.status).toBe('ok');
  });

  it('keeps partial marks when cache and fallback quotes both fail', async () => {
    ibkrPortfolio.ENABLED = true;
    compositeMarketData.getCanonicalQuote.mockResolvedValue(null);
    ibkrPortfolio.getPortfolioSnapshot.mockImplementation(async (accountId, quoteFn) => {
      const quotes = await quoteFn(['CLOX']);
      return {
        holdings: [
          {
            symbol: 'CLOX',
            description: 'CLOX',
            quantity: 10,
            price: quotes.CLOX?.mark ?? null,
            marketValue: null,
            assetType: 'STK',
            assetClass: 'Equities',
            positionSource: 'ibkr_api',
            priceSource: null,
            warning: 'missing_market_value',
          },
        ],
        summary: { totalValue: 1000, positionCount: 1, longCount: 1, shortCount: 0 },
        dataQuality: {
          status: 'partial',
          missingMarketValueCount: 1,
          missingMarketValueSymbols: ['CLOX'],
          warnings: ['IBKR missing market values for CLOX'],
        },
        fetchedAt: '2026-06-18T18:40:30.000Z',
        dataSource: 'ibkr_api',
      };
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U1');

    expect(compositeMarketData.getCanonicalQuote).toHaveBeenCalledWith('CLOX');
    expect(snap.holdings[0].marketValue).toBeNull();
    expect(snap.dataQuality.status).toBe('partial');
  });
});
