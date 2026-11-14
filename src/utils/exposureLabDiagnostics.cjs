const { buildAdjustedReturns } = require('./securityRiskMetrics.cjs');
const { buildFactorReturnSeries } = require('./exposureLabFactorRisk.cjs');
const {
  DEFAULT_CORRELATION_WINDOWS,
  DEFAULT_COVARIANCE_SHRINKAGE,
  FACTOR_DEFINITIONS,
} = require('../constants/exposureLabModel.cjs');
const {
  GEOGRAPHY_CONTROL_SYMBOL,
  GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS,
  GEOGRAPHY_MODEL_VERSION,
  GEOGRAPHY_PROXIES,
  REGION_ORDER,
  countryName,
  countryRegion,
  normalizeCountryCode,
} = require('../constants/exposureLabGeography.cjs');

const CORRELATION_MODEL_VERSION = 'exposure-lab-correlation-v2';
const DEFAULT_CORRELATION_WINDOW = 90;
const MINIMUM_CORRELATION_OBSERVATIONS = 20;
const MINIMUM_CORRELATION_COVERAGE = 0.8;
const ANNUALIZATION_SESSIONS = 252;
const PAIR_RANKING_LIMIT = 25;
const SERIES_MAP_CACHE = new WeakMap();

function classifyExposureLabPortfolioInput(portfolio) {
  if (!portfolio || typeof portfolio !== 'object') {
    return { verified: false, reason: 'live_portfolio_unavailable' };
  }
  if (portfolio.dataSource !== 'ibkr_api') {
    return { verified: false, reason: 'live_portfolio_unverified' };
  }
  if (portfolio.liveSessionVerified !== true || portfolio.fromCache !== false) {
    return { verified: false, reason: 'live_portfolio_unverified' };
  }
  if (
    portfolio.isMock === true
    || portfolio.mock === true
    || portfolio.isSeed === true
    || portfolio.seeded === true
    || portfolio.synthetic === true
  ) {
    return { verified: false, reason: 'live_portfolio_unverified' };
  }
  if (!(finiteNumber(portfolio.summary?.totalValue) > 0)) {
    return { verified: false, reason: 'net_liquidation_unavailable' };
  }
  return { verified: true, reason: null };
}

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

function minimumObservations(window) {
  return Math.max(
    MINIMUM_CORRELATION_OBSERVATIONS,
    Math.ceil(Number(window) * MINIMUM_CORRELATION_COVERAGE),
  );
}

