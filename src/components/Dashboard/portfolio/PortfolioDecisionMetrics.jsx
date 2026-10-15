import React from 'react';
import PortfolioMetricCell from './PortfolioMetricCell';
import LeveragedProductsCell from './LeveragedProductsCell';

// The parent prepares validated values, provenance, tones, and modal payloads.
// This section owns layout only; it never fetches, retains, or calculates data.
export default function PortfolioDecisionMetrics({
  symbol,
  metrics,
  quadRanking = null,
  onExplainBeta,
  onExplainQuad,
  onSelectLeveragedProduct,
}) {
  return (
    <>
      <div className="pcv2-intel-grid pcv2-intel-header" aria-label="Decision intelligence headers">
        {['Tick', 'Trade', 'Trend', 'Beta', 'Factor Ctrb', 'Quad +EV'].map((label, index) => (
          <div className={`pcv2-intel-cell pcv2-intel-span-${index < 4 ? 3 : 4}`} key={label}>
            {label === 'Beta' ? (
              <button
                type="button"
                className="pcv2-intel-header-button"
                aria-label={`Explain ${symbol} beta calculation`}
                title="Click for beta calculation and a plain-English takeaway"
                onClick={onExplainBeta}
              >
                {label}
              </button>
            ) : label === 'Quad +EV' ? (
              <button
                type="button"
                className="pcv2-intel-header-button"
                aria-label={`Explain ${symbol} quad ranking`}
                title="Click for the primary factor, chart ranks, and a plain-English takeaway"
                onClick={onExplainQuad}
              >
                {label}
              </button>
            ) : label}
          </div>
        ))}
      </div>

      <div className="pcv2-intel-grid pcv2-intel-values" aria-label={`${symbol} decision intelligence`}>
        {['tick', 'trade', 'trend', 'beta', 'factorContribution'].map((key, index) => (
          <PortfolioMetricCell key={key} {...metrics[key]} spanClassName={`pcv2-intel-span-${index < 4 ? 3 : 4}`} />
        ))}
        <PortfolioMetricCell {...metrics.quad} spanClassName="pcv2-intel-span-4">
          {quadRanking ? (
            <span className="pcv2-intel-quad-order" aria-label={`Quad order ${quadRanking.orderText}`}>
              {quadRanking.groups.map((group, groupIndex) => (
                <React.Fragment key={group[0].quad}>
                  {groupIndex > 0 && <span className="pcv2-intel-quad-arrow">›</span>}
                  {group.map((fit, index) => (
                    <React.Fragment key={fit.quad}>
                      {index > 0 && <span className="pcv2-intel-quad-arrow">=</span>}
                      <span className={`pcv2-intel-quad is-q${fit.quad}`}>{fit.quad}</span>
                    </React.Fragment>
                  ))}
                </React.Fragment>
              ))}
            </span>
          ) : null}
        </PortfolioMetricCell>
      </div>

      <div
        className="pcv2-intel-grid pcv2-intel-header"
        aria-label="Decision intelligence secondary headers"
      >
        {['Levered products', 'Signal strength', 'LRR', 'HRR', 'Other exposure', 'Coverage'].map((label) => (
          <div
            className={`pcv2-intel-cell pcv2-intel-span-${['LRR', 'HRR'].includes(label) ? 2 : 4}`}
            key={label}
            title={label === 'LRR' ? 'Low price risk range' : label === 'HRR' ? 'High price risk range' : undefined}
          >
            {label}
          </div>
        ))}
      </div>

      <div
        className="pcv2-intel-grid pcv2-intel-values"
        aria-label={`${symbol} supplemental decision intelligence`}
      >
        <LeveragedProductsCell symbol={symbol} onSelect={onSelectLeveragedProduct} />
        {['signal', 'lowRange', 'highRange', 'otherExposure', 'coverage'].map((key) => (
          <PortfolioMetricCell
            key={key}
            {...metrics[key]}
            spanClassName={`pcv2-intel-span-${['lowRange', 'highRange'].includes(key) ? 2 : 4}`}
          />
        ))}
      </div>
    </>
  );
}
