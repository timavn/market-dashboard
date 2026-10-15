/** @jest-environment node */
const { createMarketMonitorService } = require('./marketMonitorService.cjs');

const AS_OF = '2026-09-15T16:00:00.000Z';
const NOW = Date.parse(AS_OF);
const EVENT_TICKER = 'KXBTCD-26SEP1517';
const CLOSE = '2026-09-15T21:00:00.000Z';

function perpetualReference({ available = true } = {}) {
  const status = available ? 'available' : 'unavailable';
  const common = {
    status,
    availability: available ? 'live' : 'unavailable',
    source: available ? 'kalshi_margin_market' : null,
    asOf: available ? AS_OF : null,
    expiresAt: available ? new Date(NOW + 60_000).toISOString() : null,
    fit: 'exact', referenceKind: 'perpetual_contract', executable: false,
    ...(available ? {} : { refreshFailed: true, reason: 'Perpetual provider unavailable.' }),
  };
  const spot = { ...common, value: available ? 76_200 : null, label: 'BTC PERP' };
  const chart = {
    ...common,
    points: available ? [{ timestamp: NOW - 60_000, value: 76_300 }, { timestamp: NOW, value: 76_200 }] : [],
  };
  const reference = {
    referenceKind: 'perpetual_contract', fit: 'exact',
    resolver: 'Kalshi BTC perpetual contract',
    instrument: { symbol: 'BTC', ticker: 'KXBTCPERP', provider: 'kalshi' },
    spot, chart, proxyFit: null,
  };
  return {
    ...reference,
    chartReferences: {
      basis: { ...reference, role: 'perpetual_contract', symbol: 'BTC PERP', riskRangeTicker: 'BITCOIN', exact: true },
    },
  };
}

function createSubject({ currentReference = perpetualReference(), eventsAvailable = true, loadSettlementBenchmark = async () => null } = {}) {
  let currentTime = NOW;
  let reference = currentReference;
  const event = {
    event_ticker: EVENT_TICKER,
    series_ticker: 'KXBTCD', status: 'open', strike_date: CLOSE,
    settlement_sources: [{ name: 'CF Benchmarks', url: 'https://www.cfbenchmarks.com/data/indices/BRTI' }],
    markets: [76_000, 77_000].map((threshold) => ({
      ticker: `${EVENT_TICKER}-T${threshold}`, event_ticker: EVENT_TICKER,
      status: 'open', close_time: CLOSE, floor_strike: threshold, strike_type: 'greater',
      rules_primary: `If the average of sixty seconds of CF Benchmarks Bitcoin Real-Time Index (BRTI) in the final minute before expiration is above ${threshold}, this market resolves Yes.`,
    })),
  };
  const loadMarketReference = jest.fn(async () => reference);
  const service = createMarketMonitorService({
    now: () => new Date(currentTime),
    publicSources: {},
    spxMonitorService: {},
    kalshiFetch: jest.fn(async () => ({ events: eventsAvailable ? [event] : [] })),
    loadKalshiOrderbooks: jest.fn(async (tickers) => new Map(tickers.map((ticker) => [ticker, {
      ticker, orderbook_fp: { yes_dollars: [['0.40', '10']], no_dollars: [['0.58', '10']] },
    }]))),
    loadMarketReference,
    loadSettlementBenchmark,
  });
  return {
    service,
    loadMarketReference,
    setReference(next) { reference = next; currentTime += 5_001; },
  };
}

