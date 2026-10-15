import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardCallPanel({
  showCall,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Call"
        manageFocus
        active={showCall}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('call', showCall),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
