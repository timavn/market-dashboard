const test = require('node:test');
const assert = require('node:assert/strict');
const { createMorningPredictionReview } = require('./analystMorningReview.cjs');
const { MARKETS } = require('./analystPredictions.cjs');

function fixture({ date = '2026-09-16T13:30:00Z' } = {}) {
  const settings = new Map();
  const conversation = { id: 'daily-prediction', messages: [] };
  const run = { runId: 'run-1', reviewKind: 'prediction-markets-review', state: 'running' };
  let starts = 0;
  const workspace = {
    initialize: async () => {},
    call: async (operation, args) => {
      if (operation === 'get') return { conversation };
      assert.equal(operation, 'setting');
      if ('value' in args) settings.set(args.key, args.value);
      return { value: settings.get(args.key) };
    },
  };
  const prepare = async (kind, force) => {
    assert.equal(kind, run.reviewKind); assert.equal(force, true); starts += 1;
    settings.set(`daily-run:${conversation.id}`, { kind, runId: run.runId, turnId: 'report-turn', startedAt: date });
    return conversation;
  };
  const service = createMorningPredictionReview({ workspace, prepare, request: async () => ({ run }), now: () => new Date(date) });
  const complete = (outcome = 'partial') => {
    Object.assign(run, { state: 'succeeded', outcome, completedAt: date, marketIds: MARKETS.map(([marketId]) => marketId) });
    conversation.messages.push({ role: 'assistant', state: 'complete', turn_id: 'report-turn', text: 'Current verified report with explicit coverage gaps.' });
  };
  return { service, run, conversation, settings, complete, starts: () => starts };
}

test('Hermes trigger reuses the daily workflow and deduplicates concurrent and repeated starts', async () => {
  const f = fixture();
  assert.equal((await f.service.status()).status, 'pending');
  const results = await Promise.all([f.service.start(), f.service.start()]);
  assert.ok(results.every(result => result.status === 'running'));
  assert.equal(f.starts(), 1);
  f.complete();
  const result = await f.service.start();
  assert.equal(result.status, 'ready');
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.marketIds, MARKETS.map(([id]) => id));
  assert.equal(f.starts(), 1);
});

test('waits for the exact report to reach the existing Analyst conversation', async () => {
  const f = fixture(); await f.service.start(); f.complete('ready');
  f.conversation.messages[0].turn_id = 'older-report-turn';
  assert.equal((await f.service.status()).status, 'running');
  f.conversation.messages[0].source_id = 'daily-report:run-1';
  assert.equal((await f.service.status()).status, 'ready');
  f.conversation.messages[0].state = 'failed';
  assert.equal((await f.service.status()).status, 'running');
});

test('rejects missing markets, wrong runs, and previous-day completion', async () => {
  const f = fixture(); await f.service.start(); f.complete();
  f.run.marketIds.pop();
  await assert.rejects(f.service.status(), /coverage is incomplete/);
  f.complete(); f.run.runId = 'wrong';
  await assert.rejects(f.service.status(), /identity/);
  f.run.runId = 'run-1'; f.run.completedAt = '2026-09-15T13:30:00Z';
  await assert.rejects(f.service.status(), /date is not current/);
});

test('blocked evidence and failed runs never become a successful morning review', async () => {
  const f = fixture(); await f.service.start(); f.complete('blocked');
  assert.equal((await f.service.status()).status, 'blocked');
  f.run.state = 'failed';
  assert.equal((await f.service.status()).status, 'failed');
});

test('holidays and weekends skip before starting any review', async () => {
  for (const date of ['2026-09-19T13:30:00Z', '2026-09-07T13:30:00Z']) {
    const f = fixture({ date });
    assert.equal((await f.service.start()).status, 'skipped');
    assert.equal(f.starts(), 0);
  }
});
