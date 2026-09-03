import {
  assertDashboardResourceRegistryComplete,
  DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES,
  DASHBOARD_RESOURCE_CLASSIFICATIONS,
  DASHBOARD_RESOURCE_DEFINITIONS,
  projectPredictionMonitorReference,
  resolveDashboardResourceDefinition,
} from './dashboardResourceRegistry';

describe('dashboardResourceRegistry', () => {
  test('every refreshable navigation surface declares registered policies', () => {
    expect(assertDashboardResourceRegistryComplete()).toEqual([]);
    expect(Object.keys(DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES).length).toBeGreaterThan(5);
    Object.values(DASHBOARD_RESOURCE_DEFINITIONS).forEach((definition) => {
      expect(Object.values(DASHBOARD_RESOURCE_CLASSIFICATIONS)).toContain(
        definition.classification,
      );
      expect(definition.cacheKey).toBeTruthy();
      expect(definition.scopeKey).toBeTruthy();
      expect(definition.polling).toEqual(expect.any(Object));
      expect(definition.storage).toEqual(expect.any(Object));
      expect(definition.warmup).toEqual(expect.any(Object));
      expect(definition.validate).toEqual(expect.any(Function));
      expect(definition.freshnessSource).toEqual(expect.any(Function));
      if (definition.warmup.eligible) {
        expect(definition.warmup.providerPure).toBe(true);
        expect(definition.accountScoped).not.toBe(true);
        expect(definition.classification).not.toBe(
          DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
        );
        if (definition.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED) {
          expect(definition.referenceProjection).toEqual(expect.any(Function));
          expect(definition.validateReference).toEqual(expect.any(Function));
        }
      }
    });
  });

  test('resolves executable and informational policies without caller duplication', () => {
    const portfolio = resolveDashboardResourceDefinition('portfolio', { accountId: 'U1' });
    expect(portfolio).toMatchObject({
      resourceClass: 'executable-live',
      resourceKey: 'portfolio',
      scopeKey: 'U1',
      displayRole: 'executable',
      accountScoped: true,
      persistReferenceSnapshot: null,
    });

    const quotes = resolveDashboardResourceDefinition('market-quotes');
    expect(quotes).toMatchObject({
      resourceClass: 'informational-live',
      displayRole: 'informational',
      retainOnRefreshFailure: true,
      retainAfterExpiry: true,
      persistReferenceSnapshot: expect.objectContaining({
        key: 'market-dashboard.reference.multi-region-quotes.v1',
      }),
    });
  });

  test('canonicalizes fixed-market aliases to one monitor resource and persisted snapshot', () => {
    const goldAuto = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'gold', venue: 'auto', generationId: null,
    });
    const goldKalshi = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'gold', venue: 'kalshi', generationId: null,
    });
    const spxAuto = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'sp500', venue: 'auto', generationId: null,
    });
    const spxForecastEx = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'sp500', venue: 'forecastex', generationId: null,
    });
    const cpiAuto = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'cpi', venue: 'auto', generationId: null,
    });
    const cpiKalshi = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'cpi', venue: 'kalshi', generationId: null,
    });

    expect(goldAuto.scopeKey).toBe('gold|kalshi|default');
    expect(goldAuto.scopeKey).toBe(goldKalshi.scopeKey);
    expect(goldAuto.persistReferenceSnapshot.key).toBe(goldKalshi.persistReferenceSnapshot.key);
    expect(spxAuto.scopeKey).toBe('sp500|forecastex|default');
    expect(spxAuto.scopeKey).toBe(spxForecastEx.scopeKey);
    expect(spxAuto.persistReferenceSnapshot.key).toBe(spxForecastEx.persistReferenceSnapshot.key);
    expect(cpiAuto.scopeKey).toBe('cpi|kalshi|default');
    expect(cpiAuto.scopeKey).toBe(cpiKalshi.scopeKey);
    expect(cpiAuto.persistReferenceSnapshot.key).toBe(cpiKalshi.persistReferenceSnapshot.key);
    expect(goldAuto.reconcileIncoming).toEqual(expect.any(Function));

    const explicitGeneration = resolveDashboardResourceDefinition('prediction-monitor', {
      marketId: 'gold', venue: 'auto', generationId: 'KXGOLDD-26SEP02',
    });
    expect(explicitGeneration.scopeKey).not.toBe(goldAuto.scopeKey);
  });

  test('mixed prediction projection strips all executable fields', () => {
    const projection = projectPredictionMonitorReference({
      schemaVersion: 2,
      marketId: 'sp500',
      generatedAt: '2026-08-31T18:00:00.000Z',
      spot: { value: 6500, source: 'ibkr_live', executable: true },
      chart: { points: [{ time: 1, value: 6490 }] },
      chartReferences: { basis: { status: 'live', value: 6500 } },
      goldMarketReferences: [{ status: 'live', price: 3500, source: 'ibkr' }],
      contracts: {
        status: 'available',
        event: { ticker: 'FES-SEP', closeTime: '2026-09-01T20:00:00.000Z' },
        lines: [{
          ticker: 'FES-SEP-6500', threshold: 6500, yesBid: 0.48, yesAsk: 0.52,
          noBid: 0.47, noAsk: 0.53, yesDepth: 50, noDepth: 40,
        }],
      },
      venues: {
        forecastex: {
          id: 'forecastex',
          brokerRoutable: true,
          book: { lines: [{ yesBid: 0.48 }] },
          catalog: { lines: [{ ticker: 'FES-SEP-6500', threshold: 6500 }] },
        },
      },
      generationOptions: [{
        id: 'forecastex:FES-SEP', generationId: 'FES-SEP', venueId: 'forecastex',
        bookStatus: 'available', lines: [{ yesBid: 0.48 }],
      }],
      selectedGeneration: {
        id: 'forecastex:FES-SEP', generationId: 'FES-SEP', venueId: 'forecastex',
        bookStatus: 'available', lines: [{ yesBid: 0.48 }],
      },
      positions: [{ ticker: 'FES-SEP-6500', quantity: 2 }],
      sizing: { contracts: 10 },
      orders: [{ id: 'order-1' }],
      strategy: { status: 'available', eligibleVenueId: 'forecastex' },
    });

    expect(projection).toMatchObject({
      referenceOnly: true,
      executionAvailable: false,
      strategy: { status: 'unavailable', eligibleVenueId: null },
      spot: { executable: false, availability: 'delayed', displayOnly: true },
    });
    expect(projection.positions).toBeUndefined();
    expect(projection.sizing).toBeUndefined();
    expect(projection.orders).toBeUndefined();
    expect(projection.chartReferences).toBeUndefined();
    expect(projection.goldMarketReferences).toBeUndefined();
    expect(projection.contracts.lines[0]).toMatchObject({
      threshold: 6500,
      yesBid: null,
      yesAsk: null,
      noBid: null,
      noAsk: null,
      yesDepth: null,
      noDepth: null,
      executable: false,
    });
    expect(projection.venues.forecastex.book.lines).toEqual([]);
    expect(projection.venues.forecastex.brokerRoutable).toBe(false);
    expect(projection.generationOptions[0]).toMatchObject({
      generationId: 'FES-SEP',
      bookStatus: 'unavailable',
      executionAvailable: false,
    });
    expect(projection.generationOptions[0].lines).toBeUndefined();
    expect(projection.selectedGeneration.lines).toBeUndefined();
  });

  test('persists a verified chart as dated history without live overlays', () => {
    const projection = projectPredictionMonitorReference({
      schemaVersion: 2,
      marketId: 'gold',
      generatedAt: '2026-09-02T15:00:00.000Z',
      chart: {
        status: 'available',
        availability: 'current',
        source: 'pyth_historical_bars',
        expiresAt: '2026-09-02T15:01:00.000Z',
        latestAt: '2026-09-02T14:59:00.000Z',
        points: [
          { timestamp: Date.parse('2026-09-02T14:58:00.000Z'), value: 3500 },
          { timestamp: Date.parse('2026-09-02T14:59:00.000Z'), value: 3501, contractValue: 0.61 },
        ],
      },
      contracts: { lines: [] },
      venues: {},
      chartReferences: { contract: { status: 'live', points: [1, 2] } },
      goldMarketReferences: [{ status: 'live', price: 3501, source: 'ibkr' }],
    });

    expect(projection.chart).toMatchObject({
      status: 'historical',
      availability: 'historical',
      historicalThroughDate: '2026-09-02',
      executable: false,
    });
    expect(projection.chart.points).toEqual([
      { timestamp: Date.parse('2026-09-02T14:58:00.000Z'), value: 3500 },
      { timestamp: Date.parse('2026-09-02T14:59:00.000Z'), value: 3501 },
    ]);
    expect(projection.chart.expiresAt).toBeUndefined();
    expect(projection.chartReferences).toBeUndefined();
    expect(projection.goldMarketReferences).toBeUndefined();
  });

  test('persists current CPI research as a non-executable dated reference and removes its live book', () => {
    const releaseAt = '2099-09-11T12:30:00.000Z';
    const projection = projectPredictionMonitorReference({
      schemaVersion: 2,
      marketId: 'cpi',
      generatedAt: '2099-09-02T15:00:00.000Z',
      forecastComparison: {
        status: 'available',
        releaseKey: 'KXCPIYOY#2099-08',
        reportMonth: '2099-08',
        forecastMonth: 'August 2099',
        releaseAt,
        eventTicker: 'KXCPIYOY-99AUG',
        hedgeye: {
          status: 'available', reportMonth: '2099-08', baseValue: 2.6,
          scenarios: [
            { key: 'downside', label: 'Downside', value: 2.4 },
            { key: 'base', label: 'Base Case', value: 2.6 },
            { key: 'upside', label: 'Upside', value: 2.8 },
          ],
          source: 'hedgeye-inflation-nowcast', asOf: '2099-09-01T15:00:00.000Z',
        },
        clevelandFed: {
          status: 'available', reportMonth: '2099-08', value: 2.5,
          points: [{ timestamp: Date.parse('2099-09-01T15:00:00.000Z'), value: 2.5 }],
          source: 'cleveland_fed_inflation_nowcasting',
        },
        bls: {
          status: 'available', reportMonth: '2099-08', source: 'bls_public_data_api',
          latestFinal: { reportMonth: '2099-07', value: 2.7, source: 'bls_public_data_api' },
        },
      },
      ladderReference: {
        status: 'available', kind: 'hedgeye_base', label: 'HEDGEYE BASE',
        value: 2.6, reportMonth: '2099-08', source: 'hedgeye-inflation-nowcast',
        asOf: '2099-09-01T15:00:00.000Z', expiresAt: releaseAt,
        availability: 'dated', executable: false,
      },
      contracts: {
        status: 'available',
        event: { ticker: 'KXCPIYOY-99AUG', reportMonth: '2099-08', closeTime: '2099-09-11T12:29:00.000Z' },
        lines: [{
          ticker: 'KXCPIYOY-99AUG-T2.6', threshold: 2.6,
          yesBid: 0.48, yesAsk: 0.52, noBid: 0.47, noAsk: 0.53,
          directNative: true,
        }],
      },
      venues: {
        kalshi: {
          id: 'kalshi', brokerRoutable: false,
          catalog: { lines: [{ ticker: 'KXCPIYOY-99AUG-T2.6', threshold: 2.6 }] },
          book: { lines: [{ ticker: 'KXCPIYOY-99AUG-T2.6', yesBid: 0.48 }] },
        },
      },
      strategy: { status: 'unavailable', model: null, eligibleVenueId: null },
    });

    expect(projection.forecastComparison).toMatchObject({
      status: 'available', reportMonth: '2099-08', referenceOnly: true, executable: false,
      hedgeye: { baseValue: 2.6, executable: false },
      clevelandFed: { value: 2.5, executable: false },
      bls: { latestFinal: { reportMonth: '2099-07', value: 2.7 }, executable: false },
    });
    expect(projection.ladderReference).toMatchObject({
      kind: 'hedgeye_base', value: 2.6, referenceOnly: true, executable: false,
    });
    expect(projection.contracts.lines[0]).toMatchObject({
      yesBid: null, yesAsk: null, noBid: null, noAsk: null,
      directNative: false, executable: false,
    });
    expect(projection.venues.kalshi.book.lines).toEqual([]);
  });

  test('does not persist CPI comparison data after its release boundary', () => {
    const projection = projectPredictionMonitorReference({
      schemaVersion: 2,
      marketId: 'cpi',
      forecastComparison: {
        status: 'available', releaseKey: 'KXCPIYOY#2020-01', reportMonth: '2020-01',
        releaseAt: '2020-02-01T12:30:00.000Z',
      },
      ladderReference: {
        status: 'available', kind: 'hedgeye_base', value: 2.6,
        reportMonth: '2020-01', expiresAt: '2020-02-01T12:30:00.000Z',
      },
      contracts: { lines: [] },
      venues: {},
    });

    expect(projection.forecastComparison).toBeNull();
    expect(projection.ladderReference).toBeNull();
  });
});
