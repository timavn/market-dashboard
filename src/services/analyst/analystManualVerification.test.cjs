const test = require('node:test');
const assert = require('node:assert/strict');
const { createManualVerificationWorkflow } = require('./analystManualVerification.cjs');

const binding = { conversationId: 'manual-chat', turnId: 'manual-turn', captureId: 'manual-capture' };
const acceptedTurn = () => ({
  turn: { id: binding.turnId, state: 'accepted' },
  conversation: { id: binding.conversationId, messages: [{ role: 'user', text: 'Check every holding.' }],
    activeTurn: { id: binding.turnId }, manualVerification: { ...binding } },
});
const readyStatus = state => ({ ...binding, turnState: 'accepted', state });
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
function fixture(options = {}) {
  const accepted = acceptedTurn();
  const active = new Map();
  const calls = [];
  const generated = [];
  const waits = [];
  const logs = [];
  const handlers = {
    'manual-start': async () => ({ started: true }),
    'manual-status': async () => readyStatus('ready'),
    get: async () => ({ conversation: accepted.conversation }),
    frame: async () => ({ ok: true }),
    ...options.handlers,
  };
  const workflow = createManualVerificationWorkflow({
    active,
    call: async (operation, body, transport) => {
      calls.push({ operation, body, transport });
      assert.ok(handlers[operation], `Unexpected operation: ${operation}`);
      return handlers[operation](body, transport);
    },
    generate: value => { generated.push(value); options.onGenerate?.(value, active); },
    canGenerate: () => options.canGenerate !== false,
    log: line => logs.push(line),
    captureTimeoutMs: options.captureTimeoutMs,
    pollMs: 25,
    wait: async ms => { waits.push(ms); await options.wait?.(ms); },
  });
  return { workflow, accepted, active, calls, generated, waits, logs };
}

for (const state of ['ready', 'partial']) {
  test(`one ${state} capture hands its exact owner to generation without changing the submitted prompt`, async () => {
    const nextOwner = { conversationId: binding.conversationId, generation: true };
    const f = fixture({ handlers: { 'manual-status': async () => readyStatus(state) },
      onGenerate: (_value, active) => active.set(binding.turnId, nextOwner) });
    const before = structuredClone(f.accepted);
    await f.workflow.start(f.accepted);
    assert.deepEqual(f.calls.map(call => call.operation), ['manual-start', 'manual-status', 'get']);
    assert.deepEqual(f.calls[0].body, binding);
    assert.deepEqual(f.calls[1].body, binding);
    assert.deepEqual(f.calls[1].transport, { timeoutMs: 5_000 });
    assert.deepEqual(f.calls[2].body, { conversationId: binding.conversationId, includeBriefs: false });
    assert.equal(f.generated.length, 1);
    assert.deepEqual(f.generated[0].manualVerification, binding);
    assert.deepEqual(f.accepted, before);
    assert.equal(f.active.get(binding.turnId), nextOwner, 'capture cleanup must retain the new generation owner');
  });
}

test('concurrent starts share the first accepted capture and generate only once', async () => {
  const status = deferred();
  const f = fixture({ handlers: { 'manual-status': () => status.promise } });
  const first = f.workflow.start(f.accepted);
  await new Promise(resolve => setImmediate(resolve));
  await f.workflow.start(f.accepted);
  assert.equal(f.calls.filter(call => call.operation === 'manual-start').length, 1);
  status.resolve(readyStatus('ready'));
  await first;
  assert.equal(f.generated.length, 1);
  assert.equal(f.active.size, 0);
});

test('transient metadata failures retry the same binding and a successful read resets the failure budget', async () => {
  const responses = [new Error('Temporary metadata failure'), new Error('Temporary metadata failure'),
    readyStatus('acquiring'), new Error('Temporary metadata failure'), readyStatus('partial')];
  const f = fixture({ handlers: { 'manual-status': async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } } });
  await f.workflow.start(f.accepted);
  assert.equal(f.calls.filter(call => call.operation === 'manual-status').length, 5);
  assert.equal(f.waits.length, 4);
  assert.ok(f.calls.filter(call => call.operation === 'manual-status').every(call => JSON.stringify(call.body) === JSON.stringify(binding)));
  assert.equal(f.generated.length, 1);
  assert.equal(f.calls.some(call => call.operation === 'frame'), false);
});

