import React from 'react';
import RefreshButton from '../common/RefreshButton';
import './ReferenceProductPanels.css';

const ReferencePanelShell = ({
  title,
  subtitle,
  status,
  statusTone = 'neutral',
  onRefresh,
  refreshing = false,
  onClose,
  children,
}) => (
  <section className="reference-panel" aria-label={title}>
    <header className="reference-panel__header">
      <div className="reference-panel__heading">
        <div className="reference-panel__title-row">
          <h1>{title}</h1>
          {status && (
            <span className={`reference-panel__status reference-panel__status--${statusTone}`}>
              {status}
            </span>
          )}
        </div>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="reference-panel__actions">
        {onRefresh && (
          <RefreshButton
            onClick={onRefresh}
            loading={refreshing}
            iconOnly
            title={`Refresh ${title}`}
          />
        )}
        <button
          type="button"
          className="reference-panel__close"
          onClick={onClose}
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
        >
          ×
        </button>
      </div>
    </header>
    <div className="reference-panel__body">{children}</div>
  </section>
);

export default ReferencePanelShell;
