import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import GlobalMarketDayCycleHeader from '../GlobalMarketDayCycleHeader';

const mockDate = new Date('2024-01-15T14:26:00Z');

describe('GlobalMarketDayCycleHeader regional strip', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(mockDate);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders the three regional clock groups without a redundant title', () => {
    render(<GlobalMarketDayCycleHeader compact />);

    expect(screen.getByLabelText('Americas market clocks')).toBeInTheDocument();
    expect(screen.getByLabelText('Europe market clocks')).toBeInTheDocument();
    expect(screen.getByLabelText('Asia market clocks')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Americas market clocks')).getByText('LA')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Europe market clocks')).getByText('LDN')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Asia market clocks')).getByText('TYO')).toBeInTheDocument();
    expect(screen.queryByText('Americas')).not.toBeInTheDocument();
    expect(screen.queryByText(/follow the sun/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/global market day-cycle/i)).not.toBeInTheDocument();
    expect(document.querySelector('.global-session-strip__map')).not.toBeInTheDocument();
  });

  test('shows the correct local times from west to east', () => {
    render(<GlobalMarketDayCycleHeader />);

    expect(screen.getByLabelText(/LA Jan 15 06:26 PST/)).toBeInTheDocument();
    expect(screen.getByLabelText(/CHI Jan 15 08:26 CST/)).toBeInTheDocument();
    expect(screen.getByLabelText(/NY Jan 15 09:26 EST/)).toBeInTheDocument();
    expect(screen.getByLabelText(/LDN Jan 15 14:26 GMT/)).toBeInTheDocument();
    expect(screen.getByLabelText(/HK Jan 15 22:26 GMT\+8/)).toBeInTheDocument();
    expect(screen.getByLabelText(/TYO Jan 15 23:26 GMT\+9/)).toBeInTheDocument();
  });

  test('preserves the home timezone and market status with a single date-time line', () => {
    render(<GlobalMarketDayCycleHeader />);

    const homeClock = screen.getByLabelText('LA Jan 15 06:26 PST, holiday, home timezone');
    expect(homeClock).toHaveClass('global-session-city--home');
    expect(screen.getAllByLabelText(/home timezone/)).toHaveLength(1);
    expect(within(homeClock).getByText('Jan 15 06:26 PST')).toHaveAttribute('datetime', mockDate.toISOString());
    expect(homeClock).toHaveAttribute('title', 'Pacific Exchange · Jan 15 06:26 PST · holiday · home timezone');
  });

  test('keeps each clock date with its timezone when Asia has crossed midnight', () => {
    jest.setSystemTime(new Date('2026-09-15T16:00:00Z'));
    render(<GlobalMarketDayCycleHeader />);

    expect(screen.getByText('Sep 15 09:00 PDT')).toBeInTheDocument();
    expect(screen.getByText('Sep 16 00:00 GMT+8')).toBeInTheDocument();
    expect(screen.getByText('Sep 16 01:00 GMT+9')).toBeInTheDocument();
  });

  test('updates the local hour and timezone together across daylight saving time', () => {
    jest.setSystemTime(new Date('2026-03-08T09:59:00Z'));
    render(<GlobalMarketDayCycleHeader />);

    expect(screen.getByText('Mar 8 01:59 PST')).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(60_000));

    expect(screen.getByText('Mar 8 03:00 PDT')).toBeInTheDocument();
    expect(screen.queryByText('Mar 8 01:59 PST')).not.toBeInTheDocument();
  });
});
