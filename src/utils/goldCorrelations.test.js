const {
  GOLD_CORRELATION_HORIZONS,
  alignCompletedLevels,
  buildGoldCorrelationSnapshot,
  completedDailyChanges,
  correlationsForHorizons,
  normalizeDailyHistory,
} = require('./goldCorrelations.cjs');

function dateSequence(length, start = '2026-01-01') {
  const startMs = Date.parse(`${start}T12:00:00.000Z`);
  return Array.from({ length }, (_, index) => (
    new Date(startMs + index * 24 * 60 * 60_000).toISOString().slice(0, 10)
  ));
}

function variedChanges(length) {
  return Array.from({ length }, (_, index) => (
    Math.sin(index / 4) * 0.008 + Math.cos(index / 11) * 0.003 + ((index % 5) - 2) * 0.0007
  ));
}

function priceHistory(changes, dates = dateSequence(changes.length + 1), multiplier = 1) {
  let close = 100;
  return dates.map((date, index) => {
    if (index > 0) close *= 1 + changes[index - 1] * multiplier;
    return { date, close };
  });
}

function yieldHistory(changes, dates = dateSequence(changes.length + 1), multiplier = 1) {
  let value = 2;
  return dates.map((date, index) => {
    if (index > 0) value += (changes[index - 1] * multiplier) / 100;
    return { date, value };
  });
}

function fullHistories(changes, dates) {
  return {
    DXY: priceHistory(changes, dates, -1),
    UST10Y_REAL: yieldHistory(changes, dates, -1),
    UST10Y_NOMINAL: yieldHistory(changes, dates, 1),
    SPX: priceHistory(changes, dates, 1),
    SILVER: priceHistory(changes, dates, -1),
    CRB: priceHistory(changes, dates, 1),
    WTI: priceHistory(changes, dates, -1),
  };
}

