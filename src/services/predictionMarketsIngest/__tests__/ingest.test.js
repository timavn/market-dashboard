const { normalizeEvent, comparisonFingerprint } = require('../normalize/normalizeEvent');
const { isFinancialMacroEvent } = require('../filter/isFinancialMacroEvent');
const { enrichEvent } = require('../enrich/enrichEvent');
const { assignComparisonGroup } = require('../group/assignComparisonGroup');
const { mergeCrossVenueEvents } = require('../merge/mergeCrossVenueEvents');
const { sortAggregatedEvents } = require('../sortEvents');
const { fromKalshiCents } = require('../normalize/priceScaling');

describe('priceScaling', () => {
  test('fromKalshiCents converts cents to 0-1', () => {
    expect(fromKalshiCents(45)).toBeCloseTo(0.45);
    expect(fromKalshiCents(0.45)).toBeCloseTo(0.45);
  });

});

describe('normalizeEvent kalshi', () => {
  test('maps market fields', () => {
    const event = normalizeEvent(
      {
        market: {
          ticker: 'TEST-1',
          yes_bid: 42,
          yes_ask: 45,
          last_price: 44,
          status: 'open',
          close_time: '2025-06-11T12:00:00Z',
        },
        series: { ticker: 'CPI', category: 'economics', title: 'CPI Release' },
        event: { title: 'June CPI' },
      },
      'kalshi'
    );
    expect(event.id).toBe('kalshi:TEST-1');
    expect(event.yes_bid).toBeCloseTo(0.42);
    expect(event.venue).toBe('Kalshi');
  });

  test('uses native Kalshi NO fields and never complements a missing side', () => {
    const native = normalizeEvent({
      market: {
        ticker: 'TEST-NATIVE',
        yes_bid_dollars: '0.42',
        yes_ask_dollars: '0.45',
        no_bid_dollars: '0.54',
        no_ask_dollars: '0.58',
        status: 'active',
      },
    }, 'kalshi');
    const missingNo = normalizeEvent({
      market: {
        ticker: 'TEST-MISSING-NO',
        yes_bid_dollars: '0.42',
        yes_ask_dollars: '0.45',
        status: 'active',
      },
    }, 'kalshi');

    expect(native).toMatchObject({ no_bid: 0.54, no_ask: 0.58 });
    expect(missingNo).toMatchObject({ no_bid: null, no_ask: null });
  });

  test('preserves native top-of-book sizes and retrieval provenance without deriving NO depth', () => {
    const event = normalizeEvent({
      market: {
        ticker: 'TEST-DEPTH',
        yes_bid_dollars: '0.42',
        yes_ask_dollars: '0.45',
        yes_bid_size_fp: '120.00',
        yes_ask_size_fp: '90.00',
        updated_time: '2026-08-09T16:00:00.000Z',
        status: 'active',
      },
    }, 'kalshi');

    expect(event).toMatchObject({
      yes_bid_size: 120,
      yes_ask_size: 90,
      no_bid_size: null,
      no_ask_size: null,
      market_updated_at: '2026-08-09T16:00:00.000Z',
      order_book_provenance: 'kalshi_market_snapshot_top_of_book',
    });
    expect(Number.isFinite(Date.parse(event.quote_retrieved_at))).toBe(true);
    expect(event.updated_at).toBe(event.quote_retrieved_at);
  });
});

describe('isFinancialMacroEvent', () => {
  test('includes CPI market', () => {
    expect(
      isFinancialMacroEvent({
        question: 'Will CPI exceed 3%?',
        category: 'Inflation',
        settlement_source: 'BLS',
      })
    ).toBe(true);
  });

  test('excludes sports without macro settlement', () => {
    expect(
      isFinancialMacroEvent({
        question: 'Will the Chiefs win the Super Bowl?',
        category: 'Other Macro',
      })
    ).toBe(false);
  });
});

describe('enrichEvent', () => {
  test('computes mids and spread', () => {
    const e = enrichEvent({
      yes_bid: 0.4,
      yes_ask: 0.5,
      no_bid: 0.5,
      no_ask: 0.6,
      status: 'open',
      settlement_source: 'BLS',
      volume: 10000,
      updated_at: new Date().toISOString(),
    });
    expect(e.yes_mid).toBeCloseTo(0.45);
    expect(e.spread).toBeCloseTo(0.1);
    expect(e.data_quality_flags).toContain('wide_spread');
  });
});

describe('assignComparisonGroup', () => {
  test('same fingerprint shares group id', () => {
    const a = {
      question: 'Will CPI exceed 3%?',
      underlying: 'CPI',
      event_date: '2025-06-11',
      settlement_source: 'BLS',
    };
    const b = { ...a, venue: 'Kalshi', api_raw_id: '1' };
    const c = { ...a, venue: 'ForecastEx', api_raw_id: '2' };
    const grouped = assignComparisonGroup([b, c]);
    expect(grouped[0].comparison_group_id).toBe(grouped[1].comparison_group_id);
  });
});

