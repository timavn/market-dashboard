import React from 'react';
import { CPI_RELEASE_SETUP_DEFINITIONS, cpiBenchmarkNumber, formatCpiReleasePercent, formatCpiSourceDate } from './cpiForecastContext';
import { formatCpiMonth } from './cpiForecastValues';
import { CpiSourceLink } from './CpiForecastDetails';
import './CpiForecastComparisonPanel.css';

const CpiReleaseSetup = ({
  comparison,
  benchmarkData,
  reportMonth,
  blsLatestActualAvailable,
  blsReportMonthActualAvailable,
}) => {
  const blsFinal = comparison?.bls?.latestFinal || null;
  const sourceRows = new Map((benchmarkData?.releaseSetup?.rows || [])
    .map((row) => [row.id, row]));
  const rows = CPI_RELEASE_SETUP_DEFINITIONS.map((definition) => {
    const source = sourceRows.get(definition.id) || null;
    const prior = definition.id === 'headline-yoy' && blsLatestActualAvailable
      ? cpiBenchmarkNumber(blsFinal?.value)
      : cpiBenchmarkNumber(source?.previous);
    const actual = definition.id === 'headline-yoy' && blsReportMonthActualAvailable
      ? cpiBenchmarkNumber(blsFinal?.value)
      : null;
    const street = cpiBenchmarkNumber(source?.consensus);
    return {
      ...definition,
      prior,
      street,
      actual,
      surprise: actual != null && street != null ? actual - street : null,
      status: source?.status || 'pending',
      reason: source?.reason,
    };
  });
  const showSurprise = rows.some((row) => row.surprise != null);
  const sourceUrl = benchmarkData?.releaseSetup?.sourceUrl;
  const checkedAt = benchmarkData?.releaseSetup?.checkedAt;
  const pendingStreet = rows.some((row) => row.street == null);

  return (
    <aside className="pm-cpi-side-panel pm-cpi-release-setup" aria-label="CPI release setup">
      <header>
        <span>RELEASE SETUP</span>
        <small>{formatCpiMonth(reportMonth).toUpperCase()}</small>
      </header>
      <table>
        <thead>
          <tr>
            <th scope="col">MEASURE</th>
            <th scope="col">PRIOR</th>
            <th scope="col">STREET</th>
            <th scope="col">ACTUAL</th>
            {showSurprise && <th scope="col">SURPRISE</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`is-${row.status}`} title={row.reason || undefined}>
              <th scope="row">{row.label}</th>
              <td>{formatCpiReleasePercent(row.prior)}</td>
              <td className={row.street == null ? 'is-pending' : undefined}>
                {row.street == null ? 'PENDING' : formatCpiReleasePercent(row.street)}
              </td>
              <td>{formatCpiReleasePercent(row.actual)}</td>
              {showSurprise && (
                <td>{row.surprise == null
                  ? '—'
                  : `${row.surprise > 0 ? '+' : ''}${row.surprise.toFixed(1)} pp`}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        <CpiSourceLink href={sourceUrl}>
          {pendingStreet ? 'PENDING = NOT PUBLISHED' : 'STREET CONSENSUS PUBLISHED'}
        </CpiSourceLink>
        {formatCpiSourceDate(checkedAt) && <small>CHECKED {formatCpiSourceDate(checkedAt)}</small>}
      </footer>
    </aside>
  );
};

export default CpiReleaseSetup;
