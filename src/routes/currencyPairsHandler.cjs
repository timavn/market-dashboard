'use strict';

// No verified currency-pair provider is wired to this endpoint. Do not supply
// indicative, cached or fixed prices in place of provider observations.
function createCurrencyPairsHandler() {
  return (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({
      status: 'unavailable',
      currencyPairs: [],
      reason: 'verified_currency_pair_provider_unavailable',
    });
  };
}

module.exports = { createCurrencyPairsHandler };
