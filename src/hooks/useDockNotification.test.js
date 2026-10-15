import { act, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.node';
import useDockNotification from './useDockNotification';

const storageKey = (channel = 'analyst', scope = 'default') => (
  `market-dashboard:dock-notifications:v1:${channel}:${scope}`
);

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mountNotification(initialProps = {}) {
  return renderHook((props) => useDockNotification(props), {
    initialProps: { channel: 'analyst', notificationIds: [], ...initialProps },
  });
}

test('stays quiet until an identified notification arrives', () => {
  const { result, rerender } = mountNotification();
  expect(result.current.hasNotification).toBe(false);

  rerender({ channel: 'analyst', notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(true);
});

test('keeps a pending glow through empty or unavailable polls until clicked', () => {
  const { result, rerender } = mountNotification({ notificationIds: ['finding-1'] });
  rerender({ channel: 'analyst', notificationIds: [] });
  expect(result.current.hasNotification).toBe(true);
  rerender({ channel: 'analyst', notificationIds: null });
  expect(result.current.hasNotification).toBe(true);

  act(() => result.current.dismiss());
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(false);
});

test('does not relight dismissed notifications after reordering, removal, or reappearance', () => {
  const { result, rerender } = mountNotification({ notificationIds: ['finding-1', 'finding-2'] });
  act(() => result.current.dismiss());

  for (const notificationIds of [
    ['finding-2', 'finding-1'], ['finding-1'], [], ['finding-1', 'finding-2'],
  ]) {
    rerender({ channel: 'analyst', notificationIds });
    expect(result.current.hasNotification).toBe(false);
  }
});

test('lights up for a new distinct notification even when the count is unchanged', () => {
  const { result, rerender } = mountNotification({ notificationIds: ['finding-1'] });
  act(() => result.current.dismiss());
  rerender({ channel: 'analyst', notificationIds: ['finding-2'] });
  expect(result.current.hasNotification).toBe(true);

  act(() => result.current.dismiss());
  expect(result.current.hasNotification).toBe(false);
  expect(JSON.parse(window.localStorage.getItem(storageKey()))).toEqual(['finding-1', 'finding-2']);
});

test('persists only dismissed identifiers and restores dismissal after remount', () => {
  const { result, unmount } = mountNotification({ notificationIds: ['finding-2', 'finding-1'] });
  expect(window.localStorage.getItem(storageKey())).toBeNull();
  act(() => result.current.dismiss());
  expect(JSON.parse(window.localStorage.getItem(storageKey()))).toEqual(['finding-1', 'finding-2']);
  unmount();

  const { result: remountedResult, rerender } = mountNotification({ notificationIds: ['finding-1'] });
  expect(remountedResult.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: ['finding-1', 'finding-3'] });
  expect(remountedResult.current.hasNotification).toBe(true);
});

test('a click before data arrives does not dismiss a future notification', () => {
  const { result, rerender } = mountNotification();
  act(() => result.current.dismiss());
  expect(window.localStorage.getItem(storageKey())).toBeNull();

  rerender({ channel: 'analyst', notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(true);
});

test('resets pending notifications on a new calendar scope without dismissing that day', () => {
  const { result, rerender } = mountNotification({
    channel: 'market-events', scope: '2026-09-14', notificationIds: ['event-1'],
  });
  expect(result.current.hasNotification).toBe(true);

  rerender({ channel: 'market-events', scope: '2026-09-15', notificationIds: [] });
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'market-events', scope: '2026-09-15', notificationIds: ['event-2'] });
  expect(result.current.hasNotification).toBe(true);
});

test('isolates dismissal by channel and scope, including returning to a prior scope', () => {
  const { result, rerender } = mountNotification({
    channel: 'market-events', scope: '2026-09-14', notificationIds: ['same-id'],
  });
  act(() => result.current.dismiss());

  rerender({ channel: 'market-events', scope: '2026-09-15', notificationIds: ['same-id'] });
  expect(result.current.hasNotification).toBe(true);
  rerender({ channel: 'market-events', scope: '2026-09-14', notificationIds: ['same-id'] });
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', scope: '2026-09-14', notificationIds: ['same-id'] });
  expect(result.current.hasNotification).toBe(true);
});

test.each(['not json', '{}', 'null', '42'])('ignores malformed stored dismissals: %s', (stored) => {
  window.localStorage.setItem(storageKey(), stored);
  const { result } = mountNotification({ notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(true);
  act(() => result.current.dismiss());
  expect(result.current.hasNotification).toBe(false);
});

test('ignores invalid identifiers without persisting objects or message content', () => {
  const { result, rerender } = mountNotification({
    notificationIds: [null, undefined, '', ' ', {}, { message: 'private content' }, true, NaN],
  });
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: [123, '123', 'finding-1', 'finding-1'] });
  act(() => result.current.dismiss());
  expect(JSON.parse(window.localStorage.getItem(storageKey()))).toEqual(['123', 'finding-1']);
});

test('keeps dismissal functional when browser storage cannot be accessed', () => {
  jest.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  const { result, rerender } = mountNotification({ notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(true);
  act(() => result.current.dismiss());
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: ['finding-2'] });
  expect(result.current.hasNotification).toBe(true);
});

test('keeps dismissal functional when the browser refuses storage writes', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded');
  });
  const { result, rerender } = mountNotification({ notificationIds: ['finding-1'] });
  act(() => result.current.dismiss());
  expect(result.current.hasNotification).toBe(false);
  rerender({ channel: 'analyst', notificationIds: ['finding-1'] });
  expect(result.current.hasNotification).toBe(false);
});

test('can render without a browser window', () => {
  function Notification() {
    const { hasNotification } = useDockNotification({ channel: 'analyst', notificationIds: ['finding-1'] });
    return createElement('span', null, hasNotification ? 'new' : 'quiet');
  }
  const windowGetter = jest.spyOn(global, 'window', 'get').mockReturnValue(undefined);
  try {
    expect(renderToString(createElement(Notification))).toBe('<span>new</span>');
  } finally {
    windowGetter.mockRestore();
  }
});
