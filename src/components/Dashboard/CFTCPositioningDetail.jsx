import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import usePageScrollLock from '../../hooks/usePageScrollLock';
import { CFTC_HISTORY_FIELDS, CFTC_SERIES_LABELS } from '../../constants/cftcPositioning';
import {
  cftcValueClass,
  formatCftcDate,
  formatCftcNumber,
  formatCftcRetrieval,
  getCftcRowKey,
  getCftcSourceUrl,
  isCftcResearchRow,
} from '../../utils/cftcPositioningPresentation';
import './CFTCPositioningDetail.css';

const PositioningValues = ({ row }) => (
  <dl className="cftc-detail__values">
    <div><dt>Net contracts</dt><dd className={cftcValueClass(row.latest)}>{formatCftcNumber(row.latest)}</dd></div>
    <div><dt>W/W change</dt><dd className={cftcValueClass(row.wwChg)}>{formatCftcNumber(row.wwChg, { signed: true })}</dd></div>
    <div><dt>1Y Z-score</dt><dd className={cftcValueClass(row.zScore1Y, { score: true })}>{formatCftcNumber(row.zScore1Y, { score: true })}</dd></div>
    <div><dt>3Y Z-score</dt><dd className={cftcValueClass(row.zScore3Y, { score: true })}>{formatCftcNumber(row.zScore3Y, { score: true })}</dd></div>
  </dl>
);

const SeriesSource = ({ row, snapshot }) => {
  const sourceUrl = getCftcSourceUrl(row, snapshot);
  return (
    <p className="cftc-detail__series-source">
      {CFTC_SERIES_LABELS[row.seriesType]?.label || 'Series unavailable'} · Futures + options
      {sourceUrl && <> · <a href={sourceUrl} target="_blank" rel="noreferrer">Official CFTC source ↗</a></>}
    </p>
  );
};

const HistoricalContext = ({ row, snapshot, alternate = false }) => {
  const statistics = isCftcResearchRow(row, snapshot) && snapshot.schemaVersion === 'cftc-positioning-v3'
    ? row.historyStatistics : null;
  return (
    <section className="cftc-detail__history" aria-label={alternate ? 'Alternative historical positioning context' : 'Historical positioning context'}>
      <h3>Historical context</h3>
      <dl>
        {CFTC_HISTORY_FIELDS.map(({ key, label }) => (
          <div key={key}><dt>{label}</dt><dd className={cftcValueClass(statistics?.[key])}>{formatCftcNumber(statistics?.[key])}</dd></div>
        ))}
      </dl>
      {!statistics && <p>Historical statistics unavailable for this snapshot.</p>}
    </section>
  );
};

const CFTCPositioningDetail = ({ row, snapshot, freshness, onClose }) => {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const verified = isCftcResearchRow(row, snapshot);
  const alternatives = verified && snapshot.schemaVersion === 'cftc-positioning-v3' && Array.isArray(row.alternateSeries)
    ? row.alternateSeries.filter(alternative => isCftcResearchRow(alternative, snapshot)
      && alternative.cftcContractMarketCode === row.cftcContractMarketCode
      && alternative.asOf === row.asOf
      && alternative.seriesType !== row.seriesType) : [];

  usePageScrollLock(true);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const handleKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // This dialog sits above the expanded reference table. Escape closes
        // only the current detail, preserving the table and its trigger focus.
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll('button, a[href]') || []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="cftc-detail-backdrop"
      data-testid="cftc-detail-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="cftc-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="cftc-detail__header">
          <h2 id={titleId}>{row.metric} positioning</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close positioning details">×</button>
        </header>
        <div className="cftc-detail__body">
          {freshness.referenceOnly && <p className="cftc-detail__reference">{freshness.label}</p>}
          {verified ? <>
            <SeriesSource row={row} snapshot={snapshot} />
            <dl className="cftc-detail__dates">
              <div><dt>Positions as of</dt><dd>{formatCftcDate(row.asOf)}</dd></div>
              <div><dt>Retrieved</dt><dd>{formatCftcRetrieval(snapshot.retrievedAt)}</dd></div>
            </dl>
            {row.status === 'discontinued' && <p className="cftc-detail__reference">DISCONTINUED · Historical reference</p>}
            <PositioningValues row={row} />
          </> : <p className="cftc-detail__reference">VERIFIED POSITIONING UNAVAILABLE</p>}

          <HistoricalContext row={row} snapshot={snapshot} />

          {alternatives.map(alternative => (
            <section className="cftc-detail__alternative" key={getCftcRowKey(alternative)} aria-label="Alternative trader group">
              <h3>Alternative trader group</h3>
              <SeriesSource row={alternative} snapshot={snapshot} />
              <p>Positions as of {formatCftcDate(alternative.asOf)}</p>
              <PositioningValues row={alternative} />
              <HistoricalContext row={alternative} snapshot={snapshot} alternate />
            </section>
          ))}

          <section className="cftc-detail__methodology">
            <h3>How to read it</h3>
            <p>Net positioning is long contracts minus short contracts. A positive z-score means positioning is above its own historical average; a negative score means below.</p>
            <p>3M, 6M and 1Y averages use 13, 26 and 52 weekly observations; 3Y uses 156. Each window includes the current report. Z-score = (net − window average) ÷ sample standard deviation.</p>
            <p>Negative values are red; positive z-scores are green. Outlines mark z-scores above +2 or below −2. Colors describe positioning, not buy or sell signals.</p>
          </section>
        </div>
      </section>
    </div>,
    document.body,
  );
};

export default CFTCPositioningDetail;