function seriesFromBars(bars) {
  return buildAdjustedReturns(Array.isArray(bars) ? bars : [])
    .filter((row) => row?.date && Number.isFinite(row.value))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function seriesMap(series) {
  if (!Array.isArray(series)) return new Map();
  const cached = SERIES_MAP_CACHE.get(series);
  if (cached) return cached;
  const mapped = new Map(series
    .filter((row) => row?.date && Number.isFinite(row.value))
    .map((row) => [row.date, row]));
  SERIES_MAP_CACHE.set(series, mapped);
  return mapped;
}

function maximumRequestedWindow(windows = DEFAULT_CORRELATION_WINDOWS) {
  return Math.max(
    DEFAULT_CORRELATION_WINDOW,
    ...(Array.isArray(windows) ? windows : DEFAULT_CORRELATION_WINDOWS)
      .map(Number)
      .filter((window) => Number.isInteger(window) && window > 0),
  );
}

function normalizePortfolioPositions(holdings = [], totalValue = null) {
  const nav = finiteNumber(totalValue);
  if (!(nav > 0)) return [];
  const bySymbol = new Map();
  (Array.isArray(holdings) ? holdings : []).forEach((holding) => {
    const symbol = normalizeSymbol(holding?.symbol);
    const marketValue = finiteNumber(holding?.marketValue);
    if (!symbol || marketValue == null || marketValue === 0) return;
    const current = bySymbol.get(symbol) || {
      symbol,
      name: holding?.description || holding?.name || symbol,
      marketValue: 0,
      grossMarketValue: 0,
      quantity: 0,
      holdingCount: 0,
    };
    current.marketValue += marketValue;
    current.grossMarketValue += Math.abs(marketValue);
    current.quantity += finiteNumber(holding?.quantity) || 0;
    current.holdingCount += 1;
    if (current.name === current.symbol && (holding?.description || holding?.name)) {
      current.name = holding.description || holding.name;
    }
    bySymbol.set(symbol, current);
  });
  return [...bySymbol.values()].map((position) => ({
    ...position,
    side: position.marketValue < 0 ? 'short' : position.marketValue > 0 ? 'long' : 'flat',
    sideMultiplier: Math.sign(position.marketValue),
    signedWeight: position.marketValue / nav,
    signedWeightPct: round((position.marketValue / nav) * 100, 4),
    grossWeightPct: round((position.grossMarketValue / nav) * 100, 4),
  })).sort((left, right) => (
    right.grossMarketValue - left.grossMarketValue || left.symbol.localeCompare(right.symbol)
  ));
}

function matchingReturnIntervals(maps, dates) {
  return dates.filter((date) => maps.every((map) => map.has(date)
    && map.get(date).startDate === maps[0].get(date).startDate));
}

function recentAlignedRows(firstSeries, secondSeries, window, controlSeries = null) {
  const first = seriesMap(firstSeries);
  const second = seriesMap(secondSeries);
  const control = controlSeries == null ? null : seriesMap(controlSeries);
  const allDates = new Set([...first.keys(), ...second.keys(), ...(control ? control.keys() : [])]);
  const dates = [...allDates].sort().slice(-window);
  return matchingReturnIntervals([first, second, ...(control ? [control] : [])], dates).filter((date) => (
    first.has(date) && second.has(date) && (!control || control.has(date))
  )).map((date) => ({
    date,
    first: first.get(date).value,
    second: second.get(date).value,
    control: control?.get(date)?.value ?? null,
  }));
}

function moments(rows, leftKey, rightKey) {
  const count = rows.length;
  if (count < 2) return null;
  const meanLeft = rows.reduce((sum, row) => sum + row[leftKey], 0) / count;
  const meanRight = rows.reduce((sum, row) => sum + row[rightKey], 0) / count;
  let covarianceNumerator = 0;
  let leftVarianceNumerator = 0;
  let rightVarianceNumerator = 0;
  rows.forEach((row) => {
    const leftDelta = row[leftKey] - meanLeft;
    const rightDelta = row[rightKey] - meanRight;
    covarianceNumerator += leftDelta * rightDelta;
    leftVarianceNumerator += leftDelta * leftDelta;
    rightVarianceNumerator += rightDelta * rightDelta;
  });
  return {
    covariance: covarianceNumerator / (count - 1),
    leftVariance: leftVarianceNumerator / (count - 1),
    rightVariance: rightVarianceNumerator / (count - 1),
  };
}

function residualize(rows, targetKey) {
  const controlMoments = moments(rows, 'control', 'control');
  if (!controlMoments || controlMoments.leftVariance <= 1e-18) return null;
  const targetControl = moments(rows, targetKey, 'control');
  const targetMean = rows.reduce((sum, row) => sum + row[targetKey], 0) / rows.length;
  const controlMean = rows.reduce((sum, row) => sum + row.control, 0) / rows.length;
  const beta = targetControl.covariance / controlMoments.leftVariance;
  const intercept = targetMean - beta * controlMean;
  return rows.map((row) => row[targetKey] - intercept - beta * row.control);
}

function correlationCell(firstSeries, secondSeries, window, {
  signMultiplier = 1,
  controlSeries = null,
} = {}) {
  const required = minimumObservations(window);
  if (!Array.isArray(firstSeries) || firstSeries.length === 0
    || !Array.isArray(secondSeries) || secondSeries.length === 0) {
    return {
      value: null,
      rawValue: null,
      observations: 0,
      reason: 'history_unavailable',
      rawCovariance: null,
      asOf: null,
    };
  }
  if (controlSeries != null && (!Array.isArray(controlSeries) || controlSeries.length === 0)) {
    return {
      value: null,
      rawValue: null,
      observations: 0,
      reason: 'control_history_unavailable',
      rawCovariance: null,
      asOf: null,
    };
  }
  const rows = recentAlignedRows(firstSeries, secondSeries, window, controlSeries);
  if (rows.length < required) {
    return {
      value: null,
      rawValue: null,
      observations: rows.length,
      reason: 'insufficient_aligned_observations',
      rawCovariance: null,
      asOf: rows.at(-1)?.date || null,
    };
  }

  let modeledRows = rows;
  if (controlSeries != null) {
    const firstResiduals = residualize(rows, 'first');
    const secondResiduals = residualize(rows, 'second');
    if (!firstResiduals || !secondResiduals) {
      return {
        value: null,
        rawValue: null,
        observations: rows.length,
        reason: 'zero_control_variance',
        rawCovariance: null,
        asOf: rows.at(-1)?.date || null,
      };
    }
    modeledRows = rows.map((row, index) => ({
      ...row,
      first: firstResiduals[index],
      second: secondResiduals[index],
    }));
  }
  const stats = moments(modeledRows, 'first', 'second');
  if (!stats || stats.leftVariance <= 1e-18 || stats.rightVariance <= 1e-18) {
    return {
      value: null,
      rawValue: null,
      observations: rows.length,
      reason: 'zero_variance',
      rawCovariance: null,
      asOf: rows.at(-1)?.date || null,
    };
  }
  const rawValue = Math.max(
    -1,
    Math.min(1, stats.covariance / Math.sqrt(stats.leftVariance * stats.rightVariance)),
  );
  return {
    value: round(rawValue * signMultiplier, 4),
    rawValue: round(rawValue, 4),
    observations: rows.length,
    reason: null,
    rawCovariance: stats.covariance,
    asOf: rows.at(-1)?.date || null,
  };
}

function compactMatrix(rowItems, columnItems, window, cellBuilder) {
  const values = [];
  const rawValues = [];
  const observations = [];
  const reasons = [];
  rowItems.forEach((rowItem, rowIndex) => {
    const valueRow = [];
    const rawValueRow = [];
    const observationRow = [];
    const reasonRow = [];
    columnItems.forEach((columnItem, columnIndex) => {
      const cell = cellBuilder(rowItem, columnItem, rowIndex, columnIndex);
      valueRow.push(cell.value);
      rawValueRow.push(cell.rawValue);
      observationRow.push(cell.observations);
      reasonRow.push(cell.reason);
    });
    values.push(valueRow);
    rawValues.push(rawValueRow);
    observations.push(observationRow);
    reasons.push(reasonRow);
  });
  return {
    window,
    minimumObservations: minimumObservations(window),
    values,
    rawValues,
    observations,
    reasons,
  };
}

function serializePositionAxis(position) {
  return {
    id: position.symbol,
    symbol: position.symbol,
    label: position.name || position.symbol,
    side: position.side,
    signedWeightPct: position.signedWeightPct,
    grossWeightPct: position.grossWeightPct,
    holdingCount: position.holdingCount,
  };
}

function serializeFactorAxis(factor) {
  return {
    id: factor.id,
    label: factor.label,
    family: factor.family,
    formula: factor.formula,
    observations: factor.observations,
    asOf: factor.asOf,
    status: factor.status,
  };
}

function rankPositionPairs(positions, positionSeries, window = DEFAULT_CORRELATION_WINDOW) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < positions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < positions.length; rightIndex += 1) {
      const left = positions[leftIndex];
      const right = positions[rightIndex];
      const cell = correlationCell(
        positionSeries.get(left.symbol),
        positionSeries.get(right.symbol),
        window,
        { signMultiplier: left.sideMultiplier * right.sideMultiplier },
      );
      if (cell.value == null || !Number.isFinite(cell.rawCovariance)) continue;
      const signedAnnualizedCovariance = (
        cell.rawCovariance
        * left.sideMultiplier
        * right.sideMultiplier
        * (1 - DEFAULT_COVARIANCE_SHRINKAGE)
        * ANNUALIZATION_SESSIONS
      );
      const varianceContributionPct2 = (
        2
        * Math.abs(left.signedWeight)
        * Math.abs(right.signedWeight)
        * signedAnnualizedCovariance
        * 10_000
      );
      if (Math.abs(varianceContributionPct2) <= 1e-14) continue;
      pairs.push({
        left: serializePositionAxis(left),
        right: serializePositionAxis(right),
        pnlCorrelation: cell.value,
        rawCorrelation: cell.rawValue,
        observations: cell.observations,
        signedAnnualizedCovariance: round(signedAnnualizedCovariance, 8),
        annualizedVarianceContributionPct2: round(varianceContributionPct2, 4),
      });
    }
  }
  const commonRisk = pairs.filter((pair) => pair.annualizedVarianceContributionPct2 > 0)
    .sort((left, right) => (
      right.annualizedVarianceContributionPct2 - left.annualizedVarianceContributionPct2
      || left.left.symbol.localeCompare(right.left.symbol)
      || left.right.symbol.localeCompare(right.right.symbol)
    )).slice(0, PAIR_RANKING_LIMIT);
  const offsets = pairs.filter((pair) => pair.annualizedVarianceContributionPct2 < 0)
    .sort((left, right) => (
      left.annualizedVarianceContributionPct2 - right.annualizedVarianceContributionPct2
      || left.left.symbol.localeCompare(right.left.symbol)
      || left.right.symbol.localeCompare(right.right.symbol)
    )).slice(0, PAIR_RANKING_LIMIT);
  return {
    window,
    shrinkage: DEFAULT_COVARIANCE_SHRINKAGE,
    annualizationSessions: ANNUALIZATION_SESSIONS,
    commonRisk,
    offsets,
  };
}

