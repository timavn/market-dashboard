import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import MomoTrackerPanel from './MomoTrackerPanel';
import { normalizeVerifiedMomoTrackerSpots } from './momoTrackerContext';
import useHedgaiTickResearch from '../../../hooks/useHedgaiTickResearch';

jest.mock('../../../hooks/useHedgaiTickResearch', () => ({ __esModule: true, default: jest.fn() }));
beforeEach(() => useHedgaiTickResearch.mockReturnValue({ readings: {} }));

const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const SOURCE_URL = 'https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy';
const NASDAQ_URL = 'https://www.nasdaq.com/market-activity/stocks/msft';
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
// All numbers below are test-only fixtures; runtime rankings are provider data.
const roster = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'LLY', 'AVGO', 'META', 'TSLA', 'BRK.B'];
const contributorRow = (ticker, index, overrides = {}) => ({
  ticker,
  name: `${ticker} company`,
  weightPct: 8 - index * 0.5,
  marketCap: {
    status: 'available', value: 3.75e12, currency: 'USD', scope: 'company',
    timestampKind: 'retrieved', asOf: new Date(NOW).toISOString(),
    source: 'Nasdaq', sourceUrl: NASDAQ_URL,
  },
  quote: null,
  ...overrides,
});
const contributors = (overrides = {}) => freeze({
  status: 'available', asOf: '2026-09-09', fetchedAt: new Date(NOW).toISOString(),
  source: 'State Street / S&P Dow Jones Indices', sourceUrl: SOURCE_URL,
  rows: roster.map((ticker, index) => contributorRow(ticker, index)),
  ...overrides,
});
const row = (ticker, overrides = {}) => ({
  ticker, buyTrade: 1499.125, sellTrade: 1600, upside: 1.2, downside: -2.3,
  trend: 'BULLISH', rangeStatus: 'available', rangeStatusDate: null,
  ...overrides,
});
const publication = (rows = [row('MSFT')], overrides = {}) => freeze({
  status: 'available', publicationDate: '2026-09-10', rows, ...overrides,
});
const spot = (overrides = {}) => ({
  ticker: 'MSFT', status: 'live', price: 1500.25, changePercent: 1.23,
  asOf: new Date(NOW - 10_000).toISOString(), source: 'ibkr',
  ...overrides,
});
const momoEvidence = (extras = ['SNOW', 'NFLX']) => ({
  momoPublicationDate: '2026-09-10',
  momoSnapshot: {
    snapshotType: 'momo-tracker', date: '2026-09-10', meta: { stockCount: 8 },
    data: Object.fromEntries([...extras, 'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NVDA'].map((ticker) => [ticker, row(ticker)])),
  },
});
const tickerRow = (ticker) => screen.getByRole('rowheader', { name: ticker }).closest('tr');
const cells = (ticker) => within(tickerRow(ticker)).getAllByRole('cell');

function renderPanel(props = {}) {
  return render(<MomoTrackerPanel contributors={contributors()} nowMs={NOW} {...props} />);
}

