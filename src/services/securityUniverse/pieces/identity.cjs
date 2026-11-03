'use strict';

const { SEC_NAME_SOURCE, YAHOO_NAME_SOURCE, normalizeSecurityName } = require('../../exposureLabSecurityIdentity.cjs');
const { securityDisplayName, continuousInstrumentName } = require('../../../utils/securityDisplayName.cjs');
const { available, flagged, unavailable, withStatus } = require('../fields.cjs');

const VERIFIED_NAME_SOURCES = new Set([SEC_NAME_SOURCE, YAHOO_NAME_SOURCE]);
const LISTED_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
const FUND_TYPES = new Set(['ETF', 'MUTUALFUND']);
const LOOKUP_CONCURRENCY = 8;

const failedStatus = value => ['unavailable', 'failed', 'error', 'offline', 'disconnected', 'mock', 'seeded'].includes(value?.status);
const invalid = value => flagged(value) || failedStatus(value);
// A listed share class trades on Yahoo with a hyphen (BRK.B → BRK-B).
const listingSymbolOf = symbol => (/^[A-Z]{1,5}\.[AB]$/.test(symbol) ? symbol.replace('.', '-') : symbol);
const defaultInstrument = symbol => ({ yahooSymbol: listingSymbolOf(symbol), listingSymbol: listingSymbolOf(symbol) });

function emptyIdentity(reason) {
  return withStatus({ name: unavailable(reason), displayName: unavailable(reason), instrumentType: unavailable(reason),
    exchange: unavailable(reason), priced: null });
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  for (let offset = 0; offset < values.length; offset += limit) {
    const slice = values.slice(offset, offset + limit);
    (await Promise.all(slice.map(mapper))).forEach((value, index) => { results[offset + index] = value; });
  }
  return results;
}

