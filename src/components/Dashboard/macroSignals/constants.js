/** Default tab (aggregate macro view) */
export const DEFAULT_ASSET_CLASS = 'MACRO';

export const MACRO_ASSET_TABS = [
  { assetClass: 'MACRO', title: 'Macro', group: 'Macro' },
  { assetClass: 'EQ', title: 'Equities', group: 'Index' },
  { assetClass: 'FI', title: 'Fixed Income', group: 'Rates' },
  { assetClass: 'FX', title: 'FX', group: 'FX' },
  { assetClass: 'CMD', title: 'Commodities', group: 'Commodities' },
  { assetClass: 'CRPT', title: 'Crypto', group: 'Crypto' },
];

export const BROAD_MACRO_SIGNAL_SYMBOLS = [
  'UST2Y',
  'UST10Y',
  'UST30Y',
  'DXY',
  'USD',
  'VIX',
  'GOLD',
  'GLD',
  'WTIC',
  'WTI',
  'BRENT',
  'COPPER',
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
