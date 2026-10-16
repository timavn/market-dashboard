import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';
import useDockNotification from '../../hooks/useDockNotification';
import { synchronizeProcessDrafts } from '../../utils/processDocumentDrafts';
import { isActionRequired } from '../../utils/analystInboxAlerts.cjs';
import MarketEventsQuickReference from './MarketEventsQuickReference';
import './DashboardTopNavigation.css';

const isMarketItem = (item) => String(item.id).startsWith('predictionMonitor-');
const PORTFOLIO_ITEM_IDS = new Set(['portfolio', 'exposureLab', 'balance', 'contractPnl']);
const OCCLUDING_ITEM_IDS = ['process', 'dashboardGuide', 'exposureGuide'];
const MENU_LABELS = { research: 'Research', portfolio: 'Portfolio', prediction: 'Prediction Markets', perpetual: 'Perpetual Futures' };
const orderBySection = (items) => [...new Set(items.map((item) => item.sectionLabel || ''))]
  .flatMap((section) => items.filter((item) => (item.sectionLabel || '') === section));
const inboxNotificationIds = (result) => result.findings
  .filter((finding) => (finding?.unread === true || finding?.unread === 1) && typeof finding.id === 'string')
  .map((finding) => finding.id);
// Undecided instructions that oppose a held position. Unlike the blue
// notification, opening the Analyst does not clear them.
const actionRequiredCount = (result) => result.findings
  .filter((finding) => (finding?.unread === true || finding?.unread === 1) && isActionRequired(finding)).length;