function buildUnifiedCorrelation({
  holdings = [],
  totalValue = null,
  histories = {},
  factorDefinitions = FACTOR_DEFINITIONS,
  windows = DEFAULT_CORRELATION_WINDOWS,
} = {}) {
  const nav = finiteNumber(totalValue);
  if (!(nav > 0)) return buildEmptyCorrelation('net_liquidation_unavailable');
  const positions = normalizePortfolioPositions(holdings, nav)
    .filter((position) => position.sideMultiplier !== 0);
  if (positions.length === 0) return buildEmptyCorrelation('eligible_positions_unavailable');
  const selectedWindows = [...new Set((windows || DEFAULT_CORRELATION_WINDOWS)
    .map(Number).filter((window) => Number.isInteger(window) && window > 0))].sort((a, b) => a - b);
  const seriesWindow = maximumRequestedWindow(selectedWindows);
  const positionSeries = new Map(positions.map((position) => [
    position.symbol,
    seriesFromBars(histories[position.symbol] || []).slice(-seriesWindow),
  ]));
  const factors = buildFactorReturnSeries(histories, factorDefinitions);
  const factorSeries = new Map(factors.map((factor) => [
    factor.id,
    (factor.series || []).slice(-seriesWindow),
  ]));
  const positionAxis = positions.map(serializePositionAxis);
  const factorAxis = factors.map(serializeFactorAxis);

  const positionPositionMatrices = {};
  const positionFactorMatrices = {};
  const factorFactorMatrices = {};
  selectedWindows.forEach((window) => {
    positionPositionMatrices[String(window)] = compactMatrix(
      positions,
      positions,
      window,
      (left, right) => correlationCell(
        positionSeries.get(left.symbol),
        positionSeries.get(right.symbol),
        window,
        { signMultiplier: left.sideMultiplier * right.sideMultiplier },
      ),
    );
    positionFactorMatrices[String(window)] = compactMatrix(
      positions,
      factors,
      window,
      (position, factor) => correlationCell(
        positionSeries.get(position.symbol),
        factorSeries.get(factor.id),
        window,
        { signMultiplier: position.sideMultiplier },
      ),
    );
    factorFactorMatrices[String(window)] = compactMatrix(
      factors,
      factors,
      window,
      (left, right) => correlationCell(
        factorSeries.get(left.id),
        factorSeries.get(right.id),
        window,
      ),
    );
  });

  const defaultMatrix = positionPositionMatrices[String(DEFAULT_CORRELATION_WINDOW)];
  const availableCells = defaultMatrix?.values.flat().filter((value) => value != null).length || 0;
  const totalCells = defaultMatrix?.values.flat().length || 0;
  const positionsWithHistory = positions.filter((_position, index) => (
    defaultMatrix?.values?.[index]?.[index] != null
  ));
  const modeledGrossNavPct = positionsWithHistory.reduce(
    (sum, position) => sum + position.grossWeightPct,
    0,
  );
  const totalGrossNavPct = positions.reduce((sum, position) => sum + position.grossWeightPct, 0);

  return {
    status: availableCells === totalCells && totalCells > 0
      ? 'available'
      : availableCells > 0 ? 'partial' : 'unavailable',
    reason: availableCells > 0 ? null : 'correlation_history_unavailable',
    modelVersion: CORRELATION_MODEL_VERSION,
    defaultWindow: DEFAULT_CORRELATION_WINDOW,
    windows: selectedWindows,
    initialPositionCount: 20,
    maxPositionCount: 75,
    modes: {
      positionPosition: {
        id: 'position_position',
        label: 'Position × Position',
        rowAxis: positionAxis,
        columnAxis: positionAxis,
        matrices: positionPositionMatrices,
      },
      positionFactor: {
        id: 'position_factor',
        label: 'Position × Factor',
        rowAxis: positionAxis,
        columnAxis: factorAxis,
        matrices: positionFactorMatrices,
      },
      factorFactor: {
        id: 'factor_factor',
        label: 'Factor × Factor',
        rowAxis: factorAxis,
        columnAxis: factorAxis,
        matrices: factorFactorMatrices,
      },
    },
    pairs: rankPositionPairs(positions, positionSeries),
    coverage: {
      positionCount: positions.length,
      positionsWithHistory: positionsWithHistory.length,
      positionsWithQualifiedHistory: positionsWithHistory.length,
      modeledGrossNavPct: round(modeledGrossNavPct, 2),
      totalGrossNavPct: round(totalGrossNavPct, 2),
      modeledGrossCoveragePct: totalGrossNavPct > 0
        ? round((modeledGrossNavPct / totalGrossNavPct) * 100, 2)
        : 0,
      defaultWindowAvailableCellPct: totalCells > 0
        ? round((availableCells / totalCells) * 100, 2)
        : 0,
    },
    methodology: {
      returnBasis: 'completed-session adjusted-close simple returns',
      observationGate: 'max(20, ceil(80% × window)) aligned observations',
      positionSignAdjustment: 'position P&L correlation = side multiplier × raw asset correlation',
      factorFactorSignAdjustment: 'none',
      pairRanking: '2 × absolute NAV weights × annualized signed covariance after 20% off-diagonal shrinkage',
      clustersInferred: false,
    },
  };
}

