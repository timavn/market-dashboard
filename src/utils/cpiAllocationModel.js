const DEFAULT_MIN_CALIBRATION_OBSERVATIONS = 8;
const DEFAULT_HISTORY_PRIOR_OBSERVATIONS = 24;
const DEFAULT_QUOTE_MAX_AGE_MS = 120000;

export const DEFAULT_CPI_ALLOCATION_SETTINGS = Object.freeze({
  riskPct: 1,
  maxRiskPerBet: 500,
  maxOpenRisk: 10000,
  maxCorrelatedExposure: 3000,
  maxPmRiskPct: 0.05,
  minCalibrationObservations: DEFAULT_MIN_CALIBRATION_OBSERVATIONS,
  historyPriorObservations: DEFAULT_HISTORY_PRIOR_OBSERVATIONS,
  quoteMaxAgeMs: DEFAULT_QUOTE_MAX_AGE_MS,
});

const NON_LIVE_FLAGS = new Set([
  'stale_quote',
  'portfolio_seed',
  'portfolio_discovered',
  'portfolio_derived',
  'open_position',
  'catalog_missing',
  'mock',
  'fallback',
  'no_live_quote',
  'cached',
  'expired_contract',
  'wrong_release',
  'unknown_contract_side',
]);

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustScale(values = []) {
  const center = median(values);
  if (center == null) return 0;
  const mad = median(values.map((value) => Math.abs(value - center))) || 0;
  return 1.4826 * mad;
}

// Abramowitz-Stegun 7.1.26. The approximation is deterministic and more than
// precise enough for tenth-point CPI settlement buckets.
function normalCdf(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return x === Infinity ? 1 : x === -Infinity ? 0 : null;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + (0.3275911 * abs));
  const polynomial = (
    (((((1.061405429 * t) - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
      + 0.254829592
  ) * t;
  const erf = sign * (1 - (polynomial * Math.exp(-(abs * abs))));
  return 0.5 * (1 + erf);
}

function normalSurvival(boundary, mean, bandwidth) {
  const scale = Math.max(0.0001, Number(bandwidth));
  return 1 - normalCdf((boundary - mean) / scale);
}

function logit(probability) {
  const p = clamp(Number(probability), 0.001, 0.999);
  return Math.log(p / (1 - p));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-Number(value)));
}

function scenarioValue(model, aliases = []) {
  const wanted = aliases.map((value) => String(value).toLowerCase());
  const scenario = (model?.scenarios || []).find((entry) => {
    const tokens = [entry?.key, entry?.label, entry?.name]
      .map((value) => String(value || '').trim().toLowerCase());
    return tokens.some((token) => wanted.includes(token));
  });
  return finiteNumber(scenario?.value ?? scenario?.percent ?? scenario?.raw);
}

function normalizeCurrentScenarios(model = null) {
  const lower = scenarioValue(model, ['downside', 'lower', 'low', 'bear']);
  const base = scenarioValue(model, ['base', 'base case', 'base-case', 'central']);
  const upper = scenarioValue(model, ['upside', 'upper', 'high', 'bull']);
  if (![lower, base, upper].every(Number.isFinite) || !(lower < base && base < upper)) return null;
  return { lower, base, upper };
}

function rawHistoryScenario(entry = {}, key) {
  const scenario = entry?.scenarios?.[key];
  return finiteNumber(
    scenario?.raw ??
    scenario?.value ??
    scenario ??
    entry?.scenarios?.raw?.[key],
  );
}

function normalizeCalibrationObservations(history = [], finals = []) {
  const entries = Array.isArray(history) ? history : history?.entries || [];
  const finalEntries = Array.isArray(finals) ? finals : finals?.finals || [];
  const finalByMonth = new Map(finalEntries.map((entry) => [
    String(entry?.id || entry?.monthId || ''),
    finiteNumber(entry?.value ?? entry?.final),
  ]));

  return entries.map((entry) => {
    const monthId = String(entry?.id || entry?.monthId || '');
    const lower = rawHistoryScenario(entry, 'lower');
    const base = rawHistoryScenario(entry, 'base');
    const upper = rawHistoryScenario(entry, 'upper');
    const final = finalByMonth.get(monthId);
    if (
      !monthId ||
      ![lower, base, upper, final].every(Number.isFinite) ||
      !(lower < base && base < upper) ||
      String(entry?.status || '').toLowerCase() === 'provisional'
    ) return null;
    return {
      monthId,
      lower,
      base,
      upper,
      final,
      residual: final - base,
    };
  }).filter(Boolean);
}

function eventThreshold(row = {}) {
  const direct = finiteNumber(row?.threshold);
  if (direct != null) return direct;
  const text = [
    row?.title,
    row?.event?.contract_title,
    row?.event?.question,
    row?.event?.api_raw_symbol,
  ].filter(Boolean).join(' ');
  const match = text.match(/\babove\s+(-?\d+(?:\.\d+)?)\s*%?/i)
    || text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]|$)/i);
  return match ? finiteNumber(match[1]) : null;
}

