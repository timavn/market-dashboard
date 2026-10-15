const { Matrix, SingularValueDecomposition } = require('ml-matrix');

const MODEL_VERSION = 'holdings-correlation-pca-v1';
const DISPLAY_COMPONENTS = 5;
const DEFAULT_CONFIG = Object.freeze({ window: 126, warnThreshold: 0.35, highThreshold: 0.5 });
const REFERENCE_MIN_CORRELATION = 0.4;
const REFERENCE_MIN_COVERAGE = 0.8;

class PcaModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PcaModelError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PcaModelError(code, message);
}

function sum(values) {
  let total = 0;
  let correction = 0;
  for (const value of values) {
    const next = value - correction;
    const updated = total + next;
    correction = (updated - total) - next;
    total = updated;
  }
  return total;
}

const dot = (left, right) => sum(left.map((value, index) => value * right[index]));
const mean = values => sum(values) / values.length;
const centered = values => {
  const average = mean(values);
  return values.map(value => value - average);
};
const compareIds = (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const variance = values => dot(values, values) / (values.length - 1);

function getConfig(config = {}) {
  const result = { ...DEFAULT_CONFIG, ...config };
  if (!Number.isInteger(result.window) || result.window < 2) {
    fail('INVALID_WINDOW', 'The PCA window must contain at least two daily observations.');
  }
  if (!finite(result.warnThreshold) || !finite(result.highThreshold)
    || result.warnThreshold <= 0 || result.highThreshold <= result.warnThreshold || result.highThreshold > 1) {
    fail('INVALID_THRESHOLDS', 'PCA thresholds must satisfy 0 < warning < high <= 1.');
  }
  return { window: result.window, warnThreshold: result.warnThreshold, highThreshold: result.highThreshold };
}

function validateDates(dates) {
  if (!Array.isArray(dates) || dates.length < 2) fail('INVALID_DATES', 'Aligned session dates are required.');
  dates.forEach((date, index) => {
    const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
      || (index > 0 && dates[index - 1] >= date)) {
      fail('INVALID_DATES', 'Session dates must be valid, unique, and in ascending order.');
    }
  });
}

function copyAsset(asset, count, start = 0, requireWeight = true) {
  if (!asset || typeof asset.id !== 'string' || !asset.id.trim()) fail('INVALID_ASSET', 'Every security needs an ID.');
  if (requireWeight && !finite(asset.weight)) fail('INVALID_WEIGHT', `A finite signed weight is required for ${asset.id}.`);
  if (!Array.isArray(asset.returns) || asset.returns.length !== count
    || asset.returns.some(value => !finite(value))) {
    fail('INVALID_RETURNS', `Complete aligned daily returns are required for ${asset.id}.`);
  }
  return {
    id: asset.id,
    symbol: typeof asset.symbol === 'string' && asset.symbol ? asset.symbol : asset.id,
    name: typeof asset.name === 'string' && asset.name ? asset.name : (asset.symbol || asset.id),
    weight: requireWeight ? asset.weight : 0,
    returns: asset.returns.slice(start),
  };
}

function requireUniqueAssets(assets) {
  const ids = new Set();
  assets.forEach(asset => {
    if (ids.has(asset.id)) fail('DUPLICATE_ASSET', `Security ${asset.id} appears more than once.`);
    ids.add(asset.id);
  });
}

function correlation(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const x = centered(left);
  const y = centered(right);
  const denominator = Math.sqrt(dot(x, x)) * Math.sqrt(dot(y, y));
  const value = denominator > 0 && finite(denominator) ? dot(x, y) / denominator : null;
  return finite(value) ? Math.max(-1, Math.min(1, value)) : null;
}

function riskStatus(riskShare, config) {
  if (riskShare === null) return 'unavailable';
  if (riskShare >= config.highThreshold) return 'high';
  if (riskShare >= config.warnThreshold) return 'warning';
  return 'ok';
}

