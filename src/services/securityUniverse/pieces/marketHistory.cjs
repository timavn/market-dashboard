'use strict';

const { calculatePriceZScore20, normalizeAdjustedPriceBars } = require('../../../utils/securityRiskMetrics.cjs');
const { buildRealizedVolatilitySnapshot } = require('../../../utils/realizedVolatility.cjs');
const { horizonStats } = require('../../../utils/securityHorizonStats.cjs');
const { available, flagged, round, unavailable, withStatus } = require('../fields.cjs');

const SOURCE = 'Yahoo Finance chart API';
const SIZING_SOURCE = 'Position Sizing v2.0 (14-day ATR, 2× ATR stop)';
const HISTORY_CONCURRENCY = 6;
// A window without enough sessions stays null, never 0.
const percent = value => (Number.isFinite(value) ? round(value * 100) : null);

const emptyRisk = reason => withStatus({ instrumentType: unavailable(reason), referencePrice: unavailable(reason),
  atr14: unavailable(reason), atrPct: unavailable(reason), beta: unavailable(reason), sizing: unavailable(reason) });
const emptyActivity = reason => withStatus({ zScore20: unavailable(reason), realizedVol: unavailable(reason), horizons: unavailable(reason) });

function metricField(metric, fetchedAt) {
  if (metric?.status !== 'available' || flagged(metric) || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
    return unavailable(metric?.reason || 'unavailable', { source: metric?.source || SOURCE, asOf: metric?.asOf || null });
  }
  return available(metric.value, { source: metric.source || SOURCE, asOf: metric.asOf || null, fetchedAt, observations: metric.observations ?? null });
}

// Risk and activity read one daily-bar history: the 'sizing-2y' entry the
// sidecar's sizing reader and horizon stats already use, so every figure here
// shares one fetch and one as-of date with them.
function createMarketHistoryPiece({ loadRiskMetrics, loadSizingHistory, sizingReference, now = Date.now } = {}) {
  async function risk(symbols) {
    let payload;
    try { payload = await loadRiskMetrics(symbols); } catch { payload = null; }
    if (!payload || flagged(payload) || !payload.rows) return new Map(symbols.map(symbol => [symbol, emptyRisk('daily-history-unavailable')]));
    return new Map(symbols.map(symbol => {
      const row = payload.rows[symbol];
      if (!row || flagged(row) || row.status === 'unavailable') return [symbol, emptyRisk(row?.reason || row?.atr14?.reason || 'daily-history-unavailable')];
      const fetchedAt = row.provenance?.security?.fetchedAt || null;
      const yahooSymbol = row.provenance?.security?.yahooSymbol || null;
      // The Positions table's own gate: spot-like instrument, history under an hour
      // old, the latest completed session, then the ATR band.
      const reference = sizingReference(payload, symbol, { now: now() });
      const sizingOk = reference.available && !reference.riskBlocked;
      return [symbol, withStatus({
        instrumentType: row.instrumentType ? available(row.instrumentType, { source: SOURCE, asOf: row.asOf || null, fetchedAt, yahooSymbol })
          : unavailable('instrument-type-unverified', { source: SOURCE }),
        referencePrice: metricField(row.referencePrice, fetchedAt),
        atr14: metricField(row.atr14, fetchedAt),
        atrPct: sizingOk ? available(round(reference.relativeAtr * 100, 3), { source: SIZING_SOURCE, asOf: reference.asOf, fetchedAt })
          : unavailable(reference.reason || 'atr-unavailable', { source: SIZING_SOURCE }),
        beta: metricField(row.beta, fetchedAt),
        sizing: sizingOk
          ? available({ version: '2.0', minPct: reference.minWeight, maxPct: reference.maxWeight,
            stopDistancePct: round(reference.stopDistance * 100, 3), floorApplied: Boolean(reference.floorApplied) },
          { source: SIZING_SOURCE, asOf: reference.asOf, fetchedAt })
          : unavailable(reference.riskBlocked ? 'too-volatile-to-size' : reference.reason || 'sizing-unavailable', { source: SIZING_SOURCE }),
      })];
    }));
  }

  async function activityFor(symbol) {
    let history;
    try { history = await loadSizingHistory(symbol); } catch { return emptyActivity('daily-history-unavailable'); }
    if (!history || flagged(history) || !Array.isArray(history.bars)) return emptyActivity('daily-history-unavailable');
    const fetchedAt = history.fetchedAt || null;
    const normalized = normalizeAdjustedPriceBars(history.bars);
    const stats = horizonStats(history.bars);
    const zScore = calculatePriceZScore20(normalized, { source: SOURCE, normalized: true });
    const vol = buildRealizedVolatilitySnapshot(normalized, { includeLongWindows: false, includeSeries: false, normalizedBars: normalized,
      assetType: history.instrumentType === 'CRYPTOCURRENCY' ? 'crypto' : 'equity' });
    return withStatus({
      zScore20: metricField(zScore, fetchedAt),
      realizedVol: Number.isFinite(vol.rv21)
        ? available({ rv21Pct: percent(vol.rv21), rv63Pct: percent(vol.rv63), rv252Pct: percent(vol.rv252) },
          { source: SOURCE, asOf: vol.asOf, fetchedAt, method: 'close-to-close log returns, annualized', limitedHistory: Boolean(vol.limitedHistory) })
        : unavailable(vol.reason || 'insufficient-history', { source: SOURCE, asOf: vol.asOf }),
      horizons: stats
        ? available(stats, { source: SOURCE, asOf: stats.asOf, fetchedAt, method: 'session windows; Parkinson range vol; volume vs 252-session average' })
        : unavailable('insufficient-history', { source: SOURCE }),
    });
  }

  async function activity(symbols) {
    const values = [];
    for (let offset = 0; offset < symbols.length; offset += HISTORY_CONCURRENCY) {
      values.push(...await Promise.all(symbols.slice(offset, offset + HISTORY_CONCURRENCY).map(activityFor)));
    }
    return new Map(symbols.map((symbol, index) => [symbol, values[index]]));
  }

  return { risk, activity, emptyRisk, emptyActivity };
}

module.exports = { createMarketHistoryPiece, emptyActivity, emptyRisk };
