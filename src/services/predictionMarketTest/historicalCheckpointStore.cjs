const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIRECTIONAL_FEEDS } = require('./directionalFeedRegistry.cjs');

const CHECKPOINT_SCHEMA_VERSION = 1;
const MAX_SESSIONS = 30;
const FORBIDDEN_PROVENANCE = /(?:mock|seed|fixture|fallback|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived|yahoo)/i;

function defaultStateDirectory() {
  if (process.env.PREDICTION_MONITOR_STATE_DIR) {
    return path.resolve(process.env.PREDICTION_MONITOR_STATE_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'market-dashboard', 'prediction-monitor');
  }
  return path.join(os.homedir(), '.local', 'state', 'market-dashboard', 'prediction-monitor');
}

function emptyState() {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    updatedAt: null,
    selections: {},
    histories: {},
  };
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseBarTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.length === 10 ? numeric * 1000 : numeric;
  }
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?/);
  if (compact) {
    const timestamp = Date.parse(`${compact[1]}-${compact[2]}-${compact[3]}T${String(compact[4] || '00').padStart(2, '0')}:${compact[5] || '00'}:${compact[6] || '00'}.000Z`);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const normalized = text.replace(' ', 'T').replace(/\s+[A-Za-z/_-]+$/, 'Z');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionDate(value) {
  const text = String(value || '').trim();
  const compact = text.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const parsed = parseBarTimestamp(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function validContractIdentity(marketId, contract) {
  const definition = DIRECTIONAL_FEEDS[marketId];
  if (!definition || definition.provider !== 'ibkr') return false;
  const conId = finiteInteger(contract?.conId ?? contract?.conid);
  const root = String(contract?.symbol || contract?.ibkrSymbol || '').toUpperCase();
  const localSymbol = String(contract?.localSymbol || contract?.displaySymbol || '').toUpperCase();
  const expiry = String(contract?.lastTradeDateOrContractMonth || contract?.lastTradeDate || '');
  return conId !== null
    && root === definition.root
    && (!localSymbol || localSymbol.startsWith(definition.root))
    && /^\d{6,8}$/.test(expiry)
    && String(contract?.provider || 'ibkr').toLowerCase() === 'ibkr';
}

function normalizeContract(marketId, contract) {
  if (!validContractIdentity(marketId, contract)) return null;
  const definition = DIRECTIONAL_FEEDS[marketId];
  return {
    provider: 'ibkr',
    symbol: definition.root,
    ibkrSymbol: definition.root,
    displaySymbol: String(contract.localSymbol || contract.displaySymbol || definition.root).toUpperCase(),
    localSymbol: String(contract.localSymbol || contract.displaySymbol || '').toUpperCase() || null,
    conId: finiteInteger(contract.conId ?? contract.conid),
    secType: 'FUT',
    exchange: String(contract.exchange || definition.exchange).toUpperCase(),
    currency: String(contract.currency || definition.currency).toUpperCase(),
    multiplier: String(contract.multiplier || definition.multiplier),
    lastTradeDateOrContractMonth: String(contract.lastTradeDateOrContractMonth || contract.lastTradeDate),
    tradingClass: String(contract.tradingClass || '').trim() || null,
  };
}

function normalizePersistableBars(bars, { nowMs, completedThroughDate, interval }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(completedThroughDate || ''))) return [];
  const safe = (Array.isArray(bars) ? bars : []).map((bar) => {
    const rawDate = bar?.date ?? bar?.timestamp ?? bar?.time;
    const timestamp = parseBarTimestamp(rawDate);
    const date = sessionDate(rawDate);
    const close = Number(bar?.close ?? bar?.value);
    if (!Number.isFinite(timestamp) || timestamp > nowMs + 5_000 || !date || date > completedThroughDate || !Number.isFinite(close)) return null;
    return {
      date: rawDate,
      open: Number.isFinite(Number(bar?.open)) ? Number(bar.open) : close,
      high: Number.isFinite(Number(bar?.high)) ? Number(bar.high) : close,
      low: Number.isFinite(Number(bar?.low)) ? Number(bar.low) : close,
      close,
      volume: Number.isFinite(Number(bar?.volume)) ? Number(bar.volume) : null,
      _timestamp: timestamp,
      _sessionDate: date,
    };
  }).filter(Boolean).sort((left, right) => left._timestamp - right._timestamp);
  const sessionDates = [...new Set(safe.map((bar) => bar._sessionDate))].slice(-MAX_SESSIONS);
  const allowed = new Set(sessionDates);
  const minimumPerSession = interval === '1d' ? 1 : 2;
  const counts = safe.reduce((map, bar) => map.set(bar._sessionDate, (map.get(bar._sessionDate) || 0) + 1), new Map());
  const completeDates = sessionDates.filter((date) => (counts.get(date) || 0) >= minimumPerSession);
  const complete = new Set(completeDates);
  return safe.filter((bar) => allowed.has(bar._sessionDate) && complete.has(bar._sessionDate)).map((bar) => {
    const { _timestamp, _sessionDate, ...persisted } = bar;
    return persisted;
  });
}

function createHistoricalCheckpointStore({
  stateDirectory = defaultStateDirectory(),
  filename = 'directional-history-v1.json',
  now = Date.now,
  logger = console,
} = {}) {
  const filePath = path.join(stateDirectory, filename);
  let memory = null;
  let tempSequence = 0;

  function readState() {
    if (memory) return memory;
    try {
      if (!fs.existsSync(filePath)) {
        memory = emptyState();
        return memory;
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed?.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
        || typeof parsed?.selections !== 'object'
        || typeof parsed?.histories !== 'object') {
        throw new Error('unsupported checkpoint schema');
      }
      memory = parsed;
    } catch (error) {
      logger?.warn?.(`[Prediction Monitor] Ignoring invalid directional checkpoint: ${error.message}`);
      memory = emptyState();
    }
    return memory;
  }

  function atomicWrite(next) {
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDirectory, 0o700);
    tempSequence += 1;
    const tempPath = path.join(stateDirectory, `.${filename}.${process.pid}.${tempSequence}.tmp`);
    const descriptor = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(next)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    const directoryDescriptor = fs.openSync(stateDirectory, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    memory = next;
  }

  function saveSelection(marketId, contract, rollReason) {
    const normalized = normalizeContract(marketId, contract);
    if (!normalized) return false;
    const reason = String(rollReason || '').trim().slice(0, 160);
    if (!reason || FORBIDDEN_PROVENANCE.test(reason)) return false;
    const state = readState();
    const next = {
      ...state,
      updatedAt: new Date(Number(now())).toISOString(),
      selections: {
        ...state.selections,
        [marketId]: { ...normalized, selectedAt: new Date(Number(now())).toISOString(), rollReason: reason },
      },
    };
    atomicWrite(next);
    return true;
  }

  function loadSelection(marketId) {
    const selection = readState().selections?.[marketId];
    const normalized = normalizeContract(marketId, selection);
    if (!normalized || FORBIDDEN_PROVENANCE.test(String(selection?.rollReason || ''))) return null;
    const expiry = String(normalized.lastTradeDateOrContractMonth || '').match(/^(\d{4})(\d{2})(\d{2})/);
    if (expiry) {
      const expiryMs = Date.parse(`${expiry[1]}-${expiry[2]}-${expiry[3]}T23:59:59.999Z`);
      if (!Number.isFinite(expiryMs) || expiryMs < Number(now())) return null;
    }
    return { ...normalized, selectedAt: selection.selectedAt || null, rollReason: selection.rollReason || 'restored_verified_identity' };
  }

  function historyKey(marketId, conId, interval) {
    return `${marketId}:${conId}:${interval}`;
  }

  function saveHistory({ marketId, contract, interval, bars, sourceTimestamp, completedThroughDate, provenance = 'ibkr' }) {
    const normalized = normalizeContract(marketId, contract);
    if (!normalized || !['5m', '1h', '1d'].includes(interval) || FORBIDDEN_PROVENANCE.test(String(provenance || ''))) return false;
    const sourceMs = Date.parse(String(sourceTimestamp || ''));
    const nowMs = Number(now());
    if (!Number.isFinite(sourceMs) || sourceMs > nowMs + 5_000) return false;
    const completedBars = normalizePersistableBars(bars, { nowMs, completedThroughDate, interval });
    const sessions = [...new Set(completedBars.map((bar) => sessionDate(bar.date)))].filter(Boolean);
    if (completedBars.length < 2 || sessions.at(-1) !== completedThroughDate) return false;
    const key = historyKey(marketId, normalized.conId, interval);
    const state = readState();
    const next = {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      histories: {
        ...state.histories,
        [key]: {
          schemaVersion: CHECKPOINT_SCHEMA_VERSION,
          marketId,
          provider: 'ibkr',
          contract: normalized,
          interval,
          sourceTimestamp: new Date(sourceMs).toISOString(),
          completedThroughDate,
          completedSessionDates: sessions,
          provenance: 'verified_completed_ibkr_history',
          bars: completedBars,
        },
      },
    };
    atomicWrite(next);
    return true;
  }

  function loadHistory({ marketId, contract, interval, completedThroughDate }) {
    const normalized = normalizeContract(marketId, contract);
    if (!normalized) return null;
    const entry = readState().histories?.[historyKey(marketId, normalized.conId, interval)];
    if (!entry || entry.provider !== 'ibkr' || entry.interval !== interval
      || entry.completedThroughDate !== completedThroughDate
      || FORBIDDEN_PROVENANCE.test(String(entry.provenance || ''))
      || !validContractIdentity(marketId, entry.contract)
      || finiteInteger(entry.contract?.conId) !== normalized.conId) return null;
    const nowMs = Number(now());
    const bars = normalizePersistableBars(entry.bars, { nowMs, completedThroughDate, interval });
    const sessions = [...new Set(bars.map((bar) => sessionDate(bar.date)))].filter(Boolean);
    if (bars.length < 2 || sessions.at(-1) !== completedThroughDate) return null;
    return {
      source: 'ibkr_completed_history_checkpoint',
      asOf: entry.sourceTimestamp,
      bars,
      contract: { ...entry.contract },
      completedThroughDate,
      restoredFromCheckpoint: true,
      executable: false,
    };
  }

  function getHealth() {
    const state = readState();
    return {
      status: 'available',
      path: filePath,
      schemaVersion: state.schemaVersion,
      updatedAt: state.updatedAt,
      selectedMarkets: Object.keys(state.selections || {}).length,
      historySeries: Object.keys(state.histories || {}).length,
    };
  }

  return { filePath, getHealth, loadHistory, loadSelection, saveHistory, saveSelection };
}

module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  FORBIDDEN_PROVENANCE,
  MAX_SESSIONS,
  createHistoricalCheckpointStore,
  defaultStateDirectory,
  parseBarTimestamp,
};
