import React from 'react';

// Each sized setup's tickets, emitted by the setup board renderer as an ```analyst-sizing JSON block: the position as a
// share of the Kalshi account, what each input added to it, and the lines it goes on for the daily or weekly event.
export function parsePredictionSizing(text) {
  try {
    const value = JSON.parse(String(text || ''));
    const markets = Array.isArray(value?.markets)
      ? value.markets.filter(market => market && typeof market.market === 'string' && typeof market.pct === 'string')
        .map(market => ({ ...market, inputs: Array.isArray(market.inputs) ? market.inputs : [], lines: Array.isArray(market.lines) ? market.lines : [] }))
      : [];
    return markets.length ? { markets } : null;
  } catch {
    return null;
  }
}

const SIDE_CLASS = { Long: 'is-positive', Short: 'is-negative' };
const COLUMNS = [['line', 'Line'], ['from', 'From price'], ['buy', 'Buy'], ['ask', 'Ask'], ['stake', 'Stake'], ['contracts', 'Contracts'], ['wins', 'Wins']];
const pointsClass = points => (/^\+/.test(points) ? 'is-positive' : /^[−-]/.test(points) ? 'is-negative' : undefined);

function Ticket({ market }) {
  // Without a Kalshi balance a line carries its share of the account only.
  const funded = market.lines.some(line => line.contracts);
  const columns = COLUMNS.filter(([key]) => funded || (key !== 'contracts' && key !== 'wins'));
  const name = [market.market, market.duration?.split(' · ')[0]].filter(Boolean).join(' ');
  const footer = [
    market.price && `Price ${market.price}`,
    market.move && `Expected move ${market.move}`,
    market.range && `Risk Range ${market.range}`,
    market.vol,
    market.unspent && `Unspent ${market.unspent}`,
    market.quoted && `Quoted ${market.quoted}`,
  ].filter(Boolean);
  return <section className="analyst-sizing__market" aria-label={`${name} position`}>
    <div className="analyst-sizing__head">
      <span className="analyst-sizing__name">{market.market}</span>
      <span className={SIDE_CLASS[market.side] || undefined}>{market.side}</span>
      {market.duration && <span>{market.duration}</span>}
      <span className="analyst-sizing__size">{market.pct}<span className="is-muted"> of {market.maxPct || '5.5%'}</span></span>
      {market.dollars && <span className="is-muted">{market.dollars}</span>}
    </div>
    {market.inputs.length > 0 && <table className="analyst-drivers__table analyst-sizing__inputs" aria-label={`${name} size`}>
      <thead><tr>{market.inputs.map(item => <th key={item.label}>{item.label}</th>)}</tr></thead>
      <tbody><tr>{market.inputs.map(item => <td key={item.label}>
        <span className={pointsClass(item.points)}>{item.points}</span>{item.note && <span className="is-muted"> {item.note}</span>}</td>)}</tr></tbody>
    </table>}
    {market.lines.length > 0
      ? <table className="analyst-drivers__table analyst-sizing__table" aria-label={`${name} lines`}>
        <thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>{market.lines.map(line => <tr key={line.line}>
          {columns.map(([key]) => <td key={key} className={key === 'buy' ? (line.buy === 'Yes' ? 'is-positive' : 'is-negative') : undefined}>
            {line[key] ?? 'N/A'}{key === 'contracts' && line.capped ? <span className="is-muted" title="All the size at the ask"> ·cap</span> : null}
          </td>)}</tr>)}</tbody>
      </table>
      : <div className="analyst-sizing__reason">{market.reason || 'No line within reach'}</div>}
    {(footer.length > 0 || market.note) && <div className="analyst-sizing__foot">
      {footer.map(text => <span key={text}>{text}</span>)}{market.note && <span>{market.note}</span>}</div>}
  </section>;
}

export default function AnalystPredictionSizing({ sizing }) {
  return <div className="analyst-sizing">{sizing.markets.map(market => <Ticket key={`${market.market} ${market.duration || ''}`} market={market} />)}</div>;
}
