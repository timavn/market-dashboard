import React, { useMemo } from 'react';
import { getBucketForSeries } from '../../utils/volatilityRegimes';
import { getRowQuoteStatus } from './RadarReferencePanels';

const CHART_WIDTH = 118;
const CHART_HEIGHT = 44;
const CHART_INSET = 4;

const isFiniteNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value));

const buildPoints = (values) => {
  const finiteValues = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  if (finiteValues.length < 2) return [];

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const range = max - min;
  return finiteValues.map((value, index) => ({
    x: CHART_INSET + (index * ((CHART_WIDTH - (CHART_INSET * 2)) / (finiteValues.length - 1))),
    y: range === 0
      ? CHART_HEIGHT / 2
      : CHART_INSET + (((max - value) / range) * (CHART_HEIGHT - (CHART_INSET * 2))),
  }));
};

const formatValue = (value, kind) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  if (kind === 'rate') return `${numeric.toFixed(2)}%`;
  if (kind === 'index') {
    return numeric.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return numeric.toFixed(2);
};

const formatChange = (value) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(2)}%`;
};

const getTone = (value) => {
  if (!isFiniteNumber(value) || Number(value) === 0) return 'is-flat';
  return Number(value) > 0 ? 'is-positive' : 'is-negative';
};

const getStatusLabel = (status) => {
  switch (status) {
    case 'live': return 'LIVE';
    case 'delayed': return 'DLY';
    case 'historical': return 'HIST';
    case 'loading': return 'LOAD';
    default: return 'NO DATA';
  }
};

const getVolatilityStatus = (row, loading) => {
  if (loading) return 'loading';
  if (
    !row ||
    row.availability !== 'available' ||
    row.freshness !== 'current' ||
    !isFiniteNumber(row.lastPx)
  ) return 'unavailable';

  const source = String(row.source || '').toLowerCase();
  const quoteMode = String(row.quoteMode || row.dataType || '').toLowerCase();
  if (quoteMode.includes('delay') || source === 'yahoo' || source === 'cboe') return 'delayed';
  return 'live';
};

const PulseSparkline = ({ values, label, available }) => {
  const points = available ? buildPoints(values) : [];
  if (points.length < 2) {
    return <div className="efr-pulse-sparkline__empty" aria-label={`${label} intraday series unavailable`}>—</div>;
  }

  const pointString = points.map(({ x, y }) => `${x},${y}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg
      className="efr-pulse-sparkline"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={`${label} intraday sparkline`}
      preserveAspectRatio="none"
    >
      <polyline points={pointString} />
      <circle cx={last.x} cy={last.y} r="2.4" />
    </svg>
  );
};

const EmbeddedVolatility = ({ metric }) => {
  if (!metric) return null;
  const available = ['live', 'delayed', 'historical'].includes(metric.status);
  const loading = metric.status === 'loading';
  const displayValue = loading ? '…' : (available ? formatValue(metric.value, 'number') : '—');
  const regime = available ? getBucketForSeries(metric.label, metric.value) : null;

  return (
    <span
      className={`efr-pulse-vol efr-pulse-vol--${metric.status}`}
      aria-label={`${metric.label} volatility ${available ? displayValue : 'unavailable'}`}
    >
      <b>{metric.label}</b>
      <strong className={regime ? `efr-pulse-vol__value--${regime}` : ''}>{displayValue}</strong>
      <small>{getStatusLabel(metric.status)}</small>
    </span>
  );
};

const PulseMetric = ({ label, value, change, kind, values, status, embeddedVolatility }) => {
  const available = ['live', 'delayed', 'historical'].includes(status);
  const loading = status === 'loading';
  const displayValue = loading ? '…' : (available ? formatValue(value, kind) : '—');
  const displayChange = loading ? '…' : (available ? formatChange(change) : '—');

  return (
    <section className="efr-pulse-metric" aria-label={`${label} market pulse`}>
      <div className="efr-pulse-metric__copy">
        <div className="efr-pulse-metric__heading">
          <h2>{label}</h2>
          <span className={`efr-pulse-metric__status efr-pulse-metric__status--${status}`}>
            {getStatusLabel(status)}
          </span>
        </div>
        <strong>{displayValue}</strong>
        <div className="efr-pulse-metric__footer">
          <span className={`efr-pulse-metric__change ${available ? getTone(change) : 'is-unavailable'}`}>
            {displayChange}
          </span>
          <EmbeddedVolatility metric={embeddedVolatility} />
        </div>
      </div>
      <PulseSparkline values={values} label={label} available={available} />
    </section>
  );
};

const findRow = (marketData, region, symbols) => {
  const value = marketData?.[region];
  const rows = Array.isArray(value)
    ? value
    : Object.values(value || {}).flatMap((entry) => (Array.isArray(entry) ? entry : []));
  return rows.find((row) => symbols.includes(String(row?.symbol || '').toUpperCase())) || null;
};

const MarketPulseRibbon = ({
  marketData = {},
  marketDataLoading = false,
  providerStatus = null,
  volatilityState = {},
}) => {
  const vix = volatilityState?.snapshot?.VIX || null;
  const move = volatilityState?.snapshot?.MOVE || null;
  const vixStatus = getVolatilityStatus(vix, volatilityState?.loading);
  const moveStatus = getVolatilityStatus(move, volatilityState?.loading);

  const metrics = useMemo(() => {
    const quoteDescriptors = [
      { label: 'S&P 500', region: 'us', symbols: ['SPX', 'SPY'], kind: 'index' },
      { label: 'DXY', region: 'currencies', symbols: ['USD', 'DXY'], kind: 'number' },
      { label: 'US 10Y', region: 'rates', symbols: ['UST10Y'], kind: 'rate' },
      { label: 'WTI Oil', region: 'commodities', symbols: ['CL', 'WTI', 'WTIC'], kind: 'number' },
    ];

    const quoteMetrics = quoteDescriptors.map((descriptor) => {
      const row = findRow(marketData, descriptor.region, descriptor.symbols);
      return {
        ...descriptor,
        value: row?.price,
        change: row?.changePercent,
        values: row?.sparklineData,
        status: marketDataLoading ? 'loading' : getRowQuoteStatus(row, providerStatus),
        embeddedVolatility: descriptor.label === 'S&P 500'
          ? { label: 'VIX', value: vix?.lastPx, status: vixStatus }
          : descriptor.label === 'US 10Y'
            ? { label: 'MOVE', value: move?.lastPx, status: moveStatus }
            : null,
      };
    });

    return quoteMetrics;
  }, [marketData, marketDataLoading, move, moveStatus, providerStatus, vix, vixStatus]);

  return (
    <div className="efr-market-pulse" aria-label="Market pulse ribbon">
      <div className="efr-market-pulse__metrics">
        {metrics.map((metric) => <PulseMetric key={metric.label} {...metric} />)}
      </div>
    </div>
  );
};

export { buildPoints, getVolatilityStatus };
export default MarketPulseRibbon;
