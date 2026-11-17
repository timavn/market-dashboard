'use strict';

/**
 * Period returns for the market overview tables. Pure functions over an
 * ascending series of `{ t: epochMs, close }` rows.
 *
 * - MTD, QTD and YTD compare with the last close before the period starts
 *   (the prior month-, quarter- or year-end close). The period is the one the
 *   latest bar belongs to, never the wall clock.
 * - 1W, 1M, 3M, 6M and 1Y compare with the last close on or before the same
 *   calendar date a week, or that many months, earlier. This is how Hedgeye
 *   states weekly and monthly performance (its "last month" for XLV on the
 *   13 Nov 2026 close was +11.3%: +11.31% from 13 Oct, +6.58% from 21 sessions
 *   back), and a holiday week is still Friday to Friday.
 * - 15D, 30D and 90D count sessions, as a duration stated in days does. A
 *   series that prints every calendar day counts calendar days instead.
 * - Dates are session dates, never instants: a US daily bar is stamped
 *   13:30 UTC in summer and 14:30 in winter, so comparing instants across a
 *   clock change would pick the session before the right one. Futures and FX
 *   bars are stamped at local midnight, an hour either side of it across a
 *   clock change, and are dated with that hour allowed for.
 * - A window longer than the available history has no value.
 */
const { percentageChange } = require('../services/providers/observationChange.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
// The close on or before a date is normally zero to four days earlier. Long
// exchange holidays (Lunar New Year, Golden Week) stay well inside ten.
const PERIOD_START_REFERENCE_MAX_GAP_MS = 10 * DAY_MS;
// A series carries one UTC offset, the current one. A bar from the other side
// of a clock change is therefore an hour out, which moves a bar stamped at
// local midnight (futures, FX) onto the previous day. No daily bar is stamped
// in the last two hours of its own local day, so two hours are allowed.
const SESSION_DATE_TOLERANCE_MS = 2 * 60 * 60 * 1000;
// Windows stated in days: sessions on an exchange, calendar days on a market
// that prints every day.
const DAY_COUNT_OFFSETS = Object.freeze({ fifteenDay: 15, thirtyDay: 30, ninetyDay: 90 });
// Windows stated in weeks, months or years: always calendar dates.
const CALENDAR_DAY_OFFSETS = Object.freeze({ week: 7 });
const CALENDAR_MONTH_OFFSETS = Object.freeze({ month: 1, threeMonth: 3, sixMonth: 6, oneYear: 12 });
// 28 of 28 days for a continuous market; about 20 for a five-day exchange.
const CONTINUOUS_SERIES_MIN_BARS_IN_28_DAYS = 26;

// The same day of the month `months` earlier, clamped to that month's length.
function calendarMonthsBefore(timestamp, months) {
  const date = new Date(timestamp);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + 1, 0,
  )).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return date.getTime();
}

function printsEveryCalendarDay(closes) {
  const latestTime = Number(closes[closes.length - 1]?.t);
  if (!Number.isFinite(latestTime)) return false;
  const windowStart = latestTime - (28 * DAY_MS);
  let bars = 0;
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const timestamp = Number(closes[index]?.t);
    if (!Number.isFinite(timestamp) || timestamp <= windowStart) break;
    bars += 1;
  }
  return bars >= CONTINUOUS_SERIES_MIN_BARS_IN_28_DAYS;
}

// A provider may attach the exchange's UTC offset to the series so a session
// that opens before midnight UTC (Sydney) is dated on its own calendar day.
function utcOffsetMsOf(closes) {
  return Number.isFinite(closes?.utcOffsetMs) ? closes.utcOffsetMs : 0;
}

// The calendar day a bar belongs to on its own exchange, as that day's
// midnight in UTC.
function sessionDay(timestamp, offset) {
  return Math.floor((timestamp + offset + SESSION_DATE_TOLERANCE_MS) / DAY_MS) * DAY_MS;
}

