import React, { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import TickerTape from './TickerTape';
import USDProxies from './USDProxies';
import VolatilityPanel, { calculateVolatilityMetrics, calculateRealizedVolatility } from './VolatilityPanel';
import { MarketDataService } from '../../services/api/marketDataService';
import { USDMarketService } from '../../services/api/usdMarketService';
import { resetSessionResourceStore } from '../../utils/sessionResourceStore';

jest.mock('../../services/api/marketDataService', () => ({ MarketDataService: { getHistoricalData: jest.fn() } }));
jest.mock('../../services/api/usdMarketService', () => ({ USDMarketService: { getHistoricalData: jest.fn() } }));
jest.mock('recharts', () => ({
  ...jest.requireActual('recharts'),
  ResponsiveContainer: ({ children }) => require('react').cloneElement(children, { width: 600, height: 250 }),
}));

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-04T21:00:00Z'));
  MarketDataService.getHistoricalData.mockReset().mockRejectedValue(new Error('Offline'));
  USDMarketService.getHistoricalData.mockReset().mockRejectedValue(new Error('Offline'));
});
afterEach(() => { resetSessionResourceStore(); jest.useRealTimers(); });

test('ticker tape requires supplied verified observations and labels their original date', () => {
  const { container, rerender } = render(<TickerTape />);
  expect(screen.getAllByText('Unavailable')).toHaveLength(22);
  expect(container).not.toHaveTextContent(/\d+\.\d+/);
  rerender(<TickerTape quotes={{ SP500: { symbol: 'SP500', source: 'ibkr', timestamp: '2026-09-03T20:00:00Z', price: 6100 } }} />);
  expect(screen.getAllByText('6,100.00')).toHaveLength(2);
  expect(screen.getAllByText(/Reference · As of/)).toHaveLength(2);
  expect(container).not.toHaveTextContent('+0.00%');
  rerender(<TickerTape quotes={{ SP500: { symbol: 'SP500', source: 'ibkr', timestamp: '2026-09-03T20:00:00Z', price: 6100, stale: true } }} />);
  expect(screen.queryByText('6,100.00')).not.toBeInTheDocument();
});

test('FX panel preserves instrument choices but never invents index quotes or changes from history failure', async () => {
  const { container } = render(<USDProxies currencyPairs={[{ pair: 'USDEUR', name: 'Euro' }]} />);
  await waitFor(() => expect(USDMarketService.getHistoricalData).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.allSettled(USDMarketService.getHistoricalData.mock.results.map(({ value }) => value)); });
  expect(screen.getByText('FXE')).toBeInTheDocument();
  expect(screen.getByText('UUP (USD Index)')).toBeInTheDocument();
  expect(screen.getAllByText('Verified quote unavailable')).toHaveLength(5);
  expect(screen.getAllByText('No verified history')).toHaveLength(2);
  expect(container).not.toHaveTextContent(/\d+\.\d+%/);
});

test('volatility failure and unsupported index keep charts and metrics unavailable', async () => {
  const { container } = render(<VolatilityPanel />);
  expect(await screen.findByText('No verified chart data available')).toBeInTheDocument();
  expect(MarketDataService.getHistoricalData).toHaveBeenCalledWith('^VIX', 400);
  expect(container).not.toHaveTextContent(/\d+\.\d+/);
  fireEvent.click(screen.getByRole('combobox', { name: 'Volatility index' }));
  fireEvent.click(screen.getByRole('option', { name: 'TYVIX' }));
  expect(await screen.findByText('No verified chart data available')).toBeInTheDocument();
  expect(MarketDataService.getHistoricalData).toHaveBeenCalledTimes(1);
});

test('volatility uses actual historical closes and clears visible metrics after refresh failure', async () => {
  MarketDataService.getHistoricalData.mockResolvedValueOnce({ symbol: '^VIX', data: [
    { date: '2026-09-02', close: 17 }, { date: '2026-09-03', close: 18 },
  ] });
  render(<VolatilityPanel />);
  expect(await screen.findAllByText('18.00')).toHaveLength(2);
  expect(screen.getByText('17.00')).toBeInTheDocument();
  expect(screen.getByText('+5.88%')).toBeInTheDocument();
  expect(screen.getByText(/Historical reference · As of/)).toBeInTheDocument();
  await act(async () => { jest.advanceTimersByTime(900000); });
  expect(screen.queryByText('18.00')).not.toBeInTheDocument();
  expect(screen.getByText('No verified chart data available')).toBeInTheDocument();
});

test('period metrics require an actual comparison observation and realized volatility permits measured zero', () => {
  const metrics = calculateVolatilityMetrics([{ date: '2026-08-20', value: 10 }, { date: '2026-08-27', value: 12 }], 'VIX');
  expect(metrics.weekOverWeek.percent).toBe(20);
  expect(metrics.monthOverMonth.percent).toBeNull();
  expect(metrics.lrr).toBeNull();
  const prices = Array.from({ length: 64 }, (_, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), close: 100 }));
  expect(calculateRealizedVolatility(prices).at(-1)).toMatchObject({ vol1M: 0, vol3M: 0, dailyChange: 0 });
  expect(calculateRealizedVolatility(prices.slice(0, 20))).toEqual([]);
});
