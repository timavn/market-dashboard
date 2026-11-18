import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionLines, { parsePredictionLines, settlementGrid } from './AnalystPredictionLines';
import AnalystKalshiBook, { parseKalshiBook } from './AnalystKalshiBook';

const silver = {
  id: 'silver', market: 'Silver', event: 'KXSILVERD-26NOV1317', shade: 'SHORT', open: true,
  summary: { price: 52.8, centre: 52.65, position: 0.92, unit: null, fillable: 24, total: 40, closeTime: '2026-11-16T22:00:00Z',
    best: { ticker: 'B', strike: 53.5, subtitle: '$53.50 or above', side: 'NO', ask: 0.8, edge: 0.051, depth: 400, strength: 'STRONG', isNew: true } },
  lines: { side: 'SHORT', buy: 'NO', illiquid: 1, closeTime: '2026-11-13T22:00:00Z', best: 0.06,
    counts: { STRONG: 2, GOOD: 0, WATCH: 0, PASS: 1 },
    lines: [
      { ticker: 'A', strike: 51.99, subtitle: '$51.99 or above', reach: true, buy: 'NO', ask: 0.71, kalshiOdds: 0.71, ourOdds: 0.78, edge: 0.06, sigmas: 0.9,
        kalshiYes: 0.29, ourYes: 0.22, yes: { ask: 0.3, depth: 300, edge: -0.08 }, no: { ask: 0.71, depth: 400, edge: 0.06 },
        strength: 'STRONG', held: { side: 'NO', contracts: 317.73 } },
      { ticker: 'B', strike: 52.49, reach: true, buy: 'NO', ask: 0.8, kalshiOdds: 0.8, ourOdds: 0.86, edge: 0.051, sigmas: 1.3, kalshiYes: 0.2, ourYes: 0.14,
        yes: { ask: 0.21, depth: 90, edge: -0.07 }, no: { ask: 0.8, depth: 800, edge: 0.051 }, ticket: { pct: 2.25, zone: 'target', ask: 0.8, contracts: 400, dollars: 320, win: 80 } },
      { ticker: 'D', strike: 51.49, reach: true, buy: 'NO', ask: 0.5, kalshiOdds: 0.5, ourOdds: 0.55, edge: 0.04, sigmas: 0.4, kalshiYes: 0.5, ourYes: 0.45,
        yes: { ask: 0.52, depth: 520, edge: -0.08 }, no: { ask: 0.5, depth: 20, illiquid: true }, illiquid: true },
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

test('one row per market: book icon, centred name, curve icon, shaded by Trade, Trend and the range third; nothing to open, no row', () => {
  renderLines();
  const table = screen.getByRole('table', { name: 'Kalshi lines' });
  expect(table.querySelector(':scope > thead')).toBeNull();
  const row = name => within(table).getByRole('button', { name: `${name} order book` }).closest('tr');
  expect([...table.querySelectorAll(':scope > tbody > tr.analyst-lines__row')].map(item => item.textContent)).toEqual(['BookCurveSilver', 'BookCurveGold', 'BookCurveBitcoin']);
  expect(row('Gold').cells).toHaveLength(1);
  expect(row('Gold')).toHaveTextContent(/^BookCurveGold$/);
  // Shading: Silver short (red), Bitcoin long (green), the rest plain, each with a reason on hover.
  expect(row('Silver')).toHaveClass('is-shade-short');
  expect(row('Silver')).toHaveAttribute('title', 'Shaded short: Trade and Trend Bearish, price in the top third of the Risk Range');
  expect(row('Bitcoin')).toHaveClass('is-shade-long');
  expect(row('Gold')).not.toHaveClass('is-shade-short');
  expect(row('Gold')).not.toHaveClass('is-shade-long');
  expect(row('Gold')).toHaveAttribute('title', 'Unshaded: Trade Bullish, Trend Bearish');
  // Every book starts closed, even a shaded market's with a Good or Strong line.
  expect(within(table).getByRole('button', { name: 'Silver order book' })).toHaveAttribute('aria-expanded', 'false');
  expect(within(table).getByRole('button', { name: 'Bitcoin order book' })).toHaveAttribute('aria-expanded', 'false');
  expect(within(table).getByRole('button', { name: 'Gold order book' })).toHaveAttribute('aria-expanded', 'false');
  // Copper (no open event) and UST 30Y (no lines, nothing held) have nothing to open, so no row.
  expect(within(table).queryByText('Copper')).toBeNull();
  expect(within(table).queryByText('UST 30Y')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Bitcoin Kalshi lines' })).toBeNull();
});

test('a setup\'s order book lists the side it buys and the lines in reach, the ticket tinted and totalled, spot as a rule', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-13T20:00:00Z'));
  renderLines();
  fireEvent.click(screen.getByRole('button', { name: 'Silver order book' }));
  jest.useRealTimers();
  // The label carries only the event and its close.
  expect(screen.getByText('KXSILVERD-26NOV1317').parentElement).toHaveTextContent(/^KXSILVERD-26NOV1317closes Fri 2:00 PM PT$/);
  const lines = screen.getByRole('table', { name: 'Silver Kalshi lines' });
  // A short buys No: only that side is shown, with no zone, odds, edge or grade.
  expect(within(lines).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Line', 'From price', 'No ask', 'At the ask', 'Stake', 'Contracts', 'Wins']);
  expect(lines).not.toHaveTextContent(/Strong|Good|Watch|Pass|edge|ours|Target|Near|Far/i);
  const rows = within(lines).getAllByRole('row').slice(1);
  // The three lines in reach below the price, then spot, then the one line on its other side.
  expect(rows.map(row => row.cells[0].textContent)).toEqual(['Above51.49', 'Above51.99', 'Above52.49', 'Spot52.80', 'Above53.99', 'Ticket']);
  expect(rows[1]).toHaveTextContent(/^Above51\.99−1\.3%71¢\$400———$/);
  // The ticket's line is tinted, its stake the share of the account over its dollars.
  expect(rows[2]).toHaveClass('analyst-lines__ticket');
  expect(rows[2]).toHaveTextContent(/^Above52\.49−0\.3%80¢\$8002\.25%\$320400\$80$/);
  expect([...rows[2].cells[4].querySelectorAll('.analyst-lines__stack')].map(item => item.textContent)).toEqual(['2.25%', '$320']);
  // Under $50 at the No ask: the thin ask is marked.
  expect(rows[0].cells[2]).toHaveClass('is-thin');
  // Spot is a rule across the table whose number sits in the same slot as the strikes.
  expect(rows[3]).toHaveClass('analyst-lines__spot');
  expect(rows[3].cells).toHaveLength(2);
  expect(rows[3].cells[1]).toHaveAttribute('colspan', '6');
  expect(rows[3].querySelector('.analyst-lines__spot-tag .analyst-lines__word')).toHaveTextContent('Spot');
  expect(rows[5]).toHaveClass('analyst-lines__total');
  expect(rows[5]).toHaveTextContent(/^Ticket80¢ avg2\.25%\$320400\$80$/);
  const held = screen.getByRole('table', { name: 'Silver held lines' });
  expect(within(held).getAllByRole('row')[1]).toHaveTextContent('Above50.99No 779$214.3832¢34%Through lineKalshi has the held side at 34%');
});

test('a setup with no line in reach falls back to the plain two-sided ladder', () => {
  const market = { ...silver, held: [], lines: { ...silver.lines, lines: silver.lines.lines.map(({ reach, ticket, ...line }) => line) } };
  render(<AnalystPredictionLines lines={parsePredictionLines(JSON.stringify({ markets: [market] }))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Silver order book' }));
  expect(within(screen.getByRole('table', { name: 'Silver Kalshi lines' })).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Line', 'From centre', 'Yes', 'No', 'Yes odds']);
});

test('a held line shows in the opened market with its state and reason', () => {
  renderLines();
  fireEvent.click(screen.getByRole('button', { name: 'Bitcoin order book' }));
  const held = screen.getByRole('table', { name: 'Bitcoin held lines' });
  expect(within(held).getByText('Contradicts')).toHaveClass('is-red');
  expect(held).toHaveTextContent('Shaded long; line is held No');
});

const book = {
  account: 5783.87, cash: 2922.45, atRisk: 668.2, atRiskPct: 11.6, maxPayout: 1720, openLines: 3, events: 2,
  flagged: { red: 1, yellow: 1 }, value: 700.4, pnl: 52.2, unvalued: 1, topClose: { day: '2026-11-13', pct: 60.2 },
  positions: [
    { market: 'UST 10Y', sectionLabel: 'Rates', side: 'NO', cost: 481, pct: 8.3, value: 552.2, pnl: 71.2, maxPayout: 1375,
      closeTime: '2026-11-13T17:30:00Z', state: 'HOLD', tone: 'none', why: null,
      lines: [{ ticker: 'T1', subtitle: '4.92% or above', strikeType: 'greater', contracts: 700, cost: 250, bid: 0.4, value: 280 },
        { ticker: 'T2', subtitle: '4.94% or above', strikeType: 'greater', contracts: 675, cost: 231, value: 272.2 }] },
    { market: 'Bitcoin', sectionLabel: 'Crypto', side: 'NO', cost: 167.2, pct: 2.9, value: 148.2, pnl: -19, maxPayout: 300,
      closeTime: '2026-11-13T22:00:00Z', state: 'CONTRADICTS', tone: 'red', why: 'Shaded long; line is held No',
      lines: [{ ticker: 'B1', subtitle: 'Above $73000', strikeType: 'greater', contracts: 300, cost: 167.2, bid: 0.494, state: 'CONTRADICTS' }] },
    { market: 'KXOTHER', sectionLabel: 'Other', side: 'YES', cost: 20, pct: 0.3, value: null, pnl: null, maxPayout: 45,
      closeTime: null, state: 'CLOSED', tone: 'blue', why: 'Closed; awaiting settlement',
      lines: [{ strike: 1, contracts: 45, cost: 20 }] },
  ],
};

test('parses only a book with an at-risk figure', () => {
  expect(parseKalshiBook('{}')).toBeNull();
  expect(parseKalshiBook(JSON.stringify({ atRisk: 0 }))).toMatchObject({ positions: [], flagged: {} });
});

test('the book is a row of account figures over a per-line ledger: market groups with subtotals and a book total', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-13T12:00:00Z'));
  render(<AnalystKalshiBook book={parseKalshiBook(JSON.stringify(book))} />);
  jest.useRealTimers();
  const figures = screen.getByRole('region', { name: 'Kalshi book' }).querySelector('.analyst-book__figures');
  expect([...figures.children].map(item => item.textContent)).toEqual(['Account$5,784', 'Cash$2,922', 'At risk$668 · 11.6%', 'Flags1 · 1']);
  const ledger = screen.getByRole('table', { name: 'Kalshi positions' });
  expect(within(ledger).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Line', 'Side', 'Qty', 'Avg ¢', 'Mark ¢', 'Cost', 'Value', 'P&L', 'P&L %', 'Max pay', '% acct', 'State']);
  const rows = within(ledger).getAllByRole('row').slice(1).map(row => row.textContent);
  expect(rows).toEqual([
    'Rates · UST 10Y · closes Fri 9:30 AM',
    // Avg and Mark in cents per contract; a line with no bid is marked from its value.
    'Above 4.92%No70035.740.0$250$280+$30+12%$7004.32%Hold',
    'Above 4.94%No67534.240.3$231$272+$41+18%$6753.99%Hold',
    'UST 10Y1,37535.040.2$481$552+$71+15%$1,3758.32%',
    'Crypto · Bitcoin · closes Fri 2 PM',
    'Above $73000No30055.749.4$167$148−$19−11%$3002.89%Contradicts',
    'Bitcoin30055.749.4$167$148−$19−11%$3002.89%',
    'Other · KXOTHER',
    '1Yes4544.4N/A$20N/AN/AN/A$450.35%Closed',
    'KXOTHER4544.4N/A$20N/AN/AN/A$450.35%',
    // The total's P&L is the book's own, against the cost of the valued lines; the value is starred for the unvalued one.
    'Book3 mkt1,72038.840.7$668$700*+$52+8.1%$1,72011.55%60% closes Fri',
  ]);
  const bitcoin = within(ledger).getByText('Above $73000').closest('tr');
  expect(bitcoin).toHaveClass('analyst-lines__tone-red');
  expect(within(bitcoin).getByText('Contradicts')).toHaveClass('is-red', 'is-flash');
  expect(within(bitcoin).getByText('Contradicts')).toHaveAttribute('title', 'Shaded long; line is held No');
  expect(within(ledger).getByText('Book')).toHaveAttribute('title', '1 position with no bid left out');
});

test('a book with no positions says so under its totals', () => {
  render(<AnalystKalshiBook book={parseKalshiBook(JSON.stringify({ account: 6196, cash: 6196, atRisk: 0, atRiskPct: 0, maxPayout: 0,
    value: null, pnl: null, positions: [], flagged: { red: 0, yellow: 0 } }))} />);
  expect(screen.getByRole('region', { name: 'Kalshi book' })).toHaveTextContent('Account$6,196Cash$6,196At risk$0 · 0.0%Flags0 · 0');
  expect(screen.queryByRole('table', { name: 'Kalshi positions' })).toBeNull();
  expect(screen.getByText('No open lines.')).toBeInTheDocument();
});

test('an unshaded market opens to its fillable lines with spot between them; illiquid ones fold behind a button', () => {
  renderLines();
  fireEvent.click(screen.getByRole('button', { name: 'Gold order book' }));
  const ladder = screen.getByRole('table', { name: 'Gold Kalshi lines' });
  expect(within(ladder).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Line', 'From centre', 'Yes', 'No', 'Yes odds']);
  expect(screen.queryByText(/not graded|illiquid \(/i)).toBeNull();
  // Only the fillable line shows, with spot (3,887.6) above it; no other fillable lines to show.
  const rows = () => within(ladder).getAllByRole('row').slice(1);
  expect(rows().map(row => row.cells[0].textContent)).toEqual(['Spot3,887.6', 'Above4,000.0']);
  expect(rows()[0]).toHaveClass('analyst-lines__spot');
  expect(rows()[1]).toHaveTextContent(/^Above4,000\.0−0\.3σ62¢40¢61%$/);
  // No setup, so neither side is marked.
  expect(rows()[1].cells[3]).not.toHaveClass('is-take');
  expect(rows()[1].cells[2]).not.toHaveClass('is-take');
  expect(screen.queryByRole('button', { name: /fillable lines/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 2 illiquid lines' }));
  expect(rows()).toHaveLength(4);
  expect(rows()[2]).toHaveClass('analyst-lines__illiquid');
  expect(rows()[2].cells[2]).toHaveClass('is-thin');
  expect(rows()[3]).toHaveClass('analyst-lines__illiquid');
});

test('a long ladder opens to the 15 fillable lines nearest even odds, in strike order, with spot among them', () => {
  const lines = Array.from({ length: 40 }, (_, index) => {
    const odds = 1 - index / 39;
    return { ticker: `L${index}`, strike: 100 + index, yesBid: odds, yesAsk: odds, kalshiOdds: odds, ourOdds: odds, sigmas: (index - 20) / 5,
      ...(index === 20 ? { illiquid: true } : {}) };
  });
  const market = { id: 'x', market: 'Nasdaq-100', event: 'E', held: [], open: false, summary: { price: 117.5 },
    lines: { side: null, illiquid: 1, lines } };
  render(<AnalystPredictionLines lines={parsePredictionLines(JSON.stringify({ markets: [market] }))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Nasdaq-100 order book' }));
  const rows = () => within(screen.getByRole('table', { name: 'Nasdaq-100 Kalshi lines' })).getAllByRole('row').slice(1);
  const lineRows = () => rows().filter(row => !row.classList.contains('analyst-lines__spot'));
  expect(lineRows()).toHaveLength(15);
  const strikes = lineRows().map(row => Number(row.cells[0].textContent.replace('Above', '')));
  expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
  expect(strikes).not.toContain(120);
  const spot = rows().findIndex(row => row.classList.contains('analyst-lines__spot'));
  expect(rows()[spot]).toHaveTextContent('Spot117.5');
  expect(rows()[spot - 1].cells[0]).toHaveTextContent('Above117');
  expect(rows()[spot + 1].cells[0]).toHaveTextContent('Above118');
  fireEvent.click(screen.getByRole('button', { name: 'Show all 39 fillable lines' }));
  expect(lineRows()).toHaveLength(39);
  fireEvent.click(screen.getByRole('button', { name: 'Show 1 illiquid line' }));
  expect(lineRows()).toHaveLength(40);
  expect(lineRows()[20]).toHaveClass('analyst-lines__illiquid');
});

test('with a bet, lines show the average the whole bet fills at; unread lines are not listed and short books fold', () => {
  const fill = (avg, contracts, best, worst, complete = true) => ({ avg, contracts, best, worst, complete, dollars: 248 });
  const market = { id: 'gold', market: 'Gold', event: 'KXGOLDD-26NOV1617', held: [], open: true, summary: { price: 3872.5 },
    lines: { side: null, bet: 247.83, closeTime: '2026-11-16T22:00:00Z', lines: [
      { ticker: 'G1', strike: 3867, subtitle: 'Above $3867', kalshiOdds: 0.6, ourOdds: 0.61, sigmas: -0.2, better: 'YES', checked: true,
        yes: { ask: 0.612, edge: -0.012, depth: 900, fill: fill(0.612, 405, 0.6, 0.63) }, no: { ask: 0.41, edge: -0.03, depth: 700, fill: fill(0.41, 605, 0.41, 0.41) } },
      { ticker: 'G2', strike: 3877, subtitle: 'Above $3877', kalshiOdds: 0.34, ourOdds: 0.3, sigmas: -0.1, better: 'NO', checked: true,
        yes: { ask: 0.366, edge: -0.08, depth: 1200, fill: fill(0.366, 677, 0.35, 0.46) }, no: { ask: 0.682, edge: 0.012, depth: 484, fill: fill(0.682, 364, 0.66, 0.69) } },
      { ticker: 'G3', strike: 3887, subtitle: 'Above $3887', kalshiOdds: 0.3, ourOdds: 0.27, sigmas: 0.1, better: 'NO', checked: true, illiquid: true,
        yes: { ask: 0.31, edge: -0.05, depth: 60, fill: fill(0.31, 190, 0.31, 0.31, false) }, no: { ask: 0.72, edge: 0.004, depth: 120, fill: fill(0.72, 166, 0.71, 0.73, false) } },
      { ticker: 'G4', strike: 3897, subtitle: 'Above $3897', kalshiOdds: 0.22, ourOdds: 0.2, sigmas: 0.3, better: 'NO',
        yes: { ask: 0.23, edge: -0.02, depth: 115 }, no: { ask: 0.79, edge: 0.004, depth: 395 } },
    ] } };
  render(<AnalystPredictionLines lines={parsePredictionLines(JSON.stringify({ markets: [market] }))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Gold order book' }));
  expect(screen.getByText('Bet $248')).toHaveClass('analyst-lines__bet');
  const table = screen.getByRole('table', { name: 'Gold Kalshi lines' });
  const rows = () => within(table).getAllByRole('row').slice(1);
  // G4's book was not read, so it is not listed; G3 cannot take the bet and folds.
  expect(rows().map(row => row.cells[0].textContent)).toEqual(['Above3867.0', 'Spot3872.5', 'Above3877.0']);
  const g2 = rows()[2];
  expect(g2.cells[2]).toHaveTextContent(/^36\.6¢$/);
  expect(g2.cells[3]).toHaveTextContent(/^68\.2¢$/);
  expect(g2.cells[3]).toHaveAttribute('title', '$248 buys 364 contracts at 66¢–69¢, average 68.2¢');
  expect(rows()[0].cells[3]).toHaveAttribute('title', '$248 buys 605 contracts at 41¢, average 41.0¢');
  fireEvent.click(screen.getByRole('button', { name: "Show 1 line that can't take $248" }));
  const g3 = rows().find(row => row.cells[0].textContent === 'Above3887.0');
  expect(g3).toHaveClass('analyst-lines__illiquid');
  expect(g3.cells[3]).toHaveAttribute('title', 'Only $120 for sale on this side; the $248 bet does not fill');
});

describe('settlement grid under the held lines', () => {
  const ladder = [[1700, 0.99], [1740, 0.97], [1760, 0.95], [1780, 0.9], [1800, 0.85], [1820, 0.75], [1840, 0.6], [1860, 0.42], [1880, 0.25], [1900, 0.12]];
  const eth = { id: 'eth', market: 'Ethereum', event: 'KXETHD-26NOV1614', held: [
    { ticker: 'E1760', side: 'NO', contracts: 590, cost: 47, bid: 0.03, strike: 1760, strikeType: 'greater', subtitle: '$1,760 or above', state: 'THROUGH_LINE' },
    { ticker: 'E1800', side: 'NO', contracts: 159, cost: 48, bid: 0.14, strike: 1800, strikeType: 'greater', subtitle: '$1,800 or above', state: 'THROUGH_LINE' },
  ], summary: { price: 1850, centre: 1852, unit: null },
  lines: { side: null, lines: ladder.map(([strike, odds]) => ({ ticker: `L${strike}`, strike, subtitle: `Above $${strike}`, kalshiOdds: odds })) } };

  it('cuts the axis at the held strikes: P&L per line and in total by zone, odds that sum to one, odds × P&L summed', () => {
    const grid = settlementGrid(eth);
    expect(grid.zones.map(zone => [zone.lo, zone.hi, zone.perLine.map(Math.round), Math.round(zone.pnl)]))
      .toEqual([[null, 1760, [543, 111], 654], [1760, 1800, [-47, 111], 64], [1800, null, [-47, -48], -95]]);
    expect(grid.zones.reduce((total, zone) => total + zone.odds, 0)).toBeCloseTo(1, 6);
    expect(grid.expected).toBeCloseTo(grid.zones.reduce((total, zone) => total + zone.odds * zone.pnl, 0), 6);
    expect(grid.marked).toBeCloseTo(0.03 * 590 + 0.14 * 159 - 95, 6);
    // Two sample prices a ladder step apart outside the held strikes, thirds between them, and spot in its zone.
    expect(grid.zones.map(zone => zone.rows.map(row => `${Math.round(row.x)}${row.spot ? ' spot' : ''}`)))
      .toEqual([['1720', '1740'], ['1773', '1787'], ['1820', '1840', '1850 spot']]);
  });

  it('draws under the held lines in the book, with spot ruled and zone odds merged per zone', () => {
    render(<AnalystPredictionLines lines={{ markets: [eth] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ethereum order book' }));
    const grid = screen.getByRole('table', { name: 'Ethereum settlement grid' });
    expect(within(grid).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Settle', 'Δ spot', 'No 1,760', 'No 1,800', 'Book P&L', 'P&L %', 'Above %', 'Zone odds', 'Odds × P&L']);
    const rows = within(grid).getAllByRole('row').slice(1);
    expect(rows[0].textContent).toMatch(/^1,720−7\.0%\+\$543\+\$111\+\$654\+688\.4%/);
    expect(rows[0].querySelectorAll('td[rowspan="2"]')).toHaveLength(2);
    const spot = rows.find(row => row.classList.contains('is-spot'));
    expect(spot.textContent).toMatch(/^1,850 spot0\.0%−\$47−\$48−\$95−100\.0%/);
    expect(rows.at(-1).textContent).toMatch(/^Expected at Kalshi odds · marked −\$55 at the bid−\$42−43\.8%100%−\$42$/);
  });

  it('is left out when no held line can be priced', () => {
    expect(settlementGrid({ ...eth, held: [{ ...eth.held[0], strikeType: 'between' }] })).toBeNull();
    expect(settlementGrid({ ...eth, held: [] })).toBeNull();
  });
});
