const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attachDailyWorkflow } = require('./analystDaily.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const settings = new Map();
  const conversations = new Map();
  const calls = [];
  const generated = [];
  const scan = deferred();
  let scanStarted = false;
  let runSequence = 0;
  let startRead = null;
  let startError = null;
  let lostAccept = false;
  let guardedStart = false;
  const runs = new Map();
  const statusReads = new Map();
  const captureReads = new Map();
  const failedReads = new Map();
  const deleted = new Set();
  const missing = new Set();
  const lines = [];
  const clone = value => structuredClone(value);
  const workspace = {
    router: express.Router(), active: new Map(), initialize: async () => {},
    generate: accepted => generated.push(accepted),
    call: async (operation, body = {}) => {
      calls.push({ operation, body });
      if (operation === 'setting') {
        if (Object.hasOwn(body, 'value')) {
          const previous = settings.get(body.key);
          if (body.expectedRunId && (previous?.runId !== body.expectedRunId || previous?.turnId !== body.expectedTurnId)) return { ignored: true };
          settings.set(body.key, clone(body.value));
        }
        return { value: settings.get(body.key) || null };
      }
      if (operation === 'daily') {
        if (!conversations.has(body.kind)) conversations.set(body.kind, {
          id: body.kind, kind: body.kind, messages: [], activeTurn: null, lastTurn: null,
        });
        return { conversation: clone(conversations.get(body.kind)) };
      }
      // Deletion removes the conversation row, so it leaves every list.
      if (operation === 'list') return { conversations: [...conversations.values()].filter(row => !deleted.has(row.id) && !missing.has(row.id))
        .map(row => ({ id: row.id, kind: row.kind, state: row.activeTurn?.state || row.lastTurn?.state })) };
      if (operation === 'cancel-review') return { ok: true };
      if (operation === 'source-binding') {
        // The sidecar answers a tombstoned chat with a typed 410 and an
        // unknown id with 404; neither owns a review.
        if (deleted.has(body.conversationId)) throw Object.assign(new Error('Conversation was deleted'), { statusCode: 410, code: 'ANALYST_CONVERSATION_DELETED' });
        if (missing.has(body.conversationId)) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
        const conversation = conversations.get(body.conversationId);
        return { conversation: { id: conversation.id, kind: conversation.kind, activeTurn: clone(conversation.activeTurn) },
          runId: settings.get(`daily-run:${body.conversationId}`)?.runId };
      }
      if (operation === 'get') return { conversation: { ...clone(conversations.get(body.conversationId)), briefsProjected: body.includeBriefs !== false } };
      if (operation === 'accept') {
        const conversation = conversations.get(body.conversationId);
        const acceptedTurn = { id: body.requestId, state: 'accepted' };
        conversation.activeTurn = acceptedTurn;
        conversation.lastTurn = acceptedTurn;
        if (body.reviewRecord) {
          settings.set(`daily-run:${conversation.id}`, clone({ ...body.reviewRecord, turnId: acceptedTurn.id }));
          settings.set(`review-post:${conversation.id}:${body.reviewRecord.reviewPostId}`, clone({ ...body.reviewRecord, turnId: acceptedTurn.id }));
          settings.set(body.reviewRequestBinding.key, clone({ ...body.reviewRequestBinding.value, turnId: acceptedTurn.id }));
          conversation.reviewPhase = body.reviewRecord.reviewPhase;
          conversation.reviewRunId = body.reviewRecord.runId;
        }
        if (lostAccept) { lostAccept = false; throw new Error('Accept receipt lost'); }
        return { created: true, turn: clone(acceptedTurn), conversation: { ...clone(conversation), briefsProjected: body.includeBriefs !== false } };
      }
      if (operation === 'frame') {
        const conversation = [...conversations.values()].find(row => row.activeTurn?.id === body.turnId);
        assert.ok(conversation, 'only the owning active turn is completed');
        const message = conversation.messages.find(row => row.turn_id === body.turnId);
        const update = { role: 'assistant', text: body.text, citations: body.citations, turn_id: body.turnId, state: body.type === 'progress' ? 'reviewing' : body.type };
        // Mirrors workspace.py: a failure after a published revision keeps
        // that report and its citations and appends the one status line.
        if (body.type === 'failed' && body.partialStatus && message?.state === 'reviewing' && message.text.trim()) {
          Object.assign(update, { text: `${message.text.trimEnd()}\n\n${body.partialStatus}`, citations: message.citations });
        }
        if (message) Object.assign(message, update); else conversation.messages.push(update);
        if (body.type !== 'progress') {
          conversation.activeTurn = null;
          conversation.lastTurn = { id: body.turnId, state: body.type };
        }
        return {};
      }
      if (operation === 'deleted') return { deleted: deleted.has(body.conversationId) };
      if (operation === 'recover') return { recovered: 0 };
      if (operation === 'findings') return { findings: [] };
      assert.fail(`Unexpected workspace operation ${operation}`);
    },
  };
  const request = async (path, options = {}) => {
    calls.push({ path, ...(options.body ? { body: clone(options.body) } : {}) });
    if (path === '/internal/workspace/changes') { scanStarted = true; return scan.promise; }
    if (path === '/internal/workspace/readiness') return {};
    if (path === '/internal/reviews' && options.method === 'POST') {
      if (startRead) await startRead.promise;
      if (startError) throw startError;
      if (guardedStart) {
        const conversation = conversations.get(options.body.conversationId);
        const record = settings.get(`daily-run:${options.body.conversationId}`);
        if (deleted.has(options.body.conversationId) || conversation?.activeTurn?.id !== options.body.workspaceTurnId
          || conversation?.kind !== options.body.reviewKind || record?.runId !== options.body.runId
          || record?.turnId !== options.body.workspaceTurnId || record?.startRequest?.requestId !== options.body.requestId
          || record?.completedAt || record?.error) {
          throw Object.assign(new Error('Review dispatch no longer owns the accepted turn'), { statusCode: 409 });
        }
      }
      const runId = options.body.runId;
      const run = { runId, state: 'running', reviewKind: options.body.reviewKind, conversationId: options.body.conversationId };
      runs.set(runId, run);
      return clone(run);
    }
    const match = path.match(/^\/internal\/reviews\/([^/]+)(\/status)?$/);
    if (match) {
      const [, runId, status] = match;
      if (failedReads.has(runId)) throw failedReads.get(runId);
      const read = (status ? statusReads : captureReads).get(runId);
      return read ? read.promise : clone(runs.get(runId));
    }
    assert.fail(`Unexpected request ${path}`);
  };
  const daily = attachDailyWorkflow({ workspace, request, now: () => new Date('2026-09-19T15:00:00Z'), createRunId: () => runSequence++ ? 'balance-review-run' : 'review-run',
    logRun: line => lines.push(line) });
  const prepare = async (...args) => { const result = await daily.prepare(...args); await turn(); return result; };
  return {
    daily, prepare, calls, conversations, generated, scan, deleted, missing, lines, failedReads, workspace, request, settings,
    clearStartDelay() { startRead = null; },
    delayStart() { startRead = deferred(); return startRead; },
    loseAcceptReceipt() { lostAccept = true; },
    failStart(error) { startError = error; },
    guardStarts() { guardedStart = true; },
    get scanStarted() { return scanStarted; },
    phase(phase, state = 'running') { runs.set('review-run', { ...runs.get('review-run'), phase, state }); },
    progress(revision = 'revision-1') {
      const run = { ...runs.get('review-run'), reportAvailable: true, reportRevision: revision,
        reportMarkdown: 'Verified research section', citations: [{ id: 'captured-citation', publicationDate: '2026-09-18' }] };
      runs.set('review-run', run);
      return clone(run);
    },
    failed(error) {
      const run = { ...runs.get('review-run'), state: 'failed', phase: 'terminal', outcome: 'blocked', error, completedAt: '2026-09-19T15:00:01Z' };
      runs.set('review-run', run);
      return clone(run);
    },
    completed(runId = 'review-run') {
      const run = { ...runs.get(runId), state: 'succeeded', outcome: 'ready', reportMarkdown: 'Verified Silver report', completedAt: '2026-09-19T15:00:01Z' };
      runs.set(runId, run);
      return clone(run);
    },
    delayReview(runId = 'review-run') { const read = deferred(); statusReads.set(runId, read); return read; },
    delayCapture(runId = 'review-run') { const read = deferred(); captureReads.set(runId, read); return read; },
  };
}

