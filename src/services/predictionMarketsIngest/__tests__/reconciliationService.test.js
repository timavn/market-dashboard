const {
  createCpiCatalogReconciler: createCatalogReconciler,
  isPremarketWindow,
} = require('../reconciliationService');

function successfulPromotion(releaseKey = 'KXCPIYOY#2026-07', count = 5) {
  return {
    atomic: true,
    promotedCurrent: true,
    releases: [releaseKey],
    contracts: count,
    retired: 0,
  };
}

function createCpiCatalogReconciler(options = {}) {
  return createCatalogReconciler({
    promoteCatalog: jest.fn(async (events, meta) => successfulPromotion(meta.releaseKey, events.length)),
    ...options,
  });
}

function release(month = '2026-07', sourceAsOf = '2026-07-20T18:00:00Z') {
  const code = month === '2026-08' ? 'AUG' : 'JUL';
  const name = month === '2026-08' ? 'August 2026' : 'July 2026';
  return {
    releaseKey: `KXCPIYOY#${month}`,
    releaseDate: month === '2026-08' ? '2026-09-11' : '2026-08-12',
    source: { asOf: sourceAsOf },
    scenarios: [
      { key: 'upside', value: 3.5 },
      { key: 'base', value: 3.4 },
      { key: 'downside', value: 3.3 },
    ],
    cpi: {
      releaseKey: `KXCPIYOY#${month}`,
      reportMonthId: month,
      forecastMonth: name,
      eventTicker: `KXCPIYOY-26${code}`,
      targetStrikes: [3.2, 3.3, 3.4, 3.5, 3.6],
    },
  };
}

function successfulDiscovery(overrides = {}) {
  const releaseKey = overrides.releaseKey || 'KXCPIYOY#2026-07';
  const targetStrikes = overrides.targetStrikes || [3.2, 3.3, 3.4, 3.5, 3.6];
  return {
    ok: true,
    discovered: targetStrikes.length,
    contracts_added: 1,
    contracts_total: targetStrikes.length,
    catalog_promotion: {
      type: 'catalog_candidate',
      status: 'candidate',
      atomic: false,
      releaseKey,
      authority: 'PredictionMarketCatalogV2',
      activeContracts: targetStrikes.length,
      retiredContracts: 2,
    },
    catalog_contracts: targetStrikes.map((strike, index) => ({
      conId: 7000 + index,
      api_raw_id: String(7000 + index),
      venue: 'ForecastEx',
      releaseKey,
      catalog_source: 'ibkr_contract_details',
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      lastTradeDateOrContractMonth: '20991231',
      strike,
      quote_side: index % 2 === 0 ? 'YES' : 'NO',
      tradable_in_ibkr: true,
    })),
    cpi_discovery: {
      releaseKey,
      targetStrikes,
      foundStrikes: targetStrikes,
      missingStrikes: [],
      discovered: targetStrikes.length,
    },
    catalog_qualification: {
      releaseKey,
      authoritative: true,
      qualifiedContracts: targetStrikes.length,
      freshDiscoveredContracts: targetStrikes.length,
      targetCoverageComplete: true,
      freshTargetCoverageComplete: true,
      missingStrikes: [],
      freshMissingStrikes: [],
      complete: true,
    },
    ...overrides,
  };
}

