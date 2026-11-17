const { sidecarRequest, SIDECAR_BASE } = require('../providers/ibkrSidecarClient');
const { normalizeIbkrRaw } = require('../providers/normalize/normalizeQuote');
const { withQuoteObservation, validateQuoteObservation } = require('../providers/normalize/quoteContract.cjs');
const { toLegacyQuote } = require('../providers/normalize/legacyQuoteAdapter');
const { resolveInstrument, instrumentCacheKey } = require('../providers/instruments/instrumentResolver');
const { setIbkrConnected, setIbkrLastQuoteAt, setIbkrStreamMeta, getProviderStatusSnapshot } = require('../providers/providerStatus');

const STREAM_ENABLED = process.env.IBKR_STREAM_ENABLED !== 'false';
const quotesStateCache = new Map();
const quoteListeners = new Set();
let controller = null;
let reconnectTimer = null;
let reconcileTimer = null;
let reconcileTask = null;
let reconnectAttempt = 0;
let generation = 0;
let running = false;
let connected = false;
let providerGeneration = null;
let desiredSymbols = [];
// Instruments a bare symbol cannot identify (an index with its contract id),
// kept subscribed beside the symbols.
let desiredInstruments = [];
let desiredInstrumentsKey = '[]';
let reconcileFailures = 0;
let desiredRevision = 0;
let appliedRevision = -1;

