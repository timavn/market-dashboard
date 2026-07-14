const hermesRules = require('../constants/hermesRules.json');

function parseNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function classifyVixBucket(value, rules = hermesRules) {
  const numeric = parseNumber(value);
  if (numeric == null) return null;
  const buckets = rules?.volatility?.vixBuckets || [];
  return buckets.find((bucket) => {
    const min = parseNumber(bucket.min);
    const max = bucket.max == null ? null : parseNumber(bucket.max);
    return numeric >= min && (max == null || numeric <= max);
  }) || null;
}

function getExposureCapsForBucket(bucketKey, rules = hermesRules) {
  return rules?.exposureCaps?.[bucketKey] || null;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function calculateZScore(value, history, rules = hermesRules) {
  const numeric = parseNumber(value);
  if (numeric == null || !Array.isArray(history)) return null;
  const windowDays = Number(rules?.volatility?.rollingWindowTradingDays || 63);
  const minObs = Number(rules?.volatility?.minimumObservations || 40);
  const values = history
    .map((row) => parseNumber(row?.close ?? row?.value ?? row))
    .filter((rowValue) => rowValue != null)
    .slice(-windowDays);
  if (values.length < minObs) return null;
  const avg = mean(values);
  const sd = stdDev(values);
  if (!sd) return null;
  return (numeric - avg) / sd;
}

function buildVolatilityDeviationAlert({ name, current, history, rules = hermesRules }) {
  const zScore = calculateZScore(current, history, rules);
  const threshold = Number(rules?.volatility?.zScoreThreshold || 2);
  if (zScore == null || Math.abs(zScore) < threshold) return null;
  return {
    name,
    current: parseNumber(current),
    zScore,
    threshold,
    direction: zScore > 0 ? 'upside' : 'downside',
    severity: Math.abs(zScore) >= threshold + 1 ? 'critical' : 'warning',
  };
}

module.exports = {
  hermesRules,
  classifyVixBucket,
  getExposureCapsForBucket,
  calculateZScore,
  buildVolatilityDeviationAlert,
};
