import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import AnalystReportLink from './AnalystReportLink';
import AnalystPredictionRangeBar, { parsePredictionRange, predictionRangeLabel } from './AnalystPredictionRangeBar';
import AnalystPredictionDrivers, { parsePredictionDrivers } from './AnalystPredictionDrivers';
import AnalystPredictionResearch, { parsePredictionResearch } from './AnalystPredictionResearch';
import AnalystPredictionSizing, { parsePredictionSizing } from './AnalystPredictionSizing';
import AnalystPredictionLines, { parsePredictionLines } from './AnalystPredictionLines';
import AnalystKalshiBook, { parseKalshiBook } from './AnalystKalshiBook';
import remarkGfm from 'remark-gfm';
import { remarkAnalystProcessColors } from './analystProcessColors';
import { predictionReportSources } from './analystPredictionSources';
import { foldPredictionAlphaCode, onceAcrossPredictionResearch, pinPredictionDollar, predictionReportTables, splitPredictionZScore } from './analystPredictionTables';
import { presentAnalystReportDates } from '../../utils/analystReportDates';
import './AnalystPredictionReport.css';

const nodeText = node => node?.type === 'text' ? node.value : (node?.children || []).map(nodeText).join('');
const reportPlugins = [remarkGfm, [remarkAnalystProcessColors, { reviewKind: 'prediction-markets-review' }]];
const dateValue = /^(?:(?:Published|As of|Since|Initiated|Last close) )?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: \d{1,2},)? \d{4}(?: \d{2}:\d{2} [A-Z]{2,4})?$/i;
const shortReading = /^(?:Last known\s+)?(?:Long|Short|Buy|Wait|Watch|Bullish|Bearish|Neutral)$/i;
// Setup board stacked cells: BIAS(direction;date;product) and MKT(name;sub-label). Boards with price history add
// the 20-session Z-score as a third field, and NAME(name;;z) carries it for a market with no sub-label.
// An optional fourth field explains a Neutral read from a broken Alpha Code line (tooltip only).
const BIAS_TOKEN = /^BIAS\((Bullish|Bearish|Neutral|N\/A);([^;()]*);([^;()]*)(?:;([^;()]*))?\)$/;
const MARKET_TOKEN = /^(MKT|REF)\(([^;()]+);([^;()]+)\)$|^(MKT|REF|NAME)\(([^;()]+);([^;()]*);([-+]\d+(?:\.\d+)?)?\)$/;
// ASOF(pulled;tickDate,tickProduct;tradeDate,tradeProduct;trendDate,trendProduct)
const AS_OF_TOKEN = /^ASOF\(([^;()]*);([^;()]*),([^;()]*);([^;()]*),([^;()]*);([^;()]*),([^;()]*)\)$/;
// ALPHA(trade;trend;tradeRel;trendRel;unit;approximate;product): this morning's Alpha Code with the price above or below each level.
const ALPHA_TOKEN = /^ALPHA\(([^;()]*);([^;()]*);(above|below|at|);(above|below|at|);(%?);([01]);([^;()]*)\)$/;
// STRUCT(lowSteps;lowRun;highSteps;highRun;ath;athDate;athPct;topAbove;unit[;volume;tone[;direction]]): the Risk Range
// against its earlier publications. Steps run oldest to today as + (higher), - (lower) or = (unchanged); runs are signed
// counts ending today. Boards with volume add DV/AV, how it reads for the Trend (supports, warns or confirms), and
// later boards the day's direction (+ up, - down).
const STRUCTURE_TOKEN = /^STRUCT\(([-+=]*);([-+]?\d+);([-+=]*);([-+]?\d+);([^;()]*);([^;()]*);([-+]?\d*);([01]);(%?)(?:;(DV|AV)?;(supports|warns|confirms)?(?:;([-+]?))?)?\)$/;
// VOL(d1;d15;d30;d90;date;symbol[;side]): the latest session's ETF volume against the prior session and its 15-, 30- and
// 90-calendar-day averages, in signed whole percents. Drawn under Tick, Trade and Trend, or one window to a cell
// under Z, Tick, Trade and Trend when the board has a Z column. Side is the day's move with (+) or against (-) the Trend.
const VOLUME_TOKEN = /^VOL\(([-+]?\d*);([-+]?\d*);([-+]?\d*);([-+]?\d*);([^;()]*);([^;()]*)(?:;([-+]?))?\)$/;
const VOLUME_WINDOWS = ['1D', '15D', '30D', '90D'];
// A signed number reads by its own sign everywhere on the site: up green, down red, zero plain.
const windowTone = value => (value > 0 ? ' is-on' : value < 0 ? ' is-against' : '');
const VOLUME_SIDE = { '-': ' · Day against the Trend', '+': ' · Day with the Trend' };
function VolumeCell({ match, split, ...span }) {
  const [, d1, d15, d30, d90, date, symbol, side] = match;
  const values = [d1, d15, d30, d90];
  const label = values.every(value => value === '') ? 'Volume unavailable'
    : `${symbol} volume${date ? ` on ${date}` : ''} vs the prior session and its 15-, 30- and 90-day averages${VOLUME_SIDE[side] || ''}`;
  const windows = VOLUME_WINDOWS.map((key, index) => {
    const value = values[index] === '' ? null : Number(values[index]);
    const tone = value === null ? '' : windowTone(value);
    return <span key={key} className={`analyst-prediction-volume__window${tone}`}>
      <span className="analyst-prediction-volume__key">{key}</span>
      <span className="analyst-prediction-volume__value">{value === null ? 'N/A' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}%`}</span>
    </span>;
  });
  if (split) return <>{windows.map(window => <td key={window.key} className="analyst-prediction-volume-cell is-window" title={label}>{window}</td>)}</>;
  return <td {...span} className="analyst-prediction-volume-cell" title={label}>
    <span className="analyst-prediction-volume">{windows}</span>
  </td>;
}
// Z(z): the market's 20-session Z-score, a signal cell before Tick; two or more standard deviations reads heavier.
const Z_TOKEN = /^Z\(([-+]\d+(?:\.\d+)?)?\)$/;
function ZCell({ match }) {
  const z = match[1];
  return <td className="analyst-prediction-z-cell" title={`Z-score ${z || 'N/A'} vs. the prior 20 daily closes`}>
    <span className={`analyst-prediction-stack analyst-prediction-z${z && Math.abs(Number(z)) >= 2 ? ' analyst-prediction-z--stretched' : ''}${z ? '' : ' analyst-prediction-stack--muted'}`}>
      {z ? z.replace('-', '−') : 'N/A'}
    </span>
  </td>;
}
const RELATION = { above: ['▲', 'analyst-process--positive', 'price above'], below: ['▼', 'analyst-process--negative', 'price below'], at: ['=', 'analyst-prediction-stack--muted', 'price at'] };
// Two-digit days keep the right-aligned As of dates in one column: Sep 9 -> Sep 09.
const padDay = date => date.replace(/^([A-Za-z]{3}) (\d)\b/, '$1 0$2');
const BIAS_CLASS = { Bullish: 'analyst-process--positive', Bearish: 'analyst-process--negative' };
const STEP_CLASS = { '+': 'is-higher', '-': 'is-lower', '=': 'is-unchanged' };
const STEP_LABEL = { '+': 'higher', '-': 'lower', '=': 'unchanged' };
// Today's move as HL/LL/=L for lows and HH/LH/=H for highs.
const todayMove = (steps, leg) => {
  const step = steps.at(-1);
  const text = step === '+' ? (leg === 'low' ? 'HL' : 'HH') : step === '-' ? (leg === 'low' ? 'LL' : 'LH') : `=${leg === 'low' ? 'L' : 'H'}`;
  return { text, tone: step === '+' ? ' is-on' : step === '-' ? ' is-against' : '' };
};
const runLabel = (run, leg) => {
  const count = Number(run);
  if (!count) return { text: '—', className: 'analyst-prediction-stack--muted' };
  const higher = count > 0;
  return { text: `${higher ? 'H' : 'L'}${leg === 'low' ? 'L' : 'H'} ${Math.abs(count)}`,
    className: higher ? 'analyst-process--positive' : 'analyst-process--negative' };
};
// The ATH line opens a small note under it with the date the record was set.
function AthLine({ level, distance, date }) {
  const [open, setOpen] = useState(false);
  const reading = <>
    <span className="analyst-prediction-structure-record">{level}</span>
    {distance && <span className="analyst-prediction-structure-distance">{` : ${distance}`}</span>}
  </>;
  if (!date) return <span className="analyst-prediction-stack">{reading}</span>;
  return <span className="analyst-prediction-structure-ath">
    <button type="button" className="analyst-prediction-structure-ath__toggle" aria-expanded={open}
      onClick={() => setOpen(value => !value)} onBlur={() => setOpen(false)}
      onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>{reading}</button>
    {open && <span role="tooltip" className="analyst-prediction-structure-ath__date">ATH on {date}</span>}
  </span>;
}
// Hedgeye reads volume against the Trend: a move against it on DV is a buy (Bullish) or short (Bearish) setup,
// on AV a warning. A move with the Trend on AV confirms it; on DV it says nothing either way and keeps the plain outline.
const VOLUME_TONE = { supports: ' is-on', warns: ' is-against', confirms: ' is-on' };
const VOLUME_ARROW = { '+': '↑', '-': '↓' };
const VOLUME_SENTENCE = { DV: 'volume below its 30-day average', AV: 'volume above its 30-day average' };
const VOLUME_DAY = { '+': 'Up day on ', '-': 'Down day on ' };
const VOLUME_READING = { supports: ' (against the Trend: setup)', warns: ' (against the Trend: warning)',
  confirms: ' (with the Trend: confirmation)' };
function StructureCell({ match, ...span }) {
  const [, lowSteps, lowRun, highSteps, highRun, ath, athDate, athPct, topAbove, unit, volume, volumeTone, direction] = match;
  const legs = [['high', highSteps, highRun], ['low', lowSteps, lowRun]];
  const moves = [todayMove(lowSteps, 'low'), todayMove(highSteps, 'high'),
    { text: 'ATH', tone: topAbove === '1' ? ' is-record' : '' },
    ...(volume ? [{ text: `${VOLUME_ARROW[direction] || ''}${volume}`, tone: VOLUME_TONE[volumeTone] || '' }] : [])];
  // The level reads blue; after a black colon, how far price is below it (a + marks price above it).
  const athLevel = topAbove === '1' ? `Top > ATH ${ath}${unit}` : `ATH ${ath}${unit}`;
  const pct = Number(athPct);
  const athDistance = athPct ? `${pct > 0 ? '+' : ''}${Math.abs(pct)}%` : null;
  // The tooltip says in words what the percent is: price against the all-time high.
  const record = `${ath}${unit}${athDate ? ` (${athDate})` : ''}`;
  const athSentence = !ath ? 'All-time high unavailable'
    : topAbove === '1' ? `Range top above the all-time high of ${record}`
      : !athPct ? `All-time high ${record}`
        : pct === 0 ? `Price at the all-time high of ${record}`
          : `Price ${Math.abs(pct)}% ${pct < 0 ? 'below' : 'above'} the all-time high of ${record}`;
  const label = [`Today ${moves.map(move => move.text).join(' ')}`,
    ...legs.map(([leg, , run]) => runLabel(run, leg).text), athSentence,
    ...(volume ? [`${VOLUME_DAY[direction] || 'Day on '}${VOLUME_SENTENCE[volume]}${VOLUME_READING[volumeTone] || ' (not against the Trend)'}`] : [])].join(' · ');
  return <td {...span} className="analyst-prediction-structure-cell" title={label}>
    <span className="analyst-prediction-stack analyst-prediction-structure-moves">
      {moves.map(move => <span key={move.text} className={`analyst-prediction-structure-move${move.tone}`}>{move.text}</span>)}
    </span>
    {legs.map(([leg, steps, run]) => {
      const count = runLabel(run, leg);
      return <span key={leg} className="analyst-prediction-stack analyst-prediction-structure-leg">
        <span className={`analyst-prediction-structure-count ${count.className}`}>{count.text}</span>
        <span className="analyst-prediction-structure-steps" aria-label={`${leg === 'low' ? 'Lows' : 'Highs'}, oldest to today: ${[...steps].map(step => STEP_LABEL[step]).join(', ')}`}>
          {[...steps].map((step, index) => <i key={index} className={STEP_CLASS[step]} />)}
        </span>
      </span>;
    })}
    {ath ? <AthLine level={athLevel} distance={athDistance} date={athDate} />
      : <span className="analyst-prediction-stack analyst-prediction-stack--muted">ATH N/A</span>}
  </td>;
}
function cellFor({ node, children }) {
  const text = nodeText(node).trim();
  const structure = text.match(STRUCTURE_TOKEN);
  if (structure) return <StructureCell match={structure} />;
  const volume = text.match(VOLUME_TOKEN);
  if (volume) return <VolumeCell match={volume} />;
  const zScore = text.match(Z_TOKEN);
  if (zScore) return <ZCell match={zScore} />;
  const bias = text.match(BIAS_TOKEN);
  if (bias) {
    const [, direction, date, product, note] = bias;
    const label = [direction, date, product, note].filter(Boolean).join(' · ');
    return <td className="analyst-prediction-bias-cell" title={label}>
      <span className={`analyst-prediction-stack ${BIAS_CLASS[direction] || 'analyst-prediction-stack--muted'}`}>{direction}</span>
      {date && <span className="analyst-prediction-stack">{date}</span>}
      {product && <span className="analyst-prediction-stack analyst-prediction-stack--muted">{product}</span>}
    </td>;
  }
  const market = text.match(MARKET_TOKEN);
  if (market) {
    const [kind, name, sub] = market[1] ? market.slice(1, 4) : market.slice(4, 7);
    const scored = !market[1];
    const z = market[7];
    const label = [name, sub, scored && `Z-score ${z || 'N/A'} vs. the prior 20 daily closes`].filter(Boolean).join(' · ');
    return <td className={kind === 'REF' ? 'analyst-prediction-reference-cell' : undefined} title={label}>
      <span className="analyst-prediction-stack">{name}</span>
      {sub && <span className="analyst-prediction-stack analyst-prediction-stack--muted">{sub}</span>}
      {scored && <span className="analyst-prediction-stack analyst-prediction-z">
        <span className="analyst-prediction-stack__key">Z</span>{' '}
        {z ? <span className={Math.abs(Number(z)) >= 2 ? 'analyst-prediction-z--stretched' : undefined}>{z.replace('-', '−')}</span>
          : <span className="analyst-prediction-stack--muted">N/A</span>}
      </span>}
    </td>;
  }
  const alpha = text.match(ALPHA_TOKEN);
  if (alpha) {
    const [, trade, trend, tradeRel, trendRel, unit, approximate, product] = alpha;
    const prefix = approximate === '1' ? '~' : '';
    const lines = [['Ta', 'Trade', trade, tradeRel], ['Te', 'Trend', trend, trendRel]];
    const label = ['Alpha Code', ...lines.map(([, name, value, relation]) => value
      ? `${name} ${prefix}${value}${unit}${relation ? ` (${RELATION[relation][2]})` : ''}` : `${name} N/A`), product].filter(Boolean).join(' · ');
    return <td className="analyst-prediction-alpha-cell" title={label}>
      {lines.map(([key, , value, relation]) => <span key={key} className="analyst-prediction-stack analyst-prediction-alpha-line">
        <span className="analyst-prediction-stack__key">{key}</span>{' '}
        {value ? <span className="analyst-prediction-alpha-line__value">{prefix}{value}{unit}</span> : <span className="analyst-prediction-stack--muted">N/A</span>}
        {value && relation && <span className={`analyst-prediction-alpha-line__relation ${RELATION[relation][1]}`} aria-label={RELATION[relation][2]}>{RELATION[relation][0]}</span>}
      </span>)}
      {product && <span className="analyst-prediction-stack analyst-prediction-stack--muted">{product}</span>}
    </td>;
  }
  const asOf = text.match(AS_OF_TOKEN);
  if (asOf) {
    const [, pulled, ...rest] = asOf;
    const lines = [['Ti', rest[0], rest[1]], ['Ta', rest[2], rest[3]], ['Te', rest[4], rest[5]]];
    const label = [pulled, ...lines.map(([key, date, product]) => `${key} ${date ? `${date} ${product}`.trim() : 'N/A'}`)].join(' · ');
    return <td className="analyst-prediction-as-of-cell" title={label}>
      <span className="analyst-prediction-stack analyst-process--key analyst-prediction-as-of-pulled">{pulled}</span>
      {lines.map(([key, date, product]) => <span key={key} className="analyst-prediction-stack analyst-prediction-as-of-line">
        <span className="analyst-prediction-stack__key">{key}</span>{' '}
        <span className="analyst-prediction-as-of-line__product analyst-prediction-stack--muted">{date ? product : ''}</span>{date && product ? ' ' : ''}
        <span className={`analyst-prediction-as-of-line__date${date ? '' : ' analyst-prediction-stack--muted'}`}>{date ? padDay(date) : 'N/A'}</span>
      </span>)}
    </td>;
  }
  const range = parsePredictionRange(nodeText(node));
  if (range) return <td className="analyst-prediction-range-cell" title={predictionRangeLabel(range).text}><AnalystPredictionRangeBar range={range} /></td>;
  const value = presentAnalystReportDates(nodeText(node));
  const dates = value.split(' · ');
  const className = shortReading.test(value) ? 'analyst-prediction-short-reading' : /^(?:N\/A|—)$/.test(value.trim()) ? 'is-na' : undefined;
  return <td title={value} className={className}>{dates.every(date => dateValue.test(date))
    ? dates.map((date, index) => <React.Fragment key={`${date}-${index}`}>{index > 0 && ' · '}<span className="analyst-prediction-cell-date analyst-process--key">{date}</span></React.Fragment>)
    : children}</td>;
}
// The row renderer spans cells over the volume row, or splits the volume into one cell per window, by passing
// rowSpan/colSpan/split through.
const MarkdownCell = ({ rowSpan, colSpan, split, ...props }) => {
  const cell = cellFor(props);
  return rowSpan || colSpan || split ? React.cloneElement(cell, { rowSpan, colSpan, split }) : cell;
};
const isVolumeHeading = cell => cell.tagName === 'th' && /^Volume$/i.test(nodeText(cell).trim());
const isVolumeCell = cell => cell.tagName === 'td' && VOLUME_TOKEN.test(nodeText(cell).trim());
const isZCell = cell => cell.tagName === 'td' && Z_TOKEN.test(nodeText(cell).trim());
// Boards with volume carry it as a column after Trend; Tick, Trade and Trend take the top half of the row
// and the volume windows span the three of them underneath, while the other cells run the full height.
// With a Z column before Tick, Z joins the top half and each volume window sits in its own cell under one of the four.
const MarkdownRow = ({ node, children }) => {
  const cells = (node?.children || []).filter(child => child.tagName === 'td' || child.tagName === 'th');
  const elements = React.Children.toArray(children).filter(React.isValidElement);
  const volume = cells.findIndex(cell => isVolumeHeading(cell) || isVolumeCell(cell));
  if (volume < 3 || elements.length !== cells.length) return <tr>{children}</tr>;
  const rest = elements.filter((_cell, index) => index !== volume);
  if (cells[volume].tagName === 'th') return <tr>{rest}</tr>;
  const zed = cells.findIndex(isZCell) === volume - 4;
  const signal = index => index >= volume - (zed ? 4 : 3) && index < volume;
  return <>
    <tr>{rest.map((cell, index) => (signal(index) ? cell : React.cloneElement(cell, { rowSpan: 2 })))}</tr>
    <tr className="analyst-prediction-volume-row">{React.cloneElement(elements[volume], zed ? { split: true } : { colSpan: 3 })}</tr>
  </>;
};
const MarkdownTable = ({ children, node }) => {
  const heading = node?.children?.find(child => child.tagName === 'thead')?.children?.find(child => child.tagName === 'tr');
  const headings = (heading?.children || []).filter(child => child.tagName === 'th').map(nodeText);
  const dated = /^(?:Date|As of|Last updated|Statistics date)$/i.test(headings.at(-1)?.trim() || '');
  const tickers = /^(?:Ticker|Symbol|Securities)$/i.test(headings[0]?.trim() || '');
  const securities = tickers && /^(?:Security|Company|Issuer)(?: name)?$/i.test(headings[1]?.trim() || '');
  const labels = /^(?:Metric|Signal|Factor)$/i.test(headings[0]?.trim() || '');
  const tickComparison = headings.join('|') === 'Ticker|Security|Tick|Contribution|Initiated|Bull history|Bear history|Statistics date';
  // Setup boards: saved captures used separate Price/Risk Range/In range columns; current ones use one range bar.
  const rangeBoard = headings.some(label => /^Price and Risk Range$/i.test(label.trim()));
  const alphaBoard = rangeBoard && headings.some(label => /^Alpha Code$/i.test(label.trim()));
  const structureBoard = rangeBoard && headings.some(label => /^Structure\b/i.test(label.trim()));
  const zBoard = rangeBoard && /^Z$/.test(headings[1]?.trim() || '');
  const setupBoard = rangeBoard || (headings.some(label => /^Setup$/i.test(label.trim()))
    && headings.some(label => /^In range$/i.test(label.trim())));
  // CPI nowcast: Low in red, Base as is, High in green.
  const nowcast = /^(?:Nowcast low|Low)\|Base\|High$/i.test(headings.slice(2, 5).map(label => label.trim()).join('|'));
  // The single US Dollar row pinned above the sections stays in view while the report scrolls.
  const bodyRows = node?.children?.find(child => child.tagName === 'tbody')?.children?.filter(child => child.tagName === 'tr') || [];
  const pinned = bodyRows.length === 1 && /^REF\(US Dollar;/.test(nodeText(bodyRows[0].children?.find(child => child.tagName === 'td')).trim());
  const contractComparison = headings.some(label => /^Outcome$/i.test(label.trim()))
    && headings.some(label => /^Market-implied odds$/i.test(label.trim()));
  const contractColumn = label => {
    if (!contractComparison) return undefined;
    if (/^Level$/i.test(label.trim())) return 'analyst-prediction-contract-level-col';
    if (/^Outcome$/i.test(label.trim())) return 'analyst-prediction-contract-outcome-col';
    if (/^Side$/i.test(label.trim())) return 'analyst-prediction-contract-side-col';
    if (/^Price$/i.test(label.trim())) return 'analyst-prediction-contract-price-col';
    if (/^Market-implied odds$/i.test(label.trim())) return 'analyst-prediction-contract-odds-col';
    if (/^Gross reward\/risk \(before fees\)$/i.test(label.trim())) return 'analyst-prediction-contract-payoff-col';
    return undefined;
  };
  const frameClass = `analyst-table-frame${dated ? ' has-dates' : ''}${tickers ? ' has-tickers' : ''}${securities ? ' has-securities' : ''}${labels ? ' has-labels' : ''}${tickComparison ? ' is-tick-comparison' : ''}${contractComparison ? ' is-contract-comparison' : ''}${setupBoard ? ' is-setup-board' : ''}${rangeBoard ? ' is-range-board' : ''}${alphaBoard ? ' has-alpha' : ''}${structureBoard ? ' has-structure' : ''}${zBoard ? ' has-z' : ''}${rangeBoard && headings.some(label => /^Setup$/i.test(label.trim())) ? ' has-setup' : ''}${nowcast ? ' is-nowcast' : ''}${pinned ? ' is-pinned-dollar' : ''}`;
  // The volume column draws inside the signal columns, so it has no column of its own.
  const columns = rangeBoard ? headings.filter(label => !/^Volume$/i.test(label.trim())) : headings;
  const table = <table>{columns.length > 0 && <colgroup>{columns.map((label, index) => <col key={`${label}-${index}`} className={
      contractColumn(label) || (index === 0 && tickers ? 'analyst-prediction-ticker-col'
        : index === 1 && securities ? 'analyst-prediction-security-col'
          : index === 0 && labels ? 'analyst-prediction-metric-col'
            : index === columns.length - 1 && dated ? 'analyst-prediction-date-col' : undefined)
    } />)}
    </colgroup>}{children}</table>;
  return pinned ? <PinnedFrame className={frameClass}>{table}</PinnedFrame> : <div className={frameClass}>{table}</div>;
};
// While the pinned frame is stuck it masks the transcript's top padding, so rows scrolling under it never show above it.
function PinnedFrame({ className, children }) {
  const marker = useRef(null);
  const frame = useRef(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let scroller = frame.current?.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return undefined;
    let pending = 0;
    const measure = () => {
      pending = 0;
      if (marker.current && frame.current) setStuck(marker.current.getBoundingClientRect().top < frame.current.getBoundingClientRect().top - 1);
    };
    const onScroll = () => { if (!pending) pending = requestAnimationFrame(measure); };
    measure();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); cancelAnimationFrame(pending); };
  }, []);
  return <>
    <div ref={marker} aria-hidden="true" className="analyst-pinned-marker" />
    <div ref={frame} className={`${className}${stuck ? ' is-stuck' : ''}`}>{children}</div>
  </>;
}
// ```analyst-drivers blocks carry a section's shared variables, ```analyst-sizing its setups'
// positions and line splits, ```analyst-lines its markets' foldable Kalshi lines, ```analyst-kalshi-book the whole Kalshi
// account, and ```analyst-research its markets' morning research; other code blocks render normally.
const MarkdownPre = ({ node, children }) => {
  const code = node?.children?.find(child => child.tagName === 'code');
  const classes = [].concat(code?.properties?.className || []);
  const drivers = classes.includes('language-analyst-drivers') ? parsePredictionDrivers(nodeText(code)) : null;
  if (drivers) return <AnalystPredictionDrivers drivers={drivers} />;
  const sizing = classes.includes('language-analyst-sizing') ? parsePredictionSizing(nodeText(code)) : null;
  if (sizing) return <AnalystPredictionSizing sizing={sizing} />;
  const lines = classes.includes('language-analyst-lines') ? parsePredictionLines(nodeText(code)) : null;
  if (lines) return <AnalystPredictionLines lines={lines} />;
  const book = classes.includes('language-analyst-kalshi-book') ? parseKalshiBook(nodeText(code)) : null;
  if (book) return <AnalystKalshiBook book={book} />;
  const research = classes.includes('language-analyst-research') ? parsePredictionResearch(nodeText(code)) : null;
  return research ? <AnalystPredictionResearch research={research} /> : <pre>{children}</pre>;
};
const SourceButton = ({ group, onCitation, children }) => <button type="button" className="analyst-prediction-source"
  aria-label={`Source: ${group.label}`} title={group.source.title || group.label}
  onClick={() => onCitation?.(group.source, group.context)}>{children || group.label}</button>;

const FOOTER_LINE = /^(Sources?:\s|Paper tickets:|Research read for\b)/i;
const AnalystPredictionReport = memo(function AnalystPredictionReport({ messageId, markdown, citations, onCitation, error }) {
  const report = useMemo(() => {
    const sourced = predictionReportSources(markdown, citations);
    // Saved reports titled the CPI nowcast's first column "Nowcast low".
    return { ...sourced, markdown: onceAcrossPredictionResearch(pinPredictionDollar(splitPredictionZScore(foldPredictionAlphaCode(predictionReportTables(sourced.markdown)))))
      .replace(/^(\| Market \| Kalshi \| )Nowcast low( \| Base \| High \|)/gm, '$1Low$2')
      // Setup boards saved before Status was named for their publication times.
      .replace(/^(\| Market \| (?:Z \| )?Tick \|.*\| )As of \(PT\)( \|)$/gm, '$1Status$2')
      // Boards saved while Structure carried its session count in the title.
      .replace(/^(\| Market \| (?:Z \| )?Tick \|.*\| )Structure \(\d+d\)( \|)/gm, '$1Structure$2') };
  }, [markdown, citations]);
  const parts = useMemo(() => {
    const match = report.markdown.match(/<details data-analyst-hedgai>\s*<summary>([^<\n]+)<\/summary>\s*([\s\S]*?)\s*<\/details>/);
    return match ? { body: report.markdown.replace(match[0], ''), title: match[1].replace(/^HedgAI comparison\b/, 'Tick comparison'), detail: match[2] } : { body: report.markdown };
  }, [report.markdown]);
  const components = useMemo(() => ({
    table: MarkdownTable,
    td: MarkdownCell,
    tr: MarkdownRow,
    pre: MarkdownPre,
    // Older captures keep their original evidence and publication names. Only
    // the generated signal-field label follows today's Tick terminology.
    strong: ({ node, children }) => <strong>{nodeText(node) === 'HedgAI:' ? 'Tick:' : children}</strong>,
    a: ({ href, children }) => report.links.has(href)
      ? <SourceButton group={report.links.get(href)} onCitation={onCitation}>{children}</SourceButton>
      : <AnalystReportLink href={href}>{children}</AnalystReportLink>,
    // The closing Paper tickets, Research read and Sources lines are not shown (user-specified 2026-11-13); the report
    // ends with the Kalshi book. Saved reports that carry them drop them too.
    p: ({ node, children }) => (FOOTER_LINE.test(node.children?.[0]?.value || '') ? null : <p>{children}</p>),
  }), [report.links, onCitation]);
  return <article data-message-id={messageId} className={`analyst-message analyst-message--assistant analyst-prediction-report${error ? ' is-error' : ''}`} aria-label="Predictive Markets Review">
    <div className="analyst-markdown">
      <ReactMarkdown remarkPlugins={reportPlugins} components={components}
        urlTransform={url => report.links.has(url) ? url : defaultUrlTransform(url)}>
        {parts.body.replaceAll('<!-- analyst-prediction-research-rollup -->', '')
          .replaceAll('<!-- analyst-details -->', '\n\n')}
      </ReactMarkdown>
      {parts.detail && <details className="analyst-research-disclosure"><summary>{parts.title}</summary>
        <ReactMarkdown remarkPlugins={reportPlugins} components={components}
          urlTransform={url => report.links.has(url) ? url : defaultUrlTransform(url)}>{parts.detail}</ReactMarkdown>
      </details>}
    </div>
  </article>;
});
export default AnalystPredictionReport;
