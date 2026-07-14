import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MarketDataService } from '../../services/api/marketDataService';
import RadarReferencePanels, { getRowQuoteStatus, readManualRecord } from './RadarReferencePanels';

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getDollarLiquidityModels: jest.fn(),
    getMarketShareVolume: jest.fn(),
  },
}));
jest.mock('./MultiRegionMarketOverview', () => ({
  CurrenciesCompactRail: () => null,
}));

describe('radar reference data guards', () => {
  const now = new Date('2026-07-13T21:00:00.000Z').getTime();

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts explicitly delayed public quotes without calling them live', () => {
    expect(getRowQuoteStatus({
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
    }, null)).toBe('delayed');
  });

  it('rejects delayed public quotes beyond the four-day analytical cutoff', () => {
    expect(getRowQuoteStatus({
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      quoteAsOf: '2026-07-08T20:59:00.000Z',
    }, null)).toBe('unavailable');
  });

  it('uses a two-hour cutoff for continuously traded crypto quotes', () => {
    const cryptoRow = {
      symbol: 'BTC',
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      quoteAsOf: '2026-07-13T18:00:00.000Z',
    };

    expect(getRowQuoteStatus(cryptoRow, null)).toBe('unavailable');
    expect(getRowQuoteStatus({
      ...cryptoRow,
      quoteAsOf: '2026-07-13T20:00:01.000Z',
    }, null)).toBe('delayed');
  });

  it('rejects an old IBKR mark as soon as provider health is delayed', () => {
    const row = {
      availability: 'current',
      source: 'ibkr',
      dataType: 'live',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:59:50.000Z',
    };
    const providerStatus = {
      timestamp: '2026-07-13T20:59:55.000Z',
      ibkr: { connected: true, lastQuoteAt: '2026-07-13T20:59:50.000Z' },
    };

    expect(getRowQuoteStatus(row, providerStatus)).toBe('live');
    expect(getRowQuoteStatus(row, { ...providerStatus, statusRefreshDelayed: true })).toBe('unavailable');
  });

  it('rejects legacy rows without the explicit backend availability enum', () => {
    expect(getRowQuoteStatus({
      availability: 'available',
      source: 'yahoo',
      dataType: 'delayed',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
    }, null)).toBe('unavailable');
  });

  it('reads manual edit time from the separate compatibility key', () => {
    window.localStorage.setItem('styleFactorPerformanceData', JSON.stringify({
      Value: { '1D': '0.2' },
    }));
    window.localStorage.setItem(
      'styleFactorPerformanceData.lastEditedAt',
      '2026-07-13T20:15:00.000Z',
    );

    const record = readManualRecord('styleFactorPerformanceData');
    expect(record.lastEditedAt).toBe('2026-07-13T20:15:00.000Z');
    expect(record.rows.Value['1D']).toBe('0.2');
  });
});

describe('radar reference volume card', () => {
  beforeEach(() => {
    MarketDataService.getDollarLiquidityModels.mockResolvedValue({ models: {} });
    MarketDataService.getMarketShareVolume.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('places Volume immediately to the right of Dollar Liquidity', async () => {
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing' },
    });

    render(<RadarReferencePanels />);

    const referenceBar = screen.getByRole('region', { name: 'Normal / Reference' });
    const cards = within(referenceBar).getAllByRole('region');
    const liquidity = screen.getByRole('region', { name: 'Dollar Liquidity' });
    const volume = screen.getByRole('region', { name: 'Volume' });
    expect(cards).toHaveLength(6);
    expect(cards[4]).toBe(liquidity);
    expect(cards[5]).toBe(volume);
    await within(volume).findByLabelText('UNAVAILABLE');
  });

  test('surfaces a provisional dataset with its as-of date', async () => {
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      asOf: '2026-07-10',
      metrics: {
        totalMarket: { pctPriorDay: 15, pct1M: 1, pct3M: 5, pct1Y: 8 },
        exchange: { pctPriorDay: 22, pct1M: 4, pct3M: 9, pct1Y: 16 },
      },
      meta: {
        status: 'provisional',
        asOfTradingDate: '2026-07-10',
        uploadDate: '2026-07-13',
        methodologyVersion: 'hedgeye-volume-slide-direct-v1',
      },
    });

    render(<RadarReferencePanels />);

    const panel = screen.getByRole('region', { name: 'Volume' });
    const chip = await within(panel).findByLabelText('PROVISIONAL · AS OF JUL 10');
    expect(chip).toHaveAttribute('data-status', 'delayed');
    expect(chip).toHaveClass('efr-status-chip--delayed');
  });

  test.each([
    ['failed', () => MarketDataService.getMarketShareVolume.mockRejectedValue(new Error('offline'))],
    ['missing', () => MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing', asOfTradingDate: null },
    })],
  ])('keeps a %s volume dataset unavailable', async (_case, arrange) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    arrange();

    render(<RadarReferencePanels />);

    const panel = screen.getByRole('region', { name: 'Volume' });
    await waitFor(() => {
      expect(within(panel).getByLabelText('UNAVAILABLE')).toHaveAttribute('data-status', 'unavailable');
    });
    expect(within(panel).queryByText('PROVISIONAL')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
