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

function fundingReferenceEvidence(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    connected: true,
    status: 'reference',
    source: 'ibkr_completed_session_reference',
    account: 'U1',
    observed_at: observedAt,
    socket_verified_at: observedAt,
    summary: {
      account: 'U1',
      baseCurrency: 'USD',
      AccountReady: true,
      NetLiquidation: 195000,
      TotalCashValue: 114000,
      'TotalCashValue-S': 114000,
      'TotalCashValue-C': 0,
      'MaintMarginReq-C': 0,
      'GrossPositionValue-S': 295000,
      StockMarketValue: 95000,
      'AccruedCash-S': 0,
      'SettledCashByDate-S': '20260725:115000;20260727:114000',
      'SettledCashByDate-C': '20260725:0;20260727:0',
      CashBalance: { USD: 114000 },
    },
    funding: null,
    fundingReference: {
      schemaVersion: 1,
      referenceOnly: true,
      actionable: false,
      referenceKind:
        'completed_market_session_with_current_settlement_ladder',
      referenceSessionDate: '2026-07-24',
      cashLedgerObservedDate: '2026-07-25',
      settlementHorizonDate: '2026-07-27',
      accountValuesObservedAt: observedAt,
      openPositionCount: 2,
      shortPositionCount: 1,
      openOrderCount: 0,
      executionCountObserved: 0,
      cashBalances: { USD: 114000 },
      shortStockReferenceCloseValue: 100000,
      shortPositionReferenceEvidence: [{
        conId: 756733,
        symbol: 'MACRO',
        currency: 'USD',
        quantity: -1000,
        referenceClose: 100,
        referenceCloseSource: 'ibkr_historical_daily_close',
        referenceCloseSessionDate: '2026-07-24',
        referenceCloseObservedAt: observedAt,
      }],
      positionScope: {
        allStock: true,
        allBaseCurrency: true,
      },
      settlementVerification:
        'reference_segment_ladders_double_snapshot',
    },
    ...overrides,
  };
}