describe('sortAggregatedEvents', () => {
  test('open before settled', () => {
    const sorted = sortAggregatedEvents([
      { status: 'settled', event_date: '2025-01-01', volume: 999, spread: 0.01 },
      { status: 'open', event_date: '2025-06-01', volume: 1, spread: 0.5 },
    ]);
    expect(sorted[0].status).toBe('open');
  });
});

describe('comparisonFingerprint', () => {
  test('stable for same inputs', () => {
    const fp1 = comparisonFingerprint({
      question: 'Fed rate above 5%?',
      underlying: 'FF',
      event_date: '2025-03-19',
      settlement_source: 'Federal Reserve',
    });
    const fp2 = comparisonFingerprint({
      question: 'Fed rate above 5%?',
      underlying: 'FF',
      event_date: '2025-03-19',
      settlement_source: 'Federal Reserve',
    });
    expect(fp1).toBe(fp2);
  });
});

describe('mergeCrossVenueEvents', () => {
  test('prefers IBKR quotes and keeps Kalshi OI', () => {
    const grouped = assignComparisonGroup([
      {
        id: 'kalshi:cpi-1',
        venue: 'Kalshi',
        api_raw_id: 'cpi-1',
        question: 'Will CPI exceed 3%?',
        underlying: 'CPI',
        event_date: '2025-06-11',
        settlement_source: 'BLS',
        yes_bid: 0.4,
        yes_ask: 0.42,
        open_interest: 5000,
        liquidity: 8000,
        volume: 1200,
        url: 'https://kalshi.com/markets/cpi-1',
      },
      {
        id: 'cme:999',
        venue: 'CME',
        api_raw_id: '999',
        tradable_in_ibkr: true,
        question: 'Will CPI exceed 3%?',
        underlying: 'CPI',
        event_date: '2025-06-11',
        settlement_source: 'BLS',
        yes_bid: 0.41,
        yes_ask: 0.43,
        volume: 50,
      },
    ]);

    const merged = mergeCrossVenueEvents(grouped);
    expect(merged).toHaveLength(1);
    expect(merged[0].yes_bid).toBeCloseTo(0.41);
    expect(merged[0].yes_ask).toBeCloseTo(0.43);
    expect(merged[0].open_interest).toBe(5000);
    expect(merged[0].liquidity).toBe(8000);
    expect(merged[0].quote_source).toBe('CME');
    expect(merged[0].venues).toEqual(expect.arrayContaining(['Kalshi', 'CME']));
    expect(merged[0].is_merged).toBe(true);
    expect(merged[0].alt_quotes).toHaveLength(2);
  });

  test('single venue rows get canonical metadata', () => {
    const merged = mergeCrossVenueEvents([
      {
        id: 'kalshi:only',
        venue: 'Kalshi',
        api_raw_id: 'only',
        question: 'Only on Kalshi',
        comparison_group_id: 'cg_only',
      },
    ]);
    expect(merged[0].venues).toEqual(['Kalshi']);
    expect(merged[0].is_merged).toBe(false);
  });
});

