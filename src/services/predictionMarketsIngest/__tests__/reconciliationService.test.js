const {
  createCpiCatalogReconciler: createCatalogReconciler,
  isPremarketWindow,
} = require('../reconciliationService');
const { CPIY_RULES_URL } = require('../../predictionMarketTest/cpiForecastExReviewService.cjs');

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
    loadOfficialCatalog: jest.fn(async (currentRelease) => officialCatalog(currentRelease, options.now())),
    ...options,
  });
}

function release(month = '2026-07', sourceAsOf = '2026-07-20T18:00:00Z') {
  const code = month === '2026-08' ? 'AUG' : 'JUL';
  const name = month === '2026-08' ? 'August 2026' : 'July 2026';
  const releaseDate = month === '2026-08' ? '2026-09-11' : '2026-08-12';
  const releaseAt = `${releaseDate}T12:30:00.000Z`;
  return {
    releaseKey: `KXCPIYOY#${month}`,
    releaseDate,
    releaseAt,
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
      releaseAt,
      targetStrikes: [3.2, 3.3, 3.4, 3.5, 3.6],
    },
  };
}

function officialCatalog(currentRelease, at, strikes = currentRelease.cpi.targetStrikes) {
  const month = currentRelease.cpi.reportMonthId;
  return {
    provider: 'forecastex_public_contracts',
    productId: 'CPIY',
    fetchedAt: new Date(at).toISOString(),
    lines: strikes.map((strike) => ({
      contractId: `CPIY_${month.slice(5, 7)}${month.slice(2, 4)}_${strike}`,
      productId: 'CPIY',
      strike,
      question: `Will the year-over-year change in the US Consumer Price Index exceed ${strike}% in ${currentRelease.cpi.forecastMonth}?`,
      rulesUrl: CPIY_RULES_URL,
      lastTradeDate: currentRelease.releaseAt,
      expirationDate: currentRelease.releaseAt,
      payoutDate: currentRelease.releaseAt,
    })),
  };
}

