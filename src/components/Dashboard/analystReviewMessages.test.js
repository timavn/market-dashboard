import { analystReviewMessages } from './analystReviewMessages';

const review = (id, post = 'base', run = id, extra = {}) => ({
  id, role: 'assistant', state: 'complete', text: `Report ${id}`, reviewPostId: post, reviewRunId: run, ...extra,
});
const narrative = (id, post, run) => review(id, post, run, { reviewNarrative: true });
const ids = conversation => analystReviewMessages(conversation).map(message => message.id);

test.each(['portfolio-review', 'balance-review', 'prediction-markets-review'])('%s collapses automatic revisions into their latest post and matching explanation', kind => {
  const conversation = { kind, messages: [
    review('first', 'base', 'run-1'), narrative('old-notes', 'base', 'run-1'),
    review('latest', 'base', 'run-2'), narrative('new-notes', 'base', 'run-2'),
  ] };
  expect(ids(conversation)).toEqual(['latest', 'new-notes']);
  expect(conversation.messages).toHaveLength(4);
});

test('keeps explicitly requested posts and real user/assistant dialogue in original order', () => {
  const user = { id: 'question', role: 'user', text: 'Why did the cash balance change?' };
  const assistant = { id: 'answer', role: 'assistant', text: 'The filled order changed cash.' };
  const conversation = { kind: 'balance-review', messages: [
    review('first', 'base', 'run-1'), narrative('first-notes', 'base', 'run-1'),
    user, assistant,
    review('requested', 'requested-post', 'run-2'), narrative('requested-notes', 'requested-post', 'run-2'),
    review('requested-revision', 'requested-post', 'run-3'), narrative('latest-notes', 'requested-post', 'run-3'),
  ] };
  expect(ids(conversation)).toEqual(['first', 'first-notes', 'question', 'answer', 'requested-revision', 'latest-notes']);
  expect(analystReviewMessages(conversation)[2]).toBe(user);
  expect(analystReviewMessages(conversation)[3]).toBe(assistant);
});

test('does not attach delayed narrative from another run to the currently displayed post', () => {
  expect(ids({ kind: 'portfolio-review', messages: [
    review('old', 'base', 'old-run'),
    narrative('premature-notes', 'base', 'current-run'),
    review('current', 'base', 'current-run'),
    narrative('delayed-old-notes', 'base', 'old-run'),
    narrative('current-notes', 'base', 'current-run'),
  ] })).toEqual(['current', 'current-notes']);
});

test('retains a separately requested unavailable portfolio review as a second post', () => {
  expect(ids({ kind: 'portfolio-review', messages: [
    review('verified', 'base', 'run-1', { portfolioBrief: { available: true } }),
    review('unavailable-request', 'requested-post', 'run-2', { portfolioBrief: { available: false } }),
  ] })).toEqual(['verified', 'unavailable-request']);
});

test('retains the verified portfolio and its narrative when an automatic refresh of the same post is unavailable', () => {
  expect(ids({ kind: 'portfolio-review', messages: [
    review('verified', 'base', 'run-1', { portfolioBrief: { available: true } }),
    narrative('verified-notes', 'base', 'run-1'),
    review('unavailable-refresh', 'base', 'run-2', { portfolioBrief: { available: false } }),
    narrative('unavailable-notes', 'base', 'run-2'),
  ] })).toEqual(['verified', 'verified-notes']);
});

test.each(['portfolio-review', 'balance-review', 'prediction-markets-review'])('%s preserves a successful post across failed and interrupted automatic revisions', kind => {
  expect(ids({ kind, messages: [
    review('saved', 'base', 'run-1', { reviewState: 'complete' }),
    narrative('saved-notes', 'base', 'run-1'),
    review('failed-auto', 'base', 'run-2', { reviewState: 'failed' }),
    review('interrupted-auto', 'base', 'run-3', { reviewState: 'interrupted' }),
    review('cancelled-auto', 'base', 'run-4', { reviewState: 'cancelled' }),
    review('failed-request', 'requested-post', 'run-5', { reviewState: 'failed' }),
  ] })).toEqual(['saved', 'saved-notes', 'failed-request']);
});

test('shows an initial failed review and replaces it after successful recovery', () => {
  const conversation = { kind: 'balance-review', messages: [
    review('first-failure', 'base', 'run-1', { reviewState: 'failed' }),
  ] };
  expect(ids(conversation)).toEqual(['first-failure']);
  conversation.messages.push(review('recovered', 'base', 'run-2', { reviewState: 'complete' }));
  expect(ids(conversation)).toEqual(['recovered']);
});

test('a known legacy no-change notice retains the prior full report and its matching narrative', () => {
  expect(ids({ kind: 'balance-review', messages: [
    review('saved', 'base', 'run-1'), narrative('saved-notes', 'base', 'run-1'),
    review('unchanged', 'base', 'run-2', { reviewUnchanged: true }),
    { id: 'question', role: 'user', text: 'Any changes?' },
  ] })).toEqual(['saved', 'saved-notes', 'question']);
});

test('legacy notices without a prior report and user dialogue with similar wording remain visible', () => {
  const text = 'Fresh inputs checked at 2026-09-18T18:00:00.000Z. No material changes to the preceding review.';
  expect(ids({ kind: 'balance-review', messages: [
    review('only-notice', 'base', 'run-1', { reviewUnchanged: true, text }),
    { id: 'user', role: 'user', text },
    { id: 'reply', role: 'assistant', text },
    review('unrecognized-report', 'new-post', 'run-2', { text }),
  ] })).toEqual(['only-notice', 'user', 'reply', 'unrecognized-report']);
});

test('groups legacy portfolio briefs without removing ordinary dialogue', () => {
  expect(ids({ kind: 'portfolio-review', messages: [
    { id: 'legacy-first', role: 'assistant', portfolioBrief: { available: true } },
    { id: 'question', role: 'user', text: 'What changed?' },
    { id: 'reply', role: 'assistant', text: 'An explanation.' },
    { id: 'legacy-latest', role: 'assistant', portfolioBrief: { available: true } },
  ] })).toEqual(['question', 'reply', 'legacy-latest']);
});

test('returns ordinary chats unchanged and handles conversations that have not loaded', () => {
  const messages = [review('one'), review('two'), { id: 'user', role: 'user', text: 'Hello' }];
  expect(analystReviewMessages({ kind: 'chat', messages })).toBe(messages);
  expect(analystReviewMessages(null)).toEqual([]);
});
