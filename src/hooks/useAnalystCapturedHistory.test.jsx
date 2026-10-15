import React, { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import useAnalystCapturedHistory from './useAnalystCapturedHistory';
import useAnalystReportContainment from './useAnalystReportContainment';
import { analystWorkspaceApi as api } from '../services/analyst/analystClient';

jest.mock('../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));
const post = (id, run = `${id}-run`) => ({ id, reviewRunId: run, reviewBodyIncluded: false });
const captured = message => ({ conversation: { id: 'chat', messages: [{ ...message, reviewBodyIncluded: true,
  portfolioBrief: { available: true, runId: message.reviewRunId } }] } });
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; };
let intersections, sizes;
const originalIntersectionObserver = global.IntersectionObserver;
const originalResizeObserver = global.ResizeObserver;
beforeEach(() => {
  api.request.mockReset();
  intersections = [];
  sizes = [];
  global.IntersectionObserver = jest.fn(callback => {
    const observer = { callback, observe: jest.fn(), disconnect: jest.fn() };
    intersections.push(observer); return observer;
  });
  global.ResizeObserver = jest.fn(callback => {
    const observer = { callback, observe: jest.fn(), disconnect: jest.fn() };
    sizes.push(observer); return observer;
  });
});
afterEach(() => { global.IntersectionObserver = originalIntersectionObserver; global.ResizeObserver = originalResizeObserver; });
function Harness({ messages, held = false, onCapturedBody, onCapturedUnavailable, active = true, conversationId = 'chat' }) {
  const transcript = useRef();
  const hold = useRef(() => held); hold.current = () => held;
  useAnalystCapturedHistory({ active, conversationId, messages, transcript, hold: hold.current, onCapturedBody, onCapturedUnavailable });
  useAnalystReportContainment({ active, transcript, messages });
  return <div ref={transcript}>{messages.map(message => <article key={message.id} data-message-id={message.id}
    data-testid={message.id} className={message.portfolioBrief ? 'analyst-historical-report' : 'analyst-captured-report-placeholder'}>
    Captured {message.id}<button>Saved citation</button>
  </article>)}</div>;
}
const enter = (...ids) => intersections.at(-1).callback(ids.map(id => ({ target: screen.getByTestId(id), isIntersecting: true })));

test('cold historical bodies wait for the requested primary then load only viewport captures serially', async () => {
  const first = deferred();
  api.request.mockReturnValueOnce(first.promise).mockResolvedValueOnce(captured(post('b')));
  const onCapturedBody = jest.fn();
  const messages = [post('a'), post('b'), post('offscreen')];
  const { rerender } = render(<Harness messages={messages} held onCapturedBody={onCapturedBody} />);
  expect(intersections).toHaveLength(0);
  expect(api.request).not.toHaveBeenCalled();
  rerender(<Harness messages={messages} onCapturedBody={onCapturedBody} />);
  enter('a', 'b');
  expect(api.request.mock.calls).toEqual([['/conversations/chat?includeBriefs=false&briefMessageId=a']]);
  enter('a', 'b');
  await act(async () => first.resolve(captured(post('a'))));
  await waitFor(() => expect(onCapturedBody).toHaveBeenCalledTimes(2));
  expect(api.request.mock.calls).toEqual([
    ['/conversations/chat?includeBriefs=false&briefMessageId=a'], ['/conversations/chat?includeBriefs=false&briefMessageId=b'],
  ]);
  expect(onCapturedBody.mock.calls.map(([, expected]) => expected.reviewRunId)).toEqual(['a-run', 'b-run']);
});

test('an exact historical request never accepts another capture or removes the conversation after a missing body', async () => {
  api.request.mockResolvedValue(captured(post('a', 'foreign-run')));
  const onCapturedBody = jest.fn();
  const onCapturedUnavailable = jest.fn();
  const expected = post('a');
  render(<Harness messages={[expected]} onCapturedBody={onCapturedBody} onCapturedUnavailable={onCapturedUnavailable} />);
  enter('a');
  await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
  await api.request.mock.results[0].value;
  expect(onCapturedBody).not.toHaveBeenCalled();
  expect(onCapturedUnavailable).toHaveBeenCalledWith('chat', expected);
  enter('a');
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(onCapturedUnavailable).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('a')).toBeTruthy();
});

