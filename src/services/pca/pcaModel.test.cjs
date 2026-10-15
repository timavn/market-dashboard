const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPcaModel, comparePcaScenario, PcaModelError } = require('./pcaModel.cjs');

const close = (actual, expected, tolerance = 1e-11) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `Expected ${actual} to be within ${tolerance} of ${expected}`,
);
const datesFor = count => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
const basis = (count, frequency) => Array.from({ length: count }, (_, index) => Math.sin(2 * Math.PI * frequency * index / count) * Math.sqrt(2 * (count - 1) / count));
const average = values => values.reduce((total, value) => total + value, 0) / values.length;
const covariance = (left, right) => {
  const leftMean = average(left);
  const rightMean = average(right);
  return left.reduce((total, value, index) => total + (value - leftMean) * (right[index] - rightMean), 0) / (left.length - 1);
};
const total = values => values.reduce((result, value) => result + value, 0);
const allComponents = model => [...model.components, ...model.otherComponents];
const asset = (id, weight, returns) => ({ id, symbol: id, name: `Security ${id}`, weight, returns });
const expectCode = (callback, code) => assert.throws(callback, error => error instanceof PcaModelError && error.code === code);

function fixture(count = 64) {
  const factors = Array.from({ length: 7 }, (_, index) => basis(count, index + 1));
  const pair = (first, second, common, volatility, sign = 1) => first.map((value, index) => volatility * (Math.sqrt(common) * value + sign * Math.sqrt(1 - common) * second[index]));
  return {
    dates: datesFor(count),
    config: { window: count },
    assets: [
      asset('A', 0.35, pair(factors[0], factors[1], 0.8, 0.012)),
      asset('B', -0.2, pair(factors[0], factors[1], 0.8, 0.009, -1)),
      asset('C', 0.18, pair(factors[2], factors[3], 0.65, 0.021)),
      asset('D', 0.15, pair(factors[2], factors[3], 0.65, 0.006, -1)),
      asset('E', -0.22, pair(factors[4], factors[5], 0.6, 0.015)),
      asset('F', 0.25, pair(factors[4], factors[5], 0.6, 0.01, -1)),
      asset('G', 0.05, factors[6].map(value => value * 0.008)),
    ],
  };
}

function portfolioReturns(assets) {
  return assets[0].returns.map((_, index) => total(assets.map(item => item.weight * item.returns[index])));
}

test('sample-standardized correlation PCA reconstructs covariance, loadings, and every risk attribution', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  assert.equal(model.components.length, 5);
  assert.equal(model.otherComponents.length, 2);
  [1.6, 1.3, 1.2, 1, 0.8, 0.7, 0.4].forEach((expected, index) => close(model.fit.eigenvalues[index], expected));
  close(total(model.fit.eigenvalues), input.assets.length);
  close(total(allComponents(model).map(component => component.explainedVarianceRatio)), 1);
  input.assets.forEach((left, i) => {
    model.fit.scores.forEach((score, k) => {
      close(covariance(score, score), 1);
      const expectedBeta = model.fit.volatilities[i] * Math.sqrt(model.fit.eigenvalues[k]) * model.fit.eigenvectors[k][i];
      close(model.fit.betas[i][k], expectedBeta);
      close(model.holdings[i].loadings[k].loading, covariance(left.returns, score) / model.fit.volatilities[i]);
    });
    input.assets.forEach((right, j) => close(
      total(model.fit.betas[i].map((beta, k) => beta * model.fit.betas[j][k])),
      covariance(left.returns, right.returns),
    ));
  });
  const portfolio = portfolioReturns(input.assets);
  close(model.summary.dailyVariance, covariance(portfolio, portfolio));
  close(model.summary.annualizedVolatility, Math.sqrt(model.summary.dailyVariance * 252));
  for (const component of allComponents(model)) {
    close(total(component.drivers.map(driver => driver.exposureContribution)), component.exposure);
    close(total(component.drivers.map(driver => driver.riskContribution)), component.variance);
    close(component.riskShare, component.variance / model.summary.dailyVariance);
  }
  close(total(model.components.map(component => component.variance)) + model.summary.residualVariance, model.summary.dailyVariance);
  close(total(model.otherComponents.map(component => component.variance)), model.summary.residualVariance);
  close(model.summary.topFiveRiskShare + model.summary.residualRiskShare, 1);
  close(model.summary.fullBasisResidualVariance, 0);
  close(model.summary.grossWeight, 1.4);
  close(model.summary.netWeight, 0.56);
});