function directMarketPoint(row = {}) {
  if (row?.missingContract) return null;
  const threshold = eventThreshold(row);
  const bid = finiteNumber(row?.event?.yes_bid);
  const ask = finiteNumber(row?.event?.yes_ask ?? row?.yesPrice);
  if (
    threshold == null || bid == null || ask == null ||
    bid < 0 || ask <= 0 || ask >= 1 || bid >= ask
  ) return null;
  const spread = ask - bid;
  return {
    threshold,
    bid,
    ask,
    midpoint: (bid + ask) / 2,
    weight: Math.min(10000, 1 / Math.max(0.01, spread) ** 2),
  };
}

function enforceNonIncreasing(points = []) {
  const blocks = [];
  points.forEach((point, index) => {
    blocks.push({
      first: index,
      last: index,
      weight: point.weight,
      weightedValue: point.weight * point.midpoint,
    });
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      const leftMean = left.weightedValue / left.weight;
      const rightMean = right.weightedValue / right.weight;
      if (leftMean >= rightMean) break;
      blocks.splice(blocks.length - 2, 2, {
        first: left.first,
        last: right.last,
        weight: left.weight + right.weight,
        weightedValue: left.weightedValue + right.weightedValue,
      });
    }
  });

  const fitted = Array(points.length).fill(null);
  blocks.forEach((block) => {
    const value = clamp(block.weightedValue / block.weight, 0.001, 0.999);
    for (let index = block.first; index <= block.last; index += 1) fitted[index] = value;
  });
  return fitted;
}

function unavailableCurve(reason, details = {}) {
  return {
    status: 'unavailable',
    reason,
    observations: details.observations || 0,
    historyWeight: null,
    modelWeight: null,
    bandwidth: null,
    probabilities: [],
    warnings: details.warnings || [],
  };
}

