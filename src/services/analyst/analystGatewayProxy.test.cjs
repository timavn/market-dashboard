const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { WebSocket } = require('ws');

const {
  ANALYST_MCP_TOOL_PREFIX,
  APPROVED_TOOLS,
  JsonRpcPeer,
  attachAnalystGatewayProxy,
  collectCitations,
  inferLiveTurnState,
  isApprovedTool,
  isMissingRuntimeSessionError,
  liveRequirementsForPrompt,
  projectHistory,
  safePortfolioReviewError,
  sanitizeCitationText,
  validCitation,
} = require('./analystGatewayProxy.cjs');

const citation = {
  id: `cite_${'a'.repeat(32)}`,
  documentId: `doc_${'b'.repeat(32)}`,
  product: 'the-call',
  publicationDate: '2026-08-15',
  sourceUri: 'gmail://message/example',
  title: 'The Call',
  excerpt: 'Sourced text.',
};

function waitForWebSocketFrame(client, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', handleMessage);
      reject(new Error('Timed out waiting for WebSocket frame.'));
    }, timeoutMs);
    const handleMessage = (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch (_error) { return; }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      client.off('message', handleMessage);
      resolve(frame);
    };
    client.on('message', handleMessage);
  });
}

class FakeHermesSocket extends EventEmitter {
  constructor(requestHandler) {
    super();
    this.requestHandler = requestHandler;
    this.readyState = WebSocket.CONNECTING;
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  send(raw) {
    const request = JSON.parse(String(raw));
    Promise.resolve(this.requestHandler(request))
      .then((result) => this.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result })))
      .catch((error) => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { message: error.message },
      })));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }

  terminate() { this.close(); }
}

async function withGateway(t, requestHandler, options = {}) {
  const server = http.createServer();
  const calls = [];
  let upstreamSocket;
  const analyst = attachAnalystGatewayProxy(server, {
    contractVerified: true,
    token: 'test-token',
    sessionListFetchImpl: null,
    socketFactory: () => (upstreamSocket = new FakeHermesSocket((request) => {
      calls.push(request);
      if (request.method === 'session.create') {
        assert.equal(request.params.follow_profile_config, true);
        for (const field of ['model', 'provider', 'reasoning_effort', 'service_tier']) {
          assert.equal(Object.hasOwn(request.params, field), false, `Analyst creation must inherit profile ${field}`);
        }
      }
      return requestHandler(request);
    })),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/analyst`);
  await once(browser, 'open');
  t.after(async () => {
    browser.close();
    analyst.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return { analyst, browser, calls, server, emitEvent: event => upstreamSocket.emit('message', JSON.stringify({jsonrpc:'2.0', method:'event', params:event})) };
}

test('rejects hostile-origin upgrades before opening the privileged upstream', async (t) => {
  const { server, calls } = await withGateway(t, () => ({}));
  const hostile = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/analyst`, { origin: 'http://untrusted.example' });
  const status = await new Promise((resolve, reject) => {
    hostile.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); hostile.terminate(); });
    hostile.once('error', () => {});
    hostile.once('open', () => reject(new Error('Hostile client was accepted')));
  });
  assert.equal(status, 403);
  assert.equal(calls.length, 0);
});

test('revoking runtime verification closes Analyst sockets without stopping HTTP', async (t) => {
  const { createAnalystRuntimeGate, CONTRACT_MESSAGE } = require('./analystRuntimeGate.cjs');
  const transport = new EventEmitter();
  const gate = createAnalystRuntimeGate({ generation: 'test', transport });
  const publish = (revision, verified) => transport.emit('message', { type: CONTRACT_MESSAGE, generation: 'test', revision, verified, hermesPid: 2, sidecarPid: 3 });
  publish(1, true);
  const { server, browser } = await withGateway(t, () => ({}), { runtimeGate: gate });
  t.after(() => gate.dispose());
  const closed = once(browser, 'close');
  publish(2, false);
  const [code] = await closed;
  assert.equal(code, 1013);
  assert.equal(server.listening, true);
});

test('rejects oversized incoming WebSocket frames', async (t) => {
  const { browser, calls } = await withGateway(t, () => ({}));
  const closed = once(browser, 'close');
  browser.send('x'.repeat(256 * 1024 + 1));
  const [code] = await closed;
  assert.equal(code, 1009);
  assert.equal(calls.length, 0);
});

test('normalizes legacy coordinator exceptions before they can reach a browser', () => {
  const message = safePortfolioReviewError(
    'COORDINATOR_FINALIZATION_FAILED',
    "name 'sha256' is not defined",
  );
  assert.equal(
    message,
    'Portfolio Review could not finish because the review service encountered an internal error.',
  );
  assert.doesNotMatch(message, /sha256|not defined|nameerror/i);
});