test('weights do not enter the fit; volatility is restored before signed portfolio projection', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  const doubled = buildPcaModel({ ...input, assets: input.assets.map(item => ({ ...item, weight: item.weight * 2 })) });
  const reversed = buildPcaModel({ ...input, assets: input.assets.map(item => ({ ...item, weight: -item.weight })) });
  assert.deepEqual(model.fit.eigenvalues, doubled.fit.eigenvalues);
  assert.deepEqual(model.fit.scores, doubled.fit.scores);
  assert.deepEqual(model.fit.eigenvectors, reversed.fit.eigenvectors);
  allComponents(model).forEach((component, index) => {
    close(allComponents(doubled)[index].exposure, component.exposure * 2);
    close(allComponents(doubled)[index].variance, component.variance * 4);
    close(allComponents(doubled)[index].riskShare, component.riskShare);
    close(allComponents(reversed)[index].exposure, -component.exposure);
    close(allComponents(reversed)[index].variance, component.variance);
  });
});

test('shorts have signed Euler contributions and exact hedges have unavailable concentration', () => {
  const returns = basis(32, 1).map(value => value * 0.01);
  const input = { dates: datesFor(32), config: { window: 32 }, assets: [asset('A', 0.5, returns), asset('B', -0.2, returns)] };
  const model = buildPcaModel(input);
  assert.equal(model.components.length, 1);
  close(model.components[0].exposure, 0.003);
  close(model.components[0].variance, 0.000009);
  close(model.components[0].drivers.find(driver => driver.id === 'A').riskContribution, 0.000015);
  close(model.components[0].drivers.find(driver => driver.id === 'B').riskContribution, -0.000006);
  assert.equal(model.summary.status, 'high');
  const hedged = comparePcaScenario({ model, changes: [{ id: 'B', deltaWeight: -0.3 }] });
  assert.equal(hedged.after.dailyVariance, 0);
  assert.equal(hedged.after.annualizedVolatility, 0);
  assert.equal(hedged.after.maxRiskShare, null);
  assert.equal(hedged.after.residualRiskShare, null);
  assert.equal(hedged.after.status, 'unavailable');
  assert.equal(hedged.components[0].afterExposure, 0);
  assert.equal(hedged.components[0].riskShareDelta, null);
  assert.ok(!JSON.stringify(hedged).includes('NaN'));
});

test('a concentrated component beyond the displayed five raises the full-spectrum alert', () => {
  const input = fixture();
  const baseline = buildPcaModel(input);
  const assets = input.assets.map((item, index) => ({
    ...item,
    weight: baseline.fit.eigenvectors[6][index] / baseline.fit.volatilities[index] * 0.001,
  }));
  const model = buildPcaModel({ ...input, assets });
  close(model.summary.topFiveRiskShare, 0);
  close(model.summary.residualRiskShare, 1);
  close(model.summary.maxRiskShare, 1);
  assert.equal(model.summary.status, 'high');
  assert.equal(model.otherComponents[1].status, 'high');
  close(model.otherComponents[1].riskShare, 1);
  assert.ok(model.components.every(component => component.status === 'ok'));
});

test('thresholds are inclusive, configurable shares of total portfolio variance', () => {
  const input = fixture();
  const baseline = buildPcaModel(input);
  const maximum = baseline.summary.maxRiskShare;
  assert.equal(buildPcaModel({ ...input, config: { window: 64, warnThreshold: maximum, highThreshold: 0.99 } }).summary.status, 'warning');
  assert.equal(buildPcaModel({ ...input, config: { window: 64, warnThreshold: maximum / 2, highThreshold: maximum } }).summary.status, 'high');
  expectCode(() => buildPcaModel({ ...input, config: { window: 64, warnThreshold: 0.5, highThreshold: 0.35 } }), 'INVALID_THRESHOLDS');
});