// A sign convention changes presentation only. Rank is always the current variance rank.
function orientComponents(eigenvectors, scores, dates, previousModel) {
  const continuity = scores.map(() => ({ comparedToPrevious: false, previousComponentId: null, correlation: null, overlapCount: 0 }));
  eigenvectors.forEach((vector, index) => {
    const anchor = vector.reduce((best, value, position) => Math.abs(value) > Math.abs(vector[best]) + 1e-12 ? position : best, 0);
    if (vector[anchor] < 0) {
      eigenvectors[index] = vector.map(value => -value);
      scores[index] = scores[index].map(value => -value);
    }
  });
  if (previousModel?.modelVersion !== MODEL_VERSION || !Array.isArray(previousModel.fit?.scores)
    || !Array.isArray(previousModel.dates) || !previousModel.fit.scores.length
    || previousModel.fit.scores.some(score => !Array.isArray(score) || score.length !== previousModel.dates.length
      || score.some(value => !finite(value)) || !(variance(centered(score)) > 0))) return continuity;
  const previousDates = new Map(previousModel.dates.map((date, index) => [date, index]));
  const overlap = dates.map((date, index) => [index, previousDates.get(date)]).filter(([, index]) => index !== undefined);
  if (overlap.length < Math.max(6, Math.ceil(Math.min(dates.length, previousModel.dates.length) * 0.5))) return continuity;
  continuity.forEach(item => { item.comparedToPrevious = true; item.overlapCount = overlap.length; });
  const matches = [];
  scores.forEach((score, currentIndex) => {
    previousModel.fit.scores.forEach((previousScore, previousIndex) => {
      if (!Array.isArray(previousScore) || overlap.some(([, index]) => !finite(previousScore[index]))) return;
      const value = correlation(overlap.map(([index]) => score[index]), overlap.map(([, index]) => previousScore[index]));
      if (value !== null && Math.abs(value) >= 0.7) matches.push({ currentIndex, previousIndex, value });
    });
  });
  matches.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.currentIndex - b.currentIndex || a.previousIndex - b.previousIndex);
  const currentUsed = new Set();
  const previousUsed = new Set();
  for (const match of matches) {
    if (currentUsed.has(match.currentIndex) || previousUsed.has(match.previousIndex)) continue;
    currentUsed.add(match.currentIndex);
    previousUsed.add(match.previousIndex);
    if (match.value < 0) {
      eigenvectors[match.currentIndex] = eigenvectors[match.currentIndex].map(value => -value);
      scores[match.currentIndex] = scores[match.currentIndex].map(value => -value);
    }
    continuity[match.currentIndex] = {
      comparedToPrevious: true,
      previousComponentId: `PC${match.previousIndex + 1}`,
      correlation: Math.abs(match.value),
      overlapCount: overlap.length,
    };
  }
  return continuity;
}

// References are already transformed by their catalog/adapter (returns, bp changes,
// or direction-normalized FX returns). They are never columns of the fitted matrix.
function interpretComponent(references, score, originalCount, start) {
  const matches = [];
  const seen = new Set();
  for (const reference of references) {
    if (!reference || typeof reference.id !== 'string' || seen.has(reference.id)
      || !Array.isArray(reference.values) || reference.values.length !== originalCount) continue;
    seen.add(reference.id);
    const values = reference.values.slice(start);
    const validIndices = values.map((value, index) => finite(value) ? index : -1).filter(index => index >= 0);
    if (validIndices.length < Math.ceil(score.length * REFERENCE_MIN_COVERAGE)) continue;
    const value = correlation(validIndices.map(index => values[index]), validIndices.map(index => score[index]));
    if (value === null) continue;
    matches.push({
      id: reference.id,
      label: reference.label || reference.id,
      group: reference.group || 'Macro',
      transform: reference.transform || null,
      asOf: reference.asOf || null,
      correlation: value,
      overlapCount: validIndices.length,
      coverage: validIndices.length / score.length,
    });
  }
  matches.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation) || compareIds(a, b));
  const groups = [];
  for (const reference of matches) {
    if (Math.abs(reference.correlation) >= REFERENCE_MIN_CORRELATION && !groups.includes(reference.group)) groups.push(reference.group);
    if (groups.length === 2) break;
  }
  return { label: groups.length ? groups.join(' / ') : 'Unclassified', references: matches };
}

function projectAssets(assets, scores) {
  const centeredReturns = assets.map(asset => centered(asset.returns));
  const betas = centeredReturns.map(values => scores.map(score => dot(values, score) / (score.length - 1)));
  const volatilities = centeredReturns.map(values => Math.sqrt(variance(values)));
  if (volatilities.some(value => !finite(value)) || betas.some(values => values.some(value => !finite(value)))) {
    fail('NUMERICAL_OVERFLOW', 'Daily returns exceed the supported numeric range.');
  }
  return { centeredReturns, betas, volatilities };
}

