import React, { useMemo, useState } from 'react';
import AnalystPredictionCurves, { settlementCurve } from './AnalystPredictionCurve';

// Each section's Kalshi line monitor, emitted by the setup board renderer as an ```analyst-lines JSON block:
// one foldable row per market, shaded red (short) or green (long) by Trade, Trend and the Risk Range third, with its
// price against Kalshi's centre, best line, fillable lines, close and holdings; opened, its lines and held lines.
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

// Prices read at the precision their size needs; yields and CPI carry a % sign.
const level = (value, unit) => {
  if (!isNum(value)) return 'N/A';
  if (unit === '%') return `${value.toFixed(2)}%`;
  const digits = Math.abs(value) >= 10000 ? 0 : Math.abs(value) >= 100 ? 1 : 2;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

function PriceCell({ summary }) {
  const { price, centre, position, unit } = summary;
  const gap = isNum(price) && isNum(centre) && price
    ? unit === '%' ? `${centre >= price ? '+' : '−'}${Math.abs(Math.round((centre - price) * 100))} bp`
      : `${centre >= price ? '+' : '−'}${Math.abs(((centre - price) / price) * 100).toFixed(1)}%`
    : null;
  const where = !isNum(position) ? null : position < 0 ? 'below range' : position > 1 ? 'above range' : `${Math.round(position * 100)}% of range`;
  return <td>
    {isNum(price) ? level(price, unit) : <span className="is-muted">N/A</span>} → {level(centre, unit)}
    {(gap || where) && <span className="analyst-lines__sub">{[gap, where].filter(Boolean).join(' · ')}</span>}
  </td>;
}

function BestCell({ best, flash }) {
  if (!best || !isNum(best.ask)) return <td className="is-muted">No line with $50 at the ask</td>;
  const grade = STRENGTH[best.strength];
  return <td>
    <span className={best.side === 'YES' ? 'analyst-lines__yes' : 'analyst-lines__no'}>{best.side === 'YES' ? 'Yes' : 'No'}</span>{' '}
    {lineLabel(best)} · {cents(best.ask)} · <span className={best.edge > 0 ? 'is-positive' : 'is-muted'}>{points(best.edge)}</span>
    {grade && best.strength !== 'PASS' && <> <Chip className={grade[1]} flash={flash && best.isNew}>{grade[0]}</Chip></>}
    {isNum(best.depth) && <span className="analyst-lines__sub">${Math.round(best.depth).toLocaleString('en-US')} at the ask</span>}
  </td>;
}

// Within the week: weekday and time; later: the date.
export const closes = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'N/A';
  const date = new Date(value);
  return date.getTime() - Date.now() < 6 * 86_400_000
    ? date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(':00 ', ' ')
    : date.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
};

function HeldSummary({ market, flash }) {
  if (!market.held.length) return <span className="is-muted">—</span>;
  const state = market.worst ? STATE[market.worst.state] : null;
  const cost = market.held.reduce((total, line) => total + (isNum(line.cost) ? line.cost : 0), 0);
  const sides = [...new Set(market.held.map(line => (line.side === 'YES' ? 'Yes' : 'No')))].join('/');
  return <span className="analyst-lines__summary">
    <span className="analyst-lines__held">{market.held.length === 1
      ? `${sides} ${contracts(market.held[0].contracts)}` : `${market.held.length} lines ${sides}`} · ${Math.round(cost).toLocaleString('en-US')}</span>
    {state && <Chip className={state[1]} flash={flash && market.worst.state === 'CONTRADICTS'}>{state[0]}</Chip>}
  </span>;
}

const sigma = value => (isNum(value) ? `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}σ` : 'N/A');
const SIDE_HEAD = 'Ask · our edge in points. Hover for the dollars resting at the ask.';

// One side of a line: its ask and our edge; the side we would take is highlighted, a thin side is underlined red.
function SideCell({ book, take }) {
  if (!book || !isNum(book.ask)) return <td className="is-muted">N/A</td>;
  const depth = isNum(book.depth) ? `$${Math.round(book.depth).toLocaleString('en-US')} at ${cents(book.ask)}` : 'Size at the ask not quoted';
  return <td className={`analyst-lines__side${take ? ' is-take' : ''}${book.illiquid ? ' is-thin' : ''}`} title={depth}>
    {cents(book.ask)} <span className={isNum(book.edge) && book.edge > 0 ? 'is-positive' : 'is-muted'}>{points(book.edge)}</span>
  </td>;
}

const illiquidNote = lines => `${lines.illiquid} illiquid (under $${lines.minDepth ?? 50} at the ask)`;