test('accepted review dispatch and collection do not await saved report history', async () => {
  const subject = fixture();
  const history = deferred();
  let accepted = false;
  const original = subject.workspace.call;
  subject.workspace.call = async (operation, body) => {
    if (operation === 'get' && accepted) return history.promise;
    const result = await original(operation, body);
    if (operation === 'accept') accepted = true;
    return result;
  };
  // The adapter captures workspace.call at construction. Recreate it with
  // history deliberately blocked after the durable acceptance commits.
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request,
    now: () => new Date('2026-09-19T15:00:00Z'), createRunId: () => 'review-run' });
  subject.scan.resolve({ events: [] });
  try {
    await daily.prepare('prediction-markets-review', true, { requestId: 'history-independent' });
    await turn();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'source-binding').length, 1);
    subject.progress();
    await daily.tick();
    assert.equal(subject.conversations.get('prediction-markets-review').messages.length, 1);
    assert.equal(subject.conversations.get('prediction-markets-review').activeTurn.state, 'accepted');
    subject.completed();
    await daily.tick();
    assert.equal(subject.conversations.get('prediction-markets-review').activeTurn, null);
  } finally {
    history.resolve({ conversation: subject.conversations.get('prediction-markets-review') });
    daily.stop();
    subject.daily.stop();
  }
});

test('verified progress replaces the owning post once per revision and completes that same post', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    subject.progress();
    await subject.daily.tick();
    const conversation = subject.conversations.get('prediction-markets-review');
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].state, 'reviewing');
    assert.equal(conversation.messages[0].citations[0].publicationDate, '2026-09-18');
    assert.ok(conversation.activeTurn);
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 1);
    subject.progress('revision-2');
    await subject.daily.tick();
    assert.equal(conversation.messages.length, 1);
    subject.completed();
    await subject.daily.tick();
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].text, 'Verified Silver report');
    assert.equal(conversation.activeTurn, null);
    assert.equal(subject.generated.length, 0);
  } finally { subject.daily.stop(); }
});

test('a failure after published progress keeps that report and appends one status line', async () => {
  const deadline = { code: 'REVIEW_DEADLINE_EXCEEDED', message: 'The review did not finish within its server deadline.', retryable: true };
  const restarted = { code: 'REVIEW_PROCESS_RESTARTED', message: 'The review was interrupted when the review service restarted.', retryable: true };
  for (const [error, status] of [
    [deadline, 'Review interrupted: the server deadline passed before every source finished. Refresh to retry with fresh evidence.'],
    // Each status line names the interruption once, as one sentence, before the shared remedy.
    [restarted, 'Review interrupted: the review service restarted before every source finished. Refresh to retry with fresh evidence.'],
    [{ code: 'PORTFOLIO_MARKET_SESSION_UNAVAILABLE', retryable: true,
      message: 'The verified market session is unavailable. Refresh this review when the source is ready.' },
    'Review interrupted: the verified market session is unavailable. Refresh to retry with fresh evidence.'],
  ]) {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    try {
      await subject.prepare('prediction-markets-review', true);
      subject.progress();
      await subject.daily.tick();
      subject.failed(error);
      await subject.daily.tick();
      const conversation = subject.conversations.get('prediction-markets-review');
      assert.equal(conversation.messages.length, 1);
      assert.equal(conversation.messages[0].text, `Verified research section\n\n${status}`);
      assert.deepEqual(conversation.messages[0].citations, [{ id: 'captured-citation', publicationDate: '2026-09-18' }]);
      assert.equal(conversation.messages[0].state, 'failed');
      assert.equal(conversation.lastTurn.state, 'failed');
      const frames = subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'failed');
      assert.equal(frames.length, 1);
      assert.equal(frames[0].body.partialStatus, status);
      assert.equal(frames[0].body.error, error.message);
    } finally { subject.daily.stop(); }
  }
});

test('daily start and refresh failures keep the sidecar error code for the browser', async () => {
  const http = require('node:http');
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  const app = express();
  app.use(express.json());
  app.use(subject.workspace.router);
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const post = () => new Promise((resolve, reject) => {
    const body = JSON.stringify({ refresh: true, conversationId: 'deleted-elsewhere', requestId: 'refresh-request' });
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/daily/portfolio-review', method: 'POST',
      agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(body);
  });
  try {
    // Another window deleted the chat; the sidecar's typed 410 must reach the browser intact.
    subject.workspace.initialize = async () => { throw Object.assign(new Error('Conversation was deleted'), { statusCode: 410, code: 'ANALYST_CONVERSATION_DELETED' }); };
    assert.deepEqual(await post(), { status: 410, body: { error: 'Conversation was deleted', code: 'ANALYST_CONVERSATION_DELETED' } });
    subject.workspace.initialize = async () => { throw new Error('Analyst sidecar unavailable'); };
    assert.deepEqual(await post(), { status: 503, body: { error: 'Analyst sidecar unavailable' } });
  } finally {
    await new Promise(resolve => server.close(resolve));
    subject.daily.stop();
  }
});

test('a deadline before any published revision keeps today\'s one-line failure', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    subject.failed({ code: 'REVIEW_DEADLINE_EXCEEDED', message: 'The review did not finish within its server deadline.', retryable: true });
    await subject.daily.tick();
    const conversation = subject.conversations.get('prediction-markets-review');
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].text,
      'Review interrupted: The review did not finish within its server deadline. Open today’s review to retry with fresh evidence.');
    assert.equal(conversation.messages[0].state, 'failed');
    assert.equal(conversation.lastTurn.state, 'failed');
    assert.equal(subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'progress').length, 0);
  } finally { subject.daily.stop(); }
});

test('late progressive content cannot publish after Stop or delete', async () => {
  for (const action of ['stop', 'delete']) {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    try {
      await subject.prepare('prediction-markets-review', true);
      subject.progress();
      const read = subject.delayCapture();
      const collecting = subject.daily.tick();
      await turn();
      if (action === 'delete') subject.deleted.add('prediction-markets-review');
      else subject.conversations.get('prediction-markets-review').activeTurn = null;
      read.resolve(subject.progress('revision-2'));
      await collecting;
      assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
      assert.equal(subject.generated.length, 0);
    } finally { subject.daily.stop(); }
  }
});

test('a newer captured publication wins a stale status trigger without duplicate progress', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    const older = subject.progress('revision-1');
    const status = subject.delayReview();
    status.resolve(older);
    const capture = subject.delayCapture();
    const collecting = subject.daily.tick();
    await turn();
    capture.resolve(subject.progress('revision-2'));
    await collecting;
    const progress = subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'progress');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].body.reportRevision, 'revision-2');
    assert.equal(subject.settings.get('daily-run:prediction-markets-review').progressRevision, 'revision-2');
    assert.ok(subject.conversations.get('prediction-markets-review').activeTurn);
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'progress').length, 1);
  } finally { subject.daily.stop(); }
});

