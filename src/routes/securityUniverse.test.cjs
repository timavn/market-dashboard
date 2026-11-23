const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSecurityUniverseHandler } = require('./securityUniverse.cjs');

const response = () => ({
  headers: {}, code: 200, body: null,
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

test('passes exact tickers and requested pieces to the record, as research-only data', async () => {
  let received;
  const handler = createSecurityUniverseHandler({ service: { load: async (symbols, options) => {
    received = { symbols, options };
    return { schemaVersion: 1, status: 'partial', rows: { DRAM: { symbol: 'DRAM' } }, historicalOnly: true, executable: false };
  } } });
  const res = response();
  await handler({ query: { symbols: ' dram,DRAM, lulu', fields: 'identity,stance' } }, res);
  assert.deepEqual(received, { symbols: ['DRAM', 'LULU'], options: { fields: ['identity', 'stance'] } });
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Data-Use'], 'historical-research-only');
  await handler({ query: { symbols: 'DRAM' } }, res);
  assert.deepEqual(received.options.fields, ['identity', 'classification', 'research', 'stance', 'risk', 'activity']);
});

test('rejects malformed tickers, unknown pieces and more than 50 tickers before any read', async () => {
  let reads = 0;
  const handler = createSecurityUniverseHandler({ service: { load: async () => { reads += 1; } } });
  for (const query of [{}, { symbols: '' }, { symbols: 'DRAM;x' }, { symbols: ['DRAM'] }, { symbols: 'DRAM,,LULU' },
    { symbols: Array.from({ length: 51 }, (_, index) => `S${index}`).join(',') }, { symbols: 'DRAM', fields: 'price' }, { symbols: 'DRAM', fields: ['identity'] }]) {
    const res = response();
    await handler({ query }, res);
    assert.equal(res.code, 400, JSON.stringify(query));
    assert.deepEqual(res.body.rows, {});
  }
  assert.equal(reads, 0);
});

test('an unavailable record or a failed read is a quiet 503', async () => {
  for (const load of [async () => ({ schemaVersion: 1, status: 'unavailable', rows: {} }), async () => { throw new Error('private detail'); }]) {
    const res = response();
    await createSecurityUniverseHandler({ service: { load } })({ query: { symbols: 'DRAM' } }, res);
    assert.equal(res.code, 503);
    assert.equal(res.body.status, 'unavailable');
    assert.equal(JSON.stringify(res.body).includes('private'), false);
  }
});
