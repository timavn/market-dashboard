const { buildAdjustedReturns } = require('./securityRiskMetrics.cjs');
const {
  DEFAULT_CORRELATION_WINDOWS,
  DEFAULT_COVARIANCE_SHRINKAGE,
  DEFAULT_COVARIANCE_WINDOW,
  DEFAULT_FACTOR_MIN_OBSERVATIONS,
  DEFAULT_HALF_LIFE,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_REGRESSION_SESSIONS,
  DEFAULT_RIDGE_LAMBDA,
  DEFAULT_SEASONED_OBSERVATIONS,
  FACTOR_DEFINITIONS,
  MODEL_VERSION,
  SAMPLE_SIZE_TIERS,
} = require('../constants/exposureLabModel.cjs');

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function classifySampleQuality(observations, {
  minimumObservations = DEFAULT_MIN_OBSERVATIONS,
  seasonedObservations = DEFAULT_SEASONED_OBSERVATIONS,
  tiers = SAMPLE_SIZE_TIERS,
} = {}) {
  const count = Math.max(0, Math.floor(finiteNumber(observations) || 0));
  const floor = Math.max(1, Math.floor(finiteNumber(minimumObservations) || DEFAULT_MIN_OBSERVATIONS));
  const seasonedFloor = Math.max(
    floor,
    Math.floor(finiteNumber(seasonedObservations) || DEFAULT_SEASONED_OBSERVATIONS),
  );
  const thresholds = [...new Set([
    ...(Array.isArray(tiers) ? tiers : SAMPLE_SIZE_TIERS),
    floor,
    seasonedFloor,
  ].map((value) => Math.floor(finiteNumber(value) || 0)).filter((value) => value > 0))]
    .sort((left, right) => left - right);
  const reachedTier = thresholds.filter((value) => value <= count).at(-1) || null;
  const complete = count >= seasonedFloor;
  const nextTier = complete
    ? null
    : thresholds.find((value) => value > count) || seasonedFloor;
  let state = 'insufficient';
  if (count >= floor) {
    if (complete) state = 'seasoned';
    else if (reachedTier >= 90) state = 'moderate';
    else if (reachedTier >= 60) state = 'building';
    else state = 'early';
  }

  return {
    observations: count,
    minimumObservations: floor,
    seasonedObservations: seasonedFloor,
    tier: reachedTier,
    tierLabel: reachedTier == null ? `<${floor}` : `${reachedTier}${complete ? '+' : ''}`,
    state,
    preliminary: count >= floor && !complete,
    complete,
    nextTier,
    observationsToNextTier: nextTier == null ? 0 : Math.max(0, nextTier - count),
  };
}

function getFactorProxySymbols(definitions = FACTOR_DEFINITIONS) {
  return [...new Set(
    (Array.isArray(definitions) ? definitions : [])
      .flatMap((definition) => [definition.longSymbol, definition.shortSymbol])
      .map(normalizeSymbol)
      .filter(Boolean),
  )];
}

function returnsByDate(bars) {
  return new Map(buildAdjustedReturns(bars).map((row) => [row.date, row.value]));
}

function buildFactorReturnSeries(histories = {}, definitions = FACTOR_DEFINITIONS) {
  const symbolReturns = new Map();
  for (const symbol of getFactorProxySymbols(definitions)) {
    symbolReturns.set(symbol, returnsByDate(histories[symbol] || []));
  }

  return (Array.isArray(definitions) ? definitions : []).map((definition) => {
    const longSymbol = normalizeSymbol(definition.longSymbol);
    const shortSymbol = normalizeSymbol(definition.shortSymbol);
    const longReturns = symbolReturns.get(longSymbol) || new Map();
    const shortReturns = shortSymbol ? symbolReturns.get(shortSymbol) || new Map() : null;
    const rows = [];
    for (const [date, longValue] of longReturns.entries()) {
      if (!Number.isFinite(longValue)) continue;
      if (shortReturns) {
        const shortValue = shortReturns.get(date);
        if (!Number.isFinite(shortValue)) continue;
        rows.push({ date, value: longValue - shortValue });
      } else {
        rows.push({ date, value: longValue });
      }
    }
    rows.sort((left, right) => left.date.localeCompare(right.date));
    return {
      ...definition,
      longSymbol,
      shortSymbol: shortSymbol || null,
      formula: shortSymbol ? `${longSymbol} - ${shortSymbol}` : longSymbol,
      series: rows,
      observations: rows.length,
      asOf: rows.at(-1)?.date || null,
      status: rows.length > 1 ? 'available' : 'unavailable',
    };
  });
}

