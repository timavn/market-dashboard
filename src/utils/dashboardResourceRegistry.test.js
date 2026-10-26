import {
  assertDashboardResourceRegistryComplete,
  DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES,
  DASHBOARD_RESOURCE_CLASSIFICATIONS,
  DASHBOARD_RESOURCE_DEFINITIONS,
  resolveDashboardResourceDefinition,
} from './dashboardResourceRegistry';


describe('dashboardResourceRegistry', () => {
  test('volume does not hydrate old persisted reports or retain failed refreshes', () => {
    const volume = resolveDashboardResourceDefinition('market-volume');
    expect(volume).toMatchObject({
      resourceKey: 'market-share-volume-v2',
      retainOnRefreshFailure: false,
      retainAfterExpiry: false,
      persistReferenceSnapshot: null,
    });
    expect(volume.validate({ asOf: '2026-03-18', totalMarket: [], totalExchange: [] })).toBeNull();
  });

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

    });
  });

  test.each(Object.entries(DASHBOARD_RESOURCE_DEFINITIONS).filter(([, definition]) => definition.warmup.eligible))(
    'warmup for %s is provider-pure and never restores executable or account data', (_key, definition) => {
      expect(definition.warmup.providerPure).toBe(true);
      expect(definition.accountScoped).not.toBe(true);
      expect(definition.classification).not.toBe(DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE);
    },
  );

  test('mixed warmups validate a reference-only projection', () => {
    Object.values(DASHBOARD_RESOURCE_DEFINITIONS)
      .filter((definition) => definition.warmup.eligible
        && definition.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED)
      .forEach((definition) => {
        expect(definition.referenceProjection).toEqual(expect.any(Function));
        expect(definition.validateReference).toEqual(expect.any(Function));
      });
  });

  test('retired prediction-market resources are no longer registered', () => {
    ['prediction-monitor', 'prediction-nav', 'wti-workbench', 'gold-correlations', 'momo-tracker']
      .forEach((id) => expect(DASHBOARD_RESOURCE_DEFINITIONS).not.toHaveProperty(id));
    expect(DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES).not.toHaveProperty('predictionMonitor');
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
      persistReferenceSnapshot: { key: 'market-dashboard.reference.multi-region-quotes.v1' },
    });
  });

  test.each(['market-quotes', 'market-period-returns'])(
    '%s persists merged observations without an age-based deletion deadline', (id) => {
      const resource = resolveDashboardResourceDefinition(id);
      expect(resource).toMatchObject({
        retainOnRefreshFailure: true,
        retainAfterExpiry: true,
        persistReferenceSnapshot: { ttlMs: Number.MAX_SAFE_INTEGER },
        reconcileIncoming: expect.any(Function),
      });
    },
  );
});
