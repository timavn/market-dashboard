const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registry = require('../../../infra/lambdas/gmail_ingestor/research_products.json');
// The deployed registry still names the retired Signal Strength Shorts; readiness never lists it.
const listed = registry.products.filter(row => row.id !== 'signal-strength-shorts');
const { automatedSourceReadiness, sourceLibraryRows, FEED_MAX_AGE_MS } = require('./analystSourceReadiness.cjs');
const { dailyReadiness } = require('./analystPolicy.cjs');
const { attachDailyWorkflow } = require('./analystDaily.cjs');

const now = new Date('2026-09-14T17:00:00.000Z');
const providerTime = '2026-09-14T12:01:00.000Z';
const indexTime = '2026-09-14T12:02:00.000Z';
const evidence = () => ({
  feedGeneratedAt: now.toISOString(),
  products: [{ product: 'risk-ranges', latestPublicationDate: '2026-09-14', observedAt: providerTime,
    sourceIds: ['gmail-message-1'], evidenceHash: 'validated-revision-1', status: 'indexed',
    stages: { received: true, parsed: true, validated: true, indexed: true } }],
  indexed: [{ product: 'risk-ranges', publication_date: '2026-09-14', document_id: 'document-1',
    content_hash: 'document-content-1', source_uri: 's3://research/risk-ranges/2026-09-14.pdf', indexed_at: indexTime }],
});
// Rows follow registry order; the fixture product is looked up by id.
const riskRow = rows => rows.find(row => row.id === 'risk-ranges');
const first = input => riskRow(automatedSourceReadiness(input, now));

test('daily source roster requires dated provider and local index evidence and preserves actual source times', () => {
  const input = evidence();
  const result = automatedSourceReadiness(input, now);
  assert.deepEqual(result.map(row => row.id), listed.map(row => row.id));
  assert.equal(result.some(row => row.id === 'signal-strength-shorts'), false);
  assert.deepEqual(riskRow(result), {
    id: 'risk-ranges', label: 'Risk Ranges', publicationDate: '2026-09-14', observedAt: providerTime,
    indexedAt: indexTime, updatedAt: indexTime, usableForDay: true, status: 'ready', reason: null,
    sourceUri: input.indexed[0].source_uri, sourceIds: ['gmail-message-1', input.indexed[0].source_uri], evidenceHash: 'validated-revision-1',
  });
  assert.ok(result.filter(row => row.id !== 'risk-ranges').every(row => !row.usableForDay && row.updatedAt === null));
  const daily = dailyReadiness(input, now);
  assert.equal(daily.checkedAt, now.toISOString());
  assert.equal(daily.date, '2026-09-14');
  assert.deepEqual(daily.automatedSources, sourceLibraryRows(result));
  assert.equal(first({ ...input, feedGeneratedAt: new Date(now.getTime() - 60_000).toISOString() }).updatedAt, indexTime);
});

test('failed, stale, offline, cache-only, seed, and mock evidence never reports a usable source', () => {
  const assertSuppressed = result => {
    for (const field of ['publicationDate', 'observedAt', 'indexedAt', 'updatedAt', 'sourceUri', 'evidenceHash']) assert.equal(result[field], null, field);
    assert.deepEqual(result.sourceIds, []);
    assert.equal(result.label, 'Risk Ranges');
    assert.equal(result.status, 'unavailable');
  };
  const flags = [{ status: 'failed' }, { status: 'offline' }, { connected: false }, { stale: true },
    { cacheOnly: true }, { seeded: true }, { mock: true }, { metadata: { freshness: 'stale' } },
    { metadata: { provenance: { sourceType: 'fixture' } } }, { sourceIds: ['mock:document'] }];
  for (const flagsForRow of flags) {
    const input = evidence();
    Object.assign(input.products[0], flagsForRow);
    assert.equal(first(input).usableForDay, false, JSON.stringify(flagsForRow));
    assertSuppressed(first(input));
  }
  for (const metadata of [{ stale: true }, { offline: true }, { cacheOnly: true }, { seed: true }, { mock: true }]) {
    const input = evidence();
    input.indexed[0].metadata_json = JSON.stringify(metadata);
    assert.equal(first(input).usableForDay, false, JSON.stringify(metadata));
    assertSuppressed(first(input));
  }
  for (const flag of [{ feedError: 'Disconnected' }, { errors: ['Publication read failed'] }, { status: 'offline' }, { cacheOnly: true },
    { feedGeneratedAt: null }, { feedGeneratedAt: new Date(now.getTime() - FEED_MAX_AGE_MS - 1).toISOString() },
    { feedGeneratedAt: new Date(now.getTime() + 60_000).toISOString() }]) {
    assert.equal(first({ ...evidence(), ...flag }).usableForDay, false, JSON.stringify(flag));
  }
});

test('verified earlier publications retain their original dates and source evidence without claiming today usability', () => {
  const input = evidence();
  input.products[0].latestPublicationDate = '2026-09-11';
  input.products[0].observedAt = '2026-09-11T12:01:00.000Z';
  input.indexed = [];
  const result = first(input);
  assert.equal(result.usableForDay, false);
  assert.equal(result.publicationDate, '2026-09-11');
  assert.equal(result.updatedAt, '2026-09-11T12:01:00.000Z');
  assert.equal(result.observedAt, input.products[0].observedAt);
  assert.equal(result.indexedAt, null);
  assert.deepEqual(result.sourceIds, input.products[0].sourceIds);
  assert.equal(result.evidenceHash, input.products[0].evidenceHash);
});

