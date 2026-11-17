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

const cents = value => (isNum(value) ? (value * 100).toFixed(1) : 'N/A');
const pctOf = (part, whole) => (isNum(part) && isNum(whole) && whole ? (part / whole) * 100 : null);
const signedPct = value => (isNum(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(Math.abs(value) >= 10 ? 0 : 1)}%` : 'N/A');
const acct = value => (isNum(value) ? `${value.toFixed(2)}%` : 'N/A');
const capital = word => word.charAt(0).toUpperCase() + word.slice(1);
const lineLabel = line => [WAY[line.strikeType] && capital(WAY[line.strikeType]), strikeText(line)].filter(Boolean).join(' ');

// One ledger row: a held line, a market's subtotal, or the book's total. Avg and Mark are cents per contract; P&L % is
// against cost; % acct is cost against the account.
function LedgerRow({ label, side, contracts, cost, value, account, state, className, title, closeNote, pnl: given, valueNote = '' }) {
  // The book's total P&L leaves out positions with no bid, so its own figure (and the cost it is against) wins.
  const pnl = isNum(given) ? given : isNum(value) ? value - cost : null;
  const basis = isNum(given) && isNum(value) ? value - given : cost;
  return <tr className={className}>
    <td title={title}>{label}</td>
    <td>{side}</td>
    <td>{Math.round(contracts).toLocaleString('en-US')}</td>
    <td>{cents(contracts ? cost / contracts : null)}</td>
    <td>{cents(isNum(value) && contracts ? value / contracts : null)}</td>
    <td>{money(cost)}</td>
    <td>{money(value)}{isNum(value) ? valueNote : ''}</td>
    <td className={tone(pnl)}>{signed(pnl)}</td>
    <td className={tone(pnl)}>{signedPct(pctOf(pnl, basis))}</td>
    <td>{money(contracts)}</td>
    <td>{acct(pctOf(cost, account))}</td>
    <td>{state || closeNote || ''}</td>
  </tr>;
}

function closeShare(book) {
  if (!book.topClose || !isNum(book.topClose.pct)) return null;
  const day = new Date(`${book.topClose.day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `${Math.round(book.topClose.pct)}% closes ${day}`;
}

const sumOf = (items, key) => items.reduce((total, item) => total + (isNum(item[key]) ? item[key] : 0), 0);
const lineValue = line => (isNum(line.value) ? line.value : isNum(line.bid) ? line.bid * line.contracts : null);

// The Kalshi account at the end of the Predictive Markets report, as a spreadsheet: a row of account figures over a
// ledger with one row per held line, grouped by market (section · market · close) with a subtotal, and a book total.
export default function AnalystKalshiBook({ book }) {
  const { positions } = book;
  const markets = new Set(positions.map(position => position.market)).size;
  const rows = [];
  for (const position of positions) {
    const side = SIDE[position.side] || [position.side, ''];
    const sideCell = <span className={`analyst-book__side ${side[1]}`}>{side[0]}</span>;
    const red = position.tone === 'red' ? ' analyst-lines__tone-red' : '';
    const key = `${position.market}-${position.side}`;
    rows.push(<tr key={`${key}-head`} className="analyst-book__section"><td colSpan={12}>
      {[position.sectionLabel, position.market, position.closeTime ? `closes ${closes(position.closeTime)}` : null].filter(Boolean).join(' · ')}</td></tr>);
    position.lines.forEach((line, index) => {
      const state = STATE[line.state || position.state] || STATE.HOLD;
      rows.push(<LedgerRow key={`${key}-${line.ticker || index}`} className={`analyst-book__line${red}`} label={lineLabel(line)} side={sideCell}
        title={line.ticker} contracts={line.contracts} cost={line.cost} value={lineValue(line)} account={book.account}
        state={<Chip className={state[1]} flash={(line.state || position.state) === 'CONTRADICTS'} title={position.why || undefined}>{state[0]}</Chip>} />);
    });
    const values = position.lines.map(lineValue);
    const value = isNum(position.value) ? position.value : values.includes(null) ? null : values.reduce((total, item) => total + item, 0);
    rows.push(<LedgerRow key={`${key}-sub`} className="analyst-book__subtotal" label={position.market} side=""
      contracts={sumOf(position.lines, 'contracts')} cost={position.cost} value={value} account={book.account} />);
  }
  const unvalued = book.unvalued ? `${book.unvalued} position${book.unvalued === 1 ? '' : 's'} with no bid left out` : undefined;
  const contracts = positions.reduce((total, position) => total + sumOf(position.lines, 'contracts'), 0);
  const flags = <><span className="is-negative">{book.flagged.red ?? 0}</span> · <span className="is-caution">{book.flagged.yellow ?? 0}</span></>;
  return <section className="analyst-book" aria-label="Kalshi book">
    <dl className="analyst-book__figures" aria-label="Kalshi account">
      {[['Account', money(book.account)], ['Cash', money(book.cash)], ['At risk', `${money(book.atRisk)} · ${share(book.atRiskPct)}`],
        ['Flags', <span title="Red · yellow">{flags}</span>]].map(([label, value]) =>
        <div key={label} className="analyst-book__figure"><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
    {positions.length ? <div className="analyst-book__scroll"><table className="analyst-drivers__table analyst-book__ledger" aria-label="Kalshi positions">
      <thead><tr><th>Line</th><th>Side</th><th>Qty</th><th>Avg ¢</th><th>Mark ¢</th><th>Cost</th><th>Value</th><th>P&amp;L</th>
        <th>P&amp;L %</th><th>Max pay</th><th>% acct</th><th>State</th></tr></thead>
      <tbody>{rows}
        <LedgerRow className="analyst-book__total" label="Book" side={<span className="is-muted">{markets} mkt</span>} contracts={contracts}
          cost={book.atRisk} value={isNum(book.value) ? book.value : null} pnl={book.pnl} valueNote={unvalued ? '*' : ''}
          account={book.account} title={unvalued}
          closeNote={<span className="is-muted">{closeShare(book)}</span>} />
      </tbody>
    </table></div> : <p className="analyst-book__foot analyst-book__empty">No open lines.</p>}
  </section>;
}