describe('IBKR-only prediction market status helpers', () => {
  test('keeps only fresh authoritative native IBKR rows', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const now = new Date('2026-07-21T17:00:00Z');
    const fresh = '2026-07-21T16:59:30Z';
    const events = _private.filterIbkrEvents([
      { venue: 'Kalshi', source_api: 'kalshi_trade_api_v2', updated_at: fresh },
      {
        conId: 101,
        venue: 'ForecastEx',
        releaseKey: 'KXCPIYOY#2026-07',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        status: 'open',
        exchange: 'FORECASTX',
        tradingClass: 'KXCPIYOY',
        expiration_time: '20260812',
        catalog_source: 'ibkr_contract_details',
        quote_side: 'YES',
        yes_bid: 0.4,
        yes_ask: 0.41,
        updated_at: fresh,
      },
      {
        conId: 102,
        venue: 'CME',
        releaseKey: 'KXCPIYOY#2026-07',
        source_api: 'IBKR_CPAPI',
        tradable_in_ibkr: true,
        status: 'open',
        exchange: 'CME',
        tradingClass: 'ECPI',
        expiration_time: '20260812',
        catalog_source: 'ibkr_contract_details',
        quote_side: 'NO',
        no_bid: 0.58,
        no_ask: 0.59,
        updated_at: fresh,
      },
      { venue: 'CME', updated_at: fresh },
      { venue: 'IBKR', updated_at: fresh },
      {
        venue: 'Other',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        updated_at: fresh,
      },
      {
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        updated_at: fresh,
        data_quality_flags: ['stale_quote'],
      },
      { venue: 'IBKR', source_api: 'IBKR_PORTFOLIO', updated_at: fresh },
      {
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        updated_at: fresh,
        data_quality_flags: ['portfolio_seed'],
      },
      {
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        updated_at: fresh,
        data_quality_flags: ['portfolio_discovered'],
      },
      {
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        updated_at: '2026-07-21T16:55:00Z',
      },
    ], { now });

    expect(events).toHaveLength(2);
    expect(events.some((event) => event.venue === 'Kalshi')).toBe(false);
    expect(events.some((event) => event.source_api === 'IBKR_PORTFOLIO')).toBe(false);
    expect(events.some((event) => (event.data_quality_flags || []).includes('stale_quote'))).toBe(false);
    expect(events.some((event) => (event.data_quality_flags || []).includes('portfolio_seed'))).toBe(false);
    expect(events.some((event) => (event.data_quality_flags || []).includes('portfolio_discovered'))).toBe(false);
  });

  test('marks connected IBKR provider as empty when no contracts are discovered', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected' },
      cme: { status: 'connected' },
    }, []);

    expect(providers.ibkr.status).toBe('connected_no_contracts');
    expect(providers.ibkr.message).toBe('IBKR connected; no authoritative current-release event contracts discovered');
    expect(providers.forecastex.status).toBe('connected_no_contracts');
    expect(providers.cme.status).toBe('connected_no_contracts');
  });

  test('keeps portfolio exposure separate from current contract-catalog status', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected' },
      cme: { status: 'connected' },
    }, [], { portfolioCpiPositionCount: 4 });

    expect(providers.ibkr.status).toBe('connected_no_contracts');
    expect(providers.ibkr.message).toBe('IBKR connected; no authoritative current-release event contracts discovered');
    expect(providers.ibkr.portfolio_cpi_positions).toBe(4);
    expect(providers.forecastex.status).toBe('connected_no_contracts');
    expect(providers.cme.status).toBe('connected_no_contracts');
  });

  test('keeps connected IBKR provider connected when discovery reports contract rows', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected' },
      cme: { status: 'connected' },
    }, [], { portfolioCpiPositionCount: 4, contractsTotal: 7 });

    expect(providers.ibkr.status).toBe('connected');
    expect(providers.forecastex.status).toBe('connected');
    expect(providers.cme.status).toBe('connected');
  });

  test('marks connected IBKR provider degraded when CPI catalog is incomplete', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: {
        status: 'connected',
        last_success_at: '2026-06-18T18:41:07Z',
        contracts_total: 4,
        portfolio_seed_count: 4,
        cpi_discovery: {
          targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
          foundStrikes: [3.8, 4, 4.1, 4.2],
          missingStrikes: [3.6, 3.7, 3.9],
        },
      },
      forecastex: { status: 'connected' },
      cme: { status: 'connected' },
    }, [], { portfolioCpiPositionCount: 4 });

    expect(providers.ibkr.status).toBe('connected_catalog_incomplete');
    expect(providers.ibkr.message).toBe('IBKR connected; CPI contract catalog incomplete; missing strikes 3.6%, 3.7%, 3.9%');
    expect(providers.ibkr.contracts_total).toBe(4);
    expect(providers.ibkr.portfolio_seed_count).toBe(4);
    expect(providers.forecastex.status).toBe('connected_catalog_incomplete');
    expect(providers.cme.status).toBe('connected_catalog_incomplete');
  });

  test('does not relabel an empty catalog as positions-only', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected_no_contracts', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected_no_contracts' },
      cme: { status: 'connected_no_contracts' },
    }, [], { portfolioCpiPositionCount: 4 });

    expect(providers.ibkr.status).toBe('connected_no_contracts');
    expect(providers.ibkr.portfolio_cpi_positions).toBe(4);
    expect(providers.forecastex.status).toBe('connected_no_contracts');
    expect(providers.cme.status).toBe('connected_no_contracts');
  });

  test('normalizes CPI discovery diagnostics from provider status', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const requestBody = {
      cpi: {
        metric: 'Headline CPI YoY',
        targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
      },
    };
    const diagnostics = _private.getCpiDiscoveryDiagnostics(
      requestBody,
      {},
      null,
      [],
      {
        ibkr: {
          status: 'connected_no_contracts',
          cpi_discovery: {
            targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
            foundStrikes: [4],
            missingStrikes: [3.6, 3.7, 3.8, 3.9, 4.1, 4.2],
          },
          contracts_total: 1,
          contracts_added: 0,
        },
      },
    );

    expect(diagnostics.targetStrikes).toEqual([3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2]);
    expect(diagnostics.foundStrikes).toEqual([4]);
    expect(diagnostics.missingStrikes).toEqual([3.6, 3.7, 3.8, 3.9, 4.1, 4.2]);
    expect(diagnostics.contractsTotal).toBe(1);
    expect(diagnostics.contractsAdded).toBe(0);
  });

  test('combines IBKR and Kalshi CPI strike coverage in diagnostics', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const requestBody = {
      cpi: {
        metric: 'Headline CPI YoY',
        targetStrikes: [3.6, 3.7, 3.8, 3.9, 4],
      },
    };
    const events = [
      {
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
      },
      {
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        contract_title: 'Above 3.6%',
      },
      {
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        contract_title: 'Above 3.7%',
      },
      {
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        contract_title: 'Above 3.9%',
      },
    ];

    const diagnostics = _private.getCpiDiscoveryDiagnostics(
      requestBody,
      {},
      null,
      events,
      { ibkr: { status: 'connected' } },
    );

    expect(diagnostics.ibkrFoundStrikes).toEqual([3.8]);
    expect(diagnostics.kalshiFoundStrikes).toEqual([3.6, 3.7, 3.9]);
    expect(diagnostics.foundStrikes).toEqual([3.6, 3.7, 3.8, 3.9]);
    expect(diagnostics.missingStrikes).toEqual([4]);
  });

  test('prefers IBKR CPI rows and fills missing target strikes from Kalshi', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const requestBody = {
      cpi: {
        targetStrikes: [3.6, 3.8],
      },
    };
    const merged = _private.mergeCpiSourceEvents(
      [
        {
          id: 'ibkr-38',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
        },
      ],
      [
        {
          id: 'kalshi-36',
          venue: 'Kalshi',
          source_api: 'kalshi_trade_api_v2',
          api_raw_symbol: 'KXCPIYOY-26JUN-T3.6',
          contract_title: 'Above 3.6%',
        },
        {
          id: 'kalshi-38',
          venue: 'Kalshi',
          source_api: 'kalshi_trade_api_v2',
          api_raw_symbol: 'KXCPIYOY-26JUN-T3.8',
          contract_title: 'Above 3.8%',
        },
      ],
      requestBody,
    );

    expect(merged.map((event) => event.id)).toEqual(['kalshi-36', 'ibkr-38']);
  });

  test('uses complete active Kalshi CPI rows over incomplete portfolio-discovered sidecar rows', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const requestBody = {
      cpi: {
        targetStrikes: [4.2],
      },
    };
    const merged = _private.mergeCpiSourceEvents(
      [
        {
          id: 'ibkr-42',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUN-T4.2_NO',
          yes_bid: 0.94,
          yes_ask: null,
          no_bid: null,
          no_ask: 0.06,
          data_quality_flags: ['portfolio_discovered'],
        },
      ],
      [
        {
          id: 'kalshi-42',
          venue: 'Kalshi',
          source_api: 'kalshi_trade_api_v2',
          api_raw_symbol: 'KXCPIYOY-26JUN-T4.2',
          contract_title: 'Above 4.2%',
          yes_bid: 0.05,
          yes_ask: 0.06,
          no_bid: 0.94,
          no_ask: 0.95,
        },
      ],
      requestBody,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('kalshi-42');
  });

  test('keeps identical CPI strikes distinct across report months', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const merged = _private.mergeCpiSourceEvents(
      [
        {
          id: 'ibkr-june-40',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
        },
        {
          id: 'ibkr-july-40',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUL-T4.0_YES',
        },
      ],
      [],
      { cpi: { targetStrikes: [4] } },
    );

    expect(merged.map((event) => event.id)).toEqual(['ibkr-june-40', 'ibkr-july-40']);
  });

  test('returns only source-matched CPI events for an active report month', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const requestBody = {
      cpi: {
        forecastMonth: 'July 2026',
        reportMonth: 'July 2026',
        releaseCode: 'Jul 26',
        targetStrikes: [4],
      },
    };
    const merged = _private.mergeCpiSourceEvents(
      [
        {
          id: 'ibkr-june-40',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
        },
        {
          id: 'ibkr-july-40',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          contract_title: 'KXCPIYOY-26JUL-T4.0_YES',
        },
      ],
      [
        {
          id: 'kalshi-july-40',
          venue: 'Kalshi',
          source_api: 'kalshi_trade_api_v2',
          api_raw_symbol: 'KXCPIYOY-26JUL-T4.0',
          contract_title: 'Above 4.0%',
          yes_bid: 0.42,
          yes_ask: 0.43,
          no_bid: 0.57,
          no_ask: 0.58,
        },
      ],
      requestBody,
    );

    expect(merged.map((event) => event.id)).toEqual(['kalshi-july-40']);
    expect(_private.cpiMonthIdForEvent(merged[0])).toBe('2026-07');
  });
});

