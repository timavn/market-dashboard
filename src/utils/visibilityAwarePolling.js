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
  documentObject = typeof document !== 'undefined' ? document : null,
}) {
  if (typeof poll !== 'function') {
    throw new TypeError('poll must be a function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs must be a positive number');
  }

  let intervalId = null;
  let stopped = false;
  let suspended = Boolean(documentObject?.hidden);

  const stopInterval = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
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

  const handleVisibilityChange = () => {
    const hidden = Boolean(documentObject?.hidden);
    if (hidden) {
      if (!suspended) {
        suspended = true;
        stopInterval();
      }
      return;
    }

    if (!suspended) return;
    suspended = false;
    run();
    startInterval();
  };

  if (pollOnStart && !suspended) {
    run();
  }
  startInterval();
  documentObject?.addEventListener?.('visibilitychange', handleVisibilityChange);

  return () => {
    stopped = true;
    stopInterval();
    documentObject?.removeEventListener?.('visibilitychange', handleVisibilityChange);
  };
}
