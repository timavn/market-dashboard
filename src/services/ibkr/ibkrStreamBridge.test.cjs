const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sidecar = require('../providers/ibkrSidecarClient');
const requests = [];
let sidecarReply = { ok: true };
sidecar.sidecarRequest = async (path, options) => { requests.push({ path, ...options }); return sidecarReply; };
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

test('instrument descriptors are streamed beside the symbols, each instrument once, and the two sets are independent', async () => {
  const SPX = { symbol: 'SPX', provider: 'auto', ibkrSymbol: 'SPX', yahooSymbol: '^GSPC', conId: 416904, secType: 'IND', exchange: 'CBOE', currency: 'USD' };
  const XLK = { symbol: 'XLK', name: 'Technology', yahooSymbol: 'XLK' };
  const YAHOO_ONLY = { symbol: 'NDX', provider: 'yahoo', yahooSymbol: '^NDX', secType: 'IND' };
  transport(); bridge.setDesiredSymbols(['SPY']); bridge.setDesiredInstruments([SPX, XLK, XLK, YAHOO_ONLY]);
  bridge.startIbkrStreamBridge(); await flush(); status(); await flush();
  assert.deepEqual(requests.at(-1).body.owner, 'market-dashboard');
  assert.deepEqual(requests.at(-1).body.instruments, [
    { symbol: 'SPY', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: undefined },
    { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD', conId: 416904 },
    { symbol: 'XLK', secType: 'STK', exchange: 'SMART', currency: 'USD', conId: undefined },
  ]);

  // Replacing the symbols leaves the descriptors, and the other way round.
  bridge.setDesiredSymbols([]); await flush();
  assert.deepEqual(requests.at(-1).body.instruments.map(i => i.symbol), ['SPX', 'XLK']);
  const sent = requests.length;
  bridge.setDesiredInstruments([XLK, SPX]); await flush();
  assert.equal(requests.length, sent, 'the same set in another order is not sent again');
  bridge.setDesiredInstruments([]); await flush();
  assert.deepEqual(requests.at(-1).body.instruments, []);
});

test('a request the sidecar keeps refusing is retried with a growing delay', async () => {
  const actualSetTimeout = global.setTimeout;
  const delays = [];
  const pending = [];
  sidecarReply = { ok: false, errors: ['Max subscriptions (100) reached'] };
  try {
    transport(); bridge.setDesiredSymbols(['SPY']); bridge.startIbkrStreamBridge(); await flush();
    // Only the reconcile retry is run; the stream's own 45-second heartbeat timer is left pending.
    global.setTimeout = (callback, delay) => { if (delay !== 45000) { delays.push(delay); pending.push(callback); } return { unref() {} }; };
    status(); await flush();
    for (let attempt = 0; attempt < 6; attempt += 1) { pending.shift()?.(); await flush(); }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  } finally {
    global.setTimeout = actualSetTimeout;
    sidecarReply = { ok: true };
    bridge.setDesiredSymbols([]);
  }
});
