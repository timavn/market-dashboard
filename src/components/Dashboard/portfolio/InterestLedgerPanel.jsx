import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, X } from 'lucide-react';
import { MarketDataService } from '../../../services/api/marketDataService';
import './InterestLedgerPanel.css';

const LEDGER_RESPONSE_MAX_AGE_MS = 5 * 60 * 1000;

const SHEETS = [
  { id: 'overview', label: 'Overview' },
  { id: 'daily', label: 'Daily ledger', dataKey: 'ledger' },
  { id: 'observations', label: 'MTD checkpoints' },
  { id: 'forecasts', label: 'Forecasts' },
  { id: 'formulaAudit', label: 'Formula audit' },
  { id: 'postings', label: 'Postings' },
];

const TABLE_COLUMNS = {
  daily: [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'flex_debit_interest_cost', label: 'Debit cost', type: 'currency' },
    { key: 'flex_cash_credit_interest', label: 'Cash credit', type: 'currency' },
    { key: 'flex_short_credit_interest', label: 'Short credit', type: 'currency' },
    { key: 'flex_net_interest_signed', label: 'Net signed', type: 'currency' },
    { key: 'flex_reported_mtd_net_signed', label: 'Flex MTD', type: 'currency' },
    { key: 'live_mtd_net_accrued_signed', label: 'Live MTD', type: 'currency' },
    { key: 'forecast_point_debit_cost', label: 'Forecast', type: 'currency' },
    { key: 'flex_actual_debit_cost', label: 'Actual debit', type: 'currency' },
    { key: 'row_status', label: 'Evidence status', type: 'status' },
  ],
  observations: [
    { key: 'session_date', label: 'Session date', type: 'date' },
    { key: 'observed_at', label: 'Observed at', type: 'timestamp' },
    { key: 'live_mtd_net_accrued_signed', label: 'MTD net signed', type: 'currency' },
    { key: 'live_mtd_cost_display', label: 'Cost display', type: 'currency' },
    { key: 'change_since_prior_checkpoint', label: 'Change', type: 'currency' },
    { key: 'calendar_days_since_prior_checkpoint', label: 'Calendar days', type: 'number' },
    { key: 'source', label: 'Verified source', type: 'status' },
  ],
  forecasts: [
    { key: 'value_date', label: 'Value date', type: 'date' },
    { key: 'covered_value_dates', label: 'Covered dates', type: 'text' },
    { key: 'accrual_days', label: 'Days', type: 'number' },
    { key: 'estimated_principal', label: 'Principal', type: 'currency' },
    { key: 'raw_forecast', label: 'Raw', type: 'currency' },
    { key: 'point_forecast', label: 'Point', type: 'currency' },
    { key: 'upper_forecast', label: 'Upper', type: 'currency' },
    { key: 'effective_annual_rate', label: 'Rate', type: 'rateDecimal' },
    { key: 'actual_debit_interest', label: 'Actual debit', type: 'currency' },
    { key: 'point_residual_actual_minus_forecast', label: 'Residual', type: 'currency' },
    { key: 'comparison_status', label: 'Comparison', type: 'status' },
    { key: 'model_status', label: 'Model', type: 'status' },
  ],
  formulaAudit: [
    { key: 'value_date', label: 'Value date', type: 'date' },
    { key: 'interest_type', label: 'Interest type', type: 'text' },
    { key: 'principal', label: 'Principal', type: 'currency' },
    { key: 'annual_rate_percent', label: 'Annual rate', type: 'ratePercent' },
    { key: 'day_count', label: 'Day count', type: 'number' },
    { key: 'formula_interest_absolute', label: 'Formula', type: 'currency' },
    { key: 'ibkr_interest_absolute', label: 'IBKR', type: 'currency' },
    { key: 'residual_ibkr_minus_formula', label: 'Residual', type: 'currency' },
    { key: '__auditResult', label: 'Result', type: 'auditResult' },
  ],
  postings: [
    { key: 'posted_date', label: 'Posted date', type: 'date' },
    { key: 'covered_month', label: 'Covered month', type: 'text' },
    { key: 'category', label: 'Category', type: 'status' },
    { key: 'amount_signed', label: 'Amount signed', type: 'currency' },
    { key: 'currency', label: 'CCY', type: 'text' },
    { key: 'transaction_type', label: 'Transaction type', type: 'text' },
    { key: 'description', label: 'Description', type: 'text' },
  ],
};

function explicitFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasForbiddenLedgerEvidence(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (
    value.fromCache === true
    || value.cacheOnly === true
    || value.mock === true
    || value.isMock === true
    || value.seeded === true
    || value.synthetic === true
    || value.inferred === true
    || value._cache?.hit === true
    || value._cache?.stale === true
  ) return true;
  return Object.values(value).some((child) => (
    child && typeof child === 'object'
      ? hasForbiddenLedgerEvidence(child, seen)
      : false
  ));
}

