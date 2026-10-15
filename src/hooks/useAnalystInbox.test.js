import { act, renderHook } from '@testing-library/react';
import { analystWorkspaceApi as api } from '../services/analyst/analystClient';
import useAnalystInbox from './useAnalystInbox';

jest.mock('../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
};
const finding = (id, fingerprint = 'first', unread = 1) => ({ id, unread, payload: { attentionVersion: 1, fingerprint } });
const response = findings => ({ attentionVersion: 1, findings, unread: findings.filter(item => item.unread).length });

beforeEach(() => api.request.mockReset());

test('successive acknowledgments hide immediately and a failed save restores only its own row', async () => {
  const first = deferred();
  const second = deferred();
  api.request.mockImplementation(path => path === '/inbox' ? Promise.resolve(response([finding('a'), finding('b')]))
    : path === '/inbox/a/read' ? first.promise : second.promise);
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  let firstSave;
  let secondSave;
  act(() => { firstSave = result.current.acknowledge('a', 'first'); });
  expect(result.current.inbox.unread).toBe(1);
  act(() => { secondSave = result.current.acknowledge('b', 'first'); });
  expect(result.current.inbox.unread).toBe(0);
  expect(api.request).toHaveBeenCalledWith('/inbox/a/read', { acknowledge: true, fingerprint: 'first' });
  await act(async () => { second.resolve({ acknowledged: true }); await secondSave; });
  await act(async () => { first.reject(new Error('offline')); await firstSave; });
  expect(result.current.inbox.findings.filter(item => item.unread).map(item => item.id)).toEqual(['a']);
  expect(result.current.inboxError).toBe('Couldn’t mark this alert as read. Try again.');
});

test('an older acknowledgment cannot hide or acknowledge a materially newer incident revision', async () => {
  const save = deferred();
  let rows = [finding('gateway')];
  api.request.mockImplementation(path => path === '/inbox' ? Promise.resolve(response(rows)) : save.promise);
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  let pending;
  act(() => { pending = result.current.acknowledge('gateway', 'first'); });
  expect(result.current.inbox.unread).toBe(0);
  rows = [finding('gateway', 'escalated')];
  await act(async () => result.current.loadInbox());
  expect(result.current.inbox.unread).toBe(1);
  await act(async () => { save.resolve({ acknowledged: true }); await pending; });
  expect(result.current.inbox.unread).toBe(1);
  expect(result.current.inbox.findings[0].payload.fingerprint).toBe('escalated');
});

test('a delayed acknowledgment of a previous occurrence cannot hide recurrence with the same evidence fingerprint', async () => {
  const save = deferred();
  const occurrence = materialRevision => ({ ...finding('gateway'), payload: { ...finding('gateway').payload, materialRevision } });
  let rows = [occurrence(1)];
  api.request.mockImplementation(path => path === '/inbox' ? Promise.resolve(response(rows)) : save.promise);
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  let pending;
  act(() => { pending = result.current.acknowledge('gateway', 'first', 1); });
  expect(result.current.inbox.unread).toBe(0);
  expect(api.request).toHaveBeenCalledWith('/inbox/gateway/read', { acknowledge: true, fingerprint: 'first', materialRevision: 1 });
  rows = [occurrence(2)];
  await act(async () => result.current.loadInbox());
  expect(result.current.inbox.unread).toBe(1);
  await act(async () => { save.resolve({ acknowledged: true }); await pending; });
  expect(result.current.inbox.unread).toBe(1);
  expect(result.current.inbox.findings[0].payload.materialRevision).toBe(2);
});

test('a revision mismatch reloads the current concern instead of marking it read', async () => {
  const save = deferred();
  let rows = [finding('gateway')];
  api.request.mockImplementation(path => path === '/inbox' ? Promise.resolve(response(rows)) : save.promise);
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  let pending;
  act(() => { pending = result.current.acknowledge('gateway', 'first'); });
  rows = [finding('gateway', 'escalated')];
  await act(async () => { save.resolve({ acknowledged: false }); await pending; });
  expect(result.current.inbox.unread).toBe(1);
  expect(result.current.inbox.findings[0].payload.fingerprint).toBe('escalated');
  expect(result.current.inboxError).toBe('');
});

