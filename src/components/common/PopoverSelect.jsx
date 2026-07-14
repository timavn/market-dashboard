import React, { useEffect, useRef, useState } from 'react';

const PopoverSelect = ({
  ariaLabel,
  value,
  options,
  onChange,
  buttonClassName = '',
  menuClassName = '',
  optionClassName = '',
  menuMatchButtonWidth = false,
  menuOffset = 8,
}) => {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 200 });
  const ref = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, []);

  // Find the label for the current value
  const displayLabel = options.find(opt => opt.value === value)?.label || value;

  return (
    <div ref={ref} className="relative w-full">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        role={ariaLabel ? 'combobox' : undefined}
        className={`w-full px-2 py-1 text-sm border rounded bg-white dark:bg-gray-700 dark:text-white border-gray-300 dark:border-gray-600 shadow-sm ${buttonClassName}`}
        onClick={() => {
          if (!open) {
            // Calculate position before opening
            if (buttonRef.current) {
              const rect = buttonRef.current.getBoundingClientRect();
              const menuWidth = menuMatchButtonWidth ? rect.width : 200;
              let left = rect.left;
              // Ensure menu doesn't go off-screen right
              if (left + menuWidth > window.innerWidth) {
                left = Math.max(8, window.innerWidth - menuWidth - 8);
              }
              setMenuPos({
                top: rect.bottom + menuOffset,
                left: left,
                width: menuWidth,
              });
            }
          }
          setOpen((v) => !v);
        }}
      >
        {displayLabel}
      </button>
      {open && (
        <div
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
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PopoverSelect;
