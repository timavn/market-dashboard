import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import SecurityRangeMeter from './SecurityRangeMeter';

const range = { low: 35.12, high: 46.65, source: 'ETF Pro', asOf: '2026-11-08', cadence: 'weekly' };
const meter = () => screen.getByRole('img');

test('shows % of range and names a weekly edition', () => {
  render(<SecurityRangeMeter range={{ ...range, price: 41.97 }} />);
  expect(meter()).toHaveTextContent('59%');
  expect(meter()).toHaveAttribute('title', 'Price 41.97 · Risk Range 35.12–46.65 · 59% of range · ETF Pro Nov 8, weekly');
});

test.each([[36, 'is-bottom'], [44, 'is-top']])('price %s reads %s', (price, tone) => {
  render(<SecurityRangeMeter range={{ ...range, price }} />);
  expect(meter()).toHaveClass(tone);
});

test('outside the range it names the broken end', () => {
  render(<SecurityRangeMeter range={{ ...range, price: 33 }} />);
  expect(meter()).toHaveClass('is-below');
  expect(meter()).toHaveTextContent('▾ 35.12');
});

test('no price, no meter', () => {
  const { container } = render(<SecurityRangeMeter range={{ ...range, price: null }} />);
  expect(container).toBeEmptyDOMElement();
});
