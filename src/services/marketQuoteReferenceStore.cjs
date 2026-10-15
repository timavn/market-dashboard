const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'last-verified-v1.json';
const { isVerifiedProviderRow, markRetainedReference, rowTimestamp } = require('../utils/marketQuoteReference.cjs');
const {
  PERIOD_RETURN_FIELDS,
  PERIOD_RETURN_BPS_FIELDS,
  PERIOD_RETURN_REFERENCE_FIELDS,
  PERIOD_RETURN_METADATA_FIELDS,
  mergeMarketRowPreservingPeriods,
} = require('../utils/dashboardMarketPeriods.cjs');

const PERIOD_FIELDS = [
  ...PERIOD_RETURN_FIELDS,
  ...PERIOD_RETURN_BPS_FIELDS,
  ...PERIOD_RETURN_REFERENCE_FIELDS,
  ...PERIOD_RETURN_METADATA_FIELDS,
];

const emptySnapshot = () => ({
  schemaVersion: SCHEMA_VERSION,
  updatedAt: null,
  modes: {
    current: {},
    periods: {},
  },
});

const rowTimestampMs = (row) => Date.parse(String(rowTimestamp(row) || ''));

const normalizeSymbol = (value) => String(value || '').trim().toUpperCase();

const mergeLatestPeriodObservation = (quoteRow, candidates, currentTime) => {
  const periods = candidates.filter((row) => (
    isVerifiedProviderRow(row, currentTime)
      && row.periodReturnsStatus === 'historical'
      && Number.isFinite(Date.parse(String(row.periodReturnsAsOf || '')))
      && Date.parse(row.periodReturnsAsOf) <= currentTime + 5 * 60 * 1000
  )).sort((left, right) => Date.parse(left.periodReturnsAsOf) - Date.parse(right.periodReturnsAsOf));

  // Quote refreshes and daily histories have independent clocks and providers.
  // Preserve each compatible historical field with its original provenance,
  // without advancing its date to the quote date.
  const quoteOnly = { ...quoteRow };
  PERIOD_FIELDS.forEach((field) => delete quoteOnly[field]);
  const compatible = periods.filter((candidate) => (
    mergeMarketRowPreservingPeriods(candidate, quoteOnly).periodReturnsAsOf === candidate.periodReturnsAsOf
  ));
  const history = compatible.reduce((previous, candidate) => (
    mergeMarketRowPreservingPeriods(previous, candidate)
  ), null);
  if (!history) return quoteOnly;
  const merged = mergeMarketRowPreservingPeriods(history, quoteOnly);
  PERIOD_FIELDS.forEach((field) => {
    if (Object.hasOwn(history, field)) merged[field] = history[field];
  });
  return merged;
};

const sanitizeStoredRow = (row) => {
  if (!row || typeof row !== 'object') return null;
  const symbol = normalizeSymbol(row.symbol || row.ticker);
  if (!symbol) return null;
  const lastVerifiedAt = rowTimestamp(row);
  return {
    ...row,
    symbol,
    timestamp: lastVerifiedAt,
    quoteAsOf: lastVerifiedAt,
    lastVerifiedAt,
    displayOnly: true,
    executable: false,
  };
};

const safeReadSnapshot = (fileSystem, filePath) => {
  try {
    if (!fileSystem.existsSync(filePath)) return emptySnapshot();
    const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    if (
      !parsed
      || parsed.schemaVersion !== SCHEMA_VERSION
      || !parsed.modes
      || typeof parsed.modes !== 'object'
    ) return emptySnapshot();
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: parsed.updatedAt || null,
      modes: {
        current: parsed.modes.current && typeof parsed.modes.current === 'object'
          ? parsed.modes.current
          : {},
        periods: parsed.modes.periods && typeof parsed.modes.periods === 'object'
          ? parsed.modes.periods
          : {},
      },
    };
  } catch {
    return emptySnapshot();
  }
};

