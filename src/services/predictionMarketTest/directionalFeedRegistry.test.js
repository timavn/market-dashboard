const {
  evaluateRiskRangeBasis,
  generateDirectionalCandidates,
  selectDirectionalContract,
} = require('./directionalFeedRegistry.cjs');

const NOW = Date.parse('2026-08-29T20:00:00.000Z');

function candidate(conId, month, volumes, lastTradeDate = `${month}28`) {
  return {
    qualified: true,
    instrument: {
      symbol: 'SI', displaySymbol: `SI-${month}`, conId, secType: 'FUT',
      exchange: 'COMEX', currency: 'USD', provider: 'ibkr',
      lastTradeDateOrContractMonth: lastTradeDate,
    },
    contract: { conId, lastTradeDateOrContractMonth: lastTradeDate },
    lastTradeDate,
    volumeSessions: volumes.map((volume, index) => ({
      date: `2026-08-${String(26 + index).padStart(2, '0')}`,
      volume,
    })),
  };
}

describe('unified directional feed registry', () => {
  test.each([
    ['sp500', ['ESU26', 'ESZ26', 'ESH27']],
    ['wti', ['CLV26', 'CLX26', 'CLZ26']],
    ['gold', ['GCV26', 'GCZ26', 'GCG27']],
    ['silver', ['SIU26', 'SIZ26', 'SIH27']],
    ['brent', ['BZX26', 'BZZ26', 'BZF27']],
  ])('generates current plus the next two directional %s delivery candidates', (marketId, symbols) => {
    expect(generateDirectionalCandidates(marketId, NOW, 3).slice(0, 3).map((row) => row.displaySymbol)).toEqual(symbols);
  });

  test('initially chooses the largest three-session median volume', () => {
    const thin = candidate(1, '202609', [100, 110, 105], '20260929');
    const liquid = candidate(2, '202612', [500, 600, 550], '20261229');
    expect(selectDirectionalContract({ candidates: [thin, liquid], nowMs: NOW })).toMatchObject({
      changed: true,
      reason: 'initial_three_session_median_volume',
      selected: { instrument: { conId: 2 } },
    });
  });

  test('holds through a one-session spike and rolls after two 20% crossover sessions', () => {
    const current = candidate(1, '202609', [100, 100, 100], '20260929');
    const oneSpike = candidate(2, '202612', [80, 80, 130], '20261229');
    expect(selectDirectionalContract({ candidates: [current, oneSpike], current, nowMs: NOW })).toMatchObject({
      changed: false, reason: 'sticky_volume_hysteresis', selected: { instrument: { conId: 1 } },
    });
    const crossover = candidate(2, '202612', [80, 125, 130], '20261229');
    expect(selectDirectionalContract({ candidates: [current, crossover], current, nowMs: NOW })).toMatchObject({
      changed: true, reason: 'successor_volume_20pct_two_sessions', selected: { instrument: { conId: 2 } },
    });
  });

  test('rolls inside five business days of last trade and never rolls backward', () => {
    const expiring = candidate(1, '202609', [500, 500, 500], '20260903');
    const successor = candidate(2, '202612', [100, 100, 100], '20261229');
    expect(selectDirectionalContract({ candidates: [expiring, successor], current: expiring, nowMs: NOW })).toMatchObject({
      changed: true, reason: 'within_five_business_days_of_last_trade', selected: { instrument: { conId: 2 } },
    });
    const prior = candidate(1, '202609', [5000, 5000, 5000], '20260929');
    expect(selectDirectionalContract({ candidates: [prior, successor], current: successor, nowMs: NOW })).toMatchObject({
      changed: false, selected: { instrument: { conId: 2 } },
    });
  });

  test('gates Hedgeye ranges without shifting their values', () => {
    expect(evaluateRiskRangeBasis({
      directionalPreviousClose: 100.5, hedgeyePreviousClose: 100,
      lrr: 95, hrr: 105,
    })).toMatchObject({ status: 'aligned', display: 'normal' });
    expect(evaluateRiskRangeBasis({
      directionalPreviousClose: 101.5, hedgeyePreviousClose: 100,
      lrr: 95, hrr: 105,
    })).toMatchObject({ status: 'proxy', display: 'proxy' });
    expect(evaluateRiskRangeBasis({
      directionalPreviousClose: 103, hedgeyePreviousClose: 100,
      lrr: 95, hrr: 105,
    })).toMatchObject({ status: 'mismatch', display: 'hide' });
  });
});
