const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { reviewNarrativePrompt } = require('./analystReviewPrompt.cjs');
const { dailyReadiness, easternDate, pacificDate, fingerprint, evaluateFinding, marketSession } = require('./analystPolicy.cjs');
const { isTradingDateKey, previousTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');
const { lastCompletedPortfolioSession, openPortfolioReference } = require('./analystPortfolioReference.cjs');
const { createAttentionWorkflow } = require('./analystAttention.cjs');
const { createPortfolioCloseReview } = require('./analystPortfolioClose.cjs');
const { logRunSettlement } = require('./analystRunTimeline.cjs');
const materialEvidence = value => Array.isArray(value) ? value.map(materialEvidence) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['asOf','observedAt','updatedAt','completedAt','startedAt','generatedAt','expiresAt','durationMs','runId','attempt'].includes(key)).map(([key, entry]) => [key, materialEvidence(entry)])) : value;
// Balance Review is retired into Portfolio Review; its launches are rejected.
const TITLES = { 'portfolio-review': 'Portfolio Review', 'prediction-markets-review': 'Predictive Markets Review' };
// Scalar stage timings for enough recent runs to compare a working session.
const DIAGNOSTIC_RUNS = 50;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
// Appended by the workspace beneath a partial report it already published.
// A failure before any published revision keeps the one-line failure text.
const INTERRUPTIONS = {
  REVIEW_DEADLINE_EXCEEDED: 'the server deadline passed before every source finished.',
  REVIEW_PROCESS_RESTARTED: 'the review service restarted before every source finished.',
  REVIEW_COORDINATOR_FAILED: 'an internal error stopped it before every source finished.',
};
const interruption = run => {
  if (INTERRUPTIONS[run.error?.code]) return INTERRUPTIONS[run.error.code];
  // Another failure keeps its own words once: drop its trailing refresh advice
  // (the shared remedy follows) and continue the sentence in lower case.
  const message = String(run.error?.message || '').replace(/(?:^|\s+)[^.]*\b(?:refresh|retry)\b[^.]*\.\s*$/i, '').trim()
    || 'The providers could not complete this review.';
  return /^[A-Z][a-z]/.test(message) ? message[0].toLowerCase() + message.slice(1) : message;
};
const partialReportStatus = run => `Review interrupted: ${interruption(run)} Refresh to retry with fresh evidence.`;
function attachDailyWorkflow({ workspace, request, now = () => new Date(), canGenerate = () => true, createRunId = randomUUID, logRun }) {
  const { router, call } = workspace;
  const attention = createAttentionWorkflow({ call, request, now });
  const pending = new Map();
  const startingReviews = new Map();
  let lastPendingRestoreAt = -Infinity;
  let archivedRestored = false;
  let tickRunning = false;
  const collectingReviews = new Map();
  const collectionErrors = new Map();
  const diagnosticRuns = new Map();
  const getReviewDiagnostics = () => [...diagnosticRuns.values()].map(run => ({ ...run, stages: run.stages.map(stage => ({ ...stage })) }));
  const runScalars = result => {
    const run = result.run || result;
    return { state: run.state, phase: run.phase,
      ...(typeof run.reportRevision === 'string' && /^[a-f\d]{64}$/i.test(run.reportRevision) ? { reportRevision: run.reportRevision } : {}) };
  };
  async function stage(record, name, operation, scalars) {
    if (!record?.runId) return operation();
    let diagnostics = diagnosticRuns.get(record.runId);
    if (!diagnostics) {
      diagnostics = { runId: record.runId, conversationId: record.conversationId, kind: record.kind, stages: [] };
      diagnosticRuns.set(record.runId, diagnostics);
      while (diagnosticRuns.size > DIAGNOSTIC_RUNS) diagnosticRuns.delete(diagnosticRuns.keys().next().value);
    }
    const entry = { stage: name, startedAt: new Date().toISOString(), completedAt: null, durationMs: null, outcome: 'pending' };
    diagnostics.stages.push(entry);
    if (diagnostics.stages.length > 96) diagnostics.stages.shift();
    const started = performance.now();
    try {
      const result = await operation();
      entry.outcome = 'completed';
      if (scalars) Object.assign(entry, scalars(result));
      return result;
    } catch (error) {
      entry.outcome = 'failed';
      if (Number.isInteger(error.statusCode)) entry.statusCode = error.statusCode;
      throw error;
    } finally {
      entry.completedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
    }
  }
  let restoringCloseCapture = null;
  let collectionError = null;
  let timer;
  let ingestion = null;
  let feedError = null;
  let status = { ready: false, missing: [], errors: ['Loading research readiness'] };
  async function readiness() {
    const evidence = await request('/internal/workspace/readiness', { method: 'POST', body: {} });
    const observed = now();
    status = { ...dailyReadiness({ ...evidence, feedError }, observed), portfolioReferenceDate: lastCompletedPortfolioSession(observed),
      portfolioFingerprint: fingerprint((evidence.portfolioIndexed || evidence.indexed || []).map(row => [row.document_id, row.content_hash]).sort()) };
    return status;
  }
  const preparing = new Map();
  const readConversation = async (conversationId, includeBriefs = true) =>
    (await call('get', { conversationId, includeBriefs })).conversation;
  // A deleted (410) or absent (404) conversation owns no review.
  const readReviewOwner = async (conversationId, record, name = 'ownership') => {
    try { return await stage(record, name, () => call('source-binding', { conversationId }), binding => ({ owned: ownsReview(binding, conversationId, record) })); }
    catch (error) { if (error.statusCode === 404 || error.statusCode === 410) return {}; throw error; }
  };
  const ownsReview = (binding, id, record) => binding.conversation?.id === id
    && binding.conversation?.kind === record.kind && binding.runId === record.runId
    && binding.conversation?.activeTurn?.id === record.turnId;
  const readReceiptConversation = async (conversationId, loadedConversation) => {
    const conversation = loadedConversation || await readConversation(conversationId, false);
    if (conversation.activeTurn && !pending.has(conversationId)) {
      const key = `daily-run:${conversationId}`;
      const record = (await call('setting', { key })).value;
      if (record?.turnId === conversation.activeTurn.id && record.runId && !record.completedAt && !record.error) {
        const restored = { ...record, key, conversationId };
        pending.set(conversationId, restored);
        if (restored.startPending && restored.startRequest) void startReview(conversationId, restored);
      }
    }
    return { ...conversation, briefsIncluded: false };
  };
  const deletePending = (id, record) => { if (pending.get(id) === record) pending.delete(id); };
  // Portfolio and Predictive acquisition share the local broker and research
  // stores with the attention scan while they are queued or acquiring.
  const reviewAcquiring = () => [...pending.values()].some(record => ['portfolio-review', 'prediction-markets-review'].includes(record.kind)
    && (record.startPending || ['queued', 'acquiring'].includes(record.reviewPhase)));
  // One timestamped line per settled run, from phase clocks kept on its record.
  // Keyed by run, so a record restored from inventory never logs twice.
  const settledRuns = new Set();
  const settleTimeline = (record, state, times = {}) => {
    if (settledRuns.has(record.runId)) return;
    settledRuns.add(record.runId);
    if (settledRuns.size > 500) settledRuns.delete(settledRuns.values().next().value);
    logRunSettlement({ runId: record.runId, kind: record.kind, state,
      phaseTimes: { acceptedAt: instant(record.startedAt), ...record.phaseTimes, ...times, settledAt: times.settledAt || now().toISOString() } }, logRun);
  };
  // A run that lost its owner (Stop, delete, restart) settles here, once.
  const releasePending = (id, record, state) => {
    if (pending.get(id) !== record) return;
    pending.delete(id);
    settleTimeline(record, state);
  };
  const releaseState = (deleted, binding) => deleted || !binding?.conversation ? 'deleted' : 'stopped';
  const endedState = (conversation, record) => record?.turnId && conversation?.lastTurn?.id === record.turnId && conversation.lastTurn.state
    ? `turn-${conversation.lastTurn.state}` : 'stopped';
  const saveRecord = (id, record, value = record) => pending.get(id) === record
    ? stage(record, 'record-setting', () => call('setting', { key: record.key, value: { ...value }, expectedRunId: record.runId, expectedTurnId: record.turnId }), saved => ({ ignored: saved.ignored === true }))
    : Promise.resolve({ ignored: true });
  async function prepare(kind, force = false, options = {}) {
    // Only a requested review or the Hermes close capture may create or refresh
    // conversation history. Research ingestion and date rollover stay outside it.
    if (!force) return null;
    // Serialize starts without returning another saved conversation when two
    // requests for the same review kind target different history rows.
    const previous = preparing.get(kind) || Promise.resolve();
    const promise = previous.catch(() => {}).then(() => prepareOne(kind, force, options));
    preparing.set(kind, promise);
    try { return await promise; }
    finally { if (preparing.get(kind) === promise) preparing.delete(kind); }
  }
  async function prepareOne(kind, force = false, options = {}) {
    const observed = now();
    const explicitRefresh = force && options.refresh === true;
    const refreshRequestId = String(options.requestId || randomUUID());
    if (!refreshRequestId.trim() || refreshRequestId.length > 200) throw Object.assign(new Error('A stable review request ID is required.'), { statusCode: 400 });
    const refreshKey = `${explicitRefresh ? 'daily-refresh' : 'daily-request'}:${fingerprint([kind, refreshRequestId])}`;
    // These independent ownership reads share no mutable result. The
    // acceptance transaction remains responsible for rejecting an active or
    // deleted owner after this snapshot; historical bodies need only one read.
    const requestedReads = explicitRefresh && options.conversationId
      ? await Promise.allSettled([
        call('setting', { key: refreshKey }),
        readConversation(options.conversationId, false),
        call('setting', { key: `daily-run:${options.conversationId}` }),
      ]) : null;
    const readValue = result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    };
    const rememberRefresh = async (conversationId, record = {}) => {
      if (refreshKey) await call('setting', { key: refreshKey, value: { conversationId, requestId: refreshRequestId,
        ...(options.visibleText ? { visibleText: options.visibleText, requestOwnerId: options.requestOwnerId || null } : {}), ...record } });
    };
    if (refreshKey) {
      const prior = (requestedReads ? readValue(requestedReads[0]) : await call('setting', { key: refreshKey })).value;
      if (prior) {
        if (prior.visibleText && (prior.visibleText !== options.visibleText || prior.requestOwnerId !== (options.requestOwnerId || null))) {
          throw Object.assign(new Error('Refresh request belongs to another message.'), { statusCode: 409 });
        }
        if (options.conversationId && options.conversationId !== prior.conversationId) {
          throw Object.assign(new Error('Refresh request belongs to another conversation.'), { statusCode: 409 });
        }
        return readReceiptConversation(prior.conversationId,
          requestedReads && prior.conversationId === options.conversationId ? readValue(requestedReads[1]) : undefined);
      }
    }
    const requestedConversation = options.conversationId
      ? requestedReads ? readValue(requestedReads[1]) : await readConversation(options.conversationId, false) : null;
    if (requestedConversation && requestedConversation.kind !== kind) throw new Error('Review belongs to another conversation kind.');
    if (requestedConversation && !requestedConversation.activeTurn && pending.has(requestedConversation.id)) {
      const ended = pending.get(requestedConversation.id);
      releasePending(requestedConversation.id, ended, endedState(requestedConversation, ended));
    }
    if (requestedConversation?.activeTurn) {
      await rememberRefresh(requestedConversation.id, { turnId: requestedConversation.activeTurn?.id || null });
      return readReceiptConversation(requestedConversation.id, requestedConversation);
    }
    if (force && kind === 'portfolio-review' && !options.refresh && marketSession(observed) !== 'open') {
      const saved = await openPortfolioReference({ call, request, now: observed, includeCurrentSession: true });
      if (saved) return saved;
      // First use (or deleted history) still needs an actual review. The
      // coordinator uses the latest research date and labels holdings by
      // their own observation time; it does not invent a historical close.
    }
    // Manual prediction reviews acquire their own verified inputs.
    // The equity publication calendar gates scheduled runs, not venue access.
    const requestedSnapshot = force && kind === 'prediction-markets-review';
    // The exchange date decides the session and its data; the chat is filed
    // under the user's Pacific calendar day (the same day except 21:00–24:00 PT).
    const date = easternDate(observed);
    const conversationDate = pacificDate(observed);
    let gate = { date, marketDay: isTradingDateKey(date), ready: true, fingerprint: fingerprint([kind, date]) };
    if (kind === 'portfolio-review') {
      // Every position is checked against what has actually arrived. Missing
      // publications are coverage gaps and never block the whole morning book.
      // The worker captures available research itself. Acceptance must not
      // await a readiness scan, provider checks, or the model gateway.
      gate = { ...gate, fingerprint: fingerprint([kind, date, marketSession(observed)]) };
    }
    const { conversation } = requestedConversation
      ? { conversation: requestedConversation }
      : await call('daily', { kind, date: conversationDate, title: TITLES[kind], reopen: force, includeBriefs: false });
    if (!conversation) return null;
    if (conversation.kind !== kind) throw new Error('Review belongs to another conversation kind.');
    if (!gate.ready) {
      await call('append', { conversationId: conversation.id, sourceId: `waiting:${conversation.id}:${fingerprint(gate.missing)}`, text: gate.marketDay ? `Waiting for today’s required research: ${gate.missing.map(p => `${p.label} (${p.reason})`).join('; ')}.` : `Market closed on ${gate.date}. Daily reviews resume on the next exchange trading day.` });
      return readReceiptConversation(conversation.id);
    }
    const current = requestedReads ? requestedConversation : await readConversation(conversation.id, false);
    if (!current.activeTurn && pending.has(conversation.id)) {
      const ended = pending.get(conversation.id);
      releasePending(conversation.id, ended, endedState(current, ended));
    }
    if (current.activeTurn) {
      await rememberRefresh(conversation.id, { turnId: current.activeTurn?.id || null });
      return readReceiptConversation(conversation.id);
    }
    const key = `daily-run:${conversation.id}`;
    const previous = (requestedReads ? readValue(requestedReads[2]) : await call('setting', { key })).value;
    if (requestedSnapshot && previous?.fingerprint) gate.fingerprint = previous.fingerprint;
    // Button opens refresh expired inputs; background triggers only a new publication revision.
    const expired = !previous?.completedAt || observed.getTime() - Date.parse(previous.completedAt) > 60000;
    if (!explicitRefresh && previous?.fingerprint === gate.fingerprint && (!force || !expired) && !previous?.error) {
      return requestedConversation ? readReceiptConversation(conversation.id) : { ...conversation, briefsIncluded: false };
    }
    // Active captures were returned above. An incomplete legacy binding with
    // no active turn was interrupted; a new user request may retry it.
    const requestId = explicitRefresh
      ? `daily-refresh:${fingerprint([kind, conversation.id, refreshRequestId])}`
      : `daily-request:${fingerprint([kind, conversation.id, refreshRequestId])}`;
    const runId = createRunId();
    // A requested new post counts once; background revisions and its notes
    // continue the same post. Older saved revisions belong to the base post.
    const newPost = explicitRefresh || options.newPost === true;
    const reviewPostId = newPost ? runId : previous?.reviewPostId || 'base';
    const balanceReferenceDate = kind === 'balance-review' && !gate.marketDay ? previousTradingDateKey(gate.date) : null;
    const record = { fingerprint: gate.fingerprint, runId, reviewPostId, newPost, kind, balanceReferenceDate,
      reviewRequestId: refreshRequestId,
      priorMaterialFingerprint: previous?.materialFingerprint,
      startedAt: observed.toISOString(), reviewPhase: 'queued', reviewState: 'queued', startPending: true,
      startRequest: { reviewKind: kind, conversationId: conversation.id, requestId, runId } };
    // Commit the turn, run binding and request receipt together before returning.
    // A restart can resume this exact acquisition; replay never creates a chat.
    const accepted = await call('accept', { conversationId: conversation.id, requestId: `daily-turn:${runId}`,
      text: options.visibleText || `Prepare ${TITLES[kind]}`, internalPrompt: !options.visibleText, reviewPostId,
      includeBriefs: false, reviewRecord: record, reviewRequestBinding: { key: refreshKey, value: {
        conversationId: conversation.id, requestId: refreshRequestId, runId, reviewPostId,
        ...(options.visibleText ? { visibleText: options.visibleText, requestOwnerId: options.requestOwnerId || null } : {}),
      } } });
    record.turnId = accepted.turn.id;
    pending.set(conversation.id, { ...record, key, conversationId: conversation.id });
    void startReview(conversation.id, pending.get(conversation.id));
    return { ...accepted.conversation, briefsIncluded: false };
  }
  function startReview(id, record) {
    const ownerKey = `${id}:${record.runId}`;
    if (startingReviews.has(ownerKey)) return startingReviews.get(ownerKey);
    const starting = (async () => {
      let owner;
      const ownsTurn = async () => {
        if (pending.get(id) !== record) return false;
        owner = await readReviewOwner(id, record, 'startup-ownership');
        return ownsReview(owner, id, record) && pending.get(id) === record;
      };
      if (pending.get(id) !== record) return;
      try {
        // The worker validates this exact accepted binding under the Workspace
        // write lock before creating the run. A separate owner HTTP read would
        // add a round trip without protecting the subsequent creation race.
        const result = await stage(record, 'dispatch', () => request('/internal/reviews', { method: 'POST',
          body: { ...record.startRequest, workspaceTurnId: record.turnId } }), runScalars);
        const run = result.run || result;
        if (run.runId !== record.runId || run.conversationId !== id || run.reviewKind !== record.kind) throw new Error('Review acceptance belongs to another conversation.');
        if (!await ownsTurn()) {
          releasePending(id, record, releaseState(false, owner));
          await call('cancel-review', { runId: record.runId, conversationId: id });
          return;
        }
        record.startPending = false;
        record.reviewState = run.state;
        record.reviewPhase = run.state === 'queued' ? 'queued' : run.phase || 'acquiring';
        record.phaseTimes = { ...record.phaseTimes, dispatchedAt: now().toISOString() };
        await saveRecord(id, record);
      } catch (error) {
        if (!await ownsTurn()) { releasePending(id, record, releaseState(false, owner)); return; }
        await call('frame', { turnId: record.turnId, includeConversation: false, type: 'failed',
          text: 'The review could not start. Refresh this review to retry.', error: error.message });
        await saveRecord(id, record, { ...record, startPending: false,
          reviewPhase: 'terminal', reviewState: 'failed', error: true, completedAt: now().toISOString() });
        deletePending(id, record);
        settleTimeline(record, 'start-failed');
        // Creation may have committed even when its HTTP response was lost.
        void call('cancel-review', { runId: record.runId, conversationId: id }).catch(() => {});
      }
    })().catch(error => { collectionErrors.set(id, error); })
      .finally(() => { startingReviews.delete(ownerKey); });
    startingReviews.set(ownerKey, starting);
    return starting;
  }
  function collect() {
    return (async () => {
      await workspace.initialize();
      await collectOnce();
      collectionError = collectionErrors.size ? [...collectionErrors.values()][0] : null;
    })().catch(error => {
      collectionError = error;
    });
  }
  async function restoreCloseCapture() {
    // Inventory recovery is rate-limited; a one-second collector tick must not
    // rescan between restores. The close capture is headless and needs none.
    const restoreAt = Date.now();
    if (restoreAt - lastPendingRestoreAt < 5000) return false;
    lastPendingRestoreAt = restoreAt;
    // Nothing archives conversations any more, so archived in-flight work can
    // exist only from before this process started. Read that list once.
    const readArchived = !archivedRestored;
    const [visible, archived] = await Promise.all([
      call('list'), readArchived ? call('list', { archived: true }) : { conversations: [] },
    ]);
    const lists = [visible, archived];
    for (const conversation of lists.flatMap(result => result.conversations || [])) {
      if (!TITLES[conversation.kind] || !['accepted', 'running'].includes(conversation.state) || pending.has(conversation.id)) continue;
      const key = `daily-run:${conversation.id}`;
      const record = (await call('setting', { key })).value;
      if (record?.runId && record.turnId && !record.completedAt && !record.error && !pending.has(conversation.id)) pending.set(conversation.id, { ...record, key, conversationId: conversation.id });
    }
    if (readArchived) archivedRestored = true;
    return true;
  }
  async function collectOnce() {
    if (!restoringCloseCapture) restoringCloseCapture = restoreCloseCapture()
      .then(restored => { if (restored) collectionErrors.delete('restoration'); }, error => { collectionErrors.set('restoration', error); })
      .finally(() => { restoringCloseCapture = null; });
    const restoring = restoringCloseCapture;
    // Known owners can publish while inventory recovery runs in the background.
    // An empty collector still waits once so a restart resumes saved work.
    if (pending.size) for (const record of pending.values()) void stage(record, 'restore-background', () => restoring);
    else await restoring;
    const reads = [];
    for (const [id, record] of pending) {
      const ownerKey = `${id}:${record.runId}`;
      if (collectingReviews.has(ownerKey)) continue;
      // Independent reviews must not queue behind one slow provider/store read.
      // Bound acquisition polling while preserving one durable writer per chat.
      if (collectingReviews.size >= 3) break;
      const read = collectReview(id, record)
        .then(() => { collectionErrors.delete(id); }, error => { collectionErrors.set(id, error); })
        .finally(() => { collectingReviews.delete(ownerKey); });
      collectingReviews.set(ownerKey, read);
      reads.push(read);
    }
    await Promise.all(reads);
  }
  async function publicationOwner(id, record) {
    const reads = await Promise.allSettled([
      stage(record, 'publish-deleted', () => call('deleted', { conversationId: id }), value => ({ deleted: value.deleted === true })),
      readReviewOwner(id, record, 'publish-ownership'),
    ]);
    if (pending.get(id) !== record) return null;
    const deleted = reads[0].status === 'fulfilled' && reads[0].value.deleted;
    if (deleted || reads[1].status === 'fulfilled' && !ownsReview(reads[1].value, id, record)) {
      releasePending(id, record, releaseState(deleted, reads[1].value));
      return null;
    }
    const failed = reads.find(read => read.status === 'rejected');
    if (failed) throw failed.reason;
    return reads[1].value;
  }
  async function collectReview(id, record) {
    if (pending.get(id) !== record) return;
    if (record.startPending && record.startRequest) { void startReview(id, record); return; }
    const reads = await Promise.allSettled([
      stage(record, 'deleted', () => call('deleted', { conversationId: id }), value => ({ deleted: value.deleted === true })),
      stage(record, 'status', () => request(`/internal/reviews/${record.runId}/status`, { timeoutMs: 5_000 }), runScalars),
      readReviewOwner(id, record),
    ]);
    if (pending.get(id) !== record) return;
    const deleted = reads[0].status === 'fulfilled' && reads[0].value.deleted;
    if (deleted || reads[2].status === 'fulfilled' && !ownsReview(reads[2].value, id, record)) {
      releasePending(id, record, releaseState(deleted, reads[2].value));
      return;
    }
    const failed = reads.find(read => read.status === 'rejected');
    if (failed) throw failed.reason;
    const result = reads[1].value;
    const status = result.run || result;
    if (status.runId !== record.runId || status.conversationId !== id || status.reviewKind !== record.kind) throw new Error('Review status belongs to another conversation.');
    if (pending.get(id) !== record) return;
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(status.state);
    const phase = terminal ? 'terminal' : status.state === 'queued' ? 'queued' : status.phase || 'acquiring';
    if (record.reviewPhase !== phase || record.reviewState !== status.state) {
      record.reviewPhase = phase;
      record.reviewState = status.state;
      await saveRecord(id, record);
    }
    const progressive = !terminal && status.state === 'running' && status.reportAvailable === true
      && typeof status.reportRevision === 'string' && status.reportRevision
      && status.reportRevision !== record.progressRevision;
    if (!terminal && !progressive) return;
    // Hydrate only a new verified partial revision or a terminal capture.
    const completed = await stage(record, 'capture', () => request(`/internal/reviews/${record.runId}`), runScalars);
    const run = completed.run || completed;
    if (run.runId !== record.runId || run.conversationId !== id || run.reviewKind !== record.kind) throw new Error('Review capture belongs to another conversation.');
    if (pending.get(id) !== record) return;
    if (!['succeeded', 'failed', 'cancelled'].includes(run.state)) {
      // A newer verified publication can land after the status trigger. The
      // captured response owns its report/citations/revision; publish that
      // snapshot rather than discarding it until the next polling cycle.
      if (!progressive || run.state !== 'running' || !run.reportMarkdown?.trim()
        || typeof run.reportRevision !== 'string' || !run.reportRevision
        || run.reportRevision === record.progressRevision) return;
      const saved = await publicationOwner(id, record);
      if (!record.turnId || !saved) { releasePending(id, record, 'released'); return; }
      await stage(record, 'progress-frame', () => call('frame', { turnId: record.turnId, runId: record.runId, includeConversation: false,
        type: 'progress', reportRevision: run.reportRevision, text: run.reportMarkdown, citations: run.citations || [] }), value => ({ ignored: value.ignored === true }));
      record.progressRevision = run.reportRevision;
      await saveRecord(id, record);
      return;
    }
    const materialFingerprint = fingerprint([record.fingerprint, materialEvidence(run.sections || run.reportMarkdown)]);
    const material = record.newPost === true || record.kind === 'portfolio-review' || record.priorMaterialFingerprint !== materialFingerprint;
    const balanceDateNote = record.balanceReferenceDate ? `Last exchange trading day: **${record.balanceReferenceDate}**. Balance amounts use the verified IBKR observation timestamp shown below.\n\n` : '';
    const text = run.state === 'succeeded' ? balanceDateNote + run.reportMarkdown : `Review interrupted: ${run.error?.message || 'The providers could not complete this review.'} Open today’s review to retry with fresh evidence.`;
    const savedBinding = await publicationOwner(id, record);
    if (!savedBinding) return;
    // Only Balance's narrative needs the saved session/history projection.
    const saved = record.kind === 'balance-review' ? await readConversation(id, false) : savedBinding.conversation;
    if (record.turnId && ownsReview(savedBinding, id, record)) {
      const framed = await stage(record, 'terminal-frame', () => call('frame', { turnId: record.turnId, includeConversation: false, type: run.state === 'succeeded' ? 'complete' : 'failed', text, citations: run.citations || [], error: run.error?.message,
        ...(run.state === 'succeeded' ? {} : { partialStatus: partialReportStatus(run) }) }), value => ({ ignored: value.ignored === true }));
      if (framed.ignored || pending.get(id) !== record) return;
    }
    else if (!record.turnId) await call('append', { conversationId: id, sourceId: `daily-report:${run.runId}`, text, citations: run.citations || [], createdAt: run.completedAt });
    record.phaseTimes = { ...record.phaseTimes, captureSettledAt: instant(run.completedAt) || now().toISOString(), publishedAt: now().toISOString() };
    const completedRecord = await saveRecord(id, record, { ...record, materialFingerprint, completedAt: run.completedAt || new Date().toISOString(), error: run.state !== 'succeeded' });
    if (completedRecord.ignored || pending.get(id) !== record) {
      // The report was published; only its completion record lost a race.
      settleTimeline(record, run.state, { settledAt: record.phaseTimes.publishedAt });
      return;
    }
    deletePending(id, record);
    let summarizing = false;
    try {
      // Balance reviews add an issues check; portfolio and prediction reports
      // are complete in code. Explicit follow-up chat still uses Hermes.
      if (record.kind === 'balance-review' && material && run.state === 'succeeded' && run.outcome !== 'blocked' && canGenerate() && !saved.referenceReview && saved.lastTurn?.state !== 'interrupted' && (!saved.activeTurn || saved.activeTurn.id === record.turnId)) {
        const accepted = await call('accept', { conversationId: id, requestId: `daily-narrative:${run.runId}`, text: `Explain this ${TITLES[record.kind]} in a concise daily summary.`, internalPrompt: true, reviewPostId: record.reviewPostId || 'base', expectedLastTurnId: record.turnId });
        if (accepted.created) {
          const summarizingAt = now().toISOString();
          const phaseRecord = await call('setting', { key: record.key, value: { ...record, materialFingerprint,
            completedAt: run.completedAt || now().toISOString(), narrativeTurnId: accepted.turn.id,
            reviewPhase: 'summarizing', reviewState: 'running', phaseTimes: { ...record.phaseTimes, summarizingAt } },
          expectedRunId: record.runId, expectedTurnId: record.turnId });
          if (!phaseRecord.ignored && (await readConversation(id, false)).activeTurn?.id === accepted.turn.id) {
            summarizing = true;
            workspace.generate({ ...accepted, narrative: reviewNarrativePrompt(record.kind, text, record.balanceReferenceDate),
              onSettled: type => settleTimeline(record, type === 'complete' ? run.state : `${run.state}-summary-${type}`, { summarizingAt }) });
          }
        }
      }
    } finally {
      if (!summarizing) settleTimeline(record, run.state, { settledAt: record.phaseTimes.publishedAt });
    }
  }
  async function monitor() {
    if (await attention.enabled()) {
      // Health and full-book assessment remain independent of source-feed success.
      const results = await Promise.allSettled([
        request('/internal/workspace/changes', { method: 'POST', body: {} }),
        attention.tick([], { defer: reviewAcquiring() }),
      ]);
      const changes = results[0];
      if (changes.status === 'fulfilled') {
        feedError = null;
        ingestion = changes.value.ingestion;
        if (changes.value.events?.length) {
          const saved = (await call('setting', { key: 'attention-source-events' })).value || [];
          const identity = event => [event.sourceMessageId || event.sourceEventId || event.eventKey, event.entityId, event.fieldPath || event.eventType].join('|');
          const journal = new Map(saved.map(event => [identity(event), event]));
          for (const event of changes.value.events) journal.set(identity(event), event);
          await call('setting', { key: 'attention-source-events', value: [...journal.values()].slice(-2000) });
        }
        if (changes.value.cursor) await call('setting', { key: 'research-change-cursor', value: changes.value.cursor });
      } else feedError = 'Research delivery cannot be verified';
      return;
    }
    const changes = await request('/internal/workspace/changes', { method: 'POST', body: {} }).catch(error => {
      feedError = error.message || 'Source feed unavailable';
      throw error;
    });
    feedError = null;
    ingestion = changes.ingestion;
    const previous = (await call('findings')).findings;
    const events = changes.events || [];
    const unresolved = previous.filter(f => f.state !== 'resolved');
    if (!events.length && !unresolved.length) { if (changes.cursor) await call('setting', { key: 'research-change-cursor', value: changes.cursor }); return; }
    const symbols = [...new Set([...events.map(event => event.entityId), ...unresolved.map(f => f.symbol)].filter(Boolean))];
    const holdings = await request('/internal/workspace/holdings', { method: 'POST', body: { symbols } }).catch(() => ({ liveVerified: false, complete: false, positions: [] }));
    const identity = e => [e.sourceMessageId || e.sourceEventId || e.eventKey, e.entityId, e.fieldPath || e.eventType].join('|');
    const revised = new Set(events.map(identity));
    for (const event of [...events, ...unresolved.map(f => f.payload.event).filter(e => e && !revised.has(identity(e)))]) {
      if (!event) continue;
      const prior = previous.find(f => (f.source_id === (event.sourceMessageId || event.sourceEventId || event.eventKey) || event.contentSha256 && f.payload.event?.contentSha256 === event.contentSha256) && f.symbol === String(event.entityId).toUpperCase() && (f.payload.event?.fieldPath || f.payload.event?.eventType) === (event.fieldPath || event.eventType));
      const finding = evaluateFinding(event, holdings, prior?.payload, now());
      if (finding) await call('finding', { finding });
    }
    if (changes.cursor) await call('setting', { key: 'research-change-cursor', value: changes.cursor });
  }
  async function tick() {
    // Each conversation has its own collector: a five-second worker tick can
    // publish finished reviews while another review or alert scan is still busy.
    await collect();
    if (tickRunning) return;
    tickRunning = true;
    try {
      await workspace.initialize();
      // Quiet model reasoning is still owned by its live gateway socket. Only
      // orphaned turns, or owners past their response deadline, are recoverable.
      const activeTurnIds = Array.from(workspace.active?.entries() || [])
        .filter(([, owner]) => owner.deadlineAt > Date.now())
        .map(([turnId]) => turnId);
      await call('recover', { staleAfterSeconds: 190, activeTurnIds, resumeReviews: true });
      // Portfolio alerts must not wait for all daily publications or a review.
      const errors = [];
      await monitor().catch(error => errors.push(`Portfolio alerts: ${error.message}`));
      if (collectionError) errors.push(`Review completion: ${collectionError.message}`);
      const gate = await readiness().catch(error => { errors.push(`Research readiness: ${error.message}`); return { ready: false }; });
      await call('setting', { key: 'monitor-health', value: { asOf: new Date().toISOString(), status: errors.length ? 'degraded' : 'healthy', error: errors.join('; ') || null, intervalSeconds: 5, readiness: gate, ingestion } });
    } catch (e) {
      await call('setting', { key: 'monitor-health', value: { asOf: new Date().toISOString(), status: 'failed', error: e.message } }).catch(() => {});
    } finally { tickRunning = false; }
  }
  router.get('/daily', async (_req, res) => { res.set('Cache-Control', 'no-store'); try { res.json(await readiness()); } catch (e) { res.status(503).json({ error: e.message, code: e.code }); } });
  workspace.setPortfolioRefreshHandler?.(async ({ requestId, conversationId, text }) => {
    const owner = conversationId ? await readConversation(conversationId, false) : null;
    const conversation = await prepare('portfolio-review', true, { refresh: true, newPost: true, requestId,
      ...(owner?.kind === 'portfolio-review' ? { conversationId: owner.id } : {}),
      visibleText: text, requestOwnerId: owner?.id || null });
    return { conversation };
  });
  router.post('/daily/:kind', async (req, res) => {
    if (!TITLES[req.params.kind]) return res.status(400).json({ error: 'Unknown review kind' });
    // The browser tells a verified deletion (410) apart only by its typed code.
    try { await workspace.initialize(); return res.json({ conversation: await prepare(req.params.kind, true, { newPost: req.params.kind !== 'portfolio-review' || req.body?.refresh === true, refresh: req.body?.refresh === true, conversationId: req.body?.conversationId, requestId: req.body?.requestId }) }); } catch (e) { return res.status(e.statusCode || 503).json({ error: e.message, code: e.code }); }
  });
  router.get('/monitor', async (req, res) => {
    if (req.query.reviewStages === 'true') return res.json({ reviewDiagnostics: getReviewDiagnostics(),
      workspaceReadDiagnostics: workspace.getReadDiagnostics?.() || [] });
    try { return res.json({ ...((await call('setting', { key: 'monitor-health' })).value || {}), reviewDiagnostics: getReviewDiagnostics() }); }
    catch (e) { return res.status(503).json({ error: e.message }); }
  });
  router.post('/inbox/refresh', async (req, res) => {
    try {
      await workspace.initialize();
      if (attention.isRunning()) {
        if (req.body?.reset === true) void attention.start({ reset: true });
        return res.status(202).json({ ...await attention.getStatus(), resetQueued: req.body?.reset === true });
      }
      void attention.start({ reset: req.body?.reset === true });
      return res.status(202).json(await attention.getStatus());
    } catch { return res.status(503).json({ error: 'The Inbox could not be refreshed.' }); }
  });
  router.get('/inbox/refresh', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await attention.getStatus()); }
    catch { res.status(503).json({ error: 'Assessment status unavailable.' }); }
  });
  // Existing Hermes schedules may still call this adapter. Acknowledge the
  // user's manual-review policy without starting or resurrecting a chat.
  for (const method of ['post', 'get']) {
    router[method]('/automation/prediction-morning', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ date: easternDate(now()), reviewKind: 'prediction-markets-review', status: 'skipped', reason: 'user_initiated_only' });
    });
  }
  // Hermes captures verified holdings 30 minutes after each close as a headless
  // run (no chat). It is the next session's "Since previous close" baseline;
  // GET reports, POST starts.
  const closeReview = createPortfolioCloseReview({ workspace, request, now });
  for (const [method, action] of [['get', 'status'], ['post', 'start']]) {
    router[method]('/automation/portfolio-close', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      try { res.json(await closeReview[action]()); }
      catch { res.status(503).json({ error: 'Closing holdings capture unavailable.' }); }
    });
  }
  let collectorTimer;
  let collectorTick = 0;
  return { tick, prepare, getReviewDiagnostics, portfolioCloseBaseline: () => closeReview.baseline(), start() { if (!timer) {
    timer = setInterval(tick, 5000); timer.unref?.();
    collectorTick = 0;
    collectorTimer = setInterval(() => {
      collectorTick += 1;
      // Mandatory broker preflight failures should clear the accepted turn
      // promptly. Full report generation keeps the existing one-second poll.
      if (pending.size && (reviewAcquiring() || collectorTick % 4 === 0)) void collect();
    }, 250); collectorTimer.unref?.();
    tick();
  } }, stop() { clearInterval(timer); clearInterval(collectorTimer); timer = null; collectorTimer = null; } };
}
module.exports = { attachDailyWorkflow };