test('collector diagnostics bound scalar stage timings and expose an in-flight capture without report evidence', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    subject.progress();
    const capture = subject.delayCapture();
    const collecting = subject.daily.tick();
    await turn();
    const pending = subject.daily.getReviewDiagnostics()[0];
    assert.equal(pending.runId, 'review-run');
    assert.equal(pending.stages.findLast(stage => stage.stage === 'capture').outcome, 'pending');
    capture.resolve(subject.progress());
    await collecting;
    const completed = subject.daily.getReviewDiagnostics()[0];
    for (const name of ['restore-background', 'deleted', 'status', 'capture', 'publish-ownership', 'progress-frame']) {
      const stage = completed.stages.findLast(value => value.stage === name);
      assert.equal(stage.outcome, 'completed');
      assert.ok(stage.completedAt);
      assert.ok(stage.durationMs >= 0);
    }
    for (let index = 0; index < 35; index += 1) await subject.daily.tick();
    const bounded = subject.daily.getReviewDiagnostics();
    assert.ok(bounded.length <= 3);
    assert.equal(bounded[0].stages.length, 96);
    const serialized = JSON.stringify(bounded);
    for (const content of ['Verified research section', 'captured-citation', 'Prepare Predictive', 'sourceEvidence', 'Authorization']) {
      assert.equal(serialized.includes(content), false);
    }
  } finally { subject.daily.stop(); }
});

test('known captures publish while recovery inventory is blocked', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  const inventory = deferred();
  const original = subject.workspace.call;
  subject.workspace.call = (operation, body) => operation === 'list' ? inventory.promise : original(operation, body);
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, createRunId: () => 'review-run' });
  try {
    await daily.prepare('prediction-markets-review', true);
    await turn();
    subject.progress();
    await daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'progress').length, 1);
    assert.ok(daily.getReviewDiagnostics()[0].stages.some(stage => stage.stage === 'restore-background' && stage.outcome === 'pending'));
    subject.completed();
    await daily.tick();
    assert.equal(subject.conversations.get('prediction-markets-review').activeTurn, null);
  } finally {
    inventory.resolve({ conversations: [] });
    await turn();
    daily.stop(); subject.daily.stop();
  }
});

test('initial control reads run together and retain Stop and deletion authority', async () => {
  for (const action of ['publish', 'stop', 'delete']) {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    const deleted = deferred();
    let blocking = false;
    let deletedReads = 0;
    let ownerStarted = false;
    let statusStarted = false;
    const originalCall = subject.workspace.call;
    subject.workspace.call = async (operation, body) => {
      if (blocking && operation === 'deleted' && ++deletedReads === 1) await deleted.promise;
      if (blocking && operation === 'source-binding') ownerStarted = true;
      return originalCall(operation, body);
    };
    const request = (path, options) => {
      if (blocking && path.endsWith('/status')) statusStarted = true;
      return subject.request(path, options);
    };
    const daily = attachDailyWorkflow({ workspace: subject.workspace, request, createRunId: () => 'review-run' });
    try {
      await daily.prepare('prediction-markets-review', true);
      await turn();
      subject.progress(); blocking = true;
      const collecting = daily.tick();
      await turn();
      assert.equal(statusStarted, true);
      assert.equal(ownerStarted, true);
      if (action === 'delete') subject.deleted.add('prediction-markets-review');
      if (action === 'stop') subject.conversations.get('prediction-markets-review').activeTurn = null;
      deleted.resolve();
      await collecting;
      assert.equal(subject.calls.filter(call => call.operation === 'frame').length, action === 'publish' ? 1 : 0);
    } finally { deleted.resolve(); daily.stop(); subject.daily.stop(); }
  }
});

test('late restart inventory cannot replace a newly accepted refresh owner', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  await subject.prepare('prediction-markets-review', true);
  const previous = structuredClone(subject.settings.get('daily-run:prediction-markets-review'));
  const inventoryRead = deferred();
  const inventoryStarted = deferred();
  const original = subject.workspace.call;
  let blocked = false;
  subject.workspace.call = (operation, body) => {
    if (!blocked && operation === 'setting' && body.key === 'daily-run:prediction-markets-review' && !('value' in body)) {
      blocked = true; inventoryStarted.resolve();
      return inventoryRead.promise;
    }
    return original(operation, body);
  };
  const restarted = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, createRunId: () => 'balance-review-run' });
  const restoring = restarted.tick();
  try {
    await inventoryStarted.promise;
    subject.conversations.get('prediction-markets-review').activeTurn = null;
    await restarted.prepare('prediction-markets-review', true, { refresh: true, conversationId: 'prediction-markets-review', requestId: 'new-owner' });
    await turn();
    inventoryRead.resolve({ value: previous });
    await restoring;
    subject.completed('balance-review-run');
    await restarted.tick();
    assert.equal(subject.settings.get('daily-run:prediction-markets-review').runId, 'balance-review-run');
    assert.equal(subject.conversations.get('prediction-markets-review').activeTurn, null);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 2);
    assert.equal(subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'complete').length, 1);
  } finally {
    inventoryRead.resolve({ value: previous }); await restoring;
    restarted.stop(); subject.daily.stop();
  }
});

test('the whole recovery inventory runs at five-second cadence and finds a lost committed receipt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-19T15:00:00Z') });
  const subject = fixture();
  const kind = 'prediction-markets-review';
  subject.scan.resolve({ events: [] });
  try {
    await subject.daily.tick();
    // The headless close capture needs no recovery read; only the inventory lists.
    const recoveryReads = () => subject.calls.filter(call => call.operation === 'list'
      || call.operation === 'setting' && call.body.key.startsWith('hermes-portfolio-close:'));
    assert.equal(recoveryReads().length, 2);

    t.mock.timers.tick(1000);
    subject.loseAcceptReceipt();
    await assert.rejects(subject.daily.prepare(kind, true, { refresh: true, requestId: 'missed-receipt' }), /Accept receipt lost/);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 0);
    for (let index = 0; index < 4; index += 1) {
      await subject.daily.tick();
      assert.equal(recoveryReads().length, 2, 'inventory recovery keeps its five-second cadence');
      if (index < 3) t.mock.timers.tick(1000);
    }
    t.mock.timers.tick(1000);
    await subject.daily.tick();
    await turn();
    // Contract change: after the first completed restoration the archived list
    // is no longer re-read (3 reads, then 2 per cadence: visible list + close).
    assert.equal(recoveryReads().length, 3);
    assert.equal(subject.calls.filter(call => call.operation === 'list' && call.body.archived === true).length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
    assert.equal(subject.settings.get(`daily-run:${kind}`).startPending, false);
  } finally { subject.daily.stop(); }
});

test('a failed recovery attempt retries on the same five-second cadence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-19T15:00:00Z') });
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  const original = subject.workspace.call;
  let failInventory = true;
  let inventoryReads = 0;
  subject.workspace.call = async (operation, body) => {
    if (operation === 'list') {
      inventoryReads += 1;
      if (failInventory) throw new Error('Recovery inventory unavailable');
    }
    return original(operation, body);
  };
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request });
  try {
    await daily.tick();
    assert.equal(inventoryReads, 2);
    assert.match(subject.settings.get('monitor-health').error, /Recovery inventory unavailable/);
    failInventory = false;
    t.mock.timers.tick(4999);
    await daily.tick();
    assert.equal(inventoryReads, 2);
    assert.match(subject.settings.get('monitor-health').error, /Recovery inventory unavailable/);
    t.mock.timers.tick(1);
    await daily.tick();
    assert.equal(inventoryReads, 4);
    assert.equal(subject.settings.get('monitor-health').error, null);
  } finally { daily.stop(); subject.daily.stop(); }
});

