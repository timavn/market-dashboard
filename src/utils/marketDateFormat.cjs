// Intl formatter construction loads timezone/calendar data. Reuse formatters
// across ledger rows, but always format the current input (never cache dates).
const MAX_TIME_ZONES = 16;
const dateFormatters = new Map();

function formatMarketDate(date, timeZone = 'America/New_York') {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone });
    if (dateFormatters.size >= MAX_TIME_ZONES) {
      dateFormatters.delete(dateFormatters.keys().next().value);
    }
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

module.exports = { formatMarketDate };
