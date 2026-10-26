import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionRangeBar, { parsePredictionRange } from './AnalystPredictionRangeBar';

const draw = token => render(<AnalystPredictionRangeBar range={parsePredictionRange(token)} />).container;

test('parses only well-formed range tokens', () => {
  expect(parsePredictionRange('RR(4100;4237;4197;0;)')).toEqual({ low: 4100, high: 4237, price: 4197, decimals: 0, unit: '' });
  expect(parsePredictionRange('RR(4.75;4.94;;2;%)')).toEqual({ low: 4.75, high: 4.94, price: null, decimals: 2, unit: '%' });
  expect(parsePredictionRange('RR(5;4;4.5;2;)')).toBeNull();
  expect(parsePredictionRange('4,197')).toBeNull();
});

test('an in-range price sits over its dot with the third levels below the bar', () => {
  const container = draw('RR(4100;4237;4197;0;)');
  expect(screen.getByRole('img')).toHaveAccessibleName('Price 4,197 · Risk Range 4,100–4,237 · 71%');
  expect(container.querySelector('.analyst-range-bar__price--inside')).toHaveTextContent('4,197');
  const label = container.querySelector('.analyst-range-bar__price--inside');
  expect(parseFloat(label.style.left)).toBeCloseTo(70.803, 2);
  expect(label.style.transform).toBe('translateX(-50%)');
  expect(container.querySelector('.analyst-range-bar__level--bottom')).toHaveTextContent('4,146');
  expect(container.querySelector('.analyst-range-bar__level--top')).toHaveTextContent('4,191');
});

test('a price at the low end aligns inward so it never overlaps the low label', () => {
  const container = draw('RR(4.75;4.94;4.75;2;%)');
  expect(container.querySelector('.analyst-range-bar__price--inside')).toHaveStyle({ left: '0%', transform: 'translateX(-4px)' });
  expect(container.querySelector('.analyst-range-bar__price--inside')).toHaveTextContent('4.75%');
});

test('below range moves the price over the low end in red with a left arrow', () => {
  const container = draw('RR(2399;2777;2350;0;)');
  expect(container.querySelector('.analyst-range-bar__price--below')).toHaveTextContent('2,350 ◂');
  expect(container.querySelector('.analyst-range-bar__price--inside')).toBeNull();
  expect(container.querySelector('.analyst-range-bar__dot')).toHaveClass('is-below');
  expect(container.querySelector('.analyst-range-bar__dot')).toHaveStyle({ left: '0%' });
});

test('above range moves the price over the high end in green with a right arrow', () => {
  const container = draw('RR(6.46;6.80;6.85;2;)');
  expect(container.querySelector('.analyst-range-bar__price--above')).toHaveTextContent('▸ 6.85');
  expect(container.querySelector('.analyst-range-bar__dot')).toHaveClass('is-above');
  expect(container.querySelector('.analyst-range-bar__dot')).toHaveStyle({ left: '100%' });
});

test('a withheld price draws the range without a dot or price', () => {
  const container = draw('RR(4100;4224;;0;)');
  expect(container.querySelector('.analyst-range-bar__dot')).toBeNull();
  expect(container.querySelector('.analyst-range-bar__price')).toBeNull();
  expect(container.querySelector('.analyst-range-bar__position')).toHaveTextContent('—');
});

test('the position reads green from 66%, red at 33% and below, ink between', () => {
  const tone = token => draw(token).querySelector('.analyst-range-bar__position').className;
  expect(tone('RR(0;100;66;0;)')).toContain('is-top');
  expect(tone('RR(0;100;65;0;)')).toContain('is-middle');
  expect(tone('RR(0;100;34;0;)')).toContain('is-middle');
  expect(tone('RR(0;100;33;0;)')).toContain('is-bottom');
  expect(tone('RR(0;100;;0;)')).toBe('analyst-range-bar__position');
});

test('the Alpha Code reads AC Trade/Trend in the bottom-left corner, AC N/A without one, with black dots at its levels inside the range', () => {
  expect(parsePredictionRange('RR(4100;4224;4216;0;;4180;4120;1;1;The Macro Show)').alphaCode)
    .toEqual({ trade: 4180, trend: 4120, approximate: true, dots: true, product: 'The Macro Show' });
  const gold = draw('RR(4100;4224;4216;0;;4180;4120;1;1;The Macro Show)');
  expect(gold.querySelector('.analyst-range-bar__alpha-code')).toHaveTextContent('AC : ~4,180/~4,120');
  expect([...gold.querySelectorAll('.analyst-range-bar__alpha-dot')].map(dot => Math.round(parseFloat(dot.style.left))))
    .toEqual([65, 16]);
  expect(gold.querySelector('[role="img"]')).toHaveAttribute('aria-label',
    'Price 4,216 · Risk Range 4,100–4,224 · 94% · Alpha Code ~4,180/~4,120 (Trade/Trend) · The Macro Show');
  // A missing level reads —; a level outside the range, or a code on another instrument, gets no dot.
  const ust2y = draw('RR(4.73;4.96;4.75;2;%;;4.4;0;1;Top 3 Things)');
  expect(ust2y.querySelector('.analyst-range-bar__alpha-code')).toHaveTextContent('AC : —/4.40');
  expect(ust2y.querySelectorAll('.analyst-range-bar__alpha-dot')).toHaveLength(0);
  expect(draw('RR(25979;26667;26703;0;;26500;26100;0;0;Top 3 Things)').querySelectorAll('.analyst-range-bar__alpha-dot')).toHaveLength(0);
  // Every bar keeps the corner: no published code reads AC N/A, muted.
  for (const token of ['RR(4100;4237;4197;0;)', 'RR(4100;4237;4197;0;;;;0;1;)']) {
    expect(draw(token).querySelector('.analyst-range-bar__alpha-code')).toHaveTextContent('AC : N/A');
    expect(draw(token).querySelector('.analyst-range-bar__alpha-code')).toHaveClass('is-na');
  }
});