test('a failed historical read settles only its exact placeholder once without changing captured evidence', async () => {
  const request = deferred();
  api.request.mockReturnValue(request.promise);
  const expected = post('a');
  const saved = JSON.stringify(expected);
  const onCapturedBody = jest.fn();
  const onCapturedUnavailable = jest.fn();
  render(<Harness messages={[expected]} onCapturedBody={onCapturedBody} onCapturedUnavailable={onCapturedUnavailable} />);
  enter('a');
  await act(async () => request.reject(new Error('Captured body unavailable.')));
  expect(onCapturedUnavailable).toHaveBeenCalledTimes(1);
  expect(onCapturedUnavailable).toHaveBeenCalledWith('chat', expected);
  expect(onCapturedBody).not.toHaveBeenCalled();
  expect(JSON.stringify(expected)).toBe(saved);
  enter('a');
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(onCapturedUnavailable).toHaveBeenCalledTimes(1);
});

test.each(['switch conversation', 'unmount'])('a late historical read failure does not settle another view after %s', async departure => {
  const request = deferred();
  api.request.mockReturnValue(request.promise);
  const expected = post('a');
  const onCapturedBody = jest.fn();
  const onCapturedUnavailable = jest.fn();
  const { rerender, unmount } = render(<Harness messages={[expected]} onCapturedBody={onCapturedBody} onCapturedUnavailable={onCapturedUnavailable} />);
  enter('a');
  if (departure === 'unmount') unmount();
  else rerender(<Harness conversationId="other-chat" messages={[expected]} onCapturedBody={onCapturedBody} onCapturedUnavailable={onCapturedUnavailable} />);
  await act(async () => request.reject(new Error('Late captured body failure.')));
  expect(onCapturedUnavailable).not.toHaveBeenCalled();
  expect(onCapturedBody).not.toHaveBeenCalled();
});

test('a transient historical failure retries on returning without an automatic retry loop', async () => {
  api.request.mockRejectedValueOnce(new Error('Timed out.')).mockResolvedValueOnce(captured(post('a')));
  const onCapturedBody = jest.fn();
  const messages = [post('a')];
  const { rerender } = render(<Harness messages={messages} onCapturedBody={onCapturedBody} />);
  enter('a');
  await api.request.mock.results[0].value.catch(() => {});
  enter('a');
  expect(api.request).toHaveBeenCalledTimes(1);
  rerender(<Harness messages={messages} active={false} onCapturedBody={onCapturedBody} />);
  rerender(<Harness messages={messages} onCapturedBody={onCapturedBody} />);
  enter('a');
  await waitFor(() => expect(onCapturedBody).toHaveBeenCalledTimes(1));
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('a newly requested review pauses queued historical bodies until its primary is revealed', async () => {
  const first = deferred();
  api.request.mockReturnValueOnce(first.promise).mockResolvedValueOnce(captured(post('b')));
  const onCapturedBody = jest.fn();
  const messages = [post('a'), post('b')];
  const { rerender } = render(<Harness messages={messages} onCapturedBody={onCapturedBody} />);
  enter('a', 'b');
  rerender(<Harness messages={messages} held onCapturedBody={onCapturedBody} />);
  await act(async () => first.resolve(captured(post('a'))));
  expect(api.request).toHaveBeenCalledTimes(1);
  rerender(<Harness messages={messages} onCapturedBody={onCapturedBody} />);
  enter('b');
  await waitFor(() => expect(onCapturedBody).toHaveBeenCalledTimes(2));
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('historical containment uses measured report height and retains its citation controls', () => {
  render(<Harness messages={[{ ...post('a'), portfolioBrief: { available: true } }]} onCapturedBody={jest.fn()} />);
  const report = screen.getByTestId('a');
  sizes[0].callback([{ target: report, contentRect: { height: 0 } }]);
  expect(report.classList.contains('has-measured-report-size')).toBe(false);
  sizes[0].callback([{ target: report, borderBoxSize: [{ blockSize: 7214 }], contentRect: { height: 7200 } }]);
  expect(report.style.getPropertyValue('--analyst-report-block-size')).toBe('7214px');
  expect(report.classList.contains('has-measured-report-size')).toBe(true);
  expect(screen.getByRole('button', { name: 'Saved citation' })).toBeTruthy();
});
