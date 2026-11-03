const { randomUUID, createHash } = require('node:crypto');
const { SECURITY_SYMBOL } = require('../../utils/securitySymbols.cjs');

const INTERVAL_MS = 30_000;
// A queued or acquiring review may postpone at most this many scan cycles.
const MAX_DEFERRED_CYCLES = 2;
// Only attention publication writes this switch; re-read it occasionally anyway.
const ENABLED_CACHE_MS = 60_000;
// The stance book outlives the 2,000-event journal; a missing history is
// fetched from the ledger at most hourly while the live feed keeps folding in.
const STANCE_BOOK_KEY = 'stance-book-v1';
const STANCE_HISTORY_DAYS = 90;
const STANCE_HISTORY_RETRY_MS = 3_600_000;
// The day's Alpha Code lines and which side of each the price is on.
const ALPHA_CODE_WATCH_KEY = 'alpha-code-watch-v1';
// Names for held securities come from the central security record, read in
// route-sized batches; a slow read leaves cards unnamed rather than holding the scan.
const SECURITY_BATCH = 50;
const SECURITY_TIMEOUT_MS = 8_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function unavailableFinding(channel, now) {
  const research = channel === 'research';
  const subject = research ? 'Research assessment' : 'Dashboard monitoring';
  const text = research
    ? 'Current research and portfolio evidence could not be verified. Portfolio issues and new ideas cannot be fully assessed.'
    : 'Dashboard health could not be verified. Connection and research delivery checks are incomplete.';
  return { attentionVersion: 1, id: `attention:assessment:${channel}`, sourceId: `assessment:${channel}`,
    symbol: subject, action: 'verification issue', state: 'open', kind: 'operational', priority: 0,
    assessmentChannel: channel,
    fingerprint: hash([channel, 'unavailable']), publicationTime: now.toISOString(),
    presentation: { subject, date: now.toISOString().slice(0, 10), rows: [{ label: 'Issue', text }], sourceLinks: [] } };
}

