import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import GoldCorrelationPanel from './GoldCorrelationPanel';

const HORIZONS = ['15D', '30D', '90D', '120D', '180D'];
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Prepared completed-session display fixtures stay local to these leaf tests.
// Provider acceptance, expiry, and monitor activation remain covered upstream.
const row = (key, overrides = {}) => ({
  key,
  label: key,
  status: 'available',
  source: 'Verified completed daily source',
  asOf: '2026-09-10',
  transform: 'price_return',
  latest: { value: 98.42, unit: 'index', asOf: '2026-09-10' },
  values: Object.fromEntries(HORIZONS.map((horizon) => [horizon, 0.2])),
  ...overrides,
});
const snapshot = (rows, overrides = {}) => freeze({ status: 'available', rows, ...overrides });

test('keeps the loading shell and unavailable reason precedence compact without controls', () => {
  const { rerender } = render(<GoldCorrelationPanel />);
  const panel = screen.getByRole('complementary', { name: 'Gold correlation matrix' });
  expect(panel).toHaveClass('is-loading');
  expect(panel).toHaveTextContent('GOLD CORRELATION');
  expect(panel).toHaveTextContent('XAUUSD PROXY BASIS · COMPLETED DAILY CHANGES');
  expect(within(panel).getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(panel).toHaveTextContent('CHECKING VERIFIED DAILY HISTORY');
  expect(panel).toHaveTextContent('Waiting for IBKR XAUUSD and current comparator histories.');

  rerender(<GoldCorrelationPanel state="error" snapshot={{ status: 'unavailable', rows: [], reason: 'Snapshot reason.' }} reason="Request reason." />);
  expect(screen.getByTestId('gold-correlation-panel')).toBe(panel);
  expect(panel).toHaveClass('is-unavailable');
  expect(panel).toHaveTextContent('CORRELATION DATA UNAVAILABLE');
  expect(panel).toHaveTextContent('Request reason.');
  expect(panel).not.toHaveTextContent('Snapshot reason.');
  rerender(<GoldCorrelationPanel state="error" snapshot={{ status: 'unavailable', rows: [], reason: 'Snapshot reason.' }} />);
  expect(panel).toHaveTextContent('Snapshot reason.');
  rerender(<GoldCorrelationPanel state="error" snapshot={{ status: 'available', rows: [] }} />);
  expect(panel).toHaveTextContent('No verified current Gold correlation snapshot is available.');
  expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  expect(panel.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
});

test('renders prepared available and partial rows ahead of request state with fixed horizon columns', () => {
  const prepared = snapshot([row('DXY')], { horizons: [...HORIZONS].reverse() });
  const { rerender } = render(<GoldCorrelationPanel snapshot={prepared} state="loading" />);
  const panel = screen.getByTestId('gold-correlation-panel');
  expect(panel).toHaveClass('is-available');
  expect(within(panel).queryByRole('status')).not.toBeInTheDocument();
  const table = within(panel).getByRole('table');
  expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent))
    .toEqual(['DRIVER', 'LAST', ...HORIZONS]);
  expect(table.querySelectorAll('col')).toHaveLength(7);

  rerender(<GoldCorrelationPanel snapshot={snapshot([row('DXY')], { status: 'partial' })} state="error" reason="Refresh error." />);
  expect(panel).toHaveClass('is-partial');
  expect(within(panel).getByRole('table')).toBe(table);
  expect(panel).not.toHaveTextContent('Refresh error.');
});

test('retains row provenance and completed observation labels while limiting delta-BP text to yields', () => {
  render(<GoldCorrelationPanel snapshot={snapshot([
    row('DXY'),
    row('Real yield', {
      status: 'partial',
      source: 'FRED completed observations',
      reason: 'Shorter verified series.',
      transform: 'yield_change_bps',
      latest: { value: -0.25, unit: 'percent', asOf: '2026-09-10' },
    }),
  ])} />);
  const yieldRow = screen.getByRole('rowheader', { name: /Real yield/ }).closest('tr');
  expect(yieldRow).toHaveClass('is-partial');
  expect(yieldRow).toHaveAttribute('title', 'FRED completed observations · As of 2026-09-10 · Shorter verified series.');
  expect(within(yieldRow).getByText('Δ BP')).toBeInTheDocument();
  expect(within(yieldRow).getByRole('cell', { name: 'Real yield last completed observation: -0.25% as of 2026-09-10' }))
    .toHaveTextContent('-0.25%');
  const dxyRow = screen.getByRole('rowheader', { name: 'DXY' }).closest('tr');
  expect(within(dxyRow).queryByText('Δ BP')).not.toBeInTheDocument();
  expect(screen.getAllByText('Δ BP')).toHaveLength(1);
});