test('removes Portfolio packet tools from the model allowlist', () => {
  assert.equal(APPROVED_TOOLS.size, 16);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}prepare_portfolio_review`), false);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}get_portfolio_review_packet`), false);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}get_portfolio_context`), true);
  assert.equal(isApprovedTool('mcp__other_server__get_portfolio_context'), false);
  assert.equal([...APPROVED_TOOLS].some((name) => /portfolio_review_packet/i.test(name)), false);
});

test('permits only the native read-only skill tools alongside the fixed market tools', () => {
  assert.equal(new Set([...APPROVED_TOOLS, 'skills_list', 'skill_view']).size, 18);
  assert.equal(isApprovedTool('skills_list'), true);
  assert.equal(isApprovedTool('skill_view'), true);
  for (const name of [
    'skill_manage', 'skills_manage', 'read_file', 'write_file', 'terminal',
    'delegate_task', 'tool_call', `${ANALYST_MCP_TOOL_PREFIX}skill_view`,
    'mcp__other_server__skill_view', 'plugin__skill_view',
  ]) assert.equal(isApprovedTool(name), false, name);
});

test('skill instructions never register research citations from persisted tool history', () => {
  for (const name of ['skills_list', 'skill_view']) {
    const history = { role: 'tool', name, content: JSON.stringify({ citations: [citation] }) };
    assert.equal(collectCitations(history).size, 0);
  }
  assert.equal(collectCitations({
    role: 'tool',
    name: `${ANALYST_MCP_TOOL_PREFIX}get_research_source`,
    content: JSON.stringify({ citations: [citation] }),
  }).has(citation.id), true);
});

test('read-only skill lifecycle events reach the chat without blocking the turn', async (t) => {
  const { browser, calls, emitEvent } = await withGateway(t, ({ method }) => {
    if (method === 'session.create') return { session_id: 'skill-runtime', session_key: 'skill-saved', messages: [], running: false };
    if (method === 'session.list' || method === 'session.history') return { sessions: [], messages: [] };
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(method);
  });
  browser.send(JSON.stringify({ action: 'new_prompt', requestId: 'skill-test', text: 'Explain the workflow.' }));
  while (!calls.some((call) => call.method === 'prompt.submit')) await new Promise((resolve) => setTimeout(resolve, 1));
  for (const name of ['skills_list', 'skill_view']) {
    const started = waitForWebSocketFrame(browser, (frame) => frame.type === 'tool' && frame.name === name && frame.status === 'running');
    emitEvent({ session_id: 'skill-runtime', type: 'tool.start', payload: { name, tool_id: name } });
    await started;
    const complete = waitForWebSocketFrame(browser, (frame) => frame.type === 'tool' && frame.name === name && frame.status === 'complete');
    emitEvent({ session_id: 'skill-runtime', type: 'tool.complete', payload: { name, tool_id: name, result: { success: true, citations: [citation] } } });
    await complete;
  }
  const completed = waitForWebSocketFrame(browser, (frame) => frame.type === 'message_complete');
  emitEvent({ session_id: 'skill-runtime', type: 'message.complete', payload: { text: 'The workflow is ready.' } });
  const frame = await completed;
  assert.equal(frame.text, 'The workflow is ready.');
  assert.equal(frame.citations.length, 0);
  assert.equal(calls.some((call) => call.method === 'session.interrupt'), false);
});

test('retires GM, companion retry, and review WebSocket launch before Hermes connects', async (t) => {
  let socketCreations = 0;
  const server = http.createServer();
  const analyst = attachAnalystGatewayProxy(server, {
    contractVerified: true,
    token: 'test-token',
    socketFactory: () => {
      socketCreations += 1;
      throw new Error('Hermes should not be contacted');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/analyst`);
  await once(browser, 'open');
  t.after(async () => {
    browser.close();
    analyst.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  for (const action of ['gm', 'retry_gm_review']) {
    const framePromise = waitForWebSocketFrame(browser, (frame) => frame.action === action);
    browser.send(JSON.stringify({ action, requestId: `${action}-1` }));
    const frame = await framePromise;
    assert.equal(frame.code, 'ANALYST_GM_RETIRED');
  }
  for (const action of ['start_review', 'retry_review']) {
    const framePromise = waitForWebSocketFrame(browser, (frame) => frame.action === action);
    browser.send(JSON.stringify({
      action,
      requestId: `${action}-1`,
      reviewKind: 'portfolio-review',
      sessionId: 'stored-1',
    }));
    const frame = await framePromise;
    assert.equal(frame.code, 'ANALYST_REVIEW_PROTOCOL_RETIRED');
  }
  assert.equal(socketCreations, 0);
});

test('ordinary saved chat open still uses Hermes transport', async (t) => {
  let legacyReviewCalls = 0;
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') {
      return { sessions: [{ id: 'stored-1', title: 'Research', source: 'market-dashboard-analyst' }] };
    }
    if (method === 'session.resume') {
      return {
        session_id: 'runtime-1', session_key: params.session_id,
        messages: [{ role: 'user', content: 'hello' }], running: false,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  }, {
    reviewFetchImpl: async () => {
      legacyReviewCalls += 1;
      throw new Error('Legacy review transport must not run while opening saved chat.');
    },
  });
  const opened = waitForWebSocketFrame(browser, (frame) => frame.type === 'session');
  browser.send(JSON.stringify({ action: 'open', requestId: 'open-1', sessionId: 'stored-1' }));
  const session = await opened;
  assert.equal(session.storedSessionId, 'stored-1');
  assert.equal(session.requestId, 'open-1');
  assert.ok(calls.some(({ method }) => method === 'session.resume'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(legacyReviewCalls, 0);
});

test('first blank-canvas prompt creates and submits one deterministically titled conversation', async (t) => {
  const persisted = [];
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.create') {
      persisted.push({
        id: 'stored-new-prompt',
        title: params.title,
        source: 'market-dashboard-analyst',
        created_at: '2026-09-02T12:00:00.000Z',
      });
      return {
        session_id: 'runtime-new-prompt',
        session_key: 'stored-new-prompt',
        messages: [],
        running: false,
      };
    }
    if (method === 'session.list') return { sessions: persisted };
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(`Unexpected method ${method}`);
  });

  const sessionFrame = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'session' && frame.requestId === 'new-prompt-1',
  );
  const userFrame = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'user_message' && frame.requestId === 'new-prompt-1',
  );
  browser.send(JSON.stringify({
    action: 'new_prompt',
    requestId: 'new-prompt-1',
    text: 'Explain duration risk in this portfolio',
  }));

  const session = await sessionFrame;
  const user = await userFrame;
  assert.equal(session.storedSessionId, 'stored-new-prompt');
  assert.equal(session.title, 'Explain duration risk in this portfolio');
  assert.equal(user.text, 'Explain duration risk in this portfolio');
  while (!calls.some(({ method }) => method === 'prompt.submit')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const create = calls.find(({ method }) => method === 'session.create');
  const submit = calls.find(({ method }) => method === 'prompt.submit');
  assert.equal(create.params.title, 'Explain duration risk in this portfolio');
  assert.equal(Object.hasOwn(create.params, 'model'), false);
  assert.equal(create.params.hidden, undefined);
  assert.match(submit.params.text, /explicitly call each of these tools in this turn: get_portfolio_context/);
  assert.equal(projectHistory([{role:'user', content:submit.params.text}])[0].content, 'Explain duration risk in this portfolio');
  assert.equal(calls.filter(({ method }) => method === 'session.create').length, 1);
});

