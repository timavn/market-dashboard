'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRiskRangeRevisionWatch, watchHours } = require('./riskRangeRevisionWatch.cjs');

const envelope = (version, ranges = {}) => ({ available: true, manifest: { dataVersion: version }, ranges });

test('the first reading records the version; a later change clears caches and names revised tickers', async () => {
  const reads = [envelope('v1'), envelope('v1'), envelope('v2', { SPX: { lrr: 6899, hrr: 7367, revision: { eventTime: 'x' } }, VIX: { lrr: 15, hrr: 20 } })];
  const changes = [];
  const watch = createRiskRangeRevisionWatch({ load: async () => reads.shift(), onChange: (change) => changes.push(change), isActive: () => true });
  assert.deepEqual(await watch.check(), { checked: true, changed: false });
  assert.deepEqual(await watch.check(), { checked: true, changed: false });
  const result = await watch.check();
  assert.equal(result.changed, true);
  assert.deepEqual(result.revised, ['SPX']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previous, 'v1');
  assert.equal(changes[0].version, 'v2');
});

test('an unavailable publication counts as a change, and outside watch hours nothing is read', async () => {
  let reads = 0;
  const changes = [];
  const sequence = [envelope('v1'), { available: false, manifest: { dataVersion: 'v1' } }];
  const watch = createRiskRangeRevisionWatch({ load: async () => { reads += 1; return sequence.shift(); }, onChange: (change) => changes.push(change), isActive: () => true });
  await watch.check();
  assert.equal((await watch.check()).changed, true);
  const idle = createRiskRangeRevisionWatch({ load: async () => { reads += 1; }, onChange: () => {}, isActive: () => false });
  assert.deepEqual(await idle.check(), { checked: false });
  assert.equal(reads, 2);
});

test('a failed read is reported and does not clear caches', async () => {
  const changes = [];
  const watch = createRiskRangeRevisionWatch({ load: async () => { throw new Error('throttled'); }, onChange: (change) => changes.push(change), isActive: () => true });
  const result = await watch.check();
  assert.equal(result.checked, false);
  assert.equal(changes.length, 0);
});

test('watch hours are weekdays 06:00-19:59 New York', () => {
  assert.equal(watchHours(new Date('2026-11-20T19:23:35Z')), true); // Fri 14:23 ET
  assert.equal(watchHours(new Date('2026-11-20T10:30:00Z')), false); // Fri 05:30 ET
  assert.equal(watchHours(new Date('2026-11-21T16:00:00Z')), false); // Saturday
  assert.equal(watchHours(new Date('2026-11-21T00:30:00Z')), true); // Fri 19:30 ET
  assert.equal(watchHours(new Date('2026-11-21T01:00:00Z')), false); // Fri 20:00 ET
});
