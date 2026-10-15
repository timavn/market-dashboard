const test = require('node:test');
const assert = require('node:assert/strict');
const { lastCompletedPortfolioSession, portfolioResearchDate, openPortfolioReference } = require('./analystPortfolioReference.cjs');

test('research checks retain the last trading date on holidays and weekends but include premarket publications', () => {
  for (const [timestamp, expected] of [
    ['2026-09-06T15:00:00Z', '2026-09-04'],
    ['2026-09-07T15:00:00Z', '2026-09-04'],
    ['2026-04-03T15:00:00Z', '2026-04-02'],
    ['2026-09-08T12:00:00Z', '2026-09-08'],
    ['2026-09-08T21:00:00Z', '2026-09-08'],
  ]) assert.equal(portfolioResearchDate(new Date(timestamp)), expected, timestamp);
});

test('completed sessions follow Eastern time, exchange holidays, early closes, and DST', () => {
  for (const [timestamp, expected] of [
    ['2026-09-05T01:00:00Z', '2026-09-04'],
    ['2026-09-07T15:00:00Z', '2026-09-04'],
    ['2026-09-08T13:29:00Z', '2026-09-04'],
    ['2026-09-08T19:59:00Z', '2026-09-04'],
    ['2026-09-08T20:00:00Z', '2026-09-08'],
    ['2026-11-27T17:59:00Z', '2026-11-25'],
    ['2026-11-27T18:00:00Z', '2026-11-27'],
    ['2027-01-01T17:00:00Z', '2026-12-31'],
  ]) assert.equal(lastCompletedPortfolioSession(new Date(timestamp)), expected, timestamp);
});

const savedRun = (runId, conversationId) => ({
  runId, conversationId, reviewKind: 'portfolio-review', state: 'succeeded', outcome: 'partial',
  reportMarkdown: `Captured report ${runId}`, completedAt: '2026-09-04T20:06:00Z',
  dependencies: { portfolio: { status: 'partial', asOf: '2026-09-04T20:05:00Z', detail: { liveVerified: true } } },
});

test('saved history checks all deleted revisions in one call before opening the retained report', async () => {
  const removed = Array.from({ length: 450 }, (_, index) => savedRun(`removed-${index}`, `removed-${index % 45}`));
  const retained = savedRun('retained', 'kept');
  const vanished = savedRun('vanished', 'vanished');
  const tombstoned = savedRun('tombstoned', 'tombstoned');
  const calls = [];
  const conversation = { id: 'kept', messages: [{ id: 'message', role: 'assistant', state: 'complete', text: retained.reportMarkdown }] };
  const request = async url => {
    assert.equal(url, '/internal/reviews?limit=500&view=portfolio-reference');
    return { runs: [...removed, vanished, tombstoned, retained] };
  };
  const call = async (operation, body) => {
    calls.push([operation, body]);
    if (operation === 'deleted') return { deletedConversationIds: Array.from({ length: 45 }, (_, index) => `removed-${index}`) };
    if (operation === 'get') {
      assert.equal(body.includeBriefs, false, 'opening a saved capture does not hydrate its briefs before the receipt');
      if (body.conversationId === 'vanished') throw Object.assign(new Error('Deleted concurrently'), { statusCode: 404 });
      if (body.conversationId === 'tombstoned') throw Object.assign(new Error('Conversation was deleted'), { statusCode: 410, code: 'ANALYST_CONVERSATION_DELETED' });
      assert.equal(body.conversationId, 'kept');
      return { conversation };
    }
    assert.equal(operation, 'setting');
    assert.equal(body.value.runId, 'retained');
    return {};
  };
  assert.deepEqual(await openPortfolioReference({ call, request, now: new Date('2026-09-07T15:00:00Z') }), { ...conversation, briefsIncluded: false });
  const checks = calls.filter(([operation]) => operation === 'deleted');
  assert.equal(checks.length, 1);
  assert.equal(checks[0][1].conversationIds.length, 48);
  assert.deepEqual(calls.filter(([operation, body]) => operation === 'get' && body.conversationId === 'kept')
    .map(([, body]) => body.includeBriefs), [false, false]);
});

test('restoring an unposted capture fetches only its full report for original citations', async () => {
  const run = savedRun('selected', 'kept');
  const citations = [{ id: 'original-evidence', publicationDate: '2026-09-04' }];
  const conversation = { id: 'kept', messages: [] };
  const requested = [];
  const request = async url => {
    requested.push(url);
    if (url.includes('?')) return { runs: [run] };
    assert.equal(url, '/internal/reviews/selected');
    return { run: { ...run, citations } };
  };
  const call = async (operation, body) => {
    if (operation === 'deleted') return { deletedConversationIds: [] };
    if (operation === 'get') return { conversation };
    if (operation === 'append') {
      assert.equal(body.text, run.reportMarkdown);
      assert.equal(body.createdAt, run.completedAt);
      assert.deepEqual(body.citations, citations);
      conversation.messages.push({ id: 'restored', source_id: body.sourceId, role: 'assistant', state: 'complete', text: body.text });
    } else assert.equal(operation, 'setting');
    return {};
  };
  await openPortfolioReference({ call, request, now: new Date('2026-09-07T15:00:00Z') });
  assert.deepEqual(requested, ['/internal/reviews?limit=500&view=portfolio-reference', '/internal/reviews/selected']);
});

test('a missing batch deletion result cannot revive deleted history', async () => {
  await assert.rejects(openPortfolioReference({
    request: async () => ({ runs: [savedRun('old', 'deleted')] }),
    call: async operation => { assert.equal(operation, 'deleted'); return {}; },
    now: new Date('2026-09-07T15:00:00Z'),
  }), /Saved review history is unavailable/);
});
