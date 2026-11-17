import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionSizing, { parsePredictionSizing } from './AnalystPredictionSizing';

const gold = { market: 'Gold', side: 'Short', duration: 'Weekly · closes Nov 20 14:00', pct: '4.5%', maxPct: '5.5%', dollars: '$270 of $6,000',
  inputs: [{ label: 'Base', points: '3%' }, { label: 'Dollar', points: '+1', note: '-0.62 corr, dollar bullish' },
    { label: 'Tick', points: '−0.5', note: 'bullish' }, { label: 'Volume', points: '0', note: 'no reading' }],
  lines: [
    { line: 'Above 3,800', from: '-1.1%', buy: 'No', ask: '28¢', stake: '2.2% · $134', contracts: '456', wins: '$322' },
    { line: 'Above 3,760', from: '-2.2%', buy: 'No', ask: '17¢', stake: '2.2% · $134', contracts: '760', wins: '$626', capped: true },
  ],
  price: '3,844', move: '±101 (2.6%)', range: '3,712–3,871', vol: 'Vol moderate', unspent: '0.1%', quoted: 'Nov 16 08:02' };

test('parses only well-formed sizing blocks', () => {
  expect(parsePredictionSizing('not json')).toBeNull();
  expect(parsePredictionSizing('{"markets":[]}')).toBeNull();
  expect(parsePredictionSizing(JSON.stringify({ markets: [{ market: 'Gold', pct: '4.5%' }] })).markets[0]).toMatchObject({ inputs: [], lines: [] });
});

test('shows the position, what each input added, and one row per line', () => {
  render(<AnalystPredictionSizing sizing={parsePredictionSizing(JSON.stringify({ markets: [gold] }))} />);
  const block = screen.getByRole('region', { name: 'Gold Weekly position' });
  expect(block).toHaveTextContent('GoldShortWeekly · closes Nov 20 14:004.5% of 5.5%$270 of $6,000');
  expect(within(block).getByText('Short')).toHaveClass('is-negative');
  const size = within(block).getByRole('table', { name: 'Gold Weekly size' });
  expect(within(size).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Base', 'Dollar', 'Tick', 'Volume']);
  expect(within(size).getByText('+1')).toHaveClass('is-positive');
  expect(within(size).getByText('−0.5')).toHaveClass('is-negative');
  const table = within(block).getByRole('table', { name: 'Gold Weekly lines' });
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Line', 'From price', 'Buy', 'Ask', 'Stake', 'Contracts', 'Wins']);
  const [first, second] = within(table).getAllByRole('row').slice(1);
  expect(first).toHaveTextContent('Above 3,800-1.1%No28¢2.2% · $134456$322');
  expect(second).toHaveTextContent('·cap');
  expect(block).toHaveTextContent('Price 3,844Expected move ±101 (2.6%)Risk Range 3,712–3,871Vol moderateUnspent 0.1%Quoted Nov 16 08:02');
});

test('without a balance the contract columns are left out, and a ticket with no line says why', () => {
  const shares = { ...gold, dollars: undefined, lines: gold.lines.map(({ contracts, wins, capped, ...line }) => ({ ...line, stake: '2.2%' })),
    note: 'Kalshi balance unavailable; shares of the account only.' };
  const empty = { market: 'Bitcoin', side: 'Long', duration: 'Daily', pct: '5.5%', lines: [], reason: 'No line at 50¢ or less within reach' };
  render(<AnalystPredictionSizing sizing={parsePredictionSizing(JSON.stringify({ markets: [shares, empty] }))} />);
  expect(within(screen.getByRole('table', { name: 'Gold Weekly lines' })).getAllByRole('columnheader')).toHaveLength(5);
  expect(screen.getByText('Kalshi balance unavailable; shares of the account only.')).toBeInTheDocument();
  const bitcoin = screen.getByRole('region', { name: 'Bitcoin Daily position' });
  expect(bitcoin).toHaveTextContent('No line at 50¢ or less within reach');
  expect(within(bitcoin).getByText('Long')).toHaveClass('is-positive');
});
