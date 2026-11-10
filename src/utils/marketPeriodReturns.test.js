const {
  computePeriodBpsFromCloses,
  computePeriodPercentsFromCloses,
  computeSpreadBpsDeltas,
} = require('./marketPeriodReturns.cjs');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);
const dateKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

// One bar per listed day; `hourUtc` places the bar inside its UTC day.
function series(start, end, { weekdaysOnly = true, hourUtc = 14.5, closeFor = (index) => 1000 + index } = {}) {
  const rows = [];
  for (let day = dayStart(start); day <= dayStart(end); day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    rows.push({ t: day + (hourUtc * HOUR_MS), close: closeFor(rows.length, dateKey(day)), date: dateKey(day) });
  }
  return rows;
}
const closeOn = (rows, date) => rows.find((row) => row.date === date).close;
const pct = (last, ref) => Math.round((((last / ref) - 1) * 100) * 100) / 100;

describe('period returns from daily closes', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('MTD, QTD and YTD start from the last close before the period', () => {
    const rows = series('2025-11-03', '2026-11-09');
    const last = rows[rows.length - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.mtdChangePct).toBe(pct(last, closeOn(rows, '2026-10-30')));
    expect(result.qtdChangePct).toBe(pct(last, closeOn(rows, '2026-09-30')));
    expect(result.ytdChangePct).toBe(pct(last, closeOn(rows, '2025-12-31')));
    // The first session of the month is part of the month's return.
    expect(result.mtdChangePct).not.toBe(pct(last, closeOn(rows, '2026-11-02')));
    expect(result.mtdChangeValue).toBe(last - closeOn(rows, '2026-10-30'));
  });

  test('the period is the latest bar\'s, whatever the wall clock says', () => {
    const rows = series('2025-12-01', '2026-12-31');
    const last = rows[rows.length - 1].close;
    // Evening of 31 December in Pacific time is already the next UTC year.
    jest.useFakeTimers().setSystemTime(new Date('2027-01-01T03:00:00Z'));
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.ytdChangePct).toBe(pct(last, closeOn(rows, '2025-12-31')));
    expect(result.mtdChangePct).toBe(pct(last, closeOn(rows, '2026-11-30')));
    expect(result.qtdChangePct).toBe(pct(last, closeOn(rows, '2026-09-30')));
  });

  test('a five-day exchange steps back whole sessions', () => {
    const rows = series('2025-11-03', '2026-11-09');
    const n = rows.length;
    const last = rows[n - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.weekChangePct).toBe(pct(last, rows[n - 6].close));
    expect(result.fifteenDayChangePct).toBe(pct(last, rows[n - 16].close));
    expect(result.monthChangePct).toBe(pct(last, rows[n - 22].close));
    expect(result.threeMonthChangePct).toBe(pct(last, rows[n - 64].close));
    expect(result.sixMonthChangePct).toBe(pct(last, rows[n - 127].close));
  });

  test('a series printing every calendar day uses calendar windows', () => {
    const rows = series('2025-11-10', '2026-11-10', { weekdaysOnly: false, hourUtc: 0, closeFor: (index) => 50000 + (index * 10) });
    const last = rows[rows.length - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.weekChangePct).toBe(pct(last, closeOn(rows, '2026-11-03')));
    expect(result.fifteenDayChangePct).toBe(pct(last, closeOn(rows, '2026-10-26')));
    expect(result.thirtyDayChangePct).toBe(pct(last, closeOn(rows, '2026-10-11')));
    expect(result.monthChangePct).toBe(pct(last, closeOn(rows, '2026-10-10')));
    expect(result.threeMonthChangePct).toBe(pct(last, closeOn(rows, '2026-08-10')));
    expect(result.sixMonthChangePct).toBe(pct(last, closeOn(rows, '2026-05-10')));
    // Not 21 bars back, which is only three weeks of a seven-day market.
    expect(result.monthChangePct).not.toBe(pct(last, rows[rows.length - 22].close));
    expect(result.mtdChangePct).toBe(pct(last, closeOn(rows, '2026-10-31')));
  });

  test('a window longer than the history has no value', () => {
    const rows = series('2026-09-15', '2026-11-09');
    expect(rows.length).toBe(40);
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.weekChangePct).not.toBeNull();
    expect(result.monthChangePct).not.toBeNull();
    expect(result.thirtyDayChangePct).not.toBeNull();
    expect(result.threeMonthChangePct).toBeNull();
    expect(result.sixMonthChangePct).toBeNull();
    expect(result.ninetyDayChangePct).toBeNull();
    expect(result.threeMonthChangeValue).toBeNull();
    expect(result.oneYearChangePct).toBeNull();
  });

  test('a listing inside the period is measured from its first close', () => {
    const rows = series('2026-11-03', '2026-11-09');
    const last = rows[rows.length - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.mtdChangePct).toBe(pct(last, rows[0].close));
    expect(result.qtdChangePct).toBe(pct(last, rows[0].close));
    expect(result.ytdChangePct).toBe(pct(last, rows[0].close));
  });

  test('sessions are dated on the exchange calendar when its UTC offset is known', () => {
    // Sydney opens at 23:00 UTC on the previous day during summer time.
    const local = series('2026-10-01', '2026-12-03', { hourUtc: -1 });
    const last = local[local.length - 1].close;
    const sydney = local.map(({ t, close }) => ({ t, close }));
    sydney.utcOffsetMs = 11 * HOUR_MS;

    expect(computePeriodPercentsFromCloses(sydney).mtdChangePct).toBe(pct(last, closeOn(local, '2026-11-30')));
    // Without the offset the 1 December session is dated 30 November.
    expect(computePeriodPercentsFromCloses(local.map(({ t, close }) => ({ t, close }))).mtdChangePct)
      .toBe(pct(last, closeOn(local, '2026-12-01')));
  });

  test('too little data returns nothing', () => {
    expect(computePeriodPercentsFromCloses(null)).toBeNull();
    expect(computePeriodPercentsFromCloses([{ t: 1, close: 10 }])).toBeNull();
    expect(computePeriodPercentsFromCloses([{ t: 1, close: 10 }, { t: 2, close: 0 }])).toBeNull();
  });
});

