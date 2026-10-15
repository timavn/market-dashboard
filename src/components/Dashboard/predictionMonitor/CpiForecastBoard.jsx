import React from 'react';
import { cpiBenchmarkNumber, formatCpiBoardPercent, formatCpiSourceDate } from './cpiForecastContext';
import { CpiSourceLink } from './CpiForecastDetails';
import './CpiForecastComparisonPanel.css';

const CpiForecastBoard = ({
  comparison,
  benchmarkData,
  reportMonth,
  releaseCurrent,
}) => {
  const sourceById = new Map((benchmarkData?.sources || []).map((source) => [source.id, source]));
  const street = sourceById.get('wall-street-consensus') || null;
  const headlineSetup = benchmarkData?.releaseSetup?.rows
    ?.find((row) => row.id === 'headline-yoy') || null;
  const hedgeye = comparison?.hedgeye || null;
  const cleveland = comparison?.clevelandFed || null;
  const hedgeyeAvailable = releaseCurrent
    && hedgeye?.status === 'available'
    && hedgeye.reportMonth === reportMonth
    && cpiBenchmarkNumber(hedgeye.baseValue) != null;
  const clevelandAvailable = releaseCurrent
    && cleveland?.status === 'available'
    && cleveland.reportMonth === reportMonth
    && cpiBenchmarkNumber(cleveland.value) != null;
  const streetAvailable = releaseCurrent
    && street?.status === 'available'
    && cpiBenchmarkNumber(street.point) != null;
  const tradingEconomicsAvailable = releaseCurrent
    && headlineSetup?.status === 'available'
    && cpiBenchmarkNumber(headlineSetup.providerForecast) != null;
  const scenarios = Array.isArray(hedgeye?.scenarios) ? hedgeye.scenarios : [];
  const downside = scenarios.find((scenario) => scenario.key === 'downside')?.value;
  const upside = scenarios.find((scenario) => scenario.key === 'upside')?.value;
  const hedgeyeRange = cpiBenchmarkNumber(downside) != null && cpiBenchmarkNumber(upside) != null
    ? `${formatCpiBoardPercent(downside)}–${formatCpiBoardPercent(upside)}`
    : null;
  const checkedAt = benchmarkData?.releaseSetup?.checkedAt || benchmarkData?.fetchedAt || null;
  const rows = [
    {
      id: 'street',
      label: 'Street consensus',
      value: streetAvailable ? formatCpiBoardPercent(street.point) : 'PENDING',
      detail: streetAvailable
        ? `SURVEY CONSENSUS${formatCpiSourceDate(street.asOf) ? ` · ${formatCpiSourceDate(street.asOf)}` : ''}`
        : 'NOT PUBLISHED YET',
      status: streetAvailable ? 'available' : 'pending',
      href: street?.sourceUrl || headlineSetup?.sourceUrl || benchmarkData?.releaseSetup?.sourceUrl,
      reason: street?.reason || headlineSetup?.reason,
    },
    {
      id: 'cleveland',
      label: 'Cleveland Fed',
      value: clevelandAvailable ? formatCpiBoardPercent(cleveland.value) : 'PENDING',
      detail: clevelandAvailable
        ? `DAILY NOWCAST${formatCpiSourceDate(cleveland.asOf) ? ` · ${formatCpiSourceDate(cleveland.asOf)}` : ''}`
        : 'EXACT-MONTH NOWCAST PENDING',
      status: clevelandAvailable ? 'available' : 'pending',
      href: cleveland?.sourceUrl,
      reason: cleveland?.reason,
    },
    {
      id: 'hedgeye',
      label: 'Hedgeye base',
      value: hedgeyeAvailable ? formatCpiBoardPercent(hedgeye.baseValue) : 'PENDING',
      detail: hedgeyeAvailable
        ? `${hedgeyeRange ? `RANGE ${hedgeyeRange}` : 'SCENARIO SET'}${formatCpiSourceDate(hedgeye.asOf) ? ` · ${formatCpiSourceDate(hedgeye.asOf)}` : ''}`
        : 'SCENARIO SET PENDING',
      status: hedgeyeAvailable ? 'available' : 'pending',
      href: hedgeye?.sourceUrl,
      reason: hedgeye?.reason,
    },
    {
      id: 'trading-economics',
      label: 'Trading Economics',
      value: tradingEconomicsAvailable
        ? formatCpiBoardPercent(headlineSetup.providerForecast)
        : 'PENDING',
      detail: tradingEconomicsAvailable
        ? `HOUSE FORECAST${formatCpiSourceDate(headlineSetup.checkedAt || checkedAt) ? ` · CHECKED ${formatCpiSourceDate(headlineSetup.checkedAt || checkedAt)}` : ''}`
        : 'HOUSE FORECAST PENDING',
      status: tradingEconomicsAvailable ? 'available' : 'pending',
      href: headlineSetup?.sourceUrl || benchmarkData?.releaseSetup?.sourceUrl,
      reason: headlineSetup?.reason,
    },
  ];

  return (
    <aside className="pm-cpi-side-panel pm-cpi-forecast-board" aria-label="CPI forecast board">
      <header>
        <span>FORECAST BOARD</span>
        <small>HEADLINE YOY</small>
      </header>
      <table>
        <thead>
          <tr><th scope="col">SOURCE</th><th scope="col">FORECAST</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={`is-${row.id} is-${row.status}`} title={row.reason || undefined}>
              <th scope="row">
                <CpiSourceLink href={row.href}>{row.label}</CpiSourceLink>
                <small>{row.detail}</small>
              </th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
};

export default CpiForecastBoard;
