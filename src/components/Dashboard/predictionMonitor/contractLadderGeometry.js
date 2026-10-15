import { finite } from './monitorNumbers';

export const SPX_CONTRACT_LINES_PER_SIDE = 5;

export function selectContractLinesAroundSpot(analyses = [], spotValue, linesPerSide = SPX_CONTRACT_LINES_PER_SIDE) {
  if (!Array.isArray(analyses) || !finite(spotValue)) return analyses;
  const sideLimit = Math.max(0, Math.floor(Number(linesPerSide)) || 0);
  const spot = Number(spotValue);
  const ordered = analyses
    .map((analysis, originalIndex) => ({
      analysis,
      originalIndex,
      threshold: Number(analysis?.line?.threshold),
    }))
    .filter(({ threshold }) => Number.isFinite(threshold))
    .sort((left, right) => left.threshold - right.threshold || left.originalIndex - right.originalIndex);

  const below = sideLimit > 0
    ? ordered.filter(({ threshold }) => threshold < spot).slice(-sideLimit)
    : [];
  const exact = ordered.filter(({ threshold }) => threshold === spot);
  const above = sideLimit > 0
    ? ordered.filter(({ threshold }) => threshold > spot).slice(0, sideLimit)
    : [];
  return [...below, ...exact, ...above].map(({ analysis }) => analysis);
}

export const contractLineGeometry = (line) => {
  const lower = finite(line?.lowerBound) ? Number(line.lowerBound) : null;
  const upper = finite(line?.upperBound) ? Number(line.upperBound) : null;
  const threshold = finite(line?.threshold) ? Number(line.threshold) : lower ?? upper;
  if (line?.comparator === 'inclusive_range' && lower != null && upper != null && lower <= upper) {
    return { lower, upper, anchor: (lower + upper) / 2, range: true };
  }
  return threshold == null
    ? null
    : { lower: threshold, upper: threshold, anchor: threshold, range: false };
};

export const buildLadderProximityLevels = (lines = [], spotValue) => {
  const levels = new Map();
  if (!finite(spotValue)) return levels;
  const spot = Number(spotValue);
  const entries = (Array.isArray(lines) ? lines : []).map((line, index) => {
    const geometry = contractLineGeometry(line);
    if (!geometry) return null;
    const containsSpot = geometry.range
      ? spot >= geometry.lower && spot <= geometry.upper
      : spot === geometry.anchor;
    return { index, geometry, containsSpot };
  }).filter(Boolean);
  const containing = entries.filter(({ containsSpot }) => containsSpot);
  const below = entries
    .filter(({ geometry, containsSpot }) => !containsSpot && geometry.anchor < spot)
    .sort((left, right) => right.geometry.anchor - left.geometry.anchor);
  const above = entries
    .filter(({ geometry, containsSpot }) => !containsSpot && geometry.anchor > spot)
    .sort((left, right) => left.geometry.anchor - right.geometry.anchor);

  containing.forEach(({ index }) => levels.set(index, 'dark'));
  ['dark', 'medium', 'light'].forEach((level, index) => {
    if (below[index]) levels.set(below[index].index, level);
    if (above[index]) levels.set(above[index].index, level);
  });
  return levels;
};

export const buildGoldLadderProximityLevels = buildLadderProximityLevels;

export const contractLineActivity = (line) => [line?.openInterest, line?.volume24h, line?.totalVolume, line?.liquidity]
  .reduce((total, value) => total + (finite(value) ? Number(value) : 0), 0);

export function selectContractLinesForReference(
  analyses = [],
  spotValue,
  linesPerSide = SPX_CONTRACT_LINES_PER_SIDE,
  maximumWithoutReference = 10,
) {
  if (!Array.isArray(analyses)) return [];
  const ordered = analyses.map((analysis, originalIndex) => ({
    analysis,
    originalIndex,
    geometry: contractLineGeometry(analysis?.line),
  })).filter(({ geometry }) => geometry).sort((left, right) => (
    left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex
  ));
  if (!finite(spotValue)) {
    return ordered
      .sort((left, right) => (
        contractLineActivity(right.analysis?.line) - contractLineActivity(left.analysis?.line)
        || left.geometry.anchor - right.geometry.anchor
        || String(left.analysis?.line?.ticker || '').localeCompare(String(right.analysis?.line?.ticker || ''))
      ))
      .slice(0, Math.max(0, Math.floor(Number(maximumWithoutReference)) || 0))
      .sort((left, right) => left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex)
      .map(({ analysis }) => analysis);
  }
  const spot = Number(spotValue);
  const sideLimit = Math.max(0, Math.floor(Number(linesPerSide)) || 0);
  const below = ordered.filter(({ geometry }) => geometry.upper < spot).slice(-sideLimit);
  const containing = ordered.filter(({ geometry }) => geometry.lower <= spot && geometry.upper >= spot);
  const above = ordered.filter(({ geometry }) => geometry.lower > spot).slice(0, sideLimit);
  return [...below, ...containing, ...above].map(({ analysis }) => analysis);
}
