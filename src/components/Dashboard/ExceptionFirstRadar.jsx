import React from 'react';
import { VOLATILITY_SERIES } from '../../hooks/useVolatilitySnapshot';
import {
  formatVolatilityRange,
  getBucketForSeries,
  VOL_RANGES,
} from '../../utils/volatilityRegimes';
import { formatMarketMonthDay } from '../../utils/timeUtils';
import DataStatusChip from './DataStatusChip';
import GlobalMarketDayCycleHeader from './GlobalMarketDayCycleHeader';
import MarketPulseRibbon from './MarketPulseRibbon';
import RadarReferencePanels, {
  aggregateQuoteStatus,
  getRowQuoteStatus,
} from './RadarReferencePanels';
import USDCorrelationMatrix from './USDCorrelationMatrix';
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
    railLabel: 'EU',
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
    railLabel: 'ASIA',
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
    railLabel: 'CMDTY',
    rows: [
      { symbols: ['BZ'], label: 'Brent Oil' },
      { symbols: ['CL'], label: 'WTI Oil' },
      { symbols: ['GC'], label: 'Gold' },
      { symbols: ['HG'], label: 'Copper' },
      { symbols: ['SI'], label: 'Silver' },
    ],
  },
  {
    id: 'rates',
    label: 'Rates',
    railLabel: 'RATES',
    rows: [
      { symbols: ['UST2Y'], label: 'UST 2Y' },
      { symbols: ['UST10Y'], label: 'UST 10Y' },
      { symbols: ['UST30Y'], label: 'UST 30Y' },
      { symbols: ['BUND10Y'], label: 'Bund 10Y' },
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

const aggregateDataStatuses = (statuses) => {
  const values = (Array.isArray(statuses) ? statuses : []).filter(Boolean);
  const usable = values.filter((status) => status !== 'unavailable');
  if (usable.length === 0) return 'unavailable';
  if (usable.length !== values.length || new Set(usable).size > 1) return 'mixed';
  return usable[0];
};

const getVolatilityRowStatus = (seriesName, row) => {
  const complete = Boolean(formatMarketMonthDay(row?.asOf))
    && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]));
  const historicalMove = seriesName === 'MOVE'
    && row?.availability === 'historical'
    && row?.freshness === 'historical'
    && row?.quoteMode === 'end-of-day'
    && complete;
  if (historicalMove) return 'historical';
  if (row?.availability !== 'available' || row?.freshness !== 'current' || !complete) {
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
  mixed: 'mixed',
  historical: 'as-of',
  unavailable: 'missing',
};

const formatStatusCounts = (statuses) => Object.entries(
  (Array.isArray(statuses) ? statuses : []).reduce((counts, status) => ({
    ...counts,
    [status]: (counts[status] || 0) + 1,
  }), {}),
)
  .map(([status, count]) => `${count} ${STATUS_COUNT_LABELS[status] || status}`)
  .join(' · ');

const formatIssue = (value) => {
  if (!value) return null;
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
  if (volatilityState?.loading) return 'loading';
  if (volatilityState?.error || !volatilityState?.snapshot) return 'unavailable';
  return aggregateDataStatuses(VOLATILITY_SERIES.map(({ name }) => (
    getVolatilityRowStatus(name, volatilityState.snapshot[name])
  )));
};

const getCorrelationStatus = (correlationState) => {
  if (correlationState?.loading) return 'loading';
  if (correlationState?.error || !correlationState?.correlations || !correlationState?.rollingStats) return 'unavailable';
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
  row?.availability === 'available'
  && row?.freshness === 'current'
  && Boolean(formatMarketMonthDay(row?.asOf))
  && VOLATILITY_CHART_POINTS.every(({ key }) => isFiniteNumber(row?.[key]))
);

