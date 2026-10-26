const { isTradingDateKey, previousTradingDateKey, addCalendarDays } = require('./usEquityMarketCalendar.cjs');

// Match the completed-session contract's 16:15 New York publication allowance.
// Historical estimates remain usable over exchange holidays, not across a new close.
function expectedSizingSession(now = Date.now(), annualizationFactor = 252) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  if (annualizationFactor === 365) return addCalendarDays(date.toISOString().slice(0, 10), -1);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return isTradingDateKey(today) && Number(parts.hour) * 60 + Number(parts.minute) >= 975
    ? today : previousTradingDateKey(today);
}

module.exports = {
  expectedSizingSession,
};