describe('Gold correlation calculations', () => {
  test('intersects completed dates before transforming and never forward-fills gaps', () => {
    const basis = normalizeDailyHistory([
      { date: '2026-01-01', close: 100 },
      { date: '2026-01-02', close: 101 },
      { date: '2026-01-03', close: 104 },
    ]);
    const comparator = normalizeDailyHistory([
      { date: '2026-01-01', close: 50 },
      { date: '2026-01-03', close: 55 },
    ]);

    const aligned = alignCompletedLevels(basis, comparator);
    expect(aligned).toEqual([
      { date: '2026-01-01', basis: 100, comparator: 50 },
      { date: '2026-01-03', basis: 104, comparator: 55 },
    ]);
    expect(completedDailyChanges(aligned, 'price_return')).toEqual([
      { date: '2026-01-03', base: 0.040000000000000036, metric: 0.10000000000000009 },
    ]);
  });

  test('uses percentage returns for prices and basis-point changes for official yields', () => {
    const aligned = [
      { date: '2026-01-01', basis: 100, comparator: 2 },
      { date: '2026-01-02', basis: 102, comparator: 2.05 },
      { date: '2026-01-03', basis: 101, comparator: 2.01 },
    ];

    const yieldChanges = completedDailyChanges(aligned, 'yield_change_bps');
    expect(yieldChanges.map((row) => row.date)).toEqual(['2026-01-02', '2026-01-03']);
    expect(yieldChanges[0].base).toBeCloseTo(0.02, 12);
    expect(yieldChanges[0].metric).toBeCloseTo(5, 12);
    expect(yieldChanges[1].base).toBeCloseTo(-0.009803921568627416, 12);
    expect(yieldChanges[1].metric).toBeCloseTo(-4, 12);
  });

  test('calculates every exact observation horizon from the latest completed changes', () => {
    const changes = variedChanges(180);
    const dates = dateSequence(181);
    const comparatorHistories = fullHistories(changes, dates);
    const snapshot = buildGoldCorrelationSnapshot({
      basisHistory: priceHistory(changes, dates),
      comparatorHistories,
    }, {
      now: new Date(`${dates.at(-1)}T23:00:00.000Z`),
      cutoffDate: dates.at(-1),
    });

    expect(snapshot.status).toBe('available');
    expect(snapshot.horizons).toEqual(GOLD_CORRELATION_HORIZONS.map(({ key }) => key));
    expect(snapshot.basis).toMatchObject({
      symbol: 'XAUUSD', role: 'proxy', status: 'available', asOf: dates.at(-1),
    });
    for (const row of snapshot.rows) {
      expect(row.status).toBe('available');
      expect(row.observations).toBe(180);
      const finalComparator = comparatorHistories[row.key].at(-1);
      expect(row.latest).toMatchObject({
        value: finalComparator.close ?? finalComparator.value,
        asOf: dates.at(-1),
      });
      for (const value of Object.values(row.values)) {
        expect(Math.abs(value)).toBe(1);
      }
    }
    expect(snapshot.rows.find((row) => row.key === 'UST10Y_REAL')).toMatchObject({
      transform: 'yield_change_bps', latest: { unit: 'percent' }, values: { '180D': -1 },
    });
    expect(snapshot.rows.find((row) => row.key === 'SPX')).toMatchObject({
      transform: 'price_return', latest: { unit: 'index' }, values: { '180D': 1 },
    });
  });

  test('requires the full aligned-change count for every horizon', () => {
    const changes = variedChanges(180);
    const dates = dateSequence(181);
    const shortDates = dates.slice(-31);
    const shortChanges = variedChanges(30);
    const snapshot = buildGoldCorrelationSnapshot({
      basisHistory: priceHistory(changes, dates),
      comparatorHistories: { DXY: priceHistory(shortChanges, shortDates, -1) },
      comparatorErrors: Object.fromEntries(
        ['UST10Y_REAL', 'UST10Y_NOMINAL', 'SPX', 'SILVER', 'CRB', 'WTI']
          .map((key) => [key, 'provider unavailable']),
      ),
    }, {
      now: new Date(`${dates.at(-1)}T23:00:00.000Z`),
      cutoffDate: dates.at(-1),
    });
    const dxy = snapshot.rows.find((row) => row.key === 'DXY');

    expect(snapshot.status).toBe('partial');
    expect(dxy).toMatchObject({ status: 'partial', observations: 30 });
    expect(dxy.values['15D']).toEqual(expect.any(Number));
    expect(dxy.values['30D']).toEqual(expect.any(Number));
    expect(dxy.values['90D']).toBeNull();
    expect(dxy.values['120D']).toBeNull();
    expect(dxy.values['180D']).toBeNull();
    expect(correlationsForHorizons(variedChanges(14).map((value, index) => ({
      date: String(index), base: value, metric: -value,
    })))['15D']).toBeNull();
  });

  test('excludes observations after the completed-session cutoff with no lookahead', () => {
    const changes = variedChanges(181);
    const dates = dateSequence(182);
    const cutoffDate = dates.at(-2);
    const snapshot = buildGoldCorrelationSnapshot({
      basisHistory: priceHistory(changes, dates),
      comparatorHistories: fullHistories(changes, dates),
    }, {
      now: new Date(`${dates.at(-1)}T12:00:00.000Z`),
      cutoffDate,
    });

    expect(snapshot.basis.asOf).toBe(cutoffDate);
    expect(snapshot.calculationDate).toBe(cutoffDate);
    expect(snapshot.rows.every((row) => row.asOf === cutoffDate)).toBe(true);
    expect(snapshot.rows.every((row) => row.observations === 180)).toBe(true);
  });

  test('rejects a stale or missing XAUUSD basis instead of returning comparator data', () => {
    const changes = variedChanges(180);
    const dates = dateSequence(181, '2025-01-01');
    expect(() => buildGoldCorrelationSnapshot({
      basisHistory: priceHistory(changes, dates),
      comparatorHistories: fullHistories(changes, dates),
    }, {
      now: new Date('2026-08-31T20:00:00.000Z'),
      cutoffDate: '2026-08-31',
    })).toThrow(/stale/i);

    expect(() => buildGoldCorrelationSnapshot({ basisHistory: [] }, {
      now: new Date('2026-08-31T20:00:00.000Z'),
      cutoffDate: '2026-08-31',
    })).toThrow(/XAUUSD/i);
  });
});
