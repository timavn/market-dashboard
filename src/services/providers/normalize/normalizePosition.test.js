const {
  isPredictionMarketContract,
  normalizeIbkrPosition,
} = require('./normalizePosition');

describe('IBKR position normalization', () => {
  test('retains an unfamiliar ForecastEx contract for the Prediction Markets Other bucket', () => {
    expect(isPredictionMarketContract({
      secType: 'OPT',
      exchange: 'FORECASTX',
      symbol: 'UNFAMILIAR',
      localSymbol: 'UNFAMILIAR CONTRACT',
    })).toBe(true);
  });

  test('keeps absent numeric values unavailable while preserving genuine zeroes', () => {
    expect(normalizeIbkrPosition({
      account: 'U1',
      symbol: 'KXUNKNOWN',
      secType: 'EVENT',
      position: 2,
    })).toEqual(expect.objectContaining({
      quantity: 2,
      avgCost: null,
      costBasis: null,
      marketValue: null,
      gainLoss: null,
    }));

    expect(normalizeIbkrPosition({
      account: 'U1',
      symbol: 'KXUNKNOWN',
      secType: 'EVENT',
      position: 0,
      avgCost: 0,
      marketValue: 0,
    })).toEqual(expect.objectContaining({
      quantity: 0,
      avgCost: 0,
      costBasis: 0,
      marketValue: 0,
    }));
  });
});
