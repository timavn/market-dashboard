const ibkrPortfolio = require('./ibkr/ibkrPortfolioDataProvider');
const { reconcilePositions } = require('./normalize/reconcilePositions');
const { setPortfolioMeta } = require('./providerStatus');

const PREFER_UPLOAD = process.env.IBKR_PREFER_UPLOAD === 'true';

/**
 * @param {ReturnType<import('./uploadedStatementPortfolioProvider').createUploadedStatementPortfolioProvider>} uploadProvider
 * @param {(symbols: string[]) => Promise<Record<string, object>>} getCanonicalQuotesMap
 */
function createCompositePortfolioDataProvider(uploadProvider, getCanonicalQuotesMap) {
  async function shouldUseIbkr(forceUpload) {
    if (forceUpload || PREFER_UPLOAD) return false;
    if (!ibkrPortfolio.ENABLED) return false;
    try {
      const status = await ibkrPortfolio.getProviderStatus();
      return status.connected;
    } catch {
      return false;
    }
  }

  async function getPortfolioSnapshot(accountId, options = {}) {
    const forceUpload = options.source === 'upload';
    const useIbkr = await shouldUseIbkr(forceUpload);

    const uploadSnap = await uploadProvider.getPortfolioSnapshot();

    if (useIbkr) {
      try {
        const quoteFn = async (symbols) => {
          const map = {};
          for (const sym of symbols) {
            const canonical = await require('./compositeMarketDataProvider').getCanonicalQuote(sym);
            if (canonical) map[sym.toUpperCase()] = canonical;
          }
          return map;
        };

        const ibkrSnap = await ibkrPortfolio.getPortfolioSnapshot(accountId, quoteFn);

        if (ibkrSnap.holdings?.length) {
          const reconciliationWarnings = uploadSnap.holdings?.length
            ? reconcilePositions(ibkrSnap.holdings, uploadSnap.holdings)
            : [];

          setPortfolioMeta('ibkr_api', reconciliationWarnings.length ? reconciliationWarnings.join('; ') : null);

          const holdings = ibkrSnap.holdings.map((h) => ({
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
            conid: h.conid,
            positionSource: h.positionSource,
            priceSource: h.priceSource,
            lastUpdated: h.lastUpdated,
            warning: h.warning,
          }));

          return {
            ...ibkrSnap,
            holdings,
            assetAllocation: buildAllocation(holdings),
            topHoldings: [...holdings]
              .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0))
              .slice(0, 10)
              .map((h) => ({
                symbol: h.symbol,
                marketValue: h.marketValue,
                accountPercent: ibkrSnap.summary?.totalValue
                  ? ((h.marketValue / ibkrSnap.summary.totalValue) * 100).toFixed(2)
                  : '0.00',
              })),
            dataSource: 'ibkr_api',
            positionSource: 'ibkr_api',
            priceSource: 'ibkr',
            reconciliationWarnings,
            providerStatus: await getProviderStatus(),
            lastUpdated: formatLastUpdated(ibkrSnap.fetchedAt || new Date().toISOString()),
            accountSummary: ibkrSnap.accountSummary,
          };
        }
      } catch (err) {
        console.warn('[Portfolio] IBKR snapshot failed, falling back to upload:', err.message);
      }
    }

    setPortfolioMeta('uploaded_statement', null);
    return formatUploadResponse(uploadSnap);
  }

  function buildAllocation(holdings) {
    const total = holdings.reduce((s, h) => s + (h.marketValue || 0), 0);
    const byClass = {};
    for (const h of holdings) {
      const cls = h.assetClass || 'Other';
      byClass[cls] = (byClass[cls] || 0) + (h.marketValue || 0);
    }
    const alloc = {};
    for (const [cls, val] of Object.entries(byClass)) {
      alloc[cls] = total > 0 ? ((val / total) * 100).toFixed(2) : '0.00';
    }
    return alloc;
  }

  function formatUploadResponse(uploadSnap) {
    if (uploadSnap.empty) {
      return {
        summary: {
          totalValue: 0,
          totalDayChange: 0,
          totalDayChangePercent: '0.00',
          totalGainLoss: 0,
          totalGainLossPercent: '0.00',
          positionCount: 0,
        },
        assetAllocation: {},
        holdings: [],
        topHoldings: [],
        lastUpdated: 'No portfolio data - upload a Schwab CSV or connect IBKR',
        dataSource: 'uploaded_statement',
        empty: true,
      };
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

  return {
    getPortfolioSnapshot,
    getProviderStatus,
    getAccounts: ibkrPortfolio.getAccounts,
    getPositions: ibkrPortfolio.getPositions,
    getAccountSummary: ibkrPortfolio.getAccountSummary,
    getBalances: ibkrPortfolio.getBalances,
    getOpenOrders: ibkrPortfolio.getOpenOrders,
    getPnL: ibkrPortfolio.getPnL,
  };
}

module.exports = { createCompositePortfolioDataProvider };
