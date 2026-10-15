const { isPredictionMarketContract } = require('../providers/normalize/normalizePosition');

const EQUITY_TYPES = new Set(['STK', 'STOCK', 'EQUITY', 'ETF', 'ETP']);
const PREDICTION_VENUES = new Set(['FORECASTX', 'FORECASTEX', 'KALSHI']);
const NON_EQUITY_TYPES = new Set([
  'OPT', 'OPTION', 'OPTIONS', 'FOP', 'FUT', 'FUTURE', 'FUTURES', 'CONTFUT', 'FUT+CONTFUT',
  'CASH', 'FX', 'FOREX', 'BOND', 'BILL', 'IND', 'INDEX', 'CFD', 'WAR', 'WARRANT',
  'IOPT', 'BAG', 'CMDTY', 'COMMODITY', 'FUND', 'MUTUAL_FUND', 'MFUND', 'CRYPTO', 'FWD', 'SWAP',
]);
const normalized = value => String(value || '').trim().toUpperCase();

function pcaOutOfScopeReason(holding = {}) {
  const type = normalized(holding.secType || holding.securityType || holding.assetType);
  const venues = [holding.exchange, holding.primaryExchange, holding.venue].map(normalized);
  if (holding.isPredictionMarket === true || type === 'EVENT'
    || venues.some(venue => PREDICTION_VENUES.has(venue))) return 'prediction_contract';

  // Verified equity types take precedence over broad product-code patterns:
  // KXI is an ETF, and descriptions can legitimately contain "yes" or "no".
  if (EQUITY_TYPES.has(type)) return null;

  // Broker-native contract identities remain useful when a venue is omitted.
  // Free-form descriptions are deliberately not used as contract evidence.
  const identity = [holding.symbol, holding.localSymbol, holding.tradingClass, holding.contractMonth]
    .map(normalized).join(' ');
  const contractIdentity = /(?:^|\s)KX[A-Z0-9]+[-_]\d/.test(identity)
    || /\bCPIY\b/.test(identity)
    || (/\d/.test(identity) && /[-_ ](?:YES|NO)(?:$|[-_ ])/.test(identity));
  if (contractIdentity && isPredictionMarketContract({
    secType: type,
    symbol: holding.symbol,
    localSymbol: holding.localSymbol,
    tradingClass: holding.tradingClass,
    contractMonth: holding.contractMonth,
  })) return 'prediction_contract';

  return NON_EQUITY_TYPES.has(type) ? 'non_equity_instrument' : null;
}

function scopeCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object') return coverage;
  const excluded = [];
  const migrated = [];
  for (const row of coverage.excluded || []) {
    const reason = row.reason === 'prediction_contract_unmodeled'
      ? 'prediction_contract'
      : row.reason === 'unsupported_instrument' ? pcaOutOfScopeReason(row) : null;
    if (reason) migrated.push({ ...row, reason });
    else excluded.push({ ...row });
  }
  const outOfScope = [...new Map([...(coverage.outOfScope || []), ...migrated]
    .map(row => [`${row.id || row.symbol || ''}:${row.reason}`, { ...row }])).values()];
  const holdingCount = Number.isInteger(coverage.holdingCount)
    ? Math.max(0, coverage.holdingCount - migrated.length) : coverage.holdingCount;
  const complete = excluded.length === 0 && Number.isInteger(holdingCount)
    && Number.isInteger(coverage.modeledCount)
    ? coverage.modeledCount === holdingCount : coverage.complete === true && excluded.length === 0;
  const result = { ...coverage, scope: 'equities-etfs', holdingCount, excluded, outOfScope, complete };
  // Legacy gross totals cannot be separated into eligible and out-of-scope
  // securities without their original verified individual weights.
  if (migrated.length) delete result.totalGrossWeight;
  return result;
}

module.exports = { pcaOutOfScopeReason, scopeCoverage };
