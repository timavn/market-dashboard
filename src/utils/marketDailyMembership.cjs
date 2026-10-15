'use strict';

const { isTradingDateKey } = require('./usEquityMarketCalendar.cjs');

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// The daily strip uses an explicitly dated issuer membership/weight reference,
// not an executable quote. A freshly retrieved issuer file can still describe
// an earlier session (including Thursday holdings over a weekend). Its original
// date remains visible; aging the reference must not erase verified observations.
// Quote/session freshness is validated separately by marketDailyMetrics.
function membershipDateIsUsable(asOf, nowMs = Date.now()) {
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
    || !Number.isFinite(nowMs) || !isTradingDateKey(asOf)) return false;
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
  return asOf <= `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { membershipDateIsUsable };
