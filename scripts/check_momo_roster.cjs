#!/usr/bin/env node
'use strict';

const { validateMomoRoster, rosterCheckResult: result } = require('../src/services/momoRosterVerification.cjs');
const { newYorkDateKey } = require('../src/services/momoTrackerSnapshot.cjs');
const { isTradingDateKey } = require('../src/utils/usEquityMarketCalendar.cjs');

const REQUEST_TIMEOUT_MS = 35_000;

async function runMomoRosterCheck({
  apiBase = process.env.MARKET_DASHBOARD_API_BASE || 'http://127.0.0.1:3001',
  fetchImpl = global.fetch,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const date = newYorkDateKey(now());
  if (!isTradingDateKey(date)) return result('skipped', date, 'non_trading_day');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(result('unavailable', date, 'request_timeout'));
    }, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs)));
  });
  try {
    return await Promise.race([deadline, (async () => {
      try {
        const response = await fetchImpl(`${apiBase.replace(/\/$/, '')}/api/market/sp500-contributors`, {
          cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        });
        if (!response.ok) return result('unavailable', date, 'endpoint_unavailable');
        if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') || '')) {
          return result('unavailable', date, 'response_not_fresh');
        }
        return validateMomoRoster(await response.json(), { nowMs: now() });
      } catch {
        return result('unavailable', date, controller.signal.aborted ? 'request_timeout' : 'endpoint_unavailable');
      }
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { validateMomoRoster, runMomoRosterCheck };

if (require.main === module) {
  runMomoRosterCheck().then(output => {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    if (output.status === 'unavailable') process.exitCode = 1;
  });
}
