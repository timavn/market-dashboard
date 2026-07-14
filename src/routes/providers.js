const express = require('express');
const router = express.Router();
const compositeMarket = require('../services/providers/compositeMarketDataProvider');
const ibkrMarket = require('../services/providers/ibkr/ibkrMarketDataProvider');
const ibkrPortfolio = require('../services/providers/ibkr/ibkrPortfolioDataProvider');

const PROVIDER_STATUS_TIMEOUT_MS = Number(process.env.PROVIDER_STATUS_TIMEOUT_MS || 3500);

function getPortfolioProvider(req) {
  return req.app.locals.portfolioDataProvider;
}

function withTimeout(promise, label, timeoutMs = PROVIDER_STATUS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function providerStatusError(label, error) {
  return {
    name: label,
    connected: false,
    status: error?.code === 'ETIMEDOUT' ? 'timeout' : 'error',
    message: error?.message || `Failed to load ${label} status`,
    statusRefreshDelayed: error?.code === 'ETIMEDOUT',
  };
}

// GET /api/providers/status
router.get('/status', async (req, res) => {
  try {
    const portfolioProvider = getPortfolioProvider(req);
    const [marketResult, portfolioResult] = await Promise.allSettled([
      withTimeout(compositeMarket.getProviderStatus(), 'Market provider status'),
      portfolioProvider
        ? withTimeout(portfolioProvider.getProviderStatus(), 'Portfolio provider status')
        : Promise.resolve({}),
    ]);
    const warnings = [];
    const marketStatus = marketResult.status === 'fulfilled'
      ? marketResult.value
      : {
          ibkr: providerStatusError('ibkr', marketResult.reason),
          yahoo: providerStatusError('yahoo', marketResult.reason),
          marketStatusError: marketResult.reason?.message,
        };
    const portfolioStatus = portfolioResult.status === 'fulfilled'
      ? portfolioResult.value
      : {
          error: portfolioResult.reason?.message,
          statusRefreshDelayed: portfolioResult.reason?.code === 'ETIMEDOUT',
        };

    if (marketResult.status === 'rejected') {
      warnings.push(`Market provider status unavailable: ${marketResult.reason?.message}`);
    }
    if (portfolioResult.status === 'rejected') {
      warnings.push(`Portfolio provider status unavailable: ${portfolioResult.reason?.message}`);
    }

    const payload = {
      ...marketStatus,
      ibkr: marketStatus.ibkr || portfolioStatus.ibkr,
      portfolio: portfolioStatus,
      providerStatusWarnings: warnings,
      statusRefreshDelayed: warnings.some((warning) => /timed out/i.test(warning)),
      timestamp: new Date().toISOString(),
    };

    res.json({
      ...payload,
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