function alignFactorRows(factorSeries, { window = null, minimumObservations = 1 } = {}) {
  const available = (Array.isArray(factorSeries) ? factorSeries : [])
    .filter((factor) => factor.status === 'available' && factor.observations >= minimumObservations);
  if (available.length === 0) return { factors: [], rows: [] };

  const maps = available.map((factor) => new Map(factor.series.map((row) => [row.date, row.value])));
  const commonDates = [...maps[0].keys()]
    .filter((date) => maps.every((map) => map.has(date)))
    .sort();
  const selectedDates = Number.isInteger(window) && window > 0
    ? commonDates.slice(-window)
    : commonDates;
  return {
    factors: available,
    rows: selectedDates.map((date) => ({
      date,
      values: maps.map((map) => map.get(date)),
    })),
  };
}

function exponentialWeights(length, halfLife = DEFAULT_HALF_LIFE) {
  if (!Number.isInteger(length) || length <= 0) return [];
  const decay = Math.log(2) / Math.max(1, halfLife);
  const raw = Array.from({ length }, (_, index) => Math.exp(-decay * (length - 1 - index)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  if (size === 0 || matrix.length !== size) return [];
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    if (pivot !== column) [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function regressSecurityReturns({
  securityBars,
  factorRows,
  factors,
  sessions = DEFAULT_REGRESSION_SESSIONS,
  minObservations = DEFAULT_MIN_OBSERVATIONS,
  seasonedObservations = DEFAULT_SEASONED_OBSERVATIONS,
  halfLife = DEFAULT_HALF_LIFE,
  ridgeLambda = DEFAULT_RIDGE_LAMBDA,
} = {}) {
  const securityReturns = returnsByDate(securityBars || []);
  const aligned = (Array.isArray(factorRows) ? factorRows : [])
    .filter((row) => securityReturns.has(row.date))
    .map((row) => ({ ...row, target: securityReturns.get(row.date) }))
    .slice(-sessions);
  const factorCount = Array.isArray(factors) ? factors.length : 0;
  const sampleQuality = classifySampleQuality(aligned.length, {
    minimumObservations: minObservations,
    seasonedObservations,
  });
  if (factorCount === 0 || aligned.length < minObservations) {
    return {
      status: 'unavailable',
      reason: factorCount === 0 ? 'factor_history_unavailable' : 'insufficient_aligned_returns',
      observations: aligned.length,
      sampleQuality,
      asOf: aligned.at(-1)?.date || null,
      loadings: {},
      residualVariance: null,
      rSquared: null,
    };
  }

  const weights = exponentialWeights(aligned.length, halfLife);
  const targetMean = aligned.reduce((sum, row, index) => sum + weights[index] * row.target, 0);
  const means = Array.from({ length: factorCount }, (_, column) => (
    aligned.reduce((sum, row, index) => sum + weights[index] * row.values[column], 0)
  ));
  const standardDeviations = means.map((mean, column) => Math.sqrt(
    aligned.reduce((sum, row, index) => {
      const delta = row.values[column] - mean;
      return sum + weights[index] * delta * delta;
    }, 0),
  ));

  if (standardDeviations.some((value) => !Number.isFinite(value) || value <= 1e-12)) {
    return {
      status: 'unavailable',
      reason: 'zero_factor_variance',
      observations: aligned.length,
      sampleQuality,
      asOf: aligned.at(-1)?.date || null,
      loadings: {},
      residualVariance: null,
      rSquared: null,
    };
  }

  const normalMatrix = Array.from({ length: factorCount }, () => Array(factorCount).fill(0));
  const normalVector = Array(factorCount).fill(0);
  aligned.forEach((row, rowIndex) => {
    const standardized = row.values.map((value, column) => (
      (value - means[column]) / standardDeviations[column]
    ));
    const centeredTarget = row.target - targetMean;
    const weight = weights[rowIndex];
    for (let left = 0; left < factorCount; left += 1) {
      normalVector[left] += weight * standardized[left] * centeredTarget;
      for (let right = 0; right < factorCount; right += 1) {
        normalMatrix[left][right] += weight * standardized[left] * standardized[right];
      }
    }
  });
  for (let index = 0; index < factorCount; index += 1) normalMatrix[index][index] += ridgeLambda;

  const standardizedCoefficients = solveLinearSystem(normalMatrix, normalVector);
  if (!standardizedCoefficients) {
    return {
      status: 'unavailable',
      reason: 'singular_factor_system',
      observations: aligned.length,
      sampleQuality,
      asOf: aligned.at(-1)?.date || null,
      loadings: {},
      residualVariance: null,
      rSquared: null,
    };
  }
  const coefficients = standardizedCoefficients.map((value, column) => (
    value / standardDeviations[column]
  ));
  const intercept = targetMean - coefficients.reduce((sum, value, column) => (
    sum + value * means[column]
  ), 0);

  let residualVariance = 0;
  let totalVariance = 0;
  aligned.forEach((row, rowIndex) => {
    const prediction = intercept + coefficients.reduce((sum, coefficient, column) => (
      sum + coefficient * row.values[column]
    ), 0);
    const residual = row.target - prediction;
    const targetDelta = row.target - targetMean;
    residualVariance += weights[rowIndex] * residual * residual;
    totalVariance += weights[rowIndex] * targetDelta * targetDelta;
  });
  const loadings = Object.fromEntries(factors.map((factor, index) => [factor.id, {
    value: round(coefficients[index]),
    status: 'available',
  }]));

  return {
    status: 'available',
    reason: null,
    observations: aligned.length,
    sampleQuality,
    asOf: aligned.at(-1)?.date || null,
    intercept: round(intercept, 8),
    loadings,
    residualVariance: round(Math.max(0, residualVariance), 10),
    rSquared: totalVariance > 0
      ? round(Math.max(-1, Math.min(1, 1 - residualVariance / totalVariance)), 4)
      : null,
    methodology: {
      sessions,
      minObservations,
      seasonedObservations: sampleQuality.seasonedObservations,
      sampleSizeTiers: SAMPLE_SIZE_TIERS,
      halfLife,
      ridgeLambda,
      returnBasis: 'adjusted-close simple daily returns over completed sessions',
    },
  };
}

function covarianceMatrix(rows, factorCount, shrinkage = DEFAULT_COVARIANCE_SHRINKAGE) {
  if (!Array.isArray(rows) || rows.length < 2 || factorCount <= 0) return [];
  const means = Array.from({ length: factorCount }, (_, column) => (
    rows.reduce((sum, row) => sum + row.values[column], 0) / rows.length
  ));
  const denominator = rows.length - 1;
  const matrix = Array.from({ length: factorCount }, () => Array(factorCount).fill(0));
  for (let left = 0; left < factorCount; left += 1) {
    for (let right = left; right < factorCount; right += 1) {
      const sample = rows.reduce((sum, row) => (
        sum + (row.values[left] - means[left]) * (row.values[right] - means[right])
      ), 0) / denominator;
      const value = left === right ? sample : sample * (1 - shrinkage);
      matrix[left][right] = value;
      matrix[right][left] = value;
    }
  }
  return matrix;
}

function calculateCorrelation(seriesA, seriesB, window) {
  const first = new Map((seriesA || []).map((row) => [row.date, row.value]));
  const aligned = (seriesB || [])
    .filter((row) => first.has(row.date))
    .map((row) => [first.get(row.date), row.value])
    .slice(-window);
  const minObservations = Math.max(10, Math.ceil(window * 0.45));
  if (aligned.length < minObservations) return { value: null, observations: aligned.length };
  const meanA = aligned.reduce((sum, row) => sum + row[0], 0) / aligned.length;
  const meanB = aligned.reduce((sum, row) => sum + row[1], 0) / aligned.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [a, b] of aligned) {
    const deltaA = a - meanA;
    const deltaB = b - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  if (varianceA <= 0 || varianceB <= 0) return { value: null, observations: aligned.length };
  return {
    value: round(Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceA * varianceB))), 4),
    observations: aligned.length,
  };
}

function buildFactorCorrelationMatrices(factorSeries, windows = DEFAULT_CORRELATION_WINDOWS) {
  const available = (factorSeries || []).filter((factor) => factor.status === 'available');
  return Object.fromEntries((windows || []).map((window) => {
    const matrix = {};
    available.forEach((rowFactor) => {
      matrix[rowFactor.id] = {};
      available.forEach((columnFactor) => {
        matrix[rowFactor.id][columnFactor.id] = rowFactor.id === columnFactor.id
          ? { value: 1, observations: Math.min(window, rowFactor.observations) }
          : calculateCorrelation(rowFactor.series, columnFactor.series, window);
      });
    });
    return [String(window), matrix];
  }));
}

function matrixVectorMultiply(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function serializeFactor(factor) {
  const { series: _series, ...metadata } = factor;
  return metadata;
}

function buildUnavailableSnapshot(reason, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    modelVersion: MODEL_VERSION,
    historicalOnly: true,
    executable: false,
    factors: [],
    positions: [],
    portfolio: null,
    correlations: {},
    coverage: {
      modeledPositionCount: 0,
      totalPositionCount: 0,
      modeledGrossNavPct: 0,
      unmodeledGrossNavPct: 0,
    },
    ...extra,
  };
}

function buildPortfolioFactorRiskSnapshot({
  holdings = [],
  totalValue = null,
  histories = {},
  factorDefinitions = FACTOR_DEFINITIONS,
  benchmarkSymbol = 'SPY',
  regressionSessions = DEFAULT_REGRESSION_SESSIONS,
  minObservations = DEFAULT_MIN_OBSERVATIONS,
  seasonedObservations = DEFAULT_SEASONED_OBSERVATIONS,
  factorMinObservations = DEFAULT_FACTOR_MIN_OBSERVATIONS,
  covarianceWindow = DEFAULT_COVARIANCE_WINDOW,
  correlationWindows = DEFAULT_CORRELATION_WINDOWS,
} = {}) {
  const nav = finiteNumber(totalValue);
  if (!(nav > 0)) return buildUnavailableSnapshot('net_liquidation_unavailable');
  const factorSeries = buildFactorReturnSeries(histories, factorDefinitions);
  const aligned = alignFactorRows(factorSeries, { minimumObservations: factorMinObservations });
  if (aligned.factors.length === 0 || aligned.rows.length < factorMinObservations) {
    return buildUnavailableSnapshot('factor_history_unavailable', {
      factors: factorSeries.map(serializeFactor),
    });
  }

  const portfolioHoldings = (Array.isArray(holdings) ? holdings : [])
    .map((holding) => ({
      ...holding,
      symbol: normalizeSymbol(holding?.symbol),
      marketValue: finiteNumber(holding?.marketValue),
      quantity: finiteNumber(holding?.quantity),
    }))
    .filter((holding) => holding.symbol && holding.marketValue != null && holding.marketValue !== 0);
  const symbols = [...new Set(portfolioHoldings.map((holding) => holding.symbol))];
  const securityModels = {};
  for (const symbol of [...new Set([...symbols, normalizeSymbol(benchmarkSymbol)])]) {
    securityModels[symbol] = regressSecurityReturns({
      securityBars: histories[symbol] || [],
      factorRows: aligned.rows,
      factors: aligned.factors,
      sessions: regressionSessions,
      minObservations,
      seasonedObservations,
    });
  }

  const factorIds = aligned.factors.map((factor) => factor.id);
  const netLoadings = Array(factorIds.length).fill(0);
  const grossLoadings = Array(factorIds.length).fill(0);
  let residualVariance = 0;
  let modeledGrossNavPct = 0;
  let preliminaryGrossNavPct = 0;
  let seasonedGrossNavPct = 0;
  let unmodeledGrossNavPct = 0;
  let netExposurePct = 0;
  let grossExposurePct = 0;

  const positions = portfolioHoldings.map((holding) => {
    const weight = holding.marketValue / nav;
    const weightPct = weight * 100;
    const model = securityModels[holding.symbol];
    const modeled = model?.status === 'available';
    netExposurePct += weightPct;
    grossExposurePct += Math.abs(weightPct);
    if (modeled) {
      modeledGrossNavPct += Math.abs(weightPct);
      if (model.sampleQuality?.complete === true) seasonedGrossNavPct += Math.abs(weightPct);
      else preliminaryGrossNavPct += Math.abs(weightPct);
    } else unmodeledGrossNavPct += Math.abs(weightPct);
    const contributions = {};
    factorIds.forEach((factorId, index) => {
      const loading = finiteNumber(model?.loadings?.[factorId]?.value);
      if (loading == null) {
        contributions[factorId] = null;
        return;
      }
      const contribution = weight * loading;
      netLoadings[index] += contribution;
      grossLoadings[index] += Math.abs(contribution);
      contributions[factorId] = round(contribution * 100, 3);
    });
    if (modeled && Number.isFinite(model.residualVariance)) {
      residualVariance += weight * weight * model.residualVariance;
    }
    return {
      symbol: holding.symbol,
      name: holding.description || holding.name || holding.symbol,
      side: weight < 0 ? 'short' : 'long',
      marketValue: holding.marketValue,
      quantity: holding.quantity,
      signedWeightPct: round(weightPct, 3),
      grossWeightPct: round(Math.abs(weightPct), 3),
      modelStatus: model?.status || 'unavailable',
      modelReason: model?.reason || null,
      observations: model?.observations || 0,
      sampleQuality: model?.sampleQuality || classifySampleQuality(model?.observations || 0, {
        minimumObservations: minObservations,
        seasonedObservations,
      }),
      rSquared: model?.rSquared ?? null,
      contributions,
      loadings: model?.loadings || {},
    };
  }).sort((left, right) => right.grossWeightPct - left.grossWeightPct || left.symbol.localeCompare(right.symbol));

  const covarianceRows = aligned.rows.slice(-covarianceWindow);
  const covariance = covarianceMatrix(covarianceRows, factorIds.length);
  if (covariance.length === 0) {
    return buildUnavailableSnapshot('factor_covariance_unavailable', {
      factors: factorSeries.map(serializeFactor),
      positions,
    });
  }
  const covarianceTimesExposure = matrixVectorMultiply(covariance, netLoadings);
  const factorVariance = Math.max(0, dot(netLoadings, covarianceTimesExposure));
  const totalVariance = Math.max(0, factorVariance + residualVariance);
  const benchmarkModel = securityModels[normalizeSymbol(benchmarkSymbol)];

  const factorRows = aligned.factors.map((factor, index) => {
    const contributionToVariance = netLoadings[index] * covarianceTimesExposure[index];
    const benchmarkLoading = finiteNumber(benchmarkModel?.loadings?.[factor.id]?.value);
    return {
      ...serializeFactor(factor),
      netExposure: round(netLoadings[index], 4),
      netExposurePct: round(netLoadings[index] * 100, 3),
      grossExposure: round(grossLoadings[index], 4),
      grossExposurePct: round(grossLoadings[index] * 100, 3),
      spyRelativeExposure: benchmarkLoading == null ? null : round(netLoadings[index] - benchmarkLoading, 4),
      spyRelativeExposurePct: benchmarkLoading == null ? null : round((netLoadings[index] - benchmarkLoading) * 100, 3),
      contributionToVariance: round(contributionToVariance, 10),
      contributionToTotalRiskPct: totalVariance > 0
        ? round((contributionToVariance / totalVariance) * 100, 2)
        : null,
    };
  });

  return {
    status: positions.some((position) => (
      position.modelStatus !== 'available' || position.sampleQuality?.complete !== true
    )) ? 'partial' : 'available',
    reason: null,
    modelVersion: MODEL_VERSION,
    historicalOnly: true,
    executable: false,
    asOf: covarianceRows.at(-1)?.date || null,
    factors: factorRows,
    positions,
    portfolio: {
      netExposurePct: round(netExposurePct, 2),
      grossExposurePct: round(grossExposurePct, 2),
      predictedAnnualizedVolPct: totalVariance > 0 ? round(Math.sqrt(totalVariance * 252) * 100, 2) : null,
      factorAnnualizedVolPct: factorVariance > 0 ? round(Math.sqrt(factorVariance * 252) * 100, 2) : null,
      residualAnnualizedVolPct: residualVariance > 0 ? round(Math.sqrt(residualVariance * 252) * 100, 2) : null,
      factorVariance: round(factorVariance, 10),
      residualVariance: round(residualVariance, 10),
      totalVariance: round(totalVariance, 10),
      benchmark: normalizeSymbol(benchmarkSymbol),
    },
    correlations: buildFactorCorrelationMatrices(factorSeries, correlationWindows),
    covariance: {
      factorIds,
      window: covarianceWindow,
      observations: covarianceRows.length,
      shrinkage: DEFAULT_COVARIANCE_SHRINKAGE,
      matrix: covariance.map((row) => row.map((value) => round(value, 10))),
    },
    coverage: {
      modeledPositionCount: positions.filter((position) => position.modelStatus === 'available').length,
      seasonedPositionCount: positions.filter((position) => position.sampleQuality?.complete === true).length,
      preliminaryPositionCount: positions.filter((position) => (
        position.modelStatus === 'available' && position.sampleQuality?.preliminary === true
      )).length,
      totalPositionCount: positions.length,
      modeledGrossNavPct: round(modeledGrossNavPct, 2),
      seasonedGrossNavPct: round(seasonedGrossNavPct, 2),
      preliminaryGrossNavPct: round(preliminaryGrossNavPct, 2),
      unmodeledGrossNavPct: round(unmodeledGrossNavPct, 2),
    },
    provenance: {
      provider: 'Yahoo Finance chart API',
      returnBasis: 'explicit adjusted close; completed daily sessions only',
      regressionSessions,
      minObservations,
      seasonedObservations,
      factorMinObservations,
      sampleSizeTiers: SAMPLE_SIZE_TIERS,
      covarianceWindow,
      correlationWindows,
      factorDefinitions: factorRows.map((factor) => ({
        id: factor.id,
        formula: factor.formula,
        asOf: factor.asOf,
        observations: factor.observations,
      })),
    },
  };
}

function buildFactorNeutralizationScenarios({
  riskSnapshot,
  totalValue,
  factorDefinitions = FACTOR_DEFINITIONS,
  securityReviews = [],
  portfolioMode = 'unavailable',
  tolerancePct = 0.5,
  securityMasterAvailable = true,
} = {}) {
  const nav = finiteNumber(totalValue);
  const definitions = new Map(
    (Array.isArray(factorDefinitions) ? factorDefinitions : []).map((factor) => [factor.id, factor]),
  );
  const reviewsBySymbol = new Map();
  for (const review of Array.isArray(securityReviews) ? securityReviews : []) {
    for (const symbol of [review?.ticker, review?.canonicalSymbol]) {
      const normalized = normalizeSymbol(symbol);
      if (normalized) reviewsBySymbol.set(normalized, review);
    }
  }
  const riskUsable = ['available', 'partial'].includes(riskSnapshot?.status) && nav > 0;
  const liveMarksVerified = portfolioMode === 'live';
  const modeledPositions = Array.isArray(riskSnapshot?.positions) ? riskSnapshot.positions : [];
  const hasUnmodeledPositions = modeledPositions.some((position) => (
    position?.modelStatus !== 'available'
  ));
  const hasPreliminaryModels = modeledPositions.some((position) => (
    position?.modelStatus === 'available' && position?.sampleQuality?.complete !== true
  ));
  const globalBlockers = [
    ...(!riskUsable ? ['factor_risk_snapshot_unavailable'] : []),
    ...(!liveMarksVerified ? ['live_marks_unavailable'] : []),
    ...(!securityMasterAvailable ? ['security_master_unavailable'] : []),
    ...(hasUnmodeledPositions ? ['incomplete_security_model_coverage'] : []),
    ...(hasPreliminaryModels ? ['preliminary_security_models'] : []),
  ];

  const rows = (Array.isArray(riskSnapshot?.factors) ? riskSnapshot.factors : []).map((factor) => {
    const definition = definitions.get(factor.id) || factor;
    const requiredSymbols = [definition.longSymbol, definition.shortSymbol]
      .map(normalizeSymbol)
      .filter(Boolean);
    const unreviewedSymbols = requiredSymbols.filter((symbol) => {
      const review = reviewsBySymbol.get(symbol);
      return !(
        review?.identityStatus === 'verified'
        && review?.analysisEligible === true
        && review?.hedgeEligible === true
      );
    });
    const currentExposurePct = finiteNumber(factor.netExposurePct);
    const withinTolerance = currentExposurePct != null
      && Math.abs(currentExposurePct) <= Math.max(0, Number(tolerancePct) || 0);
    const blockers = [
      ...globalBlockers,
      ...(unreviewedSymbols.length > 0 ? ['hedge_instrument_review_incomplete'] : []),
    ];
    const previewAvailable = blockers.length === 0 && !withinTolerance;
    const requiredFactorChangePct = currentExposurePct == null ? null : -currentExposurePct;
    const notionalPerLeg = previewAvailable
      ? Math.abs(requiredFactorChangePct / 100) * nav
      : null;
    const positiveFactorChange = requiredFactorChangePct > 0;
    const legs = requiredSymbols.map((symbol, index) => ({
      symbol,
      role: index === 0 ? 'longProxy' : 'shortProxy',
      action: previewAvailable
        ? (index === 0
          ? (positiveFactorChange ? 'BUY' : 'SELL')
          : (positiveFactorChange ? 'SELL' : 'BUY'))
        : null,
      notional: notionalPerLeg == null ? null : round(notionalPerLeg, 2),
    }));
    return {
      factorId: factor.id,
      factor: factor.label,
      family: factor.family,
      formula: factor.formula,
      currentExposurePct,
      targetExposurePct: 0,
      requiredFactorChangePct: previewAvailable ? round(requiredFactorChangePct, 3) : null,
      contributionToTotalRiskPct: finiteNumber(factor.contributionToTotalRiskPct),
      status: withinTolerance
        ? 'within_tolerance'
        : previewAvailable
          ? 'preview_available'
          : 'blocked',
      requiredSymbols,
      unreviewedSymbols,
      blockers,
      legs,
    };
  }).sort((left, right) => (
    Math.abs(right.currentExposurePct || 0) - Math.abs(left.currentExposurePct || 0)
  ));

  return {
    available: rows.some((row) => row.status === 'preview_available'),
    executable: false,
    actionable: false,
    orderSubmitted: false,
    orderRoute: null,
    target: 'zero first-order factor exposure',
    tolerancePct,
    blockers: [...new Set([
      ...globalBlockers,
      ...(rows.some((row) => row.unreviewedSymbols.length > 0)
        ? ['reviewed_security_master_not_active']
        : []),
    ])],
    rows,
    methodology: 'Research-only first-order factor-neutral pair notionals. No cross-factor optimizer, share conversion, order preview, staging, or submission is performed.',
  };
}

module.exports = {
  DEFAULT_CORRELATION_WINDOWS,
  DEFAULT_COVARIANCE_SHRINKAGE,
  DEFAULT_COVARIANCE_WINDOW,
  DEFAULT_FACTOR_MIN_OBSERVATIONS,
  DEFAULT_HALF_LIFE,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_REGRESSION_SESSIONS,
  DEFAULT_RIDGE_LAMBDA,
  DEFAULT_SEASONED_OBSERVATIONS,
  FACTOR_DEFINITIONS,
  MODEL_VERSION,
  SAMPLE_SIZE_TIERS,
  alignFactorRows,
  buildFactorCorrelationMatrices,
  buildFactorReturnSeries,
  buildFactorNeutralizationScenarios,
  buildPortfolioFactorRiskSnapshot,
  classifySampleQuality,
  covarianceMatrix,
  exponentialWeights,
  getFactorProxySymbols,
  regressSecurityReturns,
  solveLinearSystem,
};
