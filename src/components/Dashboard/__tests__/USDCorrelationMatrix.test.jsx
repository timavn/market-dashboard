import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import USDCorrelationMatrix, { corrHeatProps } from '../USDCorrelationMatrix';

jest.mock('../../../services/api/usdMarketService', () => ({
  CorrelationHelpers: {
    formatCorrelation: (value) => (value == null ? '--' : Number(value).toFixed(2)),
  },
}));

const COMPLETE_FXVL = {
  lastPx: 5.75,
  day1Ago: 6.29,
  day15Ago: 6.1,
  week1Ago: 6.47,
  week4Ago: 7.12,
  month3Ago: 5.61,
  month6Ago: 6.8,
  priorYearClose: 6.56,
  dayChangePct: -8.59,
  fifteenDayChangePct: -5.74,
  weekChangePct: -11.13,
  monthChangePct: -19.24,
  threeMonthChangePct: 2.42,
  sixMonthChangePct: -15.44,
  ytdChangePct: -12.31,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cme',
  asOf: '2026-07-14T19:59:46.000Z',
};

const CORRELATION_STATE = {
  correlations: {
    FXVL: { '5D': 0.05, '15D': 0.11, '30D': 0.22, '1M': 0.25, '3M': 0.33, '6M': 0.44, '90D': 0.33, '120D': 0.44, '180D': 0.55 },
    SPX: { '5D': 0.05, '15D': 0.1, '30D': 0.2, '1M': 0.25, '3M': 0.3, '6M': 0.4, '90D': 0.3, '120D': 0.4, '180D': 0.5 },
  },
  rollingStats: {
    FXVL: { high: 0.72, low: -0.61, percentPositive: 63, percentNegative: 37 },
    SPX: { high: 0.8, low: -0.7, percentPositive: 42, percentNegative: 58 },
  },
  correlationsTimestamp: '2026-07-13T22:00:00.000Z',
  calculationDate: '2026-07-13',
  loading: false,
  error: null,
};

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
          SPX: { '5D': 0.05, '15D': 0.1, '30D': 0.2, '1M': 0.25, '3M': 0.3, '6M': 0.4 },
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
    expect(Array.from(screen.getByRole('table').querySelectorAll('thead th')).map(({ textContent }) => textContent.trim()))
      .toEqual(['METRIC', '5D', '15D', '30D', '1M', '3M', '6M', 'HIGH', 'LOW', '% TIME POS', '% TIME NEG']);
  });

  test('renders current FXVL correlations as the first metric row', () => {
    render(
      <USDCorrelationMatrix
        correlations={{
          FXVL: { '5D': 0.05, '15D': 0.11, '30D': 0.22, '1M': 0.25, '3M': 0.33, '6M': 0.44 },
          SPX: { '5D': 0.05, '15D': 0.1, '30D': 0.2, '1M': 0.25, '3M': 0.3, '6M': 0.4 },
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
            SPX: { '5D': 0.05, '15D': 0.1, '30D': 0.2, '1M': 0.25, '3M': 0.3, '6M': 0.4 },
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
        currencyPanel={<section aria-label="Currency section">Currency rows</section>}
      />,
    );

    expect(screen.getByTestId('usd-correlation-panel').getAttribute('data-variant')).toBe('radar');
    expect(screen.queryByText('USD')).not.toBeInTheDocument();
    expect(screen.queryByText('USD Correlations')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'FX Volatility' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'FX Volatility' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Correlations' })).toBeInTheDocument();
    expect(screen.getByLabelText('Currency section')).toHaveTextContent('Currency rows');
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /status details for usd correlations/i })).toBeNull();
    expect(screen.getByLabelText('FXVL volatility data unavailable')).toHaveTextContent('NO LIVE SERIES');
    expect(within(screen.getByRole('table')).queryByText('FXVL')).not.toBeInTheDocument();
  });

  test('uses the VIX row template for a verified current FXVL snapshot', () => {
    render(
      <USDCorrelationMatrix
        state={{ ...CORRELATION_STATE, fxvlSnapshot: COMPLETE_FXVL }}
        variant="radar"
      />,
    );

    const row = screen.getByLabelText('FXVL current volatility');
    expect(row).toHaveClass('efr-vol-row', 'usd-corr-fxvl-summary');
    expect(within(row).getByText('5.75')).toBeInTheDocument();
    expect(Array.from(row.querySelectorAll('.efr-vol-row__metrics small')).map(({ textContent }) => textContent))
      .toEqual(['DAY', '15D', '1M', '3M', '6M']);
    expect(Array.from(row.querySelectorAll('.efr-vol-row__metric-level')).map(({ textContent }) => textContent))
      .toEqual(['6.29', '6.10', '7.12', '5.61', '6.80']);

    const chart = within(row).getByLabelText('FXVL volatility from six months ago to 7/14');
    expect(within(chart).getAllByText(/^(6M|3M|1M|15D|1D|7\/14)$/).map(({ textContent }) => textContent))
      .toEqual(['6M', '3M', '1M', '15D', '1D', '7/14']);

    const table = screen.getByRole('table');
    expect(within(table).queryByText('FXVL')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('SPX');
  });

  test('labels a verified historical FXVL snapshot as a dated close', () => {
    render(
      <USDCorrelationMatrix
        state={{
          ...CORRELATION_STATE,
          fxvlSnapshot: {
            ...COMPLETE_FXVL,
            availability: 'historical',
            freshness: 'historical',
            quoteMode: 'end-of-day',
            asOf: '2026-07-13T20:30:00.000Z',
          },
        }}
        variant="radar"
      />,
    );

    const row = screen.getByLabelText('FXVL closing volatility as of JUL 13');
    expect(within(row).getByText('AS OF JUL 13')).toBeInTheDocument();
    const chart = within(row).getByLabelText('FXVL volatility from six months ago to close');
    expect(chart).toBeInTheDocument();
    expect(within(chart).getAllByText(/^(6M|3M|1M|15D|1D|CLOSE)$/).map(({ textContent }) => textContent))
      .toEqual(['6M', '3M', '1M', '15D', '1D', 'CLOSE']);
  });

  test.each([
    ['stale', { ...COMPLETE_FXVL, freshness: 'stale' }],
    ['incomplete', { ...COMPLETE_FXVL, month6Ago: null }],
    ['unattributed', { ...COMPLETE_FXVL, source: null }],
  ])('withholds %s FXVL values', (_case, fxvlSnapshot) => {
    render(
      <USDCorrelationMatrix
        state={{ ...CORRELATION_STATE, fxvlSnapshot }}
        variant="radar"
      />,
    );

    const row = screen.getByLabelText('FXVL volatility data unavailable');
    expect(row).toHaveTextContent('NO LIVE SERIES');
    expect(row).not.toHaveTextContent('5.75');
  });
});
