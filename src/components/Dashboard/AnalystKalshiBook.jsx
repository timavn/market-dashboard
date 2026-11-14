import React from 'react';
import { Chip, STATE, lineLabel } from './AnalystPredictionLines';

// The whole Kalshi account at the end of the Predictive Markets report, emitted as an ```analyst-kalshi-book JSON block.
export function parseKalshiBook(text) {
  try {
    const value = JSON.parse(String(text || ''));
    if (!value || typeof value !== 'object' || typeof value.atRisk !== 'number') return null;
    return { ...value, sections: Array.isArray(value.sections) ? value.sections : [], flags: Array.isArray(value.flags) ? value.flags : [],
      unmapped: Array.isArray(value.unmapped) ? value.unmapped : [], flagged: value.flagged || {}, caps: value.caps || {} };
  } catch {
    return null;
  }
}

const isNum = value => typeof value === 'number' && Number.isFinite(value);
const money = value => (isNum(value) ? `${value < 0 ? '−' : ''}$${Math.round(Math.abs(value)).toLocaleString('en-US')}` : 'N/A');
const share = value => (isNum(value) ? `${value.toFixed(1)}%` : 'N/A');
const DIRECTION = { LONG: ['Long', 'is-long'], SHORT: ['Short', 'is-short'], MIXED: ['Mixed', 'is-pass'] };
const TONE = { red: ['Red', 'is-red'], yellow: ['Yellow', 'is-yellow'], blue: ['Blue', 'is-blue'] };

function Tile({ label, value, note }) {
  return <div className="analyst-book__tile"><span className="analyst-book__label">{label}</span>
    <span className="analyst-book__value">{value}</span>{note && <span className="analyst-book__note">{note}</span>}</div>;
}

function SectionBars({ book }) {
  const cap = book.caps.sectionPct;
  const top = Math.max(30, cap || 0, ...book.sections.map(section => section.pct || 0));
  const scale = Math.ceil(top / 10) * 10;
  const width = value => `${Math.max(0, Math.min(100, ((value || 0) / scale) * 100))}%`;
  return <div className="analyst-book__block">
    <h4>At risk by section · % of account</h4>
    {book.sections.map(section => {
      const total = section.atRisk || 0;
      const yesPct = isNum(section.pct) && total ? (section.pct * (section.yes || 0)) / total : 0;
      return <div key={section.id} className="analyst-book__bar-row">
        <span>{section.label}</span>
        <span className="analyst-book__bar" role="img" aria-label={`${section.label} ${share(section.pct)} of account`}>
          <i className="is-yes" style={{ width: width(yesPct) }} />
          <i className="is-no" style={{ left: width(yesPct), width: width((section.pct || 0) - yesPct) }} />
          {isNum(cap) && <b style={{ left: width(cap) }} />}
        </span>
        <span className={total ? undefined : 'is-muted'}>{share(section.pct ?? 0)}</span>
      </div>;
    })}
    <p className="analyst-book__foot">Scale 0–{scale}%. Green = Yes, blue = No.{isNum(cap) ? ` Dashed mark = ${cap}% section cap.` : ' No section cap set.'}</p>
  </div>;
}

export default function AnalystKalshiBook({ book }) {
  const held = book.sections.filter(section => section.lines > 0);
  return <section className="analyst-book" aria-label="Kalshi book">
    <div className="analyst-book__tiles">
      <Tile label="Account" value={money(book.account)} note={isNum(book.cash) ? `${money(book.cash)} cash` : null} />
      <Tile label="At risk" value={money(book.atRisk)} note={isNum(book.atRiskPct) ? `${share(book.atRiskPct)} of account` : null} />
      <Tile label="Max payout" value={money(book.maxPayout)} note="if every line pays" />
      <Tile label="Open" value={`${book.openLines ?? 0} lines`} note={`${book.events ?? 0} events`} />
      <Tile label="Held lines flagged" value={<><span className="is-negative">{book.flagged.red ?? 0}</span> · <span className="is-caution">{book.flagged.yellow ?? 0}</span></>}
        note="red · yellow" />
      <Tile label="Bettable today" value={`${book.bettable ?? 0} lines`} note="Good or Strong, not held" />
    </div>
    <div className="analyst-book__grid">
      <SectionBars book={book} />
      <div className="analyst-book__block">
        <h4>Direction</h4>
        {held.length ? <table className="analyst-drivers__table analyst-book__table" aria-label="Kalshi book by section">
          <thead><tr><th>Section</th><th>Markets</th><th>At risk</th><th>Bet</th><th>State</th></tr></thead>
          <tbody>{held.map(section => {
            const direction = DIRECTION[section.direction];
            const state = STATE[section.state] || STATE.HOLD;
            return <tr key={section.id}><td>{section.label}</td><td title={section.markets.join(', ')}>{section.markets.join(', ')}</td>
              <td>{money(section.atRisk)}</td>
              <td>{direction ? <Chip className={direction[1]}>{direction[0]}</Chip> : 'N/A'}</td>
              <td><Chip className={state[1]}>{section.flagged > 1 && section.state !== 'CONTRADICTS' ? `${section.flagged} flags` : state[0]}</Chip></td></tr>;
          })}</tbody>
        </table> : <p className="analyst-book__foot">No open lines.</p>}
      </div>
      <div className="analyst-book__block">
        <h4>Book flags</h4>
        {book.flags.length ? <ul className="analyst-book__flags">{book.flags.map(flag => {
          const tone = TONE[flag.tone] || TONE.blue;
          return <li key={flag.text}><Chip className={tone[1]}>{tone[0]}</Chip><span>{flag.text}</span></li>;
        })}</ul> : <p className="analyst-book__foot">No book flags.</p>}
        {isNum(book.realized) && book.realized !== 0 && <p className="analyst-book__foot">Realized on open events:{' '}
          <span className={book.realized > 0 ? 'is-positive' : 'is-negative'}>{book.realized > 0 ? '+' : ''}{money(book.realized)}</span></p>}
        {book.unmapped.length > 0 && <p className="analyst-book__foot">Not on the board: {book.unmapped.map(line =>
          `${line.ticker.split('-')[0]} ${lineLabel(line)}`).join(', ')}.</p>}
      </div>
    </div>
  </section>;
}
