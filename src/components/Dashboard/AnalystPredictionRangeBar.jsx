import React from 'react';

// RR(low;high;price;decimals;unit) — emitted by the setup board renderer
// (scripts/analyst_sidecar/prediction_setup_board.py). Price may be empty when withheld.
const RANGE_TOKEN = /^RR\((-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)?;(\d);(%?)\)$/;

export function parsePredictionRange(value) {
  const match = String(value || '').trim().match(RANGE_TOKEN);
  if (!match) return null;
  const [, low, high, price, decimals, unit] = match;
  const range = { low: Number(low), high: Number(high), price: price === undefined ? null : Number(price),
    decimals: Number(decimals), unit };
  return range.high > range.low ? range : null;
}

export function predictionRangeLabel({ low, high, price, decimals, unit }) {
  const format = value => `${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit}`;
  const exact = price === null ? null : ((price - low) / (high - low)) * 100;
  const position = exact === null ? null : Math.round(exact);
  return { format, exact, position,
    text: `${price === null ? 'Price withheld' : `Price ${format(price)}`} · Risk Range ${format(low)}–${format(high)}${position === null ? '' : ` · ${position}%`}` };
}

// Position reads green in the top third (66%+), red in the bottom third (33% and below), ink between.
const positionTone = position => position === null ? '' : position >= 66 ? ' is-top' : position <= 33 ? ' is-bottom' : ' is-middle';

/** One-line price-in-range bar with bottom/top third levels. */
export default function AnalystPredictionRangeBar({ range }) {
  const { low, high, price } = range;
  const { format, exact, position, text } = predictionRangeLabel(range);
  const third = (high - low) / 3;
  const below = price !== null && price < low;
  const above = price !== null && price > high;
  const x = exact === null ? null : Math.max(0, Math.min(100, exact));
  // Near either end the label aligns inward so it never runs past the bar.
  const inside = x === null || below || above ? null
    : x < 18 ? { left: `${x}%`, transform: 'translateX(-4px)' }
      : x > 82 ? { right: `${100 - x}%`, transform: 'translateX(4px)' }
        : { left: `${x}%`, transform: 'translateX(-50%)' };
  return <div className="analyst-range-bar" role="img" aria-label={text} title={text}>
    {below && <span className="analyst-range-bar__price analyst-range-bar__price--below">{format(price)} ◂</span>}
    {above && <span className="analyst-range-bar__price analyst-range-bar__price--above">▸ {format(price)}</span>}
    <span className="analyst-range-bar__end analyst-range-bar__end--low">{format(low)}</span>
    <div className="analyst-range-bar__track">
      {inside && <span className="analyst-range-bar__price analyst-range-bar__price--inside" style={inside}>{format(price)}</span>}
      <span className="analyst-range-bar__line" />
      <span className="analyst-range-bar__mark analyst-range-bar__mark--bottom" />
      <span className="analyst-range-bar__mark analyst-range-bar__mark--top" />
      <span className="analyst-range-bar__level analyst-range-bar__level--bottom">{format(low + third)}</span>
      <span className="analyst-range-bar__level analyst-range-bar__level--top">{format(low + 2 * third)}</span>
      {x !== null && <span className={`analyst-range-bar__dot${below ? ' is-below' : above ? ' is-above' : ''}`} style={{ left: `${x}%` }} />}
    </div>
    <span className="analyst-range-bar__end analyst-range-bar__end--high">{format(high)}</span>
    <span className={`analyst-range-bar__position${positionTone(position)}`}>{position === null ? '—' : `${position}%`}</span>
  </div>;
}