export function buildCpiCalibratedProbabilityCurve({
  model = null,
  history = [],
  finals = [],
  rows = [],
  minObservations = DEFAULT_MIN_CALIBRATION_OBSERVATIONS,
  priorObservations = DEFAULT_HISTORY_PRIOR_OBSERVATIONS,
} = {}) {
  const current = normalizeCurrentScenarios(model);
  if (!current) return unavailableCurve('current_scenarios_unavailable');

  const observations = normalizeCalibrationObservations(history, finals);
  if (observations.length < minObservations) {
    return unavailableCurve('insufficient_calibration_history', {
      observations: observations.length,
      warnings: [`Need at least ${minObservations} resolved pre-release observations.`],
    });
  }

  const marketPoints = rows.map(directMarketPoint).filter(Boolean)
    .sort((left, right) => left.threshold - right.threshold);
  const uniquePoints = [];
  marketPoints.forEach((point) => {
    const key = point.threshold.toFixed(4);
    if (!uniquePoints.some((entry) => entry.threshold.toFixed(4) === key)) uniquePoints.push(point);
  });
  if (uniquePoints.length < 3) {
    return unavailableCurve('insufficient_live_market_curve', {
      observations: observations.length,
      warnings: ['Need at least three direct live two-sided CPI books.'],
    });
  }

  const residuals = observations.map((entry) => entry.residual);
  const halfBand = (current.upper - current.lower) / 2;
  const residualScale = robustScale(residuals);
  const bandwidth = Math.max(0.035, halfBand * 0.5, residualScale * 0.35);
  const priorBandwidth = Math.max(0.025, halfBand * 0.35);
  const historyWeight = observations.length / (observations.length + Math.max(1, priorObservations));
  const modelWeight = Math.min(0.5, historyWeight);
  const marketFit = enforceNonIncreasing(uniquePoints);

  const probabilities = uniquePoints.map((point, index) => {
    // Contracts are strict "Above X" claims on a CPI figure published to one
    // decimal. The latent boundary is therefore X + 0.05.
    const boundary = Number((point.threshold + 0.05).toFixed(6));
    const empirical = residuals.reduce((sum, residual) => (
      sum + normalSurvival(boundary, current.base + residual, bandwidth)
    ), 0) / residuals.length;
    const prior = (
      0.25 * normalSurvival(boundary, current.lower, priorBandwidth) +
      0.50 * normalSurvival(boundary, current.base, priorBandwidth) +
      0.25 * normalSurvival(boundary, current.upper, priorBandwidth)
    );
    const nowcastProbability = clamp(
      (historyWeight * empirical) + ((1 - historyWeight) * prior),
      0.001,
      0.999,
    );
    const marketProbability = marketFit[index];
    const fairProbability = clamp(logistic(
      (modelWeight * logit(nowcastProbability)) +
      ((1 - modelWeight) * logit(marketProbability)),
    ), 0.001, 0.999);
    return {
      threshold: point.threshold,
      boundary,
      bid: point.bid,
      ask: point.ask,
      marketProbability,
      nowcastProbability,
      fairProbability,
    };
  });

  return {
    status: 'ready',
    reason: null,
    observations: observations.length,
    historyWeight,
    modelWeight,
    bandwidth,
    probabilities,
    warnings: observations.length < priorObservations
      ? [`Small-sample shrinkage active (${observations.length} resolved observations).`]
      : [],
  };
}

export function calculateKalshiTakerFee(contracts, price) {
  const count = Math.max(0, Math.floor(Number(contracts) || 0));
  const probability = finiteNumber(price);
  if (!count || probability == null || probability <= 0 || probability >= 1) return 0;
  return Math.ceil((0.07 * count * probability * (1 - probability)) * 100 - 1e-9) / 100;
}

function feeModelForRow(row = {}) {
  const event = row.event || {};
  const venue = String(event.venue || row.venue || '').toLowerCase();
  const source = String(event.source_api || '').toLowerCase();
  if (venue === 'kalshi' || source === 'kalshi_trade_api_v2') {
    return {
      kind: 'kalshi_taker',
      total: (contracts, price) => calculateKalshiTakerFee(contracts, price),
      marginalRate: (price) => 0.07 * price * (1 - price),
    };
  }
  const flat = finiteNumber(event.fee_per_contract ?? row.feePerContract);
  if (flat != null && flat >= 0) {
    return {
      kind: 'venue_flat',
      total: (contracts) => roundMoney(Math.max(0, Math.floor(contracts)) * flat),
      marginalRate: () => flat,
    };
  }
  return null;
}

function rowHasRejectedFlags(row = {}) {
  return (row?.event?.data_quality_flags || []).some((flag) => NON_LIVE_FLAGS.has(flag));
}