describe('spread deltas in basis points', () => {
  test('period deltas use the close before the period and whole sessions', () => {
    const rows = series('2025-11-03', '2026-11-09', { closeFor: (index) => 40 + (index * 0.3) });
    const n = rows.length;
    const last = rows[n - 1].close;
    const delta = (ref) => Math.round((last - ref) * 10) / 10;
    const result = computeSpreadBpsDeltas(rows);

    expect(result.dayDeltaBps).toBe(delta(rows[n - 2].close));
    expect(result.weekDeltaBps).toBe(delta(rows[n - 6].close));
    expect(result.monthDeltaBps).toBe(delta(rows[n - 22].close));
    expect(result.mtdDeltaBps).toBe(delta(closeOn(rows, '2026-10-30')));
    expect(result.qtdDeltaBps).toBe(delta(closeOn(rows, '2026-09-30')));
    expect(result.ytdDeltaBps).toBe(delta(closeOn(rows, '2025-12-31')));
    expect(result.latestBps).toBe(Math.round(last * 10) / 10);
    expect(result.asOf).toBe(new Date(rows[n - 1].t).toISOString());
  });

  test('a short paired history leaves the longer windows empty', () => {
    const rows = series('2026-09-15', '2026-11-09', { closeFor: (index) => 40 + index });
    const result = computeSpreadBpsDeltas(rows);

    expect(result.weekDeltaBps).not.toBeNull();
    expect(result.threeMonthDeltaBps).toBeNull();
    expect(result.sixMonthDeltaBps).toBeNull();
    // The year began before this history: measured from its first close.
    expect(result.ytdDeltaBps).toBe(Math.round((rows[rows.length - 1].close - rows[0].close) * 10) / 10);
  });
});

describe('rate changes in basis points', () => {
  const yields = (start, end) => series(start, end, { hourUtc: 0, closeFor: (index) => 4 + (index * 0.001) });
  const bps = (latest, ref) => Math.round((latest - ref) * 1000) / 10;

  test('a daily series measures the year from the prior year-end observation', () => {
    const rows = yields('2025-06-02', '2026-11-09');
    const latest = rows[rows.length - 1].close;
    const result = computePeriodBpsFromCloses(rows);

    expect(result.ytdChangeBps).toBe(bps(latest, closeOn(rows, '2025-12-31')));
    expect(result.ytdChangeBps).not.toBe(bps(latest, closeOn(rows, '2026-01-01')));
    expect(result.monthChangeBps).toBe(bps(latest, closeOn(rows, '2026-10-09')));
  });

  test('a series that starts inside the year uses its first observation', () => {
    const rows = yields('2026-01-02', '2026-11-09');
    const latest = rows[rows.length - 1].close;

    expect(computePeriodBpsFromCloses(rows).ytdChangeBps).toBe(bps(latest, rows[0].close));
  });

  test('monthly observations keep the first observation of the year', () => {
    const months = ['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'];
    const rows = months.map((date, index) => ({ t: dayStart(date), close: 3 + (index * 0.1) }));
    const result = computePeriodBpsFromCloses(rows, { observationFrequency: 'monthly' });

    expect(result.ytdChangeBps).toBe(bps(rows[5].close, rows[3].close));
    expect(result.dayChangeBps).toBeNull();
  });
});
