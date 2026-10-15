const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDerivedSummary,
  buildMatches,
  buildStockBorrowFeeSummary,
  createIbkrInterestValidationService,
  flexReportingRange,
  hasMonthlyReconciliation,
  latestVerifiedTierSchedule,
  remainingPredictionUpper,
  resolveDebitRateEvidence,
  requireLiveObservation,
  requireLiveBalanceInterestObservation,
} = require('./ibkrInterestValidationService.cjs');
const {
  createInterestValidationStore,
} = require('./ibkrInterestValidationStore.cjs');

const ACCOUNT = 'U25779973';

function flexSnapshot(overrides = {}) {
  return {
    source: 'ibkr_flex_interest_web_service',
    reportHash: 'a'.repeat(64),
    revisionHash: 'b'.repeat(64),
    fetchedAt: '2026-07-27T11:00:00.000Z',
    fromDate: '2026-06-13',
    toDate: '2026-07-26',
    tierDetails: [{
      currency: 'USD',
      interestType: 'Debit Interest',
      valueDate: '2026-07-26',
      tierBreak: 'I',
      totalPrincipal: -100000,
      rate: 5.13,
      totalInterest: -14.25,
    }],
    cashReports: [],
    cashTransactions: [],
    derived: {
      dailyDebitActuals: [{
        date: '2026-07-26',
        currency: 'USD',
        totalInterest: -3.5,
        debitAmount: 3.5,
        rowCount: 1,
      }],
      monthlyPaid: [],
    },
    ...overrides,
  };
}

function liveObservation(overrides = {}) {
  return {
    ok: true,
    connected: true,
    status: 'live',
    source: 'ibkr_live_interest_observation',
    account: ACCOUNT,
    observed_at: '2026-07-27T21:00:00.000Z',
    socket_verified_at: '2026-07-27T20:59:59.000Z',
    account_values_observed_at: '2026-07-27T20:59:58.000Z',
    positions_observed_at: '2026-07-27T20:59:58.000Z',
    executions_observed_at: '2026-07-27T20:59:59.000Z',
    from_cache: false,
    freshness: {
      status: 'fresh',
      account_reads: 2,
      position_reads: 2,
      execution_reads: 2,
    },
    summary: {
      baseCurrency: 'USD',
      'TotalCashValue-S': 50000,
      'TotalCashValue-C': 0,
      'TotalCashValue-Z': 0,
      'SettledCashByDate-S': '20260727:50000',
      'SettledCashByDate-C': '20260727:0',
      'SettledCashByDate-Z': '20260727:0',
      FxCashBalance: 0,
      'MaintMarginReq-C': 0,
      'AccruedCash-S': -326.79,
    },
    forecast: {
      eligible: true,
      forecastKind: 'completed_session_window',
      sessionDate: '2026-07-27',
      basisSessionDate: '2026-07-27',
      cashAnchorDate: '2026-07-27',
      nextSessionDate: '2026-07-28',
      accrualDays: 1,
      currentSessionCloseAt: '2026-07-27T20:00:00.000Z',
      currentSessionScheduled: true,
      currentSessionComplete: true,
      priorCompletedSessionDate: '2026-07-24',
      latestCompletedSessionDate: '2026-07-27',
      verification: 'ibkr_liquid_hours_and_broker_time',
    },
    market_calendar: {
      verifiedNyDate: '2026-07-27',
      forecastKind: 'completed_session_window',
      sessionDate: '2026-07-27',
      basisSessionDate: '2026-07-27',
      cashAnchorDate: '2026-07-27',
      accrualDays: 1,
      currentSessionScheduled: true,
      currentSessionCloseAt: '2026-07-27T20:00:00.000Z',
      currentSessionComplete: true,
      priorCompletedSessionDate: '2026-07-24',
      latestCompletedSessionDate: '2026-07-27',
      nextSessionDate: '2026-07-28',
      liquidHours: '20260727:0930-1600;20260728:0930-1600',
      source: 'ibkr_contract_details_and_historical_schedule',
    },
    position_scope: {
      mode: 'stocks_only',
      allSupportedForBalance: true,
      allStock: true,
      allBaseCurrency: true,
      stockPositionCount: 1,
      eventPositionCount: 0,
    },
    event_position_evidence: [],
    event_accounting: null,
    short_positions: [{
      conId: 1,
      symbol: 'SHORT',
      currency: 'USD',
      quantity: -1000,
      priorClose: 80,
      priorCloseSource: 'ibkr_historical_daily_close',
      priorCloseSessionDate: '2026-07-24',
      priorCloseObservedAt: '2026-07-27T20:59:57.000Z',
      snapshotTimestamp: '2026-07-27T20:59:58.000Z',
    }],
    execution_evidence: {
      asOf: '2026-07-27T20:59:59.000Z',
      count: 0,
      rows: [],
    },
    evidence_hash: 'c'.repeat(64),
    ...overrides,
  };
}

function closedDayObservation({
  sessionDate,
  observedAt,
  accrualDays,
  evidenceHash = 'd'.repeat(64),
} = {}) {
  const basisSessionDate = '2026-07-31';
  const nextSessionDate = '2026-08-03';
  const compactSessionDate = sessionDate.replaceAll('-', '');
  const compactNextSessionDate = nextSessionDate.replaceAll('-', '');
  const base = liveObservation();
  return {
    ...base,
    observed_at: observedAt,
    socket_verified_at: observedAt,
    account_values_observed_at: observedAt,
    positions_observed_at: observedAt,
    executions_observed_at: observedAt,
    summary: {
      ...base.summary,
      'TotalCashValue-S': 50000,
      'TotalCashValue-C': 0,
      'TotalCashValue-Z': 0,
      'SettledCashByDate-S': `${compactSessionDate}:49000;${compactNextSessionDate}:50000`,
      'SettledCashByDate-C': `${compactSessionDate}:0;${compactNextSessionDate}:0`,
      'SettledCashByDate-Z': `${compactSessionDate}:0;${compactNextSessionDate}:0`,
    },
    forecast: {
      eligible: true,
      forecastKind: 'closed_day_remaining_window',
      sessionDate,
      basisSessionDate,
      cashAnchorDate: sessionDate,
      nextSessionDate,
      accrualDays,
      currentSessionCloseAt: null,
      currentSessionScheduled: false,
      currentSessionComplete: false,
      priorCompletedSessionDate: basisSessionDate,
      latestCompletedSessionDate: basisSessionDate,
      verification: 'ibkr_liquid_hours_and_broker_time',
    },
    market_calendar: {
      verifiedNyDate: sessionDate,
      forecastKind: 'closed_day_remaining_window',
      sessionDate,
      basisSessionDate,
      cashAnchorDate: sessionDate,
      accrualDays,
      currentSessionScheduled: false,
      currentSessionCloseAt: null,
      currentSessionComplete: false,
      priorCompletedSessionDate: basisSessionDate,
      latestCompletedSessionDate: basisSessionDate,
      nextSessionDate,
      liquidHours: '20260731:0930-1600;20260801:CLOSED;20260802:CLOSED;20260803:0930-1600',
      source: 'ibkr_contract_details_and_historical_schedule',
    },
    short_positions: base.short_positions.map((position) => ({
      ...position,
      priorCloseSessionDate: basisSessionDate,
      priorCloseObservedAt: observedAt,
      snapshotTimestamp: observedAt,
    })),
    execution_evidence: {
      asOf: observedAt,
      count: 0,
      rows: [],
    },
    evidence_hash: evidenceHash,
  };
}

