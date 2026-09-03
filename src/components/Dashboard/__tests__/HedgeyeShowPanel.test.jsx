import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import HedgeyeShowPanel, { getRecentShowMarketDays, getSnapshotPositions } from '../HedgeyeShowPanel';
import PersistentSurface from '../../common/PersistentSurface';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getHedgeyeSnapshot: jest.fn(),
  },
}));

const snapshot = (date, data) => ({
  date,
  snapshotType: 'the-call',
  scrapedAt: `${date}T13:30:00Z`,
  data,
  article: { feedUrl: 'https://app.hedgeye.com/feed_items/1' },
});

describe('HedgeyeShowPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shows current positioning, changes, history, and source metadata', async () => {
    const days = getRecentShowMarketDays(5);
    const fixtures = {
      [days[0].dateKey]: snapshot(days[0].dateKey, {
        longs: ['META', 'AAPL'],
        shorts: ['TSLA'],
        neutrals: ['D'],
      }),
      [days[1].dateKey]: snapshot(days[1].dateKey, {
        longs: ['META'],
        shorts: ['TSLA', 'NVDA'],
        neutrals: [],
      }),
    };
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (_type, date) => fixtures[date] || null);

    render(<HedgeyeShowPanel snapshotType="the-call" title="Call" onClose={jest.fn()} />);

    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('NVDA').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Source' }).length).toBe(2);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search Call positions' }), { target: { value: 'AAPL' } });
    expect(screen.getByText(days[0].label)).toBeInTheDocument();
    expect(screen.queryByText(days[1].label)).not.toBeInTheDocument();
  });

  test('clears snapshots when a manual refresh returns no data', async () => {
    const days = getRecentShowMarketDays(5);
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (_type, date) => (
      date === days[0].dateKey
        ? snapshot(days[0].dateKey, { longs: ['META'], shorts: [], neutrals: [] })
        : null
    ));

    render(<HedgeyeShowPanel snapshotType="the-call" title="Call" onClose={jest.fn()} />);
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getAllByText('META').length).toBeGreaterThan(0);

    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Call' }));

    expect(await screen.findByText('No Call snapshots are available for the last five market days.')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('META')).not.toBeInTheDocument();
  });

  test('keeps its snapshot and interaction state without an activation-only reload', async () => {
    const days = getRecentShowMarketDays(5);
    MarketDataService.getHedgeyeSnapshot.mockImplementation(async (_type, date) => (
      date === days[0].dateKey
        ? snapshot(days[0].dateKey, { longs: ['AAPL'], shorts: [], neutrals: [] })
        : null
    ));
    const panel = (
      <HedgeyeShowPanel snapshotType="the-call" title="Call" onClose={jest.fn()} />
    );
    const view = render(<PersistentSurface active>{panel}</PersistentSurface>);

    expect(await screen.findByText('Current')).toBeInTheDocument();
    const initialCallCount = MarketDataService.getHedgeyeSnapshot.mock.calls.length;
    expect(initialCallCount).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Call positions' }), {
      target: { value: 'AAPL' },
    });

    view.rerender(<PersistentSurface active={false}>{panel}</PersistentSurface>);
    view.rerender(<PersistentSurface active>{panel}</PersistentSurface>);

    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(initialCallCount);
    expect(screen.getByRole('textbox', { name: 'Search Call positions' })).toHaveValue('AAPL');
    expect(screen.getAllByText('AAPL').length).toBeGreaterThan(0);
  });

  test('removes known Macro Show boilerplate artifacts without fabricating positions', () => {
    expect(getSnapshotPositions({ data: { shorts: ['Oil (WTI)', 'not of any strength'] } }, 'short'))
      .toEqual(['Oil (WTI)']);
    expect(getSnapshotPositions({ data: {} }, 'long')).toBeNull();
  });
});
