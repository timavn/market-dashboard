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
}) => {
  const surfaceActive = useSurfaceActivity();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 200, placement: 'bottom' });
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const updateMenuPosition = useCallback(() => {
    if (!buttonRef.current || typeof window === 'undefined') return;
    const rect = buttonRef.current.getBoundingClientRect();
    const buttonWidth = rect.width || buttonRef.current.offsetWidth || 200;
    const width = menuMatchButtonWidth ? buttonWidth : Math.max(200, buttonWidth);
    const viewportPadding = 8;
    const measuredHeight = menuRef.current?.getBoundingClientRect?.().height;
    const estimatedHeight = Math.min(256, Math.max(40, options.length * 36 + 8));
    const menuHeight = measuredHeight || estimatedHeight;
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
  }, [menuMatchButtonWidth, menuOffset, options.length]);

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
      if (e.key === 'Escape') {
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
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

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
        title={buttonLabel != null ? selectedTitle : undefined}
        className={`w-full px-2 py-1 text-sm border rounded bg-white dark:bg-gray-700 dark:text-white border-gray-300 dark:border-gray-600 shadow-sm ${buttonClassName}`}
        onClick={() => {
          if (!open) {
            updateMenuPosition();
          }
          setOpen((v) => !v);
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
          aria-label={ariaLabel ? `${ariaLabel} options` : undefined}
          data-placement={menuPos.placement}
          className={`fixed z-[9999] max-h-64 overflow-auto rounded border bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 shadow-lg ${menuClassName}`}
          style={{
            top: menuPos.top,
            left: menuPos.left,
            width: menuMatchButtonWidth ? `${menuPos.width}px` : undefined,
            minWidth: menuMatchButtonWidth ? `${menuPos.width}px` : '200px',
          }}
        >
          <div className="py-1">
            {options.map((opt) => (
              <button
                key={opt.value}
                aria-selected={value === opt.value}
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
