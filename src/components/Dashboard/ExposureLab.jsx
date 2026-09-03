import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import PersistentSurface, { useSurfaceActivity } from '../common/PersistentSurface';
import ResourceDataStatusChip from './ResourceDataStatusChip';
import './ExposureLab.css';

const {
  SUPPORTED_COUNTRY_CODES,
  countryName,
} = require('../../constants/exposureLabGeography.cjs');

const TABS = [
  ['exposures', 'Exposure Matrix'],
  ['correlation', 'Correlation'],
  ['geography', 'Geography'],
  ['universe', 'Universe QA'],
  ['hedge', 'Hedge Lab'],
];

const CORRELATION_WINDOWS = [30, 90, 180];
const LIVE_PORTFOLIO_RETRY_DELAYS_MS = [1500, 4000];
const UNIVERSE_PAGE_SIZE = 100;
const EMPTY_ROWS = Object.freeze([]);
const INSTRUMENT_TYPES = ['STK', 'ETF', 'FUND', 'IND', 'FUT', 'FX', 'CRYPTO', 'CASH', 'OTHER'];
const GEOGRAPHY_INSTRUMENT_TYPES = new Set(['STK', 'ETF', 'FUND']);
const EXPOSURE_FIXED_COLUMNS_WIDTH = 220;
const EXPOSURE_MIN_FACTOR_WIDTH = 58;
const CORRELATION_LABEL_COLUMN_WIDTH = 100;
const CORRELATION_MIN_FACTOR_WIDTH = 46;
const CORRELATION_HEADER_HEIGHT = 24;
const CORRELATION_ROW_HEIGHT = 21;
const HEDGE_MIN_TABLE_WIDTH = 920;
const FACTOR_HEADER_LABELS = Object.freeze({
  'sector-communication': 'Comms',
  'sector-consumer-discretionary': 'Cons Disc',
  'sector-consumer-staples': 'Cons Stap',
  'sector-financials': 'Financial',
  'sector-health-care': 'Health',
  'sector-industrials': 'Industr.',
  'sector-technology': 'Tech',
  'sector-real-estate': 'Real Est',
  'style-size': 'Sm vs Lg',
  'style-beta': 'Hi vs Lo',
  'style-secular-growth': 'Sec Grth',
  'macro-commodities': 'Commods',
});

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, decimals = 1, suffix = '') {
  const parsed = finite(value);
  return parsed == null ? '—' : `${parsed.toFixed(decimals)}${suffix}`;
}