// Contract change: failed status reads are transient until the overall
// deadline (previously three consecutive failures ended a healthy capture).
test('persistent metadata failures settle one failed turn at the deadline without exposing provider errors', async t => {
  let observed = 1_000;
  t.mock.method(Date, 'now', () => observed);
  const f = fixture({ captureTimeoutMs: 1_000, wait: ms => { observed += ms; },
    handlers: { 'manual-status': async () => { throw Object.assign(new Error('Private provider address'), { code: 'ECONNREFUSED' }); } } });
  await f.workflow.start(f.accepted);
  assert.equal(f.calls.filter(call => call.operation === 'manual-status').length, 40);
  assert.deepEqual(f.calls.filter(call => call.operation === 'frame').map(call => call.body), [{
    turnId: binding.turnId, type: 'failed', error: 'Portfolio verification could not finish. Retry is available.',
  }]);
  assert.equal(f.generated.length, 0);
  assert.equal(f.active.size, 0);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /run settled runId=manual-capture kind=portfolio-cross-verification state=failed/);
  assert.doesNotMatch(f.logs.join(' '), /Private provider/);
});

test('transport failures and timeouts on a running capture are transient and the capture still completes', async () => {
  const responses = [readyStatus('acquiring'), Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }),
    Object.assign(new Error('Analyst sidecar HTTP 503'), { statusCode: 503 }), readyStatus('acquiring'), readyStatus('ready')];
  const f = fixture({ handlers: { 'manual-status': async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } } });
  await f.workflow.start(f.accepted);
  assert.equal(f.calls.filter(call => call.operation === 'manual-status').length, 6);
  assert.equal(f.generated.length, 1);
  assert.equal(f.calls.some(call => call.operation === 'frame'), false);
});

for (const statusCode of [404, 409, 410]) {
  test(`a definitive ${statusCode} status read stops polling immediately`, async () => {
    let reads = 0;
    const f = fixture({ handlers: { 'manual-status': async () => {
      reads += 1;
      if (reads === 1) return readyStatus('acquiring');
      throw Object.assign(new Error('Conversation not found'), { statusCode,
        ...(statusCode === 410 ? { code: 'ANALYST_CONVERSATION_DELETED' } : {}) });
    } } });
    await f.workflow.start(f.accepted);
    assert.equal(reads, 2);
    assert.equal(f.waits.length, 1);
    assert.equal(f.generated.length, 0);
    assert.equal(f.active.size, 0);
  });
}

test('a transient conversation read after readiness retries instead of failing the saved capture', async () => {
  let reads = 0;
  const f = fixture({ handlers: { get: async () => {
    if (++reads === 1) throw Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' });
    return { conversation: acceptedTurn().conversation };
  } } });
  await f.workflow.start(f.accepted);
  assert.equal(reads, 2);
  assert.equal(f.generated.length, 1);
  assert.equal(f.calls.some(call => call.operation === 'frame'), false);
});

test('the default Express deadline waits beyond the sidecar capture budget', async t => {
  let observed = 0;
  let failedAt = null;
  t.mock.method(Date, 'now', () => observed);
  const f = fixture({ wait: () => { observed += 10_000; }, handlers: { 'manual-status': async () => readyStatus('acquiring'),
    frame: async body => { if (body.type === 'failed') failedAt = observed; return { ok: true }; } } });
  await f.workflow.start(f.accepted);
  // The sidecar settles its own 1 s probe plus 180 s capture first.
  assert.equal(failedAt, 200_000);
});

test('an owner past daily recovery\'s 190 s idle threshold stays protected through its own settlement', async t => {
  let observed = 0;
  t.mock.method(Date, 'now', () => observed);
  const checks = [];
  let f;
  // The daily tick protects exactly these owners from 'recover' (analystDaily.cjs).
  const owned = () => [...f.active.entries()].some(([turnId, owner]) => turnId === binding.turnId && owner.deadlineAt > Date.now());
  f = fixture({ wait: () => { observed += 9_000; }, handlers: {
    'manual-status': async () => {
      // A 5 s status timeout can straddle the capture deadline.
      observed += 5_000;
      checks.push({ at: observed, owned: owned() });
      throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' });
    },
    frame: async body => { checks.push({ at: observed, owned: owned(), type: body.type }); return { ok: true }; } } });
  await f.workflow.start(f.accepted);
  const settled = checks.at(-1);
  assert.equal(settled.type, 'failed');
  assert.ok(settled.at > 200_000, 'the failure is written after the capture deadline');
  assert.ok(checks.filter(check => check.at > 190_000).length >= 2);
  assert.ok(checks.every(check => check.owned), 'recovery can never interrupt the owner before its own outcome');
  assert.equal(f.active.size, 0);
});

