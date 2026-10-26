/** Durable browser-independent response adapter. One private gateway socket owns one turn. */
const express = require('express');
const WebSocket = require('ws');
const { reviewNarrativePrompt } = require('./analystReviewPrompt.cjs');
const { buildAnalystInbox } = require('../../utils/analystInboxAlerts.cjs');
const { createReviewSources } = require('./analystReviewSources.cjs');
const { isPortfolioRefreshRequest } = require('./portfolioRefreshRequest.cjs');
const { collectCitations, liveRequirementsForPrompt, projectHistory, reconcileLiveTurnHistory, sanitizeCitationText } = require('./analystGatewayProxy.cjs');
// Match the isolated Hermes gateway's finite 30-minute generation budget.
// Maximum-effort reasoning can exceed ten minutes.
const RESPONSE_TIMEOUT_MS = 1_800_000;
const RESPONSE_TIMEOUT_ERROR = 'The response exceeded its time limit. Retry is available.';
const EVENT_WRITES = new Set(['accept', 'frame', 'recover', 'reconcile-response', 'import', 'delete', 'archive', 'daily', 'append', 'finding', 'finding-read', 'attention-publish']);
// Concurrent Inbox readers share one findings read for a short window. Only
// these operations write findings (or the attention switch), so they end it.
const INBOX_TTL_MS = 2_000;
const FINDING_WRITES = new Set(['finding', 'finding-read', 'attention-publish']);
// The attention Inbox shows open findings only; retained history stays stored.
const INBOX_HISTORY_STATES = ['superseded', 'resolved', 'unavailable'];
const REQUEST_IDENTITY_MAX = 512;
// Scalar read timings only; enough recent conversations to compare a session.
const READ_DIAGNOSTIC_CONVERSATIONS = 50;
const INBOX_THREADS_KEY = 'inbox-threads-v1';
// Marks the alert text that opens an Inbox discussion; the Inbox hides it.
const INBOX_THREAD_PREFIX = 'About this Inbox alert:';
const requestIdentity = value => typeof value === 'string' && value.trim()
  ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, REQUEST_IDENTITY_MAX) : null;

