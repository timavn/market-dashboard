const {
  buildHistoricalFxvlSnapshot,
  createFxvlSnapshotService,
  isHistoryFreshEnough,
  parseFxvlHistoryRows,
  pickCvolIndex,
  readCredentials,
} = require('./fxvlSnapshotService.cjs');
const {
  addCalendarDays,
  mostRecentCompletedTradingDateKey,
  previousTradingDateKey,
} = require('./volatilitySnapshotService.cjs');

function makeTradingHistory(endDateKey, length = 140, startClose = 6.5) {
  const rows = [];
  let cursor = endDateKey;
  let close = startClose;
  for (let index = 0; index < length; index += 1) {
    rows.push({ date: cursor, close: Number((close).toFixed(4)) });
    close *= 1 + (((index % 5) - 2) * 0.004);
    cursor = previousTradingDateKey(cursor);
  }
  return rows.reverse();
}

function toCmeHistoryPayload(rows, productCode = 'FXVL') {
  return rows.map((row) => ({
    businessDt: row.date,
    cycleCode: 'EOD',
    instrument: [{
      productCode,
      values: [{
        cvolIndex: row.close,
        atmVolatility: row.close * 0.98,
      }],
    }],
  }));
}

describe('fxvlSnapshotService', () => {
  test('readCredentials fails closed without CME env', () => {
    expect(readCredentials({})).toBeNull();
    expect(readCredentials({ CME_CVOL_API_ID: 'id' })).toBeNull();
    expect(readCredentials({
      CME_CVOL_API_ID: 'id',
      CME_CVOL_API_PASSWORD: 'secret',
    })).toMatchObject({
      apiId: 'id',
      apiPassword: 'secret',
    });
  });

  test('parses nested CME instrument payloads into dated closes', () => {
    const rows = parseFxvlHistoryRows(toCmeHistoryPayload([
      { date: '2026-07-10', close: 5.1 },
      { date: '2026-07-13', close: 5.4 },
    ]));
    expect(rows).toEqual([
      { date: '2026-07-10', close: 5.1 },
      { date: '2026-07-13', close: 5.4 },
    ]);
    expect(pickCvolIndex([{ cvolIndex: 7.25 }])).toBe(7.25);
  });

  test('builds a CME-attributed historical snapshot matching the UI contract', () => {
    const asOfDateKey = '2026-07-24';
    const history = makeTradingHistory(asOfDateKey, 140, 6.2);
    const snapshot = buildHistoricalFxvlSnapshot(history, {
      asOfDateKey,
      now: new Date('2026-07-27T16:00:00.000Z'),
    });
    expect(snapshot).toMatchObject({
      source: 'cme',
      quoteMode: 'end-of-day',
      availability: 'historical',
      freshness: 'historical',
      measure: 'cvol',
      lastPx: history.at(-1).close,
    });
    expect(snapshot.asOf).toContain('2026-07-24');
    expect(Number.isFinite(snapshot.dayChangePct)).toBe(true);
    expect(Number.isFinite(snapshot.monthChangePct)).toBe(true);
    expect(Number.isFinite(snapshot.threeMonthChangePct)).toBe(true);
  });

  test('builds equal-weight G5 realized-vol series from pair histories', () => {
    const {
      buildG5RealizedVolSeries,
      buildPairRealizedVolSeries,
    } = require('./fxvlSnapshotService.cjs');
    const endDate = '2026-07-24';
    const pairHistory = makeTradingHistory(endDate, 180, 1.1);
    const one = buildPairRealizedVolSeries(pairHistory);
    expect(one.length).toBeGreaterThan(130);
    expect(one.at(-1).date).toBe(endDate);
    expect(one.at(-1).close).toBeGreaterThan(0);

    const g5 = buildG5RealizedVolSeries({
      EURUSD: pairHistory,
      GBPUSD: makeTradingHistory(endDate, 180, 1.25),
      USDJPY: makeTradingHistory(endDate, 180, 150),
      AUDUSD: makeTradingHistory(endDate, 180, 0.66),
      USDCAD: makeTradingHistory(endDate, 180, 1.35),
    });
    expect(g5.length).toBeGreaterThan(130);
    expect(g5.at(-1).date).toBe(endDate);
  });

  test('returns Yahoo G5 realized vol when CME credentials are missing', async () => {
    const now = new Date('2026-07-27T20:00:00.000Z');
    const expected = mostRecentCompletedTradingDateKey(now);
    const fetchPairHistory = jest.fn(async (symbol) => (
      makeTradingHistory(expected, 180, symbol === 'USDJPY' ? 150 : 1.1)
    ));
    const service = createFxvlSnapshotService({
      env: {},
      now: () => now,
      fetchPairHistory,
      httpClient: { get: jest.fn(), post: jest.fn() },
      logger: { warn: jest.fn() },
    });

    const snapshot = await service.getSnapshot();
    expect(fetchPairHistory).toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      source: 'yahoo',
      measure: 'realized',
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
    });
    expect(snapshot.lastPx).toBeGreaterThan(0);
  });

  test('returns null when credentials are missing', async () => {
    const service = createFxvlSnapshotService({
      env: {},
      httpClient: { get: jest.fn(), post: jest.fn() },
    });
    expect(service.hasCredentials).toBe(false);
    await expect(service.getSnapshot()).resolves.toBeNull();
    expect(service.hasCredentials).toBe(false);
  });

  test('fetches OAuth token + CME latest/history and returns a displayable snapshot', async () => {
    const now = new Date('2026-07-27T20:00:00.000Z');
    const expected = mostRecentCompletedTradingDateKey(now);
    const history = makeTradingHistory(expected, 140, 5.75);
    const httpClient = {
      post: jest.fn(async () => ({
        data: { access_token: 'token-1', expires_in: 300 },
      })),
      get: jest.fn(async (url) => {
        if (String(url).includes('/latest')) {
          return { data: toCmeHistoryPayload([history.at(-1)])[0] };
        }
        return { data: toCmeHistoryPayload(history) };
      }),
    };

    const service = createFxvlSnapshotService({
      httpClient,
      now: () => now,
      credentials: {
        apiId: 'id',
        apiPassword: 'secret',
        tokenUrl: 'https://auth.example/token',
        baseUrl: 'https://api.example/cvol-eod/v1',
        appName: 'market-dashboard',
        appVendor: 'timavn',
        appVersion: '1.0.0',
      },
    });

    const snapshot = await service.getSnapshot();
    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.get).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({
      source: 'cme',
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      lastPx: history.at(-1).close,
    });
  });

  test('fails closed on auth errors and stale history', async () => {
    const now = new Date('2026-07-27T20:00:00.000Z');
    const expected = mostRecentCompletedTradingDateKey(now);
    const staleDate = addCalendarDays(expected, -20);
    const staleHistory = makeTradingHistory(staleDate, 140, 5.1);

    const authFailService = createFxvlSnapshotService({
      now: () => now,
      logger: { warn: jest.fn() },
      credentials: {
        apiId: 'id',
        apiPassword: 'secret',
        tokenUrl: 'https://auth.example/token',
        baseUrl: 'https://api.example/cvol-eod/v1',
        appName: 'market-dashboard',
        appVendor: 'timavn',
        appVersion: '1.0.0',
      },
      httpClient: {
        post: jest.fn(async () => {
          throw new Error('401 unauthorized');
        }),
        get: jest.fn(),
      },
    });
    await expect(authFailService.getSnapshot()).resolves.toBeNull();

    const staleService = createFxvlSnapshotService({
      now: () => now,
      maxStaleDays: 5,
      logger: { warn: jest.fn() },
      credentials: {
        apiId: 'id',
        apiPassword: 'secret',
        tokenUrl: 'https://auth.example/token',
        baseUrl: 'https://api.example/cvol-eod/v1',
        appName: 'market-dashboard',
        appVendor: 'timavn',
        appVersion: '1.0.0',
      },
      httpClient: {
        post: jest.fn(async () => ({ data: { access_token: 'token-1', expires_in: 300 } })),
        get: jest.fn(async (url) => {
          if (String(url).includes('/latest')) {
            return { data: toCmeHistoryPayload([staleHistory.at(-1)])[0] };
          }
          return { data: toCmeHistoryPayload(staleHistory) };
        }),
      },
    });
    await expect(staleService.getSnapshot()).resolves.toBeNull();
    expect(isHistoryFreshEnough(staleDate, now, 5)).toBe(false);
    expect(isHistoryFreshEnough(expected, now, 5)).toBe(true);
  });
});
