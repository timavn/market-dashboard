import React from 'react';
import { RefreshCw } from 'lucide-react';
import AnalystSpinner from '../Dashboard/AnalystSpinner';
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
      {loading ? <AnalystSpinner size={14} elapsed /> : <RefreshCw className="app-refresh-btn-icon" aria-hidden />}
      {!iconOnly && label}
    </button>
  );
}

export default RefreshButton;