test('missing provenance, previous publication, partial stages and unindexed corrections are unavailable', () => {
  const invalid = [
    input => { input.products[0].observedAt = null; },
    input => { input.products[0].observedAt = '2026-09-14'; },
    input => { input.products[0].evidenceHash = null; },
    input => { input.products[0].latestPublicationDate = '2026-09-11'; },
    input => { input.products[0].stages.validated = false; },
    input => { input.products[0].status = 'indexing'; },
    input => { input.products[0].observedAt = '2026-09-14T12:03:00.000Z'; },
    input => { input.indexed[0].indexed_at = '2026-09-14T17:01:00.000Z'; },
    input => { input.indexed[0].source_uri = null; },
    input => { input.indexed[0].content_hash = null; },
    input => { input.indexed[0].metadata_json = 'invalid-json'; },
    input => { input.indexed = []; },
  ];
  for (const mutate of invalid) {
    const input = evidence(); mutate(input);
    assert.equal(first(input).usableForDay, false, mutate.toString());
  }
  const input = evidence();
  input.products[0].observedAt = '2026-09-14T12:03:00.000Z';
  input.indexed[0].indexed_at = '2026-09-14T12:04:00.000Z';
  assert.equal(first(input).usableForDay, true);
});

test('a Crypto Quant email filed as its Bitcoin Tracker is ready under both ids and listed once', () => {
  const input = evidence();
  input.products.push({ ...input.products[0], product: 'bitcoin-trend-tracker' },
    { product: 'crypto-quant', latestPublicationDate: '2026-09-14', observedAt: providerTime, sourceIds: [],
      evidenceHash: 'coverage-1', status: 'not_due', stages: { received: false, parsed: false, validated: false, indexed: false } });
  input.indexed.push({ ...input.indexed[0], product: 'bitcoin-trend-tracker', document_id: 'document-2' });
  const rows = automatedSourceReadiness(input, now);
  const row = id => rows.find(item => item.id === id);
  assert.equal(row('crypto-quant').status, 'ready');
  assert.equal(row('crypto-quant').label, 'Crypto Quant');
  assert.equal(row('bitcoin-trend-tracker').status, 'ready');
  const library = dailyReadiness(input, now).automatedSources;
  assert.equal(library.some(item => item.id === 'crypto-quant'), false);
  assert.equal(library.find(item => item.id === 'bitcoin-trend-tracker').label, 'Crypto Quant · Bitcoin Tracker');
  assert.equal(library.length, listed.length - 1);
});

test('a product with nothing received today is not received, not a pipeline failure', () => {
  const input = evidence();
  // Coverage dates a not-due product to the market day with no receipt.
  input.products[0] = { product: 'risk-ranges', latestPublicationDate: '2026-09-14', observedAt: providerTime,
    sourceIds: [], evidenceHash: 'coverage-1', status: 'not_due',
    stages: { received: false, parsed: false, validated: false, indexed: false } };
  input.indexed = [];
  assert.equal(first(input).status, 'not_received');
  assert.equal(first(input).reason, 'No publication received today');
  assert.equal(first({ ...input, products: [] }).status, 'not_received');
  const failed = evidence();
  failed.products[0].stages.validated = false;
  assert.equal(first(failed).status, 'unavailable');
  assert.equal(first({ ...input, feedGeneratedAt: null }).status, 'unavailable');
});

test('source availability guard does not alter the existing daily review gate', () => {
  const input = evidence();
  const before = dailyReadiness(input, now);
  const failed = dailyReadiness({ ...input, feedError: 'Source feed failed' }, now);
  assert.deepEqual(failed.required, before.required);
  assert.equal(failed.ready, before.ready);
  assert.equal(failed.fingerprint, before.fingerprint);
  assert.equal(riskRow(before.automatedSources).usableForDay, true);
  assert.equal(riskRow(failed.automatedSources).usableForDay, false);
});

test('daily API drops source readiness after a feed failure and restores it after successful refresh', async t => {
  let offline = false;
  const input = evidence();
  const request = async url => {
    if (url.endsWith('/readiness')) return input;
    if (url.endsWith('/changes')) {
      if (offline) throw new Error('Source provider disconnected');
      return { events: [] };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const workspace = { router: express.Router(), initialize: async () => {}, call: async operation => operation === 'findings' ? { findings: [] } : {} };
  const daily = attachDailyWorkflow({ workspace, request, now: () => now });
  const app = express(); app.use(workspace.router);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/daily`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.status, 200);
    return response.json();
  };
  await daily.tick();
  assert.equal(riskRow((await read()).automatedSources).usableForDay, true);
  offline = true;
  await daily.tick();
  assert.equal(riskRow((await read()).automatedSources).usableForDay, false);
  offline = false;
  await daily.tick();
  assert.equal(riskRow((await read()).automatedSources).usableForDay, true);
});
