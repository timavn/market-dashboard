import React from 'react';
import { Globe } from 'lucide-react';
import { VOLATILITY_SERIES } from '../../hooks/useVolatilitySnapshot';
import { getBucketForSeries, VOL_RANGES } from '../../utils/volatilityRegimes';
import DataStatusChip from './DataStatusChip';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import MarketPulseRibbon from './MarketPulseRibbon';
import RadarReferencePanels, { aggregateQuoteStatus, getRowQuoteStatus } from './RadarReferencePanels';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import './ExceptionFirstRadar.css';

const VOLATILITY_PERIODS = [
  { key: 'dayChangePct', label: 'DAY' },
  { key: 'monthChangePct', label: 'MONTH' },
  { key: 'threeMonthChangePct', label: '3M' },
  { key: 'ytdChangePct', label: 'YTD' },
];

const VOLATILITY_CHART_POINTS = [
  { key: 'week4Ago', label: '4W' },
  { key: 'week1Ago', label: '1W' },
  { key: 'day1Ago', label: '1D' },
  { key: 'lastPx', label: 'NOW' },
];

const BACKDROP_GROUPS = [
  {
    id: 'us',
    label: 'US',
    rows: [
      { symbols: ['SPX', 'SPY'], label: 'S&P 500' },
      { symbols: ['DJI'], label: 'Dow 30' },
      { symbols: ['IXIC'], label: 'Nasdaq' },
      { symbols: ['RUT'], label: 'Russell' },
      { symbols: ['QQQ'], label: 'QQQ' },
    ],
  },
  {
    id: 'europe',
    label: 'Europe',
    rows: [
      { symbols: ['FTSE'], label: 'FTSE 100' },
      { symbols: ['CAC'], label: 'CAC 40' },
      { symbols: ['DAX'], label: 'DAX' },
      { symbols: ['N100'], label: 'Euronext 100' },
    ],
  },
  {
    id: 'asia',
    label: 'Asia',
    rows: [
      { symbols: ['N225'], label: 'Nikkei 225' },
      { symbols: ['HSI'], label: 'Hang Seng' },
      { symbols: ['SSEC'], label: 'Shanghai' },
      { symbols: ['AXJO'], label: 'ASX 200' },
    ],
  },
  {
    id: 'commodities',
    label: 'Commodities',
    rows: [
      { symbols: ['BZ'], label: 'Brent Oil' },
      { symbols: ['GC'], label: 'Gold' },
    ],
  },
  {
    id: 'rates',
    label: 'Rates',
    rows: [
      { symbols: ['UST10Y'], label: 'UST 10Y', isRate: true },
      { symbols: ['BUND10Y'], label: 'Bund 10Y', isRate: true },
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto',
    rows: [
      { symbols: ['BTC'], label: 'Bitcoin / USD' },
      { symbols: ['ETH'], label: 'Ethereum / USD' },
    ],
  },
];

const flattenRows = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenRows);
};

const findMarketRow = (marketData, groupId, symbols) => {
  const rows = flattenRows(marketData?.[groupId]);
  return rows.find((row) => symbols.includes(String(row?.symbol || '').toUpperCase())) || null;
};

const isFiniteNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value));

const formatSnapshotDate = (value, includeTime = false) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).toUpperCase();
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'UTC',
  }).toUpperCase();
};