function LineTable({ market, lines }) {
  const [showAll, setShowAll] = useState(false);
  const visible = lines.lines.filter(line => showAll || line.strength !== 'PASS');
  const hidden = lines.lines.length - visible.length;
  return <>
    <div className="analyst-lines__label">
      <span>{market.event}</span>{lines.closeTime && <span>closes {pacific(lines.closeTime)}</span>}
      <span>Shaded {lines.side === 'LONG' ? 'long' : 'short'} · buys {lines.buy === 'YES' ? 'Yes' : 'No'}</span>
      {lines.illiquid > 0 && <span>{illiquidNote(lines)}</span>}
    </div>
    {visible.length > 0 && <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From centre</th><th title={SIDE_HEAD}>Yes</th><th title={SIDE_HEAD}>No</th>
        <th title="Kalshi odds / our odds that the line pays Yes">Yes odds K / ours</th><th>Strength</th><th>Held</th></tr></thead>
      <tbody>{visible.map(line => <tr key={line.ticker} className={line.strength === 'ILLIQUID' ? 'analyst-lines__illiquid' : undefined}>
        <td>{lineLabel(line)}</td>
        <td>{sigma(line.sigmas)}</td>
        <SideCell book={line.yes} take={line.buy === 'YES'} /><SideCell book={line.no} take={line.buy === 'NO'} />
        <td>{pct(line.kalshiYes)} / {pct(line.ourYes)}</td>
        <td><Chip className={STRENGTH[line.strength]?.[1]} flash={line.isNew}>{STRENGTH[line.strength]?.[0] || line.strength}{line.isNew ? ' · new' : ''}</Chip></td>
        <td>{line.held ? <span className="analyst-lines__held">{line.held.side === 'YES' ? 'Yes' : 'No'} {contracts(line.held.contracts)}</span> : '—'}</td>
      </tr>)}</tbody>
    </table>}
    {hidden > 0 && <button type="button" className="analyst-lines__more" onClick={() => setShowAll(true)}>
      {hidden} below 1 point of edge · show</button>}
  </>;
}