function isFreshRow(row = {}, now = Date.now(), maxAgeMs = DEFAULT_QUOTE_MAX_AGE_MS) {
  const event = row.event || {};
  const timestamp = Date.parse(
    event.quote_retrieved_at ||
    event.market_data_retrieved_at ||
    event.updated_at ||
    '',
  );
  const age = Number(now) - timestamp;
  return Number.isFinite(timestamp) && Number.isFinite(age) && age >= -5000 && age <= maxAgeMs;
}

function sideDepth(row = {}, side) {
  const event = row.event || {};
  const directKeys = side === 'YES'
    ? ['yes_ask_size', 'yesAskSize']
    : ['no_ask_size', 'noAskSize'];
  for (const key of directKeys) {
    const value = finiteNumber(event[key]);
    if (value != null && value > 0) return { value: Math.floor(value), source: key };
  }

  // Kalshi exposes a single binary book. A native YES bid is the executable
  // resting liquidity for a NO buyer. Keep that provenance explicit instead
  // of populating a synthetic no_ask_size field on the event.
  if (side === 'NO' && String(event.venue || row.venue || '').toLowerCase() === 'kalshi') {
    const value = finiteNumber(event.yes_bid_size ?? event.yesBidSize);
    if (value != null && value > 0) {
      return { value: Math.floor(value), source: 'kalshi_yes_bid_size' };
    }
  }
  return null;
}

function candidateCost(candidate, contracts) {
  const count = Math.max(0, Math.floor(contracts));
  return (count * candidate.price * candidate.payoutMultiplier) +
    candidate.feeModel.total(count, candidate.price);
}

function maxContractsUnderCost(candidate, maxCost) {
  const costCap = Math.max(0, Number(maxCost) || 0);
  let low = 0;
  let high = Math.max(0, Math.min(
    candidate.depthCap,
    Math.floor(costCap / Math.max(0.0001, candidate.price * candidate.payoutMultiplier)),
  ));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (candidateCost(candidate, middle) <= costCap + 1e-9) low = middle;
    else high = middle - 1;
  }
  return low;
}

function buildSettlementStates(probabilities = []) {
  const sorted = [...probabilities].sort((left, right) => left.threshold - right.threshold);
  if (!sorted.length) return [];
  const states = [{
    key: `at-or-below-${sorted[0].threshold}`,
    label: `≤ ${sorted[0].threshold.toFixed(1)}`,
    settlementValue: sorted[0].threshold,
    probability: clamp(1 - sorted[0].fairProbability, 0, 1),
  }];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const next = sorted[index + 1];
    states.push({
      key: `at-${next.threshold}`,
      label: next.threshold.toFixed(1),
      settlementValue: next.threshold,
      probability: clamp(sorted[index].fairProbability - next.fairProbability, 0, 1),
    });
  }
  const last = sorted[sorted.length - 1];
  states.push({
    key: `above-${last.threshold}`,
    label: `≥ ${(last.threshold + 0.1).toFixed(1)}`,
    settlementValue: Number((last.threshold + 0.1).toFixed(1)),
    probability: clamp(last.fairProbability, 0, 1),
  });
  const total = states.reduce((sum, state) => sum + state.probability, 0);
  return total > 0
    ? states.map((state) => ({ ...state, probability: state.probability / total }))
    : [];
}

function positionThreshold(position = {}) {
  const direct = finiteNumber(position.threshold);
  if (direct != null) return direct;
  const text = [position.title, position.description, position.symbol, position.raw?.description]
    .filter(Boolean).join(' ');
  const match = text.match(/\babove\s+(-?\d+(?:\.\d+)?)\s*%?/i)
    || text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]|$)/i);
  return match ? finiteNumber(match[1]) : null;
}

