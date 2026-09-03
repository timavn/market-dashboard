const {
  IBKR_CATALOG_VENUES,
  fetchCurrentIbkrPredictionSnapshot,
} = require('../providers/ibkrProvider');

describe('release-aware IBKR prediction snapshot', () => {
  test('loads the server-owned current release and authoritative operational catalog before refresh', async () => {
    const release = {
      releaseKey: 'KXCPIYOY#2026-08',
      cpi: { releaseKey: 'KXCPIYOY#2026-08', targetStrikes: [2.8, 2.9, 3.0] },
    };
    const contracts = [{ conId: 123, venue: 'ForecastEx' }];
    const getCurrentCpiRelease = jest.fn().mockResolvedValue(release);
    const loadOperationalCatalogByRelease = jest.fn().mockResolvedValue(contracts);
    const fetchIBKREvents = jest.fn().mockResolvedValue([{ conId: 123 }]);

    const result = await fetchCurrentIbkrPredictionSnapshot({
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      getCurrentCpiRelease,
      loadOperationalCatalogByRelease,
      fetchIBKREvents,
      getProviderStatus: () => ({ ibkr: { status: 'connected' } }),
    });

    expect(loadOperationalCatalogByRelease).toHaveBeenCalledWith(release.releaseKey, {
      venues: IBKR_CATALOG_VENUES,
      requireCurrent: true,
    });
    expect(fetchIBKREvents).toHaveBeenCalledWith({ cpi: release.cpi, catalogContracts: contracts });
    expect(result).toMatchObject({
      release,
      provider: { status: 'connected' },
      events: [{ conId: 123 }],
    });
  });

  test('preserves catalog promotion and entitlement failures instead of relabeling them', async () => {
    const notPromoted = Object.assign(new Error('Active catalog generation is missing'), {
      code: 'CATALOG_NOT_PROMOTED',
    });
    const catalogFailure = await fetchCurrentIbkrPredictionSnapshot({
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      getCurrentCpiRelease: jest.fn().mockResolvedValue({
        releaseKey: 'KXCPIYOY#2026-08',
        cpi: { releaseKey: 'KXCPIYOY#2026-08' },
      }),
      loadOperationalCatalogByRelease: jest.fn().mockRejectedValue(notPromoted),
      fetchIBKREvents: jest.fn(),
    });
    expect(catalogFailure).toMatchObject({
      events: [],
      provider: {
        status: 'catalog_unavailable',
        errorCode: 'CATALOG_NOT_PROMOTED',
      },
    });

    const entitlementFailure = await fetchCurrentIbkrPredictionSnapshot({
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      getCurrentCpiRelease: jest.fn().mockResolvedValue({
        releaseKey: 'KXCPIYOY#2026-08',
        cpi: { releaseKey: 'KXCPIYOY#2026-08' },
      }),
      loadOperationalCatalogByRelease: jest.fn().mockResolvedValue([{ conId: 123 }]),
      fetchIBKREvents: jest.fn().mockResolvedValue([]),
      getProviderStatus: () => ({
        ibkr: {
          status: 'unsupported_or_not_entitled',
          errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
        },
      }),
    });
    expect(entitlementFailure.provider).toMatchObject({
      status: 'unsupported_or_not_entitled',
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
    });
  });

  test('forwards an on-demand snapshot and retry request for every promoted contract', async () => {
    const release = {
      releaseKey: 'KXCPIYOY#2026-08',
      cpi: { releaseKey: 'KXCPIYOY#2026-08' },
    };
    const contracts = [{ conId: 456, venue: 'ForecastEx' }];
    const fetchIBKREvents = jest.fn().mockResolvedValue([{ conId: 456 }]);

    await fetchCurrentIbkrPredictionSnapshot({
      forceRefresh: true,
      retryMissing: true,
      checkGatewayHealth: jest.fn().mockResolvedValue({ ok: true, authenticated: true }),
      getCurrentCpiRelease: jest.fn().mockResolvedValue(release),
      loadOperationalCatalogByRelease: jest.fn().mockResolvedValue(contracts),
      fetchIBKREvents,
      getProviderStatus: () => ({ ibkr: { status: 'connected' } }),
    });

    expect(fetchIBKREvents).toHaveBeenCalledWith({
      cpi: release.cpi,
      catalogContracts: contracts,
      forceRefresh: true,
      retryMissing: true,
    });
  });
});
