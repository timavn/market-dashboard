const SUPPORTED_EQUITY_TYPES = new Set(['STK', 'ETF']);
const SUPPORTED_IBKR_TYPES = new Set([...SUPPORTED_EQUITY_TYPES, 'IND', 'FUT', 'CMDTY']);

const IBKR_CASH_INDEX_OVERRIDES = Object.freeze({
  SPX: Object.freeze({ secType: 'IND', exchange: 'CBOE' }),
});

function normalizeProvider(provider) {
  const normalized = String(provider || 'auto').trim().toLowerCase();
  return normalized || 'auto';
}

/**
 * Resolve user symbol or instrument descriptor for market data providers.
 * @param {string|object} input - ticker string or a provider-aware instrument descriptor
 * @returns {{ symbol: string, displaySymbol?: string, conid?: number, secType: string, exchange: string, currency: string, provider: string, providerSymbol?: string, ibkrSymbol?: string, yahooSymbol?: string, supported: boolean, reason?: string }}
 */
function resolveInstrument(input) {
  if (input == null) {
    return {
      symbol: '',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      provider: 'auto',
      supported: false,
      reason: 'empty_input',
    };
  }

  if (typeof input === 'object') {
    const secType = (input.secType || 'STK').toUpperCase();
    const provider = normalizeProvider(input.provider);
    const displaySymbol = String(input.symbol || '').toUpperCase();
    const providerSymbol = String(input.providerSymbol || '').trim() || undefined;
    const ibkrSymbol = String(
      input.ibkrSymbol
        || (provider === 'ibkr' ? providerSymbol : '')
        || displaySymbol,
    ).toUpperCase();
    const yahooSymbol = String(
      input.yahooSymbol
        || (provider === 'yahoo' ? providerSymbol : '')
        || '',
    ).trim() || undefined;
    const contractMonth = String(input.lastTradeDateOrContractMonth || input.contractMonth || '').trim();
    const exactFuture = secType !== 'FUT' || input.conId != null || input.conid != null || /^\d{6,8}$/.test(contractMonth);
    const supportedByIbkr = SUPPORTED_IBKR_TYPES.has(secType) &&
      (provider === 'auto' || provider === 'ibkr') &&
      exactFuture;
    if (secType === 'FORECAST' || secType === 'EVENT' || input.venue === 'ForecastEx') {
      return {
        symbol: displaySymbol,
        displaySymbol,
        conid: input.conId ?? input.conid,
        secType,
        exchange: input.exchange || 'FORECASTX',
        currency: input.currency || 'USD',
        provider,
        providerSymbol,
        ibkrSymbol: input.ibkrSymbol || undefined,
        yahooSymbol,
        supported: false,
        reason: 'forecast_event_todo',
      };
    }
    return {
      symbol: ibkrSymbol,
      displaySymbol,
      conid: input.conId ?? input.conid,
      secType,
      exchange: input.exchange || 'SMART',
      currency: input.currency || 'USD',
      provider,
      providerSymbol,
      ibkrSymbol: input.ibkrSymbol || undefined,
      yahooSymbol,
      lastTradeDateOrContractMonth: contractMonth || undefined,
      tradingClass: input.tradingClass || undefined,
      multiplier: input.multiplier || undefined,
      supported: supportedByIbkr,
      reason: supportedByIbkr
        ? undefined
        : provider !== 'auto' && provider !== 'ibkr'
          ? `${provider}_only`
          : secType === 'FUT' && !exactFuture
            ? 'futures_contract_identity_required'
          : `unsupported_sec_type:${secType}`,
    };
  }

  const symbol = String(input).trim().toUpperCase();
  if (!symbol) {
    return {
      symbol: '',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      provider: 'auto',
      supported: false,
      reason: 'empty_symbol',
    };
  }

  const cashIndex = IBKR_CASH_INDEX_OVERRIDES[symbol];
  return {
    symbol,
    secType: cashIndex?.secType || 'STK',
    exchange: cashIndex?.exchange || 'SMART',
    currency: 'USD',
    provider: 'auto',
    supported: true,
  };
}

/**
 * Stable identity for quote caches. A bare symbol is not sufficient because
 * the same text can identify an equity, index, future, FX pair, or crypto
 * instrument at different providers.
 */
function instrumentCacheKey(input) {
  const instrument = resolveInstrument(input);
  return [
    instrument.provider,
    instrument.secType,
    instrument.conid != null ? `conid:${instrument.conid}` : `symbol:${instrument.symbol}`,
    instrument.exchange,
    instrument.currency,
    instrument.lastTradeDateOrContractMonth || '',
    instrument.tradingClass || '',
    instrument.multiplier || '',
    instrument.providerSymbol || '',
    instrument.yahooSymbol || '',
  ].join('|');
}

/**
 * The stream bridge is symbol-keyed, so only the default SMART/USD equity
 * identity can safely consume it. Contract-specific and non-equity
 * descriptors must go through their explicit provider route.
 */
function canUseSymbolStream(input) {
  const instrument = resolveInstrument(input);
  return Boolean(
    instrument.supported
      && SUPPORTED_EQUITY_TYPES.has(instrument.secType)
      && instrument.conid == null
      && instrument.exchange === 'SMART'
      && instrument.currency === 'USD'
      && (instrument.provider === 'auto' || instrument.provider === 'ibkr')
  );
}

module.exports = {
  resolveInstrument,
  instrumentCacheKey,
  canUseSymbolStream,
  SUPPORTED_EQUITY_TYPES,
  SUPPORTED_IBKR_TYPES,
};
