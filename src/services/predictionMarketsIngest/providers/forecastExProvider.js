const { fetchIBKREvents } = require('./ibkrProvider');
const { setProviderStatus } = require('../cache');

/**
 * ForecastEx has no public API — all contracts via IBKR FORECASTX exchange.
 */
async function fetchForecastExEvents(options = {}) {
  if (process.env.IBKR_INGEST_ENABLED === 'false') {
    setProviderStatus('forecastex', { status: 'unknown', message: 'IBKR disabled' });
    return [];
  }
  const all = await fetchIBKREvents(options);
  return all.filter((e) => e.venue === 'ForecastEx');
}

module.exports = { fetchForecastExEvents };
