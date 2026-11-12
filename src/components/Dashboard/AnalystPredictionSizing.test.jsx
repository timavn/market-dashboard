import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionSizing, { parsePredictionSizing } from './AnalystPredictionSizing';

const gold = { market: 'Gold', side: 'Short', pct: '8.0%', maxPct: '10%',
  lost: [{ label: 'Dollar', points: '−1.0', note: '0.10 corr, dollar bullish' }, { label: 'Z-score', points: '−0.5', note: 'no reading' }],
  lines: [
    { line: 'Above 4,200', from: '+0.0% · +0.0σ', buy: 'No', ask: '51¢', kalshi: '52%', ours: '59%', edge: '+5.9', pct: '2.50%', stake: '$150 · 284' },
    { line: 'Above 4,240', from: '+1.0% · +1.0σ', buy: 'No', ask: '85¢', kalshi: '88%', ours: '91%', edge: '+2.1', pct: '5.10%', stake: '$306 · 355', capped: true },
  ],
  unspent: '0.40%', sigma: '±1.0% · ±42', implied: 'GVZ ±1.4% · ±61', quoted: 'Oct 10 10:00' };

test('parses only well-formed sizing blocks', () => {
  expect(parsePredictionSizing('not json')).toBeNull();
  expect(parsePredictionSizing('{"markets":[]}')).toBeNull();
  expect(parsePredictionSizing(JSON.stringify({ markets: [{ market: 'Gold', pct: '8.0%' }] })).markets[0]).toMatchObject({ lost: [], lines: [] });
});

test('shows the position, what cost it points, and one row per funded line', () => {
  render(<AnalystPredictionSizing sizing={parsePredictionSizing(JSON.stringify({ markets: [gold] }))} />);
  const block = screen.getByRole('region', { name: 'Gold position' });
  expect(block).toHaveTextContent('GoldShort8.0% of 10%Dollar −1.0Z-score −0.5');
  expect(within(block).getByText('Short')).toHaveClass('is-negative');
  const table = within(block).getByRole('table', { name: 'Gold lines' });
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Line', 'From centre', 'Buy', 'Ask', 'Kalshi odds', 'Our odds', 'Edge', '% of account', '$ · contracts']);
  const [first, second] = within(table).getAllByRole('row').slice(1);
  expect(first).toHaveTextContent('Above 4,200+0.0% · +0.0σNo51¢52%59%+5.92.50%$150 · 284');
  expect(second).toHaveTextContent('·cap');
  expect(block).toHaveTextContent('Unspent 0.40%Kalshi 1σ ±1.0% · ±42GVZ ±1.4% · ±61Quoted Oct 10 10:00');
});

test('without a balance the dollar column is left out, and a setup with no funded line says why', () => {
  const shares = { ...gold, lines: gold.lines.map(({ stake, capped, ...line }) => line), note: 'Kalshi balance unavailable; shares of the account only.' };
  const empty = { market: 'Bitcoin', side: 'Long', pct: '5.5%', lines: [], reason: 'No line with edge' };
  render(<AnalystPredictionSizing sizing={parsePredictionSizing(JSON.stringify({ markets: [shares, empty] }))} />);
  expect(within(screen.getByRole('table', { name: 'Gold lines' })).getAllByRole('columnheader')).toHaveLength(8);
  expect(screen.getByText('Kalshi balance unavailable; shares of the account only.')).toBeInTheDocument();
  const bitcoin = screen.getByRole('region', { name: 'Bitcoin position' });
  expect(bitcoin).toHaveTextContent('No line with edge');
  expect(within(bitcoin).getByText('Long')).toHaveClass('is-positive');
});
