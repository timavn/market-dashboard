import React, { useEffect, useMemo, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
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

function EtfProTable({ title, titleClass, rows, isExpanded, toggleSort, added, removed }) {
  const hasChanges = added.length > 0 || removed.length > 0;
  const addedSet = useMemo(() => new Set(added.map(t => t.toUpperCase())), [added]);
  const removedSet = useMemo(() => new Set(removed.map(t => t.toUpperCase())), [removed]);

  return (
    <div className="etfpro-pane">
      <div className={`etfpro-pane-title ${titleClass}`}>
        {title}
        <span className="etfpro-pane-count">{rows.length}</span>
      </div>

      {hasChanges && (
        <div className="etfpro-changes">
          {added.length > 0 && (
            <div className="etfpro-change-section">
              <div className="etfpro-change-header add">Added</div>
              <div className="etfpro-change-list">
                {added.map(t => <div key={t} className="etfpro-change-ticker add">{t}</div>)}
              </div>
            </div>
          )}
          {removed.length > 0 && (
            <div className="etfpro-change-section">
              <div className="etfpro-change-header remove">Removed</div>
              <div className="etfpro-change-list">
                {removed.map(t => <div key={t} className="etfpro-change-ticker remove">{t}</div>)}
              </div>
            </div>
          )}
        </div>
      )}

      <div className={isExpanded ? 'etfpro-pane-scroll expanded' : 'etfpro-pane-scroll'}>
        <table className="etfpro-table">
          <thead>
            <tr>
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
            {rows.map((r) => {
              const rel = r.relativePerformance;
              const relClass =
                Number.isFinite(rel) && rel !== 0 ? (rel > 0 ? 'pos' : 'neg') : '';
              const tk = String(r.ticker).toUpperCase();
              const rowHighlight = addedSet.has(tk) ? 'row-added' : '';
              return (
                <tr key={r.id} className={rowHighlight}>
                  <td className="mono">{r.ticker}</td>
                  <td className={`right mono ${relClass}`}>{formatSignedPercent(rel)}</td>
                  <td className="right mono">{Number.isFinite(r.daysHeld) ? r.daysHeld : '--'}</td>
                  {isExpanded && (
                    <>
                      <td className="wrap" title={r.etf}>{r.etf || '--'}</td>
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
                <td colSpan={isExpanded ? 10 : 3} className="etfpro-pane-empty">
                  None
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const EMPTY_CHANGES = {
  addedLongs: [], removedLongs: [], addedShorts: [], removedShorts: [], previousDate: null,
};

function isFreshForToday(snapshotDate) {
  if (!snapshotDate) return false;
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return snapshotDate === `${yyyy}-${mm}-${dd}`;
}

const EtfProCard = ({ isExpanded = false, onFreshness }) => {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [changes, setChanges] = useState(EMPTY_CHANGES);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'relativePerformance', dir: 'desc' });

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const snapshot = await MarketDataService.getHedgeyeEtfPro();
        if (!isMounted) return;
        setRows(Array.isArray(snapshot?.rows) ? snapshot.rows : []);
        setMeta(snapshot?.meta ?? null);
        setChanges(snapshot?.changes ?? EMPTY_CHANGES);
        if (onFreshness) onFreshness(isFreshForToday(snapshot?.meta?.snapshotDate));
      } catch (e) {
        if (!isMounted) return;
        const msg =
          e?.response?.data?.error ||
          e?.message ||
          'Failed to load ETF Pro snapshot. Run: npm run collect:etfpro';
        setError(msg);
        setRows([]);
        setMeta(null);
        setChanges(EMPTY_CHANGES);
        if (onFreshness) onFreshness(false);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
    };
  }, [onFreshness]);

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
      shortRows: sortRows(shorts, sort),
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
          No ETF Pro snapshot found yet. Run: <span className="mono">npm run collect:etfpro</span>
        </div>
      ) : (
        <div className="etfpro-split">
          <EtfProTable
            title="Longs"
            titleClass="long"
            rows={longRows}
            isExpanded={isExpanded}
            toggleSort={toggleSort}
            added={changes.addedLongs || []}
            removed={changes.removedLongs || []}
          />
          <EtfProTable
            title="Shorts"
            titleClass="short"
            rows={shortRows}
            isExpanded={isExpanded}
            toggleSort={toggleSort}
            added={changes.addedShorts || []}
            removed={changes.removedShorts || []}
          />
        </div>
      )}
    </div>
  );
};

export default EtfProCard;