test('keeps one unavailable shell for missing rankings without exposing provider failures or trading controls', () => {
  const { rerender } = render(<MomoTrackerPanel nowMs={NOW} />);
  const panel = screen.getByTestId('sp500-momo-tracker');
  expect(within(panel).getByRole('status')).toHaveTextContent('UNAVAILABLE');
  rerender(<MomoTrackerPanel nowMs={NOW} contributors={{ status: 'unavailable', reason: 'Raw provider failure.' }} snapshot={publication()} state="available" />);
  expect(screen.getByTestId('sp500-momo-tracker')).toBe(panel);
  expect(panel).not.toHaveTextContent('Raw provider failure.');
  expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  expect(panel.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
});

test('shows an in-panel loading state only while a contributor request is pending', () => {
  const { rerender } = render(<MomoTrackerPanel contributors={{ status: 'loading', rows: [] }} nowMs={NOW} />);
  const panel = screen.getByTestId('sp500-momo-tracker');
  expect(within(panel).getByRole('status')).toHaveTextContent('LOADING');
  expect(panel).not.toHaveTextContent('UNAVAILABLE');
  expect(panel).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  rerender(<MomoTrackerPanel contributors={{ status: 'unavailable', rows: [] }} nowMs={NOW} />);
  expect(within(panel).getByRole('status')).toHaveTextContent('UNAVAILABLE');
  expect(panel).not.toHaveAttribute('aria-busy');
  rerender(<MomoTrackerPanel contributors={contributors()} state="loading" nowMs={NOW} />);
  expect(screen.getAllByRole('rowheader')).toHaveLength(10);
  expect(within(panel).queryByRole('status')).not.toBeInTheDocument();
  expect(panel).not.toHaveAttribute('aria-busy');
});

test('ranks displayed leaders by market cap while excluding GOOG and preserving direct index percentages and daily performance', () => {
  const ranked = contributors({ rows: contributors().rows.map((entry) => ({
    ...entry, marketCap: {
      ...entry.marketCap,
      value: ['GOOGL', 'GOOG'].includes(entry.ticker) ? 6e12
        : entry.ticker === 'BRK.B' ? 875_123_456_789 : entry.marketCap.value,
    },
  })).reverse() });
  const prepared = publication([row('MSFT', { sellTrade: 1600.75 }), row('NVDA', { trend: 'BEARISH' })]);
  const spots = freeze({ MSFT: spot() });
  const before = JSON.stringify({ ranked, prepared, spots });
  renderPanel({ contributors: ranked, snapshot: prepared, spots, state: 'available' });
  const table = screen.getByRole('table');
  expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent))
    .toEqual(['#', 'TICKER', 'MKT CAP', 'S&P %', 'BUY TRADE', 'SPOT', 'DAY %', 'SELL TRADE', 'UPSIDE', 'DOWNSIDE', 'Ti / Te']);
  expect(table.querySelectorAll('col')).toHaveLength(11);
  expect(within(table).getAllByRole('rowheader').map((cell) => cell.textContent))
    .toEqual(['GOOGL', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'LLY', 'AVGO', 'META', 'TSLA', 'BRK.B']);
  expect(within(table).getAllByRole('row')).toHaveLength(11);
  expect(within(table).queryByRole('rowheader', { name: 'GOOG', exact: true })).not.toBeInTheDocument();
  expect(cells('MSFT').map((cell) => cell.textContent))
    .toEqual(['4', '$3.75T', '7.00%', '1,499', '1,500', '+1.23%', '1,601', '1.20%', '-2.30%', 'BULLISH']);
  expect(cells('BRK.B')[0]).toHaveTextContent('10');
  expect(cells('BRK.B')[1]).toHaveTextContent('$875.12B');
  expect(cells('GOOGL')[1]).toHaveTextContent('$6.00T');
  expect(cells('GOOGL')[2]).toHaveTextContent('6.00%');
  expect(screen.queryByText('S&P 500 · TOP 10 + MOMO')).not.toBeInTheDocument();
  expect(screen.queryByText(/OF INDEX/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /WEIGHTS/ })).not.toBeInTheDocument();
  expect(cells('GOOGL')[2]).toHaveAttribute('title', expect.stringContaining('As of 2026-09-09'));
  expect(cells('MSFT')[1]).toHaveAttribute('title', expect.stringContaining('Retrieved 2026-09-10'));
  expect(cells('MSFT')[5]).toHaveClass('is-positive');
  expect(cells('MSFT')[9]).toHaveClass('is-trend', 'is-bullish');
  expect(JSON.stringify({ ranked, prepared, spots })).toBe(before);
});

