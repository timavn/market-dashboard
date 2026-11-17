'use strict';

const { resolveInstrument, instrumentCacheKey } = require('../providers/instruments/instrumentResolver');

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_RECHECK_MS = 60_000;
const DEFAULT_RESERVED_LINES = 5;

/**
 * Keeps the market overview's IBKR rows subscribed while the overview is in use.
 *
 * Read one at a time, each of those rows opens a market-data request at IBKR,
 * waits for the next tick (0.1 to 1.9 seconds, measured 16 Nov 2026) and
 * cancels it, on every uncached poll. Subscribed, the same rows are read from
 * the stream with no request at all.
 *
 * A subscription takes one of the account's market-data lines, and the
 * portfolio comes first: the rows are subscribed only while that leaves
 * `reservedLines` free, which is checked again every minute, and they are
 * released once the overview has not been asked for in `idleMs`. A row IBKR
 * cannot quote at the moment (no entitlement, or no ticks overnight) is left
 * out, so it does not hold a line that delivers nothing.
 */
function createOverviewStreamSubscription({
  rows,
  setDesiredInstruments,
  readStreamCapacity,
  isUnavailable = () => false,
  reservedLines = DEFAULT_RESERVED_LINES,
  idleMs = DEFAULT_IDLE_MS,
  recheckMs = DEFAULT_RECHECK_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let held = 0;
  let lastCheckAt = null;
  let checking = null;
  let idleTimer = null;

  // The rows IBKR serves first and can quote right now, each once.
  function wanted() {
    const seen = new Set();
    const instruments = [];
    for (const row of rows()) {
      const instrument = resolveInstrument(row);
      if (!instrument.supported || !['auto', 'ibkr'].includes(instrument.provider)) continue;
      const key = instrumentCacheKey(row);
      if (seen.has(key) || isUnavailable(row)) continue;
      seen.add(key);
      instruments.push(row);
    }
    return instruments;
  }

  function apply(instruments) {
    held = instruments.length;
    setDesiredInstruments(instruments);
  }

  async function evaluate() {
    const instruments = wanted();
    if (instruments.length === 0) {
      apply([]);
      return;
    }
    const capacity = await readStreamCapacity();
    const active = Number(capacity?.active);
    const max = Number(capacity?.max);
    // Without a reading nothing changes: neither taking lines nor giving them up blind.
    if (!Number.isFinite(active) || !Number.isFinite(max)) return;
    const usedByOthers = Math.max(0, active - held);
    apply(usedByOthers + instruments.length <= max - reservedLines ? instruments : []);
  }

  function release() {
    clearTimer(idleTimer);
    idleTimer = null;
    lastCheckAt = null;
    apply([]);
  }

  // Called for every overview request.
  function touch() {
    clearTimer(idleTimer);
    idleTimer = setTimer(release, idleMs);
    idleTimer?.unref?.();
    if (checking || (lastCheckAt !== null && now() - lastCheckAt < recheckMs)) return checking;
    lastCheckAt = now();
    checking = evaluate()
      .catch(() => { /* The overview still reads these rows one at a time. */ })
      .finally(() => { checking = null; });
    return checking;
  }

  return { touch, release, heldLines: () => held };
}

module.exports = { createOverviewStreamSubscription };
