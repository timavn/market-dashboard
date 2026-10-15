import React from 'react';
import PortfolioDecisionMetrics from './PortfolioDecisionMetrics';
import PortfolioMarketContext from './PortfolioMarketContext';
import PortfolioResearchProducts from './PortfolioResearchProducts';
import PortfolioResearchHistory from './PortfolioResearchHistory';

// Compose prepared display data only. The position owner retains validation,
// calculations, modal selection, and product-expansion state.
export default function PortfolioResearchPanel({ rowId, symbol, model, expandedProducts, actions }) {
  return (
    <div
      className="pcv2-intel-panel"
      id={`portfolio-research-${rowId}`}
      aria-label={`Research intelligence for ${symbol}`}
      data-health-status={model.healthStatus || undefined}
      aria-busy={model.busy}
    >
      <PortfolioDecisionMetrics
        symbol={symbol}
        metrics={model.decision.metrics}
        quadRanking={model.decision.quadRanking}
        onExplainBeta={actions.onExplainBeta}
        onExplainQuad={actions.onExplainQuad}
        onSelectLeveragedProduct={actions.onSelectLeveragedProduct}
      />

      <PortfolioMarketContext
        symbol={symbol}
        metrics={model.marketContext.metrics}
        sizingVolatilityDisplay={model.marketContext.sizingVolatilityDisplay}
        volatilityReadings={model.marketContext.volatilityReadings}
      />

      <PortfolioResearchProducts
        rowId={rowId}
        symbol={symbol}
        rows={model.products.rows}
        loading={model.products.loading}
        expandedProducts={expandedProducts}
        onToggleProduct={actions.onToggleProduct}
      />

      <PortfolioResearchHistory
        rowId={rowId}
        rows={model.history.rows}
        historyDays={model.history.historyDays}
        loading={model.history.loading}
        error={model.history.error}
      />
    </div>
  );
}
