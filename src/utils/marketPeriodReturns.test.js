const {
  computePeriodBpsFromCloses,
  computePeriodPercentsFromCloses,
  computeSpreadBpsDeltas,
} = require('./marketPeriodReturns.cjs');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);
const dateKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

// One bar per listed day; `hourUtc` places the bar inside its UTC day and may
// depend on the date. `closed` lists exchange holidays.
function series(start, end, {
  weekdaysOnly = true, hourUtc = 14.5, closeFor = (index) => 1000 + index, closed = [],
} = {}) {
  const rows = [];
  for (let day = dayStart(start); day <= dayStart(end); day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    if (closed.includes(dateKey(day))) continue;
    const hour = typeof hourUtc === 'function' ? hourUtc(dateKey(day)) : hourUtc;
    rows.push({ t: day + (hour * HOUR_MS), close: closeFor(rows.length, dateKey(day)), date: dateKey(day) });
  }
  return rows;
}
// New York opens at 13:30 UTC on summer time and 14:30 on winter time, and
// Yahoo stamps a daily bar with its session open.
const newYorkOpenUtc = (date) => (date >= '2026-03-08' && date < '2026-11-01' ? 13.5 : 14.5);
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

  test('week, month and year windows are calendar dates; day counts are sessions', () => {
    const rows = series('2025-11-03', '2026-11-09');
    const n = rows.length;
    const last = rows[n - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    // Monday 9 November 2026: the last close on or before the same date earlier.
    expect(result.weekChangePct).toBe(pct(last, closeOn(rows, '2026-11-02')));
    expect(result.monthChangePct).toBe(pct(last, closeOn(rows, '2026-10-09')));
    expect(result.threeMonthChangePct).toBe(pct(last, closeOn(rows, '2026-08-07'))); // 9 Aug is a Sunday
    expect(result.sixMonthChangePct).toBe(pct(last, closeOn(rows, '2026-05-08'))); // 9 May is a Saturday
    expect(result.oneYearChangePct).toBe(pct(last, closeOn(rows, '2025-11-07'))); // never the Monday after
    // Not 63 and 126 sessions back, which start two and one sessions later here.
    expect(result.threeMonthChangePct).not.toBe(pct(last, rows[n - 64].close));
    expect(result.sixMonthChangePct).not.toBe(pct(last, rows[n - 127].close));

    expect(result.fifteenDayChangePct).toBe(pct(last, rows[n - 16].close));
    expect(result.thirtyDayChangePct).toBe(pct(last, rows[n - 31].close));
    expect(result.ninetyDayChangePct).toBe(pct(last, rows[n - 91].close));
  });

  test('a holiday week is still measured Friday to Friday', () => {
    // Labor Day, Monday 7 September 2026: four sessions that week.
    const rows = series('2026-06-01', '2026-09-11', { closed: ['2026-09-07'] });
    const n = rows.length;
    const last = rows[n - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.weekChangePct).toBe(pct(last, closeOn(rows, '2026-09-04')));
    // Five sessions back is Thursday 3 September, a day too far.
    expect(rows[n - 6].date).toBe('2026-09-03');
    expect(result.weekChangePct).not.toBe(pct(last, rows[n - 6].close));
  });

  test('a clock change between the two dates does not move the window by a session', () => {
    const rows = series('2025-11-03', '2026-06-15', { hourUtc: newYorkOpenUtc });
    const result = computePeriodPercentsFromCloses(rows);
    const last = rows[rows.length - 1].close;

    // Latest bar stamped 13:30 UTC; the bars one, three and six months earlier are
    // stamped 14:30 on winter time. An instant comparison would land a session early.
    expect(result.sixMonthChangePct).toBe(pct(last, closeOn(rows, '2025-12-15')));
    const april = series('2025-11-03', '2026-04-06', { hourUtc: newYorkOpenUtc });
    const aprilLast = april[april.length - 1].close;
    expect(computePeriodPercentsFromCloses(april).monthChangePct).toBe(pct(aprilLast, closeOn(april, '2026-03-06')));
    expect(computePeriodPercentsFromCloses(april).threeMonthChangePct).toBe(pct(aprilLast, closeOn(april, '2026-01-06')));
    // And the other way: a winter bar looking back at summer-time bars.
    const november = series('2026-03-02', '2026-11-09', { hourUtc: newYorkOpenUtc });
    const novemberLast = november[november.length - 1].close;
    expect(computePeriodPercentsFromCloses(november).monthChangePct)
      .toBe(pct(novemberLast, closeOn(november, '2026-10-09')));
  });

  test('a month window from a month end clamps to the shorter month', () => {
    const rows = series('2024-06-03', '2025-03-31');
    const last = rows[rows.length - 1].close;
    const result = computePeriodPercentsFromCloses(rows);

    expect(result.monthChangePct).toBe(pct(last, closeOn(rows, '2025-02-28')));
    expect(result.threeMonthChangePct).toBe(pct(last, closeOn(rows, '2024-12-31')));
    expect(result.sixMonthChangePct).toBe(pct(last, closeOn(rows, '2024-09-30')));
  });

  test('a date inside a long exchange holiday reaches back to the close before it', () => {
    // Golden Week: no session from 1 to 8 October 2026.
    const closed = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'];
    const rows = series('2026-06-01', '2026-10-15', { closed });
    const last = rows[rows.length - 1].close;

    // A week before Thursday 15 October is 8 October; the last close is 30 September.
    expect(computePeriodPercentsFromCloses(rows).weekChangePct).toBe(pct(last, closeOn(rows, '2026-09-30')));
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
    // Auckland opens at 21:00 UTC on the previous day during its summer time.
    const local = series('2026-10-01', '2026-12-03', { hourUtc: -3 });
    const last = local[local.length - 1].close;
    const auckland = local.map(({ t, close }) => ({ t, close }));
    auckland.utcOffsetMs = 13 * HOUR_MS;

    expect(computePeriodPercentsFromCloses(auckland).mtdChangePct).toBe(pct(last, closeOn(local, '2026-11-30')));
    // Without the offset the 1 December session is dated 30 November.
    expect(computePeriodPercentsFromCloses(local.map(({ t, close }) => ({ t, close }))).mtdChangePct)
      .toBe(pct(last, closeOn(local, '2026-12-01')));
  });

  test('a bar stamped at local midnight keeps its date across a clock change', () => {
    // Crude futures: 04:00 UTC on New York summer time, 05:00 on winter time.
    // The series carries one offset, the current one (winter, UTC-5).
    const futures = series('2025-11-03', '2026-11-16', { hourUtc: (date) => newYorkOpenUtc(date) - 9.5 });
    const crude = futures.map(({ t, close }) => ({ t, close }));
    crude.utcOffsetMs = -5 * HOUR_MS;
    const last = futures[futures.length - 1].close;
    const result = computePeriodPercentsFromCloses(crude);

    // The quarter starts from 30 September, not from the first close inside it.
    expect(result.qtdChangePct).toBe(pct(last, closeOn(futures, '2026-09-30')));
    expect(result.threeMonthChangePct).toBe(pct(last, closeOn(futures, '2026-08-14'))); // 16 Aug is a Sunday
    expect(result.sixMonthChangePct).toBe(pct(last, closeOn(futures, '2026-05-15'))); // 16 May is a Saturday

    // A currency pair: 23:00 UTC the evening before on London summer time, midnight on winter time.
    const londonMidnightUtc = (date) => (date >= '2026-03-29' && date < '2026-10-25' ? -1 : 0);
    const pair = series('2025-11-03', '2026-11-16', { hourUtc: londonMidnightUtc });
    const fx = pair.map(({ t, close }) => ({ t, close }));
    fx.utcOffsetMs = 0;
    const fxLast = pair[pair.length - 1].close;
    expect(computePeriodPercentsFromCloses(fx).qtdChangePct).toBe(pct(fxLast, closeOn(pair, '2026-09-30')));
    expect(computePeriodPercentsFromCloses(fx).threeMonthChangePct).toBe(pct(fxLast, closeOn(pair, '2026-08-14')));
  });

  test('too little data returns nothing', () => {
    expect(computePeriodPercentsFromCloses(null)).toBeNull();
    expect(computePeriodPercentsFromCloses([{ t: 1, close: 10 }])).toBeNull();
    expect(computePeriodPercentsFromCloses([{ t: 1, close: 10 }, { t: 2, close: 0 }])).toBeNull();
  });
});

describe('spread deltas in basis points', () => {
  test('period deltas use the same dates and sessions as price returns', () => {
    const rows = series('2025-11-03', '2026-11-09', { closeFor: (index) => 40 + (index * 0.3) });
    const n = rows.length;
    const last = rows[n - 1].close;
    const delta = (ref) => Math.round((last - ref) * 10) / 10;
    const result = computeSpreadBpsDeltas(rows);

    expect(result.dayDeltaBps).toBe(delta(rows[n - 2].close));
    expect(result.weekDeltaBps).toBe(delta(closeOn(rows, '2026-11-02')));
    expect(result.fifteenDayDeltaBps).toBe(delta(rows[n - 16].close));
    expect(result.monthDeltaBps).toBe(delta(closeOn(rows, '2026-10-09')));
    expect(result.threeMonthDeltaBps).toBe(delta(closeOn(rows, '2026-08-07')));
    expect(result.sixMonthDeltaBps).toBe(delta(closeOn(rows, '2026-05-08')));
    expect(result.oneYearDeltaBps).toBe(delta(closeOn(rows, '2025-11-07')));
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