const isHistoricalMoveRow = (seriesName, row) => (
  seriesName === 'MOVE'
  && row?.availability === 'historical'
  && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day'
  && Boolean(formatMarketMonthDay(row?.asOf))
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

const buildVolatilityChart = (
  row,
  width,
  height,
  seriesName = null,
) => buildVolatilityMetricChart(row, width, height, {
  available: isDisplayableVolatilityRow(seriesName, row),
  historical: isHistoricalMoveRow(seriesName, row),
});

const buildVolatilitySparkline = (row, width, height, seriesName = null) => (
  buildVolatilityMetricSparkline(row, width, height, {
    available: isDisplayableVolatilityRow(seriesName, row),
    historical: isHistoricalMoveRow(seriesName, row),
  })
);

const VolatilityMapPanel = ({ volatilityState, status }) => {
  const snapshot = volatilityState?.snapshot;
  const loading = Boolean(volatilityState?.loading);
  const error = volatilityState?.error;
  const hasSnapshot = snapshot && typeof snapshot === 'object';
  const seriesStatuses = VOLATILITY_SERIES.map(({ name }) => getVolatilityRowStatus(name, snapshot?.[name]));
  const missingSeries = VOLATILITY_SERIES
    .filter(({ name }) => getVolatilityRowStatus(name, snapshot?.[name]) === 'unavailable')
    .map(({ symbol }) => symbol);
  const availableSeriesCount = seriesStatuses.filter((seriesStatus) => seriesStatus !== 'unavailable').length;

  return (
    <section
      className="efr-panel efr-exceptions efr-vol-map"
      aria-label="Volatility · 3M Map"
      data-status={status}
    >
      <DataStatusChip
        status={status}
        detail={volatilityState?.lastUpdated ? formatSnapshotDate(volatilityState.lastUpdated) : undefined}
        context="Volatility"
        diagnostics={[
          { label: 'Coverage', value: `${availableSeriesCount}/${VOLATILITY_SERIES.length} series` },
          { label: 'Sources', value: formatStatusCounts(seriesStatuses) },
        ]}
        issues={[formatIssue(error), formatMissingIssue(missingSeries)]}
        className="efr-card-status efr-vol-map__status"
        compact
        indicatorOnly
      />

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
              <VolatilityMetricRow
                key={name}
                row={row}
                symbol={symbol}
                available={available}
                historical={historical}
                asOfLabel={asOfLabel}
                bucket={bucket}
                regimeLabel={regime?.label}
                regimeRange={formatVolatilityRange(regime)}
                resolveLevelBucket={(value) => getBucketForSeries(name, value)}
                ariaLabel={
                  available
                    ? historical
                      ? `${symbol} end-of-day volatility as of ${asOfLabel}`
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
    return (
      <td
        className={canRender ? getTone(value) : ''}
        title={isPeriod ? periodTitle : undefined}
      >
        {canRender ? formatChange(value) : '—'}
      </td>
    );
  };

  return (
    <tr>
      <td>{descriptor.label}</td>
      <td>{available ? formatLevel(row?.price, '', row?.symbol || descriptor.symbols[0]) : '—'}</td>
      {renderReturn(dayChange)}
      {renderReturn(row?.fifteenDayChangePct, true)}
      {renderReturn(row?.monthChangePct, true)}
      {renderReturn(row?.threeMonthChangePct, true)}
      {renderReturn(row?.sixMonthChangePct, true)}
    </tr>
  );
};

const MarketBackdrop = ({ marketData, marketDataLoading, marketDataError, providerStatus }) => {
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
  const overallStatus = marketDataLoading
    ? 'loading'
    : marketDataError
      ? 'unavailable'
      : aggregateQuoteStatus(displayedEntries.map((entry) => entry.row), providerStatus);

  return (
    <section className="efr-panel efr-backdrop" aria-label="Market Backdrop" data-status={overallStatus}>
      <div className="efr-backdrop__body">
        <DataStatusChip
          status={overallStatus}
          context="Market Backdrop"
          diagnostics={[
            { label: 'Coverage', value: `${availableCount}/${displayedEntries.length} markets` },
            { label: 'Sources', value: formatStatusCounts(displayedStatuses) },
          ]}
          issues={[
            formatIssue(marketDataError),
            formatMissingIssue(missingLabels),
            getProviderIssue(providerStatus),
          ]}
          className="efr-backdrop__status"
          compact
          indicatorOnly
        />
        {BACKDROP_GROUPS.map((group) => (
          <section className="efr-backdrop-group" key={group.id} aria-labelledby={`efr-backdrop-${group.id}`}>
            <h3 id={`efr-backdrop-${group.id}`} aria-label={group.label}>
              <span aria-hidden="true">{group.railLabel}</span>
            </h3>
            <table aria-label={`${group.label} market performance`}>
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Price</th>
                  <th>D</th>
                  <th>15D</th>
                  <th>1M</th>
                  <th>3M</th>
                  <th>6M</th>
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
        <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      </>
    );
  }

  const status = getRowQuoteStatus(row, providerStatus);
  const available = status !== 'unavailable';
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
      <td>{available ? formatLevel(row.price, 'FX', row.symbol) : '—'}</td>
      {renderReturn(dayChange)}
      {renderReturn(row.fifteenDayChangePct, true)}
      {renderReturn(row.monthChangePct, true)}
      {renderReturn(row.threeMonthChangePct, true)}
      {renderReturn(row.sixMonthChangePct, true)}
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
        <col className="usd-currency-spreadsheet__return-col" span={5} />
        <col className="usd-currency-spreadsheet__ticker-col" />
        <col className="usd-currency-spreadsheet__price-col" />
        <col className="usd-currency-spreadsheet__return-col" span={5} />
      </colgroup>
      <thead>
        <tr className="usd-currency-spreadsheet__groups">
          <th colSpan="7" scope="colgroup">Dollar &amp; Majors</th>
          <th colSpan="7" scope="colgroup">USD Crosses</th>
        </tr>
        <tr>
          <th>Ticker</th><th>Price</th><th>D</th><th>15D</th><th>1M</th><th>3M</th><th>6M</th>
          <th>Ticker</th><th>Price</th><th>D</th><th>15D</th><th>1M</th><th>3M</th><th>6M</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rowCount }, (_, index) => (
          <tr key={`${leftRows[index]?.symbol || 'blank'}-${rightRows[index]?.symbol || 'blank'}`}>
            <USDCurrencyCells row={leftRows[index]} providerStatus={providerStatus} />
            <USDCurrencyCells row={rightRows[index]} providerStatus={providerStatus} />
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
      <header className="usd-card-section__header">
        <h3 id="usd-card-currencies-title">Currencies · USD First</h3>
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
  correlationState = {},
}) => {
  const volatilityStatus = getVolatilityStatus(volatilityState);
  const correlationStatus = getCorrelationStatus(correlationState);
  const correlationAsOf = correlationState?.calculationDate || correlationState?.correlationsCalculationDate;
  const usdCurrencyRows = buildUsdCurrencyColumns(marketData?.currencies).flat();
  const usdCurrencyStatus = marketDataLoading && usdCurrencyRows.length === 0
    ? 'loading'
    : aggregateQuoteStatus(usdCurrencyRows, providerStatus);
  const usdCardStatus = combineCardStatuses(usdCurrencyStatus, correlationStatus);
  const correlationStatusLabel = correlationStatus === 'historical' && correlationAsOf
    ? `AS OF ${formatSnapshotDate(correlationAsOf)}`
    : correlationStatus.toUpperCase();
  const usdCardStatusDetail = `CURRENCIES ${usdCurrencyStatus.toUpperCase()} · CORRELATIONS ${correlationStatusLabel}`;
  const usdCurrencyStatuses = usdCurrencyRows.map((row) => getRowQuoteStatus(row, providerStatus));
  const usdMissingLabels = usdCurrencyRows
    .filter((row) => getRowQuoteStatus(row, providerStatus) === 'unavailable')
    .map((row) => row?.name || row?.symbol);
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
          <section
            className="efr-panel efr-analytics-card efr-analytics-card--correlations efr-analytics-card--usd"
            aria-label="USD"
            data-status={usdCardStatus}
          >
            <DataStatusChip
              status={usdCardStatus}
              label="USD DATA"
              detail={usdCardStatusDetail}
              context="USD Data"
              diagnostics={[
                { label: 'Currencies', value: formatStatusCounts(usdCurrencyStatuses) || usdCurrencyStatus },
                { label: 'Correlations', value: correlationStatusLabel },
              ]}
              issues={[
                formatIssue(marketDataError),
                correlationState?.error ? `Correlations: ${formatIssue(correlationState.error)}` : null,
                formatMissingIssue(usdMissingLabels),
                getProviderIssue(providerStatus),
              ]}
              className="efr-card-status efr-usd-card__status"
              compact
              indicatorOnly
            />
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
      </div>

      <RadarReferencePanels />

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