describe('IBKR CPI payload forwarding', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../providers/ibkrHttp');
    jest.dontMock('../cpiRelease');
  });

  test('refresh posts CPI target context to the sidecar unchanged', async () => {
    jest.resetModules();
    const sidecarRequest = jest.fn().mockResolvedValue({
      events: [],
      providers: { ibkr: { status: 'connected' } },
      fetched_at: '2026-06-19T16:00:00Z',
      cpi_discovery: { targetStrikes: [3.6, 3.7], foundStrikes: [], missingStrikes: [3.6, 3.7] },
      contracts_added: 0,
      contracts_total: 0,
    });
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    const { fetchIBKREvents } = require('../providers/ibkrProvider');
    const cpi = {
      metric: 'Headline CPI YoY',
      forecastMonth: 'June 2026',
      reportMonth: 'June 2026',
      releaseCode: 'Jun 26',
      targetStrikes: [3.6, 3.7],
    };

    await fetchIBKREvents({ cpi });

    expect(sidecarRequest).toHaveBeenCalledWith('/refresh', expect.objectContaining({
      method: 'POST',
      body: { cpi, catalogContracts: [] },
      timeoutMs: 30000,
    }));
  });

  test('forced prediction refresh asks the sidecar for snapshots and missing-only retries', async () => {
    jest.resetModules();
    const sidecarRequest = jest.fn().mockResolvedValue({
      events: [],
      providers: { ibkr: { status: 'catalog_unavailable' } },
      fetched_at: '2026-06-19T16:00:00Z',
      refreshEvidence: {
        mode: 'on_demand_prediction_fanout',
        brokerSnapshotRequestedCount: 0,
      },
    });
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    const { fetchIBKREvents } = require('../providers/ibkrProvider');
    const cpi = { releaseKey: 'KXCPIYOY#2026-08' };

    await fetchIBKREvents({
      cpi,
      catalogContracts: [{ conId: 456 }],
      forceRefresh: true,
      retryMissing: true,
    });

    expect(sidecarRequest).toHaveBeenCalledWith('/refresh', expect.objectContaining({
      method: 'POST',
      body: {
        cpi,
        catalogContracts: [{ conId: 456 }],
        forceRefresh: true,
        retryMissing: true,
      },
      timeoutMs: 30000,
    }));
  });

  test('refresh returns no stale events when IBKR is disconnected', async () => {
    jest.resetModules();
    const sidecarRequest = jest.fn().mockResolvedValue({
      events: [
        {
          id: 'ibkr:stale-cpi',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          data_quality_flags: ['portfolio_seed', 'stale_quote'],
        },
      ],
      providers: {
        ibkr: {
          status: 'tws_offline',
          message: 'IB Gateway/TWS not reachable',
        },
      },
      fetched_at: '2026-06-19T16:00:00Z',
    });
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    const { fetchIBKREvents } = require('../providers/ibkrProvider');

    const events = await fetchIBKREvents({ cpi: { targetStrikes: [4] } });

    expect(events).toEqual([]);
  });

  test('discover posts CPI target context to the sidecar unchanged', async () => {
    jest.resetModules();
    const sidecarRequest = jest.fn().mockResolvedValue({
      ok: true,
      status: 'connected',
      contracts_added: 0,
      contracts_total: 0,
      cpi_discovery: { targetStrikes: [3.9], foundStrikes: [], missingStrikes: [3.9] },
    });
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    const { discoverIbkrEventContracts } = require('../providers/ibkrProvider');
    const body = {
      cpi: {
        metric: 'Headline CPI YoY',
        forecastMonth: 'June 2026',
        reportMonth: 'June 2026',
        releaseCode: 'Jun 26',
        targetStrikes: [3.9],
      },
    };

    await discoverIbkrEventContracts(body);

    expect(sidecarRequest).toHaveBeenCalledWith('/discover', expect.objectContaining({
      method: 'POST',
      body,
      timeoutMs: 20000,
    }));
  });

  test('discover preserves unsupported-or-not-entitled in provider status', async () => {
    jest.resetModules();
    const sidecarRequest = jest.fn().mockResolvedValue({
      ok: false,
      status: 'unsupported_or_not_entitled',
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
      message: 'No supported/entitled ForecastEx CPI product.',
      contracts_added: 0,
      contracts_total: 0,
    });
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    const { discoverIbkrEventContracts } = require('../providers/ibkrProvider');
    const { getProviderStatus } = require('../cache');

    const result = await discoverIbkrEventContracts({
      cpi: { releaseKey: 'KXCPIYOY#2026-07', targetStrikes: [3.9] },
    });

    expect(result.errorCode).toBe('UNSUPPORTED_OR_NOT_ENTITLED');
    expect(getProviderStatus().ibkr).toMatchObject({
      status: 'unsupported_or_not_entitled',
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
    });
  });

  test('discover route returns diagnostics without forcing a quote refresh', async () => {
    jest.resetModules();
    const fetchIBKREvents = jest.fn();
    const discoverIbkrEventContracts = jest.fn().mockResolvedValue({
      ok: true,
      status: 'connected',
      discovered: 1,
      contracts_added: 1,
      contracts_total: 1,
      portfolio_seed_count: 4,
      catalog_promotion: {
        type: 'catalog_candidate',
        status: 'candidate',
        atomic: false,
        releaseKey: 'KXCPIYOY#2026-07',
        authority: 'PredictionMarketCatalogV2',
      },
      catalog_contracts: [{
        conId: 7001,
        api_raw_id: '7001',
        venue: 'ForecastEx',
        releaseKey: 'KXCPIYOY#2026-07',
        catalog_source: 'ibkr_contract_details',
        exchange: 'FORECASTX',
        tradingClass: 'KXCPIYOY',
        lastTradeDateOrContractMonth: '20991231',
        strike: 3.9,
        quote_side: 'YES',
        tradable_in_ibkr: true,
      }],
      cpi_discovery: {
        releaseKey: 'KXCPIYOY#2026-07',
        targetStrikes: [3.9],
        foundStrikes: [3.9],
        missingStrikes: [],
        discovered: 1,
      },
      catalog_qualification: {
        releaseKey: 'KXCPIYOY#2026-07',
        authoritative: true,
        qualifiedContracts: 1,
        freshDiscoveredContracts: 1,
        targetCoverageComplete: true,
        freshTargetCoverageComplete: true,
        missingStrikes: [],
        freshMissingStrikes: [],
        complete: true,
      },
      timing: { phase: 'discovery', total_ms: 25 },
    });
    const sidecarRequest = jest.fn(async (path) => {
      if (path === '/accounts') return { accounts: [] };
      return { positions: [] };
    });

    jest.doMock('../../../services/predictionMarketsIngest', () => ({
      getAggregatedFinancialPredictionEvents: jest.fn(),
      fetchIBKREvents,
    }));
    jest.doMock('../providers/ibkrProvider', () => ({ discoverIbkrEventContracts }));
    jest.doMock('../providers/kalshiProvider', () => ({
      fetchKalshiCpiEvents: jest.fn().mockResolvedValue([]),
    }));
    jest.doMock('../providers/ibkrHttp', () => ({
      sidecarRequest,
      SIDECAR_BASE: 'http://sidecar.test',
    }));
    jest.doMock('../cache', () => ({
      getProviderStatus: jest.fn(() => ({
        ibkr: { status: 'connected' },
        kalshi: { status: 'connected_no_contracts' },
      })),
      setProviderStatus: jest.fn(),
      loadOperationalCatalogByRelease: jest.fn().mockResolvedValue([]),
      persistCatalogEvents: jest.fn().mockImplementation(async (events, meta) => ({
        atomic: true,
        promotedCurrent: meta.promoteCurrent === true,
        releases: [meta.releaseKey],
        contracts: events.length,
        retired: 0,
      })),
    }));
    jest.doMock('../cpiRelease', () => ({
      getCurrentCpiRelease: jest.fn().mockResolvedValue({
        releaseKey: 'KXCPIYOY#2026-07',
        reportMonth: '2026-07',
        cpi: {
          releaseKey: 'KXCPIYOY#2026-07',
          metric: 'Headline CPI YoY',
          forecastMonth: 'July 2026',
          reportMonth: 'July 2026',
          reportMonthId: '2026-07',
          releaseCode: 'Jul 26',
          targetStrikes: [3.9],
        },
        request: { cpi: { targetStrikes: [3.9] } },
      }),
      releaseKeyForEvent: jest.fn((event) => event.releaseKey || null),
    }));
    const router = require('../../../routes/predictionMarketsIngest');
    const layer = router.stack.find((entry) => entry.route?.path === '/discover/ibkr');
    const handler = layer.route.stack[0].handle;
    const req = {
      body: {
        cpi: {
          metric: 'Headline CPI YoY',
          targetStrikes: [3.9],
        },
      },
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await handler(req, res);

    expect(discoverIbkrEventContracts).toHaveBeenCalledWith({
      cpi: expect.objectContaining({
        releaseKey: 'KXCPIYOY#2026-07',
        reportMonthId: '2026-07',
        targetStrikes: [3.9],
      }),
    });
    expect(fetchIBKREvents).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      events: [],
      dashboardEvents: [],
      contractsTotal: 1,
      portfolioSeedCount: 4,
      reconciliation: expect.objectContaining({
        type: 'cpi_catalog_reconciliation',
        trigger: 'manual',
        status: 'succeeded',
        atomicPromotion: true,
      }),
      timing: expect.objectContaining({ phase: 'discovery' }),
    }));
  });

  test('IBKR aggregate route replaces generic rows with a live current-release refresh', async () => {
    jest.resetModules();
    const wrongReleaseEvent = {
      id: 'ibkr:wrong-release',
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      tradable_in_ibkr: true,
      releaseKey: 'KXCPIYOY#2026-06',
      status: 'open',
      yes_bid: 0.4,
      yes_ask: 0.41,
      updated_at: new Date().toISOString(),
      expiration_time: '20991231',
    };
    const currentEvent = {
      ...wrongReleaseEvent,
      id: 'ibkr:current-release',
      releaseKey: 'KXCPIYOY#2026-07',
      conId: 701,
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      catalog_source: 'ibkr_contract_details',
      quote_side: 'YES',
    };
    const getAggregatedFinancialPredictionEvents = jest.fn().mockResolvedValue({
      events: [wrongReleaseEvent],
      reference: {},
      providers: {},
      fetched_at: new Date().toISOString(),
    });
    const fetchIBKREvents = jest.fn().mockResolvedValue([currentEvent]);
    const release = {
      releaseKey: 'KXCPIYOY#2026-07',
      reportMonth: '2026-07',
      cpi: {
        releaseKey: 'KXCPIYOY#2026-07',
        reportMonthId: '2026-07',
        targetStrikes: [3.9],
      },
      request: { cpi: { releaseKey: 'KXCPIYOY#2026-07', targetStrikes: [3.9] } },
    };

    jest.doMock('../../../services/predictionMarketsIngest', () => ({
      getAggregatedFinancialPredictionEvents,
      fetchIBKREvents,
    }));
    jest.doMock('../providers/kalshiProvider', () => ({
      fetchKalshiCpiEvents: jest.fn().mockResolvedValue([]),
    }));
    jest.doMock('../cpiRelease', () => ({
      getCurrentCpiRelease: jest.fn().mockResolvedValue(release),
      releaseKeyForEvent: jest.fn((event) => event.releaseKey || null),
    }));
    const catalogContracts = [{
      conId: 701,
      venue: 'IBKR',
      releaseKey: 'KXCPIYOY#2026-07',
    }];
    jest.doMock('../cache', () => ({
      getProviderStatus: jest.fn(() => ({})),
      setProviderStatus: jest.fn(),
      persistCatalogEvents: jest.fn().mockResolvedValue({ atomic: true }),
      loadOperationalCatalogByRelease: jest.fn().mockResolvedValue(catalogContracts),
    }));

    const router = require('../../../routes/predictionMarketsIngest');
    const layer = router.stack.find((entry) => entry.route?.path === '/aggregated-events');
    const handler = layer.route.stack[0].handle;
    const req = { query: { source: 'ibkr', refresh: 'all' } };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    await handler(req, res);

    expect(fetchIBKREvents).toHaveBeenCalledWith({
      cpi: release.cpi,
      catalogContracts,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      events: [currentEvent],
    }));
    expect(res.json.mock.calls[0][0].events).not.toContainEqual(wrongReleaseEvent);
  });
});

