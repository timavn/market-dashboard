const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { expectedSizingSession } = require('../../utils/volatilitySizingBand.cjs');
const { isTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');
const { scopeCoverage } = require('./pcaScope.cjs');

const DEFAULT_CONFIG = Object.freeze({ window: 126, warnThreshold: 0.35, highThreshold: 0.5 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defaultStateDir = () => process.env.PORTFOLIO_PCA_STATE_DIR || path.join(os.homedir(),
  process.platform === 'darwin' ? 'Library/Application Support/market-dashboard' : '.local/state/market-dashboard', 'portfolio-pca');

function validationError(message, code = 'invalid_request', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validateConfig(input = {}, prior = DEFAULT_CONFIG) {
  const config = { ...prior };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (input[key] !== undefined) config[key] = Number(input[key]);
  }
  if (!Number.isInteger(config.window) || config.window < 63 || config.window > 504) {
    throw validationError('Choose a window from 63 to 504 trading days.');
  }
  if (!(config.warnThreshold > 0 && config.warnThreshold < config.highThreshold && config.highThreshold <= 1)) {
    throw validationError('Warning must be below high concentration, with both above 0% and at most 100%.');
  }
  return config;
}

function accountKey(value) {
  if (value == null || value === '') return 'default';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw validationError('Choose a valid account.');
  }
  return value;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  const { evidence: _evidence, model, ...publicFields } = snapshot;
  const { fit: _fit, ...publicModel } = model;
  return { ...publicFields, coverage: scopeCoverage(snapshot.coverage), historicalOnly: true, executable: false, model: publicModel };
}

function easternClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function createPcaService({ dataSource, stateDir = defaultStateDir(), now = () => new Date(),
  modelBuilder, scenarioBuilder, defaultAccount = process.env.IBKR_ACCOUNT_ID } = {}) {
  // Lazy dependency resolution keeps store/worker tests independent of the solver.
  const build = modelBuilder || (input => require('./pcaModel.cjs').buildPcaModel(input));
  const compareModel = scenarioBuilder || (input => require('./pcaModel.cjs').comparePcaScenario(input));
  const pending = new Map();
  const attempts = new Map();
  const accounts = new Set([accountKey(defaultAccount)]);
  const writes = new Map();
  const configWrites = new Map();
  const configuredDefault = accountKey(defaultAccount);
  const aliasFile = path.join(stateDir, 'default-account.json');
  let learnedDefault = null;
  let aliasReady;
  let aliasWrite = Promise.resolve();
  let timer = null;
  let ticking = false;
  const folder = account => path.join(stateDir, hash(accountKey(account)).slice(0, 24));
  const keyFor = (account, window) => `${accountKey(account)}:${window}`;
  const configFile = account => path.join(folder(account), 'config.json');
  const manifestFile = account => path.join(folder(account), 'manifest.json');
  const snapshotFile = (account, id) => path.join(folder(account), 'snapshots', `${id}.json`);
  function requirePostClose(reason) {
    const clock = easternClock(now());
    if (!isTradingDateKey(clock.date) || clock.minute < 17 * 60 + 30) {
      throw validationError('Build a snapshot after 17:30 New York on a trading day. Saved snapshots remain available.', 'post_close_required', 422);
    }
    if (reason !== 'manual' && clock.minute > 20 * 60) {
      throw validationError('Automatic PCA snapshots run from 17:30 to 20:00 New York on trading days. Saved snapshots remain available.', 'post_close_required', 422);
    }
  }
  async function loadDefaultAlias() {
    if (!aliasReady) aliasReady = readJson(aliasFile).then(saved => {
      if (!saved) return;
      const verifiedAccount = accountKey(saved.accountId);
      if (verifiedAccount === 'default' || saved.source !== 'verified-portfolio-capture') {
        throw validationError('The saved default account could not be verified.', 'account_mismatch', 422);
      }
      learnedDefault = verifiedAccount;
      accounts.delete('default');
      accounts.add(verifiedAccount);
    });
    await aliasReady;
  }

  async function resolveAccount(value) {
    const requested = accountKey(value);
    if (requested !== 'default') return requested;
    if (configuredDefault !== 'default') return configuredDefault;
    await loadDefaultAlias();
    return learnedDefault || 'default';
  }

  async function bindDefaultAccount(accountId, selected) {
    const canonical = accountKey(accountId);
    if (canonical === 'default') throw validationError('The captured account identity is unavailable.', 'account_mismatch', 422);
    const task = aliasWrite.catch(() => {}).then(async () => {
      await loadDefaultAlias();
      if (learnedDefault && learnedDefault !== canonical) {
        throw validationError('The captured default account changed during this refresh.', 'account_mismatch', 422);
      }
      if (!learnedDefault) {
        // Keep account-specific preferences. An initial default capture can have a
        // different window, and must remain stored with that captured window.
        const before = configWrites.get(canonical) || Promise.resolve();
        const configTask = before.catch(() => {}).then(async () => {
          if (!await readJson(configFile(canonical))) {
            const inherited = await readJson(configFile('default'));
            await atomicJson(configFile(canonical), validateConfig(inherited || selected));
          }
        });
        configWrites.set(canonical, configTask);
        try { await configTask; } finally { if (configWrites.get(canonical) === configTask) configWrites.delete(canonical); }
        await atomicJson(aliasFile, { accountId: canonical, source: 'verified-portfolio-capture', verifiedAt: now().toISOString() });
        learnedDefault = canonical;
      }
      accounts.delete('default');
      accounts.add(canonical);
      const originalKey = keyFor('default', selected.window);
      const canonicalKey = keyFor(canonical, selected.window);
      if (pending.has(originalKey) && !pending.has(canonicalKey)) pending.set(canonicalKey, pending.get(originalKey));
      return canonical;
    });
    aliasWrite = task;
    return task;
  }

  async function saveManifest(account, row) {
    const before = writes.get(account) || Promise.resolve();
    const task = before.catch(() => {}).then(async () => {
      const manifest = await readJson(manifestFile(account), { snapshots: [] });
      await atomicJson(manifestFile(account), { accountKey: account, snapshots: [row, ...manifest.snapshots.filter(item => item.id !== row.id)] });
    });
    writes.set(account, task);
    try { await task; } finally { if (writes.get(account) === task) writes.delete(account); }
  }

  async function config(account) {
    const normalized = await resolveAccount(account);
    accounts.add(normalized);
    return validateConfig(await readJson(configFile(normalized), {}));
  }

  async function saveConfig(account, input) {
    const normalized = await resolveAccount(account);
    const before = configWrites.get(normalized) || Promise.resolve();
    const task = before.catch(() => {}).then(async () => {
      const next = validateConfig(input, await config(normalized));
      await atomicJson(configFile(normalized), next);
      return next;
    });
    configWrites.set(normalized, task);
    try { return await task; } finally { if (configWrites.get(normalized) === task) configWrites.delete(normalized); }
  }

  async function readSnapshot(account, { window, id } = {}) {
    const normalized = await resolveAccount(account);
    if (id && !/^[a-f0-9]{64}$/.test(id)) throw validationError('Choose a valid PCA snapshot.');
    const manifest = await readJson(manifestFile(normalized), { snapshots: [] });
    const entry = manifest.snapshots.find(row => id ? row.id === id : row.window === window);
    return entry ? readJson(snapshotFile(normalized, entry.id)) : null;
  }

  async function snapshot({ account, window, id } = {}) {
    const normalized = await resolveAccount(account);
    const selected = validateConfig(window == null ? {} : { window }, await config(normalized));
    const saved = await readSnapshot(normalized, { window: selected.window, id });
    const report = publicSnapshot(saved);
    const key = keyFor(normalized, selected.window);
    const latestAttempt = attempts.get(key) || await readJson(path.join(folder(normalized), `attempt-${selected.window}.json`));
    return {
      status: report ? report.coverage.complete ? 'available' : 'partial' : 'unavailable',
      historicalOnly: true, executable: false, snapshot: report, config: selected,
      pending: pending.has(key), latestAttempt,
      latestCompletedSession: expectedSizingSession(now().getTime()),
      schedule: { time: '17:30', timeZone: 'America/New_York', retryUntil: '20:00' },
    };
  }

  async function recordAttempt(account, window, attempt) {
    attempts.set(keyFor(account, window), attempt);
    await atomicJson(path.join(folder(account), `attempt-${window}.json`), attempt);
  }

  async function buildSnapshot(account, selected, reason) {
    const startedAt = now().toISOString();
    const sessionDate = expectedSizingSession(now().getTime());
    await recordAttempt(account, selected.window, { status: 'pending', startedAt, sessionDate, reason });
    try {
      const input = await dataSource.capture({ account: account === 'default' ? undefined : account, window: selected.window, sessionDate });
      const capturedAccount = accountKey(input.accountId);
      if (capturedAccount === 'default' || (account !== 'default' && capturedAccount !== account)) {
        throw validationError('The captured account does not match this portfolio.', 'account_mismatch', 422);
      }
      if (account === 'default') {
        account = await bindDefaultAccount(capturedAccount, selected);
        await recordAttempt(account, selected.window, { status: 'pending', startedAt, sessionDate, reason });
      }
      if (!input.assets.length) throw validationError('No holdings have complete verified daily history and valuations.', 'no_covered_holdings', 422);
      const previous = await readSnapshot(account, { window: selected.window });
      const model = build({ ...input, config: selected, previousModel: previous?.model });
      // Holdings observation times remain metadata, not revision keys. Equal
      // economic inputs produce one reproducible report despite repeated refreshes.
      const byIdentity = rows => [...(rows || [])].sort((a, b) => JSON.stringify([a.id, a.symbol, a.reason]).localeCompare(JSON.stringify([b.id, b.symbol, b.reason])));
      const id = hash({ accountId: input.accountId, sessionDate, config: selected,
        assets: byIdentity(input.assets), dates: input.dates, references: byIdentity(input.references),
        coverage: { ...input.coverage, excluded: byIdentity(input.coverage.excluded), outOfScope: byIdentity(input.coverage.outOfScope) }, modelVersion: model.modelVersion });
      const existing = await readSnapshot(account, { id });
      if (!existing) {
        const saved = { id, accountId: input.accountId, sessionDate, generatedAt: now().toISOString(),
          config: selected, provenance: input.provenance, coverage: input.coverage,
          evidence: input.evidence, model, historicalOnly: true, executable: false };
        await atomicJson(snapshotFile(account, id), saved);
      }
      await saveManifest(account, { id, window: selected.window, sessionDate, generatedAt: existing?.generatedAt || now().toISOString() });
      await recordAttempt(account, selected.window, { status: 'complete', startedAt, completedAt: now().toISOString(), sessionDate, reason, snapshotId: id });
    } catch (error) {
      // Do not expose raw vendor errors, account responses or filesystem paths.
      await recordAttempt(account, selected.window, { status: 'failed', startedAt, completedAt: now().toISOString(), sessionDate, reason,
        code: /^[a-z0-9_-]+$/i.test(error.code || '') ? error.code : 'pca_unavailable',
        message: 'The latest PCA snapshot is unavailable. Check portfolio and daily-history coverage, then retry.' });
    }
    return snapshot({ account, window: selected.window });
  }

  async function refresh({ account, window, reason = 'manual' } = {}) {
    requirePostClose(reason);
    const normalized = await resolveAccount(account);
    const selected = validateConfig(window == null ? {} : { window }, await config(normalized));
    const key = keyFor(normalized, selected.window);
    if (!pending.has(key)) {
      const task = buildSnapshot(normalized, selected, reason).finally(() => {
        for (const [pendingKey, pendingTask] of pending) if (pendingTask === task) pending.delete(pendingKey);
      });
      pending.set(key, task);
      // Routes return immediately; polling observes a terminal attempt even if
      // disk failure prevents saving the normal failure record.
      task.catch(() => attempts.set(keyFor(normalized === 'default' ? learnedDefault || normalized : normalized, selected.window), { status: 'failed', completedAt: now().toISOString(),
        code: 'storage_unavailable', message: 'PCA storage is unavailable.' }));
    }
    return snapshot({ account: normalized, window: selected.window });
  }

  async function waitForRefresh({ account, window } = {}) {
    const normalized = await resolveAccount(account);
    const selected = validateConfig(window == null ? {} : { window }, await config(normalized));
    await pending.get(keyFor(normalized, selected.window));
    return snapshot({ account: normalized, window: selected.window });
  }

  async function compare({ account, snapshotId, name = 'Scenario', changes } = {}) {
    const normalized = await resolveAccount(account);
    if (!snapshotId) throw validationError('Build or select a PCA snapshot first.');
    const saved = await readSnapshot(normalized, { id: snapshotId });
    if (!saved) throw validationError('This PCA snapshot is unavailable for the selected account.', 'snapshot_not_found', 404);
    if (!Array.isArray(changes) || !changes.length || changes.length > 50) throw validationError('Enter between 1 and 50 candidate changes.');
    const changesBySymbol = new Map();
    for (const change of changes) {
      const symbol = String(change.symbol || '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9.=-]{0,23}$/.test(symbol) || typeof change.deltaWeight !== 'number' || !Number.isFinite(change.deltaWeight)) {
        throw validationError('Each candidate needs a valid ticker and signed NAV weight change.');
      }
      changesBySymbol.set(symbol, (changesBySymbol.get(symbol) || 0) + change.deltaWeight);
    }
    const holdings = new Map(saved.model.holdings.map(row => [row.symbol, row]));
    const missing = [...changesBySymbol.keys()].filter(symbol => !holdings.has(symbol));
    const candidates = missing.length ? await dataSource.candidates({ symbols: missing,
      dates: saved.model.dates, sessionDate: saved.sessionDate, window: saved.config.window }) : [];
    const identities = new Map([...holdings, ...candidates.map(row => [row.symbol, row])]);
    const deltas = [...changesBySymbol].map(([symbol, deltaWeight]) => {
      const identity = identities.get(symbol);
      if (!identity) throw validationError(`Verified history is unavailable for ${symbol}.`, 'candidate_unavailable', 422);
      return { id: identity.id, deltaWeight };
    });
    let result;
    try { result = compareModel({ model: saved.model, changes: deltas, candidates }); }
    catch (_) { throw validationError('The candidate cannot be compared on this snapshot’s complete dates.', 'candidate_unavailable', 422); }
    return { ...result, snapshotId, name: String(name).slice(0, 80), sessionDate: saved.sessionDate,
      coverage: scopeCoverage(saved.coverage), historicalOnly: true, executable: false };
  }

  async function history({ account, window } = {}) {
    const normalized = await resolveAccount(account);
    const selected = validateConfig(window == null ? {} : { window }, await config(normalized));
    const manifest = await readJson(manifestFile(normalized), { snapshots: [] });
    return manifest.snapshots.filter(row => row.window === selected.window).slice(0, 90);
  }

  async function tick({ startup = false } = {}) {
    if (ticking) return;
    ticking = true;
    try {
      const clock = easternClock(now());
      const due = isTradingDateKey(clock.date) && clock.minute >= 17 * 60 + 30 && clock.minute <= 20 * 60;
      if (!due) return;
      // Restore accounts registered before a restart without exposing raw account IDs in directory names.
      for (const directory of await fs.readdir(stateDir, { withFileTypes: true }).catch(() => [])) {
        if (!directory.isDirectory() || !/^[a-f0-9]{24}$/.test(directory.name)) continue;
        const manifest = await readJson(path.join(stateDir, directory.name, 'manifest.json'));
        if (manifest?.accountKey) accounts.add(await resolveAccount(manifest.accountKey));
      }
      for (const account of accounts) {
        const currentAccount = await resolveAccount(account);
        const current = await snapshot({ account: currentAccount });
        const last = current.latestAttempt;
        const complete = currentAccount !== 'default' && last?.status === 'complete' && last.sessionDate === current.latestCompletedSession
          && current.snapshot?.coverage.complete === true
          && current.snapshot?.config.warnThreshold === current.config.warnThreshold
          && current.snapshot?.config.highThreshold === current.config.highThreshold;
        const tooSoon = last?.completedAt && now().getTime() - Date.parse(last.completedAt) < 15 * 60 * 1000;
        if (!current.pending && !complete && !tooSoon) await refresh({ account: currentAccount, reason: startup ? 'startup' : 'scheduled' });
      }
    } finally { ticking = false; }
  }

  return { config, saveConfig, snapshot, refresh, waitForRefresh, compare, history, tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
      timer.unref?.();
      tick({ startup: true }).catch(() => {});
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createPcaService, validateConfig, DEFAULT_CONFIG, publicSnapshot, easternClock };
