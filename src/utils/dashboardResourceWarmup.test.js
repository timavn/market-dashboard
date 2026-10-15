import { warmDashboardResource, resolveDashboardWarmupConfig } from './dashboardResourceWarmup';
import { resetSessionResourceStore } from './sessionResourceStore';

describe('dashboardResourceWarmup', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
  });

  afterEach(() => resetSessionResourceStore());

  test('deduplicates an eligible provider-pure resource through the shared store', async () => {
    let resolveRequest;
    const fetcher = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const first = warmDashboardResource('etf-pro', {}, { fetcher });
    const second = warmDashboardResource('etf-pro', {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveRequest({ rows: [], generatedAt: '2026-08-31T18:00:00.000Z' });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  test('deduplicates Gold auto and Kalshi warmups through the canonical monitor identity', async () => {
    let resolveRequest;
    const fetcher = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const first = warmDashboardResource('prediction-monitor', {
      marketId: 'gold', venue: 'auto', generationId: null,
    }, { fetcher });
    const second = warmDashboardResource('prediction-monitor', {
      marketId: 'gold', venue: 'kalshi', generationId: null,
    }, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveRequest({
      schemaVersion: 2,
      marketId: 'gold',
      generatedAt: new Date().toISOString(),
      venues: {},
      contracts: { status: 'unavailable', lines: [] },
      chart: null,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  test('rejects executable, forced, and provider-starting work', () => {
    expect(() => resolveDashboardWarmupConfig('portfolio', { accountId: 'U1' }, {
      fetcher: jest.fn(),
    })).toThrow(/not safe to warm/i);
    expect(() => resolveDashboardWarmupConfig('securities', {}, {
      fetcher: jest.fn(),
    })).toThrow(/not safe to warm/i);
    expect(() => resolveDashboardWarmupConfig('etf-pro', {}, {
      fetcher: jest.fn(),
      forceRefresh: true,
    })).toThrow(/forced\/provider warmup/i);
    expect(() => resolveDashboardWarmupConfig('etf-pro', {}, {
      fetcher: jest.fn(),
      startsProviderWork: true,
    })).toThrow(/forced\/provider warmup/i);
  });
});
