const express = require('express');
const router = express.Router();
const compositeMarket = require('../services/providers/compositeMarketDataProvider');
const ibkrMarket = require('../services/providers/ibkr/ibkrMarketDataProvider');
const ibkrPortfolio = require('../services/providers/ibkr/ibkrPortfolioDataProvider');

function getPortfolioProvider(req) {
  return req.app.locals.portfolioDataProvider;
}

// GET /api/providers/status
router.get('/status', async (req, res) => {
  try {
    const portfolioProvider = getPortfolioProvider(req);
    const [marketStatus, portfolioStatus] = await Promise.all([
      compositeMarket.getProviderStatus(),
      portfolioProvider ? portfolioProvider.getProviderStatus() : Promise.resolve({}),
    ]);
    res.json({
      ...marketStatus,
      portfolio: portfolioStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/dev-smoke
router.get('/dev-smoke', async (req, res) => {
  const allowDev =
    process.env.NODE_ENV !== 'production' || process.env.IBKR_DEV_SMOKE === 'true';
  if (!allowDev) {
    return res.status(404).json({ error: 'Not available in production' });
  }

  try {
    const portfolioProvider = getPortfolioProvider(req);
    const [ibkrStatus, aaplQuote, spyQuote, accounts] = await Promise.all([
      ibkrMarket.getProviderStatus(),
      compositeMarket.getQuote('AAPL'),
      compositeMarket.getQuote('SPY'),
      ibkrPortfolio.getAccounts().catch(() => []),
    ]);

    let positions = [];
    let accountSummary = null;
    let portfolioSnapshot = null;

    if (accounts.length > 0) {
      const acct = process.env.IBKR_ACCOUNT_ID || accounts[0];
      [positions, accountSummary, portfolioSnapshot] = await Promise.all([
        ibkrPortfolio.getPositions(acct),
        ibkrPortfolio.getAccountSummary(acct),
        portfolioProvider
          ? portfolioProvider.getPortfolioSnapshot(acct, { source: 'ibkr' })
          : Promise.resolve(null),
      ]);
    }

    res.json({
      ibkrStatus,
      quotes: { AAPL: aaplQuote, SPY: spyQuote },
      accounts,
      positions: positions.positions || positions,
      accountSummary,
      portfolioSnapshot: portfolioSnapshot
        ? {
            dataSource: portfolioSnapshot.dataSource,
            holdingCount: portfolioSnapshot.holdings?.length,
            summary: portfolioSnapshot.summary,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
});

module.exports = router;
