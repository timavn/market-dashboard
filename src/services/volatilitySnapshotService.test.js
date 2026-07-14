const {
  addCalendarDays,
  combineCurrentQuote,
  computeVolatilityMetrics,
  createVolatilitySnapshotService,
  isTradingDateKey,
  parseCboeHistoryCsv,
  percentageChange,
} = require('./volatilitySnapshotService.cjs');

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
                : '2026-07-13T16:00:00-04:00',
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

  test('uses fixed trading-session offsets and the prior year-end close', () => {
    const rows = tradingRows('2025-12-31', 130, 100);
    const metrics = computeVolatilityMetrics(rows);
    const last = rows.at(-1).close;

    expect(metrics).toMatchObject({
      lastPx: last,
      day1Ago: rows.at(-2).close,
      week1Ago: rows.at(-6).close,
      week4Ago: rows.at(-22).close,
      dayChangePct: percentageChange(last, rows.at(-2).close),
      weekChangePct: percentageChange(last, rows.at(-6).close),
      monthChangePct: percentageChange(last, rows.at(-22).close),
      threeMonthChangePct: percentageChange(last, rows.at(-64).close),
      sixMonthChangePct: percentageChange(last, rows.at(-127).close),
      ytdChangePct: percentageChange(last, rows[0].close),
    });
  });

  test('returns null for periods without enough history instead of using the oldest value', () => {
    const metrics = computeVolatilityMetrics(tradingRows('2026-06-01', 10, 10));
    expect(metrics.weekChangePct).not.toBeNull();
    expect(metrics.monthChangePct).toBeNull();
    expect(metrics.threeMonthChangePct).toBeNull();
    expect(metrics.sixMonthChangePct).toBeNull();
    expect(metrics.ytdChangePct).toBeNull();
  });
});

describe('createVolatilitySnapshotService', () => {
  const afterClose = new Date('2026-07-13T20:45:00.000Z');

  test('returns current Cboe rows and a validated historical MOVE row', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider(),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('partial');
    expect(snapshot.RVX).toMatchObject({
      lastPx: 200,
      availability: 'available',
      freshness: 'current',
      source: 'cboe',
      quoteMode: 'delayed',
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

  test('withholds the prior close after a new session completes until Yahoo publishes it', async () => {
    const now = new Date('2026-07-14T20:45:00.000Z');
    const waiting = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider(),
      now: () => now,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();
    expect(waiting.MOVE).toMatchObject({
      availability: 'unavailable',
      freshness: 'stale',
      error: 'stale_quote',
      lastPx: null,
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

  test('rejects obsolete, malformed, failed, and incomplete MOVE responses', async () => {
    const now = () => new Date('2026-07-14T14:00:00.000Z');
    const cases = [
      buildFakeProvider({ moveAsOf: '2026-07-10T20:30:00.000Z' }),
      buildFakeProvider({ invalidMove: true }),
      buildFakeProvider({ failMove: true }),
      buildFakeProvider({ moveHistoryEnd: '2026-07-09' }),
    ];

    const snapshots = await Promise.all(cases.map((httpClient) => (
      createVolatilitySnapshotService({ httpClient, now, logger: { warn: jest.fn() } }).fetchSnapshot()
    )));

    expect(snapshots.map((snapshot) => snapshot.MOVE.error)).toEqual([
      'stale_quote',
      'invalid_quote',
      'provider_error',
      'incomplete_history',
    ]);
    snapshots.forEach((snapshot) => {
      expect(snapshot.MOVE).toMatchObject({ availability: 'unavailable', lastPx: null });
    });
  });

  test('marks only a failed provider row unavailable and reports a partial snapshot', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failSymbols: new Set(['RVX']) }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('partial');
    expect(snapshot.RVX.availability).toBe('unavailable');
    expect(snapshot.RVX.lastPx).toBeNull();
    expect(snapshot.VIX.availability).toBe('available');
  });

  test('marks stale market-hours quotes unavailable', async () => {
    const duringMarket = new Date('2026-07-13T18:00:00.000Z');
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ staleCboe: true }),
      now: () => duringMarket,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.VIX).toMatchObject({
      availability: 'unavailable',
      freshness: 'stale',
      lastPx: null,
    });
  });

  test('reports a complete outage without any cached spot fallback', async () => {
    const snapshot = await createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failAll: true }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    }).fetchSnapshot();

    expect(snapshot.status).toBe('unavailable');
    for (const name of ['VIX', 'VVIX', 'RVX', 'NazVol', 'GVZ', 'OVX', 'MOVE']) {
      expect(snapshot[name].availability).toBe('unavailable');
      expect(snapshot[name].lastPx).toBeNull();
    }
  });

  test('clears a formerly available row when its next spot refresh fails', async () => {
    const failSymbols = new Set();
    const service = createVolatilitySnapshotService({
      httpClient: buildFakeProvider({ failSymbols }),
      now: () => afterClose,
      logger: { warn: jest.fn() },
    });

    const first = await service.fetchSnapshot();
    expect(first.RVX.availability).toBe('available');

    failSymbols.add('RVX');
    const second = await service.fetchSnapshot();
    expect(second.RVX).toMatchObject({ availability: 'unavailable', lastPx: null });
  });
});
