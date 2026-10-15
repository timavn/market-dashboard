import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceActivity } from './PersistentSurface';

const PopoverSelect = ({
  ariaLabel,
  value,
  options,
  onChange,
  rootClassName = '',
  buttonClassName = '',
  menuClassName = '',
  optionClassName = '',
  buttonLabel,
  showChevron = false,
  showSelectionMark = false,
  menuMatchButtonWidth = false,
  menuOffset = 8,
  preferredPlacement = 'bottom',
}) => {
  const surfaceActive = useSurfaceActivity();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 200, placement: 'bottom' });
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef([]);
  const typeahead = useRef({ text: '', at: 0 });

  const openMenu = (fallback = 0) => {
    if (!options.length) return;
    const selected = options.findIndex((option) => option.value === value);
    setActiveIndex(selected >= 0 ? selected : fallback);
    updateMenuPosition();
    setOpen(true);
  };

  const focusOption = (index) => {
    const next = Math.max(0, Math.min(options.length - 1, index));
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
    optionRefs.current[next]?.scrollIntoView?.({ block: 'nearest' });
  };

  const handleMenuKey = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (options[activeIndex]) onChange(options[activeIndex].value);
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    const nextIndex = {
      ArrowDown: (activeIndex + 1) % options.length,
      ArrowUp: (activeIndex - 1 + options.length) % options.length,
      Home: 0,
      End: options.length - 1,
    }[event.key];
    if (nextIndex != null) {
      event.preventDefault();
      focusOption(nextIndex);
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const prior = now - typeahead.current.at < 700 ? typeahead.current.text : '';
      const text = `${prior}${event.key.toLocaleLowerCase()}`;
      typeahead.current = { text, at: now };
      const match = options.findIndex((option) => String(option.label).toLocaleLowerCase().startsWith(text));
      if (match >= 0) focusOption(match);
      event.preventDefault();
    }
  };

  const updateMenuPosition = useCallback(() => {
    if (!buttonRef.current || typeof window === 'undefined') return;
    const rect = buttonRef.current.getBoundingClientRect();
    const buttonWidth = rect.width || buttonRef.current.offsetWidth || 200;
    const width = menuMatchButtonWidth ? buttonWidth : Math.max(200, buttonWidth);
    const viewportPadding = 8;
    const measuredHeight = menuRef.current?.getBoundingClientRect?.().height;
    const estimatedHeight = Math.min(256, Math.max(40, options.length * 36 + 8));
    const menuHeight = measuredHeight || estimatedHeight;
    if (preferredPlacement === 'top') {
      const maxWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
      const minWidth = Math.min(width, maxWidth);
      const measuredWidth = menuRef.current?.getBoundingClientRect?.().width || width;
      const boundedWidth = menuMatchButtonWidth ? minWidth : Math.min(Math.max(minWidth, measuredWidth), maxWidth);
      const gap = Math.max(0, menuOffset);
      const aboveSpace = Math.max(0, rect.top - gap - viewportPadding);
      const belowSpace = Math.max(0, window.innerHeight - viewportPadding - rect.bottom - gap);
      const optionHeight = optionRefs.current[0]?.getBoundingClientRect?.().height || 36;
      const minimumHeight = optionHeight + 8;
      // Prefer a scrollable menu above the trigger. Move below only when even
      // one option cannot fit above and there is more usable space below.
      const placement = aboveSpace >= minimumHeight || aboveSpace >= belowSpace ? 'top' : 'bottom';
      const maxHeight = Math.min(256, placement === 'top' ? aboveSpace : belowSpace);
      const borderHeight = Math.max(0, (measuredHeight || 0) - (menuRef.current?.clientHeight || measuredHeight || 0));
      const contentHeight = menuRef.current?.scrollHeight ? menuRef.current.scrollHeight + borderHeight : menuHeight;
      const boundedHeight = Math.min(contentHeight, maxHeight);
      const anchoredTop = placement === 'top' ? rect.top - gap - boundedHeight : rect.bottom + gap;
      const top = Math.max(viewportPadding, Math.min(anchoredTop, window.innerHeight - viewportPadding - boundedHeight));
      const left = Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - boundedWidth - viewportPadding));
      const next = { top, left, width: boundedWidth, minWidth, maxWidth, maxHeight, placement };
      setMenuPos((previous) => Object.keys(next).every((key) => previous[key] === next[key]) ? previous : next);
      return;
    }
    const belowTop = rect.bottom + menuOffset;
    const aboveTop = rect.top - menuOffset - menuHeight;
    const placement = belowTop + menuHeight <= window.innerHeight - viewportPadding || aboveTop < viewportPadding
      ? 'bottom'
      : 'top';
    const top = placement === 'bottom' ? belowTop : aboveTop;
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );

    setMenuPos({ top, left, width, placement });
  }, [menuMatchButtonWidth, menuOffset, options.length, preferredPlacement]);

  useEffect(() => {
    if (!surfaceActive || !open) return undefined;
    const handleClickOutside = (e) => {
      if (
        ref.current
        && !ref.current.contains(e.target)
        && !menuRef.current?.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape' && (ref.current?.contains(e.target) || menuRef.current?.contains(e.target))) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) setOpen(false);
  }, [surfaceActive]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    optionRefs.current[activeIndex]?.focus();
    // Focus only when opening. Arrow-key focus is handled synchronously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    const resizeObserver = preferredPlacement === 'top' && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateMenuPosition) : null;
    if (resizeObserver) {
      resizeObserver.observe(buttonRef.current);
      resizeObserver.observe(menuRef.current);
    }
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      resizeObserver?.disconnect();
    };
  }, [open, updateMenuPosition, preferredPlacement]);

  // Find the label for the current value
  const displayLabel = options.find(opt => opt.value === value)?.label || value;
  const triggerLabel = buttonLabel ?? displayLabel;
  const selectedTitle = typeof displayLabel === 'string' ? displayLabel : undefined;

  return (
    <div ref={ref} className={`relative w-full ${rootClassName}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        role={ariaLabel ? 'combobox' : undefined}
        aria-activedescendant={open ? `${menuId}-option-${activeIndex}` : undefined}
        title={buttonLabel != null ? selectedTitle : undefined}
        className={`w-full px-2 py-1 text-sm border rounded bg-white dark:bg-gray-700 dark:text-white border-gray-300 dark:border-gray-600 shadow-sm ${buttonClassName}`}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' || event.key === 'End' ? options.length - 1 : 0);
          }
        }}
      >
        <span className="popover-select__trigger-label">{triggerLabel}</span>
        {showChevron && (
          <svg
            aria-hidden="true"
            className="popover-select__chevron"
            viewBox="0 0 10 6"
          >
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="listbox"
          onKeyDown={handleMenuKey}
          aria-label={ariaLabel ? `${ariaLabel} options` : undefined}
          data-placement={menuPos.placement}
          className={`fixed z-[9999] max-h-64 overflow-auto rounded border bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-lg ${menuClassName}`}
          style={{
            top: menuPos.top,
            left: menuPos.left,
            width: menuMatchButtonWidth ? `${menuPos.width}px` : undefined,
            minWidth: menuMatchButtonWidth ? `${menuPos.width}px` : '200px',
            overscrollBehavior: 'contain',
            ...(preferredPlacement === 'top' ? {
              width: menuMatchButtonWidth ? `${menuPos.width}px` : 'max-content',
              minWidth: menuPos.minWidth,
              maxWidth: menuPos.maxWidth,
              maxHeight: menuPos.maxHeight,
              boxSizing: 'border-box',
              overflow: 'auto',
              zIndex: 9999,
            } : {}),
          }}
        >
          <div className="py-1">
            {options.map((opt, index) => (
              <button
                key={opt.value}
                id={`${menuId}-option-${index}`}
                ref={(node) => { optionRefs.current[index] = node; }}
                tabIndex={activeIndex === index ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                aria-selected={value === opt.value}
                data-value={opt.value}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 ${
                  value === opt.value ? 'font-semibold' : ''
                } ${optionClassName}`}
                role="option"
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
              >
                {showSelectionMark && (
                  <span className="popover-select__selection-mark" aria-hidden="true">
                    {value === opt.value ? '✓' : ''}
                  </span>
                )}
                <span className="popover-select__option-label">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      , document.body)}
    </div>
  );
};

export default PopoverSelect;
