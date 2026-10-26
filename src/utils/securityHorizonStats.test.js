const { horizonStats } = require('./securityHorizonStats.cjs');

const day = index => new Date(Date.UTC(2025, 0, 1) + index * 86400000).toISOString().slice(0, 10);
// Close rises 1 per session from 100; each bar spans ±1% with steady volume.
function bars(count, { volume = () => 1000 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return { date: day(index), adjustedClose: close, close, high: close * 1.01, low: close * 0.99, volume: volume(index) };
  });
}

test('each window reports change, range volatility, relative volume and range position', () => {
  const stats = horizonStats(bars(300, { volume: index => index >= 285 ? 2000 : 1000 }));
  expect(stats.asOf).toBe(day(299));
  expect(stats.columns.map(column => column.label)).toEqual(['1D', '15D', '30D', '90D']);
  const [one, fifteen, , ninety] = stats.columns;
  expect(one.priceChangePct).toBeCloseTo((399 / 398 - 1) * 100, 1);
  expect(ninety.priceChangePct).toBeCloseTo((399 / 309 - 1) * 100, 1);
  // ln(1.01 / 0.99) per session → about 18.9% annualized on every window.
  expect(one.realizedVolPct).toBe(19);
  expect(ninety.realizedVolPct).toBe(19);
  expect(stats.baselineVolPct).toBe(19);
  // The last 15 sessions trade twice the 252-session average volume.
  expect(fifteen.volumeRatio).toBeCloseTo(2000 / ((237 * 1000 + 15 * 2000) / 252), 1);
  expect(one.rangePct).toBe(50);
  expect(ninety.rangePct).toBeGreaterThan(95);
});

test('short or incomplete history leaves the affected cells empty', () => {
  const stats = horizonStats(bars(40).map((bar, index) => index === 39 ? { ...bar, volume: null } : bar));
  const ninety = stats.columns[3];
  expect(ninety).toEqual({ label: '90D', priceChangePct: null, realizedVolPct: null, volumeRatio: null, rangePct: null });
  expect(stats.columns[0].volumeRatio).toBeNull();
  expect(stats.columns[1].priceChangePct).not.toBeNull();
  expect(horizonStats([])).toBeNull();
});
