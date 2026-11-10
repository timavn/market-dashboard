'use strict';

/**
 * Period returns for the market overview tables. Pure functions over an
 * ascending series of `{ t: epochMs, close }` rows.
 *
 * - MTD, QTD and YTD compare with the last close before the period starts
 *   (the prior month-, quarter- or year-end close). The period is the one the
 *   latest bar belongs to, never the wall clock.
 * - 1W, 15D, 1M, 3M and 6M step back whole sessions (5, 15, 21, 63 and 126
 *   bars). A series that prints every calendar day uses calendar dates
 *   instead: 21 bars is three weeks of crypto, not a month.
 * - A window longer than the available history has no value.
 */
const { percentageChange } = require('../services/providers/observationChange.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_REFERENCE_MAX_GAP_MS = 7 * DAY_MS;
// The close before a period start is normally one to four days earlier. Long
// exchange holidays (Lunar New Year, Golden Week) stay well inside ten.
const PERIOD_START_REFERENCE_MAX_GAP_MS = 10 * DAY_MS;
const SESSION_OFFSETS = Object.freeze({
  week: 5, fifteenDay: 15, thirtyDay: 30, ninetyDay: 90, month: 21, threeMonth: 63, sixMonth: 126,
});
const CALENDAR_DAY_OFFSETS = Object.freeze({ week: 7, fifteenDay: 15, thirtyDay: 30, ninetyDay: 90 });
const CALENDAR_MONTH_OFFSETS = Object.freeze({ month: 1, threeMonth: 3, sixMonth: 6 });
// 28 of 28 days for a continuous market; about 20 for a five-day exchange.
const CONTINUOUS_SERIES_MIN_BARS_IN_28_DAYS = 26;

function findCloseAtOrBefore(closes, targetTimestamp, maxGapMs) {
  if (!Array.isArray(closes) || !Number.isFinite(Number(targetTimestamp))) return null;
  let match = null;
  for (const row of closes) {
    const timestamp = Number(row?.t);
    const close = Number(row?.close);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
    if (timestamp > Number(targetTimestamp)) break;
    match = { t: timestamp, close };
  }
  if (!match || Number(targetTimestamp) - match.t > maxGapMs) return null;
  return match;
}

function findClosestClose(closes, targetTimestamp) {
  if (!Array.isArray(closes) || !Number.isFinite(Number(targetTimestamp))) return null;
  let closest = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const row of closes) {
    const timestamp = Number(row?.t);
    const close = Number(row?.close);
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;
    const distance = Math.abs(timestamp - Number(targetTimestamp));
    if (distance < closestDistance) {
      closest = row;
      closestDistance = distance;
    }
  }
  return closestDistance <= ONE_YEAR_REFERENCE_MAX_GAP_MS ? closest : null;
}

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

function periodStartReferences(closes) {
  const latestTime = Number(closes[closes.length - 1]?.t);
  if (!Number.isFinite(latestTime)) return { mtd: null, qtd: null, ytd: null };
  const offset = utcOffsetMsOf(closes);
  const latestDate = new Date(latestTime + offset);
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
      const sessionTime = timestamp + offset;
      if (sessionTime < start) prior = { sessionTime, close };
      else { first = close; break; }
    }
    if (prior && start - prior.sessionTime <= PERIOD_START_REFERENCE_MAX_GAP_MS) return [period, prior.close];
    // No close just before the period (a listing or a data gap): measure from its first close.
    return [period, first];
  }));
}

function periodReferences(closes) {
  const latestTime = Number(closes[closes.length - 1]?.t);
  const continuous = printsEveryCalendarDay(closes);
  const atOrBefore = (target) => findCloseAtOrBefore(closes, target, 7 * DAY_MS)?.close ?? null;
  const references = {};
  for (const [name, sessions] of Object.entries(SESSION_OFFSETS)) {
    if (!continuous) {
      const index = closes.length - 1 - sessions;
      references[name] = index >= 0 ? closes[index].close : null;
    } else if (name in CALENDAR_DAY_OFFSETS) {
      references[name] = atOrBefore(latestTime - (CALENDAR_DAY_OFFSETS[name] * DAY_MS));
    } else {
      references[name] = atOrBefore(calendarMonthsBefore(latestTime, CALENDAR_MONTH_OFFSETS[name]));
    }
  }
  references.oneYear = Number.isFinite(latestTime)
    ? findClosestClose(closes, latestTime - (365 * DAY_MS))?.close
    : null;
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
  const reference = (target, maxGapDays) => (
    findCloseAtOrBefore(ordered, target, maxGapDays * DAY_MS)?.close ?? null
  );
  const toBps = (value) => (
    Number.isFinite(value)
      ? Math.round((latest.close - value) * 1000) / 10
      : null
  );
  const hasDailyObservations = observationFrequency === 'daily';
  const latestDate = new Date(latest.t);
  const yearStart = Date.UTC(latestDate.getUTCFullYear(), 0, 1);
  // A daily series measures the year from the prior year-end observation. A
  // series that starts inside the year, or a monthly one, keeps its first
  // observation of the year.
  const priorYearEnd = hasDailyObservations ? reference(yearStart - 1, 7) : null;
  const firstYearObservation = ordered.find((row) => row.t >= yearStart && row.t <= latest.t);
  const ytdReference = priorYearEnd ?? (
    firstYearObservation && firstYearObservation.t - yearStart <= 7 * DAY_MS
      ? firstYearObservation.close : null
  );

  const references = {
    day: hasDailyObservations ? reference(latest.t - DAY_MS, 7) : null,
    week: hasDailyObservations ? reference(latest.t - (7 * DAY_MS), 7) : null,
    fifteenDay: hasDailyObservations ? reference(latest.t - (15 * DAY_MS), 7) : null,
    month: reference(calendarMonthsBefore(latest.t, 1), 7),
    threeMonth: reference(calendarMonthsBefore(latest.t, 3), 7),
    sixMonth: reference(calendarMonthsBefore(latest.t, 6), 7),
    ytd: ytdReference,
    oneYear: reference(calendarMonthsBefore(latest.t, 12), 7),
  };
  return {
    ...Object.fromEntries(Object.entries(references).map(([period, value]) => [`${period}ChangeBps`, toBps(value)])),
    // Calculate percentages from the same dated endpoints as rate deltas.
    // Do not turn 15 monthly observations into a supposed 15-day return.
    backdropPercentageReturns: Object.fromEntries(Object.entries(references)
      .map(([period, value]) => [`${period}ChangePct`, percentageChange(latest.close, value)])),
  };
}

// Period deltas in bps for a spread series, on the same session boundaries as
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
  computePeriodBpsFromCloses,
  computePeriodPercentsFromCloses,
  computeSpreadBpsDeltas,
  findCloseAtOrBefore,
  findClosestClose,
};