function currentPositionPnl(position = {}, state = {}) {
  const threshold = positionThreshold(position);
  const quantity = finiteNumber(position.quantity);
  const averagePrice = finiteNumber(position.avgPrice ?? position.averagePrice)
    ?? (finiteNumber(position.costBasis) != null && quantity
      ? Math.abs(Number(position.costBasis) / quantity)
      : null);
  const side = String(position.contractSide || '').toUpperCase();
  if (threshold == null || quantity == null || !quantity || averagePrice == null || !['YES', 'NO'].includes(side)) return 0;
  const yesWins = Number(state.settlementValue) > threshold;
  const wins = side === 'YES' ? yesWins : !yesWins;
  return quantity * ((wins ? 1 : 0) - averagePrice);
}

function cvarLowerTail(states = [], key = 'combinedPnl', tailProbability = 0.05) {
  const ordered = [...states].sort((left, right) => Number(left[key]) - Number(right[key]));
  let remaining = tailProbability;
  let weighted = 0;
  ordered.forEach((state) => {
    if (remaining <= 0) return;
    const used = Math.min(remaining, state.probability);
    weighted += used * Number(state[key] || 0);
    remaining -= used;
  });
  const usedProbability = tailProbability - remaining;
  return usedProbability > 0 ? weighted / usedProbability : 0;
}

function allocationUnavailable(reason, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    requestedRiskPct: extra.requestedRiskPct ?? null,
    requestedBudget: extra.requestedBudget ?? null,
    effectiveBudget: extra.effectiveBudget ?? null,
    deployedBudget: 0,
    residualBudget: extra.effectiveBudget ?? 0,
    probabilityCurve: extra.probabilityCurve || null,
    allocations: [],
    settlementStates: [],
    metrics: null,
    warnings: extra.warnings || [],
  };
}

function incrementalUtility({ candidate, addContracts, currentContracts, states, portfolioEquity, currentPnl, proposedPnl }) {
  const nextContracts = currentContracts + addContracts;
  const feeDelta = candidate.feeModel.total(nextContracts, candidate.price) -
    candidate.feeModel.total(currentContracts, candidate.price);
  let utility = 0;
  const increments = states.map((state, index) => {
    const yesWins = Number(state.settlementValue) > candidate.threshold;
    const wins = candidate.side === 'YES' ? yesWins : !yesWins;
    const increment = addContracts * (
      (wins ? candidate.payoutMultiplier : 0) -
      (candidate.price * candidate.payoutMultiplier)
    ) - feeDelta;
    const before = portfolioEquity + currentPnl[index] + proposedPnl[index];
    const after = before + increment;
    if (before <= 0 || after <= 0) return { invalid: true, value: increment };
    utility += state.probability * (Math.log(after) - Math.log(before));
    return { invalid: false, value: increment };
  });
  if (increments.some((entry) => entry.invalid)) return null;
  return { utility, increments: increments.map((entry) => entry.value), feeDelta };
}

function candidateForSide(row, side, curveEntry, settings, now) {
  if (
    row?.missingContract || rowHasRejectedFlags(row) ||
    row?.event?.heldPosition || row?.event?.source_api === 'IBKR_PORTFOLIO' ||
    !isFreshRow(row, now, settings.quoteMaxAgeMs)
  ) return null;
  const threshold = eventThreshold(row);
  const price = finiteNumber(side === 'YES' ? row.yesPrice : row.noPrice);
  const depth = sideDepth(row, side);
  const feeModel = feeModelForRow(row);
  const payoutMultiplier = finiteNumber(row.payoutMultiplier ?? row.event?.max_payout_per_contract) || 1;
  if (
    threshold == null || price == null || price <= 0 || price >= 1 ||
    !depth || depth.value <= 0 || !feeModel
  ) return null;
  const fairProbability = side === 'YES'
    ? curveEntry.fairProbability
    : 1 - curveEntry.fairProbability;
  const candidate = {
    id: `${row.id}-${side}`,
    row,
    threshold,
    side,
    price,
    fairProbability,
    payoutMultiplier,
    depthCap: depth.value,
    depthSource: depth.source,
    feeModel,
    netEdge: (payoutMultiplier * (fairProbability - price)) - feeModel.marginalRate(price),
  };
  candidate.maxContracts = maxContractsUnderCost(candidate, settings.maxRiskPerBet);
  return candidate.maxContracts > 0 ? candidate : null;
}

