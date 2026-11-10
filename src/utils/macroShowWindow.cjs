/* The Macro Show summary email has landed between 10:07 and 11:49 ET, so research
 * caches re-read every minute from 10:00 to 12:00 ET on weekdays. */
const FAST_REFRESH_MS = 60_000;
const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
});

function inMacroShowWindow(nowMs) {
  const parts = Object.fromEntries(easternClock.formatToParts(new Date(nowMs)).map(({ type, value }) => [type, value]));
  return !['Sat', 'Sun'].includes(parts.weekday) && [10, 11].includes(Number(parts.hour));
}

function researchRefreshMs(nowMs, normalMs) {
  return inMacroShowWindow(nowMs) ? Math.min(FAST_REFRESH_MS, normalMs) : normalMs;
}

module.exports = { inMacroShowWindow, researchRefreshMs };