// Hedgeye's eleven equity sectors, each by its SPDR ETF.
const SECTOR_ETFS = Object.freeze(['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY']);
// A stock is flagged for review when another sector ETF tracks it this much better than its own.
const SECTOR_FIT_REVIEW_MARGIN = 0.1;

// How closely each stock's daily returns follow its assigned sector ETF, on the same
// return basis and observation gate as the unified correlation, plus the sector ETF
// it follows best. Nothing is reassigned here: a better fit is only reported.
function buildSectorFit({
  assignments = [],
  histories = {},
  sectorEtfs = SECTOR_ETFS,
  windows = DEFAULT_CORRELATION_WINDOWS,
  defaultWindow = DEFAULT_CORRELATION_WINDOW,
} = {}) {
  const selectedWindows = [...new Set((windows || DEFAULT_CORRELATION_WINDOWS)
    .map(Number).filter((window) => Number.isInteger(window) && window > 0))].sort((a, b) => a - b);
  const seriesWindow = maximumRequestedWindow(selectedWindows);
  const cache = new Map();
  const series = (symbol) => {
    if (!cache.has(symbol)) cache.set(symbol, seriesFromBars(histories[symbol] || []).slice(-seriesWindow));
    return cache.get(symbol);
  };
  const cell = (symbol, etf, window) => {
    const result = correlationCell(series(symbol), series(etf), window);
    return { value: result.rawValue == null ? null : round(result.rawValue, 4), observations: result.observations, reason: result.reason || null };
  };
  const rows = (Array.isArray(assignments) ? assignments : []).map((assignment) => {
    const symbol = normalizeSymbol(assignment?.symbol);
    const etf = normalizeSymbol(assignment?.etf);
    if (!symbol || !sectorEtfs.includes(etf)) return null;
    const correlations = Object.fromEntries(selectedWindows.map((window) => [String(window), cell(symbol, etf, window)]));
    const assigned = correlations[String(defaultWindow)]?.value ?? null;
    const ranked = sectorEtfs
      .map((candidate) => ({ etf: candidate, value: cell(symbol, candidate, defaultWindow).value }))
      .filter((candidate) => candidate.value != null)
      .sort((left, right) => right.value - left.value);
    const best = ranked[0] || null;
    return {
      symbol,
      etf,
      correlations,
      best,
      // Another sector ETF follows the stock clearly better than the one it is filed under.
      review: Boolean(best && assigned != null && best.etf !== etf && best.value - assigned >= SECTOR_FIT_REVIEW_MARGIN),
    };
  }).filter(Boolean);
  return {
    modelVersion: 'exposure-lab-sector-fit-v1',
    defaultWindow,
    windows: selectedWindows,
    rows,
    methodology: {
      returnBasis: 'completed-session adjusted-close simple returns',
      observationGate: 'max(20, ceil(80% × window)) aligned observations',
      measure: 'raw return correlation of the stock with the sector ETF itself, not the sector-minus-market factor',
      reviewRule: `another sector ETF leads the assigned one by ${SECTOR_FIT_REVIEW_MARGIN} or more on the default window`,
    },
  };
}