function createMarketQuoteReferenceStore({
  dataDir = path.join(process.cwd(), 'data', 'market-quotes-reference'),
  fileSystem = fs,
  now = () => Date.now(),
} = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const filePath = path.join(resolvedDataDir, FILE_NAME);
  let snapshot = safeReadSnapshot(fileSystem, filePath);
  let dirty = false;

  const ensureScope = (mode, scope) => {
    const normalizedMode = mode === 'periods' ? 'periods' : 'current';
    const normalizedScope = String(scope || '').trim();
    if (!snapshot.modes[normalizedMode][normalizedScope]) {
      snapshot.modes[normalizedMode][normalizedScope] = {};
    }
    return snapshot.modes[normalizedMode][normalizedScope];
  };

  const reconcileRows = ({
    mode = 'current',
    scope,
    incomingRows = [],
    expectedSymbols = [],
    retentionReason = 'provider_refresh_unavailable',
  } = {}) => {
    const currentTime = Number(now());
    const storedBySymbol = ensureScope(mode, scope);
    const incomingBySymbol = new Map(
      (Array.isArray(incomingRows) ? incomingRows : [])
        .map((row) => [normalizeSymbol(row?.symbol || row?.ticker), row])
        .filter(([symbol, row]) => symbol && isVerifiedProviderRow(row, currentTime)),
    );
    const orderedSymbols = [...new Set(
      (Array.isArray(expectedSymbols) ? expectedSymbols : [])
        .map(normalizeSymbol)
        .filter(Boolean),
    )];
    incomingBySymbol.forEach((_, symbol) => {
      if (!orderedSymbols.includes(symbol)) orderedSymbols.push(symbol);
    });

    const output = [];
    orderedSymbols.forEach((symbol) => {
      const incoming = incomingBySymbol.get(symbol) || null;
      // Either mode may contain the last verified quote or history. A current
      // refresh must save the merged reading so a later period failure or API
      // restart cannot erase a successfully observed index timeframe.
      const storedCandidates = [
        snapshot.modes.current[scope]?.[symbol],
        snapshot.modes.periods[scope]?.[symbol],
      ].filter((candidate) => isVerifiedProviderRow(candidate, currentTime));
      const stored = storedCandidates.slice()
        .sort((left, right) => rowTimestampMs(right) - rowTimestampMs(left))[0];
      const storedIsValid = isVerifiedProviderRow(stored, currentTime);
      const incomingTime = incoming ? rowTimestampMs(incoming) : NaN;
      const storedTime = storedIsValid ? rowTimestampMs(stored) : NaN;

      if (incoming && (!storedIsValid || incomingTime >= storedTime)) {
        const merged = mergeLatestPeriodObservation(incoming, [...storedCandidates, incoming], currentTime);
        const nextStored = sanitizeStoredRow(merged);
        storedBySymbol[symbol] = nextStored;
        dirty = true;
        output.push(merged);
        return;
      }

      if (storedIsValid) {
        const merged = mergeLatestPeriodObservation(stored, [...storedCandidates, incoming].filter(Boolean), currentTime);
        const nextStored = sanitizeStoredRow(merged);
        if (JSON.stringify(storedBySymbol[symbol]) !== JSON.stringify(nextStored)) {
          storedBySymbol[symbol] = nextStored;
          dirty = true;
        }
        const reason = incoming && incomingTime < storedTime
          ? 'provider_observation_older_than_last_verified'
          : retentionReason;
        const retained = markRetainedReference(merged, reason, currentTime);
        if (retained) output.push(retained);
      }
    });

    return output;
  };

  const flush = () => {
    if (!dirty) return false;
    const persistedAt = new Date(Number(now())).toISOString();
    snapshot.updatedAt = persistedAt;
    fileSystem.mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
    try {
      fileSystem.chmodSync(resolvedDataDir, 0o700);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fileSystem.renameSync(temporaryPath, filePath);
    try {
      fileSystem.chmodSync(filePath, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
    dirty = false;
    return true;
  };

  return {
    filePath,
    flush,
    reconcileRows,
    snapshot: () => JSON.parse(JSON.stringify(snapshot)),
  };
}

module.exports = {
  FILE_NAME,
  SCHEMA_VERSION,
  createMarketQuoteReferenceStore,
  isVerifiedProviderRow,
  markRetainedReference,
  rowTimestamp,
};
