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

const EtfProCard = ({ isExpanded = false }) => {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
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
      } catch (e) {
        if (!isMounted) return;
        const msg =
          e?.response?.data?.error ||
          e?.message ||
          'Failed to load ETF Pro snapshot. Run: npm run collect:etfpro';
        setError(msg);
        setRows([]);
        setMeta(null);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    load();
    return () => {
      isMounted = false;
    };
  }, []);

  const sortedRows = useMemo(() => {
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
  }, [rows, sort]);

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' };
      return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' };
    });
  };

  return (
    <div className="etfpro-body">
      <div className="etfpro-upload-row">
        <div className="etfpro-upload-meta">
          <div className="etfpro-upload-meta-line">
            {meta?.snapshotDate ? `Snapshot: ${meta.snapshotDate}` : 'Snapshot: --'}
          </div>
          <div className="etfpro-upload-meta-line subtle">
            Parsed: {meta?.parsedAt ? formatDateTime(meta.parsedAt) : '--'}
          </div>
        </div>
        <div className="etfpro-source">
          {meta?.sourceFile ? meta.sourceFile.split('/').slice(-1)[0] : ''}
        </div>
      </div>

      {error && <div className="etfpro-error">{error}</div>}

      {loading ? (
        <div className="etfpro-empty">Loading ETF Pro…</div>
      ) : rows.length === 0 ? (
        <div className="etfpro-empty">
          No ETF Pro snapshot found yet. Run: <span className="mono">npm run collect:etfpro</span>
        </div>
      ) : (
        <div className={isExpanded ? 'etfpro-table-scroll expanded' : 'etfpro-table-scroll'}>
          <table className="etfpro-table">
            <thead>
              <tr>
                <th className="clickable" onClick={() => toggleSort('ticker')}>
                  Ticker
                </th>
                <th className="clickable" onClick={() => toggleSort('call')}>
                  Call
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
              {sortedRows.map((r) => {
                const rel = r.relativePerformance;
                const relClass =
                  Number.isFinite(rel) && rel !== 0 ? (rel > 0 ? 'pos' : 'neg') : '';

                return (
                  <tr key={r.id}>
                    <td className="mono">{r.ticker}</td>
                    <td>
                      <span className={String(r.call).toLowerCase() === 'short' ? 'pill short' : 'pill long'}>
                        {r.call || '--'}
                      </span>
                    </td>
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
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default EtfProCard;

