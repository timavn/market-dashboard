export const MARKET_QUOTE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const ACTIVE_QUOTE_AVAILABILITIES = new Set(['current', 'delayed']);
const RETAINABLE_QUOTE_AVAILABILITIES = new Set([
  'current',
  'delayed',
  'historical',
  'reference',
]);
const RETAINABLE_QUOTE_SOURCES = new Set(['ibkr', 'yahoo', 'fred', 'stooq', 'derived']);
const FORBIDDEN_RETAINED_EVIDENCE = /(?:mock|seed|seeded|synthetic|inferred|portfolio-derived)/i;

const quoteRowKey = (row) => String(row?.symbol || row?.ticker || '').trim().toUpperCase();

const quoteRowTimestamp = (row) => (
  row?.quoteAsOf || row?.timestamp || row?.asOf || null
);

const canRetainQuoteRow = (row) => {
  const availability = String(row?.availability || '').trim().toLowerCase();
  const source = String(row?.source || row?.provider || '').trim().toLowerCase();
  const evidence = [
    row?.source,
    row?.provider,
    row?.warning,
    row?.error,
    row?.provenance,
  ].filter(Boolean).join(' ');
  return Boolean(
    quoteRowKey(row)
      && row?.price !== ''
      && row?.price != null
      && Number.isFinite(Number(row.price))
      && Number.isFinite(Date.parse(String(quoteRowTimestamp(row) || '')))
      && RETAINABLE_QUOTE_AVAILABILITIES.has(availability)
      && RETAINABLE_QUOTE_SOURCES.has(source)
      && !FORBIDDEN_RETAINED_EVIDENCE.test(evidence)
      && row?.mock !== true
      && row?.seeded !== true
      && row?.synthetic !== true
      && row?.inferred !== true
  );
};

const markQuoteRowRefreshDelayed = (row, reason = 'quote_refresh_delayed') => {
  if (!canRetainQuoteRow(row)) return null;
  if (String(row.availability || '').toLowerCase() === 'historical') return { ...row };
  const lastVerifiedAt = row.lastVerifiedAt || quoteRowTimestamp(row);
  return {
    ...row,
    availability: 'reference',
    freshness: 'refresh-delayed',
    quoteMode: 'last-verified-reference',
    refreshDelayed: true,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    lastVerifiedAt,
    retentionReason: reason,
  };
};

const markNodeRefreshDelayed = (value, reason) => {
  if (Array.isArray(value)) {
    return value
      .map((row) => markQuoteRowRefreshDelayed(row, reason))
      .filter(Boolean);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, markNodeRefreshDelayed(child, reason)]),
  );
};

const reconcileQuoteRows = (previousRows = [], incomingRows = []) => {
  const incomingByKey = new Map(
    incomingRows
      .map((row) => [quoteRowKey(row), row])
      .filter(([key]) => Boolean(key)),
  );
  const consumed = new Set();
  const rows = [];

  previousRows.forEach((previousRow) => {
    const key = quoteRowKey(previousRow);
    const incomingRow = key ? incomingByKey.get(key) : null;
    if (incomingRow) {
      rows.push(incomingRow);
      consumed.add(key);
      return;
    }
    const retained = markQuoteRowRefreshDelayed(previousRow, 'quote_missing_from_refresh');
    if (retained) rows.push(retained);
  });

  incomingRows.forEach((row) => {
    const key = quoteRowKey(row);
    if (!key || !consumed.has(key)) rows.push(row);
  });
  return rows;
};

const reconcileQuoteNode = (previous, incoming) => {
  if (Array.isArray(incoming)) {
    return reconcileQuoteRows(Array.isArray(previous) ? previous : [], incoming);
  }
  if (!incoming || typeof incoming !== 'object') return incoming;
  const previousObject = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? previous
    : {};
  const keys = new Set([...Object.keys(previousObject), ...Object.keys(incoming)]);
  return Object.fromEntries([...keys].map((key) => {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) {
      return [key, markNodeRefreshDelayed(previousObject[key], 'region_missing_from_refresh')];
    }
    return [key, reconcileQuoteNode(previousObject[key], incoming[key])];
  }));
};

/**
 * Preserve a previously verified observation when a partial provider refresh
 * omits that symbol. The retained row is explicitly demoted to a display-only
 * delayed reference and is replaced atomically when the symbol returns.
 */
export const reconcileMarketQuotePayload = ({ currentData, incomingData }) => (
  reconcileQuoteNode(currentData, incomingData)
);

/** Demote a retained whole-resource snapshot after its refresh fails/expires. */
export const markMarketQuotePayloadRefreshDelayed = (
  payload,
  reason = 'market_quote_refresh_delayed',
) => markNodeRefreshDelayed(payload, reason);

export const collectMarketRows = (value, rows = []) => {
  if (Array.isArray(value)) {
    value.forEach((row) => {
      if (row && typeof row === 'object') rows.push(row);
    });
    return rows;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((child) => collectMarketRows(child, rows));
  }
  return rows;
};

export const marketPayloadObservedAt = (payload, { periodOnly = false } = {}) => {
  const timestamps = collectMarketRows(payload)
    .filter((row) => (
      periodOnly
      || ACTIVE_QUOTE_AVAILABILITIES.has(String(row?.availability || '').trim().toLowerCase())
    ))
    .map((row) => periodOnly
      ? row.periodReturnsAsOf
      : row.quoteAsOf || row.timestamp)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
};

export const validateMarketQuotePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || !marketPayloadObservedAt(payload)) {
    throw Object.assign(
      new Error('The market quote response had no authoritative current or delayed observations.'),
      {
        code: 'MARKET_QUOTES_EVIDENCE_MISSING',
        liveInvalidation: true,
      },
    );
  }
  return payload;
};

export const validatePeriodReturnPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || !marketPayloadObservedAt(payload, { periodOnly: true })) {
    throw new Error('Dated period-return observations are unavailable.');
  }
  return payload;
};
