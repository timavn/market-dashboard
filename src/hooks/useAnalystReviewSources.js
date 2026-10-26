import { useCallback, useEffect, useReducer, useRef } from 'react';
import { analystWorkspaceApi } from '../services/analyst/analystClient';
import { reuseAnalystEvidence } from '../services/analyst/analystEvidenceIdentity';
import { pendingReviewSourceItems } from '../services/analyst/analystReviewSourceCatalog.cjs';

const sameCapturedReview = (entry, conversationId, turnId, captureId, running) => entry?.turnId === turnId
  && (entry?.running === running || (entry?.running && !running))
  && entry?.sources?.conversationId === conversationId
  && entry?.sources?.basis === 'review' && Boolean(entry.sources.runId)
  && (!captureId || entry.sources.runId === captureId);
const canonicalCaptureId = captureId => Boolean(captureId) && !/^(daily-report|review-message):/.test(captureId);
// A read can bind metadata to the review only as far as its identity is known.
const capturedBy = (sources, conversationId, captureId) => !((sources?.conversationId && sources.conversationId !== conversationId)
  || (canonicalCaptureId(captureId) && sources?.runId && sources.runId !== captureId));
// Sources read while the conversation record was unavailable carry no turn or
// capture binding. Keep them only if the record then confirms that ownership.
const unboundCapture = (entry, conversationId, captureId) => Boolean(entry && !entry.turnId
  && !entry.captureId && !entry.running && entry.sources && capturedBy(entry.sources, conversationId, captureId));
const unfinishedSources = sources => {
  if (['succeeded', 'complete', 'ready', 'partial', 'failed', 'cancelled', 'interrupted'].includes(sources?.state)) return false;
  return ['queued', 'accepted', 'preparing', 'acquiring', 'running', 'checking'].includes(sources?.state)
    || sources?.items?.some(item => item.status === 'checking');
};
const transientSourceReadFailure = error => !error?.code || error.code === 'ANALYST_REQUEST_TIMEOUT'
  || /^HTTP_(?:408|429|5\d\d)$/.test(error.code) || [408, 429].includes(error.status) || error.status >= 500;
const terminalSources = sources => ['succeeded', 'complete', 'ready', 'partial', 'failed', 'cancelled', 'interrupted'].includes(sources?.state);
// About a hundred seconds of capped backoff for a saved review's metadata;
// an unfinished capture keeps checking until its coordinator settles it.
const SAVED_REVIEW_READ_ATTEMPTS = 10;
// A paused source stays Pending through a refresh; it is not being checked.
const pendingRoster = (items, reviewKind) => Array.isArray(items) && items.length
  ? items.map(({ id, label, requiresIbGateway, status, diagnostic, detail }) => (status === 'pending'
    ? { id, label, status, observedAt: null, ...(diagnostic ? { diagnostic } : {}), ...(detail ? { detail } : {}) }
    : { id, label, status: 'checking', observedAt: null, ...(requiresIbGateway ? { requiresIbGateway: true } : {}) }))
  : pendingReviewSourceItems(reviewKind);

