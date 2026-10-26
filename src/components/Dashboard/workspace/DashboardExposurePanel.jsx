import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardExposurePanel({
  showExposureLab,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="PCA"
        manageFocus
        active={showExposureLab}
        data-testid="exposure-lab-panel"
        data-layout="centered-workspace"
        className="dashboard-side-panel dashboard-side-panel--exposure-card"
        style={{
          zIndex: getSidebarPanelZIndex('exposureLab', showExposureLab),
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {children}
        </div>
      </DashboardWorkspaceWindow>
  );
}