// Who a ticker is. `name` is the listed security this exact ticker trades as,
// with the precedence /api/security-identities has always used: the SEC ticker
// directory, Yahoo for tickers SEC does not list, and an exact ETF or fund name
// over a SEC trust registrant. `displayName` is the same security as people read
// it. `priced` is set only when the dashboard prices a different instrument
// under this ticker (BTC → BTC-USD, GOLD → GC=F), so no reader mistakes one for
// the other.
function createIdentityPiece({ resolver, resolveInstrument = defaultInstrument } = {}) {
  if (!resolver || typeof resolver.resolve !== 'function') throw new Error('resolver.resolve is required');

  async function exactYahoo(lookupSymbol, types) {
    if (typeof resolver.loadYahooIdentity !== 'function' || !lookupSymbol) return null;
    try {
      const result = await resolver.loadYahooIdentity(lookupSymbol, { exactTicker: true });
      const identity = result?.identity;
      if (result?.status !== 'available' || invalid(result) || invalid(identity) || identity?.ticker !== lookupSymbol
        || identity?.nameSource !== YAHOO_NAME_SOURCE || !types.has(identity?.instrumentType)) return null;
      const name = normalizeSecurityName(identity.name, lookupSymbol);
      return name ? { name, instrumentType: identity.instrumentType, exchange: identity.exchange || null, fetchedAt: result.fetchedAt || null } : null;
    } catch {
      return null;
    }
  }

  // The cached alias lookup that named a ticker SEC does not list, for its date and type.
  async function aliasYahoo(ticker) {
    if (typeof resolver.loadYahooIdentity !== 'function') return null;
    try {
      const result = await resolver.loadYahooIdentity(ticker);
      return result?.status === 'available' && !invalid(result) && !invalid(result.identity) ? result : null;
    } catch {
      return null;
    }
  }

  async function priced(symbol, row) {
    const instrument = resolveInstrument(symbol);
    if (!instrument?.yahooSymbol || instrument.yahooSymbol === instrument.listingSymbol || row?.yahooSymbol === instrument.yahooSymbol) return null;
    const identity = await exactYahoo(instrument.yahooSymbol, new Set(['CRYPTOCURRENCY', 'CURRENCY', 'FUTURE', 'INDEX', 'EQUITY', 'ETF', 'MUTUALFUND']));
    const name = identity && continuousInstrumentName(identity.name);
    return name
      ? available({ name, yahooSymbol: instrument.yahooSymbol, instrumentType: identity.instrumentType },
        { source: YAHOO_NAME_SOURCE, asOf: identity.fetchedAt, match: 'different-instrument' })
      : unavailable('priced-instrument-unverified', { yahooSymbol: instrument.yahooSymbol, match: 'different-instrument' });
  }

  async function identify(symbol, row, secAsOf) {
    const pricedField = await priced(symbol, row);
    if (!row) return { ...emptyIdentity('no-verified-provider-identity'), priced: pricedField };
    const listingSymbol = (resolveInstrument(symbol) || defaultInstrument(symbol)).listingSymbol;
    if (row.nameSource === SEC_NAME_SOURCE) {
      const listing = await exactYahoo(listingSymbol, LISTED_TYPES);
      const fund = listing && FUND_TYPES.has(listing.instrumentType) && /\b(?:trust|funds?)\b/i.test(row.name);
      return withStatus({
        name: fund ? available(listing.name, { source: YAHOO_NAME_SOURCE, asOf: listing.fetchedAt, nameVerified: true })
          : available(row.name, { source: SEC_NAME_SOURCE, asOf: secAsOf, nameVerified: true, cik: row.cik ?? null }),
        displayName: listing ? available(listing.name, { source: YAHOO_NAME_SOURCE, asOf: listing.fetchedAt })
          : available(securityDisplayName(row.name), { source: SEC_NAME_SOURCE, asOf: secAsOf, recased: true }),
        instrumentType: listing ? available(listing.instrumentType, { source: YAHOO_NAME_SOURCE, asOf: listing.fetchedAt })
          : unavailable('listing-instrument-type-unverified', { source: YAHOO_NAME_SOURCE }),
        exchange: listing?.exchange ? available(listing.exchange, { source: YAHOO_NAME_SOURCE, asOf: listing.fetchedAt })
          : row.exchange ? available(row.exchange, { source: SEC_NAME_SOURCE, asOf: secAsOf }) : unavailable('exchange-unverified'),
        priced: pricedField,
      });
    }
    const alias = await aliasYahoo(row.ticker);
    const asOf = alias?.fetchedAt || null;
    const type = alias?.identity?.instrumentType || row.providerInstrumentType || null;
    const exchange = alias?.identity?.exchange || row.exchange || null;
    return withStatus({
      name: available(row.name, { source: YAHOO_NAME_SOURCE, asOf, nameVerified: true }),
      displayName: available(row.name, { source: YAHOO_NAME_SOURCE, asOf }),
      instrumentType: type ? available(type, { source: YAHOO_NAME_SOURCE, asOf }) : unavailable('listing-instrument-type-unverified'),
      exchange: exchange ? available(exchange, { source: YAHOO_NAME_SOURCE, asOf }) : unavailable('exchange-unverified'),
      priced: pricedField,
    });
  }

  async function loadMany(symbols) {
    const fail = reason => new Map(symbols.map(symbol => [symbol, emptyIdentity(reason)]));
    let resolved;
    try {
      // Exact requested tickers, independent of the research archive's discovery roster.
      resolved = await resolver.resolve({ rows: symbols.map(ticker => ({
        ticker, discoveryState: 'structured', confidenceKinds: ['structured_list'], existingUniverse: false,
      })) });
    } catch {
      return fail('identity-directory-unavailable');
    }
    if (invalid(resolved) || invalid(resolved?.identityDirectory)) return fail('identity-directory-unavailable');
    const secAsOf = resolved.identityDirectory?.sources?.sec?.fetchedAt || null;
    const rows = new Map();
    for (const row of Array.isArray(resolved?.rows) ? resolved.rows : []) {
      if (!symbols.includes(row?.ticker) || rows.has(row.ticker) || invalid(row)
        || row.nameVerified !== true || !VERIFIED_NAME_SOURCES.has(row.nameSource)) continue;
      const name = normalizeSecurityName(row.name, row.ticker, { allowTickerName: row.nameSource === SEC_NAME_SOURCE });
      if (name) rows.set(row.ticker, { ...row, name });
    }
    const identities = await mapLimit(symbols, LOOKUP_CONCURRENCY, symbol => identify(symbol, rows.get(symbol), secAsOf));
    return new Map(symbols.map((symbol, index) => [symbol, identities[index]]));
  }

  return { loadMany, empty: emptyIdentity };
}

module.exports = { createIdentityPiece, emptyIdentity, listingSymbolOf };
