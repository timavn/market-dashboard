import { isRetainedQuoteReference, isVerifiedProviderRow, markRetainedReference } from './marketQuoteReference.cjs';
import { mergeMarketRowPreservingPeriods } from './dashboardMarketPeriods.cjs';

export const MARKET_QUOTE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const ACTIVE_QUOTE_AVAILABILITIES = new Set(['current', 'delayed']);
const RETAINABLE_QUOTE_AVAILABILITIES = new Set([
  'current',
  'delayed',
  'historical',
  'reference',
]);
const canRetainQuoteRow = (row) => isVerifiedProviderRow(row);

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
  const rows = collectMarketRows(payload);
  const responseObservedAt = Date.parse(String(payload?.meta?.observedAt || ''));
  if (
    !periodOnly
    && Number.isFinite(responseObservedAt)
    && rows.some((row) => canRetainQuoteRow(row) || isRetainedQuoteReference(row))
  ) {
    return new Date(responseObservedAt).toISOString();
  }
  const activeRows = rows.filter((row) => ACTIVE_QUOTE_AVAILABILITIES.has(
    String(row?.availability || '').trim().toLowerCase(),
  ));
  const timestampRows = periodOnly
    ? rows
    : activeRows.length
      ? activeRows
      : rows.filter((row) => RETAINABLE_QUOTE_AVAILABILITIES.has(
        String(row?.availability || '').trim().toLowerCase(),
      ));
  const timestamps = timestampRows
    .map((row) => periodOnly
      ? row.periodReturnsAsOf
      : row.quoteAsOf || row.timestamp)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
};

export const validateMarketQuotePayload = (payload) => {
  if (
    !payload
    || typeof payload !== 'object'
    || !collectMarketRows(payload).some((row) => canRetainQuoteRow(row) || isRetainedQuoteReference(row))
    || !marketPayloadObservedAt(payload)
  ) {
    throw Object.assign(
      new Error('The market quote response had no authoritative verified observations.'),
      {
        code: 'MARKET_QUOTES_EVIDENCE_MISSING',
        liveInvalidation: true,
      },
    );
  }
  return payload;
};

export const markMarketPayloadRetained = (payload, reason) => {
  if (Array.isArray(payload)) {
    return payload.map((row) => markRetainedReference(row, reason)).filter(Boolean);
  }
  if (!payload || typeof payload !== 'object') return payload;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [
    key, key === 'meta' ? value : markMarketPayloadRetained(value, reason),
  ]));
};

// Persist the merged per-instrument observation, rather than allowing a partial
// refresh to erase a row or its independently sourced historical returns.
export const reconcileMarketQuotePayload = ({ currentData, currentReferenceData, incomingData, nowMs = Date.now() }) => {
  const verified = (row) => isVerifiedProviderRow(row, nowMs) || isRetainedQuoteReference(row, nowMs);
  const reconcile = (previous, next) => {
    if (Array.isArray(next) || Array.isArray(previous)) {
      const previousRows = (Array.isArray(previous) ? previous : []).filter(verified);
      const previousBySymbol = new Map(previousRows.map((row) => [row.symbol, row]));
      const incomingRows = (Array.isArray(next) ? next : []).filter(verified);
      const incomingBySymbol = new Map(incomingRows.map((row) => [row.symbol, row]));
      const symbols = [...new Set([...incomingBySymbol.keys(), ...previousBySymbol.keys()])];
      return symbols.map((symbol) => {
        const oldRow = previousBySymbol.get(symbol);
        const newRow = incomingBySymbol.get(symbol);
        if (!oldRow) return newRow;
        const oldTime = Date.parse(oldRow.lastVerifiedAt || oldRow.quoteAsOf || oldRow.timestamp);
        const newTime = Date.parse(newRow?.lastVerifiedAt || newRow?.quoteAsOf || newRow?.timestamp);
        if (!newRow || newTime < oldTime) {
          return markRetainedReference(oldRow, 'partial_provider_refresh', nowMs);
        }
        return mergeMarketRowPreservingPeriods(oldRow, newRow);
      }).filter(Boolean);
    }
    if (!next || typeof next !== 'object') {
      if (!previous || typeof previous !== 'object') return previous;
      next = {};
    }
    return Object.fromEntries([...new Set([...Object.keys(previous || {}), ...Object.keys(next)])]
      .map((key) => [key, key === 'meta' ? next[key] || previous?.[key] : reconcile(previous?.[key], next[key])]));
  };
  return reconcile(currentData || currentReferenceData || {}, incomingData);
};

export const validatePeriodReturnPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || !marketPayloadObservedAt(payload, { periodOnly: true })) {
    throw new Error('Dated period-return observations are unavailable.');
  }
  return payload;
};
