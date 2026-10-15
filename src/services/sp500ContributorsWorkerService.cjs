'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { canonicalMomoCompanyTicker, MOMO_EXCLUDED_TICKERS } = require('../constants/momoTrackerCatalog.cjs');

const WORKER_PATH = path.join(__dirname, 'sp500ContributorsWorker.cjs');
const unavailable = () => ({ status: 'unavailable', asOf: null, fetchedAt: new Date().toISOString(), rows: [] });

function validSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.rows)) return false;
  if (snapshot.status === 'unavailable') return snapshot.rows.length === 0;
  return snapshot.status === 'available' && snapshot.rows.length === 10
    && snapshot.ranking === 'company-market-cap'
    && typeof snapshot.source === 'string' && typeof snapshot.sourceUrl === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf || '')
    && Number.isFinite(Date.parse(snapshot.fetchedAt))
    && snapshot.rows.every((row, index) => row && /^[A-Z][A-Z0-9]*(?:[.-][A-Z])?$/.test(row.ticker || '')
      && !MOMO_EXCLUDED_TICKERS.includes(row.ticker) && row.rank === index + 1
      && Number.isFinite(row.marketCap?.value) && row.marketCap.value > 0
      && row.marketCap.scope === 'company'
      && (index === 0 || snapshot.rows[index - 1].marketCap.value >= row.marketCap.value)
      && (row.weightPct === null || (Number.isFinite(row.weightPct) && row.weightPct > 0 && row.weightPct <= 100)))
    && new Set(snapshot.rows.map(row => canonicalMomoCompanyTicker(row.ticker))).size === 10;
}

function safeDiagnostic(value) {
  if (!value || !/^[a-z-]+(?::[a-z-]+)?$/.test(value.stage || '') || !/^[A-Z0-9_]+$/.test(value.code || '')) return null;
  const diagnostic = { status: 'unavailable', stage: value.stage, code: value.code };
  if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) diagnostic.elapsedMs = value.elapsedMs;
  for (const key of ['asOf', 'currentMarketDate']) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value[key] || '')) diagnostic[key] = value[key];
  }
  return diagnostic;
}

function createSp500ContributorsWorkerService({
  workerFactory = (filename, options) => new Worker(filename, options),
  sourceTimeoutMs = 8_000,
  sourceOverallTimeoutMs = 26_000,
  workerTimeoutMs = 30_000,
  onDiagnostic = diagnostic => console.warn('[sp500-contributors]', JSON.stringify(diagnostic)),
} = {}) {
  const inFlight = new Map();

  function run({ momoSnapshot = null } = {}) {
    return new Promise(resolve => {
      const startedAt = Date.now();
      let worker;
      let timeout;
      let settled = false;
      let reported = false;
      const report = value => {
        const diagnostic = safeDiagnostic(value);
        if (reported || !diagnostic) return;
        reported = true;
        try { onDiagnostic?.(diagnostic); } catch { /* Diagnostic failures cannot hold a request open. */ }
      };
      const finish = snapshot => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (worker) {
          worker.removeListener('message', onMessage);
          worker.removeListener('exit', onExit);
          // Retain the guarded error listener until termination completes;
          // a late native error must not become an unhandled event.
          try { Promise.resolve(worker.terminate()).catch(() => {}); } catch { /* The worker may already have exited. */ }
        }
        resolve(snapshot);
      };
      const fail = code => {
        if (settled) return;
        report({ stage: 'worker', code, elapsedMs: Date.now() - startedAt });
        finish(unavailable());
      };
      const onMessage = message => {
        if (settled) return;
        if (message?.type === 'diagnostic') {
          report(message.diagnostic);
          return;
        }
        if (message?.type !== 'snapshot' || !validSnapshot(message.snapshot)) {
          fail('WORKER_RESPONSE_INVALID');
          return;
        }
        finish(message.snapshot);
      };
      const onExit = () => fail('WORKER_EXIT_WITHOUT_SNAPSHOT');
      try {
        worker = workerFactory(WORKER_PATH, {
          workerData: { sourceTimeoutMs, sourceOverallTimeoutMs, momoSnapshot },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
        });
        worker.on('message', onMessage);
        worker.on('error', () => fail('WORKER_ERROR'));
        worker.on('exit', onExit);
        timeout = setTimeout(() => fail('WORKER_TIMEOUT'), workerTimeoutMs);
      } catch {
        fail('WORKER_START_FAILED');
      }
    });
  }

  function getSnapshot(options = {}) {
    const key = JSON.stringify(options.momoSnapshot || null);
    if (!inFlight.has(key)) inFlight.set(key, run(options).finally(() => { inFlight.delete(key); }));
    return inFlight.get(key);
  }
  return { getSnapshot };
}

module.exports = { createSp500ContributorsWorkerService };
