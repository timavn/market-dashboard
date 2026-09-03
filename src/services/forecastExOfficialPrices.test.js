const {
  loadOfficialForecastExPrices,
  parseOfficialForecastExPricesCsv,
} = require('./forecastExOfficialPrices.cjs');

const header = 'event_contract,subtype,expiration_date,date,start_price,high_price,low_price,end_price,settlement_price,pair_quantity,open_interest,vwap';
const settledCsv = `${header}\nCOMCO_081226_82,YES,2026-08-12T23:55:00-05:00,2026-08-13,1.00,0.00,0.00,1.00,1.00,0,0,0.00\nCOMCO_081226_82,NO,2026-08-12T23:55:00-05:00,2026-08-13,0.00,0.00,0.00,0.00,0.00,0,0,0.00\n`;
const multiProductCsv = `${settledCsv}METLG_081426_4400,YES,2026-08-14T23:55:00-05:00,2026-08-13,0.02,0.02,0.02,0.02,,0,0,0.02\nMETLG_081426_4400,NO,2026-08-14T23:55:00-05:00,2026-08-13,0.98,0.98,0.98,0.98,0.98,0,0,0.98\nFES_081426_7800,YES,2026-08-17T10:00:00-05:00,2026-08-13,0.82,0.82,0.82,0.82,0.82,0,0,0.82\nFES_081426_7800,NO,2026-08-17T10:00:00-05:00,2026-08-13,0.18,0.18,0.18,0.18,0.18,0,0,0.18\nCPIY_0726_3.4,YES,2026-08-12T07:30:00-05:00,2026-08-13,0.00,0.00,0.00,0.00,0.00,0,0,0.00\nCPIY_0726_3.4,NO,2026-08-12T07:30:00-05:00,2026-08-13,1.00,1.00,1.00,1.00,1.00,0,0,1.00\n`;

describe('ForecastEx official prices', () => {
  test('parses exact COMCO, METLG, FES, and CPIY outcomes while ignoring unrelated products', () => {
    const rows = parseOfficialForecastExPricesCsv(
      `${multiProductCsv}ACD_1226_432.0,YES,2027-01-05T08:00:00-06:00,2026-08-13,0.04,0,0,0.04,0.04,0,105,0\n`,
      { dataDate: '2026-08-13' },
    );
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventContract: 'COMCO_081226_82', subtype: 'YES', settlementPrice: 1, dataDate: '2026-08-13' }),
      expect.objectContaining({ eventContract: 'COMCO_081226_82', subtype: 'NO', settlementPrice: 0, dataDate: '2026-08-13' }),
      expect.objectContaining({ productCode: 'METLG', eventContract: 'METLG_081426_4400', subtype: 'YES', settlementPrice: null }),
      expect.objectContaining({ productCode: 'METLG', eventContract: 'METLG_081426_4400', subtype: 'NO', settlementPrice: 0.98 }),
      expect.objectContaining({ productCode: 'FES', eventContract: 'FES_081426_7800', subtype: 'YES', settlementPrice: 0.82 }),
      expect.objectContaining({ productCode: 'FES', eventContract: 'FES_081426_7800', subtype: 'NO', settlementPrice: 0.18 }),
      expect.objectContaining({ productCode: 'CPIY', eventContract: 'CPIY_0726_3.4', subtype: 'YES', settlementPrice: 0 }),
      expect.objectContaining({ productCode: 'CPIY', eventContract: 'CPIY_0726_3.4', subtype: 'NO', settlementPrice: 1 }),
    ]));
    expect(rows).toHaveLength(8);
  });

  test('rejects duplicate identities and mismatched data dates', () => {
    expect(() => parseOfficialForecastExPricesCsv(`${settledCsv}${settledCsv.split('\n')[1]}\n`, { dataDate: '2026-08-13' }))
      .toThrow(/duplicate/i);
    expect(() => parseOfficialForecastExPricesCsv(settledCsv, { dataDate: '2026-08-14' }))
      .toThrow(/identity/i);
    expect(() => parseOfficialForecastExPricesCsv(
      `${header}\nMETLG_081426_BAD,YES,2026-08-14T23:55:00-05:00,2026-08-13,0.1,0.1,0.1,0.1,0.1,0,0,0.1\n`,
      { dataDate: '2026-08-13' },
    )).toThrow(/identity/i);
  });

  test('fetches only the official no-store CSV endpoint and records provenance', async () => {
    const fetchImpl = jest.fn(async (url, options) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/csv' },
      text: async () => settledCsv,
      options,
    }));
    const snapshot = await loadOfficialForecastExPrices({
      dataDate: '2026-08-13',
      fetchImpl,
      now: () => new Date('2026-08-13T23:00:00Z'),
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.forecastex.com/api/download?type=prices&date=20260813');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
    expect(snapshot).toMatchObject({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate: '2026-08-13',
      fetchedAt: '2026-08-13T23:00:00.000Z',
    });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects redirects outside ForecastEx', async () => {
    await expect(loadOfficialForecastExPrices({
      dataDate: '2026-08-13',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://example.invalid/prices.csv',
        headers: { get: () => 'text/csv' },
        text: async () => settledCsv,
      }),
    })).rejects.toMatchObject({ code: 'FORECASTEX_PRICES_SOURCE_UNVERIFIED' });
  });
});
