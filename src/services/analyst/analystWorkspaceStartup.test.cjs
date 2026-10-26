const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAnalystWorkspace } = require('./analystWorkspace.cjs');

test('saved chats and cursor load while archive import remains pending', async t => {
  let finishImport;
  const archive = new Promise(resolve => { finishImport = resolve; });
  const calls = [];
  const workspace = createAnalystWorkspace({ request: async path => {
    const operation = path.split('/').at(-1);
    calls.push(operation);
    if (operation === 'recover') return {};
    if (operation === 'import') return archive;
    if (operation === 'list') return { conversations: [{ id: 'saved-chat' }], cursor: 9000 };
    throw new Error(operation);
  } });
  const app = express(); app.use(workspace.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { finishImport({}); server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { conversations: [{ id: 'saved-chat' }], cursor: 9000 });
  await workspace.initialize();
  // Listing chats also reads the inbox-thread links so alert discussions stay out of Chats.
  assert.deepEqual(calls, ['recover', 'import', 'list', 'setting']);
});

test('failed archive import retries without repeating recovery', async () => {
  let imports = 0;
  let recoveries = 0;
  const workspace = createAnalystWorkspace({ request: async path => {
    if (path.endsWith('/recover')) { recoveries += 1; return {}; }
    imports += 1;
    if (imports === 1) throw new Error('Archive temporarily unavailable');
    return {};
  } });
  await workspace.initialize();
  await new Promise(resolve => setImmediate(resolve));
  await workspace.initialize();
  assert.equal(imports, 2);
  assert.equal(recoveries, 1);
});

test('compact current read remains usable while full saved evidence is delayed', async t => {
  let finishFull;
  let fullStarted;
  const hydration = new Promise(resolve => { finishFull = resolve; });
  const started = new Promise(resolve => { fullStarted = resolve; });
  const calls = [];
  const primary = { version: 1, runId: 'saved-run', reportRevision: 'original-revision', presentation: 'compact',
    metrics: { grossExposure: 123 }, dailyRollup: { version: 1, sections: [{ id: 'reading', title: 'Captured reading' }] } };
  const workspace = createAnalystWorkspace({ request: async (path, options) => {
    const operation = path.split('/').at(-1);
    if (operation === 'recover' || operation === 'import') return {};
    assert.equal(operation, 'get');
    calls.push(options.body);
    if (options.body.includeBriefs === false) return { cursor: 42, conversation: { id: 'saved-chat', messages: [
      { id: 'saved-post', role: 'assistant', text: '', reportTextIncluded: false, portfolioBrief: primary },
    ] } };
    fullStarted();
    return hydration;
  } });
  const app = express(); app.use(workspace.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { finishFull({}); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const full = fetch(`${base}/conversations/saved-chat`);
  await started;
  const compact = await fetch(`${base}/conversations/saved-chat?includeBriefs=false`, { signal: AbortSignal.timeout(1000) });
  assert.equal(compact.status, 200);
  const result = await compact.json();
  assert.equal(result.cursor, 42);
  assert.equal(result.conversation.briefsIncluded, false);
  assert.deepEqual(result.conversation.messages[0].portfolioBrief, primary);
  assert.deepEqual(calls, [{ conversationId: 'saved-chat' }, { conversationId: 'saved-chat', includeBriefs: false, briefView: 'compact' }]);
  finishFull({ cursor: 42, conversation: { id: 'saved-chat', messages: [{ id: 'saved-post', text: 'Original saved Markdown', portfolioBrief: { ...primary, presentation: 'full' } }] } });
  assert.equal((await (await full).json()).conversation.messages[0].text, 'Original saved Markdown');
});

test('captured citation route binds the exact conversation and historical message', async t => {
  const calls = [];
  const citation = { id: 'cite-old', product: 'risk-ranges', excerpt: 'Original captured evidence' };
  const workspace = createAnalystWorkspace({ request: async (path, options) => {
    if (path.endsWith('/recover') || path.endsWith('/import')) return {};
    calls.push({ path, body: options.body });
    return { citation };
  } });
  const app = express(); app.use(workspace.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations/saved-chat/citations/old-post/cite-old`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { citation });
  assert.deepEqual(calls, [{ path: '/internal/workspace/captured-citation', body: { conversationId: 'saved-chat', messageId: 'old-post', citationId: 'cite-old' } }]);
});

test('compact projection selectors forward one exact selection and reject invalid reads', async t => {
  const calls = [];
  const workspace = createAnalystWorkspace({ request: async (path, options) => {
    if (path.endsWith('/recover') || path.endsWith('/import')) return {};
    calls.push(options.body);
    return { conversation: { id: 'saved-chat', messages: [] } };
  } });
  const app = express(); app.use(workspace.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/conversations/saved-chat`;
  assert.equal((await fetch(`${base}?includeBriefs=false&briefScope=latest`)).status, 200);
  assert.equal((await fetch(`${base}?includeBriefs=false&briefMessageId=old-post`)).status, 200);
  assert.deepEqual(calls, [
    { conversationId: 'saved-chat', includeBriefs: false, briefView: 'compact', briefScope: 'latest' },
    { conversationId: 'saved-chat', includeBriefs: false, briefView: 'compact', briefMessageId: 'old-post' },
  ]);
  for (const query of ['briefScope=latest', 'includeBriefs=false&briefScope=all',
    'includeBriefs=false&briefMessageId=', 'includeBriefs=false&briefMessageId=' + 'x'.repeat(513),
    'includeBriefs=false&briefScope=latest&briefMessageId=old-post']) {
    assert.equal((await fetch(`${base}?${query}`)).status, 400);
  }
  assert.equal(calls.length, 2);
});
