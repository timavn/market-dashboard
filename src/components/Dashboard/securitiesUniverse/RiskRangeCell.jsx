import React from 'react';
import { TRADING_DAY_LABELS, buildTradingDays } from '../../../utils/enrichSecurity';
import { getRiskRangeColor, formatTradingDate } from './securitiesUniverseMetricsUtils';

function formatClosingPrice(price) {
  if (price === null || price === undefined || price === 0) return '--';
  if (Math.abs(price) >= 1000) return price.toFixed(0);
  return price.toFixed(2);
}

function formatRangeValue(value) {
  if (value === null || value === undefined || value === 0) return '--';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(2);
}

function RiskRangeCell({ riskRangeHistory, tradingDays: tradingDaysProp }) {
  const tradingDays = tradingDaysProp || buildTradingDays();
  const dayLabels = TRADING_DAY_LABELS;

  const { hrr, lrr, ath, prices } = riskRangeHistory || {};
  const lastIndex = dayLabels.length - 1;

  const closingPrices =
    Array.isArray(prices) && prices.length > 0
      ? prices.map(p => (p > 0 ? parseFloat(p) : null))
      : Array(10).fill(null);

  const cellWidth = '42px';
  const lastCellWidth = '46px';
  const cellStyle = (index, color = '#6b7280') => ({
      width: index === lastIndex ? lastCellWidth : cellWidth,
      textAlign: 'center',
      fontSize: '9px',
      borderRight: index < lastIndex ? '1px solid #e5e7eb' : 'none', // Vertical divider
      padding: '0 2px',
      color: color,
      fontWeight: 600,
      backgroundColor: index === lastIndex ? '#eff6ff' : 'transparent', // Highlight 't' column
      borderRadius: index === lastIndex ? '4px' : '0'
  });

  if (!hrr || !lrr) {
    return <span className="su-metrics-muted">--</span>;
  }

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '9px' }}>
        {/* ATH Row — above current day (t) column; plain "ATH: value" text only */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <span style={{ width: '28px' }} />
          <div style={{ display: 'flex' }}>
            {dayLabels.map((_, index) => (
              <div
                key={`ath-${index}`}
                style={{
                  width: index === lastIndex ? lastCellWidth : cellWidth,
                  textAlign: 'center',
                  borderRight: index < lastIndex ? '1px solid #e5e7eb' : 'none',
                  padding: '0 2px',
                  fontSize: '8px',
                  color: '#6b7280',
                  lineHeight: 1.2
                }}
              >
                {index === lastIndex
                  ? `ATH: ${ath > 0 ? ath.toFixed(2) : '--'}`
                  : null}
              </div>
            ))}
          </div>
        </div>
        {/* Day Labels Row (date + t label stacked) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <span style={{ width: '28px' }}></span>
          <div style={{ display: 'flex' }}>
            {dayLabels.map((label, index) => (
              <div
                key={`label-${index}`}
                style={{
                  width: index === lastIndex ? lastCellWidth : cellWidth,
                  textAlign: 'center',
                  borderRight: index < lastIndex ? '1px solid transparent' : 'none',
                  padding: '0 2px'
                }}
              >
                {/* Date line above t-label */}
                <div
                  style={{
                    width: '100%',
                    fontSize: '9px',
                    fontWeight: 'normal',
                    color: index === lastIndex ? '#1e40af' : '#6b7280',
                    lineHeight: '1.2',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {tradingDays[index]
                    ? tradingDays[index].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : ''}
                </div>
                {/* t / t-1 / t-2 etc. label */}
                <div
                  style={{
                    width: '100%',
                    position: 'relative',
                    backgroundColor: index === lastIndex ? '#f3f4f6' : '#f9fafb',
                    fontWeight: index === lastIndex ? 'bold' : 'normal',
                    color: index === lastIndex ? '#1e40af' : '#6b7280'
                  }}
                  title={formatTradingDate(tradingDays[index])}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* HRR Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <span style={{ width: '28px', color: '#6b7280', fontWeight: 500, fontSize: '8px' }}>HRR</span>
          <div style={{ display: 'flex' }}>
            {hrr.map((value, index) => (
              <span
                key={`hrr-${index}`}
                style={cellStyle(index, getRiskRangeColor(value, index > 0 ? hrr[index - 1] : null, index === 0, ath, true))}
                title={`${value}${ath && value > ath ? ' (New ATH!)' : ''}`}
              >
                {formatRangeValue(value)}
              </span>
            ))}
          </div>
        </div>
        {/* Closing Prices Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <span style={{ width: '28px', color: '#6b7280', fontWeight: 500, fontSize: '8px' }}>Price</span>
          <div style={{ display: 'flex' }}>
            {closingPrices.map((price, index) => (
              <span
                key={`price-${index}`}
                style={{
                  ...cellStyle(index, price !== null ? '#374151' : '#9ca3af'),
                  fontWeight: 600
                }}
              >
                {formatClosingPrice(price)}
              </span>
            ))}
          </div>
        </div>
        {/* LRR Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          <span style={{ width: '28px', color: '#6b7280', fontWeight: 500, fontSize: '8px' }}>LRR</span>
          <div style={{ display: 'flex' }}>
            {lrr.map((value, index) => (
              <span
                key={`lrr-${index}`}
                style={cellStyle(index, getRiskRangeColor(value, index > 0 ? lrr[index - 1] : null, index === 0))}
              >
                {formatRangeValue(value)}
              </span>
            ))}
          </div>
        </div>
      </div>
    );

}

export default RiskRangeCell;
