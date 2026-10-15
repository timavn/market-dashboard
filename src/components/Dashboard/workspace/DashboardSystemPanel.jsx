import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardSystemPanel({
  showSystemReadiness,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="compact"
        aria-label="Systems"
        manageFocus
        active={showSystemReadiness}
        style={{
          zIndex: getSidebarPanelZIndex('system', showSystemReadiness),
        }}
        className="system-status-flyout"
        data-testid="system-readiness-sheet"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
