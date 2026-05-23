const ibkrPortfolio = require('./ibkr/ibkrPortfolioDataProvider');
const { setPortfolioMeta } = require('./providerStatus');
const ibkrStreamBridge = require('../ibkr/ibkrStreamBridge');
const { sidecarRequest } = require('./ibkrSidecarClient');
const { normalizeIbkrRaw } = require('./normalize/normalizeQuote');

/**
 * Cache-only quotes for portfolio enrichment — avoids sequential IBKR/Yahoo fetches.
 * Positions from IBKR stream cache usually include marketValue already.
 */
async function getCachedQuotesForSymbols(symbols) {
  const map = {};
  const missing = [];

  for (const sym of symbols) {
    const canonical = ibkrStreamBridge.getCachedCanonical(sym);
    if (canonical?.valid && canonical.mark != null) {
      map[sym.toUpperCase()] = canonical;
    } else {
      missing.push(sym);
    }
  }

  if (missing.length === 0) return map;

  try {
    const res = await sidecarRequest(
      `/cache/quotes?symbols=${encodeURIComponent(missing.join(','))}`,
      { timeoutMs: 2000 },
    );
    for (const raw of res.quotes || []) {
      const sym = (raw.symbol || '').toUpperCase();
      if (!sym) continue;
      const canonical = normalizeIbkrRaw(raw);
      if (canonical?.valid && canonical.mark != null) {
        map[sym] = canonical;
      }
    }
  } catch {
    // Positions may already carry marketValue from IBKR portfolio cache.
  }

  return map;
}

/**
 * @param {ReturnType<import('./uploadedStatementPortfolioProvider').createUploadedStatementPortfolioProvider>} uploadProvider
 */
