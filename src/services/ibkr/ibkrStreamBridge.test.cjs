const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sidecar = require('../providers/ibkrSidecarClient');
const requests = [];
sidecar.sidecarRequest = async (path, options) => { requests.push({ path, ...options }); return { ok: true }; };
const bridge = require('./ibkrStreamBridge');
const { getProviderStatusSnapshot } = require('../providers/providerStatus');
const originalFetch = global.fetch;
const flush = () => new Promise(resolve => setImmediate(resolve));
let streams;
function transport() {
  streams = [];
  requests.length = 0;
  global.fetch = async (_url, { signal }) => {
    let control;
    const stream = new ReadableStream({ start(c) { control = c; } });
    signal.addEventListener('abort', () => { try { control.error(new DOMException('aborted', 'AbortError')); } catch {} });
    streams.push(control);
    return new Response(stream, { status: 200 });
  };
}
function event(payload) { streams.at(-1).enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)); }
function status(instanceId = 'first') { event({ type: 'status', payload: { connected: true, instanceId, connectionGeneration: 1 } }); }
function raw(timestamp = new Date().toISOString()) { return { symbol: 'SPY', secType: 'STK', currency: 'USD', exchange: 'SMART', bid: 99, ask: 101, last: 100, close: 98, timestamp, dataType: 'live', entitlementStatus: 'live' }; }
afterEach(() => { bridge.stopIbkrStreamBridge(); global.fetch = originalFetch; });
test('read checks use the provider timestamp, and stopped streams expose no quotes', async () => {
  transport(); bridge.startIbkrStreamBridge(); await flush(); status(); await flush();
  const now = Date.now();
  bridge.upsertQuote(raw(new Date(now - 59000).toISOString()));
  const cached = bridge.getCachedLegacy('SPY');
  assert.ok(cached);
  assert.equal(cached.observation.classification, 'live_quote');
  assert.deepEqual(cached.observation.scope, { kind: 'market', accountId: null });
  assert.equal(cached.observation.connectionGeneration, getProviderStatusSnapshot().ibkr.connectionGeneration);
  assert.equal(bridge.getCachedLegacy('SPY').receivedAt, cached.receivedAt);
  const actualNow = Date.now;
  Date.now = () => now + 2000;
  try { assert.equal(bridge.getCachedLegacy('SPY'), null); } finally { Date.now = actualNow; }
  bridge.upsertQuote(raw()); bridge.stopIbkrStreamBridge();
  assert.equal(bridge.getCachedCanonical('SPY'), null);
});
test('clean EOF invalidates evidence and reconnect replays complete desired subscriptions', async () => {
  transport(); bridge.setDesiredSymbols(['SPY', 'QQQ']); bridge.startIbkrStreamBridge();
  await flush(); status(); await flush();
  event({ type: 'quote', payload: raw() }); await flush();
  assert.ok(bridge.getCachedLegacy('SPY'));
  streams[0].close(); await flush();
  assert.equal(getProviderStatusSnapshot().ibkr.connected, false);
  assert.equal(bridge.getCachedLegacy('SPY'), null);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(streams.length, 2);
  status('restarted'); await flush();
  assert.deepEqual(requests.at(-1).body.instruments.map(i => i.symbol), ['QQQ', 'SPY']);
  bridge.setDesiredSymbols([]); await flush();
  assert.deepEqual(requests.at(-1).body.instruments, []);
});
test('unknown entitlement or mock observations never reach quote listeners', async () => {
  transport(); bridge.startIbkrStreamBridge(); await flush(); status(); await flush();
  const seen = []; const unsubscribe = bridge.onQuote(q => seen.push(q));
  for (const change of [{ entitlementStatus: 'unknown' }, { mock: true }, { dataType: 'frozen' }]) event({ type: 'quote', payload: { ...raw(), ...change } });
  await flush(); unsubscribe();
  assert.equal(seen.length, 0); assert.equal(bridge.getCachedLegacy('SPY'), null);
});

test('a derivative with the same root cannot overwrite the default equity cache', async () => {
  transport(); bridge.startIbkrStreamBridge(); await flush(); status(); await flush();
  bridge.upsertQuote(raw());
  bridge.upsertQuote({ ...raw(), secType: 'OPT', conId: 12345, last: 2, bid: 1, ask: 3 });
  assert.equal(bridge.getCachedLegacy('SPY').price, '100.00');
});

test('stream listeners receive the same immutable envelope that the cache validates', async () => {
  transport(); bridge.startIbkrStreamBridge(); await flush(); status(); await flush();
  const seen = []; const unsubscribe = bridge.onQuote(q => seen.push(q));
  event({ type: 'quote', payload: raw() }); await flush(); unsubscribe();
  assert.equal(seen.length, 1);
  const cached = bridge.getCachedLegacy('SPY');
  assert.equal(seen[0].observation, cached.observation);
  assert.equal(seen[0].receivedAt, cached.receivedAt);
  assert.equal(seen[0].expiresAt, cached.expiresAt);
});
