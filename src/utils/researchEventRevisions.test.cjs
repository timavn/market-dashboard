const test = require('node:test');
const assert = require('node:assert/strict');
const { currentResearchEvents } = require('./researchEventRevisions.cjs');

test('a corrected re-parse supersedes only its own email, newest revision wins', () => {
  const events = [
    { productKey: 'investing-ideas', sourceMessageId: 'a', eventKey: 't#a#0000' },
    { productKey: 'investing-ideas', sourceMessageId: 'a', eventKey: 't#a#0000#revision-r1', parseRevision: 'r1', revisedAt: '2026-10-29T01:00:00+00:00' },
    { productKey: 'investing-ideas', sourceMessageId: 'a', eventKey: 't#a#0000#revision-r2', parseRevision: 'r2', revisedAt: '2026-10-29T02:00:00+00:00' },
    { productKey: 'investing-ideas', sourceMessageId: 'b', eventKey: 't#b#0000' },
  ];
  assert.deepEqual(currentResearchEvents(events).map((event) => event.eventKey), ['t#a#0000#revision-r2', 't#b#0000']);
});

test('a ledger with no revisions passes through unchanged', () => {
  const events = [{ productKey: 'etf-pro', sourceMessageId: 'a', eventKey: 't#a#0000' }];
  assert.equal(currentResearchEvents(events), events);
  assert.deepEqual(currentResearchEvents(undefined), []);
});