function cacheKey(symbol) { return String(symbol || '').toUpperCase(); }
function getCachedCanonical(symbol) {
  const entry = quotesStateCache.get(cacheKey(symbol));
  const provider = getProviderStatusSnapshot().ibkr;
  if (!entry || !connected || !provider.connected || entry.generation !== provider.connectionGeneration) return null;
  const validation = validateQuoteObservation(entry.canonical, { instrument: symbol, connectionGeneration: provider.connectionGeneration, connected: provider.connected });
  if (!validation.valid || entry.canonical.valid !== true) {
    quotesStateCache.delete(cacheKey(symbol));
    return null;
  }
  return entry.canonical;
}
function getCachedLegacy(symbol) { return toLegacyQuote(getCachedCanonical(symbol)); }
function invalidate(message) {
  connected = false;
  appliedRevision = -1;
  quotesStateCache.clear();
  setIbkrConnected(false, message);
  setIbkrStreamMeta('offline', message);
}
function upsertQuote(raw) {
  // Portfolio subscriptions also emit derivatives with the same root symbol.
  // Match the resolver's complete default identity before sharing by symbol.
  const expected = resolveInstrument(raw?.symbol);
  const secType = String(raw?.secType || '').toUpperCase();
  const matchesType = secType === expected.secType || (secType === 'ETF' && expected.secType === 'STK');
  if (!matchesType || raw?.currency !== expected.currency || raw?.exchange !== expected.exchange) return null;
  const provider = getProviderStatusSnapshot().ibkr;
  const canonical = withQuoteObservation(normalizeIbkrRaw(raw), { instrument: raw.symbol, receivedAt: Date.now(), connectionGeneration: provider.connectionGeneration, connected: provider.connected });
  if (!canonical.symbol) return null;
  const key = cacheKey(canonical.symbol);
  if (!canonical.valid) {
    quotesStateCache.delete(key);
    return null;
  }
  quotesStateCache.set(key, { canonical, generation: canonical.connectionGeneration });
  // Bound unsolicited symbol cardinality as well as observation age.
  if (quotesStateCache.size > 1000) quotesStateCache.delete(quotesStateCache.keys().next().value);
  if (connected) setIbkrLastQuoteAt(new Date().toISOString(), canonical.dataType === 'live' ? 'current' : 'delayed');
  return { canonical, legacy: toLegacyQuote(canonical) };
}
function onQuote(callback) { quoteListeners.add(callback); return () => quoteListeners.delete(callback); }
// Every instrument the dashboard wants streamed, each once.
function desiredSidecarInstruments() {
  const seen = new Set();
  const instruments = [];
  for (const input of [...desiredSymbols, ...desiredInstruments]) {
    const instrument = resolveInstrument(input);
    const key = instrumentCacheKey(input);
    if (!instrument.supported || seen.has(key)) continue;
    seen.add(key);
    instruments.push({
      symbol: instrument.symbol, secType: instrument.secType, exchange: instrument.exchange,
      currency: instrument.currency, conId: instrument.conid,
    });
  }
  return instruments;
}
// A request the sidecar keeps refusing (no free market-data line, a contract
// it cannot identify) is retried less and less often, not once a second.
function retryReconcile() {
  if (!running || reconcileTimer) return;
  const delay = Math.min(1000 * 2 ** Math.min(reconcileFailures, 5), 30000);
  reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcileDesired(); }, delay);
  reconcileTimer.unref?.();
}
function reconcileDesired() {
  if (!running || !connected || reconcileTask || appliedRevision === desiredRevision) return reconcileTask;
  const streamGeneration = generation;
  const brokerGeneration = providerGeneration;
  const revision = desiredRevision;
  reconcileTask = sidecarRequest('/subscriptions/reconcile', {
    method: 'POST', body: { owner: 'market-dashboard', instruments: desiredSidecarInstruments() }, timeoutMs: 10000,
  }).then(result => {
    const applied = result.ok === true && !(result.errors?.length);
    reconcileFailures = applied ? 0 : reconcileFailures + 1;
    if (generation === streamGeneration && providerGeneration === brokerGeneration && connected && applied) appliedRevision = revision;
  }).catch(() => { reconcileFailures += 1; /* Pending desired state is retried; no reference counts are committed on failure. */ }).finally(() => {
    reconcileTask = null;
    if (running && appliedRevision !== desiredRevision) retryReconcile();
  });
  return reconcileTask;
}
function setDesiredSymbols(symbols) {
  const next = [...new Set((symbols || []).map(cacheKey).filter(Boolean))].sort();
  if (JSON.stringify(next) !== JSON.stringify(desiredSymbols)) { desiredSymbols = next; desiredRevision += 1; reconcileFailures = 0; }
  return reconcileDesired();
}
// The complete set of instrument descriptors to keep streamed beside the
// symbols. The two sets are independent: replacing one leaves the other.
function setDesiredInstruments(instruments) {
  const byKey = new Map();
  for (const instrument of instruments || []) {
    if (instrument && resolveInstrument(instrument).supported) byKey.set(instrumentCacheKey(instrument), instrument);
  }
  const next = [...byKey.values()];
  const key = JSON.stringify([...byKey.keys()].sort());
  if (key !== desiredInstrumentsKey) {
    desiredInstruments = next;
    desiredInstrumentsKey = key;
    desiredRevision += 1;
    reconcileFailures = 0;
  }
  return reconcileDesired();
}
// Compatibility for callers that maintain an incremental set. Server uses the full union.
function sidecarSubscribe(symbols) { return setDesiredSymbols([...desiredSymbols, ...symbols]); }
function sidecarUnsubscribe(symbols) {
  const removed = new Set(symbols.map(cacheKey));
  return setDesiredSymbols(desiredSymbols.filter(symbol => !removed.has(symbol)));
}
function handleEvent(msg, token) {
  if (!running || token !== generation) return;
  if (msg.type === 'status') {
    const nextProviderGeneration = `${msg.payload?.instanceId || ''}:${msg.payload?.connectionGeneration ?? ''}`;
    if (providerGeneration !== nextProviderGeneration) {
      quotesStateCache.clear();
      appliedRevision = -1;
      providerGeneration = nextProviderGeneration;
    }
    if (msg.payload?.connected !== true) { invalidate(msg.payload?.message || 'not_connected'); return; }
    connected = true;
    setIbkrConnected(true, null, nextProviderGeneration);
    setIbkrStreamMeta('streaming', null);
    reconnectAttempt = 0;
    reconcileDesired();
  } else if (msg.type === 'quote' && connected && msg.payload) {
    const result = upsertQuote(msg.payload);
    if (result?.legacy) {
      quoteListeners.forEach(fn => {
        const provider = getProviderStatusSnapshot().ibkr;
        if (!validateQuoteObservation(result.legacy, { instrument: result.legacy.symbol, connectionGeneration: provider.connectionGeneration, connected: provider.connected }).valid) return;
        try { fn(result.legacy); } catch (err) { console.error('[ibkrStreamBridge] listener error:', err.message); }
      });
    }
  }
}
function parseSseChunk(buffer, onEvent) {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const remainder = parts.pop() || '';
  for (const part of parts) {
    const data = part.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) { try { onEvent(JSON.parse(data)); } catch { /* A malformed frame carries no evidence. */ } }
  }
  return remainder;
}
async function consumeSse(token) {
  const localController = new AbortController();
  controller = localController;
  let reader;
  let heartbeat;
  const resetHeartbeat = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => localController.abort(), 45000);
    heartbeat.unref?.();
  };
  try {
    resetHeartbeat();
    const res = await fetch(`${SIDECAR_BASE.replace(/\/$/, '')}/stream/quotes`, {
      headers: { Accept: 'text/event-stream' }, signal: localController.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (running && token === generation) {
      const { done, value } = await reader.read();
      if (done) throw new Error('quote_stream_ended');
      resetHeartbeat();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('quote_stream_frame_too_large');
      buffer = parseSseChunk(buffer, msg => handleEvent(msg, token));
    }
  } catch (err) {
    if (running && token === generation) invalidate(err.name === 'AbortError' ? 'quote_stream_timeout' : err.message);
  } finally {
    clearTimeout(heartbeat);
    try { await reader?.cancel(); } catch { /* Transport already closed. */ }
    if (running && token === generation) scheduleReconnect();
  }
}
function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt++, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (running) { generation += 1; consumeSse(generation); }
  }, delay);
  reconnectTimer.unref?.();
}
function startIbkrStreamBridge() {
  if (!STREAM_ENABLED) { setIbkrStreamMeta('disabled', null); return; }
  if (running) return;
  running = true;
  generation += 1;
  invalidate('quote_stream_connecting');
  consumeSse(generation);
}
function stopIbkrStreamBridge() {
  running = false;
  generation += 1;
  controller?.abort();
  controller = null;
  clearTimeout(reconnectTimer);
  clearTimeout(reconcileTimer);
  reconnectTimer = reconcileTimer = null;
  invalidate('quote_stream_stopped');
}
module.exports = { quotesStateCache, getCachedCanonical, getCachedLegacy, onQuote, startIbkrStreamBridge, stopIbkrStreamBridge,
  sidecarSubscribe, sidecarUnsubscribe, setDesiredSymbols, setDesiredInstruments, upsertQuote, STREAM_ENABLED };
