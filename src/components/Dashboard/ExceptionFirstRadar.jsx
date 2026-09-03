import React, { useEffect, useMemo } from 'react';
import { VOLATILITY_SERIES } from '../../hooks/useVolatilitySnapshot';
import {
  formatVolatilityRange,
  getBucketForSeries,
  VOL_RANGES,
} from '../../utils/volatilityRegimes';
import { formatMarketMonthDay } from '../../utils/timeUtils';
import {
  isCurrentVolatilityRow as isCurrentSnapshotRow,
  isHistoricalVolatilityRow as isHistoricalSnapshotRow,
  isRefreshDelayedVolatilityRow,
} from '../../utils/volatilitySnapshotRows';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import DelayedDataMarker from './DelayedDataMarker';
import MarketPulseRibbon from './MarketPulseRibbon';
import RadarReferencePanels, {
  aggregateQuoteStatus,
  getRowQuoteStatus,
} from './RadarReferencePanels';
import USDCorrelationMatrix from './USDCorrelationMatrix';
import VolatilityExplainerModal from './VolatilityExplainerModal';
import VolatilityMetricRow, {
  VOLATILITY_METRIC_CHART_POINTS as VOLATILITY_CHART_POINTS,
  buildVolatilityMetricChart,
  buildVolatilityMetricSparkline,
} from './VolatilityMetricRow';
import './ExceptionFirstRadar.css';

const BACKDROP_GROUPS = [
  {
    id: 'us',
    label: 'US',
    railLabel: 'US',
    rows: [
      { symbols: ['SPX'], label: 'S&P 500' },
      { symbols: ['RSP'], label: 'S&P Equal Weight' },
      { symbols: ['DJI'], label: 'Dow 30' },
      { symbols: ['IXIC'], label: 'Nasdaq' },
      { symbols: ['RUT'], label: 'Russell' },
      { symbols: ['QQQ'], label: 'QQQ' },
      { symbols: ['SMH'], label: 'Semiconductors' },
    ],
  },
  {
    id: 'europe',
    label: 'Europe',
    railLabel: 'EU',
    rows: [
      { symbols: ['STOXX600'], label: 'STOXX Europe 600' },
      { symbols: ['SX5E'], label: 'Euro STOXX 50' },
      { symbols: ['FTSE'], label: 'FTSE 100' },
      { symbols: ['CAC'], label: 'CAC 40' },
      { symbols: ['DAX'], label: 'DAX' },
      { symbols: ['N100'], label: 'Euronext 100' },
    ],
  },
  {
    id: 'asia',
    label: 'Asia',
    railLabel: 'ASIA',
    rows: [
      { symbols: ['N225'], label: 'Nikkei 225' },
      { symbols: ['HSI'], label: 'Hang Seng' },
      { symbols: ['CSI300'], label: 'CSI 300' },
      { symbols: ['SSEC'], label: 'Shanghai' },
      { symbols: ['KOSPI'], label: 'KOSPI' },
      { symbols: ['TAIEX'], label: 'TAIEX' },
      { symbols: ['NIFTY50'], label: 'Nifty 50' },
      { symbols: ['AXJO'], label: 'ASX 200' },
    ],
  },
  {
    id: 'commodities',
    label: 'Commodities',
    railLabel: 'CMDTY',
    rows: [
      { symbols: ['CRB'], label: 'CRB Index' },
      { symbols: ['BZ'], label: 'Brent Oil' },
      { symbols: ['CL'], label: 'WTI Oil' },
      { symbols: ['NG'], label: 'Natural Gas' },
      { symbols: ['GC'], label: 'Gold' },
      { symbols: ['SI'], label: 'Silver' },
      { symbols: ['HG'], label: 'Copper' },
      { symbols: ['PL'], label: 'Platinum' },
      { symbols: ['ZC'], label: 'Corn' },
    ],
  },
  {
    id: 'rates',
    label: 'Rates',
    railLabel: 'RATES',
    rows: [
      { symbols: ['UST2Y'], label: 'UST 2Y' },
      { symbols: ['UST5Y'], label: 'UST 5Y' },
      { symbols: ['UST10Y'], label: 'UST 10Y' },
      { symbols: ['UST30Y'], label: 'UST 30Y' },
      { symbols: ['CURVE_2s10s'], label: '2s10s Curve', unit: 'bps' },
      { symbols: ['BUND10Y'], label: 'Bund 10Y' },
      { symbols: ['IG_OAS'], label: 'IG OAS', inversePerformance: true },
      { symbols: ['HY_OAS'], label: 'HY OAS', inversePerformance: true },
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto',
    railLabel: 'CRYPTO',
    rows: [
      { symbols: ['BTC'], label: 'Bitcoin / USD' },
      { symbols: ['ETH'], label: 'Ethereum / USD' },
      { symbols: ['BNB'], label: 'BNB / USD' },
      { symbols: ['XRP'], label: 'XRP / USD' },
      { symbols: ['SOL'], label: 'Solana / USD' },
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
  const normalizedSymbols = (Array.isArray(symbols) ? symbols : [])
    .map((symbol) => String(symbol || '').toUpperCase());
  return rows.find((row) => normalizedSymbols.includes(String(row?.symbol || '').toUpperCase())) || null;
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

const formatLevel = (value, category = '', symbol = '', unit = '') => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  if (String(unit).toLowerCase() === 'bps') return `${numeric.toFixed(1)} bps`;
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
  return `${Math.abs(numeric).toFixed(digits)}${suffix}`;
};

const getPerformanceTone = (value) => {
  if (!isFiniteNumber(value)) return '';
  if (Number(value) === 0) return 'is-neutral';
  return Number(value) > 0 ? 'is-positive' : 'is-negative';
};

const aggregateDataStatuses = (statuses) => {
  const values = (Array.isArray(statuses) ? statuses : []).filter(Boolean);
  const usable = values.filter((status) => status !== 'unavailable');
  if (usable.length === 0) return 'unavailable';
  if (usable.includes('refresh-delayed')) return 'mixed';
  if (usable.length !== values.length || new Set(usable).size > 1) return 'mixed';
  return usable[0];
};

const getVolatilityRowStatus = (seriesName, row) => {
  const complete = Boolean(formatMarketMonthDay(row?.asOf))
    && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]));
  const historicalMove = isHistoricalSnapshotRow(seriesName, row) && complete;
  if (historicalMove) return 'historical';
  if (isRefreshDelayedVolatilityRow(row) && complete) return 'refresh-delayed';
  if (!isCurrentSnapshotRow(row) || !complete) {
    return 'unavailable';
  }
  const quoteMode = String(row.quoteMode || row.dataType || '').toLowerCase();
  const source = String(row.source || '').toLowerCase();
  return quoteMode.includes('delay') || source === 'yahoo' || source === 'cboe'
    ? 'delayed'
    : 'live';
};

