/**
 * Portfolio Performance Utilities and Mock Data
 *
 * This file contains data structures and helper functions for the 
 * Portfolio Performance dashboard. Once backend APIs provide these 
 * metrics, this file can act as a mapping layer.
 */

export const PERFORMANCE_DEFINITIONS = {
  annualizedReturn: {
    label: 'Annualized Return',
    definition: 'Compounded average yearly return over the selected period.'
  },
  standardDeviation: {
    label: 'Standard Deviation',
    definition: 'Volatility of returns; higher means returns varied more.'
  },
  maxDrawdown: {
    label: 'Max Drawdown',
    definition: 'Largest peak-to-trough decline during the period.'
  },
  sharpeRatio: {
    label: 'Sharpe Ratio',
    definition: 'Return earned per unit of total volatility, usually relative to a risk-free rate.'
  },
  sortinoRatio: {
    label: 'Sortino Ratio',
    definition: 'Return earned per unit of downside volatility.'
  },
  gainToPainRatio: {
    label: 'Gain to Pain Ratio',
    definition: 'Total gains divided by absolute total losses over the period.'
  },
  sp500Correlation: {
    label: 'S&P 500 Correlation',
    definition: 'How closely portfolio returns move with the S&P 500.'
  },
  sp500Beta: {
    label: 'S&P 500 Beta',
    definition: 'Sensitivity of the portfolio to S&P 500 moves.'
  },
  downsideDeviation: {
    label: 'Downside Deviation',
    definition: 'Volatility of negative returns only.'
  }
};

export const MOCK_PERFORMANCE_METRICS = [
  { key: 'annualizedReturn', group: 'return', value: 50.3, format: 'percent' },
  { key: 'standardDeviation', group: 'risk', value: 19.4, format: 'percent' },
  { key: 'maxDrawdown', group: 'risk', value: -15.7, format: 'percent' },
  { key: 'downsideDeviation', group: 'risk', value: 7.5, format: 'percent' },
  { key: 'sharpeRatio', group: 'riskAdjusted', value: 2.2, format: 'ratio' },
  { key: 'sortinoRatio', group: 'riskAdjusted', value: 5.7, format: 'ratio' },
  { key: 'gainToPainRatio', group: 'riskAdjusted', value: 4.4, format: 'ratio' },
  { key: 'sp500Correlation', group: 'benchmark', value: 0.12, format: 'ratio' },
  { key: 'sp500Beta', group: 'benchmark', value: 0.16, format: 'ratio' },
];

export const MOCK_MONTHLY_RETURNS = [
  { year: 2026, returns: [5.4, -2.1, 12.4, 4.5, null, null, null, null, null, null, null, null], total: 19.4, isYtd: true },
];

// Helper to generate a realistic looking equity curve and drawdown curve based on the monthly returns
export function generateMockChartData() {
  let equity = 10000;
  let peak = 10000;
  const chartData = [];

  for (const yearRow of MOCK_MONTHLY_RETURNS) {
    const year = yearRow.year;
    yearRow.returns.forEach((ret, index) => {
      if (ret === null) return;
      
      const monthDate = new Date(year, index, 28).toISOString().split('T')[0];
      equity = equity * (1 + ret / 100);
      
      if (equity > peak) {
        peak = equity;
      }
      
      const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;

      chartData.push({
        date: monthDate,
        equity: equity,
        drawdown: drawdown,
      });
    });
  }

  return chartData;
}

export const formatPerformanceValue = (value, format) => {
  if (value === null || value === undefined) return '–';
  
  if (format === 'percent') {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`;
  }
  
  if (format === 'ratio') {
    return value.toFixed(2);
  }
  
  return value.toString();
};

export const getMonthName = (index) => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[index];
};

export const getColorIntensity = (value) => {
  if (value === null || value === undefined) return '';
  
  // Calculate an opacity between 0.1 and 0.8 based on magnitude (cap at 20%)
  const magnitude = Math.min(Math.abs(value), 20);
  const opacity = 0.1 + (magnitude / 20) * 0.7;
  
  if (value > 0) {
    return `rgba(34, 197, 94, ${opacity})`; // Tailwind green-500
  } else if (value < 0) {
    return `rgba(239, 68, 68, ${opacity})`; // Tailwind red-500
  }
  return 'transparent';
};
