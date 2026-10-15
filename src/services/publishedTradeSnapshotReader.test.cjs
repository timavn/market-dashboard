'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublishedTradeSnapshotReader } = require('./publishedTradeSnapshotReader.cjs');
const request = (value) => ({ promise: async () => value });
const key = (date, snapshotType = 'early-look') => ({ date, snapshotType });
const projection = { snapshotProjectionExpression: '#date, #article.#text',
  snapshotAttributeNames: { '#date': 'date', '#article': 'article', '#text': 'bodyText' } };

test('queries only index keys and projects original source evidence in base-table reads', async () => {
  const queries = [];
  const batches = [];
  const item = { ...key('2026-08-18'), article: { bodyText: 'CRB is BULLISH TRADE.' } };
  const read = createPublishedTradeSnapshotReader({ dynamodb: {
    query(input) { queries.push(input); return request({ Items: [key(item.date)] }); },
    batchGet(input) { batches.push(input); return request({ Responses: { HedgeyeDailySnapshot: [item] } }); },
  } });
  assert.deepEqual(await read('early-look', { limit: 60, ...projection }), [item]);
  assert.equal(queries[0].IndexName, 'snapshotType-date-meta-index');
  assert.equal(queries[0].ProjectionExpression, '#type, #date');
  assert.equal(queries[0].ScanIndexForward, false);
  assert.equal(queries[0].Limit, 60);
  assert.deepEqual(batches[0].RequestItems.HedgeyeDailySnapshot, {
    Keys: [key(item.date)], ConsistentRead: false,
    ProjectionExpression: projection.snapshotProjectionExpression,
    ExpressionAttributeNames: projection.snapshotAttributeNames,
  });
});

test('bounds all product read operations to two concurrent requests, including after a failure', async () => {
  let active = 0;
  let maximum = 0;
  const read = createPublishedTradeSnapshotReader({ concurrency: 20, dynamodb: {
    query(input) { return { promise: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      if (input.ExpressionAttributeValues[':type'] === 'fail') throw new Error('Source failed');
      return { Items: [] };
    } }; },
  } });
  const results = await Promise.allSettled(['one', 'fail', 'three', 'four', 'five'].map(type => read(type)));
  assert.equal(maximum, 2);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual(await read('six'), []);
});

test('retries only unprocessed keys and keeps source projections on every attempt', async () => {
  const keys = [key('2026-08-18'), key('2026-08-19')];
  const batches = [];
  const read = createPublishedTradeSnapshotReader({ dynamodb: {
    query() { return request({ Items: keys }); },
    batchGet(input) {
      batches.push(input.RequestItems.HedgeyeDailySnapshot);
      return request(batches.length === 1 ? {
        Responses: { HedgeyeDailySnapshot: [keys[0]] },
        UnprocessedKeys: { HedgeyeDailySnapshot: { Keys: [keys[1]] } },
      } : { Responses: { HedgeyeDailySnapshot: [keys[1]] } });
    },
  } });
  assert.deepEqual(await read('early-look', projection), keys);
  assert.deepEqual(batches.map(batch => batch.Keys), [keys, [keys[1]]]);
  assert.ok(batches.every(batch => batch.ProjectionExpression === projection.snapshotProjectionExpression));
});

test('rejects an incomplete batch after bounded retries without publishing a partial result', async () => {
  let calls = 0;
  const keys = [key('2026-08-18')];
  const read = createPublishedTradeSnapshotReader({ dynamodb: {
    query() { return request({ Items: keys }); },
    batchGet() { calls++; return request({ UnprocessedKeys: { HedgeyeDailySnapshot: { Keys: keys } } }); },
  } });
  await assert.rejects(read('early-look', projection), { code: 'HEDGEYE_SNAPSHOT_BATCH_UNPROCESSED' });
  assert.equal(calls, 4);
});

test('a missing index falls back to bounded projected exact-date keys and never scans', async () => {
  const gets = [];
  const read = createPublishedTradeSnapshotReader({ now: () => new Date('2026-09-26T20:00:00Z'), dynamodb: {
    query() { return { promise: async () => { throw Object.assign(new Error('Index missing'), { code: 'ResourceNotFoundException' }); } }; },
    get(input) { gets.push(input); return request(gets.length === 3 ? { Item: input.Key } : {}); },
    scan() { throw new Error('A table scan must never run'); },
  } });
  assert.deepEqual(await read('early-look', { limit: 1, ...projection }), [key('2026-09-24')]);
  assert.deepEqual(gets.map(input => input.Key.date), ['2026-09-26', '2026-09-25', '2026-09-24']);
  assert.ok(gets.every(input => input.ProjectionExpression === projection.snapshotProjectionExpression));
});

test('authentication failures do not trigger alternate reads or scans', async () => {
  const read = createPublishedTradeSnapshotReader({ dynamodb: {
    query() { return { promise: async () => { throw Object.assign(new Error('Denied'), { code: 'AccessDeniedException' }); } }; },
    get() { throw new Error('Unexpected fallback'); },
  } });
  await assert.rejects(read('early-look'), { code: 'AccessDeniedException' });
});