const STATUS_COUNT_LABELS = {
  live: 'live',
  delayed: 'delayed',
  'refresh-delayed': 'refresh delayed',
  mixed: 'mixed',
  historical: 'as-of',
  unavailable: 'missing',
};

const QUOTE_SOURCE_LABELS = {
  ibkr: 'IBKR',
  yahoo: 'Yahoo Finance',
  fred: 'FRED',
  stooq: 'Stooq',
};

const quoteSourceLabel = (row) => {
  const source = String(row?.source || row?.provider || '').trim();
  return QUOTE_SOURCE_LABELS[source.toLowerCase()] || source || 'Unknown provider';
};

const quoteProvenanceLabel = (row, status) => {
  if (!row || status === 'unavailable') return 'Unavailable — no verified provider quote';
  const rawAsOf = row.quoteAsOf || row.timestamp || row.asOf;
  const parsedAsOf = rawAsOf ? new Date(rawAsOf) : null;
  const asOf = parsedAsOf && !Number.isNaN(parsedAsOf.getTime())
    ? parsedAsOf.toISOString()
    : rawAsOf;
  const warning = String(row.warning || '').trim();
  return [
    quoteSourceLabel(row),
    status,
    asOf ? `as of ${asOf}` : null,
    warning || null,
  ].filter(Boolean).join(' · ');
};

const formatStatusCounts = (statuses) => Object.entries(
  (Array.isArray(statuses) ? statuses : []).reduce((counts, status) => ({
    ...counts,
    [status]: (counts[status] || 0) + 1,
  }), {}),
)
  .map(([status, count]) => `${count} ${STATUS_COUNT_LABELS[status] || status}`)
  .join(' · ');

const formatProviderCounts = (entries) => Object.values(
  (Array.isArray(entries) ? entries : []).reduce((counts, { row, status }) => {
    if (!row || status === 'unavailable') return counts;
    const label = quoteSourceLabel(row);
    const key = `${label} ${STATUS_COUNT_LABELS[status] || status}`;
    return { ...counts, [key]: { label: key, count: (counts[key]?.count || 0) + 1 } };
  }, {}),
)
  .map(({ label, count }) => `${count} ${label}`)
  .join(' · ') || 'No verified providers';

