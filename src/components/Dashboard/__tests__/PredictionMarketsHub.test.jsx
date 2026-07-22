import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PredictionMarketsHub, {
  classifyPredictionMarketPosition,
  normalizeLivePositionsPayload,
} from '../PredictionMarketsHub';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';

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
  signal: { name: 'Risk Range', status: 'available' },
  ...overrides,
});

const OVERVIEW = {
  ok: true,
  fetchedAt: '2026-07-21T20:00:00.000Z',
  markets: {
    cpi: { status: 'available', summary: summary({ seriesTicker: 'KXCPI', eventTitle: 'July CPI' }) },
    spx: { status: 'available', summary: summary({ seriesTicker: 'KXINXU', eventTitle: 'S&P 500 close' }) },
    wti: {
      daily: { status: 'available', summary: summary({ seriesTicker: 'KXWTI', marketTicker: 'KXWTI-DAILY-T84' }) },
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

  test('opens on the factual Overview and mounts only the selected workbench', async () => {
    render(<Harness />);

    const overview = await screen.findByTestId('prediction-markets-overview');
    expect(await within(overview).findByText('July CPI')).toBeInTheDocument();
    expect(within(overview).getByText('S&P 500 close')).toBeInTheDocument();
    expect(within(overview).getByText('KXWTI-DAILY-T84')).toBeInTheDocument();
    expect(within(overview).getByText('No current weekly event.')).toBeInTheDocument();
    expect(within(overview).getAllByText('42¢ / 45¢').length).toBeGreaterThan(0);
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('SPX Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Prediction market view' })).getByRole('button', { name: 'SPX' }));
    expect(await screen.findByText('SPX Workbench')).toBeInTheDocument();
    expect(screen.queryByTestId('prediction-markets-overview')).not.toBeInTheDocument();
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();
    expect(mockSpxWorkbench).toHaveBeenLastCalledWith(expect.objectContaining({
      embedded: true,
      sharedPositionsState: expect.objectContaining({ status: 'live' }),
    }));
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
    expect(screen.getByRole('navigation', { name: 'Prediction market view' })).toBeInTheDocument();
  });

  test('localizes a stale market summary without suppressing the other markets', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: { status: 'available', summary: summary({ eventTitle: 'Stale CPI', freshness: { status: 'stale' } }) },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(within(cpiCard).getByText('No verified current market is available.')).toBeInTheDocument();
    expect(screen.queryByText('Stale CPI')).not.toBeInTheDocument();
    expect(await screen.findByText('S&P 500 close')).toBeInTheDocument();
  });

  test('keeps the last verified summaries visible during refresh and clears them on refresh failure', async () => {
    let rejectRefresh;
    predictionMarketsIngestService.getPredictionMarketsOverview
      .mockResolvedValueOnce(OVERVIEW)
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectRefresh = reject; }));

    render(<Harness />);
    expect(await screen.findByText('July CPI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh prediction markets overview' }));
    expect(screen.getByText('July CPI')).toBeInTheDocument();

    await act(async () => rejectRefresh(new Error('Refresh failed')));
    expect(await screen.findByText(/Market summaries are unavailable: Refresh failed/)).toBeInTheDocument();
    expect(screen.queryByText('July CPI')).not.toBeInTheDocument();
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
