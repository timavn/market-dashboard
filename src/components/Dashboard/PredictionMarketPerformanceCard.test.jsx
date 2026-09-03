import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PredictionMarketPerformanceCard from './PredictionMarketPerformanceCard';
import { MarketDataService } from '../../services/api/marketDataService';

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getPredictionMarketPerformance: jest.fn(),
    getPredictionMarketPerformanceExecutions: jest.fn(),
    getPredictionMarketSp500Research: jest.fn(),
  },
}));

const ready = {
  rows: [{
    id: 'lifecycle-1',
    openedAt: '2026-08-13T15:00:00Z',
    resolvedDate: '2026-08-13',
    market: 'wti',
    contractLabel: 'WTI $81.49 YES',
    settlementDate: '2026-08-14',
    settlementValue: 81.25,
    quantity: 10,
    entryQuantity: 10,
    remainingQuantity: 0,
    risked: 4.5,
    paid: 10,
    currentValue: 10,
    pnl: 5.5,
    roi: 5.5 / 4.5,
    resolutionType: 'expiry',
    verification: 'verified_settlement',
    status: 'verified',
    displayState: 'SETTLED',
    outcome: 'NO',
    payoutPerContract: 1,
  }],
  activeRows: [],
  review: [],
  summary: {
    count: 1,
    openCount: 0,
    openPnl: 0,
    realizedCount: 1,
    realizedPnl: 5.5,
    risked: 4.5,
    paid: 10,
    pnl: 5.5,
    roi: 5.5 / 4.5,
  },
  tracker: { status: 'ready', health: 'capturing' },
};

const quarantinedReady = {
  ...ready,
  rows: [
    ...ready.rows,
    {
      ...ready.rows[0],
      id: 'review-1',
      contractLabel: 'WTI $82 NO',
      contractSide: 'NO',
      strike: 82,
      status: 'review',
      displayState: 'CHECK',
    },
  ],
  review: [{
    id: 'review-1',
    recordKey: 'lifecycle#1#1',
    market: 'wti',
    contractLabel: 'WTI $82 NO',
    reason: 'unsupported_contract_identity',
    version: 4,
    fields: {
      market: 'wti',
      contractLabel: 'WTI $82 NO',
      contractSide: 'NO',
      strike: 82,
      quantity: 10,
      entryPrincipal: 4.8,
      fees: 0.2,
      paid: 10,
      resolvedDate: '2026-08-13',
      resolutionType: 'expiry',
    },
  }],
};

