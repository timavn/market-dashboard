import axios from 'axios';
import { API_BASE_URL, ENDPOINTS, EXTERNAL_APIS } from '../../constants/apiEndpoints';
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
  static async getPortfolio(snapshotId = null) {
    try {
      const params = snapshotId ? { snapshotId } : {};
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
            positionCount: data.summary.positionCount || 0
          },
          assetAllocation: data.assetAllocation || {},
          holdings: data.holdings || [],
          topHoldings: data.topHoldings || [],
          lastUpdated: data.lastUpdated || new Date().toLocaleString(),
          
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
            marketCap: {
              largeCap: '75.0%',
              midCap: '20.0%',
              smallCap: '5.0%'
            },
            sectors: {
              technology: '35.0%',
              healthcare: '15.0%',
              financials: '12.0%',
              consumer: '18.0%',
              energy: '8.0%'
            },
            geographic: {
              northAmerica: '80.0%',
              europe: '12.0%',
              asiaPacific: '6.0%',
              emergingMarkets: '2.0%'
            }
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
}