test('candidate baskets retain both current-holding and candidate residual hedge covariance', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  const outsideBasis = basis(64, 8).map(value => value * 0.03);
  const candidates = [
    { id: 'X', symbol: 'X', returns: input.assets[0].returns.map((value, index) => value + outsideBasis[index]) },
    { id: 'Y', symbol: 'Y', returns: input.assets[0].returns.map((value, index) => value - outsideBasis[index]) },
  ];
  const isolated = comparePcaScenario({ model, changes: [{ id: 'X', deltaWeight: 0.1 }], candidates: [candidates[0]] });
  close(isolated.after.fullBasisResidualVariance, 0.1 ** 2 * 0.03 ** 2);
  const paired = comparePcaScenario({ model, changes: [{ id: 'X', deltaWeight: 0.1 }, { id: 'Y', deltaWeight: 0.1 }], candidates });
  const equivalent = comparePcaScenario({ model, changes: [{ id: 'A', deltaWeight: 0.2 }] });
  close(paired.after.fullBasisResidualVariance, 0);
  close(paired.after.dailyVariance, equivalent.after.dailyVariance);
  close(paired.after.residualVariance, equivalent.after.residualVariance);
  close(paired.before.dailyVariance, model.summary.dailyVariance);
  const explicit = [...input.assets, ...candidates.map(item => ({ ...item, weight: 0.1 }))];
  close(paired.after.dailyVariance, covariance(portfolioReturns(explicit), portfolioReturns(explicit)));
  close(total(paired.components.map(component => component.afterVariance)) + paired.after.residualVariance, paired.after.dailyVariance);
});

test('a candidate can hedge the existing residual beyond the first five PCs without refitting', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  const portfolio = portfolioReturns(input.assets);
  const candidateReturns = portfolio.map((value, index) => -value + total(model.components.map((component, k) => component.exposure * model.fit.scores[k][index])));
  const serialized = JSON.stringify(model);
  const result = comparePcaScenario({ model, changes: [{ id: 'HEDGE', deltaWeight: 1 }], candidates: [{ id: 'HEDGE', symbol: 'HEDGE', returns: candidateReturns }] });
  close(result.after.residualVariance, 0);
  close(result.residual.varianceDelta, -model.summary.residualVariance);
  close(result.after.dailyVariance, total(model.components.map(component => component.variance)));
  result.components.forEach(component => close(component.varianceDelta, 0));
  assert.equal(JSON.stringify(model), serialized);
  assert.equal(result.components.length, model.components.length);
});

test('an outside-basis candidate is retained in total variance and never called a new fitted PC', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  const returns = basis(64, 8).map(value => value * 0.1);
  const result = comparePcaScenario({ model, candidates: [{ id: 'NEW', symbol: 'NEW', returns }], changes: [{ id: 'NEW', deltaWeight: 0.5 }] });
  close(result.after.dailyVariance, model.summary.dailyVariance + 0.0025);
  close(result.after.fullBasisResidualVariance, 0.0025);
  close(result.after.residualVariance, model.summary.residualVariance + 0.0025);
  assert.equal(result.components.length + result.otherComponents.length, model.fit.numericalRank);
  result.components.forEach(component => close(component.varianceDelta, 0));
});

test('return-window selection uses the last configurable observations and defaults to 126', () => {
  const input = fixture(128);
  const full = buildPcaModel({ ...input, config: undefined });
  assert.equal(full.dates.length, 126);
  assert.equal(full.config.window, 126);
  const selected = buildPcaModel({ ...input, config: { window: 64 } });
  const explicit = buildPcaModel({ dates: input.dates.slice(-64), assets: input.assets.map(item => ({ ...item, returns: item.returns.slice(-64) })), config: { window: 64 } });
  assert.deepEqual(selected, explicit);
  expectCode(() => buildPcaModel({ ...fixture(), config: { window: 126 } }), 'INSUFFICIENT_HISTORY');
});