const formatIssue = (value) => {
  if (!value) return null;
  if (
    ['LIVE_RESOURCE_FUTURE_TIMESTAMP', 'LIVE_RESOURCE_STALE'].includes(value?.code)
    && value?.observedAt
    && Number.isFinite(Number(value?.ageMs))
    && Number.isFinite(Number(value?.thresholdMs))
  ) {
    const ageMs = Number(value.ageMs);
    const ageLabel = ageMs < 0
      ? `${Math.ceil(Math.abs(ageMs) / 1000)}s ahead`
      : `${Math.ceil(ageMs / 1000)}s old`;
    const thresholdLabel = value.code === 'LIVE_RESOURCE_FUTURE_TIMESTAMP'
      ? 'future tolerance'
      : 'freshness limit';
    return `${value.message} Observed ${value.observedAt} (${ageLabel}; ${thresholdLabel} ${Math.round(Number(value.thresholdMs) / 1000)}s).`;
  }
  return value?.message || String(value);
};

const formatMissingIssue = (labels) => {
  const values = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (values.length === 0) return null;
  const shown = values.slice(0, 5);
  const remainder = values.length - shown.length;
  return `Missing: ${shown.join(', ')}${remainder > 0 ? ` +${remainder} more` : ''}`;
};

const getProviderIssue = (providerStatus) => {
  if (providerStatus?.statusRefreshDelayed) return 'Provider status refresh is delayed.';
  if (providerStatus?.ibkr?.connected === false) {
    return `IBKR market data is disconnected${providerStatus.ibkr.error ? `: ${providerStatus.ibkr.error}` : '.'}`;
  }
  return null;
};

const getVolatilityStatus = (volatilityState) => {
  if (!volatilityState?.snapshot) return volatilityState?.loading ? 'loading' : 'unavailable';
  return aggregateDataStatuses(VOLATILITY_SERIES.map(({ name }) => (
    getVolatilityRowStatus(name, volatilityState.snapshot[name])
  )));
};

const buildVolatilityStatusInfo = (volatilityState, status) => {
  const snapshot = volatilityState?.snapshot;
  const snapshotDate = volatilityState?.lastUpdated
    ? formatSnapshotDate(volatilityState.lastUpdated)
    : undefined;
  const seriesStatuses = VOLATILITY_SERIES.map(({ name }) => getVolatilityRowStatus(name, snapshot?.[name]));
  const missingSeries = VOLATILITY_SERIES
    .filter(({ name }) => getVolatilityRowStatus(name, snapshot?.[name]) === 'unavailable')
    .map(({ symbol }) => symbol);
  const availableSeriesCount = seriesStatuses.filter((seriesStatus) => seriesStatus !== 'unavailable').length;
  return {
    id: 'volatility',
    status,
    date: snapshotDate,
    sourceDate: volatilityState?.lastUpdated || undefined,
    detail: snapshotDate,
    diagnostics: [
      { label: 'Coverage', value: `${availableSeriesCount}/${VOLATILITY_SERIES.length} series` },
      { label: 'Sources', value: formatStatusCounts(seriesStatuses) },
    ],
    issues: [formatIssue(volatilityState?.error), formatMissingIssue(missingSeries)].filter(Boolean),
  };
};

const getCorrelationStatus = (correlationState) => {
  if (!correlationState?.correlations || !correlationState?.rollingStats) {
    return correlationState?.loading ? 'loading' : 'unavailable';
  }
  if (correlationState?.sourceStatus && correlationState.sourceStatus !== 'current') return 'unavailable';
  return 'historical';
};

const combineCardStatuses = (...statuses) => {
  const availableStatuses = statuses.filter(Boolean);
  if (availableStatuses.length === 0) return 'unavailable';
  if (availableStatuses.some((status) => ['offline', 'unavailable'].includes(status))) {
    return 'unavailable';
  }
  if (availableStatuses.includes('loading')) return 'loading';
  return new Set(availableStatuses).size === 1 ? availableStatuses[0] : 'mixed';
};

