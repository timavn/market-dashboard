const {
  centralTimestamp,
  loadOfficialForecastExContractSchedule,
  parseOfficialForecastExContractSchedule,
} = require('./forecastExContractSchedule.cjs');

function payload(rows) {
  return {
    statusCode: 200,
    body: {
      data: JSON.stringify(rows),
      next_page: null,
      total_pages: 1,
    },
  };
}

const gold = {
  contract_id: 'METLG_081426_4400',
  product_id: 'METLG',
  question: 'Will the price of Gold exceed $4,400 on August 14, 2026?',
  expiration_date: '2026-08-14T23:55:00',
  last_trade_date: '2026-08-14T12:30:00',
  payout_date: '2026-08-15T01:55:00',
  exchange_spec_url: 'https://data.forecastex.com/regulatory/METLGTermsandConditions.pdf',
};

const sp500 = {
  contract_id: 'FES_081426_7800',
  product_id: 'FES',
  question: 'Will Sep-26 S&P 500 Index Futures settle above $7,800 on August 14 2026?',
  expiration_date: '2026-08-17T10:00:00',
  last_trade_date: '2026-08-14T15:00:00',
  payout_date: '2026-08-17T12:00:00',
  exchange_spec_url: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
};

const sp500August20 = {
  contract_id: 'FES_082026_7375',
  product_id: 'FES',
  question: 'Will Sep-26 S&P 500 Index Futures settle above $7,375 on August 20 2026?',
  expiration_date: '2026-08-21T10:00:00',
  last_trade_date: '2026-08-20T15:00:00',
  payout_date: '2026-08-21T12:00:00',
  exchange_spec_url: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
};

describe('official ForecastEx contract schedules', () => {
  test('interprets Gold and SP500 venue timestamps as America/Chicago and preserves the exact resolver symbol', () => {
    expect(parseOfficialForecastExContractSchedule(payload([gold]), {
      productCode: 'METLG',
      eventContract: gold.contract_id,
      observedAt: '2026-08-14T17:31:00Z',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=100&productId=METLG',
      sourceHash: 'gold-hash',
    })).toMatchObject({
      eventTicker: 'METLG_081426_4400',
      eventDate: '2026-08-14',
      lastTradeAt: '2026-08-14T17:30:00.000Z',
      resolutionAt: '2026-08-15T04:55:00.000Z',
      payoutAt: '2026-08-15T06:55:00.000Z',
      settlementSymbol: 'GCQ26',
      source: 'forecastex_official_contract_api',
      sourceHash: 'gold-hash',
    });
    expect(parseOfficialForecastExContractSchedule(payload([sp500]), {
      productCode: 'FES',
      eventContract: sp500.contract_id,
      observedAt: '2026-08-14T20:01:00Z',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=100&productId=FES',
    })).toMatchObject({
      lastTradeAt: '2026-08-14T20:00:00.000Z',
      resolutionAt: '2026-08-17T15:00:00.000Z',
      payoutAt: '2026-08-17T17:00:00.000Z',
      settlementSymbol: 'ESU26',
    });
  });

  test('derives the August 20 Sep-26 ES resolver and exact CT schedule without a static registry entry', () => {
    expect(parseOfficialForecastExContractSchedule(payload([sp500August20]), {
      productCode: 'FES',
      eventContract: sp500August20.contract_id,
      observedAt: '2026-08-20T19:00:00Z',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=1000&productId=FES',
    })).toMatchObject({
      eventDate: '2026-08-20',
      settlementSymbol: 'ESU26',
      resolverContractMonth: '202609',
      resolverMonthLabel: 'Sep-26',
      lastTradeAt: '2026-08-20T20:00:00.000Z',
      resolutionAt: '2026-08-21T15:00:00.000Z',
      payoutAt: '2026-08-21T17:00:00.000Z',
    });
    expect(() => parseOfficialForecastExContractSchedule(payload([{
      ...sp500August20,
      exchange_spec_url: 'https://example.com/FESTermsandConditions.pdf',
    }]), {
      productCode: 'FES',
      eventContract: sp500August20.contract_id,
      observedAt: '2026-08-20T19:00:00Z',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=1000&productId=FES',
    })).toThrow(/invalid or conflicting contract schedule/i);
  });

  test('rejects malformed, ambiguous, wrong-product, and timezone-tagged schedules', () => {
    const options = {
      productCode: 'METLG',
      eventContract: gold.contract_id,
      observedAt: '2026-08-14T17:31:00Z',
      sourceUrl: 'https://www.forecastex.com/api/contracts',
    };
    expect(() => parseOfficialForecastExContractSchedule(payload([gold, gold]), options))
      .toThrow(/exactly one/i);
    expect(() => parseOfficialForecastExContractSchedule(payload([{ ...gold, product_id: 'FES' }]), options))
      .toThrow(/different product/i);
    expect(() => parseOfficialForecastExContractSchedule(payload([{ ...gold, last_trade_date: '2026-08-14T12:30:00Z' }]), options))
      .toThrow(/invalid or conflicting/i);
    expect(() => parseOfficialForecastExContractSchedule(payload([{ ...gold, question: 'Gold contract' }]), options))
      .toThrow(/invalid or conflicting/i);
    expect(centralTimestamp('2026-02-30T12:30:00')).toBeNull();
  });

  test('loads only the authoritative exact contract response and records a source hash', async () => {
    const raw = JSON.stringify(payload([gold]));
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      url: 'https://www.forecastex.com/api/contracts?page=1&pageSize=100&productId=METLG',
      headers: { get: () => 'application/json' },
      text: async () => raw,
    }));
    await expect(loadOfficialForecastExContractSchedule({
      productCode: 'METLG',
      eventContract: gold.contract_id,
      fetchImpl,
      now: () => new Date('2026-08-14T17:31:00Z'),
    })).resolves.toMatchObject({
      eventTicker: gold.contract_id,
      observedAt: '2026-08-14T17:31:00.000Z',
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fetchImpl.mock.calls[0][0]).toContain('pageSize=1000');
    expect(fetchImpl.mock.calls[0][0]).toContain('productId=METLG');
  });
});
