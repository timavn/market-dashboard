const { fetchIBKREvents } = require('./ibkrProvider');
const { setProviderStatus } = require('../cache');

/**
 * CME event contracts: primary path IBKR (tradingClass EC*).
 * Direct CME Reference Data API requires commercial credentials — see README in this folder.
 */
async function fetchCMEEvents(options = {}) {
  const directEnabled = process.env.CME_DIRECT_API_ENABLED === 'true';
  if (directEnabled) {
    console.warn(
      '[CME] CME_DIRECT_API_ENABLED is set but direct client is not implemented. ' +
        'Replace fetchCmeDirect() in cmeProvider.js with CME Reference Data API (subtype=EVENT).'
    );
  }

  if (process.env.IBKR_INGEST_ENABLED !== 'false') {
    const all = await fetchIBKREvents(options);
    const ibkrCme = all.filter((e) => e.venue === 'CME');
    if (ibkrCme.length) return ibkrCme;
  }

  setProviderStatus('cme', {
    status: directEnabled ? 'error' : 'unknown',
    message: directEnabled
      ? 'CME direct API stub — implement Reference Data client'
      : 'IBKR Gateway required for CME event contracts',
  });

  return [];
}

module.exports = { fetchCMEEvents };
