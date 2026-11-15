import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionLines, { parsePredictionLines } from './AnalystPredictionLines';
import AnalystKalshiBook, { parseKalshiBook } from './AnalystKalshiBook';

const silver = {
  id: 'silver', market: 'Silver', event: 'KXSILVERD-26NOV1317', shade: 'SHORT', open: true,
  summary: { price: 52.8, centre: 52.65, position: 0.92, unit: null, fillable: 24, total: 40, closeTime: '2026-11-16T22:00:00Z',
    best: { ticker: 'B', strike: 53.5, subtitle: '$53.50 or above', side: 'NO', ask: 0.8, edge: 0.051, depth: 400, strength: 'STRONG', isNew: true } },
  lines: { side: 'SHORT', buy: 'NO', illiquid: 1, closeTime: '2026-11-13T22:00:00Z', best: 0.06,
    counts: { STRONG: 2, GOOD: 0, WATCH: 0, PASS: 1 },
    lines: [
      { ticker: 'A', strike: 51.99, subtitle: '$51.99 or above', buy: 'NO', ask: 0.71, kalshiOdds: 0.71, ourOdds: 0.78, edge: 0.06, sigmas: 0.9,
        kalshiYes: 0.29, ourYes: 0.22, yes: { ask: 0.3, depth: 300, edge: -0.08 }, no: { ask: 0.71, depth: 400, edge: 0.06 },
        strength: 'STRONG', held: { side: 'NO', contracts: 317.73 } },
      { ticker: 'B', strike: 52.49, buy: 'NO', ask: 0.8, kalshiOdds: 0.8, ourOdds: 0.86, edge: 0.051, sigmas: 1.3, kalshiYes: 0.2, ourYes: 0.14,
        yes: { ask: 0.21, depth: 90, edge: -0.07 }, no: { ask: 0.8, depth: 800, edge: 0.051 }, strength: 'STRONG', isNew: true },
      { ticker: 'D', strike: 51.49, buy: 'NO', ask: 0.5, kalshiOdds: 0.5, ourOdds: 0.55, edge: 0.04, sigmas: 0.4, kalshiYes: 0.5, ourYes: 0.45,
        yes: { ask: 0.52, depth: 520, edge: -0.08 }, no: { ask: 0.5, depth: 20, edge: 0.04, illiquid: true }, strength: 'ILLIQUID' },
      { ticker: 'C', strike: 53.99, buy: 'NO', ask: 0.96, kalshiOdds: 0.96, ourOdds: 0.965, edge: 0.002, sigmas: 2.5, strength: 'PASS' },
    ] },
  held: [{ ticker: 'KXSILVERW-26NOV1317-T50.99', subtitle: '$50.99 or above', side: 'NO', contracts: 778.53, cost: 214.38, bid: 0.32,
    kalshiOdds: 0.335, ourOdds: 0.34, state: 'THROUGH_LINE', tone: 'yellow', why: 'Kalshi has the held side at 34%' }],
  worst: { state: 'THROUGH_LINE', tone: 'yellow' },
};
const gold = { id: 'gold', market: 'Gold', event: 'KXGOLDD-26NOV1317', shade: null, shadeReason: 'Trade Bullish, Trend Bearish', held: [], open: false,
  summary: { price: 3887.6, centre: 3883.47, position: 0.277, unit: null, fillable: 28, total: 40, closeTime: '2026-11-16T22:00:00Z',
    best: { ticker: 'G9', strike: 3957, subtitle: 'Above $3957', side: 'NO', ask: 0.89, edge: 0.013, depth: 445 } },
  lines: { side: null, illiquid: 1, closeTime: '2026-11-13T22:00:00Z', lines: [
    { ticker: 'G1', strike: 4000, subtitle: '$4,000 or above', kalshiOdds: 0.61, ourOdds: 0.6, sigmas: -0.3, better: 'NO',
      yes: { ask: 0.62, depth: 200, edge: -0.02 }, no: { ask: 0.4, depth: 300, edge: -0.004 } },
    { ticker: 'G2', strike: 4100, kalshiOdds: 0.015, ourOdds: 0.01, sigmas: 2.1, better: 'YES', illiquid: true,
      yes: { ask: 0.02, depth: 4, edge: -0.011, illiquid: true }, no: { ask: 0.99, depth: 990, edge: -0.0 } },
    { ticker: 'G3', strike: 4200, kalshiOdds: null, ourOdds: null, sigmas: 3.9, better: null, illiquid: true,
      yes: { ask: 0.01, depth: null, edge: null }, no: { ask: null, depth: null, edge: null, illiquid: true } }] } };
