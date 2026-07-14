import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { VolatilityTableWithTabs } from '../VolatilityTable';

const SNAPSHOT = {
  status: 'partial',
  lastUpdated: '2026-07-13T22:00:00.000Z',
  VIX: {
    lastPx: 17.16,
    day1Ago: 15.03,
    week1Ago: 15.57,
    week4Ago: 22.22,
    dayChangePct: 14.17,
    weekChangePct: 10.21,
    monthChangePct: -22.77,
    threeMonthChangePct: -10.76,
    sixMonthChangePct: 11.07,
    ytdChangePct: 14.78,
    availability: 'available',
    freshness: 'current',
    source: 'cboe',
    sourceLabel: 'Cboe Global Indices',
    quoteMode: 'delayed',
    asOf: '2026-07-13T22:00:00.000Z',
  },
};

const HISTORICAL_MOVE = {
  ...SNAPSHOT.VIX,
  lastPx: 92.4,
  day1Ago: 89.2,
  week1Ago: 94.1,
  week4Ago: 101.2,
  availability: 'historical',
  freshness: 'historical',
  source: 'yahoo',
  sourceLabel: 'Yahoo Finance',
  quoteMode: 'end-of-day',
  asOf: '2026-07-13T20:30:00.000Z',
};

describe('VolatilityTable controlled state', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('renders a radar variant from the supplied snapshot without polling', () => {
    render(
      <VolatilityTableWithTabs
        snapshot={SNAPSHOT}
        loading={false}
        error={null}
        variant="radar"
      />,
    );

    expect(screen.getByTestId('volatility-table-shell').getAttribute('data-variant')).toBe('radar');
    expect(screen.getByTestId('volatility-table').getAttribute('data-variant')).toBe('radar');
    expect(screen.getByText('17.16')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /last updated time for volatility data/i })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('shows red, yellow, green regimes and emphasizes the live spot bucket', () => {
    render(
      <VolatilityTableWithTabs
        snapshot={SNAPSHOT}
        loading={false}
        error={null}
        variant="radar"
      />,
    );

    const regime = screen.getByLabelText('VIX current volatility regime: green');
    const blocks = within(regime).getAllByText(/^(29\+|20–29|<20)$/);

    expect(blocks.map((block) => block.getAttribute('data-regime'))).toEqual([
      'red',
      'yellow',
      'green',
    ]);
    expect(blocks[0]).toHaveTextContent('29+');
    expect(blocks[1]).toHaveTextContent('20–29');
    expect(blocks[2]).toHaveTextContent('<20');
    expect(blocks[0]).toHaveAttribute('data-active', 'false');
    expect(blocks[1]).toHaveAttribute('data-active', 'false');
    expect(blocks[2]).toHaveAttribute('data-active', 'true');
    expect(screen.getByText('17.16')).toHaveClass('vol-mw-bucket-green');
    expect(screen.getByText('15.03')).toHaveClass('vol-mw-bucket-green');
    expect(screen.getByText('15.57')).toHaveClass('vol-mw-bucket-green');
    expect(screen.getByText('22.22')).toHaveClass('vol-mw-bucket-yellow');

    const unavailableRegime = screen.getByLabelText('VVIX volatility regime unavailable');
    const unavailableBlocks = within(unavailableRegime).getAllByText(/^(115\+|95–115|<95)$/);
    unavailableBlocks.forEach((block) => expect(block).toHaveAttribute('data-active', 'false'));
  });

  test('uses the supplied controlled retry handler for an unavailable snapshot', () => {
    const onRetry = jest.fn();
    render(
      <VolatilityTableWithTabs
        snapshot={null}
        loading={false}
        error="provider offline"
        onRetry={onRetry}
        variant="radar"
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('provider offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('renders historical MOVE as a labeled EOD row with regime colors', () => {
    render(
      <VolatilityTableWithTabs
        snapshot={{ ...SNAPSHOT, MOVE: HISTORICAL_MOVE }}
        loading={false}
        error={null}
        variant="radar"
      />,
    );

    expect(screen.getByLabelText('MOVE end-of-day volatility regime: green')).toBeInTheDocument();
    expect(screen.getByText('92.40').closest('td')).toHaveClass('vol-mw-bucket-green');
    expect(screen.getByText('EOD · AS OF JUL 13')).toBeInTheDocument();
  });
});
