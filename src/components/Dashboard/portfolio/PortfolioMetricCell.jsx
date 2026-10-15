import React from 'react';

const PortfolioMetricCell = ({
  value,
  meta,
  tone = '',
  title = null,
  className = '',
  spanClassName = 'pcv2-intel-span-2',
  children = null,
  onClick = null,
  buttonLabel = null,
}) => {
  const accessibleLabel = [
    value === null || value === undefined ? null : String(value),
    meta,
    title,
  ].filter(Boolean).join(' · ');
  return (
    <div
      className={`pcv2-intel-cell ${spanClassName} ${className}`.trim()}
      title={title || meta || undefined}
      aria-label={accessibleLabel || undefined}
    >
      {onClick ? (
        <button
          type="button"
          className="pcv2-intel-metric-button"
          aria-label={buttonLabel || undefined}
          title={buttonLabel || undefined}
          onClick={onClick}
        >
          <span className={`pcv2-intel-value ${tone}`.trim()}>
            {children || value}
          </span>
        </button>
      ) : (
        <div className={`pcv2-intel-value ${tone}`.trim()}>
          {children || value}
        </div>
      )}
    </div>
  );
};

export default PortfolioMetricCell;