function periodStartReferences(closes) {
  const latestTime = Number(closes[closes.length - 1]?.t);
  if (!Number.isFinite(latestTime)) return { mtd: null, qtd: null, ytd: null };
  const offset = utcOffsetMsOf(closes);
  const latestDate = new Date(sessionDay(latestTime, offset));
  const year = latestDate.getUTCFullYear();
  const month = latestDate.getUTCMonth();
  const starts = {
    mtd: Date.UTC(year, month, 1),
    qtd: Date.UTC(year, Math.floor(month / 3) * 3, 1),
    ytd: Date.UTC(year, 0, 1),
  };
  return Object.fromEntries(Object.entries(starts).map(([period, start]) => {
    let prior = null;
    let first = null;
    for (const row of closes) {
      if (row?.close == null) continue;
      const timestamp = Number(row.t);
      const close = Number(row.close);
      if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
      const day = sessionDay(timestamp, offset);
      if (day < start) prior = { day, close };
      else { first = close; break; }
    }
    if (prior && start - prior.day <= PERIOD_START_REFERENCE_MAX_GAP_MS) return [period, prior.close];
    // No close just before the period (a listing or a data gap): measure from its first close.
    return [period, first];
  }));
}

// The last close whose session date is on or before `targetDay`. A target
// inside a long exchange holiday reaches back to the close before it.
function closeOnOrBeforeDay(closes, targetDay, offset) {
  if (!Number.isFinite(targetDay)) return null;
  let match = null;
  for (const row of closes) {
    if (row?.close == null) continue;
    const timestamp = Number(row.t);
    const close = Number(row.close);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
    const day = sessionDay(timestamp, offset);
    if (day > targetDay) break;
    match = { day, close };
  }
  if (!match || targetDay - match.day > PERIOD_START_REFERENCE_MAX_GAP_MS) return null;
  return match.close;
}

function periodReferences(closes) {
  const latestTime = Number(closes[closes.length - 1]?.t);
  const offset = utcOffsetMsOf(closes);
  const latestDay = Number.isFinite(latestTime) ? sessionDay(latestTime, offset) : NaN;
  const onOrBefore = (targetDay) => closeOnOrBeforeDay(closes, targetDay, offset);
  const continuous = printsEveryCalendarDay(closes);
  const references = {};
  for (const [name, days] of Object.entries(CALENDAR_DAY_OFFSETS)) {
    references[name] = onOrBefore(latestDay - (days * DAY_MS));
  }
  for (const [name, months] of Object.entries(CALENDAR_MONTH_OFFSETS)) {
    references[name] = Number.isFinite(latestDay) ? onOrBefore(calendarMonthsBefore(latestDay, months)) : null;
  }
  for (const [name, count] of Object.entries(DAY_COUNT_OFFSETS)) {
    if (continuous) {
      references[name] = onOrBefore(latestDay - (count * DAY_MS));
    } else {
      const index = closes.length - 1 - count;
      references[name] = index >= 0 ? closes[index].close : null;
    }
  }
  return { ...references, ...periodStartReferences(closes) };
}

function computePeriodPercentsFromCloses(closes, { absoluteBase = false } = {}) {
  if (!closes || closes.length < 2) return null;
  const n = closes.length;
  const last = closes[n - 1].close;
  if (last == null || !Number.isFinite(last) || last === 0) return null;
  const references = periodReferences(closes);

  const pct = (ref) =>
    ref != null && Number.isFinite(ref) && ref !== 0
      ? absoluteBase ? percentageChange(last, ref) : Math.round((((last / ref) - 1) * 100) * 100) / 100
      : null;
  const absolute = (ref) => (
    ref != null && Number.isFinite(ref)
      ? Math.round((last - ref) * 1000000) / 1000000
      : null
  );

  const asOfTime = Number(closes[n - 1].t);
  return {
    weekChangePct: pct(references.week),
    fifteenDayChangePct: pct(references.fifteenDay),
    thirtyDayChangePct: pct(references.thirtyDay),
    ninetyDayChangePct: pct(references.ninetyDay),
    monthChangePct: pct(references.month),
    threeMonthChangePct: pct(references.threeMonth),
    sixMonthChangePct: pct(references.sixMonth),
    mtdChangePct: pct(references.mtd),
    qtdChangePct: pct(references.qtd),
    ytdChangePct: pct(references.ytd),
    oneYearChangePct: pct(references.oneYear),
    weekChangeValue: absolute(references.week),
    fifteenDayChangeValue: absolute(references.fifteenDay),
    monthChangeValue: absolute(references.month),
    threeMonthChangeValue: absolute(references.threeMonth),
    sixMonthChangeValue: absolute(references.sixMonth),
    mtdChangeValue: absolute(references.mtd),
    qtdChangeValue: absolute(references.qtd),
    ytdChangeValue: absolute(references.ytd),
    oneYearChangeValue: absolute(references.oneYear),
    asOf: Number.isFinite(asOfTime) ? new Date(asOfTime).toISOString() : null,
  };
}