function installLiveMocks({
  positions = [],
  summary = { NetLiquidation: 190539.25 },
  fundingOverrides = {},
  fundingError = null,
  fundingResponse = null,
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
    if (requestPath.startsWith('/portfolio/live-funding')) {
      if (fundingError) throw fundingError;
      if (fundingResponse) return fundingResponse;
      const fundingObservedAt = new Date().toISOString();
      const shortPositionEvidence = positions
        .filter((position) => Number(position.position) < 0)
        .map((position) => ({
          conId: position.conId || 1,
          symbol: position.symbol,
          currency: position.currency || 'USD',
          quantity: Number(position.position),
          priorClose: 100,
          priorCloseSource: 'ibkr_live_tick_close',
          priorCloseSessionDate: '2026-07-22',
          priorCloseObservedAt: fundingObservedAt,
          currentPrice: 100.25,
          currentPriceSource: 'ibkr_ticker_direct_max',
          directAsk: 100.25,
          directBid: 99.75,
          directLast: 100,
          snapshotTimestamp: fundingObservedAt,
          marketDataType: 1,
        }));
      return liveEvidence({
        account: 'U1',
        summary: {
          account: 'U1',
          baseCurrency: 'USD',
          AccountReady: true,
          'TotalCashValue-S': 100000,
          'TotalCashValue-C': 0,
          'MaintMarginReq-C': 0,
          'GrossPositionValue-S': Number(summary.GrossPositionValue || 0),
          StockMarketValue: 0,
          'AccruedCash-S': 0,
          'SettledCashByDate-S': '20260723:100000',
          'SettledCashByDate-C': '20260723:0',
          ...summary,
        },
        funding: {
          accountValuesObservedAt: fundingObservedAt,
          shortPositionEvidence,
          openPositionCount: positions.filter((position) => Number(position.position) !== 0).length,
          shortPositionCount: shortPositionEvidence.length,
          positionScope: { allStock: true, allBaseCurrency: true },
          openOrderCount: 0,
          settledShortPositionsVerified: true,
          settlementStatus: 'settled',
          noSameDayExecutionsVerified: true,
          sameDayExecutionCount: 0,
          ...fundingOverrides,
        },
      });
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
    expect(snapshot.funding.shortPositions[0]).toMatchObject({
      symbol: 'SHORT_A',
      quantity: -20,
      priorClose: 100,
      priorCloseSource: 'ibkr_live_tick_close',
      priorCloseSessionDate: '2026-07-22',
      priorCloseObservedAt: expect.any(String),
      currentPrice: 100.25,
      currentPriceSource: 'ibkr_ticker_direct_max',
      directAsk: 100.25,
      directBid: 99.75,
      directLast: 100,
      marketDataType: 1,
    });
    expect(sidecarRequest.mock.calls.some(([requestPath]) => requestPath.startsWith('/cache/'))).toBe(false);
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
      fundingError: new Error('funding unavailable'),
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

  test('accepts a verified empty portfolio and uses only the live funding-summary NLV', async () => {
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
    expect(sidecarRequest).toHaveBeenCalledWith(
      '/portfolio/live-funding?account=U1',
      { timeoutMs: 25000 },
    );
  });

  test('passes through only a fresh same-account live funding snapshot', async () => {
    installLiveMocks({
      summary: {
        NetLiquidation: 190539.25,
        TotalCashValue: 90000,
        GrossPositionValue: 250000,
      },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.accountSummary).toMatchObject({
      netLiquidation: 190539.25,
      totalCashValue: 90000,
      grossPositionValue: 250000,
    });
    expect(snapshot.funding).toMatchObject({
      accountId: 'U1',
      status: 'live',
      source: 'ibkr_live_session',
      fromCache: false,
      accountReady: true,
      totalCashValueSecurities: 100000,
      settledCashByDateSecurities: '20260723:100000',
      settledCashByDateCommodities: '20260723:0',
      openOrderCount: 0,
      settledShortPositionsVerified: true,
      settlementStatus: 'settled',
      noSameDayExecutionsVerified: true,
      sameDayExecutionCount: 0,
    });
    expect(sidecarRequest).toHaveBeenCalledWith(
      '/portfolio/live-funding?account=U1',
      { timeoutMs: 25000 },
    );
  });

  test('passes through a broker-verified weekend reference without promoting it to live funding', async () => {
    const fundingResponse = fundingReferenceEvidence();
    installLiveMocks({ fundingResponse });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding).toBeNull();
    expect(snapshot.fundingUnavailableReason).toBe('non_settlement_day');
    expect(snapshot.fundingReference).toMatchObject({
      schemaVersion: 1,
      referenceOnly: true,
      actionable: false,
      accountId: 'U1',
      status: 'reference',
      source: 'ibkr_completed_session_reference',
      fromCache: false,
      referenceSessionDate: '2026-07-24',
      cashLedgerObservedDate: '2026-07-25',
      settlementHorizonDate: '2026-07-27',
      shortPositionCount: 1,
      openOrderCount: 0,
      shortPositionReferences: [{
        conId: 756733,
        quantity: -1000,
        referenceClose: 100,
        referenceCloseSource: 'ibkr_historical_daily_close',
      }],
    });
    expect(snapshot.fundingReference.shortPositionReferences[0])
      .not.toHaveProperty('currentPrice');
  });

  test('retries one transient funding timeout before dropping the weekend reference', async () => {
    let fundingCalls = 0;
    sidecarRequest.mockImplementation(async (requestPath) => {
      if (requestPath === '/accounts') {
        return { ok: true, accounts: ['U1'] };
      }
      if (requestPath === '/portfolio/live-positions') {
        return liveEvidence({ positions: [] });
      }
      if (requestPath.startsWith('/portfolio/reference-marks')) {
        return referenceEvidence();
      }
      if (requestPath.startsWith('/portfolio/live-funding')) {
        fundingCalls += 1;
        if (fundingCalls === 1) {
          throw Object.assign(new Error('transient'), {
            sidecarCode: 'FUNDING_SNAPSHOT_TIMEOUT',
            status: 503,
          });
        }
        return fundingReferenceEvidence();
      }
      if (requestPath.startsWith('/portfolio/pnl')) {
        return { ok: true, pnl: null };
      }
      throw new Error(`Unexpected sidecar request: ${requestPath}`);
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(fundingCalls).toBe(2);
    expect(snapshot.fundingReference).toMatchObject({
      status: 'reference',
      referenceSessionDate: '2026-07-24',
    });
    expect(snapshot.fundingUnavailableReason).toBe('non_settlement_day');
  });

  test.each([
    ['wrong source', (response) => {
      response.source = 'ibkr_live_session';
    }],
    ['actionable flag', (response) => {
      response.fundingReference.actionable = true;
    }],
    ['live quote field', (response) => {
      response.fundingReference.shortPositionReferenceEvidence[0]
        .currentPrice = 100;
    }],
    ['cross-account response', (response) => {
      response.account = 'U2';
    }],
  ])('rejects a weekend funding reference with %s', async (_label, mutate) => {
    const fundingResponse = fundingReferenceEvidence();
    mutate(fundingResponse);
    sidecarRequest.mockResolvedValue(fundingResponse);

    const snapshot = await ibkrPortfolio.getLiveFundingSnapshot('U1');

    expect(snapshot).toBeNull();
  });

  test('does not convert missing or legacy short evidence into a verified empty array', async () => {
    installLiveMocks({
      fundingOverrides: {
        shortPositionEvidence: undefined,
        shortPositions: [],
      },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding.shortPositions).toBeNull();
  });

  test('does not substitute response observation time for missing account-value evidence', async () => {
    installLiveMocks({
      fundingOverrides: {
        accountValuesObservedAt: undefined,
      },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding.accountValuesObservedAt).toBeNull();
    expect(snapshot.funding.observedAt).not.toBeNull();
  });

  test('preserves missing settlement attestation as unavailable evidence', async () => {
    installLiveMocks({
      fundingOverrides: {
        settledShortPositionsVerified: undefined,
        settlementStatus: undefined,
        noSameDayExecutionsVerified: undefined,
        sameDayExecutionCount: '0',
      },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding.settledShortPositionsVerified).toBeNull();
    expect(snapshot.funding.settlementStatus).toBeNull();
    expect(snapshot.funding.noSameDayExecutionsVerified).toBeNull();
    expect(snapshot.funding.sameDayExecutionCount).toBeNull();
  });

  test('preserves exact short currency and snapshot fields without legacy fallbacks', async () => {
    installLiveMocks({
      fundingOverrides: {
        shortPositionEvidence: [{
          conId: 1,
          symbol: 'NO-FALLBACK',
          quantity: -1,
          priorClose: 100,
          priorCloseSource: 'ibkr_live_tick_close',
          currentPrice: 100,
          currentPriceSource: 'ibkr_ticker_direct_max',
          directBid: 100,
          directAsk: 100,
          timestamp: new Date().toISOString(),
          marketDataType: 1,
        }],
        shortPositionCount: 1,
      },
    });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding.shortPositions[0].currency).toBeNull();
    expect(snapshot.funding.shortPositions[0].snapshotTimestamp).toBeNull();
  });

  test('propagates only the sanitized unsettled funding reason', async () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fundingError = Object.assign(
      new Error('contains sensitive broker details 12345'),
      { sidecarCode: 'UNSETTLED_SECURITIES_ACTIVITY', status: 503 },
    );
    installLiveMocks({ fundingError });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding).toBeNull();
    expect(snapshot.fundingUnavailableReason).toBe(
      'unsettled_securities_activity',
    );
    expect(JSON.stringify(snapshot)).not.toContain('12345');
    expect(JSON.stringify(warningSpy.mock.calls)).not.toContain('12345');
    warningSpy.mockRestore();
  });

  test('propagates only the sanitized non-settlement-day funding reason', async () => {
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fundingError = Object.assign(
      new Error('contains sensitive broker details 67890'),
      { sidecarCode: 'NON_SETTLEMENT_DAY', status: 503 },
    );
    installLiveMocks({ fundingError });

    const snapshot = await ibkrPortfolio.getPortfolioSnapshot('U1');

    expect(snapshot.funding).toBeNull();
    expect(snapshot.fundingUnavailableReason).toBe('non_settlement_day');
    expect(JSON.stringify(snapshot)).not.toContain('67890');
    expect(JSON.stringify(warningSpy.mock.calls)).not.toContain('67890');
    warningSpy.mockRestore();
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
