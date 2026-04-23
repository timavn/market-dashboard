// Performance Tracking Service
import axios from 'axios';
import { ENDPOINTS } from '../../constants/apiEndpoints';

// Use same backend URL pattern as marketDataService
const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const apiClient = axios.create({
  baseURL: backendUrl,
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
});

class PerformanceService {
  /**
   * Get performance history
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {number} limit - Limit number of records
   * @returns {Promise<Object>} Performance history data
   */
  static async getPerformanceHistory(startDate = null, endDate = null, limit = null) {
    try {
      const params = {};
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      if (limit) params.limit = limit;

      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_HISTORY, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching performance history:', error);
      throw error;
    }
  }

  /**
   * Get performance metrics for a specific period
   * @param {string} period - Period type ('30d', '90d', '1y', 'all')
   * @returns {Promise<Object>} Performance metrics
   */
  static async getPerformanceMetrics(period = 'all') {
    try {
      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_METRICS, {
        params: { period }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching performance metrics:', error);
      throw error;
    }
  }

  /**
   * Get position-level performance
   * @param {string} symbol - Security symbol
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Object>} Position performance data
   */
  static async getPositionPerformance(symbol, startDate = null, endDate = null) {
    try {
      const params = { symbol };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_POSITIONS, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching position performance:', error);
      throw error;
    }
  }

  /**
   * Get benchmark comparison
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @param {string[]} benchmarks - Array of benchmark symbols (default: ['SPY', 'QQQ'])
   * @returns {Promise<Object>} Benchmark comparison data
   */
  static async getBenchmarkComparison(startDate = null, endDate = null, benchmarks = ['SPY', 'QQQ']) {
    try {
      const params = {
        benchmarks: benchmarks.join(',')
      };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_BENCHMARK, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching benchmark comparison:', error);
      throw error;
    }
  }

  /**
   * Get equity curve with drawdowns
   * @returns {Promise<Object>} Equity curve data
   */
  static async getEquityCurve() {
    try {
      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_EQUITY_CURVE);
      return response.data;
    } catch (error) {
      console.error('Error fetching equity curve:', error);
      throw error;
    }
  }

  /**
   * Get list of all statement dates (archive)
   * @returns {Promise<Object>} List of statements with dates
   */
  static async getStatements() {
    try {
      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_STATEMENTS);
      return response.data;
    } catch (error) {
      console.error('Error fetching statements:', error);
      throw error;
    }
  }

  /**
   * Get statement data for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise<Object>} Statement data for the date
   */
  static async getStatementByDate(date) {
    try {
      const response = await apiClient.get(`${ENDPOINTS.PERFORMANCE_STATEMENT}/${date}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching statement:', error);
      throw error;
    }
  }

  /**
   * Realized gain/loss lot details for bubble chart
   * @param {string} period - 'all' | 'ytd' | '1y' | '90d' | '30d'
   * @param {string} symbol - optional ticker filter
   */
  static async getRealizedGainLoss(period = 'all', symbol = '') {
    try {
      const params = { period };
      if (symbol && symbol.trim()) params.symbol = symbol.trim();
      const response = await apiClient.get(ENDPOINTS.PERFORMANCE_REALIZED_GAIN_LOSS, { params });
      return response.data;
    } catch (error) {
      console.error('Error fetching realized gain/loss:', error);
      throw error;
    }
  }
}

export default PerformanceService;

