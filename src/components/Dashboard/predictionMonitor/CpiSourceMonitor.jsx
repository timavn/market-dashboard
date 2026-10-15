import React from 'react';
import DelayedDataMarker from '../DelayedDataMarker';
import { finite } from './monitorNumbers';
import { formatAsOf } from './monitorFormatting';
import {
  formatCpiPercent, formatCpiMonth, resolveCpiBlsActualAvailability,
} from './cpiForecastValues';

const CpiSourceMonitor = ({ snapshot, refreshDelayed, nowMs = Date.now() }) => {
  const comparison = snapshot?.forecastComparison || null;
  const reportMonth = comparison?.reportMonth || null;
  const releaseAtMs = Date.parse(comparison?.releaseAt || '');
  const currentRelease = Number.isFinite(releaseAtMs) && releaseAtMs > nowMs;
  const blsActualAvailability = resolveCpiBlsActualAvailability({
    bls: comparison?.bls,
    reportMonth,
    releaseAt: comparison?.releaseAt,
    nowMs,
  });
  const hedgeye = comparison?.hedgeye;
  const rows = [
    ...(Array.isArray(hedgeye?.scenarios) ? hedgeye.scenarios : []).map((scenario) => ({
      id: `hedgeye-${scenario.key}`,
      source: 'HEDGEYE',
      value: scenario.value,
      role: String(scenario.label || scenario.key || 'Scenario').toUpperCase(),
      period: reportMonth,
      asOf: hedgeye.asOf,
      status: hedgeye.status,
      exact: hedgeye.reportMonth === reportMonth,
      reason: hedgeye.reason,
    })),
    {
      id: 'cleveland-fed',
      source: 'CLEVELAND FED',
      value: comparison?.clevelandFed?.value,
      role: 'NOWCAST',
      period: comparison?.clevelandFed?.reportMonth || reportMonth,
      asOf: comparison?.clevelandFed?.asOf,
      status: comparison?.clevelandFed?.status,
      exact: comparison?.clevelandFed?.reportMonth === reportMonth,
      reason: comparison?.clevelandFed?.reason,
    },
    {
      id: 'bls-actual',
      source: 'BLS',
      value: comparison?.bls?.latestFinal?.value,
      role: 'LATEST ACTUAL',
      period: comparison?.bls?.latestFinal?.reportMonth || null,
      asOf: comparison?.bls?.fetchedAt || comparison?.bls?.asOf,
      status: comparison?.bls?.status,
      exact: blsActualAvailability.latestPublishedActualAvailable,
      reason: comparison?.bls?.reason,
    },
  ];
  return (
    <section
      className="pm-spx-factor-panel pm-cpi-source-panel"
      aria-label="CPI forecast and official source monitor"
      data-testid="cpi-source-monitor"
    >
      <table className="pm-spx-factor-table pm-cpi-source-table">
        <thead>
          <tr><th>SOURCE</th><th>VALUE</th><th>ROLE</th><th>PERIOD</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const available = row.status === 'available'
              && row.exact
              && finite(row.value)
              && (row.id === 'bls-actual' || currentRelease);
            const delayed = snapshot?.referenceOnly || refreshDelayed;
            return (
              <tr
                key={row.id}
                className={available ? undefined : 'is-unavailable'}
                data-availability={available ? 'available' : 'unavailable'}
                title={row.reason || undefined}
              >
                <th scope="row">{row.source}</th>
                <td className="pm-spx-factor-value">
                  {available ? (
                    <>
                      {formatCpiPercent(row.value)}
                      <DelayedDataMarker
                        status={delayed ? 'refresh-delayed' : row.id === 'bls-actual' ? 'historical' : 'available'}
                        title={`${row.source} ${row.role} as of ${row.asOf || 'unknown'}`}
                        updatedAt={row.asOf}
                        observationFrequency={row.id === 'bls-actual' ? 'monthly' : undefined}
                      />
                    </>
                  ) : '—'}
                </td>
                <td>{row.role}</td>
                <td>{row.period ? formatCpiMonth(row.period).toUpperCase() : '—'}</td>
                <td>{available && row.asOf ? formatAsOf(row.asOf) : '—'}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr className="is-unavailable"><td colSpan="5">NO VERIFIED CPI FORECAST SOURCES</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

export default CpiSourceMonitor;
