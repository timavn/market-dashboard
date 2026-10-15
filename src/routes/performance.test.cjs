const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { DynamoDB } = require('../services/aws/clients.cjs');
let scan;
const original = DynamoDB.DocumentClient;
DynamoDB.DocumentClient = function () { this.scan = params => ({ promise: () => scan(params) }); };
const router = require('./performance');
DynamoDB.DocumentClient = original;

async function fixture(context, pages) {
  const requests = [];
  scan = async params => { requests.push(params); assert.ok(pages.length, 'unexpected database read'); return pages.shift(); };
  const app = express(); app.use('/api/performance', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { requests, request: path => fetch(`http://127.0.0.1:${server.address().port}/api/performance${path}`) };
}
test('historical performance includes all pages before chronological return calculation', async context => {
  const { request, requests } = await fixture(context, [
    { Items: [{ date: '2026-09-02', summary: { totalValue: 110 } }], LastEvaluatedKey: { id: 'a' } },
    { Items: [], LastEvaluatedKey: { id: 'b' } },
    { Items: [{ date: '2026-09-01', summary: { totalValue: 100 } }] },
  ]);
  const response = await request('/history?range=all'); assert.equal(response.status, 200);
  const result = await response.json(); assert.deepEqual(result.history.map(row => row.date), ['2026-09-01', '2026-09-02']);
  assert.equal(result.history[1].dailyReturn, 10); assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].ExclusiveStartKey, { id: 'b' });
});
test('statement lookup and its holdings survive empty filtered pages', async context => {
  const { request } = await fixture(context, [
    { Items: [], LastEvaluatedKey: { id: 'a' } },
    { Items: [{ date: '2026-09-01', totalValue: 100 }] },
    { Items: [{ symbol: 'AAA' }], LastEvaluatedKey: { id: 'b' } },
    { Items: [{ symbol: 'BBB' }] },
  ]);
  const response = await request('/statement/2026-09-01'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).holdings.map(row => row.symbol), ['AAA', 'BBB']);
});
test('missing verified benchmark data never yields random performance history', async context => {
  const { request, requests } = await fixture(context, []);
  const response = await request('/benchmark'); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', reason: 'verified_benchmark_history_unavailable', portfolio: [], benchmarks: {} });
  assert.equal(requests.length, 0);
});
