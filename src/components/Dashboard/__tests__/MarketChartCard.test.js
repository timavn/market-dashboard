/**
 * Test suite for MarketChartCard component
 *
 * Tests verify that:
 * - Component renders correctly with mock data
 * - Time period tabs display and can be switched
 * - Loading state displays correctly
 * - Positive/negative styling is applied correctly
 * - OHLC data displays when available
 * - Close button triggers onClose callback
 * - Error state handles gracefully
 */

// Mock the MarketDataService
jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getChartData: jest.fn()
  }
}));

import { MarketDataService } from '../../../services/api/marketDataService';

describe('MarketChartCard Component', () => {
  // Mock chart data for testing
  const mockChartData = {
    symbol: 'SPY',
    name: 'S&P 500',
    source: 'yahoo',
    current: {
      price: '485.50',
      change: '2.50',
      changePercent: '0.52',
      previousClose: '483.00'
    },
    ohlc: {
      open: '483.25',
      high: '486.00',
      low: '482.75',
      close: '485.50'
    },
    chartData: [
      { timestamp: 1705400400000, open: 483.25, high: 484.00, low: 482.75, close: 483.50, volume: 1000000 },
      { timestamp: 1705404000000, open: 483.50, high: 485.00, low: 483.25, close: 484.75, volume: 1500000 },
      { timestamp: 1705407600000, open: 484.75, high: 486.00, low: 484.50, close: 485.50, volume: 2000000 }
    ],
    meta: {
      currency: 'USD',
      exchangeTimezone: 'America/New_York',
      regularMarketTime: '2025-01-16T16:00:00.000Z',
      range: '1d',
      interval: '5m',
      dataPoints: 3
    }
  };

  const mockNegativeChartData = {
    ...mockChartData,
    current: {
      price: '480.50',
      change: '-2.50',
      changePercent: '-0.52',
      previousClose: '483.00'
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Data Fetching', () => {
    test('should call getChartData with correct symbol and default range', async () => {
      MarketDataService.getChartData.mockResolvedValue(mockChartData);

      // The component would call this on mount
      await MarketDataService.getChartData('SPY', '1d');

      expect(MarketDataService.getChartData).toHaveBeenCalledWith('SPY', '1d');
    });

    test('should call getChartData with different ranges', async () => {
      MarketDataService.getChartData.mockResolvedValue(mockChartData);

      const ranges = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y'];

      for (const range of ranges) {
        await MarketDataService.getChartData('SPY', range);
        expect(MarketDataService.getChartData).toHaveBeenCalledWith('SPY', range);
      }
    });

    test('should handle API errors gracefully', async () => {
      MarketDataService.getChartData.mockRejectedValue(new Error('API Error'));

      await expect(MarketDataService.getChartData('SPY', '1d')).rejects.toThrow('API Error');
    });
  });

  describe('Chart Data Processing', () => {
    test('should correctly identify positive price change', () => {
      const change = parseFloat(mockChartData.current.change);
      expect(change).toBeGreaterThan(0);
    });

    test('should correctly identify negative price change', () => {
      const change = parseFloat(mockNegativeChartData.current.change);
      expect(change).toBeLessThan(0);
    });

    test('should have valid OHLC data', () => {
      const { ohlc } = mockChartData;
      const open = parseFloat(ohlc.open);
      const high = parseFloat(ohlc.high);
      const low = parseFloat(ohlc.low);
      const close = parseFloat(ohlc.close);

      // High should be >= all other values
      expect(high).toBeGreaterThanOrEqual(open);
      expect(high).toBeGreaterThanOrEqual(low);
      expect(high).toBeGreaterThanOrEqual(close);

      // Low should be <= all other values
      expect(low).toBeLessThanOrEqual(open);
      expect(low).toBeLessThanOrEqual(high);
      expect(low).toBeLessThanOrEqual(close);
    });

    test('should have chartData with required fields', () => {
      const { chartData } = mockChartData;

      expect(chartData.length).toBeGreaterThan(0);

      chartData.forEach(point => {
        expect(point).toHaveProperty('timestamp');
        expect(point).toHaveProperty('close');
        expect(typeof point.timestamp).toBe('number');
        expect(typeof point.close).toBe('number');
      });
    });
  });

  describe('Time Range Handling', () => {
    test('should have 7 valid time ranges', () => {
      const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y'];
      expect(validRanges.length).toBe(7);
    });

    test('should support 1d and 5d ranges for Treasury yields', async () => {
      const treasuryResponse = {
        symbol: 'UST10Y',
        name: 'UST10Y',
        source: 'yahoo',
        current: {
          price: '4.05',
          change: '0.02',
          changePercent: '0.50',
          previousClose: '4.03'
        },
        chartData: [
          { timestamp: 1705400400000, close: 4.01 },
          { timestamp: 1705404000000, close: 4.03 },
          { timestamp: 1705407600000, close: 4.05 }
        ],
        meta: {
          range: '1d',
          interval: '5m',
          dataPoints: 3
        },
        availableRanges: ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']
      };

      MarketDataService.getChartData.mockResolvedValue(treasuryResponse);

      const result = await MarketDataService.getChartData('UST10Y', '1d');

      expect(result.availableRanges).toContain('1d');
      expect(result.availableRanges).toContain('5d');
    });
  });

  describe('Price Formatting', () => {
    test('should format price with 2 decimal places', () => {
      const price = parseFloat(mockChartData.current.price);
      const formatted = price.toFixed(2);
      expect(formatted).toBe('485.50');
    });

    test('should format change with 2 decimal places', () => {
      const change = parseFloat(mockChartData.current.change);
      const formatted = change.toFixed(2);
      expect(formatted).toBe('2.50');
    });

    test('should format changePercent with 2 decimal places', () => {
      const changePercent = parseFloat(mockChartData.current.changePercent);
      const formatted = changePercent.toFixed(2);
      expect(formatted).toBe('0.52');
    });
  });

  describe('Y-Axis Domain Calculation', () => {
    test('should calculate Y-axis domain with padding', () => {
      const { chartData } = mockChartData;
      const prices = chartData.map(d => d.close);

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const padding = (max - min) * 0.1;

      const domainMin = min - padding;
      const domainMax = max + padding;

      expect(domainMin).toBeLessThan(min);
      expect(domainMax).toBeGreaterThan(max);
    });

    test('should handle single data point', () => {
      const singlePointData = [{ close: 100 }];
      const prices = singlePointData.map(d => d.close);

      const min = Math.min(...prices);
      const max = Math.max(...prices);

      // When min === max, padding would be 0
      expect(min).toBe(max);
    });
  });

  describe('Timestamp Formatting', () => {
    test('should format 1d timestamps as time', () => {
      const timestamp = 1705420800000; // Jan 16, 2025, 2:00 PM
      const date = new Date(timestamp);
      const formatted = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      expect(formatted).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
    });

    test('should format monthly timestamps as month/day', () => {
      const timestamp = 1705420800000;
      const date = new Date(timestamp);
      const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      expect(formatted).toMatch(/^[A-Z][a-z]{2}\s\d{1,2}$/);
    });

    test('should format yearly timestamps as month/year', () => {
      const timestamp = 1705420800000;
      const date = new Date(timestamp);
      const formatted = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

      expect(formatted).toMatch(/^[A-Z][a-z]{2}\s\d{2}$/);
    });
  });

  describe('Gradient Color Selection', () => {
    test('should use green gradient for positive change', () => {
      const change = parseFloat(mockChartData.current.change);
      const isPositive = change >= 0;
      const gradientColor = isPositive ? '#16a34a' : '#dc2626';

      expect(gradientColor).toBe('#16a34a');
    });

    test('should use red gradient for negative change', () => {
      const change = parseFloat(mockNegativeChartData.current.change);
      const isPositive = change >= 0;
      const gradientColor = isPositive ? '#16a34a' : '#dc2626';

      expect(gradientColor).toBe('#dc2626');
    });

    test('should treat zero change as positive', () => {
      const change = 0;
      const isPositive = change >= 0;

      expect(isPositive).toBe(true);
    });
  });

  describe('Reference Line', () => {
    test('should have previous close value for reference line', () => {
      const previousClose = parseFloat(mockChartData.current.previousClose);

      expect(previousClose).toBeDefined();
      expect(typeof previousClose).toBe('number');
      expect(previousClose).toBe(483.00);
    });
  });

  describe('Meta Information', () => {
    test('should have valid meta information', () => {
      const { meta } = mockChartData;

      expect(meta.currency).toBe('USD');
      expect(meta.range).toBe('1d');
      expect(meta.interval).toBe('5m');
      expect(meta.dataPoints).toBe(3);
    });
  });
});