test.each([
  [1499.49, 1500.5, 1600.51, ['1,499', '1,501', '1,601']],
  [2.49, 3.5, 4.49, ['2', '4', '4']],
])('rounds displayed buy, spot and sell levels to whole numbers for %s / %s / %s', (buyTrade, price, sellTrade, expected) => {
  const prepared = publication([row('MSFT', { buyTrade, sellTrade })]);
  const spots = freeze({ MSFT: spot({ price }) });
  renderPanel({ snapshot: prepared, spots, state: 'available' });
  const displayed = cells('MSFT');
  expect([displayed[3].textContent, displayed[4].textContent, displayed[6].textContent]).toEqual(expected);
  expect(displayed[5]).toHaveTextContent('+1.23%');
  expect(displayed[7]).toHaveTextContent('1.20%');
  expect(displayed[8]).toHaveTextContent('-2.30%');
  expect(prepared.rows[0]).toMatchObject({ buyTrade, sellTrade });
  expect(spots.MSFT.price).toBe(price);
});

test('preserves rankings and quotes when current Hedgeye data is absent, older, or still loading', () => {
  const ranked = contributors();
  const spots = { MSFT: spot() };
  const { rerender } = renderPanel({ contributors: ranked, spots, state: 'unavailable' });
  const table = screen.getByRole('table');
  expect(cells('MSFT')[3]).toHaveTextContent('—');
  expect(cells('MSFT')[9]).toHaveTextContent('—');
  expect(screen.getByLabelText('MSFT verified live spot 1,500')).toBeInTheDocument();
  rerender(<MomoTrackerPanel contributors={ranked} spots={spots} snapshot={publication(undefined, { publicationDate: '2026-09-09' })} state="refresh-delayed" nowMs={NOW} />);
  expect(screen.getByRole('table')).toBe(table);
  expect(cells('MSFT')[3]).toHaveTextContent('—');
  rerender(<MomoTrackerPanel contributors={ranked} spots={spots} snapshot={publication()} state="loading" nowMs={NOW} />);
  expect(cells('MSFT')[3]).toHaveTextContent('—');
  rerender(<MomoTrackerPanel contributors={ranked} spots={spots} snapshot={publication()} state="refresh-delayed" nowMs={NOW} />);
  expect(cells('MSFT')[3]).toHaveTextContent('1,499');
  expect(screen.getByRole('table')).toBe(table);
});

test('keeps only GOOGL with its own research and quote even when GOOG has distinct data', () => {
  renderPanel({ snapshot: publication([
    row('GOOGL', { buyTrade: 327, sellTrade: 351, upside: 1.75, downside: -5.2, trend: 'BEARISH' }),
    row('GOOG', { buyTrade: 315, sellTrade: 362, upside: 4.5, downside: -6.1, trend: 'BULLISH' }),
    row('MSFT', { buyTrade: null, sellTrade: null, upside: null, downside: null, rangeStatus: 'outbucket', rangeStatusDate: '09/10', trend: 'NEUTRAL' }),
  ]), spots: {
    GOOGL: spot({ ticker: 'GOOGL', price: 345, changePercent: 0.08 }),
    GOOG: spot({ ticker: 'GOOG', price: 342, changePercent: 0.16 }),
  }, state: 'available' });
  expect(screen.queryByRole('rowheader', { name: 'GOOG', exact: true })).not.toBeInTheDocument();
  expect(cells('GOOGL').map((cell) => cell.textContent))
    .toEqual(['5', '$3.75T', '6.00%', '327', '345', '+0.08%', '351', '1.75%', '-5.20%', 'BEARISH']);
  expect(within(tickerRow('MSFT')).getAllByText('OUTBUCKET 09/10')).toHaveLength(2);
  expect(cells('MSFT')[7]).toHaveTextContent('—');
  expect(cells('MSFT')[9]).toHaveClass('is-neutral');
});

