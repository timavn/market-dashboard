import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import marketBackdropCatalog from '../../constants/marketBackdropCatalog.json';
import { VOLATILITY_SERIES } from '../../hooks/useVolatilitySnapshot';
import { isUsdIndexRow } from '../../hooks/useUsdIndexBias';
import {
  formatVolatilityRange,
  getBucketForSeries,
  VOL_RANGES,
} from '../../utils/volatilityRegimes';
import { formatMarketMonthDay } from '../../utils/timeUtils';
import { formatOverviewPrice } from '../../utils/formatOverviewPrice';
import { delayedMarkerMarketContext, sourceMarketSessionDate } from '../../utils/delayedMarkerMarketContext';
import {
  isCurrentVolatilityRow as isCurrentSnapshotRow,
  isHistoricalVolatilityRow as isHistoricalSnapshotRow,
  isRefreshDelayedVolatilityRow,
} from '../../utils/volatilitySnapshotRows';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import DelayedDataMarker, { formatDelayedDataTimestamp } from './DelayedDataMarker';
import DashboardResearchLabel from './DashboardResearchLabel';
import MarketPulseRibbon from './MarketPulseRibbon';
import RadarReferencePanels, {
  aggregateQuoteStatus,
  getRowQuoteStatus,
} from './RadarReferencePanels';
import USDCorrelationMatrix, { getFxVolatilityRowProps } from './USDCorrelationMatrix';
import VolatilityExplainerModal from './VolatilityExplainerModal';
import VolatilityMetricRow, {
  VOLATILITY_METRIC_CHART_POINTS as VOLATILITY_CHART_POINTS,
  buildVolatilityMetricChart,
  buildVolatilityMetricSparkline,
} from './VolatilityMetricRow';
import VolatilitySpreadsheetRow, { VolatilitySpreadsheetHeader } from './VolatilitySpreadsheetRow';
import './ExceptionFirstRadar.css';

const BACKDROP_GROUPS = marketBackdropCatalog.map((group) => ({
  id: group.id,
  label: group.label,
  railLabel: group.railLabel,
  rows: group.rows.map((row) => ({
    symbols: [row.symbol],
    label: row.label,
    summary: row.summary === true,
    unit: row.unit,
    changeUnit: row.changeUnit,
    inversePerformance: row.inversePerformance === true,
  })),
}));

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

const usdIndexLevelFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const formatUsdIndexLevel = (value) => (
  isFiniteNumber(value) ? usdIndexLevelFormatter.format(Number(value)) : '—'
);

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

const formatLevel = (value, category = '', symbol = '', unit = '', detailed = false) => {
  if (!isFiniteNumber(value)) return '—';
  const numeric = Number(value);
  if (String(unit).toLowerCase() === 'bps') return numeric.toFixed(1);
  if (String(unit).toLowerCase() === 'yield') return numeric.toFixed(3);
  if (category === 'CORRELATION') return numeric.toFixed(2);
  if (category === 'FX') return numeric.toFixed(numeric < 10 ? 3 : 2);
  if (symbol.startsWith('UST') || symbol === 'BUND10Y') return numeric.toFixed(3);
  if (!detailed) return formatOverviewPrice(numeric);
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
  trading_economics: 'Trading Economics',
  bundesbank: 'Bundesbank',
  japan_mof: 'Japan Ministry of Finance',
  bank_of_england: 'Bank of England',
};

const quoteSourceLabel = (row) => {
  const source = String(row?.source || row?.provider || '').trim();
  return QUOTE_SOURCE_LABELS[source.toLowerCase()] || source || 'Unknown provider';
};

const quoteObservationFrequency = (row) => row?.observationFrequency
  || (row?.source === 'fred' && row?.latestObservationChange?.interval === 'monthly' ? 'monthly' : null);

const observationDateLabel = (value, status, frequency) => (
  formatDelayedDataTimestamp(value, status, frequency).replace(/^(?:Updated|Observation) /, '')
);

