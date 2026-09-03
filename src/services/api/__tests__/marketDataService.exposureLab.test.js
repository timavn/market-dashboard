const mockGet = jest.fn();
const mockPut = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    put: mockPut,
    post: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  })),
}));

const { MarketDataService } = require('../marketDataService');

describe('MarketDataService Exposure Lab', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
  });

  test('loads the complete archive universe through the dedicated read-only endpoint', async () => {
    mockGet.mockResolvedValue({ data: { status: 'available', rows: [{ ticker: 'SPY' }] } });

    const result = await MarketDataService.getExposureLabUniverse({ forceRefresh: true });

    expect(result.rows).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/risk/exposure-lab/universe',
      expect.objectContaining({ params: { forceRefresh: 'true' }, timeout: 120000 }),
    );
  });

  test('loads an account-scoped factor snapshot with the extended research timeout', async () => {
    mockGet.mockResolvedValue({ data: { status: 'available', executable: false } });

    const result = await MarketDataService.getExposureLabSnapshot({ account: 'U1' });

    expect(result.executable).toBe(false);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/risk/exposure-lab/snapshot',
      expect.objectContaining({
        params: { account: 'U1', forceRefresh: undefined },
        timeout: 120000,
      }),
    );
  });

  test('writes a versioned security review through the audited security-master endpoint', async () => {
    const review = {
      identityStatus: 'verified',
      canonicalSymbol: 'ABNB',
      instrumentType: 'STK',
      geography: {
        basis: 'country_of_risk',
        allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Issuer filing',
        sourceAsOf: '2026-06-30',
      },
      analysisEligible: true,
      hedgeEligible: false,
      reviewedBy: 'Risk PM',
      reviewReason: 'Matched issuer and listing.',
      expectedVersion: 0,
    };
    mockPut.mockResolvedValue({ data: { status: 'available', auditRecorded: true } });

    const result = await MarketDataService.saveExposureLabSecurityReview('abnb', review);

    expect(result.auditRecorded).toBe(true);
    expect(mockPut).toHaveBeenCalledWith(
      '/api/risk/exposure-lab/security-master/ABNB',
      review,
    );
  });
});