function evaluatePortfolio(assets, scores, metadata, config) {
  const { centeredReturns, betas, volatilities } = projectAssets(assets, scores);
  const count = centeredReturns[0].length;
  const portfolio = Array.from({ length: count }, (_, index) => sum(assets.map((asset, assetIndex) => asset.weight * centeredReturns[assetIndex][index])));
  const grossVolatility = sum(assets.map((asset, index) => Math.abs(asset.weight) * volatilities[index]));
  const zeroTolerance = grossVolatility * grossVolatility * 1e-24;
  const cleanVariance = value => value <= zeroTolerance ? 0 : value;
  const dailyVariance = cleanVariance(variance(portfolio));
  if (!finite(grossVolatility) || !finite(dailyVariance)) fail('NUMERICAL_OVERFLOW', 'Portfolio risk exceeds the supported numeric range.');
  const exposures = scores.map((_, index) => dailyVariance === 0 ? 0 : sum(assets.map((asset, assetIndex) => asset.weight * betas[assetIndex][index])));
  const riskShare = value => dailyVariance > 0 ? Math.min(1, Math.max(0, value / dailyVariance)) : null;
  const componentRows = metadata.map((component, index) => {
    const exposure = exposures[index];
    const componentVariance = cleanVariance(exposure * exposure);
    const share = riskShare(componentVariance);
    return {
      ...component,
      exposure,
      variance: componentVariance,
      riskShare: share,
      status: riskStatus(share, config),
      drivers: assets.map((asset, assetIndex) => {
        const exposureContribution = asset.weight * betas[assetIndex][index];
        return {
          id: asset.id, symbol: asset.symbol, weight: asset.weight,
          loading: volatilities[assetIndex] > 0 ? betas[assetIndex][index] / volatilities[assetIndex] : 0,
          exposureContribution,
          riskContribution: exposureContribution * exposure,
        };
      }).sort((a, b) => Math.abs(b.riskContribution) - Math.abs(a.riskContribution)
        || Math.abs(b.exposureContribution) - Math.abs(a.exposureContribution) || compareIds(a, b)),
    };
  });
  // Computing the weighted residual time series retains every residual covariance,
  // including negative hedge cross terms. A diagonal residual approximation would not.
  const residualAfter = number => cleanVariance(variance(portfolio.map((value, index) => value
    - sum(scores.slice(0, number).map((score, componentIndex) => score[index] * exposures[componentIndex])))));
  const residualVariance = residualAfter(DISPLAY_COMPONENTS);
  const maxRiskShare = dailyVariance > 0 ? Math.max(0, ...componentRows.map(component => component.riskShare)) : null;
  const summary = {
    dailyVariance,
    annualizedVolatility: Math.sqrt(dailyVariance * 252),
    explainedVarianceRatio: sum(metadata.slice(0, DISPLAY_COMPONENTS).map(component => component.explainedVarianceRatio)),
    topFiveRiskShare: dailyVariance > 0 ? Math.min(1, sum(componentRows.slice(0, DISPLAY_COMPONENTS).map(component => component.riskShare))) : null,
    residualVariance,
    residualRiskShare: riskShare(residualVariance),
    fullBasisResidualVariance: residualAfter(scores.length),
    maxRiskShare,
    status: riskStatus(maxRiskShare, config),
    grossWeight: sum(assets.map(asset => Math.abs(asset.weight))),
    netWeight: sum(assets.map(asset => asset.weight)),
  };
  const holdings = assets.map((asset, assetIndex) => ({
    id: asset.id, symbol: asset.symbol, name: asset.name, weight: asset.weight,
    volatility: volatilities[assetIndex],
    loadings: componentRows.map((component, index) => ({
      componentId: component.id,
      rank: component.rank,
      loading: volatilities[assetIndex] > 0 ? betas[assetIndex][index] / volatilities[assetIndex] : 0,
      beta: betas[assetIndex][index],
      exposureContribution: asset.weight * betas[assetIndex][index],
      riskContribution: asset.weight * betas[assetIndex][index] * exposures[index],
    })),
  }));
  return { summary, holdings, components: componentRows.slice(0, DISPLAY_COMPONENTS), otherComponents: componentRows.slice(DISPLAY_COMPONENTS) };
}

