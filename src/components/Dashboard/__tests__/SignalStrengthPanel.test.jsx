import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SignalStrengthPanel, { isVerifiedLiveQuote } from '../SignalStrengthPanel';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../constants/securitiesList', () => ({
  SECURITIES_LIST: [
    { ticker: 'AAA', name: 'Alpha', assetClass: 'equity' },
    { ticker: 'BBB', name: 'Beta', assetClass: 'fixedIncome' },
  ],
  ASSET_CLASS_NAMES: { equity: 'Equity', fixedIncome: 'Fixed Income' },
}));

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getProviderStatus: jest.fn(),
    getQuotes: jest.fn(),
    getRiskRanges: jest.fn(),
    getHistoricalData: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
  },
}));

describe('SignalStrengthPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MarketDataService.getProviderStatus.mockResolvedValue({ ibkr: { connected: true } });
    MarketDataService.getQuotes.mockResolvedValue({
      AAA: { price: '101.25', source: 'ibkr', dataType: 'live', timestamp: new Date().toISOString() },
      BBB: { price: '49.50', source: 'yahoo', dataType: 'delayed', timestamp: new Date().toISOString() },
    });
    MarketDataService.getRiskRanges.mockResolvedValue({
      AAA: { lrr: 95, hrr: 105, trend: 'BULLISH', date: '2026-07-13' },
      BBB: { lrr: 45, hrr: 55, trend: 'BEARISH', date: '2026-07-13' },
    });
    MarketDataService.getHistoricalData.mockResolvedValue({ data: [{ date: '2026-06-13', close: 100 }, { date: '2026-07-13', close: 105 }] });
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue({ date: '2026-07-13' });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('accepts only current verified IBKR quotes', () => {
    const status = { ibkr: { connected: true } };
    const now = Date.now();
    expect(isVerifiedLiveQuote({ price: 10, source: 'ibkr', dataType: 'live', timestamp: new Date(now).toISOString() }, status, now)).toBe(true);
    expect(isVerifiedLiveQuote({ price: 10, source: 'yahoo', dataType: 'delayed', timestamp: new Date(now).toISOString() }, status, now)).toBe(false);
    expect(isVerifiedLiveQuote({ price: 10, source: 'cache', timestamp: new Date(now).toISOString() }, status, now)).toBe(false);
    expect(isVerifiedLiveQuote({ price: 10, source: 'ibkr', timestamp: new Date(now - 61000).toISOString() }, status, now)).toBe(false);
    expect(isVerifiedLiveQuote({ price: 10, source: 'ibkr', timestamp: new Date(now).toISOString() }, { ibkr: { connected: false } }, now)).toBe(false);
  });

  test('uses authoritative changelog changes, hides delayed quotes, and stops polling after unmount', async () => {
    const onRefreshChangelog = jest.fn().mockResolvedValue({});
    const { unmount } = render(
      <SignalStrengthPanel
        onClose={jest.fn()}
        changelog={{ 'signal-strength': { added: ['TRU'], removed: ['LEVI'], currentDate: '2026-07-13' } }}
        onRefreshChangelog={onRefreshChangelog}
      />
    );

    expect(await screen.findByText('TRU')).toBeInTheDocument();
    expect(screen.getByText('LEVI')).toBeInTheDocument();

    await waitFor(() => expect(MarketDataService.getQuotes).toHaveBeenCalled());
    expect(await screen.findByText('101.25')).toBeInTheDocument();
    expect(screen.queryByText('49.50')).not.toBeInTheDocument();

    const callsBeforePoll = MarketDataService.getQuotes.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(30000); });
    expect(MarketDataService.getQuotes.mock.calls.length).toBeGreaterThan(callsBeforePoll);

    unmount();
    const callsAtUnmount = MarketDataService.getQuotes.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(60000); });
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(callsAtUnmount);
  });

  test('clears live values when the provider refresh reports offline', async () => {
    MarketDataService.getProviderStatus
      .mockResolvedValueOnce({ ibkr: { connected: true } })
      .mockResolvedValueOnce({ ibkr: { connected: true } })
      .mockResolvedValue({ ibkr: { connected: false } });

    render(<SignalStrengthPanel onClose={jest.fn()} changelog={{}} onRefreshChangelog={jest.fn()} />);
    expect(await screen.findByText('101.25')).toBeInTheDocument();

    await act(async () => { jest.advanceTimersByTime(30000); });
    expect(await screen.findByText(/No live IBKR quotes/i)).toBeInTheDocument();
    expect(screen.queryByText('101.25')).not.toBeInTheDocument();
  });
});