test('requested refresh reads its ledger, owner and previous binding concurrently, with one history read', async () => {
  const subject = fixture();
  const kind = 'balance-review';
  subject.conversations.set(kind, { id: kind, kind, messages: [{ role: 'assistant', text: 'Captured account history' }], activeTurn: null, lastTurn: null });
  const release = deferred();
  const started = new Set();
  const original = subject.workspace.call;
  subject.workspace.call = async (operation, body) => {
    const name = operation === 'get' ? 'owner' : operation === 'setting'
      && !Object.hasOwn(body, 'value') ? body.key.startsWith('daily-refresh:') ? 'ledger'
        : body.key === `daily-run:${kind}` ? 'previous' : null : null;
    if (name && started.size < 3) { started.add(name); await release.promise; }
    return original(operation, body);
  };
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, createRunId: () => 'review-run' });
  const options = { conversationId: kind, refresh: true, requestId: 'parallel-refresh' };
  try {
    const preparing = daily.prepare(kind, true, options);
    await turn();
    assert.deepEqual(started, new Set(['ledger', 'owner', 'previous']));
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 0);
    release.resolve();
    const receipt = await preparing;
    await turn();
    assert.equal(receipt.messages[0].text, 'Captured account history');
    assert.equal(subject.calls.filter(call => call.operation === 'get').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
    const replayStart = subject.calls.length;
    const replay = await daily.prepare(kind, true, options);
    assert.equal(replay.reviewRunId, receipt.reviewRunId);
    assert.equal(subject.calls.slice(replayStart).filter(call => call.operation === 'get').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
  } finally { release.resolve(); daily.stop(); subject.daily.stop(); }
});

for (const action of ['delete', 'running']) test(`the atomic acceptance rejects an owner made ${action} after parallel metadata was read`, async () => {
  const subject = fixture();
  const kind = 'balance-review';
  subject.conversations.set(kind, { id: kind, kind, messages: [], activeTurn: null, lastTurn: null });
  const original = subject.workspace.call;
  let staleOwnerRead = false;
  subject.workspace.call = async (operation, body) => {
    if (operation === 'accept') {
      assert.equal(staleOwnerRead, true);
      if (action === 'delete' && subject.deleted.has(kind)) throw Object.assign(new Error('Conversation was deleted'), { statusCode: 410, code: 'ANALYST_CONVERSATION_DELETED' });
      if (action === 'running' && subject.conversations.get(kind).activeTurn) throw new Error('A response is already running');
    }
    const result = await original(operation, body);
    if (operation === 'get') {
      staleOwnerRead = true;
      if (action === 'delete') subject.deleted.add(kind);
      else subject.conversations.get(kind).activeTurn = { id: 'other-owner', state: 'running' };
    }
    return result;
  };
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request });
  try {
    await assert.rejects(daily.prepare(kind, true, { conversationId: kind, refresh: true, requestId: `raced-${action}` }), action === 'delete' ? /was deleted/ : /already running/);
    assert.equal(subject.calls.filter(call => call.operation === 'get').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 0);
    assert.equal(subject.settings.has(`daily-run:${kind}`), false);
  } finally { daily.stop(); subject.daily.stop(); }
});

test('a ready prediction report publishes once during a blocked alert scan without an automatic narrative', async () => {
  const subject = fixture();
  let firstFinished = false;
  const first = subject.daily.tick().then(() => { firstFinished = true; });
  try {
    await turn();
    assert.equal(subject.scanStarted, true);
    await subject.prepare('prediction-markets-review', true);
    const finished = subject.completed();
    const read = subject.delayReview();
    const second = subject.daily.tick();
    const concurrent = subject.daily.tick();
    await turn();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run/status').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 0);
    read.resolve(finished);
    await Promise.all([second, concurrent]);
    assert.equal(firstFinished, false, 'collection must not wait for the alert scan');
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.generated.length, 0);
    assert.equal(subject.calls.filter(call => call.operation === 'accept' && call.body.requestId.startsWith('daily-narrative:')).length, 0);
    assert.equal(subject.conversations.get('prediction-markets-review').messages[0].text, 'Verified Silver report');
    assert.equal(subject.conversations.get('prediction-markets-review').activeTurn, null);
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.generated.length, 0);
  } finally {
    subject.scan.resolve({ events: [] });
    await first;
    subject.daily.stop();
  }
});

test('the existing worker timer collects during an alert scan and stop clears further collection ticks', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const subject = fixture();
  subject.daily.start();
  try {
    await turn();
    assert.equal(subject.scanStarted, true);
    await subject.prepare('prediction-markets-review', true);
    subject.completed();
    t.mock.timers.tick(5000);
    await turn();
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.generated.length, 0);
    subject.daily.stop();
    const count = subject.calls.length;
    t.mock.timers.tick(20000);
    await turn();
    assert.equal(subject.calls.length, count);
    assert.equal(subject.generated.length, 0);
  } finally {
    subject.daily.stop();
    subject.scan.resolve({ events: [] });
    await turn();
  }
});

for (const kind of ['portfolio-review', 'prediction-markets-review']) test(`${kind} preflight failure completes its accepted turn within the first quarter-second poll and preserves saved history`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const subject = fixture();
  subject.daily.start();
  try {
    await turn();
    await subject.prepare(kind, true, { refresh: true, requestId: 'disconnected-refresh' });
    const conversation = subject.conversations.get(kind);
    const previous = { role: 'assistant', text: 'Original verified review', turn_id: 'saved-capture', state: 'complete' };
    conversation.messages.push(previous);
    subject.phase('terminal', 'failed');
    t.mock.timers.tick(250);
    await turn();
    assert.equal(conversation.activeTurn, null);
    assert.equal(conversation.lastTurn.state, 'failed');
    assert.deepEqual(conversation.messages[0], previous);
    assert.equal(subject.calls.filter(call => call.operation === 'frame' && call.body.type === 'failed').length, 1);
    assert.equal(subject.generated.length, 0);
    assert.equal(subject.calls.filter(call => call.path === '/internal/workspace/readiness').length, 0);
  } finally { subject.daily.stop(); subject.scan.resolve({ events: [] }); await turn(); }
});

test('portfolio generation returns to the existing one-second status cadence after acquisition', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const subject = fixture();
  subject.daily.start();
  try {
    await turn();
    await subject.prepare('portfolio-review', true, { refresh: true });
    subject.phase('summarizing');
    t.mock.timers.tick(250);
    await turn();
    const statusCount = () => subject.calls.filter(call => call.path === '/internal/reviews/review-run/status').length;
    const count = statusCount();
    t.mock.timers.tick(250);
    await turn();
    assert.equal(statusCount(), count);
    t.mock.timers.tick(500);
    await turn();
    assert.equal(statusCount(), count + 1);
  } finally { subject.daily.stop(); subject.scan.resolve({ events: [] }); await turn(); }
});

test('balance reviews retain their automatic additional-issues narrative', async () => {
  const subject = fixture();
  try {
    await subject.prepare('balance-review', true);
    subject.completed();
    subject.scan.resolve({ events: [] });
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.generated.length, 1);
    assert.match(subject.generated[0].narrative, /Check this Balance Review for additional issues only/);
    assert.equal(subject.calls.filter(call => call.operation === 'accept' && call.body.requestId === 'daily-narrative:review-run').length, 1);
  } finally {
    subject.scan.resolve({ events: [] });
    subject.daily.stop();
  }
});

test('prediction preparation and completed-run polling read metadata without hydrating saved reports', async () => {
  const subject = fixture();
  const id = 'prediction-markets-review';
  subject.conversations.set(id, { id, kind: id, messages: [{ role: 'assistant', text: 'Earlier saved review' }], activeTurn: null, lastTurn: null });
  try {
    const result = await subject.prepare(id, true, { conversationId: id, refresh: true, requestId: 'fresh-capture' });
    const preparingReads = subject.calls.filter(call => call.operation === 'get');
    assert.equal(preparingReads.length, 1);
    assert.ok(preparingReads.every(call => call.body.includeBriefs === false));
    assert.equal(result.briefsProjected, false, 'acceptance skips saved report hydration');
    assert.equal(result.briefsIncluded, false, 'the browser is told to preserve existing captured briefs');
    assert.equal(result.messages[0].text, 'Earlier saved review');
    assert.equal(subject.calls.find(call => call.operation === 'accept').body.includeBriefs, false);

    const pollStart = subject.calls.length;
    subject.completed();
    subject.scan.resolve({ events: [] });
    await subject.daily.tick();
    const pollReads = subject.calls.slice(pollStart).filter(call => call.operation === 'get');
    assert.equal(pollReads.length, 0);
    assert.equal(subject.calls.slice(pollStart).filter(call => call.operation === 'source-binding').length, 2);
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.conversations.get(id).messages.at(-1).text, 'Verified Silver report');
  } finally {
    subject.scan.resolve({ events: [] });
    subject.daily.stop();
  }
});

