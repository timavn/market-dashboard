'use strict';

const SECURITY_SYMBOL = /^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/;

// Exact requested tickers for per-security reads: comma separated, upper-cased,
// de-duplicated, at most `max`. Anything malformed rejects the whole request
// (null) so a caller never mistakes a dropped ticker for a missing fact.
function requestedSecuritySymbols(value, { max = 50 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max * 33) return null;
  const symbols = value.split(',').map(symbol => symbol.trim().toUpperCase());
  if (symbols.length > max || symbols.some(symbol => !SECURITY_SYMBOL.test(symbol))) return null;
  return [...new Set(symbols)];
}

module.exports = { SECURITY_SYMBOL, requestedSecuritySymbols };
