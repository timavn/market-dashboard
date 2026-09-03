const {
  applyContractSchedule,
  applyReviewPatch,
  buildContractLabel,
  createLedgerStore,
  createReconciler,
  createRevisionRecord,
  contractIdentity,
  finalizeLifecycle,
  FORECASTEX_LEDGER_MODEL_VERSION,
  forecastExLastTradingAt,
  forecastExThresholdIdentity,
  hasSupportedContractIdentity,
  isVerifiedLiveEvidence,
  loadPerformance,
  normalizeExecution,
  normalizeActivePerformanceRow,
  normalizePerformanceRow,
  normalizeMarket,
  newYorkCalendarDate,
  persistCaptureEntries,
  reconcileEvidence,
  reconstructForecastExEconomicRecords,
  sortPerformanceRows,
  summarizeRows,
} = require('./predictionMarketPerformanceLedger.cjs');

const now = new Date().toISOString();

const livePayload = (extra = {}) => ({
  ok: true,
  status: 'live',
  source: 'ibkr_live',
  complete: true,
  coverageComplete: true,
  partial: false,
  snapshotId: 'snapshot-1',
  fetchedAt: now,
  ...extra,
});

const execution = ({ id, side, quantity, price, commission = 0.1, time, symbol, localSymbol, exchange = 'FORECASTX' }) => ({
  accountId: 'U123',
  execId: id,
  conId: 9001,
  symbol: symbol || 'KXWTI-26AUG13-T81.49-YES',
  localSymbol: localSymbol || symbol || 'KXWTI-26AUG13-T81.49-YES',
  exchange,
  secType: 'OPT',
  expiration: '20260813',
  strike: 81.49,
  contractSide: 'YES',
  side,
  quantity,
  price,
  commission,
  executionTime: time || now,
});

