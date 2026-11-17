const {
  addCalendarDays,
  combineCurrentQuote,
  computeVolatilityMetrics,
  createVolatilitySnapshotService: createPersistentVolatilitySnapshotService,
  isTradingDateKey,
  isUsMarketOpen,
  mostRecentCompletedTradingDateKey,
  parseCboeHistoryCsv,
  percentageChange,
} = require('./volatilitySnapshotService.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ordinary provider tests are isolated from the real server's durable evidence.
const createVolatilitySnapshotService = (options) => createPersistentVolatilitySnapshotService({
  referenceFilePath: null, ...options,
});

function tradingRows(startDate, count, startingClose = 100) {
  const rows = [];
  let date = startDate;
  while (rows.length < count) {
    if (isTradingDateKey(date)) {
      rows.push({ date, close: startingClose + rows.length });
    }
    date = addCalendarDays(date, 1);
  }
  return rows;
}

function historyCsv(rows, twoColumn = false) {
  const header = twoColumn ? 'DATE,VALUE' : 'DATE,OPEN,HIGH,LOW,CLOSE';
  const body = rows.map((row) => {
    const [year, month, day] = row.date.split('-');
    const date = `${month}/${day}/${year}`;
    return twoColumn
      ? `${date},${row.close}`
      : `${date},${row.close},${row.close},${row.close},${row.close}`;
  });
  return [header, ...body].join('\n');
}

function tradingRowsThrough(startDate, endDate, startingClose = 20) {
  const rows = [];
  let date = startDate;
  while (date <= endDate) {
    if (isTradingDateKey(date)) rows.push({ date, close: startingClose + rows.length });
    date = addCalendarDays(date, 1);
  }
  return rows;
}

function buildFakeProvider({
  failSymbols = new Set(),
  staleCboe = false,
  failAll = false,
  failMove = false,
  invalidMove = false,
  cboeAsOf = '2026-07-13T16:00:00-04:00',
  moveAsOf = '2026-07-13T20:30:00.000Z',
  moveHistoryEnd = '2026-07-10',
  moveHistoryRows = null,
  movePrice = 200,
} = {}) {
  const priorRows = tradingRowsThrough('2025-12-31', '2026-07-10', 20);
  const moveRows = moveHistoryRows || tradingRowsThrough('2025-12-31', moveHistoryEnd, 20);
  const moveTimestamps = moveRows.map((row) => (
    Math.floor(new Date(`${row.date}T17:00:00.000Z`).getTime() / 1000)
  ));
  const moveCloses = moveRows.map((row) => row.close);

  return {
    get: jest.fn(async (url) => {
      if (failAll) throw new Error('provider offline');
      const quoteMatch = url.match(/quotes\/_([A-Z]+)\.json$/);
      if (quoteMatch) {
        const symbol = quoteMatch[1];
        if (failSymbols.has(symbol)) throw new Error(`${symbol} offline`);
        return {
          data: {
            timestamp: '2026-07-13 20:20:00',
            data: {
              current_price: 200,
              last_trade_time: staleCboe
                ? '2026-07-13T12:00:00-04:00'
                : cboeAsOf,
            },
          },
        };
      }
      const historyMatch = url.match(/daily_prices\/([A-Z]+)_History\.csv$/);
      if (historyMatch) return { data: historyCsv(priorRows, historyMatch[1] === 'VVIX') };
      if (url.includes('%5EMOVE')) {
        if (failMove) throw new Error('MOVE offline');
        return {
          data: {
            chart: {
              result: [{
                meta: {
                  regularMarketPrice: invalidMove ? null : movePrice,
                  regularMarketTime: Math.floor(new Date(moveAsOf).getTime() / 1000),
                },
                timestamp: moveTimestamps,
                indicators: { quote: [{ close: moveCloses }] },
              }],
            },
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }),
  };
}

describe('parseCboeHistoryCsv', () => {
  test('parses two-column and OHLC history formats', () => {
    expect(parseCboeHistoryCsv('DATE,VVIX\n07/09/2026,87.10\n07/10/2026,87.28')).toEqual([
      { date: '2026-07-09', close: 87.1 },
      { date: '2026-07-10', close: 87.28 },
    ]);
    expect(parseCboeHistoryCsv('DATE,OPEN,HIGH,LOW,CLOSE\n07/10/2026,20.94,21.32,19.93,19.98')).toEqual([
      { date: '2026-07-10', close: 19.98 },
    ]);
  });

  test('drops invalid, missing, and zero closes', () => {
    expect(parseCboeHistoryCsv('DATE,VALUE\n07/08/2026,\n07/09/2026,0\n07/10/2026,22.1')).toEqual([
      { date: '2026-07-10', close: 22.1 },
    ]);
  });
});

describe('computeVolatilityMetrics', () => {
  test('replaces a same-date history close with the current quote without duplicating the session', () => {
    const combined = combineCurrentQuote(
      [
        { date: '2026-07-10', close: 20 },
        { date: '2026-07-13', close: 21 },
      ],
      new Date('2026-07-13T20:00:00.000Z'),
      22
    );
    expect(combined).toEqual([
      { date: '2026-07-10', close: 20 },
      { date: '2026-07-13', close: 22 },
    ]);
  });

  test('measures months by calendar date, days and the week by sessions, and the year from the prior year-end close', () => {
    const rows = tradingRows('2025-12-31', 130, 100);
    const metrics = computeVolatilityMetrics(rows);
    const last = rows.at(-1).close;
    // The last close on or before a date.
    const onOrBefore = (date) => [...rows].reverse().find((row) => row.date <= date).close;

    // 130 sessions from 31 December 2025 end on Thursday 9 July 2026.
    expect(rows.at(-1).date).toBe('2026-07-09');
    expect(metrics).toMatchObject({
      lastPx: last,
      day1Ago: rows.at(-2).close,
      day15Ago: rows.at(-16).close,
      week1Ago: rows.at(-6).close,
      week4Ago: onOrBefore('2026-06-09'),
      month3Ago: onOrBefore('2026-04-09'),
      month6Ago: onOrBefore('2026-01-09'),
      priorYearClose: rows[0].close,
      dayChangePct: percentageChange(last, rows.at(-2).close),
      fifteenDayChangePct: percentageChange(last, rows.at(-16).close),
      weekChangePct: percentageChange(last, rows.at(-6).close),
      monthChangePct: percentageChange(last, onOrBefore('2026-06-09')),
      threeMonthChangePct: percentageChange(last, onOrBefore('2026-04-09')),
      sixMonthChangePct: percentageChange(last, onOrBefore('2026-01-09')),
      ytdChangePct: percentageChange(last, rows[0].close),
    });
    // Not 21, 63 and 126 sessions back.
    expect(metrics.week4Ago).not.toBe(rows.at(-22).close);
    expect(metrics.month6Ago).not.toBe(rows.at(-127).close);
  });

  test('a month that ends on a weekend or holiday uses the close before it', () => {
    // Monday 6 July 2026: one month earlier is Saturday 6 June; three months earlier,
    // 6 April, is the Monday after Good Friday.
    const rows = tradingRowsThrough('2026-01-02', '2026-07-06');
    const metrics = computeVolatilityMetrics(rows);
    const closeOn = (date) => rows.find((row) => row.date === date).close;

    expect(metrics.week4Ago).toBe(closeOn('2026-06-05'));
    expect(metrics.month3Ago).toBe(closeOn('2026-04-06'));
    expect(metrics.month6Ago).toBe(closeOn('2026-01-06'));
  });

  test('returns null for periods without enough history instead of using the oldest value', () => {
    const metrics = computeVolatilityMetrics(tradingRows('2026-06-01', 10, 10));
    expect(metrics.weekChangePct).not.toBeNull();
    expect(metrics.fifteenDayChangePct).toBeNull();
    expect(metrics.day15Ago).toBeNull();
    expect(metrics.monthChangePct).toBeNull();
    expect(metrics.month3Ago).toBeNull();
    expect(metrics.month6Ago).toBeNull();
    expect(metrics.priorYearClose).toBeNull();
    expect(metrics.threeMonthChangePct).toBeNull();
    expect(metrics.sixMonthChangePct).toBeNull();
    expect(metrics.ytdChangePct).toBeNull();
  });
});

describe('createVolatilitySnapshotService', () => {
  const afterClose = new Date('2026-07-13T20:45:00.000Z');

  test('reuses time-zone formatting for MOVE history while retaining DST, weekend, and holiday session boundaries', async () => {
    const httpClient = buildFakeProvider();
    const constructor = jest.spyOn(Intl, 'DateTimeFormat');
    try {
      const result = await createVolatilitySnapshotService({
        httpClient, now: () => afterClose, logger: { warn: jest.fn() },
      }).fetchSnapshot();
      expect(result.MOVE.lastPx).toBe(200);
      expect([
        '2026-03-06T14:29:00Z', '2026-03-06T14:30:00Z',
        '2026-03-09T13:29:00Z', '2026-03-09T13:30:00Z', '2026-03-09T20:14:00Z', '2026-03-09T20:15:00Z',
        '2026-11-02T14:29:00Z', '2026-11-02T14:30:00Z',
        '2026-03-08T15:00:00Z', '2026-07-03T15:00:00Z',
      ].map((date) => isUsMarketOpen(new Date(date)))).toEqual([
        false, true, false, true, true, false, false, true, false, false,
      ]);
      expect(constructor).not.toHaveBeenCalled();
    } finally {
      constructor.mockRestore();
    }
  });

  test('coalesces concurrent snapshot requests into one upstream provider batch', async () => {
    const httpClient = buildFakeProvider();
    const service = createVolatilitySnapshotService({
      httpClient,
      now: () => afterClose,
      logger: { warn: jest.fn() },
    });

    const [first, second] = await Promise.all([
      service.fetchSnapshot(),
      service.fetchSnapshot(),
    ]);

    expect(second).toBe(first);
    expect(httpClient.get).toHaveBeenCalledTimes(17);
  });

  test('uses the current Cboe API host for every quote and history request', async () => {
    const httpClient = buildFakeProvider();
    await createVolatilitySnapshotService({
      httpClient, now: () => afterClose, logger: { warn: jest.fn() },
    }).fetchSnapshot();

    const cboeUrls = httpClient.get.mock.calls.map(([url]) => url)
      .filter((url) => url.includes('cboe.com'));
    expect(cboeUrls).toHaveLength(16);
    expect(cboeUrls.every((url) => new URL(url).origin === 'https://cdn-api.cboe.com')).toBe(true);
  });

  test('keeps independently verified MOVE history when all Cboe quotes are stale', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ cboeAsOf: '2026-07-10T16:00:00-04:00' }),
      now: () => new Date('2026-07-14T14:00:00.000Z'), logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(snapshot.status).toBe('partial');
    expect(snapshot.VIX).toMatchObject({ availability: 'reference', freshness: 'refresh-delayed', lastPx: 200,
      asOf: '2026-07-10T20:00:00.000Z', executable: false });
    expect(snapshot.MOVE).toMatchObject({ availability: 'historical', freshness: 'historical', lastPx: 200 });
  });

  test('applies the shared 30-minute Cboe freshness boundary during market hours', async () => {
    const marketNow = new Date('2026-07-13T18:00:00.000Z');
    const accepted = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ cboeAsOf: '2026-07-13T13:30:00-04:00' }),
      now: () => marketNow,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    const expired = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ cboeAsOf: '2026-07-13T13:29:59-04:00' }),
      now: () => marketNow,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(accepted.VIX).toMatchObject({ availability: 'available', freshness: 'current' });
    expect(expired.VIX).toMatchObject({ availability: 'reference', freshness: 'refresh-delayed',
      lastPx: 200, asOf: '2026-07-13T17:29:59.000Z', executable: false });
  });

  test('returns current Cboe rows and a validated historical MOVE row', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider(),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('partial');
    expect(snapshot.marketSession).toBe('closed');
    expect(snapshot.RVX).toMatchObject({
      lastPx: 200,
      availability: 'available',
      freshness: 'current',
      source: 'cboe',
      quoteMode: 'delayed',
    });
    expect(snapshot.VXEEM).toMatchObject({
      lastPx: 200,
      availability: 'available',
      freshness: 'current',
      source: 'cboe',
      quoteMode: 'delayed',
      asOf: '2026-07-13T20:00:00.000Z',
      dayChangePct: expect.any(Number),
      sixMonthChangePct: expect.any(Number),
    });
    expect(snapshot.MOVE).toMatchObject({
      lastPx: 200,
      availability: 'historical',
      freshness: 'historical',
      source: 'yahoo',
      quoteMode: 'end-of-day',
      asOf: '2026-07-13T20:30:00.000Z',
    });
    // The later historical MOVE timestamp must not age the live/current panel.
    expect(snapshot.lastUpdated).toBe('2026-07-13T20:00:00.000Z');
  });

  test('accepts the latest completed session during market hours, weekends, and observed holidays', async () => {
    const duringMarket = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider(),
      now: () => new Date('2026-07-14T14:00:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(duringMarket.marketSession).toBe('open');
    expect(duringMarket.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      lastPx: 200,
    });

    const weekend = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-17T20:30:00.000Z',
        moveHistoryEnd: '2026-07-16',
      }),
      now: () => new Date('2026-07-18T16:00:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(weekend.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      asOf: '2026-07-17T20:30:00.000Z',
    });

    const observedHolidayWeekend = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-02T20:30:00.000Z',
        moveHistoryEnd: '2026-07-01',
      }),
      now: () => new Date('2026-07-05T16:00:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(observedHolidayWeekend.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      asOf: '2026-07-02T20:30:00.000Z',
    });
  });

  test('uses the prior completed daily close when Yahoo advances MOVE intraday metadata', async () => {
    const expectedRows = tradingRowsThrough('2025-12-31', '2026-07-13', 20);
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-14T19:30:00.000Z',
        moveHistoryEnd: '2026-07-13',
      }),
      now: () => new Date('2026-07-14T19:45:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      lastPx: expectedRows.at(-1).close,
      asOf: '2026-07-13T17:00:00.000Z',
    });
  });

  test('re-dates Yahoo\'s current-day MOVE carry-forward on both sides of the close cutoff', async () => {
    const movePrice = 77.7746;
    const dailyBarClose = 77.77459716796875;
    const priorRows = tradingRowsThrough('2025-12-31', '2026-07-10', 20);
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-14T19:30:00.000Z',
        moveHistoryRows: [
          ...priorRows,
          { date: '2026-07-13', close: null },
          { date: '2026-07-14', close: dailyBarClose },
        ],
        movePrice,
      }),
      now: () => new Date('2026-07-14T19:45:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      lastPx: dailyBarClose,
      day1Ago: priorRows.at(-1).close,
      asOf: '2026-07-13T20:15:00.000Z',
    });

    const afterCloseSnapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-14T19:30:00.000Z',
        moveHistoryRows: [
          ...priorRows,
          { date: '2026-07-13', close: null },
          { date: '2026-07-14', close: dailyBarClose },
        ],
        movePrice,
      }),
      now: () => new Date('2026-07-14T20:45:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(afterCloseSnapshot.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      lastPx: dailyBarClose,
      asOf: '2026-07-13T20:15:00.000Z',
    });
  });

  test('retains the last verified close after a new session completes until Yahoo publishes it', async () => {
    const now = new Date('2026-07-14T20:45:00.000Z');
    const retainedRows = tradingRowsThrough('2025-12-31', '2026-07-10', 20);
    const waiting = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider(),
      now: () => now,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(waiting.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      lastPx: retainedRows.at(-1).close,
      asOf: '2026-07-10T17:00:00.000Z',
    });

    const published = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-14T20:30:00.000Z',
        moveHistoryEnd: '2026-07-13',
      }),
      now: () => now,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(published.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      asOf: '2026-07-14T20:30:00.000Z',
    });
  });

  test('uses the newest verified daily row when Yahoo has two null completed-session bars', async () => {
    const priorRows = tradingRowsThrough('2025-12-31', '2026-07-10', 20);
    const ambiguousCurrentPrice = 75.0326;
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({
        moveAsOf: '2026-07-15T19:30:00.000Z',
        moveHistoryRows: [
          ...priorRows,
          { date: '2026-07-13', close: null },
          { date: '2026-07-14', close: null },
          { date: '2026-07-15', close: ambiguousCurrentPrice },
        ],
        movePrice: ambiguousCurrentPrice,
      }),
      now: () => new Date('2026-07-15T20:00:00.000Z'),
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.MOVE).toMatchObject({
      availability: 'historical',
      freshness: 'historical',
      quoteMode: 'end-of-day',
      lastPx: priorRows.at(-1).close,
      day1Ago: priorRows.at(-2).close,
      asOf: '2026-07-10T17:00:00.000Z',
    });
    expect(snapshot.MOVE.lastPx).not.toBe(ambiguousCurrentPrice);
  });

  test('retains verified history for stale metadata and rejects responses with no verified history', async () => {
    const now = () => new Date('2026-07-14T14:00:00.000Z');
    const retainedCases = [
      buildFakeProvider({ moveAsOf: '2026-07-10T20:30:00.000Z' }),
      buildFakeProvider({ invalidMove: true }),
      buildFakeProvider({ moveHistoryEnd: '2026-07-09' }),
    ];

    const retainedSnapshots = await Promise.all(retainedCases.map((httpClient) => (
      createVolatilitySnapshotService({ httpClient, now, logger: { warn: jest.fn() } }).fetchSnapshot()
    )));
    expect(retainedSnapshots.map((snapshot) => snapshot.MOVE.availability))
      .toEqual(['historical', 'historical', 'historical']);
    expect(retainedSnapshots.map((snapshot) => snapshot.MOVE.asOf)).toEqual([
      '2026-07-10T17:00:00.000Z',
      '2026-07-10T17:00:00.000Z',
      '2026-07-09T17:00:00.000Z',
    ]);

    const rejectedSnapshots = await Promise.all([
      buildFakeProvider({ invalidMove: true, moveHistoryRows: [] }),
      buildFakeProvider({ failMove: true }),
    ].map((httpClient) => (
      createVolatilitySnapshotService({ httpClient, now, logger: { warn: jest.fn() } }).fetchSnapshot()
    )));
    expect(rejectedSnapshots.map((snapshot) => snapshot.MOVE.error)).toEqual([
      'invalid_quote',
      'provider_error',
    ]);
    rejectedSnapshots.forEach((snapshot) => {
      expect(snapshot.MOVE).toMatchObject({ availability: 'unavailable', lastPx: null });
    });
  });

  test('recovers an official daily close when spot fails on the first request', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failSymbols: new Set(['RVX']) }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('partial');
    expect(snapshot.RVX).toMatchObject({ availability: 'reference', freshness: 'refresh-delayed',
      lastPx: tradingRowsThrough('2025-12-31', '2026-07-10', 20).at(-1).close,
      asOf: '2026-07-10', asOfPrecision: 'date', marketSessionDate: '2026-07-10',
      displayOnly: true, executable: false });
    expect(snapshot.VIX.availability).toBe('available');
  });

  test('retries a transient provider request before degrading the row', async () => {
    const stableProvider = buildFakeProvider();
    let vxnQuoteAttempts = 0;
    const httpClient = {
      get: jest.fn(async (...args) => {
        if (args[0].includes('quotes/_VXN.json')) {
          vxnQuoteAttempts += 1;
          if (vxnQuoteAttempts === 1) {
            throw Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' });
          }
        }
        return stableProvider.get(...args);
      }),
    };

    const snapshot = await createVolatilitySnapshotService({
      httpClient,
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(vxnQuoteAttempts).toBe(2);
    expect(snapshot.NazVol).toMatchObject({
      availability: 'available',
      freshness: 'current',
      lastPx: 200,
    });
  });

  test('keeps dated provider observations after intraday freshness expires', async () => {
    const duringMarket = new Date('2026-07-13T18:00:00.000Z');
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ staleCboe: true }),
      now: () => duringMarket,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.VIX).toMatchObject({
      availability: 'reference',
      freshness: 'refresh-delayed',
      lastPx: 200,
      asOf: '2026-07-13T16:00:00.000Z',
      lastVerifiedAt: '2026-07-13T16:00:00.000Z',
      displayDelayed: true,
      executable: false,
    });
    expect(snapshot.VXEEM).toMatchObject({
      availability: 'reference', freshness: 'refresh-delayed', lastPx: 200,
    });
  });

  test('reports a complete outage without any cached spot fallback', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failAll: true }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('unavailable');
    for (const name of ['VIX', 'VVIX', 'RVX', 'NazVol', 'VXEEM', 'GVZ', 'OVX', 'BITVX', 'MOVE']) {
      expect(snapshot[name].availability).toBe('unavailable');
      expect(snapshot[name].lastPx).toBeNull();
    }
  });

  test('keeps a formerly verified row when its next spot refresh fails', async () => {
    const failSymbols = new Set();
    const service = createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failSymbols }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    });

    expect((await service.fetchSnapshot()).RVX.availability).toBe('available');

    failSymbols.add('RVX');
    const second = await service.fetchSnapshot();
    expect(second.RVX).toMatchObject({
      availability: 'reference',
      freshness: 'refresh-delayed',
      lastPx: 200,
      asOf: '2026-07-13T20:00:00.000Z',
      lastVerifiedAt: '2026-07-13T20:00:00.000Z',
      displayDelayed: true,
      executable: false,
    });
  });

  test('never expires the last verified overview row on later refreshes', async () => {
    const failSymbols = new Set();
    let currentTime = afterClose;
    const service = createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failSymbols }),
      now: () => currentTime,
      logger: { warn: jest.fn() },
    });

    await service.fetchSnapshot();
    currentTime = new Date(afterClose.getTime() + (60 * 24 * 60 * 60 * 1000));
    failSymbols.add('RVX');

    const expired = await service.fetchSnapshot();
    expect(expired.RVX).toMatchObject({
      availability: 'reference',
      freshness: 'refresh-delayed',
      lastPx: 200,
      asOf: '2026-07-13T20:00:00.000Z',
      lastVerifiedAt: '2026-07-13T20:00:00.000Z',
      displayDelayed: true,
      executable: false,
    });
    expect(expired.RVX).not.toHaveProperty('retainedUntil');
  });

  test('preserves every numeric field and original observation through complete outages and process restarts', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volatility-reference-'));
    const referenceFilePath = path.join(dataDir, 'last-verified-v1.json');
    try {
      let provider = buildFakeProvider();
      let currentTime = afterClose;
      const options = { referenceFilePath, now: () => currentTime, logger: { warn: jest.fn() },
        httpClient: { get: (...args) => provider.get(...args) } };
      const service = createVolatilitySnapshotService(options);
      const verified = await service.fetchSnapshot();
      expect(fs.existsSync(referenceFilePath)).toBe(true);
      provider = buildFakeProvider({ failAll: true });
      currentTime = new Date('2026-09-25T18:00:00.000Z');
      for (const snapshot of [await service.fetchSnapshot(),
        await createVolatilitySnapshotService(options).fetchSnapshot()]) {
        expect(snapshot.status).toBe('partial');
        for (const name of ['VIX', 'VVIX', 'RVX', 'NazVol', 'VXEEM', 'GVZ', 'OVX', 'BITVX', 'MOVE']) {
          const numericFields = Object.keys(verified[name]).filter((field) => typeof verified[name][field] === 'number');
          expect(Object.fromEntries(numericFields.map((field) => [field, snapshot[name][field]])))
            .toEqual(Object.fromEntries(numericFields.map((field) => [field, verified[name][field]])));
          expect(snapshot[name]).toMatchObject({ source: verified[name].source, asOf: verified[name].asOf,
            lastVerifiedAt: verified[name].asOf, availability: 'reference', freshness: 'refresh-delayed',
            displayDelayed: true, displayOnly: true, executable: false });
          expect(snapshot[name]).not.toHaveProperty('retainedUntil');
        }
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('replaces references with newer verified observations while ignoring older provider responses', async () => {
    let provider = buildFakeProvider();
    let currentTime = new Date('2026-07-13T20:05:00.000Z');
    const service = createVolatilitySnapshotService({
      httpClient: { get: (...args) => provider.get(...args) }, now: () => currentTime, logger: { warn: jest.fn() },
    });
    await service.fetchSnapshot();
    provider = buildFakeProvider({ failAll: true });
    expect((await service.fetchSnapshot()).VIX.availability).toBe('reference');
    provider = buildFakeProvider({ cboeAsOf: '2026-07-13T15:55:00-04:00' });
    expect((await service.fetchSnapshot()).VIX).toMatchObject({ availability: 'reference',
      asOf: '2026-07-13T20:00:00.000Z', retentionReason: 'older_provider_observation' });
    currentTime = new Date('2026-07-13T20:10:00.000Z');
    provider = buildFakeProvider({ cboeAsOf: '2026-07-13T16:09:00-04:00' });
    const recovered = await service.fetchSnapshot();
    expect(recovered.VIX).toMatchObject({ availability: 'available', freshness: 'current',
      asOf: '2026-07-13T20:09:00.000Z' });
    expect(recovered.VIX).not.toHaveProperty('refreshDelayed');
    expect(recovered.VIX).not.toHaveProperty('lastVerifiedAt');
  });

  test('history refresh failures retain the entire verified row instead of erasing its changes', async () => {
    let failHistory = false;
    const provider = buildFakeProvider();
    const service = createVolatilitySnapshotService({ historyCacheTtlMs: 0,
      httpClient: { get: (url, config) => {
        if (failHistory && url.includes('daily_prices/')) throw new Error('history offline');
        return provider.get(url, config);
      } }, now: () => afterClose, logger: { warn: jest.fn() },
    });
    const first = await service.fetchSnapshot();
    failHistory = true;
    expect((await service.fetchSnapshot()).RVX).toMatchObject({ lastPx: first.RVX.lastPx,
      dayChangePct: first.RVX.dayChangePct, sixMonthChangePct: first.RVX.sixMonthChangePct,
      asOf: first.RVX.asOf, availability: 'reference', retentionReason: 'history_refresh_unavailable' });
  });

  test('partial history preserves prior periods only for the exact same provider observation', async () => {
    let truncated = false;
    let revisedPrice = null;
    const provider = buildFakeProvider();
    const service = createVolatilitySnapshotService({ historyCacheTtlMs: 0,
      httpClient: { get: async (url, config) => {
        const response = await provider.get(url, config);
        if (truncated && url.includes('daily_prices/')) {
          response.data = historyCsv(tradingRowsThrough('2026-07-09', '2026-07-10', 149));
        }
        if (revisedPrice != null && url.includes('quotes/')) response.data.data.current_price = revisedPrice;
        return response;
      } }, now: () => afterClose, logger: { warn: jest.fn() },
    });
    const first = await service.fetchSnapshot();
    truncated = true;
    const sameObservation = await service.fetchSnapshot();
    expect(sameObservation.VIX).toMatchObject({ asOf: first.VIX.asOf, lastPx: first.VIX.lastPx,
      fifteenDayChangePct: first.VIX.fifteenDayChangePct, monthChangePct: first.VIX.monthChangePct,
      threeMonthChangePct: first.VIX.threeMonthChangePct, sixMonthChangePct: first.VIX.sixMonthChangePct });
    revisedPrice = 201;
    const revision = await service.fetchSnapshot();
    expect(revision.VIX).toMatchObject({ asOf: first.VIX.asOf, lastPx: 201,
      fifteenDayChangePct: null, monthChangePct: null, threeMonthChangePct: null, sixMonthChangePct: null });
  });

  test('keeps a verified standalone level when history has too few observations to calculate changes', async () => {
    const provider = buildFakeProvider({ failSymbols: new Set(['VIX']) });
    const service = createVolatilitySnapshotService({
      httpClient: { get: (url, config) => url.includes('VIX_History.csv')
        ? Promise.resolve({ data: historyCsv([{ date: '2026-07-10', close: 19.5 }]) }) : provider.get(url, config),
      }, now: () => afterClose, logger: { warn: jest.fn() },
    });
    expect((await service.fetchSnapshot()).VIX).toMatchObject({ availability: 'reference',
      asOf: '2026-07-10', lastPx: 19.5, dayChangePct: null, sixMonthChangePct: null });
  });

  test.each([{ mock: true }, { seeded: true }, { synthetic: true }, { inferred: true },
    { cacheOnly: true }, { fromCache: true }, { connected: false }, { providerStatus: 'offline' }])(
    'does not replace verified evidence with a flagged provider response: %j', async (flags) => {
      let rejected = false;
      const provider = buildFakeProvider();
      const service = createVolatilitySnapshotService({ historyCacheTtlMs: 0,
        httpClient: { get: async (url, config) => {
          if (rejected && url.includes('daily_prices/')) throw new Error('history offline');
          const response = await provider.get(url, config);
          if (rejected && url.includes('quotes/')) {
            response.data.data = { ...response.data.data, ...flags, current_price: 999,
              last_trade_time: '2026-07-13T16:10:00-04:00' };
          }
          if (rejected && url.includes('%5EMOVE')) Object.assign(response.data.chart.result[0].meta, flags,
            { regularMarketPrice: 999 });
          return response;
        } }, now: () => afterClose, logger: { warn: jest.fn() },
      });
      const first = await service.fetchSnapshot();
      rejected = true;
      const retained = await service.fetchSnapshot();
      for (const name of ['VIX', 'VVIX', 'RVX', 'MOVE']) {
        expect(retained[name]).toMatchObject({ lastPx: first[name].lastPx, asOf: first[name].asOf,
          availability: 'reference', executable: false });
      }
    },
  );

  test('ignores invalid persisted evidence without manufacturing cold-start values', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volatility-reference-'));
    const referenceFilePath = path.join(dataDir, 'last-verified-v1.json');
    try {
      fs.writeFileSync(referenceFilePath, JSON.stringify({ schemaVersion: 1, rows: {
        VIX: { source: 'cboe', availability: 'available', freshness: 'current', lastPx: 999,
          asOf: '2026-07-13T20:00:00.000Z', mock: true },
        VVIX: { source: 'cboe', availability: 'available', freshness: 'current', lastPx: 999, asOf: 'invalid' },
        RVX: { source: 'cboe', availability: 'available', freshness: 'current', lastPx: 999,
          asOf: '2027-07-13T20:00:00.000Z' },
      } }));
      const snapshot = await createVolatilitySnapshotService({ referenceFilePath,
        httpClient: buildFakeProvider({ failAll: true }), now: () => afterClose, logger: { warn: jest.fn() },
      }).fetchSnapshot();
      for (const name of ['VIX', 'VVIX', 'RVX']) expect(snapshot[name].lastPx).toBeNull();
      expect(snapshot.status).toBe('unavailable');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('an early close ends the index session at 13:15 New York time', () => {
    // Friday after Thanksgiving 2026; New York is UTC-5.
    expect([
      '2026-11-27T17:59:00Z', '2026-11-27T18:14:00Z', '2026-11-27T18:15:00Z', '2026-11-27T20:00:00Z',
      '2026-12-24T18:14:00Z', '2026-12-24T18:15:00Z',
    ].map((date) => isUsMarketOpen(new Date(date)))).toEqual([true, true, false, false, true, false]);
    expect(mostRecentCompletedTradingDateKey(new Date('2026-11-27T18:14:00Z'))).toBe('2026-11-25');
    expect(mostRecentCompletedTradingDateKey(new Date('2026-11-27T18:15:00Z'))).toBe('2026-11-27');
    // A regular session still completes at 16:15.
    expect(mostRecentCompletedTradingDateKey(new Date('2026-11-10T21:14:00Z'))).toBe('2026-11-09');
    expect(mostRecentCompletedTradingDateKey(new Date('2026-11-10T21:15:00Z'))).toBe('2026-11-10');
  });
});
