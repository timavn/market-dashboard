import React, { useId, useState } from 'react';
import { previewQuarters } from '../../utils/globalQuadsPeriods';
import './GlobalQuadsCard.css';
import LoadingIndicator from '../common/LoadingIndicator';

export { previewQuarters } from '../../utils/globalQuadsPeriods';

const LABELS = { global: 'All countries', g20: 'G20', em: 'Emerging markets' };
const dateLabel = value => value ? new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US',
  { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
const sourceTitle = source => source ? `Hedgeye · As of ${dateLabel(source.asOf)}` : '';

const PERIOD_TITLES = { previous: 'Previous quarter', current: 'Current quarter', estimate: 'Estimate' };

export const QuadCell = ({ value, sources = {} }) => {
  const source = sources[value?.sourceId];
  if (!source || ![1, 2, 3, 4].includes(value?.quad)) return <span className="global-quads-reading global-quads-reading--missing">—</span>;
  return <a className={`global-quads-reading global-quads-reading--${value.quad}`}
    href={`${process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'}${source.imageUrl}`}
    target="_blank" rel="noreferrer"
    title={`${sourceTitle(source)} · ${value.kind === 'estimate' ? 'Estimate' : 'Actual'}`}>
    {value.quad}
  </a>;
};

function QuadTable({ columns, rows, sources, label, compact = false }) {
  const bands = columns.reduce((result, column) => {
    const previous = result[result.length - 1];
    if (previous && previous.kind === column.kind) previous.count += 1;
    else result.push({ kind: column.kind, count: 1, start: column.id });
    return result;
  }, []);
  const startsEstimates = index => columns[index].kind === 'estimate' && index > 0 && columns[index - 1].kind !== 'estimate';
  const columnClass = index => compact && columns[index].period === 'current'
    ? 'global-quads-current-quarter'
    : !compact && startsEstimates(index) ? 'global-quads-estimate-start' : undefined;
  return <table className={`global-quads-grid${compact ? ' global-quads-grid--compact' : ''}`}
    aria-label={label} style={{ '--global-quads-columns': columns.length }}>
    <colgroup><col className="global-quads-country-col" />{columns.map(c => <col key={c.id} />)}</colgroup>
    <thead>
      {!compact && <tr className="global-quads-bands">
        <th scope="col" rowSpan={2} className="global-quads-country">Country / region</th>
        {bands.map((band, index) => <th key={band.start} scope="colgroup" colSpan={band.count}
          className={index > 0 && band.kind === 'estimate' ? 'global-quads-estimate-start' : undefined}>
          {band.kind === 'estimate' ? 'Estimates' : 'Actuals'}
        </th>)}
      </tr>}
      <tr>{compact && <th scope="col" className="global-quads-country">Market</th>}
        {columns.map((c, index) => <th key={c.id} scope="col"
          className={columnClass(index)}
          title={PERIOD_TITLES[c.period] || (c.kind === 'estimate' ? 'Published estimate' : 'Published actual')}>{c.label}</th>)}
      </tr>
    </thead>
    <tbody>{rows.map(row => <tr key={row.country} className={row.aggregate ? 'global-quads-aggregate' : undefined}>
      <th scope="row" className="global-quads-country">{compact && row.aggregate ? `G20 ${row.country.toLowerCase()}` : row.country}</th>
      {columns.map((c, index) => <td key={c.id} className={columnClass(index)}>
        <QuadCell value={row.values[c.id]} sources={sources} />
      </td>)}
    </tr>)}</tbody>
  </table>;
}

export function QuadsPreview({ snapshot, loading }) {
  const group = snapshot?.data?.groups?.g20;
  const sources = snapshot?.data?.sources || {};
  const columns = previewQuarters(group);
  const rows = group?.rows || [];
  const preferred = [rows.find(r => r.aggregate), ...['United States', 'China', 'Germany', 'Japan', 'United Kingdom', 'Canada', 'India', 'South Korea', 'Australia', 'Brazil'].map(name => rows.find(r => r.country === name))]
    .filter(row => row && group.currentCountries.includes(row.country));
  if (!preferred.length || !columns.length) return <div className="efr-preview-empty">{loading ? <LoadingIndicator label="Loading…" size="sm" /> : 'UNAVAILABLE'}</div>;
  return <div className="global-quads-preview">
    <QuadTable columns={columns} rows={preferred} sources={sources} label="G20 quad preview" compact />
  </div>;
}

export default function GlobalQuadsCard({ resourceState }) {
  const [activeGroup, setActiveGroup] = useState(null);
  const panelId = useId();
  const snapshot = resourceState?.data;
  const groups = snapshot?.data?.groups || {};
  const sources = snapshot?.data?.sources || {};
  const selectedId = activeGroup || Object.keys(LABELS).find(id => groups[id]) || 'g20';
  const group = groups[selectedId];
  const source = sources[group?.sourceId];
  const tabs = Object.entries(LABELS).filter(([id]) => id !== 'global' || groups[id] || selectedId === id);
  const onTabKeyDown = (event, index) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
    setActiveGroup(tabs[next][0]);
  };
  if (!Object.keys(groups).length) return <p className="global-quads-empty">{resourceState?.initialLoading ? <LoadingIndicator label="Loading…" size="sm" /> : 'UNAVAILABLE'}</p>;
  return <div className="global-quads-full">
    <div className="global-quads-toolbar">
      <div role="tablist" aria-label="Global Quads tables" className="global-quads-tabs">
        {tabs.map(([id, label], index) => <button key={id} type="button" role="tab"
          id={`${panelId}-${id}`} aria-controls={`${panelId}-table`} aria-selected={selectedId === id}
          tabIndex={selectedId === id ? 0 : -1} onClick={() => setActiveGroup(id)} onKeyDown={event => onTabKeyDown(event, index)}>
          {label}
        </button>)}
      </div>
      {source && <div className="global-quads-sources">
          <span>As of {dateLabel(group.asOf)}</span>
          {source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">Email</a>}
          <a href={`${process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001'}${source.imageUrl}`} target="_blank" rel="noreferrer">Source chart</a>
      </div>}
    </div>
    <section id={`${panelId}-table`} role="tabpanel" aria-labelledby={`${panelId}-${selectedId}`}>
      {!group ? <p className="global-quads-empty">UNAVAILABLE</p> : <div className="global-quads-scroll" key={selectedId}>
        <QuadTable columns={group.columns} rows={group.rows} sources={sources} label={`${LABELS[selectedId]} published quad readings`} />
      </div>}
    </section>
    <p className="global-quads-date">E = published estimate.</p>
  </div>;
}
