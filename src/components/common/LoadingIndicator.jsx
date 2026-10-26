import React, { useEffect, useState } from 'react';
import AnalystSpinner from '../Dashboard/AnalystSpinner';
import './RefreshButton.css';

const SIZE_CLASS = {
  sm: 'app-loading--sm',
  md: 'app-loading--md',
  lg: 'app-loading--lg',
};
const RING_SIZE = { sm: 14, md: 16, lg: 20 };
// A load that has not finished by now is treated as failed; data that arrives later still replaces this.
export const LOADING_LIMIT_MS = 5_000;

/**
 * The one loading state the dashboard shows: the turning ring and the blue
 * seconds since it appeared. The label is for screen readers only, so every
 * load looks the same. After LOADING_LIMIT_MS it stops and reads Unavailable.
 * Pass announce={false} inside an element that is already a status.
 */
function LoadingIndicator({
  label,
  size = 'md',
  centered = false,
  className = '',
  announce = true,
}) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), LOADING_LIMIT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span
      className={[
        'app-loading',
        SIZE_CLASS[size] || SIZE_CLASS.md,
        centered ? 'app-loading--centered' : '',
        expired ? 'app-loading--expired' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...(announce ? { role: 'status', 'aria-live': 'polite' } : {})}
    >
      {expired ? 'Unavailable' : <>
        <AnalystSpinner size={RING_SIZE[size] || RING_SIZE.md} elapsed />
        {label && <span className="sr-only">{label}</span>}
      </>}
    </span>
  );
}

export default LoadingIndicator;
