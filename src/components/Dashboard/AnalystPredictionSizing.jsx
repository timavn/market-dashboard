import React from 'react';

// Each sized setup emitted by the setup board renderer as an ```analyst-sizing JSON block:
// its share of the Kalshi account, the inputs that cost it points, and the split across the event's lines.
export function parsePredictionSizing(text) {
  try {
    const value = JSON.parse(String(text || ''));
    const markets = Array.isArray(value?.markets)
      ? value.markets.filter(market => market && typeof market.market === 'string' && typeof market.pct === 'string')
        .map(market => ({ ...market, lost: Array.isArray(market.lost) ? market.lost : [], lines: Array.isArray(market.lines) ? market.lines : [] }))
      : [];
    return markets.length ? { markets } : null;
  } catch {
    return null;
  }
}

const SIDE_CLASS = { Long: 'is-positive', Short: 'is-negative' };
const COLUMNS = [['line', 'Line'], ['from', 'From centre'], ['buy', 'Buy'], ['ask', 'Ask'], ['kalshi', 'Kalshi odds'], ['ours', 'Our odds'],
  ['edge', 'Edge'], ['pct', '% of account'], ['stake', '$ · contracts']];

function SizedMarket({ market }) {
  // Without a Kalshi balance the split carries shares of the account only.
  const columns = COLUMNS.filter(([key]) => key !== 'stake' || market.lines.some(line => line.stake));
  const footer = [
    market.unspent && `Unspent ${market.unspent}`,
    market.sigma && `Kalshi 1σ ${market.sigma}`,
    market.implied && `${market.implied}`,
    market.quoted && `Quoted ${market.quoted}`,
  ].filter(Boolean);
  return <section className="analyst-sizing__market" aria-label={`${market.market} position`}>
    <div className="analyst-sizing__head">
      <span className="analyst-sizing__name">{market.market}</span>
      <span className={SIDE_CLASS[market.side] || undefined}>{market.side}</span>
      <span className="analyst-sizing__size">{market.pct}<span className="is-muted"> of {market.maxPct || '10%'}</span></span>
      {market.lost.map(item => <span key={item.label} className="analyst-sizing__lost" title={item.note || undefined}>
        {item.label} <span className="is-negative">{item.points}</span></span>)}
    </div>
    {market.lines.length > 0
      ? <table className="analyst-drivers__table analyst-sizing__table" aria-label={`${market.market} lines`}>
        <thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>{market.lines.map(line => <tr key={line.line}>
          {columns.map(([key]) => <td key={key} className={key === 'buy' ? (line.buy === 'Yes' ? 'is-positive' : 'is-negative') : undefined}>
            {line[key] ?? 'N/A'}{key === 'stake' && line.capped ? <span className="is-muted" title="Cut to the size at the ask"> ·cap</span> : null}
          </td>)}</tr>)}</tbody>
      </table>
      : <div className="analyst-sizing__reason">{market.reason || 'No line with edge'}</div>}
    {(footer.length > 0 || market.note) && <div className="analyst-sizing__foot">
      {footer.map(text => <span key={text}>{text}</span>)}{market.note && <span>{market.note}</span>}</div>}
  </section>;
}

export default function AnalystPredictionSizing({ sizing }) {
  return <div className="analyst-sizing">{sizing.markets.map(market => <SizedMarket key={market.market} market={market} />)}</div>;
}
