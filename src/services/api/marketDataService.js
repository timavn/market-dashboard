import axios from 'axios';
import { ENDPOINTS, EXTERNAL_APIS } from '../../constants/apiEndpoints';
import { PortfolioAnalytics } from '../portfolioAnalytics';

// Create axios instance with default config
// Use full URL to bypass proxy issues in development
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const apiClient = axios.create({
  baseURL: backendUrl,
  timeout: 60000, // 60 seconds - increased for large quote requests (111 symbols)
  headers: {
    'Content-Type': 'application/json',
  },
});

// Market Data Service
export class MarketDataService {
  static async getProviderStatus() {
    try {
      const response = await apiClient.get(ENDPOINTS.PROVIDERS_STATUS);
      return response.data;
    } catch (error) {
      console.error('Error fetching provider status:', error);
      throw error;
    }
  }

  // Get real-time quotes
  static async getQuotes(symbols) {
    try {
      const response = await apiClient.get(ENDPOINTS.QUOTES, {
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
      const response = await apiClient.get(ENDPOINTS.PORTFOLIO, { params });
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
            totalDayChange: data.summary.totalDayChange || 0,
            totalDayChangePercent: data.summary.totalDayChangePercent || '0.00',
            totalGainLoss: data.summary.totalGainLoss || 0,
            totalGainLossPercent: data.summary.totalGainLossPercent || '0.00',
            positionCount: data.summary.positionCount || 0,
            longCount: data.summary.longCount || 0,
            shortCount: data.summary.shortCount || 0,
          },
          assetAllocation: data.assetAllocation || {},
          holdings: data.holdings || [],
          topHoldings: data.topHoldings || [],
          lastUpdated: data.lastUpdated || new Date().toLocaleString(),
          dataSource: data.dataSource || null,
          accountSummary: data.accountSummary || null,
          accountId: data.accountId || null,
          empty: Boolean(data.empty),
          reconciliationWarnings: data.reconciliationWarnings || [],

          // Mock analytics for local development
          riskMetrics: {
            volatility: '18.75%',
            sharpeRatio: '-0.13',
            sortinoRatio: '-0.02',
            var95: '$5571',
            maxDrawdown: '0.00%'
          },
          exposureMetrics: {
            grossExposure: '100.0%',
            netLongExposure: '100.0%',
            netShortExposure: '0.0%',
            netExposure: '100.0%'
          },
          concentrationMetrics: {
            top10HoldingsPercent: '65.2%',
            largestPositionPercent: '18.2%',
            hhiIndex: '0.15'
          },
          factorExposures: {
            'Momentum': { long: '18.5%', short: '8.2%' },
            'Value': { long: '12.4%', short: '15.1%' },
            'Quality': { long: '22.1%', short: '5.4%' },
            'Volatility': { long: '5.2%', short: '12.8%' },
            'Growth': { long: '28.4%', short: '10.2%' },
            'Size': { long: '8.5%', short: '2.1%' },
            'Liquidity': { long: '15.8%', short: '3.5%' },
            'Carry': { long: '10.2%', short: '4.8%' },
            'Crowding': { long: '4.5%', short: '14.2%' }
          }
        };
      }

      return portfolioData;
    } catch (error) {
      console.error('Error fetching portfolio:', error);
      throw error;
    }
  }

  // Get options chain
  static async getOptionsChain(symbol, expiration = null) {
    try {
      const params = { symbol };
      if (expiration) params.expiration = expiration;

      const response = await apiClient.get(ENDPOINTS.OPTIONS_CHAIN, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching options chain:', error);
      throw error;
    }
  }

  // Get VIX data
  static async getVIXData() {
    try {
      const response = await apiClient.get(ENDPOINTS.VIX);
      return response.data;
    } catch (error) {
      console.error('Error fetching VIX data:', error);
      throw error;
    }
  }

  // Get macro indicators (DXY, GLD, UST10Y, CRB, WTI, SPY, QQQ, IWM)
  static async getMacroIndicators() {
    try {
      const response = await apiClient.get('/api/macro-indicators');
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

      const response = await apiClient.get('/api/multi-region-quotes', { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching multi-region quotes:', error);
      throw error;
    }
  }

  // Get volume data
  static async getVolumeData(symbols) {
    try {
      const response = await apiClient.get(ENDPOINTS.VOLUME, {
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
      const response = await apiClient.get(ENDPOINTS.MARKET_SHARE_VOLUME, {
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
      const response = await apiClient.get('/api/securities/signal-strength');
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
      const response = await apiClient.get(ENDPOINTS.RISK_RANGES, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching risk ranges:', error);
      throw error;
    }
  }

  // Get risk range history for a specific ticker
  static async getRiskRangeHistory(ticker, limit = 30) {
    try {
      const response = await apiClient.get('/api/risk-ranges/history', {
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
      const response = await apiClient.get('/api/risk-ranges/history-all');
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
      const response = await apiClient.get(
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
      const response = await apiClient.get('/api/hedgeye/freshness');
      return response.data;
    } catch (error) {
      console.error('Error fetching Hedgeye freshness:', error);
      throw error;
    }
  }

  static async getHedgeyeEtfPro() {
    try {
      const response = await apiClient.get('/api/hedgeye/etfpro');
      return response.data;
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
      const response = await apiClient.get('/api/usd/historical', {
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
      const response = await apiClient.get('/api/usd/correlations');
      return response.data;
    } catch (error) {
      console.error('Error fetching USD correlations:', error);
      throw error;
    }
  }

  // Get liquidity indicators (M3 proxy, Money Supply vs GDP)
  static async getLiquidityIndicators() {
    try {
      const response = await apiClient.get('/api/liquidity-indicators');
      return response.data;
    } catch (error) {
      console.error('Error fetching liquidity indicators:', error);
      throw error;
    }
  }

  // Get chart data for expanded market cards (OHLC, multiple time ranges)
  // Returns: { symbol, name, current, ohlc, chartData, meta }
  static async getChartData(symbol, range = '1d') {
    try {
      const response = await apiClient.get(`/api/chart-data/${encodeURIComponent(symbol)}`, {
        params: { range }
      });
      return response.data;
    } catch (error) {
      console.error(`Error fetching chart data for ${symbol}:`, error);
      throw error;
    }
  }
}
