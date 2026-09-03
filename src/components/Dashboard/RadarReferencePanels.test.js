import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MarketDataService } from '../../services/api/marketDataService';
import RadarReferencePanels, {
  aggregateQuoteStatus,
  CurrenciesPreview,
  getRowQuoteStatus,
  readManualRecord,
} from './RadarReferencePanels';
import { resetSessionResourceStore } from '../../utils/sessionResourceStore';
import {
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
} from './dashboardStatus';

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getDollarLiquidityModels: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getMarketShareVolume: jest.fn(),
  },
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

  it('accepts a verified Yahoo fallback while preserving the rejected IBKR warning', () => {
    expect(getRowQuoteStatus({
      symbol: 'DJI',
      price: '54036.93',
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
      warning: 'ibkr: close_only_reference; missing_timestamp; stale_quote; delayed_data',
    }, null)).toBe('delayed');
  });

  it('accepts a direct Yahoo row with its delayed provenance warning', () => {
    expect(getRowQuoteStatus({
      symbol: 'SMH',
      price: '250.00',
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
      warning: 'yahoo_fallback',
    }, null)).toBe('delayed');
  });

  it('still rejects a stale warning emitted by the selected Yahoo provider', () => {
    expect(getRowQuoteStatus({
      symbol: 'DJI',
      price: '54036.93',
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
      warning: 'stale_quote',
    }, null)).toBe('unavailable');
  });

  it('reports mixed coverage when verified rows and missing rows coexist', () => {
    expect(aggregateQuoteStatus([
      {
        availability: 'delayed',
        source: 'yahoo',
        dataType: 'delayed',
        freshness: 'current',
        quoteAsOf: '2026-07-13T20:59:00.000Z',
      },
      null,
    ], null)).toBe('mixed');
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

  it('keeps a fresh IBKR mark through a status-poll delay and demotes it on disconnect', () => {
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
    expect(getRowQuoteStatus(row, { ...providerStatus, statusRefreshDelayed: true })).toBe('live');
    expect(getRowQuoteStatus(row, {
      ...providerStatus,
      ibkr: { ...providerStatus.ibkr, connected: false, status: 'offline' },
    })).toBe('delayed');
  });

  it('shows a retained last-verified row as delayed even after its normal live cutoff', () => {
    expect(getRowQuoteStatus({
      symbol: 'SPX',
      price: '7669.22',
      availability: 'reference',
      source: 'ibkr',
      dataType: 'live',
      freshness: 'refresh-delayed',
      quoteAsOf: '2026-07-10T20:00:00.000Z',
      lastVerifiedAt: '2026-07-10T20:00:00.000Z',
      displayDelayed: true,
      displayOnly: true,
      executable: false,
    }, null)).toBe('delayed');
  });

  it('never shows a retained marker when its provenance is synthetic', () => {
    expect(getRowQuoteStatus({
      symbol: 'SPX',
      price: '7669.22',
      availability: 'reference',
      source: 'mock',
      dataType: 'live',
      freshness: 'refresh-delayed',
      quoteAsOf: '2026-07-10T20:00:00.000Z',
      lastVerifiedAt: '2026-07-10T20:00:00.000Z',
      displayDelayed: true,
      displayOnly: true,
      executable: false,
    }, null)).toBe('unavailable');
  });

  it('demotes an aging timestamped IBKR observation instead of blanking it', () => {
    expect(getRowQuoteStatus({
      symbol: 'DJI',
      price: '53002.30',
      availability: 'current',
      source: 'ibkr',
      dataType: 'live',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:58:00.000Z',
    }, null)).toBe('live');

    expect(getRowQuoteStatus({
      symbol: 'DJI',
      price: '53002.30',
      availability: 'current',
      source: 'ibkr',
      dataType: 'live',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:57:59.999Z',
    }, null)).toBe('delayed');
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

  it('shows verified delayed currency values and withholds the same row when stale', () => {
    const delayedRow = {
      symbol: 'EURUSD',
      name: 'EUR/USD',
      price: 1.15,
      changePercent: 0.88,
      thirtyDayChangePct: 2.5,
      periodReturnsStatus: 'available',
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
    };
    const { rerender } = render(<CurrenciesPreview rows={[delayedRow]} />);

    let row = screen.getByRole('row', { name: /EUR\/USD/ });
    expect(row).toHaveTextContent('1.150');
    expect(row).toHaveTextContent('+0.88%');
    expect(row).toHaveTextContent('+2.50%');

    rerender(<CurrenciesPreview rows={[{ ...delayedRow, freshness: 'stale' }]} />);
    row = screen.getByRole('row', { name: /EUR\/USD/ });
    expect(within(row).getAllByRole('cell').slice(1).map(({ textContent }) => textContent))
      .toEqual(['—', '—', '—']);
  });

  it('supports a larger guarded row limit for the split USD currency cards', () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      symbol: `FX${index + 1}`,
      name: `FX ${index + 1}`,
      price: 1 + (index / 100),
      changePercent: index / 10,
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      quoteAsOf: '2026-07-13T20:59:00.000Z',
    }));

    render(<CurrenciesPreview rows={rows} maxRows={6} ariaLabel="Expanded currencies" />);

    const table = screen.getByRole('table', { name: 'Expanded currencies' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getByText('FX 6')).toBeInTheDocument();
    expect(within(table).queryByText('FX 7')).not.toBeInTheDocument();
  });
});

