const {
  applyContractMark,
  applyPreliminaryResolverReferences,
  applyResolverSettlementDetails,
  buildPredictionMarketMarkProviders,
  exactKalshiMarketTicker,
  markActivePerformanceRows,
  resolveForecastExOfficialSettlementMarks,
  summarizeTrackedRows,
  verifiedResolverSettlement,
} = require('./predictionMarketPerformanceMarks.cjs');

describe('prediction-market performance marks', () => {
  test('extracts an exact venue ticker without inventing a complementary contract', () => {
    expect(exactKalshiMarketTicker({ contractKey: 'KXWTI-26AUG1314-T81.49_NO' }))
      .toBe('KXWTI-26AUG1314-T81.49');
    expect(exactKalshiMarketTicker({
      contractKey: 'KXCPIYOY',
      eventTicker: 'KXCPIYOY-26JUN',
      positionSnapshotEvidence: { description: 'KXCPIYOY-26JUN-T3.8_YES' },
    })).toBe('KXCPIYOY-26JUN-T3.8');
    expect(exactKalshiMarketTicker({ eventTicker: 'KXWTI-26AUG1314' })).toBeNull();
  });

  test('uses a fresh direct held-side bid for an open Kalshi contract', async () => {
    const kalshiFetch = jest.fn(async () => ({
      market: {
        ticker: 'KXCPIYOY-26JUL-T3.3',
        status: 'active',
        close_time: '2026-08-13T21:00:00Z',
        updated_time: '2026-08-13T19:59:30Z',
        yes_bid_dollars: '0.61',
        no_bid_dollars: '0.38',
      },
    }));
    const providers = buildPredictionMarketMarkProviders({
      kalshiFetch,
      now: () => new Date('2026-08-13T20:00:00Z'),
    });
    await expect(providers.kalshi({
      contractKey: 'KXCPIYOY-26JUL-T3.3_NO',
      contractSide: 'NO',
    })).resolves.toMatchObject({
      price: 0.38,
      state: 'live_bid',
      source: 'kalshi_direct_bid',
    });
  });

  test('uses the explicit held-side closing trade after a Kalshi market closes', async () => {
    const kalshiFetch = jest.fn(async (path) => {
      if (path.startsWith('/markets/KXWTI')) {
        return {
          market: {
            ticker: 'KXWTI-26AUG1314-T81.49',
            status: 'closed',
            close_time: '2026-08-13T18:30:00Z',
          },
        };
      }
      return {
        trades: [{
          ticker: 'KXWTI-26AUG1314-T81.49',
          created_time: '2026-08-13T18:29:42Z',
          yes_price_dollars: '0.01',
          no_price_dollars: '0.99',
        }],
      };
    });
    const providers = buildPredictionMarketMarkProviders({
      kalshiFetch,
      now: () => new Date('2026-08-13T20:00:00Z'),
    });
    await expect(providers.kalshi({
      contractKey: 'KXWTI-26AUG1314-T81.49_NO',
      contractSide: 'NO',
    })).resolves.toMatchObject({
      price: 0.99,
      state: 'closing_trade',
      source: 'kalshi_direct_closing_trade',
    });
    expect(kalshiFetch).toHaveBeenLastCalledWith('/markets/trades', {
      ticker: 'KXWTI-26AUG1314-T81.49',
      limit: 1,
    });
  });

  test('exposes Kalshi published settlement date and underlying expiration value', async () => {
    const providers = buildPredictionMarketMarkProviders({
      kalshiFetch: async () => ({
        market: {
          ticker: 'KXWTI-26AUG1314-T81.49',
          status: 'finalized',
          result: 'NO',
          expiration_value: '81.25',
          settlement_ts: '2026-08-14T15:01:14.410928Z',
        },
      }),
    });

    await expect(providers.kalshi({
      contractKey: 'KXWTI-26AUG1314-T81.49_NO',
      contractSide: 'NO',
    })).resolves.toMatchObject({
      price: 1,
      state: 'verified_settlement',
      settlementDate: '2026-08-14',
      settlementValue: 81.25,
      settlementValueSource: 'kalshi_published_expiration_value',
    });
  });

  test('rejects a stale open-market quote instead of presenting it as current P&L', async () => {
    const providers = buildPredictionMarketMarkProviders({
      kalshiFetch: async () => ({
        market: {
          ticker: 'KXWTI-26AUG1414-T82',
          status: 'active',
          close_time: '2026-08-14T21:00:00Z',
          updated_time: '2026-08-13T19:00:00Z',
          yes_bid_dollars: '0.7',
        },
      }),
      now: () => new Date('2026-08-13T20:00:00Z'),
    });
    await expect(providers.kalshi({
      contractKey: 'KXWTI-26AUG1414-T82_YES',
      contractSide: 'YES',
    })).resolves.toBeNull();
  });

  test('uses the exact ForecastEx subtype from the official price file', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      fetchedAt: '2026-08-14T03:30:00Z',
      rows: [{
        eventContract: 'COMCO_081326_82',
        subtype: 'NO',
        expirationDate: '2026-08-13T23:55:00-05:00',
        settlementPrice: 0.84,
      }],
    }));
    const providers = buildPredictionMarketMarkProviders({
      loadOfficialForecastExPrices,
      now: () => new Date('2026-08-14T03:35:00Z'),
    });
    await expect(providers.forecastex({
      exchange: 'FORECASTX',
      contractKey: 'COMCO_081326_82_NO',
      expiration: '20260813',
      strike: 82,
      contractSide: 'NO',
    })).resolves.toMatchObject({
      price: 0.84,
      state: 'official_reference',
      source: 'forecastex_official_price',
      settlementDate: '2026-08-13',
    });
  });

  test.each([
    { contractKey: 'METLG_081426_4400_YES', side: 'YES', eventContract: 'METLG_081426_4400', price: 0.02, expiration: '20260814' },
    { contractKey: 'FES_081426_7800_NO', side: 'NO', eventContract: 'FES_081426_7800', price: 0.18, expiration: '20260817' },
  ])('routes $contractKey to its exact official held-side mark', async ({ contractKey, side, eventContract, price, expiration }) => {
    const providers = buildPredictionMarketMarkProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true,
        source: 'forecastex_official_prices',
        snapshotType: 'settled_outcome_candidates',
        dataDate,
        fetchedAt: '2026-08-14T18:00:00Z',
        rows: [
          { eventContract, subtype: side, expirationDate: '2026-08-17T10:00:00-05:00', settlementPrice: price },
          { eventContract, subtype: side === 'YES' ? 'NO' : 'YES', expirationDate: '2026-08-17T10:00:00-05:00', settlementPrice: 1 - price },
        ],
      }),
      now: () => new Date('2026-08-14T18:01:00Z'),
    });
    const [marked] = await markActivePerformanceRows([{
      contractKey,
      eventTicker: eventContract,
      contractSide: side,
      expiration,
      strike: Number(eventContract.split('_').at(-1)),
      quantity: 10,
      risked: 4,
      paid: 0,
    }], providers);
    expect(marked).toMatchObject({
      markPrice: price,
      markState: 'official_reference',
      markSource: 'forecastex_official_price',
      settlementDate: '2026-08-17',
    });
  });

  test('adds only an exact final resolver price to the matching ForecastEx event', () => {
    const row = {
      market: 'sp500',
      contractKey: 'FES_081426_7800_NO',
      eventTicker: 'FES_081426_7800',
      contractSide: 'NO',
      strike: 7800,
      expiration: '20260817',
    };
    const exact = {
      role: 'resolver',
      availability: 'official_final',
      final: true,
      source: 'cme_daily_bulletin_final',
      sourceUrl: 'https://www.cmegroup.com/daily_bulletin/current/Section11_Equity_And_Index_Futures.pdf',
      sourceHash: 'a'.repeat(64),
      productCode: 'FES',
      market: 'sp500',
      value: 7802.5,
      tradingDate: '2026-08-14',
      asOf: '2026-08-14T23:10:00Z',
      symbol: 'ESU26',
    };

    expect(verifiedResolverSettlement(row, [exact])).toMatchObject({
      value: 7802.5,
      status: 'official_final',
      symbol: 'ESU26',
    });
    expect(applyResolverSettlementDetails([row], [exact])[0]).toMatchObject({
      settlementValue: 7802.5,
      settlementValueSource: 'cme_daily_bulletin_final',
      settlementValueStatus: 'official_final',
    });
    expect(verifiedResolverSettlement(row, [{
      ...exact,
      source: 'databento_glbx_mdp3_statistics',
      sourceUrl: null,
      sourceHash: null,
    }])).toBeNull();
    expect(verifiedResolverSettlement(row, [{ ...exact, final: false, availability: 'official_preliminary' }])).toBeNull();
    expect(verifiedResolverSettlement(row, [{ ...exact, tradingDate: '2026-08-13' }])).toBeNull();
    expect(verifiedResolverSettlement(row, [{ ...exact, tradingDate: '2026-08-17' }])).toBeNull();
    expect(verifiedResolverSettlement(row, [{ ...exact, source: 'ibkr_historical_daily_close' }])).toBeNull();
    expect(verifiedResolverSettlement(row, [{ ...exact }])).toMatchObject({
      value: 7802.5,
      source: 'cme_daily_bulletin_final',
      sourceUrl: expect.stringContaining('cmegroup.com'),
    });
    expect(verifiedResolverSettlement(row, [{
      ...exact,
      source: 'cme_daily_bulletin_final',
      sourceUrl: 'https://example.com/not-official.pdf',
      sourceHash: 'a'.repeat(64),
    }])).toBeNull();
  });

  test('does not infer a ForecastEx held-side mark from the opposite outcome', async () => {
    const providers = buildPredictionMarketMarkProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true,
        source: 'forecastex_official_prices',
        snapshotType: 'settled_outcome_candidates',
        dataDate,
        fetchedAt: '2026-08-14T18:00:00Z',
        rows: [{
          eventContract: 'METLG_081426_4400', subtype: 'NO',
          expirationDate: '2026-08-14T23:55:00-05:00', settlementPrice: 0.98,
        }],
      }),
      now: () => new Date('2026-08-14T18:01:00Z'),
    });
    await expect(providers.forecastex({
      contractKey: 'METLG_081426_4400_YES', eventTicker: 'METLG_081426_4400',
      expiration: '20260814', strike: 4400, contractSide: 'YES',
    })).resolves.toBeNull();
  });

  test('does not call a lone binary ForecastEx row a verified settlement', async () => {
    const providers = buildPredictionMarketMarkProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true,
        source: 'forecastex_official_prices',
        snapshotType: 'settled_outcome_candidates',
        dataDate,
        fetchedAt: '2026-08-15T18:00:00Z',
        rows: [{
          eventContract: 'METLG_081426_4400', subtype: 'YES',
          expirationDate: '2026-08-14T23:55:00-05:00', settlementPrice: 1,
        }],
      }),
      now: () => new Date('2026-08-15T18:01:00Z'),
    });
    await expect(providers.forecastex({
      contractKey: 'METLG_081426_4400_YES', expiration: '20260814',
      strike: 4400, contractSide: 'YES',
    })).resolves.toMatchObject({ state: 'official_reference', price: 1 });
  });

  test('batch-resolves exact expired ForecastEx contracts from one authoritative file', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      fetchedAt: '2026-08-25T16:00:00.000Z',
      url: `https://www.forecastex.com/api/download?type=prices&date=${dataDate.replaceAll('-', '')}`,
      sha256: 'a'.repeat(64),
      rows: [
        { eventContract: 'FES_082426_7700', subtype: 'YES', expirationDate: '2026-08-25T15:00:00Z', settlementPrice: 0 },
        { eventContract: 'FES_082426_7700', subtype: 'NO', expirationDate: '2026-08-25T15:00:00Z', settlementPrice: 1 },
      ],
    }));
    const rows = await resolveForecastExOfficialSettlementMarks([{
      conId: 102,
      expiration: '20260825',
      localSymbol: 'FES_082426_7700_YES',
      contractKey: 'FES_082426_7700_YES',
      contractSide: 'YES',
      exchange: 'FORECASTX',
    }, {
      conId: 103,
      localSymbol: 'FES_082426_7700_NO',
      contractKey: 'FES_082426_7700_NO',
      contractSide: 'NO',
      exchange: 'FORECASTX',
    }], {
      loadOfficialForecastExPrices,
      now: () => new Date('2026-08-25T18:00:00.000Z'),
    });

    expect(rows).toEqual([
      expect.objectContaining({ conId: 102, status: 'verified_settlement', settlementPrice: 0 }),
      expect.objectContaining({ conId: 103, status: 'verified_settlement', settlementPrice: 1 }),
    ]);
    expect(loadOfficialForecastExPrices).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['2026-08-14T20:00:00Z', '2026-08-17T18:00:00Z', null],
    ['2026-08-18T15:00:00Z', '2026-08-18T18:00:00Z', null],
    ['2026-08-17T15:00:00Z', '2026-08-17T14:00:00Z', 'official_reference'],
    ['2026-08-17T15:00:00Z', '2026-08-17T18:00:00Z', 'verified_settlement'],
  ])('uses only the published FES expiration for settlement (%s at %s)', async (expirationDate, at, expectedState) => {
    const providers = buildPredictionMarketMarkProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true, source: 'forecastex_official_prices', snapshotType: 'settled_outcome_candidates',
        dataDate, fetchedAt: at,
        rows: [
          { eventContract: 'FES_081426_7800', subtype: 'YES', expirationDate, settlementPrice: 1 },
          { eventContract: 'FES_081426_7800', subtype: 'NO', expirationDate, settlementPrice: 0 },
        ],
      }),
      now: () => new Date(at),
    });
    const result = await providers.forecastex({
      contractKey: 'FES_081426_7800_YES', contractSide: 'YES', expiration: '20260817',
    });
    expect(result?.state ?? null).toBe(expectedState);
    expect(result?.settlementDate ?? null).toBe(expectedState == null ? null : '2026-08-17');
  });

  test('values a closed same-day FES contract from an exact wholly-below resolver bar while final settlement is pending', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      fetchedAt: '2026-08-25T22:30:00.000Z',
      url: `https://www.forecastex.com/api/download?type=prices&date=${dataDate.replaceAll('-', '')}`,
      sha256: 'a'.repeat(64),
      rows: [
        { eventContract: 'FES_082526_7700', subtype: 'YES', expirationDate: '2026-08-26T15:00:00.000Z', settlementPrice: 0.14 },
        { eventContract: 'FES_082526_7700', subtype: 'NO', expirationDate: '2026-08-26T15:00:00.000Z', settlementPrice: 0.86 },
      ],
    }));
    const loadContractSchedule = jest.fn(async () => ({
      ok: true,
      venue: 'ForecastEx',
      source: 'forecastex_official_contract_api',
      productCode: 'FES',
      eventTicker: 'FES_082526_7700',
      eventDate: '2026-08-25',
      strike: 7700,
      lastTradeAt: '2026-08-25T20:00:00.000Z',
      resolutionAt: '2026-08-26T15:00:00.000Z',
      payoutAt: '2026-08-26T17:00:00.000Z',
      settlementSymbol: 'ESU26',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=1000&productId=FES',
      sourceHash: 'b'.repeat(64),
      rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
    }));
    const getResolverSettlements = jest.fn(async () => [{
      role: 'resolver_reference',
      availability: 'preliminary_reference',
      final: false,
      complete: true,
      source: 'ibkr_exact_cutoff_bar',
      provider: 'ibkr',
      provenance: 'verified_ibkr_historical_trade_bar',
      productCode: 'FES',
      eventContract: 'FES_082526_7700',
      tradingDate: '2026-08-25',
      symbol: 'ESU26',
      value: 7691,
      windowOpen: 7693,
      windowHigh: 7694.75,
      windowLow: 7689.5,
      windowClose: 7691,
      barStartAt: '2026-08-25T19:59:00.000Z',
      cutoffAt: '2026-08-25T20:00:00.000Z',
      asOf: '2026-08-25T22:30:00.000Z',
    }]);

    const [row] = await resolveForecastExOfficialSettlementMarks([{
      conId: 7700,
      localSymbol: 'FES_082526_7700_YES',
      contractKey: 'FES_082526_7700_YES',
      expiration: '20260826',
      contractSide: 'YES',
      exchange: 'FORECASTX',
    }], {
      loadOfficialForecastExPrices,
      loadContractSchedule,
      getResolverSettlements,
      now: () => new Date('2026-08-25T22:45:00.000Z'),
    });

    expect(row).toMatchObject({
      conId: 7700,
      status: 'resolver_determined',
      valuationPrice: 0,
      valuationSource: 'ibkr_exact_cutoff_bar',
      resolverValue: 7691,
      resolverWindowHigh: 7694.75,
      resolverWindowLow: 7689.5,
      finalSettlementPending: true,
    });
    expect(loadContractSchedule).toHaveBeenCalledTimes(1);
    expect(getResolverSettlements).toHaveBeenCalledTimes(1);
    const [conflicting] = await resolveForecastExOfficialSettlementMarks([{
      conId: 7700, localSymbol: 'FES_082526_7700_YES', contractSide: 'YES', expiration: '20260827',
    }], {
      loadOfficialForecastExPrices, loadContractSchedule, getResolverSettlements,
      now: () => new Date('2026-08-25T22:45:00.000Z'),
    });
    expect(conflicting.status).not.toBe('resolver_determined');
    expect(getResolverSettlements).toHaveBeenCalledTimes(1);
  });

  test('keeps untrusted, incomplete, and active ForecastEx settlement rows unavailable', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      fetchedAt: '2026-08-25T16:00:00.000Z',
      url: 'https://example.com/prices.csv',
      sha256: 'b'.repeat(64),
      rows: [
        { eventContract: 'FES_082426_7700', subtype: 'YES', expirationDate: '2026-08-25T15:00:00Z', settlementPrice: 0 },
        { eventContract: 'FES_082426_7700', subtype: 'NO', expirationDate: '2026-08-25T15:00:00Z', settlementPrice: 1 },
      ],
    }));
    const rows = await resolveForecastExOfficialSettlementMarks([{
      conId: 1,
      localSymbol: 'FES_082426_7700_YES',
      contractKey: 'FES_082426_7700_YES',
      contractSide: 'YES',
    }, {
      conId: 2,
      localSymbol: 'FES_082526_7700_YES',
      contractKey: 'FES_082526_7700_YES',
      contractSide: 'YES',
    }], {
      loadOfficialForecastExPrices,
      now: () => new Date('2026-08-25T18:00:00.000Z'),
    });

    expect(rows[0]).toMatchObject({ status: 'awaiting_settlement' });
    expect(rows[1]).toMatchObject({ status: 'active' });
  });

  test('calculates marked value, P&L, and aggregate return without filling unavailable marks', async () => {
    const rows = await markActivePerformanceRows([
      {
        id: 'marked', contractKey: 'KXWTI-26AUG1314-T81.49_NO', contractSide: 'NO',
        quantity: 100, risked: 20, paid: 0,
      },
      {
        id: 'unmarked', contractKey: 'UNKNOWN', contractSide: 'YES',
        quantity: 10, risked: 4, paid: 0,
      },
    ], {
      kalshi: async () => ({
        price: 0.99,
        state: 'closing_trade',
        source: 'kalshi_direct_closing_trade',
        observedAt: '2026-08-13T18:29:42Z',
      }),
    });
    expect(rows[0]).toMatchObject({ currentValue: 99, pnl: 79, roi: 3.95 });
    expect(rows[1]).toMatchObject({ currentValue: null, pnl: null, markState: 'unavailable' });
    expect(summarizeTrackedRows(rows)).toMatchObject({
      count: 2,
      valuedCount: 1,
      complete: false,
      risked: 24,
      currentValue: null,
      pnl: null,
      roi: null,
    });
    expect(applyContractMark({ quantity: 10, risked: 4, paid: 1 }, {
      price: 0.5,
      state: 'live_bid',
      source: 'kalshi_direct_bid',
      observedAt: '2026-08-13T20:00:00Z',
    })).toMatchObject({ currentValue: 6, pnl: 2, roi: 0.5 });
  });

  test('does not treat a post-close ForecastEx contract price as an FES settlement proxy', async () => {
    const [row] = await markActivePerformanceRows([{
      id: 'awaiting-aug21-reference',
      status: 'awaiting_resolution',
      contractKey: 'FES_082126_7700_NO',
      eventTicker: 'FES_082126_7700',
      contractSide: 'NO',
      quantity: 500,
      risked: 811.25,
      paid: 487.5,
    }], {
      forecastex: async () => ({
        price: 0.9,
        state: 'official_reference',
        source: 'forecastex_official_price',
        observedAt: '2026-08-21T22:02:22.524Z',
      }),
    });

    expect(row).toMatchObject({
      status: 'awaiting_resolution',
      currentValue: null,
      pnl: null,
      roi: null,
      markPrice: null,
      markState: 'unavailable',
      markSource: null,
    });
  });

  test('values FES preliminarily only when the complete cutoff bar is wholly on one side', () => {
    const row = {
      id: 'aug21-7700', status: 'awaiting_resolution', contractKey: 'FES_082126_7700_YES',
      eventTicker: 'FES_082126_7700', contractSide: 'YES', contractRule: 'above', strike: 7700,
      settlementSymbol: 'ESU26', lastTradeAt: '2026-08-21T20:00:00.000Z',
      entryQuantity: 12500, remainingQuantity: 2500, entryCost: 3995, risked: 3995,
      netExitProceeds: 3660, paid: 3660,
    };
    const reference = {
      role: 'resolver_reference', availability: 'preliminary_reference', final: false, complete: true,
      source: 'ibkr_exact_cutoff_bar', provider: 'ibkr', provenance: 'verified_ibkr_historical_trade_bar',
      productCode: 'FES', eventContract: 'FES_082126_7700', tradingDate: '2026-08-21', symbol: 'ESU26',
      value: 7691.5, windowOpen: 7696.5, windowHigh: 7698.25, windowLow: 7688.75, windowClose: 7691.5,
      barStartAt: '2026-08-21T19:59:00.000Z', cutoffAt: '2026-08-21T20:00:00.000Z',
      asOf: '2026-08-22T00:30:13.000Z',
    };
    const [valued] = applyPreliminaryResolverReferences([row], [reference]);
    expect(valued).toMatchObject({
      preliminaryReferenceValue: 7691.5,
      preliminaryOutcome: 'NO',
      preliminaryPayoutPerContract: 0,
      remainingPayout: 0,
      currentValue: 3660,
      pnl: -335,
      roi: -335 / 3995,
      holdToExpiryPnl: -3995,
      savedVsHold: 3660,
      valuationStatus: 'preliminary',
    });
    expect(valued.settlementValue).toBeUndefined();

    const [overlap] = applyPreliminaryResolverReferences([{ ...row, strike: 7690, contractKey: 'FES_082126_7690_YES', eventTicker: 'FES_082126_7690' }], [{
      ...reference, eventContract: 'FES_082126_7690',
    }]);
    expect(overlap).toMatchObject({ preliminaryOutcome: null, currentValue: null, pnl: null, valuationStatus: 'pending_overlap' });
  });

  test('keeps a non-official awaiting reference unavailable', async () => {
    const [row] = await markActivePerformanceRows([{
      id: 'awaiting-unverified-reference',
      status: 'awaiting_resolution',
      contractKey: 'FES_081426_7775_NO',
      eventTicker: 'FES_081426_7775',
      contractSide: 'NO',
      quantity: 5000,
      risked: 300,
      paid: 0,
    }], {
      forecastex: async () => ({
        price: 0.07,
        state: 'official_reference',
        source: 'unverified_reference',
        observedAt: '2026-08-15T04:00:55.719Z',
      }),
    });

    expect(row).toMatchObject({
      currentValue: null,
      pnl: null,
      markState: 'unavailable',
      markSource: null,
    });
  });

  test('keeps a verified binary settlement available for an awaiting row', async () => {
    const [row] = await markActivePerformanceRows([{
      id: 'awaiting-final',
      status: 'awaiting_resolution',
      contractKey: 'FES_081426_7775_NO',
      eventTicker: 'FES_081426_7775',
      contractSide: 'NO',
      quantity: 5000,
      risked: 300,
      paid: 0,
    }], {
      forecastex: async () => ({
        price: 1,
        state: 'verified_settlement',
        source: 'forecastex_verified_settlement',
        observedAt: '2026-08-17T17:00:00.000Z',
      }),
    });

    expect(row).toMatchObject({ currentValue: 5000, pnl: 4700, roi: 4700 / 300, markState: 'verified_settlement' });
  });
});
