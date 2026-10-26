import React from 'react';
import DashboardWorkspaceWindow from './DashboardWorkspaceWindow';

export default function DashboardMacroShowPanel({
  showMacroShow,
  getSidebarPanelZIndex,
  children
}) {
  return (
    <DashboardWorkspaceWindow
        size="wide"
        aria-label="Macro Show"
        manageFocus
        active={showMacroShow}
        style={{
          zIndex: getSidebarPanelZIndex('macroShow', showMacroShow),
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
          {children}
      </DashboardWorkspaceWindow>
  );
}
