const ibkrPortfolio = require('./ibkr/ibkrPortfolioDataProvider');
const { setPortfolioMeta } = require('./providerStatus');

/**
 * @param {ReturnType<import('./uploadedStatementPortfolioProvider').createUploadedStatementPortfolioProvider>} uploadProvider
 */
function createCompositePortfolioDataProvider(uploadProvider) {
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
      lastUpdated: null,
      dataSource: 'ibkr_offline',
      positionSource: null,
      priceSource: null,
      empty: true,
      liveSessionVerified: false,
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
      accountId: h.accountId,
      quantity: h.quantity,
      price: h.price ?? null,
      marketValue: h.marketValue ?? null,
      costBasis: h.costBasis ?? null,
      gainLoss: h.gainLoss ?? null,
      gainLossPercent: h.gainLossPercent ?? null,
      dayChangePercent: null,
      assetType: h.assetType,
      assetClass: h.assetClass,
      secType: h.secType,
      conid: h.conid,
      isPredictionMarket: h.isPredictionMarket,
      positionSource: h.positionSource,
      priceSource: h.priceSource,
      lastUpdated: h.lastUpdated,
      warning: h.warning,
    }));

    const dataQualityWarnings = Array.isArray(ibkrSnap.dataQuality?.warnings)
      ? ibkrSnap.dataQuality.warnings
      : [];

    setPortfolioMeta('ibkr_api', ibkrSnap.error || dataQualityWarnings[0] || null);

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
          accountPercent: totalValue && h.marketValue != null
            ? ((Math.abs(h.marketValue) / totalValue) * 100).toFixed(2)
            : '0.00',
        })),
      dataSource: 'ibkr_api',
      positionSource: 'ibkr_live_session',
      priceSource: null,
      reconciliationWarnings: dataQualityWarnings,
      providerStatus: null,
      dataQuality: ibkrSnap.dataQuality || null,
      lastUpdated: formatLastUpdated(ibkrSnap.fetchedAt || new Date().toISOString()),
      accountSummary: ibkrSnap.accountSummary,
      empty: holdings.length === 0 && !ibkrSnap.accountSummary,
      liveSessionVerified: true,
      fromCache: false,
    };
  }

  async function getPortfolioSnapshot(accountId, options = {}) {
    if (options.source === 'upload') {
      const uploadSnap = await uploadProvider.getPortfolioSnapshot();
      setPortfolioMeta('uploaded_statement', null);
      return formatUploadResponse(uploadSnap);
    }

    if (!ibkrPortfolio.ENABLED) {
      return formatIbkrOfflineEmpty();
    }

    try {
      const ibkrSnap = await ibkrPortfolio.getPortfolioSnapshot(accountId);
      if (ibkrSnap.liveSessionVerified !== true
          || (ibkrSnap.error && !ibkrSnap.accountSummary && !(ibkrSnap.holdings?.length))) {
        return formatIbkrOfflineEmpty();
      }
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
      archival: true,
      liveSessionVerified: false,
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
