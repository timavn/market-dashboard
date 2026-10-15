import React from 'react';
import { finite, formatPythTrackingUsd } from './proxyFitPresentation';
import './ProxyFitPanels.css';

// Display the prepared comparison only. Resource loading and acceptance remain in the monitor.
const PythTrackingPanel = ({ tracking }) => {
  const status = ['available', 'partial', 'loading'].includes(String(tracking?.status || '').toLowerCase())
    ? String(tracking.status).toLowerCase()
    : 'unavailable';
  const available = status === 'available';
  const latestFinal = tracking?.currentEventFinal || tracking?.latestFinal || null;
  const guardBand = finite(tracking?.guardBandUsd) ? Number(tracking.guardBandUsd) : 10;
  const metrics = [
    ['N', Number.isInteger(Number(tracking?.sampleSize)) ? Number(tracking.sampleSize) : 0],
    ['BIAS', formatPythTrackingUsd(tracking?.meanSignedErrorUsd, { signed: true })],
    ['MAE', formatPythTrackingUsd(tracking?.meanAbsoluteErrorUsd)],
    ['MEDIAN', formatPythTrackingUsd(tracking?.medianAbsoluteErrorUsd)],
    ['P90', formatPythTrackingUsd(tracking?.p90AbsoluteErrorUsd)],
    ['MAX', formatPythTrackingUsd(tracking?.maxAbsoluteErrorUsd)],
  ];
  return (
    <aside
      className={`pm-spx-proxy-fit pm-gold-pyth-tracking is-${status}`}
      aria-label="Gold Pyth resolver tracking"
      data-testid="gold-pyth-tracking"
      title={tracking?.reason || tracking?.methodology || undefined}
    >
      <header><strong>PYTH TRACKING</strong></header>
      <div className="pm-spx-proxy-fit-pair" aria-label="IBKR XAUUSD proxy compared with Pyth Metal Index Gold USD">
        <b>XAUUSD</b><span aria-hidden="true">→</span><b>PYTH GOLD/USD</b>
      </div>
      <div className="pm-gold-pyth-resolver">
        <span>PYTH 1-MIN CANDLE CLOSE · 4:59–5:00 PM ET</span>
      </div>
      <div className="pm-spx-proxy-fit-current">
        <b className={`is-${status}`}>±{formatPythTrackingUsd(guardBand)}</b>
      </div>
      <dl className="pm-gold-pyth-metrics">
        {metrics.map(([label, value]) => (
          <div key={label} className={!available && label !== 'N' ? 'is-unavailable' : undefined}>
            <dt>{label}</dt><dd>{available || label === 'N' ? value : '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="pm-gold-pyth-final">
        <span>{tracking?.currentEventFinal ? 'CURRENT EVENT FINAL' : 'LATEST OFFICIAL FINAL'}</span>
        <strong>{latestFinal && finite(latestFinal.value)
          ? `$${Number(latestFinal.value).toFixed(2)}`
          : '—'}</strong>
        <small>{latestFinal?.eventTicker || 'NO FINALIZED MATCH'}</small>
      </div>
    </aside>
  );
};

export default PythTrackingPanel;
