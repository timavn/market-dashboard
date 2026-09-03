import React from 'react';
import { render, screen, within } from '@testing-library/react';
import PredictionMarketSummaryCard, { buildMarketSummaries } from './PredictionMarketSummaryCard';
import { MarketDataService } from '../../services/api/marketDataService';

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getPredictionMarketPerformance: jest.fn(),
  },
}));

const rows = [
  {
    id: 'wti-settled-win',
    market: 'wti',
    contractLabel: 'WTI $82.00 NO',
    resolvedDate: '2026-08-13',
    risked: 310,
    pnl: 400.76,
    status: 'verified',
  },
  {
    id: 'wti-open',
    market: 'wti',
    contractLabel: 'WTI $81.99 NO',
    openedAt: '2026-08-14T12:00:00Z',
    risked: 519.04,
    currentValue: 887.04,
    pnl: 368,
    status: 'open',
    markState: 'official_reference',
  },
  {
    id: 'gold-open',
    market: 'gold',
    contractLabel: 'Gold $3,412.0 NO',
    openedAt: '2026-08-14T12:00:00Z',
    risked: 220,
    pnl: 189.9,
    status: 'open',
  },
  {
    id: 'sp500-loss',
    market: 'sp500',
    contractLabel: 'SP500 6,450 YES',
    resolvedDate: '2026-08-13',
    risked: 88,
    pnl: -88,
    status: 'verified',
  },
  {
    id: 'sp500-fes-open',
    market: 'sp500',
    contractLabel: 'SP500 7,800 NO',
    contractKey: 'FES_081426_7800_NO',
    eventTicker: 'FES_081426_7800',
    contractSide: 'NO',
    strike: 7800,
    openedAt: '2026-08-14T12:00:00Z',
    risked: 210,
    currentValue: null,
    pnl: null,
    status: 'awaiting_resolution',
    displayState: 'AWAITING_RESULT',
    markState: 'unavailable',
  },
  {
    id: 'eth-unmarked',
    market: 'ethereum',
    contractLabel: 'ETH $4,220–4,239.99 NO',
    openedAt: '2026-08-14T12:00:00Z',
    risked: 64,
    currentValue: null,
    pnl: null,
    status: 'open',
    markState: 'unavailable',
  },
  {
    id: 'gold-ticker',
    market: 'other',
    contractLabel: 'METLG_081426_3412_NO',
    contractKey: 'METLG_081426_3412_NO',
    resolvedDate: '2026-08-13',
    risked: 100,
    pnl: 50,
    status: 'verified',
  },
];

describe('PredictionMarketSummaryCard', () => {
  afterEach(() => jest.restoreAllMocks());

  test('buildMarketSummaries groups ledger rows without inventing unmarked P&L', () => {
    const cards = buildMarketSummaries(rows);
    const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
    expect(cards.map((card) => card.key)).toEqual(['wti', 'gold', 'sp500', 'nasdaq100', 'bitcoin', 'ethereum', 'cpi']);
    expect(byKey.wti).toMatchObject({
      settledCount: 1,
      openCount: 1,
      realizedPnl: 400.76,
      totalPnl: 768.76,
      biggestWin: 400.76,
      hitLabel: '1/1',
      period: 'Aug 13 – Aug 14',
    });
    expect(byKey.gold).toMatchObject({
      settledCount: 1,
      openCount: 1,
      realizedPnl: 50,
      biggestWin: 50,
    });
    expect(byKey.gold.totalPnl).toBeCloseTo(239.9);
    expect(byKey.sp500).toMatchObject({
      settledCount: 1,
      openCount: 0,
      awaitingCount: 1,
      realizedPnl: -88,
      biggestLoss: -88,
      hitLabel: '0/1',
    });
    expect(byKey.ethereum.totalPnl).toBeNull();
    expect(byKey.ethereum.openPnl).toBeNull();
    expect(byKey.ethereum.realizedPnl).toBeNull();
  });

  test('renders per-market glance stats from live ledger rows', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      rows,
      tracker: { status: 'ready', health: 'capturing' },
    });
    render(<PredictionMarketSummaryCard accountId="U123" />);

    const wti = await screen.findByRole('article', { name: 'WTI overview' });
    expect(within(wti).getByText('WTI')).toBeTruthy();
    expect(within(wti).getByText(/1 settled · 1 open/)).toBeTruthy();
    expect(within(wti).getByRole('heading', { name: 'Performance' })).toBeTruthy();
    expect(within(wti).getByRole('heading', { name: 'Record' })).toBeTruthy();
    expect(within(wti).getByRole('heading', { name: 'Unsettled position' })).toBeTruthy();
    expect(within(wti).getAllByText('+$400.76').length).toBeGreaterThan(0);
    expect(within(wti).getByText('+$768.76')).toBeTruthy();
    expect(within(wti).getByText('1/1')).toBeTruthy();

    const gold = screen.getByRole('article', { name: 'Gold overview' });
    expect(within(gold).getByText('Gold')).toBeTruthy();
    expect(within(gold).getAllByText('+$50.00').length).toBeGreaterThan(0);

    const sp500 = screen.getByRole('article', { name: 'SP500 overview' });
    expect(within(sp500).getAllByText('-$88.00').length).toBeGreaterThan(0);
    expect(within(sp500).getByText('0/1')).toBeTruthy();
    expect(within(sp500).getByText(/1 settled · 1 awaiting/)).toBeTruthy();
    expect(within(sp500).getByText('$210.00')).toBeTruthy();
    expect(screen.queryByText(/FES_081426/)).toBeNull();

    const eth = screen.getByRole('article', { name: 'ETH overview' });
    expect(within(eth).getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByRole('article', { name: 'NQ overview' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'BTC overview' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'CPI overview' })).toBeTruthy();
    expect(screen.getAllByText('No tracked contracts')).toHaveLength(3);
  });

  test('shows an explicit no-live-data state when the ledger is unavailable', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockRejectedValue({
      response: { data: { tracker: { message: 'IBKR is disconnected.' } } },
    });
    render(<PredictionMarketSummaryCard accountId="U123" />);
    expect(await screen.findByText('P&L unavailable')).toBeTruthy();
    expect(screen.getByText('IBKR is disconnected.')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  test('shows a quiet empty state when the account has no tracked contracts', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      rows: [],
      tracker: { status: 'empty', health: 'capturing' },
    });
    render(<PredictionMarketSummaryCard accountId="U123" />);
    expect(await screen.findByText('No tracked contracts yet.')).toBeTruthy();
  });
});
