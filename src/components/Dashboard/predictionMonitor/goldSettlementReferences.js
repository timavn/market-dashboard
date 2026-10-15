import { FORBIDDEN_GOLD_CONTEXT_PROVENANCE } from './goldContextValidation';
import { chartSessionParts } from './riskRangeChartSessions';
import { buildSettlementIdentityViewModel } from './settlementIdentity';
import { isPythResolverSymbol } from '../../../services/predictionMarketTest/resolverIdentities.cjs';

const GOLD_SETTLEMENT_SOURCE = 'kalshi_finalized_expiration_value';

const GOLD_SETTLEMENT_INSTRUMENT = 'Metal.Index.GOLD/USD';

const GOLD_EVENT_MONTH_CODES = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

const goldEventTickerForSessionDate = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const monthCode = match ? GOLD_EVENT_MONTH_CODES[Number(match[2]) - 1] : null;
  return match && monthCode ? `KXGOLDD-${match[1].slice(-2)}${monthCode}${match[3]}17` : null;
};

const resolveVerifiedGoldSettlements = (tracking, rangeDates = []) => {
  const trackingProvenance = [
    tracking?.source,
    tracking?.provenance,
    tracking?.cacheStatus,
    tracking?.cacheState,
    tracking?.warning,
    tracking?.error,
    tracking?.fromCache ? 'cached' : null,
    tracking?.cachedOnly ? 'cached-only' : null,
    tracking?.cacheOnly ? 'cache-only' : null,
    tracking?.mock ? 'mock' : null,
    tracking?.seeded ? 'seeded' : null,
    tracking?.fallback ? 'fallback' : null,
  ].filter(Boolean).join(' ');
  const trustedTracking = ['available', 'partial'].includes(tracking?.status)
    && tracking?.source === GOLD_SETTLEMENT_SOURCE
    && tracking?.resolverSymbol === GOLD_SETTLEMENT_INSTRUMENT
    && tracking?.refreshFailed !== true
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(trackingProvenance);
  if (!trustedTracking) return [];

  const dates = new Set((Array.isArray(rangeDates) ? rangeDates : [])
    .map((date) => String(date || ''))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const grouped = new Map();
  (Array.isArray(tracking?.settlements) ? tracking.settlements : []).forEach((row) => {
    const observationAt = Date.parse(row?.observationAt || '');
    const finalizedAt = Date.parse(row?.finalizedAt || '');
    const value = Number(row?.value);
    const session = chartSessionParts(observationAt);
    const rowProvenance = [
      row?.source,
      row?.provenance,
      row?.cacheStatus,
      row?.cacheState,
      row?.warning,
      row?.error,
      row?.fromCache ? 'cached' : null,
      row?.cachedOnly ? 'cached-only' : null,
      row?.cacheOnly ? 'cache-only' : null,
      row?.mock ? 'mock' : null,
      row?.seeded ? 'seeded' : null,
      row?.fallback ? 'fallback' : null,
    ].filter(Boolean).join(' ');
    const valid = row?.status === 'available'
      && row?.availability === 'official_final'
      && row?.final === true
      && row?.source === GOLD_SETTLEMENT_SOURCE
      && Number.isFinite(observationAt)
      && Number.isFinite(finalizedAt)
      && finalizedAt >= observationAt
      && value > 0
      && session?.minutes === (17 * 60)
      && dates.has(session?.date)
      && row?.eventTicker === goldEventTickerForSessionDate(session?.date)
      && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(rowProvenance);
    if (!valid) return;
    grouped.set(session.date, [...(grouped.get(session.date) || []), {
      date: session.date,
      eventTicker: row.eventTicker,
      observationAt: new Date(observationAt).toISOString(),
      timestamp: observationAt,
      finalizedAt: new Date(finalizedAt).toISOString(),
      value,
      source: row.source,
      availability: row.availability,
    }]);
  });
  return [...grouped.entries()]
    .flatMap(([, rows]) => (rows.length === 1 ? rows : []))
    .sort((left, right) => left.timestamp - right.timestamp);
};

const resolveVerifiedGoldSettlementTime = (venueSelection, sessionDate, nowMs = Date.now()) => {
  const identity = buildSettlementIdentityViewModel(venueSelection, { nowMs });
  const basis = identity?.basis;
  const observationAt = Date.parse(basis?.observationAt || '');
  const session = chartSessionParts(observationAt);
  const provenance = [
    basis?.sourceName,
    basis?.source,
    basis?.provenance,
    basis?.warning,
    basis?.fromCache ? 'cached' : null,
    basis?.mock ? 'mock' : null,
    basis?.seeded ? 'seeded' : null,
    basis?.fallback ? 'fallback' : null,
  ].filter(Boolean).join(' ');
  const valid = identity?.status === 'verified'
    && basis?.instrumentScope === 'exact'
    && isPythResolverSymbol('gold', basis?.instrument)
    && /^Pyth$/i.test(String(basis?.sourceName || ''))
    && /1-minute\s+close/i.test(String(basis?.method || ''))
    && Number.isFinite(observationAt)
    && session?.minutes === (17 * 60)
    && session?.date === String(sessionDate || '')
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance);
  return valid ? {
    timestamp: observationAt,
    observationAt: new Date(observationAt).toISOString(),
    date: session.date,
    sourceName: basis.sourceName,
    instrument: basis.instrument,
    method: basis.method,
  } : null;
};

export { GOLD_SETTLEMENT_SOURCE, resolveVerifiedGoldSettlementTime, resolveVerifiedGoldSettlements };
