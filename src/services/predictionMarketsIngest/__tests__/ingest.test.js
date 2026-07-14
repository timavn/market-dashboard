const { normalizeEvent, comparisonFingerprint } = require('../normalize/normalizeEvent');
const { isFinancialMacroEvent } = require('../filter/isFinancialMacroEvent');
const { enrichEvent } = require('../enrich/enrichEvent');
const { assignComparisonGroup } = require('../group/assignComparisonGroup');
const { mergeCrossVenueEvents } = require('../merge/mergeCrossVenueEvents');
const { sortAggregatedEvents } = require('../sortEvents');
const { fromKalshiCents, deriveNoFromYes } = require('../normalize/priceScaling');

describe('priceScaling', () => {
  test('fromKalshiCents converts cents to 0-1', () => {
    expect(fromKalshiCents(45)).toBeCloseTo(0.45);
    expect(fromKalshiCents(0.45)).toBeCloseTo(0.45);
  });

  test('deriveNoFromYes complements yes prices', () => {
    const { no_bid, no_ask } = deriveNoFromYes(0.4, 0.45);
    expect(no_bid).toBeCloseTo(0.55);
    expect(no_ask).toBeCloseTo(0.6);
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
  test('filters out Kalshi rows and keeps IBKR-tradable venues', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const events = _private.filterIbkrEvents([
      { venue: 'Kalshi', source_api: 'kalshi_trade_api_v2' },
      { venue: 'ForecastEx', source_api: 'IBKR_TWS_API' },
      { venue: 'CME' },
      { venue: 'IBKR' },
      { venue: 'Other', tradable_in_ibkr: true },
      { venue: 'IBKR', source_api: 'IBKR_TWS_API', data_quality_flags: ['stale_quote'] },
      { venue: 'IBKR', source_api: 'IBKR_PORTFOLIO' },
      { venue: 'IBKR', source_api: 'IBKR_TWS_API', data_quality_flags: ['portfolio_seed'] },
      { venue: 'IBKR', source_api: 'IBKR_TWS_API', data_quality_flags: ['portfolio_discovered'] },
    ]);

    expect(events).toHaveLength(4);
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
    expect(providers.ibkr.message).toBe('IBKR connected, no event contracts discovered');
    expect(providers.forecastex.status).toBe('connected_no_contracts');
    expect(providers.cme.status).toBe('connected_no_contracts');
  });

  test('marks connected IBKR provider as positions-only when CPI positions exist without catalog rows', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected' },
      cme: { status: 'connected' },
    }, [], { portfolioCpiPositionCount: 4 });

    expect(providers.ibkr.status).toBe('connected_positions_only');
    expect(providers.ibkr.message).toBe('IBKR connected; CPI positions loaded from portfolio, contract catalog missing');
    expect(providers.ibkr.portfolio_cpi_positions).toBe(4);
    expect(providers.forecastex.status).toBe('connected_positions_only');
    expect(providers.cme.status).toBe('connected_positions_only');
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

    expect(providers.ibkr.status).toBe('connected_positions_only');
    expect(providers.ibkr.message).toBe('IBKR connected; CPI contract catalog incomplete; missing strikes 3.6%, 3.7%, 3.9%');
    expect(providers.ibkr.contracts_total).toBe(4);
    expect(providers.ibkr.portfolio_seed_count).toBe(4);
    expect(providers.forecastex.status).toBe('connected_positions_only');
    expect(providers.cme.status).toBe('connected_positions_only');
  });

  test('upgrades connected_no_contracts to positions-only when CPI portfolio exposure exists', () => {
    const { _private } = require('../../../routes/predictionMarketsIngest');
    const providers = _private.withIbkrContractStatus({
      ibkr: { status: 'connected_no_contracts', last_success_at: '2026-06-18T18:41:07Z' },
      forecastex: { status: 'connected_no_contracts' },
      cme: { status: 'connected_no_contracts' },
    }, [], { portfolioCpiPositionCount: 4 });

    expect(providers.ibkr.status).toBe('connected_positions_only');
    expect(providers.ibkr.portfolio_cpi_positions).toBe(4);
    expect(providers.forecastex.status).toBe('connected_positions_only');
    expect(providers.cme.status).toBe('connected_positions_only');
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
          contract_title: 'Above 3.6%',
        },
        {
          id: 'kalshi-38',
          venue: 'Kalshi',
          source_api: 'kalshi_trade_api_v2',
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
});

describe('IBKR CPI payload forwarding', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../providers/ibkrHttp');
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
      body: { cpi },
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

  test('discover route returns diagnostics without forcing a quote refresh', async () => {
    jest.resetModules();
    const fetchIBKREvents = jest.fn();
    const discoverIbkrEventContracts = jest.fn().mockResolvedValue({
      ok: true,
      status: 'connected',
      contracts_added: 0,
      contracts_total: 0,
      portfolio_seed_count: 4,
      cpi_discovery: { targetStrikes: [3.9], foundStrikes: [], missingStrikes: [3.9] },
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

    expect(discoverIbkrEventContracts).toHaveBeenCalledWith(req.body);
    expect(fetchIBKREvents).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      events: [],
      dashboardEvents: [],
      contractsTotal: 0,
      portfolioSeedCount: 4,
      timing: expect.objectContaining({ phase: 'discovery' }),
    }));
  });
});
