import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar from './ExceptionFirstRadar';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
jest.mock('./USDCorrelationMatrix', () => () => null);
jest.mock('./RadarReferencePanels', () => ({
  __esModule: true,
  default: () => null,
  aggregateQuoteStatus: () => 'unavailable',
  getRowQuoteStatus: () => 'unavailable',
}));

const CURRENT_VIX = {
  lastPx: 16.65,
  day1Ago: 15.03,
  week1Ago: 15.57,
  week4Ago: 22.22,
  dayChangePct: 10.78,
  weekChangePct: 6.94,
  monthChangePct: -25.07,
  threeMonthChangePct: -13.42,
  sixMonthChangePct: 7.77,
  ytdChangePct: 11.37,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cboe',
};

const HISTORICAL_MOVE = {
  ...CURRENT_VIX,
  lastPx: 92.4,
  availability: 'historical',
  freshness: 'historical',
  quoteMode: 'end-of-day',
  source: 'yahoo',
  asOf: '2026-07-13T20:30:00.000Z',
};

describe('Exception-First header', () => {
  test('replaces the title with the market pulse ribbon', () => {
    render(<ExceptionFirstRadar />);

    expect(screen.getByLabelText('Market pulse ribbon')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exception-First Radar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dashboard data status')).not.toBeInTheDocument();
  });

  test('renders a scaled volatility chart with aligned axes', () => {
    const { container } = render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    expect(screen.getByRole('heading', { name: 'Volatility · 1M Map' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exceptions Now' })).not.toBeInTheDocument();
    const chart = screen.getByLabelText('VIX volatility from four weeks ago to now');
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('.efr-vol-sparkline__y-tick text')).toHaveLength(3);
    expect(chart.querySelector('.efr-vol-sparkline__y-axis')).toBeInTheDocument();

    const linePointXs = chart.querySelector('.efr-vol-sparkline__line')
      .getAttribute('points')
      .split(' ')
      .map((point) => point.split(',')[0]);
    const xTicks = Array.from(chart.querySelectorAll('.efr-vol-sparkline__x-tick'));
    expect(xTicks.map((tick) => tick.querySelector('text')?.textContent)).toEqual(['4W', '1W', '1D', 'NOW']);
    expect(xTicks.map((tick) => tick.querySelector('text')?.getAttribute('x')))
      .toEqual(linePointXs);
    expect(chart.querySelectorAll('circle')).toHaveLength(0);
    expect(container.querySelector('.efr-vol-sparkline__labels')).not.toBeInTheDocument();
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.65');
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('-25.07%');
    const vixRow = screen.getByLabelText('VIX current volatility');
    expect(Array.from(vixRow.querySelectorAll('.efr-vol-row__metrics small'))
      .map((label) => label.textContent)).toEqual(['DAY', 'MONTH', '3M', 'YTD']);
    expect(vixRow.querySelectorAll('.efr-vol-row__metrics small'))
      .toHaveLength(4);
    expect(within(vixRow).queryByText('Regime')).not.toBeInTheDocument();
    expect(within(vixRow).getByText('Investable')).toBeInTheDocument();
  });

  test('keeps the current snapshot visible during a background refresh', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX }, loading: true }} />);

    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.65');
    expect(screen.getByLabelText('VIX volatility from four weeks ago to now')).toBeInTheDocument();
    expect(screen.queryByText('Loading current volatility data…')).not.toBeInTheDocument();
  });

  test('does not render stale volatility values as current data', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, freshness: 'stale' } } }} />);

    expect(screen.getByLabelText('VIX volatility data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('16.65')).not.toBeInTheDocument();
  });

  test('colors current VIX values by their regime', () => {
    const { rerender } = render(
      <ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 16.56 } } }} />,
    );
    expect(within(screen.getByLabelText('VIX current volatility')).getByText('16.56'))
      .toHaveClass('efr-vol-regime-value--green');

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 20 } } }} />);
    expect(within(screen.getByLabelText('VIX current volatility')).getByText('20.00'))
      .toHaveClass('efr-vol-regime-value--yellow');

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 40 } } }} />);
    expect(within(screen.getByLabelText('VIX current volatility')).getByText('40.00'))
      .toHaveClass('efr-vol-regime-value--red');
  });

  test('renders validated historical MOVE as EOD with a regime-colored value', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { MOVE: HISTORICAL_MOVE } }} />);

    const row = screen.getByLabelText('MOVE end-of-day volatility as of JUL 13');
    expect(within(row).getByText('EOD · AS OF JUL 13')).toBeInTheDocument();
    expect(within(row).getByText('92.40')).toHaveClass('efr-vol-regime-value--green');
    expect(within(row).getByLabelText('MOVE volatility from four weeks ago to end of day')).toBeInTheDocument();
  });

});
