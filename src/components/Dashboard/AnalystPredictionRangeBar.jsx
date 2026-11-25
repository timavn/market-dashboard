import React from 'react';

// RR(low;high;price;decimals;unit[;acTrade;acTrend;approx;dots;product][;@roll]) — emitted by the setup board renderer
// (scripts/analyst_sidecar/prediction_setup_board.py). Price may be empty when withheld; boards with the
// morning's research add the Alpha Code, whose levels are marked on the bar when dots is 1. @roll: the price is the
// contract month trading while the range is still on the expiring one, so it is shown but given no position.
const NUMBER = '(-?\\d+(?:\\.\\d+)?)';
const RANGE_TOKEN = new RegExp(`^RR\\(${NUMBER};${NUMBER};${NUMBER}?;(\\d);(%?)(?:;${NUMBER}?;${NUMBER}?;([01]);([01]);([^;()]*))?(;@roll)?\\)$`);

export function parsePredictionRange(value) {
  const match = String(value || '').trim().match(RANGE_TOKEN);
  if (!match) return null;
  const [, low, high, price, decimals, unit, acTrade, acTrend, approximate, dots, product, roll] = match;
  const range = { low: Number(low), high: Number(high), price: price === undefined ? null : Number(price),
    decimals: Number(decimals), unit, ...(roll ? { offContract: true } : {}) };
  if (approximate !== undefined) {
    range.alphaCode = { trade: acTrade === undefined ? null : Number(acTrade), trend: acTrend === undefined ? null : Number(acTrend),
      approximate: approximate === '1', dots: dots === '1', product: product.trim() };
  }
  return range.high > range.low ? range : null;
}

// Alpha Code levels as Hedgeye prints them, Trade/Trend: yields to two decimals, 4,180, 92, 6.45.
const alphaLevel = (value, unit) => (unit === '%' ? value.toFixed(2)
  : value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }));
export const alphaCodeLevels = ({ trade, trend, approximate }, unit) => (trade === null && trend === null ? 'N/A' : [trade, trend]
  .map(value => (value === null ? '—' : `${approximate ? '~' : ''}${alphaLevel(value, unit)}`)).join('/'));

export function predictionRangeLabel({ low, high, price, decimals, unit, alphaCode, offContract }) {
  const format = value => `${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit}`;
  const exact = price === null ? null : ((price - low) / (high - low)) * 100;
  const position = exact === null || offContract ? null : Math.round(exact);
  const alpha = alphaCode ? ` · Alpha Code ${alphaCodeLevels(alphaCode, unit)} (Trade/Trend)${alphaCode.product ? ` · ${alphaCode.product}` : ''}` : '';
  return { format, exact, position,
    text: `${price === null ? 'Price withheld' : `Price ${format(price)}${offContract ? ' (contract month trading; the range is on the expiring month)' : ''}`} · Risk Range ${format(low)}–${format(high)}${position === null ? '' : ` · ${position}%`}${alpha}` };
}

// Position reads green in the top third (66%+), red in the bottom third (33% and below), ink between.
const positionTone = position => position === null ? '' : position >= 66 ? ' is-top' : position <= 33 ? ' is-bottom' : ' is-middle';

/** One-line price-in-range bar with bottom/top third levels and the Alpha Code in its bottom-left corner. */
export default function AnalystPredictionRangeBar({ range }) {
  const { low, high, price, unit, alphaCode, offContract } = range;
  const { format, exact, position, text } = predictionRangeLabel(range);
  // Every bar keeps its Alpha Code corner; a market with no published code reads AC N/A.
  const alphaLevels = alphaCode ? alphaCodeLevels(alphaCode, unit) : 'N/A';
  // Alpha Code levels inside the range are marked on the line; outside it they appear only in the AC text.
  const alphaMarks = alphaCode?.dots ? [alphaCode.trade, alphaCode.trend]
    .filter(level => level !== null && level >= low && level <= high).map(level => ((level - low) / (high - low)) * 100) : [];
  const third = (high - low) / 3;
  const below = price !== null && price < low;
  const above = price !== null && price > high;
  const x = exact === null ? null : Math.max(0, Math.min(100, exact));
  // Inside the range the price sits centered over the ball; past either end it takes the arrow beside the bar.
  const inside = x === null || below || above ? null : { left: `${x}%`, transform: 'translateX(-50%)' };
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
      {alphaMarks.map((left, index) => <span key={index} className="analyst-range-bar__alpha-dot" style={{ left: `${left}%` }} />)}
      {x !== null && <span className={`analyst-range-bar__dot${offContract ? ' is-off' : below ? ' is-below' : above ? ' is-above' : ''}`} style={{ left: `${x}%` }} />}
    </div>
    <span className="analyst-range-bar__end analyst-range-bar__end--high">{format(high)}</span>
    <span className={`analyst-range-bar__position${positionTone(position)}`}>{position === null ? '—' : `${position}%`}</span>
    <span className={`analyst-range-bar__alpha-code${alphaLevels === 'N/A' ? ' is-na' : ''}`}>AC : {alphaLevels}</span>
  </div>;
}
