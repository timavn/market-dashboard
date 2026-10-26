import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardSignalStrengthPanel({
  showSignalStrength,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Signal Strength"
        manageFocus
        active={showSignalStrength}
        style={{
          zIndex: getSidebarPanelZIndex('ss', showSignalStrength),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