test('keeps the direct perpetual chart separate from the binary event resolver and native book', async () => {
  const subject = createSubject();
  const snapshot = await subject.service.getSnapshot('bitcoin');

  expect(snapshot.spot).toMatchObject({ value: 76_200, source: 'kalshi_margin_market', executable: false });
  expect(Object.keys(snapshot.chartReferences)).toEqual(['basis']);
  expect(snapshot.chartReferences.basis.symbol).toBe('BTC PERP');
  expect(snapshot.perpetualReference.instrument.ticker).toBe('KXBTCPERP');
  expect(snapshot.perpetualReference.resolverIdentity).toBeUndefined();
  expect(snapshot.resolverReference).toBe(snapshot.venues.kalshi.reference);
  expect(snapshot.resolverReference.spot).toMatchObject({ status: 'unavailable', value: null });
  expect(snapshot.resolverReference.resolverIdentity.eventTicker).toBe(EVENT_TICKER);
  expect(snapshot.resolverMetadata.kalshi.underlying).toBe('cf_benchmarks_brti');
  expect(snapshot.resolverMetadata.reference).not.toContain('perpetual');
  expect(snapshot.venues.kalshi.book.lines.map((line) => line.ticker)).toEqual([
    `${EVENT_TICKER}-T76000`, `${EVENT_TICKER}-T77000`,
  ]);
  expect(snapshot.sourceHealth).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'perpetual_spot', status: 'live', source: 'kalshi_margin_market' }),
  ]));
});

test('publishes the exact index beside the perpetual and revokes only that index when its refresh fails', async () => {
  const { loadCfBenchmarkReference } = require('./cfBenchmarkReference.cjs');
  const { verifiedSettlementBenchmarkSpot } = require('./settlementBenchmarkReference.cjs');
  let available = true;
  const subject = createSubject({ loadSettlementBenchmark: ({ nowMs }) => loadCfBenchmarkReference({
    marketId: 'bitcoin', nowMs, kalshiFetch: async () => {
      if (!available) throw new Error('Provider offline');
      return { data: { serverTime: new Date(nowMs).toISOString(), payload: [{ value: '76123.45', time: nowMs }] } };
    },
  }) });
  const snapshot = await subject.service.getSnapshot('bitcoin');
  expect(snapshot.spot.value).toBe(76200);
  expect(snapshot.resolverReference.settlementBenchmark).toMatchObject({
    identityVerified: true, eventTicker: EVENT_TICKER, symbol: 'BRTI',
  });
  expect(verifiedSettlementBenchmarkSpot(snapshot.resolverReference, NOW)).toMatchObject({ value: 76123.45 });
  available = false;
  subject.setReference(perpetualReference());
  const failed = await subject.service.getSnapshot('bitcoin');
  expect(failed.spot.value).toBe(76200);
  expect(failed.resolverReference.spot.value).toBeNull();
});

test('keeps direct perpetual history available without a current binary event', async () => {
  const subject = createSubject({ eventsAvailable: false });
  const snapshot = await subject.service.getSnapshot('bitcoin');

  expect(snapshot.status).toBe('partial');
  expect(snapshot.spot.value).toBe(76_200);
  expect(snapshot.chart.points).toHaveLength(2);
  expect(Object.keys(snapshot.chartReferences)).toEqual(['basis']);
  expect(snapshot.perpetualReference.instrument.ticker).toBe('KXBTCPERP');
  expect(snapshot.resolverReference.spot.value).toBeNull();
  expect(snapshot.resolverReference.resolverIdentity.eventTicker).toBeNull();
  expect(snapshot.displaySelection.venueId).toBeNull();
  expect(snapshot.contracts.lines).toEqual([]);
  expect(snapshot.executionContracts.lines).toEqual([]);
});

test.each([true, false])('removes direct prices after a failed refresh with binary event available=%s', async (eventsAvailable) => {
  const subject = createSubject({ eventsAvailable });
  const initial = await subject.service.getSnapshot('bitcoin');
  expect(initial.spot.value).toBe(76_200);

  subject.setReference(perpetualReference({ available: false }));
  const failed = await subject.service.getSnapshot('bitcoin');

  expect(subject.loadMarketReference).toHaveBeenCalledTimes(2);
  expect(failed.spot).toMatchObject({ status: 'unavailable', value: null, refreshFailed: true });
  expect(failed.chart.points).toEqual([]);
  expect(Object.keys(failed.chartReferences)).toEqual(['basis']);
  expect(failed.perpetualReference.spot.value).toBeNull();
  expect(failed.resolverReference.spot.value).toBeNull();
  expect(failed.venues.kalshi.reference.spot.value).toBeNull();
});