const formatLevel = (value, category = '', symbol = '') => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  if (category === 'CORRELATION') return numeric.toFixed(2);
  if (category === 'FX') return numeric.toFixed(numeric < 10 ? 3 : 2);
  if (symbol.startsWith('UST') || symbol === 'BUND10Y') return numeric.toFixed(3);
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const formatChange = (value, suffix = '%', digits = 2) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(digits)}${suffix}`;
};

const getPerformanceTone = (value) => {
  if (!isFiniteNumber(value) || Number(value) === 0) return '';
  return Number(value) > 0 ? 'is-positive' : 'is-negative';
};

const getVolatilityStatus = (volatilityState) => {
  if (volatilityState?.loading) return 'loading';
  if (volatilityState?.error || !volatilityState?.snapshot) return 'unavailable';
  const rows = Object.values(volatilityState.snapshot).filter((row) => row && typeof row === 'object' && row.availability);
  const eligible = rows.filter((row) => (
    row.availability === 'available'
    && row.freshness === 'current'
    && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
  ));
  if (eligible.length === 0) return 'unavailable';
  const delayedCount = eligible.filter((row) => {
    const quoteMode = String(row.quoteMode || row.dataType || '').toLowerCase();
    const source = String(row.source || '').toLowerCase();
    return quoteMode.includes('delay') || source === 'yahoo' || source === 'cboe';
  }).length;
  if (delayedCount === eligible.length) return 'delayed';
  if (delayedCount > 0) return 'mixed';
  return 'live';
};

const getCorrelationStatus = (correlationState) => {
  if (correlationState?.loading) return 'loading';
  if (correlationState?.error || !correlationState?.correlations || !correlationState?.rollingStats) return 'unavailable';
  if (correlationState?.sourceStatus && correlationState.sourceStatus !== 'current') return 'unavailable';
  return 'historical';
};

const isCurrentVolatilityRow = (row) => (
  row?.availability === 'available'
  && row?.freshness === 'current'
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isHistoricalMoveRow = (seriesName, row) => (
  seriesName === 'MOVE'
  && row?.availability === 'historical'
  && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day'
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isDisplayableVolatilityRow = (seriesName, row) => (
  isCurrentVolatilityRow(row) || isHistoricalMoveRow(seriesName, row)
);

const formatMoveAsOfDate = (value) => {
  if (!value) return 'UNKNOWN';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'UNKNOWN';
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).toUpperCase();
};

const VOLATILITY_CHART_SIZE = { width: 244, height: 76 };
const VOLATILITY_CHART_MARGIN = { top: 6, right: 6, bottom: 18, left: 34 };

const getNiceStep = (rawStep) => {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const fraction = rawStep / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
};

const formatVolatilityAxisTick = (value, step) => {
  if (!Number.isFinite(value)) return '—';
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return Number(value).toFixed(digits);
};

const buildVolatilityChart = (
  row,
  width = VOLATILITY_CHART_SIZE.width,
  height = VOLATILITY_CHART_SIZE.height,
  seriesName = null,
) => {
  if (!isDisplayableVolatilityRow(seriesName, row)) return null;
  const historical = isHistoricalMoveRow(seriesName, row);
  const values = VOLATILITY_CHART_POINTS.map(({ key }) => Number(row[key]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rawRange = max - min;
  const step = getNiceStep((rawRange || Math.max(Math.abs(max) * 0.1, 1)) / 2);
  let axisMin = Math.floor(min / step) * step;
  let axisMax = Math.ceil(max / step) * step;
  if (axisMin === axisMax) {
    axisMin -= step;
    axisMax += step;
  }

  const plotLeft = VOLATILITY_CHART_MARGIN.left;
  const plotRight = width - VOLATILITY_CHART_MARGIN.right;
  const plotTop = VOLATILITY_CHART_MARGIN.top;
  const plotBottom = height - VOLATILITY_CHART_MARGIN.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const axisRange = axisMax - axisMin;

  const points = values.map((value, index) => ({
    ...VOLATILITY_CHART_POINTS[index],
    label: historical && VOLATILITY_CHART_POINTS[index].key === 'lastPx'
      ? 'EOD'
      : VOLATILITY_CHART_POINTS[index].label,
    value,
    x: plotLeft + (index * (plotWidth / (values.length - 1))),
    y: plotTop + (((axisMax - value) / axisRange) * plotHeight),
  }));
  const yTicks = [axisMax, axisMin + (axisRange / 2), axisMin].map((value, index) => ({
    value,
    label: formatVolatilityAxisTick(value, step),
    y: plotTop + (index * (plotHeight / 2)),
  }));

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    points,
    yTicks,
  };
};

const buildVolatilitySparkline = (row, width, height, seriesName = null) => (
  buildVolatilityChart(row, width, height, seriesName)?.points || null
);

const volatilityDirectionClass = (value) => {
  if (!isFiniteNumber(value) || Number(value) === 0) return 'is-flat';
  return Number(value) > 0 ? 'is-rising' : 'is-falling';
};

const VolatilitySparkline = ({ row, symbol, seriesName }) => {
  const historical = isHistoricalMoveRow(seriesName, row);
  const chart = buildVolatilityChart(row, undefined, undefined, seriesName);
  if (!chart) {
    return <div className="efr-vol-sparkline__empty">NO LIVE SERIES</div>;
  }
  const direction = volatilityDirectionClass(row.monthChangePct);
  const pointString = chart.points.map(({ x, y }) => `${x},${y}`).join(' ');
  return (
    <div className={`efr-vol-sparkline ${direction}`}>
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        aria-label={`${symbol} volatility from four weeks ago to ${historical ? 'end of day' : 'now'}`}
      >
        {chart.yTicks.map((tick) => (
          <g className="efr-vol-sparkline__y-tick" key={tick.label}>
            <line x1={chart.plotLeft} y1={tick.y} x2={chart.plotRight} y2={tick.y} />
            <line className="efr-vol-sparkline__axis-tick" x1={chart.plotLeft - 3} y1={tick.y} x2={chart.plotLeft} y2={tick.y} />
            <text x={chart.plotLeft - 6} y={tick.y}>{tick.label}</text>
          </g>
        ))}
        <line
          className="efr-vol-sparkline__y-axis"
          x1={chart.plotLeft}
          y1={chart.plotTop}
          x2={chart.plotLeft}
          y2={chart.plotBottom}
        />
        {chart.points.map(({ key, label, x }) => (
          <g className="efr-vol-sparkline__x-tick" key={key}>
            <line x1={x} y1={chart.plotBottom} x2={x} y2={chart.plotBottom + 3} />
            <text x={x} y={chart.height - 3}>{label}</text>
          </g>
        ))}
        <polyline className="efr-vol-sparkline__line" points={pointString} />
      </svg>
    </div>
  );
};

const VolatilityMapPanel = ({ volatilityState, status }) => {
  const snapshot = volatilityState?.snapshot;
  const loading = Boolean(volatilityState?.loading);
  const error = volatilityState?.error;
  const hasSnapshot = snapshot && typeof snapshot === 'object';

  return (
    <section className="efr-panel efr-exceptions efr-vol-map" aria-labelledby="efr-vol-map-title">
      <header className="efr-panel__header">
        <h2 id="efr-vol-map-title">Volatility · 1M Map</h2>
        <DataStatusChip
          status={status}
          detail={volatilityState?.lastUpdated ? formatSnapshotDate(volatilityState.lastUpdated) : undefined}
          compact
        />
      </header>

      {loading && !hasSnapshot ? (
        <div className="efr-vol-map__state">Loading current volatility data…</div>
      ) : error || !hasSnapshot ? (
        <div className="efr-vol-map__state efr-vol-map__state--error" role="alert">
          <span>Current volatility data unavailable.</span>
          {volatilityState?.retry ? (
            <button type="button" onClick={volatilityState.retry}>Retry</button>
          ) : null}
        </div>
      ) : (
        <div className="efr-vol-map__rows">
          {VOLATILITY_SERIES.map(({ name, symbol }) => {
            const row = snapshot[name];
            const historical = isHistoricalMoveRow(name, row);
            const available = isDisplayableVolatilityRow(name, row);
            const bucket = available ? getBucketForSeries(name, row.lastPx) : null;
            const regime = bucket
              ? VOL_RANGES[name]?.ranges.find((range) => range.color === bucket)
              : null;
            const asOfLabel = historical ? formatMoveAsOfDate(row.asOf) : null;
            return (
              <article
                className={`efr-vol-row${available ? '' : ' is-unavailable'}`}
                key={name}
                aria-label={
                  available
                    ? historical
                      ? `${symbol} end-of-day volatility as of ${asOfLabel}`
                      : `${symbol} current volatility`
                    : `${symbol} volatility data unavailable`
                }
              >
                <div className="efr-vol-row__chart">
                  <VolatilitySparkline row={row} symbol={symbol} seriesName={name} />
                </div>
                <div className="efr-vol-row__data">
                  <div className="efr-vol-row__metrics">
                    {VOLATILITY_PERIODS.map(({ key, label }) => (
                      <span className={available ? volatilityDirectionClass(row[key]) : 'is-flat'} key={key}>
                        <small>{label}</small>
                        <strong>{available ? formatChange(row[key]) : '—'}</strong>
                      </span>
                    ))}
                  </div>
                  <div className={`efr-vol-row__regime${bucket ? ` efr-vol-row__regime--${bucket}` : ''}`}>
                    <strong>{regime?.label || '—'}</strong>
                  </div>
                  <div className="efr-vol-row__identity">
                    <strong>
                      {symbol}
                      {historical ? <small className="efr-vol-row__eod">EOD · AS OF {asOfLabel}</small> : null}
                    </strong>
                    <span className={bucket ? `efr-vol-regime-value efr-vol-regime-value--${bucket}` : ''}>
                      {available ? formatLevel(row.lastPx) : '—'}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

const BackdropRow = ({ descriptor, row, providerStatus }) => {
  const status = getRowQuoteStatus(row, providerStatus);
  const available = status !== 'unavailable';
  const change = descriptor.isRate ? row?.change : row?.changePercent;
  const mode = status === 'historical' ? 'AS OF' : status === 'delayed' ? 'DELAYED' : status === 'live' ? 'LIVE' : '—';
  return (
    <tr>
      <td>{descriptor.label}</td>
      <td>{available ? formatLevel(row?.price, '', row?.symbol || descriptor.symbols[0]) : '—'}</td>
      <td className={available ? (descriptor.isRate ? (Number(change) >= 0 ? 'is-rate-up' : 'is-rate-down') : getPerformanceTone(change)) : ''}>
        {available ? formatChange(change, descriptor.isRate ? '' : '%', descriptor.isRate ? 3 : 2) : '—'}
      </td>
      <td><span className={`efr-backdrop-mode efr-backdrop-mode--${status}`}>{mode}</span></td>
    </tr>
  );
};

const MarketBackdrop = ({ marketData, marketDataLoading, marketDataError, providerStatus }) => {
  const allRows = flattenRows(marketData);
  const overallStatus = marketDataLoading
    ? 'loading'
    : marketDataError
      ? 'unavailable'
      : aggregateQuoteStatus(allRows, providerStatus);

  return (
    <section className="efr-panel efr-backdrop" aria-labelledby="efr-backdrop-title">
      <header className="efr-panel__header">
        <div className="efr-panel__header-title"><Globe size={15} aria-hidden="true" /><h2 id="efr-backdrop-title">Market Backdrop</h2></div>
        <DataStatusChip status={overallStatus} compact />
      </header>
      <div className="efr-backdrop__body">
        {BACKDROP_GROUPS.map((group) => (
          <section className="efr-backdrop-group" key={group.id} aria-labelledby={`efr-backdrop-${group.id}`}>
            <h3 id={`efr-backdrop-${group.id}`}>{group.label}</h3>
            <table>
              <thead><tr><th>Index</th><th>Price</th><th>{group.id === 'rates' ? 'Move' : 'Day (%)'}</th><th>Data</th></tr></thead>
              <tbody>
                {group.rows.map((descriptor) => (
                  <BackdropRow
                    key={descriptor.label}
                    descriptor={descriptor}
                    row={findMarketRow(marketData, group.id, descriptor.symbols)}
                    providerStatus={providerStatus}
                  />
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </section>
  );
};

const ExceptionFirstRadar = ({
  marketData = {},
  marketDataLoading = false,
  marketDataError = null,
  providerStatus = null,
  volatilityState = {},
  correlationState = {},
}) => {
  const volatilityStatus = getVolatilityStatus(volatilityState);
  const correlationStatus = getCorrelationStatus(correlationState);
  const correlationAsOf = correlationState?.calculationDate || correlationState?.correlationsCalculationDate;
  return (
    <main className="exception-first-radar">
      <header className="efr-topbar">
        <div className="efr-trust-strip">
          <MarketPulseRibbon
            marketData={marketData}
            marketDataLoading={marketDataLoading}
            providerStatus={providerStatus}
            volatilityState={volatilityState}
          />
        </div>
        <div className="efr-clock">
          <GlobalMarketDayCycleHeader compact />
        </div>
      </header>

      {marketDataError ? (
        <div className="efr-system-alert" role="alert">
          Market quotes unavailable: {String(marketDataError)}
        </div>
      ) : null}

      <div className="efr-primary-grid">
        <VolatilityMapPanel volatilityState={volatilityState} status={volatilityStatus} />

        <div className="efr-analytics-stack">
          <section className="efr-panel efr-analytics-card efr-analytics-card--correlations" aria-label="USD correlations">
            <div className="efr-analytics-card__status">
              <DataStatusChip
                status={correlationStatus}
                detail={correlationAsOf ? formatSnapshotDate(correlationAsOf) : undefined}
                compact
              />
            </div>
            <USDCorrelationMatrix
              state={correlationState}
              correlations={correlationState?.correlations}
              rollingStats={correlationState?.rollingStats}
              correlationsTimestamp={correlationState?.correlationsTimestamp || correlationState?.timestamp}
              calculationDate={correlationAsOf}
              loading={correlationState?.loading}
              error={correlationState?.error}
              onRetry={correlationState?.retry}
              variant="radar"
            />
          </section>

        </div>

        <MarketBackdrop
          marketData={marketData}
          marketDataLoading={marketDataLoading}
          marketDataError={marketDataError}
          providerStatus={providerStatus}
        />
      </div>

      <RadarReferencePanels
        marketData={marketData}
        marketDataLoading={marketDataLoading}
        providerStatus={providerStatus}
      />

    </main>
  );
};

export {
  BACKDROP_GROUPS,
  buildVolatilityChart,
  buildVolatilitySparkline,
  findMarketRow,
  flattenRows,
  isDisplayableVolatilityRow,
  isCurrentVolatilityRow,
};
export default ExceptionFirstRadar;
