import React, { useEffect, useMemo, useState } from 'react';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import { formatMarketMonthDay } from '../../utils/timeUtils';
import { getBucketForSeries } from '../../utils/volatilityRegimes';
import { isRefreshDelayedVolatilityRow } from '../../utils/volatilitySnapshotRows';
import DelayedDataMarker, { shouldMarkDataDelayed } from './DelayedDataMarker';
import { getRowQuoteStatus } from './RadarReferencePanels';

const CHART_WIDTH = 132;
const CHART_HEIGHT = 56;
const CHART_INSET = 4;
const CHART_AXIS_LEFT = 22;
const CHART_AXIS_BOTTOM = 12;
const PULSE_ROTATION_MS = 6000;

const PULSE_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'equities',
    label: 'Equities',
    assetClass: 'equity',
    marketKeys: Object.freeze(['us', 'sectors', 'europe', 'asia']),
  }),
  Object.freeze({
    id: 'rates',
    label: 'Rates',
    assetClass: 'fixedIncome',
    marketKeys: Object.freeze(['rates']),
  }),
  Object.freeze({
    id: 'commodities',
    label: 'Commodities',
    assetClass: 'commodity',
    marketKeys: Object.freeze(['commodities']),
  }),
  Object.freeze({
    id: 'crypto',
    label: 'Crypto',
    assetClass: 'crypto',
    marketKeys: Object.freeze(['crypto']),
  }),
]);

const FEED_TO_UNIVERSE_TICKER = Object.freeze({
  IXIC: 'COMPQ',
  N225: 'NIKK',
  BZ: 'BRENT',
  CL: 'WTIC',
  HG: 'COPPER',
  SI: 'SILVER',
});

const CORE_CRYPTO_TICKERS = new Set(['BTC', 'ETH', 'SOL']);
const EXCLUDED_FEED_TICKERS = new Set([
  // UST2Y is a dated FRED observation, not a current pulse row.
  'UST2Y',
]);

const UNIVERSE_BY_TICKER = new Map(SECURITIES_LIST.map((security, index) => [
  String(security.ticker || '').toUpperCase(),
  { ...security, universeIndex: index },
]));

const VIX_ELIGIBLE_TICKERS = new Set([
  'SPX', 'RSP',
  'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK',
  'XLP', 'XLRE', 'XLU', 'XLV', 'XLY',
]);

const VOLATILITY_BY_TICKER = Object.freeze({
  QQQ: Object.freeze({ seriesKey: 'NazVol', label: 'VXN' }),
  RUT: Object.freeze({ seriesKey: 'RVX', label: 'RVX' }),
  UST10Y: Object.freeze({ seriesKey: 'MOVE', label: 'MOVE', statusLabel: 'CLOSE' }),
  UST30Y: Object.freeze({ seriesKey: 'MOVE', label: 'MOVE', statusLabel: 'CLOSE' }),
  WTIC: Object.freeze({ seriesKey: 'OVX', label: 'OVX' }),
  BRENT: Object.freeze({ seriesKey: 'OVX', label: 'OVX' }),
});

const isFiniteNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value));

const flattenRows = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenRows);
};

const resolveUniverseSecurity = (row) => {
  const feedTicker = String(row?.symbol || row?.ticker || '').toUpperCase();
  if (!feedTicker || EXCLUDED_FEED_TICKERS.has(feedTicker)) return null;
  const universeTicker = FEED_TO_UNIVERSE_TICKER[feedTicker] || feedTicker;
  const security = UNIVERSE_BY_TICKER.get(universeTicker);
  return security ? { feedTicker, universeTicker, security } : null;
};

