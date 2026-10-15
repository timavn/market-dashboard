import { hydrateAnalystCapturedCitations } from './analystCapturedCitations';

const captured = id => ({ id, captureConversationId: 'saved/chat', captureMessageId: 'original post',
  evidenceIncluded: false, highlightTexts: ['Captured reading'] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('saved citations hydrate only their exact escaped post with two concurrent reads', async () => {
  const waits = [deferred(), deferred(), deferred()];
  const request = jest.fn().mockImplementationOnce(() => waits[0].promise)
    .mockImplementationOnce(() => waits[1].promise).mockImplementationOnce(() => waits[2].promise);
  const onResolved = jest.fn();
  const work = hydrateAnalystCapturedCitations(['one', 'two', 'three'].map(captured), { request, isCurrent: () => true, onResolved });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    '/conversations/saved%2Fchat/citations/original%20post/one', '/conversations/saved%2Fchat/citations/original%20post/two',
  ]);
  waits[0].resolve({ citation: { id: 'one', excerpt: 'Exact saved evidence.' } });
  await waits[0].promise;
  expect(request).toHaveBeenCalledTimes(3);
  expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', excerpt: 'Exact saved evidence.', highlightTexts: ['Captured reading'], evidenceIncluded: true }));
  waits[1].resolve({ citation: { id: 'two' } });
  waits[2].resolve({ citation: { id: 'three' } });
  await work;
});

test('a dismissed or replaced evidence view ignores late results and starts no remaining reads', async () => {
  const wait = deferred();
  let current = true;
  const request = jest.fn(() => wait.promise);
  const onResolved = jest.fn();
  const work = hydrateAnalystCapturedCitations(['one', 'two', 'three'].map(captured), { request, isCurrent: () => current, onResolved });
  current = false;
  wait.resolve({ citation: { id: 'one', excerpt: 'Late evidence' } });
  await work;
  expect(request).toHaveBeenCalledTimes(2);
  expect(onResolved).not.toHaveBeenCalled();
});

test('mismatched and malformed captured sources fail clearly without substituting current research', async () => {
  const request = jest.fn(async () => ({ citation: { id: 'different', excerpt: 'Unrelated evidence' } }));
  const onResolved = jest.fn();
  await hydrateAnalystCapturedCitations([captured('one'), { ...captured('bad'), captureMessageId: null }], { request, isCurrent: () => true, onResolved });
  expect(request).toHaveBeenCalledTimes(1);
  expect(onResolved.mock.calls.every(([source]) => source.evidenceError && !source.excerpt && source.evidenceLoading === false)).toBe(true);
});
