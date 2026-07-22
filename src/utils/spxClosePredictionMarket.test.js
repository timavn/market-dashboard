import {
  classifySpxThreshold,
  dateKeyInTimeZone,
  findSpxRiskRangeForEvent,
  hasCurrentSpxRiskRange,
  isSpxClosePosition,
  locateSpxLivePrice,
  selectRelevantSpxMarkets,
} from './spxClosePredictionMarket';

describe('SPX close prediction-market helpers', () => {
  test('matches the Hedgeye range to the contract trading date in New York', () => {
    expect(dateKeyInTimeZone('2026-07-18T00:30:00Z')).toBe('2026-07-17');
    expect(hasCurrentSpxRiskRange(
      { date: '2026-07-17', lrr: 7425, hrr: 7575 },
      '2026-07-17T20:00:00Z',
    )).toBe(true);
    expect(hasCurrentSpxRiskRange(
      { date: '2026-07-17', lrr: 7425, hrr: 7575 },
      '2026-07-20T20:00:00Z',
    )).toBe(false);
  });

  test('classifies and narrows strikes without inventing probabilities', () => {
    const range = { lrr: 7425, hrr: 7575 };
    expect(classifySpxThreshold(7400, range)).toBe('below');
    expect(classifySpxThreshold(7500, range)).toBe('inside');
    expect(classifySpxThreshold(7600, range)).toBe('above');
    expect(selectRelevantSpxMarkets([
      { threshold: 7350 },
      { threshold: 7400 },
      { threshold: 7425 },
      { threshold: 7575 },
      { threshold: 7600 },
      { threshold: 7650 },
    ], range).map((market) => market.threshold)).toEqual([7400, 7425, 7575, 7600]);
  });

  test('places a live cash-SPX level between the correct adjacent strikes', () => {
    const markets = [7400, 7405, 7410, 7415].map((threshold) => ({ threshold }));

    expect(locateSpxLivePrice(markets, 7406)).toEqual({
      afterIndex: 1,
      position: 'between',
      lower: 7405,
      upper: 7410,
    });
    expect(locateSpxLivePrice(markets, 7410)).toEqual({
      afterIndex: 2,
      position: 'exact',
      lower: 7410,
      upper: 7410,
    });
  });

  test('labels live cash-SPX levels outside the shown ladder without moving the price', () => {
    const markets = [7405, 7410].map((threshold) => ({ threshold }));

    expect(locateSpxLivePrice(markets, 7400)).toEqual({
      afterIndex: -1,
      position: 'below',
      lower: null,
      upper: 7405,
    });
    expect(locateSpxLivePrice(markets, 7420)).toEqual({
      afterIndex: 1,
      position: 'above',
      lower: 7410,
      upper: null,
    });
    expect(locateSpxLivePrice(markets, null)).toBeNull();
    expect(locateSpxLivePrice([], 7406)).toBeNull();
  });

  test('selects the historical Risk Range by the exact event date', () => {
    const history = [
      { date: '2026-07-20', lrr: 7460, hrr: 7600 },
      { date: '2026-07-17', lrr: 7425, hrr: 7575, trend: 'BULLISH' },
      { date: '2026-07-16', lrr: 7464, hrr: 7598 },
    ];
    expect(findSpxRiskRangeForEvent(history, '2026-07-17T20:00:00Z')).toEqual(history[1]);
    expect(findSpxRiskRangeForEvent(history, '2026-07-15T20:00:00Z')).toBeNull();
  });

  test('accepts only positions from the exact active cash-SPX event', () => {
    expect(isSpxClosePosition(
      { localSymbol: 'KXINXU-26JUL17H1600-T7450_YES' },
      'KXINXU-26JUL17H1600',
    )).toBe(true);
    expect(isSpxClosePosition(
      { localSymbol: 'KXINXU-26JUL16H1600-T7450_YES' },
      'KXINXU-26JUL17H1600',
    )).toBe(false);
    expect(isSpxClosePosition({ localSymbol: 'FES_071726_7500_YES' })).toBe(false);
  });
});