function buildPcaModel({ assets, dates, references = [], config: requestedConfig, previousModel } = {}) {
  const config = getConfig(requestedConfig);
  validateDates(dates);
  if (dates.length < config.window) fail('INSUFFICIENT_HISTORY', `The model requires ${config.window} aligned daily returns.`);
  if (!Array.isArray(assets) || !assets.length) fail('NO_HOLDINGS', 'At least one holding is required.');
  if (!Array.isArray(references)) fail('INVALID_REFERENCES', 'References must be an array.');
  const start = dates.length - config.window;
  const fitDates = dates.slice(start);
  const fitAssets = assets.map(asset => copyAsset(asset, dates.length, start)).sort(compareIds);
  requireUniqueAssets(fitAssets);
  const means = fitAssets.map(asset => mean(asset.returns));
  const rawCentered = fitAssets.map((asset, index) => asset.returns.map(value => value - means[index]));
  const volatilities = rawCentered.map(values => Math.sqrt(variance(values)));
  volatilities.forEach((value, index) => {
    if (!finite(value) || value <= 0) fail('ZERO_VARIANCE', `Nonzero daily return variation is required for ${fitAssets[index].id}.`);
  });
  const standardized = fitDates.map((_, index) => rawCentered.map((values, assetIndex) => values[index] / volatilities[assetIndex]));
  let svd;
  try {
    svd = new SingularValueDecomposition(new Matrix(standardized), { autoTranspose: true });
  } catch (_error) {
    fail('DECOMPOSITION_FAILED', 'The daily-return matrix could not be decomposed.');
  }
  const singularValues = svd.diagonal;
  const largestSingularValue = Math.max(...singularValues);
  const rankTolerance = largestSingularValue * Math.max(config.window, fitAssets.length) * Number.EPSILON * 32;
  const indices = singularValues.map((value, index) => ({ value, index }))
    .filter(item => finite(item.value) && item.value > rankTolerance)
    .sort((a, b) => b.value - a.value || a.index - b.index);
  if (!indices.length) fail('DECOMPOSITION_FAILED', 'The daily-return matrix has no estimable components.');
  const eigenvalues = indices.map(item => item.value ** 2 / (config.window - 1));
  const eigenvectors = indices.map(item => svd.rightSingularVectors.getColumn(item.index));
  const scores = indices.map(item => svd.leftSingularVectors.getColumn(item.index).map(value => value * Math.sqrt(config.window - 1)));
  const continuity = orientComponents(eigenvectors, scores, fitDates, previousModel);
  // All standardized columns have sample variance one. The full singular spectrum,
  // including tiny discarded modes, is the explained-variance denominator.
  const totalEigenvalue = sum(singularValues.map(value => value * value / (config.window - 1)));
  const metadata = eigenvalues.map((eigenvalue, index) => ({
    id: `PC${index + 1}`,
    rank: index + 1,
    eigenvalue,
    explainedVarianceRatio: eigenvalue / totalEigenvalue,
    continuity: continuity[index],
    ...interpretComponent(references, scores[index], dates.length, start),
  }));
  const evaluation = evaluatePortfolio(fitAssets, scores, metadata, config);
  return {
    modelVersion: MODEL_VERSION,
    dates: fitDates,
    config,
    ...evaluation,
    fit: {
      method: 'correlation-pca',
      window: config.window,
      observationCount: config.window,
      assetIds: fitAssets.map(asset => asset.id),
      assets: fitAssets,
      means,
      volatilities,
      numericalRank: eigenvalues.length,
      rankTolerance,
      eigenvalues,
      eigenvectors,
      scores,
      betas: projectAssets(fitAssets, scores).betas,
      config,
    },
  };
}

function scenarioModel(model) {
  if (model?.modelVersion !== MODEL_VERSION || !Array.isArray(model.fit?.assets)
    || !model.fit.assets.length || !Array.isArray(model.fit.scores) || !model.fit.scores.length) {
    fail('INVALID_MODEL', 'A complete frozen PCA snapshot is required.');
  }
  validateDates(model.dates);
  const config = getConfig(model.fit.config);
  if (config.window !== model.dates.length) fail('INVALID_MODEL', 'The frozen window does not match its session dates.');
  const assets = model.fit.assets.map(asset => copyAsset(asset, model.dates.length));
  requireUniqueAssets(assets);
  const scores = model.fit.scores;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    if (!Array.isArray(score) || score.length !== model.dates.length || score.some(value => !finite(value))
      || Math.abs(mean(score)) > 1e-8 || Math.abs(variance(score) - 1) > 1e-8
      || scores.slice(0, index).some(previous => Math.abs(dot(previous, score) / (score.length - 1)) > 1e-8)) {
      fail('INVALID_MODEL', 'Frozen component scores must remain aligned and orthonormal.');
    }
  }
  const rows = [...(model.components || []), ...(model.otherComponents || [])];
  if (rows.length !== scores.length || rows.some((component, index) => component.rank !== index + 1
    || component.id !== `PC${index + 1}` || !finite(component.explainedVarianceRatio))) {
    fail('INVALID_MODEL', 'The frozen component metadata is incomplete.');
  }
  const metadata = rows.map(({ drivers, exposure, variance: componentVariance, riskShare, status, ...component }) => component);
  return { config, assets, scores, metadata };
}