function successfulDiscovery(overrides = {}) {
  const releaseKey = overrides.releaseKey || 'KXCPIYOY#2026-07';
  const targetStrikes = overrides.targetStrikes || [3.2, 3.3, 3.4, 3.5, 3.6];
  const currentRelease = release(releaseKey.split('#')[1]);
  const month = currentRelease.cpi.reportMonthId;
  const contractCount = targetStrikes.length * 2;
  return {
    ok: true,
    discovered: contractCount,
    contracts_added: 1,
    contracts_total: contractCount,
    catalog_promotion: {
      type: 'catalog_candidate',
      status: 'candidate',
      atomic: false,
      releaseKey,
      authority: 'PredictionMarketCatalogV2',
      activeContracts: contractCount,
      retiredContracts: 2,
    },
    catalog_contracts: targetStrikes.flatMap((strike, index) => ['YES', 'NO'].map((side, sideIndex) => ({
      conId: 7000 + index * 2 + sideIndex,
      api_raw_id: String(7000 + index * 2 + sideIndex),
      venue: 'ForecastEx',
      releaseKey,
      catalog_source: 'ibkr_contract_details',
      exchange: 'FORECASTX',
      symbol: 'CPIY',
      tradingClass: 'CPIY',
      secType: 'OPT',
      right: side === 'YES' ? 'C' : 'P',
      localSymbol: `CPIY_${month.slice(5, 7)}${month.slice(2, 4)}_${strike}_${side}`,
      lastTradeDateOrContractMonth: currentRelease.releaseDate.replaceAll('-', ''),
      strike,
      quote_side: side,
      tradable_in_ibkr: true,
    }))),
    cpi_discovery: {
      releaseKey,
      targetStrikes,
      foundStrikes: targetStrikes,
      missingStrikes: [],
      discovered: contractCount,
    },
    catalog_qualification: {
      releaseKey,
      authoritative: true,
      qualifiedContracts: contractCount,
      freshDiscoveredContracts: contractCount,
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
  test('discovers published strikes instead of scenario targets and retains the original fingerprint', async () => {
    const at = new Date('2026-07-21T17:00:00Z');
    const currentRelease = release();
    const original = JSON.parse(JSON.stringify(currentRelease));
    const publishedStrikes = [2.7, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4, 4.2, 4.4, 4.5, 4.6];
    const catalog = officialCatalog(currentRelease, at, publishedStrikes);
    const discover = jest.fn(async (body) => successfulDiscovery({ targetStrikes: body.cpi.targetStrikes }));
    const promoteCatalog = jest.fn(async (events, meta) => successfulPromotion(meta.releaseKey, events.length));
    const loadOfficialCatalog = jest.fn(async () => catalog);
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: async () => currentRelease, loadOfficialCatalog, discover, promoteCatalog,
      now: () => at, env: {},
    });

    const result = await reconciler.reconcile();

    expect(result.outcome).toMatchObject({ status: 'succeeded', persistedContracts: 24, missingStrikes: [] });
    expect(result.currentRelease).toBe(currentRelease);
    expect(currentRelease).toEqual(original);
    expect(JSON.parse(result.outcome.releaseFingerprint).targetStrikes).toEqual(original.cpi.targetStrikes);
    expect(discover).toHaveBeenCalledWith({ cpi: expect.objectContaining({ targetStrikes: publishedStrikes }) });
    expect(loadOfficialCatalog).toHaveBeenCalledWith(currentRelease);
    const promoted = promoteCatalog.mock.calls[0][0];
    expect(promoted).toHaveLength(24);
    for (const [index, candidate] of promoted.entries()) {
      const official = catalog.lines[Math.floor(index / 2)];
      expect(candidate).toMatchObject({
        conId: 7000 + index, api_raw_id: String(7000 + index),
        publicContractId: official.contractId, contractId: official.contractId,
        productCode: 'CPIY', reportMonthId: '2026-07', rulesUrl: CPIY_RULES_URL,
        close_time: currentRelease.releaseAt, expiration_time: currentRelease.releaseAt,
        question: official.question,
      });
      expect(candidate).not.toHaveProperty('native_bid');
      expect(candidate).not.toHaveProperty('native_ask');
    }
    expect(await reconciler.poll()).toMatchObject({ status: 'skipped', code: 'CATALOG_RECONCILE_NOT_DUE' });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['wrong release', (catalog) => { catalog.lines.forEach((line) => { line.contractId = line.contractId.replace('0726', '0826'); }); }],
    ['wrong product', (catalog) => { catalog.lines[0].productId = 'CPIM'; }],
    ['wrong terms', (catalog) => { catalog.lines[0].rulesUrl = 'https://example.com/terms'; }],
    ['wrong release time', (catalog) => { catalog.lines[0].lastTradeDate = '2026-08-12T13:30:00Z'; }],
    ['wrong threshold', (catalog) => { catalog.lines[0].strike = 3.9; }],
    ['duplicate threshold', (catalog) => { catalog.lines.push({ ...catalog.lines[0] }); }],
    ['stale', (catalog) => { catalog.fetchedAt = '2026-07-20T17:00:00Z'; }],
    ['cache only', (catalog) => { catalog.cacheOnly = true; }],
    ['offline', (catalog) => { catalog.connected = false; }],
    ['mock', (catalog) => { catalog.lines[0].mock = true; }],
    ['seed', (catalog) => { catalog.seeded = true; }],
  ])('rejects %s public inventory before native discovery', async (_label, mutate) => {
    const at = new Date('2026-07-21T17:00:00Z');
    const currentRelease = release();
    const catalog = officialCatalog(currentRelease, at);
    mutate(catalog);
    const discover = jest.fn(async () => successfulDiscovery());
    const promoteCatalog = jest.fn();
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: async () => currentRelease, loadOfficialCatalog: async () => catalog,
      discover, promoteCatalog, now: () => at, env: {},
    });

    const result = await reconciler.reconcile();

    expect(result.outcome).toMatchObject({ status: 'failed', code: 'CATALOG_OFFICIAL_INVENTORY_UNVERIFIED', atomicPromotion: false });
    expect(promoteCatalog).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  test.each([
    ['unpublished strike', (rows) => { rows[0].strike = 3.9; rows[0].localSymbol = 'CPIY_0726_3.9_YES'; }],
    ['local symbol month', (rows) => { rows[0].localSymbol = 'CPIY_0826_3.2_YES'; }],
    ['local symbol strike', (rows) => { rows[0].localSymbol = 'CPIY_0726_3.3_YES'; }],
    ['local symbol side', (rows) => { rows[0].localSymbol = 'CPIY_0726_3.2_NO'; }],
    ['symbol', (rows) => { rows[0].symbol = 'CPIM'; }],
    ['trading class', (rows) => { rows[0].tradingClass = 'CPIM'; }],
    ['security type', (rows) => { rows[0].secType = 'FOP'; }],
    ['exchange', (rows) => { rows[0].exchange = 'CME'; }],
    ['right', (rows) => { rows[0].right = 'P'; }],
    ['expiry', (rows) => { rows[0].lastTradeDateOrContractMonth = '20260813'; }],
    ['close time', (rows) => { rows[0].close_time = '2026-08-12T13:30:00Z'; }],
    ['public ID', (rows) => { rows[0].publicContractId = 'CPIY_0726_9'; }],
    ['native ID alias', (rows) => { rows[0].api_raw_id = '9900'; }],
    ['duplicate native ID', (rows) => { rows[1].conId = rows[0].conId; rows[1].api_raw_id = rows[0].api_raw_id; }],
    ['duplicate side', (rows) => { rows.push({ ...rows[0], conId: 9900, api_raw_id: '9900' }); }],
    ['missing native side', (rows) => { rows.splice(1, 1); }],
  ])('rejects broker %s mismatch before promotion', async (_label, mutate) => {
    const discovery = successfulDiscovery();
    mutate(discovery.catalog_contracts);
    const promoteCatalog = jest.fn();
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: async () => release(), discover: async () => discovery, promoteCatalog,
      now: () => new Date('2026-07-21T17:00:00Z'), env: {},
    });

    const result = await reconciler.reconcile();

    expect(result.outcome).toMatchObject({ status: 'failed', code: 'CATALOG_CANDIDATE_INVALID', atomicPromotion: false });
    expect(promoteCatalog).not.toHaveBeenCalled();
  });

  test.each([
    ['ages out', '2026-07-21T17:00:00Z', 61_000],
    ['crosses the release cutoff', '2026-08-12T12:29:59Z', 2_000],
  ])('rejects official inventory that %s during discovery', async (_label, startedAt, elapsedMs) => {
    let clock = new Date(startedAt);
    const promoteCatalog = jest.fn();
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease: async () => release(),
      discover: async () => { clock = new Date(clock.getTime() + elapsedMs); return successfulDiscovery(); },
      promoteCatalog, now: () => clock, env: {},
    });

    const result = await reconciler.reconcile();

    expect(result.outcome).toMatchObject({ status: 'failed', code: 'CATALOG_CANDIDATE_INVALID', atomicPromotion: false });
    expect(result.outcome.message).toContain('official_inventory_expired');
    expect(promoteCatalog).not.toHaveBeenCalled();
  });

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
    let clock = new Date('2026-07-21T17:00:00Z');
    const releases = [release(), release('2026-08', '2026-08-20T18:00:00Z')];
    const loadCurrentRelease = jest.fn().mockImplementation(async () => releases.shift());
    const discover = jest.fn().mockImplementation(async (body) => successfulDiscovery({
      releaseKey: body.cpi.releaseKey,
      targetStrikes: body.cpi.targetStrikes,
    }));
    const reconciler = createCpiCatalogReconciler({
      loadCurrentRelease,
      discover,
      now: () => clock,
      logger: { warn: jest.fn() },
      env: {},
    });

    await reconciler.reconcile({ trigger: 'startup' });
    clock = new Date('2026-08-21T17:00:00Z');
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