// An unshaded market: its ladder as Kalshi quotes it, both sides priced and the better side highlighted.
// Opened, it shows the 15 quoted lines closest to even odds in strike order, illiquid ones tinted red.
export const LADDER_LINES = 15;
function LadderTable({ market, lines }) {
  const [showAll, setShowAll] = useState(false);
  const quoted = lines.lines.filter(line => isNum(line.kalshiOdds));
  const nearest = new Set([...quoted].sort((a, b) => Math.abs(a.kalshiOdds - 0.5) - Math.abs(b.kalshiOdds - 0.5))
    .slice(0, LADDER_LINES).map(line => line.ticker));
  const visible = lines.lines.filter(line => showAll || nearest.has(line.ticker));
  const hidden = lines.lines.length - visible.length;
  return <>
    <div className="analyst-lines__label">
      <span>{market.event}</span>{lines.closeTime && <span>closes {pacific(lines.closeTime)}</span>}
      <span>Unshaded · not graded</span>
      {lines.illiquid > 0 && <span>{illiquidNote(lines)}</span>}
    </div>
    {visible.length > 0 && <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} Kalshi lines`}>
      <thead><tr><th>Line</th><th>From centre</th><th title={SIDE_HEAD}>Yes</th><th title={SIDE_HEAD}>No</th>
        <th title="Kalshi odds / our odds that the line pays Yes">Yes odds K / ours</th></tr></thead>
      <tbody>{visible.map(line => <tr key={line.ticker} className={line.illiquid ? 'analyst-lines__illiquid' : undefined}>
        <td>{lineLabel(line)}</td>
        <td>{sigma(line.sigmas)}</td>
        <SideCell book={line.yes} take={line.better === 'YES'} /><SideCell book={line.no} take={line.better === 'NO'} />
        <td>{pct(line.kalshiOdds)} / {pct(line.ourOdds)}</td>
      </tr>)}</tbody>
    </table>}
    {hidden > 0 && <button type="button" className="analyst-lines__more" onClick={() => setShowAll(true)}>
      Show all {lines.lines.length} lines{lines.total > lines.lines.length ? ` nearest even (of ${lines.total})` : ''}</button>}
  </>;
}

function HeldTable({ market }) {
  return <table className="analyst-drivers__table analyst-lines__table" aria-label={`${market.market} held lines`}>
    <thead><tr><th>Held line</th><th>Held</th><th>Cost</th><th>Bid</th><th title="Kalshi odds / our odds">Odds K / ours</th><th>State</th></tr></thead>
    <tbody>{market.held.map(line => {
      const state = STATE[line.state] || STATE.HOLD;
      return <tr key={line.ticker} className={`analyst-lines__tone-${line.tone || 'none'}`}>
        <td title={line.ticker}>{lineLabel(line)}</td>
        <td>{line.side === 'YES' ? 'Yes' : 'No'} {contracts(line.contracts)}</td>
        <td>{dollars(line.cost)}</td><td>{cents(line.bid)}</td><td>{pct(line.kalshiOdds)} / {pct(line.ourOdds)}</td>
        <td><Chip className={state[1]}>{state[0]}</Chip>{line.why && <span className="analyst-lines__why">{line.why}</span>}</td>
      </tr>;
    })}</tbody>
  </table>;
}

function MarketRows({ market }) {
  const [open, setOpen] = useState(Boolean(market.open));
  // A flash stops once the row has been opened or closed by hand; the color stays.
  const [touched, setTouched] = useState(false);
  const expandable = Boolean(market.lines?.lines.length || market.held.length);
  const toggle = () => { setOpen(value => !value); setTouched(true); };
  const { summary } = market;
  const shade = market.shade === 'SHORT' ? ' is-shade-short' : market.shade === 'LONG' ? ' is-shade-long' : '';
  return <>
    <tr className={`analyst-lines__row${open ? ' is-open' : ''}${shade}`}
      title={SHADE_TITLE[market.shade] || (market.shadeReason ? `Unshaded: ${market.shadeReason}` : undefined)}>
      <td>{expandable
        ? <button type="button" className="analyst-lines__toggle" aria-expanded={open} onClick={toggle}>
          <span aria-hidden="true" className="analyst-lines__chev">{open ? '▼' : '▶'}</span>{market.market}</button>
        : <span className="analyst-lines__toggle is-off"><span aria-hidden="true" className="analyst-lines__chev">▶</span>{market.market}</span>}</td>
      <PriceCell summary={summary} />
      <BestCell best={summary.best} flash={!touched} />
      <td>{isNum(summary.fillable) && isNum(summary.total) ? `${summary.fillable} / ${summary.total}` : <span className="is-muted">N/A</span>}</td>
      <td>{summary.closeTime ? closes(summary.closeTime) : <span className="is-muted">No open event</span>}</td>
      <td><HeldSummary market={market} flash={!touched} /></td>
    </tr>
    {open && expandable && <tr className="analyst-lines__detail"><td colSpan={6}>
      {market.lines?.lines.length > 0 && (market.lines.side
        ? <LineTable market={market} lines={market.lines} /> : <LadderTable market={market} lines={market.lines} />)}
      {market.held.length > 0 && <HeldTable market={market} />}
    </td></tr>}
  </>;
}

// The section's settlement curves, folded into one solid row under its markets; closed until clicked.
function CurvesRows({ markets }) {
  const [open, setOpen] = useState(false);
  const curves = useMemo(() => markets.map(settlementCurve).filter(Boolean), [markets]);
  if (!curves.length) return null;
  return <>
    <tr className={`analyst-lines__curves-row${open ? ' is-open' : ''}`}><td colSpan={6}>
      <button type="button" className="analyst-lines__toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span aria-hidden="true" className="analyst-lines__chev">{open ? '▼' : '▶'}</span>Settlement curves
        <span className="analyst-lines__curves-names">{curves.map(curve => curve.market).join(' · ')}</span></button>
    </td></tr>
    {open && <tr className="analyst-lines__detail analyst-lines__curves"><td colSpan={6}><AnalystPredictionCurves curves={curves} /></td></tr>}
  </>;
}

export default function AnalystPredictionLines({ lines }) {
  return <div className="analyst-lines">
    <table className="analyst-drivers__table analyst-lines__markets" aria-label="Kalshi lines">
      <colgroup><col className="analyst-lines__market-col" /><col className="analyst-lines__price-col" /><col />
        <col className="analyst-lines__fill-col" /><col className="analyst-lines__close-col" /><col className="analyst-lines__held-col" /></colgroup>
      <thead><tr><th title="Rows shade red for a short (Trade and Trend Bearish, price in the top third of the Risk Range) and green for a long (both Bullish, bottom third).">Market</th>
        <th title="Spot price, then the price Kalshi's ladder centres on (its 50% line), and where spot sits in the Risk Range.">Price → Kalshi</th>
        <th title="The line with the best edge with at least $50 at its ask: on the shaded side when the row is shaded, on either side otherwise.">Best line</th>
        <th title="Lines with at least $50 at the ask of their better side, of all the event's lines.">Fillable</th>
        <th>Closes</th><th>Held</th></tr></thead>
      <tbody>{lines.markets.map(market => <MarketRows key={market.id || market.market} market={market} />)}
        <CurvesRows markets={lines.markets} /></tbody>
    </table>
  </div>;
}
