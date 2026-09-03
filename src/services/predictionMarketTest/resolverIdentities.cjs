'use strict';

const PYTH_RESOLVER_IDENTITIES = Object.freeze({
  gold: Object.freeze({
    symbol: 'Metal.Index.GOLD/USD',
    label: 'GOLD',
    assetType: 'metal',
    assetPattern: /\bgold\b/i,
    riskRangeTicker: 'GLD',
  }),
  silver: Object.freeze({
    symbol: 'Metal.Index.SILVER/USD',
    label: 'SILVER',
    assetType: 'metal',
    assetPattern: /\bsilver\b/i,
    riskRangeTicker: 'SILVER',
  }),
  brent: Object.freeze({
    symbol: 'Commodities.Index.BRENT/USD',
    label: 'BRENT',
    assetType: 'commodity',
    assetPattern: /\bbrent(?:\s+crude\s+oil)?\b/i,
    riskRangeTicker: 'BRENT',
  }),
});

const PYTH_AUTHORITATIVE_HOSTS = Object.freeze([
  'app.pyth.com',
  'pyth.com',
  'pythdata.app',
  'pyth.network',
]);

const FORECAST_COMMODITY_PRODUCTS = Object.freeze({
  METLG: Object.freeze({
    marketId: 'gold',
    assetLabel: 'Gold',
    productInstrument: 'COMEX Gold Futures',
    symbolPattern: /^GC[FGHJKMNQUVXZ]\d{2}$/,
    sourceName: 'COMEX',
  }),
  METLS: Object.freeze({
    marketId: 'silver',
    assetLabel: 'Silver',
    productInstrument: 'COMEX Silver Futures',
    symbolPattern: /^SI[FGHJKMNQUVXZ]\d{2}$/,
    sourceName: 'COMEX',
  }),
});

function pythExplorerSymbol(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/explore\/([^/]+)$/i);
    if (!match) return null;
    const symbol = decodeURIComponent(match[1]).trim();
    return /^(?:Metal|Commodities)\.[A-Za-z0-9_.-]+\/USD$/.test(symbol) ? symbol : null;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  FORECAST_COMMODITY_PRODUCTS,
  PYTH_AUTHORITATIVE_HOSTS,
  PYTH_RESOLVER_IDENTITIES,
  pythExplorerSymbol,
};
