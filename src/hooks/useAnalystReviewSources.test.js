import { act, renderHook, waitFor } from '@testing-library/react';
import useAnalystReviewSources from './useAnalystReviewSources';
import { analystWorkspaceApi as api } from '../services/analyst/analystClient';

jest.mock('../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));
const captured = (conversationId = 'a', state = 'succeeded', status = 'ready') => ({
  conversationId, runId: `${conversationId}-capture`, basis: 'review', state,
  items: [{ id: 'research', label: 'Captured research', status,
    ...(status === 'ready' ? { observedAt: '2026-10-07T01:00:00Z' } : {}) }],
});
const props = (conversationId = 'a', running = false) => ({
  conversationId, turnId: `${conversationId}-turn`, captureId: `${conversationId}-capture`, active: true, running,
});
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; };
beforeEach(() => { jest.useFakeTimers(); api.request.mockReset(); });
afterEach(() => { jest.useRealTimers(); });

test('terminal conversation keeps checking a nonterminal Sources response until its captured sources complete', async () => {
  api.request.mockResolvedValueOnce(captured('a', 'queued', 'checking')).mockResolvedValueOnce(captured());
  const { result } = renderHook(useAnalystReviewSources, { initialProps: props() });
  await waitFor(() => expect(result.current.sources?.state).toBe('queued'));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toEqual(captured());
  expect(result.current.loading).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('an active review withholds a previous capture and keeps checking until its exact metadata arrives', async () => {
  const previous = { ...captured('a', 'running'), runId: 'previous-capture', turnId: 'previous-turn', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-08T15:30:00Z' },
  ] };
  const current = { ...captured('a', 'partial'), turnId: 'a-turn', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-09T15:30:00Z' },
    { id: 'research', label: 'Captured research', status: 'partial', publishedAt: '2026-10-09T12:00:00Z' },
  ] };
  api.request.mockResolvedValueOnce(previous).mockResolvedValue(current);
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'portfolio-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.runId).toBeUndefined();
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  expect(result.current.loading).toBe(true);
  expect(result.current.readFailed).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toBe(current);
  expect(result.current.loading).toBe(false);
  expect(result.current.readFailed).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(2);
});

test.each(['missing', 'unavailable'])('terminal %s evidence stops polling after its captured response', async status => {
  api.request.mockResolvedValue(captured('a', 'failed', status));
  const { result } = renderHook(useAnalystReviewSources, { initialProps: props() });
  await waitFor(() => expect(result.current.sources?.items[0].status).toBe(status));
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(1);
});

test.each(['ready', 'partial'])('a %s capture stops checking while its narrative turn is still running', async state => {
  const sources = { ...captured('a', state), turnId: 'a-turn', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-09T15:30:00Z' },
    { id: 'risk-ranges', label: 'Risk Ranges', status: state === 'partial' ? 'unavailable' : 'ready' },
  ] };
  api.request.mockResolvedValue(sources);
  const initialProps = { ...props('a', true), reviewKind: 'portfolio-review' };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await waitFor(() => expect(result.current.sources).toBe(sources));
  expect(result.current.loading).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(10_000));
  expect(api.request).toHaveBeenCalledTimes(1);
  rerender({ ...initialProps, running: false });
  expect(result.current.sources).toBe(sources);
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(sources);
  expect(result.current.loading).toBe(false);
});

test('returning before an old serialized source read settles resumes the terminal capture check', async () => {
  const oldRead = deferred();
  let reads = 0;
  api.request.mockImplementation(path => path === '/conversations/a/sources'
    ? (++reads === 1 ? oldRead.promise : Promise.resolve(captured()))
    : Promise.resolve(captured('b')));
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  expect(api.request).toHaveBeenCalledTimes(1);
  rerender(props('a', false));
  rerender(props('b'));
  await waitFor(() => expect(result.current.sources?.conversationId).toBe('b'));
  rerender(props('a'));
  await act(async () => oldRead.resolve(captured('a', 'running', 'checking')));
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toEqual(captured());
  expect(result.current.loading).toBe(false);
  expect(reads).toBe(2);
});

