import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getVolatilityIndexDefinition } from '../../constants/volatilityIndexDefinitions';
import { VOL_RANGES } from '../../utils/volatilityRegimes';
import './VolatilityExplainerModal.css';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const formatModalRange = ({ min, max }) => {
  if (max == null) return `≥ ${min}`;
  if (Number(min) === 0) return `< ${max}`;
  return `${min} to < ${max}`;
};

const VolatilityExplainerModal = ({ indicatorKey, onClose }) => {
  const info = getVolatilityIndexDefinition(indicatorKey);
  const ranges = VOL_RANGES[indicatorKey]?.ranges || [];
  const rangeSource = VOL_RANGES[indicatorKey]?.source || null;
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!info) return undefined;
    const previouslyFocused = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = priorOverflow;
      previouslyFocused?.focus?.();
    };
  }, [info, onClose]);

  if (!info || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="vol-explainer-backdrop"
      data-testid="volatility-explainer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className="vol-explainer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-indicator={indicatorKey}
      >
        <header className="vol-explainer-header">
          <div>
            <span className="vol-explainer-symbol">{info.symbol}</span>
            <p>{info.horizon}</p>
            <h2 id={titleId}>{info.name}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="vol-explainer-close"
            onClick={onClose}
            aria-label={`Close ${info.symbol} explainer`}
          >
            ×
          </button>
        </header>

        <div className="vol-explainer-body" id={descriptionId}>
          <div className="vol-explainer-summary-grid">
            <section>
              <h3>What it is</h3>
              <p>{info.what}</p>
            </section>
            <section>
              <h3>How it is used</h3>
              <p>{info.usedFor}</p>
            </section>
            <section>
              <h3>Role in the process</h3>
              <p>{info.processRole}</p>
            </section>
            <section>
              <h3>How to read the number</h3>
              <p>{info.numberMeaning}</p>
            </section>
          </div>

          <section className="vol-explainer-calculation">
            <h3>How it is calculated</h3>
            <p>{info.calculation}</p>
            <code>{info.formula}</code>
            {info.formulaTerms !== false ? (
              <dl>
                <div><dt>T</dt><dd>time to option expiration</dd></div>
                <div><dt>K</dt><dd>option strike</dd></div>
                <div><dt>Q(K)</dt><dd>option mid-quote</dd></div>
                <div><dt>F</dt><dd>forward level implied by options</dd></div>
              </dl>
            ) : null}
          </section>

          <section className="vol-explainer-ranges" aria-label={`${info.symbol} dashboard process ranges`}>
            <div className="vol-explainer-section-heading">
              <div>
                <h3>Dashboard process ranges</h3>
                <p>These are dashboard heuristics, not exchange-defined trading signals.</p>
              </div>
              {rangeSource ? <span>{rangeSource}</span> : null}
            </div>
            {ranges.length ? (
              <div className="vol-explainer-range-grid">
                {ranges.map((range) => (
                  <article
                    key={`${range.min}-${range.max ?? 'up'}`}
                    className={`vol-explainer-range is-${range.color}`}
                  >
                    <small>{range.label}</small>
                    <strong>{formatModalRange(range)}</strong>
                    <p>{range.desc}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="vol-explainer-no-ranges">
                <strong>No validated process bands yet.</strong>
                <p>{info.symbol} is shown as context only. Use its level, direction, and history without assigning a green/yellow/red regime.</p>
              </div>
            )}
          </section>

          <footer className="vol-explainer-footer">
            <p>Educational context only. The explainer does not replace the verified live reading shown on the dashboard.</p>
            <a href={info.sourceUrl} target="_blank" rel="noreferrer">
              {info.sourceLabel} ↗
            </a>
          </footer>
        </div>
      </section>
    </div>,
    document.body,
  );
};

export default VolatilityExplainerModal;
