const {
  classifyVixBucket,
  buildVolatilityDeviationAlert,
} = require('./hermesRules.cjs');

function historyAround(value, count = 63) {
  return Array.from({ length: count }, (_, index) => ({
    close: value + ((index % 5) - 2) * 0.1,
  }));
}

describe('Hermes rules', () => {
  test('classifies VIX bucket boundaries', () => {
    expect(classifyVixBucket(18.99).key).toBe('investable');
    expect(classifyVixBucket(19).key).toBe('chop');
    expect(classifyVixBucket(29).key).toBe('fBucket');
  });

  test('creates volatility alert at 2 sigma but not below threshold', () => {
    const quietHistory = historyAround(20);

    const below = buildVolatilityDeviationAlert({
      name: 'VIX',
      current: 20.25,
      history: quietHistory,
    });
    expect(below).toBeNull();

    const above = buildVolatilityDeviationAlert({
      name: 'VIX',
      current: 21,
      history: quietHistory,
    });
    expect(above).toEqual(expect.objectContaining({
      name: 'VIX',
      direction: 'upside',
      severity: expect.any(String),
    }));
    expect(Math.abs(above.zScore)).toBeGreaterThanOrEqual(2);
  });
});