function quantityForBlock(candidate, currentContracts, targetCost, remainingBudget) {
  const capacity = candidate.maxContracts - currentContracts;
  if (capacity <= 0) return 0;
  const currentCost = candidateCost(candidate, currentContracts);
  const limit = Math.min(remainingBudget, Math.max(
    targetCost,
    candidateCost(candidate, currentContracts + 1) - currentCost,
  ));
  let low = 0;
  let high = capacity;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const delta = candidateCost(candidate, currentContracts + middle) - currentCost;
    if (delta <= limit + 1e-9) low = middle;
    else high = middle - 1;
  }
  return low;
}

function candidateSelectionScore(candidate, states, portfolioEquity, currentPnl) {
  const result = incrementalUtility({
    candidate,
    addContracts: 1,
    currentContracts: 0,
    states,
    portfolioEquity,
    currentPnl,
    proposedPnl: states.map(() => 0),
  });
  const cost = candidateCost(candidate, 1);
  return result && cost > 0 ? result.utility / cost : -Infinity;
}

function buildPlanRows(rows, curve, selectedCandidates, quantities) {
  const curveByStrike = new Map(curve.probabilities.map((entry) => [entry.threshold.toFixed(4), entry]));
  const selectedByStrike = new Map(selectedCandidates.map((candidate) => [candidate.threshold.toFixed(4), candidate]));
  const uniqueRows = new Map();
  rows.forEach((row) => {
    const threshold = eventThreshold(row);
    if (threshold == null || row.missingContract) return;
    const key = threshold.toFixed(4);
    if (!uniqueRows.has(key)) uniqueRows.set(key, row);
  });

  return [...uniqueRows.entries()].map(([key, row]) => {
    const curveEntry = curveByStrike.get(key);
    const candidate = selectedByStrike.get(key);
    const contracts = candidate ? quantities.get(candidate.id) || 0 : 0;
    const fees = candidate ? candidate.feeModel.total(contracts, candidate.price) : 0;
    const entryCost = candidate ? contracts * candidate.price * candidate.payoutMultiplier : 0;
    return {
      id: candidate?.id || `${row.id}-unallocated`,
      row,
      threshold: eventThreshold(row),
      side: candidate?.side || null,
      eligible: Boolean(candidate),
      fairProbability: candidate?.fairProbability ?? curveEntry?.fairProbability ?? null,
      ask: candidate?.price ?? null,
      netEdge: candidate?.netEdge ?? null,
      depthCap: candidate?.depthCap ?? 0,
      depthSource: candidate?.depthSource ?? null,
      contracts,
      entryCost,
      fees,
      allocation: entryCost + fees,
      maxLoss: entryCost + fees,
      expectedPnl: candidate
        ? contracts * candidate.payoutMultiplier * (candidate.fairProbability - candidate.price) - fees
        : 0,
    };
  }).sort((left, right) => left.threshold - right.threshold);
}

