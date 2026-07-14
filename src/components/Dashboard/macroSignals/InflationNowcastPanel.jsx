import React from 'react';
import { normalizeCpiNowcast } from '../../../utils/cpiPredictionMarket';

const MANUAL_INFLATION_NOWCAST = {
  metric: 'Headline CPI M/M',
  forecastMonth: 'June 2026',
  publishedText: '06/16/2026 11:47 AM EDT',
  releaseDate: '2026-07-14',
  outlook: 'Probable Disinflation',
  scenarios: [
    { key: 'upside', label: 'Upside', value: 0.4 },
    { key: 'base', label: 'Base Case', value: 0.3 },
    { key: 'downside', label: 'Downside', value: 0.2 },
  ],
};

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(2)}%`;
}

function formatDate(value) {
  if (!value) return '-';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function resolveNowcast(inflationNowcast) {
  if (!inflationNowcast) {
    return {
      data: MANUAL_INFLATION_NOWCAST,
      sourceLabel: 'Manual fallback',
      unavailableMessage: null,
    };
  }

  const normalized = normalizeCpiNowcast(inflationNowcast);
  if (!normalized.ok) {
    return {
      data: null,
      sourceLabel: 'Snapshot unavailable',
      unavailableMessage: normalized.message || 'Latest inflation nowcast snapshot could not be parsed.',
    };
  }

  return {
    data: normalized.model,
    sourceLabel: 'Hedgeye snapshot',
    unavailableMessage: null,
  };
}

function InflationNowcastPanel({ inflationNowcast = null }) {
  const { data, sourceLabel, unavailableMessage } = resolveNowcast(inflationNowcast);
  const scenarios = data?.scenarios || [];

  return (
    <section className="inflation-nowcast-panel" aria-label="Inflation Nowcast">
      <div className="inflation-nowcast-title-row">
        <span className="inflation-nowcast-kicker">Inflation Nowcast</span>
        <span className="inflation-nowcast-muted">{data?.metric || sourceLabel}</span>
      </div>
      {unavailableMessage ? (
        <div className="inflation-nowcast-empty" role="status">
          {unavailableMessage}
        </div>
      ) : (
        <>
          <div className="inflation-nowcast-main-row">
            <div>
              <div className="inflation-nowcast-forecast">{data.forecastMonth}</div>
              <div className="inflation-nowcast-outlook">{data.outlook || sourceLabel}</div>
            </div>
            <div className="inflation-nowcast-date-stack">
              <span>Published {data.publishedText || '-'}</span>
              <span>Release {formatDate(data.releaseDate)}</span>
            </div>
          </div>
          <div className="inflation-nowcast-scenarios">
            {scenarios.map((scenario) => (
              <div
                key={scenario.key || scenario.label}
                className={`inflation-nowcast-scenario inflation-nowcast-scenario-${scenario.key || 'base'}`}
              >
                <span>{scenario.label}</span>
                <strong>{formatPercent(scenario.value)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default InflationNowcastPanel;
