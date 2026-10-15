import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';
import { Title } from '@tremor/react';
import RefreshButton from '../../common/RefreshButton';

export default function DashboardWorkflowPanel({
  showWorkflowStatus,
  showContractPnl,
  getSidebarPanelZIndex,
  closeSidebarPanel,
  setShowWorkflowStatus,
  setAnalyticsRefreshKey,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="analytics"
        aria-label="Analytics"
        manageFocus
        active={showWorkflowStatus}
        occluded={showContractPnl}
        data-contract-pnl-coverable="true"
        style={{
          zIndex: getSidebarPanelZIndex('analytics', showWorkflowStatus),
        }}
        className="dark:bg-gray-900/95 dark:border-gray-700 backdrop-blur-sm"
      >
            {/* Header with Centered Title (Clickable to Close) */}
            <div
              style={{
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                background: 'linear-gradient(to bottom, rgba(249, 250, 251, 0.9), rgba(255, 255, 255, 0.6))',
              }}
              className="dark:border-gray-700 dark:bg-gradient-to-b dark:from-gray-800/80 dark:to-gray-700/50"
            >
              {/* Empty spacer for centering */}
              <div style={{ width: '28px' }} />

              <Title
                className="dark:text-white"
                style={{
                  fontSize: '14px',
                  fontWeight: 700,
                  color: '#000',
                  margin: 0,
                  userSelect: 'none',
                  cursor: 'pointer',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
                }}
                onClick={() => closeSidebarPanel('analytics', setShowWorkflowStatus)}
              >
                Analytics
              </Title>

              <RefreshButton
                iconOnly
                title="Refresh Analytics"
                label="Refresh Analytics"
                onClick={(e) => {
                  e.stopPropagation();
                  setAnalyticsRefreshKey(prev => prev + 1);
                }}
              />
            </div>

            {/* Scrollable Content */}
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
