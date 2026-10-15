'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMarketDailyReferenceStore } = require('./marketDailyReferenceStore.cjs');
const { mergeMarketDailyReference } = require('../utils/marketDailyReference.cjs');
const NOW = Date.parse('2026-09-22T17:00:00Z');
const snapshot = () => ({ status: 'available', asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1_200_000).toISOString(),
  source: 'State Street / Yahoo Finance', sourceUrl: 'https://www.ssga.com/', universe: { count: 503 },
  coverage: { quotes: 503, total: 503 }, breadth: { advancing: 300, declining: 203 }, winners: [], losers: [], leadership: {}, outliers: {} });

test('API restarts restore the persisted merged reference with its original observation and no age cutoff', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-daily-reference-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const referencePath = path.join(directory, 'reference.json');
  const first = createMarketDailyReferenceStore({ referencePath, now: () => NOW });
  const incoming = { ...snapshot(), status: 'partial', asOf: new Date(NOW + 60_000).toISOString(),
    breadth: { advancing: null, declining: null }, coverage: { quotes: 502, total: 503 } };
  first.write(mergeMarketDailyReference(snapshot(), incoming, NOW + 60_000));
  const restarted = createMarketDailyReferenceStore({ referencePath, now: () => NOW + 180 * 86_400_000 }).read();
  assert.equal(restarted.breadth.advancing, 300);
  assert.equal(restarted.retained, true);
  assert.equal(restarted.referenceObservations.breadth.asOf, snapshot().asOf);
  assert.equal(restarted.referenceObservations.breadth.coverage.total, 503);
  first.write({ ...snapshot(), mock: true });
  assert.equal(first.read().breadth.advancing, 300);
  fs.writeFileSync(referencePath, JSON.stringify({ schemaVersion: 1, snapshot: { ...snapshot(), seeded: true } }));
  assert.equal(first.read(), null);
});