const copper = { id: 'copper', market: 'Copper', shade: null, shadeReason: 'Below range', held: [], open: false,
  summary: { price: 6.06, centre: null, position: -0.03, unit: null, best: null, fillable: null, total: null, closeTime: null } };
const ust30 = { id: 'ust30y', market: 'UST 30Y', shade: null, shadeReason: 'Trade Bearish, Trend Bullish', held: [], open: false,
  summary: { price: 5.47, centre: 5.55, position: 1, unit: '%', fillable: 16, total: 20, closeTime: '2026-11-30T20:30:00Z',
    best: { ticker: 'U', strike: 5.65, subtitle: '5.65% or above', side: 'NO', ask: 0.9, edge: 0.003, depth: 108 } } };
const bitcoin = { id: 'bitcoin', market: 'Bitcoin', shade: 'LONG', open: false,
  summary: { price: 68161.42, centre: 68218.74, position: 0.2, unit: null, fillable: 18, total: 60, closeTime: '2026-11-14T22:00:00Z',
    best: { ticker: 'D', strike: 73000, side: 'YES', ask: 0.4, edge: 0.021, depth: 2038, strength: 'WATCH' } },
  lines: { side: 'LONG', buy: 'YES', illiquid: 0, best: 0.021, counts: { STRONG: 0, GOOD: 0, WATCH: 1, PASS: 0 },
    lines: [{ ticker: 'D', strike: 73000, ask: 0.4, kalshiOdds: 0.4, ourOdds: 0.43, edge: 0.021, strength: 'WATCH' }] },
  held: [{ ticker: 'KXBTCD-26NOV1317-T72999.99', strike: 72999.99, side: 'NO', contracts: 317.73, cost: 95.32, state: 'CONTRADICTS', tone: 'red',
    why: 'Shaded long; line is held No' }],
  worst: { state: 'CONTRADICTS', tone: 'red' } };

const renderLines = () => render(<AnalystPredictionLines lines={parsePredictionLines(JSON.stringify({ markets: [silver, gold, bitcoin, copper, ust30] }))} />);

test('parses only well-formed line blocks', () => {
  expect(parsePredictionLines('nope')).toBeNull();
  expect(parsePredictionLines('{"markets":[]}')).toBeNull();
  expect(parsePredictionLines(JSON.stringify({ markets: [{ market: 'Gold' }] })).markets[0]).toMatchObject({ summary: {}, held: [], lines: null });
});