test('references only interpret PCs with sufficient overlap and support names from two distinct groups', () => {
  const input = fixture();
  const baseline = buildPcaModel(input);
  const reference = (id, group, values) => ({ id, label: `${id} reference`, group, transform: 'basis-point-change', asOf: input.dates.at(-1), values });
  const score = baseline.fit.scores[0];
  const references = [
    reference('EQUITY', 'Equities', score),
    reference('SAME_GROUP', 'Equities', score.map(value => -value)),
    reference('CREDIT', 'Credit', score.map((value, index) => index < 12 ? null : value)),
    reference('TOO_SHORT', 'Volatility', score.map((value, index) => index < 13 ? null : value)),
    reference('UNRELATED', 'FX', basis(64, 8)),
  ];
  const model = buildPcaModel({ ...input, references });
  assert.deepEqual(model.fit, baseline.fit);
  assert.deepEqual(model.summary, baseline.summary);
  assert.match(model.components[0].label, /Equities/);
  assert.match(model.components[0].label, /Credit/);
  assert.equal(model.components[0].label.split(' / ').length, 2);
  assert.ok(!model.components[0].references.some(item => item.id === 'TOO_SHORT'));
  assert.equal(model.components[0].references.find(item => item.id === 'CREDIT').overlapCount, 52);
  close(model.components[0].references.find(item => item.id === 'SAME_GROUP').correlation, -1);
  assert.equal(model.components[0].references.find(item => item.id === 'CREDIT').transform, 'basis-point-change');
  const unrelated = buildPcaModel({ ...input, references: [references[4]] });
  assert.equal(unrelated.components[0].label, 'Unclassified');
});

test('missing or malformed references cannot contaminate or block the holdings fit', () => {
  const input = fixture();
  const baseline = buildPcaModel(input);
  const model = buildPcaModel({ ...input, references: [
    { id: 'MISSING', values: Array(64).fill(null) },
    { id: 'SHIFTED', values: Array(63).fill(1) },
    { id: 'INVALID', values: Array(64).fill(NaN) },
    { id: 'CONSTANT', values: Array(64).fill(1) },
    { id: 'OVERFLOW', values: basis(64, 1).map(value => value * 1e307) },
  ] });
  assert.deepEqual(model.fit, baseline.fit);
  assert.deepEqual(model.summary, baseline.summary);
  assert.ok(model.components.every(component => component.references.length === 0));
});

test('security ordering is deterministic and previous overlap aligns signs without altering risk', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  const reordered = buildPcaModel({ ...input, assets: [...input.assets].reverse() });
  assert.deepEqual(model, reordered);
  assert.ok(allComponents(model).every(component => component.continuity.comparedToPrevious === false));
  const previous = JSON.parse(JSON.stringify(model));
  previous.fit.scores = previous.fit.scores.map(values => values.map(value => -value));
  const aligned = buildPcaModel({ ...input, previousModel: previous });
  allComponents(aligned).forEach((component, index) => {
    close(component.exposure, -allComponents(model)[index].exposure);
    close(component.variance, allComponents(model)[index].variance);
    close(component.continuity.correlation, 1);
    assert.equal(component.continuity.comparedToPrevious, true);
    assert.equal(component.continuity.previousComponentId, `PC${index + 1}`);
  });
  assert.deepEqual(aligned.summary, model.summary);
});

test('continuity distinguishes an unmatched comparison from absent or unusable prior evidence', () => {
  const input = fixture();
  const previousModel = buildPcaModel(input);
  const assets = input.assets.map((item, index) => ({ ...item, returns: basis(64, index + 10).map(value => value * 0.01) }));
  const unmatched = buildPcaModel({ ...input, assets, previousModel });
  assert.ok(allComponents(unmatched).every(component => component.continuity.comparedToPrevious === true
    && component.continuity.previousComponentId === null && component.continuity.overlapCount === 64));
  const noOverlap = buildPcaModel({ ...input, previousModel: { ...previousModel, dates: previousModel.dates.map(date => date.replace('2026', '2025')) } });
  assert.ok(allComponents(noOverlap).every(component => component.continuity.comparedToPrevious === false));
  const invalidPrior = buildPcaModel({ ...input, previousModel: { ...previousModel, fit: { ...previousModel.fit, scores: [null] } } });
  assert.ok(allComponents(invalidPrior).every(component => component.continuity.comparedToPrevious === false));
});

