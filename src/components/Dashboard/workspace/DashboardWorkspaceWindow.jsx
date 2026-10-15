import React, { forwardRef } from 'react';
import PersistentSurface from '../../common/PersistentSurface';
import './DashboardWorkspaceWindow.css';

// Keep each workspace's retained state while sharing one viewport-based frame.
const DashboardWorkspaceWindow = forwardRef(function DashboardWorkspaceWindow({
  size = 'standard',
  className = '',
  ...props
}, ref) {
  return (
    <PersistentSurface
      {...props}
      ref={ref}
      role="dialog"
      className={`dashboard-workspace-window dashboard-workspace-window--${size} ${className}`}
    />
  );
});

export default DashboardWorkspaceWindow;
