const { buildPositionRisk } = require('./positionRisk.cjs');

// Deterministic daily moves; `scale` and `sign` shape each security against the market.
const marketMoves = Array.from({ length: 130 }, (_, index) => Math.sin(index * 1.7) * 0.012 + Math.cos(index * 0.6) * 0.004);
const noise = Array.from({ length: 130 }, (_, index) => Math.sin(index * 2.9 + 1) * 0.006);
const bars = (moves) => {
  let close = 100;
  return [{ date: '2026-01-01', adjustedClose: close, close }].concat(moves.map((move, index) => {
    close *= 1 + move;
    const date = new Date(Date.UTC(2026, 0, 2 + index)).toISOString().slice(0, 10);
    return { date, adjustedClose: close, close };
  }));
};
const histories = {
  SPY: bars(marketMoves),
  UP2: bars(marketMoves.map(move => move * 2)),
  HEDGE: bars(marketMoves.map(move => -move)),
  OWN: bars(noise),
  NEW: bars(marketMoves).slice(-20),
};
const row = (result, symbol) => result.rows.find(item => item.symbol === symbol);

describe('position risk', () => {
  test('beta and volatility come from each security against the S&P 500', () => {
    const result = buildPositionRisk({ positions: [{ symbol: 'UP2', weightPct: 10 }, { symbol: 'HEDGE', weightPct: 5 }], histories });
    expect(row(result, 'UP2').beta).toBeCloseTo(2, 2);
    expect(row(result, 'HEDGE').beta).toBeCloseTo(-1, 2);
    expect(row(result, 'UP2').volPct).toBeGreaterThan(row(result, 'HEDGE').volPct);
    expect(result.portfolio.beta).toBeCloseTo(0.15, 2);
  });

  test('risk shares sum to 100% and a hedge takes a negative share', () => {
    const result = buildPositionRisk({ positions: [{ symbol: 'UP2', weightPct: 10 }, { symbol: 'HEDGE', weightPct: 5 }, { symbol: 'OWN', weightPct: 8 }], histories });
    expect(result.rows.reduce((sum, item) => sum + item.riskSharePct, 0)).toBeCloseTo(100, 0);
    expect(row(result, 'HEDGE').riskSharePct).toBeLessThan(0);
    expect(row(result, 'UP2').riskSharePct).toBeGreaterThan(0);
    expect(result.status).toBe('available');
  });

  test('a short position in a market follower offsets a long one', () => {
    const result = buildPositionRisk({ positions: [{ symbol: 'UP2', weightPct: 10 }, { symbol: 'SPY', weightPct: -5 }], histories });
    expect(row(result, 'SPY').riskSharePct).toBeLessThan(0);
  });

  test('a security without enough history is left out and reported, not estimated', () => {
    const result = buildPositionRisk({ positions: [{ symbol: 'UP2', weightPct: 10 }, { symbol: 'NEW', weightPct: 10 }, { symbol: 'NONE', weightPct: 5 }], histories });
    expect(row(result, 'NEW')).toMatchObject({ beta: null, riskSharePct: null, reason: 'insufficient-history' });
    expect(row(result, 'NONE').reason).toBe('insufficient-history');
    expect(row(result, 'UP2').riskSharePct).toBeCloseTo(100, 0);
    expect(result.status).toBe('partial');
    expect(result.portfolio.measuredGrossPct).toBe(40);
  });

  test('no benchmark history means no reading', () => {
    expect(buildPositionRisk({ positions: [{ symbol: 'UP2', weightPct: 10 }], histories: { UP2: histories.UP2 } }).status).toBe('unavailable');
  });
});