test('adds SNOW with its own MOMO range and quote without assigning a top-ten rank or index weight', () => {
  const supplemental = contributorRow('SNOW', 0, { weightPct: undefined });
  const prepared = publication([row('SNOW', { buyTrade: 310, sellTrade: 357, upside: 10.53, downside: -4 })]);
  renderPanel({
    contributors: contributors({ supplementalRows: [supplemental], ...momoEvidence(['SNOW', 'NFLX']) }),
    snapshot: prepared,
    spots: { SNOW: spot({ ticker: 'SNOW', price: 326.5, changePercent: 1.08 }) },
    state: 'available',
  });
  expect(cells('SNOW').map((cell) => cell.textContent))
    .toEqual(['—', '$3.75T', '—', '310', '327', '+1.08%', '357', '10.53%', '-4.00%', 'BULLISH']);
  expect(cells('SNOW')[0]).toHaveAttribute('title', expect.stringContaining('outside the ten largest S&P 500 companies'));
  expect(cells('SNOW')[3]).toHaveAttribute('title', 'Hedgeye MOMO Tracker · 2026-09-10');
  expect(screen.getAllByRole('rowheader').at(-1)).toHaveTextContent('SNOW');
});

test('automatically appends every current MOMO extra by market cap while keeping base ten first', () => {
  const supplements = [
    contributorRow('SNOW', 0, { marketCap: { ...contributorRow('SNOW', 0).marketCap, value: 1.2e11 } }),
    contributorRow('NFLX', 0, { marketCap: { ...contributorRow('NFLX', 0).marketCap, value: 4.5e11 } }),
  ];
  renderPanel({
    contributors: contributors({ supplementalRows: supplements, ...momoEvidence() }),
    snapshot: publication([row('SNOW'), row('NFLX'), row('AAPL'), row('GOOG')]), state: 'available',
  });
  expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([...roster, 'NFLX', 'SNOW']);
  expect(cells('NFLX')[0]).toHaveTextContent('—');
  expect(cells('NFLX')[1]).toHaveTextContent('$450.00B');
  expect(screen.queryByRole('rowheader', { name: 'GOOG', exact: true })).not.toBeInTheDocument();
});

test('encapsulates other share classes in the base ten and retains the exact MOMO class for uncovered companies', () => {
  renderPanel({
    contributors: contributors({
      supplementalRows: [contributorRow('FOX', 0)],
      ...momoEvidence(['BRK.A', 'FOX']),
    }),
    snapshot: publication([row('BRK.A'), row('FOX', { buyTrade: 55 }), row('FOXA', { buyTrade: 60 })]),
    state: 'available',
  });
  expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([...roster, 'FOX']);
  expect(cells('BRK.B')[3]).toHaveTextContent('—');
  expect(cells('FOX')[3]).toHaveTextContent('55');
  expect(cells('FOX')[1]).toHaveTextContent('$3.75T');
  expect(screen.queryByRole('rowheader', { name: 'BRK.A' })).not.toBeInTheDocument();
  expect(screen.queryByRole('rowheader', { name: 'FOXA' })).not.toBeInTheDocument();
});

test('keeps unavailable index weights as dashes alongside verified row weights', () => {
  renderPanel({ contributors: contributors({ rows: contributors().rows.map((entry) => entry.ticker === 'LLY'
    ? { ...entry, weightPct: null } : entry) }) });
  expect(cells('LLY')[2]).toHaveTextContent('—');
  expect(screen.queryByText(/OF INDEX/)).not.toBeInTheDocument();
  expect(cells('GOOGL')[2]).toHaveTextContent('6.00%');
});

test('does not duplicate SNOW if it enters the published top ten', () => {
  const ranked = contributors({ rows: contributors().rows.map((entry) => entry.ticker === 'BRK.B'
    ? { ...entry, ticker: 'SNOW', name: 'Snowflake' } : entry) });
  renderPanel({ contributors: ranked });
  expect(screen.getAllByRole('rowheader')).toHaveLength(10);
  expect(cells('SNOW')[0]).toHaveTextContent('10');
  expect(cells('SNOW')[2]).toHaveTextContent('3.50%');
});

