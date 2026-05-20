import React from 'react';
import { RefreshCw } from 'lucide-react';
import './RefreshButton.css';

/**
 * Standard refresh/retry control (Macro Signals style).
 */
function RefreshButton({
  onClick,
  loading = false,
  disabled = false,
  label = 'Refresh',
  title,
  iconOnly = false,
  className = '',
  type = 'button',
}) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={[
        'app-refresh-btn',
        iconOnly ? 'app-refresh-btn--icon-only' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      title={title ?? label}
      onClick={onClick}
      disabled={isDisabled}
      aria-busy={loading || undefined}
    >
      <RefreshCw
        className={`app-refresh-btn-icon${loading ? ' app-spin' : ''}`}
        aria-hidden
      />
      {!iconOnly && label}
    </button>
  );
}

export default RefreshButton;