describe('radar reference volume card', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-13T21:00:00.000Z').getTime());
    MarketDataService.getDollarLiquidityModels.mockResolvedValue({ models: {} });
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
    MarketDataService.getMarketShareVolume.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
  });

  afterEach(() => {
    resetSessionResourceStore();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('renders four reference cards in the reflowed order', async () => {
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing' },
    });

    render(<RadarReferencePanels />);

    const referenceBar = screen.getByRole('region', { name: 'Normal / Reference' });
    expect(within(referenceBar).queryByRole('heading', { name: 'Normal / Reference' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByText('Select any panel for the full source view')).not.toBeInTheDocument();
    const cards = within(referenceBar).getAllByRole('region');
    const cftc = screen.getByRole('region', { name: 'CFTC Positioning' });
    const quads = screen.getByRole('region', { name: 'Global Quads' });
    const liquidity = screen.getByRole('region', { name: 'Dollar Liquidity' });
    const volume = screen.getByRole('region', { name: 'Volume' });
    expect(cards).toHaveLength(4);
    expect(cards).toEqual([cftc, quads, liquidity, volume]);
    expect(within(referenceBar).queryByRole('region', { name: 'Market Situation' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByRole('region', { name: 'Style Factors' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByRole('region', { name: 'Currencies' })).not.toBeInTheDocument();
    await waitFor(() => expect(volume).toHaveAttribute('data-status', 'unavailable'));
    expect(within(volume).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
  });

  test('keeps Market Situation out of the strip while preserving its status reporting', async () => {
    const onDashboardStatusChange = jest.fn();
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue({
      date: '2026-07-13',
      snapshotType: 'market-structure',
      article: {
        headline: 'MARKET SITUATION REPORT: STRUCTURALLY VULNERABLE SETUP',
      },
      data: {
        signals: [
          { id: 'gamma', label: 'SPX Gamma Exposure', value: 'Negative', tone: 'negative' },
          { id: 'flow', label: 'Systematic Flow Risk', value: 'Bearish', tone: 'negative' },
          { id: 'pv', label: 'PV Band Risk/Reward', value: 'Neutral', tone: 'neutral' },
          { id: 'allocation', label: 'Strategic Allocation', value: 'Risk On', tone: 'positive' },
        ],
        signalMatrixImageUrl: 'https://d1yhils6iwh5l5.cloudfront.net/charts/signals.png',
        charts: [],
      },
    });
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing' },
    });

    render(<RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />);

    const referenceBar = screen.getByRole('region', { name: 'Normal / Reference' });
    expect(within(referenceBar).queryByRole('region', { name: 'Market Situation' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByText('SPX Gamma Exposure')).not.toBeInTheDocument();
    await waitFor(() => expect(
      onDashboardStatusChange.mock.calls.at(-1)[0].find(({ id }) => id === 'market-situation'),
    ).toEqual(expect.objectContaining({ status: 'historical' })));
  });

  test('reports each reference card as an isolated Dashboard status', async () => {
    const onDashboardStatusChange = jest.fn();
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing' },
    });

    render(<RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />);

    await waitFor(() => expect(onDashboardStatusChange).toHaveBeenCalled());
    const latestStatuses = onDashboardStatusChange.mock.calls.at(-1)[0];
    expect(latestStatuses.map(({ id }) => id)).toEqual([
      'cftc-positioning',
      'market-situation',
      'global-quads',
      'dollar-liquidity',
      'volume',
    ]);
    expect(latestStatuses.find(({ id }) => id === 'global-quads')).toEqual(expect.objectContaining({
      status: 'manual',
      detail: 'NO AS-OF',
    }));
  });

  test('settles status publishing when the parent stores each update', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const publishSpy = jest.fn();
    MarketDataService.getMarketShareVolume.mockResolvedValue({
      totalMarket: [],
      totalExchange: [],
      meta: { status: 'missing' },
    });
    const StatefulParent = () => {
      const [statuses, setStatuses] = useState(createUnknownDashboardCardStatuses);
      const handleStatusChange = useCallback((updates) => {
        publishSpy(updates);
        setStatuses((current) => mergeDashboardCardStatuses(current, updates));
      }, []);
      return (
        <>
          <output data-testid="volume-parent-status">{statuses.volume.status}</output>
          <RadarReferencePanels onDashboardStatusChange={handleStatusChange} />
        </>
      );
    };

    render(<StatefulParent />);

    await waitFor(() => expect(screen.getByTestId('volume-parent-status')).toHaveTextContent('unavailable'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const settledPublishCount = publishSpy.mock.calls.length;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(publishSpy).toHaveBeenCalled();
    expect(publishSpy.mock.calls).toHaveLength(settledPublishCount);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/Maximum update depth exceeded/i);
    consoleError.mockRestore();
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
        uploadDate: new Date().toISOString(),
        methodologyVersion: 'hedgeye-volume-slide-direct-v1',
      },
    });

    render(<RadarReferencePanels />);

    const panel = screen.getByRole('region', { name: 'Volume' });
    await waitFor(() => expect(panel).toHaveAttribute('data-status', 'delayed'));
    expect(within(panel).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Volume' }));
    expect(await screen.findByRole('dialog', { name: 'Volume' })).toBeInTheDocument();
    expect(MarketDataService.getMarketShareVolume).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(panel).toHaveAttribute('data-status', 'unavailable'));
    expect(within(panel).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    expect(within(panel).queryByText('PROVISIONAL')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