test.each(['offline', 'disconnected', 'refreshFailed', 'stale', 'cacheOnly', 'seeded', 'mock'])(
  'keeps SNOW research separate from a quote marked %s', (flag) => {
    const spots = normalizeVerifiedMomoTrackerSpots(['SNOW'], {
      SNOW: { symbol: 'SNOW', source: 'ibkr', dataType: 'live', last: 326.5, timestamp: new Date(NOW).toISOString(), [flag]: true },
    }, { ibkr: { connected: true } }, NOW);
    renderPanel({ snapshot: publication([row('SNOW', { buyTrade: 310, sellTrade: 357 })]), spots, state: 'available' });
    expect(screen.getByLabelText('SNOW spot unavailable')).toHaveTextContent('—');
    expect(cells('SNOW')[5]).toHaveTextContent('—');
    expect(cells('SNOW')[3]).toHaveTextContent('310');
    expect(cells('SNOW')[6]).toHaveTextContent('357');
  },
);

test('expires a live spot independently and removes its daily change without removing ranks or ranges', () => {
  const ranked = contributors();
  const prepared = publication();
  const spots = freeze({ MSFT: spot({ asOf: new Date(NOW - 60_000).toISOString() }) });
  const { rerender } = renderPanel({ contributors: ranked, snapshot: prepared, spots, state: 'available' });
  const table = screen.getByRole('table');
  const cell = screen.getByLabelText('MSFT verified live spot 1,500');
  rerender(<MomoTrackerPanel contributors={ranked} snapshot={prepared} spots={spots} state="refresh-delayed" nowMs={NOW + 1} />);
  expect(screen.getByRole('table')).toBe(table);
  expect(screen.getByLabelText('MSFT spot unavailable')).toBe(cell);
  expect(cell).toHaveTextContent('—');
  expect(cells('MSFT')[5]).toHaveTextContent('—');
  expect(cells('MSFT')[3]).toHaveTextContent('1,499');
});

test('removes old Hedgeye ranges at New York midnight while retaining independently dated rankings', () => {
  const beforeMidnight = Date.parse('2026-09-11T03:59:59.999Z');
  const ranked = contributors({ asOf: '2026-09-10', fetchedAt: new Date(beforeMidnight).toISOString() });
  const prepared = publication();
  const { rerender } = renderPanel({ contributors: ranked, snapshot: prepared, state: 'refresh-delayed', nowMs: beforeMidnight });
  expect(cells('MSFT')[3]).toHaveTextContent('1,499');
  rerender(<MomoTrackerPanel contributors={ranked} snapshot={prepared} state="refresh-delayed" nowMs={beforeMidnight + 1} />);
  expect(screen.getAllByRole('rowheader')).toHaveLength(10);
  expect(cells('MSFT')[3]).toHaveTextContent('—');
  expect(cells('MSFT')[2]).toHaveTextContent('7.00%');
});

