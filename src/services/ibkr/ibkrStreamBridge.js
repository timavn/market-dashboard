const { sidecarRequest, SIDECAR_BASE } = require('../providers/ibkrSidecarClient');
const { normalizeIbkrRaw } = require('../providers/normalize/normalizeQuote');
const { toLegacyQuote } = require('../providers/normalize/legacyQuoteAdapter');
const { resolveInstrument } = require('../providers/instruments/instrumentResolver');
const {
  setIbkrConnected,
  setIbkrLastQuoteAt,
  setIbkrStreamMeta,
} = require('../providers/providerStatus');

const STREAM_ENABLED = process.env.IBKR_STREAM_ENABLED !== 'false';
const STALE_SEC = Number(process.env.IBKR_QUOTE_STALE_SEC || 60);

/** @type {Map<string, { canonical: object, legacy: object, updatedAt: number }>} */
const quotesStateCache = new Map();

/** @type {Set<(quote: object) => void>} */
const quoteListeners = new Set();

let sseAbortController = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

function cacheKey(symbol) {
  return String(symbol || '').toUpperCase();
}

function getCachedCanonical(symbol) {
  const entry = quotesStateCache.get(cacheKey(symbol));
  if (!entry) return null;
  const ageSec = (Date.now() - entry.updatedAt) / 1000;
  if (ageSec > STALE_SEC) {
    return { ...entry.canonical, valid: false, warning: 'stale_quote' };
  }
  return entry.canonical;
}

function getCachedLegacy(symbol) {
  const entry = quotesStateCache.get(cacheKey(symbol));
  if (!entry) return null;
  const ageSec = (Date.now() - entry.updatedAt) / 1000;
  if (ageSec > STALE_SEC) return null;
  return entry.legacy;
}

function markAllStale() {
  quotesStateCache.forEach((entry, key) => {
    quotesStateCache.set(key, {
      ...entry,
      canonical: {
        ...entry.canonical,
        valid: false,
        warning: [entry.canonical.warning, 'stale_quote'].filter(Boolean).join('; '),
      },
    });
  });
}

function upsertQuote(raw) {
  const canonical = normalizeIbkrRaw(raw);
  if (!canonical.symbol) return null;
  const legacy = toLegacyQuote(canonical);
  const key = cacheKey(canonical.symbol);
  quotesStateCache.set(key, {
    canonical,
    legacy,
    updatedAt: Date.now(),
  });
  if (canonical.valid) {
    setIbkrLastQuoteAt(canonical.timestamp || new Date().toISOString());
  }
  return { canonical, legacy };
}

function onQuote(callback) {
  quoteListeners.add(callback);
  return () => quoteListeners.delete(callback);
}

function notifyListeners(quote) {
  quoteListeners.forEach((fn) => {
    try {
      fn(quote);
    } catch (err) {
      console.error('[ibkrStreamBridge] listener error:', err.message);
    }
  });
}

function parseSseChunk(buffer, onEvent) {
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() || '';
  for (const part of parts) {
    const lines = part.split('\n');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        try {
          const json = JSON.parse(line.slice(5).trim());
          onEvent(json);
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
  return remainder;
}

async function consumeSse() {
  const base = SIDECAR_BASE.replace(/\/$/, '');
  sseAbortController = new AbortController();

  try {
    const res = await fetch(`${base}/stream/quotes`, {
      headers: { Accept: 'text/event-stream' },
      signal: sseAbortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE HTTP ${res.status}`);
    }

    setIbkrConnected(true);
    setIbkrStreamMeta('streaming', null);
    reconnectAttempt = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, (msg) => {
        if (msg.type === 'status') {
          const connected = Boolean(msg.payload?.connected);
          setIbkrConnected(connected, msg.payload?.message || null);
          setIbkrStreamMeta(connected ? 'streaming' : 'offline', msg.payload?.message);
          if (!connected) markAllStale();
          return;
        }
        if (msg.type === 'quote' && msg.payload) {
          const result = upsertQuote(msg.payload);
          if (result?.legacy) {
            notifyListeners(result.legacy);
          }
        }
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    setIbkrStreamMeta('offline', err.message);
    setIbkrConnected(false, err.message);
    markAllStale();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (STREAM_ENABLED) startIbkrStreamBridge();
  }, delay);
}

async function sidecarSubscribe(symbols) {
  const instruments = symbols
    .map((sym) => resolveInstrument(sym))
    .filter((i) => i.supported)
    .map((i) => ({
      symbol: i.symbol,
      secType: i.secType,
      exchange: i.exchange,
      currency: i.currency,
      conId: i.conid,
    }));

  if (!instruments.length) return { ok: false, subscribed: [] };

  return sidecarRequest('/subscribe', {
    method: 'POST',
    body: { instruments },
    timeoutMs: 10000,
  });
}

async function sidecarUnsubscribe(symbols) {
  const instruments = symbols.map((sym) => {
    const i = resolveInstrument(sym);
    return {
      symbol: i.symbol,
      secType: i.secType,
      exchange: i.exchange,
      currency: i.currency,
      conId: i.conid,
    };
  });

  return sidecarRequest('/unsubscribe', {
    method: 'POST',
    body: { instruments },
    timeoutMs: 10000,
  });
}

function startIbkrStreamBridge() {
  if (!STREAM_ENABLED) {
    setIbkrStreamMeta('disabled', null);
    return;
  }
  stopIbkrStreamBridge();
  consumeSse().catch((err) => {
    console.error('[ibkrStreamBridge] SSE error:', err.message);
  });
}

function stopIbkrStreamBridge() {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

module.exports = {
  quotesStateCache,
  getCachedCanonical,
  getCachedLegacy,
  onQuote,
  startIbkrStreamBridge,
  stopIbkrStreamBridge,
  sidecarSubscribe,
  sidecarUnsubscribe,
  upsertQuote,
  STREAM_ENABLED,
};
