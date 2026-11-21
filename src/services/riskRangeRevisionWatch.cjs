'use strict';

// Watches the current Risk Range publication for a change of its ranges, such as a Real-Time Alert's
// "SPX Refreshed Risk Range" revising a row intraday (user-specified 2026-11-20). On a change it calls
// onChange so the server can drop every cache built from the old ranges; each surface then reads the
// revised range on its next request. The first reading only records the version.

const DEFAULT_INTERVAL_MS = 60_000;
const easternParts = (now) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit',
}).formatToParts(now).map((part) => [part.type, part.value]));

// Weekdays 06:00-19:59 New York: alerts arrive in and around the session; nights and weekends need no watch.
function watchHours(now = new Date()) {
  const { weekday, hour } = easternParts(now);
  return !['Sat', 'Sun'].includes(weekday) && Number(hour) >= 6 && Number(hour) < 20;
}

function createRiskRangeRevisionWatch({
  load, onChange, isActive = watchHours, now = () => new Date(), intervalMs = DEFAULT_INTERVAL_MS,
  log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  if (typeof load !== 'function' || typeof onChange !== 'function') throw new TypeError('load and onChange are required');
  let version;
  let timer = null;
  let running = false;

  async function check() {
    if (running || !isActive(now())) return { checked: false };
    running = true;
    try {
      const envelope = await load({ now: now() });
      const next = envelope?.available ? envelope.manifest?.dataVersion || null : null;
      if (version === undefined) {
        version = next;
        return { checked: true, changed: false };
      }
      if (next === version) return { checked: true, changed: false };
      const previous = version;
      version = next;
      const revised = Object.entries(envelope?.ranges || {})
        .filter(([, range]) => range?.revision).map(([ticker]) => ticker);
      log(`[risk-ranges] publication changed${revised.length ? ` (revised: ${revised.join(', ')})` : ''}; caches cleared`);
      await onChange({ previous, version: next, revised, envelope });
      return { checked: true, changed: true, revised };
    } catch (error) {
      log(`[risk-ranges] revision watch read failed: ${error.message}`);
      return { checked: false, error };
    } finally {
      running = false;
    }
  }

  return {
    check,
    start() {
      if (!timer) {
        timer = setIntervalFn(() => { check(); }, intervalMs);
        timer?.unref?.();
      }
      return this;
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
  };
}

module.exports = { createRiskRangeRevisionWatch, watchHours, DEFAULT_INTERVAL_MS };
