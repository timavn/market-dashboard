import React from 'react';
import { formatMarketMonthDay } from '../../utils/timeUtils';

export const VOLATILITY_METRIC_PERIODS = Object.freeze([
  Object.freeze({ key: 'dayChangePct', levelKey: 'day1Ago', label: 'DAY' }),
  Object.freeze({ key: 'fifteenDayChangePct', levelKey: 'day15Ago', label: '15D' }),
  Object.freeze({ key: 'monthChangePct', levelKey: 'week4Ago', label: '1M' }),
  Object.freeze({ key: 'threeMonthChangePct', levelKey: 'month3Ago', label: '3M' }),
  Object.freeze({ key: 'sixMonthChangePct', levelKey: 'month6Ago', label: '6M' }),
]);

export const VOLATILITY_METRIC_BASE_CHART_POINTS = Object.freeze([
  Object.freeze({ key: 'month3Ago', label: '3M' }),
  Object.freeze({ key: 'week4Ago', label: '1M' }),
  Object.freeze({ key: 'day15Ago', label: '15D' }),
  Object.freeze({ key: 'day1Ago', label: '1D' }),
  Object.freeze({ key: 'lastPx', label: '—' }),
]);

export const VOLATILITY_METRIC_CHART_POINTS = Object.freeze([
  Object.freeze({ key: 'month6Ago', label: '6M' }),
  ...VOLATILITY_METRIC_BASE_CHART_POINTS,
]);

const CHART_SIZE = Object.freeze({ width: 244, height: 76 });
const CHART_MARGIN = Object.freeze({ top: 6, right: 6, bottom: 18, left: 34 });

export const isFiniteMetricNumber = (value) => (
  value !== '' && value != null && Number.isFinite(Number(value))
);

export const isCompleteVolatilityMetricRow = (row) => (
  VOLATILITY_METRIC_BASE_CHART_POINTS.every(({ key }) => isFiniteMetricNumber(row?.[key]))
  && VOLATILITY_METRIC_PERIODS.every(({ key, levelKey }) => (
    isFiniteMetricNumber(row?.[key]) && isFiniteMetricNumber(row?.[levelKey])
  ))
  && Boolean(formatMarketMonthDay(row?.asOf))
);

const getChartPoints = (row) => (
  VOLATILITY_METRIC_CHART_POINTS.every(({ key }) => isFiniteMetricNumber(row?.[key]))
    ? VOLATILITY_METRIC_CHART_POINTS
    : VOLATILITY_METRIC_BASE_CHART_POINTS
);

export const volatilityMetricDirectionClass = (value) => {
  if (!isFiniteMetricNumber(value) || Number(value) === 0) return 'is-flat';
  return Number(value) > 0 ? 'is-rising' : 'is-falling';
};

const getNiceStep = (rawStep) => {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const fraction = rawStep / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
};

const formatAxisTick = (value, step) => {
  if (!Number.isFinite(value)) return '—';
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return Number(value).toFixed(digits);
};

const formatChange = (value) => {
  if (!isFiniteMetricNumber(value)) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
};