export function normalizeVerifiedInterestLedger(response, accountId, now = Date.now()) {
  const generatedAt = Date.parse(String(response?.generatedAt || ''));
  const summary = response?.summary;
  const arraysValid = ['ledger', 'observations', 'forecasts', 'postings', 'formulaAudit']
    .every((field) => Array.isArray(response?.[field]));
  const formulaRows = Number(summary?.formulaAudit?.rows);
  const exactRows = Number(summary?.formulaAudit?.exactToCentRows);
  const recovered = summary?.recovered || {};

  if (
    response?.source !== 'ibkr_verified_interest_ledger'
    || response?.available !== true
    || response?.status !== 'verified_history'
    || response?.accountMatched !== true
    || response?.accountId !== accountId
    || response?.fromCache !== false
    || !Number.isFinite(generatedAt)
    || now - generatedAt < -5_000
    || now - generatedAt > LEDGER_RESPONSE_MAX_AGE_MS
    || summary?.source !== 'ibkr_verified_interest_evidence_export'
    || summary?.accountScoped !== true
    || summary?.accountIdentifierIncluded !== false
    || !arraysValid
    || !Number.isInteger(formulaRows)
    || formulaRows < 0
    || response.formulaAudit.length !== formulaRows
    || !Number.isInteger(exactRows)
    || exactRows < 0
    || exactRows > formulaRows
    || Number(recovered.liveMtdCheckpoints) !== response.observations.length
    || Number(recovered.forecastRows) !== response.forecasts.length
    || Number(recovered.cashPostings) !== response.postings.length
    || hasForbiddenLedgerEvidence(response)
  ) return null;

  return {
    accountMasked: response.accountMasked || null,
    generatedAt: response.generatedAt,
    summary,
    ledger: response.ledger,
    observations: response.observations,
    forecasts: response.forecasts,
    postings: response.postings,
    formulaAudit: response.formulaAudit,
  };
}

