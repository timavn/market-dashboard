const { createUsdCorrelationService } = require('./usdCorrelationService.cjs');

function makeHistory(length = 500, multiplier = 1) {
  let close = 100;
  const rows = [{ date: '2025-01-01', close }];
  for (let index = 0; index < length; index += 1) {
    const value = (Math.sin(index / 9) * 0.008 + ((index % 7) - 3) * 0.0004) * multiplier;
    close *= Math.exp(value);
    rows.push({
      date: new Date(Date.UTC(2025, 0, index + 2)).toISOString().slice(0, 10),
      close,
    });
  }
  return rows;
}

describe('USD correlation provider service', () => {
  test('deduplicates concurrent requests and caches a current successful result', async () => {
    const fetchHistory = jest.fn(async (symbol) => makeHistory(500, symbol === 'SPX' ? -1 : 1));
    const service = createUsdCorrelationService({
      fetchHistory,
      now: () => new Date('2026-05-15T22:00:00Z'),
    });

    const [first, second] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
    const third = await service.getSnapshot();

    expect(fetchHistory).toHaveBeenCalledTimes(6);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.sourceStatus).toBe('current');
  });

  test('surfaces provider failures without producing data', async () => {
    const service = createUsdCorrelationService({
      fetchHistory: async (symbol) => {
        if (symbol === 'CRB') throw new Error('429 rate limited');
        return makeHistory();
      },
      now: () => new Date('2026-05-15T22:00:00Z'),
    });

    await expect(service.getSnapshot()).rejects.toMatchObject({
      code: 'USD_CORRELATION_PROVIDER_UNAVAILABLE',
    });
  });

  test('does not serve an expired cached result after a failed refresh', async () => {
    let currentTime = new Date('2026-05-15T22:00:00Z');
    let fail = false;
    const service = createUsdCorrelationService({
      fetchHistory: async () => {
        if (fail) throw new Error('timeout');
        return makeHistory();
      },
      now: () => currentTime,
      cacheTtlMs: 1000,
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({ sourceStatus: 'current' });
    currentTime = new Date(currentTime.getTime() + 1001);
    fail = true;
    await expect(service.getSnapshot()).rejects.toMatchObject({
      code: 'USD_CORRELATION_PROVIDER_UNAVAILABLE',
    });
  });
});
