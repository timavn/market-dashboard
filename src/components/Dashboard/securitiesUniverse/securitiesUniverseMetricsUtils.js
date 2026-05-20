import {
  formatPriceChange,
  getPriceChangeColor,
  formatZScore,
  getZScoreColor,
} from '../../../utils/securitiesUniverseUtils';

export function formatSecurityPrice(price, ticker) {
  if (price === null || price === undefined) return '--';
  const num = parseFloat(price);
  if (isNaN(num)) return '--';
  if (ticker?.startsWith('UST')) return `${num.toFixed(2)}%`;
  return num.toFixed(2);
}

export function getIvolPremColor(value) {
  if (value === null || value === undefined) return '#6b7280';
  if (value > 5) return '#ef4444';
  if (value < -2) return '#10b981';
  return '#f59e0b';
}

export function getTTMZScoreColor(value) {
  if (value === null || value === undefined) return '#6b7280';
  if (value < -0.5) return '#10b981';
  if (value > 0.5) return '#ef4444';
  return '#f59e0b';
}

export function getIOVRPercentileColor(value) {
  if (value === null || value === undefined) return '#6b7280';
  if (value < 30) return '#10b981';
  if (value > 70) return '#ef4444';
  return '#f59e0b';
}

export function formatVolatilityMetric(value, isPercentage = false) {
  if (value === null || value === undefined) return '--';
  if (isPercentage) return `${value}`;
  return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

export function getQuadColor(quadNum) {
  switch (quadNum) {
    case 1:
      return '#10b981';
    case 2:
      return '#34d399';
    case 3:
      return '#f59e0b';
    case 4:
      return '#ef4444';
    default:
      return '#6b7280';
  }
}

export function getRiskRangeColor(currentValue, previousValue, isFirstDay, ath = null, isHRR = false) {
  if (isFirstDay || previousValue === null || previousValue === undefined) {
    return '#6b7280';
  }
  if (currentValue === 0 && previousValue === 0) {
    return '#6b7280';
  }
  if (currentValue > previousValue) {
    if (isHRR && ath && ath > 0 && currentValue > ath) {
      return '#3b82f6';
    }
    return '#10b981';
  }
  if (currentValue < previousValue) {
    return '#ef4444';
  }
  return '#6b7280';
}

export function formatTradingDate(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function priceChangeToHex(colorName) {
  if (colorName === 'emerald') return '#10b981';
  if (colorName === 'red') return '#ef4444';
  return '#6b7280';
}

export {
  formatPriceChange,
  getPriceChangeColor,
  formatZScore,
  getZScoreColor,
};