test('a stale load cannot reopen a saved acknowledgment', async () => {
  const staleLoad = deferred();
  const save = deferred();
  api.request.mockResolvedValueOnce(response([finding('a')]));
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  api.request.mockReturnValueOnce(staleLoad.promise).mockReturnValueOnce(save.promise);
  let load;
  let pending;
  act(() => { load = result.current.loadInbox(); pending = result.current.acknowledge('a', 'first'); });
  await act(async () => { save.resolve({ acknowledged: true }); await pending; });
  await act(async () => { staleLoad.resolve(response([finding('a')])); await load; });
  expect(result.current.inbox.unread).toBe(0);
  expect(result.current.inboxError).toBe('');
});

test('a confirmed acknowledgment survives its lost HTTP response', async () => {
  const save = deferred();
  let rows = [finding('a')];
  api.request.mockImplementation(path => path === '/inbox' ? Promise.resolve(response(rows)) : save.promise);
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  let pending;
  act(() => { pending = result.current.acknowledge('a', 'first'); });
  rows = [finding('a', 'first', 0)];
  await act(async () => result.current.loadInbox());
  await act(async () => { save.reject(new Error('response lost')); await pending; });
  expect(result.current.inbox.unread).toBe(0);
  expect(result.current.inboxError).toBe('');
});

test('polls share one pending read and invalidations coalesce into one fresh follow-up', async () => {
  const first = deferred();
  const latest = deferred();
  api.request.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
  const { result } = renderHook(useAnalystInbox);
  let load, followUp;
  act(() => {
    load = result.current.loadInbox();
    expect(result.current.loadInbox()).toBe(load);
    followUp = result.current.loadInbox({ invalidate: true });
    result.current.loadInbox({ invalidate: true });
    result.current.loadInbox();
  });
  expect(api.request).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(response([finding('a')])));
  expect(api.request).toHaveBeenCalledTimes(2);
  await act(async () => { latest.resolve(response([finding('a', 'new-revision')])); await followUp; });
  expect(result.current.inbox.findings[0].payload.fingerprint).toBe('new-revision');
  expect(api.request).toHaveBeenCalledTimes(2);
});

test('a failed pending read still runs its queued invalidation', async () => {
  const first = deferred();
  api.request.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response([finding('a', 'recovered')]));
  const { result } = renderHook(useAnalystInbox);
  let load;
  act(() => {
    load = result.current.loadInbox();
    result.current.loadInbox({ invalidate: true });
  });
  await act(async () => { first.reject(new Error('Temporary failure')); await load; });
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(result.current.inbox.findings[0].payload.fingerprint).toBe('recovered');
});

test('unchanged Inbox polls preserve evidence identity and avoid duplicate notifications while a correction publishes', async () => {
  const original = response([finding('a')]);
  api.request.mockImplementation(async () => JSON.parse(JSON.stringify(original)));
  const dispatch = jest.spyOn(window, 'dispatchEvent');
  const { result } = renderHook(useAnalystInbox);
  await act(async () => result.current.loadInbox());
  const first = result.current.inbox;
  dispatch.mockClear();
  await act(async () => result.current.loadInbox());
  expect(result.current.inbox).toBe(first);
  expect(dispatch).not.toHaveBeenCalled();
  original.findings[0].payload.fingerprint = 'corrected-source';
  await act(async () => result.current.loadInbox());
  expect(result.current.inbox).not.toBe(first);
  expect(result.current.inbox.findings[0].payload.fingerprint).toBe('corrected-source');
  expect(dispatch).toHaveBeenCalledTimes(1);
  dispatch.mockRestore();
});
