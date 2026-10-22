const UTC_DAY_MS = 24 * 60 * 60 * 1000;
// Calendars are deterministic reference facts. Share immutable yearly results,
// never market observations, and bound callers' arbitrary-year cardinality.
const YEAR_CALENDAR_CACHE_LIMIT = 256;
const yearCalendarCache = new Map();

const EXTRAORDINARY_CLOSURES = Object.freeze({
  '2001-09-11': 'September 11 market closure',
  '2001-09-12': 'September 11 market closure',
  '2001-09-13': 'September 11 market closure',
  '2001-09-14': 'September 11 market closure',
  '2004-06-11': 'National Day of Mourning for President Ronald Reagan',
  '2007-01-02': 'National Day of Mourning for President Gerald Ford',
  '2012-10-29': 'Hurricane Sandy market closure',
  '2012-10-30': 'Hurricane Sandy market closure',
  '2018-12-05': 'National Day of Mourning for President George H. W. Bush',
  '2025-01-09': 'National Day of Mourning for President Jimmy Carter',
});

function dateKeyToUtcDate(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? date
    : null;
}

function utcDateToDateKey(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function addCalendarDays(dateKey, days) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date || !Number.isFinite(Number(days))) return null;
  date.setUTCDate(date.getUTCDate() + Number(days));
  return utcDateToDateKey(date);
}

function observedWeekdayClosure(year, monthIndex, day, { saturdayObserved = true } = {}) {
  const date = new Date(Date.UTC(year, monthIndex, day, 12));
  if (date.getUTCDay() === 6) {
    if (!saturdayObserved) return null;
    date.setUTCDate(date.getUTCDate() - 1);
  } else if (date.getUTCDay() === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return utcDateToDateKey(date);
}

function nthWeekdayOfMonth(year, monthIndex, weekday, occurrence) {
  const date = new Date(Date.UTC(year, monthIndex, 1, 12));
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + ((occurrence - 1) * 7));
  return utcDateToDateKey(date);
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0, 12));
  const offset = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return utcDateToDateKey(date);
}

function easterSundayDateKey(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = ((19 * a) + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + (2 * e) + (2 * i) - h - k) % 7;
  const m = Math.floor((a + (11 * h) + (22 * l)) / 451);
  const month = Math.floor((h + l - (7 * m) + 114) / 31);
  const day = ((h + l - (7 * m) + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildYearCalendar(numericYear) {
  const holidays = new Map();
  const add = (date, name) => {
    if (date && date.startsWith(`${numericYear}-`)) holidays.set(date, name);
  };

  // NYSE does not move New Year's Day to Friday when January 1 is Saturday.
  add(observedWeekdayClosure(numericYear, 0, 1, { saturdayObserved: false }), "New Year's Day");
  if (numericYear >= 1998) {
    add(nthWeekdayOfMonth(numericYear, 0, 1, 3), 'Martin Luther King Jr. Day');
  }
  add(nthWeekdayOfMonth(numericYear, 1, 1, 3), "Washington's Birthday");
  add(addCalendarDays(easterSundayDateKey(numericYear), -2), 'Good Friday');
  add(lastWeekdayOfMonth(numericYear, 4, 1), 'Memorial Day');
  if (numericYear >= 2022) {
    add(observedWeekdayClosure(numericYear, 5, 19), 'Juneteenth National Independence Day');
  }
  add(observedWeekdayClosure(numericYear, 6, 4), 'Independence Day');
  add(nthWeekdayOfMonth(numericYear, 8, 1, 1), 'Labor Day');
  add(nthWeekdayOfMonth(numericYear, 10, 4, 4), 'Thanksgiving Day');
  add(observedWeekdayClosure(numericYear, 11, 25), 'Christmas Day');

  Object.entries(EXTRAORDINARY_CLOSURES).forEach(([date, name]) => add(date, name));
  return Object.freeze([...holidays.entries()]
    .map(([date, name]) => Object.freeze({ date, name }))
    .sort((left, right) => left.date.localeCompare(right.date)));
}

function calendarForYear(numericYear) {
  let calendar = yearCalendarCache.get(numericYear);
  if (!calendar) {
    const rows = buildYearCalendar(numericYear);
    calendar = { rows, byDate: new Map(rows.map(row => [row.date, row])) };
    yearCalendarCache.set(numericYear, calendar);
    if (yearCalendarCache.size > YEAR_CALENDAR_CACHE_LIMIT) {
      yearCalendarCache.delete(yearCalendarCache.keys().next().value);
    }
  }
  return calendar;
}

function usEquityMarketHolidays(year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) return [];
  // Keep the public API's independently mutable result; the shared cache stays private.
  return calendarForYear(numericYear).rows.map(row => ({ ...row }));
}

function getUsEquityHoliday(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date) return null;
  const holiday = calendarForYear(date.getUTCFullYear()).byDate.get(dateKey);
  return holiday ? { ...holiday } : null;
}

function classifyUsEquityClosedDateKey(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date) return null;
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { date: dateKey, type: 'weekend', holidayName: null };
  }
  const holiday = calendarForYear(date.getUTCFullYear()).byDate.get(dateKey);
  return holiday
    ? { date: dateKey, type: 'holiday', holidayName: holiday.name }
    : null;
}

function closedUsEquityDatesBetween(previousDateKey, nextDateKey) {
  const previous = dateKeyToUtcDate(previousDateKey);
  const next = dateKeyToUtcDate(nextDateKey);
  if (!previous || !next || next <= previous) return [];
  const closedDates = [];
  for (let cursor = previous.getTime() + UTC_DAY_MS; cursor < next.getTime(); cursor += UTC_DAY_MS) {
    const dateKey = utcDateToDateKey(new Date(cursor));
    const closure = classifyUsEquityClosedDateKey(dateKey);
    if (closure) closedDates.push(closure);
  }
  return closedDates;
}

function isTradingDateKey(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date || date.getUTCDay() === 0 || date.getUTCDay() === 6) return false;
  return !calendarForYear(date.getUTCFullYear()).byDate.has(dateKey);
}

function previousTradingDateKey(dateKey) {
  let candidate = addCalendarDays(dateKey, -1);
  while (candidate && !isTradingDateKey(candidate)) candidate = addCalendarDays(candidate, -1);
  return candidate;
}

function nextTradingDateKey(dateKey) {
  let candidate = addCalendarDays(dateKey, 1);
  while (candidate && !isTradingDateKey(candidate)) candidate = addCalendarDays(candidate, 1);
  return candidate;
}

module.exports = {
  UTC_DAY_MS,
  addCalendarDays,
  classifyUsEquityClosedDateKey,
  closedUsEquityDatesBetween,
  dateKeyToUtcDate,
  easterSundayDateKey,
  getUsEquityHoliday,
  isTradingDateKey,
  nextTradingDateKey,
  previousTradingDateKey,
  usEquityMarketHolidays,
};
