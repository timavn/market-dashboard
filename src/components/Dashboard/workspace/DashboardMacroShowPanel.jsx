import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardMacroShowPanel({
  showMacroShow,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Macro Show"
        manageFocus
        active={showMacroShow}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('macroShow', showMacroShow),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
