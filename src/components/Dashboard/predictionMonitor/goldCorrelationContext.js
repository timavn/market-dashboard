import {
  isFiniteGoldContextValue as finite,
  FORBIDDEN_GOLD_CONTEXT_PROVENANCE,
  freshDatedObservation,
} from './goldContextValidation';

const GOLD_CORRELATION_MAX_AGE_MS = 75 * 60_000;
export const GOLD_CORRELATION_HORIZONS = Object.freeze(['15D', '30D', '90D', '120D', '180D']);
const GOLD_CORRELATION_OBSERVATIONS = Object.freeze({
  '15D': 15,
  '30D': 30,
  '90D': 90,
  '120D': 120,
  '180D': 180,
});
const GOLD_CORRELATION_ROW_KEYS = Object.freeze([
  'DXY', 'UST10Y_REAL', 'UST10Y_NOMINAL', 'SPX', 'SILVER', 'CRB', 'WTI',
]);
const GOLD_CORRELATION_LAST_UNITS = Object.freeze({
  DXY: 'index',
  UST10Y_REAL: 'percent',
  UST10Y_NOMINAL: 'percent',
  SPX: 'index',
  SILVER: 'USD/ozt',
  CRB: 'index',
  WTI: 'USD/bbl',
});

const unavailableGoldCorrelationSnapshot = (reason) => ({
  status: 'unavailable',
  method: 'pearson_completed_daily_changes',
  horizons: GOLD_CORRELATION_HORIZONS,
  basis: null,
  rows: [],
  timestamp: null,
  reason: reason || 'Verified Gold correlation data is unavailable.',
});

export function normalizeGoldCorrelationSnapshot(payload = {}, nowMs = Date.now()) {
  const timestampMs = Date.parse(payload?.timestamp || '');
  const timestampAge = Number(nowMs) - timestampMs;
  const basisSource = String(payload?.basis?.source || '');
  const provenance = [
    payload?.warning,
    payload?.provenance,
    payload?.cacheState,
    payload?.cachedOnly ? 'cached-only' : null,
    payload?.fromCache ? 'cached' : null,
    payload?.mock ? 'mock' : null,
    payload?.seeded ? 'seed' : null,
    basisSource,
  ].filter(Boolean).join(' ');
  const horizonsValid = Array.isArray(payload?.horizons)
    && payload.horizons.length === GOLD_CORRELATION_HORIZONS.length
    && payload.horizons.every((horizon, index) => horizon === GOLD_CORRELATION_HORIZONS[index]);
  const basisValid = ['available', 'partial'].includes(String(payload?.status || '').toLowerCase())
    && payload?.method === 'pearson_completed_daily_changes'
    && horizonsValid
    && payload?.basis?.status === 'available'
    && String(payload?.basis?.symbol || '').toUpperCase() === 'XAUUSD'
    && payload?.basis?.role === 'proxy'
    && /^IBKR\b/i.test(basisSource)
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance)
    && Number.isFinite(timestampMs)
    && timestampAge >= -5_000
    && timestampAge <= GOLD_CORRELATION_MAX_AGE_MS
    && freshDatedObservation(payload?.basis?.asOf, nowMs);
  if (!basisValid) {
    return unavailableGoldCorrelationSnapshot(
      payload?.reason || payload?.basis?.reason || 'The verified IBKR XAUUSD correlation basis is unavailable.',
    );
  }

  const incomingRows = new Map((Array.isArray(payload?.rows) ? payload.rows : [])
    .map((row) => [String(row?.key || '').toUpperCase(), row]));
  const rows = GOLD_CORRELATION_ROW_KEYS.map((key) => {
    const row = incomingRows.get(key);
    const source = String(row?.source || '');
    const sourceValid = key.startsWith('UST10Y_') ? /^FRED\b/i.test(source) : /^Yahoo Finance\b/i.test(source);
    const rowProvenance = [
      source,
      row?.warning,
      row?.provenance,
      row?.cacheState,
      row?.cachedOnly ? 'cached-only' : null,
      row?.fromCache ? 'cached' : null,
      row?.mock ? 'mock' : null,
      row?.seeded ? 'seed' : null,
      row?.latest?.warning,
      row?.latest?.provenance,
      row?.latest?.cacheState,
      row?.latest?.cachedOnly ? 'cached-only' : null,
      row?.latest?.fromCache ? 'cached' : null,
      row?.latest?.mock ? 'mock' : null,
      row?.latest?.seeded ? 'seed' : null,
    ].filter(Boolean).join(' ');
    const expectedTransform = key.startsWith('UST10Y_') ? 'yield_change_bps' : 'price_return';
    const observations = Number.isFinite(Number(row?.observations)) ? Number(row.observations) : 0;
    const rowValid = ['available', 'partial'].includes(String(row?.status || '').toLowerCase())
      && sourceValid
      && row?.transform === expectedTransform
      && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(rowProvenance)
      && freshDatedObservation(row?.asOf, nowMs);
    const expectedLatestUnit = GOLD_CORRELATION_LAST_UNITS[key];
    const latestValid = rowValid
      && finite(row?.latest?.value)
      && (expectedTransform === 'yield_change_bps' || Number(row.latest.value) > 0)
      && row?.latest?.unit === expectedLatestUnit
      && row?.latest?.asOf === row?.asOf
      && freshDatedObservation(row.latest.asOf, nowMs);
    const values = Object.fromEntries(GOLD_CORRELATION_HORIZONS.map((horizon) => {
      const value = rowValid && finite(row?.values?.[horizon])
        && observations >= GOLD_CORRELATION_OBSERVATIONS[horizon]
        && Number(row.values[horizon]) >= -1 && Number(row.values[horizon]) <= 1
        ? Number(row.values[horizon])
        : null;
      return [horizon, value];
    }));
    const availableCount = Object.values(values).filter(finite).length;
    return {
      key,
      label: row?.label || key,
      symbol: row?.symbol || key,
      status: availableCount === GOLD_CORRELATION_HORIZONS.length
        ? 'available'
        : availableCount > 0 ? 'partial' : 'unavailable',
      source: sourceValid ? source : null,
      transform: row?.transform || null,
      asOf: rowValid ? row.asOf : null,
      observations: rowValid ? observations : 0,
      latest: {
        value: latestValid ? Number(row.latest.value) : null,
        asOf: latestValid ? row.latest.asOf : null,
        unit: expectedLatestUnit,
      },
      values,
      reason: availableCount > 0 ? row?.reason || null : row?.reason || `Verified ${row?.label || key} history is unavailable.`,
    };
  });
  const availableRows = rows.filter((row) => ['available', 'partial'].includes(row.status)).length;
  return {
    status: availableRows === rows.length ? 'available' : availableRows > 0 ? 'partial' : 'unavailable',
    method: payload.method,
    horizons: GOLD_CORRELATION_HORIZONS,
    basis: {
      symbol: 'XAUUSD',
      label: payload.basis.label || 'IBKR XAUUSD Spot Gold',
      role: 'proxy',
      status: 'available',
      source: basisSource,
      asOf: payload.basis.asOf,
      unit: payload.basis.unit || 'USD/ozt',
      reason: payload.basis.reason || null,
    },
    rows,
    timestamp: new Date(timestampMs).toISOString(),
    calculationDate: payload.calculationDate || payload.basis.asOf,
    reason: availableRows ? null : payload?.reason || 'No verified Gold correlation rows are available.',
  };
}