test('pages compact ordinary conversation summaries through the Hermes session API', async (t) => {
  const requests = [];
  const { browser, calls } = await withGateway(t, ({ method }) => {
    if (method === 'session.list') throw new Error('The REST page should satisfy this listing.');
    throw new Error(`Unexpected method ${method}`);
  }, {
    sessionListFetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [
            {
              id: 'stored-page-2',
              title: 'Older research',
              source: 'market-dashboard-analyst',
              started_at: 1_787_900_000,
              message_count: 4,
            },
          ],
          total: 101,
          limit: 50,
          offset: 50,
        }),
      };
    },
  });

  const listed = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'session_list' && frame.requestId === 'page-2',
  );
  browser.send(JSON.stringify({
    action: 'list_sessions',
    requestId: 'page-2',
    limit: 50,
    offset: 50,
  }));
  const frame = await listed;

  assert.equal(frame.append, true);
  assert.equal(frame.offset, 50);
  assert.equal(frame.nextOffset, 100);
  assert.equal(frame.total, 101);
  assert.deepEqual(frame.sessions.map((session) => session.id), ['stored-page-2']);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/sessions');
  assert.equal(url.searchParams.get('source'), 'market-dashboard-analyst');
  assert.equal(url.searchParams.get('order'), 'created');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(requests[0].options.headers['X-Hermes-Session-Token'], 'test-token');
  assert.equal(calls.some(({ method }) => method === 'session.list'), false);
});

test('first review follow-up lazily creates, links, submits, and hides its Hermes session', async (t) => {
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const reviewRequests = [];
  const context = {
    schema: 'ReviewContextV2',
    runId: 'run-review-followup',
    conversationId,
    reviewKind: 'portfolio-review',
    outcome: 'ready',
    sections: [{ id: 'executive-snapshot', status: 'ready' }],
    rules: { historicalContextOnly: true, maySatisfyCurrentLiveRead: false },
  };
  let storedTitle = '';
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.create') {
      storedTitle = params.title;
      return {
        session_id: 'runtime-review-followup',
        session_key: 'stored-review-followup',
        messages: [],
        running: false,
      };
    }
    if (method === 'session.list') {
      return {
        sessions: [{
          id: 'stored-review-followup',
          title: storedTitle,
          source: 'market-dashboard-analyst',
          created_at: '2026-09-02T12:00:00.000Z',
        }],
      };
    }
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(`Unexpected method ${method}`);
  }, {
    reviewFetchImpl: async (url, options = {}) => {
      reviewRequests.push({ url, options });
      if (url.endsWith(`/internal/review-conversations/${conversationId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            conversation: { conversationId, hermesSessionId: null },
          }),
        };
      }
      if (url.endsWith(`/internal/review-conversations/${conversationId}/hermes-session`)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/internal/reviews/run-review-followup/context')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, context }) };
      }
      throw new Error(`Unexpected review URL ${url}`);
    },
  });

  const sessionFrame = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'session' && frame.requestId === 'review-prompt-1',
  );
  const userFrame = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'user_message' && frame.requestId === 'review-prompt-1',
  );
  browser.send(JSON.stringify({
    action: 'review_prompt',
    requestId: 'review-prompt-1',
    conversationId,
    reviewKind: 'portfolio-review',
    reviewRunId: 'run-review-followup',
    text: 'Explain the concentration finding.',
  }));

  const session = await sessionFrame;
  const user = await userFrame;
  assert.equal(session.conversationId, conversationId);
  assert.equal(session.reviewKind, 'portfolio-review');
  assert.equal(session.storedSessionId, 'stored-review-followup');
  assert.equal(user.text, 'Explain the concentration finding.');
  while (!calls.some(({ method }) => method === 'prompt.submit')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const create = calls.find(({ method }) => method === 'session.create');
  assert.equal(Object.hasOwn(create.params, 'model'), false);
  assert.equal(create.params.hidden, true);
  assert.equal(
    create.params.title,
    `[market-dashboard-analyst-review:portfolio-review:${conversationId}]`,
  );
  const link = reviewRequests.find(({ url }) => url.endsWith('/hermes-session'));
  assert.equal(link.options.method, 'PUT');
  assert.deepEqual(JSON.parse(link.options.body), { sessionId: 'stored-review-followup' });
  const submitted = calls.find(({ method }) => method === 'prompt.submit').params.text;
  assert.match(submitted, /^\[market-dashboard-live-verification\]/);
  assert.match(submitted, /\[market-dashboard-account-comparison-v1\]/);
  assert.match(submitted, /\[market-dashboard-review-context-v2\]/);
  assert.match(submitted, /24-hour HH:mm observation times in Pacific time \(PDT or PST\)/);
  assert.equal(submitted.endsWith('Explain the concentration finding.'), true);

  const listFrame = waitForWebSocketFrame(browser, (frame) => frame.type === 'session_list');
  browser.send(JSON.stringify({ action: 'list_sessions' }));
  assert.deepEqual((await listFrame).sessions, []);
});

test('repairs a linked Hermes session that disappeared before its first prompt persisted', async (t) => {
  const conversationId = '55555555-5555-4555-8555-555555555555';
  const reviewRequests = [];
  const { browser } = await withGateway(t, ({ method }) => {
    if (method === 'session.resume') throw new Error('Runtime session old-empty was not found');
    if (method === 'session.create') {
      return {
        session_id: 'runtime-repaired',
        session_key: 'stored-repaired',
        messages: [],
        running: false,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  }, {
    reviewFetchImpl: async (url, options = {}) => {
      reviewRequests.push({ url, options });
      if (url.endsWith(`/internal/review-conversations/${conversationId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            conversation: { conversationId, hermesSessionId: 'old-empty' },
          }),
        };
      }
      if (url.endsWith(`/internal/review-conversations/${conversationId}/hermes-session`)) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error(`Unexpected review URL ${url}`);
    },
  });

  const framePromise = waitForWebSocketFrame(
    browser,
    (frame) => ['session', 'error'].includes(frame.type) && frame.requestId === 'repair-1',
  );
  browser.send(JSON.stringify({
    action: 'resume_review',
    requestId: 'repair-1',
    conversationId,
    reviewKind: 'balance-review',
  }));
  const frame = await framePromise;
  assert.equal(frame.type, 'session', frame.error);
  assert.equal(frame.storedSessionId, 'stored-repaired');
  const link = reviewRequests.find(({ url }) => url.endsWith('/hermes-session'));
  assert.deepEqual(JSON.parse(link.options.body), {
    sessionId: 'stored-repaired',
    previousSessionId: 'old-empty',
  });
});