function createAnalystWorkspace({ request, port = () => process.env.PORT || 3001, WebSocketImpl = WebSocket, canGenerate = () => true, sourceDiagnostics }) {
  const router = express.Router();
  const active = new Map();
  let portfolioRefreshHandler;
  const eventListeners = new Set();
  let inboxRead = null;
  let inboxProjection = true;
  let inboxProjectionRejected = false;
  const call = async (operation, body = {}, transport = {}) => {
    // A read that overlaps a finding write must not be reused after it commits.
    const findingWrite = FINDING_WRITES.has(operation) || (operation === 'setting' && body.key === 'pm-attention-v1' && 'value' in body);
    if (findingWrite) inboxRead = null;
    let result;
    try { result = await request(`/internal/workspace/${operation}`, { ...transport, method: 'POST', body }); }
    finally { if (findingWrite) inboxRead = null; }
    // Wake connected readers only after the durable write commits. The event
    // log remains the source of truth, including reconnects and external writes.
    if (EVENT_WRITES.has(operation) || (operation === 'setting' && (body.key?.startsWith('portfolio-reference:') || body.key?.startsWith('daily-run:')) && 'value' in body)) {
      for (const notify of eventListeners) notify();
    }
    return result;
  };
  const reviewSources = createReviewSources({ request, call });
  let diagnostics = sourceDiagnostics;
  let initialized = false;
  let initializing;
  let importing;
  let nextReadId = 0;
  const readDiagnostics = new Map();
  const getReadDiagnostics = () => [...readDiagnostics.values()].map(read => ({ ...read,
    stages: read.stages.map(stage => ({ ...stage,
      ...(stage.pythonTimings ? { pythonTimings: { ...stage.pythonTimings } } : {}) })) }));
  function beginRead(req) {
    const conversationId = String(req.params.id || '').slice(0, 128);
    let diagnostic = readDiagnostics.get(conversationId);
    if (!diagnostic) diagnostic = { conversationId, stages: [] };
    readDiagnostics.delete(conversationId);
    readDiagnostics.set(conversationId, diagnostic);
    while (readDiagnostics.size > READ_DIAGNOSTIC_CONVERSATIONS) readDiagnostics.delete(readDiagnostics.keys().next().value);
    return { diagnostic, readId: ++nextReadId };
  }
  function beginReadStage(read, name) {
    if (!read) return null;
    const entry = { readId: read.readId, stage: name, startedAt: new Date().toISOString(),
      completedAt: null, durationMs: null, outcome: 'pending' };
    read.diagnostic.stages.push(entry);
    while (read.diagnostic.stages.length > 96) read.diagnostic.stages.shift();
    const started = performance.now();
    return { entry, finish(outcome) {
      entry.completedAt = new Date().toISOString();
      entry.durationMs = Math.round(performance.now() - started);
      entry.outcome = outcome;
    } };
  }
  async function readStage(read, name, operation) {
    const span = beginReadStage(read, name);
    try { const result = await operation(span?.entry); span?.finish('completed'); return result; }
    catch (error) { span?.finish('failed'); throw error; }
  }
  // Alert id → conversation id. Writes are serialized so two threads opened at
  // once cannot overwrite each other's link.
  let inboxThreadWrites = Promise.resolve();
  const readInboxThreads = async () => {
    const value = (await call('setting', { key: INBOX_THREADS_KEY })).value;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const updateInboxThreads = change => {
    const write = inboxThreadWrites.then(async () => {
      const next = change(await readInboxThreads());
      await call('setting', { key: INBOX_THREADS_KEY, value: next });
      return next;
    });
    inboxThreadWrites = write.catch(() => {});
    return write;
  };
  const closeInboxThread = async findingId => {
    const conversationId = (await readInboxThreads())[findingId];
    if (!conversationId) return;
    await call('delete', { conversationId, requestedBy: { userAgent: 'inbox-dismiss', origin: 'inbox-dismiss' } });
    await updateInboxThreads(({ [findingId]: _closed, ...rest }) => rest);
  };
  const importHistory = () => {
    if (!importing) importing = call('import').catch(() => {
      // Saved local chats remain usable during an archive/provider outage.
      // A later initialization retries the import without changing tombstones.
      importing = null;
    });
  };
  const initialize = () => {
    if (initialized) { importHistory(); return Promise.resolve(); }
    if (!initializing) initializing = (async () => {
      await call('recover', { resumeReviews: true });
      initialized = true;
      importHistory();
    })().finally(() => { initializing = null; });
    return initializing;
  };
  const route = (fn, traceRead = false, { initializeWorkspace = true } = {}) => async (req, res) => {
    const read = traceRead ? beginRead(req) : null;
    const span = beginReadStage(read, 'route');
    try {
      if (initializeWorkspace) {
        if (read) await readStage(read, 'initialize', initialize); else await initialize();
      }
      await fn(req, res, read);
      span?.finish('completed');
    }
    catch (e) {
      span?.finish('failed');
      if (!res.headersSent) res.status(e.statusCode || 503).json({ error: e.message, code: e.code });
    }
    finally { if (span) span.entry.statusCode = res.statusCode; }
  };

  async function reconcileCompletedResponse(conversation, includeBriefs = true, briefSelection = {}) {
    const turn = conversation?.lastTurn;
    if (!conversation?.hermes_id || conversation.activeTurn || turn?.state !== 'failed' || turn.error !== RESPONSE_TIMEOUT_ERROR) return conversation;
    const { source } = await call('response-source', { conversationId: conversation.id, turnId: turn.id });
    if (!source || source.conversationId !== conversation.id || source.hermesId !== conversation.hermes_id || source.turnId !== turn.id || !Array.isArray(source.messages)) return conversation;
    const user = source.messages.findLast(message => message.role === 'user');
    const final = source.messages.findLast(message => message.role === 'assistant' && !message.tool_calls && String(message.content || '').trim());
    const prompt = conversation.messages.find(message => message.turn_id === turn.id && message.role === 'user');
    if (!user || !final || !prompt || projectHistory([user])[0]?.content !== prompt.text) return conversation;
    const evidence = {
      submittedPrompt: user.content,
      submittedAt: Date.parse(turn.created_at),
      requiredLiveTools: liveRequirementsForPrompt(prompt.text),
      completedLiveTools: new Set(),
    };
    // Reuse the live gateway's exact-turn verifier. Stored completion is a
    // captured observation, never a replacement for a new current-data read.
    if (!reconcileLiveTurnHistory(evidence, source.messages, final.content)) return conversation;
    const citations = collectCitations({ citations: source.citations });
    const sanitized = sanitizeCitationText(final.content, new Set(citations.keys()));
    const result = await call('reconcile-response', {
      conversationId: conversation.id, turnId: turn.id, hermesId: source.hermesId,
      expectedTurnCreatedAt: source.expectedTurnCreatedAt,
      expectedTurnUpdatedAt: source.expectedTurnUpdatedAt,
      sourceMessageId: source.sourceMessageId, completedAt: source.completedAt,
      text: sanitized.text, citations: sanitized.accepted.map(id => citations.get(id)),
      ...(!includeBriefs ? { includeBriefs: false, briefView: 'compact', ...briefSelection } : {}),
    });
    return result.conversation || conversation;
  }

  function generate(accepted) {
    const { turn, conversation } = accepted;
    if (active.has(turn.id)) return;
    const reviewMessage = conversation.messages.findLast(message => message.reviewRunId || message.portfolioBrief?.runId);
    const reviewRunId = conversation.referenceReview?.runId || reviewMessage?.reviewRunId || reviewMessage?.portfolioBrief?.runId;
    const ws = new WebSocketImpl(`ws://127.0.0.1:${port()}/ws/analyst`, { origin: `http://localhost:${port()}` });
    let finished = false;
    let terminalRequested = false;
    let submitted = !conversation.hermes_id && !reviewRunId;
    let queue = Promise.resolve();
    let deltaTimer = null;
    let flushQueued = false;
    const pendingDeltas = [];
    const send = (data) => ws.send(JSON.stringify(data));
    const persist = (type, extra = {}) => call('frame', { turnId: turn.id, type, includeConversation: false, ...extra });
    // Run timing diagnostics only; a listener can never affect the saved turn.
    const settled = type => { try { accepted.onSettled?.(type); } catch { /* ignore */ } };
    const finish = async (type, extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(deltaTimer);
      pendingDeltas.length = 0;
      try { await persist(type, extra); }
      finally { active.delete(turn.id); ws.close(); settled(type); }
    };
    const enqueue = task => {
      queue = queue.then(task).catch(e => finish('failed', { error: e.message })).catch(() => {});
    };
    const flushDeltas = async () => {
      if (finished || !pendingDeltas.length) return;
      const entries = pendingDeltas.splice(0);
      await persist('delta_batch', { entries });
    };
    const scheduleFlush = () => {
      if (finished || terminalRequested || deltaTimer || flushQueued) return;
      deltaTimer = setTimeout(() => {
        deltaTimer = null;
        flushQueued = true;
        enqueue(async () => {
          try { await flushDeltas(); }
          finally {
            flushQueued = false;
            if (pendingDeltas.length) scheduleFlush();
          }
        });
      }, 200);
    };
    const complete = (type, extra) => {
      if (finished || terminalRequested) return;
      terminalRequested = true;
      clearTimeout(deltaTimer);
      deltaTimer = null;
      enqueue(async () => { await flushDeltas(); await finish(type, extra); });
    };
    const timer = setTimeout(() => {
      void finish('failed', { error: RESPONSE_TIMEOUT_ERROR }).catch(() => {});
    }, RESPONSE_TIMEOUT_MS);
    active.set(turn.id, {
      conversationId: conversation.id,
      deadlineAt: Date.now() + RESPONSE_TIMEOUT_MS,
      stop: async () => {
        if (ws.readyState === WebSocketImpl.OPEN) send({ action: 'interrupt', requestId: turn.id });
        await finish('interrupted', { error: 'Stopped. You can retry this message.' });
      },
    });
    const text = accepted.narrative || conversation.messages.find(m => m.turn_id === turn.id && m.role === 'user').text;
    ws.on('open', () => send(conversation.hermes_id
      ? { action: 'resume', sessionId: conversation.hermes_id, requestId: turn.id }
      : reviewRunId
        ? { action: 'new_chat', requestId: turn.id }
        : { action: 'new_prompt', text, requestId: turn.id, conversationTitle: `[workspace:${conversation.id}] ${conversation.title}` }));
    ws.on('message', raw => {
      if (finished || terminalRequested) return;
      let frame;
      try { frame = JSON.parse(String(raw)); }
      catch (e) { complete('failed', { error: e.message }); return; }
      if (frame.type === 'message_delta') {
        pendingDeltas.push({ text: frame.text, eventId: frame.eventId ?? frame.event_id ?? frame.sequence });
        scheduleFlush();
        return;
      }
      if (frame.type === 'message_complete') {
        complete(frame.error ? 'failed' : 'complete', { text: frame.text, citations: frame.citations, error: frame.error });
        return;
      }
      if (frame.type === 'error') {
        complete('failed', { error: frame.error || 'Hermes could not complete this response.' });
        return;
      }
      enqueue(async () => {
        if (finished) return;
        if (frame.type === 'session' && (frame.storedSessionId || frame.sessionId)) {
          await persist('session', { sessionId: frame.storedSessionId || frame.sessionId });
          if (!submitted && !finished) {
            submitted = true;
            send({ action: 'prompt', text, sessionId: frame.storedSessionId || frame.sessionId, requestId: turn.id, ...(reviewRunId ? { reviewRunId } : {}) });
          }
        }
      });
    });
    ws.on('error', e => complete('failed', { error: e.message }));
    ws.on('close', () => complete('interrupted', { error: 'Hermes disconnected. The saved response can be retried.' }));
  }

  router.get('/conversations', route(async (req, res) => {
    const [result, threads] = await Promise.all([
      call('list', { query: req.query.q, archived: req.query.archived === 'true' }),
      readInboxThreads().catch(() => ({})),
    ]);
    // Alert discussions live under their alert, not in Chats.
    const hidden = new Set(Object.values(threads));
    res.json(hidden.size && Array.isArray(result?.conversations)
      ? { ...result, conversations: result.conversations.filter(row => !hidden.has(row.id)) } : result);
  }));
  router.get('/requests/:requestId', route(async (req, res) => {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId || requestId.length > 200) return res.status(400).json({ error: 'Request identity is invalid.' });
    res.set('Cache-Control', 'no-store');
    return res.json(await call('request', { requestId, includeBriefs: false }));
  }));
  router.get('/conversations/:id', route(async (req, res, read) => {
    const includeBriefs = req.query.includeBriefs !== 'false';
    const scope = req.query.briefScope;
    const messageId = req.query.briefMessageId;
    if ((scope !== undefined && scope !== 'latest')
      || (messageId !== undefined && (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 512))
      || (scope !== undefined && messageId !== undefined)
      || (includeBriefs && (scope !== undefined || messageId !== undefined))) {
      return res.status(400).json({ error: 'Choose one compact captured review projection.' });
    }
    const briefSelection = { ...(scope !== undefined ? { briefScope: scope } : {}),
      ...(messageId !== undefined ? { briefMessageId: messageId } : {}) };
    const result = await readStage(read, 'worker-get', entry => call('get', {
      conversationId: req.params.id, ...(!includeBriefs ? { includeBriefs: false, briefView: 'compact', ...briefSelection } : {}),
    }, { onResponse: metadata => {
      const timing = metadata?.serverTiming;
      if (!entry || typeof timing !== 'string' || timing.length > 512) return;
      const pythonTimings = {};
      for (const [, name, duration] of timing.matchAll(/(?:^|,)\s*(workspace|projection|encode);dur=([\d.]+)/g)) {
        const value = Number(duration);
        if (Number.isFinite(value) && value >= 0) pythonTimings[name] = value;
      }
      entry.pythonTimings = pythonTimings;
    } }));
    if (read) {
      read.diagnostic.runId = result.conversation?.reviewRunId || null;
    }
    // Reopening a timed-out chat can recover its actual saved Hermes answer
    // without submitting another prompt or creating another conversation.
    result.conversation = await readStage(read, 'reconcile', () =>
      reconcileCompletedResponse(result.conversation, includeBriefs, briefSelection).catch(() => result.conversation));
    if (!includeBriefs) result.conversation = { ...result.conversation, briefsIncluded: false };
    const serialized = beginReadStage(read, 'serialize');
    try {
      res.json(result);
      if (serialized) serialized.entry.responseBytes = Number(res.getHeader('Content-Length')) || 0;
      serialized?.finish('completed');
    } catch (error) { serialized?.finish('failed'); throw error; }
  }, true));
  router.get('/conversations/:id/citations/:messageId/:citationId', route(async (req, res) => {
    const { id: conversationId, messageId, citationId } = req.params;
    if (messageId.length > 256 || citationId.length > 256) return res.status(400).json({ error: 'Captured source identity is invalid.' });
    res.set('Cache-Control', 'no-store');
    const result = await call('captured-citation', { conversationId, messageId, citationId });
    return res.json({ citation: result.citation });
  }));
  router.get('/conversations/:id/sources', route(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sources = await reviewSources.getReviewSources(req.params.id);
    res.json(sources);
    // Investigate in the background; acquisition never waits for the Inbox.
    diagnostics ||= require('./analystSourceDiagnostics.cjs').createSourceDiagnostics({ call });
    void diagnostics.inspect(sources).catch(() => {});
  }));
  router.post('/messages', route(async (req, res) => {
    if (req.body?.operation !== undefined) return res.status(400).json({ error: 'Message operation is invalid.' });
    if (portfolioRefreshHandler && isPortfolioRefreshRequest(req.body.text)) {
      const text = String(req.body.text || '').trim();
      const requestId = String(req.body.requestId || '').trim();
      if (!requestId || !text || text.length > 20_000) return res.status(400).json({ error: 'A stable request ID and 1–20,000 character message are required.' });
      const result = await portfolioRefreshHandler({ requestId, conversationId: req.body.conversationId, text });
      return res.status(202).json(result);
    }
    if (!canGenerate()) return res.status(503).json({ code: 'ANALYST_STARTING', error: 'The Analyst is connecting. Your draft is saved; try again shortly.' });
    const result = await call('accept', { requestId: req.body.requestId, conversationId: req.body.conversationId,
      text: req.body.text });
    if (result.created) generate(result);
    res.status(202).json(result);
  }));
  // The user's one-click trash button is the only caller: a permanent delete
  // (tombstone + rows removed), never issued automatically, no archive or undo.
  router.delete('/conversations/:id', route(async (req, res) => {
    // Audit who asked, without trusting either header for authorization.
    const result = await call('delete', { conversationId: req.params.id,
      requestedBy: { userAgent: requestIdentity(req.get('user-agent')), origin: requestIdentity(req.get('origin')) } });
    // Durable deletion is the acknowledgment. Cleanup must not turn a saved
    // tombstone into an apparent failure if an upstream cancellation is slow.
    res.json({ ok: true });
    const owner = active.get(result.turnId);
    if (owner) void owner.stop().catch(() => {});
    if (result.cancelRunId) void call('cancel-review', { runId: result.cancelRunId, conversationId: req.params.id }).catch(() => {});
  }));
  router.post('/conversations/:id/turns/:turnId/retry', route(async (req, res) => {
    const current = (await call('get', { conversationId: req.params.id })).conversation;
    if (current.lastTurn?.id === req.params.turnId && current.lastTurn.state === 'failed' && current.lastTurn.error === RESPONSE_TIMEOUT_ERROR) {
      const reconciled = await reconcileCompletedResponse(current).catch(() => current);
      if (reconciled.lastTurn?.id === req.params.turnId && reconciled.lastTurn.state === 'complete') return res.status(200).json({ conversation: reconciled, recovered: true });
    }
    if (!canGenerate()) return res.status(503).json({ code: 'ANALYST_STARTING', error: 'The Analyst is connecting. Your saved report remains available; try again shortly.' });
    const data = await call('retry-data', { conversationId: req.params.id, turnId: req.params.turnId });
    const accepted = await call('accept', { conversationId: req.params.id, requestId: req.body.requestId, text: data.text,
      internalPrompt: data.internalPrompt, reviewPostId: data.reviewPostId });
    if (accepted.created) generate(data.internalPrompt ? { ...accepted, narrative: reviewNarrativePrompt(accepted.conversation.kind, data.report) } : accepted);
    res.status(202).json(accepted);
  }));
  router.post('/conversations/:id/turns/:turnId/stop', route(async (req, res) => {
    const owner = active.get(req.params.turnId);
    if (owner && owner.conversationId !== req.params.id) return res.status(409).json({ error: 'Turn belongs to another conversation.' });
    const saved = await call('get', { conversationId: req.params.id, includeBriefs: false });
    if (saved.conversation.activeTurn?.id !== req.params.turnId) return res.status(409).json({ error: 'That response is no longer running.' });
    if (owner) await owner.stop();
    else {
      const record = (await call('setting', { key: `daily-run:${req.params.id}` })).value;
      await call('frame', { turnId: req.params.turnId, type: 'interrupted', error: 'Response stopped. Retry is available.' });
      if (record?.turnId === req.params.turnId) await call('setting', { key: `daily-run:${req.params.id}`, value: {
        ...record, completedAt: new Date().toISOString(), error: true,
        reviewPhase: 'terminal', reviewState: 'cancelled', startPending: false,
      }, expectedRunId: record.runId, expectedTurnId: record.turnId });
      // A queued receipt can precede worker creation. Durable interruption is
      // the acknowledgment; its startup owner cancels any late acceptance.
      if (record?.turnId === req.params.turnId) void call('cancel-review', { runId: record.runId, conversationId: req.params.id }).catch(() => {});
    }
    return res.json({ ok: true });
  }));
  async function readFindings() {
    if (inboxProjection) {
      try {
        const projected = await call('findings', { excludeStates: INBOX_HISTORY_STATES });
        // Only the attention projection ignores non-open rows. The legacy one
        // still derives alerts from superseded history, so it reads every row.
        if (projected?.attentionVersion === 1) return projected;
        inboxProjection = false;
      } catch (error) {
        if (![400, 409, 422].includes(error?.statusCode)) throw error;
        inboxProjection = false;
        inboxProjectionRejected = true;
      }
    }
    const findings = await call('findings');
    if (!inboxProjectionRejected && findings?.attentionVersion === 1) inboxProjection = true;
    return findings;
  }
  function readInbox() {
    if (inboxRead && (inboxRead.settledAt === null || Date.now() - inboxRead.settledAt < INBOX_TTL_MS)) return inboxRead.promise;
    const entry = { settledAt: null };
    entry.promise = readFindings().then(findings => { entry.settledAt = Date.now(); return findings; },
      error => { if (inboxRead === entry) inboxRead = null; throw error; });
    inboxRead = entry;
    return entry.promise;
  }
  // Build per request: evidence freshness is evaluated at each reader's time.
  router.get('/inbox', route(async (_req, res) => res.json(buildAnalystInbox(await readInbox()))));
  router.post('/inbox/:id/read', route(async (req, res) => {
    const result = await call('finding-read', { id: req.params.id, acknowledge: req.body.acknowledge, fingerprint: req.body.fingerprint, materialRevision: req.body.materialRevision, keptReason: req.body.keptReason });
    res.json(result);
    // A dismissed alert takes its discussion with it.
    if (req.body.acknowledge) void closeInboxThread(req.params.id).catch(() => {});
  }));
  // Each alert can carry one Analyst conversation. The first message carries
  // the alert as the user saw it, so the Analyst discusses that exact card.
  router.get('/inbox-threads', route(async (_req, res) => res.json({ threads: await readInboxThreads() })));
  router.post('/inbox-threads/:findingId', route(async (req, res) => {
    const findingId = String(req.params.findingId || '');
    const text = String(req.body?.text || '').trim();
    const requestId = String(req.body?.requestId || '').trim();
    const alert = String(req.body?.alert || '').trim();
    if (!findingId || findingId.length > 256 || !requestId || !text || text.length > 20_000 || alert.length > 8_000) {
      return res.status(400).json({ error: 'A stable request ID, an alert, and a 1–20,000 character message are required.' });
    }
    if (!canGenerate()) return res.status(503).json({ code: 'ANALYST_STARTING', error: 'The Analyst is connecting. Your draft is saved; try again shortly.' });
    let conversationId = (await readInboxThreads())[findingId];
    // A thread deleted elsewhere starts over rather than failing every reply.
    if (conversationId && await call('get', { conversationId, includeBriefs: false }).then(() => false,
      error => ['ANALYST_CONVERSATION_DELETED', 'ANALYST_CONVERSATION_NOT_FOUND'].includes(error?.code) || [404, 410].includes(error?.statusCode))) {
      conversationId = undefined;
    }
    const result = await call('accept', { requestId, conversationId,
      text: conversationId ? text : `${INBOX_THREAD_PREFIX}\n${alert}\n\n${text}` });
    if (result.created) generate(result);
    if (!conversationId && result.conversation?.id) await updateInboxThreads(threads => ({ ...threads, [findingId]: result.conversation.id }));
    res.status(202).json(result);
  }));
  router.get('/process', route(async (_req, res) => res.json(await call('process'))));
  router.put('/process', route(async (req, res) => res.json(await call('process', { document: req.body.document }))));
  router.get('/events', route(async (req, res) => {
    const lastEventId = req.headers['last-event-id'];
    const reconnecting = typeof lastEventId === 'string' && lastEventId.trim() !== '' && Number.isFinite(Number(lastEventId));
    const latest = !reconnecting && req.query.after === 'latest';
    let cursor = latest ? null : Math.max(0, Number(reconnecting ? lastEventId : req.query.after) || 0);
    const resolveCursor = async () => {
      try {
        const result = await call('event-cursor', {}, { timeoutMs: 5_000 });
        if (!Number.isSafeInteger(result.cursor) || result.cursor < 0) throw new Error('Invalid event cursor');
        cursor = result.cursor;
        return true;
      } catch {
        // Falling back to zero would replay old acceptance events and revive
        // rows that the current list has already reconciled or deleted.
        return false;
      }
    };
    let closed = false;
    let timer = null;
    let notify = null;
    // Register before the cursor handshake: a client that leaves during it
    // must not leave a poller behind.
    req.on('close', () => { closed = true; clearInterval(timer); if (notify) eventListeners.delete(notify); });
    const resolved = latest ? await resolveCursor() : true;
    if (closed) return;
    // EventSource permanently closes on a non-200 answer, so an unavailable
    // tail still opens the stream and keeps retrying its cursor below.
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let pending = false;
    let refreshRequested = false;
    const ready = () => res.write(`id: ${cursor}\nevent: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
    const unavailable = message => res.write(`event: unavailable\ndata: ${JSON.stringify({ error: message })}\n\n`);
    const cursorUnavailable = 'The Analyst event cursor is unavailable.';
    // Give EventSource a reconnect cursor even when the current tail is quiet.
    // The following read still includes writes after the cursor snapshot.
    if (resolved && latest) ready();
    else if (!resolved) unavailable(cursorUnavailable);
    const tick = async () => {
      if (closed) return;
      if (pending) { refreshRequested = true; return; }
      pending = true;
      refreshRequested = false;
      try {
        if (cursor === null) {
          // No id is sent before a verified tail cursor, so a reconnect also
          // starts from latest instead of replaying old events.
          if (!await resolveCursor()) { if (!closed) unavailable(cursorUnavailable); return; }
          if (closed) return;
          ready();
        }
        const { events } = await call('events', { after: cursor });
        for (const event of events) {
          if (closed) break;
          res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
        }
        if (!events.length && !closed) ready();
      } catch (e) {
        if (!closed) res.write(`event: unavailable\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      } finally {
        pending = false;
        // A write can land while a prior read is in flight. Do not lose its
        // wake-up and leave the next text chunk waiting for the fallback poll.
        if (refreshRequested && !closed) void tick();
      }
    };
    notify = () => { void tick(); };
    eventListeners.add(notify);
    timer = setInterval(tick, 750);
    // A failed handshake retries on the fallback poll rather than immediately.
    if (resolved) await tick();
  }, false, { initializeWorkspace: false }));
  return { router, call, initialize, generate, active, reconcileCompletedResponse, getReadDiagnostics,
    setPortfolioRefreshHandler(handler) { portfolioRefreshHandler = handler; } };
}
module.exports = { createAnalystWorkspace };
