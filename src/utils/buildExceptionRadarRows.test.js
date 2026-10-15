import { buildExceptionRadarRows } from './buildExceptionRadarRows';

const NOW = '2026-07-13T22:00:00.000Z';

const volatilityRow = ({
  lastPx = 20,
  dayChangePct = 5,
  source = 'cboe',
  quoteMode = 'delayed',
  availability = 'available',
  freshness = 'current',
  asOf = NOW,
  ...rest
} = {}) => ({
  lastPx,
  dayChangePct,
  source,
  quoteMode,
  availability,
  freshness,
  asOf,
  ...rest,
});

const marketRow = ({
  symbol,
  name = symbol,
  price = 100,
  changePercent = 1,
  source = 'yahoo',
  dataType = 'delayed',
  availability = 'delayed',
  freshness = 'current',
  quoteAsOf = NOW,
  ...rest
}) => ({
  symbol,
  name,
  price,
  changePercent,
  source,
  dataType,
  availability,
  freshness,
  quoteAsOf,
  ...rest,
});

const correlationState = (overrides = {}) => ({
  correlations: {
    SPX: { '30D': -0.46 },
    BRENT: { '30D': 0.14 },
    CRB: { '30D': -0.14 },
    GOLD: { '30D': -0.51 },
    BTC: { '30D': -0.48 },
  },
  rollingStats: {
    SPX: {}, BRENT: {}, CRB: {}, GOLD: {}, BTC: {},
  },
  correlationsTimestamp: NOW,
  calculationDate: '2026-07-13',
  loading: false,
  error: null,
  ...overrides,
});

const currentProviderStatus = (overrides = {}) => ({
  timestamp: NOW,
  statusRefreshDelayed: false,
  ibkr: {
    connected: true,
    status: 'connected',
    lastQuoteAt: NOW,
  },
  ...overrides,
});

