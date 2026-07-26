const mockGet = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    post: jest.fn(),
    interceptors: {
      response: {
        use: jest.fn(),
      },
    },
  })),
}));

const { MarketDataService } = require('../marketDataService');

function portfolioResponse(fundingUnavailableReason) {
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
      accountSummary: {
        netLiquidation: 195000,
        currency: 'USD',
      },
      funding: null,
      fundingUnavailableReason,
      liveSessionVerified: true,
      fromCache: false,
    },
  };
}

describe('MarketDataService portfolio funding reason', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  test('propagates the allowlisted unsettled reason to the browser model', async () => {
    mockGet.mockResolvedValue(
      portfolioResponse('unsettled_securities_activity'),
    );

    const result = await MarketDataService.getPortfolio({ account: 'U1' });

    expect(result.funding).toBeNull();
    expect(result.fundingUnavailableReason).toBe(
      'unsettled_securities_activity',
    );
  });

  test('propagates the allowlisted non-settlement-day reason', async () => {
    const response = portfolioResponse('non_settlement_day');
    response.data.fundingReference = {
      referenceOnly: true,
      actionable: false,
      source: 'ibkr_completed_session_reference',
    };
    mockGet.mockResolvedValue(response);

    const result = await MarketDataService.getPortfolio({ account: 'U1' });

    expect(result.funding).toBeNull();
    expect(result.fundingReference).toEqual(
      response.data.fundingReference,
    );
    expect(result.fundingUnavailableReason).toBe('non_settlement_day');
  });

  test('drops arbitrary server-provided funding reason text', async () => {
    mockGet.mockResolvedValue(
      portfolioResponse('broker balance 12345 is unavailable'),
    );

    const result = await MarketDataService.getPortfolio({ account: 'U1' });

    expect(result.fundingUnavailableReason).toBeNull();
    expect(JSON.stringify(result)).not.toContain('12345');
  });

  test('preserves unavailable portfolio totals instead of rendering them as zero', async () => {
    const response = portfolioResponse(null);
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
});
