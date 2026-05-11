import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { isFreshForToday } from '../../utils/dateFreshness';
import './EtfProCard.css';

function formatSignedPercent(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toFixed(2);
}

function formatDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString();
}

function compareMaybeNumber(a, b, dir) {
  const av = Number.isFinite(a) ? a : null;
  const bv = Number.isFinite(b) ? b : null;
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

function compareMaybeString(a, b, dir) {
  const av = String(a ?? '').toLowerCase();
  const bv = String(b ?? '').toLowerCase();
  if (av === bv) return 0;
  if (dir === 'asc') return av < bv ? -1 : 1;
  return av > bv ? -1 : 1;
}

function sortRows(rows, sort) {
  const copy = [...rows];
  const { key, dir } = sort;
  copy.sort((a, b) => {
    if (key === 'ticker') return compareMaybeString(a.ticker, b.ticker, dir);
    if (key === 'call') return compareMaybeString(a.call, b.call, dir);
    if (key === 'daysHeld') return compareMaybeNumber(a.daysHeld, b.daysHeld, dir);
    if (key === 'relativePerformance') {
      return compareMaybeNumber(a.relativePerformance, b.relativePerformance, dir);
    }
    if (key === 'absolutePerformance') {
      return compareMaybeNumber(a.absolutePerformance, b.absolutePerformance, dir);
    }
    return 0;
  });
  return copy;
}

/** Matches Workflow Signal Strength changelog bars — M/D from YYYY-MM-DD. */
function formatChangesBarDate(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).trim();
  const withTime = s.includes('T') ? s : `${s.split(' ')[0]}T12:00:00`;
  const d = new Date(withTime);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

const EMPTY_CHANGES = {
  addedLongs: [],
  removedLongs: [],
  addedShorts: [],
  removedShorts: [],
  previousDate: null,
};

function EtfProPaneTitle({ title, count, type }) {
  const labelColor = type === 'long' ? '#15803d' : type === 'short' ? '#b91c1c' : '#111';
  return (
    <div className="etfpro-pane-title">
      <span className="etfpro-pane-title-label" style={{ color: labelColor }}>{title.toUpperCase()}</span>
      <span className="etfpro-pane-count">{count}</span>
    </div>
  );
}

function renderTickerWrap(arr, pillClass) {
  const list = Array.isArray(arr) ? arr : [];
  return (
    <div className="etfpro-change-pill-row">
      {list.length > 0 ? (
        list.map((t) => (
          <span key={t} className={`etfpro-change-pill ${pillClass}`}>
            {t}
          </span>
        ))
      ) : (
        <span className="etfpro-change-na">N/A</span>
      )}
    </div>
  );
}

/** Added / Removed blue-bar sections with LONGS · SHORTS (matches Workflow Signal Strength hierarchy). */
function EtfProStackedChanges({ changes, snapshotDate }) {
  const c = changes || EMPTY_CHANGES;
  const bar = formatChangesBarDate(snapshotDate);

  return (
    <div className="etfpro-stacked-changes">
      <div className="etfpro-change-bluebar">
        <span>Added</span>
        <span className="etfpro-change-bluebar-date">{bar ? `(${bar})` : ''}</span>
      </div>
      <div className="etfpro-change-leg">
        <div className="etfpro-change-leg-title etfpro-change-leg-long">LONGS</div>
        {renderTickerWrap(c.addedLongs, 'add')}
      </div>
      <div className="etfpro-change-leg">
        <div className="etfpro-change-leg-title etfpro-change-leg-short">SHORTS</div>
        {renderTickerWrap(c.addedShorts, 'add')}
      </div>

      <div className="etfpro-change-bluebar">
        <span>Removed</span>
        <span className="etfpro-change-bluebar-date">{bar ? `(${bar})` : ''}</span>
      </div>
      <div className="etfpro-change-leg">
        <div className="etfpro-change-leg-title etfpro-change-leg-long">LONGS</div>
        {renderTickerWrap(c.removedLongs, 'remove')}
      </div>
      <div className="etfpro-change-leg">
        <div className="etfpro-change-leg-title etfpro-change-leg-short">SHORTS</div>
        {renderTickerWrap(c.removedShorts, 'remove')}
      </div>
    </div>
  );
}

const DEFAULT_VISIBLE = 9;

function EtfProTable({ rows, isExpanded, toggleSort, newlyAdded }) {
  const [showAll, setShowAll] = useState(false);
  const addedSet = useMemo(
    () => new Set((Array.isArray(newlyAdded) ? newlyAdded : []).map((t) => String(t).toUpperCase())),
    [newlyAdded]
  );

  const visibleRows = isExpanded || showAll ? rows : rows.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = rows.length - visibleRows.length;

  return (
    <div className="etfpro-pane">
      <div className={isExpanded ? 'etfpro-pane-scroll expanded' : 'etfpro-pane-scroll'}>
        <table className="etfpro-table">
          <thead>
            <tr>
              <th className="etfpro-col-num">#</th>
              <th className="clickable" onClick={() => toggleSort('ticker')}>
                Ticker
              </th>
              <th className="clickable right" onClick={() => toggleSort('relativePerformance')}>
                Rel
              </th>
              <th className="clickable right" onClick={() => toggleSort('daysHeld')}>
                Days
              </th>
              {isExpanded && (
                <>
                  <th>ETF</th>
                  <th>Asset Class</th>
                  <th className="right clickable" onClick={() => toggleSort('absolutePerformance')}>
                    Abs
                  </th>
                  <th className="right">S&amp;P</th>
                  <th className="right">Last</th>
                  <th>Date Added</th>
                  <th>As of</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, idx) => {
              const rel = r.relativePerformance;
              const relClass =
                Number.isFinite(rel) && rel !== 0 ? (rel > 0 ? 'pos' : 'neg') : '';
              const tk = String(r.ticker).toUpperCase();
              const rowHighlight = addedSet.has(tk) ? 'row-added' : '';
              return (
                <tr key={r.id} className={rowHighlight}>
                  <td className="etfpro-col-num mono">{idx + 1}</td>
                  <td className="mono">{r.ticker}</td>
                  <td className={`right mono ${relClass}`}>{formatSignedPercent(rel)}</td>
                  <td className="right mono">{Number.isFinite(r.daysHeld) ? r.daysHeld : '--'}</td>
                  {isExpanded && (
                    <>
                      <td className="wrap" title={r.etf}>
                        {r.etf || '--'}
                      </td>
                      <td className="wrap">{r.assetClass || '--'}</td>
                      <td className="right mono">{formatSignedPercent(r.absolutePerformance)}</td>
                      <td className="right mono">{formatSignedPercent(r.sp500)}</td>
                      <td className="right mono">{formatPrice(r.lastPrice)}</td>
                      <td className="mono">{r.dateAdded || '--'}</td>
                      <td className="mono">{r.asOf ? formatDateTime(r.asOf) : '--'}</td>
                    </>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={isExpanded ? 11 : 4} className="etfpro-pane-empty">
                  None
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {hiddenCount > 0 && !isExpanded && (
          <button
            type="button"
            className="etfpro-show-more"
            onClick={() => setShowAll(true)}
          >
            +{hiddenCount} more ∨
          </button>
        )}
        {showAll && !isExpanded && rows.length > DEFAULT_VISIBLE && (
          <button
            type="button"
            className="etfpro-show-more"
            onClick={() => setShowAll(false)}
          >
            ∧ show less
          </button>
        )}
      </div>
    </div>
  );
}

const EtfProCard = ({ isExpanded = false, onFreshness }) => {
  const [rows, setRows] = useState([]);
  const [changes, setChanges] = useState(EMPTY_CHANGES);
  const [snapshotDate, setSnapshotDate] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'relativePerformance', dir: 'desc' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await MarketDataService.getHedgeyeEtfPro();
      setRows(Array.isArray(snapshot?.rows) ? snapshot.rows : []);
      setSnapshotDate(snapshot?.meta?.snapshotDate || null);
      setChanges(
        snapshot?.changes && typeof snapshot.changes === 'object' ? { ...EMPTY_CHANGES, ...snapshot.changes } : EMPTY_CHANGES
      );
      if (onFreshness) onFreshness(isFreshForToday(snapshot?.meta?.snapshotDate));
    } catch (e) {
      const msg =
        e?.response?.data?.error ||
        e?.message ||
        'Failed to load ETF Pro. Run npm run collect:etfpro to sync from the ETF Pro folder.';
      setError(msg);
      setRows([]);
      setSnapshotDate(null);
      setChanges(EMPTY_CHANGES);
      if (onFreshness) onFreshness(false);
    } finally {
      setLoading(false);
    }
  }, [onFreshness]);

  useEffect(() => {
    load();
  }, [load]);

  const { longRows, shortRows } = useMemo(() => {
    const longs = [];
    const shorts = [];
    for (const r of rows) {
      if (String(r.call).toLowerCase() === 'short') {
        shorts.push(r);
      } else {
        longs.push(r);
      }
    }
    return {
      longRows: sortRows(longs, sort),
      shortRows: sortRows(shorts, sort)
    };
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' };
      return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
    });
  };

  return (
    <div className="etfpro-body">
      {error && <div className="etfpro-error">{error}</div>}

      {loading ? (
        <div className="etfpro-empty">Loading ETF Pro…</div>
      ) : rows.length === 0 ? (
        <div className="etfpro-empty">
          No ETF Pro data yet. Run <span className="mono">npm run collect:etfpro</span> to pull the
          latest workbook from the ETF Pro folder.
        </div>
      ) : (
        <div className="etfpro-split-stack">
          <EtfProStackedChanges changes={changes} snapshotDate={snapshotDate} />
          <div className="etfpro-columns">
            <div className="etfpro-column etfpro-column-long">
              <EtfProPaneTitle title="Longs" count={longRows.length} type="long" />
              <EtfProTable
                rows={longRows}
                isExpanded={isExpanded}
                toggleSort={toggleSort}
                newlyAdded={changes.addedLongs}
              />
            </div>
            <div className="etfpro-column etfpro-column-short">
              <EtfProPaneTitle title="Shorts" count={shortRows.length} type="short" />
              <EtfProTable
                rows={shortRows}
                isExpanded={isExpanded}
                toggleSort={toggleSort}
                newlyAdded={changes.addedShorts}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EtfProCard;