export const isGoldCorrelationSnapshotUsable = (snapshot, nowMs = Date.now()) => {
  const timestampMs = Date.parse(snapshot?.timestamp || '');
  const ageMs = Number(nowMs) - timestampMs;
  return ['available', 'partial'].includes(snapshot?.status)
    && snapshot?.basis?.status === 'available'
    && Number.isFinite(timestampMs)
    && ageMs >= -5_000
    && ageMs <= GOLD_CORRELATION_MAX_AGE_MS;
};

export function withCanonicalGoldCorrelationFactor(snapshot, correlationSnapshot, nowMs = Date.now()) {
  if (!snapshot || snapshot?.marketId !== 'gold') return snapshot;
  const usable = isGoldCorrelationSnapshotUsable(correlationSnapshot, nowMs);
  const dxy = usable
    ? correlationSnapshot.rows.find((row) => row.key === 'DXY')
    : null;
  const correlationValue = finite(dxy?.values?.['30D']) ? Number(dxy.values['30D']) : null;
  const correlationReplacement = {
    id: 'usd',
    label: 'XAUUSD/DXY 30D RETURN CORRELATION',
    status: correlationValue == null ? 'unavailable' : 'available',
    value: correlationValue,
    displayValue: correlationValue == null ? null : `${correlationValue > 0 ? '+' : ''}${correlationValue.toFixed(2)}`,
    source: correlationValue == null ? null : dxy.source,
    asOf: correlationValue == null ? null : dxy.asOf,
    fit: 'context_only',
    decisionEligible: false,
    note: correlationValue == null
      ? correlationSnapshot?.reason || dxy?.reason || 'Verified XAUUSD/DXY return correlation is unavailable.'
      : 'Completed-session return correlation context only; never an executable price or scoring input.',
  };
  const rows = Array.isArray(snapshot.factorRows) ? snapshot.factorRows : [];
  const existingDxy = rows.find((row) => row?.id === 'dxy');
  const canonicalDxyValue = finite(dxy?.latest?.value) ? Number(dxy.latest.value) : null;
  const dxyReplacement = canonicalDxyValue == null ? existingDxy || {
    id: 'dxy',
    label: 'DXY · LAST CLOSE',
    status: 'unavailable',
    value: null,
    displayValue: null,
    source: null,
    asOf: null,
    fit: 'completed_session',
    decisionEligible: false,
    note: 'Verified completed-session DXY context is unavailable.',
  } : {
    id: 'dxy',
    label: 'DXY · LAST CLOSE',
    status: 'historical',
    availability: 'historical',
    value: canonicalDxyValue,
    displayValue: canonicalDxyValue.toFixed(2),
    source: dxy.source,
    asOf: dxy.latest.asOf,
    historicalThroughDate: dxy.latest.asOf,
    fit: 'completed_session',
    decisionEligible: false,
    note: 'Completed-session DXY close; dollar-strength context only, not an executable price or scoring input.',
  };
  return {
    ...snapshot,
    factorRows: [
      dxyReplacement,
      correlationReplacement,
      ...rows.filter((row) => !['dxy', 'usd'].includes(row?.id)),
    ],
  };
}