function reviewMapBySymbol(reviews = []) {
  const map = new Map();
  (Array.isArray(reviews) ? reviews : []).forEach((review) => {
    const ticker = normalizeSymbol(review?.ticker);
    const canonical = normalizeSymbol(review?.canonicalSymbol);
    if (ticker) map.set(ticker, review);
    if (canonical && !map.has(canonical)) map.set(canonical, review);
  });
  return map;
}

function unknownGeography(reason, review = null) {
  return {
    available: false,
    reason,
    basis: null,
    allocations: [{ countryCode: 'Unknown', weightPct: 100 }],
    sourceName: review?.geography?.sourceName || null,
    sourceAsOf: review?.geography?.sourceAsOf || null,
    sourceUrl: review?.geography?.sourceUrl || null,
    ageDays: null,
  };
}

function resolveReviewedGeography(symbol, reviews, {
  securityMasterAvailable = true,
  now = new Date(),
} = {}) {
  if (!securityMasterAvailable) return unknownGeography('security_master_unavailable');
  const review = reviews.get(symbol);
  if (!review) return unknownGeography('security_unreviewed');
  if (review.identityStatus !== 'verified') return unknownGeography('identity_unverified', review);
  const geography = review.geography;
  if (!geography || !Array.isArray(geography.allocations) || geography.allocations.length === 0) {
    return unknownGeography('geography_unreviewed', review);
  }
  const basis = String(geography.basis || '').trim().toLowerCase();
  const instrumentType = String(review.instrumentType || '').trim().toUpperCase();
  const basisValid = (
    (instrumentType === 'STK' && basis === 'country_of_risk')
    || (['ETF', 'FUND'].includes(instrumentType)
      && ['single_country_mandate', 'holdings_lookthrough'].includes(basis))
  );
  const allocations = geography.allocations.map((allocation) => ({
    countryCode: normalizeCountryCode(allocation?.countryCode),
    weightPct: finiteNumber(allocation?.weightPct),
  }));
  const total = allocations.reduce((sum, allocation) => sum + (allocation.weightPct || 0), 0);
  const allocationsValid = allocations.every((allocation) => (
    allocation.countryCode && allocation.weightPct > 0 && allocation.weightPct <= 100
  ))
    && new Set(allocations.map((allocation) => allocation.countryCode)).size === allocations.length
    && Math.abs(total - 100) <= 0.01
    && (!['country_of_risk', 'single_country_mandate'].includes(basis)
      || (allocations.length === 1 && Math.abs(allocations[0].weightPct - 100) <= 0.01));
  let sourceUrlValid = true;
  if (geography.sourceUrl) {
    try {
      sourceUrlValid = ['http:', 'https:'].includes(new URL(geography.sourceUrl).protocol);
    } catch (_error) {
      sourceUrlValid = false;
    }
  }
  if (!basisValid || !allocationsValid || !sourceUrlValid || !geography.sourceName || !geography.sourceAsOf) {
    return unknownGeography('geography_record_invalid', review);
  }
  const sourceDateMs = new Date(`${geography.sourceAsOf}T00:00:00Z`).getTime();
  if (!Number.isFinite(sourceDateMs)) return unknownGeography('geography_record_invalid', review);
  const nowMs = new Date(now).getTime();
  const ageDays = Math.max(0, Math.floor((nowMs - sourceDateMs) / 86_400_000));
  if (basis === 'holdings_lookthrough' && ageDays > GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS) {
    return {
      ...unknownGeography('holdings_lookthrough_stale', review),
      ageDays,
    };
  }
  return {
    available: true,
    reason: null,
    basis,
    allocations,
    sourceName: geography.sourceName,
    sourceAsOf: geography.sourceAsOf,
    sourceUrl: geography.sourceUrl || null,
    ageDays,
  };
}

function allocationMatrix(axisIds, valuesById, axisBuilder) {
  const columnAxis = [
    { id: 'net', label: 'Net % NAV', signed: true },
    { id: 'long', label: 'Long % NAV', signed: true },
    { id: 'short', label: 'Short % NAV', signed: true },
    { id: 'gross', label: 'Gross % NAV', signed: false },
  ];
  return {
    rowAxis: axisIds.map(axisBuilder),
    columnAxis,
    values: axisIds.map((id) => columnAxis.map((column) => (
      round(valuesById.get(id)?.[column.id] || 0, 4)
    ))),
    observations: axisIds.map(() => columnAxis.map(() => null)),
  };
}

