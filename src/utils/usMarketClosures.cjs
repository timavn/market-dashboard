const {
  addCalendarDays,
  dateKeyToUtcDate,
  getUsEquityHoliday,
  isTradingDateKey,
  isUsEquityEarlyCloseDateKey,
} = require('./usEquityMarketCalendar.cjs');

// US closures that change what can trade on a day: a stock-market holiday,
// a bond-market-only holiday, and the early closes before holidays. Bond dates
// follow SIFMA's standing recommendation: closed on NYSE holidays plus Columbus
// Day and Veterans Day, and a 14:00 ET close the session before most holidays.
const ET_TIME_ZONE = 'America/New_York';
const BOND_EARLY_CLOSE_MINUTES = 14 * 60;
const STOCK_EARLY_CLOSE_MINUTES = 13 * 60;

function nthWeekday(year, monthIndex, weekday, occurrence) {
  const date = new Date(Date.UTC(year, monthIndex, 1, 12));
  date.setUTCDate(1 + ((weekday - date.getUTCDay() + 7) % 7) + ((occurrence - 1) * 7));
  return date.toISOString().slice(0, 10);
}

// Holidays on which the bond market closes but stocks trade.
function bondOnlyHoliday(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date) return null;
  const year = date.getUTCFullYear();
  if (dateKey === nthWeekday(year, 9, 1, 2)) return 'Columbus Day';
  // Veterans Day: a Sunday holiday moves to Monday; a Saturday one is not observed.
  const veterans = new Date(Date.UTC(year, 10, 11, 12));
  if (veterans.getUTCDay() === 0) veterans.setUTCDate(12);
  if (veterans.getUTCDay() !== 6 && dateKey === veterans.toISOString().slice(0, 10)) return 'Veterans Day';
  return null;
}

function bondClosed(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date || [0, 6].includes(date.getUTCDay())) return true;
  return Boolean(getUsEquityHoliday(dateKey) || bondOnlyHoliday(dateKey));
}

// The holiday the session before closes early for, if any.
function bondEarlyCloseFor(dateKey) {
  if (bondClosed(dateKey)) return null;
  // The next weekday: a Friday session closes early for a Monday holiday.
  let next = addCalendarDays(dateKey, 1);
  while ([0, 6].includes(dateKeyToUtcDate(next).getUTCDay())) next = addCalendarDays(next, 1);
  const nextHoliday = getUsEquityHoliday(next)?.name || bondOnlyHoliday(next);
  // Good Friday, Memorial Day, Independence Day, Christmas and New Year's.
  if (nextHoliday && /^(?:Good Friday|Independence Day|Christmas|New Year)/i.test(nextHoliday)) return nextHoliday;
  const date = dateKeyToUtcDate(dateKey);
  if (date.getUTCDay() === 5) {
    const monday = addCalendarDays(dateKey, 3);
    if (/Memorial Day/.test(getUsEquityHoliday(monday)?.name || '')) return 'Memorial Day';
  }
  if (dateKey.endsWith('-12-24') || dateKey.endsWith('-12-31') || dateKey.endsWith('-07-03')) {
    return dateKey.endsWith('-12-31') ? "New Year's Day" : dateKey.endsWith('-12-24') ? 'Christmas' : 'Independence Day';
  }
  // The Friday after Thanksgiving.
  if (/Thanksgiving/.test(getUsEquityHoliday(addCalendarDays(dateKey, -1))?.name || '')) return 'Thanksgiving';
  return null;
}

// The instant a New York wall-clock time occurs, as ISO-8601.
function etInstant(dateKey, minutes) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const offsetMinutes = (ms) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: ET_TIME_ZONE, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value || 'GMT-5';
    const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return match ? (match[1] === '-' ? -1 : 1) * ((Number(match[2]) * 60) + Number(match[3] || 0)) : -300;
  };
  const first = guess - (offsetMinutes(guess) * 60000);
  return new Date(guess - (offsetMinutes(first) * 60000)).toISOString();
}

const closure = (dateKey, name, { minutes = 0, allDay = true, detail }) => ({
  dateKey, name, detail, allDay, startAt: etInstant(dateKey, minutes),
});

// Every US trading-schedule change on the weekdays from..to (inclusive).
function usMarketClosures(from, to) {
  const output = [];
  for (let dateKey = from; dateKey && dateKey <= to; dateKey = addCalendarDays(dateKey, 1)) {
    const date = dateKeyToUtcDate(dateKey);
    if (!date || [0, 6].includes(date.getUTCDay())) continue;
    const holiday = getUsEquityHoliday(dateKey);
    if (holiday) {
      const goodFriday = /Good Friday/.test(holiday.name);
      output.push(closure(dateKey, goodFriday ? `Stock market closed — ${holiday.name}` : `Stock and bond markets closed — ${holiday.name}`,
        { detail: goodFriday ? 'NYSE and Nasdaq closed; check the bond-market schedule.' : 'NYSE, Nasdaq and the US bond market are closed.' }));
      continue;
    }
    const bondHoliday = bondOnlyHoliday(dateKey);
    if (bondHoliday) {
      output.push(closure(dateKey, `Bond market closed — ${bondHoliday}`, { detail: 'US Treasuries and bonds do not trade; stocks are open.' }));
      continue;
    }
    const stockEarly = isTradingDateKey(dateKey) && isUsEquityEarlyCloseDateKey(dateKey);
    const bondEarly = bondEarlyCloseFor(dateKey);
    if (stockEarly) {
      output.push(closure(dateKey, 'Stocks close early 13:00 ET; bonds 14:00 ET', { minutes: STOCK_EARLY_CLOSE_MINUTES, allDay: false,
        detail: 'NYSE and Nasdaq close at 13:00 ET; the US bond market at 14:00 ET.' }));
    } else if (bondEarly) {
      output.push(closure(dateKey, `Bond market closes early 14:00 ET — ${bondEarly}`, { minutes: BOND_EARLY_CLOSE_MINUTES, allDay: false,
        detail: 'The US bond market closes at 14:00 ET; stocks trade a full session.' }));
    }
  }
  return output;
}

module.exports = { bondOnlyHoliday, etInstant, usMarketClosures };