test('formats prepared last observations with their units and keeps unsupported or nonfinite values empty', () => {
  const observations = [
    ['Index', 10432.126, 'index', '10,432.13'],
    ['Yield', -0.125, 'percent', '-0.13%'],
    ['Silver', 28.126, 'USD/ozt', '$28.13'],
    ['Oil', 72.3, 'USD/bbl', '$72.30'],
    ['Numeric string', '0.2', 'percent', '0.20%'],
    ['Missing', null, 'index', '—'],
    ['Nonfinite', NaN, 'index', '—'],
    ['Unknown unit', 99, 'points', '—'],
  ];
  render(<GoldCorrelationPanel snapshot={snapshot(observations.map(([key, value, unit]) => row(key, {
    latest: { value, unit, asOf: '2026-09-10' },
  })))} />);
  observations.forEach(([key, _value, _unit, expected]) => {
    const last = screen.getByRole('cell', { name: `${key} last completed observation: ${expected} as of 2026-09-10` });
    expect(last).toHaveTextContent(expected);
    expect(last).toHaveClass('is-last');
  });
});

test('uses rounded signed heat classes and accessible direction with absolute visible correlation text', () => {
  const cases = [
    ['Positive', [0.2, 0.496, 0.696, 0.004, null], ['positive', 'positive-light', 'positive-strong', 'neutral', 'unavailable']],
    ['Negative', [-0.2, -0.496, -0.696, -0.004, '-0.83'], ['negative', 'negative-light', 'negative-strong', 'neutral', 'negative-strong']],
  ];
  render(<GoldCorrelationPanel snapshot={snapshot(cases.map(([label, values]) => row(label, {
    values: Object.fromEntries(HORIZONS.map((horizon, index) => [horizon, values[index]])),
  })))} />);
  cases.forEach(([label, values, tones]) => {
    const cells = within(screen.getByRole('rowheader', { name: label }).closest('tr')).getAllByRole('cell').slice(1);
    cells.forEach((cell, index) => {
      const displayed = values[index] === null ? null : Number(Number(values[index]).toFixed(2));
      const direction = displayed > 0 ? 'positive' : displayed < 0 ? 'negative' : 'zero';
      const text = displayed === null ? '—' : Math.abs(displayed).toFixed(2);
      expect(cell).toHaveClass(`is-${tones[index]}`);
      expect(cell).toHaveTextContent(text);
      expect(cell).toHaveAttribute('aria-label', displayed === null
        ? `${label} ${HORIZONS[index]}: correlation unavailable`
        : `${label} ${HORIZONS[index]}: ${direction} correlation ${text}`);
    });
  });
});

test('removes previous readings on an unavailable rerender without remounting the shell or mutating input', () => {
  const prepared = snapshot([row('DXY', { values: { ...row('DXY').values, '30D': -0.84 } })]);
  const before = JSON.stringify(prepared);
  const { rerender } = render(<GoldCorrelationPanel snapshot={prepared} />);
  const panel = screen.getByTestId('gold-correlation-panel');
  expect(within(panel).getByRole('cell', { name: 'DXY 30D: negative correlation 0.84' })).toHaveTextContent('0.84');
  rerender(<GoldCorrelationPanel snapshot={snapshot([], { status: 'unavailable' })} state="error" />);
  expect(screen.getByTestId('gold-correlation-panel')).toBe(panel);
  expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
  expect(panel).not.toHaveTextContent('98.42');
  expect(panel).not.toHaveTextContent('0.84');
  expect(panel.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
  expect(JSON.stringify(prepared)).toBe(before);
});