test('creates and reuses one canonical Hermes follow-up session per fixed review', async (t) => {
  let createCalls = 0;
  let persisted = [];
  const { browser } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') return { sessions: persisted };
    if (method === 'session.create') {
      createCalls += 1;
      persisted = [{
        id: 'stored-canonical-portfolio',
        title: params.title,
        source: 'market-dashboard-analyst',
        created_at: '2026-09-01T10:00:00.000Z',
      }];
      return {
        session_id: `runtime-created-${createCalls}`,
        session_key: 'stored-canonical-portfolio',
        messages: [],
        running: false,
      };
    }
    if (method === 'session.history') {
      return { messages: [], running: false };
    }
    if (method === 'session.resume') {
      assert.equal(params.session_id, 'stored-canonical-portfolio');
      return {
        session_id: 'runtime-resumed-canonical',
        session_key: 'stored-canonical-portfolio',
        messages: [],
        running: false,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const firstFrame = waitForWebSocketFrame(
    browser,
    (frame) => ['session', 'error'].includes(frame.type) && frame.requestId === 'review-open-1',
  );
  browser.send(JSON.stringify({
    action: 'open_review_chat',
    reviewKind: 'portfolio-review',
    requestId: 'review-open-1',
  }));
  const first = await firstFrame;
  assert.equal(first.type, 'session', first.error);
  assert.equal(first.conversationId, 'review:portfolio-review');
  assert.equal(first.storedSessionId, 'stored-canonical-portfolio');
  assert.equal(first.canonicalReview, true);

  const secondFrame = waitForWebSocketFrame(
    browser,
    (frame) => ['session', 'error'].includes(frame.type) && frame.requestId === 'review-open-2',
  );
  browser.send(JSON.stringify({
    action: 'open_review_chat',
    reviewKind: 'portfolio-review',
    requestId: 'review-open-2',
  }));
  const second = await secondFrame;
  assert.equal(second.type, 'session', second.error);
  assert.equal(second.conversationId, 'review:portfolio-review');
  assert.equal(second.storedSessionId, 'stored-canonical-portfolio');
  assert.equal(createCalls, 1);
});

test('keeps legacy review sessions read-only at the gateway boundary', async (t) => {
  const { browser } = await withGateway(t, ({ method }) => {
    if (method === 'session.list') {
      return {
        sessions: [{
          id: 'legacy-review-1',
          title: 'Portfolio Review',
          source: 'market-dashboard-analyst',
        }],
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  for (const action of ['rename_session']) {
    const requestId = `${action}-legacy`;
    const response = waitForWebSocketFrame(
      browser,
      (frame) => frame.type === 'error' && frame.requestId === requestId,
    );
    browser.send(JSON.stringify({
      action,
      requestId,
      sessionId: 'legacy-review-1',
      title: 'Renamed legacy review',
    }));
    const frame = await response;
    assert.equal(frame.code, 'ANALYST_LEGACY_REVIEW_READ_ONLY');
  }
});

test('the Analyst gateway exposes no session delete action', async (t) => {
  const { browser, calls } = await withGateway(t, ({ method }) => {
    if (method === 'session.list') {
      return { sessions: [{ id: 'stored-1', title: 'Ordinary chat', source: 'market-dashboard-analyst' }] };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const callsBefore = calls.length;
  const response = waitForWebSocketFrame(
    browser,
    (frame) => frame.type === 'error' && frame.requestId === 'delete-ordinary',
  );
  browser.send(JSON.stringify({ action: 'delete_session', requestId: 'delete-ordinary', sessionId: 'stored-1' }));
  const frame = await response;
  assert.equal(frame.action, 'delete_session');
  assert.equal(frame.error, 'Unsupported Analyst action.');
  assert.ok(calls.slice(callsBefore).every(({ method }) => !['session.close', 'session.delete'].includes(method)));
});

test('attaches one bounded hidden ReviewContextV2 to a follow-up and keeps history user-visible', async (t) => {
  const context = {
    schema: 'ReviewContextV2',
    runId: 'run-context',
    sessionId: 'stored-1',
    reviewKind: 'portfolio-review',
    outcome: 'ready',
    sections: [{ id: 'executive-snapshot', status: 'ready', metrics: { netLiquidation: 100000 } }],
    rules: { historicalContextOnly: true, maySatisfyCurrentLiveRead: false },
  };
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') {
      return { sessions: [{ id: 'stored-1', title: 'Portfolio Review', source: 'market-dashboard-analyst' }] };
    }
    if (method === 'session.resume') {
      return { session_id: 'runtime-1', session_key: params.session_id, messages: [], running: false };
    }
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(`Unexpected method ${method}`);
  }, {
    reviewFetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        assert.match(url, /\/internal\/reviews\/run-context\/context$/);
        return { ok: true, context };
      },
    }),
  });
  const opened = waitForWebSocketFrame(browser, (frame) => frame.type === 'session');
  browser.send(JSON.stringify({ action: 'open', requestId: 'open-1', sessionId: 'stored-1' }));
  await opened;

  const visibleText = 'Explain the earlier concentration finding.';
  const userFrame = waitForWebSocketFrame(browser, (frame) => frame.type === 'user_message');
  browser.send(JSON.stringify({
    action: 'prompt',
    sessionId: 'stored-1',
    reviewRunId: 'run-context',
    text: visibleText,
  }));
  assert.equal((await userFrame).text, visibleText);
  while (!calls.some(({ method }) => method === 'prompt.submit')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const submitted = calls.find(({ method }) => method === 'prompt.submit').params.text;
  assert.match(submitted, /^\[market-dashboard-live-verification\]/);
  assert.match(submitted, /\[market-dashboard-account-comparison-v1\]/);
  assert.match(submitted, /\[market-dashboard-review-context-v2\]/);
  assert.match(submitted, /"schema":"ReviewContextV2"/);
  assert.equal(submitted.endsWith(visibleText), true);
  const projected = projectHistory([{ role: 'user', content: submitted }]);
  assert.equal(projected[0].content, visibleText);
  assert.doesNotMatch(projected[0].content, /ReviewContextV2|netLiquidation/);
  assert.equal(inferLiveTurnState([{ role: 'user', content: submitted }]).requirements.size, 0);
});

test('workspace review follow-ups attach context only after exact persisted conversation, kind and Hermes ownership match', async t => {
  for (const mismatch of [null, 'id', 'kind', 'hermes_id']) {
    await t.test(mismatch || 'verified workspace binding', async t => {
      const workspaceId = '66666666-6666-4666-8666-666666666666';
      const context = { schema: 'ReviewContextV2', runId: 'workspace-run', conversationId: workspaceId,
        sessionId: workspaceId, reviewKind: 'portfolio-review', outcome: 'ready',
        sections: [{ id: 'position-contradictions', status: 'ready' }], citations: [citation],
        rules: { historicalContextOnly: true, maySatisfyCurrentLiveRead: false } };
      const saved = { id: workspaceId, kind: 'portfolio-review', hermes_id: 'workspace-hermes' };
      if (mismatch) saved[mismatch] = 'another-owner';
      const reads = [];
      const { browser, calls, emitEvent } = await withGateway(t, ({ method, params }) => {
        if (method === 'session.list') return { sessions: [{ id: 'workspace-hermes', title: `[workspace:${workspaceId}] Portfolio Review`, source: 'market-dashboard-analyst' }] };
        if (method === 'session.resume') return { session_id: 'workspace-runtime', session_key: params.session_id, messages: [], running: false };
        if (method === 'prompt.submit') return { accepted: true };
        throw new Error(`Unexpected Hermes method ${method}`);
      }, { reviewFetchImpl: async (url, options = {}) => {
        reads.push({ url, options });
        if (url.endsWith('/internal/reviews/workspace-run/context')) return { ok: true, status: 200, json: async () => ({ context }) };
        if (url.endsWith('/internal/workspace/get')) {
          assert.equal(options.method, 'POST');
          assert.deepEqual(JSON.parse(options.body), { conversationId: workspaceId, includeBriefs: false });
          return { ok: true, status: 200, json: async () => ({ conversation: saved }) };
        }
        throw new Error(`Unexpected sidecar read ${url}`);
      } });
      const opened = waitForWebSocketFrame(browser, frame => frame.type === 'session');
      browser.send(JSON.stringify({ action: 'open', sessionId: 'workspace-hermes', requestId: 'workspace-open' }));
      await opened;
      browser.send(JSON.stringify({ action: 'prompt', sessionId: 'workspace-hermes', text: 'Explain the captured finding', reviewRunId: 'workspace-run' }));
      for (let count = 0; !calls.some(({ method }) => method === 'prompt.submit') && count < 100; count += 1) await new Promise(resolve => setTimeout(resolve, 1));
      const submitted = calls.find(({ method }) => method === 'prompt.submit')?.params.text;
      assert.ok(submitted);
      assert.equal(submitted.includes('[market-dashboard-review-context-v2]'), !mismatch);
      assert.equal(reads.length, 2);
      assert.equal(submitted.endsWith('Explain the captured finding'), true);
      const complete = waitForWebSocketFrame(browser, frame => frame.type === 'message_complete');
      emitEvent({ type: 'message.complete', session_id: 'workspace-runtime', payload: { text: `Captured finding ${citation.id}` } });
      const result = await complete;
      assert.equal(result.citations?.length || 0, mismatch ? 0 : 1);
    });
  }
});

test('existing chats receive the account comparison contract on a retry without changing visible or prior messages', async (t) => {
  const priorMessages = [
    { role: 'user', content: 'Compare my current account balance with yesterday.' },
    { role: 'assistant', content: 'Earlier saved answer.' },
  ];
  const originalMessages = structuredClone(priorMessages);
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') return { sessions: [{ id: 'account-history', title: 'Account comparison', source: 'market-dashboard-analyst' }] };
    if (method === 'session.resume') return { session_id: 'account-runtime', session_key: params.session_id, messages: priorMessages, running: false };
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(`Unexpected method ${method}`);
  });
  const opened = waitForWebSocketFrame(browser, frame => frame.type === 'session');
  browser.send(JSON.stringify({ action: 'open', sessionId: 'account-history', requestId: 'open-account' }));
  await opened;
  const visibleText = 'Run again';
  const sent = waitForWebSocketFrame(browser, frame => frame.type === 'user_message');
  browser.send(JSON.stringify({ action: 'prompt', sessionId: 'account-history', text: visibleText }));
  assert.equal((await sent).text, visibleText);
  while (!calls.some(({ method }) => method === 'prompt.submit')) await new Promise(resolve => setTimeout(resolve, 1));
  const submitted = calls.find(({ method }) => method === 'prompt.submit').params.text;
  assert.equal(submitted.split('[market-dashboard-account-comparison-v1]').length - 1, 1);
  assert.match(submitted, /apply only when this answer compares account, balance, margin, or exposure snapshots/);
  assert.match(submitted, /Metric \| \[dated earlier snapshot\] \| \[dated later snapshot\] \| Dollar change \| What this means for the account/);
  assert.match(submitted, /one or two concise plain-English sentences/);
  assert.match(submitted, /Historical reference evidence never replaces a failed current read/);
  assert.match(submitted, /collateral, not loans/);
  assert.match(submitted, /NLV change is not automatically investment P&L/);
  assert.match(submitted, /do not prove executed trades/);
  assert.match(submitted, /does not establish beta neutrality/);
  assert.match(submitted, /not daily cost or interest savings/);
  assert.match(submitted, /Do not invent causality or append trade recommendations/);
  const projected = projectHistory([...priorMessages, { role: 'user', content: submitted }]);
  assert.equal(projected.at(-1).content, visibleText);
  assert.deepEqual(priorMessages, originalMessages);
  assert.deepEqual(projected.slice(0, 2).map(message => message.content), originalMessages.map(message => message.content));
  assert.deepEqual([...inferLiveTurnState([...priorMessages, { role: 'user', content: submitted }]).requirements], ['get_balance_context', 'get_portfolio_context']);
  assert.ok(calls.every(({ method }) => !['session.delete', 'session.clear', 'session.truncate'].includes(method)));
});

test('latest resume request selects only the latest target', async (t) => {
  const resolvers = new Map();
  const { browser } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') {
      return { sessions: [
        { id: 'stored-a', title: 'A', source: 'market-dashboard-analyst' },
        { id: 'stored-b', title: 'B', source: 'market-dashboard-analyst' },
      ] };
    }
    if (method === 'session.resume') {
      return new Promise((resolve) => resolvers.set(params.session_id, resolve));
    }
    throw new Error(`Unexpected method ${method}`);
  });

  browser.send(JSON.stringify({ action: 'resume', requestId: 'resume-a', sessionId: 'stored-a' }));
  browser.send(JSON.stringify({ action: 'resume', requestId: 'resume-b', sessionId: 'stored-b' }));
  while (!resolvers.has('stored-a') || !resolvers.has('stored-b')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const selectedPromise = waitForWebSocketFrame(
    browser, (frame) => frame.type === 'session' && frame.requestId === 'resume-b',
  );
  resolvers.get('stored-a')({ session_id: 'runtime-a', session_key: 'stored-a', messages: [] });
  resolvers.get('stored-b')({ session_id: 'runtime-b', session_key: 'stored-b', messages: [] });
  const selected = await selectedPromise;
  assert.equal(selected.storedSessionId, 'stored-b');
});