export default function useAnalystReviewSources({ conversationId, turnId, captureId, reviewKind, active = true, running = false, refreshing = false, revalidationKey = 0 }) {
  // Sources belong to the saved review. Keep them in workspace memory, just
  // like its transcript, without rechecking on navigation or persisting them.
  const results = useRef(new Map());
  const reads = useRef(new Map());
  const control = useRef(null);
  const mounted = useRef(false);
  const [, render] = useReducer(value => value + 1, 0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!conversationId) return undefined;
    if (refreshing) {
      const previous = results.current.get(conversationId);
      if (previous) previous.refreshing = true;
      return undefined;
    }
    if (!active) return undefined;
    let stopped = false;
    let timer;
    let entry = results.current.get(conversationId);
    if (entry?.refreshing || entry?.turnId !== turnId || entry?.captureId !== captureId || entry?.running !== running) {
      // Completing the same capture still needs a final check, but its existing
      // source metadata can remain visible. A new turn or capture starts empty.
      const sources = !entry?.refreshing && (sameCapturedReview(entry, conversationId, turnId, captureId, running)
        || unboundCapture(entry, conversationId, captureId)) ? entry.sources : null;
      const placeholder = { basis: 'pending', items: pendingRoster(entry?.sources?.items || entry?.placeholder?.items, reviewKind) };
      entry = { turnId, captureId, running, sources, placeholder, loading: true, pending: false, again: false,
        readFailures: 0, transportFailures: 0, readFailed: false, exhausted: false, reconnecting: false, revalidationKey };
      results.current.set(conversationId, entry);
    }
    // A revalidation signal grants an exhausted saved-review read one more
    // bounded batch. A definitive rejection stays settled.
    const resume = () => {
      if (!entry.exhausted) return;
      Object.assign(entry, { exhausted: false, readFailed: false, loading: true, readFailures: 0, transportFailures: 0 });
      if (mounted.current) render();
    };
    if (entry.revalidationKey !== revalidationKey) {
      entry.revalidationKey = revalidationKey;
      resume();
    }
    const schedule = () => {
      if (stopped || timer || entry.readFailed || (terminalSources(entry.sources) && !entry.loading)
        || !(running || entry.loading || unfinishedSources(entry.sources))) return;
      // A metadata transport failure says nothing about the capture. Keep reads
      // serialized and retry while visible: a six-second cadence for unfinished
      // acquisition, backing off to fifteen seconds for a saved review.
      const cap = running || unfinishedSources(entry.sources) ? 6000 : 15_000;
      const retryDelay = Math.min(1500 * 2 ** Math.max(0, entry.readFailures - 1), cap);
      timer = setTimeout(() => { timer = null; void refresh().catch(() => {}); }, retryDelay);
    };
    const refresh = async () => {
      if (entry.readFailed || (!entry.loading && (!running || terminalSources(entry.sources)) && !unfinishedSources(entry.sources))) return;
      // A returning selection may share a read whose prior effect is being
      // cancelled. Keep its pending check owned until that read settles.
      if (entry.pending) { schedule(); return; }
      entry.pending = true;
      entry.again = false;
      let sources = null;
      let retry = false;
      let transport = false;
      try {
        // A completion or explicit refresh needs a read after the prior check,
        // not an overlapping request or that check's older source snapshot.
        const previous = reads.current.get(conversationId);
        if (previous) await previous.catch(() => {});
        if (stopped || results.current.get(conversationId) !== entry) return;
        const read = analystWorkspaceApi.request(`/conversations/${encodeURIComponent(conversationId)}/sources`);
        reads.current.set(conversationId, read);
        try {
          sources = await read;
          if (!capturedBy(sources, conversationId, captureId)) {
            sources = null;
            throw Object.assign(new Error('Source metadata belongs to another capture.'), { code: 'ANALYST_CAPTURE_MISMATCH' });
          }
        }
        finally { if (reads.current.get(conversationId) === read) reads.current.delete(conversationId); }
      } catch (error) {
        // A previous capture can still be the published metadata while the
        // current durable acquisition runs. Withhold it and keep checking the
        // active binding; an idle ownership rejection remains definitive.
        transport = transientSourceReadFailure(error);
        retry = transport || (error.code === 'ANALYST_CAPTURE_MISMATCH' && running && Boolean(turnId && captureId));
        entry.readFailures += 1;
        // A transport failure says nothing new about this exact capture's
        // recorded source metadata. Keep its rows while retrying, without
        // carrying them across a new turn/capture or replacing a failed source.
        if (retry && captureId && entry.captureId === captureId
          && sameCapturedReview(entry, conversationId, turnId, captureId, running)) sources = entry.sources;
      } finally { entry.pending = false; }
      // Let navigation finish an in-flight check for its own review, but never
      // let a superseded turn or refresh restore old source evidence.
      if (results.current.get(conversationId) !== entry) return;
      try {
        const previousSources = entry.sources;
        const wasLoading = entry.loading;
        const wasReconnecting = entry.reconnecting;
        const wasFailed = entry.readFailed;
        entry.sources = reuseAnalystEvidence(previousSources, sources);
        // Only the coordinator settles a capture. A failed metadata read never
        // turns unfinished checks into Unavailable: an unfinished capture keeps
        // checking through transport failures, a saved review retries for a
        // bounded batch, and a definitive rejection stops reading.
        entry.exhausted = retry && !(running || unfinishedSources(entry.sources)) && entry.readFailures >= SAVED_REVIEW_READ_ATTEMPTS;
        entry.readFailed = retry ? entry.exhausted : !sources;
        entry.loading = retry && !entry.exhausted;
        // Only transport failures mean the connection is being re-established.
        entry.transportFailures = transport ? entry.transportFailures + 1 : 0;
        entry.reconnecting = entry.loading && entry.transportFailures >= 2;
        if (!retry) entry.readFailures = 0;
        if (mounted.current && (wasLoading !== entry.loading || previousSources !== entry.sources
          || wasReconnecting !== entry.reconnecting || wasFailed !== entry.readFailed)) render();
      } catch { /* A presentation failure must not stop checking this capture. */ }
      if (entry.again && !stopped) {
        // A progress notice arrived during this read; it may predate that write.
        entry.again = false;
        resume();
        clearTimeout(timer);
        timer = null;
        await refresh();
        return;
      }
      // Conversation completion and source capture publication can arrive in
      // different responses. Poll only unfinished evidence until it terminates.
      schedule();
    };
    const readNow = () => {
      if (stopped) return;
      if (entry.pending) { entry.again = true; return; }
      resume();
      clearTimeout(timer);
      timer = null;
      void refresh().catch(() => {});
    };
    control.current = { conversationId, readNow };
    if (entry.loading || running || unfinishedSources(entry.sources)) void refresh().catch(() => {});
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (control.current?.readNow === readNow) control.current = null;
    };
  }, [conversationId, turnId, captureId, reviewKind, active, running, refreshing, revalidationKey]);
  // Live source progress revalidates the visible capture without reloading its
  // conversation. A settled or rejected capture ignores it; an exhausted
  // saved-review read resumes one bounded batch.
  const revalidate = useCallback(id => {
    if (control.current && (!id || control.current.conversationId === id)) control.current.readNow();
  }, []);
  const result = results.current.get(conversationId);
  const displaySources = entry => entry?.sources || (reviewKind ? entry?.placeholder : null);
  const status = { readFailed: false, reconnecting: false, revalidate };
  if (refreshing) return { ...status, sources: { basis: 'pending', items: pendingRoster(result?.sources?.items || result?.placeholder?.items, reviewKind) }, loading: true };
  if (result?.turnId === turnId && result?.captureId === captureId && result?.running === running) {
    return { ...status, sources: displaySources(result), loading: result.loading, readFailed: result.readFailed,
      reconnecting: Boolean(result.reconnecting) };
  }
  // Preserve the rows in the completion render itself, before the effect
  // replaces the entry; otherwise even a fast final check removes them once.
  if (sameCapturedReview(result, conversationId, turnId, captureId, running) || unboundCapture(result, conversationId, captureId)) {
    return { ...status, sources: result.sources, loading: true };
  }
  return { ...status, sources: reviewKind ? { basis: 'pending', items: pendingRoster(result?.sources?.items || result?.placeholder?.items, reviewKind) } : null, loading: true };
}
