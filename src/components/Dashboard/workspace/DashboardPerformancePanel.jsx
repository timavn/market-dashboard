import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';
import { Title } from '@tremor/react';

export default function DashboardPerformancePanel({
  showPerformanceTracking,
  showContractPnl,
  getSidebarPanelZIndex,
  closeSidebarPanel,
  setShowPerformanceTracking,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="standard"
        aria-label="Performance"
        manageFocus
        active={showPerformanceTracking}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('performance', showPerformanceTracking),
        }}
        className="dashboard-side-panel dashboard-side-panel--cpi dark:bg-gray-900 dark:border-gray-700"
      >
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                backgroundColor: '#f9fafb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => closeSidebarPanel('performance', setShowPerformanceTracking)}
            >
              <Title
                className="dark:text-white"
                style={{
                  fontSize: '18px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
              >
                Performance
              </Title>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 0,
              }}
            >
              {children}
            </div>
      </DashboardWorkspaceWindow>
  );
}
