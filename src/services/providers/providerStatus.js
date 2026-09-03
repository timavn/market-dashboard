const state = {
  ibkr: {
    connected: false,
    lastQuoteAt: null,
    lastQuoteAvailability: null,
    lastPortfolioAt: null,
    message: null,
    streamMode: 'offline',
    streamMessage: null,
  },
  market: {
    lastSource: null,
    lastWarning: null,
    // This is the time the provider returned a valid quote to the dashboard,
    // not the quote's own market timestamp. It lets readiness distinguish a
    // fresh delayed provider response from an unverified/expired cache.
    lastQuoteAt: null,
    lastError: null,
    lastErrorAt: null,
  },
  portfolio: {
    dataSource: null,
    lastWarning: null,
  },
};

function setIbkrConnected(connected, message = null) {
  state.ibkr.connected = connected;
  state.ibkr.message = message;
  if (!connected) {
    // A reconnecting socket must not inherit a still-fresh heartbeat from the
    // previous connection generation until a new provider tick arrives.
    state.ibkr.lastQuoteAvailability = null;
  }
}

function setIbkrLastQuoteAt(iso, availability = 'current') {
  state.ibkr.lastQuoteAt = iso;
  const normalizedAvailability = String(availability || '').trim().toLowerCase();
  if (['current', 'delayed'].includes(normalizedAvailability)) {
    state.ibkr.lastQuoteAvailability = normalizedAvailability;
  }
}

function setIbkrLastPortfolioAt(iso) {
  state.ibkr.lastPortfolioAt = iso;
}

function setIbkrStreamMeta(mode, message = null) {
  state.ibkr.streamMode = mode;
  state.ibkr.streamMessage = message;
}

function setMarketMeta(source, warning, observedAt = null) {
  const normalizedSource = String(source || '').trim().toLowerCase();
  const isSuccessfulMarketQuote = Boolean(
    observedAt && ['ibkr', 'yahoo'].includes(normalizedSource),
  );

  if (isSuccessfulMarketQuote) {
    state.market.lastSource = normalizedSource;
    state.market.lastWarning = warning || null;
    state.market.lastQuoteAt = observedAt;
    state.market.lastError = null;
    state.market.lastErrorAt = null;
    return;
  }

  // Failed/unsupported requests must not overwrite the last verified market
  // source. Otherwise a historical FRED/Stooq request or one empty IBKR tick
  // can make a still-valid market observation disappear from SYS.
  state.market.lastError = warning || 'no_quote_available';
  state.market.lastErrorAt = new Date().toISOString();
}

function setPortfolioMeta(dataSource, warning) {
  state.portfolio.dataSource = dataSource;
  state.portfolio.lastWarning = warning;
}

function getProviderStatusSnapshot() {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  setIbkrConnected,
  setIbkrLastQuoteAt,
  setIbkrLastPortfolioAt,
  setIbkrStreamMeta,
  setMarketMeta,
  setPortfolioMeta,
  getProviderStatusSnapshot,
};
