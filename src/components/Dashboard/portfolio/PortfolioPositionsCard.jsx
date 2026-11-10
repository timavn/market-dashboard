import React from 'react';
import { ChevronDown, Download, Filter, RefreshCw, Search } from 'lucide-react';
import {
  SLEEVE_ORDER, formatPct, formatPrice, holdingSourceTitle, isHistoricalReferenceMark,
} from './portfolioPositionsModel';
import SecurityRangeMeter from '../SecurityRangeMeter';
import SecurityRangeChart from '../SecurityRangeChart';
import useSecurityRiskRanges from '../../../hooks/useSecurityRiskRanges';

export const HoldingMarkWarning = ({ holding }) => {
  const historicalReference = isHistoricalReferenceMark(holding);
  const markLoading = (
    holding?.markPending === true
    || holding?.markWarmState === 'warming'
    || holding?.warning === 'reference_mark_warming'
  );
  const unavailableMark = (
    ['unavailable', 'failed', 'error'].includes(String(holding?.priceState || '').toLowerCase())
    || ['unavailable', 'failed', 'error'].includes(String(holding?.marketValueState || '').toLowerCase())
    || ['degraded', 'unavailable'].includes(String(holding?.markWarmState || '').toLowerCase())
  );
  const nonBenignWarning = Boolean(
    holding?.warning && holding.warning !== 'reference_mark_warming'
  );
  const hasError = Boolean(
    holding?.markFailure
    || nonBenignWarning
    || (!historicalReference && !markLoading && unavailableMark)
  );
  if (!markLoading && !hasError) return null;

  const state = hasError ? 'error' : 'loading';
  const title = state === 'loading'
    ? 'Live IBKR market mark is still loading; no executable price is shown'
    : holding.warning || 'Verified live market mark is unavailable';
  const ariaLabel = state === 'loading' ? 'Market mark loading' : 'Bad data warning';

  return (
    <span
      className={`pcv2-mark-status pcv2-mark-status--${state}`}
      aria-label={ariaLabel}
      title={title}
    >
      {state === 'loading' ? (
        <RefreshCw size={10} strokeWidth={2} aria-hidden="true" />
      ) : (
        <span aria-hidden="true">⚠</span>
      )}
    </span>
  );
};

const PortfolioTargetControl = ({ holding, isLongs, pctOfAccount, getInputProps }) => {
  const inputProps = getInputProps(holding, isLongs, pctOfAccount);
  if (!inputProps) return (
    <span
      aria-label={`Target weight unavailable for ${holding?.symbol || 'position'}; verified live mark and NAV required`}
      title="Sizing is disabled until IBKR supplies a verified live mark and live NAV"
    >
      —
    </span>
  );
  return (
    <div className="pcv2-target-control">
      <input
        type="text"
        inputMode="decimal"
        aria-label={`Target weight for ${holding.symbol}, percent of NAV`}
        {...inputProps}
      />
      <span aria-hidden="true">▲<br />▼</span>
    </div>
  );
};