describe('buildExceptionRadarRows', () => {
  test('builds the fixed five category slots from eligible current and delayed inputs', () => {
    const rows = buildExceptionRadarRows({
      volatilitySnapshot: {
        VIX: volatilityRow({ lastPx: 17.16, dayChangePct: 14.17 }),
        VVIX: volatilityRow({ lastPx: 95.28, dayChangePct: 9.17 }),
        OVX: volatilityRow({ lastPx: 60.25, dayChangePct: 34.88 }),
      },
      marketData: {
        currencies: [
          marketRow({ symbol: 'EURUSD', name: 'EUR/USD', price: 1.14, changePercent: -0.2 }),
          marketRow({ symbol: 'AUDUSD', name: 'AUD/USD', price: 0.69, changePercent: -1.43 }),
        ],
        us: [
          marketRow({ symbol: 'SPX', name: 'S&P 500', price: 7515.34, changePercent: -0.79 }),
          marketRow({ symbol: 'IXIC', name: 'Nasdaq', price: 25873.18, changePercent: -1.55 }),
          marketRow({ symbol: 'QQQ', name: 'QQQ', price: 711.74, changePercent: -1.9 }),
        ],
      },
      correlationState: correlationState(),
      now: NOW,
    });

    expect(rows).toHaveLength(5);
    expect(rows.map(({ symbol }) => symbol)).toEqual(['OVX', 'VIX', 'AUDUSD', 'IXIC', 'GOLD']);
    expect(rows.map(({ category }) => category)).toEqual([
      'VOLATILITY', 'VOLATILITY', 'FX', 'EQUITY', 'CORRELATION',
    ]);
    expect(rows.slice(0, 4).map(({ status }) => status)).toEqual([
      'delayed', 'delayed', 'delayed', 'delayed',
    ]);
    expect(rows[4]).toMatchObject({
      value: -0.51,
      changeLabel: '30D',
      status: 'as-of',
      available: true,
    });
  });

  test('uses stable symbol order as the final tie-break in every family', () => {
    const rows = buildExceptionRadarRows({
      volatilitySnapshot: {
        VIX: volatilityRow({ dayChangePct: 10 }),
        VVIX: volatilityRow({ dayChangePct: -10 }),
      },
      marketData: {
        currencies: [
          marketRow({ symbol: 'USDJPY', changePercent: -2 }),
          marketRow({ symbol: 'EURUSD', changePercent: 2 }),
        ],
        us: [
          marketRow({ symbol: 'DJI', changePercent: -1 }),
          marketRow({ symbol: 'SPX', changePercent: 1 }),
        ],
      },
      correlationState: correlationState({
        correlations: {
          SPX: { '30D': 0.5 },
          BRENT: { '30D': -0.5 },
        },
      }),
      now: NOW,
    });

    expect(rows.map(({ symbol }) => symbol)).toEqual(['VIX', 'VVIX', 'EURUSD', 'SPX', 'SPX']);
  });

  test('excludes stale, frozen, cache, mock, and non-current analytical inputs without backfill', () => {
    const rows = buildExceptionRadarRows({
      volatilitySnapshot: {
        VIX: volatilityRow({ freshness: 'stale' }),
        OVX: volatilityRow({ source: 'mock-provider' }),
        NazVol: volatilityRow({
          availability: 'reference',
          freshness: 'refresh-delayed',
          refreshDelayed: true,
        }),
      },
      marketData: {
        currencies: [
          marketRow({ symbol: 'AUDUSD', dataType: 'delayed_frozen' }),
        ],
        us: [
          marketRow({ symbol: 'IXIC', warning: 'cached fallback quote' }),
          marketRow({ symbol: 'QQQ', changePercent: -9 }),
        ],
      },
      correlationState: correlationState({ sourceStatus: 'stale' }),
      now: NOW,
    });

    expect(rows).toHaveLength(5);
    expect(rows.every(({ available }) => available === false)).toBe(true);
    expect(rows.map(({ statusLabel }) => statusLabel).every((label) => label === 'UNAVAILABLE')).toBe(true);
  });

  test('excludes validated historical MOVE from intraday exception slots', () => {
    const rows = buildExceptionRadarRows({
      volatilitySnapshot: {
        MOVE: volatilityRow({
          lastPx: 92.4,
          dayChangePct: 8.5,
          source: 'yahoo',
          quoteMode: 'end-of-day',
          availability: 'historical',
          freshness: 'historical',
        }),
      },
      now: NOW,
    });

    expect(rows.slice(0, 2).every(({ available }) => available === false)).toBe(true);
  });

  test('requires fresh connected provider status and quote heartbeat for IBKR rows only', () => {
    const input = {
      marketData: {
        currencies: [marketRow({
          symbol: 'AUDUSD',
          source: 'ibkr',
          dataType: 'unknown',
          availability: 'current',
          changePercent: -1.2,
        })],
        us: [marketRow({
          symbol: 'IXIC',
          changePercent: -1.1,
          warning: 'ibkr: gateway_offline; delayed_data',
        })],
      },
      correlationState: null,
      now: NOW,
    };

    const currentRows = buildExceptionRadarRows({
      ...input,
      providerStatus: currentProviderStatus(),
    });
    expect(currentRows[2]).toMatchObject({ symbol: 'AUDUSD', status: 'live', available: true });
    expect(currentRows[3]).toMatchObject({ symbol: 'IXIC', status: 'delayed', available: true });

    const delayedStatusRows = buildExceptionRadarRows({
      ...input,
      providerStatus: currentProviderStatus({ statusRefreshDelayed: true }),
    });
    expect(delayedStatusRows[2]).toMatchObject({ available: false, status: 'unavailable' });
    expect(delayedStatusRows[3]).toMatchObject({ symbol: 'IXIC', available: true });

    const staleHeartbeatRows = buildExceptionRadarRows({
      ...input,
      providerStatus: currentProviderStatus({
        ibkr: {
          connected: true,
          status: 'connected',
          lastQuoteAt: '2026-07-13T21:58:00.000Z',
        },
      }),
    });
    expect(staleHeartbeatRows[2].available).toBe(false);
  });

  test('never treats DXY, UUP, QQQ, or RSP as category substitutes', () => {
    const rows = buildExceptionRadarRows({
      marketData: {
        currencies: [
          marketRow({ symbol: 'USD', name: 'DXY', changePercent: 5 }),
          marketRow({ symbol: 'UUP', changePercent: 4 }),
        ],
        us: [
          marketRow({ symbol: 'QQQ', changePercent: -5 }),
          marketRow({ symbol: 'RSP', changePercent: -4 }),
        ],
      },
      now: NOW,
    });

    expect(rows[2].available).toBe(false);
    expect(rows[3].available).toBe(false);
  });

  test('excludes public delayed quotes older than the four-day weekend bridge', () => {
    const rows = buildExceptionRadarRows({
      marketData: {
        currencies: [marketRow({
          symbol: 'AUDUSD',
          quoteAsOf: '2026-07-03T22:00:00.000Z',
          changePercent: -2,
        })],
      },
      now: NOW,
    });

    expect(rows[2]).toMatchObject({
      category: 'FX',
      available: false,
      status: 'unavailable',
    });
  });
});
