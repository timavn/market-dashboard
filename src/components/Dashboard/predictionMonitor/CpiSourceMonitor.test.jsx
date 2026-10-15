import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import CpiSourceMonitor from './CpiSourceMonitor';
import FactorMonitor from './FactorMonitor';

const NOW = Date.parse('2026-09-11T17:00:00Z');
const RELEASE = '2026-09-15T12:30:00Z';
const preparedSnapshot = () => ({
  forecastComparison: {
    reportMonth: '2026-08', releaseAt: RELEASE,
    hedgeye: {
      status: 'available', reportMonth: '2026-08', asOf: '2026-09-10',
      scenarios: [{ key: 'low', label: 'Low scenario', value: 2.74 }, { key: 'high', value: 2.86 }],
    },
    clevelandFed: { status: 'available', reportMonth: '2026-08', value: 2.85, asOf: '2026-09-11' },
    bls: {
      status: 'available', fetchedAt: '2026-09-09', asOf: '2026-09-08',
      latestFinal: { reportMonth: '2026-07', value: 2.7 },
    },
  },
});
const rows = () => screen.getAllByRole('rowheader').map((header) => header.closest('tr'));
const values = () => rows().map((row) => within(row).getAllByRole('cell')[0]);

test('routes the CPI sheet with scenario order, exact period labels, source dates, and prior official actual', () => {
  const snapshot = preparedSnapshot();
  const before = JSON.stringify(snapshot);
  render(<FactorMonitor marketId="cpi" snapshot={snapshot} nowMs={NOW} />);
  const panel = screen.getByRole('region', { name: 'CPI forecast and official source monitor' });
  expect(panel).toHaveAttribute('data-testid', 'cpi-source-monitor');
  expect(within(panel).getAllByRole('columnheader').map((cell) => cell.textContent))
    .toEqual(['SOURCE', 'VALUE', 'ROLE', 'PERIOD', 'AS OF']);
  expect(rows().map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['HEDGEYE', 'HEDGEYE', 'CLEVELAND FED', 'BLS']);
  expect(values().map((cell) => cell.textContent)).toEqual(['2.7%', '2.9%', '2.9%', '2.7%D']);
  expect(within(rows()[0]).getAllByRole('cell').slice(1).map((cell) => cell.textContent))
    .toEqual(['LOW SCENARIO', 'AUGUST 2026', 'Sep 10']);
  expect(within(rows()[3]).getAllByRole('cell').slice(1).map((cell) => cell.textContent))
    .toEqual(['LATEST ACTUAL', 'JULY 2026', 'Sep 9']);
  expect(within(rows()[3]).getByRole('button')).toHaveAccessibleName(/BLS LATEST ACTUAL as of 2026-09-09/);
  expect(panel.querySelectorAll('input, select, a')).toHaveLength(0);
  expect(JSON.stringify(snapshot)).toBe(before);
});

test('hides forecast values exactly at release while admitting only the published report-month actual', () => {
  const snapshot = preparedSnapshot();
  snapshot.forecastComparison.bls.latestFinal = { reportMonth: '2026-08', value: 2.8 };
  const { rerender } = render(<CpiSourceMonitor snapshot={snapshot} nowMs={Date.parse(RELEASE) - 1} />);
  expect(values().map((cell) => cell.textContent)).toEqual(['2.7%', '2.9%', '2.9%', '—']);
  rerender(<CpiSourceMonitor snapshot={snapshot} nowMs={Date.parse(RELEASE)} />);
  expect(values().map((cell) => cell.textContent)).toEqual(['—', '—', '—', '2.8%D']);
  expect(rows().slice(0, 3).every((row) => row.dataset.availability === 'unavailable')).toBe(true);
  expect(within(rows()[0]).getAllByRole('cell')[3]).toHaveTextContent('—');
});

test('omits mismatched periods, unavailable sources, nonfinite forecasts, and future-month official values', () => {
  const snapshot = preparedSnapshot();
  snapshot.forecastComparison.hedgeye.reportMonth = '2026-07';
  snapshot.forecastComparison.hedgeye.reason = 'Different report month.';
  snapshot.forecastComparison.clevelandFed.status = 'unavailable';
  snapshot.forecastComparison.bls.latestFinal.reportMonth = '2026-09';
  const { rerender } = render(<CpiSourceMonitor snapshot={snapshot} nowMs={NOW} />);
  expect(values().map((cell) => cell.textContent)).toEqual(['—', '—', '—', '—']);
  expect(rows()[0]).toHaveAttribute('title', 'Different report month.');
  const next = preparedSnapshot();
  next.forecastComparison.hedgeye.scenarios[0].value = Infinity;
  next.forecastComparison.hedgeye.scenarios[1].value = null;
  next.forecastComparison.clevelandFed.value = NaN;
  next.forecastComparison.bls.status = 'offline';
  rerender(<CpiSourceMonitor snapshot={next} nowMs={NOW} />);
  expect(values().map((cell) => cell.textContent)).toEqual(['—', '—', '—', '—']);
});

test('retains display-only reference markers without changing original dates or promoting source availability', () => {
  const snapshot = preparedSnapshot();
  snapshot.referenceOnly = true;
  snapshot.forecastComparison.clevelandFed.asOf = null;
  const { rerender } = render(<CpiSourceMonitor snapshot={snapshot} nowMs={NOW} />);
  expect(values().map((cell) => cell.textContent)).toEqual(['2.7%D', '2.9%D', '2.9%D', '2.7%D']);
  expect(within(rows()[0]).getAllByRole('cell')[3]).toHaveTextContent('Sep 10');
  expect(within(rows()[2]).getAllByRole('cell')[3]).toHaveTextContent('—');
  expect(within(rows()[2]).getByRole('button')).toHaveAccessibleName(/CLEVELAND FED NOWCAST as of unknown/);
  snapshot.referenceOnly = false;
  snapshot.forecastComparison.hedgeye.status = 'unavailable';
  rerender(<CpiSourceMonitor snapshot={snapshot} nowMs={NOW} refreshDelayed />);
  expect(values().map((cell) => cell.textContent)).toEqual(['—', '—', '2.9%D', '2.7%D']);
});

test('keeps the two-source unavailable shell and clears earlier values when comparison data disappears', () => {
  const { rerender } = render(<CpiSourceMonitor snapshot={preparedSnapshot()} nowMs={NOW} />);
  rerender(<CpiSourceMonitor snapshot={null} nowMs={NOW} />);
  expect(rows().map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['CLEVELAND FED', 'BLS']);
  expect(values().map((cell) => cell.textContent)).toEqual(['—', '—']);
  expect(rows().every((row) => row.dataset.availability === 'unavailable')).toBe(true);
  expect(screen.queryByText('2.7%')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
