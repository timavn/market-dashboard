const { randomUUID, createHash } = require('node:crypto');

const INTERVAL_MS = 30_000;
// A queued or acquiring review may postpone at most this many scan cycles.
const MAX_DEFERRED_CYCLES = 2;
// Only attention publication writes this switch; re-read it occasionally anyway.
const ENABLED_CACHE_MS = 60_000;
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

function createAttentionWorkflow({ call: workspaceCall, request, now = () => new Date(), fetchJson, collectOperations, evaluateResearch }) {
  const get = fetchJson || (async path => {
    if (!path.startsWith('/api/')) throw new Error('Unexpected attention source');
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${path}`, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error('Dashboard evidence unavailable');
    return response.json();
  });
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

  async function scan({ reset = false, events = [] } = {}) {
    const startedAt = now();
    const runId = randomUUID();
    status = { runId, state: 'running', startedAt: startedAt.toISOString(), reset };
    await call('setting', { key: 'pm-attention-status', value: status });
    const retained = (await call('setting', { key: 'attention-source-events' })).value || [];
    const results = await Promise.allSettled([
      (collectOperations || require('./attentionOperations.cjs').collectOperationalAttention)({ fetchJson: get, now: startedAt }),
      request('/internal/workspace/attention-context', { method: 'POST', body: { events: [...retained, ...events] }, timeoutMs: 75_000 })
        .then(context => (evaluateResearch || require('./attentionResearch.cjs').evaluateResearchAttention)(context, now())),
    ]);
    const findings = [];
    const completeKinds = new Set();
    const completeAssessments = [];
    const diagnostics = [];
    for (const [index, result] of results.entries()) {
      const channel = index === 0 ? 'operations' : 'research';
      if (result.status === 'rejected') {
        findings.push(unavailableFinding(channel, now()));
        diagnostics.push({ channel, code: 'ASSESSMENT_UNAVAILABLE' });
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

  return { enabled, start, tick, isRunning: () => Boolean(running),
    getStatus: async () => status || (await call('setting', { key: 'pm-attention-status' })).value || { state: 'idle' } };
}

module.exports = { createAttentionWorkflow, unavailableFinding, INTERVAL_MS, MAX_DEFERRED_CYCLES };
