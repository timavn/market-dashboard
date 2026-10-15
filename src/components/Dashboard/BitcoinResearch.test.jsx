import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import BitcoinResearch from './BitcoinResearch';
import { loadBitcoinResearchStudy } from '../../services/bitcoinResearchService';
import { bitcoinUsdRules, loadBitcoinMatrixObservations } from '../../services/bitcoinResearchMatrix';

jest.mock('../../services/bitcoinResearchService', () => ({
  ...jest.requireActual('../../services/bitcoinResearchService'), loadBitcoinResearchStudy: jest.fn(),
}));
jest.mock('../../services/bitcoinResearchMatrix', () => ({
  ...jest.requireActual('../../services/bitcoinResearchMatrix'), loadBitcoinMatrixObservations: jest.fn(),
}));

const zones = [
  { id: 'below', label: 'Below range' }, { id: 'bottom', label: 'Bottom third' },
  { id: 'middle', label: 'Middle third' }, { id: 'top', label: 'Top third' }, { id: 'above', label: 'Above range' },
];
const filters = [{ id: 'none' }, ...['main', 'short_window'].flatMap(id => ['UP', 'DOWN'].map(usdDirection => ({
  id: `${id}_${usdDirection.toLowerCase()}`, usdDirection,
  correlationField: id === 'main' ? 'corr30Level' : 'corr15Level', correlationMax: -.5,
  minimumMoveBp: 10, moveField: 'usdSessionMoveBp',
})))];
const intervals = ['hourly', 'calendar_day', 'daily'].map(id => ({
  id, label: { hourly: 'Hourly', calendar_day: '24 hours', daily: 'NYSE session' }[id],
  startAt: '2025-01-01T00:00:00Z', endAt: '2026-09-15T00:00:00Z', zones, filters,
  entryModes: id === 'hourly'
    ? [{ id: 'all_hours', label: 'Every qualifying hour' }, { id: 'first_per_day', label: 'First qualifying hour per New York day' }]
    : [{ id: 'all_days', label: 'Every completed day' }],
  coverage: { eligibleEntryIntervals: 85, unknownSignalIntervals: 4, missingIntervalCount: 2 },
  methodology: [`${id} source timing`], volume: { methodology: ['Previous completed volume day.'] },
  downloads: [{ label: `${id} observations`, href: `/research/bitcoin/${id}-observations.csv` }],
}));
const study = { status: 'historical', intervals };

// Mock only the network boundary. Cell counts and every intersection below use
// the production selectors and calculations, not precomputed matrix samples.
const observation = (dayIndex, hour, updates = {}) => {
  const date = new Date(Date.UTC(2026, 0, 5 + dayIndex, hour + 5));
  const day = date.toISOString().slice(0, 10);
  return {
    startAt: date.toISOString(), timestamp: date.getTime(), endAt: new Date(date.getTime() + 3600000).toISOString(),
    day, year: 2026, weekday: date.getUTCDay(), hour,
    cohort: 'bullish', zone: 'bottom', direction: 'UP', returnPct: .5,
    filters: ['none', 'main_down'], quad: 1, volume: 'below_15d', volatility: null,
    ...updates,
  };
};
const hourlyRows = Array.from({ length: 12 }, (_, day) => [
  observation(day, 9),
  observation(day, 10, { volume: 'at_or_above_15d', direction: 'DOWN', returnPct: -.5 }),
  observation(day, 11, { quad: 3, filters: ['none', 'main_down', 'short_window_down'], direction: day < 9 ? 'UP' : 'DOWN', returnPct: day < 9 ? .5 : -.5 }),
  observation(day, 12, { quad: 3, volume: 'at_or_above_15d', filters: ['none', 'main_down', 'short_window_up'], direction: 'DOWN', returnPct: -.5 }),
  observation(day, 13, { quad: 3, filters: ['none', 'main_up', 'short_window_up'], direction: 'DOWN', returnPct: -.5 }),
  observation(day, 14, { quad: 3, cohort: 'bearish', zone: 'top' }),
  observation(day, 15, { quad: 3, cohort: 'neutral', zone: 'middle', direction: 'DOWN', returnPct: -.5 }),
]).flat();
hourlyRows.push(observation(12, 9, { quad: null, volume: null }));
const dataset = id => ({
  validated: true, intervalId: id, volatility: { status: 'unavailable' },
  startAt: intervals.find(item => item.id === id).startAt,
  endAt: intervals.find(item => item.id === id).endAt,
  usdRules: bitcoinUsdRules(intervals.find(item => item.id === id)),
  entryModes: id === 'hourly' ? ['all_hours', 'first_per_day'] : ['all_days'],
  rows: id === 'hourly' ? hourlyRows : (id === 'daily' ? ['UP', 'UP', 'DOWN'] : ['UP', 'UP', 'DOWN', 'UNCHANGED'])
    .map((direction, index) => observation(index, 9, { direction, returnPct: direction === 'UP' ? .5 : direction === 'DOWN' ? -.5 : 0, quad: 3 })),
});
const choose = (label, option) => {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option, exact: true }));
};
const mainCell = (name = 'Bullish · Bottom third · USD Down · All volatility') =>
  within(screen.getByRole('table', { name: 'Bitcoin probability matrix' })).getByRole('button', { name, exact: true });
