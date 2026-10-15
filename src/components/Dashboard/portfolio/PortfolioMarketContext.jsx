import React from 'react';
import PortfolioMetricCell from './PortfolioMetricCell';
import DelayedDataMarker from '../DelayedDataMarker';

// The position owner supplies validated display values and explanation callbacks.
// No provider rows, financial calculations, or freshness decisions belong here.
export default function PortfolioMarketContext({
  symbol,
  metrics,
  sizingVolatilityDisplay = null,
  volatilityReadings = [],
}) {
  return (
    <>
      <div className="pcv2-intel-grid pcv2-intel-header" aria-label="Market context headers">
        {['Price Z-score · 20D', 'Sizing vol', 'Relevant vol index', 'USD correlation', 'Stop loss'].map((label) => (
          <div className="pcv2-intel-cell pcv2-intel-span-4" key={label}>{label}</div>
        ))}
      </div>

      <div className="pcv2-intel-grid pcv2-intel-values pcv2-intel-context" aria-label={`${symbol} market context`}>
        <PortfolioMetricCell {...metrics.zScore} spanClassName="pcv2-intel-span-4" />
        <PortfolioMetricCell {...metrics.sizingVolatility} spanClassName="pcv2-intel-span-4">
          {sizingVolatilityDisplay ? (
            <span className="pcv2-sizing-vol-value">
              {sizingVolatilityDisplay.text}
              {sizingVolatilityDisplay.badge && (
                <span className={`pcv2-vol-badge ${sizingVolatilityDisplay.badge.className}`}>
                  {sizingVolatilityDisplay.badge.label}
                </span>
              )}
            </span>
          ) : null}
        </PortfolioMetricCell>
        <PortfolioMetricCell {...metrics.volatilityIndex} spanClassName="pcv2-intel-span-4">
          {volatilityReadings.length > 0 ? (
            <>
              {volatilityReadings.map((reading, index) => (
                <React.Fragment key={reading.key}>
                  {index > 0 ? ' · ' : null}
                  {reading.label} {reading.value}
                  <DelayedDataMarker {...reading.marker} />
                </React.Fragment>
              ))}
            </>
          ) : null}
        </PortfolioMetricCell>
        <PortfolioMetricCell {...metrics.usdCorrelation} spanClassName="pcv2-intel-span-4" />
        <PortfolioMetricCell {...metrics.stopLoss} spanClassName="pcv2-intel-span-4" />
      </div>
    </>
  );
}
