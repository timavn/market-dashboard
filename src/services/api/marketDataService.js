import axios from 'axios';
import { ENDPOINTS, EXTERNAL_APIS } from '../../constants/apiEndpoints';
import { PortfolioAnalytics } from '../portfolioAnalytics';

// Create axios instance with default config
// Use full URL to bypass proxy issues in development
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const apiClient = axios.create({
  baseURL: backendUrl,
  timeout: 60000, // 60 seconds - increased to handle slow DynamoDB/Yahoo Finance responses on cold cache
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add response interceptor for better error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      console.warn(`[MarketDataService] Request timed out: ${error.config?.url}`);
      throw new Error('Request timed out - server may be busy');
    }
    throw error;
  }
);

const inFlightGetRequests = new Map();
const FUNDING_UNAVAILABLE_REASON_ALLOWLIST = new Set([
  'non_settlement_day',
  'unsettled_securities_activity',
  'settlement_unverified',
]);

const sanitizeFundingUnavailableReason = (value) =>
  FUNDING_UNAVAILABLE_REASON_ALLOWLIST.has(value) ? value : null;

const normalizeParamsForKey = (params = {}) => Object.keys(params)
  .sort()
  .reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});

const dedupedGet = (url, config = {}) => {
  if (config.signal) {
    return apiClient.get(url, config);
  }

  const key = JSON.stringify({
    url,
    params: normalizeParamsForKey(config.params || {}),
  });

  const existing = inFlightGetRequests.get(key);
  if (existing) {
    return existing;
  }

  const request = apiClient.get(url, config)
    .finally(() => {
      inFlightGetRequests.delete(key);
    });
  inFlightGetRequests.set(key, request);
  return request;
};

const readResponseHeader = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value != null) return value;
  }
  return headers[name] ?? headers[name.toLowerCase()];
};

const attachReferenceCacheMetadata = (response) => {
  const data = response?.data;
  if (!data || typeof data !== 'object') return data;

  const rawStatus = readResponseHeader(response.headers, 'x-data-cache')
    ?? readResponseHeader(response.headers, 'x-cache-status');
  const rawAge = readResponseHeader(response.headers, 'x-data-age')
    ?? readResponseHeader(response.headers, 'age');
  const status = rawStatus ? String(rawStatus).trim().toLowerCase() : null;
  const parsedAge = Number(rawAge);
  const ageSeconds = Number.isFinite(parsedAge) && parsedAge >= 0 ? parsedAge : null;

  if (!status && ageSeconds === null) return data;

  const value = Array.isArray(data) ? [...data] : { ...data };
  Object.defineProperty(value, '_cache', {
    configurable: true,
    enumerable: false,
    value: {
      status: status || 'unknown',
      ageSeconds,
      stale: status === 'stale',
      receivedAt: new Date().toISOString(),
    },
  });
  return value;
};

// Market Data Service
export class MarketDataService {
  static async getSystemStatus() {
    try {
      // The probes themselves remain tightly bounded server-side. Allow a
      // little extra client time for the request to enter a busy local API
      // event loop while the rest of the dashboard is loading.
      const response = await dedupedGet(ENDPOINTS.SYSTEM_STATUS, { timeout: 4000 });
      return response.data;
    } catch (error) {
      console.error('Error fetching system status:', error);
      throw error;
    }
  }

