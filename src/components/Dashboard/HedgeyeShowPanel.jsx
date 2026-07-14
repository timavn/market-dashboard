import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { isTradingDay } from '../../utils/marketHolidays';
import ReferencePanelShell from './ReferencePanelShell';

const NEW_YORK_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const formatDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const dateFromKey = (dateKey) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
};

const addDays = (dateKey, count) => {
  const date = dateFromKey(dateKey);
  date.setDate(date.getDate() + count);
  return formatDateKey(date);
};

const todayInNewYork = () => {
  const values = NEW_YORK_DATE_FORMATTER.formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${values.year}-${values.month}-${values.day}`;
};

export const getRecentShowMarketDays = (count = 5) => {
  const days = [];
  let cursor = dateFromKey(todayInNewYork());
  while (days.length < count) {
    if (isTradingDay(cursor)) {
      days.push({
        dateKey: formatDateKey(cursor),
        label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        dayOfWeek: cursor.toLocaleDateString('en-US', { weekday: 'long' }),
      });
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return days;
};

const effectiveSnapshotDate = (snapshot) => {
  if (typeof snapshot?.date !== 'string') return null;
  const cursor = dateFromKey(snapshot.date);
  while (!isTradingDay(cursor)) cursor.setDate(cursor.getDate() - 1);
  return formatDateKey(cursor);
};

const stripMacroBoilerplate = (value) => String(value || '')
  .replace(/\s*The summary and positions listed here reflect[\s\S]*$/i, '')
  .replace(/\s*Positions listed in order mentioned[\s\S]*$/i, '')
  .replace(/\s*CLICK HERE[\s\S]*$/i, '')
  .trim()
  .replace(/\s+([,.:;])/g, '$1')
  .replace(/\s{2,}/g, ' ');

export const getSnapshotPositions = (snapshot, side) => {
  const key = side === 'neutral' ? 'neutrals' : `${side}s`;
  const values = snapshot?.data?.[key];
  if (!Array.isArray(values)) return null;
  return values
    .map((value) => stripMacroBoilerplate(value))
    .filter((value) => value && !/^not of any strength$/i.test(value));
};

const resolveSnapshot = async (snapshotType, marketDayKey) => {
  for (const candidate of [marketDayKey, addDays(marketDayKey, 1), addDays(marketDayKey, 2)]) {
    const snapshot = await MarketDataService.getHedgeyeSnapshot(snapshotType, candidate);
    if (snapshot && effectiveSnapshotDate(snapshot) === marketDayKey) return snapshot;
  }
  return null;
};

const formatTimestamp = (value) => {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const positionDiff = (current, previous) => {
  if (!Array.isArray(current) || !Array.isArray(previous)) return null;
  const previousSet = new Set(previous || []);
  return (current || []).filter((value) => !previousSet.has(value));
};

const PositionPills = ({ values, tone }) => {
  if (values == null) return <span className="reference-empty-inline">Unavailable</span>;
  if (values.length === 0) return <span className="reference-empty-inline">None</span>;
  return (
    <div className="reference-pill-row">
      {values.map((value) => (
        <span key={value} className={`reference-pill reference-pill--${tone}`}>{value}</span>
      ))}
    </div>
  );
};

const HedgeyeShowPanel = ({ snapshotType, title, onClose }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const days = getRecentShowMarketDays(5);
    try {
      const snapshots = await Promise.all(days.map((day) => resolveSnapshot(snapshotType, day.dateKey)));
      setRows(days.map((day, index) => ({ ...day, snapshot: snapshots[index] || null })));
      if (!snapshots.some(Boolean)) setError(`No ${title} snapshots are available for the last five market days.`);
    } catch (loadError) {
      setRows(days.map((day) => ({ ...day, snapshot: null })));
      setError(loadError?.message || `Unable to load ${title}.`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [snapshotType, title]);

  useEffect(() => {
    load(false);
  }, [load]);

  const snapshots = useMemo(() => rows.filter((row) => row.snapshot), [rows]);
  const latestRow = snapshots[0] || null;
  const priorRow = snapshots[1] || null;
  const latest = latestRow?.snapshot || null;
  const prior = priorRow?.snapshot || null;
  const latestLongs = getSnapshotPositions(latest, 'long');
  const latestShorts = getSnapshotPositions(latest, 'short');
  const latestNeutrals = getSnapshotPositions(latest, 'neutral');
  const priorLongs = getSnapshotPositions(prior, 'long');
  const priorShorts = getSnapshotPositions(prior, 'short');
  const expectedDate = rows[0]?.dateKey;
  const isCurrent = Boolean(latestRow && latestRow.dateKey === expectedDate);
  const status = loading ? 'Loading' : error && !latest ? 'Unavailable' : isCurrent ? 'Current' : 'Older snapshot';
  const statusTone = loading ? 'neutral' : error && !latest ? 'error' : isCurrent ? 'fresh' : 'warning';
  const net = latestLongs && latestShorts ? latestLongs.length - latestShorts.length : null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = rows.filter((row) => {
    if (!normalizedQuery) return true;
    return ['long', 'short', 'neutral'].some((side) =>
      (getSnapshotPositions(row.snapshot, side) || []).some((value) => value.toLowerCase().includes(normalizedQuery))
    );
  });

  const subtitle = latest
    ? `Hedgeye email snapshot • Published ${latest.date || 'unavailable'} • Retrieved ${formatTimestamp(latest.scrapedAt)}`
    : 'Hedgeye email snapshot • No current data';

  return (
    <ReferencePanelShell
      title={title}
      subtitle={subtitle}
      status={status}
      statusTone={statusTone}
      onRefresh={() => load(true)}
      refreshing={refreshing}
      onClose={onClose}
    >
      {loading && <div className="reference-alert">Loading the latest five market-day snapshots…</div>}
      {error && <div className={`reference-alert ${latest ? '' : 'reference-alert--error'}`}>{error}</div>}

      <div className="reference-grid reference-grid--summary">
        {[
          ['Long', latestLongs?.length, latest?.date],
          ['Short', latestShorts?.length, latest?.date],
          ['Neutral', latestNeutrals?.length, latest?.date],
          ['Net', net == null ? null : `${net >= 0 ? '+' : ''}${net}`, 'Long count − short count'],
        ].map(([label, value, detail]) => (
          <div className="reference-card reference-stat" key={label}>
            <div className="reference-stat__label">{label}</div>
            <div className="reference-stat__value">{value ?? '—'}</div>
            <div className="reference-stat__detail">{detail || 'Unavailable'}</div>
          </div>
        ))}
      </div>

      <div className="reference-change-grid">
        <section className="reference-card">
          <div className="reference-card__header">Long changes vs {priorRow?.label || 'prior snapshot'}</div>
          <div className="reference-change-card__body">
            <div>
              <div className="reference-change-group__label">Added</div>
              <PositionPills values={positionDiff(latestLongs, priorLongs)} tone="positive" />
            </div>
            <div>
              <div className="reference-change-group__label">Removed</div>
              <PositionPills values={positionDiff(priorLongs, latestLongs)} tone="negative" />
            </div>
          </div>
        </section>
        <section className="reference-card">
          <div className="reference-card__header">Short changes vs {priorRow?.label || 'prior snapshot'}</div>
          <div className="reference-change-card__body">
            <div>
              <div className="reference-change-group__label">Added</div>
              <PositionPills values={positionDiff(latestShorts, priorShorts)} tone="negative" />
            </div>
            <div>
              <div className="reference-change-group__label">Removed</div>
              <PositionPills values={positionDiff(priorShorts, latestShorts)} tone="positive" />
            </div>
          </div>
        </section>
      </div>

      <section className="reference-card reference-show-history">
        <div className="reference-toolbar">
          <input
            className="reference-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${title} positions`}
            aria-label={`Search ${title} positions`}
          />
          <span className="reference-show-history__count">{snapshots.length} of 5 snapshots available</span>
        </div>
        <div className="reference-show-history__rows">
          {filteredRows.map((row) => {
            const snapshot = row.snapshot;
            return (
              <article className="reference-show-day" key={row.dateKey}>
                <div className="reference-show-day__date">
                  <strong>{row.label}</strong>
                  <span>{row.dayOfWeek}</span>
                  {snapshot?.article?.feedUrl && (
                    <a href={snapshot.article.feedUrl} target="_blank" rel="noreferrer">Source</a>
                  )}
                </div>
                <div className="reference-show-day__positions">
                  <div className="reference-show-side reference-show-side--long">
                    <span>Long</span>
                    <PositionPills values={getSnapshotPositions(snapshot, 'long')} tone="positive" />
                  </div>
                  <div className="reference-show-side reference-show-side--short">
                    <span>Short</span>
                    <PositionPills values={getSnapshotPositions(snapshot, 'short')} tone="negative" />
                  </div>
                  <div className="reference-show-side">
                    <span>Neutral</span>
                    <PositionPills values={getSnapshotPositions(snapshot, 'neutral')} tone="neutral" />
                  </div>
                </div>
              </article>
            );
          })}
          {filteredRows.length === 0 && <div className="reference-table__empty">No positions match this search.</div>}
        </div>
      </section>
    </ReferencePanelShell>
  );
};

export default HedgeyeShowPanel;
