import { computeRiskRangePercents } from '../../../utils/riskRangePercents';

/** @typedef {'EQ'|'FI'|'FX'|'CMD'|'CRPT'} MacroAssetClass */

function mockRangePercents(forecastLow, forecastHigh, spotPrice) {
  const p = computeRiskRangePercents(spotPrice, forecastLow, forecastHigh);
  return {
    upsidePct: p?.upsidePct ?? null,
    downsidePct: p?.downsidePct ?? null,
    referencePrice: spotPrice,
  };
}

/** Default tab (Equities / Index group) */
export const DEFAULT_ASSET_CLASS = 'EQ';

export const MACRO_ASSET_TABS = [
  { assetClass: 'EQ', title: 'Equities', group: 'Index' },
  { assetClass: 'FI', title: 'Fixed Income', group: 'Rates' },
  { assetClass: 'FX', title: 'FX', group: 'FX' },
  { assetClass: 'CMD', title: 'Commodities', group: 'Commodities' },
  { assetClass: 'CRPT', title: 'Crypto', group: 'Crypto' },
];

/** Map Hedgeye / universe `group` to segmented tab key */
export const GROUP_TO_ASSET_CLASS = {
  Index: 'EQ',
  Equity: 'EQ',
  Rates: 'FI',
  Credit: 'FI',
  FX: 'FX',
  Commodities: 'CMD',
  Crypto: 'CRPT',
};

/**
 * Mock signals for QA — include minimal `canonical` rows so Prediction Markets selection still works.
 * @type {Array<import('./mapNormalizedRow').MacroSignalView>}
 */
export const DEFAULT_MOCK_SIGNALS = [
  {
    id: 'compq',
    ticker: 'COMPQ',
    name: 'NASDAQ Composite',
    assetClass: 'EQ',
    side: 'long',
    trade: 'Buy',
    trend: 'bull',
    tail: null,
    forecastLow: 23014,
    forecastHigh: 23926,
    spotPrice: 23652.18,
    ...mockRangePercents(23014, 23926, 23652.18),
    score: 95,
    canonical: {
      symbol: 'COMPQ',
      label: 'NASDAQ Composite',
      group: 'Index',
      trend: 'LONG',
      trackerTrend: 'BULLISH',
      riskTrend: 'BULLISH',
      macroSide: null,
      callSide: null,
      lrr: 23014,
      hrr: 23926,
      price: 23652.18,
      score: 95,
    },
  },
  {
    id: 'spx',
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'EQ',
    side: 'long',
    trade: 'Buy',
    trend: 'bull',
    tail: null,
    forecastLow: 6834,
    forecastHigh: 7026,
    spotPrice: 6928.41,
    ...mockRangePercents(6834, 7026, 6928.41),
    score: 92,
    canonical: {
      symbol: 'SPX',
      label: 'S&P 500',
      group: 'Index',
      trend: 'LONG',
      trackerTrend: 'BULLISH',
      riskTrend: 'BULLISH',
      macroSide: null,
      callSide: null,
      lrr: 6834,
      hrr: 7026,
      price: 6928.41,
      score: 92,
    },
  },
  {
    id: 'vix',
    ticker: 'VIX',
    name: 'CBOE Volatility Index',
    assetClass: 'EQ',
    side: 'short',
    trade: 'Sell',
    trend: 'bear',
    tail: null,
    forecastLow: 13.48,
    forecastHigh: 19.1,
    spotPrice: 14.92,
    ...mockRangePercents(13.48, 19.1, 14.92),
    score: 89,
    canonical: {
      symbol: 'VIX',
      label: 'CBOE Volatility Index',
      group: 'Index',
      trend: 'SHORT',
      trackerTrend: 'BEARISH',
      riskTrend: 'BEARISH',
      macroSide: null,
      callSide: null,
      lrr: 13.48,
      hrr: 19.1,
      price: 14.92,
      score: 89,
    },
  },
];