describe('PredictionMarketPerformanceCard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  test('loads selected-account results, filters by market, and sorts by a table column', async () => {
    const load = jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(ready);
    render(<PredictionMarketPerformanceCard accountId="U123" />);

    const marketTabs = screen.getByRole('group', { name: 'Market filters' });
    const viewTabs = screen.getByRole('group', { name: 'P&L views' });
    expect(screen.queryByRole('tablist', { name: 'Contract P&L account' })).toBeNull();
    expect(within(marketTabs).getAllByRole('tab').slice(0, 4).map((tab) => tab.textContent)).toEqual(['All', 'WTI', 'Gold', 'SP500']);
    expect(within(viewTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Research', 'Open']);

    expect(await screen.findByText('81.49')).toBeTruthy();
    const initialRow = screen.getByRole('row', { name: /WTI 81\.49 YES/ });
    expect(within(initialRow).getByText('YES')).toBeTruthy();
    expect(within(initialRow).queryByText('WTI')).toBeNull();
    expect(within(initialRow).getByText('81.49').className).toBe('pm-performance-strike');
    expect(within(initialRow).getByText('YES').getAttribute('data-side')).toBe('yes');
    expect(within(initialRow).getByTitle('Above strike')).toBeTruthy();
    expect(within(initialRow).getByText('Aug 14')).toBeTruthy();
    expect(within(initialRow).getByText('Date only')).toBeTruthy();
    expect(within(initialRow).getByText('$81.25')).toBeTruthy();
    expect(within(initialRow).getAllByRole('cell').map((cell) => cell.getAttribute('data-label'))).toEqual([
      'Status', 'Contract', 'Qty', 'Reference', 'Resolves', 'Cost', 'Value', 'P&L', 'Return',
    ]);
    expect(within(initialRow).getByRole('cell', { name: '10' }).getAttribute('data-label')).toBe('Qty');
    expect(within(initialRow).queryByText(/bought|left/i)).toBeNull();
    expect(within(initialRow).queryByText(/won|pays|mark/i)).toBeNull();
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ account: 'U123', scope: 'account', venue: 'all', market: 'all', sort: 'status', direction: 'asc' }));
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('data-market')).toBe('overview');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('article', { name: 'WTI overview' })).toBeTruthy();
    fireEvent.click(within(marketTabs).getByRole('tab', { name: 'All' }));
    expect(screen.getByRole('tab', { name: 'Gold' }).getAttribute('data-market')).toBe('gold');
    expect(screen.getByRole('tab', { name: 'NQ' }).getAttribute('data-market')).toBe('nasdaq100');
    expect(screen.getByRole('tab', { name: 'BTC' }).getAttribute('data-market')).toBe('bitcoin');
    expect(screen.getByRole('tab', { name: 'ETH' }).getAttribute('data-market')).toBe('ethereum');
    expect(screen.queryByText('Prediction performance')).toBeNull();
    expect(screen.queryByText(/Open marks \+ settled results/i)).toBeNull();
    expect(screen.queryByText(/Sorted by/i)).toBeNull();
    expect(screen.queryByText(/AUTOMATIC P&L/i)).toBeNull();
    expect(screen.getByText('Thu, Aug 13')).toBeTruthy();

    const callsBeforeTabSwitch = load.mock.calls.length;
    fireEvent.click(screen.getByRole('tab', { name: 'WTI' }));
    expect(screen.getByRole('row', { name: /WTI 81\.49 YES/ })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(callsBeforeTabSwitch);

    fireEvent.click(screen.getByRole('tab', { name: 'Gold' }));
    expect(screen.queryByRole('row', { name: /WTI 81\.49 YES/ })).toBeNull();
    expect(load).toHaveBeenCalledTimes(callsBeforeTabSwitch);

    fireEvent.click(within(marketTabs).getByRole('tab', { name: 'All' }));
    fireEvent.click(within(screen.getByRole('columnheader', { name: /P&L/i })).getByRole('button'));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ market: 'all', sort: 'pnl', direction: 'desc' })));
    expect(screen.getAllByText('+$5.50').length).toBeGreaterThan(0);
  });

  test('uses the selected market summary for an empty-tab message', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      tracker: { ...ready.tracker, awaitingSettlementCount: 1 },
      summaries: {
        all: ready.summary,
        ethereum: {
          count: 0,
          openCount: 0,
          awaitingCount: 0,
          realizedCount: 0,
          openPnl: 0,
          awaitingPnl: 0,
          realizedPnl: 0,
          pnl: 0,
        },
      },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);

    await screen.findByText('81.49');
    fireEvent.click(screen.getByRole('tab', { name: 'ETH' }));

    expect(screen.getByText('No verified contract P&L is available for this selection.')).toBeTruthy();
    expect(screen.queryByText(/Waiting for final settlement/i)).toBeNull();
  });

  test('shows the exact ForecastEx event identity instead of research-match metadata', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        ...ready.rows[0],
        id: 'fes-legacy', market: 'sp500', exchange: 'FORECASTX',
        contractLabel: 'SP500 6,400 YES', contractSide: 'YES', strike: 6400,
        contractKey: 'FES_081326_6400_YES', eventTicker: 'FES_081326_6400',
        fesResearchContextStatus: 'legacy_unmatched',
      }],
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    const row = await screen.findByRole('row', { name: /SP500 6,400 YES/i });
    expect(within(row).getByText('FES')).toBeTruthy();
    expect(within(row).queryByText(/FES · Aug 13/i)).toBeNull();
    expect(within(row).getByRole('cell', { name: /6,400 YES/i }).getAttribute('title'))
      .toContain('FES_081326_6400_YES');
    expect(within(row).queryByText('Legacy / unmatched')).toBeNull();
  });

  test('exposes every sortable column and refetches for an exact account change', async () => {
    const load = jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(ready);
    const { rerender } = render(<PredictionMarketPerformanceCard accountId="U123" />);
    expect(await screen.findByText('81.49')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /WTI 81\.49 YES/ })).getByText('YES')).toBeTruthy();
    expect(screen.queryByLabelText('Sort performance results')).toBeNull();

    expect(within(screen.getByRole('columnheader', { name: 'Qty' })).queryByRole('button')).toBeNull();
    for (const column of ['Date', 'Status', 'Contract', 'Reference', 'Resolves', 'Cost', 'Value', 'P&L', 'Return']) {
      const header = screen.getByRole('columnheader', { name: new RegExp(column.replace('&', '\\&')) });
      fireEvent.click(within(header).getByRole('button'));
      await waitFor(() => expect(header.getAttribute('aria-sort')).not.toBe('none'));
    }

    rerender(<PredictionMarketPerformanceCard accountId="U456" />);
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ account: 'U456', scope: 'account' })));
    expect(screen.queryByRole('tablist', { name: 'Contract P&L account' })).toBeNull();
  });

  test('uses compact anchored scope menus and keeps the venue trigger label stable', async () => {
    const load = jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      accounts: [{ accountId: 'U123' }, { accountId: 'U456' }],
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);

    await screen.findByText('81.49');
    const venueTrigger = screen.getByRole('combobox', { name: 'Venue' });
    expect(venueTrigger.textContent).toContain('Venue');
    expect(venueTrigger.textContent).not.toContain('All venues');

    fireEvent.click(venueTrigger);
    const menu = screen.getByRole('listbox', { name: 'Venue options' });
    expect(within(menu).getByRole('option', { name: 'All venues' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(menu).getByRole('option', { name: 'ForecastEx' }));

    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ venue: 'forecastex' })));
    expect(screen.queryByRole('listbox', { name: 'Venue options' })).toBeNull();
    expect(venueTrigger.textContent).toContain('Venue');
  });

  test('ignores the retired P&L account preference and uses the exact dashboard account', async () => {
    const load = jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(ready);
    window.localStorage.setItem('predictionMarketPnlAccount', 'U25465536');
    render(<PredictionMarketPerformanceCard accountId="U25779973" />);
    await screen.findByText('81.49');
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      account: 'U25779973',
      scope: 'account',
    }));
    expect(screen.queryByRole('tablist', { name: 'Contract P&L account' })).toBeNull();
    expect(screen.queryByText('Roth IRA')).toBeNull();
  });

  test('clears old rows immediately while an exact account change is loading', async () => {
    let resolveNextAccount;
    const nextAccountPending = new Promise((resolve) => { resolveNextAccount = resolve; });
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockImplementation(({ account }) => (
      account === 'U456' ? nextAccountPending : Promise.resolve(ready)
    ));
    const { rerender } = render(<PredictionMarketPerformanceCard accountId="U123" />);
    await screen.findByText('81.49');

    rerender(<PredictionMarketPerformanceCard accountId="U456" />);

    expect(screen.queryByText('81.49')).toBeNull();
    expect(screen.getByText('Loading contract P&L…')).toBeTruthy();
    resolveNextAccount({ ...ready, rows: [] });
  });

  test('loads execution details for the exact Individual account without account badges', async () => {
    const individual = {
      ...ready,
      rows: [{ ...ready.rows[0], accountId: 'U25779973', id: 'same-lifecycle' }],
    };
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(individual);
    MarketDataService.getPredictionMarketPerformanceExecutions.mockResolvedValue({
      entryQuantity: 10,
      exitedQuantity: 0,
      remainingQuantity: 0,
      netExitProceeds: 0,
      exitFees: 0,
      economicEntries: [],
      cashOuts: [],
    });
    render(<PredictionMarketPerformanceCard accountId="U25779973" />);

    const row = await screen.findByRole('row', { name: /WTI 81\.49 YES/ });
    expect(within(row).queryByText('Individual')).toBeNull();
    expect(within(row).queryByText('Roth IRA')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /Expand/i }));
    await waitFor(() => expect(MarketDataService.getPredictionMarketPerformanceExecutions).toHaveBeenCalledTimes(1));
    expect(MarketDataService.getPredictionMarketPerformanceExecutions).toHaveBeenCalledWith('same-lifecycle', { account: 'U25779973' });
  });

  test('requires the Individual account for Research and withholds incomplete current totals', async () => {
    const historyOnly = {
      ...ready,
      tracker: { ...ready.tracker, currentDataComplete: false, status: 'history_only' },
      summary: { ...ready.summary, paid: null, pnl: null, roi: null, openPnl: null },
      consolidation: { complete: false, historyComplete: true, currentComplete: false },
    };
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(historyOnly);
    MarketDataService.getPredictionMarketSp500Research.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<PredictionMarketPerformanceCard accountId="U25779973" />);
    await screen.findByText('81.49');

    expect(screen.getByText('Current totals withheld')).toBeTruthy();
    expect(screen.queryByText(/Roth/i)).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'P&L views' })).getByRole('tab', { name: 'Research' }));
    await waitFor(() => expect(MarketDataService.getPredictionMarketSp500Research).toHaveBeenCalledWith({
      account: 'U25779973',
      window: 'all',
    }));
    rerender(<PredictionMarketPerformanceCard accountId="" />);
    expect(await screen.findByText('The Individual IBKR account is unavailable.')).toBeTruthy();
  });

  test('never exposes quarantined broker evidence as a row or manual review action', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue(quarantinedReady);
    render(<PredictionMarketPerformanceCard accountId="U123" />);

    expect(await screen.findByRole('row', { name: /WTI 81\.49 YES/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /WTI 82 NO/ })).toBeNull();
    expect(screen.queryByText('CHECK')).toBeNull();
    expect(screen.queryByText(/NEEDS REVIEW/i)).toBeNull();
  });

  test('keeps a closed market awaiting its result instead of calling the position closed', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'open-1',
        openedAt: '2026-08-12T16:00:00Z',
        market: 'wti',
        contractLabel: 'WTI $81.49 NO',
        contractSide: 'NO',
        quantity: 999.73,
        risked: 219.27,
        paid: 0,
        currentValue: 989.73,
        pnl: 770.46,
        roi: 770.46 / 219.27,
        status: 'awaiting_resolution',
        displayState: 'AWAITING_RESULT',
        markPrice: 0.99,
        markState: 'closing_trade',
        markSource: 'kalshi_direct_closing_trade',
        markObservedAt: '2026-08-13T18:29:42Z',
      }],
      activeRows: [],
      summary: {
        count: 1,
        openCount: 0,
        openPnl: 0,
        awaitingCount: 1,
        awaitingPnl: 770.46,
        realizedCount: 0,
        realizedPnl: 0,
        risked: 219.27,
        paid: 989.73,
        pnl: 770.46,
        roi: 770.46 / 219.27,
      },
      tracker: { status: 'ready', health: 'capturing', openCount: 3, awaitingSettlementCount: 0, trackingCount: 3 },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    expect(await screen.findByText('81.49')).toBeTruthy();
    expect(screen.getByText('AWAITING RESULT')).toBeTruthy();
    expect(screen.queryByText(/Closing mark/i)).toBeNull();
    expect(screen.getByText('1 CONTRACTS')).toBeTruthy();
    expect(screen.getAllByText('+$770.46').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /CSV/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /IMPORT HISTORY/i })).toBeNull();
    expect(screen.queryByText('Today')).toBeNull();
    expect(screen.getByText(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/)).toBeTruthy();
    expect(screen.getByRole('row', { name: /WTI 81\.49 NO/ }).getAttribute('data-market')).toBe('wti');
    expect(within(screen.getByRole('row', { name: /WTI 81\.49 NO/ })).getByText('NO').getAttribute('data-side')).toBe('no');
    expect(within(screen.getByRole('row', { name: /WTI 81\.49 NO/ })).getByTitle('Above strike')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /WTI 81\.49 NO/ })).queryByText('WTI')).toBeNull();
  });

  test('uses the threshold rule for the arrow independently of the held YES or NO side', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'below-rule',
        market: 'wti',
        contractLabel: 'WTI $82.00 NO',
        contractSide: 'NO',
        contractRule: 'below',
        status: 'open',
        currentValue: null,
        pnl: null,
        roi: null,
        risked: 4.8,
      }],
      summary: { count: 1, openCount: 1, openPnl: null, realizedCount: 0, realizedPnl: 0, pnl: null, roi: null },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    const row = await screen.findByRole('row', { name: /WTI 82\.00 NO/ });
    expect(within(row).getByTitle('Below strike')).toBeTruthy();
  });

  test('keeps an unmarked contract visible without inventing current P&L', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'open-unmarked',
        market: 'wti',
        contractLabel: 'WTI $82.00 NO',
        quantity: 10,
        risked: 4.8,
        paid: 0,
        currentValue: null,
        pnl: null,
        roi: null,
        status: 'open',
        markState: 'unavailable',
      }],
      summary: {
        count: 1,
        openCount: 1,
        openPnl: null,
        realizedCount: 0,
        realizedPnl: 0,
        pnl: null,
        roi: null,
      },
      tracker: { status: 'ready', health: 'capturing', openCount: 1 },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    await screen.findByText('82.00');
    expect(screen.queryByText(/Contract mark/i)).toBeNull();
    expect(within(screen.getByRole('row', { name: /WTI 82\.00 NO/ })).getAllByText('—')).toHaveLength(5);
    const totalRow = screen.getByRole('row', { name: / totals$/i });
    expect(within(totalRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '$4.80', '—', '—', '—',
    ]);
  });

  test('shows the full PT resolution time, a CT tooltip, and the resolver symbol', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'gold-awaiting',
        market: 'gold',
        exchange: 'FORECASTX',
        contractLabel: 'Gold $4,400 YES',
        contractSide: 'YES',
        quantity: 2000,
        risked: 478,
        currentValue: 40,
        pnl: -438,
        roi: -438 / 478,
        status: 'awaiting_resolution',
        displayState: 'AWAITING_RESULT',
        markPrice: 0.02,
        markState: 'official_reference',
        markSource: 'forecastex_official_price',
        markObservedAt: '2026-08-14T18:00:00Z',
        markDataDate: '2026-08-14',
        contractKey: 'METLG_081426_4400_YES',
        eventTicker: 'METLG_081426_4400',
        lastTradeAt: '2026-08-14T17:30:00Z',
        resolutionAt: '2026-08-15T04:55:00Z',
        payoutAt: '2026-08-15T06:55:00Z',
        settlementSymbol: 'GCQ26',
      }],
      summary: {
        count: 1, openCount: 0, openPnl: 0, awaitingCount: 1, awaitingPnl: -438,
        realizedCount: 0, realizedPnl: 0, pnl: -438,
      },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    const row = await screen.findByRole('row', { name: /Gold 4,400 YES/ });
    expect(within(row).getByText('AWAITING RESULT')).toBeTruthy();
    expect(within(row).getByText('Prelim 2¢')).toBeTruthy();
    expect(within(row).getByText('2¢ prelim')).toBeTruthy();
    expect(within(row).queryByText(/Closing mark/i)).toBeNull();
    expect(within(row).getByText('Aug 14')).toBeTruthy();
    expect(within(row).getByText('9:55 PM PT')).toBeTruthy();
    expect(within(row).queryByText(/Expected payout/i)).toBeNull();
    expect(within(row).getByText('GCQ26')).toBeTruthy();
    expect(within(row).queryByText(/— awaiting/i)).toBeNull();
    expect(within(row).queryByText(/Awaiting official settlement/i)).toBeNull();
    const resolves = within(row).getByRole('cell', { name: /Aug 14\s+9:55 PM PT/ });
    expect(resolves.getAttribute('title')).toContain('Last trade: Aug 14, 10:30 AM PT (Aug 14, 12:30 PM CT)');
    expect(resolves.getAttribute('title')).toContain('Resolves: Aug 14, 9:55 PM PT (Aug 14, 11:55 PM CT)');
    expect(resolves.getAttribute('title')).not.toContain('Expected payout');
    expect(screen.getByText('AWAITING MTM')).toBeTruthy();
    expect(screen.getByText('MTM TOTAL')).toBeTruthy();
    expect(within(row).getByRole('cell', { name: '-$438.00' }).getAttribute('title'))
      .toContain('Preliminary mark-to-market from the official ForecastEx 2¢ contract price');
  });

  test('labels a Kalshi settlement timestamp as settled rather than a broker payout time', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        ...ready.rows[0],
        exchange: 'KALSHI',
        resolutionAt: '2026-08-13T18:30:00Z',
        payoutAt: '2026-08-14T15:01:14.410Z',
        outcomeObservedAt: '2026-08-14T15:01:14.410Z',
      }],
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    const row = await screen.findByRole('row', { name: /WTI 81\.49 YES/ });
    expect(within(row).getByText('Aug 13')).toBeTruthy();
    expect(within(row).getByText('11:30 AM PT')).toBeTruthy();
    expect(within(row).queryByText(/Settled Aug 14/i)).toBeNull();
    expect(within(row).getByRole('cell', { name: /Aug 13\s+11:30 AM PT/ }).getAttribute('title')).toContain('Settled: Aug 14, 8:01 AM PT');
    expect(within(row).queryByText(/Pays/i)).toBeNull();
  });

  test('keeps open and settled contracts grouped under their original opened dates', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [
        {
          id: 'open-cpi',
          openedAt: '2026-07-07T16:00:00Z',
          expiration: '2026-08-13',
          market: 'cpi',
          contractLabel: 'CPI 3.4% NO',
          risked: 220,
          currentValue: 410,
          pnl: 190,
          roi: 190 / 220,
          status: 'open',
          displayState: 'OPEN',
          markState: 'official_reference',
        },
        {
          ...ready.rows[0],
          openedAt: '2026-08-12T16:00:00Z',
          resolvedDate: '2026-08-13',
        },
      ],
      summary: {
        count: 2,
        openCount: 1,
        openPnl: 190,
        realizedCount: 1,
        realizedPnl: 5.5,
        pnl: 195.5,
        roi: null,
      },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    const openRow = await screen.findByRole('row', { name: /CPI 3\.4% NO/ });
    const settledRow = screen.getByRole('row', { name: /WTI 81\.49 YES/ });
    expect(openRow.getAttribute('data-day')).toBe('2026-07-07');
    expect(settledRow.getAttribute('data-day')).toBe('2026-08-12');
    expect(screen.getByText('Tue, Jul 7')).toBeTruthy();
    expect(screen.getByText('Wed, Aug 12')).toBeTruthy();
  });

  test('shows only current open contracts from the right-side Open tab', async () => {
    const load = jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [
        {
          id: 'open-cpi',
          openedAt: '2026-07-07T16:00:00Z',
          market: 'cpi',
          contractLabel: 'CPI 3.4% NO',
          contractSide: 'NO',
          strike: 3.4,
          risked: 220,
          currentValue: 410,
          pnl: 190,
          roi: 190 / 220,
          status: 'open',
          displayState: 'OPEN',
          markState: 'official_reference',
        },
        {
          id: 'awaiting-gold',
          openedAt: '2026-08-11T16:00:00Z',
          market: 'gold',
          contractLabel: 'Gold $4,400 YES',
          contractSide: 'YES',
          strike: 4400,
          risked: 100,
          currentValue: null,
          pnl: null,
          roi: null,
          status: 'awaiting_resolution',
          displayState: 'AWAITING_RESULT',
        },
        ready.rows[0],
      ],
      summary: {
        count: 3,
        openCount: 1,
        openPnl: 190,
        awaitingCount: 1,
        awaitingPnl: null,
        realizedCount: 1,
        realizedPnl: 5.5,
        pnl: null,
        roi: null,
      },
      tracker: { status: 'ready', health: 'capturing', openCount: 1, awaitingSettlementCount: 1 },
    });

    render(<PredictionMarketPerformanceCard accountId="U123" />);
    await screen.findByRole('row', { name: /CPI 3\.4% NO/ });
    fireEvent.click(screen.getByRole('tab', { name: 'Open' }));

    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ market: 'all' })));
    expect(screen.getByRole('tab', { name: 'Open' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('group', { name: 'P&L views' })).getByRole('tab', { name: 'Open' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /CPI 3\.4% NO/ }).getAttribute('data-day')).toBe('2026-07-07');
    expect(screen.queryByRole('row', { name: /Gold 4,400 YES/ })).toBeNull();
    expect(screen.queryByRole('row', { name: /WTI 81\.49 YES/ })).toBeNull();
    expect(screen.getByText('1 CONTRACTS')).toBeTruthy();
  });

  test('summarizes cost, value, P&L, and aggregate ROI at the bottom of every day', async () => {
    const dailyRows = [
      { id: 'daily-1', risked: 219.27, currentValue: 999.73, pnl: 780.46, contractLabel: 'WTI $81.49 NO' },
      { id: 'daily-2', risked: 598.86, currentValue: 999.62, pnl: 400.76, contractLabel: 'WTI $81.99 NO' },
      { id: 'daily-3', risked: 478, currentValue: 0, pnl: -478, contractLabel: 'Gold $4,400 YES' },
      { id: 'daily-4', risked: 64, currentValue: 0, pnl: -64, contractLabel: 'Gold $4,425 YES' },
    ].map((row) => ({
      ...ready.rows[0],
      ...row,
      openedAt: '2026-08-14T15:00:00Z',
      resolvedDate: '2026-08-14',
      roi: row.pnl / row.risked,
      status: 'verified',
    }));
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [
        ...dailyRows,
        {
          ...ready.rows[0],
          id: 'prior-day',
          openedAt: '2026-08-13T15:00:00Z',
          resolvedDate: '2026-08-13',
          risked: 519.04,
          currentValue: 1056,
          pnl: 536.96,
          roi: 536.96 / 519.04,
        },
      ],
    });

    render(<PredictionMarketPerformanceCard accountId="U123" />);

    const fridayTotal = await screen.findByRole('row', { name: 'Fri, Aug 14 totals' });
    const fridayCard = screen.getByRole('rowgroup', { name: 'Fri, Aug 14 contracts' });
    expect(fridayCard.className).toContain('pm-performance-day-card');
    expect(fridayCard.dataset.day).toBe('2026-08-14');
    expect(within(fridayTotal).getByRole('rowheader', { name: 'Day total' })).toBeTruthy();
    expect(within(fridayTotal).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '$1,360.13', '$1,999.35', '+$639.22', '+47.0%',
    ]);
    expect(within(screen.getByRole('row', { name: 'Thu, Aug 13 totals' })).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '$519.04', '$1,056.00', '+$536.96', '+103.5%',
    ]);
    expect(screen.getAllByText('Day total')).toHaveLength(2);
  });

  test('fits the table to the card, exposes keyboard scrolling, and labels incomplete basis evidence', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [
        {
          ...ready.rows[0],
          id: 'july-incomplete',
          openedAt: '2026-07-14T15:00:00Z',
          resolvedDate: '2026-07-14',
          market: 'cpi',
          contractLabel: 'CPI 3.8% YES',
          contractSide: 'YES',
          strike: 3.8,
          risked: null,
          paid: 0,
          currentValue: 0,
          pnl: null,
          roi: null,
          performanceComplete: false,
        },
        {
          ...ready.rows[0],
          id: 'july-complete',
          openedAt: '2026-07-14T16:00:00Z',
          resolvedDate: '2026-07-14',
          market: 'cpi',
          contractLabel: 'CPI 4.0% NO',
          contractSide: 'NO',
          strike: 4,
          risked: 10,
          paid: 10,
          currentValue: 10,
          pnl: 0,
          roi: 0,
          performanceComplete: true,
        },
      ],
    });

    render(<PredictionMarketPerformanceCard accountId="U123" />);

    const tableRegion = await screen.findByRole('region', { name: 'Contract P&L table' });
    expect(tableRegion.getAttribute('tabindex')).toBe('0');
    expect(within(tableRegion).getAllByRole('columnheader').filter((header) => header.hasAttribute('aria-sort')))
      .toHaveLength(9);

    const incompleteRow = screen.getByRole('row', { name: /CPI 3\.8% YES/ });
    const cells = within(incompleteRow).getAllByRole('cell');
    expect(cells.find((cell) => cell.dataset.label === 'Cost').textContent).toBe('History unavailable');
    expect(cells.find((cell) => cell.dataset.label === 'Value').textContent).toBe('$0.00');
    expect(cells.find((cell) => cell.dataset.label === 'P&L').textContent).toBe('Unavailable');
    expect(cells.find((cell) => cell.dataset.label === 'Return').textContent).toBe('Unavailable');

    const julyTotal = screen.getByRole('row', { name: 'Tue, Jul 14 totals' });
    expect(within(julyTotal).getByRole('rowheader', { name: 'Day total' }).textContent)
      .toContain('1 basis gap');
    expect(within(julyTotal).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'Incomplete', '$10.00', 'Incomplete', 'Incomplete',
    ]);
  });

  test('labels missing awaiting-result metrics as pending without inventing final P&L', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'fes-aug21-pending',
        market: 'sp500',
        exchange: 'FORECASTX',
        contractLabel: 'SP500 7,725 YES',
        contractKey: 'FES_082126_7725_YES',
        contractSide: 'YES',
        strike: 7725,
        quantity: 5000,
        risked: 350,
        paid: 0,
        currentValue: null,
        pnl: null,
        roi: null,
        status: 'awaiting_resolution',
        displayState: 'AWAITING_RESULT',
        settlementSymbol: 'ESU26',
        resolutionAt: '2026-08-24T15:00:00Z',
        resolverAvailability: 'awaiting_official_settlement',
      }],
      summary: {
        count: 1, openCount: 0, openPnl: 0, awaitingCount: 1, awaitingPnl: null,
        realizedCount: 0, realizedPnl: 0, pnl: null, roi: null,
      },
    });

    render(<PredictionMarketPerformanceCard accountId="U123" />);

    const row = await screen.findByRole('row', { name: /SP500 7,725 YES/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.find((cell) => cell.dataset.label === 'Reference').textContent).toBe('Pending');
    expect(cells.find((cell) => cell.dataset.label === 'Reference').getAttribute('title'))
      .toContain('ESU26');
    expect(cells.find((cell) => cell.dataset.label === 'Value').textContent).toBe('Pending');
    expect(cells.find((cell) => cell.dataset.label === 'P&L').textContent).toBe('Pending');
    expect(cells.find((cell) => cell.dataset.label === 'Return').textContent).toBe('Pending');
    expect(cells.find((cell) => cell.dataset.label === 'P&L').getAttribute('title'))
      .toContain('Awaiting the official ForecastEx final result for ESU26');

    const totalRow = screen.getByRole('row', { name: / totals$/i });
    expect(within(totalRow).getByRole('rowheader').textContent).toContain('1 final pending');
    expect(within(totalRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      '$350.00', 'Pending', 'Pending', 'Pending',
    ]);
  });

  test('turns a ForecastEx gold ticker into a Gold strike instead of showing the raw id', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'gold-ticker',
        market: 'other',
        contractLabel: 'METLG_081426_3412_NO',
        contractKey: 'METLG_081426_3412_NO',
        contractSide: 'NO',
        strike: 3412,
        risked: 478,
        currentValue: null,
        pnl: null,
        roi: null,
        status: 'verified',
        displayState: 'SETTLED',
        markState: 'unavailable',
      }],
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    expect(await screen.findByText('3,412')).toBeTruthy();
    expect(screen.queryByText(/METLG_/)).toBeNull();
    const row = screen.getByRole('row', { name: /Gold 3,412 NO/ });
    expect(row.getAttribute('data-market')).toBe('gold');
    expect(within(row).queryByText('Gold')).toBeNull();
    expect(within(row).getByText('NO')).toBeTruthy();
  });

  test('hides truncated ForecastEx ids even when the stored market is other', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      rows: [{
        id: 'gold-truncated',
        market: 'other',
        contractLabel: 'METLG_081426_4',
        contractKey: 'METLG_081426_3412_YES',
        contractSide: 'YES',
        strike: 3412,
        risked: 478,
        currentValue: null,
        pnl: null,
        roi: null,
        status: 'verified',
        displayState: 'SETTLED',
        markState: 'unavailable',
      }],
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    expect(await screen.findByText('3,412')).toBeTruthy();
    expect(screen.queryByText(/METLG_/)).toBeNull();
    expect(screen.getByRole('row', { name: /Gold 3,412 YES/ }).getAttribute('data-market')).toBe('gold');
  });

  test('does not duplicate tracker connection errors inside the P&L card', async () => {
    const connectionError = 'IBKR primary client 18 could not establish a verified API session at 127.0.0.1:4001.';
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockResolvedValue({
      ...ready,
      tracker: {
        status: 'ready',
        health: 'capture_paused',
        healthMessage: connectionError,
      },
    });

    render(<PredictionMarketPerformanceCard accountId="U123" />);

    expect(await screen.findByText('81.49')).toBeTruthy();
    expect(screen.queryByText('History capture delayed')).toBeNull();
    expect(screen.queryByText(connectionError)).toBeNull();
  });

  test('shows an explicit capture-paused state when automatic tracking is unavailable', async () => {
    jest.spyOn(MarketDataService, 'getPredictionMarketPerformance').mockRejectedValue({
      response: { data: { error: 'The Individual account is not live in Gateway.', code: 'ACCOUNT_NOT_LIVE' } },
    });
    render(<PredictionMarketPerformanceCard accountId="U123" />);
    expect(await screen.findByText('P&L unavailable')).toBeTruthy();
    expect(screen.getByText('The Individual account is not live in Gateway.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
  });
});
