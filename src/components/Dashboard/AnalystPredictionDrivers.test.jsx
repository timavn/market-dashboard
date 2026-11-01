import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPredictionDrivers, { parsePredictionDrivers } from './AnalystPredictionDrivers';

test('parses only well-formed driver blocks', () => {
  expect(parsePredictionDrivers('{"volatility":[],"correlations":{"rows":[{"market":"Gold","d15":"-0.75","d30":"-0.91","d90":"-0.76"}],"asOf":"Oct 12 close"}}'))
    .toEqual({ cells: [], volatility: [], correlations: { rows: [{ market: 'Gold', d15: '-0.75', d30: '-0.91', d90: '-0.76' }], asOf: 'Oct 12 close' } });
  expect(parsePredictionDrivers('not json')).toBeNull();
  expect(parsePredictionDrivers('{"rows":[]}')).toBeNull();
});

test('shows volatility with regime and implied move, and USD correlations as a 15D/30D/90D table', () => {
  render(<AnalystPredictionDrivers drivers={parsePredictionDrivers(JSON.stringify({
    volatility: [
      { symbol: 'GVZ', market: 'Gold', level: '22.01', d1: -2.09, d15: -6.7, m1: -17.07, regimeKey: 'GVZ', regimeValue: 22.01, implied: '±1.4% · ±58' },
      { symbol: 'VIX', market: 'S&P 500', level: '15.18', d1: -0.2, d15: 6.83, m1: -11.23, regimeKey: 'VIX', regimeValue: 15.18,
        signal: 'Bearish', range: '14.21–16.66', implied: '±1.0% · ±75' },
      { symbol: 'VXSLV', market: 'Silver', level: '36.33', d1: -3.74, regimeValue: 36.33, implied: '±2.3% · ±1.38', note: 'Oct 9 close' },
    ],
    correlations: { rows: [{ market: 'Gold', d15: '-0.75', d30: '-0.91', d60: '-0.81', d90: '-0.76' }, { market: 'Copper', d15: '-0.43', d30: '+0.10', d90: 'N/A' }],
      asOf: 'Oct 12 close' },
  }))} />);
  const volatility = screen.getByRole('table', { name: 'Volatility' });
  expect(within(volatility).getAllByRole('columnheader').map(cell => cell.textContent))
    .toEqual(['Volatility', 'Level', '1D', '15D', '1M', 'Regime', 'Implied 1D']);
  const [gvz, vix, vxslv] = within(volatility).getAllByRole('row').slice(1);
  // The regime shows the band it sits in on GVZ's own scale.
  expect(gvz).toHaveTextContent('GVZGold22.01-2.1%-6.7%-17.1%Low< 24±1.4%±58');
  expect(within(vix).getByText('Trend Bearish')).toHaveClass('is-negative');
  // No history or published band for VXSLV: N/A and its own close date rather than an invented regime.
  expect(vxslv).toHaveTextContent('VXSLVSilver36.33-3.7%N/AN/AOct 9 close±2.3%±1.38');
  const correlations = screen.getByRole('table', { name: 'Correlation with the US Dollar' });
  expect(within(correlations).getAllByRole('row').map(row => row.textContent))
    // 60D shows once any row carries it; a row without it reads N/A.
    .toEqual(['vs USD15D30D60D90D', 'Gold-0.75-0.91-0.81-0.76', 'Copper-0.43+0.10N/AN/A']);
  expect(screen.getByText('vs USD as of Oct 12 close')).toBeInTheDocument();
});

test('a reading from an earlier session keeps its date under its regime', () => {
  render(<AnalystPredictionDrivers drivers={parsePredictionDrivers(JSON.stringify({ volatility: [
    { symbol: 'MOVE', market: 'Rates', level: '101.10', d1: -1.35, d15: -3.32, m1: 25.24, regimeKey: 'MOVE', regimeValue: 101.103,
      implied: '±6.4 bp', note: 'Oct 16 close' }] }))} />);
  const [move] = within(screen.getByRole('table', { name: 'Volatility' })).getAllByRole('row').slice(1);
  expect(move.cells[5].textContent).toBe('Moderate100–120Oct 16 close');
  expect(move).toHaveTextContent('MOVERates101.10-1.4%-3.3%+25.2%');
});

test('saved reviews keep their earlier cell layout, including correlation periods', () => {
  render(<AnalystPredictionDrivers drivers={parsePredictionDrivers(
    '{"cells":[{"label":"Kalshi","value":"Oct 13 5pm ET"},{"label":"Gold vs USD","kind":"correlation","value":"-0.75","unit":"15D","sub":"30D -0.91","note":"Oct 12 close"}]}')} />);
  expect(screen.getAllByRole('listitem')[1]).toHaveTextContent('Gold vs USD-0.75 15D30D -0.91Oct 12 close');
});

test('vs USD values use the dashboard correlation heat: red negative, green positive, outlined when strong', () => {
  const { correlationHeatClass } = require('./AnalystPredictionDrivers');
  expect(correlationHeatClass('-0.91')).toBe('analyst-corr--neg-strong');
  expect(correlationHeatClass('-0.68')).toBe('analyst-corr--neg-light');
  expect(correlationHeatClass('+0.10')).toBe('analyst-corr--neutral');
  expect(correlationHeatClass('-0.50')).toBe('analyst-corr--neutral');
  expect(correlationHeatClass('+0.70')).toBe('analyst-corr--pos-light');
  expect(correlationHeatClass('+0.75')).toBe('analyst-corr--pos-strong');
  expect(correlationHeatClass('N/A')).toBe('analyst-driver__muted');
});

test('each regime shows its band on the metric\'s scale', () => {
  render(<AnalystPredictionDrivers drivers={parsePredictionDrivers(JSON.stringify({ volatility: [
    { symbol: 'VIX', market: 'S&P 500', level: '24.10', regimeKey: 'VIX', regimeValue: 24.1 },
    { symbol: 'OVX', market: 'Oil', level: '61.00', regimeKey: 'OVX', regimeValue: 61 }] }))} />);
  const [vix, ovx] = within(screen.getByRole('table', { name: 'Volatility' })).getAllByRole('row').slice(1);
  expect(vix.cells[5].textContent).toBe('Moderate19–29');
  expect(ovx.cells[5].textContent).toBe('High≥ 55');
});
