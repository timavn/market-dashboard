const {
  isAuthoritativeIbkrCpiContract,
  qualificationFailures,
} = require('./authoritativeIbkrCpiContract.cjs');

const NOW = new Date('2026-07-21T17:00:00Z');

function qualifiedEvent(overrides = {}) {
  return {
    conId: 7001,
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    exchange: 'FORECASTX',
    tradingClass: 'KXCPIYOY',
    expiration_time: '20260812',
    lastTradeDateOrContractMonth: '20260812',
    catalog_source: 'ibkr_contract_details',
    quote_side: 'YES',
    releaseKey: 'KXCPIYOY#2026-07',
    status: 'open',
    yes_bid: 0.42,
    yes_ask: 0.44,
    updated_at: '2026-07-21T16:59:30Z',
    data_quality_flags: [],
    ...overrides,
  };
}

describe('authoritative IBKR CPI contract qualification', () => {
  test('accepts a fresh native contract with exact ContractDetails provenance', () => {
    expect(isAuthoritativeIbkrCpiContract(qualifiedEvent(), {
      releaseKey: 'KXCPIYOY#2026-07',
      now: NOW,
    })).toBe(true);
  });

  test('rejects a fabricated TWS row even when its quote and source labels look live', () => {
    const fabricated = qualifiedEvent({
      conId: undefined,
      exchange: undefined,
      tradingClass: undefined,
      catalog_source: undefined,
    });

    expect(isAuthoritativeIbkrCpiContract(fabricated, { now: NOW })).toBe(false);
    expect(qualificationFailures(fabricated, { now: NOW })).toEqual(expect.arrayContaining([
      'missing_native_conid',
      'missing_exchange',
      'missing_trading_class',
      'unverified_catalog_source',
    ]));
  });

  test('rejects wrong-release, expired, stale, and unknown-side rows', () => {
    expect(qualificationFailures(qualifiedEvent({
      releaseKey: 'KXCPIYOY#2026-06',
      expiration_time: '20260714',
      lastTradeDateOrContractMonth: '20260714',
      quote_side: 'UNKNOWN',
      updated_at: '2026-07-21T16:50:00Z',
    }), {
      releaseKey: 'KXCPIYOY#2026-07',
      now: NOW,
    })).toEqual(expect.arrayContaining([
      'wrong_release',
      'missing_or_expired_expiry',
      'missing_or_stale_quote_timestamp',
      'unknown_native_side',
    ]));
  });
});