function createCompositePortfolioDataProvider(uploadProvider) {
  async function isIbkrConnected() {
    if (!ibkrPortfolio.ENABLED) return false;
    try {
      const status = await ibkrPortfolio.getProviderStatus();
      return status.connected;
    } catch {
      return false;
    }
  }

  function formatIbkrOfflineEmpty() {
    setPortfolioMeta('ibkr_offline', null);
    return {
      summary: {
        totalValue: 0,
        totalDayChange: 0,
        totalDayChangePercent: '0.00',
        totalGainLoss: 0,
        totalGainLossPercent: '0.00',
        positionCount: 0,
        longCount: 0,
        shortCount: 0,
      },
      assetAllocation: {},
      holdings: [],
      topHoldings: [],
      accountSummary: null,
      accountId: null,
      lastUpdated: 'Connect IB Gateway and run npm run ibkr-sidecar',
      dataSource: 'ibkr_offline',
      positionSource: null,
      priceSource: null,
      empty: true,
    };
  }

  function buildAllocation(holdings) {
    const total = holdings.reduce((s, h) => s + Math.abs(h.marketValue || 0), 0);
    const byClass = {};
    for (const h of holdings) {
      const cls = h.assetClass || 'Other';
      byClass[cls] = (byClass[cls] || 0) + Math.abs(h.marketValue || 0);
    }
    const alloc = {};
    for (const [cls, val] of Object.entries(byClass)) {
      alloc[cls] = total > 0 ? ((val / total) * 100).toFixed(2) : '0.00';
    }
    return alloc;
  }

  function formatIbkrResponse(ibkrSnap) {
    const holdings = (ibkrSnap.holdings || []).map((h) => ({
      symbol: h.symbol,
      description: h.description,
      quantity: h.quantity,
      price: h.price ?? 0,
      marketValue: h.marketValue ?? 0,
      costBasis: h.costBasis ?? 0,
      gainLoss: h.gainLoss ?? 0,
      gainLossPercent: h.gainLossPercent ?? 0,
      dayChangePercent: null,
      assetType: h.assetType,
      assetClass: h.assetClass,
      secType: h.secType,
      conid: h.conid,
      positionSource: h.positionSource,
      priceSource: h.priceSource,
      lastUpdated: h.lastUpdated,
      warning: h.warning,
    }));

    setPortfolioMeta('ibkr_api', ibkrSnap.error || null);

    const totalValue =
      ibkrSnap.accountSummary?.netLiquidation ?? ibkrSnap.summary?.totalValue ?? 0;

    return {
      ...ibkrSnap,
      holdings,
      assetAllocation: buildAllocation(holdings),
      topHoldings: [...holdings]
        .sort((a, b) => Math.abs(b.marketValue || 0) - Math.abs(a.marketValue || 0))
        .slice(0, 10)
        .map((h) => ({
          symbol: h.symbol,
          marketValue: h.marketValue,
          accountPercent: totalValue
            ? ((Math.abs(h.marketValue) / totalValue) * 100).toFixed(2)
            : '0.00',
        })),
      dataSource: 'ibkr_api',
      positionSource: 'ibkr_api',
      priceSource: 'ibkr',
      reconciliationWarnings: [],
      providerStatus: null,
      lastUpdated: formatLastUpdated(ibkrSnap.fetchedAt || new Date().toISOString()),
      accountSummary: ibkrSnap.accountSummary,
      empty: holdings.length === 0 && !ibkrSnap.accountSummary,
    };
  }

  async function getPortfolioSnapshot(accountId, options = {}) {
    if (options.source === 'upload') {
      const uploadSnap = await uploadProvider.getPortfolioSnapshot();
      setPortfolioMeta('uploaded_statement', null);
      return formatUploadResponse(uploadSnap);
    }

    const connected = await isIbkrConnected();
    if (!connected) {
      return formatIbkrOfflineEmpty();
    }

    try {
      const ibkrSnap = await ibkrPortfolio.getPortfolioSnapshot(
        accountId,
        getCachedQuotesForSymbols,
      );
      return formatIbkrResponse(ibkrSnap);
    } catch (err) {
      console.warn('[Portfolio] IBKR snapshot failed:', err.message);
      return formatIbkrOfflineEmpty();
    }
  }

  function formatUploadResponse(uploadSnap) {
    if (uploadSnap.empty) {
      return formatIbkrOfflineEmpty();
    }

    const timestamp = uploadSnap.timestamp;
    return {
      summary: {
        totalValue: uploadSnap.summary?.totalValue || 0,
        totalDayChange: uploadSnap.summary?.totalDayChange || 0,
        totalDayChangePercent: uploadSnap.summary?.totalDayChangePercent || '0.00',
        totalGainLoss: uploadSnap.summary?.totalGainLoss || 0,
        totalGainLossPercent: uploadSnap.summary?.totalGainLossPercent || '0.00',
        positionCount: uploadSnap.summary?.positionCount || uploadSnap.holdings.length,
        longCount: uploadSnap.summary?.longCount || 0,
        shortCount: uploadSnap.summary?.shortCount || 0,
      },
      assetAllocation: uploadSnap.assetAllocation,
      holdings: uploadSnap.holdings.map((h) => ({
        symbol: h.symbol,
        description: h.description,
        quantity: h.quantity,
        price: h.price,
        marketValue: h.marketValue,
        costBasis: h.costBasis,
        gainLoss: h.gainLoss,
        gainLossPercent: h.gainLossPercent,
        dayChangePercent: null,
        assetType: h.assetType,
        assetClass: h.assetClass,
        positionSource: h.positionSource,
        priceSource: h.priceSource,
        lastUpdated: uploadSnap.lastUpdated,
      })),
      topHoldings: uploadSnap.holdings.slice(0, 10).map((h) => ({
        symbol: h.symbol,
        marketValue: h.marketValue,
      })),
      lastUpdated: formatLastUpdated(timestamp),
      dataSource: 'uploaded_statement',
      positionSource: 'uploaded_statement',
      empty: false,
    };
  }

  function formatLastUpdated(timestamp) {
    if (!timestamp) return null;
    const ts = timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`;
    const date = new Date(ts);
    const datePart = date.toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    });
    const pstTime = date.toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const estTime = date.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `${datePart}, ${pstTime} PST / ${estTime} EST`;
  }

  async function getProviderStatus() {
    const [ibkrSt, uploadSt, meta] = await Promise.all([
      ibkrPortfolio.getProviderStatus(),
      uploadProvider.getProviderStatus(),
      Promise.resolve(require('./providerStatus').getProviderStatusSnapshot()),
    ]);
    return {
      ibkr: ibkrSt,
      upload: uploadSt,
      dataSource: meta.portfolio?.dataSource,
      lastWarning: meta.portfolio?.lastWarning,
    };
  }

  const exposeOpenOrders = process.env.IBKR_EXPOSE_OPEN_ORDERS === 'true';

  const api = {
    getPortfolioSnapshot,
    getProviderStatus,
    getAccounts: ibkrPortfolio.getAccounts,
    getPositions: ibkrPortfolio.getPositions,
    getAccountSummary: ibkrPortfolio.getAccountSummary,
    getBalances: ibkrPortfolio.getBalances,
    getPnL: ibkrPortfolio.getPnL,
  };

  if (exposeOpenOrders) {
    api.getOpenOrders = ibkrPortfolio.getOpenOrders;
  }

  return api;
}

module.exports = { createCompositePortfolioDataProvider };