const isCurrentVolatilityRow = (row) => (
  isCurrentSnapshotRow(row)
  && Boolean(formatMarketMonthDay(row?.asOf))
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isHistoricalMoveRow = (seriesName, row) => (
  isHistoricalSnapshotRow(seriesName, row)
  && Boolean(formatMarketMonthDay(row?.asOf))
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isRefreshDelayedMetricRow = (row) => (
  isRefreshDelayedVolatilityRow(row)
  && Boolean(formatMarketMonthDay(row?.asOf))
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isDisplayableVolatilityRow = (seriesName, row) => (
  isCurrentVolatilityRow(row)
  || isHistoricalMoveRow(seriesName, row)
  || isRefreshDelayedMetricRow(row)
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

const buildVolatilityChart = (
  row,
  width,
  height,
  seriesName = null,
) => buildVolatilityMetricChart(row, width, height, {
  available: isDisplayableVolatilityRow(seriesName, row),
  historical: isHistoricalMoveRow(seriesName, row),
  regimeRanges: VOL_RANGES[seriesName]?.ranges,
});

const buildVolatilitySparkline = (row, width, height, seriesName = null) => (
  buildVolatilityMetricSparkline(row, width, height, {
    available: isDisplayableVolatilityRow(seriesName, row),
    historical: isHistoricalMoveRow(seriesName, row),
    regimeRanges: VOL_RANGES[seriesName]?.ranges,
  })
);

const VolatilityMapPanel = ({ volatilityState, vixRiskRangeState = null }) => {
  const [openIndicator, setOpenIndicator] = React.useState(null);
  const closeExplainer = React.useCallback(() => setOpenIndicator(null), []);
  const snapshot = volatilityState?.snapshot;
  const loading = Boolean(volatilityState?.loading);
  const error = volatilityState?.error;
  const hasSnapshot = snapshot && typeof snapshot === 'object';

  return (
    <section
      className="efr-panel efr-exceptions efr-vol-map"
      aria-label="Volatility · 3M Map"
      data-status={getVolatilityStatus(volatilityState)}
      data-open-indicator={openIndicator || undefined}
    >
      <VolatilityExplainerModal
        indicatorKey={openIndicator}
        onClose={closeExplainer}
      />
      {loading && !hasSnapshot ? (
        <div className="efr-vol-map__state">Loading current volatility data…</div>
      ) : !hasSnapshot ? (
        <div className="efr-vol-map__state efr-vol-map__state--error" role="alert">
          <span>
            {error
              ? `Current volatility data unavailable: ${error}`
              : 'Current volatility data unavailable.'}
          </span>
          {volatilityState?.retry ? (
            <button type="button" onClick={volatilityState.retry}>Retry</button>
          ) : null}
        </div>
      ) : (
        <div
          className="efr-vol-map__rows"
          role="group"
          aria-label={`${VOLATILITY_SERIES.length} volatility series`}
          style={{ '--efr-vol-row-count': VOLATILITY_SERIES.length }}
        >
          {VOLATILITY_SERIES.map(({ name, symbol }) => {
            const row = snapshot[name];
            const historical = isHistoricalMoveRow(name, row);
            const refreshDelayed = isRefreshDelayedMetricRow(row);
            const available = isDisplayableVolatilityRow(name, row);
            const bucket = available ? getBucketForSeries(name, row.lastPx) : null;
            const regime = bucket
              ? VOL_RANGES[name]?.ranges.find((range) => range.color === bucket)
              : null;
            const asOfLabel = historical ? formatMoveAsOfDate(row.asOf) : null;
            return (
              <VolatilityMetricRow
                key={name}
                row={row}
                symbol={symbol}
                available={available}
                historical={historical}
                refreshDelayed={refreshDelayed}
                bucket={bucket}
                regimeLabel={regime?.label}
                regimeRange={formatVolatilityRange(regime)}
                regimeRanges={VOL_RANGES[name]?.ranges}
                riskRange={name === 'VIX' ? vixRiskRangeState?.range : null}
                riskRangeStatus={name === 'VIX' ? vixRiskRangeState?.status : null}
                resolveLevelBucket={(value) => getBucketForSeries(name, value)}
                onTickerClick={() => setOpenIndicator(name)}
                ariaLabel={
                  available
                    ? historical
                      ? `${symbol} end-of-day volatility as of ${asOfLabel}`
                      : refreshDelayed
                        ? `${symbol} last verified volatility; refresh delayed`
                      : `${symbol} current volatility`
                    : `${symbol} volatility data unavailable`
                }
              />
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
  const unit = String(row?.unit || descriptor.unit || '').toLowerCase();
  const isBasisPointRow = unit === 'bps';
  const price = available
    ? formatLevel(row?.price, '', row?.symbol || descriptor.symbols[0], unit)
    : '—';
  const provenance = quoteProvenanceLabel(row, status);
  const quoteAsOf = row?.lastVerifiedAt || row?.quoteAsOf || row?.timestamp || row?.asOf;
  const delayedTitle = row?.displayDelayed
    ? `Refresh delayed · last verified ${quoteAsOf || 'time unavailable'}`
    : status === 'historical'
      ? `Historical reference · as of ${quoteAsOf || 'time unavailable'}`
      : `Delayed quote · as of ${quoteAsOf || 'time unavailable'}`;
  const dayChange = row?.changePercent;
  const periodAvailable = (
    available
    && row?.periodReturnsStatus === 'historical'
    && Boolean(row?.periodReturnsAsOf)
  );
  const periodTitle = periodAvailable
    ? `Historical return as of ${row.periodReturnsAsOf}`
    : undefined;
  const getTone = (value) => (
    descriptor.inversePerformance && isFiniteNumber(value)
      ? getPerformanceTone(-Number(value))
      : getPerformanceTone(value)
  );

  const renderReturn = (value, isPeriod = false) => {
    const canRender = isPeriod ? periodAvailable : available;
    const suffix = isBasisPointRow ? ' bps' : '%';
    const digits = isBasisPointRow ? 1 : 2;
    const formattedValue = canRender ? formatChange(value, suffix, digits) : '—';
    const tone = canRender ? getTone(value) : '';
    return (
      <td
        className={[tone, formattedValue.length >= 8 ? 'is-wide-return' : '']
          .filter(Boolean)
          .join(' ')}
        title={isPeriod ? periodTitle : undefined}
      >
        {formattedValue}
      </td>
    );
  };

  return (
    <tr>
      <td>{descriptor.label}</td>
      <td
        title={provenance}
        aria-label={`${descriptor.label} price ${price}. ${provenance}`}
        data-source={row?.source || row?.provider || 'unavailable'}
        data-availability={row?.availability || 'unavailable'}
        data-quote-status={status}
      >
        <span className="efr-backdrop-price">
          <span>{price}</span>
          <DelayedDataMarker status={status} title={delayedTitle} updatedAt={quoteAsOf} />
        </span>
      </td>
      {renderReturn(dayChange)}
      {renderReturn(row?.fifteenDayChangePct, true)}
      {renderReturn(row?.monthChangePct, true)}
      {renderReturn(row?.threeMonthChangePct, true)}
      {renderReturn(row?.sixMonthChangePct, true)}
      {renderReturn(row?.ytdChangePct, true)}
      {renderReturn(row?.oneYearChangePct, true)}
    </tr>
  );
};

const buildMarketBackdropStatusInfo = ({
  marketData,
  marketDataLoading,
  marketDataError,
  providerStatus,
}) => {
  const displayedEntries = BACKDROP_GROUPS.flatMap((group) => group.rows.map((descriptor) => {
    const row = findMarketRow(marketData, group.id, descriptor.symbols);
    return {
      label: descriptor.label,
      row,
      status: getRowQuoteStatus(row, providerStatus),
    };
  }));
  const displayedStatuses = displayedEntries.map((entry) => entry.status);
  const availableCount = displayedStatuses.filter((status) => status !== 'unavailable').length;
  const missingLabels = displayedEntries
    .filter((entry) => entry.status === 'unavailable')
    .map((entry) => entry.label);
  const sourceDates = displayedEntries
    .map(({ row }) => row?.quoteAsOf || row?.timestamp || row?.asOf)
    .filter(Boolean)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  const hasMarketRows = displayedEntries.some(({ row }) => Boolean(row));
  const overallStatus = marketDataLoading && !hasMarketRows
    ? 'loading'
      : marketDataError && !hasMarketRows
        ? 'unavailable'
        : aggregateQuoteStatus(displayedEntries.map((entry) => entry.row), providerStatus);

  return {
    id: 'market-backdrop',
    status: overallStatus,
    sourceDate: sourceDates[0] || undefined,
    diagnostics: [
      { label: 'Coverage', value: `${availableCount}/${displayedEntries.length} markets` },
      { label: 'Sources', value: formatStatusCounts(displayedStatuses) },
      { label: 'Providers', value: formatProviderCounts(displayedEntries) },
      { label: 'As of', value: sourceDates[0] || 'No verified provider timestamp' },
    ],
    issues: [
      formatIssue(marketDataError),
      formatMissingIssue(missingLabels),
      getProviderIssue(providerStatus),
    ].filter(Boolean),
  };
};

const MarketBackdrop = ({ marketData, marketDataLoading, marketDataError, providerStatus }) => {
  const statusInfo = buildMarketBackdropStatusInfo({
    marketData,
    marketDataLoading,
    marketDataError,
    providerStatus,
  });

  return (
    <section className="efr-panel efr-backdrop" aria-label="Market Backdrop" data-status={statusInfo.status}>
      <div className="efr-backdrop__body">
        {BACKDROP_GROUPS.map((group) => (
          <section className="efr-backdrop-group" key={group.id} aria-labelledby={`efr-backdrop-${group.id}`}>
            <h3 id={`efr-backdrop-${group.id}`} aria-label={group.label}>
              <span aria-hidden="true">{group.railLabel}</span>
            </h3>
            <table aria-label={`${group.label} market performance`}>
              <thead>
                <tr>
                  <th>ASSET</th>
                  <th>Price</th>
                  <th>DAY</th>
                  <th>15D</th>
                  <th>1M</th>
                  <th>3M</th>
                  <th>6M</th>
                  <th>YTD</th>
                  <th>1Y</th>
                </tr>
              </thead>
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

const isDollarBenchmark = (row) => {
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return symbol === 'USD' || symbol === 'DXY' || symbol === 'UUP' || name === 'DXY' || name === 'UUP';
};

const USD_PAIR_PRIORITY = [
  'EURUSD',
  'USDJPY',
  'GBPUSD',
  'AUDUSD',
  'USDCAD',
  'USDMXN',
  'USDCHF',
  'USDCNY',
  'NZDUSD',
  'EURGBP',
];

const USD_PERSPECTIVE_RETURN_FIELDS = [
  'changePercent',
  'weekChangePct',
  'fifteenDayChangePct',
  'thirtyDayChangePct',
  'ninetyDayChangePct',
  'monthChangePct',
  'threeMonthChangePct',
  'sixMonthChangePct',
  'mtdChangePct',
  'qtdChangePct',
  'ytdChangePct',
  'oneYearChangePct',
];

const invertPercentageReturn = (value) => {
  if (!isFiniteNumber(value)) return null;
  const grossReturn = 1 + (Number(value) / 100);
  if (grossReturn <= 0) return null;
  return ((1 / grossReturn) - 1) * 100;
};

const normalizeUsdFirstCurrencyRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const sourceName = String(row.name || row.symbol || '').trim().toUpperCase();
  const match = sourceName.match(/^([A-Z]{3})\/USD$/);
  if (!match) return row;

  const sourcePrice = Number(row.price);
  const invalidPrice = !isFiniteNumber(row.price) || sourcePrice <= 0;
  const normalized = {
    ...row,
    name: `USD/${match[1]}`,
    price: invalidPrice ? null : 1 / sourcePrice,
    change: null,
    displayNote: `${sourceName} inverted for a USD-first view`,
  };

  USD_PERSPECTIVE_RETURN_FIELDS.forEach((field) => {
    normalized[field] = invalidPrice ? null : invertPercentageReturn(row[field]);
  });

  if (invalidPrice) {
    normalized.availability = 'unavailable';
    normalized.warning = [row.warning, 'invalid_usd_reciprocal_source'].filter(Boolean).join('; ');
  }

  return normalized;
};

const getUsdCurrencyPriority = (row) => {
  const symbol = String(row?.symbol || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  if (isDollarBenchmark(row)) return symbol === 'UUP' || name === 'UUP' ? 1 : 0;
  const pairIndex = USD_PAIR_PRIORITY.indexOf(symbol);
  return pairIndex === -1 ? Number.MAX_SAFE_INTEGER : pairIndex + 2;
};

const buildUsdCurrencyColumns = (rows) => {
  const currencyRows = Array.isArray(rows) ? rows : [];
  const orderedRows = [...currencyRows]
    .sort((left, right) => getUsdCurrencyPriority(left) - getUsdCurrencyPriority(right))
    .slice(0, 10)
    .map(normalizeUsdFirstCurrencyRow);
  const midpoint = Math.ceil(orderedRows.length / 2);

  return [orderedRows.slice(0, midpoint), orderedRows.slice(midpoint)];
};

const USDCurrencyCells = ({ row, providerStatus }) => {
  if (!row) {
    return (
      <>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </>
    );
  }

  const status = getRowQuoteStatus(row, providerStatus);
  const available = status !== 'unavailable';
  const quoteAsOf = row?.lastVerifiedAt || row?.quoteAsOf || row?.timestamp || row?.asOf;
  const delayedTitle = row?.displayDelayed
    ? `Refresh delayed · last verified ${quoteAsOf || 'time unavailable'}`
    : status === 'historical'
      ? `Historical reference · as of ${quoteAsOf || 'time unavailable'}`
      : `Delayed quote · as of ${quoteAsOf || 'time unavailable'}`;
  const dayChange = row.changePercent;
  const periodAvailable = (
    available
    && row.periodReturnsStatus === 'historical'
    && Boolean(row.periodReturnsAsOf)
  );
  const periodTitle = periodAvailable
    ? `Historical return as of ${row.periodReturnsAsOf}`
    : undefined;
  const renderReturn = (value, isPeriod = false) => {
    const canRender = isPeriod ? periodAvailable : available;
    return (
      <td
        className={canRender ? getPerformanceTone(value) : ''}
        title={isPeriod ? periodTitle : undefined}
      >
        {canRender ? formatChange(value) : '—'}
      </td>
    );
  };

  return (
    <>
      <td title={row.displayNote || undefined}>{row.name || row.symbol}</td>
      <td>
        {available ? (
          <span className="efr-backdrop-price">
            <span>{formatLevel(row.price, 'FX', row.symbol)}</span>
            <DelayedDataMarker status={status} title={delayedTitle} updatedAt={quoteAsOf} />
          </span>
        ) : '—'}
      </td>
      {renderReturn(dayChange)}
      {renderReturn(row.fifteenDayChangePct, true)}
      {renderReturn(row.monthChangePct, true)}
      {renderReturn(row.threeMonthChangePct, true)}
      {renderReturn(row.sixMonthChangePct, true)}
      {renderReturn(row.ytdChangePct, true)}
      {renderReturn(row.oneYearChangePct, true)}
    </>
  );
};

const USDCurrencySpreadsheet = ({ leftRows, rightRows, loading, providerStatus }) => {
  const rowCount = Math.max(leftRows.length, rightRows.length);
  if (rowCount === 0) {
    return (
      <div className="usd-card-currencies__empty">
        {loading ? 'Loading verified currency data…' : 'No verified currency data available'}
      </div>
    );
  }

  return (
    <table className="efr-mini-table usd-currency-spreadsheet" aria-label="USD currency spreadsheet">
      <colgroup>
        <col className="usd-currency-spreadsheet__ticker-col" />
        <col className="usd-currency-spreadsheet__price-col" />
        <col className="usd-currency-spreadsheet__return-col" span={7} />
        <col className="usd-currency-spreadsheet__ticker-col" />
        <col className="usd-currency-spreadsheet__price-col" />
        <col className="usd-currency-spreadsheet__return-col" span={7} />
      </colgroup>
      <thead>
        <tr>
          <th className="usd-currency-spreadsheet__header">TICKER</th>
          <th className="usd-currency-spreadsheet__header">PRICE</th>
          <th className="usd-currency-spreadsheet__header">DAY</th>
          <th className="usd-currency-spreadsheet__header">15D</th>
          <th className="usd-currency-spreadsheet__header">1M</th>
          <th className="usd-currency-spreadsheet__header">3M</th>
          <th className="usd-currency-spreadsheet__header">6M</th>
          <th className="usd-currency-spreadsheet__header">YTD</th>
          <th className="usd-currency-spreadsheet__header">1Y</th>
          <th className="usd-currency-spreadsheet__header">TICKER</th>
          <th className="usd-currency-spreadsheet__header">PRICE</th>
          <th className="usd-currency-spreadsheet__header">DAY</th>
          <th className="usd-currency-spreadsheet__header">15D</th>
          <th className="usd-currency-spreadsheet__header">1M</th>
          <th className="usd-currency-spreadsheet__header">3M</th>
          <th className="usd-currency-spreadsheet__header">6M</th>
          <th className="usd-currency-spreadsheet__header">YTD</th>
          <th className="usd-currency-spreadsheet__header">1Y</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rowCount }, (_, index) => (
          <tr key={`${leftRows[index]?.symbol || 'blank'}-${rightRows[index]?.symbol || 'blank'}`}>
            <USDCurrencyCells
              row={leftRows[index]}
              providerStatus={providerStatus}
            />
            <USDCurrencyCells
              row={rightRows[index]}
              providerStatus={providerStatus}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const USDCurrenciesSection = ({ rows, loading, providerStatus }) => {
  const [dollarAndMajorRows, usdCrossRows] = buildUsdCurrencyColumns(rows);

  return (
    <section
      className="usd-card-section usd-card-section--currencies"
      aria-labelledby="usd-card-currencies-title"
    >
      <header className="usd-card-section__header usd-card-section__header--dollar">
        <h3 id="usd-card-currencies-title">Dollar</h3>
      </header>
      <div className="usd-card-section__body usd-card-currencies__body">
        <USDCurrencySpreadsheet
          leftRows={dollarAndMajorRows}
          rightRows={usdCrossRows}
          loading={loading}
          providerStatus={providerStatus}
        />
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
  vixRiskRangeState = null,
  correlationState = {},
  onDashboardStatusChange,
}) => {
  const volatilityStatus = getVolatilityStatus(volatilityState);
  const correlationStatus = getCorrelationStatus(correlationState);
  const correlationAsOf = correlationState?.calculationDate || correlationState?.correlationsCalculationDate;
  const usdCurrencyRows = useMemo(
    () => buildUsdCurrencyColumns(marketData?.currencies).flat(),
    [marketData?.currencies],
  );
  const usdCurrencyStatus = marketDataLoading && usdCurrencyRows.length === 0
    ? 'loading'
    : aggregateQuoteStatus(usdCurrencyRows, providerStatus);
  const usdCardStatus = combineCardStatuses(usdCurrencyStatus, correlationStatus);
  const correlationStatusLabel = correlationStatus === 'historical' && correlationAsOf
    ? `AS OF ${formatSnapshotDate(correlationAsOf)}`
    : correlationStatus.toUpperCase();
  const usdCardStatusDetail = `CURRENCIES ${usdCurrencyStatus.toUpperCase()} · CORRELATIONS ${correlationStatusLabel}`;
  const usdCurrencyStatuses = useMemo(
    () => usdCurrencyRows.map((row) => getRowQuoteStatus(row, providerStatus)),
    [providerStatus, usdCurrencyRows],
  );
  const usdMissingLabels = useMemo(
    () => usdCurrencyRows
      .filter((row) => getRowQuoteStatus(row, providerStatus) === 'unavailable')
      .map((row) => row?.name || row?.symbol),
    [providerStatus, usdCurrencyRows],
  );
  const dashboardCardStatuses = useMemo(() => [
    buildVolatilityStatusInfo(volatilityState, volatilityStatus),
    {
      id: 'usd',
      status: usdCardStatus,
      date: correlationAsOf ? formatSnapshotDate(correlationAsOf) : undefined,
      sourceDate: correlationAsOf || undefined,
      detail: usdCardStatusDetail,
      diagnostics: [
        { label: 'Currencies', value: formatStatusCounts(usdCurrencyStatuses) || usdCurrencyStatus },
        { label: 'Correlations', value: correlationStatusLabel },
      ],
      issues: [
        formatIssue(marketDataError),
        correlationState?.error ? `Correlations: ${formatIssue(correlationState.error)}` : null,
        formatMissingIssue(usdMissingLabels),
        getProviderIssue(providerStatus),
      ].filter(Boolean),
    },
    buildMarketBackdropStatusInfo({
      marketData,
      marketDataLoading,
      marketDataError,
      providerStatus,
    }),
  ], [
    correlationAsOf,
    correlationState,
    correlationStatusLabel,
    marketData,
    marketDataError,
    marketDataLoading,
    providerStatus,
    usdCardStatus,
    usdCardStatusDetail,
    usdCurrencyStatus,
    usdCurrencyStatuses,
    usdMissingLabels,
    volatilityState,
    volatilityStatus,
  ]);

  useEffect(() => {
    onDashboardStatusChange?.(dashboardCardStatuses);
  }, [dashboardCardStatuses, onDashboardStatusChange]);

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

      <div className="efr-primary-grid">
        <VolatilityMapPanel
          volatilityState={volatilityState}
          vixRiskRangeState={vixRiskRangeState}
        />

        <div className="efr-analytics-stack">
          <section
            className="efr-panel efr-analytics-card efr-analytics-card--correlations efr-analytics-card--usd"
            aria-label="USD"
            data-status={usdCardStatus}
          >
            <USDCorrelationMatrix
              state={correlationState}
              correlations={correlationState?.correlations}
              rollingStats={correlationState?.rollingStats}
              correlationsTimestamp={correlationState?.correlationsTimestamp || correlationState?.timestamp}
              calculationDate={correlationAsOf}
              loading={correlationState?.loading}
              refreshing={correlationState?.refreshing}
              error={correlationState?.error}
              onRetry={correlationState?.retry}
              variant="radar"
              currencyPanel={(
                <USDCurrenciesSection
                  rows={marketData?.currencies}
                  loading={marketDataLoading}
                  providerStatus={providerStatus}
                />
              )}
            />
          </section>

        </div>

        <MarketBackdrop
          marketData={marketData}
          marketDataLoading={marketDataLoading}
          marketDataError={marketDataError}
          providerStatus={providerStatus}
        />

        <RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />
      </div>

    </main>
  );
};

export {
  BACKDROP_GROUPS,
  buildUsdCurrencyColumns,
  buildVolatilityChart,
  buildVolatilitySparkline,
  combineCardStatuses,
  findMarketRow,
  flattenRows,
  isDisplayableVolatilityRow,
  isCurrentVolatilityRow,
  invertPercentageReturn,
  normalizeUsdFirstCurrencyRow,
};
export default ExceptionFirstRadar;