  static async getSystemReadiness({ refresh = false } = {}) {
    try {
      const response = await dedupedGet(ENDPOINTS.SYSTEM_READINESS, {
        params: refresh ? { refresh: 1 } : {},
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching system readiness:', error);
      throw error;
    }
  }

  static async runSystemReadinessRepair(actionId) {
    if (!actionId || typeof actionId !== 'string') {
      throw new Error('A readiness repair action ID is required.');
    }
    const response = await apiClient.post(
      `${ENDPOINTS.SYSTEM_READINESS}/actions/${encodeURIComponent(actionId)}`,
      {},
      { headers: { 'X-Readiness-Repair': '1' } },
    );
    return response.data;
  }

  static async getProviderStatus() {
    try {
      const response = await dedupedGet(ENDPOINTS.PROVIDERS_STATUS);
      return response.data;
    } catch (error) {
      console.error('Error fetching provider status:', error);
      throw error;
    }
  }

  // Get real-time quotes
  static async getQuotes(symbols) {
    try {
      const response = await dedupedGet(ENDPOINTS.QUOTES, {
        params: { symbols: symbols.join(',') }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching quotes:', error);
      throw error;
    }
  }

  // Get portfolio summary and holdings
  static async getPortfolio({ account = null, snapshotId = null } = {}) {
    try {
      const params = {};
      if (account) params.account = account;
      if (snapshotId) params.snapshotId = snapshotId;
      const response = await dedupedGet(ENDPOINTS.PORTFOLIO, { params });
      const data = response.data;

      // Handle both AWS API Gateway format (with snapshot/holdings) and local server format (direct)
      let portfolioData;
      if (data.snapshot && data.holdings) {
        // AWS API Gateway format
        const { snapshot, holdings } = data;
        const enhancedMetrics = PortfolioAnalytics.calculatePortfolioMetrics(holdings, snapshot);

        portfolioData = {
          summary: {
            totalValue: snapshot.summary.totalValue,
            totalDayChange: 0, // Not available in current data
            totalDayChangePercent: '0.00',
            totalGainLoss: snapshot.summary.totalGainLoss,
            totalGainLossPercent: snapshot.summary.totalGainLossPercent.toFixed(2),
            positionCount: snapshot.summary.positionCount
          },
          assetAllocation: snapshot.assetAllocation,
          holdings: holdings,
          topHoldings: holdings.slice(0, 10).map(holding => ({
            symbol: holding.symbol,
            marketValue: holding.marketValue,
            accountPercent: ((holding.marketValue / snapshot.summary.totalValue) * 100).toFixed(2)
          })),
          lastUpdated: new Date(snapshot.timestamp).toLocaleString(),

          // Enhanced analytics
          riskMetrics: {
            volatility: enhancedMetrics.volatility,
            sharpeRatio: enhancedMetrics.sharpeRatio,
            sortinoRatio: enhancedMetrics.sortinoRatio,
            var95: enhancedMetrics.var95,
            maxDrawdown: enhancedMetrics.maxDrawdown
          },
          exposureMetrics: {
            grossExposure: enhancedMetrics.grossExposure,
            netLongExposure: enhancedMetrics.netLongExposure,
            netShortExposure: enhancedMetrics.netShortExposure,
            netExposure: enhancedMetrics.netExposure
          },
          concentrationMetrics: {
            top10HoldingsPercent: enhancedMetrics.top10HoldingsPercent,
            largestPositionPercent: enhancedMetrics.largestPositionPercent,
            hhiIndex: enhancedMetrics.hhiIndex
          },
          factorExposures: {
            marketCap: {
              largeCap: enhancedMetrics.largeCap,
              midCap: enhancedMetrics.midCap,
              smallCap: enhancedMetrics.smallCap
            },
            sectors: {
              technology: enhancedMetrics.technology,
              healthcare: enhancedMetrics.healthcare,
              financials: enhancedMetrics.financials,
              consumer: enhancedMetrics.consumer,
              energy: enhancedMetrics.energy
            },
            geographic: {
              northAmerica: enhancedMetrics.northAmerica,
              europe: enhancedMetrics.europe,
              asiaPacific: enhancedMetrics.asiaPacific,
              emergingMarkets: enhancedMetrics.emergingMarkets
            }
          }
        };
      } else {
        // Local server format (direct data)
        portfolioData = {
          summary: {
            totalValue: data.summary.totalValue,
            totalDayChange: data.summary.totalDayChange ?? null,
            totalDayChangePercent: data.summary.totalDayChangePercent ?? null,
            totalGainLoss: data.summary.totalGainLoss ?? null,
            totalGainLossPercent: data.summary.totalGainLossPercent ?? null,
            positionCount: data.summary.positionCount ?? 0,
            longCount: data.summary.longCount ?? 0,
            shortCount: data.summary.shortCount ?? 0,
          },
          assetAllocation: data.assetAllocation || {},
          holdings: data.holdings || [],
          topHoldings: data.topHoldings || [],
          lastUpdated: data.lastUpdated || new Date().toLocaleString(),
          dataSource: data.dataSource || null,
          accountSummary: data.accountSummary || null,
          funding: data.funding || null,
          fundingReference: data.fundingReference || null,
          fundingUnavailableReason: sanitizeFundingUnavailableReason(
            data.fundingUnavailableReason,
          ),
          accountId: data.accountId || null,
          pnl: data.pnl || null,
          empty: Boolean(data.empty),
          liveSessionVerified: data.liveSessionVerified === true,
          socketVerifiedAt: data.socketVerifiedAt || data.accountSummary?.socketVerifiedAt || null,
          fromCache: data.fromCache === true,
          reconciliationWarnings: data.reconciliationWarnings || [],
          dataQuality: data.dataQuality || null,

          // Analytics are exposed only when the server computed them from the
          // verified response. Never fill an active portfolio with demo values.
          riskMetrics: data.riskMetrics || null,
          exposureMetrics: data.exposureMetrics || null,
          concentrationMetrics: data.concentrationMetrics || null,
          factorExposures: data.factorExposures || null,
          analyticsAvailability: data.analyticsAvailability || {
            available: false,
            reason: 'No verified live analytics were returned by the portfolio API.',
          },
        };
      }

      return portfolioData;
    } catch (error) {
      console.error('Error fetching portfolio:', error);
      throw error;
    }
  }

  /**
   * Fetch the verified research projection for a set of portfolio symbols.
   *
   * This is intentionally a single bulk request. The response is kept separate
   * from getPortfolio so a research outage can never change live IBKR holdings.
   */
  static async getSecurityIntelligence({
    symbols = [],
    date = null,
    historyDays = 5,
    signal = undefined,
  } = {}) {
    const normalizedSymbols = [...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean)
    )];

    if (normalizedSymbols.length === 0) {
      return {
        schemaVersion: '1',
        marketDate: date,
        status: 'no_references',
        bySymbol: {},
        sourceCoverage: [],
      };
    }

    try {
      const response = await dedupedGet('/api/research/security-intelligence', {
        params: {
          symbols: normalizedSymbols.join(','),
          ...(date ? { date } : {}),
          historyDays,
        },
        ...(signal ? { signal } : {}),
      });
      return response.data;
    } catch (error) {
      if (error?.name !== 'CanceledError' && error?.code !== 'ERR_CANCELED') {
        console.error('Error fetching portfolio security intelligence:', error);
      }
      throw error;
    }
  }

  static async getPortfolioAccounts() {
    try {
      const response = await dedupedGet(ENDPOINTS.PORTFOLIO_ACCOUNTS);
      return response.data?.accounts || [];
    } catch (error) {
      console.error('Error fetching portfolio account snapshots:', error);
      throw error;
    }
  }

  static async getIbkrFlexStatus() {
    try {
      const response = await dedupedGet(ENDPOINTS.IBKR_FLEX_STATUS);
      return response.data;
    } catch (error) {
      console.error('Error fetching IBKR Flex status:', error);
      throw error;
    }
  }

  static async syncIbkrFlex({ date = null } = {}) {
    try {
      const response = await apiClient.post(ENDPOINTS.IBKR_FLEX_SYNC, null, {
        params: date ? { date } : {},
      });
      return response.data;
    } catch (error) {
      console.error('Error syncing IBKR Flex report:', error);
      throw error;
    }
  }

  static async getPortfolioExposureReconciliation({ date = null } = {}) {
    try {
      const response = await dedupedGet(ENDPOINTS.PORTFOLIO_EXPOSURE_RECONCILIATION, {
        params: date ? { date } : {},
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching portfolio exposure reconciliation:', error);
      throw error;
    }
  }

  static async getIbkrInterestValidationStatus({ account = null } = {}) {
    try {
      const response = await dedupedGet(ENDPOINTS.IBKR_INTEREST_VALIDATION_STATUS, {
        params: account ? { account } : {},
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching IBKR interest validation status:', error);
      throw error;
    }
  }

  static async getIbkrInterestValidationHistory({ limit = 90 } = {}) {
    try {
      const response = await dedupedGet(ENDPOINTS.IBKR_INTEREST_VALIDATION_HISTORY, {
        params: { limit },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching IBKR interest validation history:', error);
      throw error;
    }
  }

  static async runIbkrInterestValidation() {
    try {
      const response = await apiClient.post(
        ENDPOINTS.IBKR_INTEREST_VALIDATION_RUN,
        {},
      );
      return response.data;
    } catch (error) {
      console.error('Error running IBKR interest validation:', error);
      throw error;
    }
  }

  static async getPortfolioPredictionMarketPositions({ primaryAccount = null } = {}) {
    try {
      const params = {};
      if (primaryAccount) params.primaryAccount = primaryAccount;
      const response = await dedupedGet(ENDPOINTS.PORTFOLIO_PREDICTION_MARKET_POSITIONS, { params });
      return response.data || { accounts: [], positions: [] };
    } catch (error) {
      console.error('Error fetching prediction market positions:', error);
      throw error;
    }
  }

  static async getPortfolioCorrelationConcentration({
    holdings = [],
    totalValue = null,
    windows = [30, 90, 180],
    primaryWindow = 90,
    signal = null,
    forceRefresh = false,
  } = {}) {
    try {
      const response = await apiClient.post('/api/portfolio/correlation-concentration', {
        holdings,
        totalValue,
        windows,
        primaryWindow,
        forceRefresh,
      }, { signal });
      return response.data;
    } catch (error) {
      console.error('Error calculating portfolio correlation concentration:', error);
      throw error;
    }
  }

  // Get options chain
  static async getOptionsChain(symbol, expiration = null) {
    try {
      const params = { symbol };
      if (expiration) params.expiration = expiration;

      const response = await dedupedGet(ENDPOINTS.OPTIONS_CHAIN, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching options chain:', error);
      throw error;
    }
  }

  // Get VIX data
  static async getVIXData() {
    try {
      const response = await dedupedGet(ENDPOINTS.VIX);
      return response.data;
    } catch (error) {
      console.error('Error fetching VIX data:', error);
      throw error;
    }
  }

  // Get the consolidated live volatility snapshot with provider/freshness metadata
  static async getVolatilitySnapshot() {
    try {
      const response = await dedupedGet('/api/volatility-snapshot');
      return response.data;
    } catch (error) {
      console.error('Error fetching volatility snapshot:', error);
      throw error;
    }
  }

  // Get macro indicators (DXY, GLD, UST10Y, CRB, WTI, SPY, QQQ, IWM)
  static async getMacroIndicators() {
    try {
      const response = await dedupedGet('/api/macro-indicators');
      return response.data;
    } catch (error) {
      console.error('Error fetching macro indicators:', error);
      throw error;
    }
  }

  // Get multi-region market quotes (US, Europe, Asia, Crypto, Rates)
  static async getMultiRegionQuotes(regions = null, includeSparklines = false, includePeriodReturns = false) {
    try {
      const params = {};
      if (regions) {
        params.regions = regions.join(',');
      }
      if (includeSparklines !== undefined) {
        params.includeSparklines = includeSparklines.toString();
      }
      if (includePeriodReturns) {
        params.includePeriodReturns = 'true';
      }

      const response = await dedupedGet('/api/multi-region-quotes', { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching multi-region quotes:', error);
      throw error;
    }
  }

  // Get volume data
  static async getVolumeData(symbols) {
    try {
      const response = await dedupedGet(ENDPOINTS.VOLUME, {
        params: { symbols: symbols.join(',') }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching volume data:', error);
      throw error;
    }
  }

  // Get persisted market-structure daily series for the Volume card
  // Returns aligned daily arrays for:
  // - totalMarket: consolidated market-wide share volume
  // - totalExchange: listed exchange share volume
  static async getMarketShareVolume(days = 365) {
    try {
      const response = await dedupedGet(ENDPOINTS.MARKET_SHARE_VOLUME, {
        params: { days }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching market share volume data:', error);
      throw error;
    }
  }

  // External API integrations
  static async getAlphaVantageData(symbol, func = 'TIME_SERIES_INTRADAY') {
    try {
      const response = await axios.get(EXTERNAL_APIS.ALPHA_VANTAGE.baseUrl, {
        params: {
          function: func,
          symbol: symbol,
          interval: '5min',
          apikey: EXTERNAL_APIS.ALPHA_VANTAGE.apiKey
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching Alpha Vantage data:', error);
      throw error;
    }
  }

  static async getFinnhubQuote(symbol) {
    try {
      const response = await axios.get(`${EXTERNAL_APIS.FINNHUB.baseUrl}/quote`, {
        params: {
          symbol: symbol,
          token: EXTERNAL_APIS.FINNHUB.apiKey
        }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching Finnhub data:', error);
      throw error;
    }
  }

  // Get all securities data (for signal strength calculation)
  static async getAllSecuritiesData() {
    try {
      // Get all tickers from securities list
      const { getAllTickers } = await import('../../constants/securitiesConfig');
      const tickers = getAllTickers();

      // Fetch quotes for all securities in batches
      const batchSize = 50; // Yahoo Finance can handle multiple symbols
      const allData = {};

      for (let i = 0; i < tickers.length; i += batchSize) {
        const batch = tickers.slice(i, i + batchSize);
        try {
          const quotes = await this.getQuotes(batch);
          Object.assign(allData, quotes);
        } catch (error) {
          console.error(`Error fetching batch ${i}-${i + batchSize}:`, error);
        }
      }

      return allData;
    } catch (error) {
      console.error('Error fetching all securities data:', error);
      throw error;
    }
  }

  // Get signal strength rankings
  static async getSignalStrengthRankings() {
    try {
      const response = await dedupedGet('/api/securities/signal-strength');
      return response.data;
    } catch (error) {
      console.error('Error fetching signal strength rankings:', error);
      throw error;
    }
  }

  // Get risk ranges (LRR/HRR) for securities
  static async getRiskRanges(tickers = null) {
    try {
      const params = tickers ? { tickers: tickers.join(',') } : {};
      const response = await dedupedGet(ENDPOINTS.RISK_RANGES, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching risk ranges:', error);
      throw error;
    }
  }

  // Get read-only historical beta, ATR14, records, completed daily
  // high/low price structure, and realized sizing volatility.
  // The server response is explicitly historicalOnly/non-executable and must
  // never be substituted for a verified live quote or portfolio value.
  static async getSecurityRiskMetrics(symbols, {
    forceRefresh = false,
    assetTypes = null,
    includeVolSeries = false,
  } = {}) {
    const requested = Array.from(new Set(
      (Array.isArray(symbols) ? symbols : [symbols])
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean)
    ));
    if (requested.length === 0) {
      throw new TypeError('At least one symbol is required for historical risk metrics');
    }

    let assetTypesParam = null;
    if (assetTypes && typeof assetTypes === 'object') {
      assetTypesParam = Object.entries(assetTypes)
        .map(([symbol, assetType]) => {
          const key = String(symbol || '').trim().toUpperCase();
          const value = String(assetType || '').trim().toLowerCase();
          return key && value ? `${key}:${value}` : null;
        })
        .filter(Boolean)
        .join(',');
    } else if (typeof assetTypes === 'string' && assetTypes.trim()) {
      assetTypesParam = assetTypes.trim();
    }

    try {
      const response = await dedupedGet('/api/security-risk-metrics', {
        params: {
          symbols: requested.join(','),
          ...(forceRefresh ? { forceRefresh: 1 } : {}),
          ...(assetTypesParam ? { assetTypes: assetTypesParam } : {}),
          ...(includeVolSeries ? { includeVolSeries: 1 } : {}),
        }
      });
      return attachReferenceCacheMetadata(response);
    } catch (error) {
      console.error('Error fetching historical security risk metrics:', error);
      throw error;
    }
  }

  // Get risk range history for a specific ticker
  static async getRiskRangeHistory(ticker, limit = 30) {
    try {
      const response = await dedupedGet('/api/risk-ranges/history', {
        params: { ticker, limit }
      });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        // Fallback for older servers or missing endpoint
        console.warn('Risk range history endpoint not found, returning empty array');
        return [];
      }
      console.error(`Error fetching risk range history for ${ticker}:`, error);
      throw error;
    }
  }

  // Get all risk range history (bulk)
  static async getAllRiskRangeHistory() {
    try {
      const response = await dedupedGet('/api/risk-ranges/history-all');
      return response.data;
    } catch (error) {
      console.error('Error fetching all risk range history:', error);
      // Fallback to empty object
      return {};
    }
  }

  // Get Hedgeye snapshot data by type (e.g. 'the-macro-show', 'the-call')
  // Optional date format: YYYY-MM-DD
  static async getHedgeyeSnapshot(snapshotType, date = null) {
    try {
      const params = date ? { date } : undefined;
      const response = await dedupedGet(
        `/api/hedgeye/snapshot/${encodeURIComponent(snapshotType)}`,
        { params }
      );
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) return null;
      console.error(`Error fetching Hedgeye snapshot ${snapshotType}:`, error);
      return null;
    }
  }

  // Get Hedgeye freshness status for all 6 data types
  static async getHedgeyeFreshness() {
    try {
      const response = await dedupedGet('/api/hedgeye/freshness');
      return response.data;
    } catch (error) {
      console.error('Error fetching Hedgeye freshness:', error);
      throw error;
    }
  }

  static async getHedgeyeChangelog() {
    try {
      const response = await dedupedGet('/api/hedgeye/changelog');
      return attachReferenceCacheMetadata(response);
    } catch (error) {
      console.error('Error fetching Hedgeye changelog:', error);
      throw error;
    }
  }

  static async getRealTimeAlertPositions() {
    try {
      const response = await dedupedGet('/api/hedgeye/real-time-alert/positions');
      return attachReferenceCacheMetadata(response);
    } catch (error) {
      console.error('Error fetching real-time alert positions:', error);
      throw error;
    }
  }

  static async getHermesDirectorStatus() {
    try {
      const response = await dedupedGet(ENDPOINTS.HERMES_DIRECTOR_STATUS);
      return response.data;
    } catch (error) {
      console.error('Error fetching Hermes director status:', error);
      throw error;
    }
  }

  static async runHermesDirectorCommand(command, payload = {}) {
    try {
      const response = await apiClient.post(ENDPOINTS.HERMES_DIRECTOR_COMMAND, {
        command,
        payload,
      });
      return response.data;
    } catch (error) {
      console.error(`Error running Hermes command "${command}":`, error);
      throw error;
    }
  }

  static async updateHermesAlert(alertId, action, payload = {}) {
    try {
      const response = await apiClient.post(`/api/hermes/alerts/${encodeURIComponent(alertId)}/action`, {
        action,
        ...payload,
      });
      return response.data;
    } catch (error) {
      console.error(`Error updating Hermes alert ${alertId}:`, error);
      throw error;
    }
  }

  static async getHedgeyeEtfPro() {
    try {
      const response = await dedupedGet('/api/hedgeye/etfpro');
      return attachReferenceCacheMetadata(response);
    } catch (error) {
      console.error('Error fetching ETF Pro snapshot:', error);
      throw error;
    }
  }

  /** Save parsed ETF Pro rows (from browser xlsx) to server disk; same format as collect:etfpro */
  static async postHedgeyeEtfProSnapshot(payload) {
    const response = await apiClient.post('/api/hedgeye/etfpro', payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  }

  // Get historical price data for a symbol
  static async getHistoricalData(symbol, days = 30) {
    try {
      // Use query parameter to handle symbols with slashes (e.g., GBP/USD)
      const response = await dedupedGet('/api/usd/historical', {
        params: { symbol: symbol, days }
      });
      return response.data;
    } catch (error) {
      console.error(`Error fetching historical data for ${symbol}:`, error);
      throw error;
    }
  }

  // Get USD correlations for all securities
  static async getUsdCorrelations() {
    try {
      const response = await dedupedGet('/api/usd/correlations');
      return response.data;
    } catch (error) {
      console.error('Error fetching USD correlations:', error);
      throw error;
    }
  }

  // Get liquidity indicators (M3 proxy, Money Supply vs GDP)
  static async getLiquidityIndicators() {
    try {
      const response = await dedupedGet('/api/liquidity-indicators');
      return response.data;
    } catch (error) {
      console.error('Error fetching liquidity indicators:', error);
      throw error;
    }
  }

  // Get global and U.S. dollar liquidity models
  static async getDollarLiquidityModels() {
    try {
      const response = await dedupedGet('/api/liquidity-indicators');
      return response.data;
    } catch (error) {
      console.error('Error fetching dollar liquidity models:', error);
      throw error;
    }
  }

  // Get chart data for expanded market cards (OHLC, multiple time ranges)
  // Returns: { symbol, name, current, ohlc, chartData, meta }
  static async getChartData(symbol, range = '1d') {
    try {
      const response = await dedupedGet(`/api/chart-data/${encodeURIComponent(symbol)}`, {
        params: { range }
      });
      return response.data;
    } catch (error) {
      console.error(`Error fetching chart data for ${symbol}:`, error);
      throw error;
    }
  }
}
