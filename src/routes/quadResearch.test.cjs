'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuadResearchHandler } = require('./quadResearch.cjs');

function response() {
  return { headers: {}, statusCode: null, body: null,
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
test('read-only API returns the verified dated edition independently of live quote state', async () => {
  const edition = { available: true, source: 'independent-quad-research', historicalOnly: true,
    generatedAt: '2026-09-08T00:00:00Z', cutoff: '2026-Q2', cells: [], groupResults: [{ privateInternalCalculation: true }] };
  const handler = createQuadResearchHandler({ store: { latest: async () => edition } });
  for (const quoteStatus of ['live', 'offline', 'delayed', 'unavailable']) {
    const res = response();
    await handler({ quoteStatus }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.available, true);
    assert.equal(res.body.generatedAt, edition.generatedAt);
    assert.equal(res.body.groupResults, undefined);
  }
});
test('missing edition stays explicit and unexpected service failure returns no estimates', async () => {
  const res = response();
  await createQuadResearchHandler({ store: { latest: async () => ({ available: false, cells: [] }) } })({}, res);
  assert.equal(res.body.available, false);
  const failed = response();
  await createQuadResearchHandler({ store: { latest: async () => { throw new Error('private path'); } } })({}, failed);
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.body.cells, []);
  assert.equal(JSON.stringify(failed.body).includes('private path'), false);
});
