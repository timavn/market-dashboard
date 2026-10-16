import React from 'react';

// What this morning's Hedgeye products say about each market in a setup-board
// section, emitted by the renderer as an ```analyst-research JSON block:
// product, publication time, the facts it states, and the sentences they came from.
export function parsePredictionResearch(text) {
  try {
    const value = JSON.parse(String(text || ''));
    const markets = Array.isArray(value?.markets) ? value.markets.filter(row => row && typeof row.market === 'string') : [];
    return markets.length ? {
      markets: markets.map(row => ({
        market: row.market,
        items: (Array.isArray(row.items) ? row.items : []).filter(item => item && typeof item.product === 'string').map(item => ({
          product: item.product,
          time: typeof item.time === 'string' ? item.time : null,
          facts: (Array.isArray(item.facts) ? item.facts : []).filter(fact => fact && typeof fact.text === 'string'),
          quotes: (Array.isArray(item.quotes) ? item.quotes : []).filter(quote => typeof quote === 'string'),
        })),
      })),
    } : null;
  } catch {
    return null;
  }
}

const TONE_CLASS = { positive: 'is-positive', negative: 'is-negative', key: 'is-key' };

function ResearchItem({ item }) {
  return <li className="analyst-research__item">
    <span className="analyst-research__product">
      {item.product}{item.time && <span className="analyst-research__time">{item.time}</span>}
    </span>
    <span className="analyst-research__facts">
      {item.facts.map((fact, index) => <span key={`${fact.text}-${index}`} className={`analyst-research__fact ${TONE_CLASS[fact.tone] || ''}`.trim()}>{fact.text}</span>)}
    </span>
    {item.quotes.length > 0 && <details className="analyst-research__source">
      <summary>Source</summary>
      {item.quotes.map(quote => <blockquote key={quote}>{quote}</blockquote>)}
    </details>}
  </li>;
}

export default function AnalystPredictionResearch({ research }) {
  const covered = research.markets.filter(row => row.items.length);
  const quiet = research.markets.filter(row => !row.items.length).map(row => row.market);
  return <section className="analyst-research" aria-label="Morning research">
    {covered.map(row => <div key={row.market} className="analyst-research__market">
      <span className="analyst-research__name">{row.market}</span>
      <ul className="analyst-research__items">{row.items.map(item => <ResearchItem key={item.product} item={item} />)}</ul>
    </div>)}
    {quiet.length > 0 && <p className="analyst-research__quiet">Not mentioned this morning: {quiet.join(', ')}</p>}
  </section>;
}
