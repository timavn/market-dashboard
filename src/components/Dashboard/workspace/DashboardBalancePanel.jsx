import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';
import { SIDEBAR_PANEL_Z_INDEX_BASE } from '../../../constants/dashboardWorkspace';

export default function DashboardBalancePanel({
  showPortfolioBalance,
  sidebarPanelStack,
  setShowPortfolioBalance,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="balance"
        manageFocus
        as="section"
        active={showPortfolioBalance}
        className="dashboard-navigation-rail__balance-panel"
        style={{
          zIndex: SIDEBAR_PANEL_Z_INDEX_BASE + sidebarPanelStack.length + 1,
          '--dashboard-balance-panel-width': '295px',
        }}
        data-testid="portfolio-balance-planner-slot"
        aria-label="Balance"
      >
        <header className="dashboard-navigation-rail__balance-header">
          <h2 className="dashboard-navigation-rail__panel-title">Balance</h2>
          <button
            type="button"
            className="dashboard-navigation-rail__balance-close"
            aria-label="Close Balance"
            title="Close Balance"
            onClick={() => setShowPortfolioBalance(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="dashboard-navigation-rail__balance-body">
          <div className="dashboard-navigation-rail__balance-surface">
            {children}
          </div>
        </div>
      </DashboardWorkspaceWindow>
  );
}
