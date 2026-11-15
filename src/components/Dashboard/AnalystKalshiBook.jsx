import React from 'react';
import { Chip, STATE, closes } from './AnalystPredictionLines';

// The whole Kalshi account at the end of the Predictive Markets report, emitted as an ```analyst-kalshi-book JSON block:
// a strip of totals over a positions ledger (one row per market and side, grouped by section, with a total row).
export function parseKalshiBook(text) {
  try {
    const value = JSON.parse(String(text || ''));
    if (!value || typeof value !== 'object' || typeof value.atRisk !== 'number') return null;
    return { ...value, positions: Array.isArray(value.positions) ? value.positions : [], flagged: value.flagged || {} };
  } catch {
    return null;
  }
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const money = value => (isNum(value) ? `${Math.round(value) < 0 ? '−' : ''}$${Math.round(Math.abs(value)).toLocaleString('en-US')}` : 'N/A');
const signed = value => (isNum(value) ? `${Math.round(value) > 0 ? '+' : ''}${money(value)}` : 'N/A');
const tone = value => (!isNum(value) || Math.round(value) === 0 ? 'is-muted' : value > 0 ? 'is-positive' : 'is-negative');
const share = value => (isNum(value) ? `${value.toFixed(1)}%` : 'N/A');
const SIDE = { YES: ['Yes', 'is-positive'], NO: ['No', 'is-negative'] };
const WAY = { greater: 'above', greater_or_equal: 'above', less: 'below', less_or_equal: 'below' };

// "$53.50 or above" / "Above $3957" → "$53.50" / "$3957"; the direction word is said once for the row.
const strikeText = line => (line.subtitle ? line.subtitle.replace(/\s+or (above|below)$/i, '').replace(/^(above|below)\s+/i, '')
  : isNum(line.strike) ? line.strike.toLocaleString('en-US', { maximumFractionDigits: 4 }) : line.ticker);

function Bet({ position }) {
  const side = SIDE[position.side] || [position.side, ''];
  const ways = [...new Set(position.lines.map(line => WAY[line.strikeType]).filter(Boolean))];
  const strikes = position.lines.map(strikeText);
  const shown = strikes.length > 3 ? `${strikes.slice(0, 2).join(', ')} +${strikes.length - 2}` : strikes.join(', ');
  const title = position.lines.map(line =>
    `${side[0]} ${line.subtitle || strikeText(line)}: ${Math.round(line.contracts).toLocaleString('en-US')} contracts, ${money(line.cost)}`).join('\n');
  return <span title={title}><span className={`analyst-book__side ${side[1]}`}>{side[0]}</span> {ways.length === 1 ? `${ways[0]} ` : ''}{shown}</span>;
}

function Strip({ book }) {
  const cost = isNum(book.value) && isNum(book.pnl) ? book.value - book.pnl : null;
  const pnlPct = cost ? (book.pnl / cost) * 100 : null;
  const cells = [
    ['Account', money(book.account), isNum(book.cash) ? `${money(book.cash)} cash` : null],
    ['At risk', money(book.atRisk), isNum(book.atRiskPct) ? share(book.atRiskPct) : null],
    ['Value now', money(book.value), isNum(book.pnl)
      ? <span className={tone(book.pnl)}>{signed(book.pnl)}{isNum(pnlPct) ? ` · ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}</span> : null],
    ['Max payout', money(book.maxPayout), isNum(book.maxPayout) && book.atRisk ? `${signed(book.maxPayout - book.atRisk)} if all pay` : null],
    ['Needs a look', <><span className="is-negative">{book.flagged.red ?? 0}</span> · <span className="is-caution">{book.flagged.yellow ?? 0}</span></>,
      'red · yellow'],
  ];
  return <div className="analyst-book__tiles">{cells.map(([label, value, note]) =>
    <div key={label} className="analyst-book__tile"><span className="analyst-book__label">{label}</span>
      <span><span className="analyst-book__value">{value}</span>{note && <span className="analyst-book__note"> {note}</span>}</span></div>)}</div>;
}

function closeShare(book) {
  if (!book.topClose || !isNum(book.topClose.pct)) return null;
  const day = new Date(`${book.topClose.day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${Math.round(book.topClose.pct)}% closes ${day}`;
}

export default function AnalystKalshiBook({ book }) {
  const { positions } = book;
  const markets = new Set(positions.map(position => position.market)).size;
  const lines = positions.reduce((total, position) => total + position.lines.length, 0);
  const rows = [];
  let section = null;
  for (const position of positions) {
    const state = STATE[position.state] || STATE.HOLD;
    if (position.sectionLabel !== section) {
      section = position.sectionLabel;
      rows.push(<tr key={`section-${section}`} className="analyst-book__section"><td colSpan={10}>{section}</td></tr>);
    }
    rows.push(<tr key={`${position.market}-${position.side}`} className={position.tone === 'red' ? 'analyst-lines__tone-red' : undefined}>
      <td>{position.market}</td>
      <td><Bet position={position} /></td>
      <td>{position.lines.length}</td>
      <td>{money(position.cost)}</td>
      <td>{share(position.pct)}</td>
      <td>{money(position.value)}</td>
      <td className={tone(position.pnl)}>{signed(position.pnl)}</td>
      <td>{money(position.maxPayout)}</td>
      <td>{position.closeTime ? closes(position.closeTime) : 'N/A'}</td>
      <td><Chip className={state[1]} flash={position.state === 'CONTRADICTS'} title={position.why || undefined}>{state[0]}</Chip></td>
    </tr>);
  }
  const unvalued = book.unvalued ? `${book.unvalued} position${book.unvalued === 1 ? '' : 's'} with no bid left out` : undefined;
  return <section className="analyst-book" aria-label="Kalshi book">
    <Strip book={book} />
    {positions.length ? <div className="analyst-book__scroll"><table className="analyst-drivers__table analyst-book__ledger" aria-label="Kalshi positions">
      <thead><tr><th>Market</th><th>Bet</th><th>Lines</th><th>Cost</th><th>% acct</th><th>Value now</th><th>P&amp;L</th><th>Max payout</th>
        <th>Closes</th><th>State</th></tr></thead>
      <tbody>{rows}
        <tr className="analyst-book__total">
          <td>Total</td><td className="is-muted">{markets} market{markets === 1 ? '' : 's'}</td><td>{lines}</td>
          <td>{money(book.atRisk)}</td><td>{share(book.atRiskPct)}</td>
          <td title={unvalued}>{money(book.value)}{unvalued ? '*' : ''}</td>
          <td className={tone(book.pnl)}>{signed(book.pnl)}</td><td>{money(book.maxPayout)}</td>
          <td className="is-muted">{closeShare(book)}</td><td />
        </tr>
      </tbody>
    </table></div> : <p className="analyst-book__foot analyst-book__empty">No open lines.</p>}
  </section>;
}
