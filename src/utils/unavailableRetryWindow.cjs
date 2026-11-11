'use strict';

// How long to remember that a source returned nothing before asking it again.
//
// A good answer is kept for its normal cache time. Keeping a failure that long
// turns a moment's outage into an hour of blank columns; not keeping it at all
// asks a source that has nothing on every poll. So: wait a minute after the
// first miss, double the wait with each further miss in a row, and never wait
// longer than a good answer would be kept.
const FIRST_RETRY_MS = 60 * 1000;
// 2 ** 20 minutes is about two years, far past any cache time. Capping the
// exponent keeps the arithmetic exact however long a source stays down.
const MAX_DOUBLINGS = 20;

function unavailableRetryMs(consecutiveMisses, ceilingMs, firstRetryMs = FIRST_RETRY_MS) {
  const first = Number.isFinite(firstRetryMs) && firstRetryMs > 0 ? firstRetryMs : FIRST_RETRY_MS;
  const misses = Math.max(1, Math.floor(Number(consecutiveMisses)) || 1);
  const wait = first * 2 ** Math.min(misses - 1, MAX_DOUBLINGS);
  return Number.isFinite(ceilingMs) && ceilingMs > 0 ? Math.min(ceilingMs, wait) : wait;
}

module.exports = { FIRST_RETRY_MS, unavailableRetryMs };
