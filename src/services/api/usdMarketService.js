import axios from 'axios';

// Create axios instance with default config
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const apiClient = axios.create({
  baseURL: backendUrl,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// USD Market Data Service
export class USDMarketService {
  // Get latest DXY value with change
  static async getDXY() {
    try {
      const response = await apiClient.get('/api/usd/dxy');
      return response.data;
    } catch (error) {
      console.error('Error fetching DXY data:', error);
      throw error;
    }
  }

  // Get currency pairs
  static async getCurrencyPairs() {
    try {
      const response = await apiClient.get('/api/usd/currency-pairs');
      return response.data;
    } catch (error) {
      console.error('Error fetching currency pairs:', error);
      throw error;
    }
  }

  // Get USD correlations
  static async getCorrelations() {
    try {
      const response = await apiClient.get('/api/usd/correlations');
      return response.data;
    } catch (error) {
      console.error('Error fetching correlation data:', error);
      throw error;
    }
  }

  // Get historical price data for a symbol
  static async getHistoricalData(symbol, days = 30) {
    try {
      const response = await apiClient.get(`/api/usd/historical/${symbol}`, {
        params: { days }
      });
      return response.data;
    } catch (error) {
      console.error(`Error fetching historical data for ${symbol}:`, error);
      throw error;
    }
  }

  // Get all USD market data (combined call for dashboard)
  static async getAllUSDData() {
    try {
      const [dxy, currencyPairs, correlations] = await Promise.all([
        this.getDXY(),
        this.getCurrencyPairs(),
        this.getCorrelations()
      ]);

      return {
        dxy,
        currencyPairs,
        correlations,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching USD market data:', error);
      throw error;
    }
  }
}

// Helper functions for correlation display
export const CorrelationHelpers = {
  // Get color class based on correlation value
  getCorrelationColor(correlation) {
    if (correlation === null || correlation === undefined) return 'neutral';
    
    const value = parseFloat(correlation);
    if (value > 0.3) return 'positive-strong';
    if (value > 0.1) return 'positive-weak';
    if (value > -0.1) return 'neutral';
    if (value > -0.3) return 'negative-weak';
    if (value > -0.6) return 'negative-medium';
    return 'negative-strong';
  },

  // Format correlation value for display
  formatCorrelation(correlation) {
    if (correlation === null || correlation === undefined) return '--';
    return parseFloat(correlation).toFixed(2);
  },

  // Format percentage for display
  formatPercentage(value) {
    if (value === null || value === undefined) return '--';
    return `${value}%`;
  },

  // Get change color class
  getChangeColor(change) {
    if (!change) return 'neutral';
    const value = parseFloat(change);
    return value >= 0 ? 'positive' : 'negative';
  },

  // Format change for display
  formatChange(change) {
    if (!change) return '0.00';
    const value = parseFloat(change);
    return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
  },

  // Format change percentage for display
  formatChangePercent(changePercent) {
    if (!changePercent) return '0.00%';
    const value = parseFloat(changePercent);
    return value >= 0 ? `+${value.toFixed(2)}%` : `${value.toFixed(2)}%`;
  }
};

export default USDMarketService;