describe('server-owned CPI lifecycle and readiness', () => {
  const currentRelease = {
    releaseKey: 'KXCPIYOY#2026-07',
    reportMonth: '2026-07',
    cpi: {
      releaseKey: 'KXCPIYOY#2026-07',
      reportMonthId: '2026-07',
      forecastMonth: 'July 2026',
      reportMonth: 'July 2026',
      releaseCode: 'Jul 26',
      targetStrikes: [3.3, 3.4],
    },
  };

  test('historical UI context cannot roll the operational refresh backward', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const resolved = _private.resolveOperationalCpiBody({
      cpi: {
        forecastMonth: 'June 2026',
        reportMonth: 'June 2026',
        releaseCode: 'Jun 26',
        targetStrikes: [4.2],
      },
    }, currentRelease);

    expect(resolved.ignoredHistoricalRequest).toBe(true);
    expect(resolved.body.cpi).toEqual(currentRelease.cpi);
    expect(resolved.currentMonth).toBe('2026-07');
  });

  test('live Kalshi can make display ready without claiming IBKR execution', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const now = new Date('2026-07-21T17:00:00Z');
    const readiness = _private.buildCpiReadiness({
      release: currentRelease,
      now,
      events: [{
        id: 'kalshi:july-3.4',
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        releaseKey: 'KXCPIYOY#2026-07',
        status: 'open',
        yes_bid: 0.32,
        yes_ask: 0.33,
        no_bid: 0.67,
        no_ask: 0.68,
        updated_at: '2026-07-21T16:59:30Z',
        close_time: '2026-08-12T12:29:00Z',
        data_quality_flags: [],
      }],
    });

    expect(readiness.display).toMatchObject({ ready: true, venues: ['Kalshi'] });
    expect(readiness.ibkrExecution.ready).toBe(false);
  });

  test('execution readiness requires exact native ContractDetails provenance', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const now = new Date('2026-07-21T17:00:00Z');
    const qualified = {
      id: 'ibkr:july-3.4',
      conId: 7001,
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      tradable_in_ibkr: true,
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      expiration_time: '20260812',
      catalog_source: 'ibkr_contract_details',
      quote_side: 'YES',
      releaseKey: 'KXCPIYOY#2026-07',
      status: 'open',
      yes_bid: 0.32,
      yes_ask: 0.33,
      updated_at: '2026-07-21T16:59:30Z',
      data_quality_flags: [],
    };

    expect(_private.buildCpiReadiness({
      release: currentRelease,
      events: [qualified],
      now,
    }).ibkrExecution.ready).toBe(true);

    const fabricated = { ...qualified };
    delete fabricated.conId;
    delete fabricated.exchange;
    delete fabricated.tradingClass;
    delete fabricated.catalog_source;
    expect(_private.buildCpiReadiness({
      release: currentRelease,
      events: [fabricated],
      now,
    }).ibkrExecution.ready).toBe(false);
  });

  test('wrong-release, expired, mock, seed, and portfolio-derived rows never satisfy readiness', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const base = {
      conId: 701,
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      tradable_in_ibkr: true,
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      catalog_source: 'ibkr_contract_details',
      quote_side: 'YES',
      status: 'open',
      yes_bid: 0.4,
      yes_ask: 0.41,
      updated_at: '2026-07-21T16:59:30Z',
      expiration_time: '20260812',
    };
    const events = [
      { ...base, id: 'wrong', releaseKey: 'KXCPIYOY#2026-06' },
      { ...base, id: 'expired', releaseKey: 'KXCPIYOY#2026-07', expiration_time: '20260714' },
      { ...base, id: 'mock', releaseKey: 'KXCPIYOY#2026-07', data_quality_flags: ['mock'] },
      { ...base, id: 'seed', releaseKey: 'KXCPIYOY#2026-07', data_quality_flags: ['portfolio_seed'] },
      { ...base, id: 'portfolio', releaseKey: 'KXCPIYOY#2026-07', data_quality_flags: ['portfolio_discovered'] },
    ];

    const readiness = _private.buildCpiReadiness({
      release: currentRelease,
      events,
      now: new Date('2026-07-21T17:00:00Z'),
    });

    expect(readiness.display.ready).toBe(false);
    expect(readiness.ibkrExecution.ready).toBe(false);
  });

  test('an old sidecar snapshot yields zero live IBKR rows', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const oldSnapshotRows = _private.filterIbkrEvents([{
      id: 'ibkr:old-july-3.4',
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      tradable_in_ibkr: true,
      releaseKey: 'KXCPIYOY#2026-07',
      status: 'open',
      yes_bid: 0.4,
      yes_ask: 0.41,
      updated_at: '2026-07-21T16:50:00Z',
      expiration_time: '20260812',
      data_quality_flags: [],
    }], {
      now: new Date('2026-07-21T17:00:00Z'),
      maxAgeSeconds: 120,
    });

    expect(oldSnapshotRows).toEqual([]);
  });

  test('readiness preserves unsupported-or-not-entitled as a typed execution failure', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const readiness = _private.buildCpiReadiness({
      release: currentRelease,
      events: [],
      providerErrorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
      now: new Date('2026-07-21T17:00:00Z'),
    });

    expect(readiness.ibkrExecution).toMatchObject({
      ready: false,
      liveContracts: 0,
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
    });
  });

  test('catalog access denial blocks both display and execution with one typed cause', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    expect(_private.normalizeCatalogErrorCode({
      code: 'AccessDeniedException',
      message: 'not authorized to perform dynamodb:Query',
    })).toBe('PREDICTION_CATALOG_ACCESS_DENIED');

    const readiness = _private.buildCpiReadiness({
      release: currentRelease,
      events: [],
      providerErrorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
      displayErrorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
      now: new Date('2026-07-21T17:00:00Z'),
    });

    expect(readiness.display.errorCode).toBe('PREDICTION_CATALOG_ACCESS_DENIED');
    expect(readiness.ibkrExecution.errorCode).toBe('PREDICTION_CATALOG_ACCESS_DENIED');
  });
});