test.each([undefined, 'ANALYST_REQUEST_TIMEOUT', 'HTTP_503', 'HTTP_429'])('a transient %s source check retains only the exact capture metadata until a successful response', async code => {
  const original = captured('a', 'running');
  const failure = Object.assign(new Error('Source check failed'), code ? { code } : {});
  const failedSource = captured('a', 'failed', 'unavailable');
  api.request.mockResolvedValueOnce(original).mockRejectedValueOnce(failure).mockResolvedValueOnce(failedSource);
  const { result } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources).toBe(original));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toBe(original);
  expect(result.current.sources.items[0].status).toBe('ready');
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toEqual(failedSource);
  expect(result.current.sources.items[0].status).toBe('unavailable');
  expect(result.current.loading).toBe(false);
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('a transient final source check preserves the same capture rows and retries after conversation completion', async () => {
  const original = captured('a', 'running');
  api.request.mockResolvedValueOnce(original)
    .mockRejectedValueOnce(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }))
    .mockResolvedValueOnce(captured());
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources).toBe(original));
  rerender(props('a', false));
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(original);
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources).toEqual(captured());
  expect(result.current.loading).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('a failed new capture check never restores another capture source metadata', async () => {
  api.request.mockResolvedValueOnce(captured('a', 'running'))
    .mockRejectedValue(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources?.runId).toBe('a-capture'));
  rerender({ ...props('a', true), turnId: 'new-turn', captureId: 'new-capture' });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('a rejected source ownership check clears captured metadata instead of retaining it', async () => {
  api.request.mockResolvedValueOnce(captured('a', 'running'))
    .mockRejectedValueOnce(Object.assign(new Error('Deleted'), { code: 'HTTP_404' }));
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources?.runId).toBe('a-capture'));
  rerender(props('a', false));
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBeNull();
  expect(result.current.loading).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('an explicit refresh keeps source labels in place without reusing the prior capture dates or readiness', async () => {
  const original = captured();
  const next = deferred();
  api.request.mockResolvedValueOnce(original).mockReturnValueOnce(next.promise);
  const initialProps = { ...props(), reviewKind: 'portfolio-review' };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await waitFor(() => expect(result.current.sources).toBe(original));
  rerender({ ...initialProps, refreshing: true });
  expect(result.current.sources.items).toEqual([{ id: 'research', label: 'Captured research', status: 'checking', observedAt: null }]);
  expect(result.current.sources.runId).toBeUndefined();
  rerender({ ...initialProps, running: true, turnId: 'new-turn', captureId: 'new-capture' });
  expect(result.current.sources.items).toEqual([{ id: 'research', label: 'Captured research', status: 'checking', observedAt: null }]);
  await act(async () => next.resolve({ ...captured(), runId: 'new-capture', state: 'failed', items: [{
    id: 'research', label: 'Captured research', status: 'unavailable',
  }] }));
  expect(result.current.sources.runId).toBe('new-capture');
  expect(result.current.loading).toBe(false);
  expect(original.items[0].status).toBe('ready');
});

test('a paused source stays Pending through an explicit refresh while the rest re-check', async () => {
  const paused = { id: 'portfolioPca', label: 'PCA model', status: 'pending', observedAt: null,
    diagnostic: { code: 'SOURCE_PAUSED', reason: 'Paused for now. This source returns when it is re-enabled.' },
    detail: 'Paused for now. This source returns when it is re-enabled.' };
  const original = { ...captured(), items: [...captured().items, paused] };
  api.request.mockResolvedValueOnce(original).mockReturnValueOnce(deferred().promise);
  const initialProps = { ...props(), reviewKind: 'portfolio-review' };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await waitFor(() => expect(result.current.sources).toBe(original));
  const expected = [{ id: 'research', label: 'Captured research', status: 'checking', observedAt: null },
    { id: 'portfolioPca', label: 'PCA model', status: 'pending', observedAt: null, diagnostic: paused.diagnostic, detail: paused.detail }];
  rerender({ ...initialProps, refreshing: true });
  expect(result.current.sources.items).toEqual(expected);
  rerender({ ...initialProps, running: true, turnId: 'new-turn', captureId: 'new-capture' });
  expect(result.current.sources.items).toEqual(expected);
});

test('repeated saved source metadata read failures keep Checking and retry with capped backoff', async () => {
  // AGENTS.md: transient metadata-read failures never stop checking or settle rows as Unavailable.
  api.request.mockRejectedValue(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', false), reviewKind: 'portfolio-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.loading).toBe(true);
  expect(result.current.reconnecting).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(result.current.loading).toBe(true);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.reconnecting).toBe(true);
  expect(result.current.sources.items.length).toBeGreaterThan(1);
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  for (const [delay, calls] of [[3000, 3], [6000, 4], [12_000, 5], [15_000, 6], [15_000, 7]]) {
    await act(async () => jest.advanceTimersByTimeAsync(delay - 1));
    expect(api.request).toHaveBeenCalledTimes(calls - 1);
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(api.request).toHaveBeenCalledTimes(calls);
  }
  api.request.mockResolvedValue(captured());
  await act(async () => jest.advanceTimersByTimeAsync(15_000));
  expect(result.current.sources).toEqual(captured());
  expect(result.current.loading).toBe(false);
  expect(result.current.reconnecting).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(8);
});

