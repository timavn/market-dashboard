import React from 'react';
import { finite, formatAthSessionDate, proxyFitSigned, proxyFitDeviationTone } from './proxyFitPresentation';
import './ProxyFitPanels.css';

// Display the prepared comparison only. Resource loading and acceptance remain in the monitor.
const ProxyFitPanel = ({ comparison, marketUi, contractReferenceLabel = null }) => {
  const status = ['available', 'partial', 'loading'].includes(String(comparison?.status || '').toLowerCase())
    ? String(comparison.status).toLowerCase()
    : 'unavailable';
  const rowsByWindow = new Map((Array.isArray(comparison?.rows) ? comparison.rows : [])
    .map((row) => [Number(row?.window), row]));
  const rows = [5, 20, 60, 120].map((window) => rowsByWindow.get(window) || {
    window,
    status: 'unavailable',
    averageBasisPct: null,
    deviationZ: null,
    returnCorrelation: null,
  });
  const comparisonUsable = status === 'available' || status === 'partial';
  const unavailableSpx = marketUi.symbol === 'SPX' && !comparisonUsable;
  const knownSpxContract = [comparison?.proxyLabel, contractReferenceLabel]
    .find((label) => /^(?:ES|MES)[FGHJKMNQUVXZ]\d{1,4}$/i.test(String(label || '').replace(/\s/g, '')));
  const proxyLabel = unavailableSpx
    ? knownSpxContract || 'UNAVAILABLE'
    : comparison?.proxyLabel || '—';
  const underlyingLabel = unavailableSpx ? 'SPX' : comparison?.underlyingLabel || marketUi.symbol || '—';
  const alignedDate = comparisonUsable
    && /^\d{4}-\d{2}-\d{2}$/.test(String(comparison?.alignedThroughDate || ''))
    ? formatAthSessionDate(comparison.alignedThroughDate)
    : null;
  const statusLabel = status === 'available'
    ? 'VERIFIED'
    : status === 'partial' ? 'PARTIAL' : status === 'loading' ? 'CHECKING' : 'UNAVAILABLE';

  return (
    <aside
      className={`pm-spx-proxy-fit is-${status}`}
      aria-label={`${marketUi.fullLabel} proxy fit comparison`}
      data-testid={`${marketUi.symbol.toLowerCase()}-proxy-fit`}
      title={comparison?.reason || comparison?.methodology || undefined}
    >
      <header>
        <strong>PROXY FIT</strong>
      </header>
      <div
        className="pm-spx-proxy-fit-pair"
        aria-label={`Proxy ${proxyLabel} compared with underlying ${underlyingLabel}`}
      >
        <b title={proxyLabel}>{proxyLabel}</b>
        <span aria-hidden="true">→</span>
        <b title={underlyingLabel}>{underlyingLabel}</b>
      </div>
      <div className="pm-spx-proxy-fit-current">
        <b className={`is-${status}`}>
          {comparisonUsable ? proxyFitSigned(comparison?.currentBasisPct, '%') : statusLabel}
        </b>
        <span>
          {comparisonUsable ? (
            <>
              <i>{statusLabel}</i>
              <em aria-hidden="true">·</em>
              <span>LAST ALIGNED BASIS · AS OF {alignedDate || '—'}</span>
            </>
          ) : status === 'loading'
            ? 'WAITING FOR VERIFIED COMPARISON'
            : 'NO VERIFIED ALIGNED COMPARISON'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th aria-label="WINDOW" />
            <th>AVG BASIS</th>
            <th>DEVIATION</th>
            <th>RET CORR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const available = comparisonUsable && row?.status === 'available';
            return (
              <tr key={row.window} className={available ? undefined : 'is-unavailable'}>
                <th>{row.window}D</th>
                <td>{available ? proxyFitSigned(row.averageBasisPct, '%') : '—'}</td>
                <td className={available ? proxyFitDeviationTone(row.deviationZ) : undefined}>
                  {available ? proxyFitSigned(row.deviationZ, 'σ') : '—'}
                </td>
                <td>{available && finite(row.returnCorrelation) ? Number(row.returnCorrelation).toFixed(2) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <footer>
        <span>COMPLETED, TIME-ALIGNED CLOSES · RETURNS CORRELATION</span>
        {marketUi.symbol === 'BRENT' && (
          <span>
            PYTH INDEX NOT INCLUDED · LIVE HISTORY ENTITLEMENT REQUIRED
            {comparison?.exactResolverUrl && (
              <a href={comparison.exactResolverUrl} target="_blank" rel="noreferrer">
                OPEN EXACT PYTH BRENT INDEX
              </a>
            )}
          </span>
        )}
      </footer>
    </aside>
  );
};

export default ProxyFitPanel;