export function buildCpiAllocationModel({
  model = null,
  history = [],
  finals = [],
  rows = [],
  openPositions = [],
  portfolioEquity = null,
  riskPct = 1,
  settings: rawSettings = {},
  currentOpenRisk = null,
  providerReady = null,
  now = Date.now(),
} = {}) {
  const settings = { ...DEFAULT_CPI_ALLOCATION_SETTINGS, ...(rawSettings || {}) };
  const equity = finiteNumber(portfolioEquity);
  const pct = finiteNumber(riskPct);
  if (equity == null || equity <= 0) return allocationUnavailable('live_nlv_unavailable');
  if (pct == null || pct <= 0) return allocationUnavailable('invalid_risk_percentage');
  if (providerReady === false) return allocationUnavailable('live_provider_unavailable', {
    requestedRiskPct: pct,
    requestedBudget: equity * (pct / 100),
  });

  const requestedBudget = equity * (pct / 100);
  const curve = buildCpiCalibratedProbabilityCurve({
    model,
    history,
    finals,
    rows,
    minObservations: settings.minCalibrationObservations,
    priorObservations: settings.historyPriorObservations,
  });
  if (curve.status !== 'ready') {
    return allocationUnavailable(curve.reason, {
      requestedRiskPct: pct,
      requestedBudget,
      probabilityCurve: curve,
      warnings: curve.warnings,
    });
  }

  const states = buildSettlementStates(curve.probabilities);
  const currentPnl = states.map((state) => (
    (openPositions || []).reduce((sum, position) => sum + currentPositionPnl(position, state), 0)
  ));
  const currentWorstLoss = Math.max(0, -Math.min(...currentPnl, 0));
  const openRiskUsed = finiteNumber(currentOpenRisk) ?? currentWorstLoss;
  const remainingOpenRisk = Math.max(0, Number(settings.maxOpenRisk) - openRiskUsed);
  const remainingCorrelatedRisk = Math.max(0, Number(settings.maxCorrelatedExposure) - currentWorstLoss);
  const remainingPortfolioRisk = Math.max(0, (equity * Number(settings.maxPmRiskPct)) - openRiskUsed);
  const effectiveBudget = Math.max(0, Math.min(
    requestedBudget,
    remainingOpenRisk,
    remainingCorrelatedRisk,
    remainingPortfolioRisk,
  ));

  const curveByStrike = new Map(curve.probabilities.map((entry) => [entry.threshold.toFixed(4), entry]));
  const candidatesByStrike = new Map();
  rows.forEach((row) => {
    const threshold = eventThreshold(row);
    const curveEntry = threshold == null ? null : curveByStrike.get(threshold.toFixed(4));
    if (!curveEntry) return;
    const candidates = ['YES', 'NO']
      .map((side) => candidateForSide(row, side, curveEntry, settings, Number(now)))
      .filter(Boolean);
    if (!candidates.length) return;
    const key = threshold.toFixed(4);
    if (!candidatesByStrike.has(key)) candidatesByStrike.set(key, []);
    candidatesByStrike.get(key).push(...candidates);
  });

  const selectedCandidates = [...candidatesByStrike.values()].map((candidates) => (
    [...candidates].sort((left, right) => {
      const scoreDiff = candidateSelectionScore(right, states, equity, currentPnl) -
        candidateSelectionScore(left, states, equity, currentPnl);
      if (Math.abs(scoreDiff) > 1e-15) return scoreDiff;
      if (right.netEdge !== left.netEdge) return right.netEdge - left.netEdge;
      return left.side === 'YES' ? -1 : 1;
    })[0]
  )).filter(Boolean);

  if (!selectedCandidates.length) {
    return allocationUnavailable('no_live_executable_depth', {
      requestedRiskPct: pct,
      requestedBudget,
      effectiveBudget,
      probabilityCurve: curve,
      warnings: ['No strike has a fresh executable ask, native depth, and known fee schedule.'],
    });
  }

  const quantities = new Map(selectedCandidates.map((candidate) => [candidate.id, 0]));
  const proposedPnl = states.map(() => 0);
  let deployedBudget = 0;
  let iterations = 0;
  let negativeMarginalDeployment = false;
  const maxIterations = 10000;

  while (iterations < maxIterations && deployedBudget < effectiveBudget - 0.000001) {
    const remaining = effectiveBudget - deployedBudget;
    const targetBlock = remaining > 200 ? Math.min(10, remaining / 50)
      : remaining > 20 ? 1
        : remaining > 2 ? 0.25
          : remaining;
    let best = null;

    selectedCandidates.forEach((candidate) => {
      const currentContracts = quantities.get(candidate.id) || 0;
      const addContracts = quantityForBlock(candidate, currentContracts, targetBlock, remaining);
      if (!addContracts) return;
      const nextCost = candidateCost(candidate, currentContracts + addContracts);
      const currentCost = candidateCost(candidate, currentContracts);
      const costDelta = nextCost - currentCost;
      if (costDelta <= 0 || costDelta > remaining + 1e-9) return;
      const result = incrementalUtility({
        candidate,
        addContracts,
        currentContracts,
        states,
        portfolioEquity: equity,
        currentPnl,
        proposedPnl,
      });
      if (!result) return;
      const score = result.utility / costDelta;
      if (
        !best || score > best.score + 1e-15 ||
        (Math.abs(score - best.score) <= 1e-15 && candidate.threshold < best.candidate.threshold) ||
        (Math.abs(score - best.score) <= 1e-15 && candidate.threshold === best.candidate.threshold && candidate.side === 'YES')
      ) {
        best = { candidate, addContracts, costDelta, result, score };
      }
    });

    if (!best) break;
    if (best.score < 0) negativeMarginalDeployment = true;
    quantities.set(best.candidate.id, (quantities.get(best.candidate.id) || 0) + best.addContracts);
    best.result.increments.forEach((increment, index) => {
      proposedPnl[index] += increment;
    });
    deployedBudget += best.costDelta;
    iterations += 1;
  }

  deployedBudget = selectedCandidates.reduce((sum, candidate) => (
    sum + candidateCost(candidate, quantities.get(candidate.id) || 0)
  ), 0);
  const planRows = buildPlanRows(rows, curve, selectedCandidates, quantities);
  const settlementStates = states.map((state, index) => ({
    ...state,
    currentPnl: currentPnl[index],
    proposedPnl: proposedPnl[index],
    combinedPnl: currentPnl[index] + proposedPnl[index],
  }));
  const expectedPnl = settlementStates.reduce((sum, state) => sum + state.probability * state.proposedPnl, 0);
  const expectedCombinedPnl = settlementStates.reduce((sum, state) => sum + state.probability * state.combinedPnl, 0);
  const proposedWorstPnl = Math.min(...settlementStates.map((state) => state.proposedPnl), 0);
  const combinedWorstPnl = Math.min(...settlementStates.map((state) => state.combinedPnl), 0);
  const totalFees = planRows.reduce((sum, row) => sum + row.fees, 0);
  const residualBudget = Math.max(0, effectiveBudget - deployedBudget);
  const forcedDeployment = deployedBudget > 0 && negativeMarginalDeployment;
  const warnings = [
    ...curve.warnings,
    ...(effectiveBudget < requestedBudget - 0.01
      ? ['Requested budget reduced by portfolio risk guardrails.']
      : []),
    ...(forcedDeployment
      ? ['Mandate override: full-deployment mode allocated capital after marginal expected-log utility turned negative.']
      : []),
    ...(residualBudget >= 0.01
      ? ['Residual cash remains because live depth, per-strike caps, or contract increments prevented further deployment.']
      : []),
  ];

  return {
    status: 'ready',
    reason: null,
    requestedRiskPct: pct,
    requestedBudget,
    effectiveBudget,
    deployedBudget,
    residualBudget,
    probabilityCurve: curve,
    allocations: planRows,
    settlementStates,
    metrics: {
      calibrationObservations: curve.observations,
      expectedPnl,
      expectedCombinedPnl,
      proposedWorstPnl,
      combinedWorstPnl,
      cvar95: cvarLowerTail(settlementStates, 'combinedPnl'),
      totalFees,
      currentWorstLoss,
      postTradeWorstLoss: Math.max(0, -combinedWorstPnl),
      postTradeRiskPct: equity > 0 ? Math.max(0, -combinedWorstPnl) / equity : null,
      forcedDeployment,
    },
    warnings,
  };
}
