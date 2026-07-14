const QUAD_KEYS = ['q1', 'q2', 'q3', 'q4'];

function parseNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeQuadProbabilities(probabilities = {}) {
  const rawPct = QUAD_KEYS.reduce((acc, key) => {
    acc[key] = Math.max(0, parseNumber(probabilities[key], 0));
    return acc;
  }, {});
  const totalPct = QUAD_KEYS.reduce((sum, key) => sum + rawPct[key], 0);
  const normalized = QUAD_KEYS.reduce((acc, key) => {
    acc[key] = totalPct > 0 ? rawPct[key] / totalPct : 0;
    return acc;
  }, {});
  const topQuads = [...QUAD_KEYS].sort((a, b) => (
    normalized[b] - normalized[a] || QUAD_KEYS.indexOf(a) - QUAD_KEYS.indexOf(b)
  ));

  return {
    normalized,
    rawPct,
    totalPct: round(totalPct, 1),
    topQuads,
  };
}

function classifyOverlayRow({
  weightedEV,
  positiveProbMass,
  positiveQuadCount,
  topTwoValues,
}) {
  if (weightedEV <= 0) return 'Avoid';
  if (positiveQuadCount === 4) return 'All-weather';

  const topTwoPositive = topTwoValues.length > 0 && topTwoValues.every((value) => value > 0);
  if (topTwoPositive) return 'Robust overlap';

  const topTwoHasNegative = topTwoValues.some((value) => value < 0);
  if (topTwoHasNegative) return 'Fragile';

  if (positiveProbMass >= 0.6) return 'Probability aligned';
  return 'Fragile';
}

function scoreExpectedValueRow(row, probabilities) {
  const { normalized, rawPct, totalPct, topQuads } = normalizeQuadProbabilities(probabilities);
  const ev = QUAD_KEYS.reduce((acc, key) => {
    acc[key] = parseNumber(row[key], 0);
    return acc;
  }, {});
  const weightedEV = QUAD_KEYS.reduce((sum, key) => sum + normalized[key] * ev[key], 0);
  const positiveProbMass = QUAD_KEYS.reduce((sum, key) => (
    ev[key] > 0 ? sum + normalized[key] : sum
  ), 0);
  const positiveQuadCount = QUAD_KEYS.filter((key) => ev[key] > 0).length;
  const topTwoValues = topQuads.slice(0, 2).map((key) => ev[key]);
  const topTwoFloor = topTwoValues.length > 0 ? Math.min(...topTwoValues) : 0;
  const overlayScore =
    weightedEV * (0.75 + 0.25 * positiveProbMass) +
    Math.max(0, topTwoFloor) * 0.15 -
    Math.max(0, -topTwoFloor) * 0.35;
  const classification = classifyOverlayRow({
    weightedEV,
    positiveProbMass,
    positiveQuadCount,
    topTwoValues,
  });

  return {
    ...row,
    ev,
    probabilities: normalized,
    rawProbabilities: rawPct,
    probabilityTotalPct: totalPct,
    weightedEV: round(weightedEV),
    positiveProbMass: round(positiveProbMass, 4),
    positiveQuadCount,
    topTwoFloor: round(topTwoFloor),
    overlayScore: round(overlayScore),
    classification,
  };
}

function computeQuadProbabilityOverlay(rows = [], probabilities = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => scoreExpectedValueRow(row, probabilities))
    .sort((a, b) => (
      (b.overlayScore ?? -Infinity) - (a.overlayScore ?? -Infinity) ||
      (b.weightedEV ?? -Infinity) - (a.weightedEV ?? -Infinity) ||
      (b.positiveProbMass ?? -Infinity) - (a.positiveProbMass ?? -Infinity) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    ))
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));
}

module.exports = {
  QUAD_KEYS,
  classifyOverlayRow,
  computeQuadProbabilityOverlay,
  normalizeQuadProbabilities,
  scoreExpectedValueRow,
};
