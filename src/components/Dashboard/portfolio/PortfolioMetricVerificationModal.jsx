import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import PositionSizeExplanation from '../PositionSizeExplanation';
import QuadRankingExplanation from '../QuadRankingExplanation';

// The parent retains the selection and revalidates position-size inputs each render.
export default function PortfolioMetricVerificationModal({ active, selection, positionSizeReference, onClose }) {
  useEffect(() => {
    if (!active || !selection) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, selection, onClose]);

  if (!active || !selection) return null;

  return createPortal(
    <div
      className="pcv2-verification-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`pcv2-verification-dialog${['Position size', 'Quad +EV'].includes(selection.metric) ? ' pcv2-verification-dialog--sizing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pcv2-verification-title"
      >
        <header className="pcv2-verification-header">
          <div>
            <span>{selection.symbol}</span>
            <h2 id="pcv2-verification-title">{selection.metric} {selection.metric === 'Quad +EV' ? 'ranking' : 'calculation'}</h2>
          </div>
          <button
            type="button"
            aria-label="Close calculation"
            title="Close"
            onClick={() => onClose()}
            autoFocus
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        {selection.metric === 'Position size' ? (
          <PositionSizeExplanation
            symbol={selection.symbol}
            reference={positionSizeReference}
          />
        ) : selection.metric === 'Quad +EV' ? (
          <QuadRankingExplanation classification={selection.classification} />
        ) : <>
          {selection.takeaway && (
            <p className="pcv2-verification-takeaway"><strong>Quick takeaway.</strong>{' '}{selection.takeaway}</p>
          )}
          <div className="pcv2-verification-formula">{selection.formula}</div>
          <div className="pcv2-verification-equation">{selection.equation}</div>
          <dl className="pcv2-verification-result">
            <dt>Result</dt>
            <dd>{selection.result}</dd>
          </dl>
          <div className="pcv2-verification-details">
            {selection.details.map((detail) => <span key={detail}>{detail}</span>)}
          </div>
        </>}
      </section>
    </div>,
    document.body,
  );
}
