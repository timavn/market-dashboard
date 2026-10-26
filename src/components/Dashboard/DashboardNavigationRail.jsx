import React, { useEffect, useState } from 'react';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';
import { synchronizeProcessDrafts } from '../../utils/processDocumentDrafts';
import './DashboardNavigationRail.css';

const GROUPS = [
  { id: 'primary', label: 'PRIMARY', placement: 'top' },
  { id: 'utility', label: 'UTILITY', placement: 'bottom' },
];

const ANALYST_DOCK_OPTIONS = [
  { id: 'left', label: 'Move The Analyst to the left' },
  { id: 'center', label: 'Move The Analyst to the center' },
  { id: 'right', label: 'Move The Analyst to the right' },
];

const DashboardNavigationRail = ({
  items,
  activeItemId,
  activeItemIds,
  systemReadinessStatus,
  onItemIntent,
}) => {
  const [analystUnread, setAnalystUnread] = useState(0);
  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try { const result = await analystWorkspaceApi.request('/inbox'); if (!closed) setAnalystUnread(result.unread || 0); } catch { /* Keep unread findings visible during an outage. */ }
      synchronizeProcessDrafts();
    };
    const update = event => setAnalystUnread(event.detail || 0);
    window.addEventListener('analyst-inbox', update);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { closed = true; clearInterval(timer); window.removeEventListener('analyst-inbox', update); };
  }, []);
  const primaryItems = Array.isArray(items) ? items : [];
  const activeIds = new Set(
    Array.isArray(activeItemIds)
      ? activeItemIds
      : activeItemId
        ? [activeItemId]
        : [],
  );
  const getGroupItems = (groupId) => primaryItems.filter((item) => item.group === groupId);

  const renderCard = (item) => {
    const isActive = activeIds.has(item.id);
    const hasSystemStatus = item.id === 'system';
    const hasAnalystDockControls = item.id === 'analyst'
      && typeof item.onAnalystPanelPositionChange === 'function';
    const cardClassName = [
      'dashboard-navigation-rail__card',
      'dashboard-navigation-rail__card--compact',
      hasAnalystDockControls && 'dashboard-navigation-rail__card--analyst',
      isActive && 'is-active',
    ].filter(Boolean).join(' ');

    if (hasAnalystDockControls) {
      return (
        <div
          key={item.id}
          className={cardClassName}
          data-analyst-active-position={item.analystPanelPosition}
        >
          <button
            ref={item.buttonRef}
            type="button"
            title={item.title || item.label}
            aria-label={item.label}
            onPointerEnter={() => onItemIntent?.(item.id)}
            onFocus={() => onItemIntent?.(item.id)}
            onClick={item.onSelect}
            className="dashboard-navigation-rail__analyst-launch"
            aria-current={activeItemId === item.id ? 'page' : undefined}
            aria-pressed={isActive}
            data-navigation-item-id={item.id}
          >
            <span className="dashboard-navigation-rail__card-copy">
              <span className="dashboard-navigation-rail__card-title">{item.label}{item.id === 'analyst' && analystUnread > 0 && <span className="analyst-unread-badge" aria-label={`${analystUnread} unread portfolio alerts`}>{analystUnread}</span>}</span>
            </span>
          </button>
          <div
            className="dashboard-navigation-rail__analyst-dock"
            data-testid="analyst-position-controls"
            role="group"
            aria-label="Position The Analyst"
          >
            {ANALYST_DOCK_OPTIONS.map((option) => {
              const selected = item.analystPanelPosition === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`dashboard-navigation-rail__analyst-dock-dot ${selected ? 'is-active' : ''}`}
                  data-testid={`analyst-position-${option.id}`}
                  data-position={option.id}
                  aria-label={option.label}
                  aria-pressed={selected}
                  title={option.label}
                  onClick={() => {
                    item.onAnalystPanelPositionChange(option.id);
                    if (!isActive) item.onSelect();
                  }}
                >
                  <span aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <button
        key={item.id}
        ref={item.buttonRef}
        type="button"
        title={item.title || item.label}
        aria-label={item.label}
        onPointerEnter={() => onItemIntent?.(item.id)}
        onFocus={() => onItemIntent?.(item.id)}
        onClick={item.onSelect}
        className={cardClassName}
        aria-current={activeItemId === item.id ? 'page' : undefined}
        aria-pressed={isActive}
        data-navigation-item-id={item.id}
        data-process-toggle={item.isProcessToggle ? 'true' : undefined}
        data-readiness-status={hasSystemStatus ? systemReadinessStatus : undefined}
      >
        <span className="dashboard-navigation-rail__card-copy">
          <span className="dashboard-navigation-rail__card-title">{item.label}{item.id === 'analyst' && analystUnread > 0 && <span className="analyst-unread-badge" aria-label={`${analystUnread} unread portfolio alerts`}>{analystUnread}</span>}</span>
        </span>
        {hasSystemStatus && (
          <span className="sr-only">System status: {systemReadinessStatus}</span>
        )}
      </button>
    );
  };

  return (
    <nav
      data-testid="dashboard-rail-navigation"
      className="dashboard-navigation-rail__content dashboard-navigation-rail__content--collapsed"
      aria-label="Workspace navigation"
    >
      <div id="dashboard-navigation-results" className="dashboard-navigation-rail__collapsed-scroll">
        {primaryItems.length > 0 ? GROUPS.map((group) => {
          const groupItems = getGroupItems(group.id);
          if (!groupItems.length) return null;
          return (
            <section
              key={group.id}
              className={`dashboard-navigation-rail__group dashboard-navigation-rail__group--${group.placement}`}
              aria-label={`${group.label} navigation`}
              data-navigation-group={group.id}
              data-navigation-placement={group.placement}
            >
              <div className="dashboard-navigation-rail__card-grid">
                {groupItems.map(renderCard)}
              </div>
            </section>
          );
        }) : (
          <div className="dashboard-navigation-rail__empty" role="status">
            No tools available.
          </div>
        )}
      </div>
    </nav>
  );
};

export default DashboardNavigationRail;
