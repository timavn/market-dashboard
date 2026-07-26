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
          avgCost: 90,
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
      liveSessionVerified: true,
    });
    uploadProvider.getPortfolioSnapshot.mockResolvedValue({
      holdings: [],
      empty: true,
      dataSource: 'uploaded_statement',
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot();
    expect(snap.dataSource).toBe('ibkr_api');
    expect(snap.holdings[0].avgCost).toBe(90);
  });

  it('preserves reference-mark warmup provenance for row-level status rendering', async () => {
    ibkrPortfolio.ENABLED = true;
    ibkrPortfolio.getPortfolioSnapshot.mockResolvedValue({
      holdings: [
        {
          symbol: 'AAPL',
          description: 'AAPL',
          quantity: 1,
          price: null,
          marketValue: null,
          costBasis: 90,
          gainLoss: null,
          gainLossPercent: null,
          assetType: 'STK',
          assetClass: 'Equities',
          positionSource: 'ibkr_live_session',
          priceSource: null,
          priceState: 'unavailable',
          marketValueState: 'unavailable',
          markPending: true,
          markWarmState: 'warming',
          warning: 'reference_mark_warming',
        },
      ],
      summary: { totalValue: 100, positionCount: 1, longCount: 1, shortCount: 0 },
      fetchedAt: new Date().toISOString(),
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U1');

    expect(snap.holdings[0]).toMatchObject({
      priceState: 'unavailable',
      marketValueState: 'unavailable',
      markPending: true,
      markWarmState: 'warming',
      warning: 'reference_mark_warming',
    });
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
      liveSessionVerified: true,
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U25779973');
    expect(snap.dataSource).toBe('ibkr_api');
    expect(snap.empty).toBe(false);
    expect(snap.accountSummary.netLiquidation).toBe(197478.25);
    expect(snap.holdings).toHaveLength(0);
  });

  it('never supplies a cache/Yahoo quote fallback to the active IBKR snapshot', async () => {
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
      expect(quoteFn).toBeUndefined();
      return {
        holdings: [
          {
            symbol: 'CLOX',
            description: 'CLOX',
            quantity: 10,
            price: null,
            marketValue: null,
            costBasis: null,
            gainLoss: null,
            gainLossPercent: null,
            assetType: 'STK',
            assetClass: 'Equities',
            positionSource: 'ibkr_api',
            priceSource: null,
            warning: 'missing_market_value',
          },
        ],
        summary: { totalValue: 0, positionCount: 1, longCount: 1, shortCount: 0 },
        dataQuality: { status: 'partial', missingMarketValueCount: 1, warnings: ['missing'] },
        fetchedAt: '2026-06-18T18:40:30.000Z',
        dataSource: 'ibkr_api',
        liveSessionVerified: true,
      };
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U1');

    expect(compositeMarketData.getCanonicalQuote).not.toHaveBeenCalled();
    expect(snap.holdings[0].marketValue).toBeNull();
    expect(snap.holdings[0].priceSource).toBeNull();
    expect(snap.dataQuality.status).toBe('partial');
  });

  it('rejects an IBKR-shaped snapshot without socket-verification proof', async () => {
    ibkrPortfolio.ENABLED = true;
    compositeMarketData.getCanonicalQuote.mockResolvedValue(null);
    ibkrPortfolio.getPortfolioSnapshot.mockResolvedValue({
        holdings: [
          {
            symbol: 'CLOX',
            description: 'CLOX',
            quantity: 10,
            price: null,
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
        liveSessionVerified: false,
    });

    const composite = createCompositePortfolioDataProvider(uploadProvider);
    const snap = await composite.getPortfolioSnapshot('U1');

    expect(compositeMarketData.getCanonicalQuote).not.toHaveBeenCalled();
    expect(snap).toMatchObject({
      dataSource: 'ibkr_offline',
      liveSessionVerified: false,
      holdings: [],
    });
  });
});