function formatSigned(value, decimals = 2, suffix = '') {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(decimals)}${suffix}`;
}

function formatCurrency(value) {
  const parsed = finite(value);
  return parsed == null
    ? '—'
    : parsed.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toISOString().slice(0, 10);
}

function requestMessage(error, fallback) {
  return error?.response?.data?.reason
    || error?.response?.data?.error
    || error?.message
    || fallback;
}

function heatStyle(value, scale = 8) {
  const parsed = finite(value);
  if (parsed == null || parsed === 0) return undefined;
  const alpha = Math.min(0.72, 0.1 + (Math.abs(parsed) / Math.max(scale, 0.01)) * 0.52);
  return {
    '--exposure-heat': parsed > 0
      ? `rgba(28, 120, 78, ${alpha})`
      : `rgba(188, 52, 47, ${alpha})`,
  };
}

function correlationHeatStyle(value) {
  const parsed = finite(value);
  if (parsed == null) return undefined;
  const alpha = Math.min(0.78, 0.08 + Math.abs(parsed) * 0.62);
  return {
    '--exposure-heat': parsed >= 0
      ? `rgba(188, 52, 47, ${alpha})`
      : `rgba(42, 91, 165, ${alpha})`,
  };
}

function SummaryCell({ label, value, detail }) {
  return (
    <div className="exposure-lab__summary-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function EmptyRow({ columns, children }) {
  return (
    <tr>
      <td className="exposure-lab__empty" colSpan={columns}>{children}</td>
    </tr>
  );
}

function positionSampleDisplay(position) {
  const sample = position?.sampleQuality || {};
  const observations = finite(sample.observations) ?? finite(position?.observations);
  if (observations == null) {
    return {
      label: '—',
      state: 'unknown',
      description: `${position?.symbol || 'Security'} sample size unavailable`,
    };
  }
  const tier = finite(sample.tier) ?? [30, 60, 90, 120]
    .filter((threshold) => observations >= threshold)
    .at(-1) ?? null;
  const complete = sample.complete === true || observations >= 120;
  const state = sample.state || (
    observations < 30 ? 'insufficient'
      : complete ? 'seasoned'
        : tier >= 90 ? 'moderate'
          : tier >= 60 ? 'building'
            : 'early'
  );
  const nextTier = finite(sample.nextTier) ?? (
    complete ? null : [30, 60, 90, 120].find((threshold) => threshold > observations) || 120
  );
  const remaining = finite(sample.observationsToNextTier) ?? (
    nextTier == null ? 0 : Math.max(0, nextTier - observations)
  );
  const label = tier == null ? '<30' : String(tier);
  const tierDescription = tier == null
    ? 'below the 30-return modeling floor'
    : `${tier}-return tier, ${complete ? 'seasoned' : 'preliminary'}`;
  const nextDescription = nextTier == null
    ? ''
    : `; ${remaining} more to the ${nextTier}-return tier`;
  return {
    label,
    state,
    description: `${position.symbol}: ${observations} aligned daily returns; ${tierDescription}${nextDescription}`,
  };
}

function factorHeaderLabel(factor) {
  return FACTOR_HEADER_LABELS[factor?.id] || factor?.label || factor?.id || '—';
}

function ExposureMatrix({ snapshot, benchmarkMode, cellMode }) {
  const factors = Array.isArray(snapshot?.factors) ? snapshot.factors : [];
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const exposureField = benchmarkMode === 'spy'
    ? 'spyRelativeExposurePct'
    : 'netExposurePct';
  const minimumTableWidth = EXPOSURE_FIXED_COLUMNS_WIDTH
    + factors.length * EXPOSURE_MIN_FACTOR_WIDTH;

  return (
    <div className="exposure-lab__matrix-wrap exposure-lab__matrix-wrap--main">
      <table
        className="exposure-lab__table exposure-lab__table--exposure"
        aria-label="Security factor exposure matrix"
        style={{ minWidth: `${minimumTableWidth}px` }}
      >
        <thead>
          <tr>
            <th>Symbol</th>
            <th title="Progressive aligned-return tier: 30 early, 60 building, 90 moderate, 120 seasoned">Sample</th>
            <th>Side</th>
            <th>% NAV</th>
            <th>R²</th>
            {factors.map((factor) => (
              <th key={factor.id} title={`${factor.family}: ${factor.formula}`}>
                {factorHeaderLabel(factor)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 && (
            <EmptyRow columns={5 + factors.length}>
              No modeled positions. {snapshot?.reason || 'A verified portfolio and adjusted history are required.'}
            </EmptyRow>
          )}
          {positions.map((position, positionIndex) => {
            const sample = positionSampleDisplay(position);
            return (
              <tr key={`${position.symbol}-${position.side}-${positionIndex}`}>
                <th scope="row" title={position.name}>{position.symbol}</th>
                <td
                  className={`exposure-lab__sample-cell exposure-lab__sample-cell--${sample.state}`}
                  title={sample.description}
                  aria-label={sample.description}
                >
                  {sample.label}
                </td>
                <td className={`exposure-lab__side exposure-lab__side--${position.side}`}>
                  {position.side}
                </td>
                <td className="exposure-lab__number">
                  {formatSigned(position.signedWeightPct, 2, '%')}
                </td>
                <td className="exposure-lab__number">
                  {formatNumber(
                    finite(position.rSquared) == null ? null : finite(position.rSquared) * 100,
                    0,
                    '%',
                  )}
                </td>
                {factors.map((factor) => {
                  const value = cellMode === 'loading'
                    ? position.loadings?.[factor.id]?.value
                    : position.contributions?.[factor.id];
                  return (
                    <td
                      key={factor.id}
                      className="exposure-lab__number exposure-lab__heat"
                      style={heatStyle(value, cellMode === 'loading' ? 1 : 5)}
                      title={`${position.symbol} · ${factor.label} · ${cellMode}`}
                    >
                      {formatSigned(value, cellMode === 'loading' ? 2 : 2, cellMode === 'loading' ? '' : '%')}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {factors.length > 0 && (
          <tfoot>
            <tr>
              <th scope="row">Portfolio</th>
              <td title="Security-level sample tiers are shown above">—</td>
              <td>{benchmarkMode === 'spy' ? 'vs SPY' : 'absolute'}</td>
              <td>{formatSigned(snapshot?.portfolio?.netExposurePct, 1, '%')}</td>
              <td>{formatNumber(snapshot?.coverage?.modeledGrossNavPct, 0, '%')}</td>
              {factors.map((factor) => {
                const value = factor[exposureField];
                return (
                  <td
                    key={factor.id}
                    className="exposure-lab__number exposure-lab__heat"
                    style={heatStyle(value, 12)}
                    title={`${factor.label}: ${factor.formula}`}
                  >
                    {formatSigned(value, 2, '%')}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function axisSearchMatch(axis, query) {
  const needle = String(query || '').trim().toUpperCase();
  if (!needle) return true;
  return [axis?.id, axis?.symbol, axis?.label, axis?.family]
    .some((value) => String(value || '').toUpperCase().includes(needle));
}

function selectCompactMatrix(matrix, rowIndices, columnIndices) {
  if (!matrix) return null;
  const pick = (rows, emptyValue) => rowIndices.map((rowIndex) => (
    columnIndices.map((columnIndex) => rows?.[rowIndex]?.[columnIndex] ?? emptyValue)
  ));
  return {
    ...matrix,
    values: pick(matrix.values, null),
    rawValues: pick(matrix.rawValues, null),
    observations: pick(matrix.observations, 0),
    reasons: pick(matrix.reasons, 'unavailable'),
  };
}

function compactAxisLabel(axis, column = false) {
  if (axis?.symbol) return axis.symbol;
  if (column) return factorHeaderLabel(axis);
  return axis?.label || axis?.id || '—';
}

function CorrelationMatrix({ matrix, rowAxis, columnAxis, label }) {
  const minimumTableWidth = CORRELATION_LABEL_COLUMN_WIDTH
    + columnAxis.length * CORRELATION_MIN_FACTOR_WIDTH;
  const minimumTableHeight = CORRELATION_HEADER_HEIGHT
    + Math.max(1, rowAxis.length) * CORRELATION_ROW_HEIGHT;
  return (
    <div className="exposure-lab__matrix-wrap exposure-lab__matrix-wrap--correlation">
      <table
        className="exposure-lab__table exposure-lab__table--correlation"
        aria-label={label}
        style={{ minWidth: `${minimumTableWidth}px`, minHeight: `${minimumTableHeight}px` }}
      >
        <thead>
          <tr>
            <th>Risk</th>
            {columnAxis.map((axis) => (
              <th key={axis.id} title={[axis.label, axis.formula, axis.symbol].filter(Boolean).join(' · ')}>
                {compactAxisLabel(axis, true)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowAxis.length === 0 && <EmptyRow columns={Math.max(1, columnAxis.length + 1)}>Matrix unavailable.</EmptyRow>}
          {rowAxis.map((row, rowIndex) => (
            <tr key={row.id}>
              <th scope="row" title={[row.label, row.side, row.formula].filter(Boolean).join(' · ')}>
                {compactAxisLabel(row)}
              </th>
              {columnAxis.map((column, columnIndex) => {
                const value = matrix?.values?.[rowIndex]?.[columnIndex];
                const rawValue = matrix?.rawValues?.[rowIndex]?.[columnIndex];
                const observations = matrix?.observations?.[rowIndex]?.[columnIndex] ?? 0;
                const reason = matrix?.reasons?.[rowIndex]?.[columnIndex];
                const reasonText = reason ? ` · ${String(reason).replaceAll('_', ' ')}` : '';
                return (
                  <td
                    key={column.id}
                    className="exposure-lab__number exposure-lab__heat"
                    style={correlationHeatStyle(value)}
                    title={`${row.label || row.id} × ${column.label || column.id} · P&L ${formatNumber(value, 3)} · raw ${formatNumber(rawValue, 3)} · ${observations} observations${reasonText}`}
                  >
                    {formatNumber(value, 2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PairRiskTable({ title, pairs, tone }) {
  return (
    <div className={`exposure-lab__pair-panel exposure-lab__pair-panel--${tone}`}>
      <div className="exposure-lab__section-label">{title}</div>
      <div className="exposure-lab__matrix-wrap exposure-lab__matrix-wrap--bounded">
        <table className="exposure-lab__table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>P&amp;L corr</th>
              <th>Raw corr</th>
              <th>Annualized pair risk</th>
              <th>Obs</th>
            </tr>
          </thead>
          <tbody>
            {pairs.length === 0 && <EmptyRow columns={5}>No qualified pairs.</EmptyRow>}
            {pairs.slice(0, 10).map((pair) => (
              <tr key={`${pair.left?.symbol}-${pair.right?.symbol}`}>
                <th scope="row">{pair.left?.symbol} / {pair.right?.symbol}</th>
                <td className="exposure-lab__number exposure-lab__heat" style={correlationHeatStyle(pair.pnlCorrelation)}>
                  {formatNumber(pair.pnlCorrelation, 2)}
                </td>
                <td className="exposure-lab__number">{formatNumber(pair.rawCorrelation, 2)}</td>
                <td className="exposure-lab__number">{formatSigned(pair.annualizedVarianceContributionPct2, 3, ' %²')}</td>
                <td className="exposure-lab__number">{pair.observations ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CorrelationLab({ snapshot, modeKey, window, scope, query }) {
  const correlation = snapshot?.correlation;
  const mode = correlation?.modes?.[modeKey];
  const matrix = mode?.matrices?.[String(window)];
  const allRows = Array.isArray(mode?.rowAxis) ? mode.rowAxis : [];
  const allColumns = Array.isArray(mode?.columnAxis) ? mode.columnAxis : [];
  let rowIndices = allRows.map((_, index) => index);
  let columnIndices = allColumns.map((_, index) => index);
  if (modeKey !== 'factorFactor') {
    rowIndices = rowIndices.filter((index) => axisSearchMatch(allRows[index], query));
    if (scope === 'top20') rowIndices = rowIndices.slice(0, 20);
    if (modeKey === 'positionPosition') columnIndices = [...rowIndices];
  }
  const rowAxis = rowIndices.map((index) => allRows[index]);
  const columnAxis = columnIndices.map((index) => allColumns[index]);
  const selected = selectCompactMatrix(matrix, rowIndices, columnIndices);
  const pairs = correlation?.pairs || {};
  return (
    <div className="exposure-lab__stacked-tables">
      <div className="exposure-lab__legend-line">
        <span><i className="is-common-risk" /> RED = positive P&amp;L co-movement / common risk</span>
        <span><i className="is-offset" /> BLUE = offsetting P&amp;L co-movement</span>
        <span>{matrix?.minimumObservations || '—'} aligned observations required</span>
      </div>
      <CorrelationMatrix
        matrix={selected}
        rowAxis={rowAxis}
        columnAxis={columnAxis}
        label={`${mode?.label || 'Correlation'} ${window}-session matrix`}
      />
      {modeKey === 'positionPosition' && (
        <div className="exposure-lab__pair-grid">
          <PairRiskTable title="Largest common-risk pairs" pairs={pairs.commonRisk || []} tone="common" />
          <PairRiskTable title="Largest offsetting pairs" pairs={pairs.offsets || []} tone="offset" />
        </div>
      )}
      <div className="exposure-lab__footnote">
        Position cells are sign-adjusted to P&amp;L; hover for raw asset correlation. Pair risk uses current NAV weights,
        annualized covariance, and {formatNumber((pairs.shrinkage ?? 0.2) * 100, 0, '%')} off-diagonal shrinkage. No transitive clusters are inferred.
      </div>
    </div>
  );
}

function GeographyAllocation({ snapshot, level }) {
  const allocation = snapshot?.geography?.allocation;
  const matrix = allocation?.[level] || {};
  const rowAxis = Array.isArray(matrix.rowAxis) ? matrix.rowAxis : [];
  const columnAxis = Array.isArray(matrix.columnAxis) ? matrix.columnAxis : [];
  const positions = Array.isArray(allocation?.positions) ? allocation.positions : [];
  return (
    <div className="exposure-lab__stacked-tables">
      <div className="exposure-lab__coverage-line">
        <strong>AUDITED ALLOCATION · {allocation?.status?.toUpperCase?.() || 'UNAVAILABLE'}</strong>
        <span>{formatNumber(allocation?.coverage?.knownGrossCoveragePct, 1, '%')} of gross position NAV classified</span>
        <span>Unknown {formatNumber(allocation?.coverage?.unknownGrossNavPct, 1, '%')} NAV</span>
        {allocation?.reason && <span>{String(allocation.reason).replaceAll('_', ' ')}</span>}
      </div>
      <div className="exposure-lab__matrix-wrap exposure-lab__matrix-wrap--bounded">
        <table className="exposure-lab__table" aria-label={`${level} geography allocation`}>
          <thead>
            <tr>
              <th>{level === 'country' ? 'Country' : 'Region'}</th>
              {columnAxis.map((column) => <th key={column.id}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rowAxis.length === 0 && <EmptyRow columns={5}>Audited geography unavailable.</EmptyRow>}
            {rowAxis.map((axis, rowIndex) => (
              <tr key={axis.id}>
                <th scope="row" title={[axis.countryCode, axis.region].filter(Boolean).join(' · ')}>{axis.label}</th>
                {columnAxis.map((column, columnIndex) => {
                  const value = matrix.values?.[rowIndex]?.[columnIndex];
                  return (
                    <td
                      key={column.id}
                      className="exposure-lab__number exposure-lab__heat"
                      style={heatStyle(value, 25)}
                      title={`${axis.label} · ${column.label} · ${formatSigned(value, 3, '%')}`}
                    >
                      {column.id === 'gross' ? formatNumber(value, 2, '%') : formatSigned(value, 2, '%')}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="exposure-lab__section-label">Position allocation audit</div>
      <div className="exposure-lab__matrix-wrap exposure-lab__matrix-wrap--bounded">
        <table className="exposure-lab__table exposure-lab__table--geography-audit">
          <thead>
            <tr><th>Position</th><th>Gross NAV</th><th>Basis</th><th>Allocation</th><th>Source</th><th>As of</th><th>Status</th></tr>
          </thead>
          <tbody>
            {positions.length === 0 && <EmptyRow columns={7}>No eligible live positions.</EmptyRow>}
            {positions.map((position) => (
              <tr key={position.symbol}>
                <th scope="row">{position.symbol}</th>
                <td className="exposure-lab__number">{formatNumber(position.grossWeightPct, 2, '%')}</td>
                <td>{position.basis || '—'}</td>
                <td>{(position.allocations || []).map((row) => `${row.countryCode} ${formatNumber(row.weightPct, 1, '%')}`).join(' · ')}</td>
                <td>{position.sourceUrl ? <a href={position.sourceUrl} target="_blank" rel="noreferrer">{position.sourceName}</a> : position.sourceName || '—'}</td>
                <td>{position.sourceAsOf || '—'}</td>
                <td title={position.reason || ''}>{position.available ? 'reviewed' : `Unknown · ${String(position.reason || 'unavailable').replaceAll('_', ' ')}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="exposure-lab__footnote">
        Country of risk and audited fund allocations only. Listing exchange, ticker suffix, and trading currency are never used as geography.
      </div>
    </div>
  );
}

