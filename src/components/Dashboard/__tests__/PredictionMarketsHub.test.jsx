import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PredictionMarketsHub, {
  classifyPredictionMarketPosition,
  normalizeLivePositionsPayload,
} from '../PredictionMarketsHub';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: { getPortfolioPredictionMarketPositions: jest.fn() },
}));

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: { getPredictionMarketsOverview: jest.fn() },
}));

const mockWtiWorkbench = jest.fn();
const mockSpxWorkbench = jest.fn();
const mockCpiWorkbench = jest.fn();
jest.mock('../WtiWorkbench', () => (props) => {
  mockWtiWorkbench(props);
  return <div>WTI Workbench</div>;
});
jest.mock('../PredictionMarketsSandbox', () => (props) => {
  mockSpxWorkbench(props);
  return <div>SPX Workbench</div>;
});
jest.mock('../PredictionMarkets', () => (props) => {
  mockCpiWorkbench(props);
  return <div>CPI Workbench</div>;
});

const summary = (overrides = {}) => ({
  seriesTicker: 'KXTEST',
  eventTicker: 'KXTEST-26JUL21',
  eventTitle: 'Test event',
  marketTicker: 'KXTEST-26JUL21-T100',
  marketTitle: 'Test above 100',
  closeTime: '2026-07-21T20:00:00.000Z',
  yesBid: 0.42,
  yesAsk: 0.45,
  yesBidSize: 12,
  yesAskSize: 18,
  spread: 0.03,
  marketCount: 20,
  completeBookCount: 17,
  volume24h: 1234,
  openInterest: 4321,
  freshness: { status: 'current', updatedAt: '2026-07-21T19:59:00.000Z' },
  lines: [
    { ticker: 'LINE-1', label: 'Above 2.8%', sortValue: 2.8, yesBid: 0.42, yesAsk: 0.45, noBid: 0.55, noAsk: 0.58, volume24h: 1250 },
    { ticker: 'LINE-2', label: 'Above 2.9%', sortValue: 2.9, yesBid: 0.35, yesAsk: 0.38, noBid: 0.62, noAsk: 0.65, volume24h: 830 },
  ],
  lineCount: 8,
  selection: { method: 'reference_centered', label: 'Centered on Hedgeye base case' },
  reference: {
    status: 'available',
    kind: 'forecast',
    label: 'Hedgeye base case',
    value: 2.85,
    source: 'hedgeye_inflation_nowcast',
  },
  chart: {
    status: 'available',
    source: 'kalshi_trade_api_v2',
    ticker: 'LINE-1',
    label: 'Above 2.8%',
    latestAt: '2026-07-21T20:00:00.000Z',
    points: [
      { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), close: 0.39 },
      { timestamp: Date.parse('2026-07-21T19:00:00.000Z'), close: 0.41 },
      { timestamp: Date.parse('2026-07-21T20:00:00.000Z'), close: 0.43 },
    ],
  },
  signal: {
    name: 'Risk Range',
    status: 'available',
    details: { date: '2026-07-21', lrr: 80, hrr: 86, trend: 'BULLISH' },
  },
  ...overrides,
});

const OVERVIEW = {
  ok: true,
  fetchedAt: '2026-07-21T20:00:00.000Z',
  markets: {
    cpi: {
      status: 'available',
      summary: summary({
        seriesTicker: 'KXCPI',
        eventTitle: 'July CPI',
        lines: [
          { ticker: 'CPI-1', label: 'Above 2.8%', sortValue: 2.8, yesBid: 0.42, yesAsk: 0.45, noBid: 0.55, noAsk: 0.58, volume24h: 1250 },
          { ticker: 'CPI-2', label: 'Above 2.9%', sortValue: 2.9, yesBid: 0.35, yesAsk: 0.38, noBid: 0.62, noAsk: 0.65, volume24h: 830 },
        ],
        signal: {
          name: 'Hedgeye Inflation Nowcast',
          status: 'available',
          details: {
            forecastMonth: 'July 2026',
            metric: 'Headline CPI YoY',
            scenarios: [
              { key: 'downside', label: 'Downside', value: 2.7 },
              { key: 'base', label: 'Base Case', value: 2.8 },
              { key: 'upside', label: 'Upside', value: 2.9 },
            ],
          },
        },
      }),
    },
    spx: {
      status: 'available',
      summary: summary({
        seriesTicker: 'KXINXU',
        eventTitle: 'S&P 500 close',
        lines: [
          { ticker: 'SPX-1', label: 'Above 7,300', sortValue: 7300, yesBid: 0.6, yesAsk: 0.63, noBid: 0.37, noAsk: 0.4, volume24h: 4200 },
          { ticker: 'SPX-2', label: 'Above 7,325', sortValue: 7325, yesBid: 0.51, yesAsk: 0.54, noBid: 0.46, noAsk: 0.49, volume24h: 3100 },
        ],
        reference: { status: 'available', kind: 'underlying', label: 'S&P 500', value: 7310, source: 'ibkr' },
        selection: { method: 'reference_centered', label: 'Centered on S&P 500' },
      }),
    },
    wti: {
      daily: {
        status: 'available',
        summary: summary({
          seriesTicker: 'KXWTI',
          marketTicker: 'KXWTI-DAILY-T84',
          lines: [
            { ticker: 'WTI-1', label: 'Above $83', sortValue: 83, yesBid: 0.43, yesAsk: 0.44, noBid: 0.56, noAsk: 0.57, volume24h: 970 },
            { ticker: 'WTI-2', label: 'Above $84', sortValue: 84, yesBid: 0.31, yesAsk: 0.33, noBid: 0.67, noAsk: 0.69, volume24h: 640 },
          ],
          reference: { status: 'available', kind: 'underlying', label: 'WTI', value: 83.5, source: 'ibkr' },
          selection: { method: 'reference_centered', label: 'Centered on WTI' },
        }),
      },
      weekly: { status: 'unavailable', summary: null, error: 'No current weekly event.' },
    },
  },
};