const selectTopMovers = (marketData, category, providerStatus) => {
  const seen = new Set();
  const rows = category.marketKeys.flatMap((marketKey) => flattenRows(marketData?.[marketKey]));
  const movers = [];

  rows.forEach((row) => {
    const resolved = resolveUniverseSecurity(row);
    if (!resolved || resolved.security.assetClass !== category.assetClass) return;
    if (category.id === 'crypto' && !CORE_CRYPTO_TICKERS.has(resolved.universeTicker)) return;
    if (seen.has(resolved.universeTicker)) return;

    const status = getRowQuoteStatus(row, providerStatus);
    if (!['live', 'delayed'].includes(status)) return;
    if (!isFiniteNumber(row?.price) || !isFiniteNumber(row?.changePercent)) return;

    seen.add(resolved.universeTicker);
    movers.push({
      ...row,
      categoryId: category.id,
      feedTicker: resolved.feedTicker,
      ticker: resolved.universeTicker,
      label: resolved.security.name,
      status,
      universeIndex: resolved.security.universeIndex,
      numericChange: Number(row.changePercent),
    });
  });

  return movers
    .sort((left, right) => (
      Math.abs(right.numericChange) - Math.abs(left.numericChange)
      || left.universeIndex - right.universeIndex
      || left.ticker.localeCompare(right.ticker)
    ))
    .slice(0, 3);
};

const buildPoints = (values) => {
  const finiteValues = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite);
  if (finiteValues.length < 2) return [];

  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const range = max - min;
  const chartWidth = CHART_WIDTH - CHART_AXIS_LEFT - CHART_INSET;
  const chartHeight = CHART_HEIGHT - CHART_AXIS_BOTTOM - (CHART_INSET * 2);
  return finiteValues.map((value, index) => ({
    x: CHART_AXIS_LEFT + (index * (chartWidth / (finiteValues.length - 1))),
    y: range === 0
      ? CHART_INSET + (chartHeight / 2)
      : CHART_INSET + (((max - value) / range) * chartHeight),
  }));
};

const formatAxisValue = (value) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  const absolute = Math.abs(numeric);
  if (absolute >= 10000) return `${(numeric / 1000).toFixed(0)}K`;
  if (absolute >= 1000) return `${(numeric / 1000).toFixed(1)}K`;
  if (absolute >= 100) return numeric.toFixed(0);
  if (absolute >= 10) return numeric.toFixed(1);
  return numeric.toFixed(2);
};

const formatValue = (value, kind) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  if (kind === 'rate') return `${numeric.toFixed(2)}%`;
  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
    case 'refresh-delayed': return 'RETRY';
    case 'loading': return 'LOAD';
    default: return 'NO DATA';
  }
};