function addAllocation(bucket, id, metric, value) {
  const row = bucket.get(id) || { net: 0, long: 0, short: 0, gross: 0 };
  row[metric] += value;
  bucket.set(id, row);
}

function buildGeographyAllocation({
  holdings = [],
  totalValue = null,
  securityReviews = [],
  securityMasterAvailable = true,
  now = new Date(),
} = {}) {
  const nav = finiteNumber(totalValue);
  if (!(nav > 0)) return buildEmptyGeographyAllocation('net_liquidation_unavailable');
  const reviewMap = reviewMapBySymbol(securityReviews);
  const countryValues = new Map();
  const regionValues = new Map(REGION_ORDER.map((region) => [region, {
    net: 0, long: 0, short: 0, gross: 0,
  }]));
  const positionDetails = new Map();
  let knownGrossNavPct = 0;
  let unknownGrossNavPct = 0;
  let totalGrossNavPct = 0;

  (Array.isArray(holdings) ? holdings : []).forEach((holding) => {
    const symbol = normalizeSymbol(holding?.symbol);
    const marketValue = finiteNumber(holding?.marketValue);
    if (!symbol || marketValue == null || marketValue === 0) return;
    const reviewed = resolveReviewedGeography(symbol, reviewMap, { securityMasterAvailable, now });
    const signedPct = (marketValue / nav) * 100;
    const grossPct = Math.abs(signedPct);
    totalGrossNavPct += grossPct;
    if (reviewed.available) knownGrossNavPct += grossPct;
    else unknownGrossNavPct += grossPct;
    const existing = positionDetails.get(symbol) || {
      symbol,
      label: holding?.description || holding?.name || symbol,
      signedWeightPct: 0,
      grossWeightPct: 0,
      ...reviewed,
    };
    existing.signedWeightPct += signedPct;
    existing.grossWeightPct += grossPct;
    if (!reviewed.available) {
      existing.available = false;
      existing.reason = reviewed.reason;
      existing.basis = null;
      existing.allocations = [{ countryCode: 'Unknown', weightPct: 100 }];
    }
    positionDetails.set(symbol, existing);

    reviewed.allocations.forEach((allocation) => {
      const fraction = allocation.weightPct / 100;
      const country = allocation.countryCode || 'Unknown';
      const region = country === 'Unknown' ? 'Unknown' : countryRegion(country);
      const weightedSigned = signedPct * fraction;
      const weightedGross = grossPct * fraction;
      addAllocation(countryValues, country, 'net', weightedSigned);
      addAllocation(countryValues, country, marketValue > 0 ? 'long' : 'short', weightedSigned);
      addAllocation(countryValues, country, 'gross', weightedGross);
      addAllocation(regionValues, region, 'net', weightedSigned);
      addAllocation(regionValues, region, marketValue > 0 ? 'long' : 'short', weightedSigned);
      addAllocation(regionValues, region, 'gross', weightedGross);
    });
  });

  if (totalGrossNavPct === 0) return buildEmptyGeographyAllocation('eligible_positions_unavailable');
  if (!countryValues.has('Unknown')) {
    countryValues.set('Unknown', { net: 0, long: 0, short: 0, gross: 0 });
  }
  const countryIds = [...countryValues.keys()].sort((left, right) => {
    if (left === 'Unknown') return 1;
    if (right === 'Unknown') return -1;
    const regionDelta = REGION_ORDER.indexOf(countryRegion(left)) - REGION_ORDER.indexOf(countryRegion(right));
    return regionDelta || countryName(left).localeCompare(countryName(right));
  });
  const positionRows = [...positionDetails.values()].map((row) => ({
    ...row,
    signedWeightPct: round(row.signedWeightPct, 4),
    grossWeightPct: round(row.grossWeightPct, 4),
  })).sort((left, right) => right.grossWeightPct - left.grossWeightPct || left.symbol.localeCompare(right.symbol));
  return {
    status: !securityMasterAvailable
      ? 'unavailable'
      : unknownGrossNavPct > 0 ? 'partial' : 'available',
    reason: !securityMasterAvailable ? 'security_master_unavailable' : null,
    country: allocationMatrix(countryIds, countryValues, (id) => ({
      id,
      label: id === 'Unknown' ? 'Unknown' : countryName(id),
      countryCode: id === 'Unknown' ? null : id,
      region: id === 'Unknown' ? 'Unknown' : countryRegion(id),
    })),
    region: allocationMatrix(REGION_ORDER, regionValues, (id) => ({ id, label: id })),
    positions: positionRows,
    coverage: {
      knownPositionCount: positionRows.filter((row) => row.available).length,
      unknownPositionCount: positionRows.filter((row) => !row.available).length,
      knownGrossNavPct: round(knownGrossNavPct, 2),
      unknownGrossNavPct: round(unknownGrossNavPct, 2),
      totalGrossNavPct: round(totalGrossNavPct, 2),
      knownGrossCoveragePct: totalGrossNavPct > 0
        ? round((knownGrossNavPct / totalGrossNavPct) * 100, 2)
        : 0,
    },
    methodology: {
      basis: 'audited country of risk or audited fund allocation only',
      unknownPolicy: 'unreviewed, unsupported, invalid, or stale holdings look-through records are Unknown',
      holdingsLookthroughMaxAgeDays: GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS,
      regionCatalog: 'fixed ISO alpha-2 country-to-region catalog',
      listingInference: false,
      revenueExposure: false,
    },
  };
}

