const SUPPORTED_EQUITY_TYPES = new Set(['STK', 'ETF']);

/**
 * Resolve user symbol or instrument descriptor for market data providers.
 * @param {string|object} input - ticker string or { symbol, conId, secType, exchange }
 * @returns {{ symbol: string, conid?: number, secType: string, exchange: string, currency: string, supported: boolean, reason?: string }}
 */
function resolveInstrument(input) {
  if (input == null) {
    return {
      symbol: '',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      supported: false,
      reason: 'empty_input',
    };
  }

  if (typeof input === 'object') {
    const secType = (input.secType || 'STK').toUpperCase();
    if (secType === 'FORECAST' || secType === 'EVENT' || input.venue === 'ForecastEx') {
      return {
        symbol: input.symbol || '',
        conid: input.conId ?? input.conid,
        secType,
        exchange: input.exchange || 'FORECASTX',
        currency: input.currency || 'USD',
        supported: false,
        reason: 'forecast_event_todo',
      };
    }
    return {
      symbol: String(input.symbol || '').toUpperCase(),
      conid: input.conId ?? input.conid,
      secType,
      exchange: input.exchange || 'SMART',
      currency: input.currency || 'USD',
      supported: SUPPORTED_EQUITY_TYPES.has(secType) || secType === 'STK',
    };
  }

  const symbol = String(input).trim().toUpperCase();
  if (!symbol) {
    return {
      symbol: '',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      supported: false,
      reason: 'empty_symbol',
    };
  }

  return {
    symbol,
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    supported: true,
  };
}

module.exports = { resolveInstrument, SUPPORTED_EQUITY_TYPES };