const getVolatilityStatus = (row, loading) => {
  if (loading) return 'loading';
  if (isRefreshDelayedVolatilityRow(row) && isFiniteNumber(row.lastPx)) {
    return 'refresh-delayed';
  }
  if (
    row?.availability === 'historical'
    && row?.freshness === 'historical'
    && row?.quoteMode === 'end-of-day'
    && isFiniteNumber(row.lastPx)
  ) return 'historical';
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

const PulseSparkline = ({ values, label, available, asOf }) => {
  const finiteValues = available
    ? (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite)
    : [];
  const points = buildPoints(finiteValues);
  const dateLabel = formatMarketMonthDay(asOf);
  if (points.length < 2 || !dateLabel) {
    return <div className="efr-pulse-sparkline__empty" aria-label={`${label} intraday series unavailable`}>—</div>;
  }

  const pointString = points.map(({ x, y }) => `${x},${y}`).join(' ');
  const high = Math.max(...finiteValues);
  const low = Math.min(...finiteValues);
  const xAxisY = CHART_HEIGHT - CHART_AXIS_BOTTOM;
  return (
    <svg
      className="efr-pulse-sparkline"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={`${label} intraday sparkline for ${dateLabel}`}
      preserveAspectRatio="none"
    >
      <g className="efr-pulse-sparkline__axes" aria-hidden="true">
        <line className="efr-pulse-sparkline__y-axis" x1={CHART_AXIS_LEFT} x2={CHART_AXIS_LEFT} y1={CHART_INSET} y2={xAxisY} />
        <line className="efr-pulse-sparkline__x-axis" x1={CHART_AXIS_LEFT} x2={CHART_WIDTH - CHART_INSET} y1={xAxisY} y2={xAxisY} />
        <line className="efr-pulse-sparkline__y-tick" x1={CHART_AXIS_LEFT - 2} x2={CHART_AXIS_LEFT} y1={CHART_INSET} y2={CHART_INSET} />
        <line className="efr-pulse-sparkline__y-tick" x1={CHART_AXIS_LEFT - 2} x2={CHART_AXIS_LEFT} y1={xAxisY} y2={xAxisY} />
        <text className="efr-pulse-sparkline__y-label" x={CHART_AXIS_LEFT - 4} y={CHART_INSET + 2} textAnchor="end">{formatAxisValue(high)}</text>
        <text className="efr-pulse-sparkline__y-label" x={CHART_AXIS_LEFT - 4} y={xAxisY} textAnchor="end">{formatAxisValue(low)}</text>
        <text className="efr-pulse-sparkline__x-label" x={CHART_AXIS_LEFT} y={CHART_HEIGHT - 2}>OPEN</text>
        <text
          className="efr-pulse-sparkline__x-label"
          x={(CHART_AXIS_LEFT + CHART_WIDTH - CHART_INSET) / 2}
          y={CHART_HEIGHT - 2}
          textAnchor="middle"
        >
          {dateLabel}
        </text>
        <text className="efr-pulse-sparkline__x-label" x={CHART_WIDTH - CHART_INSET} y={CHART_HEIGHT - 2} textAnchor="end">CLOSE</text>
      </g>
      <polyline points={pointString} />
    </svg>
  );
};

const EmbeddedVolatility = ({ metric }) => {
  if (!metric) return null;
  const available = ['live', 'delayed', 'historical', 'refresh-delayed'].includes(metric.status);
  const loading = metric.status === 'loading';
  const displayValue = loading ? '…' : (available ? formatValue(metric.value, 'number') : '—');
  const regime = available ? getBucketForSeries(metric.seriesKey || metric.label, metric.value) : null;
  const markedDelayed = shouldMarkDataDelayed(metric.status, metric.updatedAt);
  const delayEligible = ['delayed', 'historical', 'refresh-delayed'].includes(metric.status);
  const markerTitle = metric.status === 'historical'
    ? `${metric.label} historical reference`
    : metric.status === 'refresh-delayed'
      ? `${metric.label} refresh delayed; showing the last verified value`
      : `${metric.label} delayed value`;

  return (
    <span
      className={`efr-pulse-vol efr-pulse-vol--${metric.status}`}
      aria-label={`${metric.label} volatility ${available ? displayValue : 'unavailable'}${markedDelayed ? '; delayed or historical reference' : ''}`}
    >
      <b>{metric.label}</b>
      <strong className={regime ? `efr-pulse-vol__value--${regime}` : ''}>
        {displayValue}
        <DelayedDataMarker status={metric.status} title={markerTitle} updatedAt={metric.updatedAt} />
      </strong>
      {metric.statusLabel || !delayEligible ? (
        <small>{metric.statusLabel || getStatusLabel(metric.status)}</small>
      ) : null}
    </span>
  );
};

const volatilityDescriptorForMover = (mover) => {
  if (!mover) return null;
  if (VOLATILITY_BY_TICKER[mover.ticker]) return VOLATILITY_BY_TICKER[mover.ticker];
  if (mover.categoryId === 'equities' && VIX_ELIGIBLE_TICKERS.has(mover.ticker)) {
    return { seriesKey: 'VIX', label: 'VIX' };
  }
  return null;
};

const PulseMetricContent = ({ category, mover, loading, embeddedVolatility }) => {
  const label = mover?.label || 'No verified mover';
  const status = loading ? 'loading' : mover?.status || 'unavailable';
  const available = ['live', 'delayed', 'historical'].includes(status);
  const isLoading = status === 'loading';
  const kind = category.id === 'rates' && mover?.unit === 'yield' ? 'rate' : 'number';
  const displayValue = isLoading ? '…' : (available ? formatValue(mover?.price, kind) : '—');
  const displayChange = isLoading ? '…' : (available ? formatChange(mover?.changePercent) : '—');
  const markerUpdatedAt = mover?.lastVerifiedAt || mover?.quoteAsOf || mover?.timestamp;
  const delayEligible = ['delayed', 'historical', 'refresh-delayed'].includes(status);
  const markerTitle = mover?.displayDelayed
    ? `Refresh delayed · last verified ${mover?.lastVerifiedAt || mover?.quoteAsOf || mover?.timestamp || 'time unavailable'}`
    : status === 'historical'
      ? `Historical reference · as of ${mover?.quoteAsOf || mover?.timestamp || 'time unavailable'}`
      : `Delayed quote · as of ${mover?.quoteAsOf || mover?.timestamp || 'time unavailable'}`;

  return (
    <>
      <div className="efr-pulse-metric__copy">
        <div className="efr-pulse-metric__ticker">{mover?.ticker || '—'}</div>
        <div className="efr-pulse-metric__heading">
          <h2 title={label}>{label}</h2>
          {!delayEligible ? (
            <span className={`efr-pulse-metric__status efr-pulse-metric__status--${status}`}>
              {getStatusLabel(status)}
            </span>
          ) : null}
        </div>
        <strong>
          {displayValue}
          <DelayedDataMarker
            status={status}
            title={markerTitle}
            updatedAt={markerUpdatedAt}
          />
        </strong>
        <div className="efr-pulse-metric__footer">
          <span className={`efr-pulse-metric__change ${available ? getTone(mover?.changePercent) : 'is-unavailable'}`}>
            {displayChange}
          </span>
          <EmbeddedVolatility metric={embeddedVolatility} />
        </div>
      </div>
      <PulseSparkline
        asOf={mover?.quoteAsOf || mover?.timestamp}
        available={available}
        label={label}
        values={mover?.sparklineData}
      />
    </>
  );
};

const PulseMetric = ({ category, movers, activeIndex, loading, volatilityState }) => {
  const slides = movers.length > 0 ? movers : [null];
  return (
    <section className="efr-pulse-metric" aria-label={`${category.label} market pulse`}>
      {slides.map((mover, index) => {
        const isActive = index === activeIndex;
        const descriptor = volatilityDescriptorForMover(mover);
        const volatilityRow = descriptor
          ? volatilityState?.snapshot?.[descriptor.seriesKey]
          : null;
        const volatilityStatus = descriptor
          ? getVolatilityStatus(volatilityRow, volatilityState?.loading)
          : null;
        const embeddedVolatility = descriptor
          ? {
            ...descriptor,
            value: volatilityRow?.lastPx,
            status: volatilityStatus,
            statusLabel: descriptor.statusLabel,
            updatedAt: volatilityRow?.lastVerifiedAt || volatilityRow?.asOf || volatilityRow?.timestamp,
          }
          : null;
        return (
          <div
            aria-hidden={!isActive}
            className={`efr-pulse-metric__slide ${isActive ? 'is-active' : ''}`}
            key={mover?.ticker || 'empty'}
          >
            <PulseMetricContent
              category={category}
              embeddedVolatility={embeddedVolatility}
              loading={loading && !mover}
              mover={mover}
            />
          </div>
        );
      })}
    </section>
  );
};

const MarketPulseRibbon = ({
  marketData = {},
  marketDataLoading = false,
  providerStatus = null,
  volatilityState = {},
}) => {
  const [rotationIndex, setRotationIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setRotationIndex((value) => (value + 1) % 3000);
    }, PULSE_ROTATION_MS);
    return () => clearInterval(timer);
  }, []);

  const categories = useMemo(() => PULSE_CATEGORIES.map((category) => ({
    ...category,
    movers: selectTopMovers(marketData, category, providerStatus),
  })), [marketData, providerStatus]);

  const categoryCount = categories.length;

  return (
    <div className="efr-market-pulse" aria-label="Market pulse ribbon">
      <div className="efr-market-pulse__metrics">
        {categories.map((category, categoryIndex) => {
          const count = category.movers.length;
          // Stagger left → right: only one card advances per tick, so a full
          // pass across the ribbon takes categoryCount × PULSE_ROTATION_MS.
          const activeIndex = count > 0
            ? Math.floor(
              (rotationIndex + (categoryCount - 1 - categoryIndex)) / categoryCount,
            ) % count
            : 0;
          return (
            <PulseMetric
              activeIndex={activeIndex}
              category={category}
              key={category.id}
              loading={marketDataLoading && count === 0}
              movers={category.movers}
              volatilityState={volatilityState}
            />
          );
        })}
      </div>
    </div>
  );
};

export {
  PULSE_CATEGORIES,
  PULSE_ROTATION_MS,
  buildPoints,
  getVolatilityStatus,
  selectTopMovers,
};
export default MarketPulseRibbon;