function controlEligible(series, controlSeries, window) {
  const rows = recentAlignedRows(series, controlSeries, window);
  if (rows.length < minimumObservations(window)) return false;
  const stats = moments(rows, 'first', 'second');
  return Boolean(stats && stats.leftVariance > 1e-18 && stats.rightVariance > 1e-18);
}

function portfolioSeriesForWindow(positions, positionSeries, controlSeries, window) {
  const modeledPositions = positions.filter((position) => (
    controlEligible(positionSeries.get(position.symbol), controlSeries, window)
  ));
  if (modeledPositions.length === 0) {
    return { series: [], modeledPositions, observations: 0 };
  }
  const maps = modeledPositions.map((position) => ({
    position,
    returns: seriesMap(positionSeries.get(position.symbol)),
  }));
  const control = seriesMap(controlSeries);
  const dates = [...new Set([
    ...control.keys(),
    ...maps.flatMap((entry) => [...entry.returns.keys()]),
  ])].sort().slice(-window);
  const series = matchingReturnIntervals([control, ...maps.map((entry) => entry.returns)], dates).filter((date) => (
    control.has(date) && maps.every((entry) => entry.returns.has(date))
  )).map((date) => ({
    date,
    startDate: control.get(date).startDate,
    value: maps.reduce((sum, entry) => (
      sum + entry.position.signedWeight * entry.returns.get(date).value
    ), 0),
  }));
  return { series, modeledPositions, observations: series.length };
}

function buildGeographySensitivity({
  holdings = [],
  totalValue = null,
  histories = {},
  windows = DEFAULT_CORRELATION_WINDOWS,
} = {}) {
  const nav = finiteNumber(totalValue);
  if (!(nav > 0)) return buildEmptyGeographySensitivity('net_liquidation_unavailable');
  const positions = normalizePortfolioPositions(holdings, nav)
    .filter((position) => position.sideMultiplier !== 0);
  if (positions.length === 0) return buildEmptyGeographySensitivity('eligible_positions_unavailable');
  const selectedWindows = [...new Set((windows || DEFAULT_CORRELATION_WINDOWS)
    .map(Number).filter((window) => Number.isInteger(window) && window > 0))].sort((a, b) => a - b);
  const seriesWindow = maximumRequestedWindow(selectedWindows);
  const positionSeries = new Map(positions.map((position) => [
    position.symbol,
    seriesFromBars(histories[position.symbol] || []).slice(-seriesWindow),
  ]));
  const controlSeries = seriesFromBars(histories[GEOGRAPHY_CONTROL_SYMBOL] || [])
    .slice(-seriesWindow);
  const proxies = GEOGRAPHY_PROXIES.map((proxy) => ({
    ...proxy,
    series: seriesFromBars(histories[proxy.symbol] || []).slice(-seriesWindow),
  }));
  const rowAxis = [
    {
      id: 'portfolio',
      symbol: null,
      label: 'Portfolio',
      side: 'portfolio',
      signedWeightPct: round(positions.reduce((sum, position) => sum + position.signedWeightPct, 0), 4),
      grossWeightPct: round(positions.reduce((sum, position) => sum + position.grossWeightPct, 0), 4),
    },
    ...positions.map(serializePositionAxis),
  ];
  const columnAxis = proxies.map((proxy) => ({
    id: proxy.id,
    label: proxy.label,
    symbol: proxy.symbol,
  }));
  const matrices = {};
  const coverageByWindow = {};
  selectedWindows.forEach((window) => {
    const portfolio = portfolioSeriesForWindow(positions, positionSeries, controlSeries, window);
    const matrixRows = [{ id: 'portfolio', series: portfolio.series, sideMultiplier: 1 }, ...positions.map((position) => ({
      id: position.symbol,
      series: positionSeries.get(position.symbol),
      sideMultiplier: position.sideMultiplier,
    }))];
    matrices[String(window)] = compactMatrix(
      matrixRows,
      proxies,
      window,
      (row, proxy) => correlationCell(row.series, proxy.series, window, {
        signMultiplier: row.sideMultiplier,
        controlSeries,
      }),
    );
    const modeledGrossNavPct = portfolio.modeledPositions.reduce(
      (sum, position) => sum + position.grossWeightPct,
      0,
    );
    const totalGrossNavPct = positions.reduce((sum, position) => sum + position.grossWeightPct, 0);
    coverageByWindow[String(window)] = {
      modeledPositionCount: portfolio.modeledPositions.length,
      totalPositionCount: positions.length,
      modeledGrossNavPct: round(modeledGrossNavPct, 2),
      totalGrossNavPct: round(totalGrossNavPct, 2),
      modeledGrossCoveragePct: totalGrossNavPct > 0
        ? round((modeledGrossNavPct / totalGrossNavPct) * 100, 2)
        : 0,
      portfolioObservations: portfolio.observations,
    };
  });
  const defaultValues = matrices[String(DEFAULT_CORRELATION_WINDOW)]?.values.flat() || [];
  const availableCells = defaultValues.filter((value) => value != null).length;
  return {
    status: availableCells > 0 ? (availableCells === defaultValues.length ? 'available' : 'partial') : 'unavailable',
    reason: availableCells > 0 ? null : (
      controlSeries.length === 0 ? 'control_history_unavailable' : 'sensitivity_history_unavailable'
    ),
    control: {
      symbol: GEOGRAPHY_CONTROL_SYMBOL,
      label: 'Global market control',
      observations: controlSeries.length,
      asOf: controlSeries.at(-1)?.date || null,
    },
    defaultWindow: DEFAULT_CORRELATION_WINDOW,
    windows: selectedWindows,
    rowAxis,
    columnAxis,
    matrices,
    coverageByWindow,
    methodology: {
      returnBasis: 'completed-session adjusted-close simple returns',
      control: 'both position and proxy returns are OLS-residualized on ACWI with an intercept',
      interpretation: 'overlapping market sensitivities; non-additive and not country allocation, domicile, or revenue exposure',
      positionSignAdjustment: 'position P&L correlation = side multiplier × raw residual correlation',
    },
  };
}

