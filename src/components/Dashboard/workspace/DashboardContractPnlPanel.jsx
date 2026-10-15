import React, { Profiler, useCallback, useRef } from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';
import { SIDEBAR_PANEL_Z_INDEX_BASE, CONTRACT_PNL_PANEL_MIN_WIDTH, CONTRACT_PNL_PANEL_MAX_WIDTH } from '../../../constants/dashboardWorkspace';
import { recordContractPnlPanelCommit } from '../../../utils/contractPerformanceTiming';

export default function DashboardContractPnlPanel({
  showContractPnl,
  contractPnlPanelSurfaceRef,
  contractPnlPanelResizing,
  sidebarPanelStack,
  contractPnlPanelDisplayedWidth,
  beginContractPnlPanelResize,
  handleContractPnlPanelResizeKeyDown,
  resetContractPnlPanelSize,
  setShowContractPnl,
  children
}) {
  const timingSurfaceRef = useRef(null);
  const recordTiming = useCallback((...timing) => recordContractPnlPanelCommit(timingSurfaceRef.current, ...timing), []);
  const content = <div
    className="dashboard-navigation-rail__balance-surface"
    data-testid="contract-pnl-surface"
    ref={process.env.NODE_ENV === 'development' ? timingSurfaceRef : undefined}
  >{children}</div>;
  return (
    <DashboardWorkspaceWindow
        size="balance"
        manageFocus
        as="section"
        active={showContractPnl}
        ref={contractPnlPanelSurfaceRef}
        className={[
          'dashboard-navigation-rail__balance-panel',
          'dashboard-navigation-rail__balance-panel--contract-pnl',
          contractPnlPanelResizing
            && 'dashboard-navigation-rail__balance-panel--contract-pnl-resizing',
        ].filter(Boolean).join(' ')}
        style={{
          zIndex: SIDEBAR_PANEL_Z_INDEX_BASE + sidebarPanelStack.length + 1,
          '--dashboard-balance-panel-width': `${contractPnlPanelDisplayedWidth}px`,
        }}
        data-testid="contract-pnl-panel-slot"
        aria-label="Contract P&L"
      >
        <div
          className="dashboard-navigation-rail__contract-pnl-resize-handle dashboard-navigation-rail__contract-pnl-resize-handle--left"
          data-testid="contract-pnl-panel-resize-handle"
          role="separator"
          aria-label="Resize Contract P&L from the left edge"
          aria-orientation="vertical"
          aria-valuemin={CONTRACT_PNL_PANEL_MIN_WIDTH}
          aria-valuemax={CONTRACT_PNL_PANEL_MAX_WIDTH}
          aria-valuenow={contractPnlPanelDisplayedWidth}
          aria-valuetext={`${contractPnlPanelDisplayedWidth} pixels wide`}
          tabIndex={0}
          title="Drag the left edge to resize · double-click to reset"
          onPointerDown={(event) => beginContractPnlPanelResize(event, 'left')}
          onKeyDown={(event) => handleContractPnlPanelResizeKeyDown(event, 'left')}
          onDoubleClick={resetContractPnlPanelSize}
        />
        <div
          className="dashboard-navigation-rail__contract-pnl-resize-handle dashboard-navigation-rail__contract-pnl-resize-handle--right"
          data-testid="contract-pnl-panel-resize-handle-right"
          role="separator"
          aria-label="Resize Contract P&L from the right edge"
          aria-orientation="vertical"
          aria-valuemin={CONTRACT_PNL_PANEL_MIN_WIDTH}
          aria-valuemax={CONTRACT_PNL_PANEL_MAX_WIDTH}
          aria-valuenow={contractPnlPanelDisplayedWidth}
          aria-valuetext={`${contractPnlPanelDisplayedWidth} pixels wide`}
          tabIndex={0}
          title="Drag the right edge to resize · double-click to reset"
          onPointerDown={(event) => beginContractPnlPanelResize(event, 'right')}
          onKeyDown={(event) => handleContractPnlPanelResizeKeyDown(event, 'right')}
          onDoubleClick={resetContractPnlPanelSize}
        />
        <header className="dashboard-navigation-rail__balance-header">
          <h2 className="dashboard-navigation-rail__panel-title">Contract P&amp;L</h2>
          <button
            type="button"
            className="dashboard-navigation-rail__balance-close"
            aria-label="Close Contract P&L"
            title="Close Contract P&L"
            onClick={() => setShowContractPnl(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="dashboard-navigation-rail__balance-body">
          {process.env.NODE_ENV === 'development'
            ? <Profiler id="contract-pnl" onRender={recordTiming}>{content}</Profiler>
            : content}
        </div>
      </DashboardWorkspaceWindow>
  );
}
