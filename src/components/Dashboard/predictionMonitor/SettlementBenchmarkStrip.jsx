import React from 'react';
import { formatIndex } from './monitorFormatting';
import { formatBenchmarkObservation } from './settlementBenchmark';
import './SettlementBenchmarkStrip.css';

export default function SettlementBenchmarkStrip({ benchmark }) {
  const available = benchmark.status === 'live';
  const details = [
    benchmark.sourceName ? `${benchmark.sourceName} · ${benchmark.symbol}.` : 'Verified settlement benchmark unavailable.',
    available ? `Observed ${formatBenchmarkObservation(benchmark.asOf)}.` : 'Current benchmark unavailable.',
    benchmark.method ? `Current benchmark input. Settlement uses ${benchmark.method}.` : null,
  ].filter(Boolean).join(' ');
  return (
    <div className="pm-settlement-benchmark" role="group" aria-label="Prediction contract settlement input" title={details}>
      <span className="pm-settlement-benchmark-label">SETTLEMENT INPUT</span>
      {benchmark.sourceUrl ? (
        <a href={benchmark.sourceUrl} target="_blank" rel="noreferrer" aria-label={details}>{benchmark.symbol}</a>
      ) : null}
      {available && <span>{formatIndex(benchmark.value, 2)}</span>}
      <span className={`pm-settlement-benchmark-status is-${benchmark.status}`}>{available ? 'LIVE' : 'UNAVAILABLE'}</span>
    </div>
  );
}