function GeographySensitivity({ snapshot, window, scope, query }) {
  const sensitivity = snapshot?.geography?.sensitivity;
  const matrix = sensitivity?.matrices?.[String(window)];
  const allRows = Array.isArray(sensitivity?.rowAxis) ? sensitivity.rowAxis : [];
  const columns = Array.isArray(sensitivity?.columnAxis) ? sensitivity.columnAxis : [];
  const portfolioIndex = allRows.findIndex((row) => row.id === 'portfolio');
  let positionIndices = allRows.map((_, index) => index)
    .filter((index) => index !== portfolioIndex && axisSearchMatch(allRows[index], query));
  if (scope === 'top20') positionIndices = positionIndices.slice(0, 20);
  const rowIndices = [...(portfolioIndex >= 0 ? [portfolioIndex] : []), ...positionIndices];
  const columnIndices = columns.map((_, index) => index);
  const coverage = sensitivity?.coverageByWindow?.[String(window)];
  return (
    <div className="exposure-lab__stacked-tables">
      <div className="exposure-lab__coverage-line">
        <strong>OVERLAPPING MARKET SENSITIVITIES · NON-ADDITIVE</strong>
        <span>ACWI de-marketed</span>
        <span>{formatNumber(coverage?.modeledGrossCoveragePct, 1, '%')} modeled gross-NAV coverage</span>
        <span>{coverage?.portfolioObservations ?? 0} portfolio observations</span>
      </div>
      <CorrelationMatrix
        matrix={selectCompactMatrix(matrix, rowIndices, columnIndices)}
        rowAxis={rowIndices.map((index) => allRows[index])}
        columnAxis={columns}
        label={`${window}-session de-marketed geography sensitivity matrix`}
      />
      <div className="exposure-lab__footnote">
        These diagnostics overlap. They are not additive country allocation, domicile, or revenue exposure. Both each position and each proxy are residualized against ACWI before Pearson correlation; position rows are sign-adjusted to P&amp;L.
      </div>
    </div>
  );
}