function formatCurrency(value) {
  const number = explicitFiniteNumber(value);
  if (number === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    currencySign: 'accounting',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatNumber(value) {
  const number = explicitFiniteNumber(value);
  return number === null ? '—' : new Intl.NumberFormat('en-US').format(number);
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || '—';
  const date = new Date(`${value}T12:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function humanize(value) {
  return String(value || '—').replace(/_/g, ' ');
}

function displayCell(row, column) {
  if (column.type === 'auditResult') {
    const residual = explicitFiniteNumber(row.residual_ibkr_minus_formula);
    return residual !== null && Math.abs(residual) < 0.005 ? 'OK' : 'CHECK';
  }
  const value = row[column.key];
  if (column.type === 'currency') return formatCurrency(value);
  if (column.type === 'number') return formatNumber(value);
  if (column.type === 'date') return formatDate(value);
  if (column.type === 'timestamp') return formatTimestamp(value);
  if (column.type === 'rateDecimal') {
    const number = explicitFiniteNumber(value);
    return number === null ? '—' : `${(number * 100).toFixed(2)}%`;
  }
  if (column.type === 'ratePercent') {
    const number = explicitFiniteNumber(value);
    return number === null ? '—' : `${number.toFixed(2)}%`;
  }
  if (column.type === 'status') return humanize(value);
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function usePanelPosition(open, anchorRef) {
  const [position, setPosition] = useState({
    inset: '8px',
    placement: 'overlay',
  });

  useEffect(() => {
    if (!open) return undefined;
    let observer = null;
    const update = () => {
      const anchor = anchorRef?.current;
      const balancePanel = anchor?.closest?.('.dashboard-navigation-rail__balance-panel');
      const target = balancePanel || anchor;
      const rect = target?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        setPosition({ inset: '8px', placement: 'overlay' });
        return;
      }
      const availableLeft = rect.left - 16;
      if (availableLeft < 480) {
        setPosition({ inset: '8px', placement: 'overlay' });
        return;
      }
      const width = Math.min(980, availableLeft);
      setPosition({
        top: `${Math.max(8, rect.top)}px`,
        bottom: `${Math.max(8, window.innerHeight - rect.bottom)}px`,
        left: `${Math.max(8, rect.left - width - 8)}px`,
        width: `${width}px`,
        placement: 'left',
      });
    };

    update();
    window.addEventListener('resize', update);
    const target = anchorRef?.current?.closest?.('.dashboard-navigation-rail__balance-panel');
    if (target && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(target);
    }
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [anchorRef, open]);

  return position;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadSheet(sheetId, rows, columns) {
  if (!rows.length || !columns.length) return;
  const csv = [
    columns.map((column) => csvCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => (
      column.type === 'auditResult'
        ? csvCell(displayCell(row, column))
        : csvCell(row[column.key])
    )).join(',')),
  ].join('\n');
  const url = URL.createObjectURL(new Blob([`${csv}\n`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `ibkr-interest-${sheetId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function LedgerTable({ rows, columns, label }) {
  if (!rows.length) {
    return (
      <div className="interest-ledger-panel__empty" role="status">
        No verified rows are available for this sheet.
      </div>
    );
  }
  return (
    <div className="interest-ledger-panel__table-wrap">
      <table className="interest-ledger-panel__table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key}>{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.date || row.value_date || row.session_date || row.posted_date || 'row'}-${index}`}>
              {columns.map((column) => {
                const value = displayCell(row, column);
                const numeric = ['currency', 'number', 'rateDecimal', 'ratePercent'].includes(column.type);
                const result = column.type === 'auditResult';
                return (
                  <td
                    key={column.key}
                    className={[
                      numeric && 'is-numeric',
                      result && `is-${String(value).toLowerCase()}`,
                    ].filter(Boolean).join(' ')}
                    title={String(value)}
                  >
                    {value}
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

function Overview({ ledger }) {
  const { summary } = ledger;
  const latestForecast = ledger.forecasts[ledger.forecasts.length - 1] || null;
  const latestObservation = ledger.observations[ledger.observations.length - 1] || null;
  const recovered = summary.recovered;
  const unavailable = summary.unavailableSections || {};
  return (
    <div className="interest-ledger-panel__overview">
      <div className="interest-ledger-panel__conclusion">
        <strong>Rate math is fully reproduced.</strong>
        <span>
          {summary.formulaAudit.exactToCentRows} of {summary.formulaAudit.rows} IBKR tier rows match to the cent.
          Principal reconstruction is the remaining model variable.
        </span>
      </div>

      <div className="interest-ledger-panel__kpis">
        <div><span>Formula rows</span><strong>{formatNumber(summary.formulaAudit.rows)}</strong></div>
        <div><span>Exact matches</span><strong>{formatNumber(summary.formulaAudit.exactToCentRows)}</strong></div>
        <div><span>Daily actuals</span><strong>{formatNumber(recovered.dailyDebitActualDates)}</strong></div>
        <div><span>MTD checkpoints</span><strong>{formatNumber(recovered.liveMtdCheckpoints)}</strong></div>
        <div><span>Matched forecasts</span><strong>{formatNumber(recovered.matchedForecastRows)}</strong></div>
      </div>

      <section className="interest-ledger-panel__overview-section" aria-label="Latest ledger readings">
        <h3>Latest readings</h3>
        <div className="interest-ledger-panel__latest-grid">
          <div>
            <span>Live MTD checkpoint</span>
            <strong>{latestObservation ? formatCurrency(latestObservation.live_mtd_cost_display) : '—'}</strong>
            <small>{latestObservation ? `${formatDate(latestObservation.session_date)} · net account value` : 'Awaiting verified evidence'}</small>
          </div>
          <div>
            <span>Current point forecast</span>
            <strong>{latestForecast ? formatCurrency(latestForecast.point_forecast) : '—'}</strong>
            <small>{latestForecast ? `${formatDate(latestForecast.value_date)} · ${humanize(latestForecast.comparison_status)}` : 'Awaiting forecast'}</small>
          </div>
          <div>
            <span>Estimated principal</span>
            <strong>{latestForecast ? formatCurrency(latestForecast.estimated_principal) : '—'}</strong>
            <small>{latestForecast ? `${displayCell(latestForecast, { key: 'effective_annual_rate', type: 'rateDecimal' })} effective annual rate` : 'Unavailable'}</small>
          </div>
        </div>
      </section>

      <section className="interest-ledger-panel__overview-section" aria-label="Recovered coverage">
        <h3>Recovered coverage</h3>
        <div className="interest-ledger-panel__coverage-grid">
          <span>Tier detail</span><strong>{formatDate(recovered.tierDetailFrom)}–{formatDate(recovered.tierDetailThrough)}</strong>
          <span>Daily debit actuals</span><strong>{formatDate(recovered.dailyDebitActualFrom)}–{formatDate(recovered.dailyDebitActualThrough)}</strong>
          <span>Immutable Flex revisions</span><strong>{formatNumber(recovered.immutableFlexRevisions)}</strong>
          <span>Cash postings</span><strong>{formatNumber(recovered.cashPostings)}</strong>
        </div>
      </section>

      <section className="interest-ledger-panel__overview-section" aria-label="Monthly posting tie outs">
        <h3>Monthly tier-to-posting tie-outs</h3>
        <div className="interest-ledger-panel__tie-outs">
          {(summary.postedMarginInterestByPostingMonth || []).map((row) => (
            <div key={row.month}>
              <span>{row.month}</span>
              <strong>{formatCurrency(row.net)}</strong>
              <small>exact cash-posting tie</small>
            </div>
          ))}
        </div>
      </section>

      <section className="interest-ledger-panel__overview-section" aria-label="Unavailable evidence">
        <h3>Unavailable evidence</h3>
        <div className="interest-ledger-panel__gaps">
          <span>Interest Accrual rows</span><strong>{humanize(unavailable.interestAccrualRows)}</strong>
          <span>Cash Report rows</span><strong>{humanize(unavailable.cashReportRows)}</strong>
          <span>Daily stock-borrow rows</span><strong>{humanize(unavailable.dailyStockBorrowFeeRows)}</strong>
        </div>
      </section>
    </div>
  );
}

const InterestLedgerPanel = ({ accountId, anchorRef, onClose, open }) => {
  const [activeSheet, setActiveSheet] = useState('overview');
  const [requestState, setRequestState] = useState({ status: 'idle', data: null });
  const closeButtonRef = useRef(null);
  const position = usePanelPosition(open, anchorRef);

  const loadLedger = useCallback(() => {
    if (!open || !accountId) return undefined;
    const controller = new AbortController();
    setRequestState({ status: 'loading', data: null });
    MarketDataService.getIbkrInterestValidationLedger({
      account: accountId,
      signal: controller.signal,
    })
      .then((response) => {
        const data = normalizeVerifiedInterestLedger(response, accountId);
        setRequestState(data
          ? { status: 'ready', data }
          : { status: 'unavailable', data: null });
      })
      .catch((error) => {
        if (error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
        setRequestState({ status: 'unavailable', data: null });
      });
    return () => controller.abort();
  }, [accountId, open]);

  useEffect(loadLedger, [loadLedger]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    setActiveSheet('overview');
  }, [accountId]);

  const sheet = SHEETS.find((candidate) => candidate.id === activeSheet) || SHEETS[0];
  const tableRows = requestState.data && activeSheet !== 'overview'
    ? requestState.data[sheet.dataKey || activeSheet] || []
    : [];
  const tableColumns = TABLE_COLUMNS[activeSheet] || [];
  const panelStyle = useMemo(() => {
    const { placement: _placement, ...style } = position;
    return style;
  }, [position]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <aside
      id="interest-ledger-panel"
      className="interest-ledger-panel"
      data-placement={position.placement}
      style={panelStyle}
      role="dialog"
      aria-modal="false"
      aria-labelledby="interest-ledger-panel-title"
      aria-busy={requestState.status === 'loading'}
    >
      <header className="interest-ledger-panel__header">
        <div>
          <h2 id="interest-ledger-panel-title">IBKR Interest Ledger</h2>
          <p>
            Verified historical evidence
            {requestState.data?.accountMasked ? ` · ${requestState.data.accountMasked}` : ''}
          </p>
        </div>
        <div className="interest-ledger-panel__header-actions">
          <button
            type="button"
            aria-label="Refresh interest ledger"
            title="Refresh verified ledger"
            disabled={requestState.status === 'loading'}
            onClick={() => loadLedger()}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close interest ledger"
            title="Close interest ledger"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="interest-ledger-panel__toolbar">
        <div className="interest-ledger-panel__tabs" role="tablist" aria-label="Interest ledger sheets">
          {SHEETS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={activeSheet === candidate.id}
              className={activeSheet === candidate.id ? 'is-active' : ''}
              onClick={() => setActiveSheet(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="interest-ledger-panel__download"
          disabled={!tableRows.length || !tableColumns.length}
          title={activeSheet === 'overview' ? 'Choose a data sheet to download' : `Download ${sheet.label} as CSV`}
          onClick={() => downloadSheet(activeSheet, tableRows, tableColumns)}
        >
          <Download size={13} aria-hidden="true" />
          Download sheet
        </button>
      </div>

      <div className="interest-ledger-panel__meta">
        {requestState.data
          ? `Generated ${formatTimestamp(requestState.data.generatedAt)} · blanks are unavailable evidence, never inferred zeroes`
          : 'Loading account-scoped immutable IBKR evidence'}
      </div>

      <div className="interest-ledger-panel__body">
        {requestState.status === 'loading' && (
          <div className="interest-ledger-panel__loading" role="status">
            Loading verified interest ledger…
          </div>
        )}
        {requestState.status === 'unavailable' && (
          <div className="interest-ledger-panel__empty" role="status">
            Verified account-scoped ledger evidence is unavailable.
          </div>
        )}
        {requestState.status === 'ready' && activeSheet === 'overview' && (
          <Overview ledger={requestState.data} />
        )}
        {requestState.status === 'ready' && activeSheet !== 'overview' && (
          <LedgerTable rows={tableRows} columns={tableColumns} label={sheet.label} />
        )}
      </div>
    </aside>,
    document.body,
  );
};

export default InterestLedgerPanel;
