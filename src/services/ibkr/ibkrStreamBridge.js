const { sidecarRequest, SIDECAR_BASE } = require('../providers/ibkrSidecarClient');
const { normalizeIbkrRaw } = require('../providers/normalize/normalizeQuote');
const { withQuoteObservation, validateQuoteObservation } = require('../providers/normalize/quoteContract.cjs');
const { toLegacyQuote } = require('../providers/normalize/legacyQuoteAdapter');
const { resolveInstrument } = require('../providers/instruments/instrumentResolver');
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
function instrumentsFor(symbols) {
  return symbols.map(resolveInstrument).filter(i => i.supported).map(i => ({
    symbol: i.symbol, secType: i.secType, exchange: i.exchange, currency: i.currency, conId: i.conid,
  }));
}
function retryReconcile() {
  if (!running || reconcileTimer) return;
  reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcileDesired(); }, 1000);
  reconcileTimer.unref?.();
}
function reconcileDesired() {
  if (!running || !connected || reconcileTask || appliedRevision === desiredRevision) return reconcileTask;
  const streamGeneration = generation;
  const brokerGeneration = providerGeneration;
  const revision = desiredRevision;
  reconcileTask = sidecarRequest('/subscriptions/reconcile', {
    method: 'POST', body: { owner: 'market-dashboard', instruments: instrumentsFor(desiredSymbols) }, timeoutMs: 10000,
  }).then(result => {
    if (generation === streamGeneration && providerGeneration === brokerGeneration && connected && result.ok === true && !(result.errors?.length)) appliedRevision = revision;
  }).catch(() => { /* Pending desired state is retried; no reference counts are committed on failure. */ }).finally(() => {
    reconcileTask = null;
    if (running && appliedRevision !== desiredRevision) retryReconcile();
  });
  return reconcileTask;
}
function setDesiredSymbols(symbols) {
  const next = [...new Set((symbols || []).map(cacheKey).filter(Boolean))].sort();
  if (JSON.stringify(next) !== JSON.stringify(desiredSymbols)) { desiredSymbols = next; desiredRevision += 1; }
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
  sidecarSubscribe, sidecarUnsubscribe, setDesiredSymbols, upsertQuote, STREAM_ENABLED };
