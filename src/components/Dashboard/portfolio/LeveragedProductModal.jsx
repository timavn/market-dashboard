import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useLeveragedProductOverlap from '../../../hooks/useLeveragedProductOverlap';
import { formatResearchSourceDate } from '../../../utils/researchDateFormat';
import { leveragedDirectionClass } from './leveragedProductPresentation';

// Remain mounted while hidden so the parent-owned selection can resume.
export default function LeveragedProductModal({ active, selection, onClose }) {
  const overlapState = useLeveragedProductOverlap({
    active,
    baseSymbol: selection?.baseSymbol,
    referenceSymbol: selection?.product?.overlapReferenceSymbol,
  });

  useEffect(() => {
    if (!active || !selection) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, selection, onClose]);

  if (!active || !selection) return null;
  const { baseSymbol, product } = selection;
  const referenceLabel = String(product.reference || 'Reference exposure')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const directionClass = leveragedDirectionClass(product.leverage);
  const fitLabel = product.fitLabel || product.matchLabel;
  const fitNote = product.fitNote
    || (product.matchType === 'proxy' ? `Different or broader exposure than ${baseSymbol}.` : null);
  const overlap = overlapState.status === 'available'
    && overlapState.data?.baseSymbol === baseSymbol
    && overlapState.data?.referenceSymbol === product.overlapReferenceSymbol
    ? overlapState.data
    : null;
  const overlapPercent = overlap ? Math.round(Number(overlap.weightedOverlapPct)) : null;
  const displayedFitLabel = overlapPercent == null
    ? fitLabel
    : `${fitLabel} · ${overlapPercent}% overlap`;
  const displayedFitNote = overlap
    ? `${overlap.sharedHoldings} shared holdings · ${formatResearchSourceDate(overlap.asOf)}. ${fitNote || ''}`.trim()
    : fitNote;

  return createPortal(
    <div
      className="pcv2-leveraged-product-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pcv2-leveraged-product-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pcv2-leveraged-product-title"
        aria-describedby={displayedFitNote ? 'pcv2-leveraged-product-fit-note' : undefined}
        data-testid="leveraged-product-modal"
      >
        <header className="pcv2-leveraged-product-header">
          <div>
            <h2 id="pcv2-leveraged-product-title">{product.ticker}</h2>
            <p
              className={directionClass}
              data-testid="leveraged-product-direction"
            >
              {product.leverage} daily
            </p>
          </div>
          <button
            type="button"
            aria-label="Close leveraged product details"
            title="Close"
            onClick={() => onClose()}
            autoFocus
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <dl className="pcv2-leveraged-product-details">
          <div>
            <dt>Tracks</dt>
            <dd>{referenceLabel}</dd>
          </div>
          <div>
            <dt>{baseSymbol} fit</dt>
            <dd>
              <strong title={overlap ? 'Weighted overlap: the smaller portfolio weight for each shared holding, summed.' : undefined}>
                {displayedFitLabel}
              </strong>
              {displayedFitNote ? (
                <span id="pcv2-leveraged-product-fit-note">{displayedFitNote}</span>
              ) : null}
            </dd>
          </div>
        </dl>
        <footer className="pcv2-leveraged-product-footer">
          <p>Daily reset · Multi-day returns may diverge.</p>
          {product.issuerUrl ? (
            <a
              className="pcv2-leveraged-product-issuer-link"
              href={product.issuerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {product.issuer} ↗
            </a>
          ) : (
            <span className="pcv2-leveraged-product-issuer-link is-disabled">Issuer page unavailable</span>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
