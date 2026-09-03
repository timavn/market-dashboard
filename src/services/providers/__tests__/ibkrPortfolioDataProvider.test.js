const { sidecarRequest } = require('../ibkrSidecarClient');
const ibkrPortfolio = require('../ibkr/ibkrPortfolioDataProvider');

jest.mock('../ibkrSidecarClient', () => ({
  sidecarRequest: jest.fn(),
  getSidecarProviderStatus: jest.fn().mockResolvedValue({ connected: true }),
}));

function liveEvidence(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    connected: true,
    status: 'live',
    source: 'ibkr_live_session',
    accounts: ['U1'],
    positions: [],
    observed_at: observedAt,
    socket_verified_at: observedAt,
    ...overrides,
  };
}

function referenceEvidence({
  marks = [],
  failures = [],
  pending = [],
  account = 'U1',
  overrides = {},
} = {}) {
  const observedAt = new Date().toISOString();
  const warming = pending.length > 0;
  const requestedConIds = new Set([
    ...marks.map((row) => row.conId),
    ...failures.map((row) => row.conId),
    ...pending.map((row) => row.conId),
  ].filter((value) => value != null));
  const completedCount = [...requestedConIds]
    .filter((conId) => !pending.some((row) => row.conId === conId))
    .filter((conId) => !failures.some((row) => row.conId === conId))
    .length;
  return {
    ok: true,
    connected: true,
    status: warming ? 'warming' : failures.length > 0 ? 'partial' : 'reference',
    source: 'ibkr_portfolio_reference_marks',
    account,
    accounts: ['U1'],
    requested_count: requestedConIds.size,
    mark_count: marks.length,
    reference_close_count:
      marks.filter((mark) => mark.referenceClose != null).length,
    live_mark_count: marks.filter((mark) => mark.priceState === 'live').length,
    historical_mark_count:
      marks.filter((mark) => mark.priceState === 'historical_close').length,
    warming,
    warming_count: pending.length,
    failure_count: failures.length,
    marks,
    pending,
    failures,
    progress: {
      state: warming ? 'warming' : failures.length > 0 ? 'degraded' : 'complete',
      requestedCount: requestedConIds.size,
      completedCount,
      pendingCount: pending.length,
      exhaustedFailureCount: failures.length,
      progressPercent:
        requestedConIds.size > 0
          ? (completedCount / requestedConIds.size) * 100
          : 100,
      startedAt: observedAt,
      updatedAt: observedAt,
      completedAt: warming ? null : observedAt,
      socketVerifiedAt: observedAt,
      positionsObservedAt: observedAt,
      lastErrorCode: null,
      lastErrorAt: null,
    },
    observed_at: observedAt,
    socket_verified_at: observedAt,
    ...overrides,
  };
}

function balanceSidecarEvidence(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    connected: true,
    status: 'live',
    source: 'ibkr_live_session',
    from_cache: false,
    account: 'U1',
    observed_at: observedAt,
    socket_verified_at: observedAt,
    snapshotId: 'balance-snapshot-1',
    summary: {
      account: 'U1',
      baseCurrency: 'USD',
      AccountReady: true,
      NetLiquidation: 195000,
      EquityWithLoanValue: 190000,
      InitMarginReq: 80000,
      MaintMarginReq: 75000,
      AvailableFunds: 110000,
      ExcessLiquidity: 115000,
      BuyingPower: 380000,
      TotalCashValue: 114000,
      'TotalCashValue-S': 114000,
      'TotalCashValue-C': 0,
      'MaintMarginReq-C': 0,
      'GrossPositionValue-S': 295000,
      StockMarketValue: 95000,
      'AccruedCash-S': 0,
      'SettledCashByDate-S': '20260805:115000;20260807:114000',
      'SettledCashByDate-C': '20260805:0;20260807:0',
      CashBalance: { USD: 114000 },
    },
    balanceEvidence: {
      accountValuesObservedAt: observedAt,
      openPositionCount: 2,
      shortPositionCount: 1,
      openOrderCount: 0,
      sameDayExecutionCount: 1,
      positionScope: { allStock: true, allBaseCurrency: true },
      settlementLaddersVerified: true,
      activitySnapshotVerified: true,
      settlementState: 'pending',
      settlementDate: '2026-08-05',
      settlementHorizonDate: '2026-08-07',
      settlementVerification: 'segment_ladders_double_snapshot',
      shortPositionEvidence: [{
        conId: 756733,
        symbol: 'MACRO',
        currency: 'USD',
        quantity: -1000,
        priorClose: 100,
        priorCloseSource: 'ibkr_historical_daily_close',
        priorCloseSessionDate: '2026-08-04',
        priorCloseObservedAt: observedAt,
      }],
    },
    ...overrides,
  };
}