test('a saved review stops its metadata retries after a bounded batch until a revalidation signal resumes them', async () => {
  // AGENTS.md: bounded retries. A saved review is not an unfinished capture.
  api.request.mockRejectedValue(Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' }));
  const initialProps = { ...props('a', false), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await act(async () => jest.advanceTimersByTimeAsync(97_500));
  expect(api.request).toHaveBeenCalledTimes(10);
  expect(result.current.readFailed).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.reconnecting).toBe(false);
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(300_000));
  expect(api.request).toHaveBeenCalledTimes(10);
  // Conversation hydration or a stream reconnect grants one more bounded batch.
  rerender({ ...initialProps, revalidationKey: 1 });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(api.request).toHaveBeenCalledTimes(11);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(97_500));
  expect(api.request).toHaveBeenCalledTimes(20);
  expect(result.current.readFailed).toBe(true);
  // A live progress notice resumes it as well, and a success settles it.
  api.request.mockResolvedValue(captured());
  act(() => result.current.revalidate('a'));
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(api.request).toHaveBeenCalledTimes(21);
  expect(result.current.sources).toEqual(captured());
  expect(result.current.readFailed).toBe(false);
  expect(result.current.loading).toBe(false);
});

test('a running capture never exhausts transport retries and keeps its six-second cadence', async () => {
  api.request.mockRejectedValue(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'portfolio-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(10_500));
  expect(api.request).toHaveBeenCalledTimes(4);
  await act(async () => jest.advanceTimersByTimeAsync(180_000));
  expect(api.request).toHaveBeenCalledTimes(34);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.loading).toBe(true);
  expect(result.current.reconnecting).toBe(true);
});

