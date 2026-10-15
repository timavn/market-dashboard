import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardPortfolioPanel({
  showPortfolioBreakdown,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="standard"
        aria-label="Portfolio"
        manageFocus
        active={showPortfolioBreakdown}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        data-testid="portfolio-breakdown-panel"
        className="dashboard-side-panel dashboard-side-panel--portfolio-card dark:bg-gray-900 dark:border-gray-700"
        style={{
          zIndex: getSidebarPanelZIndex('portfolio', showPortfolioBreakdown),
        }}
      >
            <div
              className="dashboard-portfolio-panel__content"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px',
              }}
            >
              {children}
            </div>
      </DashboardWorkspaceWindow>
  );
}
