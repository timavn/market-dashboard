'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHedgaiLedgerLoader } = require('./hedgaiResearchLedger.cjs');

test('full-product paging preserves the existing 20000 limit and exact original event payloads', async () => {
  const calls = [];
  const pages = Array.from({ length: 21 }, (_, page) => Array.from({ length: 1000 }, (_, index) => ({
    eventKey: `${page}:${index}`, eventType: page % 2 ? 'HEDGAI_SOURCE_REPARSE' : 'HEDGAI_PUBLICATION',
    payload: { exactSource: 'Retained original publication', unknownField: [null, 'original'] },
  })));
  const load = createHedgaiLedgerLoader({ tableName: 'exact-ledger', dynamodb: { query(params) {
    calls.push(params);
    return { promise: async () => ({ Items: pages[calls.length - 1], LastEvaluatedKey: { eventKey: `page-${calls.length}` } }) };
  } } });
  const result = await load();
  assert.equal(result.error, null);
  assert.equal(result.items.length, 20000);
  assert.equal(calls.length, 20);
  assert.deepEqual(result.items, pages.slice(0, 20).flat());
  assert.deepEqual(calls[0], {
    TableName: 'exact-ledger', KeyConditionExpression: '#productKey = :productKey',
    ExpressionAttributeNames: { '#productKey': 'productKey' },
    ExpressionAttributeValues: { ':productKey': 'hedgai-signals' },
    ScanIndexForward: true, ConsistentRead: false, Limit: 1000,
  });
  assert.deepEqual(calls[1].ExclusiveStartKey, { eventKey: 'page-1' });
});

test('explicit floor and limit use the existing key condition without inventing a baseline cutoff', async () => {
  let params;
  const items = [{ eventType: 'HEDGAI_BASELINE' }, { eventType: 'HEDGAI_SOURCE_REPARSE' }, { eventType: 'HEDGAI_ACTION' }];
  const load = createHedgaiLedgerLoader({ tableName: 'ledger', dynamodb: { query(input) {
    params = input; return { promise: async () => ({ Items: items }) };
  } } });
  const result = await load({ sinceEventTime: '2026-09-28T00:00:00Z', limit: 2 });
  assert.equal(params.KeyConditionExpression, '#productKey = :productKey AND #eventKey >= :startEventKey');
  assert.equal(params.ExpressionAttributeValues[':startEventKey'], '2026-09-28T00:00:00Z');
  assert.equal(params.Limit, 2);
  assert.deepEqual(result.items, items.slice(0, 2));
});

test('fresh-read cache retains its five-minute policy and coalesces concurrent forced reads', async () => {
  let clock = 100;
  let calls = 0;
  let release;
  const load = createHedgaiLedgerLoader({ tableName: 'ledger', now: () => clock, dynamodb: { query() {
    calls += 1;
    return { promise: () => calls === 1 ? Promise.resolve({ Items: [{ eventKey: 'old' }] })
      : new Promise(resolve => { release = resolve; }) };
  } } });
  await load();
  clock = 200;
  assert.deepEqual((await load()).items, [{ eventKey: 'old' }]);
  assert.equal(calls, 1);
  const first = load({ forceRefresh: true, refreshAfter: 150 });
  const second = load({ forceRefresh: true, refreshAfter: 150 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  release({ Items: [{ eventKey: 'fresh' }] });
  assert.deepEqual((await first).items, [{ eventKey: 'fresh' }]);
  assert.deepEqual(await second, await first);
  assert.deepEqual((await load({ forceRefresh: true, refreshAfter: 150 })).items, [{ eventKey: 'fresh' }]);
  assert.equal(calls, 2);
});

test('expired or force-failed delivery never reports retained ledger rows as available', async () => {
  let clock = 0;
  let fail = false;
  const load = createHedgaiLedgerLoader({ tableName: 'ledger', now: () => clock, dynamodb: { query() {
    return { promise: async () => {
      if (fail) throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
      return { Items: [{ eventKey: 'original' }] };
    } };
  } } });
  await load();
  clock = 300001;
  fail = true;
  assert.deepEqual(await load(), { items: [], error: 'RESEARCH_EVENT_LEDGER_CACHE_STALE' });
  assert.deepEqual(await load({ forceRefresh: true }), { items: [], error: 'OFFLINE' });
});