test('ownership-mismatch retries during an active capture never report Reconnecting', async () => {
  const previous = { ...captured('a', 'succeeded'), runId: 'previous-capture' };
  api.request.mockResolvedValue(previous);
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'portfolio-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(30_000));
  expect(api.request.mock.calls.length).toBeGreaterThan(3);
  expect(result.current.loading).toBe(true);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.reconnecting).toBe(false);
  api.request.mockRejectedValueOnce(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(result.current.reconnecting).toBe(false);
  api.request.mockRejectedValueOnce(Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(result.current.reconnecting).toBe(true);
});

test('a revalidation signal reads a retrying capture immediately and restores only its exact captured Sources', async () => {
  const failure = Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' });
  const sources = { ...captured('a', 'partial'), turnId: 'a-turn',
    items: [{ id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-09T15:30:00Z' },
      { id: 'risk-ranges', label: 'Risk Ranges', status: 'partial', publishedAt: '2026-10-08T12:00:00Z' }] };
  api.request.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(sources);
  const initialProps = { ...props(), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.readFailed).toBe(false);
  expect(result.current.reconnecting).toBe(true);
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  expect(api.request).toHaveBeenCalledTimes(2);
  rerender({ ...initialProps, revalidationKey: 1 });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(api.request).toHaveBeenCalledTimes(3);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.loading).toBe(true);
  rerender({ ...initialProps, revalidationKey: 2 });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(sources);
  expect(result.current.sources.items[0].status).toBe('ready');
  expect(result.current.readFailed).toBe(false);
  expect(result.current.reconnecting).toBe(false);
  expect(result.current.loading).toBe(false);
  rerender({ ...initialProps, revalidationKey: 3 });
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(4);
});

test('retries pause while the review is hidden and resume with an immediate read when it is shown again', async () => {
  api.request.mockRejectedValue(Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' }));
  const initialProps = { ...props(), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(api.request).toHaveBeenCalledTimes(2);
  rerender({ ...initialProps, active: false });
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(result.current.readFailed).toBe(false);
  rerender(initialProps);
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(api.request).toHaveBeenCalledTimes(3);
  rerender({ ...initialProps, revalidationKey: 0 });
  await act(async () => jest.advanceTimersByTimeAsync(5999));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('a recovery signal does not reopen a definitive capture ownership rejection', async () => {
  api.request.mockRejectedValue(Object.assign(new Error('Deleted capture'), { code: 'HTTP_404' }));
  const initialProps = { ...props(), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.readFailed).toBe(true);
  rerender({ ...initialProps, revalidationKey: 1 });
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(result.current.readFailed).toBe(true);
  expect(api.request).toHaveBeenCalledTimes(1);
});

test('a hydration signal received during a pending source read keeps one serialized retry cadence', async () => {
  const first = deferred();
  const failure = Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' });
  const sources = { ...captured('a', 'partial'), turnId: 'a-turn' };
  api.request.mockReturnValueOnce(first.promise).mockRejectedValueOnce(failure).mockResolvedValue(sources);
  const initialProps = { ...props(), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  rerender({ ...initialProps, revalidationKey: 1 });
  expect(api.request).toHaveBeenCalledTimes(1);
  await act(async () => first.reject(failure));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(result.current.readFailed).toBe(false);
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(3000));
  expect(result.current.sources).toBe(sources);
  expect(result.current.loading).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test.each(['conversation', 'capture'])('revalidation rejects successful metadata for a different %s binding', async binding => {
  const sources = { ...captured('a', 'partial'), turnId: 'a-turn',
    ...(binding === 'conversation' ? { conversationId: 'other-chat' } : {}),
    ...(binding === 'capture' ? { runId: 'other-capture' } : {}) };
  api.request.mockRejectedValueOnce(Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' }))
    .mockRejectedValueOnce(Object.assign(new Error('Source transport unavailable'), { code: 'HTTP_503' }))
    .mockResolvedValue(sources);
  const initialProps = { ...props(), reviewKind: 'portfolio-review', revalidationKey: 0 };
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps });
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.readFailed).toBe(false);
  expect(result.current.reconnecting).toBe(true);
  rerender({ ...initialProps, revalidationKey: 1 });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.readFailed).toBe(true);
  expect(result.current.reconnecting).toBe(false);
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.runId).toBeUndefined();
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('a legacy source-message token remains a navigation key without becoming a canonical capture ownership claim', async () => {
  const sources = captured();
  api.request.mockResolvedValue(sources);
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props(), captureId: 'daily-report:legacy-post', reviewKind: 'portfolio-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(sources);
  expect(result.current.readFailed).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(1);
});

test('two active capture timeouts preserve recorded connection and Checking rows, then recover progress', async () => {
  const original = { ...captured('a', 'running', 'checking'), items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-07T01:00:00Z' },
    { id: 'research', label: 'Captured research', status: 'checking' },
  ] };
  const timeout = Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' });
  api.request.mockResolvedValueOnce(original).mockRejectedValueOnce(timeout)
    .mockRejectedValueOnce(timeout).mockResolvedValueOnce(captured());
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'prediction-markets-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(original);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(api.request).toHaveBeenCalledTimes(3);
  expect(result.current.sources).toBe(original);
  expect(result.current.sources.items.map(item => item.status)).toEqual(['ready', 'checking']);
  expect(result.current.loading).toBe(true);
  expect(result.current.readFailed).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(2999));
  expect(api.request).toHaveBeenCalledTimes(3);
  await act(async () => jest.advanceTimersByTimeAsync(1));
  expect(result.current.sources).toEqual(captured());
  expect(result.current.loading).toBe(false);
  expect(result.current.readFailed).toBe(false);
});

test('an unobserved active capture keeps its fresh Checking roster with serialized capped retries', async () => {
  const timeout = Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' });
  api.request.mockRejectedValue(timeout);
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'prediction-markets-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  expect(result.current.loading).toBe(true);
  expect(result.current.readFailed).toBe(false);
  expect(api.request).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTimeAsync(3000));
  expect(api.request).toHaveBeenCalledTimes(3);
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(4);
  await act(async () => jest.advanceTimersByTimeAsync(6000));
  expect(api.request).toHaveBeenCalledTimes(5);
  expect(result.current.readFailed).toBe(false);
});

test.each(['capture', 'turn'])('active transport retries never retain metadata across a changed %s', async identity => {
  const original = captured('a', 'running');
  const timeout = Object.assign(new Error('Timed out'), { code: 'ANALYST_REQUEST_TIMEOUT' });
  api.request.mockResolvedValueOnce(original).mockRejectedValue(timeout);
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'prediction-markets-review' } });
  await waitFor(() => expect(result.current.sources).toBe(original));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  rerender({ ...props('a', true), reviewKind: 'prediction-markets-review',
    ...(identity === 'capture' ? { captureId: 'new-capture' } : { turnId: 'new-turn' }) });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.runId).toBeUndefined();
  expect(result.current.sources.items.every(item => item.status === 'checking' && item.observedAt == null)).toBe(true);
  expect(result.current.readFailed).toBe(false);
  expect(original.items[0].status).toBe('ready');
});

