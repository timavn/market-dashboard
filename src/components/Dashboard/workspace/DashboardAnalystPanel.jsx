import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';
import { ANALYST_PANEL_MIN_WIDTH, ANALYST_PANEL_MAX_WIDTH, ANALYST_PANEL_DEFAULT_WIDTH } from '../../../constants/dashboardWorkspace';
import AnalystSurfaceBoundary from '../AnalystSurfaceBoundary';

export default function DashboardAnalystPanel({
  showAnalyst,
  analystPanelSurfaceRef,
  analystPanelResizing,
  getSidebarPanelZIndex,
  analystPanelWidth,
  analystPanelResizeEdge,
  beginAnalystPanelResize,
  handleAnalystPanelResizeKeyDown,
  setAnalystPanelWidth,
  closeSidebarPanel,
  setShowAnalyst,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="analyst"
        manageFocus
        as="section"
        active={showAnalyst}
        ref={analystPanelSurfaceRef}
        data-testid="analyst-panel-surface"
        className={[
          'dashboard-navigation-rail__balance-panel',
          'dashboard-navigation-rail__analyst-panel',
          'dashboard-navigation-rail__analyst-panel--center',
          analystPanelResizing && 'dashboard-navigation-rail__analyst-panel--resizing',
          'dark:bg-gray-900 dark:border-gray-700',
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: getSidebarPanelZIndex('analyst', showAnalyst),
          '--analyst-panel-width': `${analystPanelWidth}px`,
        }}
        aria-label="The Analyst"
      >
        <div
          className="dashboard-navigation-rail__analyst-resize-handle"
          data-testid="analyst-panel-resize-handle"
          role="separator"
          aria-label={`Resize The Analyst from the ${analystPanelResizeEdge} edge`}
          aria-orientation="vertical"
          aria-valuemin={ANALYST_PANEL_MIN_WIDTH}
          aria-valuemax={ANALYST_PANEL_MAX_WIDTH}
          aria-valuenow={analystPanelWidth}
          aria-valuetext={`${analystPanelWidth} pixels wide`}
          tabIndex={0}
          title={`Drag the ${analystPanelResizeEdge} edge to resize · double-click to reset`}
          onPointerDown={beginAnalystPanelResize}
          onKeyDown={handleAnalystPanelResizeKeyDown}
          onDoubleClick={() => setAnalystPanelWidth(ANALYST_PANEL_DEFAULT_WIDTH)}
        />
        <div className="dashboard-navigation-rail__balance-body dashboard-navigation-rail__analyst-body">
          <AnalystSurfaceBoundary onClose={() => closeSidebarPanel('analyst', setShowAnalyst)}>
            {children}
          </AnalystSurfaceBoundary>
        </div>
      </DashboardWorkspaceWindow>
  );
}