const DashboardTopNavigation = ({
  items,
  activeItemId,
  activeItemIds,
  systemReadinessStatus,
  onItemIntent,
}) => {
  const [analystNotificationIds, setAnalystNotificationIds] = useState([]);
  const [analystActionRequired, setAnalystActionRequired] = useState(0);
  const analystNotification = useDockNotification({ channel: 'analyst', notificationIds: analystNotificationIds });
  const [menuOpen, setMenuOpen] = useState(null);
  const [menuPosition, setMenuPosition] = useState({ bottom: 0, left: 0 });
  const triggerRefs = useRef({});
  const menuRef = useRef(null);
  const optionRefs = useRef([]);
  const activeOptionRef = useRef(0);
  const openingFocusRef = useRef(false);
  const typeaheadRef = useRef({ text: '', at: 0 });
  const menuId = useId();
  const navigationItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const activeIds = new Set(Array.isArray(activeItemIds) ? activeItemIds : activeItemId ? [activeItemId] : []);
  const marketItems = navigationItems.filter(isMarketItem);
  const predictionItems = marketItems.filter((item) => item.menuGroup !== 'perpetual');
  const perpetualItems = marketItems.filter((item) => item.menuGroup === 'perpetual');
  const primaryItems = navigationItems.filter((item) => !isMarketItem(item) && item.group !== 'utility');
  const utilityItems = navigationItems.filter((item) => !isMarketItem(item) && item.group === 'utility')
    .sort((left, right) => Number(right.id === 'analyst') - Number(left.id === 'analyst'));
  const researchItems = primaryItems.filter((item) => !PORTFOLIO_ITEM_IDS.has(item.id));
  const portfolioItems = primaryItems.filter((item) => PORTFOLIO_ITEM_IDS.has(item.id));
  const menuItemsByGroup = { research: researchItems, portfolio: portfolioItems, prediction: orderBySection(predictionItems), perpetual: orderBySection(perpetualItems) };
  const openMenuItems = menuItemsByGroup[menuOpen] || [];
  const openMenuSections = [...new Set(openMenuItems.map((item) => item.sectionLabel || ''))];
  // The open Analyst already polls the inbox and announces each change, but
  // only while visible: a Process or guide window pauses its event stream.
  const analystOpen = activeIds.has('analyst') && !OCCLUDING_ITEM_IDS.some((id) => activeIds.has(id));

  useEffect(() => {
    let closed = false;
    let revision = 0;
    let pending = false;
    const refresh = async () => {
      if (closed || pending) return;
      if (analystOpen) { synchronizeProcessDrafts(); return; }
      pending = true;
      const requestRevision = ++revision;
      try {
        const result = await analystWorkspaceApi.request('/inbox');
        if (!closed && requestRevision === revision && Array.isArray(result?.findings)) {
          setAnalystNotificationIds(inboxNotificationIds(result));
          setAnalystActionRequired(actionRequiredCount(result));
        }
      } catch { /* Keep the pending notification visible during an outage. */ }
      finally { pending = false; }
      synchronizeProcessDrafts();
    };
    const update = (event) => {
      if (Array.isArray(event.detail?.findings)) {
        revision += 1;
        setAnalystNotificationIds(inboxNotificationIds(event.detail));
        setAnalystActionRequired(actionRequiredCount(event.detail));
      } else {
        refresh();
      }
    };
    window.addEventListener('analyst-inbox', update);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      closed = true;
      clearInterval(timer);
      window.removeEventListener('analyst-inbox', update);
    };
  }, [analystOpen]);

  const updateMenuPosition = useCallback((group = menuOpen) => {
    const trigger = triggerRefs.current[group];
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const dock = trigger.closest('nav')?.getBoundingClientRect();
    const anchorTop = dock?.height > 0 ? Math.min(rect.top, dock.top) : rect.top;
    const width = Math.min(224, window.innerWidth - 16);
    setMenuPosition({
      bottom: window.innerHeight - anchorTop + 7,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      maxHeight: Math.max(0, anchorTop - 15),
    });
  }, [menuOpen]);

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(null);
    if (restoreFocus) triggerRefs.current[menuOpen]?.focus();
  };

  const openMenu = (group, fromEnd = false) => {
    const options = menuItemsByGroup[group];
    if (!options?.length) return;
    const selectedIndex = options.findIndex((item) => item.id === activeItemId);
    activeOptionRef.current = selectedIndex >= 0 ? selectedIndex : fromEnd ? options.length - 1 : 0;
    typeaheadRef.current = { text: '', at: 0 };
    updateMenuPosition(group);
    setMenuOpen(group);
  };

  useLayoutEffect(() => {
    if (!menuOpen) return undefined;
    openingFocusRef.current = true;
    optionRefs.current[activeOptionRef.current]?.focus();
    openingFocusRef.current = false;
    updateMenuPosition();
    const reposition = () => updateMenuPosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const outside = (event) => {
      if (!triggerRefs.current[menuOpen]?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setMenuOpen(null);
      }
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(null);
      triggerRefs.current[menuOpen]?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [menuOpen]);

  const handleMenuKey = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      // Use the same event path as pointer selection so workspace navigation
      // capture handlers can close a Process/Guide route before opening a panel.
      optionRefs.current[activeOptionRef.current]?.click();
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(true);
      return;
    }
    const count = openMenuItems.length;
    let nextIndex = {
      ArrowDown: (activeOptionRef.current + 1) % count,
      ArrowUp: (activeOptionRef.current - 1 + count) % count,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const prior = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : '';
      const text = `${prior}${event.key.toLocaleLowerCase()}`;
      typeaheadRef.current = { text, at: now };
      const match = openMenuItems.findIndex((item) => String(item.label).toLocaleLowerCase().startsWith(text));
      if (match >= 0) nextIndex = match;
      event.preventDefault();
    }
    if (nextIndex != null) {
      event.preventDefault();
      activeOptionRef.current = nextIndex;
      optionRefs.current[nextIndex]?.focus();
      optionRefs.current[nextIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  };

  const renderItem = (item, inMenu = false) => {
    const isActive = activeIds.has(item.id);
    const indicatorTone = ['bullish', 'bearish'].includes(item.indicatorTone) ? item.indicatorTone : null;
    const indicatorDescription = indicatorTone && typeof item.indicatorDescription === 'string'
      ? item.indicatorDescription.trim() : '';
    const descriptionId = indicatorDescription ? `${menuId}-${item.id}-research` : undefined;
    const actionRequired = item.id === 'analyst' ? analystActionRequired : 0;
    const hasNotification = item.id === 'analyst' && (actionRequired > 0 || analystNotification.hasNotification);
    const notificationDescriptionId = hasNotification ? `${menuId}-analyst-notification` : undefined;
    const optionIndex = inMenu ? openMenuItems.findIndex((option) => option.id === item.id) : -1;
    const checkboxItem = inMenu && menuOpen !== 'research';
    return (
      <button
        key={item.id}
        ref={(node) => {
          if (inMenu) optionRefs.current[optionIndex] = node;
          const focusTarget = node || (inMenu ? triggerRefs.current[menuOpen] : null);
          if (typeof item.buttonRef === 'function') item.buttonRef(focusTarget);
          else if (item.buttonRef) item.buttonRef.current = focusTarget;
        }}
        type="button"
        role={inMenu ? checkboxItem ? 'menuitemcheckbox' : 'menuitem' : undefined}
        tabIndex={inMenu ? -1 : undefined}
        aria-label={item.label}
        aria-describedby={[descriptionId, notificationDescriptionId].filter(Boolean).join(' ') || undefined}
        aria-current={activeItemId === item.id ? 'page' : undefined}
        aria-pressed={inMenu ? undefined : isActive}
        aria-checked={checkboxItem ? isActive : undefined}
        title={indicatorDescription ? `${item.title || item.label}. ${indicatorDescription}` : item.title || item.label}
        data-navigation-item-id={item.id}
        data-process-toggle={item.isProcessToggle ? 'true' : undefined}
        data-readiness-status={item.id === 'system' ? systemReadinessStatus : undefined}
        data-indicator-tone={indicatorTone || undefined}
        className={`dashboard-top-navigation__item${inMenu ? ' dashboard-top-navigation__menu-item' : ''}${isActive ? ' is-active' : ''}${actionRequired > 0 ? ' has-action-required' : hasNotification ? ' has-notification' : ''}`}
        onPointerEnter={() => onItemIntent?.(item.id)}
        onFocus={() => {
          if (inMenu) activeOptionRef.current = optionIndex;
          if (!openingFocusRef.current) onItemIntent?.(item.id);
        }}
        onClick={() => {
          if (inMenu) closeMenu(true);
          if (item.id === 'analyst') analystNotification.dismiss();
          item.onSelect?.();
        }}
      >
        <span>{item.label}</span>
        {actionRequired > 0 && <span aria-hidden="true" className="dashboard-top-navigation__action-count">{actionRequired}</span>}
        {hasNotification && <span id={notificationDescriptionId} className="sr-only">{actionRequired > 0
          ? `${actionRequired} ${actionRequired === 1 ? 'position needs' : 'positions need'} immediate action` : 'New analyst messages'}</span>}
        {inMenu && <span aria-hidden="true" className="dashboard-top-navigation__selection">{isActive ? '✓' : ''}</span>}
        {item.id === 'system' && <span className="sr-only">System status: {systemReadinessStatus}</span>}
        {indicatorDescription && <span id={descriptionId} className="sr-only">{indicatorDescription}</span>}
      </button>
    );
  };

  const renderMenuTrigger = (group) => {
    const options = menuItemsByGroup[group];
    if (!options.length) return null;
    const isActive = options.some((item) => activeIds.has(item.id));
    const expanded = menuOpen === group;
    return (
      <button
        key={group}
        ref={(node) => {
          triggerRefs.current[group] = node;
          if (menuOpen !== group) options.forEach((item) => {
            if (typeof item.buttonRef === 'function') item.buttonRef(node);
            else if (item.buttonRef) item.buttonRef.current = node;
          });
        }}
        type="button"
        className={`dashboard-top-navigation__item dashboard-top-navigation__group-trigger${isActive || expanded ? ' is-active' : ''}`}
        aria-label={MENU_LABELS[group]}
        title={`Show ${MENU_LABELS[group]} menu`}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-pressed={isActive}
        aria-controls={expanded ? menuId : undefined}
        onClick={() => expanded ? closeMenu() : openMenu(group)}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            openMenu(group, event.key === 'ArrowUp' || event.key === 'End');
          }
        }}
      >
        <span>{MENU_LABELS[group]}</span>
      </button>
    );
  };

  return (
    <>
      <nav className="dashboard-top-navigation dashboard-bottom-navigation" aria-label="Workspace navigation" data-testid="dashboard-top-navigation">
        <div className="dashboard-top-navigation__links" data-navigation-group="primary">
          {['portfolio', 'prediction', 'perpetual'].map(renderMenuTrigger)}
          <MarketEventsQuickReference compact />
          {renderMenuTrigger('research')}
        </div>
        {utilityItems.length > 0 && <div className="dashboard-top-navigation__utilities" data-navigation-group="utility">{utilityItems.map((item) => renderItem(item))}</div>}
        {menuOpen && createPortal(
          <div ref={menuRef} id={menuId} role="menu" aria-label={MENU_LABELS[menuOpen]} className="dashboard-top-navigation__menu" style={menuPosition} onKeyDown={handleMenuKey}>
            {['prediction', 'perpetual'].includes(menuOpen) ? openMenuSections.map((section) => (
              <div key={section} role="group" aria-label={[section, MENU_LABELS[menuOpen].toLowerCase()].filter(Boolean).join(' ')} data-navigation-section={section || undefined}>
                {section && <div className="dashboard-top-navigation__section" aria-hidden="true">{section}</div>}
                {openMenuItems.filter((item) => (item.sectionLabel || '') === section).map((item) => renderItem(item, true))}
              </div>
            )) : openMenuItems.map((item) => renderItem(item, true))}
          </div>, document.body,
        )}
      </nav>
    </>
  );
};

export default DashboardTopNavigation;
