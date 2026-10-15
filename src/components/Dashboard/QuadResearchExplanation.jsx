import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import usePageScrollLock from '../../hooks/usePageScrollLock';
import './QuadResearchExplanation.css';

const formatDate = value => new Date(value).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const formatPeriod = value => /^\d{4}-?Q[1-4]$/.test(value) ? value.replace('-Q', 'Q') : formatDate(value);
const periodIndex = value => {
  const quarter = /^(\d{4})-?Q([1-4])$/.exec(value || '');
  if (quarter) return Number(quarter[1]) * 4 + Number(quarter[2]);
  const date = new Date(value);
  return date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3) + 1;
};

export default function QuadResearchExplanation({ label, quad, cell, snapshot, onClose }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const supported = cell.status === 'supported';
  const methodologyChange = supported && cell.benchmark?.methodologyChanges?.find(change => (
    periodIndex(change.endDate || change.date) >= periodIndex(cell.sampleStart)
    && periodIndex(change.date) <= periodIndex(cell.sampleEnd)
  ));
  usePageScrollLock(true);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = [...dialogRef.current.querySelectorAll('button:not([disabled]), a[href]')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      const outside = !dialogRef.current.contains(document.activeElement);
      if (outside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="quad-research-backdrop" data-testid="quad-research-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="quad-research-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} ref={dialogRef}>
        <header className="quad-research-header">
          <div>
            <span>{label} · Quad {quad}</span>
            <h2 id={titleId}>{supported ? `Rank ${cell.rank} of ${cell.peerCount}*` : 'Rank unavailable'}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close Quad research explanation">×</button>
        </header>
        <div className="quad-research-body">
          <p id={descriptionId}>{supported
            ? '* Independently calculated historical rank. A smaller number means a higher average quarterly total return among the defined peers.'
            : cell.reason}</p>
          {cell.benchmark && <p className="quad-research-benchmark">
            <a href={cell.benchmark.sourceUrl} target="_blank" rel="noreferrer">{cell.benchmark.symbol} ↗</a>
            {' '}{cell.benchmark.definition}
          </p>}
          {methodologyChange && <p className="quad-research-basis">Fund benchmark changed during this sample;{' '}
            <a href={methodologyChange.sourceUrl} target="_blank" rel="noreferrer">see issuer methodology ↗</a>.
          </p>}
          {supported && <dl>
            <div><dt>Average quarterly return</dt><dd>{(cell.meanReturn * 100).toFixed(2)}%</dd></div>
            <div><dt>Sample</dt><dd>{formatPeriod(cell.sampleStart)}–{formatPeriod(cell.sampleEnd)}</dd></div>
            <div><dt>Target Quad observations</dt><dd>{cell.observations} quarters · {cell.episodes} episodes</dd></div>
            <div><dt>80% rank intervals</dt><dd>{[2, 4, 8].map(blockLength => {
              const interval = cell.diagnostics.bootstrap[blockLength].interval;
              return <span className="quad-research-interval" key={blockLength}>{interval.lower}–{interval.upper} <small>({blockLength}q blocks)</small></span>;
            })}</dd></div>
            <div><dt>Calculated</dt><dd>{formatDate(snapshot.generatedAt)}</dd></div>
          </dl>}
          <p className="quad-research-basis">{supported
            ? 'Ranks compare total returns within our peer group. Hedgeye’s published best/worst lists use a different methodology.'
            : 'The saved Hedgeye list supplies no rank for this cell. We withhold independent estimates without a defined benchmark and sufficient, stable evidence.'}
            {' '}This is retrospective research: GDP advance releases arrive after quarter-end. It does not describe information available to trade during that quarter.
          </p>
        </div>
      </section>
    </div>, document.body,
  );
}
