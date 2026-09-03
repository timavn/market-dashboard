#!/usr/bin/env node
import process from 'node:process';
import { WebSocket } from 'ws';

const deep = process.argv.includes('--deep');
const base = process.env.ANALYST_HERMES_URL || 'ws://127.0.0.1:9121/api/ws';
const token = process.env.HERMES_DASHBOARD_SESSION_TOKEN || '';
if (!token) throw new Error('HERMES_DASHBOARD_SESSION_TOKEN is required.');
const url = `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

class Client {
  constructor() {
    this.socket = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 0;
  }

  async connect() {
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.id != null) {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.error) pending.reject(new Error(frame.error.message));
        else pending.resolve(frame.result);
      } else if (frame.method === 'event') {
        this.listeners.forEach((listener) => listener(frame.params));
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 15_000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', reject);
    });
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = `contract-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  waitFor(predicate, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error('event timeout'));
      }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    this.socket?.close();
  }
}

const evidence = {
  contract: 1,
  checkedAt: new Date().toISOString(),
  deep,
  checks: {},
};
const expectedTool = 'mcp__market_dashboard_analyst__get_research_coverage';

let client = new Client();
await client.connect();
const listed = await client.request('session.list', { limit: 5 });
if (!Array.isArray(listed.sessions)) throw new Error('session.list response is incompatible.');
evidence.checks.list = true;

const created = await client.request('session.create', {
  source: 'analyst-contract-check',
  title: 'Analyst contract check',
  model: 'openai/gpt-5.6-luna',
  close_on_disconnect: false,
  hidden: true,
});
if (!created.session_id || !created.stored_session_id) throw new Error('session.create response is incompatible.');
evidence.checks.create = true;

const active = await client.request('session.active_list');
if (!Array.isArray(active.sessions) || !active.sessions.some((session) => (
  session.id === created.session_id && session.session_key === created.stored_session_id
))) {
  throw new Error('session.active_list response is incompatible.');
}
evidence.checks.activeList = true;

const mostRecent = await client.request('session.most_recent');
if (!Object.prototype.hasOwnProperty.call(mostRecent, 'session_id')) {
  throw new Error('session.most_recent response is incompatible.');
}
evidence.checks.mostRecent = true;

const history = await client.request('session.history', { session_id: created.session_id });
if (!Array.isArray(history.messages)) throw new Error('session.history response is incompatible.');
evidence.checks.history = true;

await client.request('session.interrupt', { session_id: created.session_id });
evidence.checks.interrupt = true;

if (deep) {
  const expectedTitle = `Analyst contract check ${created.stored_session_id}`;
  const titled = await client.request('session.title', {
    session_id: created.session_id,
    title: expectedTitle,
  });
  if (titled.title !== expectedTitle) throw new Error('session.title did not persist the requested title.');
  evidence.checks.title = true;

  const started = client.waitFor((event) => (
    event?.type === 'message.start' && event?.session_id === created.session_id
  ));
  const delta = client.waitFor((event) => (
    event?.type === 'message.delta'
    && event?.session_id === created.session_id
    && typeof event?.payload?.text === 'string'
    && event.payload.text.length > 0
  ));
  const completion = client.waitFor((event) => (
    event?.type === 'message.complete' && event?.session_id === created.session_id
  ));
  const accepted = await client.request('prompt.submit', {
    session_id: created.session_id,
    text: 'Call get_research_coverage. After the tool returns, reply with exactly: ANALYST_CONTRACT_READY',
  });
  if (accepted.status !== 'streaming') throw new Error('prompt.submit did not start streaming.');
  await started;
  await delta;
  const event = await completion;
  if (!String(event.payload?.text || '').includes('ANALYST_CONTRACT_READY')) {
    throw new Error('message.complete response did not contain the contract marker.');
  }
  const completedHistory = await client.request('session.history', { session_id: created.session_id });
  const toolHistory = completedHistory.messages?.find((message) => (
    message?.role === 'tool' && message?.name === expectedTool
  ));
  if (!toolHistory) throw new Error('The expected MCP tool history was not persisted.');
  evidence.checks.promptStreaming = true;
  evidence.checks.messageStart = true;
  evidence.checks.messageDelta = true;
  evidence.checks.messageComplete = true;
  evidence.checks.mcpToolHistory = true;
}

client.close();
await new Promise((resolve) => setTimeout(resolve, 250));
client = new Client();
await client.connect();
evidence.checks.reconnect = true;

if (deep) {
  const resumed = await client.request('session.resume', {
    session_id: created.stored_session_id,
    source: 'analyst-contract-check',
  });
  if (!resumed.session_id || !Array.isArray(resumed.messages) || resumed.messages.length < 2) {
    throw new Error('session.resume did not restore persisted prompt history.');
  }
  if (!resumed.messages.some((message) => message?.role === 'tool' && message?.name === expectedTool)) {
    throw new Error('session.resume did not restore persisted MCP tool history.');
  }
  evidence.checks.resume = true;
  evidence.checks.persistence = true;
  evidence.checks.mcpToolResume = true;

  const closed = await client.request('session.close', { session_id: resumed.session_id });
  if (closed.closed !== true) throw new Error('session.close did not close the contract-check session.');
  evidence.checks.close = true;

  const deleted = await client.request('session.delete', { session_id: created.stored_session_id });
  if (deleted.deleted !== created.stored_session_id) {
    throw new Error('session.delete did not remove the contract-check session.');
  }
  evidence.checks.delete = true;
}

client.close();
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