test('initial and recent saved daily receipts skip report hydration and preserve captured text', async () => {
  const subject = fixture();
  const id = 'prediction-markets-review';
  subject.scan.resolve({ events: [] });
  try {
    const initial = await subject.prepare(id, true, { requestId: 'initial-review' });
    assert.equal(initial.briefsIncluded, false);
    assert.equal(subject.calls.find(call => call.operation === 'daily').body.includeBriefs, false);
    subject.completed();
    await subject.daily.tick();
    const start = subject.calls.length;
    const saved = await subject.prepare(id, true, { requestId: 'open-saved-review' });
    assert.equal(saved.messages.at(-1).text, 'Verified Silver report');
    assert.equal(saved.briefsIncluded, false);
    assert.ok(subject.calls.slice(start).filter(call => call.operation === 'daily' || call.operation === 'get')
      .every(call => call.body.includeBriefs === false));
    assert.equal(subject.calls.slice(start).filter(call => call.operation === 'accept').length, 0);
    const requested = await subject.prepare(id, true, { conversationId: id, requestId: 'open-saved-by-id' });
    assert.equal(requested.briefsIncluded, false);
    assert.equal(requested.briefsProjected, false);
    assert.equal(requested.messages.at(-1).text, 'Verified Silver report');
  } finally { subject.daily.stop(); }
});

test('an active requested review returns metadata without saved report hydration', async () => {
  const subject = fixture();
  const id = 'prediction-markets-review';
  const activeTurn = { id: 'existing-turn', state: 'running' };
  subject.conversations.set(id, { id, kind: id, messages: [], activeTurn, lastTurn: activeTurn });
  try {
    const result = await subject.prepare(id, true, { conversationId: id, refresh: true, requestId: 'active-capture' });
    assert.deepEqual(subject.calls.filter(call => call.operation === 'get').map(call => call.body.includeBriefs), [false]);
    assert.equal(result.briefsProjected, false);
    assert.equal(result.briefsIncluded, false);
    assert.deepEqual(result.activeTurn, activeTurn);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 0);
  } finally {
    subject.daily.stop();
  }
});

test('an idempotent refresh response replays metadata without saved report hydration', async () => {
  const subject = fixture();
  try {
    const options = { refresh: true, requestId: 'same-capture' };
    await subject.prepare('prediction-markets-review', true, options);
    const replayStart = subject.calls.length;
    const result = await subject.prepare('prediction-markets-review', true, options);
    const reads = subject.calls.slice(replayStart).filter(call => call.operation === 'get');
    assert.equal(reads.length, 1);
    assert.equal(reads[0].body.includeBriefs, false);
    assert.equal(result.briefsProjected, false);
    assert.equal(result.briefsIncluded, false);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
  } finally {
    subject.daily.stop();
  }
});

test('active reviews poll compact status without downloading or publishing a report', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    await subject.daily.tick();
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run/status').length, 2);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 0);
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
    assert.ok(subject.conversations.get('prediction-markets-review').activeTurn);
  } finally { subject.daily.stop(); }
});

test('a newly completed review publishes while another review status read remains blocked', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  let blockedTick;
  const read = subject.delayReview();
  try {
    await subject.prepare('prediction-markets-review', true);
    const prediction = subject.completed();
    blockedTick = subject.daily.tick();
    await turn();
    await subject.prepare('balance-review', true);
    subject.completed('balance-review-run');
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run/status').length, 1, 'one collector owns the blocked conversation');
    assert.equal(subject.conversations.get('balance-review').messages.length, 1);
    assert.equal(subject.conversations.get('prediction-markets-review').messages.length, 0);
    read.resolve(prediction);
    await blockedTick;
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 2);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 1);
  } finally {
    read.resolve(subject.completed());
    await blockedTick;
    subject.daily.stop();
  }
});

test('a failed status read does not suppress another review and retries only its own run', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    await subject.prepare('prediction-markets-review', true);
    await subject.prepare('balance-review', true);
    subject.completed();
    subject.completed('balance-review-run');
    subject.failedReads.set('review-run', new Error('Review store temporarily unavailable'));
    await subject.daily.tick();
    assert.equal(subject.conversations.get('prediction-markets-review').messages.length, 0);
    assert.equal(subject.conversations.get('balance-review').messages.length, 1);
    subject.failedReads.delete('review-run');
    await subject.daily.tick();
    assert.equal(subject.conversations.get('prediction-markets-review').messages.length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/balance-review-run').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 2);
  } finally { subject.daily.stop(); }
});

test('deleting a conversation during capture hydration prevents its late publication', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  const read = subject.delayCapture();
  let collecting;
  try {
    await subject.prepare('prediction-markets-review', true);
    const completed = subject.completed();
    collecting = subject.daily.tick();
    await turn();
    subject.deleted.add('prediction-markets-review');
    read.resolve(completed);
    await collecting;
    await subject.daily.tick();
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 1);
    assert.equal(subject.generated.length, 0);
  } finally {
    read.resolve(subject.completed());
    await collecting;
    subject.daily.stop();
  }
});

test('background preparation cannot create conversation history', async () => {
  const subject = fixture();
  for (const kind of ['portfolio-review', 'prediction-markets-review', 'balance-review']) {
    assert.equal(await subject.prepare(kind), null);
  }
  assert.equal(subject.calls.length, 0);
  assert.equal(subject.conversations.size, 0);
});

for (const kind of ['portfolio-review', 'prediction-markets-review', 'balance-review']) {
  test(`${kind} accepts durably before worker acquisition completes`, async () => {
    const subject = fixture();
    const start = subject.delayStart();
    try {
      const receipt = await Promise.race([
        subject.daily.prepare(kind, true, { refresh: true, requestId: 'review-click' }),
        turn().then(() => assert.fail('review acceptance waited for the worker')),
      ]);
      assert.equal(receipt.reviewPhase, 'queued');
      assert.equal(receipt.reviewRunId, 'review-run');
      assert.ok(receipt.activeTurn);
      assert.equal(receipt.briefsIncluded, false);
      const record = subject.settings.get(`daily-run:${receipt.id}`);
      assert.equal(record.turnId, receipt.activeTurn.id);
      assert.equal(record.reviewRequestId, 'review-click');
      assert.equal(record.startPending, true);
      assert.equal(record.startRequest.runId, receipt.reviewRunId);
      assert.equal(subject.calls.filter(call => call.path === '/internal/workspace/readiness').length, 0);
      const replay = await subject.daily.prepare(kind, true, { refresh: true, requestId: 'review-click' });
      assert.equal(replay.activeTurn.id, receipt.activeTurn.id);
      assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
      start.resolve();
      await turn();
      assert.equal(subject.settings.get(`daily-run:${receipt.id}`).startPending, false);
      assert.equal(subject.settings.get(`daily-run:${receipt.id}`).reviewRequestId, 'review-click');
    } finally { start.resolve(); await turn(); subject.daily.stop(); }
  });
}

test('guarded dispatch starts before a blocked ownership HTTP read and supplies the accepted turn', async () => {
  const subject = fixture();
  subject.guardStarts();
  const ownership = deferred();
  let ownershipReads = 0;
  const daily = attachDailyWorkflow({
    workspace: { ...subject.workspace, call: async (operation, body) => {
      if (operation === 'source-binding') { ownershipReads += 1; await ownership.promise; }
      return subject.workspace.call(operation, body);
    } },
    request: subject.request,
    now: () => new Date('2026-09-19T15:00:00Z'), createRunId: () => 'review-run',
  });
  try {
    const receipt = await daily.prepare('balance-review', true, { requestId: 'fast-guarded-start' });
    await turn();
    const dispatches = subject.calls.filter(call => call.path === '/internal/reviews');
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].body.workspaceTurnId, receipt.activeTurn.id);
    assert.equal(dispatches[0].body.runId, receipt.reviewRunId);
    assert.equal(ownershipReads, 1, 'only the post-dispatch ownership read may block');
    assert.equal(subject.settings.get(`daily-run:${receipt.id}`).startPending, true);
    ownership.resolve();
    await turn();
    assert.equal(subject.settings.get(`daily-run:${receipt.id}`).startPending, false);
  } finally { ownership.resolve(); await turn(); daily.stop(); subject.daily.stop(); }
});

