import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { isFreshForToday } from '../../utils/dateFreshness';
import './EtfProCard.css';

function formatSignedPercent(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
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

const ETFPRO_PAGE_SIZE_FALLBACK = 9;
const ETFPRO_ROW_APPROX_PX = 26;
const ETFPRO_THEAD_APPROX_PX = 30;
const ETFPRO_PAGINATION_RESERVE_PX = 36;

function EtfProTable({ rows, toggleSort, newlyAdded }) {
  const [page, setPage] = useState(0);
  const scrollRef = useRef(null);
  const [pageSize, setPageSize] = useState(ETFPRO_PAGE_SIZE_FALLBACK);
  const addedSet = useMemo(
    () => new Set((Array.isArray(newlyAdded) ? newlyAdded : []).map((t) => String(t).toUpperCase())),
    [newlyAdded]
  );

  useEffect(() => {
    setPage(0);
  }, [rows]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      setPageSize(ETFPRO_PAGE_SIZE_FALLBACK);
      return undefined;
    }
    const compute = () => {
      const thead = el.querySelector('thead');
      const th = thead?.offsetHeight ?? ETFPRO_THEAD_APPROX_PX;
      const h = el.clientHeight;
      const avail = Math.max(0, h - th - ETFPRO_PAGINATION_RESERVE_PX);
      const n = Math.max(3, Math.min(60, Math.floor(avail / ETFPRO_ROW_APPROX_PX)));
      setPageSize(n);
    };
    const ro = new ResizeObserver(() => compute());
    ro.observe(el);
    compute();
    return () => ro.disconnect();
  }, [rows]);

  const effectivePageSize = Math.max(pageSize, 1);
  const totalPages = Math.max(1, Math.ceil(rows.length / effectivePageSize));

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  const visibleRows = rows.slice(page * effectivePageSize, (page + 1) * effectivePageSize);

  return (
    <div className="etfpro-pane">
      <div
        ref={scrollRef}
        className="etfpro-pane-scroll"
      >
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
                  <td className="etfpro-col-num mono">
                    {page * effectivePageSize + idx + 1}
                  </td>
                  <td className="mono">{r.ticker}</td>
                  <td className={`right mono ${relClass}`}>{formatSignedPercent(rel)}</td>
                  <td className="right mono">{Number.isFinite(r.daysHeld) ? r.daysHeld : '--'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="etfpro-pane-empty">
                  None
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="etfpro-pagination">
            <button
              type="button"
              className="etfpro-page-btn"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >‹</button>
            <span className="etfpro-page-info">{page + 1}/{totalPages}</span>
            <button
              type="button"
              className="etfpro-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >›</button>
          </div>
        )}
      </div>
    </div>
  );
}

const EtfProCard = ({ onFreshness }) => {
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
                toggleSort={toggleSort}
                newlyAdded={changes.addedLongs}
              />
            </div>
            <div className="etfpro-column etfpro-column-short">
              <EtfProPaneTitle title="Shorts" count={shortRows.length} type="short" />
              <EtfProTable
                rows={shortRows}
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
