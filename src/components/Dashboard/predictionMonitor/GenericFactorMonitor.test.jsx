import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import GenericFactorMonitor from './GenericFactorMonitor';

// Prepared publication fixtures are isolated to tests and never feed runtime quotes.
const published = (row) => ({
  status: 'historical', source: 'Verified completed observations', asOf: '2026-09-15', ...row,
});
const rowCells = (label) => within(screen.getByRole('rowheader', { name: label }).closest('tr'))
  .getAllByRole('cell');
const factorRows = (symbol) => [
  published({
    id: 'dxy', label: 'DXY · 1D / 15D / 30D',
    metrics: [
      { label: '1D', value: -0.25, format: 'percent' },
      { label: '15D', value: 1.2, format: 'percent' },
      { label: '30D', value: 0, format: 'percent' },
    ],
  }),
  published({
    id: 'usd', label: `${symbol}/DXY · 15D / 30D CORRELATION`,
    metrics: [
      { label: '15D', value: -0.71, format: 'correlation' },
      { label: '30D', value: 0.21, format: 'correlation' },
    ],
  }),
  published({ id: 'cftc', label: 'CFTC · 1Y / 3Y Z', displayValue: '+0.12 / +1.02' }),
  published(symbol === 'BTC' ? {
    id: 'BITVX', label: 'BITVX · IBIT PROXY', value: 43.83, displayValue: '43.83% annualized',
    detail: '≈ ±2.76% / session · implied', note: 'One standard deviation, 252 sessions; no validated regime thresholds.',
  } : {
    id: 'ethereumRealizedVolatility', label: 'ETH · 21D REALIZED VOL', value: 0.63, displayValue: '63.00% annualized',
    detail: '≈ ±3.30% / day · realized', note: 'One standard deviation, 365 days; no validated regime thresholds.',
  }),
  published({ id: 'gate', role: 'gate', label: 'TRADE / TREND', displayValue: 'BULLISH / BEARISH' }),
  published({ id: 'geometry', label: 'CONTRACT RISK RANGE', displayValue: '75009 – 79113' }),
];

test.each([
  ['Bitcoin', 'BTC'], ['Ethereum', 'ETH'],
])('renders the compact %s factor structure with percentage horizons and separate correlations', (fullLabel, symbol) => {
  render(<GenericFactorMonitor marketUi={{ fullLabel }} snapshot={{ factorRows: factorRows(symbol) }} />);
  const panel = screen.getByRole('region', { name: `${fullLabel} factor monitor · AUTO · CURRENT` });
  expect(within(panel).getAllByRole('rowheader')).toHaveLength(6);
  expect(rowCells('DXY · 1D / 15D / 30D')[0]).toHaveTextContent('-0.25% / +1.20% / 0.00%');
  expect(within(rowCells('DXY · 1D / 15D / 30D')[0]).getByLabelText('1D: -0.25%')).toHaveClass('is-negative');
  expect(within(rowCells('DXY · 1D / 15D / 30D')[0]).getByLabelText('15D: +1.20%')).toHaveClass('is-positive');
  expect(within(rowCells('DXY · 1D / 15D / 30D')[0]).getByLabelText('30D: 0.00%')).toHaveClass('is-neutral');
  expect(rowCells(`${symbol}/DXY · 15D / 30D CORRELATION`)[0]).toHaveTextContent('-0.71 / +0.21');
  expect(within(rowCells(`${symbol}/DXY · 15D / 30D CORRELATION`)[0]).getByLabelText('15D: -0.71')).toHaveClass('is-negative');
  expect(within(rowCells(`${symbol}/DXY · 15D / 30D CORRELATION`)[0]).getByLabelText('30D: +0.21')).toHaveClass('is-neutral');
  expect(rowCells('CFTC · 1Y / 3Y Z')[0]).toHaveTextContent('+0.12 / +1.02');
  const volatilityLabel = symbol === 'BTC' ? 'BITVX · IBIT PROXY' : 'ETH · 21D REALIZED VOL';
  expect(rowCells(volatilityLabel)[0]).toHaveTextContent(symbol === 'BTC' ? '43.83% annualized' : '63.00% annualized');
  expect(rowCells(volatilityLabel)[0]).toHaveTextContent(symbol === 'BTC'
    ? '≈ ±2.76% / session · implied' : '≈ ±3.30% / day · realized');
  expect(screen.getByRole('rowheader', { name: volatilityLabel }).closest('tr')).toHaveAttribute(
    'title', expect.stringContaining('no validated regime thresholds'),
  );
  expect(panel).not.toHaveTextContent(/LAST CLOSE|GATE|GEOMETRY/);
});

test('keeps missing horizons unavailable without discarding independently verified observations', () => {
  const rows = factorRows('BTC');
  rows[0].metrics[1].value = null;
  rows[1].metrics.forEach((metric) => { metric.value = null; });
  render(<GenericFactorMonitor marketUi={{ fullLabel: 'Bitcoin' }} snapshot={{ factorRows: rows }} />);
  expect(rowCells('DXY · 1D / 15D / 30D')[0]).toHaveTextContent('-0.25% / — / 0.00%');
  expect(rowCells('DXY · 1D / 15D / 30D')[0].closest('tr')).toHaveAttribute('data-availability', 'partial');
  expect(rowCells('BTC/DXY · 15D / 30D CORRELATION')[0]).toHaveTextContent(/^—$/);
  expect(rowCells('BTC/DXY · 15D / 30D CORRELATION')[0].closest('tr')).toHaveAttribute('data-availability', 'unavailable');
  expect(rowCells('BTC/DXY · 15D / 30D CORRELATION')[3]).toHaveTextContent(/^—$/);
});

test.each([
  ['offline', { status: 'offline' }],
  ['stale', { stale: true }],
  ['cache-only', { cacheOnly: true }],
  ['cached response', { fromCache: true }],
  ['seeded', { seeded: true }],
  ['mock', { mock: true }],
  ['failed refresh', { refreshFailed: true }],
  ['disconnected', { providerConnected: false }],
])('does not display %s measurements or volatility context', (_label, overrides) => {
  const rows = factorRows('BTC').filter((row) => row.id === 'dxy' || row.id === 'BITVX')
    .map((row) => ({ ...row, ...overrides }));
  render(<GenericFactorMonitor marketUi={{ fullLabel: 'Bitcoin' }} snapshot={{ factorRows: rows }} />);
  expect(rowCells('DXY · 1D / 15D / 30D')[0]).toHaveTextContent(/^—$/);
  expect(rowCells('BITVX · IBIT PROXY')[0]).toHaveTextContent(/^—$/);
  expect(screen.queryByText('≈ ±2.76% / session · implied')).not.toBeInTheDocument();
});