function computePeriodBpsFromCloses(closes, { observationFrequency = 'daily' } = {}) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const ordered = closes
    .filter((row) => row?.t != null && row?.close != null && row.close !== '')
    .map((row) => ({ t: Number(row.t), close: Number(row.close) }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.close))
    .sort((left, right) => left.t - right.t);
  if (ordered.length < 2) return null;
  const latest = ordered[ordered.length - 1];
  // The same session dates as price returns: an instant comparison is a
  // session out when a clock change lies between the two observations.
  const offset = utcOffsetMsOf(closes);
  const latestDay = sessionDay(latest.t, offset);
  const onOrBefore = (targetDay) => closeOnOrBeforeDay(ordered, targetDay, offset);
  const toBps = (value) => (
    Number.isFinite(value)
      ? Math.round((latest.close - value) * 1000) / 10
      : null
  );
  const hasDailyObservations = observationFrequency === 'daily';
  const yearStart = Date.UTC(new Date(latestDay).getUTCFullYear(), 0, 1);
  // A daily series measures the year from the prior year-end observation. A
  // series that starts inside the year, or a monthly one, keeps its first
  // observation of the year.
  const priorYearEnd = hasDailyObservations ? onOrBefore(yearStart - DAY_MS) : null;
  const firstYearObservation = ordered.find((row) => sessionDay(row.t, offset) >= yearStart);
  const ytdReference = priorYearEnd ?? (
    firstYearObservation && sessionDay(firstYearObservation.t, offset) - yearStart <= 7 * DAY_MS
      ? firstYearObservation.close : null
  );

  const references = {
    day: hasDailyObservations ? onOrBefore(latestDay - DAY_MS) : null,
    week: hasDailyObservations ? onOrBefore(latestDay - (7 * DAY_MS)) : null,
    fifteenDay: hasDailyObservations ? onOrBefore(latestDay - (15 * DAY_MS)) : null,
    month: onOrBefore(calendarMonthsBefore(latestDay, 1)),
    threeMonth: onOrBefore(calendarMonthsBefore(latestDay, 3)),
    sixMonth: onOrBefore(calendarMonthsBefore(latestDay, 6)),
    ytd: ytdReference,
    oneYear: onOrBefore(calendarMonthsBefore(latestDay, 12)),
  };
  return {
    ...Object.fromEntries(Object.entries(references).map(([period, value]) => [`${period}ChangeBps`, toBps(value)])),
    // Calculate percentages from the same dated endpoints as rate deltas.
    // Do not turn 15 monthly observations into a supposed 15-day return.
    backdropPercentageReturns: Object.fromEntries(Object.entries(references)
      .map(([period, value]) => [`${period}ChangePct`, percentageChange(latest.close, value)])),
  };
}

// Period deltas in bps for a spread series, on the same dates and sessions as
// computePeriodPercentsFromCloses. Values are rounded to 0.1 bps for display.
function computeSpreadBpsDeltas(spreadSeries) {
  if (!spreadSeries || spreadSeries.length < 2) return null;
  const n = spreadSeries.length;
  const last = spreadSeries[n - 1].close;
  const prev = spreadSeries[n - 2].close;
  if (!Number.isFinite(last)) return null;
  const references = periodReferences(spreadSeries);

  const delta = (ref) =>
    ref != null && Number.isFinite(ref) ? Math.round((last - ref) * 10) / 10 : null;

  return {
    dayDeltaBps: delta(prev),
    weekDeltaBps: delta(references.week),
    fifteenDayDeltaBps: delta(references.fifteenDay),
    monthDeltaBps: delta(references.month),
    threeMonthDeltaBps: delta(references.threeMonth),
    sixMonthDeltaBps: delta(references.sixMonth),
    mtdDeltaBps: delta(references.mtd),
    qtdDeltaBps: delta(references.qtd),
    ytdDeltaBps: delta(references.ytd),
    oneYearDeltaBps: delta(references.oneYear),
    latestBps: Math.round(last * 10) / 10,
    asOf: Number.isFinite(Number(spreadSeries[n - 1].t))
      ? new Date(Number(spreadSeries[n - 1].t)).toISOString()
      : null,
  };
}

module.exports = {
  DAY_MS,
  PERIOD_START_REFERENCE_MAX_GAP_MS,
  calendarMonthsBefore,
  computePeriodBpsFromCloses,
  computePeriodPercentsFromCloses,
  computeSpreadBpsDeltas,
};
