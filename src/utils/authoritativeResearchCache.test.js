const { createAsyncTtlCache } = require('./serverResponseCache.cjs');
const {
  cacheFailure,
  failClosedHealthFromCache,
  requireAuthoritativeCacheValue,
} = require('./authoritativeResearchCache.cjs');

describe('authoritative research cache policy', () => {
  test('accepts non-stale cache results', () => {
    expect(requireAuthoritativeCacheValue({
      status: 'hit',
      value: ['verified'],
    })).toEqual(['verified']);
    expect(cacheFailure({ status: 'miss', value: [] })).toBeNull();
  });

  test('rejects an expired last-good value after an authoritative refresh fails', async () => {
    let currentTime = 0;
    const cache = createAsyncTtlCache({ ttlMs: 100, now: () => currentTime });
    await cache.get('ledger', async () => ['verified']);
    currentTime = 101;
    const result = await cache.get('ledger', async () => {
      const error = new Error('AccessDenied');
      error.code = 'AccessDeniedException';
      throw error;
    });

    expect(result).toMatchObject({ status: 'stale', value: ['verified'] });
    expect(() => requireAuthoritativeCacheValue(result, {
      errorCode: 'RESEARCH_EVENT_LEDGER_CACHE_STALE',
      source: 'ResearchEventLedgerV2',
    })).toThrow(/stale cached value cannot be used/i);
  });

  test('turns a stale cached healthy heartbeat into explicit unhealthy evidence', () => {
    expect(failClosedHealthFromCache({
      status: 'stale',
      value: {
        status: 'healthy',
        healthy: true,
        verified: true,
        lastSuccessAt: '2026-07-26T17:45:00.000Z',
      },
      error: new Error('network unavailable'),
    })).toMatchObject({
      status: 'unhealthy',
      healthy: false,
      verified: false,
      errorCode: 'GMAIL_HEARTBEAT_CACHE_STALE',
      cacheStatus: 'stale',
      lastSuccessAt: '2026-07-26T17:45:00.000Z',
    });
  });
});