test('renaming persists through the Hermes session API', async (t) => {
  const { browser, calls } = await withGateway(t, ({ method, params }) => {
    if (method === 'session.list') {
      return { sessions: [{ id: 'stored-1', title: 'Misc', source: 'market-dashboard-analyst' }] };
    }
    if (method === 'session.resume') {
      return { session_id: 'runtime-1', session_key: params.session_id, messages: [] };
    }
    if (method === 'session.title') return { title: params.title };
    throw new Error(`Unexpected method ${method}`);
  });
  const opened = waitForWebSocketFrame(browser, (frame) => frame.type === 'session');
  browser.send(JSON.stringify({ action: 'open', requestId: 'open-1', sessionId: 'stored-1' }));
  await opened;
  const renamed = waitForWebSocketFrame(browser, (frame) => frame.type === 'session_renamed');
  browser.send(JSON.stringify({ action: 'rename_session', sessionId: 'stored-1', title: 'Balance Review' }));
  assert.equal((await renamed).title, 'Balance Review');
  const titleCall = calls.find(({ method }) => method === 'session.title');
  assert.ok(titleCall);
  assert.match(
    titleCall.params.title,
    /^\[market-dashboard-analyst:balance-review:[0-9a-f-]{36}\]$/,
  );
  assert.notEqual(titleCall.params.title, 'Balance Review');
});

