import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardEtfProPanel({
  showEtfPro,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="ETF Pro"
        manageFocus
        active={showEtfPro}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('etfPro', showEtfPro),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