function defaultGeographyReview(instrumentType, existing = null) {
  if (!GEOGRAPHY_INSTRUMENT_TYPES.has(instrumentType)) return null;
  const singleCountry = instrumentType === 'STK';
  const existingAllocations = Array.isArray(existing?.allocations) && existing.allocations.length > 0
    ? existing.allocations.map((row) => ({ ...row }))
    : [{ countryCode: '', weightPct: 100 }];
  return {
    basis: singleCountry ? 'country_of_risk' : (
      ['single_country_mandate', 'holdings_lookthrough'].includes(existing?.basis)
        ? existing.basis
        : 'single_country_mandate'
    ),
    allocations: singleCountry
      ? [{ countryCode: existingAllocations[0]?.countryCode || '', weightPct: 100 }]
      : existingAllocations,
    sourceName: existing?.sourceName || '',
    sourceAsOf: existing?.sourceAsOf || '',
    sourceUrl: existing?.sourceUrl || '',
  };
}

function geographyAllocationSummary(geography) {
  if (!geography?.basis || !Array.isArray(geography.allocations)) return 'Unknown';
  return geography.allocations
    .map((row) => `${row.countryCode} ${formatNumber(row.weightPct, 1, '%')}`)
    .join(' · ') || 'Unknown';
}

function UniverseQa({ universe, query, stateFilter, page, setPage, onReviewSaved }) {
  const rows = Array.isArray(universe?.rows) ? universe.rows : EMPTY_ROWS;
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [reviewDraft, setReviewDraft] = useState(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewMessage, setReviewMessage] = useState(null);
  const filteredRows = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return rows.filter((row) => {
      const ticker = String(row.ticker || '').trim().toUpperCase();
      return (!needle || ticker.startsWith(needle))
        && (stateFilter === 'all' || row.discoveryState === stateFilter);
    });
  }, [query, rows, stateFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / UNIVERSE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = filteredRows.slice(
    safePage * UNIVERSE_PAGE_SIZE,
    (safePage + 1) * UNIVERSE_PAGE_SIZE,
  );

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage, setPage]);

  const selectedRow = rows.find((row) => row.ticker === selectedTicker) || null;
  const openReview = (row) => {
    setSelectedTicker(row.ticker);
    setReviewDraft({
      identityStatus: row.identityStatus || 'unverified',
      canonicalSymbol: row.canonicalSymbol || row.ticker,
      displayName: row.displayName || row.name || '',
      instrumentType: row.instrumentType || 'STK',
      providerSymbols: row.providerSymbols || {},
      geography: row.geography ? defaultGeographyReview(row.instrumentType || 'STK', row.geography) : null,
      analysisEligible: row.analysisEligible === true,
      hedgeEligible: row.hedgeEligible === true,
      reviewedBy: row.reviewedBy || '',
      reviewReason: '',
      expectedVersion: row.version || 0,
    });
    setReviewMessage(null);
  };

  const securityMasterAvailable = universe?.securityMaster?.status === 'available';
  const setDraftField = (field, value) => {
    setReviewDraft((current) => {
      if (field === 'identityStatus' && value !== 'verified') {
        return {
          ...current,
          identityStatus: value,
          geography: null,
          analysisEligible: false,
          hedgeEligible: false,
        };
      }
      if (field === 'instrumentType') {
        return {
          ...current,
          instrumentType: value,
          geography: current.geography
            ? defaultGeographyReview(value, current.geography)
            : null,
        };
      }
      return { ...current, [field]: value };
    });
  };
  const setGeographyField = (field, value) => {
    setReviewDraft((current) => ({
      ...current,
      geography: current.geography ? { ...current.geography, [field]: value } : null,
    }));
  };
  const setAllocationField = (index, field, value) => {
    setReviewDraft((current) => ({
      ...current,
      geography: current.geography ? {
        ...current.geography,
        allocations: current.geography.allocations.map((row, rowIndex) => (
          rowIndex === index ? { ...row, [field]: value } : row
        )),
      } : null,
    }));
  };
  const setGeographyBasis = (basis) => {
    setReviewDraft((current) => {
      if (!current.geography) return current;
      const allocations = basis === 'single_country_mandate'
        ? [{
          countryCode: current.geography.allocations?.[0]?.countryCode || '',
          weightPct: 100,
        }]
        : current.geography.allocations;
      return { ...current, geography: { ...current.geography, basis, allocations } };
    });
  };
  const addAllocation = () => setReviewDraft((current) => ({
    ...current,
    geography: current.geography ? {
      ...current.geography,
      allocations: [...current.geography.allocations, { countryCode: '', weightPct: 0 }],
    } : null,
  }));
  const removeAllocation = (index) => setReviewDraft((current) => ({
    ...current,
    geography: current.geography ? {
      ...current.geography,
      allocations: current.geography.allocations.filter((_, rowIndex) => rowIndex !== index),
    } : null,
  }));
  const saveReview = async () => {
    if (!selectedRow || !reviewDraft || !securityMasterAvailable || reviewSaving) return;
    setReviewSaving(true);
    setReviewMessage(null);
    try {
      const result = await MarketDataService.saveExposureLabSecurityReview(
        selectedRow.ticker,
        reviewDraft,
      );
      onReviewSaved?.(result.review);
      setReviewMessage(`SAVED VERSION ${result.review?.version || '—'} · AUDIT RECORDED`);
      setReviewDraft((current) => ({
        ...current,
        expectedVersion: result.review?.version || current.expectedVersion,
        reviewReason: '',
      }));
    } catch (error) {
      setReviewMessage(`SAVE FAILED · ${requestMessage(error, 'security review unavailable')}`);
    } finally {
      setReviewSaving(false);
    }
  };
  const geographySupported = reviewDraft?.identityStatus === 'verified'
    && GEOGRAPHY_INSTRUMENT_TYPES.has(reviewDraft?.instrumentType);
  const geographyWeightTotal = (reviewDraft?.geography?.allocations || [])
    .reduce((sum, row) => sum + (finite(row.weightPct) || 0), 0);

  return (
    <div className="exposure-lab__stacked-tables">
      <div className="exposure-lab__universe-meta">
        <span>ROWS {filteredRows.length.toLocaleString()} / {rows.length.toLocaleString()}</span>
        <span>SNAPSHOTS {universe?.meta?.snapshotCount?.toLocaleString?.() || '—'}</span>
        <span>RISK-RANGE ROWS {universe?.meta?.riskRangeRowCount?.toLocaleString?.() || '—'}</span>
        <span>LATEST {universe?.meta?.latestSourceDate || '—'}</span>
        <span>NAMES {universe?.meta?.resolvedNameCount?.toLocaleString?.() || 0} / {rows.length.toLocaleString()}</span>
        <span>DIRECTORY {universe?.identityDirectory?.status?.toUpperCase?.() || 'UNAVAILABLE'}</span>
        <span>REVIEWED {universe?.meta?.reviewedCount || 0}</span>
        <span>MASTER {universe?.securityMaster?.status?.toUpperCase?.() || 'UNAVAILABLE'}</span>
      </div>
      {selectedRow && reviewDraft && (
        <div className="exposure-lab__review-panel" aria-label={`Review ${selectedRow.ticker}`}>
          <div className="exposure-lab__review-bar">
            <strong>REVIEW {selectedRow.ticker}</strong>
            <label>
              Identity
              <select
                value={reviewDraft.identityStatus}
                onChange={(event) => setDraftField('identityStatus', event.target.value)}
              >
                <option value="unverified">unverified</option>
                <option value="verified">verified</option>
                <option value="rejected">rejected token</option>
              </select>
            </label>
            <label>
              Canonical
              <input value={reviewDraft.canonicalSymbol} onChange={(event) => setDraftField('canonicalSymbol', event.target.value.toUpperCase())} />
            </label>
            <label>
              Name
              <input value={reviewDraft.displayName} onChange={(event) => setDraftField('displayName', event.target.value)} />
            </label>
            <label>
              Type
              <select value={reviewDraft.instrumentType} onChange={(event) => setDraftField('instrumentType', event.target.value)}>
                {INSTRUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
            <label className="exposure-lab__review-check">
              <input
                type="checkbox"
                checked={reviewDraft.analysisEligible}
                onChange={(event) => setDraftField('analysisEligible', event.target.checked)}
              />
              Analysis
            </label>
            <label className="exposure-lab__review-check">
              <input
                type="checkbox"
                checked={reviewDraft.hedgeEligible}
                onChange={(event) => setDraftField('hedgeEligible', event.target.checked)}
              />
              Hedge
            </label>
            <label>
              Reviewer
              <input value={reviewDraft.reviewedBy} onChange={(event) => setDraftField('reviewedBy', event.target.value)} placeholder="required" />
            </label>
            <label className="exposure-lab__review-reason">
              Reason
              <input value={reviewDraft.reviewReason} onChange={(event) => setDraftField('reviewReason', event.target.value)} placeholder="required audit reason" />
            </label>
            <button type="button" onClick={saveReview} disabled={!securityMasterAvailable || reviewSaving}>
              {reviewSaving ? 'Saving…' : 'Save review'}
            </button>
            <button type="button" onClick={() => setSelectedTicker(null)}>Close</button>
            <span>{securityMasterAvailable ? reviewMessage : `MASTER UNAVAILABLE · ${universe?.securityMaster?.reason || 'not deployed'}`}</span>
          </div>
          <div className="exposure-lab__geography-editor">
            <label className="exposure-lab__review-check">
              <input
                type="checkbox"
                checked={reviewDraft.geography != null}
                disabled={!geographySupported}
                onChange={(event) => setDraftField(
                  'geography',
                  event.target.checked ? defaultGeographyReview(reviewDraft.instrumentType) : null,
                )}
              />
              Audited geography
            </label>
            {!geographySupported && <span>Verify a STK, ETF, or FUND identity to review geography.</span>}
            {reviewDraft.geography && (
              <>
                <label>
                  Basis
                  {reviewDraft.instrumentType === 'STK' ? (
                    <input value="country_of_risk" readOnly />
                  ) : (
                    <select value={reviewDraft.geography.basis} onChange={(event) => setGeographyBasis(event.target.value)}>
                      <option value="single_country_mandate">single-country mandate</option>
                      <option value="holdings_lookthrough">holdings look-through</option>
                    </select>
                  )}
                </label>
                <div className="exposure-lab__country-weights">
                  {(reviewDraft.geography.allocations || []).map((allocation, index) => (
                    <div key={`${index}-${allocation.countryCode}`} className="exposure-lab__country-weight">
                      <select
                        aria-label={`Country ${index + 1}`}
                        value={allocation.countryCode}
                        onChange={(event) => setAllocationField(index, 'countryCode', event.target.value)}
                      >
                        <option value="">Select ISO country</option>
                        {SUPPORTED_COUNTRY_CODES.map((code) => (
                          <option key={code} value={code}>{code} · {countryName(code)}</option>
                        ))}
                      </select>
                      <input
                        aria-label={`Country weight ${index + 1}`}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={allocation.weightPct}
                        readOnly={reviewDraft.geography.basis !== 'holdings_lookthrough'}
                        onChange={(event) => setAllocationField(index, 'weightPct', event.target.value)}
                      />
                      <span>%</span>
                      {reviewDraft.geography.basis === 'holdings_lookthrough' && reviewDraft.geography.allocations.length > 1 && (
                        <button type="button" onClick={() => removeAllocation(index)}>Remove</button>
                      )}
                    </div>
                  ))}
                  {reviewDraft.geography.basis === 'holdings_lookthrough' && (
                    <button type="button" onClick={addAllocation}>Add country</button>
                  )}
                  <strong className={Math.abs(geographyWeightTotal - 100) <= 0.01 ? 'is-valid' : 'is-invalid'}>
                    TOTAL {formatNumber(geographyWeightTotal, 2, '%')}
                  </strong>
                </div>
                <label>
                  Source
                  <input value={reviewDraft.geography.sourceName} onChange={(event) => setGeographyField('sourceName', event.target.value)} placeholder="issuer filing or fund holdings" />
                </label>
                <label>
                  Source as of
                  <input type="date" value={reviewDraft.geography.sourceAsOf} onChange={(event) => setGeographyField('sourceAsOf', event.target.value)} />
                </label>
                <label className="exposure-lab__review-source-url">
                  Source URL
                  <input type="url" value={reviewDraft.geography.sourceUrl} onChange={(event) => setGeographyField('sourceUrl', event.target.value)} placeholder="optional https://…" />
                </label>
              </>
            )}
          </div>
        </div>
      )}
      <div className="exposure-lab__matrix-wrap">
        <table className="exposure-lab__table exposure-lab__table--universe">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Security name</th>
              <th>Discovery</th>
              <th>Confidence</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Mentions</th>
              <th>Pulls</th>
              <th>Products</th>
              <th>Current catalog</th>
              <th>Identity</th>
              <th>Analysis</th>
              <th>Geography</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && <EmptyRow columns={14}>No matching archive mentions.</EmptyRow>}
            {visibleRows.map((row) => (
              <tr key={row.ticker} className={selectedTicker === row.ticker ? 'is-selected' : ''}>
                <th scope="row">{row.ticker}</th>
                <td title={row.name ? `${row.name}${row.nameSource ? ` · ${row.nameSource}` : ''}` : 'No exact security-directory identity'}>
                  {row.name || '—'}
                </td>
                <td>{row.discoveryState}</td>
                <td>{row.confidence}</td>
                <td>{row.firstSeen || '—'}</td>
                <td>{row.lastSeen || '—'}</td>
                <td className="exposure-lab__number">{row.mentionCount}</td>
                <td className="exposure-lab__number">{row.pullCount}</td>
                <td title={(row.products || []).map((item) => item.product).join(', ')}>
                  {(row.products || []).map((item) => item.product).join(', ') || '—'}
                </td>
                <td>{row.existingUniverse ? 'yes' : 'no'}</td>
                <td>{row.identityStatus}</td>
                <td>{row.analysisEligible ? 'eligible' : 'blocked'}</td>
                <td title={row.geography?.sourceName || 'No audited geography'}>
                  {geographyAllocationSummary(row.geography)}
                </td>
                <td>
                  <button type="button" onClick={() => openReview(row)}>
                    {row.reviewStatus === 'reviewed' ? `v${row.version}` : 'review'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="exposure-lab__pager">
        <button type="button" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>Prev</button>
        <span>Page {safePage + 1} / {pageCount}</span>
        <button type="button" onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1}>Next</button>
      </div>
    </div>
  );
}

function HedgeLab({ snapshot }) {
  const scenarios = snapshot?.hedgeScenarios || {};
  const rows = Array.isArray(scenarios.rows) ? scenarios.rows : [];
  const blockers = scenarios.blockers || ['risk_snapshot_unavailable'];
  const minimumTableHeight = CORRELATION_HEADER_HEIGHT
    + Math.max(1, rows.length) * CORRELATION_ROW_HEIGHT;
  return (
    <div className="exposure-lab__stacked-tables">
      <div className={`exposure-lab__gate-line ${scenarios.available ? 'is-available' : ''}`}>
        <strong>SCENARIO PREVIEW: {scenarios.available ? 'AVAILABLE' : 'BLOCKED'}</strong>
        <span>{blockers.join(' · ') || 'reviewed instruments + live marks verified'}</span>
        <span>No order preview, staging, share conversion, or submission is performed.</span>
      </div>
      <div className="exposure-lab__matrix-wrap">
        <table
          className="exposure-lab__table exposure-lab__table--hedge"
          aria-label="Factor hedge scenario matrix"
          style={{
            minWidth: `${HEDGE_MIN_TABLE_WIDTH}px`,
            minHeight: `${minimumTableHeight}px`,
          }}
        >
          <thead>
            <tr>
              <th>Factor</th>
              <th>Family</th>
              <th>Proxy formula</th>
              <th>Current exposure</th>
              <th>Required change</th>
              <th>Total-risk contribution</th>
              <th>First-order legs</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow columns={8}>Factor scenario snapshot unavailable.</EmptyRow>}
            {rows.map((row) => (
              <tr key={row.factorId}>
                <th scope="row">{row.factor}</th>
                <td>{row.family}</td>
                <td>{row.formula}</td>
                <td className="exposure-lab__number">{formatSigned(row.currentExposurePct, 2, '%')}</td>
                <td className="exposure-lab__number">{formatSigned(row.requiredFactorChangePct, 2, '%')}</td>
                <td className="exposure-lab__number">{formatSigned(row.contributionToTotalRiskPct, 2, '%')}</td>
                <td>
                  {(row.legs || []).map((leg) => (
                    leg.action
                      ? `${leg.action} ${leg.symbol} ${formatCurrency(leg.notional)}`
                      : leg.symbol
                  )).join(' · ') || '—'}
                </td>
                <td title={(row.blockers || []).join(', ')}>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ExposureLab({
  portfolioData,
  isLoading = false,
  isRefreshing = false,
  connection,
  onRefresh,
  onClose,
}) {
  const active = useSurfaceActivity();
  const [activeTab, setActiveTab] = useState('exposures');
  const [benchmarkMode, setBenchmarkMode] = useState('absolute');
  const [cellMode, setCellMode] = useState('contribution');
  const [correlationWindow, setCorrelationWindow] = useState(90);
  const [correlationMode, setCorrelationMode] = useState('positionPosition');
  const [correlationScope, setCorrelationScope] = useState('top20');
  const [correlationQuery, setCorrelationQuery] = useState('');
  const [geographyMode, setGeographyMode] = useState('allocation');
  const [geographyLevel, setGeographyLevel] = useState('region');
  const [geographyScope, setGeographyScope] = useState('top20');
  const [geographyQuery, setGeographyQuery] = useState('');
  const [universeQuery, setUniverseQuery] = useState('');
  const [universeState, setUniverseState] = useState('all');
  const [universePage, setUniversePage] = useState(0);
  const [universeView, setUniverseView] = useState(null);
  const forceSnapshotRefreshRef = useRef(false);
  const forceUniverseRefreshRef = useRef(false);
  const snapshotRetryCountRef = useRef(0);

  const accountId = portfolioData?.accountId
    || portfolioData?.holdings?.find((holding) => holding?.accountId)?.accountId
    || null;
  const livePortfolioInput = (
    portfolioData?.dataSource === 'ibkr_api'
    && portfolioData?.liveSessionVerified === true
    && portfolioData?.fromCache === false
  );
  const loadSnapshot = useCallback(async () => {
    const forceRefresh = forceSnapshotRefreshRef.current;
    forceSnapshotRefreshRef.current = false;
    try {
      const value = await MarketDataService.getExposureLabSnapshot({
        account: accountId,
        forceRefresh,
      });
      return {
        ...value,
        resourceObservedAt: new Date().toISOString(),
      };
    } catch (error) {
      const reason = error?.response?.data?.reason;
      if (reason === 'live_portfolio_unverified') {
        throw Object.assign(
          new Error('Waiting for a fresh socket-verified IBKR portfolio; retrying automatically'),
          {
            code: 'EXPOSURE_LAB_LIVE_PORTFOLIO_UNVERIFIED',
            liveInvalidation: true,
            response: error.response,
          },
        );
      }
      throw error;
    }
  }, [accountId]);

  const snapshotResource = useDashboardResource('exposure-lab-snapshot', {
    accountId,
    portfolioScope: livePortfolioInput ? 'socket-verified' : 'unverified',
  }, {
    fetcher: loadSnapshot,
    validate: (value) => (
      value && typeof value === 'object' && value.resourceObservedAt ? value : null
    ),
    getObservedAt: (value) => value.resourceObservedAt,
    maxAgeMs: 5 * 60 * 1000,
    active,
    refreshOnActivate: false,
    invalidateOnScopeChange: true,
    isExplicitInvalidation: (error) => (
      error?.code === 'EXPOSURE_LAB_LIVE_PORTFOLIO_UNVERIFIED'
    ),
  });

  const loadUniverse = useCallback(async () => {
    const forceRefresh = forceUniverseRefreshRef.current;
    forceUniverseRefreshRef.current = false;
    const value = await MarketDataService.getExposureLabUniverse({ forceRefresh });
    return {
      ...value,
      resourceObservedAt: value?.asOf
        || value?.generatedAt
        || value?.meta?.generatedAt
        || new Date().toISOString(),
    };
  }, []);
  const universeResource = useDashboardResource('exposure-lab-universe', {}, {
    fetcher: loadUniverse,
    validate: (value) => (
      value && typeof value === 'object' && Array.isArray(value.rows) ? value : null
    ),
    getObservedAt: (value) => value.resourceObservedAt,
    active,
    refreshOnActivate: false,
  });

  useEffect(() => {
    if (universeResource.data) setUniverseView(universeResource.data);
  }, [universeResource.data]);

  useEffect(() => {
    if (snapshotResource.data) {
      snapshotRetryCountRef.current = 0;
      return undefined;
    }
    if (
      !active
      || snapshotResource.error?.code !== 'EXPOSURE_LAB_LIVE_PORTFOLIO_UNVERIFIED'
    ) return undefined;
    const delay = LIVE_PORTFOLIO_RETRY_DELAYS_MS[snapshotRetryCountRef.current];
    if (delay == null) return undefined;
    snapshotRetryCountRef.current += 1;
    const timer = setTimeout(snapshotResource.refresh, delay);
    return () => clearTimeout(timer);
  }, [
    active,
    snapshotResource.data,
    snapshotResource.error?.code,
    snapshotResource.refresh,
  ]);

  const snapshot = snapshotResource.data || snapshotResource.referenceData;
  const universe = universeView || universeResource.data;
  const snapshotError = snapshotResource.error
    ? snapshotResource.error.code === 'EXPOSURE_LAB_LIVE_PORTFOLIO_UNVERIFIED'
      ? snapshotResource.error.message
      : requestMessage(snapshotResource.error, 'Exposure Lab snapshot unavailable')
    : null;
  const universeError = universeResource.error
    ? requestMessage(universeResource.error, 'Universe archive unavailable')
    : null;
  const loading = Boolean(
    (snapshotResource.initialLoading && !snapshot)
    || (universeResource.initialLoading && !universe)
    || snapshotResource.refreshing
    || universeResource.refreshing
  );

  const handleRefresh = () => {
    if (loading || isRefreshing) return;
    forceSnapshotRefreshRef.current = true;
    forceUniverseRefreshRef.current = true;
    snapshotResource.refresh();
    universeResource.refresh();
    Promise.resolve(onRefresh?.()).catch(() => {});
  };

  useEffect(() => {
    setUniversePage(0);
  }, [universeQuery, universeState]);

  const stateCounts = universe?.meta?.stateCounts || {};
  const portfolioMode = snapshot?.portfolioState?.mode || 'unavailable';
  const connectionLabel = livePortfolioInput || connection?.connected === true
    ? 'IBKR CONNECTED'
    : 'IBKR UNVERIFIED';

  return (
    <section className="exposure-lab" aria-label="Exposure Lab">
      <header className="exposure-lab__header">
        <div className="exposure-lab__title-line">
          <h2>Exposure Lab</h2>
          <span className={`exposure-lab__status exposure-lab__status--${portfolioMode}`}>
            {portfolioMode.toUpperCase()}
          </span>
          <span>{connectionLabel}</span>
          <span>MODEL {snapshot?.modelVersion || 'exposure-lab-ridge-v2'}</span>
          <span>HISTORICAL / NON-EXECUTABLE</span>
          <ResourceDataStatusChip resource={snapshotResource} context="Exposure Lab snapshot" />
        </div>
        <div className="exposure-lab__header-actions">
          <button type="button" onClick={handleRefresh} disabled={loading || isLoading || isRefreshing}>
            {loading || isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {onClose && <button type="button" onClick={onClose}>Close</button>}
        </div>
      </header>

      <div className="exposure-lab__tabs" role="tablist" aria-label="Exposure Lab views">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'is-active' : ''}
            onClick={() => setActiveTab(id)}
          >
            {label}
            {id === 'universe' && universe?.meta?.universeCount != null
              ? ` (${universe.meta.universeCount.toLocaleString()})`
              : ''}
          </button>
        ))}
      </div>

      <div className="exposure-lab__summary" aria-label="Portfolio factor summary">
        <SummaryCell label="NET" value={formatSigned(snapshot?.portfolio?.netExposurePct, 1, '%')} />
        <SummaryCell label="GROSS" value={formatNumber(snapshot?.portfolio?.grossExposurePct, 1, '%')} />
        <SummaryCell label="PRED VOL" value={formatNumber(snapshot?.portfolio?.predictedAnnualizedVolPct, 1, '%')} detail="annualized" />
        <SummaryCell label="FACTOR VOL" value={formatNumber(snapshot?.portfolio?.factorAnnualizedVolPct, 1, '%')} detail="annualized" />
        <SummaryCell
          label="CORR COVERAGE"
          value={formatNumber(snapshot?.correlation?.coverage?.defaultWindowAvailableCellPct, 1, '%')}
          detail={`${snapshot?.correlation?.coverage?.positionsWithHistory || 0}/${snapshot?.correlation?.coverage?.positionCount || 0} positions with history`}
        />
        <SummaryCell
          label="MODEL COVERAGE"
          value={formatNumber(snapshot?.coverage?.modeledGrossNavPct, 1, '%')}
          detail={`${snapshot?.coverage?.modeledPositionCount || 0}/${snapshot?.coverage?.totalPositionCount || 0} modeled${snapshot?.coverage?.preliminaryPositionCount ? ` · ${snapshot.coverage.preliminaryPositionCount} prelim` : ''}`}
        />
        <SummaryCell label="AS OF" value={formatDate(snapshot?.asOf)} detail={portfolioMode} />
      </div>

      {(snapshotError || universeError) && (
        <div className="exposure-lab__errors" role="status">
          {snapshotError && <span>SNAPSHOT: {snapshotError}</span>}
          {universeError && <span>UNIVERSE: {universeError}</span>}
        </div>
      )}

      <div className="exposure-lab__toolbar">
        {activeTab === 'exposures' && (
          <>
            <span className="exposure-lab__toolbar-label">Benchmark</span>
            <div className="exposure-lab__segmented">
              <button type="button" className={benchmarkMode === 'absolute' ? 'is-active' : ''} onClick={() => setBenchmarkMode('absolute')}>Absolute</button>
              <button type="button" className={benchmarkMode === 'spy' ? 'is-active' : ''} onClick={() => setBenchmarkMode('spy')}>vs SPY</button>
            </div>
          </>
        )}
        {activeTab === 'exposures' && (
          <>
            <span className="exposure-lab__toolbar-label">Cells</span>
            <div className="exposure-lab__segmented">
              <button type="button" className={cellMode === 'contribution' ? 'is-active' : ''} onClick={() => setCellMode('contribution')}>% NAV contribution</button>
              <button type="button" className={cellMode === 'loading' ? 'is-active' : ''} onClick={() => setCellMode('loading')}>Loading</button>
            </div>
          </>
        )}
        {activeTab === 'correlation' && (
          <>
            <span className="exposure-lab__toolbar-label">Matrix</span>
            <div className="exposure-lab__segmented">
              <button type="button" className={correlationMode === 'positionPosition' ? 'is-active' : ''} onClick={() => setCorrelationMode('positionPosition')}>Position × position</button>
              <button type="button" className={correlationMode === 'positionFactor' ? 'is-active' : ''} onClick={() => setCorrelationMode('positionFactor')}>Position × factor</button>
              <button type="button" className={correlationMode === 'factorFactor' ? 'is-active' : ''} onClick={() => setCorrelationMode('factorFactor')}>Factor × factor</button>
            </div>
            <span className="exposure-lab__toolbar-label">Window</span>
            <div className="exposure-lab__segmented">
              {CORRELATION_WINDOWS.map((window) => (
                <button key={window} type="button" className={correlationWindow === window ? 'is-active' : ''} onClick={() => setCorrelationWindow(window)}>{window}D</button>
              ))}
            </div>
            {correlationMode !== 'factorFactor' && (
              <>
                <div className="exposure-lab__segmented">
                  <button type="button" className={correlationScope === 'top20' ? 'is-active' : ''} onClick={() => setCorrelationScope('top20')}>Top 20</button>
                  <button type="button" className={correlationScope === 'all' ? 'is-active' : ''} onClick={() => setCorrelationScope('all')}>All</button>
                </div>
                <input type="search" value={correlationQuery} onChange={(event) => setCorrelationQuery(event.target.value)} placeholder="Search positions" aria-label="Search correlation positions" />
              </>
            )}
          </>
        )}
        {activeTab === 'geography' && (
          <>
            <span className="exposure-lab__toolbar-label">Mode</span>
            <div className="exposure-lab__segmented">
              <button type="button" className={geographyMode === 'allocation' ? 'is-active' : ''} onClick={() => setGeographyMode('allocation')}>Allocation</button>
              <button type="button" className={geographyMode === 'sensitivity' ? 'is-active' : ''} onClick={() => setGeographyMode('sensitivity')}>Sensitivity</button>
            </div>
            {geographyMode === 'allocation' ? (
              <div className="exposure-lab__segmented">
                <button type="button" className={geographyLevel === 'region' ? 'is-active' : ''} onClick={() => setGeographyLevel('region')}>Region</button>
                <button type="button" className={geographyLevel === 'country' ? 'is-active' : ''} onClick={() => setGeographyLevel('country')}>Country</button>
              </div>
            ) : (
              <>
                <span className="exposure-lab__toolbar-label">Window</span>
                <div className="exposure-lab__segmented">
                  {CORRELATION_WINDOWS.map((window) => (
                    <button key={window} type="button" className={correlationWindow === window ? 'is-active' : ''} onClick={() => setCorrelationWindow(window)}>{window}D</button>
                  ))}
                </div>
                <div className="exposure-lab__segmented">
                  <button type="button" className={geographyScope === 'top20' ? 'is-active' : ''} onClick={() => setGeographyScope('top20')}>Top 20</button>
                  <button type="button" className={geographyScope === 'all' ? 'is-active' : ''} onClick={() => setGeographyScope('all')}>All</button>
                </div>
                <input type="search" value={geographyQuery} onChange={(event) => setGeographyQuery(event.target.value)} placeholder="Search positions" aria-label="Search geography positions" />
              </>
            )}
          </>
        )}
        {activeTab === 'universe' && (
          <>
            <input
              type="search"
              value={universeQuery}
              onChange={(event) => setUniverseQuery(event.target.value)}
              placeholder="Ticker prefix"
              aria-label="Search universe by ticker prefix"
            />
            <select value={universeState} onChange={(event) => setUniverseState(event.target.value)} aria-label="Filter discovery state">
              <option value="all">All states ({universe?.meta?.universeCount || 0})</option>
              <option value="catalogued">Catalogued ({stateCounts.catalogued || 0})</option>
              <option value="structured">Structured ({stateCounts.structured || 0})</option>
              <option value="candidate">Candidates ({stateCounts.candidate || 0})</option>
            </select>
          </>
        )}
        <span className="exposure-lab__toolbar-spacer" />
        <span>{loading ? 'LOADING' : snapshot?.status?.toUpperCase?.() || 'UNAVAILABLE'}</span>
      </div>

      <div className="exposure-lab__body">
        <PersistentSurface
          active={activeTab === 'exposures'}
          className="exposure-lab__tab-surface"
          role="tabpanel"
          aria-label="Exposure Matrix"
        >
          <ExposureMatrix snapshot={snapshot} benchmarkMode={benchmarkMode} cellMode={cellMode} />
        </PersistentSurface>
        <PersistentSurface
          active={activeTab === 'correlation'}
          className="exposure-lab__tab-surface"
          role="tabpanel"
          aria-label="Correlation"
        >
          <CorrelationLab
            snapshot={snapshot}
            modeKey={correlationMode}
            window={correlationWindow}
            scope={correlationScope}
            query={correlationQuery}
          />
        </PersistentSurface>
        <PersistentSurface
          active={activeTab === 'geography'}
          className="exposure-lab__tab-surface"
          role="tabpanel"
          aria-label="Geography"
        >
          <PersistentSurface active={geographyMode === 'allocation'} className="exposure-lab__tab-surface">
            <GeographyAllocation snapshot={snapshot} level={geographyLevel} />
          </PersistentSurface>
          <PersistentSurface active={geographyMode === 'sensitivity'} className="exposure-lab__tab-surface">
            <GeographySensitivity
              snapshot={snapshot}
              window={correlationWindow}
              scope={geographyScope}
              query={geographyQuery}
            />
          </PersistentSurface>
        </PersistentSurface>
        <PersistentSurface
          active={activeTab === 'universe'}
          className="exposure-lab__tab-surface"
          role="tabpanel"
          aria-label="Universe QA"
        >
          <UniverseQa
            universe={universe}
            query={universeQuery}
            stateFilter={universeState}
            page={universePage}
            setPage={setUniversePage}
            onReviewSaved={(review) => {
              if (!review) return;
              setUniverseView((current) => {
                if (!current) return current;
                const nextRows = (current.rows || []).map((row) => (
                  row.ticker === review.ticker
                    ? {
                      ...row,
                      ...review,
                      ...(review.identityStatus === 'verified' && review.displayName ? {
                        name: review.displayName,
                        nameSource: 'Exposure Lab security master',
                        nameVerified: true,
                      } : {}),
                      review,
                    }
                    : row
                ));
                return {
                  ...current,
                  rows: nextRows,
                  meta: {
                    ...current.meta,
                    reviewedCount: nextRows.filter((row) => row.reviewStatus === 'reviewed').length,
                    analysisEligibleCount: nextRows.filter((row) => row.analysisEligible).length,
                    hedgeEligibleCount: nextRows.filter((row) => row.hedgeEligible).length,
                  },
                };
              });
            }}
          />
        </PersistentSurface>
        <PersistentSurface
          active={activeTab === 'hedge'}
          className="exposure-lab__tab-surface"
          role="tabpanel"
          aria-label="Hedge Lab"
        >
          <HedgeLab snapshot={snapshot} />
        </PersistentSurface>
      </div>
    </section>
  );
}