test('classifies live portfolio and prediction requirements without weakening retry gates', () => {
  assert.deepEqual(
    liveRequirementsForPrompt('Check my current prediction-market portfolio exposure'),
    new Set(['get_prediction_market_snapshot', 'get_portfolio_context']),
  );
  const state = inferLiveTurnState([
    { role: 'user', content: 'Check my current portfolio exposure' },
    { role: 'user', content: 'Retry it' },
  ]);
  assert.equal(state.requirements.has('get_portfolio_context'), true);
});

for (const completeRoster of [false, true]) test(`manual capture ${completeRoster ? 'reads every summary page without reacquisition' : 'rejects missing summary evidence'}`, async t => {
  const binding = { operation: 'portfolio-cross-verification', captureId: 'manual-capture',
    conversationId: 'manual-chat', turnId: 'manual-turn', positionCount: 2, summaryPageCount: 2, hermesSessionId: null };
  const { browser, calls, emitEvent } = await withGateway(t, ({ method }) => {
    if (method === 'session.create') return { session_id: 'manual-runtime', session_key: 'manual-saved', messages: [], running: false };
    if (method === 'session.list') return { sessions: [] };
    if (method === 'session.history') return { messages: [] };
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(method);
  }, { reviewFetchImpl: async (url, options) => {
    assert.match(url, /\/internal\/workspace\/manual-generation$/);
    assert.deepEqual(JSON.parse(options.body), { captureId: binding.captureId, conversationId: binding.conversationId, turnId: binding.turnId });
    return { ok: true, json: async () => ({ context: binding, citations: [citation] }) };
  } });
  const frames = [];
  browser.on('message', raw => frames.push(JSON.parse(raw)));
  browser.send(JSON.stringify({ action: 'manual_verification_prompt', requestId: binding.turnId,
    ...binding, text: 'Manually cross-verify my complete current portfolio.' }));
  while (!calls.some(call => call.method === 'prompt.submit')) await new Promise(resolve => setTimeout(resolve, 1));
  const submitted = calls.find(call => call.method === 'prompt.submit').params.text;
  assert.match(submitted, /get_portfolio_verification_page/);
  assert.doesNotMatch(submitted, /explicitly call each of these tools/);
  assert.match(projectHistory([{ role: 'user', content: submitted }])[0].content, /^Manually cross-verify/);
  const event = (type, payload) => emitEvent({ session_id: 'manual-runtime', type, payload });
  const page = { captureId: binding.captureId, representation: 'portfolio-verification-page-v1',
    scope: 'summary', complete: true, totalRowCount: 2, offset: 0, rowCount: 1, pageIndex: 0, pageCount: 2, nextCursor: 'next' };
  event('message.delta', { text: 'Captured answer' });
  event('tool.complete', { name: `${ANALYST_MCP_TOOL_PREFIX}get_portfolio_verification_page`, result: { ...page, captureId: 'unrelated' } });
  event('tool.complete', { name: `${ANALYST_MCP_TOOL_PREFIX}get_portfolio_verification_page`, result: page });
  if (completeRoster) event('tool.complete', { name: `${ANALYST_MCP_TOOL_PREFIX}get_portfolio_verification_page`,
    result: { ...page, offset: 1, pageIndex: 1, nextCursor: null } });
  const final = waitForWebSocketFrame(browser, frame => ['message_complete', 'error'].includes(frame.type));
  event('message.complete', { text: `Captured answer ${citation.id}` });
  const result = await final;
  if (completeRoster) {
    assert.equal(result.type, 'message_complete');
    assert.equal(result.citations[0].id, citation.id);
  } else {
    assert.equal(result.code, 'ANALYST_REVIEW_EVIDENCE_INCOMPLETE');
    assert.match(result.error, /complete captured holding roster/);
    assert.ok(!frames.some(frame => ['message_delta', 'message_complete'].includes(frame.type)));
  }
});

test('manual generation rejects a capture bound to a different accepted turn before session creation', async t => {
  const { browser, calls } = await withGateway(t, ({ method }) => {
    if (method === 'session.list') return { sessions: [] };
    throw new Error(method);
  }, { reviewFetchImpl: async () => ({ ok: true, json: async () => ({ context: {
    operation: 'portfolio-cross-verification', captureId: 'capture', conversationId: 'chat', turnId: 'other', positionCount: 1,
  } }) }) });
  const failure = waitForWebSocketFrame(browser, frame => frame.type === 'error');
  browser.send(JSON.stringify({ action: 'manual_verification_prompt', requestId: 'turn',
    captureId: 'capture', conversationId: 'chat', turnId: 'turn', text: 'Verify my portfolio.' }));
  assert.match((await failure).error, /evidence is unavailable/);
  assert.ok(!calls.some(call => ['session.create', 'prompt.submit'].includes(call.method)));
});