describe('server-owned CPI catalog reconciler', () => {
  test('manual reconciliation ignores historical UI release context', async () => {
    const discover = jest.fn().mockImplementation(async (body) => successfulDiscovery({
      releaseKey: body.cpi.releaseKey,
      targetStrikes: body.cpi.targetStrikes,
    }));
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover,
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({
      trigger: 'manual',
      requestedBody: {
        fair_probability: 0.44,
        cpi: { releaseKey: 'KXCPIYOY#2026-06', targetStrikes: [4.4] },
      },
    });

    expect(discover).toHaveBeenCalledWith({
      fair_probability: 0.44,
      cpi: expect.objectContaining({
        releaseKey: 'KXCPIYOY#2026-07',
        reportMonthId: '2026-07',
        targetStrikes: [3.2, 3.3, 3.4, 3.5, 3.6],
      }),
    });
    expect(result.outcome).toMatchObject({
      type: 'cpi_catalog_reconciliation',
      trigger: 'manual',
      status: 'succeeded',
      code: 'CATALOG_RECONCILED',
      atomicPromotion: true,
      releaseKey: 'KXCPIYOY#2026-07',
    });
  });

  test('startup reconciles immediately and installs the supervised poll', async () => {
    const scheduled = [];
    const cancelled = [];
    const timer = { unref: jest.fn() };
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery()),
      now: () => new Date('2026-07-21T17:00:00Z'),
      schedule: (callback, ms) => {
        scheduled.push({ callback, ms });
        return timer;
      },
      cancelSchedule: (value) => cancelled.push(value),
      logger: { warn: jest.fn() },
      env: {},
    });

    const outcome = await reconciler.start();

    expect(outcome).toMatchObject({ trigger: 'startup', status: 'succeeded' });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(5 * 60 * 1000);
    expect(timer.unref).toHaveBeenCalled();
    reconciler.stop();
    expect(cancelled).toEqual([timer]);
  });

  test('a nowcast/release fingerprint change triggers reconciliation', async () => {
    const releases = [release(), release('2026-08', '2026-08-20T18:00:00Z')];
    const loadCurrentRelease = jest.fn().mockImplementation(async () => releases.shift());
    const discover = jest.fn().mockImplementation(async (body) => successfulDiscovery({
      releaseKey: body.cpi.releaseKey,
      targetStrikes: body.cpi.targetStrikes,
    }));
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease,
      discover,
      now: () => new Date('2026-08-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    await reconciler.reconcile({ trigger: 'startup' });
    const outcome = await reconciler.poll();

    expect(outcome).toMatchObject({
      trigger: 'release_change',
      status: 'succeeded',
      releaseKey: 'KXCPIYOY#2026-08',
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  test('weekday New York premarket cadence reconciles without a release change', async () => {
    let clock = new Date('2026-07-20T07:00:00Z'); // Monday 3:00 a.m. ET
    const discover = jest.fn().mockResolvedValue(successfulDiscovery({ contracts_added: 0 }));
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover,
      now: () => clock,
      logger: { warn: jest.fn() },
      env: {},
    });
    await reconciler.reconcile({ trigger: 'startup' });
    clock = new Date('2026-07-20T12:00:00Z'); // Monday 8:00 a.m. ET

    const outcome = await reconciler.poll();

    expect(isPremarketWindow(clock)).toBe(true);
    expect(outcome).toMatchObject({ trigger: 'premarket', status: 'succeeded' });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  test('fails closed when the sidecar cannot prove a V2 catalog candidate', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue({ ok: true, contracts_total: 5 }),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_CANDIDATE_UNVERIFIED',
      atomicPromotion: false,
    });
  });

  test('preserves unsupported-or-not-entitled from authoritative discovery', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue({
        ok: false,
        status: 'unsupported_or_not_entitled',
        errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
        message: 'No supported/entitled ForecastEx CPI product.',
        contracts_total: 0,
        catalog_promotion: {
          type: 'catalog_candidate',
          status: 'not_promoted',
          atomic: false,
          releaseKey: 'KXCPIYOY#2026-07',
          authority: 'PredictionMarketCatalogV2',
        },
      }),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'UNSUPPORTED_OR_NOT_ENTITLED',
      atomicPromotion: false,
    });
  });

  test('does not claim success unless DynamoDB atomically promotes the release pointer', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery()),
      promoteCatalog: jest.fn().mockResolvedValue({
        atomic: true,
        promotedCurrent: false,
        releases: ['KXCPIYOY#2026-07'],
        contracts: 5,
      }),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_PROMOTION_UNVERIFIED',
      atomicPromotion: false,
    });
  });

  test('returns a typed failure when the V2 transaction is denied', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery()),
      promoteCatalog: jest.fn().mockRejectedValue(new Error('AccessDeniedException')),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_PERSISTENCE_FAILED',
      result: 'not_promoted',
      atomicPromotion: false,
    });
    expect(result.outcome.message).toContain('AccessDeniedException');
  });

  test('rejects retained rows when discovery found zero fresh authoritative contracts', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery({
        discovered: 0,
        catalog_qualification: {
          releaseKey: 'KXCPIYOY#2026-07',
          authoritative: true,
          qualifiedContracts: 5,
          freshDiscoveredContracts: 0,
          targetCoverageComplete: true,
          freshTargetCoverageComplete: false,
          missingStrikes: [],
          freshMissingStrikes: [3.2, 3.3, 3.4, 3.5, 3.6],
          complete: false,
        },
      })),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_ZERO_FRESH_DISCOVERIES',
      atomicPromotion: false,
      freshDiscoveredContracts: 0,
    });
  });

  test('rejects an atomic but incomplete target-strike catalog', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery({
        discovered: 4,
        cpi_discovery: {
          releaseKey: 'KXCPIYOY#2026-07',
          targetStrikes: [3.2, 3.3, 3.4, 3.5, 3.6],
          foundStrikes: [3.2, 3.3, 3.4, 3.5],
          missingStrikes: [3.6],
          discovered: 4,
        },
        catalog_qualification: {
          releaseKey: 'KXCPIYOY#2026-07',
          authoritative: true,
          qualifiedContracts: 4,
          freshDiscoveredContracts: 4,
          targetCoverageComplete: false,
          freshTargetCoverageComplete: false,
          missingStrikes: [3.6],
          freshMissingStrikes: [3.6],
          complete: false,
        },
      })),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_TARGET_COVERAGE_INCOMPLETE',
      targetCoverageComplete: false,
      missingStrikes: [3.6],
    });
  });

  test('does not let retained complete rows hide a partial fresh discovery', async () => {
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: jest.fn().mockResolvedValue(release()),
      discover: jest.fn().mockResolvedValue(successfulDiscovery({
        discovered: 1,
        catalog_qualification: {
          releaseKey: 'KXCPIYOY#2026-07',
          authoritative: true,
          qualifiedContracts: 5,
          freshDiscoveredContracts: 1,
          targetCoverageComplete: true,
          freshTargetCoverageComplete: false,
          missingStrikes: [],
          freshMissingStrikes: [3.3, 3.4, 3.5, 3.6],
          complete: false,
        },
      })),
      now: () => new Date('2026-07-21T17:00:00Z'),
      logger: { warn: jest.fn() },
      env: {},
    });

    const result = await reconciler.reconcile({ trigger: 'manual' });

    expect(result.outcome).toMatchObject({
      status: 'failed',
      code: 'CATALOG_TARGET_COVERAGE_INCOMPLETE',
      targetCoverageComplete: false,
      missingStrikes: [3.3, 3.4, 3.5, 3.6],
    });
  });
});