test('a handed-off capture logs one settlement line with its phases when generation settles', async () => {
  const f = fixture({ handlers: { 'manual-status': async () => ({ ...readyStatus('ready'), capturedAt: '2026-10-09T15:00:00Z' }) } });
  await f.workflow.start(f.accepted);
  assert.equal(f.logs.length, 0, 'the run is not settled until its generation settles');
  f.generated[0].onSettled('complete');
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[analyst\] run settled runId=manual-capture kind=portfolio-cross-verification state=complete /);
  assert.match(f.logs[0], /summarizing->settled=\d+ms/);
});

for (const key of ['conversationId', 'turnId', 'captureId']) {
  test(`a different ${key} cannot generate from another accepted capture`, async () => {
    const f = fixture({ handlers: { 'manual-status': async () => ({ ...readyStatus('ready'), [key]: 'another-owner' }) } });
    await f.workflow.start(f.accepted);
    assert.deepEqual(f.calls.filter(call => call.operation === 'frame').map(call => call.body), [{
      turnId: binding.turnId, type: 'failed', error: 'Portfolio verification ownership changed.',
    }]);
    assert.equal(f.generated.length, 0);
    assert.equal(f.calls.some(call => call.operation === 'get'), false);
    assert.equal(f.active.size, 0);
  });
}

test('Stop during an in-flight status read discards late readiness without reading or generating the chat', async () => {
  const status = deferred();
  const f = fixture({ handlers: { 'manual-status': () => status.promise } });
  const running = f.workflow.start(f.accepted);
  await new Promise(resolve => setImmediate(resolve));
  await f.active.get(binding.turnId).stop();
  status.resolve(readyStatus('ready'));
  await running;
  assert.deepEqual(f.calls.map(call => call.operation), ['manual-start', 'manual-status', 'frame']);
  assert.equal(f.calls.at(-1).body.type, 'interrupted');
  assert.equal(f.generated.length, 0);
  assert.equal(f.active.size, 0);
});

for (const state of ['complete', 'interrupted', 'cancelled']) {
  test(`a ${state} turn cannot hand a late capture to generation`, async () => {
    const f = fixture({ handlers: { 'manual-status': async () => ({ ...readyStatus('ready'), turnState: state }) } });
    await f.workflow.start(f.accepted);
    assert.deepEqual(f.calls.map(call => call.operation), ['manual-start', 'manual-status']);
    assert.equal(f.generated.length, 0);
    assert.equal(f.active.size, 0);
  });
}

for (const replacement of ['deleted', 'turn', 'capture']) {
  test(`a ${replacement} owner discovered after readiness cannot generate`, async () => {
    const f = fixture({ handlers: { get: async () => {
      if (replacement === 'deleted') throw Object.assign(new Error('Conversation not found.'), { statusCode: 404 });
      return { conversation: { ...acceptedTurn().conversation,
        ...(replacement === 'turn' ? { activeTurn: { id: 'new-turn' } } : { manualVerification: { ...binding, captureId: 'new-capture' } }) } };
    } } });
    await f.workflow.start(f.accepted);
    assert.equal(f.generated.length, 0);
    assert.equal(f.active.size, 0);
  });
}

test('an unavailable model settles the attempt while preserving its accepted capture', async () => {
  const f = fixture({ canGenerate: false });
  const before = structuredClone(f.accepted);
  await f.workflow.start(f.accepted);
  assert.equal(f.generated.length, 0);
  assert.equal(f.calls.some(call => call.operation === 'get'), false);
  assert.equal(f.calls.at(-1).body.type, 'failed');
  assert.deepEqual(f.accepted, before);
  assert.equal(f.active.size, 0);
});

test('the finite capture deadline ends an acquiring attempt without starting another capture', async t => {
  let observed = 1_000;
  t.mock.method(Date, 'now', () => observed);
  const f = fixture({ captureTimeoutMs: 40, wait: ms => { observed += ms; },
    handlers: { 'manual-status': async () => readyStatus('acquiring') } });
  await f.workflow.start(f.accepted);
  assert.equal(f.calls.filter(call => call.operation === 'manual-start').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'manual-status').length, 2);
  assert.equal(f.calls.at(-1).body.type, 'failed');
  assert.equal(f.generated.length, 0);
  assert.equal(f.active.size, 0);
});