test('accepts only structurally valid tool-issued citations', () => {
  assert.equal(validCitation(citation), true);
  assert.equal(validCitation({ ...citation, id: 'cite_invented' }), false);
  const collected = collectCitations({ citations: [citation, { ...citation }] });
  assert.equal(collected.size, 1);
  assert.equal(collected.get(citation.id).id, citation.id);
});

test('collects exact validated citation identities from the compact manual verification table', () => {
  const columns = ['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri'];
  const row = columns.map(column => citation[column] ?? null);
  const content = JSON.stringify({ researchVerification: { citationTable: { columns, rows: [row], rowCount: 1 } } });
  const tool = { role: 'tool', name: `${ANALYST_MCP_TOOL_PREFIX}get_portfolio_context`, content };
  const citations = collectCitations(tool);
  assert.equal(citations.size, 1);
  assert.deepEqual(citations.get(citation.id), Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  assert.equal(collectCitations({ citationTable: { columns, rows: [row] } }).size, 0);
  assert.equal(collectCitations({ ...tool, name: 'skill_view' }).size, 0);
  const history = projectHistory([tool, { role: 'assistant', content: `Captured finding ${citation.id}` }]);
  assert.equal(history[1].content, 'Captured finding [1]');
  assert.equal(history[1].citations[0].documentId, citation.documentId);
});

test('rejects malformed compact citation tables without registering invented or polluted metadata', () => {
  const columns = ['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri'];
  const row = columns.map(column => citation[column] ?? null);
  const collect = table => collectCitations({ researchVerification: { citationTable: table } });
  for (const table of [
    { columns: [...columns, 'id'], rows: [[...row, citation.id]] },
    { columns: [...columns, '__proto__'], rows: [[...row, { polluted: true }]] },
    { columns: columns.slice(1), rows: [row.slice(1)] },
    { columns, rows: [row], rowCount: 2 },
    { columns, rows: [[...row, 'extra']] },
    { columns, rows: [row.slice(0, -1)] },
    { columns, rows: [[`cite_${'f'.repeat(32)}`, ...row.slice(1, -1), { uri: citation.sourceUri }]] },
    { columns, rows: [['cite_invented', ...row.slice(1)]] },
    { columns, rows: [[row[0], 'doc_invented', ...row.slice(2)]] },
    { columns, rows: [[...row.slice(0, 3), 20260930, ...row.slice(4)]] },
  ]) assert.equal(collect(table).size, 0);
  assert.equal({}.polluted, undefined);
  assert.equal(collect({ columns, rows: [row, [...row.slice(0, -1), null]], rowCount: 2 }).size, 1);
  assert.deepEqual(collectCitations({ citations: [citation] }).get(citation.id), citation);
});

test('retains every valid citation in one full-book table like the original citation array', () => {
  const columns = ['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri'];
  const rows = Array.from({ length: 275 }, (_, index) => [
    `cite_${index.toString(16).padStart(32, '0')}`, citation.documentId, citation.product,
    citation.publicationDate, null, citation.sourceUri,
  ]);
  const collected = collectCitations({ researchVerification: { citationTable: { columns, rows, rowCount: 275 } } });
  assert.equal(collected.size, 275);
  assert.equal(collected.has(rows[274][0]), true);
});

test('removes invented citation tokens and projects validated history chips', () => {
  const invented = `cite_${'f'.repeat(32)}`;
  assert.equal(sanitizeCitationText(`Claim ${invented}`, new Map()).text, 'Claim');
  const history = projectHistory([
    { role: 'user', content: 'Question' },
    {
      role: 'tool',
      name: `${ANALYST_MCP_TOOL_PREFIX}get_research_source`,
      content: JSON.stringify({ citations: [citation] }),
    },
    { role: 'assistant', content: `Answer ${citation.id}` },
  ]);
  assert.equal(history[2].content, 'Answer [1]');
  assert.equal(history[2].citations[0].id, citation.id);
});

test('recognizes only definitive missing runtime errors', () => {
  assert.equal(isMissingRuntimeSessionError(new Error('runtime session abc was not found')), true);
  assert.equal(isMissingRuntimeSessionError(new Error('session temporarily unavailable')), false);
});

test('JSON-RPC peer resolves successful calls and surfaces errors', async () => {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.send = (raw) => {
    const request = JSON.parse(raw);
    queueMicrotask(() => socket.emit('message', JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      ...(request.method === 'fail'
        ? { error: { message: 'failed' } }
        : { result: { value: request.params.value } }),
    })));
  };
  const peer = new JsonRpcPeer({ url: 'ws://unused' });
  peer.socket = socket;
  socket.on('message', (raw) => peer.handle(raw));
  socket.close = () => { socket.readyState = WebSocket.CLOSED; };
  assert.deepEqual(await peer.request('ok', { value: 7 }), { value: 7 });
  await assert.rejects(peer.request('fail', {}), /failed/);
  peer.close();
});

test('JSON-RPC peer finalizes an explicitly closed upstream exactly once', async () => {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.send = () => {};
  socket.close = () => {
    socket.readyState = WebSocket.CLOSED;
    queueMicrotask(() => socket.emit('close'));
  };
  let closeCalls = 0;
  const peer = new JsonRpcPeer({
    url: 'ws://unused',
    onClose: () => { closeCalls += 1; },
  });
  peer.socket = socket;
  const pending = peer.request('never-finishes', {});

  peer.close();

  await assert.rejects(pending, /Hermes gateway disconnected/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peer.socket, null);
  assert.equal(peer.pending.size, 0);
  assert.equal(closeCalls, 1);
});