test('a rejected guarded dispatch cannot resurrect a stopped, deleted or replaced accepted turn', async () => {
  for (const action of ['stop', 'delete', 'replace']) {
    const subject = fixture();
    subject.guardStarts();
    const start = subject.delayStart();
    const kind = 'prediction-markets-review';
    try {
      const receipt = await subject.daily.prepare(kind, true, { requestId: `guarded-${action}` });
      await turn();
      if (action === 'delete') subject.deleted.add(kind);
      else subject.conversations.get(kind).activeTurn = null;
      const stopped = { ...subject.settings.get(`daily-run:${kind}`), error: true,
        completedAt: '2026-09-19T15:00:01Z', reviewState: 'cancelled', reviewPhase: 'terminal' };
      subject.settings.set(`daily-run:${kind}`, stopped);
      let replacement;
      if (action === 'replace') {
        subject.clearStartDelay();
        replacement = await subject.prepare(kind, true, { conversationId: kind, refresh: true, requestId: 'guarded-replacement' });
      }
      start.resolve();
      await turn();
      const dispatches = subject.calls.filter(call => call.path === '/internal/reviews');
      assert.equal(dispatches[0].body.workspaceTurnId, receipt.activeTurn.id);
      assert.equal(dispatches.length, action === 'replace' ? 2 : 1);
      assert.equal(subject.calls.filter(call => call.operation === 'frame' || call.operation === 'cancel-review').length, 0,
        'a guard rejection created no worker run to cancel or report to publish');
      assert.equal(subject.generated.length, 0);
      const current = subject.settings.get(`daily-run:${kind}`);
      if (replacement) {
        assert.equal(current.runId, replacement.reviewRunId);
        assert.equal(current.turnId, replacement.activeTurn.id);
        assert.equal(current.startPending, false);
        assert.equal(current.completedAt, undefined);
      } else assert.deepEqual(current, stopped);
      assert.equal(subject.daily.getReviewDiagnostics().find(run => run.runId === receipt.reviewRunId)
        .stages.find(stage => stage.stage === 'dispatch').statusCode, 409);
      if (action === 'stop') {
        await subject.daily.prepare(kind, true, { requestId: `guarded-${action}` });
        await turn();
        assert.equal(subject.calls.filter(call => call.operation === 'accept' || call.path === '/internal/reviews').length, 2,
          'replaying the stopped request returns its receipt without another acceptance or dispatch');
      }
    } finally { start.resolve(); await turn(); subject.daily.stop(); }
  }
});

test('a guard conflict for the current accepted owner fails once and replay preserves that receipt', async () => {
  const subject = fixture();
  subject.failStart(Object.assign(new Error('Review dispatch binding conflict'), { statusCode: 409 }));
  try {
    const receipt = await subject.prepare('balance-review', true, { requestId: 'guard-conflict' });
    assert.equal(subject.conversations.get(receipt.id).activeTurn, null);
    assert.equal(subject.settings.get(`daily-run:${receipt.id}`).reviewState, 'failed');
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'cancel-review').length, 1,
      'unknown creation outcome retains the existing cancellation cleanup');
    await subject.prepare('balance-review', true, { requestId: 'guard-conflict' });
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.generated.length, 0);
  } finally { subject.daily.stop(); }
});

test('late worker acceptance is cancelled after a queued review is stopped or deleted', async () => {
  // 'missing' is a code-less 404 for an id the Workspace never had.
  for (const action of ['stop', 'delete', 'missing']) {
    const subject = fixture();
    const start = subject.delayStart();
    try {
      const receipt = await subject.daily.prepare('prediction-markets-review', true, { requestId: 'queued-click' });
      await turn();
      if (action === 'delete') subject.deleted.add(receipt.id);
      else if (action === 'missing') subject.missing.add(receipt.id);
      else subject.conversations.get(receipt.id).activeTurn = null;
      start.resolve();
      await turn();
      assert.equal(subject.calls.filter(call => call.operation === 'cancel-review').length, 1);
      assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
      assert.equal(subject.generated.length, 0);
      assert.equal(subject.lines.length, 1);
      assert.match(subject.lines[0], new RegExp(`runId=review-run kind=prediction-markets-review state=${action === 'stop' ? 'stopped' : 'deleted'} `));
    } finally { start.resolve(); await turn(); subject.daily.stop(); }
  }
});

test('deleting a review while its start request is in flight dispatches once, cancels once and stops collecting', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  const start = subject.delayStart();
  try {
    const receipt = await subject.daily.prepare('portfolio-review', true, { refresh: true, requestId: 'delete-during-start' });
    await turn();
    subject.deleted.add(receipt.id);
    start.resolve();
    await turn();
    for (let tick = 0; tick < 5; tick += 1) {
      await subject.daily.tick();
      await turn();
    }
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.calls.filter(call => call.operation === 'cancel-review').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run/status').length, 0);
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
    assert.equal(subject.settings.get('monitor-health').error, null, 'a deleted owner is not a collection failure');
    assert.equal(subject.lines.length, 1);
    assert.match(subject.lines[0], /kind=portfolio-review state=deleted /);
  } finally { start.resolve(); await turn(); subject.daily.stop(); }
});

test('a worker startup failure completes the accepted turn without creating a second conversation', async () => {
  const subject = fixture();
  subject.failStart(Object.assign(new Error('Coordinator unavailable'), { statusCode: 503 }));
  try {
    const receipt = await subject.daily.prepare('balance-review', true, { requestId: 'failed-click' });
    assert.ok(receipt.activeTurn);
    await turn();
    const record = subject.settings.get(`daily-run:${receipt.id}`);
    assert.equal(record.reviewPhase, 'terminal');
    assert.equal(record.reviewState, 'failed');
    assert.equal(record.error, true);
    assert.equal(subject.conversations.get(receipt.id).activeTurn, null);
    assert.equal(subject.calls.filter(call => call.operation === 'cancel-review').length, 1);
    const replay = await subject.prepare('balance-review', true, { requestId: 'failed-click' });
    assert.equal(replay.id, receipt.id);
    assert.equal(replay.lastTurn.state, 'failed');
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
  } finally { subject.daily.stop(); }
});

test('an API restart resumes the exact durable queued review without creating history', async () => {
  const subject = fixture();
  subject.guardStarts();
  subject.scan.resolve({ events: [] });
  const id = 'prediction-markets-review';
  const activeTurn = { id: 'durable-turn', state: 'accepted' };
  subject.conversations.set(id, { id, kind: id, messages: [], activeTurn, lastTurn: activeTurn });
  subject.settings.set(`daily-run:${id}`, { runId: 'review-run', turnId: activeTurn.id, kind: id,
    reviewPostId: 'base', reviewPhase: 'queued', reviewState: 'queued', startPending: true,
    startRequest: { reviewKind: id, conversationId: id, requestId: 'durable-request', runId: 'review-run' } });
  const restored = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request });
  try {
    await restored.tick();
    await turn();
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.calls.find(call => call.path === '/internal/reviews').body.workspaceTurnId, activeTurn.id);
    assert.equal(subject.calls.filter(call => call.operation === 'daily' || call.operation === 'accept').length, 0);
    assert.equal(subject.settings.get(`daily-run:${id}`).startPending, false);
    subject.completed();
    await restored.tick();
    assert.equal(subject.conversations.get(id).messages.length, 1);
    assert.equal(subject.conversations.get(id).messages[0].text, 'Verified Silver report');
  } finally { restored.stop(); subject.daily.stop(); }
});

