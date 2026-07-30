const {
  ANNUALIZATION_CRYPTO,
  ANNUALIZATION_EQUITY,
  buildLogReturns,
  buildRealizedVolatilitySnapshot,
  normalizePriceSeries,
  resolveAnnualizationFactor,
  resolveSizingVolatility,
  sampleStdev,
  trailingAnnualizedVol,
} = require('./realizedVolatility.cjs');

function makeSeries(n, {
  start = 100,
  amplitude = 0.01,
  startDate = '2020-01-01',
} = {}) {
  const out = [];
  let price = start;
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    const date = new Date(startMs + (i * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    out.push({ date, close: price, adjustedClose: price });
    // Alternating signed moves so sample stdev is well above zero.
    const move = ((i % 2 === 0) ? 1 : -1) * amplitude * (1 + ((i % 7) * 0.05));
    price *= (1 + move);
  }
  return out;
}

describe('realizedVolatility', () => {
  test('resolveAnnualizationFactor uses 365 for crypto and 252 otherwise', () => {
    expect(resolveAnnualizationFactor('crypto')).toBe(ANNUALIZATION_CRYPTO);
    expect(resolveAnnualizationFactor('Cryptocurrency')).toBe(ANNUALIZATION_CRYPTO);
    expect(resolveAnnualizationFactor('equity')).toBe(ANNUALIZATION_EQUITY);
    expect(resolveAnnualizationFactor('etf')).toBe(ANNUALIZATION_EQUITY);
    expect(resolveAnnualizationFactor(null)).toBe(ANNUALIZATION_EQUITY);
  });

  test('normalizePriceSeries drops invalid prices and sorts by date', () => {
    const series = normalizePriceSeries([
      { date: '2024-01-03', close: 12 },
      { date: '2024-01-01', close: 10 },
      { date: '2024-01-02', close: null },
      { date: '2024-01-04', close: -1 },
      { date: '2024-01-05', adjustedClose: 14 },
    ]);
    expect(series.map((row) => row.date)).toEqual(['2024-01-01', '2024-01-03', '2024-01-05']);
    expect(series[2].close).toBe(14);
  });

  test('buildLogReturns computes ln(pt/pt-1) and skips gaps', () => {
    const returns = buildLogReturns([
      { date: '2024-01-01', close: 100 },
      { date: '2024-01-02', close: 110 },
      { date: '2024-01-03', close: null },
      { date: '2024-01-04', close: 121 },
    ]);
    expect(returns).toHaveLength(1);
    expect(returns[0].value).toBeCloseTo(Math.log(1.1), 8);
  });

  test('insufficient history returns unavailable with no sizing vol', () => {
    const snapshot = buildRealizedVolatilitySnapshot(makeSeries(50));
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.sizingVol).toBeNull();
    expect(snapshot.reason).toBe('insufficient_data');
    expect(snapshot.warnings[0]).toMatch(/63/);
  });

  test('limited history uses rv63 when fewer than 252 returns', () => {
    const snapshot = buildRealizedVolatilitySnapshot(makeSeries(80));
    expect(snapshot.status).toBe('available');
    expect(snapshot.limitedHistory).toBe(true);
    expect(snapshot.rv63).toBeGreaterThan(0);
    expect(snapshot.rv252).toBeNull();
    expect(snapshot.sizingVol).toBe(snapshot.rv63);
    expect(snapshot.annualizationFactor).toBe(252);
  });

  test('sizing vol is max(rv63, rv252) with full history', () => {
    // Calm history then a late high-amplitude window so 63d > 1.5× 252d.
    const calm = makeSeries(220, { amplitude: 0.002, start: 100 });
    const lastCalm = calm[calm.length - 1].close;
    const lastDate = calm[calm.length - 1].date;
    const spike = makeSeries(80, {
      start: lastCalm,
      amplitude: 0.04,
      startDate: new Date(Date.parse(`${lastDate}T00:00:00Z`) + 86400000)
        .toISOString()
        .slice(0, 10),
    });
    const series = [...calm, ...spike];
    const snapshot = buildRealizedVolatilitySnapshot(series);
    expect(snapshot.status).toBe('available');
    expect(snapshot.limitedHistory).toBe(false);
    expect(snapshot.rv63).toBeGreaterThan(snapshot.rv252);
    expect(snapshot.sizingVol).toBe(Math.max(snapshot.rv63, snapshot.rv252));
    expect(snapshot.spikeWarning).toBe(true);
  });

  test('crypto uses 365 annualization', () => {
    const equity = buildRealizedVolatilitySnapshot(makeSeries(100), { assetType: 'equity' });
    const crypto = buildRealizedVolatilitySnapshot(makeSeries(100), { assetType: 'crypto' });
    expect(crypto.annualizationFactor).toBe(365);
    expect(equity.annualizationFactor).toBe(252);
    // Same daily stdev annualizes higher at 365
    expect(crypto.sizingVol).toBeGreaterThan(equity.sizingVol);
  });

  test('trailingAnnualizedVol matches sample stdev * sqrt(factor)', () => {
    const returns = Array.from({ length: 63 }, (_, i) => ({
      date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      value: (i % 2 === 0 ? 0.01 : -0.008),
    }));
    const result = trailingAnnualizedVol(returns, 63, 252);
    const expected = sampleStdev(returns.map((r) => r.value)) * Math.sqrt(252);
    expect(result.value).toBeCloseTo(expected, 5);
  });

  test('resolveSizingVolatility respects useRecent63 toggle', () => {
    const snapshot = {
      status: 'available',
      sizingVol: 0.4,
      rv63: 0.4,
      rv252: 0.25,
    };
    expect(resolveSizingVolatility(snapshot, { useRecent63: true })).toBe(0.4);
    expect(resolveSizingVolatility(snapshot, { useRecent63: false })).toBe(0.25);
  });
});