function Harness({ initial = 'overview', onClose = jest.fn() }) {
  const [active, setActive] = useState(initial);
  const [cadence, setCadence] = useState('daily');
  return (
    <PredictionMarketsHub
      activeMarket={active}
      onActiveMarketChange={setActive}
      activeWtiCadence={cadence}
      onWtiCadenceChange={setCadence}
      selectedAccount="U1"
      onClose={onClose}
      portfolioData={{ accountId: 'U1' }}
    />
  );
}

describe('PredictionMarketsHub', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue(OVERVIEW);
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }],
      positions: [],
    });
  });

  test('uses the three cards as the only market selector and mounts only the selected workbench', async () => {
    render(<Harness />);

    const overview = await screen.findByTestId('prediction-markets-overview');
    expect(await within(overview).findByText('Above 2.8%')).toBeInTheDocument();
    expect(within(overview).getByText('Above 7,300')).toBeInTheDocument();
    expect(within(overview).getByText('Above $83')).toBeInTheDocument();
    expect(within(overview).getByText('No current weekly event.')).toBeInTheDocument();
    expect(within(overview).getByText('July 2026')).toBeInTheDocument();
    expect(within(overview).getByText('2.80%')).toBeInTheDocument();
    expect(within(overview).getAllByText('NO bid').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('NO ask').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('24h vol').length).toBeGreaterThan(0);
    expect(within(overview).getByText('Hedgeye base case 2.85%')).toBeInTheDocument();
    expect(within(overview).getByText('S&P 500 7,310')).toBeInTheDocument();
    expect(within(overview).getAllByLabelText(/Live 1-day chart/)).toHaveLength(3);
    expect(screen.queryByRole('navigation', { name: 'Prediction market view' })).not.toBeInTheDocument();
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('SPX Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('region', { name: 'S&P 500 Close market summary' })).getByRole('button', { name: /S&P 500 Close/i }));
    expect(await screen.findByText('SPX Workbench')).toBeInTheDocument();
    expect(screen.queryByTestId('prediction-markets-overview')).not.toBeInTheDocument();
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();
    expect(mockSpxWorkbench).toHaveBeenLastCalledWith(expect.objectContaining({
      embedded: true,
      sharedPositionsState: expect.objectContaining({ status: 'live' }),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'All markets' }));
    expect(await screen.findByTestId('prediction-markets-overview')).toBeInTheDocument();
  });

  test('shows every verified-live position and routes recognized rows without hiding Other', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'partial',
      meta: { source: 'ibkr_live', message: 'Account U2 could not be verified.' },
      accounts: [{ accountId: 'U1', status: 'live' }, { accountId: 'U2', status: 'unavailable' }],
      positions: [
        { positionId: '1', symbol: 'KXWTIW', description: 'KXWTIW-26JUL24-B84.50_YES', accountId: 'U1', quantity: 4, avgCost: 0.32 },
        { positionId: '2', symbol: 'KXALIEN', description: 'Unmapped prediction contract', accountId: 'U1', quantity: 2, avgCost: 0.5 },
      ],
    });

    render(<Harness />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('KXWTIW-26JUL24-B84.50_YES')).toBeInTheDocument();
    expect(within(table).getByText('Unmapped prediction contract')).toBeInTheDocument();
    expect(within(table).getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Account U2 could not be verified.')).toBeInTheDocument();

    fireEvent.click(within(table).getByRole('button', { name: 'WTI' }));
    expect(await screen.findByText('WTI Workbench')).toBeInTheDocument();
    expect(mockWtiWorkbench).toHaveBeenLastCalledWith(expect.objectContaining({ cadence: 'weekly' }));
  });

  test.each([
    [{ status: 'live', meta: { source: 'cache' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ status: 'stale', meta: { source: 'ibkr_live' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ status: 'live', meta: { source: 'mock' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ meta: { source: 'portfolio_fallback' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
  ])('renders no position rows for non-live payload %#', async (payload) => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue(payload);
    render(<Harness />);

    expect(await screen.findByText('Verified-live IBKR positions are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('keeps an Overview outage local while positions and market navigation remain usable', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockRejectedValue(new Error('Venue offline'));
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      positions: [{ positionId: '1', symbol: 'KXINXU', description: 'SPX threshold', quantity: 1 }],
    });

    render(<Harness />);
    expect(await screen.findByText(/Market summaries are unavailable: Venue offline/)).toBeInTheDocument();
    expect(screen.getByText('SPX threshold')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'S&P 500 Close market summary' })).toBeInTheDocument();
  });

  test('localizes a stale market summary without suppressing the other markets', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: { status: 'available', summary: summary({ freshness: { status: 'stale' } }) },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(within(cpiCard).getByText('No verified current lines are available.')).toBeInTheDocument();
    expect(screen.queryByText('Above 2.8%')).not.toBeInTheDocument();
    expect(await screen.findByText('Above 7,300')).toBeInTheDocument();
  });

  test('does not render cache-backed data as a live intraday chart', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: {
          status: 'available',
          summary: summary({
            chart: {
              status: 'available',
              source: 'cache',
              label: 'Above 2.8%',
              points: [{ timestamp: Date.parse('2026-07-21T20:00:00.000Z'), close: 0.43 }],
            },
          }),
        },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(within(cpiCard).getByText('No current direct venue price history is available.')).toBeInTheDocument();
    expect(within(cpiCard).queryByLabelText(/Live 1-day chart/)).not.toBeInTheDocument();
  });

  test('removes the blank overview header and its manual refresh control', async () => {
    render(<Harness />);
    expect(await screen.findByText('Above 2.8%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh prediction markets overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All markets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Prediction Markets' })).not.toBeInTheDocument();
  });

  test('clears prior positions immediately when the selected account changes', async () => {
    let resolveSecond;
    MarketDataService.getPortfolioPredictionMarketPositions
      .mockResolvedValueOnce({
        status: 'live', meta: { source: 'ibkr_live' }, positions: [{ positionId: '1', symbol: 'KXCPI', description: 'Old account CPI', quantity: 1 }],
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { rerender } = render(
      <PredictionMarketsHub activeMarket="overview" onActiveMarketChange={jest.fn()} selectedAccount="U1" onClose={jest.fn()} />,
    );
    expect(await screen.findByText('Old account CPI')).toBeInTheDocument();

    rerender(<PredictionMarketsHub activeMarket="overview" onActiveMarketChange={jest.fn()} selectedAccount="U2" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Old account CPI')).not.toBeInTheDocument());
    expect(screen.getByText('Loading live IBKR positions...')).toBeInTheDocument();

    await act(async () => {
      resolveSecond({ status: 'live', meta: { source: 'ibkr_live' }, positions: [] });
    });
  });

  test('clears verified rows synchronously when the dashboard reports an IBKR disconnect', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      positions: [{ positionId: '1', symbol: 'KXCPI', description: 'Live CPI position', quantity: 1 }],
    });
    const baseProps = {
      activeMarket: 'overview',
      onActiveMarketChange: jest.fn(),
      selectedAccount: 'U1',
      onClose: jest.fn(),
    };
    const { rerender } = render(
      <PredictionMarketsHub {...baseProps} ibkrConnection={{ connected: true, title: 'IBKR live' }} />,
    );
    expect(await screen.findByText('Live CPI position')).toBeInTheDocument();

    rerender(
      <PredictionMarketsHub {...baseProps} ibkrConnection={{ connected: false, title: 'IB Gateway offline' }} />,
    );
    expect(screen.queryByText('Live CPI position')).not.toBeInTheDocument();
    expect(screen.getByText('IB Gateway offline')).toBeInTheDocument();
  });
});

