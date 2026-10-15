const { CF_BENCHMARK_MARKETS, loadCfBenchmarkReference } = require('./cfBenchmarkReference.cjs');

const NOW = Date.parse('2026-09-15T16:15:30.000Z');

function fixture(marketId = 'bitcoin') {
  const response = { data: {
    serverTime: new Date(NOW).toISOString(),
    payload: [
      { time: NOW - 2_000, value: '76321.11' },
      { time: NOW - 1_000, value: '76344.59' },
    ],
  } };
  const kalshiFetch = jest.fn(async () => response);
  return { response, kalshiFetch, load: (extras = {}) => loadCfBenchmarkReference({
    marketId, kalshiFetch, nowMs: NOW, ...extras,
  }) };
}

function expectUnavailable(result) {
  expect(result.spot).toMatchObject({ status: 'unavailable', value: null, asOf: null, expiresAt: null, executable: false });
  expect(result.chart.points).toEqual([]);
  expect(Object.values(result.chart.variants).map((variant) => variant.points)).toEqual([[], [], []]);
}

describe('CF Benchmarks exact current reference', () => {
  test.each(Object.keys(CF_BENCHMARK_MARKETS))('loads the exact official %s index with its original observation time', async (marketId) => {
    const subject = fixture(marketId);
    const definition = CF_BENCHMARK_MARKETS[marketId];
    const result = await subject.load();
    expect(subject.kalshiFetch).toHaveBeenCalledTimes(1);
    expect(subject.kalshiFetch).toHaveBeenCalledWith('/cfbenchmarks/values', { id: definition.indexId, maxResolution: 'PER_SECOND' });
    expect(result).toMatchObject({
      fit: 'exact', referenceKind: 'settlement_benchmark',
      instrument: { symbol: definition.indexId, underlyingSymbol: definition.symbol, provider: 'cf_benchmarks' },
      spot: {
        status: 'available', availability: 'live', value: 76344.59,
        asOf: '2026-09-15T16:15:29.000Z', expiresAt: '2026-09-15T16:16:29.000Z',
        source: 'cf_benchmarks_kalshi_rest', observationKind: 'current_index', executable: false,
      },
      settlement: { observationKind: 'current_index', averagingWindowSeconds: 60, finalSettlementValue: null },
    });
    expect(result.chart.points).toEqual([]);
  });

  test.each([
    ['offline', { connected: false }], ['stale', { stale: true }], ['cache-only', { cacheOnly: true }],
    ['cached', { fromCache: true }], ['seed', { seeded: true }], ['mock', { mock: true }],
    ['delayed', { availability: 'delayed' }], ['failed refresh', { refreshFailed: true }],
    ['provider error', { error: 'calculation error' }], ['HTTP error', { status: 503 }],
    ['nested stale', { freshness: { status: 'stale' } }], ['nested offline', { providerStatus: { connected: false } }],
  ])('rejects %s evidence at the outer, CF, and latest tick levels', async (_label, flags) => {
    expect.hasAssertions();
    for (const level of ['outer', 'data', 'tick']) {
      const subject = fixture();
      Object.assign(level === 'outer' ? subject.response : level === 'data' ? subject.response.data : subject.response.data.payload[1], flags);
      expectUnavailable(await subject.load());
    }
  });

  test.each([
    ['stale', { time: NOW - 61_000 }], ['future', { time: NOW + 10_000 }],
    ['missing timestamp', { time: null }], ['seconds instead of milliseconds', { time: NOW / 1000 }],
    ['absent value', { value: null }], ['zero value', { value: '0' }], ['negative value', { value: '-1' }],
    ['non-scalar value', { value: [76344.59] }],
    ['repeated value', { repeatOfPreviousValue: true }], ['wrong index', { id: 'ETHUSD_RTI' }],
  ])('rejects a %s observation without substituting server time or another price', async (_label, overrides) => {
    expect.hasAssertions();
    const subject = fixture();
    subject.response.data.payload = [{ time: NOW - 1_000, value: '76344.59', ...overrides }];
    subject.response.data.price = 76000;
    expectUnavailable(await subject.load());
  });

  test.each(['outer', 'data', 'tick'])('rejects mismatched index identity at %s level', async (level) => {
    expect.hasAssertions();
    const subject = fixture();
    const record = level === 'outer' ? subject.response : level === 'data' ? subject.response.data : subject.response.data.payload[0];
    record.indexId = 'ETHUSD_RTI';
    expectUnavailable(await subject.load());
  });

  test.each([null, 'invalid', new Date(NOW - 61_000).toISOString(), new Date(NOW + 10_000).toISOString()])(
    'rejects absent or invalid response freshness %s', async (serverTime) => {
      expect.hasAssertions();
      const subject = fixture();
      subject.response.data.serverTime = serverTime;
      expectUnavailable(await subject.load());
    },
  );

  test('a calculation failure on the latest tick cannot resurrect the preceding tick', async () => {
    expect.hasAssertions();
    const subject = fixture();
    subject.response.data.payload[1].repeatOfPreviousValue = true;
    expectUnavailable(await subject.load());
  });

  test('keeps scientific precision and the original timestamp for amended observations', async () => {
    const subject = fixture();
    subject.response.data.payload[1] = { time: NOW - 5_000, value: '7.634459123456e4', amendTime: NOW - 1_000 };
    subject.response.data.payload.shift();
    expect((await subject.load()).spot).toMatchObject({
      value: 76344.59123456, asOf: '2026-09-15T16:15:25.000Z', amendedAt: '2026-09-15T16:15:29.000Z',
    });
    subject.response.data.payload[0].time = NOW - 61_000;
    expectUnavailable(await subject.load());
  });

  test('authorization and later transport failures clear all previous values', async () => {
    const subject = fixture();
    expect((await subject.load()).spot.status).toBe('available');
    subject.kalshiFetch.mockRejectedValue(Object.assign(new Error('authorization failed'), { status: 401 }));
    expectUnavailable(await subject.load());
    subject.kalshiFetch.mockRejectedValue(new Error('network offline'));
    expectUnavailable(await subject.load());
  });

  test('bounds an unresponsive transport without a cached or alternate benchmark', async () => {
    const subject = fixture();
    subject.kalshiFetch.mockImplementation(() => new Promise(() => {}));
    expectUnavailable(await subject.load({ requestTimeoutMs: 5 }));
    expect(subject.kalshiFetch).toHaveBeenCalledTimes(1);
  });

  test('missing credentials transport and unsupported indices never trigger another source', async () => {
    const subject = fixture();
    expectUnavailable(await subject.load({ kalshiFetch: null }));
    expect(subject.kalshiFetch).not.toHaveBeenCalled();
    await expect(subject.load({ marketId: 'unmapped' })).rejects.toThrow('Unsupported CF Benchmarks');
  });
});