describe('prediction market performance ledger', () => {
  test('normalizes concise contract labels for supported markets', () => {
    expect(buildContractLabel({ symbol: 'KXWTI-26AUG13-81.49-YES', strike: 81.49, contractSide: 'YES' })).toBe('WTI $81.49 YES');
    expect(buildContractLabel({ symbol: 'KXINX-26AUG13-7760-NO', strike: 7760, contractSide: 'NO' })).toBe('SP500 7,760 NO');
    expect(buildContractLabel({ symbol: 'KXCPI-26AUG-3.3-YES', strike: 3.3, contractSide: 'YES' })).toBe('CPI 3.3% YES');
    expect(buildContractLabel({ symbol: 'KXWTI-26AUG13-81.49-YES' })).toBe('WTI $81.49 YES');
    expect(normalizeMarket(null, 'METLG_081426_3412_NO')).toBe('gold');
    expect(normalizeMarket(null, 'KXGOLDD-26SEP0117-T4386_YES')).toBe('gold');
    expect(normalizeMarket(null, 'FES_081426_7800_YES')).toBe('sp500');
    expect(normalizeMarket(null, 'FNQ_081426_30100_NO')).toBe('nasdaq100');
    expect(normalizeMarket(null, 'KXBTC-26AUG1417-B62500_YES')).toBe('bitcoin');
    expect(normalizeMarket(null, 'KXETH-26AUG1417-B4200_NO')).toBe('ethereum');
    expect(normalizeMarket(null, 'COMCO_081426_82_NO')).toBe('wti');
    expect(buildContractLabel({ localSymbol: 'METLG_081426_3412_NO', strike: 3412, contractSide: 'NO' })).toBe('Gold $3,412 NO');
    expect(buildContractLabel({ localSymbol: 'KXGOLDD-26SEP0117-T4386_YES' })).toBe('Gold $4,386 YES');
    expect(buildContractLabel({ localSymbol: 'FNQ_081426_30100_NO', strike: 30100, contractSide: 'NO' })).toBe('NQ 30,100 NO');
    expect(buildContractLabel({ localSymbol: 'KXBTC-26AUG1417-B62500_YES', strike: 62500, contractSide: 'YES' })).toBe('BTC $62,500 YES');
    expect(buildContractLabel({ localSymbol: 'KXETH-26AUG1417-B4200_NO', strike: 4200, contractSide: 'NO' })).toBe('ETH $4,200 NO');
    expect(normalizeExecution({
      accountId: 'U123', execId: 'compact-time', conId: 1, symbol: 'KXWTI-26AUG13-T81.49_YES',
      side: 'BOT', quantity: 1, price: 0.4, commission: 0, executionTime: '20260813T15:04:05',
    }, 'U123').executionTime).toBe('2026-08-13T15:04:05.000Z');
    expect(newYorkCalendarDate('2026-08-14T03:59:59Z')).toBe('2026-08-13');
    expect(newYorkCalendarDate('2026-08-14T04:00:00Z')).toBe('2026-08-14');
  });

  test('captures exact Kalshi and ForecastEx threshold identities while rejecting conflicting broker fields', () => {
    expect(contractIdentity({
      exchange: 'FORECASTX',
      localSymbol: 'KXINXU-26AUG14H1600-T7760_NO',
      expiration: '20260814',
    })).toMatchObject({
      market: 'sp500',
      eventTicker: 'KXINXU-26AUG14H1600',
      strike: 7760,
      contractSide: 'NO',
      contractRule: 'above',
    });
    expect(hasSupportedContractIdentity({
      market: 'wti',
      exchange: 'FORECASTX',
      contractKey: 'COMCO_20260813_T82_NO',
      contractSide: 'NO',
      contractRule: 'above',
      strike: 82,
    })).toBe(false);
    expect(contractIdentity({
      exchange: 'FORECASTX',
      localSymbol: 'COMCO_081326_82_NO',
      expiration: '20260813',
      strike: 82,
      contractSide: 'P',
    })).toMatchObject({
      market: 'wti',
      eventTicker: 'COMCO_081326_82',
      contractRule: 'above',
      contractSide: 'NO',
      strike: 82,
    });
    expect(hasSupportedContractIdentity({
      market: 'wti',
      exchange: 'FORECASTX',
      contractKey: 'COMCO_081326_82_NO',
      eventTicker: 'COMCO_081326_82',
      expiration: '20260813',
      contractSide: 'NO',
      contractRule: 'above',
      strike: 82,
    })).toBe(true);
    expect(contractIdentity({
      exchange: 'FORECASTX',
      symbol: 'METLG',
      localSymbol: 'METLG_081426_4400_YES',
      tradingClass: 'METLG',
      secType: 'OPT',
      expiration: '20260814',
      strike: 4400,
      contractSide: 'C',
    })).toMatchObject({
      market: 'gold',
      eventTicker: 'METLG_081426_4400',
      contractRule: 'above',
      contractSide: 'YES',
      strike: 4400,
    });
    expect(contractIdentity({
      exchange: 'FORECASTX',
      symbol: 'ES',
      localSymbol: 'FES_081426_7775_NO',
      tradingClass: 'FES',
      secType: 'FOP',
      expiration: '20260814',
      strike: 7775,
      contractSide: 'P',
    })).toMatchObject({
      market: 'sp500',
      eventTicker: 'FES_081426_7775',
      contractRule: 'above',
      contractSide: 'NO',
      strike: 7775,
    });
    const forecastExCpi = contractIdentity({
      exchange: 'FORECASTX',
      symbol: 'CPIY',
      localSymbol: 'CPIY_0726_3.4_YES',
      tradingClass: 'CPIY',
      secType: 'OPT',
      expiration: '20260812',
      strike: 3.4,
      contractSide: 'C',
    });
    expect(forecastExCpi).toMatchObject({
      market: 'cpi',
      eventTicker: 'CPIY_0726_3.4',
      expiration: '20260812',
      contractRule: 'above',
      contractSide: 'YES',
      strike: 3.4,
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
    });
    expect(hasSupportedContractIdentity(forecastExCpi)).toBe(true);
    const flexForecastExCpi = contractIdentity({
      exchange: 'FORECASTX',
      symbol: 'CPIY_0626_3.8_YES',
      localSymbol: 'CPIY_0626_3.8_YES',
      secType: 'EVENT_FORECASTX',
      expiration: '2026-07-14',
    });
    expect(flexForecastExCpi).toMatchObject({
      market: 'cpi',
      eventTicker: 'CPIY_0626_3.8',
      expiration: '2026-07-14',
      contractRule: 'above',
      contractSide: 'YES',
      strike: 3.8,
    });
    expect(hasSupportedContractIdentity(flexForecastExCpi)).toBe(true);
    expect(contractIdentity({
      exchange: '--',
      symbol: 'CPIY_0626_3.8_NO',
      localSymbol: 'CPIY_0626_3.8_NO',
      secType: 'EVENT_FORECASTX',
      expiration: '2026-07-14',
    })).toMatchObject({
      market: 'cpi', eventTicker: 'CPIY_0626_3.8', contractRule: 'above', contractSide: 'NO', strike: 3.8,
    });
    [
      { localSymbol: 'METLG_081426_4400_YES', symbol: 'METLG', tradingClass: 'METLG', secType: 'FOP', expiration: '20260814', strike: 4400, contractSide: 'C' },
      { localSymbol: 'METLG_081426_4400_YES', symbol: 'METLG', tradingClass: 'METLG', secType: 'OPT', expiration: '20260815', strike: 4400, contractSide: 'C' },
      { localSymbol: 'METLG_081426_4400_YES', symbol: 'METLG', tradingClass: 'METLG', secType: 'OPT', expiration: '20260814', strike: 4425, contractSide: 'C' },
      { localSymbol: 'METLG_081426_4400_YES', symbol: 'METLG', tradingClass: 'METLG', secType: 'OPT', expiration: '20260814', strike: 4400, contractSide: 'P' },
      { localSymbol: 'FES_081426_7775_NO', symbol: 'NQ', tradingClass: 'FES', secType: 'FOP', expiration: '20260814', strike: 7775, contractSide: 'P' },
      { localSymbol: 'FES_081426_7775_NO', symbol: 'ES', tradingClass: 'ES', secType: 'FOP', expiration: '20260814', strike: 7775, contractSide: 'P' },
      { localSymbol: 'CPIY_0726_3.4_YES', symbol: 'CPIY', tradingClass: 'CPIY', secType: 'FOP', expiration: '20260812', strike: 3.4, contractSide: 'C' },
      { localSymbol: 'CPIY_0726_3.4_YES', symbol: 'CPIY', tradingClass: 'CPIY', secType: 'OPT', expiration: '20260812', strike: 3.5, contractSide: 'C' },
      { localSymbol: 'CPIY_0726_3.4_YES', symbol: 'CPIY', tradingClass: 'CPIY', secType: 'OPT', expiration: '20260812', strike: 3.4, contractSide: 'P' },
    ].forEach((candidate) => expect(forecastExThresholdIdentity({ exchange: 'FORECASTX', ...candidate })).toBeNull());
  });

  test('settles verified historical outcomes without fabricating unavailable cost basis', () => {
    const settled = finalizeLifecycle({
      accountId: 'U123',
      recordKey: 'lifecycle#1#1',
      itemType: 'lifecycle',
      status: 'awaiting_resolution',
      version: 1,
      verification: 'ibkr_historical_position_snapshot',
      entryQuantity: 500,
      netQuantity: 500,
      entryPrincipal: null,
      fees: null,
      feesComplete: false,
      costBasisComplete: false,
      risked: null,
      paid: 0,
    }, {
      paid: 0,
      resolvedDate: '2026-07-14',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        outcome: 'NO',
        payoutPerContract: 0,
      },
    });
    expect(settled).toMatchObject({
      status: 'verified',
      netQuantity: 0,
      paid: 0,
      performanceComplete: false,
      risked: null,
      pnl: null,
      roi: null,
    });
  });

  test('repairs an archived Kalshi schedule from the exact ticker retained in snapshot evidence', () => {
    const applied = applyContractSchedule({
      accountId: 'U123',
      recordKey: 'lifecycle#1#1',
      itemType: 'lifecycle',
      status: 'review',
      reviewReason: 'contract_schedule_evidence_conflict',
      version: 2,
      market: 'cpi',
      contractSide: 'YES',
      strike: 3.3,
      contractRule: 'above',
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
      contractKey: 'KXCPIYOY',
      eventTicker: 'KXCPIYOY-26JUL',
      positionSnapshotEvidence: { description: 'KXCPIYOY-26JUL-T3.3_YES' },
    }, {
      ok: true,
      venue: 'Kalshi',
      source: 'kalshi_exact_market',
      eventTicker: 'KXCPIYOY-26JUL-T3.3',
      lastTradeAt: '2026-08-12T12:29:00Z',
      resolutionAt: '2026-08-12T13:15:19.078Z',
      payoutAt: '2026-08-12T13:15:19.078Z',
      sourceUrl: 'https://api.elections.kalshi.com/trade-api/v2/markets/KXCPIYOY-26JUL-T3.3',
      sourceHash: 'a'.repeat(64),
      observedAt: '2026-08-15T04:30:00Z',
    }, { now: '2026-08-15T04:30:00Z' });
    expect(applied).toMatchObject({
      changed: true,
      conflict: false,
      record: {
        status: 'awaiting_resolution',
        reviewReason: null,
        lastTradeAt: '2026-08-12T12:29:00.000Z',
        resolutionAt: '2026-08-12T13:15:19.078Z',
        payoutAt: '2026-08-12T13:15:19.078Z',
      },
    });
  });

  test('aggregates fills, commissions, partial exit, and resolves on the final close', () => {
    const first = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e1', side: 'BOT', quantity: 10, price: 0.42, time: '2026-08-12T15:00:00Z' })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', localSymbol: 'KXWTI-26AUG13-81.49-YES', position: 10, avgCost: 0.42 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now,
    });
    expect(first.status).toBe('captured');
    const lifecycle = first.records.find((record) => record.itemType === 'lifecycle');
    expect(lifecycle.netQuantity).toBe(10);
    expect(lifecycle.entryPrincipal).toBeCloseTo(4.2);
    expect(lifecycle.fees).toBeCloseTo(0.1);

    const duplicate = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e1', side: 'BOT', quantity: 10, price: 0.42, time: '2026-08-12T15:00:00Z' })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', localSymbol: 'KXWTI-26AUG13-81.49-YES', position: 10, avgCost: 0.42 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: first.records,
      now,
    });
    expect(duplicate.executionRecords).toHaveLength(0);
    expect(duplicate.changed).toHaveLength(0);
    expect(duplicate.writeEntries).toHaveLength(0);

    const second = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e2', side: 'SLD', quantity: 4, price: 0.9, commission: 0.1, time: '2026-08-13T15:00:00Z' })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', localSymbol: 'KXWTI-26AUG13-81.49-YES', position: 6, avgCost: 0.42 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: first.records,
      now,
    });
    const partial = second.records.find((record) => record.itemType === 'lifecycle');
    expect(partial.netQuantity).toBe(6);
    expect(partial.status).toBe('open');
    expect(partial.paid).toBeCloseTo(3.6);

    const third = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e2', side: 'SLD', quantity: 4, price: 0.9, commission: 0.1, time: '2026-08-13T15:00:00Z' }), execution({ id: 'e3', side: 'SLD', quantity: 6, price: 1, commission: 0.1, time: '2026-08-13T16:00:00Z' })],
      positions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: second.records,
      now,
    });
    const resolved = third.records.find((record) => record.itemType === 'lifecycle');
    expect(resolved.status).toBe('verified');
    expect(resolved.resolutionType).toBe('early_exit');
    expect(resolved.risked).toBeCloseTo(4.5);
    expect(resolved.paid).toBeCloseTo(9.6);
    expect(resolved.pnl).toBeCloseTo(5.1);
    expect(resolved.roi).toBeCloseTo(5.1 / 4.5);
    expect(third.executionRecords).toHaveLength(1);

    const reopened = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e4', side: 'BOT', quantity: 1, price: 0.3, commission: 0.1, time: '2026-08-13T17:00:00Z' })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', localSymbol: 'KXWTI-26AUG13-81.49-YES', position: 1, avgCost: 0.3 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: third.records,
      now,
    });
    const lifecycles = reopened.records.filter((record) => record.itemType === 'lifecycle');
    expect(lifecycles).toHaveLength(2);
    expect(lifecycles[1].status).toBe('open');
    expect(lifecycles[1].recordKey).toBe('lifecycle#9001#2');
  });

  test('does not infer closure from stale or partial evidence', () => {
    expect(isVerifiedLiveEvidence({ ok: true, status: 'stale', source: 'cache', fetchedAt: now })).toBe(false);
    const captured = reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions: [],
      positionsPayload: { ok: true, status: 'stale', source: 'cache', fetchedAt: now },
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: [{ accountId: 'U123', itemType: 'lifecycle', recordKey: 'lifecycle#9001#1', status: 'open', netQuantity: 2 }],
    });
    expect(captured.status).toBe('capture_paused');
    expect(captured.changed).toHaveLength(0);
  });

  test('rejects positions and executions whose observation windows overlap', () => {
    const payload = livePayload({
      source: 'ibkr_positions',
      snapshotStartedAt: '2026-08-13T15:00:00Z',
    });
    const captured = reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions: [execution({ id: 'race', side: 'BOT', quantity: 1, price: 0.4, time: '2026-08-13T15:00:01Z' })],
      positionsPayload: payload,
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    expect(captured).toMatchObject({ status: 'capture_paused', reason: 'snapshot_temporal_overlap', changed: [] });
  });

  test('rejects malformed prediction evidence instead of silently dropping it', () => {
    const missingTime = execution({ id: 'missing-time', side: 'BOT', quantity: 1, price: 0.4 });
    delete missingTime.executionTime;
    expect(reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions: [missingTime],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    })).toMatchObject({ status: 'capture_paused', reason: 'invalid_execution_evidence' });

    expect(reconcileEvidence({
      accountId: 'U123',
      positions: [{ account: 'U123', conId: null, symbol: 'KXWTI', localSymbol: 'KXWTI-26AUG13-T81.49_YES', position: 1 }],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    })).toMatchObject({ status: 'capture_paused', reason: 'invalid_position_evidence' });
  });

  test('fails closed for cross-account or duplicate position coverage', () => {
    const base = {
      account: 'U123',
      conId: 9001,
      symbol: 'KXWTI-26AUG13-81.49-YES',
      position: 1,
      avgCost: 0.4,
    };
    const crossAccount = reconcileEvidence({
      accountId: 'U123',
      positions: [{ ...base, account: 'U999' }],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions', account: 'U123' }),
      executionsPayload: livePayload({ source: 'ibkr_executions', account: 'U123' }),
    });
    expect(crossAccount.status).toBe('capture_paused');
    expect(crossAccount.reason).toBe('account_scope_mismatch');
    const duplicate = reconcileEvidence({
      accountId: 'U123',
      positions: [base, { ...base, quantity: 2 }],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions', account: 'U123' }),
      executionsPayload: livePayload({ source: 'ibkr_executions', account: 'U123' }),
    });
    expect(duplicate.status).toBe('capture_paused');
    expect(duplicate.reason).toBe('duplicate_position_evidence');
  });

  test('starts a new lifecycle when a position is reopened after awaiting resolution', () => {
    const open = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e-open', side: 'BOT', quantity: 2, price: 0.4 })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', position: 2, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const awaiting = reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: open.records,
    });
    const reopened = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e-reopen', side: 'BOT', quantity: 1, price: 0.3 })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', position: 1, avgCost: 0.3 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: awaiting.records,
    });
    const lifecycles = reopened.records.filter((record) => record.itemType === 'lifecycle');
    expect(lifecycles).toHaveLength(2);
    expect(lifecycles[0].status).toBe('awaiting_resolution');
    expect(lifecycles[1].entryQuantity).toBe(1);
  });

  test('does not duplicate a settled lifecycle while IBKR still retains the expired position', () => {
    const settled = {
      accountId: 'U123',
      recordKey: 'lifecycle#9001#1',
      itemType: 'lifecycle',
      lifecycleId: 'settled-1',
      conId: 9001,
      status: 'verified',
      resolutionType: 'expiry',
      resolvedDate: '2026-08-13',
      updatedAt: '2026-08-13T20:00:00Z',
      netQuantity: 0,
      entryQuantity: 2,
      risked: 0.8,
      paid: 2,
      pnl: 1.2,
    };
    const result = reconcileEvidence({
      accountId: 'U123',
      positions: [{
        account: 'U123', conId: 9001, symbol: 'KXWTI',
        localSymbol: 'KXWTI-26AUG1314-T81.49_NO', position: 2, avgCost: 0.4,
      }],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: [settled],
      now: '2026-08-13T20:01:00Z',
    });
    expect(result.records.filter((record) => record.itemType === 'lifecycle')).toEqual([settled]);
    expect(result.changed).toHaveLength(0);
  });

  test('links an exact zero-price IBKR expiry posting to the verified settlement without a second lifecycle', () => {
    const settled = {
      accountId: 'U123', recordKey: 'lifecycle#910445730#1', itemType: 'lifecycle', lifecycleId: 'settled-wti',
      version: 4, conId: 910445730, status: 'verified', resolutionType: 'expiry', resolvedDate: '2026-08-13',
      market: 'wti', exchange: 'FORECASTX', symbol: 'COMCO', localSymbol: 'COMCO_081326_82_NO',
      tradingClass: 'COMCO', secType: 'OPT', expiration: '20260813', strike: 82,
      contractSide: 'NO', contractKey: 'COMCO_081326_82_NO', eventTicker: 'COMCO_081326_82',
      entryQuantity: 1056, netQuantity: 0, entryPrincipal: 499, fees: 20.04, risked: 519.04,
      paid: 1056, pnl: 536.96, roi: 536.96 / 519.04,
      settlementEvidence: { source: 'forecastex_official_prices', settlementPayout: 1 },
      executionIds: ['buy-1'], updatedAt: '2026-08-14T15:00:00Z',
    };
    const posting = {
      accountId: 'U123', execId: 'expiry-posting', conId: 910445730, symbol: 'COMCO',
      localSymbol: 'COMCO_081326_82_NO', tradingClass: 'COMCO', exchange: 'FORECASTX',
      secType: 'OPT', expiration: '20260813', strike: 82, contractSide: 'P',
      side: 'SLD', quantity: 1056, price: 0, commission: 0, tax: 0,
      executionTime: '2026-08-15T01:23:46Z',
    };
    const result = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [posting], existingRecords: [settled],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: '2026-08-15T02:00:00Z',
    });
    expect(result.records.filter((record) => record.itemType === 'lifecycle')).toHaveLength(1);
    expect(result.changed).toEqual([
      expect.objectContaining({
        recordKey: settled.recordKey,
        status: 'verified',
        paid: 1056,
        brokerSettlementEvidence: expect.objectContaining({
          source: 'ibkr_expiry_close_execution',
          execId: 'expiry-posting',
          quantity: 1056,
          price: 0,
        }),
      }),
    ]);
    expect(result.executionRecords).toEqual([
      expect.objectContaining({ execId: 'expiry-posting', lifecycleRecordKey: settled.recordKey }),
    ]);
  });

  test('automatically retires a legacy empty review created from that exact broker posting', async () => {
    const settled = {
      accountId: 'U123', recordKey: 'lifecycle#910445730#1', itemType: 'lifecycle', lifecycleId: 'settled-wti',
      version: 4, conId: 910445730, status: 'verified', resolutionType: 'expiry', resolvedDate: '2026-08-13',
      market: 'wti', exchange: 'FORECASTX', symbol: 'COMCO', localSymbol: 'COMCO_081326_82_NO',
      tradingClass: 'COMCO', secType: 'OPT', expiration: '20260813', strike: 82,
      contractSide: 'NO', contractKey: 'COMCO_081326_82_NO', eventTicker: 'COMCO_081326_82',
      entryQuantity: 1056, netQuantity: 0, entryPrincipal: 499, fees: 20.04, risked: 519.04,
      paid: 1056, pnl: 536.96, roi: 536.96 / 519.04,
      settlementEvidence: { source: 'forecastex_official_prices', settlementPayout: 1 },
      executionIds: ['buy-1'], updatedAt: '2026-08-14T15:00:00Z',
    };
    const posting = {
      accountId: 'U123', execId: 'expiry-posting', conId: 910445730, symbol: 'COMCO',
      localSymbol: 'COMCO_081326_82_NO', tradingClass: 'COMCO', exchange: 'FORECASTX',
      secType: 'OPT', expiration: '20260813', strike: 82, contractSide: 'P',
      side: 'SLD', quantity: 1056, price: 0, commission: 0, tax: 0,
      executionTime: '2026-08-15T01:23:46Z',
    };
    const normalizedPosting = normalizeExecution(posting, 'U123');
    const orphan = {
      accountId: 'U123', recordKey: 'lifecycle#910445730#2', itemType: 'lifecycle', lifecycleId: 'orphan',
      // Older economic replay versions could overwrite the original orphan
      // reason before the deterministic settlement-linking pass ran.
      version: 1, conId: 910445730, status: 'review', reviewReason: 'cashout_bundle_ambiguous',
      market: 'wti', contractLabel: 'WTI $82 NO', contractSide: 'NO', strike: 82,
      entryQuantity: 0, netQuantity: 0, entryPrincipal: 0, fees: 0, paid: 0, risked: 0,
      executionIds: ['expiry-posting'], updatedAt: '2026-08-15T01:24:00Z',
    };
    const postingRecord = {
      ...normalizedPosting,
      accountId: 'U123', recordKey: 'execution#expiry-posting', itemType: 'execution',
      lifecycleRecordKey: orphan.recordKey, version: 1, correctionVersion: 0,
      createdAt: '2026-08-15T01:24:00Z', updatedAt: '2026-08-15T01:24:00Z',
    };
    const legacyRead = await loadPerformance({
      accountId: 'U123',
      store: { queryAccount: jest.fn(async () => [settled, orphan]) },
    });
    expect(legacyRead.review).toEqual([]);
    const repaired = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [posting],
      existingRecords: [settled, orphan, postingRecord],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: '2026-08-15T02:00:00Z',
    });
    expect(repaired.records.find((record) => record.recordKey === orphan.recordKey)).toMatchObject({
      status: 'broker_settlement_posting',
      reviewReason: null,
      linkedLifecycleRecordKey: settled.recordKey,
    });
    expect(repaired.executionRecords).toEqual([
      expect.objectContaining({
        execId: 'expiry-posting',
        lifecycleRecordKey: settled.recordKey,
        correctionVersion: 1,
      }),
    ]);
    expect(repaired.changed.find((record) => record.recordKey === settled.recordKey)).toMatchObject({
      paid: 1056,
      brokerSettlementEvidence: expect.objectContaining({ execId: 'expiry-posting' }),
    });
    expect(repaired.records.filter((record) => record.status === 'review')).toEqual([]);

    const repeated = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [posting], existingRecords: repaired.records,
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: '2026-08-15T02:01:00Z',
    });
    expect(repeated.changed).toEqual([]);
    expect(repeated.executionRecords).toEqual([]);
    expect(repeated.writeEntries).toEqual([]);
  });

  test('keeps unsupported ForecastEx identity in review', () => {
    const result = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'forecastx-1', side: 'BOT', quantity: 1, price: 0.4, symbol: 'FORECASTEX-OTHER-81.49-YES' })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'FORECASTEX-OTHER-81.49-YES', exchange: 'FORECASTX', position: 1, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    expect(result.records.find((record) => record.itemType === 'lifecycle').status).toBe('review');
  });

  test('repairs venue-mapped Kalshi basis from exact executions instead of position average cost', () => {
    const rawExecution = {
      accountId: 'U123', execId: 'brent-entry', conId: 915243070, symbol: 'KXBRENTD',
      localSymbol: 'KXBRENTD-26AUG2417-T91_YES', tradingClass: 'KXBRENTD',
      exchange: 'KALSHI', secType: 'OPT', expiration: '20260824', strike: 91,
      contractSide: 'YES', side: 'BOT', quantity: 2000, price: 0.47,
      commission: 0, tax: 0, executionTime: '2026-08-24T17:00:00Z',
    };
    const exactExecution = normalizeExecution(rawExecution, 'U123');
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#915243070#1', itemType: 'lifecycle', lifecycleId: 'brent',
      version: 3, conId: 915243070, status: 'verified', resolutionType: 'expiry', resolvedDate: '2026-08-24',
      market: 'other', exchange: 'KALSHI', symbol: 'KXBRENTD', tradingClass: 'KXBRENTD', secType: 'OPT',
      localSymbol: 'KXBRENTD-26AUG2417-T91_YES', contractKey: 'KXBRENTD-26AUG2417-T91_YES',
      expiration: '20260824', strike: 91, contractSide: 'YES', contractRule: 'above',
      entryQuantity: 2000, remainingQuantity: 2000, netQuantity: 0, entryPrincipal: 940,
      fees: 40, entryCost: 940, risked: 980, paid: 0, pnl: -980, roi: -1,
      feesComplete: true, costBasisComplete: true, performanceComplete: true,
      feeEvidence: { source: 'ibkr_live_position_average_cost', averageCost: 0.49, quantity: 2000 },
      settlementEvidence: { source: 'kalshi_exact_market', payoutPerContract: 0 },
      executionIds: ['brent-entry'], updatedAt: '2026-08-24T22:00:00Z',
    };
    const executionRecord = {
      ...exactExecution, accountId: 'U123', recordKey: 'execution#brent-entry', itemType: 'execution',
      version: 1, correctionVersion: 0, createdAt: '2026-08-24T17:00:00Z', updatedAt: '2026-08-24T17:00:00Z',
    };
    const repaired = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [rawExecution], existingRecords: [lifecycle, executionRecord],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: '2026-08-25T00:00:00Z',
    });
    expect(repaired.records.find((record) => record.recordKey === lifecycle.recordKey)).toMatchObject({
      entryPrincipal: 940, fees: 0, entryCost: 940, risked: 940, paid: 0, pnl: -940, roi: -1,
      feeEvidence: { source: 'ibkr_exact_execution_coverage' },
    });
    expect(repaired.revisionRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionType: 'exact_execution_cost_basis_repair' }),
    ]));
  });

  test('moves ForecastEx FES positions from open to awaiting result only from its exact official schedule', () => {
    const fesExecution = {
      accountId: 'U123',
      execId: 'fes-1',
      conId: 9010,
      symbol: 'ES',
      localSymbol: 'FES_081426_7800_NO',
      tradingClass: 'FES',
      exchange: '',
      secType: 'FOP',
      expiration: '20260814',
      strike: 7800,
      contractSide: 'NO',
      side: 'BOT',
      shares: 5,
      price: 0.42,
      commission: 0.1,
      executionTime: '2026-08-14T16:00:00Z',
    };
    const fesPosition = {
      account: 'U123',
      conId: 9010,
      symbol: 'ES',
      localSymbol: 'FES_081426_7800_NO',
      tradingClass: 'FES',
      exchange: '',
      secType: 'FOP',
      expiration: '20260814',
      strike: 7800,
      contractSide: 'NO',
      position: 5,
      avgCost: 0.42,
    };
    expect(forecastExLastTradingAt(fesPosition)).toBe('2026-08-14T20:00:00.000Z');

    const result = reconcileEvidence({
      accountId: 'U123',
      executions: [fesExecution],
      positions: [fesPosition],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: '2026-08-14T19:59:59.000Z',
    });
    const lifecycle = result.records.find((record) => record.itemType === 'lifecycle');
    expect(lifecycle).toMatchObject({
      market: 'sp500',
      contractLabel: 'Above 7,800 NO',
      eventTicker: 'FES_081426_7800',
      contractRule: 'above',
      status: 'open',
      reviewReason: null,
      netQuantity: 5,
    });
    expect(normalizeActivePerformanceRow(lifecycle)).toMatchObject({
      market: 'sp500',
      contractLabel: 'Above 7,800 NO',
      status: 'open',
      quantity: 5,
      pnl: null,
      roi: null,
    });

    const scheduled = applyContractSchedule(lifecycle, {
      ok: true,
      venue: 'ForecastEx',
      source: 'forecastex_official_contract_api',
      eventTicker: 'FES_081426_7800',
      lastTradeAt: '2026-08-14T20:00:00.000Z',
      resolutionAt: '2026-08-17T15:00:00.000Z',
      payoutAt: '2026-08-17T17:00:00.000Z',
      settlementSymbol: 'ESU26',
      sourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=100&productId=FES',
      sourceHash: 'a'.repeat(64),
      observedAt: '2026-08-14T20:00:00.000Z',
    }, {
      now: '2026-08-14T20:00:00.000Z',
    });
    const pendingLifecycle = scheduled.record;
    expect(pendingLifecycle).toMatchObject({
      status: 'awaiting_resolution',
      reviewReason: null,
      lastTradeAt: '2026-08-14T20:00:00.000Z',
      resolutionAt: '2026-08-17T15:00:00.000Z',
      payoutAt: '2026-08-17T17:00:00.000Z',
      settlementSymbol: 'ESU26',
      contractScheduleEvidence: {
        source: 'forecastex_official_contract_api',
        eventTicker: 'FES_081426_7800',
      },
    });
    expect(normalizeActivePerformanceRow(pendingLifecycle)).toMatchObject({
      market: 'sp500',
      status: 'awaiting_resolution',
      displayState: 'AWAITING_RESULT',
      resolutionAt: '2026-08-17T15:00:00.000Z',
      currentValue: null,
      pnl: null,
      roi: null,
    });
  });

  test('captures ForecastEx METLG OPT positions as open Gold active rows', () => {
    const result = reconcileEvidence({
      accountId: 'U123',
      executions: [{
        accountId: 'U123', execId: 'metlg-1', conId: 9011, symbol: 'METLG',
        localSymbol: 'METLG_081426_4400_YES', tradingClass: 'METLG', exchange: 'FORECASTX',
        secType: 'OPT', expiration: '20260814', strike: 4400, contractSide: 'C',
        side: 'BOT', shares: 2, price: 0.22, commission: 0.02,
        executionTime: '2026-08-14T16:00:00Z',
      }],
      positions: [{
        account: 'U123', conId: 9011, symbol: 'METLG', localSymbol: 'METLG_081426_4400_YES',
        tradingClass: 'METLG', exchange: '', secType: 'OPT', expiration: '20260814', strike: 4400,
        contractSide: 'C', position: 2, avgCost: 0.23,
      }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    expect(result.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      market: 'gold',
      contractLabel: 'Gold $4,400 YES',
      eventTicker: 'METLG_081426_4400',
      contractRule: 'above',
      status: 'open',
      reviewReason: null,
      netQuantity: 2,
    });
  });

  test('uses Gold 12:30 PM CT cutoff and rejects a later conflicting schedule mutation', () => {
    const record = {
      accountId: 'U123', recordKey: 'lifecycle#gold#1', itemType: 'lifecycle', version: 1,
      status: 'open', market: 'gold', exchange: 'FORECASTX', symbol: 'METLG', tradingClass: 'METLG',
      secType: 'OPT', contractKey: 'METLG_081426_4400_YES', eventTicker: 'METLG_081426_4400',
      expiration: '20260814', strike: 4400, contractSide: 'YES', contractRule: 'above',
    };
    expect(forecastExLastTradingAt(record)).toBe('2026-08-14T17:30:00.000Z');
    const schedule = {
      ok: true, venue: 'ForecastEx', source: 'forecastex_official_contract_api',
      eventTicker: 'METLG_081426_4400', lastTradeAt: '2026-08-14T17:30:00Z',
      resolutionAt: '2026-08-15T04:55:00Z', payoutAt: '2026-08-15T06:55:00Z',
      settlementSymbol: 'GCQ26', sourceUrl: 'https://www.forecastex.com/api/contracts?productId=METLG',
      sourceHash: 'a'.repeat(64), observedAt: '2026-08-14T17:29:00Z',
    };
    const before = applyContractSchedule(record, schedule, { now: '2026-08-14T17:29:59Z' }).record;
    expect(before).toMatchObject({ status: 'open', lastTradeAt: '2026-08-14T17:30:00.000Z' });
    const after = applyContractSchedule(before, schedule, { now: '2026-08-14T17:30:00Z' }).record;
    expect(after).toMatchObject({ status: 'awaiting_resolution', reviewReason: null });
    const conflict = applyContractSchedule(after, {
      ...schedule,
      resolutionAt: '2026-08-15T05:55:00Z',
      sourceHash: 'b'.repeat(64),
    }, { now: '2026-08-14T17:31:00Z' }).record;
    expect(conflict).toMatchObject({ status: 'review', reviewReason: 'contract_schedule_evidence_conflict' });
    const repeatedConflict = applyContractSchedule(conflict, {
      ...schedule,
      resolutionAt: '2026-08-15T05:55:00Z',
      sourceHash: 'b'.repeat(64),
    }, { now: '2026-08-14T17:32:00Z' });
    expect(repeatedConflict).toMatchObject({ changed: false, conflict: true });
    expect(repeatedConflict.record.version).toBe(conflict.version);
  });

  test('repairs a legacy schedule-review row when exact official evidence is now valid', () => {
    const reviewed = {
      accountId: 'U123', recordKey: 'lifecycle#wti#1', itemType: 'lifecycle', version: 8,
      status: 'review', reviewReason: 'contract_schedule_evidence_conflict', market: 'wti',
      exchange: 'FORECASTX', symbol: 'KXWTI', secType: 'OPT',
      contractKey: 'KXWTI-26AUG1314-T81.99_NO', eventTicker: 'KXWTI-26AUG1314',
      expiration: '20260813', strike: 81.99, contractSide: 'NO', contractRule: 'above',
    };
    const repaired = applyContractSchedule(reviewed, {
      ok: true,
      venue: 'Kalshi',
      source: 'kalshi_exact_market',
      eventTicker: 'KXWTI-26AUG1314-T81.99',
      lastTradeAt: '2026-08-13T18:30:00Z',
      resolutionAt: '2026-08-13T18:30:00Z',
      payoutAt: '2026-08-14T15:01:14.410Z',
      settlementSymbol: 'WBS 26U-ICE',
      sourceUrl: 'https://external-api.kalshi.com/trade-api/v2/markets/KXWTI-26AUG1314-T81.99',
      sourceHash: 'c'.repeat(64),
      observedAt: '2026-08-15T02:00:00Z',
    }, { now: '2026-08-15T02:00:00Z' });
    expect(repaired).toMatchObject({ changed: true, conflict: false });
    expect(repaired.record).toMatchObject({
      status: 'awaiting_resolution',
      reviewReason: null,
      lastTradeAt: '2026-08-13T18:30:00.000Z',
      resolutionAt: '2026-08-13T18:30:00.000Z',
      payoutAt: '2026-08-14T15:01:14.410Z',
      settlementSymbol: 'WBS 26U-ICE',
    });
  });

  test('audits a Kalshi expected-to-final schedule transition without creating review or version churn', () => {
    const record = {
      accountId: 'U123', recordKey: 'lifecycle#brent#1', itemType: 'lifecycle', version: 1,
      status: 'open', market: 'other', exchange: 'FORECASTX', symbol: 'KXBRENTD', secType: 'OPT',
      contractKey: 'KXBRENTD-26AUG2417-T91_YES', eventTicker: 'KXBRENTD-26AUG2417',
      strike: 91, contractSide: 'YES', contractRule: 'above',
    };
    const scheduled = applyContractSchedule(record, {
      ok: true, venue: 'Kalshi', source: 'kalshi_exact_market',
      eventTicker: 'KXBRENTD-26AUG2417-T91', venueStatus: 'active',
      lastTradeAt: '2026-08-24T21:00:00Z', expectedResolutionAt: '2026-08-24T21:00:00Z',
      resolutionAt: null, payoutAt: null,
      sourceUrl: 'https://external-api.kalshi.com/trade-api/v2/markets/KXBRENTD-26AUG2417-T91',
      sourceHash: 'a'.repeat(64), observedAt: '2026-08-24T21:01:00Z',
    }, { now: '2026-08-24T21:01:00Z' });
    expect(scheduled).toMatchObject({ changed: true, conflict: false, record: {
      status: 'awaiting_resolution', expectedResolutionAt: '2026-08-24T21:00:00.000Z',
    } });
    const finalizedSchedule = {
      ok: true, venue: 'Kalshi', source: 'kalshi_exact_market',
      eventTicker: 'KXBRENTD-26AUG2417-T91', venueStatus: 'finalized', outcome: 'NO',
      lastTradeAt: '2026-08-24T21:00:00Z', expectedResolutionAt: '2026-08-24T21:00:00Z',
      resolutionAt: '2026-08-24T22:00:57.09524Z', finalizedAt: '2026-08-24T22:00:57.09524Z',
      payoutAt: '2026-08-24T22:00:57.09524Z',
      sourceUrl: 'https://external-api.kalshi.com/trade-api/v2/markets/KXBRENTD-26AUG2417-T91',
      sourceHash: 'b'.repeat(64), observedAt: '2026-08-24T22:01:00Z',
    };
    const finalized = applyContractSchedule(scheduled.record, finalizedSchedule, { now: '2026-08-24T22:01:00Z' });
    expect(finalized).toMatchObject({ changed: true, conflict: false, record: {
      status: 'awaiting_resolution', reviewReason: null,
      expectedResolutionAt: '2026-08-24T21:00:00.000Z',
      resolutionAt: '2026-08-24T22:00:57.095Z',
      payoutAt: '2026-08-24T22:00:57.095Z',
      contractScheduleEvidence: { outcome: 'NO', venueStatus: 'finalized' },
    } });
    const repeated = applyContractSchedule(finalized.record, {
      ...finalizedSchedule,
      observedAt: '2026-08-25T12:00:00Z',
    }, { now: '2026-08-25T12:00:00Z' });
    expect(repeated).toMatchObject({ changed: false, conflict: false });
    expect(repeated.record.version).toBe(finalized.record.version);
  });

  test('repairs a previously reviewed COMCO lifecycle from exact live broker identity', () => {
    const rawExecution = {
      accountId: 'U123',
      execId: 'comco-1',
      conId: 9002,
      symbol: 'COMCO',
      localSymbol: 'COMCO_081326_82_NO',
      exchange: 'FORECASTX',
      secType: 'OPT',
      tradingClass: 'COMCO',
      expiration: '20260813',
      contractSide: 'P',
      strike: 82,
      side: 'BOT',
      quantity: 2,
      price: 0.48,
      commission: 0,
      executionTime: now,
    };
    const initial = reconcileEvidence({
      accountId: 'U123',
      executions: [rawExecution],
      positions: [{
        account: 'U123', conId: 9002, symbol: 'COMCO', localSymbol: 'COMCO_081326_82_NO',
        exchange: '', secType: 'OPT', tradingClass: 'COMCO', expiration: '20260813',
        contractSide: 'P', strike: 82, position: 2, avgCost: 0.49,
      }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const lifecycle = initial.records.find((record) => record.itemType === 'lifecycle');
    expect(lifecycle).toMatchObject({
      status: 'open',
      eventTicker: 'COMCO_081326_82',
      contractRule: 'above',
      contractSide: 'NO',
    });
    expect(lifecycle.fees).toBeCloseTo(0.02);
    expect(lifecycle.risked).toBeCloseTo(0.98);

    const legacyRecords = initial.records.map((record) => (
      record.itemType === 'lifecycle'
        ? { ...record, status: 'review', reviewReason: 'unsupported_contract_identity', eventTicker: null, contractRule: null }
        : record
    ));
    const repaired = reconcileEvidence({
      accountId: 'U123',
      executions: [rawExecution],
      positions: [{
        account: 'U123', conId: 9002, symbol: 'COMCO', localSymbol: 'COMCO_081326_82_NO',
        exchange: '', secType: 'OPT', tradingClass: 'COMCO', expiration: '20260813',
        contractSide: 'P', strike: 82, position: 2, avgCost: 0.49,
      }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: legacyRecords,
    });
    expect(repaired.changed).toHaveLength(1);
    expect(repaired.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      status: 'open',
      reviewReason: null,
      eventTicker: 'COMCO_081326_82',
      contractRule: 'above',
    });
  });

  test.each([
    {
      label: 'METLG Gold', conId: 9012, symbol: 'METLG', localSymbol: 'METLG_081426_4425_YES',
      tradingClass: 'METLG', secType: 'OPT', right: 'C', strike: 4425,
      market: 'gold', eventTicker: 'METLG_081426_4425',
    },
    {
      label: 'FES SP500', conId: 9013, symbol: 'ES', localSymbol: 'FES_081426_7800_NO',
      tradingClass: 'FES', secType: 'FOP', right: 'P', strike: 7800,
      market: 'sp500', eventTicker: 'FES_081426_7800',
    },
  ])('repairs a previously reviewed $label lifecycle from exact live broker identity', (contract) => {
    const beforeFesClose = '2026-08-14T19:00:00.000Z';
    const rawExecution = {
      accountId: 'U123', execId: `repair-${contract.conId}`, conId: contract.conId,
      symbol: contract.symbol, localSymbol: contract.localSymbol, tradingClass: contract.tradingClass,
      exchange: 'FORECASTX', secType: contract.secType, expiration: '20260814',
      contractSide: contract.right, strike: contract.strike, side: 'BOT', quantity: 2,
      price: 0.25, commission: 0, executionTime: beforeFesClose,
    };
    const position = {
      account: 'U123', conId: contract.conId, symbol: contract.symbol, localSymbol: contract.localSymbol,
      tradingClass: contract.tradingClass, exchange: '', secType: contract.secType,
      expiration: '20260814', contractSide: contract.right, strike: contract.strike,
      position: 2, avgCost: 0.26,
    };
    const initial = reconcileEvidence({
      accountId: 'U123', executions: [rawExecution], positions: [position],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: beforeFesClose,
    });
    const legacyRecords = initial.records.map((record) => (
      record.itemType === 'lifecycle'
        ? { ...record, status: 'review', reviewReason: 'unsupported_contract_identity', eventTicker: null, contractRule: null }
        : record
    ));
    const repaired = reconcileEvidence({
      accountId: 'U123', executions: [rawExecution], positions: [position], existingRecords: legacyRecords,
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now: beforeFesClose,
    });
    expect(repaired.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      market: contract.market,
      status: 'open',
      reviewReason: null,
      eventTicker: contract.eventTicker,
      contractRule: 'above',
    });
  });

  test('reconciles a corrected execution report without double-counting the fill', () => {
    const incomplete = { ...execution({ id: 'corrected-1', side: 'BOT', quantity: 2, price: 0.4 }), commission: undefined };
    const first = reconcileEvidence({
      accountId: 'U123',
      executions: [incomplete],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', position: 2, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    expect(first.records.find((record) => record.itemType === 'lifecycle').status).toBe('review');
    const corrected = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'corrected-1', side: 'BOT', quantity: 2, price: 0.4, commission: 0.1 })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', position: 2, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: first.records,
    });
    const lifecycle = corrected.records.find((record) => record.itemType === 'lifecycle');
    const evidence = corrected.records.find((record) => record.itemType === 'execution');
    expect(corrected.executionRecords).toHaveLength(1);
    expect(evidence.correctionVersion).toBe(1);
    expect(lifecycle.entryPrincipal).toBeCloseTo(0.8);
    expect(lifecycle.entryQuantity).toBe(2);
    expect(lifecycle.fees).toBeCloseTo(0.1);
    expect(lifecycle.status).toBe('open');
  });

  test('keeps a lifecycle in review when any closing fill lacks fee evidence', () => {
    const buy = execution({ id: 'fee-buy', side: 'BOT', quantity: 2, price: 0.4 });
    const incompleteSell = { ...execution({ id: 'fee-sell-1', side: 'SLD', quantity: 1, price: 0.8 }), commission: undefined };
    const first = reconcileEvidence({
      accountId: 'U123',
      executions: [buy, incompleteSell],
      positions: [{ account: 'U123', conId: 9001, symbol: buy.symbol, position: 1, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const final = reconcileEvidence({
      accountId: 'U123',
      executions: [incompleteSell, execution({ id: 'fee-sell-2', side: 'SLD', quantity: 1, price: 0.9 })],
      positions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: first.records,
    });
    const lifecycle = final.records.find((record) => record.itemType === 'lifecycle');
    expect(lifecycle.status).toBe('review');
    expect(lifecycle.reviewReason).toBe('incomplete_fee_evidence');
  });

  test('routes non-USD commission evidence to review', () => {
    const fill = { ...execution({ id: 'foreign-fee', side: 'BOT', quantity: 1, price: 0.4 }), commissionCurrency: 'EUR' };
    const result = reconcileEvidence({
      accountId: 'U123',
      executions: [fill],
      positions: [{ account: 'U123', conId: 9001, symbol: fill.symbol, position: 1, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    expect(result.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      status: 'review',
      reviewReason: 'incomplete_fee_evidence',
    });
  });

  test('marks a missing position awaiting resolution only after a complete live snapshot', () => {
    const open = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'e1', side: 'BOT', quantity: 2, price: 0.4 })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-81.49-YES', localSymbol: 'KXWTI-26AUG13-81.49-YES', position: 2, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      now,
    });
    const closed = reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: open.records,
      now,
    });
    expect(closed.records.find((record) => record.itemType === 'lifecycle').status).toBe('awaiting_resolution');
  });

  test('derives corrected review math and preserves user-confirmed audit provenance', () => {
    const record = {
      accountId: 'U123',
      itemType: 'lifecycle',
      status: 'review',
      version: 3,
      entryPrincipal: 4,
      fees: 0.2,
      paid: 0,
      netQuantity: 10,
    };
    const patched = applyReviewPatch(record, { market: 'wti', contractLabel: 'WTI $81.49 YES', quantity: 10, entryPrincipal: 4, fees: 0.2, paid: 10, resolvedDate: '2026-08-13', resolutionType: 'expiry' }, 3);
    expect(patched.ok).toBe(true);
    expect(patched.record.status).toBe('confirmed');
    expect(patched.record.verification).toBe('user_confirmed');
    expect(patched.record.risked).toBeCloseTo(4.2);
    expect(patched.record.pnl).toBeCloseTo(5.8);
    expect(patched.record.roi).toBeCloseTo(5.8 / 4.2);
    expect(patched.record.auditTrail).toHaveLength(1);
    expect(normalizePerformanceRow(patched.record)).toBeNull();
    expect(applyReviewPatch(record, {}, 2).code).toBe('version_conflict');
  });

  test('aggregate return uses total P&L divided by total risk', () => {
    expect(summarizeRows([
      { status: 'verified', risked: 10, paid: 20, pnl: 10, roi: 1 },
      { status: 'verified', risked: 90, paid: 45, pnl: -45, roi: -0.5 },
      { status: 'review', risked: 100, paid: 100, pnl: 0, roi: 0 },
    ])).toMatchObject({ count: 2, risked: 100, pnl: -35, roi: -0.35 });
  });

  test('sorts verified rows by opened date and exposes it after settlement', async () => {
    const result = await loadPerformance({
      accountId: 'U123',
      market: 'all',
      store: { queryAccount: jest.fn(async () => [
        { itemType: 'lifecycle', lifecycleId: 'old', status: 'verified', openedAt: '2026-08-01T15:00:00Z', resolvedDate: '2026-08-14', risked: 10, paid: 8, pnl: -2, roi: -0.2, contractLabel: 'WTI $80 YES' },
        { itemType: 'lifecycle', lifecycleId: 'new', status: 'verified', openedAt: '2026-08-13T15:00:00Z', resolvedDate: '2026-08-13', risked: 5, paid: 10, pnl: 5, roi: 1, contractLabel: 'CPI 3.3% YES' },
        { itemType: 'lifecycle', lifecycleId: 'open', status: 'open', openedAt: '2026-08-14T15:00:00Z', expiration: '20260814', netQuantity: 10, risked: 4, paid: 0, contractSide: 'NO', contractKey: 'KXWTI-26AUG1414-T82_NO', contractLabel: 'WTI $82 NO' },
        { itemType: 'lifecycle', lifecycleId: 'review', status: 'review', resolvedDate: '2026-08-14', netQuantity: 10, entryQuantity: 10, risked: 100, paid: 0, pnl: -100, roi: -1, contractLabel: 'WTI $81 YES' },
      ]) }
    });
    expect(result.rows.map((row) => row.id)).toEqual(['new', 'old']);
    expect(result.rows.map((row) => row.openedAt)).toEqual(['2026-08-13T15:00:00Z', '2026-08-01T15:00:00Z']);
    expect(result.summary).toMatchObject({ count: 2, risked: 15, pnl: 3, roi: 0.2 });
    expect(result.activeRows).toEqual([
      expect.objectContaining({ id: 'open', status: 'open', quantity: 10, currentValue: null, pnl: null }),
    ]);
    expect(result.review).toEqual([]);
    expect(result.tracker.quarantinedEvidenceCount).toBe(1);
  });

  test('recovers exact legacy opening timestamps from linked ledger evidence', async () => {
    const records = [
      {
        accountId: 'U123', recordKey: 'lifecycle#101#1', itemType: 'lifecycle', lifecycleId: 'from-execution',
        status: 'verified', risked: 5, paid: 10, contractLabel: 'WTI $80 YES', executionIds: ['buy-101'],
      },
      {
        accountId: 'U123', recordKey: 'execution#buy-101', itemType: 'execution', execId: 'buy-101',
        lifecycleRecordKey: 'lifecycle#101#1', direction: 'BUY', executionTime: '2026-07-10T15:30:00Z',
      },
      {
        accountId: 'U123', recordKey: 'lifecycle#202#1', itemType: 'lifecycle', lifecycleId: 'from-revision',
        status: 'verified', risked: 4, paid: 0, contractLabel: 'CPI 3.4% YES',
      },
      {
        accountId: 'U123', recordKey: 'revision#202#1', itemType: 'revision', targetRecordKey: 'lifecycle#202#1',
        before: { openedAt: '2026-06-28T17:22:27.904Z' },
        after: { openedAt: '2026-06-28T17:22:27.904Z' },
      },
    ];
    const queryAccountPrefix = jest.fn(async (_accountId, prefix) => (
      records.filter((record) => String(record.recordKey).startsWith(prefix))
    ));
    const result = await loadPerformance({
      accountId: 'U123',
      store: { queryAccountPrefix },
    });

    expect(result.rows.find((row) => row.id === 'from-execution')?.openedAt).toBe('2026-07-10T15:30:00.000Z');
    expect(result.rows.find((row) => row.id === 'from-revision')?.openedAt).toBe('2026-06-28T17:22:27.904Z');
    expect(queryAccountPrefix).toHaveBeenCalledWith('U123', 'execution#');
    expect(queryAccountPrefix).toHaveBeenCalledWith('U123', 'revision#');
  });

  test('returns the actual FES contract identity without a legacy/unmatched display label', async () => {
    const records = [
      {
        accountId: 'U123', recordKey: 'lifecycle#matched', lifecycleId: 'matched', itemType: 'lifecycle',
        status: 'verified', resolvedDate: '2026-08-21', risked: 1, paid: 2, pnl: 1, roi: 1,
        contractKey: 'FES_082026_6400_YES', eventTicker: 'FES_082026_6400', contractSide: 'YES', strike: 6400,
      },
      {
        accountId: 'U123', recordKey: 'lifecycle#legacy', lifecycleId: 'legacy', itemType: 'lifecycle',
        status: 'verified', resolvedDate: '2026-08-21', risked: 1, paid: 0, pnl: -1, roi: -1,
        contractKey: 'FES_082026_6450_YES', eventTicker: 'FES_082026_6450', contractSide: 'YES', strike: 6450,
      },
      {
        accountId: 'U123', recordKey: 'execution#matched', itemType: 'execution', lifecycleRecordKey: 'lifecycle#matched',
        direction: 'BUY', spxFesEntryContext: { status: 'matched' },
      },
    ];
    const result = await loadPerformance({ accountId: 'U123', store: { queryAccount: jest.fn(async () => records) } });
    expect(result.rows.find((row) => row.id === 'matched')).toMatchObject({ contractKey: 'FES_082026_6400_YES' });
    expect(result.rows.find((row) => row.id === 'legacy')).toMatchObject({ contractKey: 'FES_082026_6450_YES' });
    expect(result.rows.some((row) => row.fesResearchContextStatus)).toBe(false);
  });

  test('sorts every API column deterministically', async () => {
    const rows = [
      { itemType: 'lifecycle', lifecycleId: 'a', status: 'verified', openedAt: '2026-08-01T15:00:00Z', resolvedDate: '2026-08-02', risked: 2, paid: 9, pnl: 7, roi: 3.5, contractLabel: 'WTI $90 YES', settlementEvidence: { source: 'kalshi_settled_wti', settlementDate: '2026-08-01', settlementValue: 90 } },
      { itemType: 'lifecycle', lifecycleId: 'b', status: 'verified', openedAt: '2026-08-02T15:00:00Z', resolvedDate: '2026-08-01', risked: 5, paid: 4, pnl: -1, roi: -0.2, contractLabel: 'CPI 3.3% NO', settlementEvidence: { source: 'bls_official', settlementDate: '2026-08-02', settlementValue: 81.25 } },
    ];
    const store = { queryAccount: jest.fn(async () => rows) };
    const expectations = {
      date: ['a', 'b'],
      contract: ['b', 'a'],
      settlementDate: ['a', 'b'],
      settlementValue: ['b', 'a'],
      risked: ['a', 'b'],
      paid: ['b', 'a'],
      pnl: ['b', 'a'],
      roi: ['b', 'a'],
    };
    for (const [sort, ids] of Object.entries(expectations)) {
      const result = await loadPerformance({ accountId: 'U123', store, sort, direction: 'asc' });
      expect(result.rows.map((row) => row.id)).toEqual(ids);
    }
  });

  test('exposes only an official underlying settlement value, never the binary contract payout', () => {
    expect(normalizePerformanceRow({
      itemType: 'lifecycle', lifecycleId: 'official-underlying', status: 'verified',
      openedAt: '2026-08-12T15:00:00Z', resolvedDate: '2026-08-14', risked: 10, paid: 20, pnl: 10,
      contractLabel: 'WTI $81.49 NO',
      settlementEvidence: {
        source: 'kalshi_settled_wti',
        settlementDate: '2026-08-14',
        settlementValue: 81.25,
      },
    })).toMatchObject({
      openedAt: '2026-08-12T15:00:00Z',
      settlementDate: '2026-08-14',
      settlementValue: 81.25,
      settlementValueSource: 'kalshi_settled_wti',
      settlementValueStatus: 'official_final',
    });

    expect(normalizePerformanceRow({
      itemType: 'lifecycle', lifecycleId: 'binary-only', status: 'verified',
      resolvedDate: '2026-08-14', risked: 10, paid: 20, pnl: 10,
      contractLabel: 'Gold $4,400 YES',
      resolutionType: 'expiry',
      lastTradeAt: '2026-08-14T17:30:00Z',
      resolutionAt: '2026-08-15T04:55:00Z',
      payoutAt: '2026-08-15T06:55:00Z',
      settlementSymbol: 'GCQ26',
      settlementEvidence: {
        source: 'forecastex_official_prices',
        settlementDate: '2026-08-14',
        settlementPayout: 1,
        outcome: 'YES',
        outcomeObservedAt: '2026-08-15T05:05:00Z',
      },
    })).toMatchObject({
      displayState: 'SETTLED',
      lastTradeAt: '2026-08-14T17:30:00.000Z',
      resolutionAt: '2026-08-15T04:55:00.000Z',
      payoutAt: '2026-08-15T06:55:00.000Z',
      outcome: 'YES',
      outcomeObservedAt: '2026-08-15T05:05:00.000Z',
      payoutPerContract: 1,
      settlementSymbol: 'GCQ26',
      settlementDate: '2026-08-14',
      settlementValue: null,
      resolverAvailability: 'awaiting_official_settlement',
      resolver: { availability: 'awaiting_official_settlement', symbol: 'GCQ26', value: null },
    });
  });

  test('sorts by display status first and groups each market within a status', () => {
    const rows = [
      { id: 'sp-7800', status: 'open', market: 'sp500', contractLabel: 'SP500 7,800 NO' },
      { id: 'wti-8199', status: 'open', markState: 'verified_settlement', market: 'wti', contractLabel: 'WTI $81.99 NO' },
      { id: 'gold-4425', status: 'open', market: 'gold', contractLabel: 'Gold $4,425 YES' },
      { id: 'closed-cpi', status: 'verified', resolutionType: 'early_exit', market: 'cpi', contractLabel: 'CPI 3.3% YES' },
      { id: 'settled-wti', status: 'verified', market: 'wti', contractLabel: 'WTI $82 NO' },
      { id: 'check-gold', status: 'review', market: 'gold', contractLabel: 'Gold $4,500 YES' },
      { id: 'sp-7775', status: 'open', market: 'sp500', contractLabel: 'SP500 7,775 NO' },
      { id: 'wti-8149', status: 'awaiting_resolution', market: 'wti', contractLabel: 'WTI $81.49 NO' },
      { id: 'gold-4400', status: 'open', market: 'gold', contractLabel: 'Gold $4,400 YES' },
    ];

    expect(sortPerformanceRows(rows, 'status', 'asc').map((row) => row.id)).toEqual([
      'wti-8199',
      'gold-4400',
      'gold-4425',
      'sp-7775',
      'sp-7800',
      'wti-8149',
      'closed-cpi',
      'settled-wti',
      'check-gold',
    ]);
  });

  test('persists money as integer microdollars and leaves durable records without TTL', async () => {
    const transactWrite = jest.fn(() => ({ promise: async () => ({}) }));
    const query = jest.fn(() => ({ promise: async () => ({
      Items: [{
        accountId: 'U123',
        recordKey: 'lifecycle#1#1',
        itemType: 'lifecycle',
        riskedMicros: 1_234_568,
        paidMicros: 2_000_000,
      }],
    }) }));
    const store = createLedgerStore({
      dynamodb: {
        transactWrite,
        query,
        get: jest.fn(() => ({ promise: async () => ({}) })),
        put: jest.fn(() => ({ promise: async () => ({}) })),
        update: jest.fn(() => ({ promise: async () => ({}) })),
      },
    });
    await store.transactSave([{ item: {
      accountId: 'U123',
      recordKey: 'lifecycle#1#1',
      itemType: 'lifecycle',
      version: 1,
      risked: 1.2345678,
      paid: 2,
    }, createOnly: true }]);
    const persisted = transactWrite.mock.calls[0][0].TransactItems[0].Put.Item;
    expect(persisted).toMatchObject({ riskedMicros: 1_234_568, paidMicros: 2_000_000 });
    expect(persisted).not.toHaveProperty('risked');
    expect(persisted).not.toHaveProperty('paid');
    expect(persisted).not.toHaveProperty('ttl');

    await expect(store.queryAccount('U123')).resolves.toEqual([
      expect.objectContaining({ risked: 1.234568, paid: 2 }),
    ]);
  });

  test('uses a conditional lease and an atomic health transaction for capture', async () => {
    const store = {
      acquireLease: jest.fn(async () => true),
      registerManagedAccounts: jest.fn(async () => 1),
      queryAccount: jest.fn(async () => []),
      healthItem: jest.fn((accountId, status) => ({ accountId, recordKey: 'health#capture', itemType: 'health', status })),
      transactSave: jest.fn(async () => []),
      writeHealth: jest.fn(async () => ({})),
    };
    const readEvidence = jest.fn(async () => ({
      ok: true,
      status: 'live',
      source: 'ibkr_live',
      complete: true,
      coverageComplete: true,
      partial: false,
      snapshotId: 'snapshot-capture',
      account: 'U123',
      positions: [],
      executions: [],
      positionsPayload: livePayload({ account: 'U123', source: 'ibkr_positions', snapshotId: 'snapshot-capture' }),
      executionsPayload: livePayload({ account: 'U123', source: 'ibkr_executions', snapshotId: 'snapshot-capture' }),
    }));
    const reconciler = createReconciler({ store, readEvidence });
    await expect(reconciler.reconcileAccount('U123')).resolves.toMatchObject({ status: 'captured' });
    expect(store.acquireLease).toHaveBeenCalledWith('U123', expect.any(String), expect.objectContaining({ leaseMs: expect.any(Number) }));
    expect(store.transactSave).toHaveBeenCalledWith([
      expect.objectContaining({ item: expect.objectContaining({ recordKey: 'health#capture', status: 'capturing' }) }),
    ]);

    store.acquireLease.mockResolvedValueOnce(false);
    await expect(reconciler.reconcileAccount('U123')).resolves.toEqual({ status: 'leased_elsewhere' });
    expect(readEvidence).toHaveBeenCalledTimes(1);
  });

  test('imports Flex-only executions without treating a disconnected account as flat', async () => {
    const priorCaptureAt = '2026-09-01T21:00:00.000Z';
    const observedAt = '2026-09-02T06:00:00.000Z';
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#9001#1', itemType: 'lifecycle', lifecycleId: 'still-open',
      status: 'open', version: 2, conId: 9001, netQuantity: 2, entryQuantity: 2,
      entryPrincipal: 0.8, fees: 0.1, feesComplete: true, paid: 0,
      market: 'wti', contractSide: 'YES', contractRule: 'above', strike: 81.49,
      contractKey: 'KXWTI-26AUG13-T81.49-YES',
    };
    const healthItem = jest.fn((accountId, status, details) => ({
      accountId, recordKey: 'health#capture', itemType: 'health', status, ...details,
    }));
    const store = {
      acquireLease: jest.fn(async () => true),
      queryAccount: jest.fn(async () => [
        lifecycle,
        { accountId: 'U123', recordKey: 'health#capture', itemType: 'health', status: 'capturing', lastSuccessfulCaptureAt: priorCaptureAt },
      ]),
      healthItem,
      transactSave: jest.fn(async () => []),
      writeHealth: jest.fn(async () => ({})),
    };
    const historyPayload = {
      ok: true,
      status: 'historical_import',
      source: 'ibkr_flex_import',
      snapshotId: 'flex-through-sep-1',
      fetchedAt: observedAt,
      account: 'U123',
    };
    const readEvidence = jest.fn(async () => ({
      ...historyPayload,
      evidenceMode: 'history_only',
      authoritativeThrough: '2026-09-01',
      liveConnected: false,
      positions: [],
      executions: [{
        ...execution({ id: 'flex-new-1', side: 'BOT', quantity: 1, price: 0.4, time: '2026-09-01T18:00:00.000Z' }),
        source: 'ibkr_flex_import',
        rawFingerprint: 'flex-new-1-sha',
      }],
      positionsPayload: historyPayload,
      executionsPayload: historyPayload,
    }));
    const resolveSettlements = jest.fn(async () => undefined);
    const reconciler = createReconciler({ store, readEvidence, resolveSettlements });

    const result = await reconciler.reconcileAccount('U123');

    expect(result.status).toBe('captured');
    const preservedLifecycle = result.records.find((record) => record.lifecycleId === 'still-open');
    expect(preservedLifecycle).toMatchObject({ status: 'open' });
    expect(preservedLifecycle.reviewReason).toBeFalsy();
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemType: 'execution', execId: 'flex-new-1', source: 'ibkr_flex_import' }),
    ]));
    expect(healthItem).toHaveBeenCalledWith('U123', 'history_only', expect.objectContaining({
      evidenceMode: 'history_only',
      historyThrough: '2026-09-01',
      liveConnected: false,
      lastSuccessfulCaptureAt: priorCaptureAt,
    }), observedAt);
    expect(resolveSettlements).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'U123',
      evidenceMode: 'history_only',
      authoritativeThrough: '2026-09-01',
    }));
  });

  test('falls back to the durable managed-account registry when live discovery is offline', async () => {
    const store = {
      listRegisteredManagedAccounts: jest.fn(async () => ['U123']),
      registerManagedAccounts: jest.fn(async () => 1),
      acquireLease: jest.fn(async () => true),
      writeHealth: jest.fn(async () => ({})),
    };
    const readEvidence = jest.fn(async () => { throw Object.assign(new Error('sidecar offline'), { code: 'ECONNREFUSED' }); });
    const logger = { warn: jest.fn() };
    const reconciler = createReconciler({ store, readEvidence, logger });

    const result = await reconciler.runOnce(async () => { throw new Error('accounts offline'); });

    expect(store.listRegisteredManagedAccounts).toHaveBeenCalled();
    expect(readEvidence).toHaveBeenCalledWith('U123');
    expect(store.writeHealth).toHaveBeenCalledWith('U123', 'capture_paused', expect.objectContaining({ reason: 'ECONNREFUSED' }));
    expect(result).toMatchObject({ status: 'complete', results: { U123: { status: 'capture_paused' } } });
  });

  test('routes a missing position to review when capture crossed the IBKR execution window', async () => {
    const observedAt = new Date().toISOString();
    const priorCaptureAt = new Date(Date.parse(observedAt) - 26 * 60 * 60 * 1000).toISOString();
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#9001#1', itemType: 'lifecycle', lifecycleId: 'open-1',
      status: 'open', version: 2, conId: 9001, netQuantity: 2, entryQuantity: 2,
      entryPrincipal: 0.8, fees: 0.1, feesComplete: true, paid: 0,
    };
    const store = {
      acquireLease: jest.fn(async () => true),
      queryAccount: jest.fn(async () => [
        lifecycle,
        { accountId: 'U123', recordKey: 'health#capture', itemType: 'health', status: 'capturing', lastSuccessfulCaptureAt: priorCaptureAt },
      ]),
      healthItem: jest.fn((accountId, status) => ({ accountId, recordKey: 'health#capture', itemType: 'health', status })),
      transactSave: jest.fn(async () => []),
      writeHealth: jest.fn(async () => ({})),
    };
    const readEvidence = jest.fn(async () => ({
      ok: true, status: 'live', source: 'ibkr_live', complete: true, coverageComplete: true, partial: false,
      snapshotId: 'next-day', account: 'U123', fetchedAt: observedAt, positions: [], executions: [],
      positionsPayload: livePayload({ account: 'U123', source: 'ibkr_positions', snapshotId: 'next-day', fetchedAt: observedAt }),
      executionsPayload: livePayload({ account: 'U123', source: 'ibkr_executions', snapshotId: 'next-day', fetchedAt: observedAt }),
    }));
    const reconciler = createReconciler({ store, readEvidence });

    const result = await reconciler.reconcileAccount('U123');

    expect(result.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      status: 'review',
      reviewReason: 'capture_gap_requires_review',
    });
  });

  test('keeps capture continuous across midnight when consecutive verified snapshots did not gap', async () => {
    const priorCaptureAt = '2026-08-14T03:59:00.000Z';
    const observedAt = '2026-08-14T04:00:00.000Z';
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#9001#1', itemType: 'lifecycle', lifecycleId: 'open-1',
      status: 'open', version: 2, conId: 9001, netQuantity: 2, entryQuantity: 2,
      entryPrincipal: 0.8, fees: 0.1, feesComplete: true, paid: 0,
    };
    const store = {
      acquireLease: jest.fn(async () => true),
      queryAccount: jest.fn(async () => [
        lifecycle,
        { accountId: 'U123', recordKey: 'health#capture', itemType: 'health', status: 'capturing', lastSuccessfulCaptureAt: priorCaptureAt },
      ]),
      healthItem: jest.fn((accountId, status) => ({ accountId, recordKey: 'health#capture', itemType: 'health', status })),
      transactSave: jest.fn(async () => []),
      writeHealth: jest.fn(async () => ({})),
    };
    const readEvidence = jest.fn(async () => ({
      ok: true, status: 'live', source: 'ibkr_live', complete: true, coverageComplete: true, partial: false,
      snapshotId: 'midnight-continuous', account: 'U123', fetchedAt: observedAt, positions: [], executions: [],
      positionsPayload: livePayload({ account: 'U123', source: 'ibkr_positions', snapshotId: 'midnight-continuous', fetchedAt: observedAt }),
      executionsPayload: livePayload({ account: 'U123', source: 'ibkr_executions', snapshotId: 'midnight-continuous', fetchedAt: observedAt }),
    }));
    const reconciler = createReconciler({ store, readEvidence, intervalMs: 60_000 });
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(observedAt));
    const result = await reconciler.reconcileAccount('U123');
    nowSpy.mockRestore();

    expect(result.records.find((record) => record.itemType === 'lifecycle')).toMatchObject({
      status: 'awaiting_resolution',
      reviewReason: 'awaiting_resolution',
    });
  });

  test('splits oversized account captures atomically by lifecycle and writes health last', async () => {
    const transactSave = jest.fn(async (entries) => entries.map((entry) => entry.item));
    const store = { maxTransactionItems: 4, transactSave };
    const lifecycleA = { accountId: 'U123', recordKey: 'lifecycle#1#1', itemType: 'lifecycle' };
    const lifecycleB = { accountId: 'U123', recordKey: 'lifecycle#2#1', itemType: 'lifecycle' };
    const entries = [
      { item: { accountId: 'U123', recordKey: 'execution#a', itemType: 'execution', lifecycleRecordKey: lifecycleA.recordKey } },
      { item: lifecycleA },
      { item: { accountId: 'U123', recordKey: 'execution#b', itemType: 'execution', lifecycleRecordKey: lifecycleB.recordKey } },
      { item: lifecycleB },
    ];
    const health = { accountId: 'U123', recordKey: 'health#capture', itemType: 'health' };

    await persistCaptureEntries(store, entries, health);

    expect(transactSave).toHaveBeenCalledTimes(3);
    expect(transactSave.mock.calls[0][0].map((entry) => entry.item.recordKey)).toEqual(['execution#a', 'lifecycle#1#1']);
    expect(transactSave.mock.calls[1][0].map((entry) => entry.item.recordKey)).toEqual(['execution#b', 'lifecycle#2#1']);
    expect(transactSave.mock.calls[2][0]).toEqual([{ item: health }]);
  });

  test('does not let lower-precedence Flex evidence overwrite a live execution', () => {
    const first = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({ id: 'source-1', side: 'BOT', quantity: 1, price: 0.4 })],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-T81.49-YES', position: 1, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const conflicting = reconcileEvidence({
      accountId: 'U123',
      executions: [{ ...execution({ id: 'source-1', side: 'BOT', quantity: 1, price: 0.5 }), source: 'ibkr_flex_import' }],
      positions: [{ account: 'U123', conId: 9001, symbol: 'KXWTI-26AUG13-T81.49-YES', position: 1, avgCost: 0.4 }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: first.records,
    });
    const evidence = conflicting.records.find((record) => record.itemType === 'execution');
    const lifecycle = conflicting.records.find((record) => record.itemType === 'lifecycle');
    expect(evidence.price).toBe(0.4);
    expect(lifecycle).toMatchObject({ status: 'review', reviewReason: 'execution_evidence_conflict' });
  });

  test('uses exact Flex fees to repair the same live execution without quarantining its verified settlement', () => {
    const localSymbol = 'KXWTI-26AUG13-T81.49-YES';
    const first = reconcileEvidence({
      accountId: 'U123',
      executions: [execution({
        id: 'fee-enrichment-1', side: 'BOT', quantity: 1, price: 0.4,
        commission: 0, symbol: 'KXWTI', localSymbol,
      })],
      positions: [{
        account: 'U123', conId: 9001, symbol: 'KXWTI', localSymbol,
        exchange: 'FORECASTX', secType: 'OPT', expiration: '20260813',
        strike: 81.49, contractSide: 'YES', position: 1, avgCost: 0.4,
      }],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const existingRecords = first.records.map((record) => {
      if (record.itemType !== 'lifecycle') return record;
      const settled = finalizeLifecycle(record, {
        paid: 1,
        resolvedDate: '2026-08-14',
        resolutionType: 'expiry',
        evidence: { source: 'kalshi_exact_finalized_market', payoutPerContract: 1, settlementValue: 81.25 },
      });
      return { ...settled, status: 'review', reviewReason: 'execution_evidence_conflict' };
    });

    const repaired = reconcileEvidence({
      accountId: 'U123',
      executions: [{
        ...execution({
          id: 'fee-enrichment-1', side: 'BOT', quantity: 1, price: 0.4,
          commission: 0.02, symbol: localSymbol, localSymbol,
        }),
        source: 'ibkr_flex_import',
        exchange: 'KALSHI',
        secType: 'EVENT_KALSHI',
        tradingClass: '',
        expiration: '2026-08-13',
        orderId: 12345,
        rawFingerprint: 'flex-sha256',
      }],
      positions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords,
    });

    const evidence = repaired.records.find((record) => record.itemType === 'execution');
    const lifecycle = repaired.records.find((record) => record.itemType === 'lifecycle');
    expect(evidence).toMatchObject({
      source: 'ibkr_live_execution',
      commission: 0.02,
      feeEvidenceSource: 'ibkr_flex_import',
      orderId: 12345,
    });
    expect(lifecycle).toMatchObject({
      status: 'verified',
      reviewReason: null,
      verification: 'verified_settlement',
      resolutionType: 'expiry',
      paid: 1,
      pnl: 0.58,
      performanceComplete: true,
    });
    expect(lifecycle.entryCost).toBeCloseTo(0.42, 6);
    expect(repaired.revisionRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionType: 'ibkr_execution_enrichment', actor: 'ibkr_flex_import' }),
    ]));
  });

  test('clears a false position review when live and ledger quantities differ only by floating-point noise', () => {
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#919473303#1', lifecycleId: 'gold-float', itemType: 'lifecycle',
      conId: 919473303, symbol: 'KXGOLDD', localSymbol: 'KXGOLDD-26SEP0117-T4386_YES',
      secType: 'OPT', exchange: 'KALSHI', expiration: '20260901', strike: 4386, contractSide: 'YES',
      contractRule: 'above', contractKey: 'KXGOLDD-26SEP0117-T4386_YES', eventTicker: null,
      market: 'other', contractLabel: 'KXGOLDD-26SEP0117-T4386_YES', status: 'review',
      reviewReason: 'position_quantity_changed_without_execution_evidence', verification: 'ibkr_live_execution',
      entryQuantity: 1000.0000000000001, netQuantity: 1000.0000000000001, remainingQuantity: 1000.0000000000001,
      entryPrincipal: 360, fees: 0, feesComplete: true, risked: 360, entryCost: 360, paid: 0,
      executionIds: [], version: 1, createdAt: now, updatedAt: now,
    };
    const result = reconcileEvidence({
      accountId: 'U123',
      positions: [{
        account: 'U123', conId: 919473303, symbol: 'KXGOLDD', localSymbol: 'KXGOLDD-26SEP0117-T4386_YES',
        secType: 'OPT', expiration: '20260901',
        strike: 4386, contractSide: 'YES', position: 1000, avgCost: 0.36,
      }],
      executions: [],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
      existingRecords: [lifecycle],
    });
    expect(result.records.find((record) => record.recordKey === lifecycle.recordKey)).toMatchObject({
      status: 'open',
      reviewReason: null,
      netQuantity: 1000.0000000000001,
      lastPositionQuantity: 1000,
      market: 'gold',
      contractLabel: 'Gold $4,386 YES',
      eventTicker: 'KXGOLDD-26SEP0117',
    });
  });

  test('reconstructs an exact ForecastEx CPI cashout plus Flex expiry posting without review', () => {
    const cpiExecution = ({ id, conId, side, direction, quantity, price, commission, time, exchange = 'FORECASTX' }) => ({
      accountId: 'U123', execId: id, conId,
      symbol: `CPIY_0626_3.8_${side}`, localSymbol: `CPIY_0626_3.8_${side}`,
      description: `June CPI 3.8 ${side}`, secType: 'EVENT_FORECASTX', exchange,
      expiration: '2026-07-14', direction, quantity, price, commission, tax: 0,
      transactionType: direction === 'SELL' ? 'BookTrade' : 'ExchTrade',
      executionTime: time, source: 'ibkr_flex_import',
    });
    const executions = [
      cpiExecution({ id: 'yes-entry', conId: 753279793, side: 'YES', direction: 'BUY', quantity: 63, price: 0.3, commission: 0.63, time: '2026-06-25T15:58:09Z' }),
      cpiExecution({ id: 'no-offset', conId: 753279796, side: 'NO', direction: 'BUY', quantity: 11, price: 0.74, commission: 0.11, time: '2026-07-03T14:42:25Z' }),
      cpiExecution({ id: 'yes-conversion', conId: 753279793, side: 'YES', direction: 'SELL', quantity: 11, price: 0.5, commission: 0, time: '2026-07-03T21:15:00Z', exchange: '--' }),
      cpiExecution({ id: 'no-conversion', conId: 753279796, side: 'NO', direction: 'SELL', quantity: 11, price: 0.5, commission: 0, time: '2026-07-03T21:15:00Z', exchange: '--' }),
      cpiExecution({ id: 'yes-expiry', conId: 753279793, side: 'YES', direction: 'SELL', quantity: 52, price: 0, commission: 0, time: '2026-07-14T04:00:00Z', exchange: '--' }),
    ];
    const result = reconcileEvidence({
      accountId: 'U123',
      positions: [],
      executions,
      positionsPayload: livePayload(),
      executionsPayload: livePayload(),
      existingRecords: [],
    });
    expect(result.status).toBe('captured');
    const lifecycles = result.records.filter((record) => record.itemType === 'lifecycle');
    expect(lifecycles.find((record) => record.conId === 753279793)).toMatchObject({
      status: 'verified', reviewReason: null, resolutionType: 'expiry',
      verification: 'ibkr_flex_settlement', contractRule: 'above',
      entryQuantity: 63, exitedQuantity: 11, remainingQuantity: 52,
      entryCost: 19.53, netExitProceeds: 2.75, paid: 2.75, pnl: -16.78,
      economicBundleStatus: 'verified',
      settlementEvidence: { source: 'ibkr_flex_book_trade', payoutPerContract: 0 },
    });
    expect(lifecycles.find((record) => record.conId === 753279796)).toMatchObject({
      status: 'paired_offset_component', reviewReason: null,
      pairedToLifecycleRecordKey: expect.any(String),
    });
    expect(lifecycles.filter((record) => record.status === 'review')).toEqual([]);
  });

  test('reconstructs a fully exited ForecastEx CPI cashout when later purchases share the first conversion second', () => {
    const accountId = 'U123';
    const makeExecution = ({ id, conId, side, direction, quantity, price, time }) => ({
      accountId, recordKey: `execution#${id}`, itemType: 'execution', execId: id, conId,
      symbol: 'CPIY', localSymbol: `CPIY_0826_3.3_${side}`, contractKey: `CPIY_0826_3.3_${side}`,
      eventTicker: 'CPIY_0826_3.3', exchange: 'FORECASTX', secType: 'OPT', tradingClass: 'CPIY',
      strike: 3.3, contractSide: side, contractRule: 'above', direction, shares: quantity, price,
      commission: 0, tax: 0, feesComplete: true, executionTime: time, source: 'ibkr_live_execution',
    });
    const executions = [
      makeExecution({ id: 'yes-entry-01', conId: 900623482, side: 'YES', direction: 'BUY', quantity: 11, price: 0.67, time: '2026-08-24T15:00:01Z' }),
      makeExecution({ id: 'yes-entry-02', conId: 900623482, side: 'YES', direction: 'BUY', quantity: 14, price: 0.69, time: '2026-08-24T15:00:02Z' }),
      makeExecution({ id: 'yes-entry-03', conId: 900623482, side: 'YES', direction: 'BUY', quantity: 38, price: 0.69, time: '2026-08-24T15:00:03Z' }),
      makeExecution({ id: 'yes-entry-04', conId: 900623482, side: 'YES', direction: 'BUY', quantity: 3, price: 0.69, time: '2026-08-24T15:00:04Z' }),
      makeExecution({ id: 'no-buy-01', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.46, time: '2026-08-27T15:02:49Z' }),
      makeExecution({ id: 'no-buy-02', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.48, time: '2026-08-27T15:02:49Z' }),
      makeExecution({ id: 'no-buy-03', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.50, time: '2026-08-27T15:02:50Z' }),
      makeExecution({ id: 'no-buy-04', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.54, time: '2026-08-27T15:02:50Z' }),
      makeExecution({ id: 'no-buy-05', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.58, time: '2026-08-27T15:02:51Z' }),
      makeExecution({ id: 'no-buy-06', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 2, price: 0.58, time: '2026-08-27T15:02:51Z' }),
      makeExecution({ id: 'no-buy-07', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 10, price: 0.62, time: '2026-08-27T15:02:51Z' }),
      makeExecution({ id: 'no-buy-08', conId: 900623487, side: 'NO', direction: 'BUY', quantity: 4, price: 0.66, time: '2026-08-27T15:02:52Z' }),
      makeExecution({ id: 'yes-sell-10', conId: 900623482, side: 'YES', direction: 'SELL', quantity: 10, price: 0.5, time: '2026-08-27T15:02:49Z' }),
      makeExecution({ id: 'no-sell-10', conId: 900623487, side: 'NO', direction: 'SELL', quantity: 10, price: 0.5, time: '2026-08-27T15:02:49Z' }),
      makeExecution({ id: 'yes-sell-56', conId: 900623482, side: 'YES', direction: 'SELL', quantity: 56, price: 0.5, time: '2026-08-27T15:04:41Z' }),
      makeExecution({ id: 'no-sell-56', conId: 900623487, side: 'NO', direction: 'SELL', quantity: 56, price: 0.5, time: '2026-08-27T15:04:41Z' }),
    ];
    const lifecycleFor = (conId, side) => {
      const related = executions.filter((item) => item.conId === conId);
      const buys = related.filter((item) => item.direction === 'BUY');
      const sells = related.filter((item) => item.direction === 'SELL');
      return {
        accountId, recordKey: `lifecycle#${conId}#1`, lifecycleId: `cpi-${side}`, itemType: 'lifecycle',
        conId, symbol: 'CPIY', localSymbol: `CPIY_0826_3.3_${side}`, tradingClass: 'CPIY', secType: 'OPT',
        exchange: 'FORECASTX', strike: 3.3, contractSide: side, contractRule: 'above', market: 'cpi',
        contractKey: `CPIY_0826_3.3_${side}`, eventTicker: 'CPIY_0826_3.3', status: 'review',
        reviewReason: 'cashout_bundle_ambiguous', verification: 'ibkr_live_execution',
        entryQuantity: buys.reduce((sum, item) => sum + item.shares, 0),
        netQuantity: buys.reduce((sum, item) => sum + item.shares, 0) - sells.reduce((sum, item) => sum + item.shares, 0),
        entryPrincipal: buys.reduce((sum, item) => sum + item.shares * item.price, 0),
        feesComplete: true, executionIds: related.map((item) => item.execId), version: 1,
      };
    };
    const replay = reconstructForecastExEconomicRecords({
      lifecycleRecords: [lifecycleFor(900623482, 'YES'), lifecycleFor(900623487, 'NO')],
      executionRecords: executions,
      now: '2026-08-27T15:05:00Z',
    });
    expect(replay.ambiguous).toEqual([]);
    expect(replay.bundles).toEqual([expect.objectContaining({
      heldSide: 'YES', entryQuantity: 66, exitedQuantity: 66, remainingQuantity: 0,
      entryCost: 45.98, netExitProceeds: 29.74, cashOutCount: 2,
    })]);
    expect(replay.records.find((record) => record.conId === 900623482)).toMatchObject({
      status: 'verified', reviewReason: null, resolutionType: 'early_exit', resolvedDate: '2026-08-27',
      entryCost: 45.98, netExitProceeds: 29.74, paid: 29.74, pnl: -16.24,
      remainingQuantity: 0, netQuantity: 0, valuationStatus: 'broker_execution',
      holdToExpiryPnl: null, savedVsHold: null,
    });
    expect(replay.records.find((record) => record.conId === 900623487)).toMatchObject({
      status: 'paired_offset_component', reviewReason: null, economicRole: 'paired_offset_component',
      pairedToLifecycleRecordKey: 'lifecycle#900623482#1',
    });
    const flexDuplicates = executions.filter((item) => item.direction === 'SELL').map((item) => ({
      ...item,
      execId: `flex-${item.execId}`,
      recordKey: `execution#flex-${item.execId}`,
      executionTime: '2026-08-27T21:15:00Z',
      source: 'ibkr_flex_import',
      transactionType: 'BookTrade',
    }));
    const duplicateLifecycleFor = (conId, side) => ({
      ...lifecycleFor(conId, side),
      recordKey: `lifecycle#${conId}#2`,
      lifecycleId: `duplicate-${side}`,
      entryQuantity: 0,
      netQuantity: 0,
      entryPrincipal: 0,
      executionIds: flexDuplicates.filter((item) => item.conId === conId).map((item) => item.execId),
    });
    const replayWithFlexRepresentations = reconstructForecastExEconomicRecords({
      lifecycleRecords: [
        lifecycleFor(900623482, 'YES'),
        lifecycleFor(900623487, 'NO'),
        duplicateLifecycleFor(900623482, 'YES'),
        duplicateLifecycleFor(900623487, 'NO'),
      ],
      executionRecords: [...executions, ...flexDuplicates],
      now: '2026-08-27T21:16:00Z',
    });
    expect(replayWithFlexRepresentations.ambiguous).toEqual([]);
    expect(replayWithFlexRepresentations.bundles).toEqual([expect.objectContaining({
      heldSide: 'YES', entryQuantity: 66, exitedQuantity: 66, netExitProceeds: 29.74,
    })]);
    expect(replayWithFlexRepresentations.records.find(
      (record) => record.recordKey === 'lifecycle#900623482#1',
    )).toMatchObject({ status: 'verified', pnl: -16.24 });
    expect(replayWithFlexRepresentations.records.filter(
      (record) => record.lifecycleId.startsWith('duplicate-'),
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'broker_execution_representation', reviewReason: null }),
      expect.objectContaining({ status: 'broker_execution_representation', reviewReason: null }),
    ]));
    expect(reconstructForecastExEconomicRecords({
      lifecycleRecords: replay.records,
      executionRecords: executions,
      now: '2026-08-27T15:05:00Z',
    }).changedRecords).toHaveLength(0);
  });

  test('reconstructs the Aug 21 ForecastEx tape as exactly three original contracts', () => {
    const accountId = 'U123';
    const makeExecution = ({ id, conId, strike, side, direction, quantity, price, time }) => ({
      accountId,
      recordKey: `execution#${id}`,
      itemType: 'execution',
      execId: id,
      conId,
      symbol: 'ES',
      localSymbol: `FES_082126_${strike}_${side}`,
      contractKey: `FES_082126_${strike}_${side}`,
      eventTicker: `FES_082126_${strike}`,
      exchange: 'FORECASTX',
      secType: 'FOP',
      tradingClass: 'FES',
      expiration: '20260821',
      strike,
      contractSide: side,
      contractRule: 'above',
      direction,
      shares: quantity,
      price,
      commission: 0,
      tax: 0,
      feesComplete: true,
      executionTime: time,
      source: 'ibkr_live_execution',
    });
    const executions = [
      makeExecution({ id: 'entry-7700', conId: 1, strike: 7700, side: 'YES', direction: 'BUY', quantity: 12500, price: 0.3096, time: '2026-08-21T13:58:00Z' }),
      makeExecution({ id: 'entry-7725', conId: 3, strike: 7725, side: 'YES', direction: 'BUY', quantity: 5000, price: 0.06, time: '2026-08-21T13:59:00Z' }),
      makeExecution({ id: 'entry-7750', conId: 4, strike: 7750, side: 'YES', direction: 'BUY', quantity: 5000, price: 0.02, time: '2026-08-21T14:19:00Z' }),
    ];
    const cashouts7700 = [
      ['19:07:24', 500, 0.58], ['19:07:36', 1500, 0.60], ['19:08:12', 500, 0.55],
      ['19:09:16', 1000, 0.55], ['19:12:04', 500, 0.68], ['19:13:07', 500, 0.68],
      ['19:14:00', 500, 0.68], ['19:14:42', 500, 0.68], ['19:18:11', 500, 0.68],
      ['19:18:29', 32, 0.68], ['19:19:02', 500, 0.68], ['19:21:26', 500, 0.68],
      ['19:24:47', 500, 0.68], ['19:24:57', 968, 0.68], ['19:38:57', 25, 0.55],
      ['19:45:08', 500, 0.55], ['19:45:49', 975, 0.55],
    ];
    cashouts7700.forEach(([clock, quantity, price], index) => {
      const time = `2026-08-21T${clock}Z`;
      executions.push(
        makeExecution({ id: `offset-buy-${index}`, conId: 2, strike: 7700, side: 'NO', direction: 'BUY', quantity, price, time }),
        makeExecution({ id: `held-pair-${index}`, conId: 1, strike: 7700, side: 'YES', direction: 'SELL', quantity, price: 0.5, time }),
        makeExecution({ id: `offset-pair-${index}`, conId: 2, strike: 7700, side: 'NO', direction: 'SELL', quantity, price: 0.5, time }),
      );
    });
    executions.push(
      makeExecution({ id: 'offset-buy-7750', conId: 5, strike: 7750, side: 'NO', direction: 'BUY', quantity: 1, price: 0.94, time: '2026-08-21T19:27:54Z' }),
      makeExecution({ id: 'held-pair-7750', conId: 4, strike: 7750, side: 'YES', direction: 'SELL', quantity: 1, price: 0.5, time: '2026-08-21T19:27:55Z' }),
      makeExecution({ id: 'offset-pair-7750', conId: 5, strike: 7750, side: 'NO', direction: 'SELL', quantity: 1, price: 0.5, time: '2026-08-21T19:27:55Z' }),
    );
    const lifecycleFor = (conId, strike, side, status = 'awaiting_resolution') => {
      const related = executions.filter((item) => item.conId === conId);
      const buys = related.filter((item) => item.direction === 'BUY');
      const sells = related.filter((item) => item.direction === 'SELL');
      const entryQuantity = buys.reduce((sum, item) => sum + item.shares, 0);
      const netQuantity = entryQuantity - sells.reduce((sum, item) => sum + item.shares, 0);
      const entryPrincipal = buys.reduce((sum, item) => sum + item.shares * item.price, 0);
      const risked = entryPrincipal + entryQuantity * 0.01;
      return {
        accountId, recordKey: `lifecycle#${conId}#1`, lifecycleId: `life-${conId}`, itemType: 'lifecycle',
        conId, contractKey: `FES_082126_${strike}_${side}`, eventTicker: `FES_082126_${strike}`,
        localSymbol: `FES_082126_${strike}_${side}`, symbol: 'ES', tradingClass: 'FES', secType: 'FOP',
        expiration: '20260821', strike, contractSide: side, contractRule: 'above', market: 'sp500', status,
        entryQuantity, netQuantity, remainingQuantity: netQuantity, entryPrincipal, risked, entryCost: risked,
        executionIds: related.map((item) => item.execId), version: 1,
      };
    };
    const lifecycleRecords = [
      lifecycleFor(1, 7700, 'YES'), lifecycleFor(2, 7700, 'NO', 'verified'),
      { ...lifecycleFor(2, 7700, 'NO', 'review'), recordKey: 'lifecycle#2#4', executionIds: [] },
      lifecycleFor(3, 7725, 'YES'), lifecycleFor(4, 7750, 'YES'), lifecycleFor(5, 7750, 'NO', 'verified'),
    ];
    [lifecycleRecords[0], lifecycleRecords[4]].forEach((record) => Object.assign(record, {
      status: 'review',
      reviewReason: 'cashout_bundle_ambiguous',
      resolutionType: 'expiry',
      resolutionAt: '2026-08-21T20:00:00Z',
      settlementEvidence: { source: 'forecastex_official_prices', payoutPerContract: 0 },
    }));
    executions.push(
      makeExecution({ id: 'expiry-posting-7700', conId: 1, strike: 7700, side: 'YES', direction: 'SELL', quantity: 2500, price: 0, time: '2026-08-22T15:00:00Z' }),
      makeExecution({ id: 'expiry-posting-7750', conId: 4, strike: 7750, side: 'YES', direction: 'SELL', quantity: 4999, price: 0, time: '2026-08-22T15:00:00Z' }),
    );
    const replay = reconstructForecastExEconomicRecords({
      lifecycleRecords,
      executionRecords: executions,
    });
    const visible = replay.records.filter((record) => record.status !== 'paired_offset_component');
    expect(visible).toHaveLength(3);
    expect(replay.ambiguous).toEqual([]);
    expect(visible.map((record) => record.contractLabel || buildContractLabel(record))).toEqual([
      'Above 7,700 YES', 'Above 7,725 YES', 'Above 7,750 YES',
    ]);
    expect(visible.map((record) => ({
      entryQuantity: record.entryQuantity,
      remainingQuantity: record.remainingQuantity ?? record.netQuantity,
      entryCost: record.entryCost ?? record.risked,
      netExitProceeds: record.netExitProceeds || 0,
    }))).toEqual([
      { entryQuantity: 12500, remainingQuantity: 2500, entryCost: 3995, netExitProceeds: 3660 },
      { entryQuantity: 5000, remainingQuantity: 5000, entryCost: 350, netExitProceeds: 0 },
      { entryQuantity: 5000, remainingQuantity: 4999, entryCost: 150, netExitProceeds: 0.05 },
    ]);
    expect(visible.find((record) => record.strike === 7725)).toMatchObject({
      economicRole: 'original_contract',
      economicBundleStatus: 'entry_only_verified',
      ledgerModelVersion: FORECASTEX_LEDGER_MODEL_VERSION,
      entryCost: 350,
    });
    expect(visible.find((record) => record.strike === 7700)).toMatchObject({ paid: 3660, pnl: -335 });
    expect(visible.find((record) => record.strike === 7750)).toMatchObject({ paid: 0.05, pnl: -149.95 });
    expect(reconstructForecastExEconomicRecords({ lifecycleRecords: replay.records, executionRecords: executions }).changedRecords).toHaveLength(0);
  });

  test('fills historical basis only from complete exact Flex trade coverage', () => {
    const historical = {
      accountId: 'U123', recordKey: 'lifecycle#872435569#1', lifecycleId: 'july-14', itemType: 'lifecycle',
      conId: 872435569, status: 'verified', resolutionType: 'expiry', resolvedDate: '2026-07-14',
      historicalImportId: 'cpi-2026', contractKey: 'KXCPIYOY-26JUN-T3.9_YES',
      eventTicker: 'KXCPIYOY-26JUN-T3.9', symbol: 'KXCPIYOY', contractSide: 'YES', contractRule: 'above',
      strike: 3.9, market: 'cpi', expiration: '20260714', entryQuantity: 500, paid: 0,
      risked: null, entryPrincipal: null, fees: null, feesComplete: false, costBasisComplete: false,
      performanceComplete: false, version: 1,
    };
    const flex = {
      accountId: 'U123', execId: 'flex-july-14', conId: 872435569, symbol: 'KXCPIYOY',
      localSymbol: 'KXCPIYOY-26JUN-T3.9_YES', exchange: 'FORECASTX', secType: 'OPT',
      expiration: '20260714', strike: 3.9, contractSide: 'YES', side: 'BUY', quantity: 500,
      price: 0.42, commission: 5, commissionCurrency: 'USD', tax: 0,
      executionTime: '2026-06-15T15:00:00Z', source: 'ibkr_flex_import',
    };
    const result = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [flex], existingRecords: [historical],
      positionsPayload: livePayload({ source: 'ibkr_positions' }),
      executionsPayload: livePayload({ source: 'ibkr_executions' }),
    });
    const backfilled = result.records.find((record) => record.recordKey === historical.recordKey);
    expect(result.records.filter((record) => record.itemType === 'lifecycle')).toHaveLength(1);
    expect(backfilled).toMatchObject({
      entryPrincipal: 210, fees: 5, entryCost: 215, risked: 215,
      basisStatus: 'complete', costBasisComplete: true, performanceComplete: true,
      pnl: -215, roi: -1, costBasisSource: 'ibkr_flex_exact_execution_coverage',
    });

    const incomplete = reconcileEvidence({
      accountId: 'U123', positions: [], executions: [{ ...flex, quantity: 499, shares: 499 }], existingRecords: [historical],
      positionsPayload: livePayload({ source: 'ibkr_positions', snapshotId: 'snapshot-2' }),
      executionsPayload: livePayload({ source: 'ibkr_executions', snapshotId: 'snapshot-2' }),
    });
    expect(incomplete.records.filter((record) => record.itemType === 'lifecycle')).toHaveLength(2);
    expect(incomplete.records.find((record) => record.recordKey === historical.recordKey)).toMatchObject({
      status: 'historical_snapshot_superseded',
      verification: 'superseded_by_ibkr_activity',
      supersededByLifecycleRecordKeys: ['lifecycle#872435569#2'],
    });
    expect(incomplete.records.find((record) => record.recordKey === 'lifecycle#872435569#2')).toMatchObject({
      entryQuantity: 499,
      verification: 'ibkr_live_execution',
    });
  });

  test('creates immutable revision records with money serialized in their snapshots', () => {
    const before = { accountId: 'U123', recordKey: 'lifecycle#1#1', itemType: 'lifecycle', version: 1, risked: 1.25 };
    const after = { ...before, version: 2, risked: 1.5 };
    const revision = createRevisionRecord({ accountId: 'U123', target: after, before, after, revisionType: 'user_confirmed' });
    expect(revision).toMatchObject({ itemType: 'revision', targetRecordKey: 'lifecycle#1#1', revisionType: 'user_confirmed', version: 2 });
    expect(revision.before).toMatchObject({ riskedMicros: 1_250_000 });
    expect(revision.after).toMatchObject({ riskedMicros: 1_500_000 });
    expect(revision.before).not.toHaveProperty('risked');
  });
});
