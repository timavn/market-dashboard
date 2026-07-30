const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDerivedSummary,
  buildMatches,
  createIbkrInterestValidationService,
  hasMonthlyReconciliation,
  latestVerifiedTierSchedule,
  remainingPredictionUpper,
  requireLiveObservation,
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
      'SettledCashByDate-S': '20260727:50000',
      'SettledCashByDate-C': '20260727:0',
      'SettledCashByDate-Z': null,
      'TotalCashValue-Z': null,
      FxCashBalance: 0,
      'MaintMarginReq-C': 0,
      'AccruedCash-S': -326.79,
    },
    forecast: {
      eligible: true,
      sessionDate: '2026-07-27',
      nextSessionDate: '2026-07-28',
      accrualDays: 1,
      currentSessionCloseAt: '2026-07-27T20:00:00.000Z',
      currentSessionComplete: true,
      priorCompletedSessionDate: '2026-07-24',
      latestCompletedSessionDate: '2026-07-27',
      verification: 'ibkr_liquid_hours_and_broker_time',
    },
    market_calendar: {
      verifiedNyDate: '2026-07-27',
      currentSessionScheduled: true,
      currentSessionCloseAt: '2026-07-27T20:00:00.000Z',
      currentSessionComplete: true,
      priorCompletedSessionDate: '2026-07-24',
      latestCompletedSessionDate: '2026-07-27',
      nextSessionDate: '2026-07-28',
      liquidHours: '20260727:0930-1600;20260728:0930-1600',
      source: 'ibkr_contract_details_and_historical_schedule',
    },
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

function serviceHarness() {
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
  });

  test('removes reported weekend days from the outstanding upper estimate', () => {
    const prediction = {
      identity: '2026-07-31',
      valueDate: '2026-07-31',
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
      accountMatched: true,
      latest: {
        valueDate: '2026-07-27',
        raw: 4.56,
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

  test('keeps provider failures unavailable without refreshing stale timestamps', async () => {
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
      available: false,
      status: 'unavailable',
      latest: null,
      mtd: {
        verifiedDebit: null,
        liveNetAccrued: null,
      },
      guard: {
        available: false,
        appliedReserve: null,
      },
      error: {
        code: 'interest_observation_provider_offline',
      },
    });
    const failedGeneratedAt = failed.generatedAt;

    harness.setNow('2026-08-15T21:00:00.000Z');
    const laterStatus = harness.service.getStatus();
    expect(laterStatus.generatedAt).toBe(failedGeneratedAt);
    expect(laterStatus.available).toBe(false);
    expect(laterStatus.guard.appliedReserve).toBeNull();
  });
});
