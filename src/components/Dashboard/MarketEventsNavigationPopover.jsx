import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './MarketEventsNavigationPopover.css';

export default function MarketEventsNavigationPopover({ detail, briefingOpen, hasNotification, onNotificationDismiss, onOpen, children }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({});
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();
  const notificationId = useId();

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dock = triggerRef.current.closest('nav')?.getBoundingClientRect();
    const anchorTop = dock?.height > 0 ? Math.min(rect.top, dock.top) : rect.top;
    const width = Math.min(620, window.innerWidth - 16);
    setPosition({
      bottom: window.innerHeight - anchorTop + 7,
      left: Math.max(8, (window.innerWidth - width) / 2),
      width,
      maxHeight: Math.max(0, anchorTop - 15),
    });
  }, []);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    panelRef.current?.querySelector('button[aria-pressed="true"]')?.focus();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || briefingOpen) return undefined;
    const outside = (event) => {
      if (!triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) close();
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, briefingOpen, close]);

  return <>
    <button ref={triggerRef} type="button"
      className={`dashboard-top-navigation__item market-events-navigation-trigger${open ? ' is-active' : ''}${hasNotification ? ' has-notification' : ''}`}
      aria-label="Market Events" aria-haspopup="dialog"
      aria-describedby={hasNotification ? notificationId : undefined}
      aria-expanded={open} aria-controls={open ? panelId : undefined} title={detail}
      onClick={() => {
        onNotificationDismiss?.();
        if (open) close(true);
        else { onOpen?.(); updatePosition(); setOpen(true); }
      }}>
      <span>Market Events</span>
    </button>
    {hasNotification && <span id={notificationId} className="sr-only">New market events today</span>}
    {open && createPortal(
      <div ref={panelRef} id={panelId} className="market-events-navigation-popover" style={position}
        role="dialog" aria-label="Market Events">
        {children}
      </div>, document.body,
    )}
  </>;
}
