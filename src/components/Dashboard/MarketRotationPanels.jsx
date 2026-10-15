import React from 'react';
import catalog from '../../constants/marketRotationCatalog.json';
import useMarketRotationSnapshot, { validateMarketRotationSnapshot } from '../../hooks/useMarketRotationSnapshot';
import DelayedDataMarker from './DelayedDataMarker';
import './MarketRotationPanels.css';

const signed = (value, unit = '%') => Number.isFinite(value)
  ? `${value > 0 ? '+' : ''}${value.toFixed(2)}${unit === '%' ? '%' : ` ${unit}`}` : '—';
const tone = value => !Number.isFinite(value) || value === 0 ? 'is-neutral' : value > 0 ? 'is-positive' : 'is-negative';
const time = value => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York',
  }).formatToParts(parsed);
  const part = type => parts.find(entry => entry.type === type)?.value || '';
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ET`;
};
const quoteDetail = row => row ? [
  `${row.name} · ${row.ticker} · ETF proxy · ${signed(row.changePercent)} for the observed session`,
  `${row.retained ? 'D · Last verified reading · ' : ''}DELAYED · ${time(row.asOf)}${row.marketDate ? ` · Session ${row.marketDate}` : ''}`,
  row.source, row.sourceUrl, row.issuerUrl,
].filter(Boolean).join('\n') : 'UNAVAILABLE';

const Value = ({ value, unit }) => <span className={`market-daily-strip__number ${tone(value)}`}>{signed(value, unit)}</span>;

const RotationPanel = ({ title, label, variant, detail, rows, loading, onExpand, expanded = false, detailId, children }) => {
  const observations = rows.flatMap(row => row.left && row.right ? [row.left, row.right] : [row]);
  const observation = [...observations].sort((left, right) => Date.parse(left.asOf) - Date.parse(right.asOf))[0];
  const marker = observation && <DelayedDataMarker
    status={observations.some(row => row.retained) ? 'refresh-delayed' : 'delayed'}
    updatedAt={observation.asOf}
    marketSessionDate={observation.marketDate}
    popoverLabel={`Updated ${time(observation.asOf)}`}
    className="market-daily-strip__status"
  />;
  return (
    <section className={`market-daily-strip__panel market-rotation-panel market-rotation-panel--${variant}`} data-daily-section={variant} aria-label={label} aria-busy={loading && rows.length === 0}>
      <h2 className="market-daily-strip__heading" title={detail}>
        {onExpand ? <button type="button" className="market-daily-strip__expand" onClick={onExpand} aria-label={`Expand ${label.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}>
          <span>{title}</span>
        </button> : <span>{title}</span>}
        {marker}
      </h2>
      {children}
    </section>
  );
};

export const MarketThemePanel = ({ themes, loading = false, onExpand, expanded, detailId }) => {
  const coverage = themes?.coverage;
  const roster = catalog.themes.map(row => `${row.name} (${row.ticker})`).join(', ');
  const detail = `Daily ETF price returns versus the prior regular-session close.\nLeading and lagging refer to this tracked ${catalog.themes.length}-ETF universe: ${roster}.\nVerified: ${coverage?.verified ?? 0} / ${catalog.themes.length}. Rankings require the complete, comparable universe.\nETF exposures can overlap; they are proxies for the named themes.`;
  const rows = [
    { key: 'software', label: 'Software', named: false },
    { key: 'semiconductors', label: 'Semiconductors', named: false },
    { key: 'leader', label: 'Leading theme', named: true },
    { key: 'laggard', label: 'Lagging theme', named: true },
  ];
  return (
    <RotationPanel variant="themes" title="THEMES · ETF PROXIES" label="Market themes" detail={detail} rows={rows.map(({ key }) => themes?.[key]).filter(Boolean)} loading={loading} onExpand={onExpand} expanded={expanded} detailId={detailId}>
      <table className="market-daily-strip__table market-rotation-panel__themes" aria-label="Daily theme returns">
        <colgroup><col className="market-daily-strip__label-col" /><col /></colgroup>
        <tbody>{rows.map(({ key, label, named }) => {
          const row = themes?.[key];
          return (
            <tr key={key} title={`${named ? `${detail}\n` : ''}${quoteDetail(row)}`}>
              <td>{label}</td>
              <td className="market-daily-strip__value">
                {row ? <span className="market-daily-strip__named-value">
                  <span className="market-daily-strip__security" title={`${row.name} (${row.ticker})`}>{named ? row.name : row.ticker}</span>
                  <Value value={row.changePercent} />
                </span> : <Value />}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </RotationPanel>
  );
};

export const MarketFactorPanel = ({ factors = [], loading = false, onExpand, expanded, detailId }) => {
  const rows = factors.filter(row => Number.isFinite(row?.spreadPp));
  const detail = 'Daily ETF return spreads in percentage points (pp): first ETF minus second ETF. Positive means the first exposure is outperforming; negative means the second is outperforming.\nEach ETF return uses its prior regular-session close. These are public ETF comparisons, not isolated factor returns or proprietary bank baskets.';
  return (
    <RotationPanel variant="factors" title="FACTORS · ETF SPREADS" label="Market factors" detail={detail} rows={rows} loading={loading} onExpand={onExpand} expanded={expanded} detailId={detailId}>
      <table className="market-daily-strip__table market-rotation-panel__factors" aria-label="Daily factor spreads">
        <colgroup><col className="market-daily-strip__label-col" /><col /></colgroup>
        <tbody>{catalog.factors.map(definition => {
          const row = factors.find(item => item.id === definition.id);
          return (
            <tr key={definition.id} title={`${detail}\n${definition.label}: ${definition.left} − ${definition.right}\n${quoteDetail(row?.left)}\n${quoteDetail(row?.right)}`}>
              <td>{definition.label}</td>
              <td className="market-daily-strip__value"><Value value={row?.spreadPp} unit="pp" /></td>
            </tr>
          );
        })}</tbody>
      </table>
    </RotationPanel>
  );
};

export default function MarketRotationPanels({ snapshot: suppliedSnapshot }) {
  const { snapshot: fetchedSnapshot, loading } = useMarketRotationSnapshot({ enabled: suppliedSnapshot === undefined });
  const snapshot = validateMarketRotationSnapshot(suppliedSnapshot === undefined ? fetchedSnapshot : suppliedSnapshot, Date.now(), true);
  return <>
    <MarketThemePanel themes={snapshot?.themes} loading={loading} />
    <MarketFactorPanel factors={snapshot?.factors} loading={loading} />
  </>;
}
