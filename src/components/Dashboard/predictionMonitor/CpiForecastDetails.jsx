import React from 'react';
import { finite } from './monitorNumbers';
import { formatCpiPercent } from './cpiForecastValues';
import './CpiForecastComparisonPanel.css';

const formatCpiTooltipDate = (value, options = {}) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(options.year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(timestamp));
};

export const CpiForecastTooltip = ({ active, payload, label, hedgeyeAsOf = null }) => {
  if (!active || !Array.isArray(payload) || !payload.length || !Number.isFinite(Number(label))) return null;
  const row = payload.find((entry) => entry?.payload)?.payload || null;
  if (!row) return null;
  const scenarioRows = ['downside', 'base', 'upside']
    .map((key) => finite(row?.scenarios?.[key]) ? { key, value: Number(row.scenarios[key]) } : null)
    .filter(Boolean);
  const clevelandPublishedToday = finite(row.cleveland);
  const clevelandValue = clevelandPublishedToday ? Number(row.cleveland)
    : finite(row.clevelandLatest) ? Number(row.clevelandLatest) : null;
  const clevelandPublicationAt = clevelandPublishedToday
    ? row.clevelandObservationTimestamp
    : row.clevelandLatestTimestamp;
  const clevelandNote = clevelandPublishedToday
    ? 'PUBLISHED THIS DAY'
    : finite(clevelandValue) && Number.isFinite(Number(clevelandPublicationAt))
      ? `LAST PUBLISHED ${formatCpiTooltipDate(clevelandPublicationAt)?.toUpperCase()}`
      : 'NO PUBLICATION YET';
  return (
    <div className="pm-cpi-tooltip" data-testid="cpi-chart-tooltip">
      <span className="pm-cpi-tooltip-date">
        {formatCpiTooltipDate(label, { year: true })?.toUpperCase()}
      </span>
      <div className="pm-cpi-tooltip-values">
        {scenarioRows.map((scenario) => (
          <div key={scenario.key} className={`pm-cpi-tooltip-row is-${scenario.key}`}>
            <span>{scenario.key.toUpperCase()}</span>
            <span>{formatCpiPercent(scenario.value)}</span>
          </div>
        ))}
        <div className="pm-cpi-tooltip-row is-cleveland">
          <span>CLEVELAND FED</span>
          <span>{formatCpiPercent(clevelandValue)}</span>
        </div>
        {finite(row.blsActual) && (
          <div className="pm-cpi-tooltip-row is-bls">
            <span>BLS ACTUAL</span>
            <span>{formatCpiPercent(row.blsActual)}</span>
          </div>
        )}
      </div>
      <small>{clevelandNote}</small>
      {Number.isFinite(Date.parse(hedgeyeAsOf || '')) && (
        <small>HEDGEYE SCENARIOS AS OF {formatCpiTooltipDate(Date.parse(hedgeyeAsOf))?.toUpperCase()}</small>
      )}
    </div>
  );
};

export const CpiSourceLink = ({ href, children }) => href ? (
  <a href={href} target="_blank" rel="noreferrer">{children}</a>
) : children;