function singleEventBalanceEvidence({
  exchange = 'FORECASTX',
  secType = 'FOP',
} = {}) {
  const response = balanceSidecarEvidence();
  response.summary['TotalCashValue-C'] = 100;
  response.summary['SettledCashByDate-C'] = '20260805:100;20260807:100';
  response.summary['GrossPositionValue-C'] = 250;
  response.summary['NetLiquidation-C'] = 350;
  response.summary['InitMarginReq-C'] = 250;
  response.summary['MaintMarginReq-C'] = 250;
  response.summary['AvailableFunds-C'] = 100;
  response.summary['EquityWithLoanValue-C'] = 100;
  response.balanceEvidence.openPositionCount = 3;
  response.balanceEvidence.positionScope = {
    mode: 'stocks_and_event_contracts',
    allSupportedForBalance: true,
    allStock: false,
    allBaseCurrency: true,
    stockPositionCount: 2,
    eventPositionCount: 1,
    eventVenues: [exchange],
  };
  response.balanceEvidence.eventPositionEvidence = [{
    conId: 910875954,
    symbol: 'FFRATE',
    localSymbol: 'FFRATE-YES',
    tradingClass: 'FFRATE',
    exchange,
    secType,
    currency: 'USD',
    multiplier: 1,
    quantity: 5500.35,
  }];
  response.balanceEvidence.eventAccounting = {
    venues: [exchange],
    positionCount: 1,
    marketValue: 250,
    initialMargin: 250,
    maintenanceMargin: 250,
    availableFunds: 100,
    equityWithLoanValue: 100,
    capacityContribution: 0,
    verification: 'ibkr_event_contract_commodity_segment_reconciled',
    accountValues: {
      'NetLiquidation-C': 350,
      'TotalCashValue-C': 100,
      'GrossPositionValue-C': 250,
      'InitMarginReq-C': 250,
      'MaintMarginReq-C': 250,
      'AvailableFunds-C': 100,
      'EquityWithLoanValue-C': 100,
    },
  };
  return response;
}

function installLiveMocks({
  positions = [],
  summary = { NetLiquidation: 190539.25 },
  referenceResponse = null,
  accountSummaryAvailable = true,
} = {}) {
  sidecarRequest.mockImplementation(async (requestPath) => {
    if (requestPath === '/portfolio/live-positions') {
      return liveEvidence({ positions });
    }
    if (requestPath === '/accounts') {
      return { ok: true, accounts: ['U1'], fetched_at: new Date().toISOString() };
    }
    if (requestPath.startsWith('/portfolio/live-account-summary')) {
      if (!accountSummaryAvailable) {
        return { ok: false, summary: null };
      }
      return liveEvidence({
        account: 'U1',
        summary: { account: 'U1', currency: 'USD', ...summary },
      });
    }
    if (requestPath.startsWith('/portfolio/reference-marks')) {
      return referenceResponse || referenceEvidence();
    }
    if (requestPath.startsWith('/portfolio/pnl')) return { ok: true, pnl: null };
    throw new Error(`Unexpected sidecar request: ${requestPath}`);
  });
}

