const test = require('node:test');
const assert = require('node:assert/strict');
const { createHedgaiResearchLoader, createHedgaiResearchHandlers } = require('./hedgaiResearch.cjs');
const { selectHedgaiMarketReading } = require('../services/hedgaiMarketResearch.cjs');

const projection = { version: 1, product: 'hedgai-signals', baselineDate: '2026-09-28', metricsDate: '2026-09-28',
  book: { rows: [{ instrumentId: 'hedgai:QQQ', position: 'Short', bullEligible: true, bearEligible: false, activeDirection: null }] }, sources: [] };
const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; },
  set(name, value) { this.headers[name] = value; return this; }, json(body) { this.body = body; return this; },
  sendStatus(code) { this.code = code; return this; }, send(body) { this.body = body; return this; } });

test('native mappings remain dated research and never promote Nasdaq buy history or unmapped instruments', () => {
  const reading = selectHedgaiMarketReading(projection, 'nasdaq100');
  assert.equal(reading.position, 'Short');
  assert.equal(reading.activeDirection, null);
  assert.equal(reading.mapping.fit, 'proxy');
  assert.equal(reading.executable, false);
  assert.equal(reading.decisionEligible, false);
  assert.equal(selectHedgaiMarketReading(projection, 'ethereum'), null);
  assert.equal(selectHedgaiMarketReading({ ...projection, product: 'trade' }, 'nasdaq100'), null);
  const partialMetrics = { ...projection, metricsDate: '2026-10-01',
    book: { rows: [{ ...projection.book.rows[0], metricsDate: '2026-09-28' }] } };
  assert.equal(selectHedgaiMarketReading(partialMetrics, 'nasdaq100').metricsDate, '2026-09-28');
});

test('ledger failure retains verified history but explicitly suppresses current availability', async () => {
  let error = false;
  const calls = [];
  const eventCalls = [];
  const load = createHedgaiResearchLoader({ loadBaseline: () => ({ reviewed: true }),
    loadEvents: async options => { eventCalls.push(options); return error ? { error: 'offline', items: [] } : { items: [{ eventKey: 'verified-event' }] }; },
    buildProjection: input => { calls.push(input); return projection; },
  });
  await load({ asOf: '2026-09-28T18:00:00Z' });
  error = true;
  const result = await load({ asOf: '2026-09-28T19:00:00Z', forceRefresh: true, refreshAfter: 123 });
  assert.deepEqual(eventCalls[1], { forceRefresh: true, refreshAfter: 123 });
  assert.equal(calls[1].availability, 'unavailable');
  assert.deepEqual(calls[1].events, [{ eventKey: 'verified-event' }]);
  assert.equal(result.marketReadings.nasdaq100.contextOnly, true);
});

test('endpoint requires a bounded timezone-bearing capture time and re-reads the ledger at most every two minutes', async () => {
  let captured;
  const handlers = createHedgaiResearchHandlers({ now: () => new Date('2026-09-28T20:00:00Z'),
    loadResearch: async input => { captured = input; return projection; }, loadBaseline: () => ({}), root: process.cwd() });
  for (const asOf of ['invalid', '2026-09-28', '2027-01-01T00:00:00Z']) {
    const res = response();
    await handlers.research({ query: { asOf } }, res);
    assert.equal(res.code, 400);
  }
  const res = response();
  await handlers.research({ query: { asOf: '2026-09-28T12:43:00Z' } }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(captured.asOf, '2026-09-28T12:43:00Z');
  assert.equal(captured.forceRefresh, true);
  // A ledger read from the last two minutes is reused; an older one is replaced.
  assert.equal(captured.refreshAfter, Date.parse('2026-09-28T20:00:00Z') - 120_000);
  assert.equal(res.body, projection);
  const invalidSource = response();
  await handlers.source({ params: { sourceId: '../private' } }, invalidSource);
  assert.equal(invalidSource.code, 404);
});

test('all reviewed screenshot links serve exact archived PNGs and reject changed source bytes', async () => {
  const { loadReviewedBaseline } = require('../services/hedgaiResearch.cjs');
  const baseline = loadReviewedBaseline();
  const handlers = createHedgaiResearchHandlers({ loadBaseline: () => baseline, root: process.cwd() });
  for (const source of baseline.sources) {
    const res = response();
    await handlers.source({ params: { sourceId: source.id } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.ok(Buffer.isBuffer(res.body));
    assert.equal(require('node:crypto').createHash('sha256').update(res.body).digest('hex'), source.imageSha256);
  }
  const bad = createHedgaiResearchHandlers({ loadBaseline: () => ({ sources: [{ ...baseline.sources[0], imageSha256: '0'.repeat(64) }] }), root: process.cwd() });
  const res = response();
  await bad.source({ params: { sourceId: baseline.sources[0].id } }, res);
  assert.equal(res.code, 404);
});