const refinementCell = name => within(screen.getByRole('table', { name: 'Refinement probability matrix' })).getByRole('button', { name, exact: true });
const selectedSetup = () => screen.getByLabelText('Selected setup');
const selectedRefinement = () => screen.getByLabelText('Selected refinement');
const renderReady = async () => {
  render(<BitcoinResearch onClose={jest.fn()} />);
  return screen.findByRole('table', { name: 'Bitcoin probability matrix' });
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  loadBitcoinResearchStudy.mockReset().mockResolvedValue(study);
  loadBitcoinMatrixObservations.mockReset().mockImplementation(interval => Promise.resolve(dataset(interval.id)));
});

test('orders all 15 regime and range rows Bullish, Neutral, Bearish and USD columns Up, Off, Down', async () => {
  await renderReady();
  const table = screen.getByRole('table', { name: 'Bitcoin probability matrix' });
  expect(within(table).getAllByRole('row')).toHaveLength(17);
  expect([...table.querySelectorAll('th[scope="rowgroup"]')].map(cell => cell.textContent)).toEqual(['Bullish', 'Neutral', 'Bearish']);
  expect([...table.querySelectorAll('thead tr:first-child th')].map(cell => cell.textContent)).toEqual(['UP CLOSES %', 'USD UP', 'USD OFF', 'USD DOWN']);
  expect(within(table).getAllByRole('rowheader', { name: 'Below range', exact: true })).toHaveLength(3);
  expect(within(table).getAllByRole('rowheader', { name: 'Above range', exact: true })).toHaveLength(3);
  expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveTextContent('Historical US Quad');
  expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveTextContent('Volume');
  expect(screen.queryByRole('button', { name: /buy|sell|place order/i })).not.toBeInTheDocument();
});

