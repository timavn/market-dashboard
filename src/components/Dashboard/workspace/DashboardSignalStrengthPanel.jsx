import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardSignalStrengthPanel({
  showSignalStrength,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Signal Strength"
        manageFocus
        active={showSignalStrength}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('ss', showSignalStrength),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
