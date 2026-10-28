import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { analystSemanticRanges } from './analystProcessColors';
import { portfolioReviewTickers, portfolioTickerRanges } from '../../utils/portfolioReviewTypography';
import { previousTradingDateKey } from '../../utils/usEquityMarketCalendar.cjs';
import { analystWorkspaceApi } from '../../services/analyst/analystClient';

// What this morning's Hedgeye products say about each market in a setup-board
// section, emitted by the renderer as an ```analyst-research JSON block: one
// entry per mention, with the product, its time, the part of the sentence about
// that market, and the full sentence when it was trimmed. Reported data
// ("Label: value" readings) also carries its facts, listed one per line.
const text = value => (typeof value === 'string' && value.trim() ? value : null);
const FACT = /^([^:·]{1,48}):\s+(\S[\s\S]*)$/;
const splitFact = value => {
  const match = String(value).match(FACT);
  return match ? [match[1], match[2]] : null;
};
// Reports saved before entries carried facts: a context of two or more "Label: value" parts is data.
function factsOf(entry) {
  if (Array.isArray(entry.facts)) {
    const facts = entry.facts.map(splitFact);
    return facts.length && facts.every(Boolean) ? facts : null;
  }
  const parts = entry.context.split(' · ').map(splitFact);
  return parts.length > 1 && parts.every(Boolean) ? parts : null;
}

export function parsePredictionResearch(raw) {
  try {
    const value = JSON.parse(String(raw || ''));
    const markets = Array.isArray(value?.markets) ? value.markets.filter(row => row && typeof row.market === 'string') : [];
    return markets.length ? {
      // Reports saved before blocks named their section and date have no date picker.
      section: text(value.section), marketDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.marketDate)) ? value.marketDate : null,
      markets: markets.map(row => ({
        market: row.market,
        entries: Array.isArray(row.entries)
          ? row.entries.filter(entry => entry && text(entry.product) && text(entry.context)).map(entry => ({
            product: entry.product, time: text(entry.time), date: text(entry.date), context: entry.context, source: text(entry.source),
            facts: factsOf(entry),
          }))
          // Reports saved before entries listed each product's facts and quotes.
          : (Array.isArray(row.items) ? row.items : []).filter(item => item && text(item.product)).map(item => ({
            product: item.product,
            time: text(item.time),
            date: null,
            context: (Array.isArray(item.facts) ? item.facts : []).map(fact => fact?.text).filter(text).join(' · '),
            source: (Array.isArray(item.quotes) ? item.quotes : []).filter(text).join(' ') || null,
            facts: null,
          })).filter(entry => entry.context),
      })),
    } : null;
  } catch {
    return null;
  }
}

// Typography only, as in the other reports: securities blue, quads in their colors,
// directions and signed moves green or red. Nothing here establishes a signal.
const TICKERS = new Set([...portfolioReviewTickers(), 'SPX', 'NDX', 'COMPQ', 'VIX', 'VXN', 'MOVE', 'DXY', 'BTC', 'ETH']);
const NAMES = ['U.S. Dollar Index', 'US Dollar Index', 'USD Index', 'U.S. Dollar', 'US Dollar', 'Bitcoin', '₿TC', 'Ethereum',
  'Gold', 'Silver', 'Copper', 'Crude Oil', 'Oil', 'WTI', 'S&P 500', 'SP500', 'Nasdaq-100', 'Nasdaq Composite', 'Composite Index',
  'NASDAQ', 'Nasdaq', 'Russell 2000', 'Russell', 'UST 2yr Yield', 'UST 10yr Yield', 'UST 30yr Yield', 'UST 2yr', 'UST 10yr',
  'UST 30yr', '10yr Yield', '2yr Yield', '30yr Yield', 'Treasury Bonds', 'CRB Index', '#NazVol', 'NazVol'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRanges = (value, extra) => {
  const names = [...new Set([...NAMES, ...extra.filter(Boolean)])].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\w#])(?:${names.map(escape).join('|')})(?![\\w])`, 'g');
  return [...value.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length, tone: 'ticker' }));
};
// Buy and Sell read as positions in the products' own words; "Long-term" is not one.
const ACTION_WORD = /\b(?:Long|Short|Buy|Sell|Sold|BUY|SELL)\b(?![-\w])/g;
const SIGNED = /(?<![\w.,])[+\-−]\d[\d,]*(?:\.\d+)?(?:\s?(?:%|bps?\b|basis points\b))?/g;
const MOVE_WORD = /\b(up|higher|rose|gained|rallied|down|lower|fell|lost|dropped|declined)\s+(?:(?:almost|nearly|about|another|only|roughly|approximately)\s+)?(\d[\d,]*(?:\.\d+)?\s?(?:%|bps?\b|basis points\b))/gi;
const RISING = /^(?:up|higher|rose|gained|rallied)$/i;
const VALUE_TONE = { positive: 'positive', negative: 'negative' };

