#!/usr/bin/env node
'use strict';

const { setTimeout: pause } = require('node:timers/promises');
const { newYorkDateKey } = require('../src/services/momoTrackerSnapshot.cjs');
const { isTradingDateKey } = require('../src/utils/usEquityMarketCalendar.cjs');

const TIME_ZONE = 'America/New_York';
const marketTime = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value));

async function runAnalystPortfolioClose({
  apiBase = process.env.MARKET_DASHBOARD_API_BASE || 'http://127.0.0.1:3001',
  fetchImpl = global.fetch, now = Date.now, sleep = pause, timeoutMs = 180_000,
} = {}) {
  const date = newYorkDateKey(now());
  const base = { date, timeZone: TIME_ZONE };
  const failed = reason => ({ ...base, status: 'failed', reason });
  if (!isTradingDateKey(date)) return { ...base, status: 'skipped', reason: 'non_trading_day' };
  const endpoint = `${apiBase.replace(/\/$/, '')}/api/analyst/automation/portfolio-close`;
  const deadline = now() + Math.min(180_000, Math.max(1, timeoutMs));
  let method = 'GET';
  let started = false;
  let transportFailures = 0;
  let identity;
  while (now() < deadline) {
    let result;
    try {
      const response = await fetchImpl(endpoint, {
        method, cache: 'no-store', signal: AbortSignal.timeout(Math.min(20_000, Math.max(1, deadline - now()))),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      if (response.status >= 500) throw new Error('Temporary Analyst outage');
      if (!response.ok || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') || '')) {
        return failed('capture_endpoint_unavailable');
      }
      result = await response.json();
    } catch {
      transportFailures += 1;
      if (transportFailures >= 3) return failed('capture_endpoint_unavailable');
      // An uncertain POST is checked with GET before any further action.
      if (method === 'POST') started = true;
      method = 'GET';
      await sleep(Math.min(2_000, Math.max(1, deadline - now())));
      continue;
    }
    transportFailures = 0;
    if (result.date !== date || result.timeZone !== TIME_ZONE
      || !['13:30', '16:30'].includes(result.scheduledTime)
      || (identity && ['runId', 'conversationId'].some(key => identity[key] && result[key] && result[key] !== identity[key]))) {
      return failed('capture_identity_unverified');
    }
    if (result.runId || result.conversationId) identity = result;
    // A failed or blocked earlier attempt is retried once per run when its
    // server-side throttle has elapsed; otherwise the hourly runs never retry.
    if (['blocked', 'failed'].includes(result.status) && !started
      && !(Date.parse(result.retryAt) > now())) {
      method = 'POST';
      started = true;
      continue;
    }
    if (['scheduled', 'skipped', 'blocked', 'failed'].includes(result.status)) return result;
    if (result.status === 'ready') {
      const captured = Date.parse(result.capturedAt);
      if (!Number.isFinite(captured) || newYorkDateKey(captured) !== date
        || captured > now() + 5_000 || marketTime(captured) < result.scheduledTime
        || result.fallback === true || result.verifiedAtCapture === false) return failed('capture_not_verified');
      return result;
    }
    if (result.status === 'pending' && !started) {
      if (marketTime(now()) < result.scheduledTime) return failed('capture_not_due');
      method = 'POST';
      started = true;
      continue;
    }
    if (!['pending', 'running'].includes(result.status)) return failed('capture_status_unverified');
    method = 'GET';
    await sleep(Math.min(2_000, Math.max(1, deadline - now())));
  }
  return failed('capture_timeout');
}

module.exports = { runAnalystPortfolioClose };
if (require.main === module) {
  runAnalystPortfolioClose().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!['ready', 'scheduled', 'skipped'].includes(result.status)) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Analyst closing holdings capture unavailable.\n'); process.exitCode = 1; });
}