test('a restored queued dispatch rejected after Stop cannot restart or overwrite its durable owner', async () => {
  const subject = fixture();
  subject.guardStarts();
  subject.loseAcceptReceipt();
  subject.scan.resolve({ events: [] });
  const kind = 'prediction-markets-review';
  await assert.rejects(subject.daily.prepare(kind, true, { requestId: 'lost-stopped-start' }), /Accept receipt lost/);
  const start = subject.delayStart();
  const restored = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request });
  try {
    await restored.tick();
    await turn();
    const accepted = subject.settings.get(`daily-run:${kind}`);
    assert.equal(subject.calls.find(call => call.path === '/internal/reviews').body.workspaceTurnId, accepted.turnId);
    subject.conversations.get(kind).activeTurn = null;
    const stopped = { ...accepted, error: true, completedAt: '2026-09-19T15:00:01Z',
      reviewPhase: 'terminal', reviewState: 'cancelled' };
    subject.settings.set(`daily-run:${kind}`, stopped);
    start.resolve();
    await turn();
    assert.deepEqual(subject.settings.get(`daily-run:${kind}`), stopped);
    assert.equal(subject.calls.filter(call => call.operation === 'frame' || call.operation === 'cancel-review').length, 0);
    assert.equal(subject.generated.length, 0);
    assert.equal(restored.getReviewDiagnostics()[0].stages.find(stage => stage.stage === 'dispatch').statusCode, 409);
  } finally { start.resolve(); await turn(); restored.stop(); subject.daily.stop(); }
});

test('phase changes use compact status without downloading report content', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  try {
    const receipt = await subject.prepare('prediction-markets-review', true);
    subject.phase('summarizing');
    await subject.daily.tick();
    assert.equal(subject.settings.get(`daily-run:${receipt.id}`).reviewPhase, 'summarizing');
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews/review-run').length, 0);
    assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
  } finally { subject.daily.stop(); }
});

test('a replay of a lost acceptance receipt resumes its committed run without duplicating the chat', async () => {
  const subject = fixture();
  subject.guardStarts();
  const kind = 'prediction-markets-review';
  const options = { requestId: 'lost-click', refresh: true };
  try {
    subject.loseAcceptReceipt();
    await assert.rejects(subject.daily.prepare(kind, true, options), /Accept receipt lost/);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 0);
    const receipt = await subject.daily.prepare(kind, true, options);
    await turn();
    assert.equal(receipt.reviewRunId, 'review-run');
    assert.equal(subject.calls.filter(call => call.operation === 'accept').length, 1);
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
    assert.equal(subject.calls.find(call => call.path === '/internal/reviews').body.workspaceTurnId, receipt.activeTurn.id);
    assert.equal(subject.settings.get(`daily-run:${receipt.id}`).startPending, false);
  } finally { subject.daily.stop(); }
});

for (const oldRequest of ['startup', 'status']) {
  test(`a late old ${oldRequest} cannot remove or overwrite the replacement review`, async () => {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    const kind = 'prediction-markets-review';
    const read = oldRequest === 'startup' ? subject.delayStart() : subject.delayReview();
    let collecting;
    try {
      await subject.prepare(kind, true, { refresh: true, requestId: 'old-click' });
      if (oldRequest === 'status') { collecting = subject.daily.tick(); await turn(); }
      subject.conversations.get(kind).activeTurn = null;
      const previous = subject.settings.get(`daily-run:${kind}`);
      subject.settings.set(`daily-run:${kind}`, { ...previous, error: true, completedAt: '2026-09-19T15:00:01Z', reviewState: 'cancelled' });
      subject.clearStartDelay();
      const next = await subject.prepare(kind, true, { refresh: true, requestId: 'replacement-click', conversationId: kind });
      assert.equal(next.reviewRunId, 'balance-review-run');
      read.resolve(oldRequest === 'status' ? subject.completed('review-run') : undefined);
      if (collecting) await collecting;
      await turn();
      const record = subject.settings.get(`daily-run:${kind}`);
      assert.equal(record.runId, next.reviewRunId);
      assert.equal(record.turnId, next.activeTurn.id);
      assert.equal(record.startPending, false);
      assert.equal(record.completedAt, undefined);
      assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
      subject.completed(next.reviewRunId);
      await subject.daily.tick();
      assert.equal(subject.conversations.get(kind).messages.length, 1);
      assert.equal(subject.conversations.get(kind).messages[0].turn_id, next.activeTurn.id);
      assert.equal(subject.generated.length, 0);
    } finally {
      read.resolve();
      if (collecting) await collecting;
      subject.daily.stop();
    }
  });
}

test('a new requested capture can replace an interrupted legacy binding with no completion record', async () => {
  const subject = fixture();
  const kind = 'prediction-markets-review';
  subject.conversations.set(kind, { id: kind, kind, messages: [], activeTurn: null,
    lastTurn: { id: 'legacy-turn', state: 'interrupted' } });
  subject.settings.set(`daily-run:${kind}`, { runId: 'legacy-run', turnId: 'legacy-turn', kind,
    reviewPostId: 'base', fingerprint: 'legacy-capture' });
  try {
    const receipt = await subject.prepare(kind, true, { conversationId: kind, requestId: 'new-request' });
    assert.equal(receipt.reviewRunId, 'review-run');
    assert.notEqual(receipt.activeTurn.id, 'legacy-turn');
    assert.equal(subject.calls.filter(call => call.path === '/internal/reviews').length, 1);
  } finally { subject.daily.stop(); }
});

test('the attention scan yields at most two cycles to an acquiring Predictive review and never otherwise', async () => {
  for (const acquiring of [true, false]) {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    subject.settings.set('pm-attention-v1', { enabled: true });
    let current = Date.parse('2026-09-19T15:00:00Z');
    const scans = [];
    const original = subject.workspace.call;
    subject.workspace.call = async (operation, body = {}) => {
      // Stop each scan at its first write so no dashboard evidence is fetched.
      if (operation === 'setting' && body.key === 'pm-attention-status') {
        if (body.value?.state === 'running') scans.push(current);
        throw new Error('Scan stopped by the test');
      }
      return original(operation, body);
    };
    const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, now: () => new Date(current),
      createRunId: () => 'review-run', logRun: () => {} });
    try {
      if (acquiring) {
        await daily.prepare('prediction-markets-review', true, { requestId: 'acquiring-review' });
        await turn();
        assert.equal(subject.settings.get('daily-run:prediction-markets-review').reviewPhase, 'acquiring');
      }
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await daily.tick();
        await turn();
        current += 31_000;
      }
      assert.deepEqual(scans, acquiring ? [Date.parse('2026-09-19T15:01:02Z')] : [Date.parse('2026-09-19T15:00:00Z'),
        Date.parse('2026-09-19T15:00:31Z'), Date.parse('2026-09-19T15:01:02Z')]);
      assert.equal(subject.calls.filter(call => call.operation === 'setting' && call.body.key === 'pm-attention-v1'
        && !Object.hasOwn(call.body, 'value')).length, 2, 'the enabled switch is read once per minute, not twice per tick');
    } finally { daily.stop(); subject.daily.stop(); }
  }
});

