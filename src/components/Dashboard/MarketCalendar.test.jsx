import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useMarketEvents } from '../../hooks/useMarketEvents';
import { notesService } from '../../services/api/notesService';
import MarketCalendar from './MarketCalendar';

jest.mock('../../services/api/marketEventsService', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../hooks/useMarketEvents', () => ({
  ...jest.requireActual('../../hooks/useMarketEvents'),
  useMarketEvents: jest.fn(),
}));

jest.mock('../../services/api/notesService', () => ({
  notesService: {
    loadCalendarNote: jest.fn(),
    saveCalendarNote: jest.fn(),
  },
}));

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

function snapshot(events = [event()]) {
  return {
    status: 'verified',
    provider: 'Forex Factory',
    providerMode: 'weekly-export',
    timezone: 'America/New_York',
    coverage: { from: '2026-08-09', to: '2026-08-15' },
    fetchedAt: '2026-08-10T16:00:00.000Z',
    sourceUpdatedAt: '2026-08-10T15:30:00.000Z',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    events,
  };
}

function liveResource(overrides = {}) {
  return {
    data: snapshot(),
    availability: 'live',
    initialLoading: false,
    error: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

describe('MarketCalendar verified market-event badges', () => {
  beforeEach(() => {
    jest.useFakeTimers('modern');
    jest.setSystemTime(new Date('2026-08-10T19:00:00.000Z'));
    useMarketEvents.mockReset();
    notesService.loadCalendarNote.mockReset();
    notesService.saveCalendarNote.mockReset();
    notesService.loadCalendarNote.mockResolvedValue(null);
    notesService.saveCalendarNote.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('shows only verified events inside current provider coverage', async () => {
    useMarketEvents.mockReturnValue(liveResource({
      data: snapshot([
        event(),
        event({
          id: 'ff-outside-current-provider-week',
          name: 'Out-of-range GDP',
          startAt: '2026-08-17T12:30:00.000Z',
        }),
      ]),
    }));

    render(<MarketCalendar />);
    await waitFor(() => expect(screen.queryByText('Loading calendar notes...')).not.toBeInTheDocument());

    expect(screen.getByText(/US CPI y\/y \(8:30 AM ET\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Out-of-range GDP/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FOMC Meeting/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forex Factory' })).toHaveAttribute(
      'href',
      'https://www.forexfactory.com/calendar/rss',
    );
  });

  test('keeps notes usable while provider events are unavailable', async () => {
    const retry = jest.fn();
    useMarketEvents.mockReturnValue(liveResource({
      data: null,
      availability: 'unavailable',
      error: new Error('Provider offline'),
      refresh: retry,
    }));
    notesService.loadCalendarNote.mockImplementation((dateKey) => (
      Promise.resolve(dateKey === '2026-08-10' ? 'Desk note' : null)
    ));

    render(<MarketCalendar />);
    expect(await screen.findByText('Desk note')).toBeInTheDocument();

    expect(screen.getByText('Market events unavailable. Notes remain available.')).toBeInTheDocument();
    expect(screen.queryByText(/CPI y\/y/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Desk note'));
    const editor = await screen.findByPlaceholderText('Add your notes for this day...');
    fireEvent.change(editor, { target: { value: 'Updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Note saved successfully!')).toBeInTheDocument();
    await waitFor(() => expect(notesService.saveCalendarNote).toHaveBeenCalledWith(
      '2026-08-10',
      'Updated note',
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('keeps note navigation but removes badges outside the current week', async () => {
    useMarketEvents.mockReturnValue(liveResource());

    render(<MarketCalendar />);
    await waitFor(() => expect(screen.queryByText('Loading calendar notes...')).not.toBeInTheDocument());
    expect(screen.getByText(/US CPI y\/y/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '→' }));
    await waitFor(() => expect(screen.queryByText('Loading calendar notes...')).not.toBeInTheDocument());

    expect(screen.getByText(/Market-event coverage is current-week only \(Aug 9–15 ET\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/US CPI y\/y/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    await waitFor(() => expect(screen.queryByText('Loading calendar notes...')).not.toBeInTheDocument());
    expect(screen.getByText(/Market-event coverage is current-week only/)).toBeInTheDocument();
  });
});
