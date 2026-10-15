const { buildIbkrAccountCoverage } = require('../utils/ibkrAccountCoverage.cjs');

describe('provider account coverage', () => {
  const envKeys = [
    'PREDICTION_MARKET_PERFORMANCE_ACCOUNT_ID',
    'IBKR_ACCOUNT_ID',
    'IBKR_FLEX_EXPECTED_ACCOUNT_ID',
    'IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    envKeys.forEach((key) => {
      if (originalEnv[key] == null) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
  });

  test('expects only the configured Contract P&L account even when Flex covers Roth history', () => {
    process.env.PREDICTION_MARKET_PERFORMANCE_ACCOUNT_ID = 'U25779973';
    process.env.IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS = 'U25779973,U25465536';
    const coverage = buildIbkrAccountCoverage({
      ibkr: { connected: true, accounts: ['U25779973'] },
    }, {
      ibkr: { connected: true, accounts: ['U25779973'] },
    }, '2026-09-02T22:20:00.000Z');

    expect(coverage).toEqual({
      status: 'complete',
      complete: true,
      expected: ['U25779973'],
      expectedAccountIds: ['U25779973'],
      connected: ['U25779973'],
      connectedAccountIds: ['U25779973'],
      missingLiveAccounts: [],
      missingLiveAccountIds: [],
      observedAt: '2026-09-02T22:20:00.000Z',
      timestamp: '2026-09-02T22:20:00.000Z',
    });
  });

  test('reports partial coverage when Gateway omits the configured Individual account', () => {
    process.env.PREDICTION_MARKET_PERFORMANCE_ACCOUNT_ID = 'U25779973';
    process.env.IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS = 'U25779973,U25465536';
    const coverage = buildIbkrAccountCoverage({
      ibkr: { connected: true, accounts: [] },
    }, {}, '2026-09-02T22:21:00.000Z');

    expect(coverage.status).toBe('partial_account_coverage');
    expect(coverage.complete).toBe(false);
    expect(coverage.connected).toEqual([]);
    expect(coverage.missingLiveAccounts).toEqual(['U25779973']);
  });
});
