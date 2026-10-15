const test = require('node:test');
const assert = require('node:assert/strict');
const { logRunSettlement, runSettlementLine } = require('./analystRunTimeline.cjs');

const at = new Date('2026-10-09T20:45:05.123Z');

test('a settled run logs consecutive phase durations from the clocks it recorded', () => {
  const line = runSettlementLine({ runId: 'run-1', kind: 'balance-review', state: 'succeeded', phaseTimes: {
    acceptedAt: '2026-10-09T20:44:00.000Z', dispatchedAt: '2026-10-09T20:44:00.250Z', captureSettledAt: '2026-10-09T20:44:11.000Z',
    summarizingAt: '2026-10-09T20:44:11.400Z', settledAt: '2026-10-09T20:44:49.200Z', publishedAt: '2026-10-09T20:44:11.300Z' } }, at);
  assert.equal(line, '2026-10-09T20:45:05.123Z [analyst] run settled runId=run-1 kind=balance-review state=succeeded '
    + 'accepted->dispatched=250ms dispatched->captureSettled=10750ms captureSettled->summarizing=400ms '
    + 'summarizing->settled=37800ms total=49200ms');
});

test('missing or invalid clocks are skipped and identities cannot inject text', () => {
  const line = runSettlementLine({ runId: 'run 2\nforged=1', kind: undefined, state: 'failed',
    phaseTimes: { acceptedAt: 'not a time', captureSettledAt: '2026-10-09T20:44:11Z', settledAt: '2026-10-09T20:44:12Z' } }, at);
  assert.equal(line, '2026-10-09T20:45:05.123Z [analyst] run settled runId=run2forged1 kind=- state=failed '
    + 'captureSettled->settled=1000ms total=1000ms');
});

test('a failing logger never affects settlement', () => {
  assert.doesNotThrow(() => logRunSettlement({ runId: 'run-3', kind: 'portfolio-review', state: 'succeeded' },
    () => { throw new Error('stdout closed'); }));
});