function buildEmptyCorrelation(reason) {
  return {
    status: 'unavailable',
    reason,
    modelVersion: CORRELATION_MODEL_VERSION,
    defaultWindow: DEFAULT_CORRELATION_WINDOW,
    windows: [...DEFAULT_CORRELATION_WINDOWS],
    initialPositionCount: 20,
    maxPositionCount: 75,
    modes: {},
    pairs: {
      window: DEFAULT_CORRELATION_WINDOW,
      shrinkage: DEFAULT_COVARIANCE_SHRINKAGE,
      annualizationSessions: ANNUALIZATION_SESSIONS,
      commonRisk: [],
      offsets: [],
    },
    coverage: {
      positionCount: 0,
      positionsWithHistory: 0,
      positionsWithQualifiedHistory: 0,
      modeledGrossNavPct: 0,
      totalGrossNavPct: 0,
      modeledGrossCoveragePct: 0,
      defaultWindowAvailableCellPct: 0,
    },
  };
}

function buildEmptyGeographyAllocation(reason) {
  return {
    status: 'unavailable',
    reason,
    country: { rowAxis: [], columnAxis: [], values: [], observations: [] },
    region: { rowAxis: [], columnAxis: [], values: [], observations: [] },
    positions: [],
    coverage: {
      knownPositionCount: 0,
      unknownPositionCount: 0,
      knownGrossNavPct: 0,
      unknownGrossNavPct: 0,
      totalGrossNavPct: 0,
      knownGrossCoveragePct: 0,
    },
  };
}

function buildEmptyGeographySensitivity(reason) {
  return {
    status: 'unavailable',
    reason,
    control: { symbol: GEOGRAPHY_CONTROL_SYMBOL, label: 'Global market control', observations: 0, asOf: null },
    defaultWindow: DEFAULT_CORRELATION_WINDOW,
    windows: [...DEFAULT_CORRELATION_WINDOWS],
    rowAxis: [],
    columnAxis: GEOGRAPHY_PROXIES.map((proxy) => ({
      id: proxy.id,
      label: proxy.label,
      symbol: proxy.symbol,
    })),
    matrices: {},
    coverageByWindow: {},
  };
}

function buildEmptyGeography(reason) {
  return {
    status: 'unavailable',
    reason,
    modelVersion: GEOGRAPHY_MODEL_VERSION,
    allocation: buildEmptyGeographyAllocation(reason),
    sensitivity: buildEmptyGeographySensitivity(reason),
  };
}

function buildExposureLabDiagnostics(options = {}) {
  const correlation = buildUnifiedCorrelation(options);
  const allocation = buildGeographyAllocation({
    ...options,
    holdings: Array.isArray(options.allocationHoldings)
      ? options.allocationHoldings
      : options.holdings,
  });
  const sensitivity = buildGeographySensitivity(options);
  return {
    correlation,
    geography: {
      status: [allocation.status, sensitivity.status].every((status) => status === 'available')
        ? 'available'
        : [allocation.status, sensitivity.status].some((status) => status !== 'unavailable')
          ? 'partial'
          : 'unavailable',
      reason: allocation.status === 'unavailable' && sensitivity.status === 'unavailable'
        ? allocation.reason || sensitivity.reason
        : null,
      modelVersion: GEOGRAPHY_MODEL_VERSION,
      allocation,
      sensitivity,
    },
  };
}

module.exports = {
  ANNUALIZATION_SESSIONS,
  CORRELATION_MODEL_VERSION,
  DEFAULT_CORRELATION_WINDOW,
  MINIMUM_CORRELATION_COVERAGE,
  MINIMUM_CORRELATION_OBSERVATIONS,
  SECTOR_ETFS,
  buildEmptyCorrelation,
  buildEmptyGeography,
  buildExposureLabDiagnostics,
  buildGeographyAllocation,
  buildGeographySensitivity,
  buildSectorFit,
  buildUnifiedCorrelation,
  classifyExposureLabPortfolioInput,
  correlationCell,
  minimumObservations,
  normalizePortfolioPositions,
  rankPositionPairs,
  recentAlignedRows,
};
