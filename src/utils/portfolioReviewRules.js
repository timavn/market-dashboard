import { calculateSizingDecision, stopLossPctNlv, SIZING_CONSTANTS } from './signalWeightedPositionSizing.js';

const number = value => value == null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
const signal = value => ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(value) ? value : null;
export const PORTFOLIO_WEIGHT_TOLERANCE_PP = 0.10;
const exceedsWeightLimit = (weight, limit) => weight != null && limit != null && weight - limit > PORTFOLIO_WEIGHT_TOLERANCE_PP + 1e-9;
const invalidEvidence = evidence => evidence && (
  evidence.available === false || evidence.verified === false
  || ['stale', 'offline', 'disconnected', 'cacheOnly', 'mock', 'seed', 'seeded', 'inferred', 'synthetic', 'fallback'].some(flag => evidence[flag] === true)
  || /\b(?:unavailable|unverified|stale|offline|disconnected|cache[-_ ]?only|mock|seed(?:ed)?|inferred|indication|synthetic|fallback|conflict|invalid|error|failed)\b/i.test(`${evidence.status || ''} ${evidence.freshness || ''}`)
);

function publishedSignal(holding, field, asOf) {
  const value = signal(holding[field]);
  const context = holding.signalContext?.[field];
  const source = holding.sources?.[field];
  if (!value || invalidEvidence(context) || invalidEvidence(source)
    || (context?.value != null && context.value !== value)) return null;
  if (source?.publishedAt && (!Number.isFinite(Date.parse(source.publishedAt))
    || !Number.isFinite(Date.parse(asOf)) || Date.parse(source.publishedAt) > Date.parse(asOf))) return null;
  return value;
}

function hasDatedSignalSource(holding, field, asOf) {
  const source = holding.sources?.[field];
  return Boolean(publishedSignal(holding, field, asOf)
    && Number.isFinite(Date.parse(asOf)) && Number.isFinite(Date.parse(source?.publishedAt))
    && Date.parse(source.publishedAt) <= Date.parse(asOf)
    && (source.citation?.id || source.citation?.sourceUrl || source.citation?.url));
}

// This is a dated, read-only rule comparison. Executable sizing remains owned
// by the sizing engine's separate live-context gate; no order values are used.
export function evaluatePortfolioRule(holding, asOf) {
  const trade = publishedSignal(holding, 'trade', asOf);
  const trend = publishedSignal(holding, 'trend', asOf);
  const recordedWeight = number(holding.weightPct);
  const weight = recordedWeight == null ? null : Math.abs(recordedWeight);
  const inputs = holding.sizingInputs || {};
  const capturedMetric = (metric, minimum) => {
    if (!Number.isFinite(Date.parse(asOf)) || !metric || typeof metric.source !== 'string' || !metric.source.trim()
      || invalidEvidence(metric) || number(metric.observations) < minimum
      || number(metric.observations) == null || number(metric.value) == null
      || !Number.isFinite(Date.parse(metric.asOf)) || Date.parse(metric.asOf) > Date.parse(asOf)
      || Date.parse(asOf) - Date.parse(metric.asOf) > 7 * 86400000
      || !['available', 'verified_history'].includes(metric.status)) return null;
    return metric;
  };
  const atr14 = capturedMetric(inputs.atr14, SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS);
  const referencePrice = capturedMetric(inputs.referencePrice, 1);
  const decision = calculateSizingDecision({
    symbol: holding.holding || holding.symbol,
    atr14, spot: Object.hasOwn(inputs, 'referencePrice') ? number(referencePrice?.value) : number(holding.valuationPrice), netLiquidationValue: number(holding.netLiquidation),
    lrr: number(holding.lrr), hrr: number(holding.hrr), tradeSignal: trade, trendSignal: trend,
    position: { exists: true, side: holding.heldSide, weight },
  });
  // MIN, MAX, and the stop all come from the verified ATR and reference price.
  const bandAvailable = decision.sizingBand.available;
  // Only an ATR near half the price leaves no band; a held position then exits.
  const volatilityBlocked = decision.riskBlocked === true;
  const limitWeight = bandAvailable ? decision.operationalMaxWeight : null;
  const maxWeight = limitWeight;
  const heldSignal = holding.heldSide === 'LONG' ? 'BULLISH' : holding.heldSide === 'SHORT' ? 'BEARISH' : null;
  let weightStatus = null;
  let weightDeviation = null;
  // Compare the captured weight with the displayed limits independently of
  // research actions. Below MIN is informational, including for BENCH/EXIT.
  if (heldSignal && weight != null && Number.isFinite(Date.parse(asOf))
    && !invalidEvidence(holding) && holding.connected !== false) {
    if (exceedsWeightLimit(weight, limitWeight)) {
      weightStatus = 'overweight';
      weightDeviation = weight - limitWeight;
    } else if (bandAvailable && !volatilityBlocked
      && exceedsWeightLimit(decision.minWeight, weight)) {
      weightStatus = 'underweight';
      weightDeviation = decision.minWeight - weight;
    }
  }
  const { sizingBand, stop } = decision;
  const base = { ...holding, sizingBasis: 'ATR sizing',
    atrPct: bandAvailable ? sizingBand.relativeAtr * 100 : null, atrFloorApplied: sizingBand.floorApplied, volatilityBlocked,
    stopDistancePct: bandAvailable ? sizingBand.stopDistance * 100 : null, stopPrice: stop.price,
    stopLossPctNlv: bandAvailable ? stopLossPctNlv(weight, sizingBand.stopDistance) : null,
    weightPct: weight, trade, trend, minWeight: decision.minWeight, maxWeight, weightStatus, weightDeviation, targetWeight: null, reduction: null };
  if (!heldSignal) return { ...base, status: 'verification', reason: 'Position side unavailable' };
  if (decision.research.action === 'EXIT') return {
    ...base, status: 'conflict', rule: trade && trade !== (holding.heldSide === 'SHORT' ? 'BEARISH' : 'BULLISH') ? 'TRADE_BREAK' : 'RISK_CAP',
    action: 'EXIT', targetLabel: 'Target', targetWeight: 0, reduction: weight,
  };
  // A dated published Trend can independently establish a MIN breach while
  // Trade is unavailable. This historical warning does not assert a Trade
  // break, infer one from a product indication, or authorize an executable order.
  const independentTrendBreak = !trade && trend && trend !== heldSignal && hasDatedSignalSource(holding, 'trend', asOf);
  const trendBreak = decision.lifecycleState === 'BENCH' || independentTrendBreak;
  if (bandAvailable && trendBreak && exceedsWeightLimit(weight, decision.minWeight)) return {
    ...base, status: 'conflict', rule: 'TREND_BREAK', action: 'REDUCE', targetLabel: 'MIN',
    targetWeight: decision.minWeight, reduction: weight - decision.minWeight,
  };
  // A known size breach does not depend on entry ranges or complete signals.
  // Trade-break exits and the stricter Trend-break MIN still take priority.
  if (exceedsWeightLimit(weight, limitWeight)) return {
    ...base, status: 'conflict', rule: 'ABOVE_MAX', action: 'REDUCE', targetLabel: 'MAX',
    targetWeight: limitWeight, reduction: weight - limitWeight,
  };
  if (!trade) return { ...base, status: 'verification', reason: 'Trade signal unavailable' };
  if (!trend) return { ...base, status: 'verification', reason: 'Trend signal unavailable' };
  if (weight == null) return { ...base, status: 'verification', reason: 'Position weight unavailable' };
  if (!bandAvailable) return { ...base, status: 'verification', reason: decision.lifecycleState === 'BENCH' ? 'Trend changed; MIN comparison needs verified ATR and price' : 'Position limits need verified ATR and price' };
  if (decision.lifecycleState === 'BENCH') return { ...base, status: 'aligned', reason: weight > decision.minWeight ? 'Within 10 bp of MIN' : 'At or below MIN' };
  if (!decision.range.available) return { ...base, status: 'verification', reason: 'Risk range unavailable' };
  return { ...base, status: 'aligned' };
}

