import { reuseAnalystEvidence } from './analystEvidenceIdentity';

test('fresh unchanged captured evidence reuses identities but same-revision metadata corrections remain visible', () => {
  const previous = { revision: 12, messages: [
    { id: 'report', text: 'Captured report', citations: [{ id: 'source', observedAt: '2026-10-05T14:00:00Z' }] },
    { id: 'follow-up', text: 'Saved explanation' },
  ], referenceReview: { runId: 'run-1', historicalHoldings: true } };
  const fresh = JSON.parse(JSON.stringify(previous));
  expect(reuseAnalystEvidence(previous, fresh)).toBe(previous);
  fresh.messages[0].citations[0].observedAt = '2026-10-05T14:05:00Z';
  fresh.referenceReview.historicalHoldings = false;
  const revised = reuseAnalystEvidence(previous, fresh);
  expect(revised).not.toBe(previous);
  expect(revised.messages[0].citations[0].observedAt).toBe('2026-10-05T14:05:00Z');
  expect(revised.messages[1]).toBe(previous.messages[1]);
  expect(revised.referenceReview.historicalHoldings).toBe(false);
  expect(previous.messages[0].citations[0].observedAt).toBe('2026-10-05T14:00:00Z');
});

test('revoked source fields and removed report messages are not retained by identity reuse', () => {
  const previous = { messages: [{ id: 'report', quote: 123, verified: true }, { id: 'removed' }] };
  const revised = reuseAnalystEvidence(previous, { messages: [{ id: 'report', verified: false }] });
  expect(revised.messages).toHaveLength(1);
  expect(revised.messages[0]).toEqual({ id: 'report', verified: false });
  expect(revised.messages[0]).not.toHaveProperty('quote');
});
