#!/usr/bin/env node
'use strict';

const { setTimeout: pause } = require('node:timers/promises');
const { newYorkDateKey } = require('../src/services/momoTrackerSnapshot.cjs');
const { isTradingDateKey } = require('../src/utils/usEquityMarketCalendar.cjs');

async function runAnalystMorningReview({
  apiBase = process.env.MARKET_DASHBOARD_API_BASE || 'http://127.0.0.1:3001',
  fetchImpl = global.fetch, now = Date.now, sleep = pause, timeoutMs = 180_000,
} = {}) {
  const date = newYorkDateKey(now());
  if (!isTradingDateKey(date)) return { status: 'skipped', date, reason: 'non_trading_day' };
  const endpoint = `${apiBase.replace(/\/$/, '')}/api/analyst/automation/prediction-morning`;
  const deadline = now() + Math.min(180_000, Math.max(1, timeoutMs));
  let method = 'POST';
  let expected;
  let transportFailures = 0;
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
        return { status: 'unavailable', date, reason: 'analyst_endpoint_unavailable' };
      }
      result = await response.json();
    } catch {
      transportFailures += 1;
      if (transportFailures >= 3) return { status: 'unavailable', date, reason: 'analyst_endpoint_unavailable' };
      // The POST adapter deduplicates by publication date, including uncertain replies.
      await sleep(Math.min(2_000, Math.max(1, deadline - now())));
      continue;
    }
    transportFailures = 0;
    if (result.date === date && result.reviewKind === 'prediction-markets-review'
      && result.status === 'skipped' && result.reason === 'user_initiated_only') return result;
    if (result.date !== date || result.reviewKind !== 'prediction-markets-review'
      || !result.runId || !result.conversationId
      || (expected && (result.runId !== expected.runId || result.conversationId !== expected.conversationId))) {
      return { status: 'unavailable', date, reason: 'review_identity_unverified' };
    }
    expected = result;
    if (result.status === 'ready' && ['ready', 'partial'].includes(result.outcome)) return result;
    if (['failed', 'blocked', 'unavailable'].includes(result.status)) return result;
    if (result.status !== 'running') return { status: 'unavailable', date, reason: 'review_status_unverified' };
    method = 'GET';
    await sleep(Math.min(2_000, Math.max(1, deadline - now())));
  }
  return { status: 'unavailable', date, reason: 'review_timeout' };
}

module.exports = { runAnalystMorningReview };
if (require.main === module) {
  runAnalystMorningReview().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!['ready', 'skipped'].includes(result.status)) process.exitCode = 1;
  }).catch(() => { process.stderr.write('Analyst morning review unavailable.\n'); process.exitCode = 1; });
}
