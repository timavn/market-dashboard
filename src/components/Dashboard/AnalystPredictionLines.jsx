import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import AnalystPredictionCurves, { curveLevel, settlementCurve } from './AnalystPredictionCurve';

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
const dollars = value => (isNum(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A');
const contracts = value => (isNum(value) ? Math.round(value).toLocaleString('en-US') : 'N/A');
export const lineLabel = line => line.subtitle
  || (isNum(line.strike) ? `Above ${line.strike.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : line.ticker || 'N/A');
const pacific = value => (value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' PT'
  : null);

export const STATE = {
  CLOSED: ['Closed', 'is-blue'],
  CONTRADICTS: ['Contradicts', 'is-red'], THROUGH_LINE: ['Through line', 'is-yellow'],
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
const SIDE_HEAD = 'Ask. Hover for the dollars resting at the ask.';
const FILL_HEAD = 'Average price the whole bet fills at through the order book. Hover for the fill.';
const whole = value => `$${Math.round(value).toLocaleString('en-US')}`;
const fillCents = value => `${(value * 100).toFixed(1)}¢`;

// One side of a line: its price; the side a setup buys is highlighted, a thin side is underlined red.
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
    {fill ? fillCents(book.ask) : cents(book.ask)}
  </td>;
}

// Event, close and the bet each line is checked against, centred over the lines.
const Label = ({ market, lines }) => <div className="analyst-lines__label">
  {market.weekly && <span title="The daily event lists no line near the price, so the weekly event's lines are shown">Weekly</span>}
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
// A book writes every number with the same count of decimals (user-specified 2026-11-17): 6 → 6.00 beside 5.98.
const NUMBER = /^([\d,]+)(?:\.(\d+))?(%?)$/;
const decimalsOf = text => (text.match(NUMBER)?.[2] || '').length;
const padTo = (text, digits) => {
  const match = text.match(NUMBER);
  if (!match || !digits) return text;
  return `${match[1]}.${(match[2] || '').padEnd(digits, '0')}${match[3]}`;
};
// Spot's own precision: none from 10,000, one from 100, else two.
const spotDigits = spot => (spot.unit === '%' ? 2 : Math.abs(spot.price) >= 10000 ? 0 : Math.abs(spot.price) >= 100 ? 1 : 2);
// The level a line's row shows ("5.48% or above" → 5.48), else its strike.
const shownLevel = line => {
  const value = Number.parseFloat(lineParts(line)[1].replace(/[,%]/g, ''));
  return Number.isFinite(value) ? value : line.strike;
};
// One count for a market's book: the most any of its lines (or spot) carries.
const bookDigits = (lines, spot) => Math.max(0, ...lines.map(line => decimalsOf(lineParts(line)[1])),
  isNum(spot?.price) ? spotDigits(spot) : 0);

// The word sits in a fixed-width slot so every number in the column starts at the same place.
const LineName = ({ word, number }) => <><span className="analyst-lines__word">{word || ''}</span>{number}</>;
const LineCell = ({ line, title, digits }) => {
  const [word, number] = lineParts(line);
  return <td title={title}><LineName word={word} number={padTo(number, digits)} /></td>;
};

// Spot as a thin blue rule between the strikes it sits between (strikes run low to high). Its tag sits in the Line
// column, aligned like that column's cells, so its number lines up with theirs; it is written the same way (thousands
// separators only when the lines use them, with the book's decimals).
function withSpot(visible, spot, columns, renderLine, digits = spotDigits(spot)) {
  const out = visible.map(renderLine);
  if (!isNum(spot.price) || !visible.some(line => isNum(line.strike))) return out;
  // Placed by the number the row shows, not the strike: Kalshi's "5.48% or above" line carries strike 5.47.
  const at = visible.findIndex(line => isNum(line.strike) && shownLevel(line) > spot.price);
  const grouped = visible.some(line => lineParts(line)[1].includes(','));
  const number = spot.unit === '%' ? `${spot.price.toFixed(digits)}%`
    : spot.price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: grouped });
  out.splice(at === -1 ? out.length : at, 0, <tr key="spot" className="analyst-lines__spot">
    <td><span className="analyst-lines__spot-slot"><span className="analyst-lines__spot-tag"><LineName word="Spot" number={number} /></span></span></td>
    <td colSpan={columns - 1} /></tr>);
  return out;
}

// Lines that cannot take the bet (or, without a bet, have under minDepthDollars at the ask)
// stay folded behind their own button, tinted red once shown.
const IlliquidButton = ({ count, shown, onClick, bet }) => (count > 0 && !shown
  ? <button type="button" className="analyst-lines__more" onClick={onClick}>
    {isNum(bet) ? `Show ${count} line${count === 1 ? '' : 's'} that can't take ${whole(bet)}` : `Show ${count} illiquid line${count === 1 ? '' : 's'}`}</button>
  : null);

const fromPrice = (line, centre) => (isNum(centre) && centre && isNum(line.strike)
  ? `${line.strike >= centre ? '+' : '−'}${Math.abs(((line.strike - centre) / centre) * 100).toFixed(1)}%` : sigma(line.sigmas));
// A stake as its share of the account over its dollars, each centred on its own line.
const Stake = ({ pct: share, dollars: amount }) => <>
  <span className="analyst-lines__stack">{isNum(share) ? `${share.toFixed(2).replace(/0$/, '')}%` : 'N/A'}</span>
  {isNum(amount) && <span className="analyst-lines__stack">{whole(amount)}</span>}</>;

// A setup's order book (user-specified 2026-11-16): only the side the setup buys and only the lines its rules allow
// (50¢ or less, within reach, inside the Risk Range), plus the one line on the other side of spot so spot sits between
// rows. The ticket's lines are tinted and carry stake, contracts and winnings; a Ticket row totals them.
function LineTable({ market, lines }) {
  const yes = lines.buy === 'YES';
  const ordered = [...lines.lines].sort((a, b) => (isNum(a.strike) && isNum(b.strike) ? a.strike - b.strike : 0));
  const inReach = ordered.filter(line => line.reach || line.ticket);
  // Yes is bought above the price, so the neighbour is the line just below the first one in reach; No, just above the last.
  const at = inReach.length ? ordered.indexOf(yes ? inReach[0] : inReach[inReach.length - 1]) : -1;
  const neighbour = at === -1 ? null : ordered[yes ? at - 1 : at + 1];
  const visible = ordered.filter(line => inReach.includes(line) || line === neighbour);
  const staked = inReach.filter(line => line.ticket);
  const sum = key => staked.reduce((total, line) => total + (line.ticket[key] || 0), 0);
  const funded = staked.some(line => isNum(line.ticket.contracts));
  const head = isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD;
  const digits = bookDigits(lines.lines, market.summary);
  return <>
    <Label market={market} lines={lines} />
    <table className="analyst-drivers__table analyst-lines__table analyst-lines__setup" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From price</th><th title={head}>{yes ? 'Yes' : 'No'} ask</th>
        <th title="Dollars resting at the ask on the side bought">At the ask</th><th>Stake</th><th>Contracts</th><th>Wins</th></tr></thead>
      <tbody>{withSpot(visible, market.summary, 7, line => {
        const book = yes ? line.yes : line.no;
        return <tr key={line.ticker} className={line.ticket ? 'analyst-lines__ticket' : undefined}>
          <LineCell line={line} digits={digits} />
          <td>{fromPrice(line, market.summary.centre)}</td>
          <td className={book?.illiquid ? 'analyst-lines__side is-thin' : undefined}>{isNum(lines.bet) && book?.fill && isNum(book.ask) ? fillCents(book.ask) : cents(book?.ask)}</td>
          <td>{isNum(book?.depth) ? whole(book.depth) : 'N/A'}</td>
          <td className={line.ticket ? 'analyst-lines__stake' : undefined}>{line.ticket ? <Stake pct={line.ticket.pct} dollars={line.ticket.dollars} /> : '—'}</td>
          <td>{line.ticket && isNum(line.ticket.contracts) ? contracts(line.ticket.contracts) : '—'}</td>
          <td>{line.ticket && isNum(line.ticket.win) ? whole(line.ticket.win) : '—'}</td>
        </tr>;
      }, digits)}
      {staked.length > 0 && <tr className="analyst-lines__total">
        <td>Ticket</td><td />
        <td>{sum('pct') > 0 ? `${Math.round((staked.reduce((total, line) => total + (line.ticket.ask ?? 0) * line.ticket.pct, 0) / sum('pct')) * 100)}¢ avg` : ''}</td><td />
        <td><Stake pct={sum('pct')} dollars={funded ? sum('dollars') : null} /></td>
        <td>{funded ? contracts(sum('contracts')) : '—'}</td><td>{funded ? whole(sum('win')) : '—'}</td></tr>}</tbody>
    </table>
  </>;
}

// An unshaded market: its ladder as Kalshi quotes it, both sides priced and neither marked.
// Opened, it shows the 15 fillable lines closest to even odds in strike order: with a bet, the lines whose order books
// take the whole bet on either side (only lines whose books were read are listed); without one, at least $50 at
// either side's ask. The other fillable lines and the ones that cannot fill each open with their own button.
export const LADDER_LINES = 15;
function LadderTable({ market, lines }) {
  const [showAll, setShowAll] = useState(false);
  const [showIlliquid, setShowIlliquid] = useState(false);
  const listed = isNum(lines.bet) ? lines.lines.filter(line => line.checked) : lines.lines;
  const fillable = new Set(listed.filter(line => !line.illiquid && isNum(line.kalshiOdds)));
  const nearest = new Set([...fillable].sort((a, b) => Math.abs(a.kalshiOdds - 0.5) - Math.abs(b.kalshiOdds - 0.5))
    .slice(0, LADDER_LINES));
  const visible = listed.filter(line => (fillable.has(line) ? showAll || nearest.has(line) : showIlliquid));
  const digits = bookDigits(lines.lines, market.summary);
  return <>
    <Label market={market} lines={lines} />
    {visible.length > 0 && <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From centre</th><th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>Yes</th>
        <th title={isNum(lines.bet) ? FILL_HEAD : SIDE_HEAD}>No</th>
        <th title="Kalshi odds that the line pays Yes">Yes odds</th></tr></thead>
      <tbody>{withSpot(visible, market.summary, 5, line => <tr key={line.ticker} className={fillable.has(line) ? undefined : 'analyst-lines__illiquid'}>
        <LineCell line={line} digits={digits} />
        <td>{sigma(line.sigmas)}</td>
        <SideCell book={line.yes} bet={lines.bet} /><SideCell book={line.no} bet={lines.bet} />
        <td>{pct(line.kalshiOdds)}</td>
      </tr>, digits)}</tbody>
    </table>}
    {!showAll && fillable.size > nearest.size && <button type="button" className="analyst-lines__more" onClick={() => setShowAll(true)}>
      Show all {fillable.size} fillable lines</button>}
    <IlliquidButton count={listed.length - fillable.size} shown={showIlliquid} onClick={() => setShowIlliquid(true)} bet={lines.bet} />
  </>;
}

function HeldTable({ market }) {
  const digits = bookDigits(market.held, null);
  return <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} held lines`}>
    <thead><tr><th>Held line</th><th>Held</th><th>Cost</th><th>Bid</th><th title="Kalshi odds that the held side pays">Odds</th><th>State</th></tr></thead>
    <tbody>{market.held.map(line => {
      const state = STATE[line.state] || STATE.HOLD;
      return <tr key={line.ticker} className={`analyst-lines__tone-${line.tone || 'none'}`}>
        <LineCell line={line} title={line.ticker} digits={digits} />
        <td>{line.side === 'YES' ? 'Yes' : 'No'} {contracts(line.contracts)}</td>
        <td>{dollars(line.cost)}</td><td>{cents(line.bid)}</td><td>{pct(line.kalshiOdds)}</td>
        <td><Chip className={state[1]}>{state[0]}</Chip>{line.why && <span className="analyst-lines__why">{line.why}</span>}</td>
      </tr>;
    })}</tbody>
  </table>;
}

// One row per market: the order book and the settlement curve open independently, both closed until clicked. Their
// buttons read as one black-and-white switch, Book | Curve, the open half filled black (2026-11-17).
function Toggle({ open, onClick, label, word, off, className }) {
  return <button type="button" className={`analyst-lines__toggle analyst-lines__switch ${className}${open ? ' is-active' : ''}${off ? ' is-off' : ''}`}
    aria-expanded={off ? undefined : open} aria-label={label} title={label} disabled={off} onClick={onClick}>{word}</button>;
}

// A market's two panels, its order book and its settlement curve, open independently and start closed: nothing shows
// until its button is clicked (user-specified 2026-11-16), whatever the board's open flag says.
export function useMarketPanels(market) {
  const [book, setBook] = useState(false);
  const [curveOpen, setCurveOpen] = useState(false);
  const curve = useMemo(() => settlementCurve(market), [market]);
  return { book, curveOpen, curve, toggleBook: () => setBook(value => !value), toggleCurve: () => setCurveOpen(value => !value) };
}

export function MarketToggles({ market, panels, className = '' }) {
  return <span className={`analyst-lines__toggles ${className}`.trim()}>
    <Toggle className="is-book" open={panels.book} onClick={panels.toggleBook} label={`${market.market} order book`} word="Book" />
    <Toggle className="is-curve" open={panels.curveOpen} onClick={panels.toggleCurve} off={!panels.curve} word="Curve"
      label={panels.curve ? `${market.market} settlement curve` : `${market.market}: too few quoted lines for a curve`} />
  </span>;
}

// Settlement grid: what the held lines pay across settlement prices. Held strikes cut the axis into zones (P&L is flat
// inside one); each zone gets two sample prices, spot is marked in its zone, and Kalshi's ladder gives the odds of
// settling above each price and inside each zone. Odds x P&L summed over the zones is the book's expected P&L.
const PAYS_ABOVE = new Set(['greater', 'greater_or_equal']);
const PAYS_BELOW = new Set(['less', 'less_or_equal']);
const linePays = (line, x) => {
  const above = PAYS_ABOVE.has(line.strikeType) ? x > line.strike : PAYS_BELOW.has(line.strikeType) ? x < line.strike : null;
  return above === null ? null : line.side === 'YES' ? above : !above;
};
const money = value => `${Math.round(value) < 0 ? '−' : Math.round(value) > 0 ? '+' : ''}$${Math.abs(Math.round(value)).toLocaleString('en-US')}`;
const tone = value => (Math.round(value) > 0 ? 'is-positive' : Math.round(value) < 0 ? 'is-negative' : 'is-muted');
const signedPct = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}%`;

export function settlementGrid(market) {
  const held = (market.held || []).filter(line => isNum(line.strike) && isNum(line.contracts) && isNum(line.cost)
    && linePays(line, line.strike) !== null);
  if (!held.length) return null;
  const cuts = [...new Set(held.map(line => line.strike))].sort((a, b) => a - b);
  const strikes = [...new Set((market.lines?.lines || []).map(line => line.strike).filter(isNum))].sort((a, b) => a - b);
  const gaps = strikes.slice(1).map((value, index) => value - strikes[index]).filter(gap => gap > 0).sort((a, b) => a - b);
  const price = market.summary?.price;
  const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Math.abs(price || cuts[0]) * 0.01 || 1;
  const curve = settlementCurve(market);
  const above = x => (curve ? curve.above(x) : null);
  const bounds = [...cuts.map((cut, index) => [index ? cuts[index - 1] : null, cut]), [cuts[cuts.length - 1], null]];
  const zones = bounds.map(([lo, hi]) => {
    const samples = lo === null ? [hi - 2 * step, hi - step] : hi === null ? [lo + step, lo + 2 * step]
      : [lo + (hi - lo) / 3, lo + (2 * (hi - lo)) / 3];
    const inside = x => (lo === null || x > lo) && (hi === null || x <= hi);
    const rows = samples.map(x => ({ x, spot: false }));
    if (isNum(price) && inside(price)) rows.push({ x: price, spot: true });
    rows.sort((a, b) => a.x - b.x);
    const probe = samples[0];
    const perLine = held.map(line => (linePays(line, probe) ? line.contracts : 0) - line.cost);
    const pnl = perLine.reduce((total, value) => total + value, 0);
    const odds = curve ? (lo === null ? 1 : above(lo)) - (hi === null ? 0 : above(hi)) : null;
    return { lo, hi, rows, perLine, pnl, odds };
  });
  const cost = held.reduce((total, line) => total + line.cost, 0);
  const marked = held.every(line => isNum(line.bid)) ? held.reduce((total, line) => total + line.bid * line.contracts, 0) - cost : null;
  const expected = curve ? zones.reduce((total, zone) => total + zone.odds * zone.pnl, 0) : null;
  return { held, zones, cost, price, above, expected, marked, unit: market.summary?.unit || null };
}

function SettlementGrid({ market, grid }) {
  const { held, zones, cost, price, above, expected, marked, unit } = grid;
  const level = value => curveLevel(value, unit);
  const win = value => `analyst-lines__pnl ${value > 0 ? 'is-win' : 'is-loss'}`;
  const expectedTone = isNum(expected) ? tone(expected) : undefined;
  return <table className="analyst-drivers__table analyst-lines__table analyst-lines__grid" aria-label={`${market.market} settlement grid`}>
    <thead><tr><th>Settle</th><th>Δ spot</th>
      {held.map(line => <th key={line.ticker} title={line.ticker}>{line.side === 'YES' ? 'Yes' : 'No'} {level(line.strike)}</th>)}
      <th>Book P&amp;L</th><th>P&amp;L %</th><th title="Kalshi odds of settling above this price">Above %</th>
      <th title="Kalshi odds of settling in this zone">Zone odds</th><th>Odds × P&amp;L</th></tr></thead>
    <tbody>{zones.flatMap((zone, zoneIndex) => zone.rows.map((row, index) => <tr key={`${zoneIndex}-${row.x}`} className={row.spot ? 'is-spot' : undefined}>
      <td>{level(row.x)}{row.spot ? ' spot' : ''}</td>
      <td>{isNum(price) && price ? signedPct(((row.x - price) / price) * 100) : 'N/A'}</td>
      {zone.perLine.map((value, lineIndex) => <td key={held[lineIndex].ticker} className={win(value)}>{money(value)}</td>)}
      <td className={win(zone.pnl)}>{money(zone.pnl)}</td>
      <td className={tone(zone.pnl)}>{cost ? signedPct((zone.pnl / cost) * 100) : 'N/A'}</td>
      <td>{isNum(above(row.x)) ? `${(above(row.x) * 100).toFixed(1)}%` : 'N/A'}</td>
      {index === 0 && <td rowSpan={zone.rows.length} className="analyst-lines__zone">{isNum(zone.odds) ? `${(zone.odds * 100).toFixed(1)}%` : 'N/A'}</td>}
      {index === 0 && <td rowSpan={zone.rows.length} className={`analyst-lines__zone ${tone(zone.pnl)}`}>
        {isNum(zone.odds) ? money(zone.odds * zone.pnl) : 'N/A'}</td>}
    </tr>))}
      <tr className="analyst-lines__grid-total">
        <td colSpan={2 + held.length}>Expected at Kalshi odds{isNum(marked) ? ` · marked ${money(marked)} at the bid` : ''}</td>
        <td className={expectedTone}>{isNum(expected) ? money(expected) : 'N/A'}</td>
        <td className={expectedTone}>{isNum(expected) && cost ? signedPct((expected / cost) * 100) : 'N/A'}</td>
        <td /><td>100%</td><td className={expectedTone}>{isNum(expected) ? money(expected) : 'N/A'}</td>
      </tr>
    </tbody>
  </table>;
}

export function MarketBook({ market }) {
  const grid = useMemo(() => settlementGrid(market), [market]);
  return <>
    {market.lines?.lines.length > 0 && (market.lines.side && market.lines.lines.some(line => line.reach || line.ticket)
      ? <LineTable market={market} lines={market.lines} /> : <LadderTable market={market} lines={market.lines} />)}
    {market.held.length > 0 && <HeldTable market={market} />}
    {grid && <SettlementGrid market={market} grid={grid} />}
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
