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

  test('labels a completed daily close as reference data and derives session PnL', () => {
    const position = normalizeIbkrPosition(
      {
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        secType: 'STK',
        position: -3,
      },
      {
        mark: 102,
        priceState: 'historical_close',
        priceSource: 'ibkr_historical_daily_close',
        priceObservedAt: '2026-07-25T15:00:00Z',
        priceSessionDate: '2026-07-24',
        referenceClose: 102,
        referenceCloseSource: 'ibkr_historical_daily_close',
        referenceCloseSessionDate: '2026-07-24',
        referenceCloseObservedAt: '2026-07-25T15:00:00Z',
        previousClose: 100,
        previousCloseSessionDate: '2026-07-23',
      },
    );

    expect(position).toEqual(expect.objectContaining({
      price: 102,
      priceState: 'historical_close',
      marketValue: -306,
      marketValueState: 'historical_close',
      priceSource: 'ibkr_historical_daily_close',
      priceSessionDate: '2026-07-24',
      referenceClose: 102,
      previousClose: 100,
      dayPriceChange: 2,
      dayChange: -6,
      dayGainLoss: -6,
      dayChangePercent: -2,
      dayChangeState: 'historical_session',
      dayChangeSessionDate: '2026-07-24',
      warning: null,
    }));
  });

  test('does not turn a structured mark failure into a zero value', () => {
    const failure = {
      account: 'U1',
      conId: 101,
      errorCode: 'REFERENCE_MARK_HISTORY_TIMEOUT',
      stage: 'historical_daily_close',
      retryable: true,
      observedAt: '2026-07-25T15:00:00Z',
    };
    const position = normalizeIbkrPosition(
      {
        account: 'U1',
        conId: 101,
        symbol: 'SPY',
        secType: 'STK',
        position: 2,
      },
      { failure },
    );

    expect(position).toEqual(expect.objectContaining({
      price: null,
      priceState: 'unavailable',
      marketValue: null,
      marketValueState: 'unavailable',
      dayChange: null,
      dayGainLoss: null,
      markFailure: failure,
      warning: 'missing_market_value',
    }));
  });
});
