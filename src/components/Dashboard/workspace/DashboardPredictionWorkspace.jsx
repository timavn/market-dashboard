import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardPredictionWorkspace({
  showPredictionMonitor,
  showContractPnl,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Prediction Markets"
        active={showPredictionMonitor}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        preserveLayoutWhenInactive
        data-testid="prediction-market-resolver-test-panel"
        className="dashboard-side-panel dashboard-side-panel--resolver-test dark:bg-gray-900 dark:border-gray-700"
        style={{
          zIndex: getSidebarPanelZIndex('predictionMonitor', showPredictionMonitor),
        }}
      >
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          {children}
        </div>
      </DashboardWorkspaceWindow>
  );
}