function comparePcaScenario({ model, changes = [], candidates = [] } = {}) {
  const { config, assets, scores, metadata } = scenarioModel(model);
  if (!Array.isArray(changes) || !Array.isArray(candidates)) fail('INVALID_SCENARIO', 'Changes and candidates must be arrays.');
  const additions = candidates.map(candidate => {
    if (candidate?.dates && (!Array.isArray(candidate.dates) || candidate.dates.length !== model.dates.length
      || candidate.dates.some((date, index) => date !== model.dates[index]))) {
      fail('INVALID_RETURNS', `Candidate ${candidate.id} uses different session dates.`);
    }
    return copyAsset(candidate, model.dates.length, 0, false);
  });
  const allAssets = [...assets, ...additions].sort(compareIds);
  requireUniqueAssets(allAssets);
  const byId = new Map(allAssets.map(asset => [asset.id, asset]));
  const changed = new Set();
  const normalizedChanges = changes.map(change => {
    if (!change || typeof change.id !== 'string' || !byId.has(change.id)) fail('UNKNOWN_ASSET', `No aligned history is available for ${change?.id || 'the candidate'}.`);
    if (!finite(change.deltaWeight)) fail('INVALID_WEIGHT', `A finite signed weight change is required for ${change.id}.`);
    if (changed.has(change.id)) fail('DUPLICATE_CHANGE', `Combine the changes to ${change.id} into one signed weight change.`);
    changed.add(change.id);
    return { id: change.id, deltaWeight: change.deltaWeight };
  });
  const before = evaluatePortfolio(allAssets, scores, metadata, config);
  normalizedChanges.forEach(change => { byId.get(change.id).weight += change.deltaWeight; });
  if (allAssets.some(asset => !finite(asset.weight))) fail('INVALID_WEIGHT', 'The proposed weights exceed the supported numeric range.');
  const after = evaluatePortfolio(allAssets, scores, metadata, config);
  const nullableDelta = (left, right) => left === null || right === null ? null : right - left;
  const componentDelta = (left, right) => ({
    id: left.id, rank: left.rank, label: left.label,
    beforeExposure: left.exposure, afterExposure: right.exposure, exposureDelta: right.exposure - left.exposure,
    beforeVariance: left.variance, afterVariance: right.variance, varianceDelta: right.variance - left.variance,
    beforeRiskShare: left.riskShare, afterRiskShare: right.riskShare, riskShareDelta: nullableDelta(left.riskShare, right.riskShare),
    status: right.status,
  });
  return {
    modelVersion: MODEL_VERSION,
    dates: [...model.dates],
    before: before.summary,
    after: after.summary,
    components: before.components.map((component, index) => componentDelta(component, after.components[index])),
    otherComponents: before.otherComponents.map((component, index) => componentDelta(component, after.otherComponents[index])),
    residual: {
      beforeVariance: before.summary.residualVariance,
      afterVariance: after.summary.residualVariance,
      varianceDelta: after.summary.residualVariance - before.summary.residualVariance,
      beforeRiskShare: before.summary.residualRiskShare,
      afterRiskShare: after.summary.residualRiskShare,
      riskShareDelta: nullableDelta(before.summary.residualRiskShare, after.summary.residualRiskShare),
    },
    delta: {
      dailyVariance: after.summary.dailyVariance - before.summary.dailyVariance,
      annualizedVolatility: after.summary.annualizedVolatility - before.summary.annualizedVolatility,
      maxRiskShare: nullableDelta(before.summary.maxRiskShare, after.summary.maxRiskShare),
    },
    changes: normalizedChanges,
    holdings: after.holdings,
  };
}

module.exports = { MODEL_VERSION, DEFAULT_CONFIG, PcaModelError, buildPcaModel, comparePcaScenario };
