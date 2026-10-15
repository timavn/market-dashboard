const { latestCompletedWtiSessionDate } = require('../predictionMarketsIngest/watchlistProvider');
const {
  GOLD_SPOT_PROXY_INSTRUMENT,
  goldReferenceItem,
  goldResolverContractMatches,
} = require('./marketReferenceProvider.cjs');

const NOW = Date.parse('2026-08-31T17:00:00.000Z');

function future(overrides = {}) {
  return {
    symbol: 'GC',
    displaySymbol: 'GCZ26',
    conId: 12345,
    secType: 'FUT',
    exchange: 'COMEX',
    currency: 'USD',
    lastTradeDateOrContractMonth: '202612',
    ...overrides,
  };
}

describe('Gold market-reference identity and fail-closed normalization', () => {
  test('assigns DIRECT to active GC only for the exact ForecastEx resolver contract', () => {
    const resolver = { fit: 'exact', instrument: future() };
    expect(goldResolverContractMatches(future(), resolver, { venueId: 'forecastex' })).toBe(true);
    expect(goldResolverContractMatches(
      future({ conId: 77777, lastTradeDateOrContractMonth: '202702' }),
      resolver,
      { venueId: 'forecastex' },
    )).toBe(false);
    expect(goldResolverContractMatches(future(), resolver, { venueId: 'kalshi' })).toBe(false);
    expect(goldResolverContractMatches(
      future({ conId: null, lastTradeDateOrContractMonth: null }),
      { fit: 'exact', instrument: future({ conId: null, lastTradeDateOrContractMonth: null }) },
      { venueId: 'forecastex' },
    )).toBe(false);
  });

  test('can match a complete contract month when both exact conIds are absent', () => {
    const active = future({ conId: null });
    const resolver = { fit: 'exact', instrument: future({ conId: null }) };
    expect(goldResolverContractMatches(active, resolver, { venueId: 'forecastex' })).toBe(true);
    expect(goldResolverContractMatches(
      active,
      { fit: 'exact', instrument: future({ conId: null, lastTradeDateOrContractMonth: '202702' }) },
      { venueId: 'forecastex' },
    )).toBe(false);
  });

  test('calculates daily change only from the same verified live instrument', () => {
    const item = goldReferenceItem({
      key: 'xauusd',
      label: 'SPOT GOLD',
      symbol: 'XAUUSD',
      role: 'proxy',
      instrument: GOLD_SPOT_PROXY_INSTRUMENT,
      nowMs: NOW,
      reference: {
        spot: {
          status: 'available',
          availability: 'live',
          value: 4_450,
          previousClose: 4_400,
          source: 'ibkr',
          asOf: '2026-08-31T16:59:40.000Z',
          expiresAt: '2026-08-31T17:01:00.000Z',
        },
      },
    });

    expect(item).toMatchObject({
      key: 'xauusd', role: 'proxy', status: 'live', price: 4_450,
      previousClose: 4_400, source: 'ibkr', asOf: '2026-08-31T16:59:40.000Z',
      instrument: { displaySymbol: 'XAUUSD', conId: 69067924 },
    });
    expect(item.changePercent).toBeCloseTo(1.13636, 4);
  });

  test('allows an explicitly dated latest completed settlement as HISTORICAL', () => {
    const completedDate = latestCompletedWtiSessionDate(NOW);
    const item = goldReferenceItem({
      key: 'activeComex',
      label: 'COMEX GOLD',
      symbol: 'GCZ26',
      role: 'proxy',
      instrument: future(),
      nowMs: NOW,
      reference: {
        spot: {
          status: 'historical',
          availability: 'historical',
          value: 4_430,
          previousClose: 4_400,
          source: 'ibkr_historical_bars',
          asOf: `${completedDate}T20:00:00.000Z`,
        },
      },
    });

    expect(item).toMatchObject({
      role: 'proxy', status: 'historical', price: 4_430,
      previousClose: 4_400, source: 'ibkr_historical_bars',
    });
  });

  test.each([
    ['stale quote', { asOf: '2026-08-31T16:55:00.000Z' }],
    ['disconnected provider', { provenance: 'ibkr disconnected' }],
    ['cached quote', { fromCache: true }],
    ['mock quote', { mock: true }],
    ['seeded quote', { seeded: true }],
  ])('blanks a %s instead of displaying an unsafe price', (_label, override) => {
    const item = goldReferenceItem({
      key: 'xauusd',
      label: 'SPOT GOLD',
      symbol: 'XAUUSD',
      role: 'proxy',
      instrument: GOLD_SPOT_PROXY_INSTRUMENT,
      nowMs: NOW,
      reference: {
        spot: {
          status: 'available', availability: 'live', value: 4_450, previousClose: 4_400,
          source: 'ibkr', asOf: '2026-08-31T16:59:40.000Z',
          expiresAt: '2026-08-31T17:01:00.000Z', ...override,
        },
      },
    });

    expect(item).toMatchObject({
      status: 'unavailable', price: null, previousClose: null,
      changePercent: null, source: null, asOf: null,
    });
  });

  test('preserves the DIRECT tile identity when Pyth entitlement is unavailable', () => {
    const item = goldReferenceItem({
      key: 'selectedResolver',
      label: 'PYTH GOLD INDEX',
      symbol: 'GOLD/USD',
      role: 'direct',
      nowMs: NOW,
      reference: {
        spot: {
          status: 'unavailable',
          value: null,
          reason: 'Pyth Lazer entitlement is unavailable (HTTP 401).',
        },
      },
    });

    expect(item).toEqual(expect.objectContaining({
      key: 'selectedResolver', label: 'PYTH GOLD INDEX', symbol: 'GOLD/USD',
      role: 'direct', status: 'unavailable', price: null, source: null,
      reason: expect.stringMatching(/entitlement/i),
    }));
  });
});
