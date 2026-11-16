import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import AnalystPredictionCurves, { settlementCurve } from './AnalystPredictionCurve';

// Each section's Kalshi line monitor, emitted by the setup board renderer as an ```analyst-lines JSON block:
// one row per market (book icon, centred name, curve icon), shaded red (short) or green (long) by Trade, Trend and the Risk Range
// third; opened, its lines with spot marked among them, and its held lines.
export function parsePredictionLines(text) {
  try {
    const value = JSON.parse(String(text || ''));
    const markets = Array.isArray(value?.markets)
      ? value.markets.filter(market => market && typeof market.market === 'string')
        .map(market => ({ ...market, summary: market.summary || {}, held: Array.isArray(market.held) ? market.held : [],
          lines: market.lines && Array.isArray(market.lines.lines) ? market.lines : null }))
      : [];
    return markets.length ? { markets } : null;
  } catch {
    return null;
  }
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const pct = value => (isNum(value) ? `${Math.round(value * 100)}%` : 'N/A');
const cents = value => (isNum(value) ? `${Math.round(value * 100)}¢` : 'N/A');
const points = value => {
  if (!isNum(value)) return 'N/A';
  const shown = Math.abs(value * 100).toFixed(1);
  return shown === '0.0' ? '0.0' : `${value > 0 ? '+' : '−'}${shown}`;
};
const dollars = value => (isNum(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A');
const contracts = value => (isNum(value) ? Math.round(value).toLocaleString('en-US') : 'N/A');
export const lineLabel = line => line.subtitle
  || (isNum(line.strike) ? `Above ${line.strike.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : line.ticker || 'N/A');
const pacific = value => (value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' PT'
  : null);

const STRENGTH = { STRONG: ['Strong', 'is-strong'], GOOD: ['Good', 'is-good'], WATCH: ['Watch', 'is-watch'], PASS: ['Pass', 'is-pass'],
  ILLIQUID: ['Illiquid', 'is-red'] };
export const STATE = {
  CLOSED: ['Closed', 'is-blue'],
  CONTRADICTS: ['Contradicts', 'is-red'], THROUGH_LINE: ['Through line', 'is-yellow'], EDGE_GONE: ['Edge gone', 'is-yellow'],
  SETUP_LAPSED: ['Unshaded', 'is-yellow'], CLOSING: ['Closing', 'is-blue'], HOLD: ['Hold', 'is-hold'],
};

export const Chip = ({ className, flash, title, children }) =>
  <span className={`analyst-lines__chip ${className || ''}${flash ? ' is-flash' : ''}`} title={title}>{children}</span>;

const SHADE_TITLE = {
  SHORT: 'Shaded short: Trade and Trend Bearish, price in the top third of the Risk Range',
  LONG: 'Shaded long: Trade and Trend Bullish, price in the bottom third of the Risk Range',
};


// Within the week: weekday and time; later: the date.
export const closes = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'N/A';
  const date = new Date(value);
  return date.getTime() - Date.now() < 6 * 86_400_000
    ? date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(':00 ', ' ')
    : date.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
};

const sigma = value => (isNum(value) ? `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}σ` : 'N/A');
const SIDE_HEAD = 'Ask · our edge in points. Hover for the dollars resting at the ask.';
const FILL_HEAD = 'Average price the whole bet fills at through the order book · our edge at that price. Hover for the fill.';
const whole = value => `$${Math.round(value).toLocaleString('en-US')}`;
const fillCents = value => `${(value * 100).toFixed(1)}¢`;

// One side of a line: its price and our edge; the side we would take is highlighted, a thin side is underlined red.
// With a bet checked against the order book, the price is the average the whole bet fills at.
function SideCell({ book, take, bet }) {
  if (!book || !isNum(book.ask)) return <td className="is-muted" title={book?.fill ? 'Nothing for sale on this side' : undefined}>N/A</td>;
  const fill = isNum(bet) ? book.fill : null;
  const prices = fill && fill.best !== fill.worst ? `${cents(fill.best)}–${cents(fill.worst)}` : fill ? cents(fill.worst) : null;
  const title = fill
    ? fill.complete
      ? `${whole(bet)} buys ${Math.round(fill.contracts).toLocaleString('en-US')} contracts at ${prices}, average ${fillCents(fill.avg)}`
      : `Only ${whole(book.depth)} for sale on this side; the ${whole(bet)} bet does not fill`
    : isNum(book.depth) ? `${whole(book.depth)} at ${cents(book.ask)}` : 'Size at the ask not quoted';
  return <td className={`analyst-lines__side${take ? ' is-take' : ''}${book.illiquid ? ' is-thin' : ''}`} title={title}>
    {fill ? fillCents(book.ask) : cents(book.ask)} <span className={isNum(book.edge) && book.edge > 0 ? 'is-positive' : 'is-muted'}>{points(book.edge)}</span>
  </td>;
}

// Event, close and the bet each line is checked against, centred over the lines.
const Label = ({ market, lines }) => <div className="analyst-lines__label">
  <span>{market.event}</span>{lines.closeTime && <span>closes {pacific(lines.closeTime)}</span>}
  {isNum(lines.bet) && <span className="analyst-lines__bet">Bet {whole(lines.bet)}</span>}
</div>;

// "Above $3887" / "$53.50 or above" / "5.65% or above" → ['Above', '3887'], the $ dropped.
export const lineParts = line => {
  const text = lineLabel(line);
  const before = text.match(/^(above|below)\s+(.+)$/i);
  const after = text.match(/^(.+?)\s+or (above|below)$/i);
  const [word, number] = before ? [before[1], before[2]] : after ? [after[2], after[1]] : [null, text];
  return [word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : null, number.replace(/\$/g, '')];
};
// The word sits in a fixed-width slot so every number in the column starts at the same place.
const LineName = ({ word, number }) => <><span className="analyst-lines__word">{word || ''}</span>{number}</>;
const LineCell = ({ line, title }) => {
  const [word, number] = lineParts(line);
  return <td title={title}><LineName word={word} number={number} /></td>;
};

// Spot as a blue row between the strikes it sits between (strikes run low to high), its number lined up with
// theirs and written the same way (thousands separators only when the lines use them).
function withSpot(visible, spot, columns, renderLine) {
  const out = visible.map(renderLine);
  if (!isNum(spot.price) || !visible.some(line => isNum(line.strike))) return out;
  const at = visible.findIndex(line => isNum(line.strike) && line.strike > spot.price);
  const grouped = visible.some(line => lineParts(line)[1].includes(','));
  const digits = Math.abs(spot.price) >= 10000 ? 0 : Math.abs(spot.price) >= 100 ? 1 : 2;
  const number = spot.unit === '%' ? `${spot.price.toFixed(2)}%`
    : spot.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouped });
  out.splice(at === -1 ? out.length : at, 0, <tr key="spot" className="analyst-lines__spot">
    <td><LineName word="Spot" number={number} /></td><td colSpan={columns - 1} /></tr>);
  return out;
}

// Lines that cannot take the bet on the side we would buy (or, without a bet, have under minDepthDollars at its ask)
// stay folded behind their own button, tinted red once shown.
const IlliquidButton = ({ count, shown, onClick, bet }) => (count > 0 && !shown
  ? <button type="button" className="analyst-lines__more" onClick={onClick}>
    {isNum(bet) ? `Show ${count} line${count === 1 ? '' : 's'} that can't take ${whole(bet)}` : `Show ${count} illiquid line${count === 1 ? '' : 's'}`}</button>
  : null);

function LineTable({ market, lines }) {
  const [showAll, setShowAll] = useState(false);
  const [showIlliquid, setShowIlliquid] = useState(false);
  // With a bet, only the lines whose order books were read are listed.
  const listed = isNum(lines.bet) ? lines.lines.filter(line => line.checked) : lines.lines;
  const count = strength => listed.filter(line => line.strength === strength).length;
  // Strike order, so spot sits between the lines around it; strength marks the best.
  const visible = listed.filter(line => (line.strength === 'ILLIQUID' ? showIlliquid : showAll || line.strength !== 'PASS'))
    .sort((a, b) => (isNum(a.strike) && isNum(b.strike) ? a.strike - b.strike : 0));
  const hidden = showAll ? 0 : count('PASS');
  return <>
    <Label market={market} lines={lines} />
    {visible.length > 0 && <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From centre</th><th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>Yes</th>
        <th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>No</th>
        <th title="Kalshi odds / our odds that the line pays Yes">Yes odds K / ours</th><th>Strength</th><th>Held</th></tr></thead>
      <tbody>{withSpot(visible, market.summary, 7, line => <tr key={line.ticker} className={line.strength === 'ILLIQUID' ? 'analyst-lines__illiquid' : undefined}>
        <LineCell line={line} />
        <td>{sigma(line.sigmas)}</td>
        <SideCell book={line.yes} take={line.buy === 'YES'} bet={lines.bet} /><SideCell book={line.no} take={line.buy === 'NO'} bet={lines.bet} />
        <td>{pct(line.kalshiYes)} / {pct(line.ourYes)}</td>
        <td><Chip className={STRENGTH[line.strength]?.[1]} flash={line.isNew}>{STRENGTH[line.strength]?.[0] || line.strength}{line.isNew ? ' · new' : ''}</Chip></td>
        <td>{line.held ? <span className="analyst-lines__held">{line.held.side === 'YES' ? 'Yes' : 'No'} {contracts(line.held.contracts)}</span> : '—'}</td>
      </tr>)}</tbody>
    </table>}
    {hidden > 0 && <button type="button" className="analyst-lines__more" onClick={() => setShowAll(true)}>
      {hidden} below 1 point of edge · show</button>}
    <IlliquidButton count={count('ILLIQUID')} shown={showIlliquid} onClick={() => setShowIlliquid(true)} bet={lines.bet} />
  </>;
}

// An unshaded market: its ladder as Kalshi quotes it, both sides priced and the better side highlighted.
// Opened, it shows the 15 fillable lines closest to even odds in strike order: with a bet, the lines whose order books
// take the whole bet on their better side (only lines whose books were read are listed); without one, at least $50 at
// the better side's ask. The other fillable lines and the ones that cannot fill each open with their own button.
export const LADDER_LINES = 15;
function LadderTable({ market, lines }) {
  const [showAll, setShowAll] = useState(false);
  const [showIlliquid, setShowIlliquid] = useState(false);
  const listed = isNum(lines.bet) ? lines.lines.filter(line => line.checked) : lines.lines;
  const fillable = new Set(listed.filter(line => !line.illiquid && isNum(line.kalshiOdds)));
  const nearest = new Set([...fillable].sort((a, b) => Math.abs(a.kalshiOdds - 0.5) - Math.abs(b.kalshiOdds - 0.5))
    .slice(0, LADDER_LINES));
  const visible = listed.filter(line => (fillable.has(line) ? showAll || nearest.has(line) : showIlliquid));
  return <>
    <Label market={market} lines={lines} />
    {visible.length > 0 && <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From centre</th><th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>Yes</th>
        <th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>No</th>
        <th title="Kalshi odds / our odds that the line pays Yes">Yes odds K / ours</th></tr></thead>
      <tbody>{withSpot(visible, market.summary, 5, line => <tr key={line.ticker} className={fillable.has(line) ? undefined : 'analyst-lines__illiquid'}>
        <LineCell line={line} />
        <td>{sigma(line.sigmas)}</td>
        <SideCell book={line.yes} take={line.better === 'YES'} bet={lines.bet} /><SideCell book={line.no} take={line.better === 'NO'} bet={lines.bet} />
        <td>{pct(line.kalshiOdds)} / {pct(line.ourOdds)}</td>
      </tr>)}</tbody>
    </table>}
    {!showAll && fillable.size > nearest.size && <button type="button" className="analyst-lines__more" onClick={() => setShowAll(true)}>
      Show all {fillable.size} fillable lines</button>}
    <IlliquidButton count={listed.length - fillable.size} shown={showIlliquid} onClick={() => setShowIlliquid(true)} bet={lines.bet} />
  </>;
}

function HeldTable({ market }) {
  return <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} held lines`}>
    <thead><tr><th>Held line</th><th>Held</th><th>Cost</th><th>Bid</th><th title="Kalshi odds / our odds">Odds K / ours</th><th>State</th></tr></thead>
    <tbody>{market.held.map(line => {
      const state = STATE[line.state] || STATE.HOLD;
      return <tr key={line.ticker} className={`analyst-lines__tone-${line.tone || 'none'}`}>
        <LineCell line={line} title={line.ticker} />
        <td>{line.side === 'YES' ? 'Yes' : 'No'} {contracts(line.contracts)}</td>
        <td>{dollars(line.cost)}</td><td>{cents(line.bid)}</td><td>{pct(line.kalshiOdds)} / {pct(line.ourOdds)}</td>
        <td><Chip className={state[1]}>{state[0]}</Chip>{line.why && <span className="analyst-lines__why">{line.why}</span>}</td>
      </tr>;
    })}</tbody>
  </table>;
}

// One row per market: the order-book arrow and the settlement-curve arrow open independently, both closed until clicked.
// Row icons in place of the triangles: an open book for the order book, a miniature bell for the settlement curve.
const BookIcon = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
  <path d="M8 4.2C6.6 3.1 4.6 2.7 2 2.8v9.4c2.6-.1 4.6.3 6 1.4 1.4-1.1 3.4-1.5 6-1.4V2.8c-2.6-.1-4.6.3-6 1.4z" fill="none"
    stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  <path d="M8 4.2v9.4" stroke="currentColor" strokeWidth="1.3" /></svg>;
const CurveIcon = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
  <path d="M1.5 13.5h13" stroke="currentColor" strokeWidth="1.1" opacity=".55" />
  <path d="M1 13c2.4 0 3.2-1.6 4.2-4.6S6.9 3.6 8 3.6s1.8 1.8 2.8 4.8S12.6 13 15 13z" fill="currentColor" opacity=".18" />
  <path d="M1 13c2.4 0 3.2-1.6 4.2-4.6S6.9 3.6 8 3.6s1.8 1.8 2.8 4.8S12.6 13 15 13" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;

function Toggle({ open, onClick, label, icon, off, className }) {
  return <button type="button" className={`analyst-lines__toggle analyst-lines__icon ${className}${open ? ' is-active' : ''}${off ? ' is-off' : ''}`}
    aria-expanded={off ? undefined : open} aria-label={label} title={label} disabled={off} onClick={onClick}>{icon}</button>;
}

// A market's two panels, its order book and its settlement curve, open independently; only the book of a shaded market
// with a Good or Strong line starts open.
export function useMarketPanels(market) {
  const [book, setBook] = useState(Boolean(market.open));
  const [curveOpen, setCurveOpen] = useState(false);
  const curve = useMemo(() => settlementCurve(market), [market]);
  return { book, curveOpen, curve, toggleBook: () => setBook(value => !value), toggleCurve: () => setCurveOpen(value => !value) };
}

export function MarketToggles({ market, panels, className = '' }) {
  return <span className={`analyst-lines__toggles ${className}`.trim()}>
    <Toggle className="is-book" open={panels.book} onClick={panels.toggleBook} label={`${market.market} order book`} icon={<BookIcon />} />
    <Toggle className="is-curve" open={panels.curveOpen} onClick={panels.toggleCurve} off={!panels.curve} icon={<CurveIcon />}
      label={panels.curve ? `${market.market} settlement curve` : `${market.market}: too few quoted lines for a curve`} />
  </span>;
}

export function MarketBook({ market }) {
  return <>
    {market.lines?.lines.length > 0 && (market.lines.side
      ? <LineTable market={market} lines={market.lines} /> : <LadderTable market={market} lines={market.lines} />)}
    {market.held.length > 0 && <HeldTable market={market} />}
  </>;
}

// Shading: red = short (Trade and Trend Bearish, top third of the Risk Range), green = long; the reason on hover.
export const marketShade = market => ({
  className: market.shade === 'SHORT' ? 'is-shade-short' : market.shade === 'LONG' ? 'is-shade-long' : '',
  title: SHADE_TITLE[market.shade] || (market.shadeReason ? `Unshaded: ${market.shadeReason}` : undefined),
});

function MarketRows({ market }) {
  const panels = useMarketPanels(market);
  const shade = marketShade(market);
  return <>
    <tr className={`analyst-lines__row${panels.book || panels.curveOpen ? ' is-open' : ''}${shade.className ? ` ${shade.className}` : ''}`} title={shade.title}>
      <td><span className="analyst-lines__head">
        <MarketToggles market={market} panels={panels} className="is-inline" />
        <span className="analyst-lines__name">{market.market}</span></span></td>
    </tr>
    {panels.book && <tr className="analyst-lines__detail"><td><MarketBook market={market} /></td></tr>}
    {panels.curveOpen && panels.curve && <tr className="analyst-lines__detail analyst-lines__curves"><td><AnalystPredictionCurves curves={[panels.curve]} /></td></tr>}
  </>;
}

export const expandable = market => Boolean(market.lines?.lines.length || market.held.length);

// The table can scroll sideways (wide books), so the row heads are sized to the visible width: the name sits centred
// in what you see, not in the scrolled table.
function useVisibleWidth(box) {
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth || null);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [box]);
  return width;
}

export default function AnalystPredictionLines({ lines }) {
  const box = useRef(null);
  const width = useVisibleWidth(box);
  const markets = lines.markets.filter(expandable);
  if (!markets.length) return null;
  return <div ref={box} className="analyst-lines" style={width ? { '--lines-visible': `${width}px` } : undefined}>
    <table className="analyst-drivers__table analyst-lines__markets" aria-label="Kalshi lines">
      <tbody>{markets.map(market => <MarketRows key={market.id || market.market} market={market} />)}</tbody>
    </table>
  </div>;
}
