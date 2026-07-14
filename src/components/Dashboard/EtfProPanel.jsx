import React, { useMemo, useState } from 'react';
import { isFreshForToday } from '../../utils/dateFreshness';
import ReferencePanelShell from './ReferencePanelShell';

const PAGE_SIZE = 30;

const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatNumber = (value, digits = 2) => Number.isFinite(asNumber(value))
  ? asNumber(value).toFixed(digits)
  : '—';

const formatPercent = (value) => {
  const number = asNumber(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
};

const sortMaybe = (a, b, direction) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const result = typeof a === 'string'
    ? a.localeCompare(b)
    : Number(a) - Number(b);
  return direction === 'asc' ? result : -result;
};

const ChangeGroup = ({ label, values, tone }) => (
  <div>
    <div className="reference-change-group__label">{label}</div>
    <div className="reference-pill-row">
      {values.length ? values.map((ticker) => (
        <span key={ticker} className={`reference-pill reference-pill--${tone}`}>{ticker}</span>
      )) : <span className="reference-empty-inline">None</span>}
    </div>
  </div>
);

const EtfProPanel = ({ snapshot, loading = false, refreshing = false, error = null, onRefresh, onClose }) => {
  const [side, setSide] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'dateAdded', direction: 'desc' });
  const [page, setPage] = useState(0);

  const rows = useMemo(() => (Array.isArray(snapshot?.rows) ? snapshot.rows : []), [snapshot?.rows]);
  const changes = snapshot?.changes || {};
  const snapshotDate = snapshot?.meta?.snapshotDate || null;
  const fresh = isFreshForToday(snapshotDate);
  const quality = snapshot?.dataQuality || {};

  const normalizedRows = useMemo(() => rows.map((row) => {
    const call = String(row.call || '').toLowerCase() === 'short' ? 'Short' : 'Long';
    return {
      ...row,
      call,
      ticker: String(row.ticker || '').toUpperCase(),
      publishedPrice: asNumber(row.lastPrice ?? row.recentPrice),
      rangeLow: asNumber(row.trendLowEnd ?? row.riskRangeLow),
      rangeHigh: asNumber(row.trendHighEnd ?? row.riskRangeHigh),
      absolutePerformance: asNumber(row.absolutePerformance),
      relativePerformance: asNumber(row.relativePerformance),
      daysHeld: asNumber(row.daysHeld),
    };
  }), [rows]);

  const counts = useMemo(() => normalizedRows.reduce((acc, row) => {
    if (row.call === 'Short') acc.shorts += 1;
    else acc.longs += 1;
    return acc;
  }, { longs: 0, shorts: 0 }), [normalizedRows]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedRows
      .filter((row) => side === 'all' || row.call.toLowerCase() === side)
      .filter((row) => !normalizedQuery || `${row.ticker} ${row.etf || ''} ${row.assetClass || ''}`.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => sortMaybe(a[sort.key], b[sort.key], sort.direction));
  }, [normalizedRows, query, side, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const net = counts.longs - counts.shorts;
  const gross = counts.longs + counts.shorts;
  const netPct = gross ? (net / gross) * 100 : null;
  const actionCount = (changes.addedLongs || []).length + (changes.addedShorts || []).length +
    (changes.removedLongs || []).length + (changes.removedShorts || []).length;

  const toggleSort = (key) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const selectSide = (value) => {
    setSide(value);
    setPage(0);
  };

  const qualityWarnings = [
    ...(quality.warnings || []),
    ...(quality.removedButMissing || []).map((ticker) => `Remove action missing from active book: ${ticker}`),
    ...(quality.duplicateAdds || []).map((ticker) => `Add action already present: ${ticker}`),
  ];

  return (
    <ReferencePanelShell
      title="ETF Pro"
      subtitle={`Published ETF Pro reference · ${formatDate(snapshotDate)} · ${snapshot?.meta?.source || 'source unavailable'}`}
      status={snapshotDate ? (fresh ? 'Current snapshot' : `Snapshot ${formatDate(snapshotDate)}`) : 'No snapshot'}
      statusTone={snapshotDate ? (fresh ? 'fresh' : 'stale') : 'error'}
      onRefresh={onRefresh}
      refreshing={refreshing}
      onClose={onClose}
    >
      {error && <div className="reference-alert reference-alert--error">{error}</div>}
      {snapshotDate && !fresh && <div className="reference-alert">This is a dated published reference snapshot, not current executable market data.</div>}
      {qualityWarnings.length > 0 && <div className="reference-alert">{qualityWarnings.join(' · ')}</div>}

      <div className="reference-grid reference-grid--summary">
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Longs</div>
          <div className="reference-stat__value reference-table__positive">{counts.longs}</div>
          <div className="reference-stat__detail">Published active positions</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Shorts</div>
          <div className="reference-stat__value reference-table__negative">{counts.shorts}</div>
          <div className="reference-stat__detail">Published active positions</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Net Positioning</div>
          <div className="reference-stat__value">{net > 0 ? '+' : ''}{net}</div>
          <div className="reference-stat__detail">{Number.isFinite(netPct) ? `${netPct > 0 ? '+' : ''}${netPct.toFixed(1)}% of gross count` : 'No active positions'}</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Latest Actions</div>
          <div className="reference-stat__value">{actionCount}</div>
          <div className="reference-stat__detail">Added and removed · {formatDate(snapshotDate)}</div>
        </div>
      </div>

      <div className="reference-card reference-change-card" style={{ marginTop: 6 }}>
        <div className="reference-card__header"><span>Latest ETF Pro Changes</span><span>{formatDate(snapshotDate)}</span></div>
        <div className="reference-change-card__body reference-change-card__body--four">
          <ChangeGroup label="Added Longs" values={changes.addedLongs || []} tone="positive" />
          <ChangeGroup label="Removed Longs" values={changes.removedLongs || []} tone="negative" />
          <ChangeGroup label="Added Shorts" values={changes.addedShorts || []} tone="negative" />
          <ChangeGroup label="Removed Shorts" values={changes.removedShorts || []} tone="positive" />
        </div>
      </div>

      <div className="reference-card" style={{ marginTop: 6 }}>
        <div className="reference-toolbar">
          <div className="reference-segments" role="tablist" aria-label="ETF Pro side filter">
            {['all', 'long', 'short'].map((value) => <button type="button" key={value} role="tab" aria-selected={side === value} className={`reference-segment ${side === value ? 'is-active' : ''}`} onClick={() => selectSide(value)}>{value === 'all' ? 'All' : `${value[0].toUpperCase()}${value.slice(1)}s`}</button>)}
          </div>
          <input className="reference-input" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Search ticker, ETF, or asset class" aria-label="Search ETF Pro positions" />
          <span className="reference-empty-inline">{filteredRows.length} positions · prices/ranges are published snapshot values</span>
        </div>
        <div className="reference-table-wrap">
          <table className="reference-table">
            <thead><tr>
              {[
                ['ticker', 'Ticker'], ['etf', 'ETF'], ['assetClass', 'Asset Class'], ['call', 'Call'],
                ['publishedPrice', 'Published Price'], ['rangeLow', 'Range Low'], ['rangeHigh', 'Range High'],
                ['dateAdded', 'Date Added'], ['daysHeld', 'Days'], ['absolutePerformance', 'Absolute'], ['relativePerformance', 'Relative'],
              ].map(([key, label]) => <th key={key} className="is-sortable" onClick={() => toggleSort(key)}>{label}{sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>)}
            </tr></thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id || `${row.ticker}-${row.call}`}>
                  <td className="reference-table__ticker">{row.ticker}</td>
                  <td>{row.etf || '—'}</td>
                  <td>{row.assetClass || '—'}</td>
                  <td className={row.call === 'Long' ? 'reference-table__positive' : 'reference-table__negative'}>{row.call}</td>
                  <td className="reference-table__number">{formatNumber(row.publishedPrice)}</td>
                  <td className="reference-table__number">{formatNumber(row.rangeLow)}</td>
                  <td className="reference-table__number">{formatNumber(row.rangeHigh)}</td>
                  <td>{formatDate(row.dateAdded)}</td>
                  <td className="reference-table__number">{Number.isFinite(row.daysHeld) ? row.daysHeld : '—'}</td>
                  <td className={`reference-table__number ${row.absolutePerformance > 0 ? 'reference-table__positive' : row.absolutePerformance < 0 ? 'reference-table__negative' : ''}`}>{formatPercent(row.absolutePerformance)}</td>
                  <td className={`reference-table__number ${row.relativePerformance > 0 ? 'reference-table__positive' : row.relativePerformance < 0 ? 'reference-table__negative' : ''}`}>{formatPercent(row.relativePerformance)}</td>
                </tr>
              ))}
              {!visibleRows.length && <tr><td colSpan="11" className="reference-table__empty">{loading ? 'Loading ETF Pro…' : 'No ETF Pro positions match this view.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && <div className="reference-pagination"><button type="button" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>‹</button><span>{safePage + 1} / {pageCount}</span><button type="button" disabled={safePage === pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>›</button></div>}
      </div>
    </ReferencePanelShell>
  );
};

export default EtfProPanel;
