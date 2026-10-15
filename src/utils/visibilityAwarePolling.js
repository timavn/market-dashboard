/**
 * Start a polling loop that does no work while its document is hidden.
 *
 * The first transition back to visible triggers one immediate refresh and
 * restarts the interval from that point. Repeated visibilitychange events in
 * the same state are ignored so a browser cannot fan out duplicate requests.
 */
export function startVisibilityAwarePolling({
  poll,
  intervalMs,
  pollOnStart = false,
  initialDelayMs = intervalMs,
  documentObject = typeof document !== 'undefined' ? document : null,
}) {
  if (typeof poll !== 'function') {
    throw new TypeError('poll must be a function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs must be a positive number');
  }

  let intervalId = null;
  let initialTimeoutId = null;
  let stopped = false;
  let suspended = Boolean(documentObject?.hidden);

  const normalizedInitialDelayMs = pollOnStart
    ? 0
    : Math.max(0, Math.min(Number(initialDelayMs) || 0, intervalMs));

  const stopInterval = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const stopInitialTimeout = () => {
    if (initialTimeoutId !== null) {
      clearTimeout(initialTimeoutId);
      initialTimeoutId = null;
    }
  };

  const run = () => {
    if (stopped || documentObject?.hidden) return;
    Promise.resolve()
      .then(() => {
        if (stopped || documentObject?.hidden) return undefined;
        return poll();
      })
      .catch(() => {
        // The owning component maintains request-specific error state.
      });
  };

  const startInterval = () => {
    if (stopped || suspended || intervalId !== null) return;
    intervalId = setInterval(run, intervalMs);
  };

  const startInitialTimer = () => {
    if (stopped || suspended || intervalId !== null || initialTimeoutId !== null) return;
    if (normalizedInitialDelayMs <= 0) {
      run();
      startInterval();
      return;
    }
    if (normalizedInitialDelayMs === intervalMs) {
      startInterval();
      return;
    }
    initialTimeoutId = setTimeout(() => {
      initialTimeoutId = null;
      run();
      startInterval();
    }, normalizedInitialDelayMs);
  };

  const handleVisibilityChange = () => {
    const hidden = Boolean(documentObject?.hidden);
    if (hidden) {
      if (!suspended) {
        suspended = true;
        stopInitialTimeout();
        stopInterval();
      }
      return;
    }

    if (!suspended) return;
    suspended = false;
    run();
    startInterval();
  };

  startInitialTimer();
  documentObject?.addEventListener?.('visibilitychange', handleVisibilityChange);

  return () => {
    stopped = true;
    stopInitialTimeout();
    stopInterval();
    documentObject?.removeEventListener?.('visibilitychange', handleVisibilityChange);
  };
}