function serviceHarness({ evidenceReader = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-interest-validation-'));
  const store = createInterestValidationStore({ dataDir });
  let snapshots = [flexSnapshot()];
  const flexService = {
    status: jest.fn(() => ({
      enabled: true,
      configured: true,
      status: 'ready',
    })),
    history: jest.fn(() => snapshots),
    sync: jest.fn(async () => snapshots[0]),
  };
  let currentNow = new Date('2026-07-27T21:00:00.000Z');
  const sidecarRequestImpl = jest.fn(async () => liveObservation());
  const service = createIbkrInterestValidationService({
    env: {
      IBKR_INTEREST_VALIDATION_ENABLED: 'true',
      IBKR_INTEREST_GUARD_MODE: 'graduated',
      IBKR_FLEX_EXPECTED_ACCOUNT_ID: ACCOUNT,
    },
    now: () => currentNow,
    store,
    flexService,
    sidecarRequestImpl,
    evidenceReader,
  });
  return {
    dataDir,
    flexService,
    service,
    setNow(value) {
      currentNow = new Date(value);
    },
    setSnapshots(value) {
      snapshots = value;
    },
    sidecarRequestImpl,
    store,
  };
}

describe('IBKR interest validation service', () => {
  const cleanup = [];

  afterEach(() => {
    cleanup.splice(0).forEach((directory) => {
      fs.rmSync(directory, { recursive: true, force: true });
    });
  });

  test('normalizes only fresh exact-account broker observations', () => {
    const currentTime = new Date('2026-07-27T21:00:01.000Z');
    const normalized = requireLiveObservation(
      liveObservation(),
      ACCOUNT,
      { now: currentTime },
    );
    expect(normalized).toMatchObject({
      account: ACCOUNT,
      sessionDate: '2026-07-27',
      accrualDays: 1,
      securitiesCash: 50000,
      commoditiesCash: 0,
      ibuklCash: 0,
      positionScope: 'stocks_only',
      forecastKind: 'completed_session_window',
      basisSessionDate: '2026-07-27',
      eventMarketValue: 0,
      kalshiMarketValue: 0,
      liveAccruedCash: -326.79,
    });

    expect(() => requireLiveObservation(
      liveObservation({ from_cache: true }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_unverified',
    }));

    expect(() => requireLiveObservation(
      liveObservation({
        observed_at: '2000-01-01T00:00:00.000Z',
      }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_timestamp_unverified',
    }));

    expect(() => requireLiveObservation(
      liveObservation({ market_calendar: null }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_calendar_unverified',
    }));

    expect(() => requireLiveObservation(
      liveObservation({ execution_evidence: null }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_execution_unverified',
    }));

    expect(() => requireLiveObservation(
      liveObservation({
        short_positions: [{
          ...liveObservation().short_positions[0],
          priorCloseSource: 'unverified',
        }],
      }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_short_provenance_unverified',
    }));

    expect(() => requireLiveObservation(
      liveObservation({
        summary: {
          ...liveObservation().summary,
          'SettledCashByDate-Z': '20260727:0',
          FxCashBalance: 123,
        },
      }),
      ACCOUNT,
      { now: currentTime },
    )).toThrow(expect.objectContaining({
      code: 'interest_observation_ibukl_ladder_incomplete',
    }));
  });

  test('records distinct exact-account live MTD checkpoints independently of forecasts', () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    const snapshot = {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      accountId: ACCOUNT,
      fromCache: false,
      observedAt: '2026-07-27T21:00:00.000Z',
      socketVerifiedAt: '2026-07-27T21:00:00.000Z',
      cash: { netAccruedInterest: -326.79 },
    };

    expect(requireLiveBalanceInterestObservation(snapshot, ACCOUNT, {
      now: new Date('2026-07-27T21:00:01.000Z'),
    })).toMatchObject({
      account: ACCOUNT,
      sessionDate: '2026-07-27',
      liveAccruedCash: -326.79,
    });

    const first = harness.service.recordBalanceObservation(snapshot);
    harness.setNow('2026-07-27T21:00:16.000Z');
    const duplicate = harness.service.recordBalanceObservation({
      ...snapshot,
      observedAt: '2026-07-27T21:00:15.000Z',
      socketVerifiedAt: '2026-07-27T21:00:15.000Z',
    });
    harness.setNow('2026-07-27T21:00:31.000Z');
    const changed = harness.service.recordBalanceObservation({
      ...snapshot,
      observedAt: '2026-07-27T21:00:30.000Z',
      socketVerifiedAt: '2026-07-27T21:00:30.000Z',
      cash: { netAccruedInterest: -327.82 },
    });

    expect(first.appended).toBe(true);
    expect(duplicate.appended).toBe(false);
    expect(changed.appended).toBe(true);
    expect(harness.service.history()).toMatchObject({
      observations: [
        {
          sessionDate: '2026-07-27',
          observedAt: '2026-07-27T21:00:00.000Z',
          liveNetAccrued: -326.79,
          source: 'ibkr_live_portfolio_balance',
        },
        {
          sessionDate: '2026-07-27',
          observedAt: '2026-07-27T21:00:30.000Z',
          liveNetAccrued: -327.82,
          source: 'ibkr_live_portfolio_balance',
        },
      ],
    });
    expect(harness.service.recordBalanceObservation({
      ...snapshot,
      accountId: 'U00000000',
    })).toEqual({
      appended: false,
      reason: 'interest_balance_observation_account_mismatch',
    });
    expect(() => harness.service.recordBalanceObservation({
      ...snapshot,
      fromCache: true,
    })).toThrow(expect.objectContaining({
      code: 'interest_balance_observation_unverified',
    }));
  });

  test('refreshes unchanged live MTD evidence without duplicating the audit journal', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: false });
    const recordCount = harness.store.readRecords('observations').length;

    harness.setNow('2026-07-27T21:00:50.000Z');
    expect(harness.service.recordBalanceObservation({
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      accountId: ACCOUNT,
      fromCache: false,
      observedAt: '2026-07-27T21:00:50.000Z',
      socketVerifiedAt: '2026-07-27T21:00:50.000Z',
      cash: { netAccruedInterest: -326.79 },
    })).toEqual({
      appended: false,
      reason: 'interest_balance_observation_unchanged',
    });

    expect(harness.store.readRecords('observations')).toHaveLength(recordCount);
    expect(harness.service.getStatus().mtd).toMatchObject({
      liveNetAccrued: -326.79,
      liveNetAccruedStatus: 'live',
      liveNetAccruedObservedAt: '2026-07-27T21:00:50.000Z',
      liveNetAccruedSource: 'ibkr_live_portfolio_balance',
    });

    harness.setNow('2026-07-27T21:01:36.000Z');
    expect(harness.service.getStatus().mtd).toMatchObject({
      liveNetAccrued: null,
      liveNetAccruedStatus: 'unavailable',
      liveNetAccruedObservedAt: null,
      liveNetAccruedSource: null,
    });
  });

  test('async status retains current live evidence and rechecks freshness after the worker read', async () => {
    let release;
    const evidenceReader = {
      readStatus: jest.fn(() => new Promise(resolve => { release = resolve; })),
    };
    const harness = serviceHarness({ evidenceReader });
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: false });
    const evidence = harness.service.readStatusEvidence();
    const pending = harness.service.getStatusAsync();
    harness.setNow('2026-07-27T21:00:50.000Z');
    harness.service.recordBalanceObservation({
      available: true, status: 'live', source: 'ibkr_live_session', accountId: ACCOUNT,
      fromCache: false, observedAt: '2026-07-27T21:00:50.000Z',
      socketVerifiedAt: '2026-07-27T21:00:50.000Z', cash: { netAccruedInterest: -326.79 },
    });
    const expected = harness.service.getStatus();
    const readSummary = jest.spyOn(harness.store, 'readSummary');
    const readRecords = jest.spyOn(harness.store, 'readRecords');
    release(evidence);
    expect(await pending).toEqual(expected);
    expect(readSummary).not.toHaveBeenCalled();
    expect(readRecords).not.toHaveBeenCalled();
    expect(harness.flexService.status).toHaveBeenLastCalledWith({ includeStored: false });

    const later = harness.service.getStatusAsync();
    harness.setNow('2026-07-27T21:01:36.000Z');
    release(evidence);
    expect((await later).mtd).toMatchObject({
      liveNetAccrued: null, liveNetAccruedStatus: 'unavailable', liveNetAccruedObservedAt: null,
    });
  });

  test('an old worker row cannot replace a corrected parent reading at the same observation time', async () => {
    let release;
    const harness = serviceHarness({ evidenceReader: {
      readStatus: jest.fn(() => new Promise(resolve => { release = resolve; })),
    } });
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: false });
    const evidence = harness.service.readStatusEvidence();
    const pending = harness.service.getStatusAsync();
    harness.service.recordBalanceObservation({
      available: true, status: 'live', source: 'ibkr_live_session', accountId: ACCOUNT,
      fromCache: false, observedAt: '2026-07-27T21:00:00.000Z',
      socketVerifiedAt: '2026-07-27T21:00:00.000Z', cash: { netAccruedInterest: -327.82 },
    });
    release(evidence);
    expect((await pending).mtd.liveNetAccrued).toBe(-327.82);
    expect(harness.service.getStatus().mtd.liveNetAccrued).toBe(-327.82);
  });

  test('a late worker read error cannot overwrite a newer completed run state', async () => {
    let release;
    const harness = serviceHarness({ evidenceReader: {
      readStatus: jest.fn(() => new Promise(resolve => { release = resolve; })),
    } });
    cleanup.push(harness.dataDir);
    const failedRead = { ...harness.service.readStatusEvidence(), summary: null,
      summaryError: { code: 'interest_store_corrupt', message: 'Verified IBKR interest inputs are unavailable.' } };
    const pending = harness.service.getStatusAsync();
    await harness.service.run({ force: false });
    release(failedRead);
    expect((await pending).error.code).toBe('interest_store_corrupt');
    expect(harness.service.getStatus().error).toBeNull();
  });

  test('does not duplicate a legacy forecast-time checkpoint with the same date and value', () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    harness.store.appendRecord('observations', {
      identity: '2026-07-27|legacy-evidence-hash',
      source: 'ibkr_live_interest_observation',
      sessionDate: '2026-07-27',
      observedAt: '2026-07-27T20:59:59.000Z',
      socketVerifiedAt: '2026-07-27T20:59:58.000Z',
      liveAccruedCash: -326.79,
      verified: true,
    });

    expect(harness.service.recordBalanceObservation({
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      accountId: ACCOUNT,
      fromCache: false,
      observedAt: '2026-07-27T21:00:00.000Z',
      socketVerifiedAt: '2026-07-27T21:00:00.000Z',
      cash: { netAccruedInterest: -326.79 },
    })).toEqual({
      appended: false,
      reason: 'interest_balance_observation_unchanged',
    });
    expect(harness.store.readRecords('observations')).toHaveLength(1);
    expect(harness.service.history().observations).toEqual([
      expect.objectContaining({
        sessionDate: '2026-07-27',
        liveNetAccrued: -326.79,
        source: 'ibkr_live_interest_observation',
      }),
    ]);
  });

  test('accepts reconciled live event-contract accounting while keeping shorts stock-only', () => {
    const currentTime = new Date('2026-07-27T21:00:01.000Z');
    const mixed = liveObservation({
      summary: {
        ...liveObservation().summary,
        'TotalCashValue-C': 1000,
        'SettledCashByDate-C': '20260727:1000',
        'MaintMarginReq-C': 1490,
      },
      position_scope: {
        mode: 'stocks_and_event_contracts',
        allSupportedForBalance: true,
        allStock: false,
        allBaseCurrency: true,
        stockPositionCount: 1,
        eventPositionCount: 2,
        eventVenues: ['FORECASTX', 'KALSHI'],
      },
      event_position_evidence: [
        { conId: 11, quantity: 499.17, exchange: 'KALSHI', secType: 'OPT', currency: 'USD', multiplier: 1 },
        { conId: 12, quantity: 990.83, exchange: 'FORECASTX', secType: 'FOP', currency: 'USD', multiplier: 1 },
      ],
      event_accounting: {
        venues: ['FORECASTX', 'KALSHI'],
        positionCount: 2,
        marketValue: 1490,
        initialMargin: 1490,
        maintenanceMargin: 1490,
        availableFunds: 728,
        equityWithLoanValue: 1000,
        theoreticalAvailableFunds: 1000,
        availableFundsHoldback: 272,
        capacityContribution: 0,
        verification: 'ibkr_event_contract_commodity_segment_reconciled',
        accountValues: {
          'GrossPositionValue-C': 1490,
          'NetLiquidation-C': 2490,
          'TotalCashValue-C': 1000,
          'InitMarginReq-C': 1490,
          'MaintMarginReq-C': 1490,
          'AvailableFunds-C': 728,
          'EquityWithLoanValue-C': 1000,
        },
      },
    });

    expect(requireLiveObservation(mixed, ACCOUNT, { now: currentTime }))
      .toMatchObject({
        positionScope: 'stocks_and_event_contracts',
        eventVenues: ['FORECASTX', 'KALSHI'],
        eventMarketValue: 1490,
        kalshiMarketValue: 1490,
        commodityAvailableFunds: 728,
        commodityMaintenanceMargin: 1490,
        eventAccountingVerified: true,
        shortPositions: [{ symbol: 'SHORT' }],
      });

    expect(() => requireLiveObservation({
      ...mixed,
      event_position_evidence: mixed.event_position_evidence.map((row) => (
        row.exchange === 'KALSHI' ? { ...row, secType: 'FOP' } : row
      )),
    }, ACCOUNT, { now: currentTime })).toThrow(expect.objectContaining({
      code: 'interest_observation_event_accounting_unverified',
    }));
    expect(() => requireLiveObservation({
      ...mixed,
      event_position_evidence: mixed.event_position_evidence.map((row) => (
        row.exchange === 'FORECASTX' ? { ...row, secType: 'STK' } : row
      )),
    }, ACCOUNT, { now: currentTime })).toThrow(expect.objectContaining({
      code: 'interest_observation_event_accounting_unverified',
    }));

    const legacyKalshi = {
      ...mixed,
      position_scope: {
        ...mixed.position_scope,
        mode: 'stocks_and_kalshi',
        eventVenues: undefined,
      },
      event_position_evidence: mixed.event_position_evidence.map((row) => ({
        ...row,
        exchange: 'KALSHI',
        secType: 'OPT',
      })),
      event_accounting: {
        ...mixed.event_accounting,
        venues: undefined,
        venue: 'KALSHI',
        verification: 'ibkr_kalshi_commodity_segment_reconciled',
      },
    };
    expect(requireLiveObservation(legacyKalshi, ACCOUNT, { now: currentTime }))
      .toMatchObject({
        positionScope: 'stocks_and_event_contracts',
        eventVenues: ['KALSHI'],
        eventMarketValue: 1490,
      });

    expect(() => requireLiveObservation({
      ...mixed,
      event_accounting: {
        ...mixed.event_accounting,
        maintenanceMargin: 1489.98,
      },
    }, ACCOUNT, { now: currentTime })).toThrow(expect.objectContaining({
      code: 'interest_observation_event_accounting_unverified',
    }));
  });

  test('anchors a closed-day forecast to the current value date, not Friday', () => {
    const currentTime = new Date('2026-08-01T16:00:01.000Z');
    const closed = closedDayObservation({
      sessionDate: '2026-08-01',
      observedAt: '2026-08-01T16:00:00.000Z',
      accrualDays: 2,
    });

    expect(requireLiveObservation(closed, ACCOUNT, { now: currentTime }))
      .toMatchObject({
        sessionDate: '2026-08-01',
        basisSessionDate: '2026-07-31',
        cashAnchorDate: '2026-08-01',
        securitiesCash: 49000,
      });

    expect(() => requireLiveObservation({
      ...closed,
      forecast: {
        ...closed.forecast,
        cashAnchorDate: '2026-07-31',
      },
      market_calendar: {
        ...closed.market_calendar,
        cashAnchorDate: '2026-07-31',
      },
    }, ACCOUNT, { now: currentTime })).toThrow(expect.objectContaining({
      code: 'interest_observation_calendar_unverified',
    }));

    expect(() => requireLiveObservation({
      ...closed,
      summary: {
        ...closed.summary,
        'TotalCashValue-S': 50001,
      },
    }, ACCOUNT, { now: currentTime })).toThrow(expect.objectContaining({
      code: 'interest_observation_cash_ladder_unreconciled',
    }));
  });

  test('requests the rolling Flex window through the prior reporting date', async () => {
    expect(flexReportingRange({ date: '2026-08-08' })).toEqual({
      fromDate: '2026-06-24',
      toDate: '2026-08-07',
    });
    expect(flexReportingRange({ date: '2026-08-09' })).toEqual({
      fromDate: '2026-06-24',
      toDate: '2026-08-07',
    });
    expect(flexReportingRange({ date: '2026-08-10' })).toEqual({
      fromDate: '2026-06-24',
      toDate: '2026-08-07',
    });

    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    harness.setNow('2026-08-08T11:00:00.000Z');

    await harness.service.run({ force: false });

    expect(harness.flexService.sync).toHaveBeenCalledWith({
      fromDate: '2026-06-24',
      toDate: '2026-08-07',
    });
    expect(harness.sidecarRequestImpl).toHaveBeenCalledTimes(1);
  });

  test('derives decimal account-specific tiers and observed principal coverage', () => {
    const schedule = latestVerifiedTierSchedule(
      [flexSnapshot()],
      '2026-07-27',
    );
    expect(schedule).toEqual(expect.objectContaining({
      rateDate: '2026-07-26',
      observedPrincipalCoverage: 100000,
      tiers: [{
        label: 'I',
        upTo: null,
        annualRate: 0.0513,
      }],
    }));

    const subOnePercentSchedule = latestVerifiedTierSchedule(
      [flexSnapshot({
        tierDetails: [{
          currency: 'USD',
          interestType: 'Debit Interest',
          valueDate: '2026-07-26',
          tierBreak: 'I',
          securitiesPrincipal: -75000,
          commoditiesPrincipal: -25000,
          totalPrincipal: null,
          rate: 0.75,
          totalInterest: -2.08,
        }],
      })],
      '2026-07-27',
    );
    expect(subOnePercentSchedule).toEqual(expect.objectContaining({
      observedPrincipalCoverage: 100000,
      tiers: [{
        label: 'I',
        upTo: null,
        annualRate: 0.0075,
      }],
    }));
  });

  test('uses a current official Pro schedule provisionally only after stale Flex corroboration', async () => {
    const resolved = await resolveDebitRateEvidence({
      snapshots: [flexSnapshot({
        tierDetails: [{
          ...flexSnapshot().tierDetails[0],
          valueDate: '2026-07-12',
          rate: 5.12,
        }],
      })],
      sessionDate: '2026-08-10',
      fetchOfficialSchedule: async () => ({
        source: 'ibkr_official_margin_rates',
        url: 'https://www.interactivebrokers.com/en/trading/margin-rates.php',
        fetchedAt: '2026-08-10T21:00:00.000Z',
        scheduleHash: 'f'.repeat(64),
        plan: 'IBKR Pro',
        currency: 'USD',
        provisional: true,
        liteAnnualRate: 0.0613,
        tiers: [{ label: 'USD tier 1', upTo: null, annualRate: 0.0513 }],
      }),
    });

    expect(resolved).toMatchObject({
      provisional: true,
      tiers: [{ annualRate: 0.0513 }],
      rateEvidence: {
        source: 'ibkr_official_margin_rates',
        scheduleHash: 'f'.repeat(64),
        provisional: true,
        corroboratedBy: {
          rateDate: '2026-07-12',
          firstTierAnnualRate: 0.0512,
        },
      },
    });
  });

  test('does not turn an empty current-month Flex detail set into verified zero', () => {
    const summary = buildDerivedSummary({
      config: {
        timeZone: 'America/New_York',
        accountFingerprint: 'fingerprint',
        accountMasked: '••••9973',
        guardMode: 'graduated',
      },
      store: {
        readRecords: () => [],
      },
      flexSnapshots: [flexSnapshot({
        fromDate: '2026-06-24',
        toDate: '2026-08-07',
        fetchedAt: '2026-08-10T11:00:00.000Z',
        derived: { dailyDebitActuals: [], monthlyPaid: [] },
      })],
      generatedAt: '2026-08-10T21:00:00.000Z',
      lastRun: null,
      lastError: { code: 'interest_observation_provider_offline' },
      forecastError: { code: 'interest_observation_provider_offline' },
    });

    expect(summary.mtd).toMatchObject({
      status: 'awaiting',
      verifiedDebit: null,
      actualDayCount: 0,
      throughDate: null,
    });
    expect(summary.forecast.status).toBe('unavailable');
  });

  test('verifies an explicit zero debit row through the row coverage date', () => {
    const actual = {
      kind: 'daily',
      valueDate: '2026-08-07',
      fromDate: '2026-08-07',
      toDate: '2026-08-09',
      currency: 'USD',
      debitAmount: 0,
      accrualDays: 3,
      verified: true,
    };
    const summary = buildDerivedSummary({
      config: {
        timeZone: 'America/New_York',
        accountFingerprint: 'fingerprint',
        accountMasked: '••••9973',
        guardMode: 'graduated',
      },
      store: {
        readRecords: (kind) => (kind === 'actuals' ? [actual] : []),
      },
      flexSnapshots: [flexSnapshot({
        expectedAccountFingerprint: 'fingerprint',
        fromDate: '2026-06-24',
        toDate: '2026-08-10',
        fetchedAt: '2026-08-10T11:00:00.000Z',
        derived: {
          dailyDebitActuals: [{
            date: '2026-08-07',
            fromDate: '2026-08-07',
            toDate: '2026-08-09',
            currency: 'USD',
            totalInterest: 0,
            debitAmount: 0,
            accrualDays: 3,
            rowCount: 1,
          }],
          monthlyPaid: [],
        },
      })],
      generatedAt: '2026-08-10T21:00:00.000Z',
      lastRun: null,
      lastError: null,
    });

    expect(summary.mtd).toMatchObject({
      status: 'verified',
      verifiedDebit: 0,
      actualDayCount: 3,
      throughDate: '2026-08-09',
    });
  });

  test('separates verified posted stock borrow fees from margin interest', () => {
    const summary = buildStockBorrowFeeSummary({
      expectedAccountFingerprint: 'fingerprint',
      currentNyDate: '2026-08-10',
      flexSnapshots: [flexSnapshot({
        expectedAccountFingerprint: 'fingerprint',
        cashTransactionSectionPresent: true,
        cashTransactions: [{
          transactionId: 'borrow-1',
          date: '2026-08-05',
          currency: 'USD',
          type: 'Broker Interest Paid',
          amount: -405.83,
          description: 'USD BORROW FEES FOR JUL-2026',
        }],
        borrowFeeDetails: [],
        borrowFeeDetailsSectionPresent: false,
        derived: {
          dailyDebitActuals: [],
          monthlyPaid: [],
          stockBorrowFeePayments: [{
            month: '2026-07',
            currency: 'USD',
            amount: 405.83,
            transactionCount: 1,
            postedDates: ['2026-08-05'],
          }],
          dailyStockBorrowFees: [],
        },
      })],
    });

    expect(summary).toMatchObject({
      status: 'verified',
      daily: {
        status: 'awaiting',
        reason: 'flex_query_borrow_fee_details_not_configured',
      },
      aggregate: {
        status: 'verified',
        total: 405.83,
        periodFrom: '2026-06-13',
        periodTo: '2026-07-26',
        months: [{
          month: '2026-07',
          amount: 405.83,
        }],
      },
    });
  });

  test('publishes a daily stock borrow total only from verified fee-detail charges', () => {
    const summary = buildStockBorrowFeeSummary({
      expectedAccountFingerprint: 'fingerprint',
      currentNyDate: '2026-08-10',
      flexSnapshots: [flexSnapshot({
        expectedAccountFingerprint: 'fingerprint',
        borrowFeeDetailsSectionPresent: true,
        borrowFeeDetails: [
          {
            currency: 'USD',
            symbol: 'HARD',
            valueDate: '2026-08-07',
            totalCharges: 1.25,
          },
          {
            currency: 'USD',
            symbol: 'HARD2',
            valueDate: '2026-08-07',
            totalCharges: 0.75,
          },
        ],
        derived: {
          dailyDebitActuals: [],
          monthlyPaid: [],
          stockBorrowFeePayments: [],
          dailyStockBorrowFees: [{
            date: '2026-08-07',
            amount: 2,
            positionCount: 2,
            rowCount: 2,
          }],
        },
      })],
    });

    expect(summary.daily).toMatchObject({
      status: 'verified',
      valueDate: '2026-08-07',
      amount: 2,
      positionCount: 2,
      rowCount: 2,
    });
  });

  test('matches weekend forecasts only after all daily actuals or one verified bundled actual arrive', () => {
    const prediction = {
      identity: '2026-07-24',
      valueDate: '2026-07-24',
      coveredValueDates: ['2026-07-24', '2026-07-25', '2026-07-26'],
      accrualDays: 3,
      raw: 12,
      point: 12.5,
      issuedAt: '2026-07-24T21:00:00.000Z',
      prospective: true,
      verified: true,
    };
    const daily = (valueDate, debitAmount) => ({
      kind: 'daily',
      valueDate,
      debitAmount,
      accrualDays: 1,
      fetchedAt: '2026-07-27T11:00:00.000Z',
      verified: true,
    });

    expect(buildMatches([prediction], [
      daily('2026-07-24', 4.1),
    ])).toEqual([]);
    expect(buildMatches([prediction], [
      daily('2026-07-24', 4.1),
      daily('2026-07-25', 4.2),
      daily('2026-07-26', 4.3),
    ])).toEqual([
      expect.objectContaining({
        accrualDays: 3,
        actualInterest: 12.6,
      }),
    ]);
    expect(buildMatches([prediction], [{
      ...daily('2026-07-24', 12.55),
      accrualDays: 3,
    }])).toEqual([
      expect.objectContaining({
        actualInterest: 12.55,
      }),
    ]);
    expect(buildMatches([prediction], [{
      ...daily('2026-07-24', 12.55),
      accrualDays: 3,
      fetchedAt: '2026-07-24T20:00:00.000Z',
    }])).toEqual([]);
  });

  test('reconciles monthly broker interest only when the period totals match', () => {
    const reconciled = flexSnapshot({
      cashReports: [{
        currency: 'USD',
        brokerInterest: -134.75,
      }],
      derived: {
        dailyDebitActuals: [],
        monthlyPaid: [{
          month: '2026-07',
          currency: 'USD',
          paid: 143.25,
          received: 8.5,
          net: -134.75,
        }],
      },
    });
    expect(hasMonthlyReconciliation([reconciled])).toBe(true);
    expect(hasMonthlyReconciliation([{
      ...reconciled,
      cashReports: [{
        currency: 'USD',
        brokerInterest: -120,
      }],
    }])).toBe(false);
    expect(hasMonthlyReconciliation([{
      ...reconciled,
      cashTransactions: [
        {
          date: '2026-07-03',
          currency: 'USD',
          type: 'Broker Interest Paid',
          amount: -143.25,
          description: 'USD DEBIT INT FOR JUN-2026',
        },
        {
          date: '2026-07-10',
          currency: 'USD',
          type: 'Broker Interest Received',
          amount: 8.5,
          description: 'USD CREDIT INT FOR JUN-2026',
        },
        {
          date: '2026-07-10',
          currency: 'USD',
          type: 'Broker Interest Paid',
          amount: -294.87,
          description: 'USD BORROW FEES FOR JUN-2026',
        },
      ],
      cashReports: [{
        currency: 'USD',
        brokerInterest: -429.62,
      }],
    }])).toBe(true);
  });

  test('removes reported weekend days from the outstanding upper estimate', () => {
    const prediction = {
      identity: '2026-07-31',
      valueDate: '2026-07-31',
      basisSessionDate: '2026-07-31',
      cashAnchorDate: '2026-07-31',
      nextSessionDate: '2026-08-03',
      kind: 'completed_session_window',
      coveredValueDates: ['2026-07-31', '2026-08-01', '2026-08-02'],
      accrualDays: 3,
      upper: 10,
    };
    const actualByDate = new Map([[
      '2026-07-31',
      {
        kind: 'daily',
        valueDate: '2026-07-31',
        debitAmount: 3,
        accrualDays: 1,
      },
    ]]);
    expect(remainingPredictionUpper(prediction, actualByDate)).toBe(6.67);
  });

  test('carries a partially reported month-end weekend reserve across the boundary', () => {
    const dataDir = fs.mkdtempSync(path.join(
      os.tmpdir(),
      'ibkr-interest-month-boundary-',
    ));
    cleanup.push(dataDir);
    const store = createInterestValidationStore({ dataDir });
    store.appendRecord('predictions', {
      identity: '2026-07-31',
      valueDate: '2026-07-31',
      basisSessionDate: '2026-07-31',
      cashAnchorDate: '2026-07-31',
      nextSessionDate: '2026-08-03',
      kind: 'completed_session_window',
      issuedAt: '2026-07-31T21:00:00.000Z',
      prospective: true,
      verified: true,
      coveredValueDates: ['2026-07-31', '2026-08-01', '2026-08-02'],
      accrualDays: 3,
      raw: 8,
      point: 8,
      upper: 10,
    });
    store.appendRecord('actuals', {
      identity: 'daily|2026-07-31|report',
      kind: 'daily',
      valueDate: '2026-07-31',
      fromDate: '2026-07-31',
      toDate: '2026-07-31',
      debitAmount: 3,
      accrualDays: 1,
      fetchedAt: '2026-08-01T11:00:00.000Z',
      verified: true,
      provisional: true,
    });
    store.appendRecord('observations', {
      identity: '2026-07-31|evidence',
      sessionDate: '2026-07-31',
      liveAccruedCash: 0,
      verified: true,
    });

    const summary = buildDerivedSummary({
      config: {
        timeZone: 'America/New_York',
        accountFingerprint: 'fingerprint',
        accountMasked: '••••9973',
        guardMode: 'graduated',
      },
      store,
      flexSnapshots: [],
      generatedAt: '2026-08-01T16:00:00.000Z',
      lastRun: null,
      lastError: null,
    });

    expect(summary.guard).toEqual(expect.objectContaining({
      available: true,
      verifiedUnpaidDebit: 3,
      unreportedUpper: 6.67,
      modelOutstandingUpper: 9.67,
      appliedReserve: 9.67,
      liveNegativeAccrued: null,
      combinedReserve: null,
    }));
    expect(summary.forecast).toMatchObject({
      status: 'issued',
      valueDate: '2026-07-31',
      activeForDate: '2026-08-01',
      coveredValueDates: ['2026-07-31', '2026-08-01', '2026-08-02'],
      coverageFrom: '2026-07-31',
      coverageThrough: '2026-08-02',
      basisSessionDate: '2026-07-31',
      nextSessionDate: '2026-08-03',
      kind: 'completed_session_window',
      point: 8,
    });

    const mondaySummary = buildDerivedSummary({
      config: {
        timeZone: 'America/New_York',
        accountFingerprint: 'fingerprint',
        accountMasked: '••••9973',
        guardMode: 'graduated',
      },
      store,
      flexSnapshots: [],
      generatedAt: '2026-08-03T16:00:00.000Z',
      lastRun: null,
      lastError: null,
    });
    expect(mondaySummary.forecast).toMatchObject({
      status: 'awaiting',
      activeForDate: '2026-08-03',
      coveredValueDates: [],
      point: null,
    });
  });

  test('keeps stale live accrued cash out of the applied model reserve', () => {
    const records = {
      predictions: [{
        identity: '2026-07-27',
        valueDate: '2026-07-27',
        coveredValueDates: ['2026-07-27'],
        accrualDays: 1,
        upper: 5.7,
        prospective: true,
        verified: true,
      }],
      actuals: [],
      observations: [{
        identity: '2026-07-27|evidence',
        observedAt: '2026-07-27T21:00:00.000Z',
        liveAccruedCash: -326.79,
        verified: true,
      }],
    };
    const summary = buildDerivedSummary({
      config: {
        timeZone: 'America/New_York',
        accountFingerprint: 'fingerprint',
        accountMasked: '••••9973',
        guardMode: 'graduated',
      },
      store: {
        readRecords: (kind) => records[kind],
      },
      flexSnapshots: [],
      generatedAt: '2026-07-27T21:01:00.000Z',
      lastRun: null,
      lastError: null,
    });

    expect(summary.mtd.liveNetAccrued).toBeNull();
    expect(summary.guard).toEqual(expect.objectContaining({
      available: true,
      appliedReserve: 5.7,
      modelOutstandingUpper: 5.7,
      liveNegativeAccrued: null,
      combinedReserve: null,
    }));
  });

  test('issues an immutable provisional forecast and immediately applies its upper reserve', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);

    const status = await harness.service.run({ force: true });

    expect(harness.flexService.sync).toHaveBeenCalledTimes(1);
    expect(harness.sidecarRequestImpl).toHaveBeenCalledWith(
      `/portfolio/interest-observation?account=${ACCOUNT}`,
      { timeoutMs: 30000 },
    );
    expect(status).toMatchObject({
      available: true,
      status: 'provisional',
      modelStatus: 'provisional',
      actionable: false,
      accountMatched: true,
      capabilities: {
        ready: false,
        status: 'incomplete',
        missingSections: ['interestAccruals', 'cashTransactions', 'cashReport'],
      },
      latest: {
        valueDate: '2026-07-27',
        raw: 4.56,
        lower: 3.42,
        point: 4.56,
        upper: 5.7,
        actual: null,
      },
      mtd: {
        verifiedDebit: 3.5,
      },
      guard: {
        available: true,
        mode: 'graduated',
        appliedReserve: 9.2,
        modelOutstandingUpper: 9.2,
        liveNegativeAccrued: 326.79,
        combinedReserve: 326.79,
      },
    });

    await harness.service.run({ force: true });
    expect(harness.store.readRecords('predictions')).toHaveLength(1);
  });

  test('each validation run shares one exact validated Flex history across ingest, forecast and summary', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    const original = flexSnapshot();
    harness.setSnapshots([original]);
    // A newly published revision during the live observation belongs to the
    // next validation run, rather than changing this run's summary inputs.
    harness.sidecarRequestImpl.mockImplementationOnce(async () => {
      harness.setSnapshots([flexSnapshot({ reportHash: 'c'.repeat(64),
        fetchedAt: '2026-07-27T21:00:01.000Z', derived: { dailyDebitActuals: [{
          date: '2026-07-26', currency: 'USD', totalInterest: -7, debitAmount: 7, rowCount: 1,
        }], monthlyPaid: [] } })]);
      return liveObservation();
    });
    const first = await harness.service.run({ force: true });
    expect(harness.flexService.history).toHaveBeenCalledTimes(1);
    expect(first.mtd.verifiedDebit).toBe(3.5);
    expect(first.latest.valueDate).toBe('2026-07-27');
    const second = await harness.service.run({ force: false });
    expect(harness.flexService.history).toHaveBeenCalledTimes(2);
    expect(second.mtd.verifiedDebit).toBe(7);
    expect(harness.store.readRecords('predictions')).toHaveLength(1);
  });

  test('a failed fresh history read is not repeated within the run and is rechecked next run', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    const failure = Object.assign(new Error('Stored accounting evidence did not verify.'), {
      code: 'flex_interest_integrity_error',
    });
    harness.flexService.history.mockImplementationOnce(() => { throw failure; });
    await harness.service.run({ force: false });
    expect(harness.flexService.history).toHaveBeenCalledTimes(1);
    expect(harness.sidecarRequestImpl).not.toHaveBeenCalled();
    const recovered = await harness.service.run({ force: false });
    expect(harness.flexService.history).toHaveBeenCalledTimes(2);
    expect(recovered.mtd.verifiedDebit).toBe(3.5);
  });

  test('issues a Saturday remaining-window forecast and does not overlap it on Sunday', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    harness.setNow('2026-08-01T16:00:00.000Z');
    harness.sidecarRequestImpl.mockResolvedValue(closedDayObservation({
      sessionDate: '2026-08-01',
      observedAt: '2026-08-01T16:00:00.000Z',
      accrualDays: 2,
    }));

    const saturday = await harness.service.run({ force: false });
    expect(saturday.forecast).toMatchObject({
      status: 'issued',
      valueDate: '2026-08-01',
      activeForDate: '2026-08-01',
      coveredValueDates: ['2026-08-01', '2026-08-02'],
      coverageFrom: '2026-08-01',
      coverageThrough: '2026-08-02',
      basisSessionDate: '2026-07-31',
      cashAnchorDate: '2026-08-01',
      nextSessionDate: '2026-08-03',
      kind: 'closed_day_remaining_window',
      accrualDays: 2,
    });
    expect(harness.store.readRecords('predictions')).toHaveLength(1);

    harness.setNow('2026-08-02T16:00:00.000Z');
    const sunday = await harness.service.run({ force: false });
    expect(harness.sidecarRequestImpl).toHaveBeenCalledTimes(1);
    expect(harness.store.readRecords('predictions')).toHaveLength(1);
    expect(sunday.forecast).toMatchObject({
      valueDate: '2026-08-01',
      activeForDate: '2026-08-02',
      coveredValueDates: ['2026-08-01', '2026-08-02'],
    });
  });

  test('issues a verified numeric zero for a Sunday-only remaining window', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    harness.setNow('2026-08-02T16:00:00.000Z');
    harness.sidecarRequestImpl.mockResolvedValue({
      ...closedDayObservation({
        sessionDate: '2026-08-02',
        observedAt: '2026-08-02T16:00:00.000Z',
        accrualDays: 1,
        evidenceHash: 'e'.repeat(64),
      }),
      short_positions: [],
    });

    const status = await harness.service.run({ force: false });
    expect(status.forecast).toMatchObject({
      status: 'issued',
      valueDate: '2026-08-02',
      activeForDate: '2026-08-02',
      coveredValueDates: ['2026-08-02'],
      accrualDays: 1,
      point: 0,
    });
  });

  test('throttles failed weekend retries for fifteen minutes and records the miss', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    harness.setNow('2026-08-01T16:00:00.000Z');
    harness.sidecarRequestImpl.mockRejectedValue(Object.assign(
      new Error('provider offline'),
      { code: 'interest_observation_provider_offline' },
    ));

    await harness.service.run({ force: false });
    harness.setNow('2026-08-01T16:05:00.000Z');
    await harness.service.run({ force: false });
    expect(harness.sidecarRequestImpl).toHaveBeenCalledTimes(1);

    harness.setNow('2026-08-01T16:16:00.000Z');
    await harness.service.run({ force: false });
    expect(harness.sidecarRequestImpl).toHaveBeenCalledTimes(2);
    expect(harness.store.readRecords('misses')).toEqual([
      expect.objectContaining({
        sessionDate: '2026-08-01',
        reason: 'interest_observation_provider_offline',
      }),
    ]);
  });

  test('matches next-day actuals and updates learning calibration without rewriting forecast', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: true });
    const firstPrediction = harness.store.readRecords('predictions')[0];
    harness.setSnapshots([
      flexSnapshot({
        reportHash: 'd'.repeat(64),
        revisionHash: 'e'.repeat(64),
        fetchedAt: '2026-07-28T11:00:00.000Z',
        derived: {
          dailyDebitActuals: [
            {
              date: '2026-07-26',
              currency: 'USD',
              totalInterest: -3.5,
              debitAmount: 3.5,
              rowCount: 1,
            },
            {
              date: '2026-07-27',
              currency: 'USD',
              totalInterest: -4.7,
              debitAmount: 4.7,
              rowCount: 1,
            },
          ],
          monthlyPaid: [],
        },
      }),
    ]);
    harness.setNow('2026-07-28T11:00:00.000Z');

    const status = await harness.service.run({ force: false });
    const retainedPrediction = harness.store.readRecords('predictions')[0];

    expect(retainedPrediction.recordHash).toBe(firstPrediction.recordHash);
    expect(status.status).toBe('learning');
    expect(status.calibration.sampleCount).toBe(1);
    expect(status.latest.actual).toBe(4.7);
    expect(status.latest.residual).toBe(0.14);
  });

  test('publishes an explicit forecast miss and immediately downgrades the model', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: true });
    harness.setSnapshots([
      flexSnapshot({
        reportHash: 'd'.repeat(64),
        revisionHash: 'e'.repeat(64),
        fetchedAt: '2026-07-28T11:00:00.000Z',
        toDate: '2026-07-27',
        derived: {
          dailyDebitActuals: [
            ...flexSnapshot().derived.dailyDebitActuals,
            {
              date: '2026-07-27',
              currency: 'USD',
              totalInterest: -7,
              debitAmount: 7,
              rowCount: 1,
            },
          ],
          monthlyPaid: [],
        },
      }),
    ]);
    harness.setNow('2026-07-28T11:00:00.000Z');

    const status = await harness.service.run({ force: false });

    expect(status).toMatchObject({
      status: 'provisional',
      modelStatus: 'provisional',
      modelStatusReason: 'latest_verified_forecast_miss',
      actionable: false,
      comparison: {
        status: 'verified',
        outcome: 'miss',
        valueDate: '2026-07-27',
        forecastLower: 3.42,
        forecastPoint: 4.56,
        forecastUpper: 5.7,
        actual: 7,
        residual: 2.44,
      },
    });
  });

  test('checks Flex at the morning slots only until the forecast actual arrives', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: true });

    harness.setSnapshots([flexSnapshot({
      reportHash: 'd'.repeat(64),
      revisionHash: 'e'.repeat(64),
      fetchedAt: '2026-07-28T13:36:00.000Z',
      toDate: '2026-07-27',
      derived: {
        dailyDebitActuals: [
          ...flexSnapshot().derived.dailyDebitActuals,
          {
            date: '2026-07-27',
            currency: 'USD',
            totalInterest: -4.7,
            debitAmount: 4.7,
            rowCount: 1,
          },
        ],
        monthlyPaid: [],
      },
    })]);
    harness.setNow('2026-07-28T13:36:00.000Z');
    await harness.service.run({ force: false });
    expect(harness.flexService.sync).toHaveBeenCalledTimes(2);

    harness.setNow('2026-07-28T16:06:00.000Z');
    await harness.service.run({ force: false });
    expect(harness.flexService.sync).toHaveBeenCalledTimes(2);
    expect(harness.service.getStatus().comparison).toMatchObject({
      status: 'verified',
      forecastPoint: 4.56,
      actual: 4.7,
      residual: 0.14,
      verifiedAt: '2026-07-28T13:36:00.000Z',
    });
  });

  test('never publishes another account validation as actionable', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: true });

    const status = harness.service.getStatus({ account: 'U00000000' });
    expect(status.available).toBe(false);
    expect(status.accountMatched).toBe(false);
    expect(status.guard).toEqual(expect.objectContaining({
      available: false,
      appliedReserve: null,
    }));
  });

  test('keeps verified MTD and stored forecast evidence visible when a new forecast fails', async () => {
    const harness = serviceHarness();
    cleanup.push(harness.dataDir);
    await harness.service.run({ force: true });
    harness.setNow('2026-07-28T21:00:00.000Z');
    harness.sidecarRequestImpl.mockRejectedValueOnce(
      Object.assign(new Error('provider offline'), {
        code: 'interest_observation_provider_offline',
      }),
    );

    const failed = await harness.service.run({ force: true });
    expect(failed).toMatchObject({
      available: true,
      status: 'provisional',
      latest: {
        valueDate: '2026-07-27',
        point: 4.56,
      },
      mtd: {
        status: 'verified',
        verifiedDebit: 3.5,
        liveNetAccrued: null,
      },
      forecast: {
        status: 'unavailable',
      },
      guard: {
        available: true,
        appliedReserve: 9.2,
      },
      error: {
        code: 'interest_observation_provider_offline',
      },
    });
    const failedGeneratedAt = failed.generatedAt;

    harness.setNow('2026-08-15T21:00:00.000Z');
    const laterStatus = harness.service.getStatus();
    expect(laterStatus.generatedAt).toBe(failedGeneratedAt);
    expect(laterStatus.available).toBe(true);
    expect(laterStatus.mtd.verifiedDebit).toBe(3.5);
  });
});