function researchRanges(value, names = []) {
  const ranges = [];
  const add = range => {
    if (range.end > range.start && !ranges.some(other => range.start < other.end && range.end > other.start)) ranges.push(range);
  };
  const whole = VALUE_TONE[value.trim().toLowerCase()];
  if (whole) add({ start: value.indexOf(value.trim()), end: value.indexOf(value.trim()) + value.trim().length, tone: whole });
  analystSemanticRanges(value, 'research').forEach(add);
  for (const match of value.matchAll(ACTION_WORD)) {
    add({ start: match.index, end: match.index + match[0].length, tone: /^(?:long|buy)/i.test(match[0]) ? 'positive' : 'negative' });
  }
  for (const match of value.matchAll(SIGNED)) {
    add({ start: match.index, end: match.index + match[0].length, tone: /^\+/.test(match[0]) ? 'positive' : 'negative' });
  }
  for (const match of value.matchAll(MOVE_WORD)) {
    const start = match.index + match[0].length - match[2].length;
    add({ start, end: start + match[2].length, tone: RISING.test(match[1]) ? 'positive' : 'negative' });
  }
  nameRanges(value, names).forEach(add);
  portfolioTickerRanges(value, TICKERS).forEach(add);
  return ranges.sort((a, b) => a.start - b.start);
}

function ResearchText({ value, names }) {
  const pieces = [];
  let cursor = 0;
  researchRanges(value, names).forEach(({ start, end, tone }) => {
    if (start > cursor) pieces.push(value.slice(cursor, start));
    pieces.push(<span key={start} className={`analyst-process--${tone}`}>{value.slice(start, end)}</span>);
    cursor = end;
  });
  if (cursor < value.length) pieces.push(value.slice(cursor));
  return pieces;
}

function Facts({ facts, names }) {
  return <ul className="analyst-research__facts">
    {facts.map(([label, value], index) => <li key={`${label}-${index}`}>
      <span className="analyst-research__fact-label"><ResearchText value={label} names={names} /></span>
      <span className="analyst-research__fact-value"><ResearchText value={value} names={names} /></span>
    </li>)}
  </ul>;
}

