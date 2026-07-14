import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import USDCorrelationMatrix, { corrHeatProps } from '../USDCorrelationMatrix';

jest.mock('../../../services/api/usdMarketService', () => ({
  CorrelationHelpers: {
    formatCorrelation: (value) => (value == null ? '--' : Number(value).toFixed(2)),
  },
}));

describe('USDCorrelationMatrix', () => {
  test('uses neutral, light, and strong red/green correlation bands', () => {
    expect(corrHeatProps(-1).className).toBe('usd-corr-heat--neg-strong');
    expect(corrHeatProps(-0.75).className).toBe('usd-corr-heat--neg-strong');
    expect(corrHeatProps(-0.74).className).toBe('usd-corr-heat--neg-light');
    expect(corrHeatProps(-0.504).className).toBe('usd-corr-heat--neutral');
    expect(corrHeatProps(-0.5).className).toBe('usd-corr-heat--neutral');
    expect(corrHeatProps(0.5).className).toBe('usd-corr-heat--neutral');
    expect(corrHeatProps(0.504).className).toBe('usd-corr-heat--neutral');
    expect(corrHeatProps(0.51).className).toBe('usd-corr-heat--pos-light');
    expect(corrHeatProps(0.74).className).toBe('usd-corr-heat--pos-light');
    expect(corrHeatProps(0.75).className).toBe('usd-corr-heat--pos-strong');
    expect(corrHeatProps(1).className).toBe('usd-corr-heat--pos-strong');
  });

  test('shows an explicit unavailable state with a manual retry', () => {
    const onRetry = jest.fn();
    render(
      <USDCorrelationMatrix
        correlations={null}
        rollingStats={null}
        correlationsTimestamp={null}
        calculationDate={null}
        loading={false}
        error="Correlation API unavailable"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('Correlation API unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('renders percentage fields from the current API contract', () => {
    render(
      <USDCorrelationMatrix
        correlations={{
          SPX: { '15D': 0.1, '30D': 0.2, '90D': 0.3, '120D': 0.4, '180D': 0.5 },
        }}
        rollingStats={{
          SPX: { high: 0.8, low: -0.7, percentPositive: 42, percentNegative: 58 },
        }}
        correlationsTimestamp="2026-07-13T22:00:00.000Z"
        calculationDate="2026-07-13"
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByText('USD Correlations')).toBeTruthy();
    expect(screen.queryByText('Key USD Correlations')).toBeNull();
    expect(screen.getByLabelText('FXVL correlation data unavailable')).toHaveTextContent('NO DATA');
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('58%')).toBeTruthy();
  });

  test('renders current FXVL correlations as the first metric row', () => {
    render(
      <USDCorrelationMatrix
        correlations={{
          FXVL: { '15D': 0.11, '30D': 0.22, '90D': 0.33, '120D': 0.44, '180D': 0.55 },
          SPX: { '15D': 0.1, '30D': 0.2, '90D': 0.3, '120D': 0.4, '180D': 0.5 },
        }}
        rollingStats={{
          FXVL: { high: 0.72, low: -0.61, percentPositive: 63, percentNegative: 37 },
          SPX: { high: 0.8, low: -0.7, percentPositive: 42, percentNegative: 58 },
        }}
        correlationsTimestamp="2026-07-13T22:00:00.000Z"
        calculationDate="2026-07-13"
        loading={false}
        error={null}
      />,
    );

    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('FXVL');
    expect(rows[1]).toHaveTextContent('0.22');
    expect(rows[1]).toHaveTextContent('63%');
    expect(screen.queryByLabelText('FXVL correlation data unavailable')).not.toBeInTheDocument();
  });

  test('accepts a complete controlled hook state and radar variant', () => {
    const retry = jest.fn();
    render(
      <USDCorrelationMatrix
        state={{
          correlations: {
            SPX: { '15D': 0.1, '30D': 0.2, '90D': 0.3, '120D': 0.4, '180D': 0.5 },
          },
          rollingStats: {
            SPX: { high: 0.8, low: -0.7, percentPositive: 42, percentNegative: 58 },
          },
          correlationsTimestamp: '2026-07-13T22:00:00.000Z',
          calculationDate: '2026-07-13',
          loading: false,
          error: null,
          retry,
        }}
        variant="radar"
      />,
    );

    expect(screen.getByTestId('usd-correlation-panel').getAttribute('data-variant')).toBe('radar');
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /last updated time for usd correlations/i })).toBeNull();
  });
});
