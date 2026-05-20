import React from 'react';
import { RefreshCw } from 'lucide-react';
import './RefreshButton.css';

const SIZE_CLASS = {
  sm: 'app-loading--sm',
  md: 'app-loading--md',
  lg: 'app-loading--lg',
};

/**
 * Standard loading state (spinning RefreshCw + optional label).
 */
function LoadingIndicator({
  label,
  size = 'md',
  centered = false,
  className = '',
}) {
  return (
    <div
      className={[
        'app-loading',
        SIZE_CLASS[size] || SIZE_CLASS.md,
        centered ? 'app-loading--centered' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="app-loading-icon app-spin" aria-hidden />
      {label && <span className="app-loading-label">{label}</span>}
    </div>
  );
}

export default LoadingIndicator;
