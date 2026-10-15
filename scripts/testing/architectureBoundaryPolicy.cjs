'use strict';

const roles = {};
function group(directory, role, names) {
  for (const name of names.trim().split(/\s+/)) roles[`${directory}/${name}`] = role;
}

const monitor = 'src/components/Dashboard/predictionMonitor';
group(monitor, 'pure', `
  chartLabelLayout.js contractLadderGeometry.js contractLadderPresentation.js
  contractReferenceValidation.js contractTradingClock.js cpiForecastContext.js
  cpiForecastValues.js goldContextValidation.js goldCorrelationContext.js
  goldSettlementReferences.js headerMarketReferences.js marketUi.js momoTrackerContext.js
  monitorFormatting.js monitorNumbers.js monitorSectionValidation.js predictionPositionOverlay.js
  proxyFitPresentation.js riskRangeChartAxes.js riskRangeChartSessions.js riskRangeStructure.js
  settlementIdentity.js
`);
group(monitor, 'view', `
  ContractLadder.jsx CpiForecastBoard.jsx CpiForecastComparisonPanel.jsx CpiForecastDetails.jsx
  CpiReleaseSetup.jsx CpiSourceMonitor.jsx FactorMonitor.jsx GenericFactorMonitor.jsx
  GoldCorrelationPanel.jsx HeaderMarketStrip.jsx MomoTrackerPanel.jsx ProxyFitPanel.jsx
  PythTrackingPanel.jsx RiskRangeChartAnnotations.jsx SettlementIdentityChips.jsx
  SpxRiskRangeChart.jsx factorPresentation.jsx useRiskRangeChartPlot.jsx
`);
// The chart model owns React memoization and view-model work; do not impose a pure-function policy on it.
group(monitor, 'mixed', 'useRiskRangeChartModel.js');
group(monitor, 'resource', 'useCpiBenchmarkReference.js useGoldCorrelationReference.js useMomoTrackerReference.js');

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
  useDashboardChangelog.js useDashboardPredictionIndicators.js
  usePortfolioResearch.js usePortfolioMarketContext.js
`);
group('src/hooks', 'mixed', 'useDashboardWorkspaceState.js useDashboardPanelResize.js');
group('src/constants', 'pure', 'dashboardResourceTiming.js dashboardWorkspace.js');
group('src/utils', 'pure', 'dashboardWorkspaceState.js dashboardReferenceProjection.js dashboardMarketPeriods.js');
group('src/components/Dashboard/workspace', 'view', `
  DashboardBalancePanel.jsx DashboardContractPnlPanel.jsx DashboardBookReader.jsx
  DashboardPerformancePanel.jsx DashboardPortfolioPanel.jsx DashboardExposurePanel.jsx
  DashboardPredictionWorkspace.jsx DashboardAnalystPanel.jsx DashboardSignalStrengthPanel.jsx
  DashboardEtfProPanel.jsx DashboardMacroShowPanel.jsx DashboardCallPanel.jsx
  DashboardSystemPanel.jsx DashboardWorkflowPanel.jsx
`);
group('src/routes', 'handler', 'referenceHandlers.cjs volatilityHandlers.cjs correlationHandlers.cjs currencyPairsHandler.cjs');

module.exports = {
  roles,
  orchestrators: [
    'src/components/Dashboard/PortfolioBreakdown.jsx',
    'src/components/Dashboard/PredictionMarketResolverTest.jsx',
    'src/components/Dashboard/PortfolioDashboard.jsx',
    'server.js',
  ],
};
