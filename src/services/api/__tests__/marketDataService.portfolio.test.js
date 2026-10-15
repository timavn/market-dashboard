const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    post: mockPost,
    interceptors: {
      response: {
        use: jest.fn(),
      },
    },
  })),
}));

const { MarketDataService } = require('../marketDataService');

function portfolioResponse() {
  return {
    data: {
      summary: {
        totalValue: 195000,
        totalDayChange: 0,
        totalDayChangePercent: '0.00',
        totalGainLoss: 0,
        totalGainLossPercent: '0.00',
        positionCount: 0,
        longCount: 0,
        shortCount: 0,
      },
      holdings: [],
      dataSource: 'ibkr_api',
      accountId: 'U1',
      fetchedAt: '2026-08-06T20:00:00.000Z',
      accountSummary: {
        netLiquidation: 195000,
        currency: 'USD',
      },
      liveSessionVerified: true,
      fromCache: false,
    },
  };
}

function balanceResponse(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    data: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      accountId: 'U1',
      observedAt,
      socketVerifiedAt: observedAt,
      accountValuesObservedAt: observedAt,
      fromCache: false,
      cash: { noBorrowBalance: 12000 },
      exposure: {
        available: true,
        status: 'live',
        netLiquidation: 195000,
        longMarketValue: 195000,
        shortMarketValue: 100000,
      },
      margin: {
        available: true,
        status: 'live',
        source: 'ibkr_live_session',
        health: 'healthy',
        availableFunds: 110000,
        excessLiquidity: 115000,
        buyingPower: 380000,
      },
      interestExposure: {
        available: true,
        status: 'live',
        source: 'ibkr_live_session',
        actionable: false,
        current: { estimatedDebitPrincipal: 16000 },
        projected: { estimatedDebitPrincipal: 17000 },
        policy: {
          estimatedDebitPrincipalAfterReserve: 20000,
          totalReserve: 3000,
        },
      },
      capacity: { available: true, status: 'live' },
      ...overrides,
    },
  };
}