function createAttentionWorkflow({ call: workspaceCall, request, now = () => new Date(), fetchJson, collectOperations, evaluateResearch, loadStanceHistory, loadSecurities, loadAlphaCodeLines }) {
  const get = fetchJson || (async (path, { timeoutMs = 45_000 } = {}) => {
    if (!path.startsWith('/api/')) throw new Error('Unexpected attention source');
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error('Dashboard evidence unavailable');
    return response.json();
  });
  const stanceHistory = loadStanceHistory || (() => get(`/api/analyst/stance-ledger?days=${STANCE_HISTORY_DAYS}`));
  const alphaCodeLines = loadAlphaCodeLines || (() => get('/api/analyst/alpha-code-lines', { timeoutMs: 20_000 }));
  const securities = loadSecurities || (async symbols => {
    const batches = [];
    for (let offset = 0; offset < symbols.length; offset += SECURITY_BATCH) batches.push(symbols.slice(offset, offset + SECURITY_BATCH));
    const results = await Promise.allSettled(batches.map(batch => get(`/api/security-universe?fields=identity&symbols=${encodeURIComponent(batch.join(','))}`, { timeoutMs: SECURITY_TIMEOUT_MS })));
    return Object.assign({}, ...results.map(result => (result.status === 'fulfilled' && result.value?.rows) || {}));
  });
  // The stance book this workflow last scored, with the source-enriched events
  // (SOME partials) folded in: what the Inbox stance cards read.
  let scoredStanceBook = null;
  let stanceHistoryAttemptAt = -Infinity;
  let running = null;
  let queuedReset = null;
  let lastStarted = 0;
  let deferredCycles = 0;
  let status = null;
  let enabledCache = null;
  const call = async (operation, body = {}) => {
    // Publishing enables attention mode; any write to the switch invalidates it.
    const writesSwitch = operation === 'attention-publish'
      || (operation === 'setting' && body.key === 'pm-attention-v1' && Object.hasOwn(body, 'value'));
    if (writesSwitch) enabledCache = null;
    try { return await workspaceCall(operation, body); }
    finally { if (writesSwitch) enabledCache = null; }
  };
  const enabled = () => {
    const cached = enabledCache;
    if (cached && now().getTime() - cached.at < ENABLED_CACHE_MS) return cached.promise;
    // Concurrent callers share one read. A write during it clears the entry,
    // so the next caller reads the committed value.
    const entry = { at: now().getTime() };
    entry.promise = call('setting', { key: 'pm-attention-v1' }).then(result => result.value?.enabled === true)
      .catch(error => { if (enabledCache === entry) enabledCache = null; throw error; });
    enabledCache = entry;
    return entry.promise;
  };

  async function stanceBook(events, at) {
    const { foldStanceEvents } = require('./stanceBook.cjs');
    const stored = (await call('setting', { key: STANCE_BOOK_KEY })).value;
    let { book, changed } = foldStanceEvents(stored, events, at);
    if (!book.backfill && at.getTime() - stanceHistoryAttemptAt >= STANCE_HISTORY_RETRY_MS) {
      stanceHistoryAttemptAt = at.getTime();
      try {
        const history = await stanceHistory();
        ({ book } = foldStanceEvents(book, history.events || [], at));
        book.backfill = { from: history.from, through: history.through, at: at.toISOString() };
        changed = true;
      } catch { /* Retried later; today's feed still reaches the book. */ }
    }
    // A failed save keeps the book that was read and folded; the next scan saves it.
    if (changed) await call('setting', { key: STANCE_BOOK_KEY, value: book }).catch(() => {});
    return book;
  }

  // Each scan reads the lines' live prices; unreadable lines or prices leave the
  // stored watch as it stood, so the day's breaks still show.
  async function alphaCodeWatch(at) {
    const { foldAlphaCodeWatch } = require('./alphaCodeWatch.cjs');
    const stored = (await call('setting', { key: ALPHA_CODE_WATCH_KEY })).value || null;
    const current = await alphaCodeLines().catch(() => null);
    if (!current || !Array.isArray(current.lines)) return stored;
    const { watch, changed } = foldAlphaCodeWatch(stored, { marketDate: current.marketDate, lines: current.lines, prices: current.prices || {}, now: at });
    if (changed) await call('setting', { key: ALPHA_CODE_WATCH_KEY, value: watch }).catch(() => {});
    return watch;
  }

  async function scan({ reset = false, events = [] } = {}) {
    const startedAt = now();
    const runId = randomUUID();
    status = { runId, state: 'running', startedAt: startedAt.toISOString(), reset };
    await call('setting', { key: 'pm-attention-status', value: status });
    const retained = (await call('setting', { key: 'attention-source-events' })).value || [];
    const results = await Promise.allSettled([
      (collectOperations || require('./attentionOperations.cjs').collectOperationalAttention)({ fetchJson: get, now: startedAt }),
      // The book updates beside the holdings capture; an unreadable book still
      // lets the evaluation fold the journal it is given.
      Promise.all([stanceBook([...retained, ...events], startedAt).catch(() => undefined),
        request('/internal/workspace/attention-context', { method: 'POST', body: { events: [...retained, ...events] }, timeoutMs: 75_000 }),
        alphaCodeWatch(startedAt).catch(() => null)])
        .then(async ([book, context, alphaCodes]) => {
          // Holdings freshness is judged when the context arrived, not after the name read.
          const at = now();
          const { foldStanceEvents, symbolOf } = require('./stanceBook.cjs');
          const held = [...new Set((context?.holdings?.positions || [])
            .filter(position => position?.category !== 'event_contract' && typeof position?.quantity === 'number' && position.quantity)
            .map(position => symbolOf(position.symbol)).filter(symbol => SECURITY_SYMBOL.test(symbol)))];
          const records = held.length ? await securities(held).catch(() => ({})) : {};
          const scored = foldStanceEvents(book, context?.events || [], at).book;
          // A book that could not be read is folded from today's journal alone; the
          // evaluation still uses it, but the record reports the book unavailable.
          scoredStanceBook = book ? { book: scored, scoredAt: at.toISOString() } : { book: null, scoredAt: at.toISOString(), reason: 'stance-book-unreadable' };
          return (evaluateResearch || require('./attentionResearch.cjs').evaluateResearchAttention)({ ...context, stanceBook: scored, securities: records,
            ...(alphaCodes ? { alphaCodeWatch: alphaCodes } : {}) }, at);
        }),
    ]);
    const findings = [];
    const completeKinds = new Set();
    const completeAssessments = [];
    const diagnostics = [];
    for (const [index, result] of results.entries()) {
      const channel = index === 0 ? 'operations' : 'research';
      if (result.status === 'rejected') {
        findings.push(unavailableFinding(channel, now()));
        // The reason stays in the scan status; the Inbox shows only that the channel is unavailable.
        diagnostics.push({ channel, code: 'ASSESSMENT_UNAVAILABLE', reason: String(result.reason?.message || result.reason || '').slice(0, 300) });
        continue;
      }
      const value = result.value;
      if (!value || !Array.isArray(value.findings)) throw new Error('Invalid attention result');
      findings.push(...value.findings);
      if (value.complete) completeAssessments.push(channel);
      else if (index === 1) findings.push(unavailableFinding('research', now()));
      diagnostics.push(...(Array.isArray(value.diagnostics) ? value.diagnostics : value.diagnostics ? [{ channel, ...value.diagnostics }] : []));
      for (const kind of value.completeKinds || (value.complete ? (index === 0 ? ['operational'] : ['portfolio', 'opportunity', 'market', 'account']) : [])) completeKinds.add(kind);
    }
    const completedAt = now().toISOString();
    const result = await call('attention-publish', { findings, reset, completeKinds: [...completeKinds], completeAssessments, runId, completedAt });
    status = { ...status, state: 'completed', completedAt, count: result.count, cleared: result.cleared,
      completeKinds: [...completeKinds], diagnostics };
    await call('setting', { key: 'pm-attention-status', value: status });
    return status;
  }

  function start(options = {}) {
    if (running) {
      if (!options.reset) return running;
      if (!queuedReset) queuedReset = running.then(() => {
        queuedReset = null;
        return start(options);
      });
      return queuedReset;
    }
    lastStarted = now().getTime();
    deferredCycles = 0;
    running = scan(options).catch(async () => {
      status = { ...status, state: 'failed', completedAt: now().toISOString(), error: 'The assessment could not be saved. The previous Inbox is retained.' };
      await call('setting', { key: 'pm-attention-status', value: status }).catch(() => {});
      return status;
    }).finally(() => { running = null; });
    return running;
  }

  async function tick(events = [], { defer = false } = {}) {
    if (!await enabled()) return null;
    if (running) return running;
    if (now().getTime() - lastStarted < INTERVAL_MS) return null;
    // Let an acquiring review own the broker briefly; the scan still makes its
    // own fresh holdings check and never borrows the review's capture.
    if (defer && deferredCycles < MAX_DEFERRED_CYCLES) {
      deferredCycles += 1;
      lastStarted = now().getTime();
      return null;
    }
    return start({ events });
  }

  return { enabled, start, tick, isRunning: () => Boolean(running), scoredStanceBook: () => scoredStanceBook,
    getStatus: async () => status || (await call('setting', { key: 'pm-attention-status' })).value || { state: 'idle' } };
}

module.exports = { createAttentionWorkflow, unavailableFinding, INTERVAL_MS, MAX_DEFERRED_CYCLES };
