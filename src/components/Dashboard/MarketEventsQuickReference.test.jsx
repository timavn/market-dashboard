import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useMarketEvents } from '../../hooks/useMarketEvents';
import MarketEventsQuickReference from './MarketEventsQuickReference';

jest.mock('../../services/api/marketEventsService', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../hooks/useMarketEvents', () => ({
  ...jest.requireActual('../../hooks/useMarketEvents'),
  useMarketEvents: jest.fn(),
}));

const FIXED_NOW = new Date('2026-08-10T16:00:00.000Z');
const now = () => FIXED_NOW;

function event(overrides = {}) {
  return {
    id: 'ff-15b47580b8cb192679405daf',
    name: 'CPI y/y',
    category: 'inflation',
    country: 'United States',
    countryCode: 'US',
    currency: 'USD',
    startAt: '2026-08-10T12:30:00.000Z',
    importance: 3,
    forecast: '2.8%',
    previous: '2.7%',
    actual: null,
    unit: null,
    source: 'Forex Factory',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    lastUpdatedAt: '2026-08-10T15:30:00.000Z',
    provider: 'Forex Factory',
    verification: 'provider-export',
    ...overrides,
  };
}

function verifiedSnapshot(events = [], overrides = {}) {
  return {
    status: 'verified',
    provider: 'Forex Factory',
    providerMode: 'weekly-export',
    timezone: 'America/New_York',
    coverage: { from: '2026-08-09', to: '2026-08-15' },
    fetchedAt: FIXED_NOW.toISOString(),
    sourceUpdatedAt: '2026-08-10T15:30:00.000Z',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    code: null,
    reason: null,
    events,
    ...overrides,
  };
}

function resource(overrides = {}) {
  return {
    data: verifiedSnapshot(),
    availability: 'live',
    initialLoading: false,
    refreshing: false,
    error: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

describe('MarketEventsQuickReference', () => {
  beforeEach(() => {
    useMarketEvents.mockReset();
  });

  test('renders the shared verified three-day agenda in ET with source attribution', () => {
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([
        event(),
        event({
          id: 'ff-222222222222222222222222',
          name: 'BoE Interest Rate Decision',
          country: 'United Kingdom',
          countryCode: 'UK',
          currency: 'GBP',
          startAt: '2026-08-11T11:00:00.000Z',
        }),
      ]),
    }));

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getByText('CPI y/y')).toBeInTheDocument();
    expect(screen.getByText('8:30a')).toBeInTheDocument();
    expect(screen.getByText('BoE Interest Rate Decision')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TODAY market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'TOMORROW market events' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'NEXT market events' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'FF' })).toHaveAttribute(
      'href',
      'https://www.forexfactory.com/calendar/rss',
    );
    expect(screen.getByTitle('All event times shown in Eastern Time')).toHaveTextContent('ET');
  });

  test('keeps missing provider expectations explicit', () => {
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([event({ forecast: null, previous: null })]),
    }));

    render(<MarketEventsQuickReference now={now} />);

    const row = screen.getByTitle(/US CPI y\/y/);
    expect(row).toHaveAttribute('title', expect.stringContaining('Consensus: unavailable'));
    expect(row).toHaveAttribute('title', expect.stringContaining('Prior: unavailable'));
  });

  test('switches from three days to the verified seven-day provider week', () => {
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([event()]),
    }));
    render(<MarketEventsQuickReference now={now} />);

    expect(screen.queryByRole('button', { name: 'Month' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));

    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('grid', { name: 'Aug 9–15 market events' })).toBeInTheDocument();
    expect(screen.getAllByRole('gridcell')).toHaveLength(7);
    expect(screen.getByText('Verified week · Aug 9–15 ET')).toBeInTheDocument();
  });

  test('labels verified covered empty days separately from dates beyond the export', () => {
    const saturdayNow = new Date('2026-08-15T16:00:00.000Z');
    useMarketEvents.mockReturnValue(resource({
      data: verifiedSnapshot([], {
        fetchedAt: saturdayNow.toISOString(),
        sourceUpdatedAt: '2026-08-15T15:30:00.000Z',
      }),
    }));

    render(<MarketEventsQuickReference now={() => saturdayNow} />);

    const today = screen.getByRole('region', { name: 'TODAY market events' });
    const tomorrow = screen.getByRole('region', { name: 'TOMORROW market events' });
    const next = screen.getByRole('region', { name: 'NEXT market events' });
    expect(within(today).getByText('No high-impact events')).toBeInTheDocument();
    expect(within(tomorrow).getByText('Not covered yet')).toBeInTheDocument();
    expect(within(next).getByText('Not covered yet')).toBeInTheDocument();
  });

  test('shows no-event text only after a verified covered response', () => {
    useMarketEvents.mockReturnValue(resource());

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getAllByText('No high-impact events')).toHaveLength(3);
    expect(screen.queryByText('Not covered yet')).not.toBeInTheDocument();
  });

  test('renders loading and provider-unavailable states without event rows', () => {
    useMarketEvents.mockReturnValue(resource({
      data: null,
      availability: 'loading',
      initialLoading: true,
    }));
    const { unmount } = render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('Loading verified calendar…')).toBeInTheDocument();
    unmount();

    const refresh = jest.fn();
    useMarketEvents.mockReturnValue(resource({
      data: null,
      availability: 'unavailable',
      error: new Error('Provider offline'),
      refresh,
    }));
    render(<MarketEventsQuickReference now={now} />);
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['wrong-provider', verifiedSnapshot([event()], { provider: 'Trading Economics' })],
    ['stale', verifiedSnapshot([event()], {
      fetchedAt: '2026-08-10T14:49:59.000Z',
      sourceUpdatedAt: '2026-08-10T14:19:59.000Z',
    })],
  ])('fails closed for a %s snapshot even when marked live', (_label, data) => {
    useMarketEvents.mockReturnValue(resource({ data }));

    render(<MarketEventsQuickReference now={now} />);

    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
    expect(screen.queryByText('CPI y/y')).not.toBeInTheDocument();
  });
});