function Entry({ entry, market, first, span }) {
  const [open, setOpen] = useState(false);
  const names = [market];
  return <tr className={first ? 'analyst-research__first' : undefined}>
    {first && <td className="analyst-research__market" rowSpan={span}>{market}</td>}
    <td className="analyst-research__product" title={entry.time ? `${entry.date ? `${entry.date} ` : ''}${entry.time} PT` : undefined}>{entry.product}</td>
    <td className="analyst-research__context">
      {entry.facts ? <Facts facts={entry.facts} names={names} /> : <ResearchText value={entry.context} names={names} />}
      {open && <blockquote className="analyst-research__quote"><ResearchText value={entry.source} names={names} /></blockquote>}
    </td>
    <td className="analyst-research__source">
      {entry.source && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>Source</button>}
    </td>
  </tr>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = date => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
// The report's market day and the four before it.
export function researchDays(marketDate) {
  const days = [marketDate];
  while (days.length < 5) days.push(previousTradingDateKey(days.at(-1)));
  return days;
}

// The research table's title: the market day it shows. Clicking it opens the other four of the last five
// market days in a list flush above the cell; picking one reads what was said that day.
function DayPicker({ days, shown, onPick }) {
  const [open, setOpen] = useState(false);
  const cell = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (event.type === 'keydown' ? event.key === 'Escape' : !cell.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return <th ref={cell} className="analyst-research__day">
    <button type="button" className="analyst-research__day-button" aria-haspopup="listbox" aria-expanded={open}
      aria-label={`Research for ${dayLabel(shown)}; choose another day`} onClick={() => setOpen(value => !value)}>
      {dayLabel(shown)} <span aria-hidden="true">▾</span>
    </button>
    {open && <ul className="analyst-research__days" role="listbox" aria-label="Earlier market days">
      {days.filter(day => day !== shown).map(day => <li key={day} role="option" aria-selected="false">
        <button type="button" onClick={() => { setOpen(false); onPick(day); }}>{dayLabel(day)}</button>
      </li>)}
    </ul>}
  </th>;
}

export default function AnalystPredictionResearch({ research: saved }) {
  const [shown, setShown] = useState(saved.marketDate);
  const [earlier, setEarlier] = useState({});
  const days = saved.marketDate && saved.section ? researchDays(saved.marketDate) : null;
  const reading = shown && shown !== saved.marketDate ? earlier[shown] || { status: 'loading' } : null;
  const research = reading?.status === 'ready' ? reading.research : saved;
  const pick = day => {
    setShown(day);
    if (day === saved.marketDate || earlier[day]?.status === 'ready') return;
    setEarlier(current => ({ ...current, [day]: { status: 'loading' } }));
    analystWorkspaceApi.request(`/prediction-research?date=${day}`).then(result => {
      const block = parsePredictionResearch(JSON.stringify(result?.sections?.[saved.section] || null));
      setEarlier(current => ({ ...current, [day]: block ? { status: 'ready', research: block } : { status: 'empty' } }));
    }, () => setEarlier(current => ({ ...current, [day]: { status: 'failed' } })));
  };
  // Every fact list in the table shares the widest label's column, so values line up across entries
  // (Market Structure's signals and its levels read as one column of values).
  const frame = useRef(null);
  useLayoutEffect(() => {
    if (!frame.current) return;
    // Measure each list at its own width first, so a narrower update can shrink the shared column.
    frame.current.style.removeProperty('--analyst-fact-label-width');
    const labels = [...frame.current.querySelectorAll('.analyst-research__fact-label')];
    const width = Math.max(0, ...labels.map(label => label.getBoundingClientRect().width));
    if (width > 0) frame.current.style.setProperty('--analyst-fact-label-width', `${Math.ceil(width)}px`);
  }, [research]);
  return <section ref={frame} className="analyst-table-frame analyst-research" aria-label="Morning research">
    <table>
      <colgroup>
        <col className="analyst-research__market-col" />
        <col className="analyst-research__product-col" />
        <col />
        <col className="analyst-research__source-col" />
      </colgroup>
      <thead><tr><th>Market</th><th>Product</th>
        <th>Context</th>{days ? <DayPicker days={days} shown={shown} onPick={pick} /> : <th aria-label="Source" />}</tr></thead>
      <tbody>
        {reading && reading.status !== 'ready' ? <tr className="analyst-research__first">
          <td className="analyst-research__quiet" colSpan={4}>{reading.status === 'loading' ? `Reading ${dayLabel(shown)}…`
            : reading.status === 'empty' ? `No research read for ${dayLabel(shown)}.` : `Research for ${dayLabel(shown)} is unavailable.`}</td>
        </tr> : research.markets.map(row => (row.entries.length
          ? row.entries.map((entry, index) => <Entry key={`${row.market}-${index}`} entry={entry} market={row.market}
            first={index === 0} span={row.entries.length} />)
          : <tr key={row.market} className="analyst-research__first">
            <td className="analyst-research__market">{row.market}</td>
            {/* A sentence that already reads under another market adds nothing here. */}
            <td className="analyst-research__quiet" colSpan={3}>Not mentioned</td>
          </tr>))}
      </tbody>
    </table>
  </section>;
}
