import React, { useState, useEffect, useRef } from 'react';
import {
  formatDateOnly,
  formatLastUpdated,
  formatLastUpdatedForSources
} from '../../utils/timeUtils';

/**
 * StatusDot
 *
 * Clickable status indicator dot that opens a small popover showing
 * the last refresh time and relative age of the data powering a card.
 *
 * Props:
 * - updatedAt: Date | string | number – timestamp for last refresh
 * - status: 'active' | 'inactive' | 'stale' | undefined – optional explicit status
 * - size: number – dot size in px
 * - className: string – extra classes for positioning
 * - label: string – optional label describing which data this refers to
 * - emoji: string – optional emoji to render for shiny-dot style
 * - sources: optional array of sub-sources to show in popup
 * - overallLabel: optional override label for overall line
 * - showDateOnly: optional boolean to show only the update date
 */
const StatusDot = ({
  updatedAt,
  status,
  size = 8,
  className = '',
  label,
  emoji,
  sources,
  overallLabel,
  showDateOnly = false
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const updatedDate = updatedAt ? new Date(updatedAt) : null;

  // Derive color: explicit status wins, otherwise based on age thresholds
  const now = new Date();
  const hoursAgo = updatedDate ? (now - updatedDate) / (1000 * 60 * 60) : null;

  let colorClass = 'bg-gray-400';
  if (status === 'active' || status === 'current') {
    colorClass = 'bg-green-500';
  } else if (status === 'inactive' || status === 'defective') {
    colorClass = 'bg-red-500';
  } else if (status === 'stale') {
    colorClass = 'bg-yellow-500';
  } else if (hoursAgo != null) {
    if (hoursAgo < 24) {
      colorClass = 'bg-green-500';
    } else if (hoursAgo < 72) {
      colorClass = 'bg-yellow-500';
    } else {
      colorClass = 'bg-red-500';
    }
  }

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => !prev);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((prev) => !prev);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center ${className}`}
    >
      <button
        type="button"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          label
            ? `Show last updated time for ${label}`
            : 'Show last updated time'
        }
        className={`rounded-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 ${
          emoji ? '' : colorClass
        }`}
        style={{
          width: `${size + (emoji ? 2 : 0)}px`,
          height: `${size + (emoji ? 2 : 0)}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {emoji && (
          <span
            className="ticker-dot-emoji"
            style={{ fontSize: '8px', lineHeight: 1 }}
          >
            {emoji}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          className="absolute z-20 mt-2 px-3 py-2 bg-gray-900 dark:bg-gray-800 text-white text-xs rounded shadow-lg whitespace-nowrap"
          style={{
            top: '100%',
            left: 0
          }}
        >
          {Array.isArray(sources) && sources.length > 0 ? (
            (() => {
              const { perSource } = formatLastUpdatedForSources(sources);
              return (
                <>
                  {overallLabel || label ? (
                    <div className="font-semibold mb-1">
                      {overallLabel || label}
                    </div>
                  ) : null}
                  <div className="space-y-0.5">
                    {perSource.map((src) => {
                      const status = src.status || 'current';
                      const rowColor =
                        status === 'defective'
                          ? 'text-red-300'
                          : status === 'stale'
                            ? 'text-yellow-300'
                            : 'text-gray-200';
                      return (
                        <div key={src.id} className={`flex justify-between gap-2 ${rowColor}`}>
                          <span>{src.label}</span>
                          <span className="opacity-90">{src.localeString}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()
          ) : (
            (() => {
              const { localeString } = formatLastUpdated(updatedDate || null);
              const dateOnly = formatDateOnly(updatedDate || null);
              return (
                <>
                  <div className="font-semibold">
                    {showDateOnly ? `Updated: ${dateOnly}` : `Last updated: ${localeString}`}
                  </div>
                  {label && (
                    <div className="text-gray-400 mt-0.5">
                      {label}
                    </div>
                  )}
                </>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
};

export default StatusDot;