export default function PortfolioPositionsCard({ positions, research, refresh }) {
  const { longRows: ledgerLongs, shortRows: ledgerShorts, exportCsv: handleExportCsv } = positions;
  const {
    search: ledgerSearchFilter, sortField: ledgerSortField, sleeve: ledgerSleeveFilter,
    setSearch: setLedgerSearchFilter, setSortField: setLedgerSortField, setSleeve: setLedgerSleeveFilter,
  } = positions.filters;
  const { availabilityLabel: portfolioAvailabilityLabel, isRefreshing, onRefresh: handleManualRefresh } = refresh;
  const riskRanges = useSecurityRiskRanges([...ledgerLongs, ...ledgerShorts].map(holding => holding.symbol));

  const renderLedgerRows = (rows, isLongs) => {
    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={11} className="pcv2-empty">
            No {isLongs ? 'long' : 'short'} positions
          </td>
        </tr>
      );
    }

    return rows.map((holding, index) => {
      const { pctOfAccount, assetClass, shares, action, mark, dayGainLossPercent, factorLabels, factorExposureText, compactActionLabel } = positions.getRowPresentation(holding, isLongs);
      const {
        rowId, isExpanded, healthStatus, researchNeedsAttention, positionSizeReference, riskMetricsError,
      } = research.describeRow(holding, isLongs, index);

      return (
        <React.Fragment key={rowId}>
          <tr
            className={`pcv2-ledger-row ${isExpanded ? 'is-expanded' : ''} ${researchNeedsAttention ? 'is-research-attention' : ''}`}
            data-row-id={rowId}
            data-research-health={healthStatus || (researchNeedsAttention ? 'unavailable' : undefined)}
            title={researchNeedsAttention
              ? `${holding.symbol} current research is incomplete or unavailable; holding remains visible.`
              : undefined}
          >
            <td className="pcv2-ticker">
              <button
                type="button"
                className="pcv2-research-toggle"
                aria-expanded={isExpanded}
                aria-controls={`portfolio-research-${rowId}`}
                aria-label={`${isExpanded ? 'Hide' : 'Show'} research intelligence for ${holding.symbol}`}
                onClick={() => research.toggleRow(holding, rowId)}
              >
                <svg
                  className="pcv2-research-toggle__icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M3 8h10"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.7"
                  />
                  {!isExpanded && (
                    <path
                      d="M8 3v10"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.7"
                    />
                  )}
                </svg>
              </button>
              <span title={holdingSourceTitle(holding) || undefined}>
                {holding.symbol}
                <HoldingMarkWarning holding={holding} />
              </span>
            </td>
            <td className="pcv2-num">{assetClass}</td>
            <td className="pcv2-num">
              {pctOfAccount === null ? '—' : formatPct(isLongs ? pctOfAccount : -pctOfAccount, 2)}
            </td>
            <td className="pcv2-num pcv2-ledger-size-reference">
              <button
                type="button"
                aria-label={`Verify ${holding.symbol} position size calculation`}
                title={positionSizeReference.available
                  ? 'Volatility-based operating range; click for method, inputs, and risk limits.'
                  : positionSizeReference.reason}
                onClick={() => research.explainSize(positionSizeReference.verification)}
              >
                {positionSizeReference.value
                  || (positionSizeReference.loading && !riskMetricsError ? '…' : '—')}
              </button>
            </td>
            <td className="pcv2-num"><PortfolioTargetControl holding={holding} isLongs={isLongs} pctOfAccount={pctOfAccount} getInputProps={positions.targetControls.getInputProps} /></td>
            <td className="pcv2-factor-exposures" title={factorLabels.join(' · ') || 'Needs +EV classification review'}>
              <span>{factorExposureText}</span>
            </td>
            <td className="pcv2-num">
              {shares === null ? '—' : shares ? (shares > 0 ? `+${shares}` : shares) : '0'}
            </td>
            <td
              className="pcv2-num pcv2-price-value"
              aria-label={mark?.ariaLabel || 'Price unavailable'}
              title={mark?.title || 'Verified live price or completed-session close unavailable'}
            >
              {mark === null ? '—' : (
                <span className="pcv2-price-reading">
                  <span>{formatPrice(mark.value)}</span>
                  {mark.statusLabel ? (
                    <span className="pcv2-price-state">{mark.statusLabel}</span>
                  ) : null}
                </span>
              )}
            </td>
            <td className="pcv2-range-cell">
              {riskRanges[holding.symbol] && mark !== null
                ? <SecurityRangeMeter range={{ ...riskRanges[holding.symbol], price: mark.value }} />
                : '—'}
            </td>
            <td
              className={`pcv2-num ${dayGainLossPercent > 0 ? 'pcv2-positive' : dayGainLossPercent < 0 ? 'pcv2-negative' : ''}`}
              aria-label={dayGainLossPercent === null
                ? 'Day gain/loss percentage unavailable'
                : `Day gain/loss ${formatPct(dayGainLossPercent, 2, { signed: true })}`}
              title={dayGainLossPercent === null
                ? 'Verified day gain/loss percentage unavailable'
                : `Verified session change: ${formatPct(dayGainLossPercent, 2, { signed: true })}`}
            >
              {dayGainLossPercent === null
                ? '—'
                : formatPct(dayGainLossPercent, 2, { signed: true })}
            </td>
            <td
              className={`pcv2-action-cell ${action.tone === 'trim' ? 'pcv2-negative' : action.tone === 'add' ? 'pcv2-positive' : ''}`}
              aria-label={action.label}
              title={action.label}
            >
              {compactActionLabel}
            </td>
          </tr>
          {isExpanded && (
            <tr className="pcv2-research-row">
              <td colSpan={11}>
                <SecurityRangeChart symbol={holding.symbol} />
                {research.renderExpanded(holding, rowId)}
              </td>
            </tr>
          )}
        </React.Fragment>
      );
    });
  };

  const renderLedgerTableHead = () => (
    <thead>
      <tr>
        <th title="Ticker">Ticker</th>
        <th className="pcv2-num" aria-label="Asset class" title="Asset class">Asset<br />Class</th>
        <th className="pcv2-num" aria-label="Weight % (NAV)" title="Weight % of NAV">Weight<br />% NAV</th>
        <th className="pcv2-num" aria-label="Position size" title="Volatility-based operating range (% NAV); click a size for the calculation">Size</th>
        <th className="pcv2-num" aria-label="Target % (NAV)" title="Target % of NAV">Target<br />% NAV</th>
        <th aria-label="Factor exposures" title="Reviewed +EV exposure labels">Factors</th>
        <th className="pcv2-num" aria-label="Resize (Shares)" title="Resize in shares">Resize<br />Sh</th>
        <th className="pcv2-num" aria-label="Price" title="Verified live price or latest completed-session close">Price</th>
        <th aria-label="Risk Range" title="Where the price sits in its published Risk Range: red bottom third, green top third">Range</th>
        <th className="pcv2-num" aria-label="Day G/L (%)" title="Day gain/loss percentage">Day G/L<br />%</th>
        <th aria-label="Action" title="Action">Action</th>
      </tr>
    </thead>
  );

  const renderLedgerPane = ({ label, rows, isLongs }) => {
    return (
      <div className={`pcv2-ledger-pane ${isLongs ? 'pcv2-ledger-pane--long' : 'pcv2-ledger-pane--short'}`}>
        <div className="pcv2-ledger-pane-head">
          <span>{label} ({rows.length})</span>
        </div>
        <div
          className="pcv2-ledger-pane-scroll"
          data-layout="fit-columns"
        >
          <table className="pcv2-ledger-table" data-column-count="11">
            <colgroup>
              <col style={{ width: '13%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '7%' }} />
            </colgroup>
            {renderLedgerTableHead()}
            <tbody>
              {renderLedgerRows(rows, isLongs)}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <section className="pcv2-card pcv2-ledger-card" aria-label="Portfolio positions">
      <div className="pcv2-ledger-toolbar">
        {portfolioAvailabilityLabel && (
          <span className="pcv2-ledger-availability" role="status">
            {portfolioAvailabilityLabel}
          </span>
        )}
        <label className="pcv2-search">
          <input
            type="text"
            placeholder="Search ticker or name..."
            value={ledgerSearchFilter}
            onChange={(e) => setLedgerSearchFilter(e.target.value)}
          />
          <Search aria-hidden="true" />
        </label>
        <label className="pcv2-field">
          <span>Sort:</span>
          <select value={ledgerSortField} onChange={(e) => setLedgerSortField(e.target.value)}>
            <option value="weight">Weight</option>
            <option value="ticker">Ticker</option>
            <option value="name">Name</option>
            <option value="dayGainLoss">Day G/L</option>
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <label className="pcv2-field">
          <span>Sleeve:</span>
          <select value={ledgerSleeveFilter} onChange={(e) => setLedgerSleeveFilter(e.target.value)}>
            <option value="all">All</option>
            {SLEEVE_ORDER.map((sleeve) => (
              <option value={sleeve} key={sleeve}>{sleeve}</option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <button type="button" className="pcv2-toolbar-icon" title="Filter options">
          <Filter size={14} />
        </button>
        <button
          type="button"
          className="pcv2-toolbar-icon"
          title="Refresh portfolio and research"
          aria-label={isRefreshing ? 'Refreshing portfolio and research' : 'Refresh portfolio and research'}
          aria-busy={isRefreshing}
          onClick={handleManualRefresh}
        >
          <RefreshCw size={14} />
        </button>
        <button type="button" className="pcv2-columns-button">
          Columns
          <ChevronDown size={13} />
        </button>
        <button type="button" className="pcv2-export pcv2-ledger-export" onClick={handleExportCsv}>
          <Download size={14} />
          Export CSV
        </button>
      </div>
      <div className="pcv2-ledger-split">
        {renderLedgerPane({ label: 'LONG', rows: ledgerLongs, isLongs: true })}
        {renderLedgerPane({ label: 'SHORT', rows: ledgerShorts, isLongs: false })}
      </div>
    </section>
  );
}
