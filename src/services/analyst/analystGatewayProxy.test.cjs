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
  const analyst = attachAnalystGatewayProxy(server, {
    contractVerified: true,
    token: 'test-token',
    sessionListFetchImpl: null,
    socketFactory: () => new FakeHermesSocket((request) => {
      calls.push(request);
      return requestHandler(request);
    }),
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
  return { analyst, browser, calls, server };
}

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
  assert.equal(APPROVED_TOOLS.size, 13);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}prepare_portfolio_review`), false);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}get_portfolio_review_packet`), false);
  assert.equal(isApprovedTool(`${ANALYST_MCP_TOOL_PREFIX}get_portfolio_context`), true);
  assert.equal(isApprovedTool('mcp__other_server__get_portfolio_context'), false);
  assert.equal([...APPROVED_TOOLS].some((name) => /portfolio_review_packet/i.test(name)), false);
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
  assert.equal(create.params.hidden, undefined);
  assert.equal(submit.params.text, 'Explain duration risk in this portfolio');
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
  assert.equal(create.params.hidden, true);
  assert.equal(
    create.params.title,
    `[market-dashboard-analyst-review:portfolio-review:${conversationId}]`,
  );
  const link = reviewRequests.find(({ url }) => url.endsWith('/hermes-session'));
  assert.equal(link.options.method, 'PUT');
  assert.deepEqual(JSON.parse(link.options.body), { sessionId: 'stored-review-followup' });
  const submitted = calls.find(({ method }) => method === 'prompt.submit').params.text;
  assert.match(submitted, /^\[market-dashboard-review-context-v2\]/);
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

  for (const action of ['rename_session', 'delete_session']) {
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
  assert.match(submitted, /^\[market-dashboard-review-context-v2\]/);
  assert.match(submitted, /"schema":"ReviewContextV2"/);
  assert.equal(submitted.endsWith(visibleText), true);
  const projected = projectHistory([{ role: 'user', content: submitted }]);
  assert.equal(projected[0].content, visibleText);
  assert.doesNotMatch(projected[0].content, /ReviewContextV2|netLiquidation/);
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

test('accepts only structurally valid tool-issued citations', () => {
  assert.equal(validCitation(citation), true);
  assert.equal(validCitation({ ...citation, id: 'cite_invented' }), false);
  const collected = collectCitations({ citations: [citation, { ...citation }] });
  assert.equal(collected.size, 1);
  assert.equal(collected.get(citation.id).id, citation.id);
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
