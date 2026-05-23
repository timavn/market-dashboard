const state = {
  ibkr: {
    connected: false,
    lastQuoteAt: null,
    lastPortfolioAt: null,
    message: null,
    streamMode: 'offline',
    streamMessage: null,
  },
  market: {
    lastSource: null,
    lastWarning: null,
  },
  portfolio: {
    dataSource: null,
    lastWarning: null,
  },
};

function setIbkrConnected(connected, message = null) {
  state.ibkr.connected = connected;
  state.ibkr.message = message;
}

function setIbkrLastQuoteAt(iso) {
  state.ibkr.lastQuoteAt = iso;
}

function setIbkrLastPortfolioAt(iso) {
  state.ibkr.lastPortfolioAt = iso;
}

function setIbkrStreamMeta(mode, message = null) {
  state.ibkr.streamMode = mode;
  state.ibkr.streamMessage = message;
}

function setMarketMeta(source, warning) {
  state.market.lastSource = source;
  state.market.lastWarning = warning;
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