test('incomplete event payloads reconcile only the exact current response with verified persisted tool results',()=>{
 const {reconcileLiveTurnHistory}=require('./analystGatewayProxy.cjs');
 const stamp=Date.now();
 const makeTurn=()=>({submittedPrompt:'Balance Review',submittedAt:stamp,requiredLiveTools:new Set(['get_balance_context','get_portfolio_context']),completedLiveTools:new Set()});
 const history=[
  {role:'user',content:'Balance Review',timestamp:(stamp+1)/1000},
  ...['get_balance_context','get_portfolio_context'].map(name=>({role:'tool',name:ANALYST_MCP_TOOL_PREFIX+name,content:JSON.stringify({status:'partial',liveVerified:true,freshness:'live',data:{}})})),
  {role:'assistant',content:'Verified explanation'},
 ];
 assert.equal(reconcileLiveTurnHistory(makeTurn(),history,'Verified explanation'),true);
 for(const alter of [
  rows=>{rows[0].timestamp=(stamp-60000)/1000;},
  rows=>{rows[0].content='Another question';},
  rows=>{rows[0].timestamp=null;},
  rows=>{rows[2].content=JSON.stringify({status:'unavailable',liveVerified:false});},
  rows=>{rows[2].content=JSON.stringify({status:'available',liveVerified:true,cacheOnly:true});},
  rows=>{rows.pop();},
 ]) {
  const rows=structuredClone(history);alter(rows);
  assert.equal(reconcileLiveTurnHistory(makeTurn(),rows,'Verified explanation'),false);
 }
 assert.equal(reconcileLiveTurnHistory(makeTurn(),history,'Different response'),false);
});

test('prediction narrative refreshes the exact seven pinned monitors', () => {
 const {reviewNarrativePrompt}=require('./analystReviewPrompt.cjs');
 const prompt=reviewNarrativePrompt('prediction-markets-review','# Predictive Markets Review');
 assert.match(prompt,/review_universe=true/);
 assert.match(prompt,/same seven pinned monitors/);
 assert.match(prompt,/Interactive Brokers with CPI and S&P 500 on ForecastEx, then Kalshi with Nasdaq-100, Gold, Silver, Bitcoin, and Ethereum/);
 assert.match(prompt,/CPI uses release-matched forecasts/);
 assert.match(prompt,/compute any totals from that same observation/);
});

for (const [visibleText, requiresHoldings] of [
  ['Manually cross-verify my complete current portfolio against all research.', true],
  ['Explain the recorded Session outlook.', false],
]) test(`manual prompt uses hidden California timestamp guidance: ${visibleText}`, async t => {
  const { REVIEW_TIME_PROMPT, REVIEW_RETRIEVAL_PROMPT } = require('./analystReviewPrompt.cjs');
  const { browser, calls } = await withGateway(t, ({ method }) => {
    if (method === 'session.create') return { session_id: 'pacific-runtime', session_key: 'pacific-saved', messages: [], running: false };
    if (method === 'session.list') return { sessions: [] };
    if (method === 'prompt.submit') return { accepted: true };
    throw new Error(`Unexpected method ${method}`);
  });
  const userFrame = waitForWebSocketFrame(browser, frame => frame.type === 'user_message');
  browser.send(JSON.stringify({ action: 'new_prompt', requestId: 'pacific-manual', text: visibleText }));
  assert.equal((await userFrame).text, visibleText);
  while (!calls.some(({ method }) => method === 'prompt.submit')) await new Promise(resolve => setTimeout(resolve, 1));
  const submitted = calls.find(({ method }) => method === 'prompt.submit').params.text;
  assert.ok(submitted.includes(REVIEW_TIME_PROMPT));
  assert.ok(submitted.includes(REVIEW_RETRIEVAL_PROMPT));
  assert.match(submitted, /include_research_verification=true and compact_research_verification=true/);
  assert.match(submitted, /only while its freshness and provenance still qualify/);
  assert.match(submitted, /repeat the required live reads on every new turn/);
  assert.match(submitted, /PST in standard time and PDT in daylight time with 24-hour HH:mm/);
  assert.match(submitted, /Preserve date-only publication and market-session dates/);
  assert.match(submitted, /Never print UTC or ISO timestamps in the review/);
  assert.equal(/explicitly call each of these tools/.test(submitted), requiresHoldings);
  const projected = projectHistory([{ role: 'user', content: submitted }]);
  assert.equal(projected[0].content, visibleText);
  assert.equal(inferLiveTurnState(projected).requirements.has('get_portfolio_context'), requiresHoldings);
});

for (const holdingResult of [
 {status:'partial',liveVerified:true,freshness:'live'},
 {status:'unavailable',liveVerified:false},
 {status:'available',liveVerified:true,cacheOnly:true},
 null,
]) test(`balance verification requires the instructed cross-check: ${JSON.stringify(holdingResult)}`, async t=>{
 const {reviewNarrativePrompt}=require('./analystReviewPrompt.cjs');
 const prompt=reviewNarrativePrompt('balance-review','# Balance Review\nObserved: 2026-09-06\nAvailable funds: $100');
 const {browser,calls,emitEvent}=await withGateway(t,({method})=>{
  if(method==='session.create') return {session_id:'balance-runtime',session_key:'balance-saved',messages:[],running:false};
  if(method==='session.list') return {sessions:[]};
  if(method==='session.history') return {messages:[]};
  if(method==='prompt.submit')return {accepted:true};
  throw new Error(method);
 });
 const frames=[];browser.on('message',raw=>frames.push(JSON.parse(raw)));
 browser.send(JSON.stringify({action:'new_prompt',requestId:'balance-test',text:prompt}));
 while(!calls.some(c=>c.method==='prompt.submit')) await new Promise(r=>setTimeout(r,1));
 const submitted=calls.find(c=>c.method==='prompt.submit').params.text;
 assert.match(submitted,/explicitly call each of these tools in this turn: get_portfolio_context, get_balance_context/);
 assert.doesNotMatch(submitted,/get_dashboard_context|get_prediction_market_snapshot/);
 const event=(type,payload)=>emitEvent({session_id:'balance-runtime',type,payload});
 event('tool.complete',{name:ANALYST_MCP_TOOL_PREFIX+'get_balance_context',result:{status:'partial',liveVerified:true,freshness:'live'}});
 if(holdingResult)event('tool.complete',{name:ANALYST_MCP_TOOL_PREFIX+'get_portfolio_context',result:holdingResult});
 event('message.delta',{text:'Verified balance answer'});
 const final=waitForWebSocketFrame(browser,f=>['message_complete','error'].includes(f.type));
 event('message.complete',{text:'Verified balance answer'});
 const result=await final;
 if(holdingResult?.status==='partial') {
  assert.equal(result.type,'message_complete');
  assert.equal(result.text,'Verified balance answer');
 } else {
  assert.equal(result.code,'ANALYST_LIVE_REFRESH_REQUIRED');
  assert.deepEqual(result.missingTools,['get_portfolio_context']);
  assert.match(result.error,/IBKR holdings/);
  assert.ok(!frames.some(f=>f.type==='message_delta'||f.type==='message_complete'));
 }
});
