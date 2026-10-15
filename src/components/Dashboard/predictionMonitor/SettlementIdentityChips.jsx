import React, { useId } from 'react';
import { buildSettlementIdentityViewModel } from './settlementIdentity';

const SettlementIdentityChips = ({ venueSelection, checking = false, nowMs = Date.now() }) => {
  const tooltipId = useId();
  const identity = buildSettlementIdentityViewModel(venueSelection, { checking, nowMs });
  const basis = identity.basis;
  return (
    <div
      className={`pm-spx-settlement-identity pm-spx-settlement-identity--compact is-${identity.status}`}
      tabIndex={0}
      aria-label={identity.accessibleLabel}
      aria-describedby={tooltipId}
      data-settlement-status={identity.status}
    >
        <span className={`pm-spx-venue-chip is-${identity.status}`}>
          <strong>{identity.venueText}</strong>
          {identity.productCode && <small>{identity.productCode}</small>}
        </span>
        <div id={tooltipId} className="pm-spx-settlement-tooltip" role="tooltip">
          <strong>{identity.eventTicker ? `EVENT · ${identity.eventTicker}` : 'EVENT · UNAVAILABLE'}</strong>
          {['verified', 'partial'].includes(identity.status) ? (
            <>
              <span>{identity.status === 'partial' ? 'PRODUCT' : 'INSTRUMENT'} · {basis.instrument}</span>
              <span>METHOD · {basis.method}</span>
              <span>OBSERVATION · <time dateTime={basis.observationAt}>{basis.observationAt}</time></span>
              <span>
                SOURCE · <a href={basis.sourceUrl} target="_blank" rel="noreferrer">{basis.sourceName}</a>
              </span>
              <span>
                OFFICIAL RULES · {basis.rulesUrl
                  ? <a href={basis.rulesUrl} target="_blank" rel="noreferrer">{basis.rulesUrl}</a>
                  : identity.eventTicker || 'Contract metadata identity unavailable'}
              </span>
              {identity.status === 'partial' && <span>LIMITATION · {identity.reason}</span>}
            </>
          ) : (
            <span>{identity.reason || 'Waiting for authoritative generation metadata.'}</span>
          )}
        </div>
    </div>
  );
};

export { SettlementIdentityChips };