describe('PredictionMarketsHub normalization', () => {
  test('classifies daily and weekly WTI before the shared prefix', () => {
    expect(classifyPredictionMarketPosition({ symbol: 'KXWTIW', description: 'KXWTIW-26JUL24-B84.50' })).toBe('wti-weekly');
    expect(classifyPredictionMarketPosition({ symbol: 'KXWTI', description: 'KXWTI-26JUL21-T83.99' })).toBe('wti-daily');
    expect(classifyPredictionMarketPosition({ marketFamily: 'wti', marketProduct: 'weekly', symbol: 'EVENT' })).toBe('wti-weekly');
    expect(classifyPredictionMarketPosition({ marketFamily: 'wti', marketProduct: 'daily', symbol: 'EVENT' })).toBe('wti-daily');
    expect(classifyPredictionMarketPosition({ symbol: 'KXUNKNOWN' })).toBe('other');
    expect(classifyPredictionMarketPosition({ marketFamily: 'WTI Weekly', symbol: 'EVENT' })).toBe('wti-weekly');
  });

  test('accepts partial verified-live payloads but rejects cache-only data', () => {
    expect(normalizeLivePositionsPayload({ status: 'partial', positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'partial', positions: [{ symbol: 'KXCPI' }],
    }));
    expect(normalizeLivePositionsPayload({ meta: { source: 'ibkr_live_partial', status: 'partial' }, positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'partial', positions: [{ symbol: 'KXCPI' }],
    }));
    expect(normalizeLivePositionsPayload({ status: 'live', meta: { source: 'cache' }, positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'unavailable', positions: [],
    }));
  });
});
