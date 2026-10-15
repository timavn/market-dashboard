import React from 'react';
import DashboardResearchLabel from './DashboardResearchLabel';
import { formatOverviewPrice } from '../../utils/formatOverviewPrice';
import { delayedMarkerMarketContext } from '../../utils/delayedMarkerMarketContext';
import DelayedDataMarker from './DelayedDataMarker';
import {
  isFiniteMetricNumber,
  VOLATILITY_METRIC_PERIODS,
  volatilityMetricDirectionClass,
} from './VolatilityMetricRow';
import './VolatilitySpreadsheetRow.css';

const formatLevel = (value) => (isFiniteMetricNumber(value)
  ? Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '—');

const formatChange = (value) => {
  if (!isFiniteMetricNumber(value)) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
};

export const VolatilitySpreadsheetHeader = () => (
  <thead>
    <tr>
      <th scope="col">Series</th>
      <th scope="col">Level</th>
      {VOLATILITY_METRIC_PERIODS.map(({ key, label }) => <th key={key} scope="col">{label}</th>)}
      <th scope="col">Regime</th>
    </tr>
  </thead>
);

const VolatilitySpreadsheetRow = ({
  row,
  symbol,
  available,
  historical = false,
  refreshDelayed = false,
  bucket = null,
  regimeLabel = null,
  regimeRange = null,
  onTickerClick = null,
  ariaLabel,
  research,
}) => {
  const level = available && isFiniteMetricNumber(row?.lastPx) ? Number(row.lastPx) : null;
  const quoteMode = String(row?.quoteMode || row?.dataType || '').toLowerCase();
  const source = String(row?.source || row?.provider || '').trim();
  const delayed = quoteMode.includes('delay') || ['cboe', 'yahoo'].includes(source.toLowerCase());
  const displayedStatus = !available ? 'unavailable' : refreshDelayed
    ? 'refresh-delayed' : historical ? 'historical' : delayed ? 'delayed' : 'live';
  const referenceAsOf = row?.asOf || row?.lastVerifiedAt || row?.timestamp;
  const markerTitle = refreshDelayed
    ? `Refresh delayed · last verified ${referenceAsOf || 'time unavailable'}`
    : historical
      ? `Historical reference · as of ${referenceAsOf || 'time unavailable'}`
      : `Delayed quote · as of ${referenceAsOf || 'time unavailable'}`;
  const provenance = available
    ? [source, displayedStatus, referenceAsOf && `as of ${referenceAsOf}`].filter(Boolean).join(' · ')
    : 'Unavailable';

  return (
    <tr
      className={`efr-vol-spreadsheet__row${available ? '' : ' is-unavailable'}${refreshDelayed ? ' is-refresh-delayed' : ''}`}
      aria-label={ariaLabel}
      data-status={displayedStatus}
    >
      <th scope="row">
        <DashboardResearchLabel label={symbol} reading={research}>
          {onTickerClick ? (
            <button
              type="button"
              className="efr-vol-spreadsheet__ticker"
              onClick={onTickerClick}
              aria-haspopup="dialog"
              aria-label={`Explain ${symbol} volatility index`}
              title={`What ${symbol} is and how it is used`}
            >
              {symbol}
            </button>
          ) : symbol}
        </DashboardResearchLabel>
      </th>
      <td
        title={level != null ? `Level ${level} · ${provenance}` : provenance}
        className="efr-vol-spreadsheet__level"
      >
        <span className={available && bucket ? `efr-vol-regime-value--${bucket}` : undefined}>
          {formatOverviewPrice(level)}
        </span>
        {available && (
          <DelayedDataMarker status={displayedStatus} title={markerTitle} updatedAt={referenceAsOf}
            {...delayedMarkerMarketContext(row, { symbol })} />
        )}
      </td>
      {VOLATILITY_METRIC_PERIODS.map(({ key, levelKey, label }) => (
        <td
          key={key}
          className={available ? volatilityMetricDirectionClass(row?.[key]) : undefined}
          title={available ? `${label} prior level ${formatLevel(row?.[levelKey])} · ${provenance}` : undefined}
        >
          {available ? formatChange(row?.[key]) : '—'}
        </td>
      ))}
      <td className={`efr-vol-spreadsheet__regime${available && bucket ? ` efr-vol-spreadsheet__regime--${bucket}` : ''}`}>
        <span>{available ? regimeLabel || '—' : '—'}</span>
        {available && regimeRange ? <small>{regimeRange}</small> : null}
      </td>
    </tr>
  );
};

export default VolatilitySpreadsheetRow;
