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

    expect(fetchHistory).toHaveBeenCalledTimes(14);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.sourceStatus).toBe('current');
    expect(first.fxvlSnapshot).toBeNull();
    expect(first.correlations.SILVER).toEqual(expect.objectContaining({ '30D': 1 }));
    expect(first.correlations.UST10Y).toEqual(expect.objectContaining({ '30D': 1, '180D': 1 }));
    expect(first.correlations.COPPER).toEqual(expect.objectContaining({ '30D': 1, '180D': 1 }));
    expect(first.assetContext.silverRealizedVolatility).toMatchObject({
      status: 'historical', window: 21, annualized: true, decisionEligible: false,
    });
    expect(first.assetContext.brentWtiSpread).toMatchObject({
      status: 'historical', value: 0, decisionEligible: false,
    });
  });

  test.each(['SILVER', 'UST10Y', 'COPPER'])('keeps the matrix available when %s history is offline', async (missingSymbol) => {
    const service = createUsdCorrelationService({
      fetchHistory: async (symbol) => {
        if (symbol === missingSymbol) throw new Error('provider offline');
        return makeHistory();
      },
      now: () => new Date('2026-05-15T22:00:00Z'),
      logger: { warn: jest.fn() },
    });
    const snapshot = await service.getSnapshot();
    expect(snapshot.sourceStatus).toBe('current');
    expect(snapshot.correlations.SPX).toBeDefined();
    expect(snapshot.correlations[missingSymbol]).toBeUndefined();
    expect(snapshot.rollingStats[missingSymbol]).toBeUndefined();
  });

  test('keeps required correlations current but leaves Silver context blank when optional history fails', async () => {
    const logger = { warn: jest.fn() };
    const service = createUsdCorrelationService({
      fetchHistory: async (symbol) => {
        if (symbol === 'SILVER') throw new Error('Silver history timeout');
        return makeHistory();
      },
      now: () => new Date('2026-05-15T22:00:00Z'),
      logger,
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.sourceStatus).toBe('current');
    expect(snapshot.correlations.SILVER).toBeUndefined();
    expect(snapshot.assetContext.silverRealizedVolatility).toBeUndefined();
    expect(snapshot.assetContext.brentWtiSpread).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('optional SILVER history unavailable'));
  });

  test('attaches a verified FXVL snapshot when the CME producer succeeds', async () => {
    const fxvlSnapshot = {
      lastPx: 5.75,
      source: 'cme',
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      asOf: '2026-07-24T21:00:00.000Z',
    };
    const fetchFxvlSnapshot = jest.fn(async () => fxvlSnapshot);
    const service = createUsdCorrelationService({
      fetchHistory: async () => makeHistory(),
      fetchFxvlSnapshot,
      now: () => new Date('2026-05-15T22:00:00Z'),
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      sourceStatus: 'current',
      fxvlSnapshot,
    });
    expect(fetchFxvlSnapshot).toHaveBeenCalledTimes(1);
  });

  test('keeps correlations current when FXVL fetch fails closed', async () => {
    const service = createUsdCorrelationService({
      fetchHistory: async () => makeHistory(),
      fetchFxvlSnapshot: async () => {
        throw new Error('CME unauthorized');
      },
      now: () => new Date('2026-05-15T22:00:00Z'),
      logger: { warn: jest.fn() },
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      sourceStatus: 'current',
      fxvlSnapshot: null,
    });
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