describe('ibkrPortfolioDataProvider live-session integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds side counts only from a fresh socket-verified position snapshot', async () => {
    installLiveMocks({
      positions: [
        { account: 'U1', symbol: 'LONG_A', position: 10, secType: 'STK' },
        { account: 'U1', symbol: 'SHORT_A', position: -20, secType: 'STK' },
        { account: 'U1', symbol: 'CLOSED', position: 0, secType: 'STK' },
      ],
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fromCache: false,
      summary: { longCount: 1, shortCount: 1, positionCount: 2 },
    });
    expect(snapshot.holdings.map((holding) => holding.symbol)).not.toContain('CLOSED');
    expect(snapshot.holdings.every((holding) => holding.positionSource === 'ibkr_live_session')).toBe(true);
    expect(snapshot).not.toHaveProperty('funding');
    expect(sidecarRequest.mock.calls.some(([requestPath]) => requestPath.startsWith('/cache/'))).toBe(false);
  });

  test('keeps ForecastEx contracts out of the securities portfolio while retaining EXPGY', async () => {
    const eventPositions = [
      { conId: 913869765, localSymbol: 'FES_082126_7700_YES', position: 2500 },
      { conId: 913869775, localSymbol: 'FES_082126_7725_YES', position: 5000 },
      { conId: 913869780, localSymbol: 'FES_082126_7750_YES', position: 4999 },
    ].map((position) => ({
      account: 'U1',
      symbol: 'ES',
      secType: 'FOP',
      ...position,
    }));
    const failures = [
      ...eventPositions.map((position) => ({
        account: 'U1',
        conId: position.conId,
        symbol: position.localSymbol,
        errorCode: 'REFERENCE_MARK_NO_TRADE_IN_LOOKBACK',
        stage: 'historical_daily_close',
      })),
      {
        account: 'U1',
        conId: 41197624,
        symbol: 'EXPGY',
        errorCode: 'REFERENCE_MARK_NO_TRADE_IN_LOOKBACK',
        stage: 'historical_daily_close',
      },
    ];
    installLiveMocks({
      positions: [
        ...eventPositions,
        {
          account: 'U1',
          conId: 41197624,
          symbol: 'EXPGY',
          localSymbol: 'EXPGY',
          position: 112.5,
          secType: 'STK',
          exchange: 'PINK',
        },
      ],
      referenceResponse: referenceEvidence({ failures }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings).toEqual([
      expect.objectContaining({
        symbol: 'EXPGY',
        secType: 'STK',
        exchange: 'PINK',
        isPredictionMarket: false,
      }),
    ]);
    expect(snapshot.summary).toMatchObject({
      positionCount: 1,
      longCount: 1,
      shortCount: 0,
    });
    expect(snapshot.dataQuality).toMatchObject({
      predictionMarketContractCount: 3,
      predictionMarketContractSymbols: ['ES', 'ES', 'ES'],
      markFailureCount: 1,
      missingMarketValueCount: 1,
      missingMarketValueSymbols: ['EXPGY'],
    });
    expect(snapshot.referenceMarks.failures).toEqual([
      expect.objectContaining({ conId: 41197624, symbol: 'EXPGY' }),
    ]);
  });

  test('retries one transient live-position transport failure without using cached data', async () => {
    installLiveMocks({
      positions: [
        { account: 'U1', symbol: 'LONG_A', position: 10, secType: 'STK' },
      ],
    });
    sidecarRequest.mockRejectedValueOnce(new Error('temporary sidecar timeout'));

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      dataSource: 'ibkr_api',
      liveSessionVerified: true,
      fromCache: false,
      summary: { longCount: 1, positionCount: 1 },
    });
    expect(
      sidecarRequest.mock.calls.filter(
        ([requestPath]) => requestPath === '/portfolio/live-positions',
      ),
    ).toHaveLength(2);
    expect(
      sidecarRequest.mock.calls.some(
        ([requestPath]) => requestPath.startsWith('/cache/'),
      ),
    ).toBe(false);
  });

  test('does not enrich missing IBKR values with cached or fallback quotes', async () => {
    installLiveMocks({
      positions: [{ account: 'U1', symbol: 'MISSING', position: 10, secType: 'STK' }],
    });
    const quoteFn = jest.fn().mockResolvedValue({
      MISSING: { mark: 12, source: 'yahoo', timestamp: new Date().toISOString() },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1', quoteFn);

    expect(quoteFn).not.toHaveBeenCalled();
    expect(snapshot.holdings[0]).toMatchObject({
      price: null,
      marketValue: null,
      priceSource: null,
      warning: 'missing_market_value',
    });
    expect(snapshot.dataQuality.status).toBe('partial');
  });

  test('uses exact-conId completed IBKR closes as explicitly stale reference values', async () => {
    const observedAt = new Date().toISOString();
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          position: 2,
          price: 101,
          priceState: 'historical_close',
          priceSource: 'ibkr_historical_daily_close',
          priceSessionDate: '2026-07-24',
          priceObservedAt: observedAt,
          referenceClose: 101,
          referenceCloseSource: 'ibkr_historical_daily_close',
          referenceCloseSessionDate: '2026-07-24',
          referenceCloseObservedAt: observedAt,
          previousClose: 99,
          previousCloseSessionDate: '2026-07-23',
          marketDataType: null,
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      symbol: 'SPY',
      conid: 101,
      price: 101,
      priceState: 'historical_close',
      marketValue: 202,
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
      priceSessionDate: '2026-07-24',
      referenceClose: 101,
      referenceCloseSessionDate: '2026-07-24',
      previousClose: 99,
      previousCloseSessionDate: '2026-07-23',
      dayPriceChange: 2,
      dayChange: 4,
      dayGainLoss: 4,
      dayChangeState: 'historical_session',
      warning: null,
    });
    expect(snapshot.holdings[0].dayChangePercent).toBeCloseTo((2 / 99) * 100);
    expect(snapshot.dataQuality).toMatchObject({
      status: 'stale',
      markState: 'reference',
      liveMarkCount: 0,
      historicalMarkCount: 1,
      missingMarketValueCount: 0,
      markFailureCount: 0,
      latestReferenceSessionDate: '2026-07-24',
    });
    expect(snapshot.referenceMarks).toMatchObject({
      status: 'reference',
      markCount: 1,
      historicalMarkCount: 1,
      failureCount: 0,
    });
    expect(snapshot.referenceMarks.marksByConId).toBeUndefined();
    expect(sidecarRequest).toHaveBeenCalledWith(
      '/portfolio/reference-marks?account=U1&include_live=true',
      { timeoutMs: 5000 },
    );
    expect(sidecarRequest.mock.calls.some(([requestPath]) => requestPath.startsWith('/cache/'))).toBe(false);
  });

  test('reports partial cache fill as warming without synthesizing mark failures', async () => {
    const observedAt = new Date().toISOString();
    installLiveMocks({
      positions: [
        {
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          position: 2,
          avgCost: 90,
          secType: 'STK',
        },
        {
          account: 'U1',
          conId: 202,
          symbol: 'TLT',
          position: 3,
          avgCost: 80,
          secType: 'STK',
        },
      ],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          price: 101,
          priceState: 'historical_close',
          priceSource: 'ibkr_historical_daily_close',
          priceSessionDate: '2026-07-24',
          priceObservedAt: observedAt,
          referenceClose: 101,
          referenceCloseSource: 'ibkr_historical_daily_close',
          referenceCloseSessionDate: '2026-07-24',
          referenceCloseObservedAt: observedAt,
          previousClose: 99,
          previousCloseSessionDate: '2026-07-23',
        }],
        pending: [{
          account: 'U1',
          conId: 202,
          symbol: 'TLT',
          state: 'warming',
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      symbol: 'SPY',
      marketValue: 202,
      markPending: false,
    });
    expect(snapshot.holdings[1]).toMatchObject({
      symbol: 'TLT',
      marketValue: null,
      markPending: true,
      markWarmState: 'warming',
      markFailure: null,
      warning: 'reference_mark_warming',
    });
    expect(snapshot.summary.totalGainLoss).toBeNull();
    expect(snapshot.dataQuality).toMatchObject({
      status: 'stale',
      markState: 'warming',
      warmingMarketValueCount: 1,
      unavailableMarketValueCount: 0,
      markFailureCount: 0,
      markWarmState: 'warming',
    });
    expect(snapshot.referenceMarks).toMatchObject({
      status: 'warming',
      warming: true,
      warmingCount: 1,
      failureCount: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain('REFERENCE_MARK_MISSING');
  });

  test('keeps a due cached mark usable while its replacement warms', async () => {
    const observedAt = '2026-07-24T21:00:00.000Z';
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        avgCost: 90,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          price: 101,
          priceState: 'historical_close',
          priceSource: 'ibkr_historical_daily_close',
          priceSessionDate: '2026-07-24',
          priceObservedAt: observedAt,
          referenceClose: 101,
          referenceCloseSource: 'ibkr_historical_daily_close',
          referenceCloseSessionDate: '2026-07-24',
          referenceCloseObservedAt: observedAt,
          previousClose: 99,
          previousCloseSessionDate: '2026-07-23',
        }],
        pending: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          state: 'warming',
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      marketValue: 202,
      priceState: 'historical_close',
      markPending: true,
      warning: 'reference_mark_warming',
    });
    expect(snapshot.dataQuality).toMatchObject({
      status: 'stale',
      missingMarketValueCount: 0,
      warmingMarketValueCount: 0,
      markState: 'warming',
    });
  });

  test('accepts only a fresh direct IBKR live-last mark and retains prior-close provenance', async () => {
    const observedAt = new Date().toISOString();
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          position: 2,
          price: 102,
          priceState: 'live',
          priceSource: 'ibkr_live_last',
          priceSessionDate: null,
          priceObservedAt: observedAt,
          referenceClose: 101,
          referenceCloseSource: 'ibkr_historical_daily_close',
          referenceCloseSessionDate: '2026-07-24',
          referenceCloseObservedAt: observedAt,
          previousClose: 99,
          previousCloseSessionDate: '2026-07-23',
          marketDataType: 1,
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      price: 102,
      priceState: 'live',
      marketValue: 204,
      marketValueState: 'live',
      priceSource: 'ibkr_live_last',
      priceSessionDate: null,
      referenceClose: 101,
      dayPriceChange: 1,
      dayChange: 2,
      dayGainLoss: 2,
      dayChangeState: 'live_vs_reference_close',
    });
    expect(snapshot.dataQuality).toMatchObject({
      status: 'ok',
      markState: 'live',
      liveMarkCount: 1,
      historicalMarkCount: 0,
      missingMarketValueCount: 0,
    });
  });

  test('rejects a live-last older than the 60-second contract', async () => {
    const staleLiveAt = new Date(Date.now() - 2 * 60_000).toISOString();
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          price: 102,
          priceState: 'live',
          priceSource: 'ibkr_live_last',
          priceObservedAt: staleLiveAt,
          marketDataType: 1,
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      price: null,
      marketValue: null,
    });
    expect(snapshot.dataQuality.markFailures[0]).toMatchObject({
      conId: 101,
      errorCode: 'REFERENCE_MARK_INVALID',
    });
  });

  test('never substitutes marked holdings for a verified live NLV', async () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const observedAt = new Date().toISOString();
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      accountSummaryAvailable: false,
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          price: 101,
          priceState: 'historical_close',
          priceSource: 'ibkr_historical_daily_close',
          priceSessionDate: '2026-07-24',
          priceObservedAt: observedAt,
          referenceClose: 101,
          referenceCloseSource: 'ibkr_historical_daily_close',
          referenceCloseSessionDate: '2026-07-24',
          referenceCloseObservedAt: observedAt,
          previousClose: 99,
          previousCloseSessionDate: '2026-07-23',
          marketDataType: null,
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.accountSummary).toBeNull();
    expect(snapshot.holdings[0].marketValue).toBe(202);
    expect(snapshot.summary.totalValue).toBeNull();
    expect(snapshot.summary.totalValue).not.toBe(202);
    warningSpy.mockRestore();
  });

  test('rejects a stale or cross-account mark instead of joining by symbol', async () => {
    const staleObservedAt = '2026-07-15T12:00:00.000Z';
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        marks: [{
          account: 'U2',
          conId: 101,
          symbol: 'SPY',
          price: 102,
          priceState: 'live',
          priceSource: 'ibkr_live_last',
          priceObservedAt: staleObservedAt,
          marketDataType: 1,
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0]).toMatchObject({
      price: null,
      marketValue: null,
      priceState: 'unavailable',
      warning: 'missing_market_value',
    });
    expect(snapshot.dataQuality).toMatchObject({
      status: 'partial',
      markState: 'unavailable',
      missingMarketValueCount: 1,
      markFailureCount: 1,
    });
    expect(snapshot.dataQuality.markFailures[0]).toMatchObject({
      account: 'U1',
      conId: 101,
      errorCode: 'REFERENCE_MARK_INVALID',
      stage: 'reference_marks_validation',
    });
  });

  test('preserves sanitized per-contract mark failures without raw broker messages', async () => {
    installLiveMocks({
      positions: [{
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        position: 2,
        secType: 'STK',
      }],
      referenceResponse: referenceEvidence({
        failures: [{
          account: 'U1',
          conId: 101,
          symbol: 'SPY',
          errorCode: 'REFERENCE_MARK_HISTORY_TIMEOUT',
          stage: 'historical_daily_close',
          message: 'sensitive raw broker text 12345',
          retryable: true,
          observedAt: new Date().toISOString(),
        }],
      }),
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.holdings[0].markFailure).toMatchObject({
      account: 'U1',
      conId: 101,
      symbol: 'SPY',
      errorCode: 'REFERENCE_MARK_HISTORY_TIMEOUT',
      stage: 'historical_daily_close',
      retryable: true,
      observedAt: expect.any(String),
    });
    expect(snapshot.dataQuality.markFailureCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('12345');
  });

  test('accepts a verified empty portfolio from the live account-summary path only', async () => {
    installLiveMocks();

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      holdings: [],
      liveSessionVerified: true,
      fromCache: false,
      accountSummary: {
        netLiquidation: 190539.25,
        source: 'ibkr_live_session',
      },
      summary: { totalValue: 190539.25, positionCount: 0 },
    });
    expect(sidecarRequest.mock.calls.some(([path]) => path.includes('live-balance')))
      .toBe(false);
  });

  test('calculates a live balance from pending settlement ladders', async () => {
    sidecarRequest.mockResolvedValue(balanceSidecarEvidence());

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance).toMatchObject({
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      accountId: 'U1',
      fromCache: false,
      snapshotId: 'balance-snapshot-1',
      settlement: { state: 'pending', horizonDate: '2026-08-07' },
      activity: { sameDayExecutionCount: 1, previewAvailable: true },
      freshness: { status: 'fresh', maxAgeMs: 45000 },
      cash: {
        netAccruedInterest: 0,
        noBorrowBalance: 12000,
        noBorrowLongLimit: 207000,
      },
      buffer: { balance: 4900 },
      exposure: {
        available: true,
        longMarketValue: 195000,
        shortMarketValue: 100000,
      },
      margin: {
        available: true,
        health: 'healthy',
        availableFunds: 110000,
        excessLiquidity: 115000,
        buyingPower: 380000,
        actionable: false,
      },
      interestExposure: {
        available: true,
        interpretation: 'debit_interest_exposure_only',
        actionable: false,
        projected: { estimatedDebitPrincipal: 0 },
        policy: { estimatedDebitPrincipalAfterReserve: 0 },
      },
      capacity: { available: true, status: 'live' },
    });
    expect(sidecarRequest).toHaveBeenCalledWith(
      '/portfolio/live-balance?account=U1',
      { timeoutMs: 13000 },
    );
  });

  test('fails closed when broker-native margin evidence is incomplete', async () => {
    const response = balanceSidecarEvidence();
    delete response.summary.ExcessLiquidity;
    sidecarRequest.mockResolvedValue(response);

    await expect(ibkrPortfolio.getPortfolioBalance('U1')).rejects.toMatchObject({
      code: 'BALANCE_MARGIN_INVALID',
    });
  });

  test('returns verified exposure-only evidence with explicit unavailable margin', async () => {
    const response = balanceSidecarEvidence();
    response.balanceEvidence.capacityAvailable = false;
    response.balanceEvidence.capacityUnavailableCode = 'EVENT_CONTRACT_ACCOUNTING_UNRECONCILED';
    response.balanceEvidence.capacityUnavailableMessage = 'Event accounting did not reconcile.';
    response.balanceEvidence.positionScope = {
      allStock: false,
      allBaseCurrency: false,
    };
    response.balanceEvidence.openPositionCount = null;
    response.balanceEvidence.shortPositionCount = null;
    response.balanceEvidence.openOrderCount = null;
    response.balanceEvidence.sameDayExecutionCount = null;
    response.balanceEvidence.shortPositionEvidence = [];
    response.balanceEvidence.positionEvidence = [];
    [
      'EquityWithLoanValue',
      'InitMarginReq',
      'MaintMarginReq',
      'AvailableFunds',
      'ExcessLiquidity',
      'BuyingPower',
      'TotalCashValue',
      'TotalCashValue-S',
      'TotalCashValue-C',
      'MaintMarginReq-C',
      'AccruedCash-S',
      'SettledCashByDate-S',
      'SettledCashByDate-C',
      'CashBalance',
    ].forEach((key) => delete response.summary[key]);
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance).toMatchObject({
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      exposure: {
        available: true,
        netLiquidation: 195000,
        grossMarketValue: 295000,
        netMarketValue: 95000,
      },
      margin: {
        available: false,
        status: 'unavailable',
        errorCode: 'BALANCE_MARGIN_UNAVAILABLE',
        reason: 'broker_native_margin_evidence_unavailable',
      },
      capacity: {
        available: false,
        errorCode: 'EVENT_CONTRACT_ACCOUNTING_UNRECONCILED',
        reason: 'event_contract_accounting_unreconciled',
      },
      settlement: null,
      activity: null,
      cash: null,
      buffer: null,
    });
  });

  test('exposes signed net accrued interest only from exact securities-segment evidence', async () => {
    const response = balanceSidecarEvidence();
    response.summary['AccruedCash-S'] = -102.32;
    response.summary.AccruedCash = 999;
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.cash.netAccruedInterest).toBe(-102.32);
    expect(balance.cash.accruedDebitReserve).toBe(102.32);

    const missingExact = balanceSidecarEvidence();
    delete missingExact.summary['AccruedCash-S'];
    missingExact.summary.AccruedCash = -102.32;
    sidecarRequest.mockResolvedValue(missingExact);

    const unavailable = await ibkrPortfolio.getPortfolioBalance('U1');
    expect(unavailable.capacity).toMatchObject({
      available: false,
      reason: 'invalid_accruedCashSecurities',
    });
    expect(unavailable.cash).toBeNull();
  });

  test('does not amplify a transient busy balance read with a provider retry', async () => {
    sidecarRequest
      .mockRejectedValueOnce(Object.assign(new Error('busy'), {
        sidecarCode: 'BALANCE_SNAPSHOT_BUSY',
      }))
      .mockResolvedValueOnce(balanceSidecarEvidence());

    await expect(ibkrPortfolio.getPortfolioBalance('U1')).rejects.toMatchObject({
      sidecarCode: 'BALANCE_SNAPSHOT_BUSY',
    });

    expect(sidecarRequest).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['cross-account', (response) => { response.account = 'U2'; }],
    ['cached', (response) => { response.from_cache = true; }],
    ['stale', (response) => {
      const stale = new Date(Date.now() - 46_000).toISOString();
      response.observed_at = stale;
      response.socket_verified_at = stale;
      response.balanceEvidence.accountValuesObservedAt = stale;
    }],
  ])('fails closed for %s portfolio-balance evidence', async (_label, mutate) => {
    const response = balanceSidecarEvidence();
    mutate(response);
    sidecarRequest.mockResolvedValue(response);

    await expect(ibkrPortfolio.getPortfolioBalance('U1')).rejects.toBeTruthy();
  });

  test('keeps current exposure live when short-position evidence is missing', async () => {
    const response = balanceSidecarEvidence();
    response.balanceEvidence.openPositionCount = 0;
    response.balanceEvidence.shortPositionCount = 0;
    response.balanceEvidence.shortPositionEvidence = [];
    response.balanceEvidence.positionEvidence = [];
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance).toMatchObject({
      available: true,
      status: 'live',
      exposure: {
        available: true,
        longMarketValue: 195000,
        shortMarketValue: 100000,
      },
      capacity: {
        available: false,
        reason: 'short_position_evidence_missing',
      },
      cash: null,
      buffer: null,
    });
  });

  test('keeps current exposure live while unreconciled cash blocks capacity', async () => {
    const response = balanceSidecarEvidence();
    response.summary['TotalCashValue-S'] = 113000;
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.exposure).toMatchObject({
      available: true,
      grossMarketValue: 295000,
      netMarketValue: 95000,
    });
    expect(balance.capacity).toMatchObject({
      available: false,
      reason: 'securities_cash_ladder_unreconciled',
    });
  });

  test('honors a sidecar instrument-scope blocker without erasing exposure', async () => {
    const response = balanceSidecarEvidence();
    response.balanceEvidence.capacityAvailable = false;
    response.balanceEvidence.capacityUnavailableCode = 'POSITION_SCOPE_UNSUPPORTED';
    response.balanceEvidence.positionScope = {
      allStock: false,
      allBaseCurrency: true,
    };
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.exposure.available).toBe(true);
    expect(balance.margin).toMatchObject({
      available: true,
      status: 'live',
      health: 'healthy',
    });
    expect(balance.capacity).toMatchObject({
      available: false,
      errorCode: 'POSITION_SCOPE_UNSUPPORTED',
      reason: 'position_scope_unsupported',
    });
  });

  test('accepts a reconciled Kalshi position scope and keeps event contracts out of stock exposure', async () => {
    const response = balanceSidecarEvidence();
    response.summary['TotalCashValue-C'] = 100;
    response.summary['SettledCashByDate-C'] = '20260805:100;20260807:100';
    response.summary['GrossPositionValue-C'] = 250;
    response.summary['NetLiquidation-C'] = 350;
    response.summary['InitMarginReq-C'] = 250;
    response.summary['MaintMarginReq-C'] = 250;
    response.summary['AvailableFunds-C'] = 100;
    response.summary['EquityWithLoanValue-C'] = 100;
    response.balanceEvidence.openPositionCount = 3;
    response.balanceEvidence.positionScope = {
      mode: 'stocks_and_kalshi',
      allSupportedForBalance: true,
      allStock: false,
      allBaseCurrency: true,
      stockPositionCount: 1,
      eventPositionCount: 2,
    };
    response.balanceEvidence.positionEvidence = [{
      conId: 756733,
      symbol: 'MACRO',
      quantity: -1000,
      currency: 'USD',
    }];
    response.balanceEvidence.eventPositionEvidence = [
      {
        conId: 882701217,
        symbol: 'KXCPIYOY',
        localSymbol: 'KXCPIYOY-YES',
        tradingClass: 'KXCPIYOY',
        exchange: 'KALSHI',
        secType: 'OPT',
        currency: 'USD',
        multiplier: 1,
        quantity: 10,
      },
      {
        conId: 882701270,
        symbol: 'KXCPIYOY',
        localSymbol: 'KXCPIYOY-NO',
        tradingClass: 'KXCPIYOY',
        exchange: 'KALSHI',
        secType: 'OPT',
        currency: 'USD',
        multiplier: 1,
        quantity: 15,
      },
    ];
    response.balanceEvidence.eventAccounting = {
      venue: 'KALSHI',
      positionCount: 2,
      marketValue: 250,
      initialMargin: 250,
      maintenanceMargin: 250,
      availableFunds: 100,
      equityWithLoanValue: 100,
      capacityContribution: 0,
      verification: 'ibkr_kalshi_commodity_segment_reconciled',
      accountValues: {
        'NetLiquidation-C': 350,
        'TotalCashValue-C': 100,
        'GrossPositionValue-C': 250,
        'InitMarginReq-C': 250,
        'MaintMarginReq-C': 250,
        'AvailableFunds-C': 100,
        'EquityWithLoanValue-C': 100,
      },
    };
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.capacity.available).toBe(true);
    expect(balance.positions).toHaveLength(1);
    expect(balance.eventPositions).toHaveLength(2);
    expect(balance.eventContracts).toMatchObject({
      venues: ['KALSHI'],
      venue: 'KALSHI',
      positionCount: 2,
      contractQuantity: 25,
      marketValue: 250,
      capacityContribution: 0,
    });
    expect(balance.cash.commodityResidual).toBe(100);
  });

  test('accepts canonical ForecastX and mixed event venues with generic accounting', async () => {
    const response = balanceSidecarEvidence();
    response.summary['TotalCashValue-C'] = 100;
    response.summary['SettledCashByDate-C'] = '20260805:100;20260807:100';
    response.summary['GrossPositionValue-C'] = 250;
    response.summary['NetLiquidation-C'] = 350;
    response.summary['InitMarginReq-C'] = 250;
    response.summary['MaintMarginReq-C'] = 250;
    response.summary['AvailableFunds-C'] = 100;
    response.summary['EquityWithLoanValue-C'] = 100;
    response.balanceEvidence.openPositionCount = 3;
    response.balanceEvidence.positionScope = {
      mode: 'stocks_and_event_contracts',
      allSupportedForBalance: true,
      allStock: false,
      allBaseCurrency: true,
      stockPositionCount: 1,
      eventPositionCount: 2,
      eventVenues: ['FORECASTX', 'KALSHI'],
    };
    response.balanceEvidence.positionEvidence = [{
      conId: 756733,
      symbol: 'MACRO',
      quantity: -1000,
      currency: 'USD',
    }];
    response.balanceEvidence.eventPositionEvidence = [
      {
        conId: 882701217,
        symbol: 'FFCPIYOY',
        localSymbol: 'FF-CPI-YES',
        tradingClass: 'FF-CPI',
        exchange: 'FORECASTX',
        secType: 'FOP',
        currency: 'USD',
        multiplier: 1,
        quantity: 10,
      },
      {
        conId: 882701270,
        symbol: 'KXCPIYOY',
        localSymbol: 'KXCPIYOY-NO',
        tradingClass: 'KXCPIYOY',
        exchange: 'KALSHI',
        secType: 'OPT',
        currency: 'USD',
        multiplier: 1,
        quantity: 15,
      },
    ];
    response.balanceEvidence.eventAccounting = {
      venues: ['FORECASTX', 'KALSHI'],
      positionCount: 2,
      marketValue: 250,
      initialMargin: 250,
      maintenanceMargin: 250,
      availableFunds: 100,
      equityWithLoanValue: 100,
      capacityContribution: 0,
      verification: 'ibkr_event_contract_commodity_segment_reconciled',
      accountValues: {
        'NetLiquidation-C': 350,
      },
    };
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.capacity.available).toBe(true);
    expect(balance.positionScope).toBe('stocks_and_event_contracts');
    expect(balance.eventPositions[0]).toMatchObject({
      exchange: 'FORECASTX',
      secType: 'FOP',
    });
    expect(balance.eventContracts).toMatchObject({
      venues: ['FORECASTX', 'KALSHI'],
      venue: null,
      positionCount: 2,
      contractQuantity: 25,
      marketValue: 250,
      verification: 'ibkr_event_contract_commodity_segment_reconciled',
    });
  });

  test.each([
    ['Kalshi FOP', { exchange: 'KALSHI', secType: 'FOP' }],
    ['ForecastX unsupported security type', { exchange: 'FORECASTX', secType: 'FUT' }],
  ])('keeps %s event evidence unavailable', async (_label, contract) => {
    sidecarRequest.mockResolvedValue(singleEventBalanceEvidence(contract));

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.capacity.available).toBe(false);
    expect(balance.capacity.reasons)
      .toContain('event_contract_accounting_unverified');
    expect(balance.eventContracts).toBeNull();
  });

  test('requires one unique canonical event row per conId', async () => {
    const response = singleEventBalanceEvidence();
    response.balanceEvidence.openPositionCount += 1;
    response.balanceEvidence.positionScope.eventPositionCount = 2;
    response.balanceEvidence.eventAccounting.positionCount = 2;
    response.balanceEvidence.eventPositionEvidence.push({
      ...response.balanceEvidence.eventPositionEvidence[0],
      quantity: 10000.437,
    });
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.capacity.available).toBe(false);
    expect(balance.capacity.reasons)
      .toContain('event_contract_accounting_unverified');
    expect(balance.eventContracts).toBeNull();
  });

  test('keeps malformed canonical event evidence unavailable', async () => {
    const response = balanceSidecarEvidence();
    response.balanceEvidence.openPositionCount = 1;
    response.balanceEvidence.positionScope = {
      mode: 'stocks_and_event_contracts',
      allSupportedForBalance: true,
      allBaseCurrency: true,
      eventPositionCount: 1,
      eventVenues: ['FORECASTX'],
    };
    response.balanceEvidence.eventPositionEvidence = [{
      conId: 1,
      exchange: 'UNKNOWN',
      secType: 'OPT',
      currency: 'USD',
      multiplier: 1,
      quantity: 1,
    }];
    response.balanceEvidence.eventAccounting = {
      venues: ['FORECASTX'],
      positionCount: 1,
      verification: 'ibkr_event_contract_commodity_segment_reconciled',
    };
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.capacity.available).toBe(false);
    expect(balance.capacity.reasons).toContain('event_contract_accounting_unverified');
    expect(balance.eventContracts).toBeNull();
  });

  test('keeps the live balance available while open orders disable preview', async () => {
    const response = balanceSidecarEvidence();
    response.balanceEvidence.openOrderCount = 2;
    sidecarRequest.mockResolvedValue(response);

    const balance = await ibkrPortfolio.getPortfolioBalance('U1');

    expect(balance.available).toBe(true);
    expect(balance.activity).toMatchObject({
      openOrderCount: 2,
      previewAvailable: false,
      previewUnavailableReason: 'open_orders_present',
    });
  });

  test('re-reads the balance and returns a read-only long preview', async () => {
    sidecarRequest.mockResolvedValue(balanceSidecarEvidence());

    const preview = await ibkrPortfolio.getPortfolioBalancePreview({
      accountId: 'U1',
      action: 'add_long',
      amount: 5000,
    });

    expect(preview).toMatchObject({
      available: true,
      status: 'preview',
      accountId: 'U1',
      orderSubmitted: false,
      cash: { noBorrowBalance: 7000 },
      exposure: { longMarketValue: 200000 },
    });
  });

  test('requires verified live quote and shortability evidence for add-short preview', async () => {
    sidecarRequest.mockImplementation(async (requestPath) => {
      if (requestPath.startsWith('/portfolio/live-balance?')) {
        return balanceSidecarEvidence();
      }
      if (requestPath === '/portfolio/live-balance/preview-evidence') {
        const observedAt = new Date().toISOString();
        return {
          ok: true,
          available: true,
          connected: true,
          status: 'live',
          source: 'ibkr_live_session',
          from_cache: false,
          account: 'U1',
          conId: 756733,
          action: 'add_short',
          positionQuantity: -1000,
          bid: 100,
          ask: 100.1,
          currentPrice: 101,
          shortableShares: 1000,
          marketDataType: 1,
          quoteObservedAt: observedAt,
          observed_at: observedAt,
          socket_verified_at: observedAt,
        };
      }
      throw new Error(`Unexpected sidecar request: ${requestPath}`);
    });

    const preview = await ibkrPortfolio.getPortfolioBalancePreview({
      accountId: 'U1',
      action: 'add_short',
      conId: 756733,
      quantity: 100,
      limitPrice: 99,
    });

    expect(preview.available).toBe(true);
    expect(preview.orderSubmitted).toBe(false);
    expect(sidecarRequest).toHaveBeenCalledWith(
      '/portfolio/live-balance/preview-evidence',
      expect.objectContaining({
        method: 'POST',
        body: {
          account: 'U1',
          conId: 756733,
          action: 'add_short',
          quantity: 100,
        },
      }),
    );
  });

  test('fails closed on stale or unverified position evidence', async () => {
    sidecarRequest.mockResolvedValueOnce(liveEvidence({
      observed_at: '2026-07-15T12:00:00.000Z',
      socket_verified_at: '2026-07-15T12:00:00.000Z',
      positions: [{ account: 'U1', symbol: 'STALE', position: 1 }],
    }));

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot).toMatchObject({
      holdings: [],
      liveSessionVerified: false,
      accountSummary: null,
    });
    expect(snapshot.error).toMatch(/fresh socket-verified/i);
    expect(sidecarRequest).toHaveBeenCalledTimes(1);
  });

  test('never returns a prior PnL value after the live request stops producing data', async () => {
    let pnlAvailable = true;
    sidecarRequest.mockImplementation(async (requestPath) => {
      if (requestPath === '/accounts') return { ok: true, accounts: ['U1'] };
      if (requestPath.startsWith('/portfolio/pnl')) {
        return pnlAvailable
          ? liveEvidence({ account: 'U1', pnl: { dailyPnL: 25, dailyPnLPercent: 9.9 } })
          : { ok: false, pnl: null };
      }
      throw new Error(`Unexpected sidecar request: ${requestPath}`);
    });

    expect(await ibkrPortfolio.getPnL('U1')).toMatchObject({
      dailyPnL: 25,
      dailyPnLPercent: null,
      source: 'ibkr_live_session',
      fromCache: false,
    });
    pnlAvailable = false;
    expect(await ibkrPortfolio.getPnL('U1')).toBeNull();
  });
});
