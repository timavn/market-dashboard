import { startVisibilityAwarePolling } from './visibilityAwarePolling';

describe('startVisibilityAwarePolling', () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden);
    } else {
      delete document.hidden;
    }
  });

  test('polls every five minutes, pauses while hidden, and refreshes once on restore', async () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    const poll = jest.fn();
    const intervalMs = 5 * 60 * 1000;
    const stop = startVisibilityAwarePolling({ poll, intervalMs });

    jest.advanceTimersByTime(intervalMs - 1);
    await Promise.resolve();
    expect(poll).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(intervalMs * 2);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(intervalMs);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(3);

    stop();
  });

  test('defers an initial poll in a hidden tab and runs it once on restore', async () => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    const poll = jest.fn();
    const intervalMs = 5 * 60 * 1000;
    const stop = startVisibilityAwarePolling({ poll, intervalMs, pollOnStart: true });

    await Promise.resolve();
    jest.advanceTimersByTime(intervalMs * 2);
    await Promise.resolve();
    expect(poll).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(intervalMs);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);

    stop();
  });
});