test('uses flush custom selectors for arbitrary Quad subsets and recalculates selectable USD rules', async () => {
  await renderReady();
  expect(mainCell()).toHaveTextContent('44.9%');
  const trigger = screen.getByRole('combobox', { name: 'Historical US Quad' });
  const bounds = { top: 80, bottom: 108, left: 20, width: 160, height: 28 };
  jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(bounds);
  fireEvent.click(trigger);
  const menu = screen.getByRole('listbox', { name: 'Historical US Quad options' });
  expect(menu).toHaveAttribute('data-placement', 'bottom');
  expect(Number.parseFloat(menu.style.top)).toBe(bounds.bottom);
  expect(within(menu).getAllByRole('option')).toHaveLength(16);
  fireEvent.click(within(menu).getByRole('option', { name: 'Q1 + Q3', exact: true }));
  expect(trigger).toHaveTextContent('Q1 + Q3');
  expect(mainCell()).toHaveTextContent('43.8%');
  const lower = screen.getByRole('table', { name: 'Refinement probability matrix' });
  expect(within(lower).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Quad 1', 'Quad 3']);
  choose('USD rule', '15-session levels · ≤-0.50 · ≥10 bp · prior day');
  expect(mainCell()).toHaveTextContent('75.0%');
  expect(mainCell()).toHaveTextContent('12 / 12');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('drills into the real selected cohort, carries intersections into later layers and removes dependent layers', async () => {
  await renderReady();
  fireEvent.click(mainCell());
  expect(mainCell()).toHaveAttribute('aria-pressed', 'true');
  expect(selectedSetup()).toHaveTextContent('Bullish › Bottom third › USD Down › All volatility');
  expect(selectedSetup()).toHaveTextContent('44.9% · 49 / 13');
  expect(screen.getByText(/Comparable parent:/)).toHaveTextContent('43.8% · 48 / 12');
  const cell = refinementCell('Quad 3 · Below 15-day avg');
  expect(cell).toHaveTextContent('75.0%');
  expect(cell).toHaveTextContent('12 / 12');
  fireEvent.click(cell);
  expect(selectedRefinement()).toHaveTextContent('Δ +31.3 pp');
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  expect(screen.getByLabelText('Applied layers')).toHaveTextContent('Layer 1 · Quad 3 · Below 15-day avg');
  expect(screen.getByLabelText('Applied layers')).toHaveTextContent('75.0% · 12 / 12');
  expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveTextContent('Year');
  expect(screen.getByRole('combobox', { name: 'Columns' })).toHaveTextContent('Day of week · New York');
  choose('Columns', 'Entry hour · New York');
  expect(screen.getByText(/Comparable parent:/)).toHaveTextContent('75.0% · 12 / 12');
  expect(refinementCell('2026 · 09:00')).toBeDisabled();
  fireEvent.click(refinementCell('2026 · 11:00'));
  expect(selectedRefinement()).toHaveTextContent('75.0%');
  expect(selectedRefinement()).toHaveTextContent('12 / 12');
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  expect(screen.getByLabelText('Applied layers')).toHaveTextContent('Layer 2 · 2026 · 11:00');
  expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveTextContent('Day of week · New York');
  fireEvent.click(screen.getByRole('button', { name: 'Remove layer 1 and later layers' }));
  expect(screen.queryByLabelText('Applied layers')).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveTextContent('Historical US Quad');
  expect(screen.getByText(/Comparable parent:/)).toHaveTextContent('43.8% · 48 / 12');
});

test('changing the main setup or upstream conditions clears applied layers', async () => {
  await renderReady();
  fireEvent.click(mainCell());
  fireEvent.click(refinementCell('Quad 3 · Below 15-day avg'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  fireEvent.click(mainCell('Bearish · Top third · USD Down · All volatility'));
  expect(screen.queryByLabelText('Applied layers')).not.toBeInTheDocument();
  expect(selectedSetup()).toHaveTextContent('Bearish › Top third › USD Down');
  expect(selectedSetup()).toHaveTextContent('100.0% · 12 / 12');
  fireEvent.click(refinementCell('Quad 3 · Below 15-day avg'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  choose('Historical US Quad', 'Q1 + Q3');
  expect(screen.queryByLabelText('Applied layers')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply & add layer' })).toBeDisabled();
  expect(selectedSetup()).toHaveTextContent('Q1 + Q3 › Bearish');
});

test('a final one-factor matrix cannot append identical All-volume layers', async () => {
  await renderReady();
  fireEvent.click(mainCell());
  fireEvent.click(refinementCell('Quad 3 · All'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  choose('Rows', 'Year');
  choose('Columns', 'Day of week · New York');
  fireEvent.click(refinementCell('2026 · Mon'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  choose('Rows', 'Entry hour · New York');
  fireEvent.click(refinementCell('11:00 · All'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  expect(screen.getByRole('combobox', { name: 'Rows' })).toHaveTextContent('Volume');
  expect(screen.queryByRole('combobox', { name: 'Columns' })).not.toBeInTheDocument();
  fireEvent.click(refinementCell('All · All observations'));
  expect(screen.getByRole('button', { name: 'Apply & add layer' })).toBeDisabled();
  expect(screen.getByLabelText('Applied layers')).not.toHaveTextContent('Layer 4');
  fireEvent.click(refinementCell('Below 15-day avg · All observations'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  expect(screen.getByLabelText('Applied layers')).toHaveTextContent('Layer 4 · Below 15-day avg · All observations');
  expect(screen.queryByRole('table', { name: 'Refinement probability matrix' })).not.toBeInTheDocument();
  expect(screen.getByText('All available factors are applied. Remove a layer to explore another combination.')).toBeVisible();
});

test('recalculates the outcome and first-per-day sampling from observations', async () => {
  await renderReady();
  fireEvent.click(mainCell());
  fireEvent.click(refinementCell('Quad 3 · Below 15-day avg'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply & add layer' }));
  choose('Outcome', 'Down closes %');
  expect(within(screen.getByRole('table', { name: 'Bitcoin probability matrix' })).getByRole('columnheader', { name: 'DOWN CLOSES %' })).toBeVisible();
  expect(mainCell()).toHaveTextContent('55.1%');
  expect(screen.getByLabelText('Applied layers')).toHaveTextContent('25.0% · 12 / 12');
  choose('Sampling', 'First qualifying hour per New York day');
  expect(screen.queryByLabelText('Applied layers')).not.toBeInTheDocument();
  expect(mainCell()).toHaveTextContent('0.0%');
  expect(mainCell()).toHaveTextContent('13 / 13');
  choose('Outcome', 'Up closes %');
  expect(mainCell()).toHaveTextContent('100.0%');
});

test('keeps unavailable volatility cells disabled and low samples unshaded even when their percentage is high', async () => {
  await renderReady();
  expect(screen.getByText('BTC volatility buckets: UNAVAILABLE · bands not defined')).toBeVisible();
  const unavailable = mainCell('Bullish · Bottom third · USD Down · Investable volatility');
  expect(unavailable).toBeDisabled();
  expect(unavailable).toHaveTextContent('—');
  expect(unavailable).not.toHaveTextContent('%');
  expect(unavailable).toHaveAttribute('title', 'BTC volatility history and regime bands are unavailable.');
  const limited = mainCell('Bearish · Top third · USD Down · All volatility');
  expect(limited).toHaveTextContent('100.0% †');
  expect(limited.closest('td')).toHaveAttribute('data-limited', 'true');
  expect(limited.closest('td').style.backgroundColor).toBe('');
  expect(mainCell().closest('td').style.backgroundColor).not.toBe('');
  choose('Minimum sample', '100 hours / 30 days');
  expect(mainCell()).toHaveTextContent('44.9% †');
  expect(mainCell().closest('td').style.backgroundColor).toBe('');
});

test('loads each interval, preserves hourly sampling, and updates coverage and downloads', async () => {
  await renderReady();
  choose('Sampling', 'First qualifying hour per New York day');
  choose('Interval', 'NYSE session');
  await screen.findByRole('table', { name: 'Bitcoin probability matrix' });
  expect(mainCell()).toHaveTextContent('66.7%');
  expect(screen.queryByRole('combobox', { name: 'Sampling' })).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Minimum sample' })).toHaveTextContent('30 sessions');
  fireEvent.click(screen.getByRole('button', { name: 'Coverage' }));
  expect(screen.getByRole('region', { name: 'Research coverage' })).toHaveTextContent('Verified signal and range: 85 sessions');
  fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
  expect(screen.getByRole('link', { name: 'daily observations' })).toHaveAttribute('href', '/research/bitcoin/daily-observations.csv');
  choose('Interval', '24 hours');
  await screen.findByRole('table', { name: 'Bitcoin probability matrix' });
  expect(mainCell()).toHaveTextContent('50.0%');
  expect(screen.getByRole('link', { name: 'calendar_day observations' })).toBeVisible();
  choose('Interval', 'Hourly');
  await screen.findByRole('table', { name: 'Bitcoin probability matrix' });
  expect(screen.getByRole('combobox', { name: 'Sampling' })).toHaveTextContent('First qualifying hour per New York day');
  expect(mainCell()).toHaveTextContent('100.0%');
  expect(loadBitcoinMatrixObservations.mock.calls.map(([interval]) => interval.id)).toEqual(['hourly', 'daily', 'calendar_day', 'hourly']);
});

test('failed study loading is unavailable with no fabricated matrix and retry recovers', async () => {
  loadBitcoinResearchStudy.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(study);
  render(<BitcoinResearch onClose={jest.fn()} />);
  expect(await screen.findByText('UNAVAILABLE')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('table', { name: 'Bitcoin probability matrix' })).toBeVisible();
});

test('failed observation loading removes earlier interval results and retry recovers', async () => {
  await renderReady();
  loadBitcoinMatrixObservations.mockRejectedValueOnce(new Error('bad export'));
  choose('Interval', 'NYSE session');
  expect(await screen.findByText('UNAVAILABLE')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('table', { name: 'Bitcoin probability matrix' });
  expect(mainCell()).toHaveTextContent('66.7%');
});

test('aborts superseded interval requests and ignores their late results', async () => {
  const hourly = deferred();
  const daily = deferred();
  const calendar = deferred();
  loadBitcoinMatrixObservations.mockImplementation(interval => ({ hourly, daily, calendar_day: calendar }[interval.id].promise));
  const { unmount } = render(<BitcoinResearch onClose={jest.fn()} />);
  await screen.findByRole('combobox', { name: 'Interval' });
  await waitFor(() => expect(loadBitcoinMatrixObservations).toHaveBeenCalledTimes(1));
  const hourlySignal = loadBitcoinMatrixObservations.mock.calls[0][1].signal;
  choose('Interval', 'NYSE session');
  await waitFor(() => expect(loadBitcoinMatrixObservations).toHaveBeenCalledTimes(2));
  const dailySignal = loadBitcoinMatrixObservations.mock.calls[1][1].signal;
  expect(hourlySignal.aborted).toBe(true);
  choose('Interval', '24 hours');
  await waitFor(() => expect(loadBitcoinMatrixObservations).toHaveBeenCalledTimes(3));
  const calendarSignal = loadBitcoinMatrixObservations.mock.calls[2][1].signal;
  expect(dailySignal.aborted).toBe(true);
  await act(async () => { daily.resolve(dataset('daily')); hourly.reject(new Error('late abort')); });
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Loading research');
  await act(async () => { calendar.resolve(dataset('calendar_day')); });
  expect(mainCell()).toHaveTextContent('50.0%');
  expect(screen.getByRole('combobox', { name: 'Interval' })).toHaveTextContent('24 hours');
  unmount();
  expect(calendarSignal.aborted).toBe(true);
});

test('closes through the existing workspace action while research is loading', () => {
  loadBitcoinResearchStudy.mockReturnValue(new Promise(() => {}));
  const close = jest.fn();
  render(<BitcoinResearch onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close Bitcoin Research' }));
  expect(close).toHaveBeenCalledTimes(1);
});
