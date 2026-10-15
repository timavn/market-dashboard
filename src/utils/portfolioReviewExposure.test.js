import { portfolioExposurePercentages } from './portfolioReviewExposure';

const captured = {
  longMarketValue: 150000, shortMarketValue: -50000, netLiquidation: 100000,
  grossLeverage: 2, netExposurePctOfNlv: 100,
};

test('keeps signed exposures tied to captured accounting, including complete broker totals with partial marks', () => {
  const metrics = { ...captured, valuationComplete: false };
  const original = JSON.stringify(metrics);
  expect(portfolioExposurePercentages(metrics)).toEqual({ gross: 200, long: 150, short: -50, net: 100 });
  expect(JSON.stringify(metrics)).toBe(original);
});

test.each([undefined, null, 0, -100000, NaN, Infinity, '100000'])('does not reconstruct missing or invalid captured NLV: %s', netLiquidation => {
  expect(portfolioExposurePercentages({ ...captured, netLiquidation })).toEqual({ gross: 200, long: null, short: null, net: 100 });
});

test('preserves captured zero and independently missing exposure fields', () => {
  expect(portfolioExposurePercentages({ ...captured, longMarketValue: 0, shortMarketValue: 0, grossLeverage: 0, netExposurePctOfNlv: 0 }))
    .toEqual({ gross: 0, long: 0, short: 0, net: 0 });
  expect(portfolioExposurePercentages({ ...captured, longMarketValue: null, grossLeverage: NaN, netExposurePctOfNlv: Infinity }))
    .toEqual({ gross: null, long: null, short: -50, net: null });
  expect(portfolioExposurePercentages()).toEqual({ gross: null, long: null, short: null, net: null });
});