test('a settled review logs one timestamped phase summary and keeps its phase clocks on the record', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  let current = Date.parse('2026-09-19T15:00:00Z');
  const lines = [];
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, now: () => new Date(current),
    createRunId: () => 'review-run', logRun: line => lines.push(line) });
  try {
    await daily.prepare('prediction-markets-review', true, { requestId: 'timed-review' });
    await turn();
    assert.equal(subject.settings.get('daily-run:prediction-markets-review').phaseTimes.dispatchedAt, '2026-09-19T15:00:00.000Z');
    current += 12_000;
    subject.completed();
    await daily.tick();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[analyst\] run settled runId=review-run kind=prediction-markets-review state=succeeded /);
    assert.match(lines[0], /accepted->dispatched=0ms dispatched->captureSettled=1000ms captureSettled->settled=11000ms total=12000ms$/);
    const record = subject.settings.get('daily-run:prediction-markets-review');
    assert.deepEqual(record.phaseTimes, { dispatchedAt: '2026-09-19T15:00:00.000Z', captureSettledAt: '2026-09-19T15:00:01Z',
      publishedAt: '2026-09-19T15:00:12.000Z' });
    assert.doesNotMatch(lines.join('\n'), /Verified Silver report|Prepare/);
    await daily.tick();
    assert.equal(lines.length, 1, 'a settled run is logged once');
  } finally { daily.stop(); subject.daily.stop(); }
});

test('a run that loses its owner to Stop or delete logs exactly one settlement line', async () => {
  const kind = 'prediction-markets-review';
  for (const action of ['stop', 'delete', 'stop-then-request']) {
    const subject = fixture();
    subject.scan.resolve({ events: [] });
    try {
      await subject.prepare(kind, true, { requestId: `owner-${action}` });
      if (action === 'delete') subject.deleted.add(kind);
      else {
        // What the Stop route commits: an interrupted turn and a terminal record.
        const conversation = subject.conversations.get(kind);
        conversation.lastTurn = { id: conversation.activeTurn.id, state: 'interrupted' };
        conversation.activeTurn = null;
        subject.settings.set(`daily-run:${kind}`, { ...subject.settings.get(`daily-run:${kind}`), completedAt: '2026-09-19T15:00:00Z',
          error: true, reviewPhase: 'terminal', reviewState: 'cancelled', startPending: false });
      }
      if (action === 'stop-then-request') {
        // A new request reaches the stale owner before the collector does.
        await subject.prepare(kind, true, { conversationId: kind, refresh: true, requestId: 'after-stop' });
      }
      await subject.daily.tick();
      await subject.daily.tick();
      assert.equal(subject.calls.filter(call => call.operation === 'frame').length, 0);
      assert.equal(subject.lines.length, 1, 'one line per run that left the collector');
      const state = { stop: 'stopped', delete: 'deleted', 'stop-then-request': 'turn-interrupted' }[action];
      assert.match(subject.lines[0], new RegExp(`runId=review-run kind=${kind} state=${state} accepted->dispatched=0ms dispatched->settled=0ms total=0ms$`));
    } finally { subject.daily.stop(); }
  }
});

test('a Balance Review settles its timeline only when its summary settles', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  let current = Date.parse('2026-09-19T15:00:00Z');
  const lines = [];
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request, now: () => new Date(current),
    createRunId: () => 'review-run', logRun: line => lines.push(line) });
  try {
    await daily.prepare('balance-review', true, { requestId: 'summarized-review' });
    await turn();
    subject.completed();
    current += 2_000;
    await daily.tick();
    assert.equal(subject.generated.length, 1);
    assert.equal(lines.length, 0);
    assert.equal(subject.settings.get('daily-run:balance-review').phaseTimes.summarizingAt, '2026-09-19T15:00:02.000Z');
    current += 30_000;
    subject.generated[0].onSettled('complete');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /kind=balance-review state=succeeded .*captureSettled->summarizing=1000ms summarizing->settled=30000ms total=32000ms$/);
  } finally { daily.stop(); subject.daily.stop(); }
});

test('collector diagnostics retain the fifty most recent runs', async () => {
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  let sequence = 0;
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request,
    now: () => new Date('2026-09-19T15:00:00Z'), createRunId: () => `run-${sequence++}`, logRun: () => {} });
  try {
    for (let index = 0; index < 52; index += 1) {
      await daily.prepare('prediction-markets-review', true, { refresh: true, requestId: `retained-${index}` });
      await turn();
      subject.completed(`run-${index}`);
      await daily.tick();
    }
    const retained = daily.getReviewDiagnostics();
    assert.equal(retained.length, 50);
    assert.deepEqual([retained[0].runId, retained.at(-1).runId], ['run-2', 'run-51']);
  } finally { daily.stop(); subject.daily.stop(); }
});

test('dated review chats are filed under the Pacific calendar day while session data keeps the exchange date', async () => {
  const { fingerprint } = require('./analystPolicy.cjs');
  const subject = fixture();
  subject.scan.resolve({ events: [] });
  // Mirrors workspace.py: one row per (kind, trading_date), reused when present.
  const filed = new Map([['prediction-markets-review|2026-10-06', 'filed-earlier-today']]);
  subject.conversations.set('filed-earlier-today', { id: 'filed-earlier-today', kind: 'prediction-markets-review', messages: [], activeTurn: null, lastTurn: null });
  const original = subject.workspace.call;
  subject.workspace.call = async (operation, body) => {
    if (operation !== 'daily') return original(operation, body);
    subject.calls.push({ operation, body });
    const key = `${body.kind}|${body.date}`;
    if (!filed.has(key)) {
      filed.set(key, `${body.kind}:${body.date}`);
      subject.conversations.set(filed.get(key), { id: filed.get(key), kind: body.kind, messages: [], activeTurn: null, lastTurn: null });
    }
    return { conversation: structuredClone(subject.conversations.get(filed.get(key))) };
  };
  let current;
  let sequence = 0;
  const daily = attachDailyWorkflow({ workspace: subject.workspace, request: subject.request,
    now: () => new Date(current), createRunId: () => `run-${sequence++}`, logRun: () => {} });
  const launch = async (instant, kind, options = {}) => {
    current = instant;
    const conversation = await daily.prepare(kind, true, { requestId: `${kind}@${instant}`, ...options });
    await turn();
    return { id: conversation.id, filedDate: subject.calls.filter(call => call.operation === 'daily').at(-1).body.date,
      record: subject.settings.get(`daily-run:${conversation.id}`) };
  };
  try {
    // Tue Oct 6 14:00 PDT: the calendars agree, so today's existing review is reused.
    let launched = await launch('2026-10-06T21:00:00Z', 'prediction-markets-review');
    assert.deepEqual([launched.filedDate, launched.id], ['2026-10-06', 'filed-earlier-today']);
    assert.equal(launched.record.fingerprint, fingerprint(['prediction-markets-review', '2026-10-06']));
    // Tue 21:30 PDT is Wed 00:30 ET: filed under Tuesday, still Wednesday's trading session.
    launched = await launch('2026-10-07T04:30:00Z', 'balance-review');
    assert.deepEqual([launched.filedDate, launched.id], ['2026-10-06', 'balance-review:2026-10-06']);
    assert.equal(launched.record.fingerprint, fingerprint(['balance-review', '2026-10-07']));
    assert.equal(launched.record.balanceReferenceDate, null);
    // Wed 00:30 PDT starts the next Pacific day.
    launched = await launch('2026-10-07T07:30:00Z', 'prediction-markets-review');
    assert.deepEqual([launched.filedDate, launched.id], ['2026-10-07', 'prediction-markets-review:2026-10-07']);
    // Fri Oct 9 21:30 PDT is Saturday 00:30 ET: Friday's chat, Saturday's (closed) exchange date.
    launched = await launch('2026-10-10T04:30:00Z', 'balance-review');
    assert.deepEqual([launched.filedDate, launched.id], ['2026-10-09', 'balance-review:2026-10-09']);
    assert.equal(launched.record.fingerprint, fingerprint(['balance-review', '2026-10-10']));
    assert.equal(launched.record.balanceReferenceDate, '2026-10-09');
    launched = await launch('2026-10-10T04:30:00Z', 'portfolio-review', { refresh: true });
    assert.deepEqual([launched.filedDate, launched.id], ['2026-10-09', 'portfolio-review:2026-10-09']);
    assert.equal(launched.record.fingerprint, fingerprint(['portfolio-review', '2026-10-10', 'closed']));
  } finally { daily.stop(); subject.daily.stop(); }
});
