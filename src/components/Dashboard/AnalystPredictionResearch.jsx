import React, { useState } from 'react';

// What this morning's Hedgeye products say about each market in a setup-board
// section, emitted by the renderer as an ```analyst-research JSON block: one
// entry per mention, with the product, its time, the part of the sentence about
// that market, and the full sentence when it was trimmed.
const text = value => (typeof value === 'string' && value.trim() ? value : null);

export function parsePredictionResearch(raw) {
  try {
    const value = JSON.parse(String(raw || ''));
    const markets = Array.isArray(value?.markets) ? value.markets.filter(row => row && typeof row.market === 'string') : [];
    return markets.length ? {
      markets: markets.map(row => ({
        market: row.market,
        entries: Array.isArray(row.entries)
          ? row.entries.filter(entry => entry && text(entry.product) && text(entry.context)).map(entry => ({
            product: entry.product, time: text(entry.time), context: entry.context, source: text(entry.source),
          }))
          // Reports saved before entries listed each product's facts and quotes.
          : (Array.isArray(row.items) ? row.items : []).filter(item => item && text(item.product)).map(item => ({
            product: item.product,
            time: text(item.time),
            context: (Array.isArray(item.facts) ? item.facts : []).map(fact => fact?.text).filter(text).join(' · '),
            source: (Array.isArray(item.quotes) ? item.quotes : []).filter(text).join(' ') || null,
          })).filter(entry => entry.context),
      })),
    } : null;
  } catch {
    return null;
  }
}

// Directions and positions read in the sentence's own words; "Long-term" and "Buying" are not positions.
const TONE_WORD = /(\b(?:[Bb]ullish|BULLISH|[Bb]earish|BEARISH)\b|\b(?:Long|Short|Buy|Sell|Sold|BUY|SELL)\b(?![-\w]))/;
const toneOf = word => (/^(?:bull|long|buy)/i.test(word) ? 'is-positive' : 'is-negative');

function Context({ value }) {
  return value.split(TONE_WORD).map((part, index) => (index % 2
    ? <span key={index} className={`analyst-research__tone ${toneOf(part)}`}>{part}</span>
    : part));
}

function Entry({ entry, market, first, span }) {
  const [open, setOpen] = useState(false);
  return <tr className={first ? 'analyst-research__first' : undefined}>
    {first && <td className="analyst-research__market" rowSpan={span}>{market}</td>}
    <td className="analyst-research__product">{entry.product}</td>
    <td className="analyst-research__time">{entry.time || '—'}</td>
    <td className="analyst-research__context">
      <Context value={entry.context} />
      {open && <blockquote className="analyst-research__quote">{entry.source}</blockquote>}
    </td>
    <td className="analyst-research__source">
      {entry.source && <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>Source</button>}
    </td>
  </tr>;
}

export default function AnalystPredictionResearch({ research }) {
  return <section className="analyst-table-frame analyst-research" aria-label="Morning research">
    <table>
      <colgroup>
        <col className="analyst-research__market-col" />
        <col className="analyst-research__product-col" />
        <col className="analyst-research__time-col" />
        <col />
        <col className="analyst-research__source-col" />
      </colgroup>
      <thead><tr><th>Market</th><th>Product</th><th>PT</th><th>Context</th><th aria-label="Source" /></tr></thead>
      <tbody>
        {research.markets.map(row => (row.entries.length
          ? row.entries.map((entry, index) => <Entry key={`${row.market}-${index}`} entry={entry} market={row.market}
            first={index === 0} span={row.entries.length} />)
          : <tr key={row.market} className="analyst-research__first">
            <td className="analyst-research__market">{row.market}</td>
            <td className="analyst-research__quiet" colSpan={4}>Not mentioned</td>
          </tr>))}
      </tbody>
    </table>
  </section>;
}
