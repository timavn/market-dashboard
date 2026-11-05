const { portfolioCaptureSession, easternDate } = require('./analystPolicy.cjs');
const { nextTradingDateKey, previousTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');

const REVIEW_KIND = 'portfolio-review';
// A failed attempt against an unresponsive Gateway returns in milliseconds.
const RETRY_INTERVAL_MS = 10 * 60_000;
const badEvidence = value => value && (
  value.connected === false || value.available === false
  || ['stale', 'isStale', 'offline', 'disconnected', 'cacheOnly', 'cached', 'fromCache', 'from_cache', 'mock', 'isMock', 'seed', 'seeded', 'delayed', 'frozen', 'inferred', 'synthetic', 'fallback', 'historicalOnly'].some(flag => value[flag] === true)
  || ['status', 'providerStatus', 'freshness', 'source', 'provider'].some(field => /\b(?:unavailable|unverified|offline|disconnected|failed|error|stale|cache[-_ ]?only|cached|mock|seed(?:ed)?|delayed|frozen|inferred|synthetic|fallback|historical)\b/i.test(String(value[field] || '')))
);

/**
 * One verified post-close capture per exchange session, scheduled by Hermes.
 * Holdings are frozen until the next pre-market open, so a missed capture can
 * be retried any time before then and still describes that close.
 * The run is headless: it stores the next session's "Since previous close"
 * baseline without creating or reopening an Analyst conversation.
 */
function createPortfolioCloseReview({ workspace, request, now = () => new Date() }) {
  let starting;
  const key = date => `hermes-portfolio-close:${date}`;
  const base = window => ({ date: window.date, reviewKind: REVIEW_KIND, scheduledTime: window.scheduledTime, timeZone: window.timeZone });
  const retryAt = saved => Number.isFinite(Date.parse(saved?.lastAttemptAt))
    ? new Date(Date.parse(saved.lastAttemptAt) + RETRY_INTERVAL_MS).toISOString() : null;
  const inCaptureWindow = (value, window, observed) => {
    const stamp = Date.parse(value || '');
    if (!Number.isFinite(stamp) || stamp > observed.getTime()) return false;
    const capture = portfolioCaptureSession(new Date(stamp));
    return capture.date === window.date && capture.due;
  };

  async function status({ at } = {}) {
    await workspace.initialize();
    const observed = at || now();
    const window = portfolioCaptureSession(observed);
    const result = base(window);
    if (!window.due) return { ...result, status: 'scheduled', reason: 'before_capture_time' };
    const saved = (await workspace.call('setting', { key: key(window.date) })).value;
    if (!saved?.runId) return { ...result, status: saved?.lastError ? 'failed' : 'pending',
      reason: saved?.lastError || 'not_started', ...(retryAt(saved) ? { retryAt: retryAt(saved) } : {}) };
    const identity = { runId: saved.runId };
    const blocked = reason => ({ ...result, ...identity, status: 'blocked', reason, retryAt: retryAt(saved) });
    if (!inCaptureWindow(saved.startedAt, window, observed)) return blocked('capture_start_unverified');
    let response;
    try { response = await request(`/internal/reviews/${encodeURIComponent(saved.runId)}`); }
    catch { return { ...result, ...identity, status: 'failed', reason: 'review_status_unavailable', retryAt: retryAt(saved) }; }
    const run = response.run || response;
    if (run.runId !== saved.runId || run.reviewKind !== REVIEW_KIND) return blocked('review_identity_unverified');
    if (['failed', 'cancelled', 'interrupted'].includes(run.state)) return { ...result, ...identity, status: 'failed', reason: 'review_failed', retryAt: retryAt(saved) };
    if (run.state !== 'succeeded') return { ...result, ...identity, status: 'running' };
    const portfolio = run.dependencies?.portfolio;
    if (!['ready', 'partial'].includes(run.outcome) || !['ready', 'partial'].includes(portfolio?.status)
      || portfolio.detail?.liveVerified !== true || badEvidence(portfolio) || badEvidence(portfolio.detail)) {
      return blocked(run.dependencies?.portfolioReference ? 'historical_holdings_only' : 'current_holdings_unavailable');
    }
    if (!inCaptureWindow(run.createdAt, window, observed) || !inCaptureWindow(run.completedAt, window, observed)
      || !inCaptureWindow(portfolio.asOf, window, observed)
      || Date.parse(run.createdAt) < Date.parse(saved.startedAt)
      || Date.parse(portfolio.asOf) < Date.parse(run.createdAt)
      || Date.parse(portfolio.asOf) > Date.parse(run.completedAt)) return blocked('capture_time_unverified');
    return { ...result, ...identity, status: 'ready', outcome: run.outcome, completedAt: run.completedAt, capturedAt: portfolio.asOf, asOf: portfolio.asOf };
  }

  async function startOne() {
    const current = await status();
    if (['skipped', 'running', 'ready'].includes(current.status) || current.reason === 'before_capture_time') return current;
    const observed = now();
    const savedKey = key(current.date);
    const previous = (await workspace.call('setting', { key: savedKey })).value;
    const nextRetryAt = retryAt(previous);
    if (nextRetryAt && observed.getTime() < Date.parse(nextRetryAt)) return { ...current, retryAt: nextRetryAt };
    const attempt = { lastAttemptAt: observed.toISOString() };
    // Save the attempt before acquisition so an unavailable broker or an
    // active conversation cannot cause the five-second worker to retry forever.
    await workspace.call('setting', { key: savedKey, value: { ...previous, ...attempt } });
    // Each attempt has its own request ID: the store returns the same run for a
    // repeated (conversation, request) pair, so a retry needs a new identity.
    let run;
    try {
      const response = await request('/internal/reviews', { method: 'POST', body: {
        reviewKind: REVIEW_KIND, requestId: `portfolio-close:${current.date}:${attempt.lastAttemptAt}`,
      } });
      run = response?.run || response;
    } catch {
      await workspace.call('setting', { key: savedKey, value: { ...attempt, lastError: 'review_start_failed' } });
      return status();
    }
    const window = portfolioCaptureSession(now());
    if (!run?.runId || run.reviewKind !== REVIEW_KIND || window.date !== current.date
      || !inCaptureWindow(run.createdAt, window, now())) {
      await workspace.call('setting', { key: savedKey, value: { ...attempt, lastError: 'current_capture_not_started' } });
      return status();
    }
    await workspace.call('setting', { key: savedKey, value: { ...attempt, runId: run.runId, startedAt: run.createdAt } });
    return status();
  }

  // The capture today's "Since previous close" compares against: the
  // preceding exchange session (Friday on a Monday; holidays skipped). It is
  // evaluated as of 03:59 New York time before the next session (02:59 in
  // winter), the end of that close's capture span.
  async function baseline() {
    const sessionDate = previousTradingDateKey(easternDate(now()));
    const result = await status({ at: new Date(`${nextTradingDateKey(sessionDate)}T03:59:00-04:00`) });
    return { ...result, sessionDate };
  }

  function start() {
    if (!starting) starting = startOne().finally(() => { starting = null; });
    return starting;
  }
  return { start, status, baseline };
}

module.exports = { createPortfolioCloseReview };
