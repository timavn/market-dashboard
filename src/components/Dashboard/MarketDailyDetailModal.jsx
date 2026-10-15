import React, { useId, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import useMarketDailyResearch from '../../hooks/useMarketDailyResearch';
import { buildMarketDailyDetail, formatMarketDailyTime } from '../../utils/marketDailyNarrative';
import { describeMarketDailyResearch } from '../../utils/marketDailyResearch';
import { safeResearchUrl } from '../../utils/researchSourceUrl';
import AnalystSemanticText from './AnalystSemanticText';
import DelayedDataMarker from './DelayedDataMarker';
import './workspace/DashboardWorkspaceWindow.css';
import './MarketDailyDetailModal.css';

const dateLabel = formatMarketDailyTime;
const safeUrl = url => typeof url === 'string' && /^https:\/\//i.test(url) ? url : undefined;
const indexHeading = detail => ['breadth', 'leadership', 'movers', 'outliers'].includes(detail.id);
const detailHeading = detail => `${detail.title}${indexHeading(detail) ? ' · S&P 500' : ''}`;
const detailSubtitle = detail => indexHeading(detail) ? '' : detail.subtitle;
const MarketDailyTimestamp = ({ detail }) => {
  const delayed = !['LIVE', 'UNAVAILABLE'].includes(detail.status);
  return <span className="market-daily-detail__timestamp">{delayed
    ? <DelayedDataMarker status="delayed" updatedAt={detail.asOf} marketSessionDate={detail.marketDate}
      popoverLabel={`Updated ${dateLabel(detail.asOf) || 'time unavailable'}`} />
    : detail.status}</span>;
};

function MarketDailyTable({ detail, group }) {
  const layout = group.layout || (detail.id === 'outliers' ? 'securities' : 'metrics');
  const securities = layout === 'securities';
  const comparison = layout === 'comparison';
  return <table className={`market-daily-detail__table--${layout}`} aria-label={group.title}>
    {layout !== 'metrics' && <caption>{group.title}</caption>}
    {securities && <thead><tr><th scope="col">Ticker</th><th scope="col" className="market-daily-detail__security">Security</th><th scope="col" className="market-daily-detail__value">{group.valueLabel}</th></tr></thead>}
    {comparison && <thead><tr><th scope="col">Comparison</th><th scope="col" className="market-daily-detail__leg">First ETF</th><th scope="col" className="market-daily-detail__leg">Second ETF</th><th scope="col" className="market-daily-detail__value">Spread</th></tr></thead>}
    <tbody>{group.rows.map(row => <tr key={row.id} title={row.detail}>
      <th scope="row">{securities ? row.ticker || '—' : row.label}</th>
      {securities && <td className="market-daily-detail__security" title={[row.ticker, row.name].filter(Boolean).join(' · ')}>{row.name || '—'}</td>}
      {comparison && row.legs.map((leg, index) => <td key={index} className="market-daily-detail__leg" title={[leg.name, leg.detail].filter(Boolean).join('\n')}>
        <span>{leg.ticker}</span>{' '}<span className={`is-${leg.tone}`}>{leg.value}</span>
      </td>)}
      <td className={`market-daily-detail__value is-${row.tone || 'neutral'}`}>
        {row.valueParts?.length ? row.valueParts.map((part, index) => <span key={index} className={`is-${part.tone || 'neutral'}`}>{part.text}</span>) : row.value}
      </td>
    </tr>)}</tbody>
  </table>;
}

function MarketDailyDetailContent({ detail }) {
  const { items = [], loading } = useMarketDailyResearch({ enabled: Boolean(detail.marketDate), marketDate: detail.marketDate, tickers: detail.tickers });
  const assigned = new Set();
  const researchFor = group => {
    const selected = [];
    const seenTickers = new Set();
    const limit = detail.id === 'outliers' ? 3 : 2;
    for (const item of items) {
      const reading = `${item.ticker}:${item.horizon}:${item.direction}`;
      if (selected.length >= limit || assigned.has(reading) || !group.tickers?.includes(item.ticker)
        || ((detail.id === 'outliers' || group.layout === 'securities') && seenTickers.has(item.ticker))) continue;
      assigned.add(reading);
      seenTickers.add(item.ticker);
      selected.push(item);
    }
    return selected;
  };
  return <section className={`market-daily-detail__section market-daily-detail--${detail.id}`} aria-label={detail.title}>
          {detail.groups.map(group => {
            const research = researchFor(group);
            return <section className="market-daily-detail__group" key={group.id} aria-label={group.title}>
              <MarketDailyTable detail={detail} group={group} />
              {(group.narrative || group.description) && <p className="market-daily-detail__narrative"><AnalystSemanticText>{group.narrative || group.description}</AnalystSemanticText></p>}
              {research.length > 0 && <p className="market-daily-detail__research">
                {research.map((item, index) => <React.Fragment key={item.id}>
                  {index > 0 ? ' ' : ''}<AnalystSemanticText>{describeMarketDailyResearch(item, group.rows.flatMap(row => row.legs || [row]).find(row => row.ticker === item.ticker)?.changePercent)}</AnalystSemanticText>{' '}
                  <a href={safeResearchUrl(item.sourceUrl)} target="_blank" rel="noreferrer" title={`${item.sourceTitle} · ${dateLabel(item.publishedAt || item.publicationDate)}`}>{item.sourceTitle} · {dateLabel(item.publicationDate)} ↗</a>
                </React.Fragment>)}
              </p>}
            </section>;
          })}
          <footer className="market-daily-detail__footer">
            <details>
              <summary>Sources & definitions</summary>
              <p>{detail.methodology}</p>
              {detail.groups.flatMap(group => group.rows).map(row => <p key={row.id}><span>{[row.ticker, row.label].filter(Boolean).join(' · ')}. </span>{row.detail}</p>)}
              <div className="market-daily-detail__sources">{detail.sources.map(source => <a key={`${source.label}-${source.url}`} href={safeUrl(source.url)} target="_blank" rel="noreferrer">{source.label} ↗</a>)}</div>
              {items.map(item => <p key={item.id}><AnalystSemanticText>{item.text}</AnalystSemanticText>{' '}<a href={safeResearchUrl(item.sourceUrl)} target="_blank" rel="noreferrer">{item.sourceTitle} · {dateLabel(item.publishedAt || item.publicationDate)} ↗</a></p>)}
              {!loading && items.length === 0 && <p>Same-day Hedgeye evidence: unavailable for these securities.</p>}
            </details>
          </footer>
  </section>;
}

const renderedBorderWidth = (element, side) => {
  if (!element) return 0;
  const style = window.getComputedStyle(element);
  const borderWidth = parseFloat(style[side]) || 0;
  const layoutWidth = parseFloat(style.width) || element.offsetWidth;
  const scale = layoutWidth > 0 ? element.getBoundingClientRect().width / layoutWidth : 1;
  return borderWidth * scale;
};

export const getMarketDailyExpansionPosition = anchor => {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  // A shared divider belongs to the next card; include its rendered border so
  // the expansion's right rule lines up even when the dashboard is scaled.
  const nextPanel = anchor.nextElementSibling?.matches('.market-daily-strip__panel')
    ? anchor.nextElementSibling : null;
  const rightDivider = renderedBorderWidth(nextPanel || anchor.closest('.efr-topbar'),
    nextPanel ? 'borderLeftWidth' : 'borderRightWidth');
  const width = Math.max(0, Math.min(rect.width + rightDivider, window.innerWidth - 16));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.bottom;
  const dock = document.querySelector('.dashboard-bottom-navigation')?.getBoundingClientRect();
  const bottom = dock?.top > top ? dock.top - 8 : window.innerHeight - 72;
  return { left, top, width, maxHeight: Math.max(0, bottom - top) };
};

export default function MarketDailyDetailModal({ id, section, snapshot, rotationSnapshot, anchor }) {
  const detail = buildMarketDailyDetail(section, snapshot, rotationSnapshot);
  const title = detailHeading(detail);
  const subtitle = detailSubtitle(detail);
  const titleId = useId();
  const [position, setPosition] = useState(() => getMarketDailyExpansionPosition(anchor));

  useLayoutEffect(() => {
    const reposition = () => setPosition(getMarketDailyExpansionPosition(anchor));
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
    if (anchor) observer?.observe(anchor);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      observer?.disconnect();
    };
  }, [anchor]);

  return createPortal(
      <section id={id} className={`market-daily-detail market-daily-detail--expanded market-daily-detail--${section}`} style={position || { visibility: 'hidden' }} role="dialog" aria-modal="false" aria-labelledby={titleId}>
        <header className="market-daily-detail__header">
          <div className="market-daily-detail__heading"><h2 id={titleId} title={title}>{title}</h2>{subtitle && <p className="market-daily-detail__subtitle">{subtitle}</p>}</div>
          <MarketDailyTimestamp detail={detail} />
        </header>
        <div className="market-daily-detail__body">
          <MarketDailyDetailContent detail={detail} />
        </div>
      </section>
    , document.body,
  );
}
