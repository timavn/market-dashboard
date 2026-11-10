import React from 'react';
import './SecurityRangeMeter.css';

// Same thirds as the Predictive Markets bar: 33% and below reads red, 66% and above green.
const tone = position => (position >= 66 ? ' is-top' : position <= 33 ? ' is-bottom' : '');
const figure = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const edition = ({ source, asOf, cadence }) => (cadence === 'weekly' && source && asOf
  ? ` · ${source} ${new Date(`${asOf}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, weekly` : '');

/** One-line price-in-range meter: the range's thirds, the price dot, and % of range. */
export default function SecurityRangeMeter({ range }) {
  const { low, high, price } = range;
  if (!(high > low) || typeof price !== 'number' || !Number.isFinite(price)) return null;
  const position = Math.round(((price - low) / (high - low)) * 100);
  const below = price < low;
  const above = price > high;
  const left = Math.max(0, Math.min(100, position));
  const reading = below ? `▾ ${figure(low)}` : above ? `▴ ${figure(high)}` : `${position}%`;
  const label = `Price ${figure(price)} · Risk Range ${figure(low)}–${figure(high)} · ${below ? 'below the low' : above ? 'above the high' : `${position}% of range`}${edition(range)}`;
  return <span className={`security-range-meter${below ? ' is-below' : above ? ' is-above' : tone(position)}`} role="img" aria-label={label} title={label}>
    <span className="security-range-meter__track">
      <span className="security-range-meter__mark security-range-meter__mark--bottom" />
      <span className="security-range-meter__mark security-range-meter__mark--top" />
      <span className="security-range-meter__dot" style={{ left: `${left}%` }} />
    </span>
    <span className="security-range-meter__reading">{reading}</span>
  </span>;
}
