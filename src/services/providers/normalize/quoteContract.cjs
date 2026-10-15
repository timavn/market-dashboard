const { strictQuoteNumber, ibkrObservationFailure, MAX_AGE_MS, MAX_FUTURE_SKEW_MS } = require('./quoteObservation.cjs');
const { resolveInstrument } = require('../instruments/instrumentResolver');
const marketBackdropCatalog = require('../../../constants/marketBackdropCatalog.json');

const DAY_MS = 86_400_000;
const CRYPTO_SYMBOLS = new Set(marketBackdropCatalog
  .flatMap((group) => group.rows)
  .filter((row) => row.provider?.secType === 'CRYPTO')
  .flatMap((row) => [row.symbol, row.provider.yahooSymbol].filter(Boolean)));
const token = value => String(value || '').trim().toUpperCase();
const timestamp = value => {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const iso = value => value == null ? null : new Date(value).toISOString();
const conid = value => value == null ? null : (strictQuoteNumber(value) ?? NaN);

function quotePolicy(quote) {
  const source = quote?.source;
  if (typeof source !== 'string' || source !== source.toLowerCase()) return null;
  const type = String(quote?.dataType || '').toLowerCase();
  if (source === 'ibkr' && ['live', 'delayed'].includes(type)) {
    return { classification: type === 'live' ? 'live_quote' : 'delayed_reference', maxAgeMs: MAX_AGE_MS };
  }
  if (['yahoo', 'trading_economics'].includes(source) && type === 'delayed') {
    return { classification: 'delayed_reference', maxAgeMs: CRYPTO_SYMBOLS.has(token(quote.symbol)) ? 2 * 60 * 60_000 : 4 * DAY_MS };
  }
  if (['fred', 'stooq', 'bundesbank', 'japan_mof', 'bank_of_england'].includes(source) && type === 'historical') {
    // Dated observations have no live-use lifetime. They never become executable.
    return { classification: 'historical_reference', maxAgeMs: null };
  }
  return null;
}

function requestedIdentity(input) {
  const instrument = resolveInstrument(input);
  return {
    symbol: token(instrument.displaySymbol || instrument.symbol),
    providerSymbol: token(instrument.symbol),
    conid: conid(instrument.conid),
    secType: token(instrument.secType),
    currency: token(instrument.currency),
    exchange: token(instrument.exchange),
    contractMonth: String(instrument.lastTradeDateOrContractMonth || ''),
    tradingClass: String(instrument.tradingClass || ''),
    multiplier: String(instrument.multiplier || ''),
    provider: String(instrument.provider || 'auto'),
    yahooSymbol: String(instrument.yahooSymbol || ''),
  };
}
function observedIdentity(quote) {
  return {
    symbol: token(quote?.symbol),
    providerSymbol: token(quote?.providerSymbol || quote?.symbol),
    providerRootSymbol: token(quote?.providerRootSymbol || quote?.providerSymbol || quote?.symbol),
    contractMonth: String(quote?.lastTradeDateOrContractMonth || ''),
    tradingClass: String(quote?.tradingClass || ''),
    multiplier: String(quote?.multiplier || ''),
    conid: conid(quote?.conid ?? quote?.conId),
    secType: token(quote?.secType),
    currency: token(quote?.currency),
    exchange: token(quote?.exchange),
  };
}
function sameFields(left, right) {
  return left && right && Object.keys(right).every(key => left[key] === right[key]);
}
function failure(reason) { return { valid: false, rejectionReason: reason }; }

function validateQuoteObservation(quote, context = {}) {
  const now = context.now ?? Date.now();
  if (!Number.isFinite(now)) return failure('validation_time_invalid');
  const observation = quote?.observation;
  if (!observation || observation.version !== 1) return failure('observation_envelope_missing');
  const policy = quotePolicy(quote);
  if (!policy || observation.classification !== policy.classification || observation.source !== quote.source
      || observation.dataType !== quote.dataType || observation.entitlementStatus !== (quote.entitlementStatus ?? null)) return failure('observation_source_mismatch');
  if (!sameFields(observation.identity, observedIdentity(quote))) return failure('observation_identity_mismatch');
  const identity = observation.identity;
  if (!identity.symbol || !identity.secType || !identity.currency || !identity.exchange
      || (identity.conid !== null && (!Number.isSafeInteger(identity.conid) || identity.conid <= 0))) return failure('observation_identity_incomplete');
  if (!observation.requestedIdentity || !['symbol', 'providerSymbol', 'secType', 'currency', 'exchange', 'provider'].every(key => typeof observation.requestedIdentity[key] === 'string' && observation.requestedIdentity[key])) return failure('requested_identity_incomplete');
  if (context.instrument !== undefined && !sameFields(observation.requestedIdentity, requestedIdentity(context.instrument))) return failure('requested_identity_mismatch');
  const scope = context.scope || 'market';
  const accountId = context.accountId ?? null;
  if (observation.scope?.kind !== scope || observation.scope?.accountId !== accountId
      || (quote.accountId ?? null) !== accountId
      || (scope === 'market' && accountId !== null)
      || (scope === 'account' && (typeof accountId !== 'string' || !accountId))) return failure('observation_account_mismatch');
  if (!['market', 'account'].includes(scope)) return failure('observation_scope_invalid');
  const observed = timestamp(observation.observedAt);
  const received = timestamp(observation.receivedAt);
  if (observed === null || received === null || observed !== timestamp(quote.timestamp)
      || observation.observedAt !== quote.observedAt || observation.receivedAt !== quote.receivedAt) return failure('observation_timestamp_mismatch');
  if (received > now + MAX_FUTURE_SKEW_MS || observed > now + MAX_FUTURE_SKEW_MS || observed > received + MAX_FUTURE_SKEW_MS) return failure('observation_receipt_invalid');
  const expectedExpiry = policy.maxAgeMs === null ? null : iso(observed + policy.maxAgeMs);
  if (observation.expiresAt !== expectedExpiry || quote.expiresAt !== expectedExpiry) return failure('observation_expiry_mismatch');
  if (expectedExpiry !== null && now > timestamp(expectedExpiry)) return failure('observation_expired');
  if (quote.source === 'ibkr') {
    if (!Number.isSafeInteger(observation.connectionGeneration) || observation.connectionGeneration < 0
        || quote.connectionGeneration !== observation.connectionGeneration) return failure('observation_generation_missing');
    if (context.connectionGeneration !== undefined && context.connectionGeneration !== observation.connectionGeneration) return failure('observation_generation_mismatch');
    if (context.connected === false) return failure('provider_disconnected');
    const rawFailure = ibkrObservationFailure(quote, { now });
    if (rawFailure) return failure(rawFailure);
    const expected = observation.requestedIdentity;
    if (!expected || expected.symbol !== identity.symbol
        || expected.providerSymbol !== identity.providerRootSymbol
        || (expected.contractMonth && !(expected.contractMonth.length === 6 ? identity.contractMonth.startsWith(expected.contractMonth) : expected.contractMonth === identity.contractMonth))
        || (expected.tradingClass && expected.tradingClass !== identity.tradingClass)
        || (expected.multiplier && expected.multiplier !== identity.multiplier)
        || (expected.conid != null && expected.conid !== identity.conid)
        || expected.currency !== identity.currency
        || !(expected.secType === identity.secType || (expected.secType === 'STK' && identity.secType === 'ETF'))
        || (expected.conid == null && expected.exchange !== identity.exchange)) return failure('provider_identity_mismatch');
  } else if (observation.connectionGeneration !== null) return failure('reference_generation_invalid');
  if (['mock', 'seeded', 'synthetic', 'cacheOnly', 'cachedOnly'].some(key => quote[key] === true)) return failure('unverified_observation');
  if (observation.valid !== true || observation.rejectionReason !== null) return failure(observation.rejectionReason || 'observation_rejected');
  const mark = quote.mark ?? quote.price ?? quote.last;
  const price = strictQuoteNumber(mark);
  if (price === null || quote.valid === false || (quote.source === 'ibkr' && price <= 0)) return failure('invalid_mark');
  return { valid: true, rejectionReason: null };
}

function withQuoteObservation(quote, { instrument, receivedAt = Date.now(), connectionGeneration = null, scope = 'market', accountId = null, ...context } = {}) {
  if (!quote || typeof quote !== 'object') return null;
  // Reusing an envelope can never rewrite its receipt or original lifetime.
  if (quote.observation) return quote;
  const requested = requestedIdentity(instrument ?? quote.symbol);
  const result = {
    ...quote,
    // Broker responses must carry their own qualified contract identity.
    // Reference providers may describe a requested series rather than an IBKR contract.
    secType: quote.secType || (quote.source === 'ibkr' ? null : requested.secType),
    currency: quote.currency || (quote.source === 'ibkr' ? null : requested.currency),
    exchange: quote.exchange || (quote.source === 'ibkr' ? null : requested.exchange),
    accountId: quote.accountId ?? accountId,
    connectionGeneration: quote.source === 'ibkr' ? connectionGeneration : null,
  };
  const policy = quotePolicy(result);
  const observed = timestamp(result.timestamp);
  const receipt = typeof receivedAt === 'number' ? receivedAt : timestamp(receivedAt);
  const envelope = {
    version: 1,
    source: result.source,
    dataType: result.dataType,
    entitlementStatus: result.entitlementStatus ?? null,
    classification: policy?.classification || 'unavailable',
    observedAt: iso(observed),
    receivedAt: iso(Number.isFinite(receipt) ? receipt : null),
    expiresAt: observed !== null && policy?.maxAgeMs != null ? iso(observed + policy.maxAgeMs) : null,
    identity: Object.freeze(observedIdentity(result)),
    requestedIdentity: Object.freeze(requested),
    scope: Object.freeze({ kind: scope, accountId }),
    connectionGeneration: result.connectionGeneration,
    valid: true,
    rejectionReason: null,
  };
  Object.assign(result, { observedAt: envelope.observedAt, receivedAt: envelope.receivedAt, expiresAt: envelope.expiresAt, observation: envelope });
  const validation = validateQuoteObservation(result, { ...context, instrument: instrument ?? quote.symbol, scope, accountId, connectionGeneration, now: context.now ?? receipt });
  envelope.valid = validation.valid;
  envelope.rejectionReason = validation.rejectionReason;
  Object.freeze(envelope);
  if (!validation.valid) result.valid = false;
  return result;
}

module.exports = { withQuoteObservation, validateQuoteObservation, quotePolicy, requestedIdentity };
