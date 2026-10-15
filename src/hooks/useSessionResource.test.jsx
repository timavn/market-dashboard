import { act, renderHook } from '@testing-library/react';
import { useSessionResource } from './useSessionResource';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';

const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

afterEach(() => {
  resetSessionResourceStore();
  jest.useRealTimers();
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete document.hidden;
});

test.each([null, 1000])('defers hidden activation with polling interval %s and refreshes once on visibility', async (pollIntervalMs) => {
  jest.useFakeTimers();
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const fetcher = jest.fn().mockResolvedValue({ verified: true });
  const { unmount } = renderHook(() => useSessionResource({
    resourceKey: 'visibility-test', kind: 'reference', fetcher, pollIntervalMs,
  }));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(fetcher).not.toHaveBeenCalled();
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  unmount();
});