export function portfolioPositionNeedsAttention(row, { includeStopIssues = false } = {}) {
  return row.status === 'conflict' || ['overweight', 'underweight'].includes(row.weightStatus)
    || (includeStopIssues && !invalidEvidence(row.stopCheck)
    && ['missing', 'partial', 'oversized', 'wrong_side'].includes(row.stopCheck?.status));
}

// Apply within each Long/Short group. Verified exceptions precede ordinary
// rows; missing research or unverified stop coverage does not create a breach.
export function sortPortfolioPositions(rows, options = {}) {
  const priority = row => row.status === 'conflict' ? row.action === 'EXIT' ? 0 : row.action === 'REDUCE' ? 1 : 2
    : portfolioPositionNeedsAttention(row, options) ? 2 : 3;
  const preferWeight = ['overweight', 'underweight'].includes(options.preferredWeightStatus);
  const weightPriority = row => !['overweight', 'underweight'].includes(row.weightStatus) ? 2
    : row.weightStatus === options.preferredWeightStatus ? 0 : 1;
  return [...rows].sort((a, b) => (preferWeight ? weightPriority(a) - weightPriority(b)
    || (weightPriority(a) < 2 ? (number(b.weightDeviation) || 0) - (number(a.weightDeviation) || 0) : 0) : 0)
    || priority(a) - priority(b)
    || (priority(a) < 2 ? (number(b.reduction) || 0) - (number(a.reduction) || 0) : 0)
    || String(a.holding).localeCompare(String(b.holding)));
}

export function sortPortfolioConflicts(rows) {
  return sortPortfolioPositions(rows);
}

export function summarizePortfolioRules(brief) {
  const rows = (brief.holdings || []).map(holding => evaluatePortfolioRule(holding, brief.reviewedAt || brief.asOf));
  return { rows, conflicts: sortPortfolioConflicts(rows.filter(row => row.status === 'conflict')),
    gaps: rows.filter(row => row.status === 'verification'),
    checked: rows.filter(row => row.trade && row.trend).length,
    signalAligned: rows.filter(row => row.trade === (row.heldSide === 'SHORT' ? 'BEARISH' : 'BULLISH') && row.trend === row.trade).length,
    total: rows.length };
}