test.each(['offline', 'disconnected', 'refreshFailed', 'stale', 'cacheOnly', 'seeded', 'mock'])(
  'hides unverified rankings marked %s while available publications cannot substitute a roster', (flag) => {
    renderPanel({ contributors: contributors({ [flag]: true }), snapshot: publication(), state: 'available' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('UNAVAILABLE');
  },
);

test('requires a complete ranking and independently verified cap provenance', () => {
  const ranked = contributors();
  const invalidRows = ranked.rows.map((entry) => entry.ticker === 'MSFT'
    ? { ...entry, marketCap: { ...entry.marketCap, source: null } } : entry);
  const { rerender } = renderPanel({ contributors: contributors({ rows: invalidRows }) });
  expect(cells('MSFT')[0]).toHaveTextContent('10');
  expect(cells('MSFT')[1]).toHaveTextContent('—');
  expect(cells('MSFT')[2]).toHaveTextContent('7.00%');
  rerender(<MomoTrackerPanel contributors={contributors({ rows: ranked.rows.slice(0, 9) })} nowMs={NOW} />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  rerender(<MomoTrackerPanel contributors={contributors({ asOf: '2026-08-01' })} nowMs={NOW} />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('removes a failed-refresh live spot and daily return while keeping verified references', () => {
  const ranked = contributors();
  const prepared = publication();
  const quote = { symbol: 'MSFT', last: 1500.25, changePercent: 1.23, source: 'ibkr', dataType: 'live', timestamp: new Date(NOW).toISOString() };
  const normalize = (value) => normalizeVerifiedMomoTrackerSpots(['MSFT'], { MSFT: value }, { ibkr: { connected: true } }, NOW);
  const { rerender } = renderPanel({ contributors: ranked, snapshot: prepared, spots: normalize(quote), state: 'available' });
  expect(screen.getByLabelText('MSFT verified live spot 1,500')).toBeInTheDocument();
  rerender(<MomoTrackerPanel contributors={ranked} snapshot={prepared} spots={normalize({ ...quote, refreshFailed: true })} state="available" nowMs={NOW} />);
  expect(screen.getByLabelText('MSFT spot unavailable')).toHaveTextContent('—');
  expect(cells('MSFT')[5]).toHaveTextContent('—');
  expect(cells('MSFT')[3]).toHaveTextContent('1,499');
});

test('keeps delayed and live quote status in metadata without visible sublines', () => {
  const delayed = {
    status: 'delayed', price: 1495, changePercent: -0.37,
    asOf: '2026-09-10T17:45:00.000Z', marketDate: '2026-09-10',
    source: 'Nasdaq', sourceUrl: NASDAQ_URL,
  };
  const ranked = contributors({ rows: contributors().rows.map((entry) => entry.ticker === 'MSFT'
    ? { ...entry, quote: delayed } : entry) });
  const { rerender } = renderPanel({ contributors: ranked });
  expect(screen.getByLabelText('MSFT delayed spot 1,495')).toHaveTextContent(/^1,495$/);
  expect(cells('MSFT')[4]).toHaveAttribute('title', expect.stringContaining('DELAYED 13:45 ET'));
  expect(cells('MSFT')[4]).toHaveAttribute('title', expect.stringContaining('Observed 2026-09-10T17:45:00.000Z'));
  expect(cells('MSFT')[4]).not.toHaveTextContent('DELAYED');
  expect(cells('MSFT')[5]).toHaveTextContent('-0.37%');
  expect(cells('MSFT')[5]).toHaveClass('is-negative');
  expect(cells('MSFT')[4]).toHaveAttribute('title', expect.stringContaining('Nasdaq'));
  rerender(<MomoTrackerPanel contributors={ranked} spots={{ MSFT: spot() }} nowMs={NOW} />);
  expect(screen.getByLabelText('MSFT verified live spot 1,500')).toHaveTextContent(/^1,500$/);
  expect(cells('MSFT')[4]).toHaveAttribute('title', expect.stringContaining('LIVE · ibkr'));
  expect(cells('MSFT')[4]).not.toHaveTextContent('LIVE');
  expect(cells('MSFT')[5]).toHaveTextContent('+1.23%');
});

test('shows only the rounded official-close price and retains its date and delayed source in metadata', () => {
  const afterClose = Date.parse('2026-09-10T21:00:00.000Z');
  const closed = {
    status: 'last-close', price: 1510.6, changePercent: -0.19,
    asOf: '2026-09-10T20:00:00.000Z', marketDate: '2026-09-10', delayedSource: true,
    source: 'Nasdaq', sourceUrl: NASDAQ_URL,
  };
  const ranked = contributors({
    asOf: '2026-09-10', fetchedAt: new Date(afterClose).toISOString(),
    rows: contributors().rows.map((entry) => entry.ticker === 'MSFT' ? { ...entry, quote: closed } : entry),
  });
  renderPanel({ contributors: ranked, nowMs: afterClose, spots: { MSFT: spot({ asOf: new Date(afterClose).toISOString() }) } });
  const cell = screen.getByLabelText('MSFT last-close spot 1,511');
  expect(cell).toHaveTextContent(/^1,511$/);
  expect(cell).not.toHaveTextContent('LAST CLOSE');
  expect(cell.querySelector('small')).not.toBeInTheDocument();
  expect(cell).toHaveAttribute('title', expect.stringContaining('LAST CLOSE 09/10'));
  expect(cell).toHaveAttribute('title', expect.stringContaining('DELAYED SOURCE'));
  expect(cell).toHaveAttribute('title', expect.stringContaining('Market date 2026-09-10'));
  expect(cells('MSFT')[5]).toHaveTextContent('-0.19%');
  expect(screen.queryByLabelText('MSFT verified live spot 1,500')).not.toBeInTheDocument();
});

test.each(['offline', 'refreshFailed', 'stale', 'cacheOnly', 'seeded', 'mock'])(
  'hides quote and daily change marked %s without hiding independently verified weights', (flag) => {
    const invalidQuote = {
      status: 'delayed', price: 1495, changePercent: -0.37, [flag]: true,
      asOf: '2026-09-10T17:45:00.000Z', marketDate: '2026-09-10',
      source: 'Nasdaq', sourceUrl: NASDAQ_URL,
    };
    renderPanel({ contributors: contributors({ rows: contributors().rows.map((entry) => entry.ticker === 'MSFT'
      ? { ...entry, quote: invalidQuote } : entry) }) });
    expect(screen.getByLabelText('MSFT spot unavailable')).toHaveTextContent('—');
    expect(cells('MSFT')[5]).toHaveTextContent('—');
    expect(cells('MSFT')[2]).toHaveTextContent('7.00%');
  },
);


test('adds an exact published stock Tick before MOMO Trend without changing quotes or ranges', () => {
  useHedgaiTickResearch.mockReturnValue({ readings: { MSFT: { verified: true, tick: 'BEARISH', tickEvidence: {
    source: 'HedgAI Signals', sourceTicker: 'MSFT', sourceLabel: 'Microsoft', date: '2026-09-09',
    position: 'Short', matchType: 'exact', evidenceText: 'Microsoft: Short',
  } } } });
  renderPanel({ snapshot: publication(), state: 'available' });
  const trend = cells('MSFT').at(-1);
  expect(trend).toHaveTextContent('Ti ↓BULLISH');
  const signals = trend.querySelector('.pm-spx-momo-signals');
  expect(signals).toBeInTheDocument();
  expect([...signals.children].map((signal) => signal.textContent)).toEqual(['Ti ↓', 'BULLISH']);
  expect(within(trend).getByRole('img', { name: 'MSFT tick: Bearish' })).toHaveAttribute('data-publication-date', '2026-09-09');
  expect(cells('MSFT')[4]).toHaveTextContent('—');
  expect(cells('MSFT')[3]).toHaveTextContent('1,499');
});

test('MOMO shows compact Tick Wait separately from a directional published Trend', () => {
  useHedgaiTickResearch.mockReturnValue({ readings: { MSFT: { verified: true, tick: 'NEUTRAL', tickEvidence: {
    source: 'HedgAI Signals', sourceTicker: 'MSFT', sourceLabel: 'Microsoft', date: '2026-09-09',
    position: 'Wait', matchType: 'exact',
  } } } });
  renderPanel({ snapshot: publication(), state: 'available' });
  const trend = cells('MSFT').at(-1);
  expect(trend).toHaveTextContent('Ti →BULLISH');
  const tick = within(trend).getByRole('img', { name: 'MSFT tick: Wait and Watch (no directional call)' });
  expect(tick).toHaveClass('is-neutral');
  expect(tick).toHaveTextContent('→');
  expect(tick).not.toHaveTextContent('W');
  expect(trend).not.toHaveTextContent('NEUTRAL');
});
