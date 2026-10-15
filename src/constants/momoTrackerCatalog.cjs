// The dashboard uses GOOGL as its displayed Alphabet share class.
const MOMO_EXCLUDED_TICKERS = Object.freeze(['GOOG']);

// Company aliases prevent a second listed share class occupying another rank.
// These are identity choices only; share-class index weights are never combined.
const MOMO_COMPANY_SHARE_CLASSES = Object.freeze([
  Object.freeze({ ticker: 'GOOGL', aliases: Object.freeze(['GOOGL', 'GOOG']) }),
  Object.freeze({ ticker: 'BRK.B', aliases: Object.freeze(['BRK.B', 'BRK/B', 'BRK-B', 'BRK.A', 'BRK/A', 'BRK-A']) }),
  Object.freeze({ ticker: 'FOXA', aliases: Object.freeze(['FOXA', 'FOX']) }),
  Object.freeze({ ticker: 'NWSA', aliases: Object.freeze(['NWSA', 'NWS']) }),
  Object.freeze({ ticker: 'BF.B', aliases: Object.freeze(['BF.B', 'BF/B', 'BF-B', 'BF.A', 'BF/A', 'BF-A']) }),
]);

function canonicalMomoCompanyTicker(ticker) {
  const symbol = String(ticker || '').trim().toUpperCase();
  return MOMO_COMPANY_SHARE_CLASSES.find(entry => entry.aliases.includes(symbol))?.ticker || symbol;
}

module.exports = { MOMO_EXCLUDED_TICKERS, MOMO_COMPANY_SHARE_CLASSES, canonicalMomoCompanyTicker };
