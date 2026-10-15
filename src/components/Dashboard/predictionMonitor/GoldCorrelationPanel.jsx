import React from 'react';
import { GOLD_CORRELATION_HORIZONS } from './goldCorrelationContext';
import { isFiniteGoldContextValue as finite } from './goldContextValidation';
import './GoldCorrelationPanel.css';

const GOLD_CORRELATION_SHADE_THRESHOLD = 0.5;
const GOLD_CORRELATION_STRONG_THRESHOLD = 0.7;

const goldCorrelationHeatClass = (value) => {
  if (!finite(value)) return 'is-unavailable';
  const displayed = Number(Number(value).toFixed(2));
  const magnitude = Math.abs(displayed);
  if (displayed === 0) return 'is-neutral';
  const direction = displayed > 0 ? 'positive' : 'negative';
  if (magnitude >= GOLD_CORRELATION_STRONG_THRESHOLD) return `is-${direction}-strong`;
  if (magnitude >= GOLD_CORRELATION_SHADE_THRESHOLD) return `is-${direction}-light`;
  return `is-${direction}`;
};

const formatCorrelationCell = (value) => finite(value)
  ? Math.abs(Number(value)).toFixed(2)
  : '—';

const goldCorrelationAccessibleLabel = (rowLabel, horizon, value) => {
  if (!finite(value)) return `${rowLabel} ${horizon}: correlation unavailable`;
  const displayed = Number(Number(value).toFixed(2));
  const direction = displayed > 0 ? 'positive' : displayed < 0 ? 'negative' : 'zero';
  return `${rowLabel} ${horizon}: ${direction} correlation ${Math.abs(displayed).toFixed(2)}`;
};

const goldCorrelationLastFormatters = Object.freeze({
  index: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  percent: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  'USD/ozt': new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  'USD/bbl': new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
});

const formatGoldCorrelationLast = (latest) => {
  if (!finite(latest?.value)) return '—';
  const formatted = goldCorrelationLastFormatters[latest.unit]?.format(Number(latest.value));
  if (!formatted) return '—';
  return latest.unit === 'percent' ? `${formatted}%` : formatted;
};

const GoldCorrelationPanel = ({ snapshot, state = 'loading', reason = null }) => {
  const available = ['available', 'partial'].includes(snapshot?.status)
    && Array.isArray(snapshot?.rows)
    && snapshot.rows.length > 0;
  const loading = state === 'loading' && !available;
  return (
    <aside
      className={`pm-gold-correlation-panel is-${loading ? 'loading' : available ? snapshot.status : 'unavailable'}`}
      aria-label="Gold correlation matrix"
      data-testid="gold-correlation-panel"
    >
      <header>
        <strong>GOLD CORRELATION</strong>
        <span>XAUUSD PROXY BASIS · COMPLETED DAILY CHANGES</span>
      </header>
      {available ? (
        <table>
          <colgroup>
            <col className="is-driver" />
            <col className="is-last" />
            {GOLD_CORRELATION_HORIZONS.map((horizon) => <col key={horizon} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">DRIVER</th>
              <th scope="col">LAST</th>
              {GOLD_CORRELATION_HORIZONS.map((horizon) => <th key={horizon} scope="col">{horizon}</th>)}
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.map((row) => (
              <tr key={row.key} className={`is-${row.status}`} title={[row.source, row.asOf && `As of ${row.asOf}`, row.reason].filter(Boolean).join(' · ')}>
                <th scope="row">
                  <span>{row.label}</span>
                  {row.transform === 'yield_change_bps' && <small>Δ BP</small>}
                </th>
                <td
                  className="is-last"
                  aria-label={`${row.label} last completed observation: ${formatGoldCorrelationLast(row.latest)}${row.latest?.asOf ? ` as of ${row.latest.asOf}` : ''}`}
                >
                  {formatGoldCorrelationLast(row.latest)}
                </td>
                {GOLD_CORRELATION_HORIZONS.map((horizon) => {
                  const value = row.values?.[horizon];
                  return (
                    <td
                      key={horizon}
                      className={goldCorrelationHeatClass(value)}
                      aria-label={goldCorrelationAccessibleLabel(row.label, horizon, value)}
                    >
                      {formatCorrelationCell(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pm-gold-correlation-state" role="status" aria-live="polite">
          <strong>{loading ? 'CHECKING VERIFIED DAILY HISTORY' : 'CORRELATION DATA UNAVAILABLE'}</strong>
          <span>{loading
            ? 'Waiting for IBKR XAUUSD and current comparator histories.'
            : reason || snapshot?.reason || 'No verified current Gold correlation snapshot is available.'}</span>
        </div>
      )}
    </aside>
  );
};

export default GoldCorrelationPanel;
