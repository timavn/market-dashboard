const {
  computeQuadProbabilityOverlay,
  normalizeQuadProbabilities,
} = require('./quadProbabilityOverlay');

const q3q4Heavy = {
  q1: 15,
  q2: 18,
  q3: 37,
  q4: 30,
};

describe('quad probability overlay', () => {
  test('calculates weighted EV and positive probability mass for a Q3/Q4-heavy scenario', () => {
    const [row] = computeQuadProbabilityOverlay([
      { name: 'Gold', ticker: 'GLD', q1: 2.7, q2: 3.2, q3: 1.6, q4: 3.1 },
    ], q3q4Heavy);

    expect(row.weightedEV).toBeCloseTo(2.5, 2);
    expect(row.positiveProbMass).toBeCloseTo(1, 3);
    expect(row.positiveQuadCount).toBe(4);
    expect(row.classification).toBe('All-weather');
  });

  test('classifies assets positive in the top two likely quads as robust overlap', () => {
    const [row] = computeQuadProbabilityOverlay([
      { name: 'Q3 Q4 Winner', ticker: 'QQW', q1: -2, q2: 0, q3: 3, q4: 2 },
    ], q3q4Heavy);

    expect(row.classification).toBe('Robust overlap');
    expect(row.topTwoFloor).toBe(2);
    expect(row.positiveProbMass).toBeCloseTo(0.67, 2);
  });

  test('classifies assets positive in all four quads as all-weather', () => {
    const [row] = computeQuadProbabilityOverlay([
      { name: 'All Weather', ticker: 'ALL', q1: 1, q2: 1.5, q3: 2, q4: 0.5 },
    ], q3q4Heavy);

    expect(row.classification).toBe('All-weather');
    expect(row.positiveQuadCount).toBe(4);
  });

  test('keeps high single-quad winners ranked but marks them fragile when top quads are weak', () => {
    const rows = computeQuadProbabilityOverlay([
      { name: 'High Single Quad', ticker: 'HSQ', q1: 40, q2: 0, q3: -1, q4: -1 },
      { name: 'Robust But Smaller', ticker: 'RBS', q1: -1, q2: 0, q3: 3, q4: 2 },
    ], q3q4Heavy);

    const highSingle = rows.find((row) => row.ticker === 'HSQ');
    const robust = rows.find((row) => row.ticker === 'RBS');

    expect(highSingle.classification).toBe('Fragile');
    expect(highSingle.overlayScore).toBeGreaterThan(robust.overlayScore);
  });

  test('classifies non-positive weighted EV as avoid', () => {
    const [row] = computeQuadProbabilityOverlay([
      { name: 'Bad Mix', ticker: 'BAD', q1: 1, q2: 1, q3: -3, q4: -2 },
    ], q3q4Heavy);

    expect(row.weightedEV).toBeLessThanOrEqual(0);
    expect(row.classification).toBe('Avoid');
  });

  test('normalizes probabilities when editable inputs do not total 100%', () => {
    const normalized = normalizeQuadProbabilities({
      q1: 20,
      q2: 20,
      q3: 40,
      q4: 30,
    });

    expect(normalized.totalPct).toBe(110);
    expect(normalized.normalized.q3).toBeCloseTo(40 / 110, 4);
    expect(normalized.topQuads.slice(0, 2)).toEqual(['q3', 'q4']);
  });
});
