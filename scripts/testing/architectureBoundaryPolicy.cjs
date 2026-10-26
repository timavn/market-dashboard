'use strict';

const roles = {};
function group(directory, role, names) {
  for (const name of names.trim().split(/\s+/)) roles[`${directory}/${name}`] = role;
}

const portfolio = 'src/components/Dashboard/portfolio';
group(portfolio, 'pure', `
  betaPresentation.js leveragedProductPresentation.js portfolioPositionsModel.js portfolioResearchRows.js
  sizingVolatilityPresentation.js stopLossPresentation.js usdCorrelationPresentation.js
`);
group(portfolio, 'view', `
  LeveragedProductsCell.jsx PortfolioDecisionMetrics.jsx PortfolioMarketContext.jsx PortfolioMetricCell.jsx
  PortfolioMetricVerificationModal.jsx PortfolioPositionsCard.jsx PortfolioResearchHistory.jsx
  PortfolioResearchPanel.jsx PortfolioResearchProducts.jsx
`);
// The overlap modal and positions interactions intentionally own local hooks; only directional checks apply.
group(portfolio, 'mixed', 'LeveragedProductModal.jsx usePortfolioPositions.js');

group('src/hooks', 'resource', `
  useDashboardPortfolio.js useDashboardOverviewResources.js useDashboardEtfProResource.js
  useDashboardChangelog.js
  usePortfolioResearch.js usePortfolioMarketContext.js
`);
group('src/hooks', 'mixed', 'useDashboardWorkspaceState.js useDashboardPanelResize.js');
group('src/constants', 'pure', 'dashboardResourceTiming.js dashboardWorkspace.js');
group('src/utils', 'pure', 'dashboardWorkspaceState.js dashboardReferenceProjection.js dashboardMarketPeriods.js');
group('src/components/Dashboard/workspace', 'view', `
  DashboardBalancePanel.jsx DashboardBookReader.jsx
  DashboardPerformancePanel.jsx DashboardPortfolioPanel.jsx DashboardExposurePanel.jsx
  DashboardAnalystPanel.jsx DashboardSignalStrengthPanel.jsx
  DashboardEtfProPanel.jsx DashboardMacroShowPanel.jsx DashboardCallPanel.jsx
  DashboardSystemPanel.jsx DashboardWorkflowPanel.jsx
`);
group('src/routes', 'handler', 'referenceHandlers.cjs volatilityHandlers.cjs correlationHandlers.cjs currencyPairsHandler.cjs');

module.exports = {
  roles,
  orchestrators: [
    'src/components/Dashboard/PortfolioBreakdown.jsx',
    'src/components/Dashboard/PortfolioDashboard.jsx',
    'server.js',
  ],
};
