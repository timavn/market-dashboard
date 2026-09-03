import React from 'react';
import { render, screen } from '@testing-library/react';
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
    expect(screen.queryByText(/follow the sun/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/global market day-cycle/i)).not.toBeInTheDocument();
    expect(document.querySelector('.global-session-strip__map')).not.toBeInTheDocument();
  });

  test('shows the correct local times from west to east', () => {
    render(<GlobalMarketDayCycleHeader />);

    expect(screen.getByLabelText(/LA 06:26 Jan 15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/CHI 08:26 Jan 15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/NY 09:26 Jan 15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/LDN 14:26 Jan 15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/HK 22:26 Jan 15/)).toBeInTheDocument();
    expect(screen.getByLabelText(/TYO 23:26 Jan 15/)).toBeInTheDocument();
  });

  test('marks LA as the home timezone and shows dates under each clock', () => {
    const { container } = render(<GlobalMarketDayCycleHeader />);

    expect(container.querySelector('.global-session-city--home')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('home timezone')
    );
    expect(container.querySelectorAll('.global-session-city--home')).toHaveLength(1);
    expect(container.querySelector('.global-session-city--home .global-session-city__code')).toHaveTextContent('LA');

    expect(screen.getByText('LA').closest('.global-session-city').querySelector('.global-session-city__date'))
      .toHaveTextContent('Jan 15');
    expect(screen.getByText('TYO').closest('.global-session-city').querySelector('.global-session-city__date'))
      .toHaveTextContent('Jan 15');
  });
});
