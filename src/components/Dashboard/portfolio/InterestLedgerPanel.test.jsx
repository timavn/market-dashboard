import { normalizeVerifiedInterestLedger } from './InterestLedgerPanel';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getIbkrInterestValidationLedger: jest.fn(),
  },
}));

function response(overrides = {}) {
  const generatedAt = new Date().toISOString();
  return {
    source: 'ibkr_verified_interest_ledger',
    available: true,
    status: 'verified_history',
    accountId: 'U1',
    accountMatched: true,
    accountMasked: '••••U1',
    fromCache: false,
    generatedAt,
    summary: {
      source: 'ibkr_verified_interest_evidence_export',
      accountScoped: true,
      accountIdentifierIncluded: false,
      recovered: {
        liveMtdCheckpoints: 1,
        forecastRows: 1,
        cashPostings: 1,
      },
      formulaAudit: { rows: 1, exactToCentRows: 1 },
    },
    ledger: [],
    observations: [{ session_date: '2026-08-16', live_mtd_cost_display: 113.78 }],
    forecasts: [{ value_date: '2026-08-16', point_forecast: 1.03 }],
    postings: [{ posted_date: '2026-08-05', amount_signed: -56.29 }],
    formulaAudit: [{ value_date: '2026-08-16', residual_ibkr_minus_formula: 0 }],
    ...overrides,
  };
}

describe('normalizeVerifiedInterestLedger', () => {
  test('accepts fresh, exact-account, no-cache verified history', () => {
    expect(normalizeVerifiedInterestLedger(response(), 'U1')).toMatchObject({
      accountMasked: '••••U1',
      observations: [{ live_mtd_cost_display: 113.78 }],
    });
  });

  test.each([
    ['wrong account', { accountId: 'U2' }],
    ['cached', { fromCache: true }],
    ['mock', { mock: true }],
    ['seeded nested evidence', { ledger: [{ seeded: true }] }],
    ['stale response', { generatedAt: '2026-08-01T00:00:00.000Z' }],
    ['row-count mismatch', { formulaAudit: [] }],
  ])('rejects %s ledger payloads', (_label, overrides) => {
    const now = Date.parse('2026-08-17T16:00:00.000Z');
    const payload = response({
      generatedAt: new Date(now).toISOString(),
      ...overrides,
    });
    expect(normalizeVerifiedInterestLedger(payload, 'U1', now)).toBeNull();
  });
});
