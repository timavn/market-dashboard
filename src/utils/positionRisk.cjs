'use strict';

const { buildAdjustedReturns } = require('./securityRiskMetrics.cjs');

const POSITION_RISK_WINDOW = 126;
const MINIMUM_OBSERVATIONS = 60;
const ANNUAL_SESSIONS = 252;
const BENCHMARK = 'SPY';

const round = (value, places) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);

function covariance(left, right) {
  let count = 0; let sumLeft = 0; let sumRight = 0; let sumProduct = 0;
  for (const [date, value] of left) {
    const other = right.get(date);
    if (other === undefined) continue;
    count += 1; sumLeft += value; sumRight += other; sumProduct += value * other;
  }
  if (count < MINIMUM_OBSERVATIONS) return null;
  return (sumProduct - (sumLeft * sumRight) / count) / (count - 1);
}

// How each position behaves in the book, from daily adjusted-close returns over the
// last `window` completed sessions: beta to the S&P 500, its own volatility, and its
// share of the book's variance (weight × its covariance with the whole book). A
// negative share is a position that offsets the rest. Weights are signed % of NAV.
function buildPositionRisk({ positions = [], histories = {}, benchmark = BENCHMARK, window = POSITION_RISK_WINDOW } = {}) {
  const dates = buildAdjustedReturns(histories[benchmark] || []).slice(-window).map(row => row.date);
  const inWindow = new Set(dates);
  const series = symbol => new Map(buildAdjustedReturns(histories[symbol] || [])
    .filter(row => inWindow.has(row.date) && Number.isFinite(row.value)).map(row => [row.date, row.value]));
  const market = series(benchmark);
  const marketVariance = covariance(market, market);

  const book = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = String(position?.symbol || '').trim().toUpperCase();
    const weight = Number(position?.weightPct);
    if (!symbol || !Number.isFinite(weight) || weight === 0) continue;
    book.set(symbol, (book.get(symbol) || 0) + weight);
  }
  const rows = [...book].map(([symbol, weightPct]) => {
    const returns = series(symbol);
    const variance = covariance(returns, returns);
    const marketCovariance = marketVariance > 0 ? covariance(returns, market) : null;
    const measured = variance != null && variance > 0;
    return {
      symbol, weightPct, returns: measured ? returns : null, observations: returns.size,
      beta: measured && marketCovariance != null ? marketCovariance / marketVariance : null,
      volPct: measured ? Math.sqrt(variance * ANNUAL_SESSIONS) * 100 : null,
      reason: measured ? null : returns.size < MINIMUM_OBSERVATIONS ? 'insufficient-history' : 'no-price-variation',
    };
  });

  const measured = rows.filter(row => row.returns);
  const contributions = new Map(measured.map(row => [row.symbol, 0]));
  let complete = true;
  for (const row of measured) {
    for (const other of measured) {
      const value = covariance(row.returns, other.returns);
      if (value == null) { complete = false; continue; }
      contributions.set(row.symbol, contributions.get(row.symbol) + row.weightPct * other.weightPct * value);
    }
  }
  const bookVariance = [...contributions.values()].reduce((sum, value) => sum + value, 0);
  const gross = rows.reduce((sum, row) => sum + Math.abs(row.weightPct), 0);
  const measuredGross = measured.reduce((sum, row) => sum + Math.abs(row.weightPct), 0);

  return {
    modelVersion: 'position-risk-v1',
    benchmark,
    window,
    asOf: dates[dates.length - 1] || null,
    status: !dates.length || !(bookVariance > 0) ? 'unavailable' : measured.length === rows.length && complete ? 'available' : 'partial',
    portfolio: {
      volPct: bookVariance > 0 ? round(Math.sqrt(bookVariance * ANNUAL_SESSIONS), 2) : null,
      beta: round(measured.reduce((sum, row) => sum + (row.beta ?? 0) * row.weightPct / 100, 0), 3),
      measuredGrossPct: gross > 0 ? round(measuredGross / gross * 100, 1) : null,
    },
    rows: rows.map(row => ({
      symbol: row.symbol,
      beta: round(row.beta, 3),
      volPct: round(row.volPct, 1),
      riskSharePct: row.returns && bookVariance > 0 ? round(contributions.get(row.symbol) / bookVariance * 100, 2) : null,
      observations: row.observations,
      reason: row.reason,
    })),
    methodology: {
      returnBasis: 'completed-session adjusted-close simple returns',
      beta: `covariance with ${benchmark} ÷ ${benchmark} variance`,
      riskShare: 'weight × covariance with the whole measured book ÷ book variance; shares sum to 100% and a negative share offsets the rest',
      observationGate: `${MINIMUM_OBSERVATIONS} shared sessions`,
    },
  };
}

module.exports = { MINIMUM_OBSERVATIONS, POSITION_RISK_WINDOW, buildPositionRisk };
