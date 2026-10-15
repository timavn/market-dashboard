import { normalizeResearchDate } from './researchDateFormat';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const HISTORY_FIELDS = ['history', 'historicalReferences'];

export const securityIntelligencePayload = (response) => (
  isRecord(response?.data)
    && (hasOwn(response.data, 'bySymbol') || hasOwn(response.data, 'securities'))
    ? response.data
    : response
);

const symbolMapKey = (payload) => {
  if (isRecord(payload?.bySymbol)) return 'bySymbol';
  if (isRecord(payload?.securities)) return 'securities';
  return null;
};

// A history request is scoped to a particular current projection. Neither a
// different market day nor another schema/map may supply its historical fields.
export const securityIntelligenceScope = (response) => {
  const payload = securityIntelligencePayload(response);
  const date = normalizeResearchDate(payload?.marketDate);
  const parsedDate = Date.parse(`${date}T00:00:00Z`);
  const mapKey = symbolMapKey(payload);
  const schema = Number(payload?.schemaVersion ?? 1);
  if (!date || !Number.isFinite(parsedDate) || !Number.isFinite(schema) || !mapKey
    || new Date(parsedDate).toISOString().slice(0, 10) !== date) return null;
  return `${date}:${schema}:${mapKey}`;
};

export const canMergeSecurityIntelligenceHistory = (currentResponse, historyResponse) => {
  const scope = securityIntelligenceScope(currentResponse);
  return Boolean(scope && scope === securityIntelligenceScope(historyResponse));
};

const withHistory = (currentResponse, historyResponse, clearMissing) => {
  if (!canMergeSecurityIntelligenceHistory(currentResponse, historyResponse)) return currentResponse;
  const current = securityIntelligencePayload(currentResponse);
  const history = securityIntelligencePayload(historyResponse);
  const mapKey = symbolMapKey(current);
  const symbols = Object.fromEntries(Object.entries(current[mapKey]).map(([symbol, entry]) => {
    // Omitted/null securities in a fresh response must never be resurrected.
    if (!isRecord(entry)) return [symbol, entry];
    const historicalEntry = history[mapKey][symbol];
    const next = { ...entry };
    HISTORY_FIELDS.forEach((field) => {
      if (clearMissing) delete next[field];
      if (isRecord(historicalEntry) && hasOwn(historicalEntry, field)) {
        next[field] = historicalEntry[field];
      }
    });
    return [symbol, next];
  }));
  const payload = { ...current, [mapKey]: symbols };
  return current === currentResponse ? payload : { ...currentResponse, data: payload };
};

// Current-only requests deliberately contain empty history arrays. Retain only
// already-loaded same-day history; every current field (including omissions,
// provenance, unavailable states and conflicts) belongs to the fresh response.
export const replaceSecurityIntelligenceCurrent = (previousResponse, incomingResponse) => (
  withHistory(incomingResponse, previousResponse, false)
);

// A history response may also contain an older current snapshot. Never copy its
// decisions, lastVerifiedDecision, products, aliases, status, dates or metadata.
// Its explicit history slice is authoritative, including empty/missing fields.
export const mergeSecurityIntelligenceHistory = (currentResponse, historyResponse) => (
  withHistory(currentResponse, historyResponse, true)
);