test('a definitive active capture ownership failure settles rather than retrying transport recovery', async () => {
  api.request.mockRejectedValue(Object.assign(new Error('Deleted'), { code: 'HTTP_404' }));
  const { result } = renderHook(useAnalystReviewSources, { initialProps: { ...props('a', true), reviewKind: 'prediction-markets-review' } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.loading).toBe(false);
  expect(result.current.readFailed).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(1);
});

test('terminal captured sources stop polling even before the conversation turn settles', async () => {
  api.request.mockResolvedValue(captured('a', 'failed', 'checking'));
  const { result } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources.state).toBe('failed'));
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(result.current.loading).toBe(false);
});

test('an early terminal capture still finishes a transient final metadata read instead of remaining loading', async () => {
  const original = captured();
  api.request.mockResolvedValueOnce(original)
    .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { code: 'HTTP_503' }))
    .mockResolvedValueOnce(original);
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await waitFor(() => expect(result.current.sources).toBe(original));
  rerender(props('a', false));
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(original);
  expect(result.current.loading).toBe(true);
  await act(async () => jest.advanceTimersByTimeAsync(1500));
  expect(result.current.loading).toBe(false);
  expect(result.current.readFailed).toBe(false);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('a live progress notice rereads the running capture at once and coalesces notices during a pending read', async () => {
  const running = { ...captured('a', 'running', 'checking') };
  const pending = deferred();
  api.request.mockResolvedValueOnce(running).mockReturnValueOnce(pending.promise).mockResolvedValue(captured());
  const { result } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(running);
  act(() => result.current.revalidate('other-conversation'));
  expect(api.request).toHaveBeenCalledTimes(1);
  act(() => result.current.revalidate('a'));
  expect(api.request).toHaveBeenCalledTimes(2);
  act(() => { result.current.revalidate('a'); result.current.revalidate('a'); });
  expect(api.request).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({ ...running }));
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(api.request).toHaveBeenCalledTimes(3);
  expect(result.current.sources).toEqual(captured());
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  expect(api.request).toHaveBeenCalledTimes(3);
  act(() => result.current.revalidate('a'));
  expect(api.request).toHaveBeenCalledTimes(3);
});

test('Sources read before the conversation record keep their rows when the record names that exact capture', async () => {
  const sources = { ...captured('a', 'running', 'checking'), turnId: 'a-turn' };
  api.request.mockResolvedValueOnce(sources).mockReturnValue(new Promise(() => {}));
  const { result, rerender } = renderHook(useAnalystReviewSources, { initialProps: {
    conversationId: 'a', reviewKind: 'portfolio-review', active: true, running: false } });
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(sources);
  rerender({ ...props('a', true), reviewKind: 'portfolio-review' });
  expect(result.current.sources).toBe(sources);
  await act(async () => jest.advanceTimersByTimeAsync(0));
  expect(result.current.sources).toBe(sources);
  expect(api.request).toHaveBeenCalledTimes(2);
  rerender({ ...props('a', true), reviewKind: 'portfolio-review', turnId: 'new-turn', captureId: 'new-capture' });
  expect(result.current.sources.basis).toBe('pending');
  expect(result.current.sources.runId).toBeUndefined();
});

test('a presentation failure after a read keeps checking instead of stranding the capture', async () => {
  const identity = require('../services/analyst/analystEvidenceIdentity');
  const reuse = jest.spyOn(identity, 'reuseAnalystEvidence').mockImplementationOnce(() => { throw new Error('Unexpected payload'); });
  try {
    api.request.mockResolvedValueOnce(captured('a', 'running', 'checking')).mockResolvedValue(captured());
    const { result } = renderHook(useAnalystReviewSources, { initialProps: props('a', true) });
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(result.current.loading).toBe(true);
    await act(async () => jest.advanceTimersByTimeAsync(1500));
    expect(result.current.sources).toEqual(captured());
    expect(result.current.loading).toBe(false);
  } finally { reuse.mockRestore(); }
});