describe('MarketDataService portfolio balance', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  test('legacy statement envelopes keep unknown daily changes and unsupported analytics unavailable', async () => {
    mockGet.mockResolvedValue({ data: {
      snapshot: { timestamp: '2026-08-31T20:00:00Z', summary: {
        totalValue: 1000, totalCostBasis: 900, totalGainLoss: 100, totalGainLossPercent: 11.11, positionCount: 1,
      } },
      holdings: [{ symbol: 'SPY', marketValue: 800 }],
    } });
    const result = await MarketDataService.getPortfolio();
    expect(result.summary.totalDayChange).toBeNull();
    expect(result.summary.totalDayChangePercent).toBeNull();
    expect(result.riskMetrics).toEqual({ volatility: null, sharpeRatio: null, sortinoRatio: null, var95: null, maxDrawdown: null });
    expect(result.factorExposures.marketCap).toEqual({ largeCap: null, midCap: null, smallCap: null });
    expect(result.analyticsAvailability.available).toBe(false);
    expect(result.topHoldings[0].accountPercent).toBe('80.00');
    expect(result.fetchedAt).toBe('2026-08-31T20:00:00Z');
  });

  test('keeps the slower portfolio model independent of the balance endpoint', async () => {
    const response = portfolioResponse();
    mockGet.mockResolvedValue(response);

    const result = await MarketDataService.getPortfolio({ account: 'U1' });

    expect(result.accountSummary.netLiquidation).toBe(195000);
    expect(result.fetchedAt).toBe('2026-08-06T20:00:00.000Z');
    expect(result.lastUpdated).toBe('2026-08-06T20:00:00.000Z');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/portfolio',
      expect.objectContaining({ params: { account: 'U1' } }),
    );
  });

  test('accepts a fresh account-matched, no-cache balance response', async () => {
    mockGet.mockResolvedValue(balanceResponse());

    const result = await MarketDataService.getPortfolioBalance({ account: 'U1' });

    expect(result.cash.noBorrowBalance).toBe(12000);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/portfolio/balance',
      expect.objectContaining({ params: { account: 'U1' }, timeout: 25_000 }),
    );
  });

  test('accepts live exposure when exact capacity is unavailable', async () => {
    mockGet.mockResolvedValue(balanceResponse({
      cash: null,
      buffer: null,
      capacity: {
        available: false,
        status: 'unavailable',
        reason: 'short_position_evidence_missing',
      },
    }));

    const result = await MarketDataService.getPortfolioBalance({ account: 'U1' });

    expect(result.exposure.longMarketValue).toBe(195000);
    expect(result.capacity.available).toBe(false);
  });

  test.each([
    ['cached', { fromCache: true }],
    ['wrong account', { accountId: 'U2' }],
    ['wrong source', { source: 'uploaded_statement' }],
    ['stale', {
      observedAt: new Date(Date.now() - 46_000).toISOString(),
      socketVerifiedAt: new Date(Date.now() - 46_000).toISOString(),
      accountValuesObservedAt: new Date(Date.now() - 46_000).toISOString(),
    }],
  ])('rejects %s balance data', async (_label, overrides) => {
    mockGet.mockResolvedValue(balanceResponse(overrides));

    await expect(MarketDataService.getPortfolioBalance({ account: 'U1' }))
      .rejects.toThrow(/not verified live/i);
  });

  test('accepts a verified read-only preview response', async () => {
    const observedAt = new Date().toISOString();
    mockPost.mockResolvedValue({
      data: {
        available: true,
        status: 'preview',
        source: 'ibkr_live_session',
        accountId: 'U1',
        observedAt,
        fromCache: false,
        orderSubmitted: false,
      },
    });

    const result = await MarketDataService.previewPortfolioBalance({
      accountId: 'U1',
      action: 'add_long',
      amount: 1000,
    });

    expect(result.orderSubmitted).toBe(false);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/portfolio/balance/preview',
      { accountId: 'U1', action: 'add_long', amount: 1000 },
      { timeout: 30_000 },
    );
  });

  test('requests the account-scoped interest ledger without cache fallbacks', async () => {
    mockGet.mockResolvedValue({
      data: {
        source: 'ibkr_verified_interest_ledger',
        available: true,
        accountId: 'U1',
        fromCache: false,
      },
    });

    const result = await MarketDataService.getIbkrInterestValidationLedger({ account: 'U1' });

    expect(result.accountId).toBe('U1');
    expect(mockGet).toHaveBeenCalledWith(
      '/api/ibkr/interest-validation/ledger',
      expect.objectContaining({ params: { account: 'U1' }, timeout: 30_000 }),
    );
    await expect(MarketDataService.getIbkrInterestValidationLedger({ account: '' }))
      .rejects.toThrow(/account is required/i);
  });

  test('can request a fresh live balance checkpoint with interest status', async () => {
    mockGet.mockResolvedValue({
      data: {
        source: 'ibkr_interest_validation',
        available: true,
      },
    });

    const result = await MarketDataService.getIbkrInterestValidationStatus({
      account: 'U1',
      refreshLive: true,
    });

    expect(result.available).toBe(true);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/ibkr/interest-validation/status',
      expect.objectContaining({
        params: { account: 'U1', refreshLive: 1 },
      }),
    );
  });

  test('preserves unavailable portfolio totals instead of rendering them as zero', async () => {
    const response = portfolioResponse();
    response.data.summary = {
      ...response.data.summary,
      totalValue: null,
      totalDayChange: null,
      totalDayChangePercent: null,
      totalGainLoss: null,
      totalGainLossPercent: null,
    };
    mockGet.mockResolvedValue(response);

    const result = await MarketDataService.getPortfolio({ account: 'U1' });

    expect(result.summary).toMatchObject({
      totalValue: null,
      totalDayChange: null,
      totalDayChangePercent: null,
      totalGainLoss: null,
      totalGainLossPercent: null,
    });
  });

  test('requests cached or forced login status with a bounded client timeout', async () => {
    mockGet.mockResolvedValue({ data: { version: 1, service: { id: 'logins' } } });

    await MarketDataService.getLoginStatus();
    expect(mockGet).toHaveBeenLastCalledWith('/api/login-status', {
      params: {},
      timeout: 15_000,
    });

    await MarketDataService.getLoginStatus({ refresh: true });
    expect(mockGet).toHaveBeenLastCalledWith('/api/login-status', {
      params: { refresh: 1 },
      timeout: 15_000,
    });
  });

  test('sends only the fixed login action ID and confirmation header', async () => {
    mockPost.mockResolvedValue({ data: { accepted: true } });

    await expect(MarketDataService.runLoginAction('aws-admin-login'))
      .resolves.toEqual({ accepted: true });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/login-status/actions/aws-admin-login',
      {},
      { headers: { 'X-Login-Action': '1' }, timeout: 15_000 },
    );
    await expect(MarketDataService.runLoginAction('')).rejects.toThrow(/required/i);
  });
});
