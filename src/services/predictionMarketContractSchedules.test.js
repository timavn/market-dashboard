const {
  buildPredictionMarketScheduleProvider,
  parseKalshiMarketSchedule,
} = require('./predictionMarketContractSchedules.cjs');

describe('prediction-market exact contract schedule provider', () => {
  test('normalizes a finalized Kalshi market without confusing close, resolution, and payout times', () => {
    expect(parseKalshiMarketSchedule({
      market: {
        ticker: 'KXWTI-26AUG1314-T81.49',
        status: 'finalized',
        result: 'no',
        close_time: '2026-08-13T18:30:00Z',
        expected_expiration_time: '2026-08-13T18:30:00Z',
        settlement_ts: '2026-08-14T15:01:14.410928Z',
        expiration_value: '81.25',
        custom_strike: { front_month_contract: 'WBS 26U-ICE' },
      },
    }, {
      ticker: 'KXWTI-26AUG1314-T81.49',
      observedAt: '2026-08-14T15:02:00Z',
    })).toMatchObject({
      source: 'kalshi_exact_market',
      lastTradeAt: '2026-08-13T18:30:00.000Z',
      expectedResolutionAt: '2026-08-13T18:30:00.000Z',
      resolutionAt: '2026-08-14T15:01:14.410Z',
      payoutAt: '2026-08-14T15:01:14.410Z',
      outcome: 'NO',
      settlementValue: 81.25,
      settlementSymbol: 'WBS 26U-ICE',
    });
  });

  test('rejects ticker conflicts and incomplete finalized evidence', () => {
    const base = {
      ticker: 'KXWTI-26AUG1314-T81.49',
      status: 'finalized',
      result: 'no',
      close_time: '2026-08-13T18:30:00Z',
      expected_expiration_time: '2026-08-13T18:30:00Z',
      settlement_ts: '2026-08-14T15:01:14Z',
    };
    expect(() => parseKalshiMarketSchedule({ market: base }, {
      ticker: 'KXWTI-26AUG1314-T81.99', observedAt: '2026-08-14T15:02:00Z',
    })).toThrow(/invalid or conflicting/i);
    expect(() => parseKalshiMarketSchedule({ market: { ...base, settlement_ts: null } }, {
      ticker: base.ticker, observedAt: '2026-08-14T15:02:00Z',
    })).toThrow(/invalid or conflicting/i);
  });

  test('routes exact ForecastEx and Kalshi identities to their official schedule loaders', async () => {
    const loadOfficialForecastExContractSchedule = jest.fn(async (identity) => ({ ...identity, source: 'forecastex_official_contract_api' }));
    const kalshiFetch = jest.fn(async () => ({
      market: {
        ticker: 'KXWTI-26AUG1314-T81.49', status: 'open',
        close_time: '2026-08-13T18:30:00Z', expected_expiration_time: '2026-08-13T18:30:00Z',
      },
    }));
    const provider = buildPredictionMarketScheduleProvider({
      loadOfficialForecastExContractSchedule,
      kalshiFetch,
      now: () => new Date('2026-08-13T18:00:00Z'),
    });
    await expect(provider({
      market: 'gold', exchange: 'FORECASTX', contractKey: 'METLG_081426_4400_YES',
      eventTicker: 'METLG_081426_4400', contractSide: 'YES', strike: 4400,
      expiration: '20260814', contractRule: 'above',
    })).resolves.toMatchObject({ source: 'forecastex_official_contract_api' });
    expect(loadOfficialForecastExContractSchedule).toHaveBeenCalledWith({
      productCode: 'METLG', eventContract: 'METLG_081426_4400',
    });
    await expect(provider({
      contractKey: 'KXWTI-26AUG1314-T81.49_NO', contractSide: 'NO',
    })).resolves.toMatchObject({ source: 'kalshi_exact_market' });
  });
});