const formatLevel = (value) => {
  if (!isFiniteMetricNumber(value)) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

export const buildVolatilityMetricChart = (
  row,
  width = CHART_SIZE.width,
  height = CHART_SIZE.height,
  { available = true, historical = false } = {},
) => {
  const chartPoints = getChartPoints(row);
  const observationDateLabel = formatMarketMonthDay(row?.asOf);
  if (
    !available
    || !observationDateLabel
    || !chartPoints.every(({ key }) => isFiniteMetricNumber(row?.[key]))
  ) return null;

  const values = chartPoints.map(({ key }) => Number(row[key]));
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

  const plotLeft = CHART_MARGIN.left;
  const plotRight = width - CHART_MARGIN.right;
  const plotTop = CHART_MARGIN.top;
  const plotBottom = height - CHART_MARGIN.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const axisRange = axisMax - axisMin;

  const points = values.map((value, index) => ({
    ...chartPoints[index],
    label: chartPoints[index].key === 'lastPx'
      ? (historical ? 'CLOSE' : observationDateLabel)
      : chartPoints[index].label,
    value,
    x: plotLeft + (index * (plotWidth / (values.length - 1))),
    y: plotTop + (((axisMax - value) / axisRange) * plotHeight),
  }));
  const segments = points.slice(1).map((point, index) => {
    const previousPoint = points[index];
    return {
      key: `${previousPoint.key}-${point.key}`,
      from: previousPoint,
      to: point,
      direction: volatilityMetricDirectionClass(point.value - previousPoint.value),
    };
  });
  const yTicks = [axisMax, axisMin + (axisRange / 2), axisMin].map((value, index) => ({
    value,
    label: formatAxisTick(value, step),
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
    segments,
    yTicks,
  };
};

export const buildVolatilityMetricSparkline = (row, width, height, options) => (
  buildVolatilityMetricChart(row, width, height, options)?.points || null
);

const buildRegimeBands = (chart, regimeRanges) => {
  if (!chart || !Array.isArray(regimeRanges)) return [];
  const axisMin = chart.yTicks.at(-1)?.value;
  const axisMax = chart.yTicks[0]?.value;
  const valueToY = (value) => (
    chart.plotTop + (((axisMax - value) / (axisMax - axisMin)) * (chart.plotBottom - chart.plotTop))
  );

  if (!Number.isFinite(axisMin) || !Number.isFinite(axisMax) || axisMax <= axisMin) return [];

  return regimeRanges.flatMap(({ min, max, color }) => {
    const lower = Math.max(Number(min), axisMin);
    const upper = Math.min(max == null ? axisMax : Number(max), axisMax);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower || !color) return [];
    const top = valueToY(upper);
    const bottom = valueToY(lower);
    return [{ color, y: top, height: bottom - top }];
  });
};

const VolatilityMetricSparkline = ({ row, symbol, available, historical, regimeRanges }) => {
  const chart = buildVolatilityMetricChart(row, undefined, undefined, { available, historical });
  if (!chart) return <div className="efr-vol-sparkline__empty">NO LIVE SERIES</div>;
  const rangeStart = chart.points[0]?.key === 'month6Ago' ? 'six months ago' : 'three months ago';
  const endpointLabel = chart.points[chart.points.length - 1]?.label;
  const regimeBands = buildRegimeBands(chart, regimeRanges);

  return (
    <div className="efr-vol-sparkline">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        aria-label={`${symbol} volatility from ${rangeStart} to ${endpointLabel === 'CLOSE' ? 'close' : endpointLabel}`}
      >
        {regimeBands.map(({ color, y, height }) => (
          <rect
            aria-hidden="true"
            className={`efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--${color}`}
            height={height}
            key={color}
            width={chart.plotRight - chart.plotLeft}
            x={chart.plotLeft}
            y={y}
          />
        ))}
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
        {chart.points.map(({ key, label, x }, index) => (
          <g
            className={`efr-vol-sparkline__x-tick${index === chart.points.length - 1 ? ' is-end' : ''}`}
            key={key}
          >
            <line x1={x} y1={chart.plotBottom} x2={x} y2={chart.plotBottom + 3} />
            <text x={x} y={chart.height - 3}>{label}</text>
          </g>
        ))}
        {chart.segments.map(({ key, from, to, direction }) => (
          <line
            className={`efr-vol-sparkline__segment ${direction}`}
            data-segment={`${from.label}-${to.label}`}
            key={key}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        ))}
      </svg>
    </div>
  );
};

const VolatilityMetricRow = ({
  row,
  symbol,
  available,
  historical = false,
  asOfLabel = null,
  bucket = null,
  regimeLabel = null,
  regimeRange = null,
  regimeRanges = null,
  resolveLevelBucket = null,
  ariaLabel,
  className = '',
}) => (
  <article
    className={`efr-vol-row${available ? '' : ' is-unavailable'}${className ? ` ${className}` : ''}`}
    aria-label={ariaLabel}
  >
    <div className="efr-vol-row__chart">
      <VolatilityMetricSparkline
        row={row}
        symbol={symbol}
        available={available}
        historical={historical}
        regimeRanges={regimeRanges}
      />
    </div>
    <div className="efr-vol-row__data">
      <div className="efr-vol-row__metrics">
        {VOLATILITY_METRIC_PERIODS.map(({ key, levelKey, label }) => {
          const levelBucket = available ? resolveLevelBucket?.(row?.[levelKey]) : null;
          return (
            <span
              className={available
                ? volatilityMetricDirectionClass(row?.[key])
                : 'is-flat'}
              key={key}
            >
              <small>{label}</small>
              {available ? (
                <span className="efr-vol-row__metric-values">
                  <strong>{formatChange(row?.[key])}</strong>
                  <span className="efr-vol-row__metric-separator" aria-hidden="true">:</span>
                  <b className={levelBucket ? `efr-vol-row__metric-level efr-vol-row__metric-level--${levelBucket}` : 'efr-vol-row__metric-level'}>
                    {formatLevel(row?.[levelKey])}
                  </b>
                </span>
              ) : <strong>—</strong>}
            </span>
          );
        })}
      </div>
      <div className={`efr-vol-row__regime${bucket ? ` efr-vol-row__regime--${bucket}` : ''}`}>
        <strong>{regimeLabel || '—'}</strong>
        {regimeRange ? <small>{regimeRange}</small> : null}
      </div>
      <div className="efr-vol-row__identity">
        <strong>
          {symbol}
          {historical && asOfLabel ? (
            <time className="efr-vol-row__eod">AS OF {asOfLabel}</time>
          ) : null}
        </strong>
        <span className={bucket ? `efr-vol-regime-value efr-vol-regime-value--${bucket}` : ''}>
          {available ? formatLevel(row?.lastPx) : '—'}
        </span>
      </div>
    </div>
  </article>
);

export default VolatilityMetricRow;