const quoteProvenanceLabel = (row, status) => {
  if (!row || status === 'unavailable') return 'Unavailable — no verified provider quote';
  const rawAsOf = row.lastVerifiedAt || row.quoteAsOf || row.timestamp || row.asOf;
  const frequency = quoteObservationFrequency(row);
  const asOf = observationDateLabel(rawAsOf, status, frequency);
  const stateLabel = frequency === 'monthly' ? 'Monthly observation'
    : status === 'historical' ? 'Historical reference'
      : status === 'refresh-delayed' || row.displayDelayed ? 'Refresh delayed'
        : status === 'current' || status === 'live' ? 'Live' : 'Delayed';
  return [
    quoteSourceLabel(row),
    stateLabel,
    asOf,
    row.sourceInstrument,
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
);

const isHistoricalMoveRow = (seriesName, row) => (
  isHistoricalSnapshotRow(seriesName, row)
  && Boolean(formatMarketMonthDay(row?.asOf))
);

const isRefreshDelayedMetricRow = (row) => (
  isRefreshDelayedVolatilityRow(row)
  && Boolean(formatMarketMonthDay(row?.asOf))
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

const VolatilityMapPanel = ({ volatilityState, vixRiskRangeState = null, researchReadings = {}, fxvlSnapshot, layout = 'map' }) => {
  const [openIndicator, setOpenIndicator] = React.useState(null);
  const closeExplainer = React.useCallback(() => setOpenIndicator(null), []);
  const snapshot = volatilityState?.snapshot;
  const loading = Boolean(volatilityState?.loading);
  const error = volatilityState?.error;
  const hasSnapshot = snapshot && typeof snapshot === 'object';
  const spreadsheet = layout === 'spreadsheet';
  const fxVolatilityProps = spreadsheet && fxvlSnapshot !== undefined
    ? getFxVolatilityRowProps(fxvlSnapshot) : null;
  const hasDisplayableRows = hasSnapshot || fxVolatilityProps?.available;
  const RowComponent = spreadsheet ? VolatilitySpreadsheetRow : VolatilityMetricRow;
  const rows = hasDisplayableRows && VOLATILITY_SERIES.map(({ name, symbol }) => {
    const row = snapshot?.[name];
    const historical = isHistoricalMoveRow(name, row);
    const refreshDelayed = isRefreshDelayedMetricRow(row);
    const available = isDisplayableVolatilityRow(name, row);
    const bucket = available ? getBucketForSeries(name, row.lastPx) : null;
    const regime = bucket
      ? VOL_RANGES[name]?.ranges.find((range) => range.color === bucket)
      : null;
    const asOfLabel = historical ? formatMoveAsOfDate(row.asOf) : null;
    return (
      <RowComponent
        key={name}
        row={row}
        symbol={symbol}
        research={researchReadings[symbol]}
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
  });

  return (
    <section
      className={`efr-panel efr-exceptions efr-vol-map${spreadsheet ? ' efr-vol-map--spreadsheet' : ''}`}
      aria-label={spreadsheet ? 'Volatility' : 'Volatility · 3M Map'}
      data-status={getVolatilityStatus(volatilityState)}
      data-open-indicator={openIndicator || undefined}
    >
      <VolatilityExplainerModal
        indicatorKey={openIndicator}
        onClose={closeExplainer}
      />
      {spreadsheet && <header className="efr-vol-spreadsheet__title"><h2>Volatility</h2></header>}
      {loading && !hasDisplayableRows ? (
        <div className="efr-vol-map__state">Loading current volatility data…</div>
      ) : !hasDisplayableRows ? (
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
      ) : spreadsheet ? (
        <div className="efr-vol-spreadsheet__wrap">
          <table className="efr-vol-spreadsheet" aria-label="Volatility performance">
            <VolatilitySpreadsheetHeader />
            <tbody>
              {rows}
              {fxVolatilityProps && <VolatilitySpreadsheetRow
                {...fxVolatilityProps}
                research={researchReadings[fxVolatilityProps.symbol]}
              />}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="efr-vol-map__rows"
          role="group"
          aria-label={`${VOLATILITY_SERIES.length} volatility series`}
          style={{ '--efr-vol-row-count': VOLATILITY_SERIES.length }}
        >
          {rows}
        </div>
      )}
    </section>
  );
};

const BackdropRow = ({ descriptor, row, providerStatus, detailed, research }) => {
  const status = getRowQuoteStatus(row, providerStatus, { allowReference: true });
  const available = status !== 'unavailable';
  const unit = String(row?.unit || descriptor.unit || '').toLowerCase();
  const isBasisPointRow = unit === 'bps';
  // Legacy curve fields contain absolute deltas despite their Pct names.
  // Only use the separately calculated percentage series for those rows.
  const percentageReturns = isBasisPointRow ? row?.backdropPercentageReturns : row?.backdropPercentageReturns || row;
  const price = available
    ? formatLevel(row?.price, '', row?.symbol || descriptor.symbols[0], unit, detailed)
    : '—';
  const provenance = quoteProvenanceLabel(row, status);
  const quoteAsOf = row?.lastVerifiedAt || row?.quoteAsOf || row?.timestamp || row?.asOf;
  const markerMarket = delayedMarkerMarketContext(row, { symbol: descriptor.symbols[0] });
  const observation = percentageReturns?.latestObservationChange || row?.latestObservationChange;
  const observationFrequency = quoteObservationFrequency(row);
  const monthlyPeriods = (row?.periodObservationFrequency || observation?.interval) === 'monthly';
  const observationAvailable = observation?.status === 'historical'
    && observation.interval === 'daily'
    && isFiniteNumber(observation.value)
    && Number.isFinite(Date.parse(observation.from))
    && Date.parse(observation.asOf) > Date.parse(observation.from)
    && Date.parse(observation.asOf) <= Date.now();
  const dailyMoveUnavailable = isBasisPointRow
    || observationFrequency === 'monthly'
    || (descriptor.changeUnit === 'bps' && row?.dayChangeBps === null)
    || !isFiniteNumber(row?.changePercent);
  const useObservation = dailyMoveUnavailable && observationAvailable && observationFrequency !== 'monthly';
  const dayChange = useObservation ? observation.value : dailyMoveUnavailable ? null : row?.changePercent;
  const dayTitle = useObservation
    ? `Last reported daily change: ${observationDateLabel(observation.from, 'historical')} to ${observationDateLabel(observation.asOf, 'historical')}`
    : observationFrequency === 'monthly'
      ? 'Daily change unavailable for monthly observations'
      : `Daily change as of ${observationDateLabel(quoteAsOf, status)}`;
  const periodAvailable = (
    available
    && row?.periodReturnsStatus === 'historical'
    && Boolean(row?.periodReturnsAsOf)
  );
  const renderReturn = (value, isPeriod = false, title, periodField) => {
    const periodEvidence = row?.periodReturnProvenance?.[periodField];
    const periodAsOf = periodEvidence?.asOf || row?.periodReturnsAsOf;
    const periodSource = periodEvidence?.source || row?.periodReturnsSource;
    const periodFrequency = periodEvidence?.observationFrequency || row?.periodObservationFrequency;
    const periodTitle = periodAvailable
      ? [periodSource ? quoteSourceLabel({ source: periodSource }) : null,
        periodEvidence?.retained ? 'Last verified historical return' : 'Historical return',
        observationDateLabel(periodAsOf, 'historical', periodFrequency),
        periodEvidence?.sourceInstrument || periodEvidence?.sourceSeriesId
          || row.periodSourceInstrument || row.periodSourceSeriesId].filter(Boolean).join(' · ')
      : undefined;
    const canRender = isPeriod ? periodAvailable : available;
    const formattedValue = canRender ? formatChange(value) : '—';
    const tone = canRender ? getPerformanceTone(value) : '';
    return (
      <td
        className={[tone, formattedValue.length >= 8 ? 'is-wide-return' : '']
          .filter(Boolean)
          .join(' ')}
        title={title || (isPeriod ? periodTitle : dayTitle)}
      >
        {formattedValue}
        {isPeriod && canRender && isFiniteNumber(value) && periodEvidence?.retained && (
          <DelayedDataMarker status="reference" popoverLabel={periodTitle}
            updatedAt={periodAsOf} observationFrequency={periodFrequency}
            {...markerMarket} marketSessionDate={periodEvidence?.marketSessionDate
              || periodEvidence?.sessionDate || sourceMarketSessionDate(periodAsOf)} />
        )}
        {!isPeriod && canRender && useObservation && (
          <DelayedDataMarker status="historical" popoverLabel={dayTitle}
            className="efr-backdrop-observation" updatedAt={observation.asOf}
            {...markerMarket} marketSessionDate={observation.sessionDate
              || sourceMarketSessionDate(observation.asOf)} />
        )}
      </td>
    );
  };

  return (
    <tr>
      <td
        title={detailed ? undefined : provenance}
        data-source={detailed ? undefined : row?.source || row?.provider || 'unavailable'}
        data-availability={detailed ? undefined : row?.availability || 'unavailable'}
        data-quote-status={detailed ? undefined : status}
      >
        <DashboardResearchLabel
          label={descriptor.label}
          reading={research}
          formatBound={(value) => formatLevel(value, '', descriptor.symbols[0], unit)}
        />
      </td>
      <td
        title={available && isFiniteNumber(row?.price) ? `${row.price} · ${provenance}` : provenance}
        aria-label={`${descriptor.label} price ${price}. ${provenance}`}
        data-source={row?.source || row?.provider || 'unavailable'}
        data-availability={row?.availability || 'unavailable'}
        data-quote-status={status}
      >
        <span className="efr-backdrop-price">
          <span>{price}</span>
          <DelayedDataMarker status={status} popoverLabel={provenance} updatedAt={quoteAsOf}
            observationFrequency={observationFrequency} {...markerMarket} />
        </span>
      </td>
      {renderReturn(dayChange)}
      {renderReturn(monthlyPeriods ? null : percentageReturns?.fifteenDayChangePct, true,
        monthlyPeriods ? '15-day change unavailable for monthly observations' : undefined, 'fifteenDayChangePct')}
      {renderReturn(percentageReturns?.monthChangePct, true, undefined, 'monthChangePct')}
      {renderReturn(percentageReturns?.threeMonthChangePct, true, undefined, 'threeMonthChangePct')}
      {renderReturn(percentageReturns?.sixMonthChangePct, true, undefined, 'sixMonthChangePct')}
      {renderReturn(percentageReturns?.ytdChangePct, true, undefined, 'ytdChangePct')}
      {renderReturn(percentageReturns?.oneYearChangePct, true, undefined, 'oneYearChangePct')}
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
      status: getRowQuoteStatus(row, providerStatus, { allowReference: true }),
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
        : aggregateQuoteStatus(displayedEntries.map((entry) => entry.row), providerStatus, { allowReference: true });

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

const BackdropTable = ({ group, rows, marketData, providerStatus, researchReadings = {}, detailed = false }) => (
  <table aria-label={`${group.label} ${detailed ? 'detailed ' : ''}market performance`}>
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
      {rows.map((descriptor) => (
        <BackdropRow
          key={descriptor.symbols[0]}
          descriptor={descriptor}
          row={findMarketRow(marketData, group.id, descriptor.symbols)}
          providerStatus={providerStatus}
          detailed={detailed}
          research={researchReadings[descriptor.symbols[0]]}
        />
      ))}
    </tbody>
  </table>
);

const MarketBackdrop = ({ marketData, marketDataLoading, marketDataError, providerStatus, researchReadings }) => {
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const triggerRefs = useRef({});
  const titleButtonRef = useRef(null);
  const statusInfo = buildMarketBackdropStatusInfo({
    marketData,
    marketDataLoading,
    marketDataError,
    providerStatus,
  });
  const expandedGroup = BACKDROP_GROUPS.find((group) => group.id === expandedGroupId) || null;

  const closeExpandedGroup = useCallback((restoreFocus = true) => {
    const trigger = expandedGroupId ? triggerRefs.current[expandedGroupId] : null;
    setExpandedGroupId(null);
    if (restoreFocus && trigger) requestAnimationFrame(() => trigger.focus());
  }, [expandedGroupId]);

  useEffect(() => {
    if (!expandedGroupId) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeExpandedGroup(true);
    };
    document.addEventListener('keydown', handleKeyDown);
    const frame = requestAnimationFrame(() => titleButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeExpandedGroup, expandedGroupId]);

  const toggleExpandedGroup = (groupId) => {
    if (expandedGroupId === groupId) {
      closeExpandedGroup(true);
      return;
    }
    setExpandedGroupId(groupId);
  };

  return (
    <>
      <section className="efr-panel efr-backdrop" aria-label="Market Backdrop" data-status={statusInfo.status}>
        <div className="efr-backdrop__body">
          {BACKDROP_GROUPS.map((group) => {
            const headingId = `efr-backdrop-${group.id}`;
            const isExpanded = expandedGroupId === group.id;
            return (
              <section
                className="efr-backdrop-group"
                key={group.id}
                aria-labelledby={headingId}
                style={{ '--efr-backdrop-summary-rows': group.rows.filter((row) => row.summary).length }}
              >
                <h3 id={headingId} aria-label={group.label}>
                  <button
                    type="button"
                    ref={(node) => { triggerRefs.current[group.id] = node; }}
                    className="efr-backdrop-group__expand"
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.label} markets`}
                    aria-expanded={isExpanded}
                    aria-controls={`efr-backdrop-dialog-${group.id}`}
                    onClick={() => toggleExpandedGroup(group.id)}
                  >
                    <span aria-hidden="true" className="efr-backdrop-group__rail-label">{group.label}</span>
                    <span aria-hidden="true" className="efr-backdrop-group__expand-icon">⤢</span>
                  </button>
                </h3>
                <BackdropTable
                  group={group}
                  rows={group.rows.filter((row) => row.summary)}
                  marketData={marketData}
                  providerStatus={providerStatus}
                  researchReadings={researchReadings}
                />
              </section>
            );
          })}
        </div>
      </section>
      {expandedGroup && typeof document !== 'undefined' && createPortal(
        <div
          className="efr-backdrop-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeExpandedGroup(false);
          }}
        >
        <section
          id={`efr-backdrop-dialog-${expandedGroup.id}`}
          className="efr-backdrop-dialog dashboard-table-dialog"
          role="dialog"
          aria-modal="false"
          aria-labelledby={`efr-backdrop-dialog-title-${expandedGroup.id}`}
        >
          <header className="efr-backdrop-dialog__header dashboard-table-dialog__header">
            <h2 id={`efr-backdrop-dialog-title-${expandedGroup.id}`}>
              <button
                type="button"
                ref={titleButtonRef}
                className="dashboard-table-dialog__title"
                title={`Close ${expandedGroup.label} markets`}
                onClick={() => closeExpandedGroup(true)}
              >
                {expandedGroup.label}
              </button>
            </h2>
          </header>
          <div className="efr-backdrop-dialog__body efr-backdrop-group">
            <BackdropTable
              group={expandedGroup}
              rows={expandedGroup.rows}
              marketData={marketData}
              providerStatus={providerStatus}
              researchReadings={researchReadings}
              detailed
            />
          </div>
        </section>
        </div>,
        document.body,
      )}
    </>
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

const USDCurrencyCells = ({ row, providerStatus, usdIndexBiasState, researchReadings }) => {
  if (!row) {
    return (
      <>
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </>
    );
  }

  const status = getRowQuoteStatus(row, providerStatus, { allowReference: true });
  const dollarIndex = isUsdIndexRow(row);
  const bias = dollarIndex && usdIndexBiasState?.status === 'available'
    && usdIndexBiasState?.bias?.verified === true ? usdIndexBiasState.bias : null;
  // Match the displayed currency orientation, not a source symbol inverted for the USD-first table.
  const researchKey = dollarIndex ? 'USD' : String(row.name || row.symbol || '').replace(/\//g, '').toUpperCase();
  const research = researchReadings?.[researchKey] || (researchReadings ? null : bias);
  const available = status !== 'unavailable';
  const quoteAsOf = row?.lastVerifiedAt || row?.quoteAsOf || row?.timestamp || row?.asOf;
  const markerMarket = delayedMarkerMarketContext(row);
  const delayedTitle = status === 'refresh-delayed'
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
  const renderReturn = (value, isPeriod = false, periodField) => {
    const evidence = row.periodReturnProvenance?.[periodField];
    const asOf = evidence?.asOf || row.periodReturnsAsOf;
    const source = evidence?.source || row.periodReturnsSource;
    const frequency = evidence?.observationFrequency || row.periodObservationFrequency;
    const periodTitle = periodAvailable ? [source ? quoteSourceLabel({ source }) : null,
      evidence?.retained ? 'Last verified historical return' : 'Historical return',
      observationDateLabel(asOf, 'historical', frequency),
      evidence?.sourceInstrument || evidence?.sourceSeriesId
        || row.periodSourceInstrument || row.periodSourceSeriesId].filter(Boolean).join(' · ') : undefined;
    const canRender = isPeriod ? periodAvailable : available;
    return (
      <td
        className={canRender ? getPerformanceTone(value) : ''}
        title={isPeriod ? periodTitle : undefined}
      >
        {canRender ? formatChange(value) : '—'}
        {isPeriod && canRender && isFiniteNumber(value) && evidence?.retained && (
          <DelayedDataMarker status="reference" popoverLabel={periodTitle}
            updatedAt={asOf} observationFrequency={frequency}
            {...markerMarket} marketSessionDate={evidence?.marketSessionDate
              || evidence?.sessionDate || sourceMarketSessionDate(asOf)} />
        )}
      </td>
    );
  };

  return (
    <>
      <td title={row.displayNote || undefined}>
        <DashboardResearchLabel
          label={dollarIndex ? 'USD Index' : row.name || row.symbol}
          reading={research}
          showUnavailable={dollarIndex && !researchReadings}
          formatBound={(value) => dollarIndex ? formatUsdIndexLevel(value) : formatLevel(value, isDollarBenchmark(row) ? '' : 'FX', row.symbol)}
        />
      </td>
      <td title={available && isFiniteNumber(row.price) ? `${row.price} · ${quoteProvenanceLabel(row, status)}` : undefined}>
        {available ? (
          <span className="efr-backdrop-price">
            <span>{dollarIndex ? formatUsdIndexLevel(row.price) : formatLevel(row.price, isDollarBenchmark(row) ? '' : 'FX', row.symbol)}</span>
            <DelayedDataMarker status={status} title={delayedTitle} updatedAt={quoteAsOf} {...markerMarket} />
          </span>
        ) : '—'}
      </td>
      {renderReturn(dayChange)}
      {renderReturn(row.fifteenDayChangePct, true, 'fifteenDayChangePct')}
      {renderReturn(row.monthChangePct, true, 'monthChangePct')}
      {renderReturn(row.threeMonthChangePct, true, 'threeMonthChangePct')}
      {renderReturn(row.sixMonthChangePct, true, 'sixMonthChangePct')}
      {renderReturn(row.ytdChangePct, true, 'ytdChangePct')}
      {renderReturn(row.oneYearChangePct, true, 'oneYearChangePct')}
    </>
  );
};

const USDCurrencySpreadsheet = ({ leftRows, rightRows, loading, providerStatus, usdIndexBiasState, researchReadings }) => {
  const rows = [...leftRows, ...rightRows];
  if (rows.length === 0) {
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
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.symbol}>
            <USDCurrencyCells
              row={row}
              providerStatus={providerStatus}
              usdIndexBiasState={usdIndexBiasState}
              researchReadings={researchReadings}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const USDCurrenciesSection = ({ rows, loading, providerStatus, usdIndexBiasState, researchReadings }) => {
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
          usdIndexBiasState={usdIndexBiasState}
          researchReadings={researchReadings}
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
  usdIndexBiasState = null,
  dashboardResearchState = null,
  correlationState = {},
  onDashboardStatusChange,
}) => {
  const researchReadings = dashboardResearchState?.readings;
  const volatilityStatus = getVolatilityStatus(volatilityState);
  const correlationStatus = getCorrelationStatus(correlationState);
  const correlationAsOf = correlationState?.calculationDate || correlationState?.correlationsCalculationDate;
  const usdCurrencyRows = useMemo(
    () => buildUsdCurrencyColumns(marketData?.currencies).flat(),
    [marketData?.currencies],
  );
  const usdCurrencyStatus = marketDataLoading && usdCurrencyRows.length === 0
    ? 'loading'
    : aggregateQuoteStatus(usdCurrencyRows, providerStatus, { allowReference: true });
  const usdCardStatus = combineCardStatuses(usdCurrencyStatus, correlationStatus);
  const correlationStatusLabel = correlationStatus === 'historical' && correlationAsOf
    ? `AS OF ${formatSnapshotDate(correlationAsOf)}`
    : correlationStatus.toUpperCase();
  const usdCardStatusDetail = `CURRENCIES ${usdCurrencyStatus.toUpperCase()} · CORRELATIONS ${correlationStatusLabel}`;
  const usdCurrencyStatuses = useMemo(
    () => usdCurrencyRows.map((row) => getRowQuoteStatus(row, providerStatus, { allowReference: true })),
    [providerStatus, usdCurrencyRows],
  );
  const usdMissingLabels = useMemo(
    () => usdCurrencyRows
      .filter((row) => getRowQuoteStatus(row, providerStatus, { allowReference: true }) === 'unavailable')
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
        <div className="efr-clock">
          <GlobalMarketDayCycleHeader compact />
        </div>
        <div className="efr-trust-strip">
          <MarketPulseRibbon />
        </div>
      </header>

      <div className="efr-primary-grid">
        <VolatilityMapPanel
          volatilityState={volatilityState}
          vixRiskRangeState={vixRiskRangeState}
          researchReadings={researchReadings}
          fxvlSnapshot={correlationState?.fxvlSnapshot || null}
          layout="spreadsheet"
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
              showFxVolatility={false}
              currencyPanel={(
                <USDCurrenciesSection
                  rows={marketData?.currencies}
                  loading={marketDataLoading}
                  providerStatus={providerStatus}
                  usdIndexBiasState={usdIndexBiasState}
                  researchReadings={researchReadings}
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
          researchReadings={researchReadings}
        />

        <RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />
      </div>

    </main>
  );
};

export {
  VolatilityMapPanel,
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