test('one row per market, shaded by Trade, Trend and the range third, with price, best line, fillable, close and held', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-13T20:00:00Z'));
  renderLines();
  jest.useRealTimers();
  const table = screen.getByRole('table', { name: 'Kalshi lines' });
  expect([...table.querySelector('thead').querySelectorAll('th')].map(cell => cell.textContent))
    .toEqual(['Market', 'Price → Kalshi', 'Best line', 'Fillable', 'Closes', 'Held']);
  const row = name => (within(table).queryByRole('button', { name }) || within(table).getByText(name)).closest('tr');
  // Shading: Silver short (red), Bitcoin long (green), the rest plain, each with a reason on hover.
  expect(row('Silver')).toHaveClass('is-shade-short');
  expect(row('Silver')).toHaveAttribute('title', 'Shaded short: Trade and Trend Bearish, price in the top third of the Risk Range');
  expect(row('Bitcoin')).toHaveClass('is-shade-long');
  expect(row('Gold')).not.toHaveClass('is-shade-short');
  expect(row('Gold')).not.toHaveClass('is-shade-long');
  expect(row('Gold')).toHaveAttribute('title', 'Unshaded: Trade Bullish, Trend Bearish');
  // Only a shaded market with a Good or Strong line opens by default.
  expect(within(table).getByRole('button', { name: 'Silver' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(table).getByRole('button', { name: 'Bitcoin' })).toHaveAttribute('aria-expanded', 'false');
  expect(within(table).getByRole('button', { name: 'Gold' })).toHaveAttribute('aria-expanded', 'false');
  expect(row('Gold')).toHaveTextContent('Gold3,887.6 → 3,883.5−0.1% · 28% of rangeNo Above $3957 · 89¢ · +1.3$445 at the ask28 / 40Mon 2 PM—');
  expect(row('Silver')).toHaveTextContent('52.80 → 52.65−0.3% · 92% of rangeNo $53.50 or above · 80¢ · +5.1 Strong$400 at the ask24 / 40Mon 2 PMNo 779 · $214Through line');
  expect(within(row('Silver')).getByText('Strong')).toHaveClass('is-flash');
  // Yields read in % with the gap in bp; later closes read as a date.
  expect(row('UST 30Y')).toHaveTextContent('5.47% → 5.55%+8 bp · 100% of rangeNo 5.65% or above · 90¢ · +0.3$108 at the ask16 / 20Nov 30—');
  // Copper has no open event: nothing to open.
  expect(within(table).queryByRole('button', { name: 'Copper' })).toBeNull();
  expect(row('Copper')).toHaveTextContent('6.06 → N/Abelow rangeNo line with $50 at the askN/ANo open event—');
  // Folded Bitcoin still shows its held line's worst state.
  expect(row('Bitcoin')).toHaveTextContent('No 318 · $95Contradicts');
  expect(within(row('Bitcoin')).getByText('Contradicts')).toHaveClass('is-red', 'is-flash');
  expect(screen.queryByRole('table', { name: 'Bitcoin Kalshi lines' })).toBeNull();
});

test('an open market lists graded lines best first, hides Pass lines behind a count, and its held lines', () => {
  renderLines();
  const lines = screen.getByRole('table', { name: 'Silver Kalshi lines' });
  const rows = within(lines).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent('$51.99 or above+0.9σ30¢ −8.071¢ +6.029% / 22%StrongNo 318');
  expect(rows[1]).toHaveTextContent('Above 52.49+1.3σ21¢ −7.080¢ +5.120% / 14%Strong · new—');
  // The setup's side (No) is the one highlighted; Yes sits beside it.
  expect(rows[0].cells[3]).toHaveClass('is-take');
  expect(rows[0].cells[2]).not.toHaveClass('is-take');
  expect(rows[0].cells[3]).toHaveAttribute('title', '$400 at 71¢');
  // Under $50 at the No ask: red row, Illiquid, thin side marked.
  expect(rows[2]).toHaveClass('analyst-lines__illiquid');
  expect(rows[2]).toHaveTextContent('Illiquid');
  expect(rows[2].cells[3]).toHaveClass('is-thin');
  expect(screen.getByText('1 illiquid (under $50 at the ask)')).toBeInTheDocument();
  expect(within(rows[1]).getByText('Strong · new')).toHaveClass('is-flash');
  fireEvent.click(screen.getByRole('button', { name: '1 below 1 point of edge · show' }));
  expect(within(lines).getAllByRole('row')).toHaveLength(5);
  const held = screen.getByRole('table', { name: 'Silver held lines' });
  expect(within(held).getAllByRole('row')[1]).toHaveTextContent('$50.99 or aboveNo 779$214.3832¢34% / 34%Through lineKalshi has the held side at 34%');
});

test('opening a row stops its flash; the color stays', () => {
  renderLines();
  const toggle = screen.getByRole('button', { name: 'Bitcoin' });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const chip = within(toggle.closest('tr')).getByText('Contradicts');
  expect(chip).toHaveClass('is-red');
  expect(chip).not.toHaveClass('is-flash');
  expect(screen.getByRole('table', { name: 'Bitcoin held lines' })).toHaveTextContent('Shaded long; line is held No');
});

const book = {
  account: 5783.87, cash: 2922.45, atRisk: 668.2, atRiskPct: 11.6, maxPayout: 1720, openLines: 3, events: 2,
  flagged: { red: 1, yellow: 1 }, value: 700.4, pnl: 52.2, unvalued: 1, topClose: { day: '2026-11-13', pct: 60.2 },
  positions: [
    { market: 'UST 10Y', sectionLabel: 'Rates', side: 'NO', cost: 481, pct: 8.3, value: 552.2, pnl: 71.2, maxPayout: 1375,
      closeTime: '2026-11-13T17:30:00Z', state: 'HOLD', tone: 'none', why: null,
      lines: [{ subtitle: '4.92% or above', strikeType: 'greater', contracts: 700, cost: 250 },
        { subtitle: '4.94% or above', strikeType: 'greater', contracts: 675, cost: 231 }] },
    { market: 'Bitcoin', sectionLabel: 'Crypto', side: 'NO', cost: 167.2, pct: 2.9, value: 148.2, pnl: -19, maxPayout: 300,
      closeTime: '2026-11-13T22:00:00Z', state: 'CONTRADICTS', tone: 'red', why: 'Shaded long; line is held No',
      lines: [{ subtitle: 'Above $73000', strikeType: 'greater', contracts: 300, cost: 167.2 }] },
    { market: 'KXOTHER', sectionLabel: 'Other', side: 'YES', cost: 20, pct: 0.3, value: null, pnl: null, maxPayout: 45,
      closeTime: null, state: 'CLOSED', tone: 'blue', why: 'Closed; awaiting settlement',
      lines: [{ strike: 1, contracts: 45, cost: 20 }] },
  ],
};

test('parses only a book with an at-risk figure', () => {
  expect(parseKalshiBook('{}')).toBeNull();
  expect(parseKalshiBook(JSON.stringify({ atRisk: 0 }))).toMatchObject({ positions: [], flagged: {} });
});

test('the book is a strip of totals over a positions ledger grouped by section', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-13T12:00:00Z'));
  render(<AnalystKalshiBook book={parseKalshiBook(JSON.stringify(book))} />);
  jest.useRealTimers();
  const region = screen.getByRole('region', { name: 'Kalshi book' });
  expect(region).toHaveTextContent('Account$5,784 $2,922 cash');
  expect(region).toHaveTextContent('At risk$668 11.6%');
  expect(region).toHaveTextContent('Value now$700 +$52 · +8.1%');
  expect(region).toHaveTextContent('Max payout$1,720 +$1,052 if all pay');
  expect(region).toHaveTextContent('Needs a look1 · 1 red · yellow');
  const ledger = screen.getByRole('table', { name: 'Kalshi positions' });
  expect(within(ledger).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Market', 'Bet', 'Lines', 'Cost', '% acct', 'Value now', 'P&L', 'Max payout', 'Closes', 'State']);
  const rows = within(ledger).getAllByRole('row').slice(1).map(row => row.textContent);
  expect(rows).toEqual([
    'Rates',
    'UST 10YNo above 4.92%, 4.94%2$4818.3%$552+$71$1,375Fri 9:30 AMHold',
    'Crypto',
    'BitcoinNo above $730001$1672.9%$148−$19$300Fri 2 PMContradicts',
    'Other',
    'KXOTHERYes 11$200.3%N/AN/A$45N/AClosed',
    'Total3 markets4$66811.6%$700*+$52$1,72060% closes Fri',
  ]);
  const bitcoin = within(ledger).getByText('Bitcoin').closest('tr');
  expect(bitcoin).toHaveClass('analyst-lines__tone-red');
  expect(within(bitcoin).getByText('Contradicts')).toHaveClass('is-red', 'is-flash');
  expect(within(bitcoin).getByText('Contradicts')).toHaveAttribute('title', 'Shaded long; line is held No');
  expect(within(ledger).getByText('UST 10Y').closest('tr').querySelector('[title]'))
    .toHaveAttribute('title', 'No 4.92% or above: 700 contracts, $250\nNo 4.94% or above: 675 contracts, $231');
});

test('a book with no positions says so under its totals', () => {
  render(<AnalystKalshiBook book={parseKalshiBook(JSON.stringify({ account: 6196, cash: 6196, atRisk: 0, atRiskPct: 0, maxPayout: 0,
    value: null, pnl: null, positions: [], flagged: { red: 0, yellow: 0 } }))} />);
  expect(screen.getByRole('region', { name: 'Kalshi book' })).toHaveTextContent('Account$6,196 $6,196 cash');
  expect(screen.queryByRole('table', { name: 'Kalshi positions' })).toBeNull();
  expect(screen.getByText('No open lines.')).toBeInTheDocument();
});

test('a market without a setup opens to its ungraded ladder, nearest liquid lines first', () => {
  renderLines();
  fireEvent.click(screen.getByRole('button', { name: 'Gold' }));
  const ladder = screen.getByRole('table', { name: 'Gold Kalshi lines' });
  expect(within(ladder).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Line', 'From centre', 'Yes', 'No', 'Yes odds K / ours']);
  // Quoted lines show, the thin one tinted red; the unquoted one folds.
  expect(within(ladder).getAllByRole('row')).toHaveLength(3);
  expect(within(ladder).getAllByRole('row')[2]).toHaveClass('analyst-lines__illiquid');
  const first = within(ladder).getAllByRole('row')[1];
  expect(first).toHaveTextContent('$4,000 or above−0.3σ62¢ −2.040¢ −0.461% / 60%');
  // No has the better edge here, so No is highlighted.
  expect(first.cells[3]).toHaveClass('is-take');
  expect(first.cells[2]).not.toHaveClass('is-take');
  expect(screen.getByText(/Unshaded · not graded/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show all 3 lines' }));
  const all = within(ladder).getAllByRole('row');
  expect(all).toHaveLength(4);
  expect(all[2]).toHaveClass('analyst-lines__illiquid');
  expect(all[2].cells[2]).toHaveClass('is-take', 'is-thin');
});

test('a long ladder opens to the 15 lines nearest even odds, in strike order, illiquid ones tinted', () => {
  const lines = Array.from({ length: 40 }, (_, index) => {
    const odds = 1 - index / 39;
    return { ticker: `L${index}`, strike: 100 + index, yesBid: odds, yesAsk: odds, kalshiOdds: odds, ourOdds: odds, sigmas: (index - 20) / 5,
      ...(index === 20 ? { illiquid: true } : {}) };
  });
  const market = { id: 'x', market: 'Nasdaq-100', event: 'E', gate: { side: null, reason: 'Tick Neutral' }, held: [], open: false,
    lines: { side: null, illiquid: 1, lines } };
  render(<AnalystPredictionLines lines={parsePredictionLines(JSON.stringify({ markets: [market] }))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nasdaq-100' }));
  const rows = within(screen.getByRole('table', { name: 'Nasdaq-100 Kalshi lines' })).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(15);
  const strikes = rows.map(row => Number(row.cells[0].textContent.replace('Above ', '')));
  expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
  expect(strikes).toContain(120);
  expect(rows[strikes.indexOf(120)]).toHaveClass('analyst-lines__illiquid');
  expect(screen.getByRole('button', { name: 'Show all 40 lines' })).toBeInTheDocument();
});