test('wide, rank-deficient matrices return only estimable PCs', () => {
  const returns = basis(8, 1);
  const model = buildPcaModel({ dates: datesFor(8), config: { window: 8 }, assets: Array.from({ length: 12 }, (_, index) => asset(`A${index}`, 0.05, returns.map(value => value * (index + 1) * 0.001))) });
  assert.equal(model.components.length, 1);
  assert.equal(model.otherComponents.length, 0);
  close(model.components[0].explainedVarianceRatio, 1);
  close(model.summary.residualVariance, 0);
});

test('missing, nonfinite, duplicate, or constant holding data is rejected instead of excluded', () => {
  const input = fixture();
  for (const invalid of [null, undefined, NaN, Infinity, '0.01']) {
    const assets = input.assets.map(item => ({ ...item, returns: [...item.returns] }));
    assets[0].returns[4] = invalid;
    expectCode(() => buildPcaModel({ ...input, assets }), 'INVALID_RETURNS');
  }
  expectCode(() => buildPcaModel({ ...input, assets: [...input.assets, input.assets[0]] }), 'DUPLICATE_ASSET');
  expectCode(() => buildPcaModel({ ...input, assets: [asset('ZERO', 1, Array(64).fill(0))] }), 'ZERO_VARIANCE');
  expectCode(() => buildPcaModel({ ...input, assets: [asset('NO_WEIGHT', null, input.assets[0].returns)] }), 'INVALID_WEIGHT');
  expectCode(() => buildPcaModel({ ...input, dates: [...input.dates].reverse() }), 'INVALID_DATES');
  expectCode(() => buildPcaModel({ ...input, dates: [...input.dates.slice(0, -1), input.dates[0]] }), 'INVALID_DATES');
  expectCode(() => buildPcaModel({ ...input, assets: [] }), 'NO_HOLDINGS');
});

test('scenario rejects unknown IDs, duplicate entries, mismatched dates, invalid weights, and corrupted basis', () => {
  const input = fixture();
  const model = buildPcaModel(input);
  expectCode(() => comparePcaScenario({ model, changes: [{ id: 'UNKNOWN', deltaWeight: 0.1 }] }), 'UNKNOWN_ASSET');
  expectCode(() => comparePcaScenario({ model, changes: [{ id: 'A', deltaWeight: NaN }] }), 'INVALID_WEIGHT');
  expectCode(() => comparePcaScenario({ model, changes: [{ id: 'A', deltaWeight: 0.1 }, { id: 'A', deltaWeight: -0.1 }] }), 'DUPLICATE_CHANGE');
  expectCode(() => comparePcaScenario({ model, candidates: [{ id: 'A', returns: input.assets[0].returns }] }), 'DUPLICATE_ASSET');
  expectCode(() => comparePcaScenario({ model, candidates: [{ id: 'NEW', returns: input.assets[0].returns.slice(1) }] }), 'INVALID_RETURNS');
  expectCode(() => comparePcaScenario({ model, candidates: [{ id: 'NEW', returns: input.assets[0].returns, dates: [...input.dates].reverse() }] }), 'INVALID_RETURNS');
  const corrupted = JSON.parse(JSON.stringify(model));
  corrupted.fit.scores[0] = corrupted.fit.scores[0].map(value => value * 2);
  expectCode(() => comparePcaScenario({ model: corrupted }), 'INVALID_MODEL');
  expectCode(() => comparePcaScenario({ model, changes: [{ id: 'A', deltaWeight: 1e308 }] }), 'NUMERICAL_OVERFLOW');
});

test('a JSON round trip preserves the reusable model and exact no-change comparison', () => {
  const model = buildPcaModel(fixture());
  const result = comparePcaScenario({ model: JSON.parse(JSON.stringify(model)) });
  assert.deepEqual(result.before, model.summary);
  assert.deepEqual(result.after, model.summary);
  assert.ok(result.components.every(component => component.varianceDelta === 0 && component.exposureDelta === 0 && component.riskShareDelta === 0));
});
