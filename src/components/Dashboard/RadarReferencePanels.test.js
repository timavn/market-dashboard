import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MarketDataService } from '../../services/api/marketDataService';
import RadarReferencePanels, {
  aggregateQuoteStatus,
  CftcPreview,
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
    getMoneyFlow: jest.fn(),
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

  it('keeps a fresh IBKR mark through a status-poll delay and withholds it on disconnect', () => {
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
    })).toBe('unavailable');
  });

  it('withholds a retained last-verified row after a failed refresh', () => {
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
    }, null)).toBe('unavailable');
  });

  it('shows the same retained observation as delayed when the overview opts in', () => {
    const row = {
      symbol: 'SPX', price: '7669.22', availability: 'reference', source: 'ibkr', dataType: 'live',
      freshness: 'refresh-delayed', quoteAsOf: '2026-07-10T20:00:00.000Z',
      lastVerifiedAt: '2026-07-10T20:00:00.000Z', displayDelayed: true, displayOnly: true, executable: false,
    };
    const offline = { ibkr: { connected: false } };
    expect(getRowQuoteStatus(row, offline, { allowReference: true })).toBe('refresh-delayed');
    expect(aggregateQuoteStatus([row], offline, { allowReference: true })).toBe('refresh-delayed');
    expect(getRowQuoteStatus(row, offline)).toBe('unavailable');
    for (const invalid of [{ source: 'mock' }, { seeded: true }, { cacheOnly: true },
      { source: 'portfolio' }, { lastVerifiedAt: null }, { executable: true }]) {
      expect(getRowQuoteStatus({ ...row, ...invalid }, offline, { allowReference: true })).toBe('unavailable');
    }
  });

  it('demotes an aging or disconnected overview observation without dropping its values', () => {
    const row = { symbol: 'RUT', price: 2550, changePercent: -0.8, availability: 'current',
      source: 'ibkr', dataType: 'live', quoteAsOf: '2026-07-13T20:57:00.000Z' };
    expect(getRowQuoteStatus(row, null, { allowReference: true })).toBe('refresh-delayed');
    expect(getRowQuoteStatus({ ...row, quoteAsOf: '2026-07-13T20:59:50.000Z' },
      { ibkr: { connected: false } }, { allowReference: true })).toBe('refresh-delayed');
    expect(getRowQuoteStatus({ ...row, freshness: 'stale' }, null, { allowReference: true })).toBe('unavailable');
    expect(getRowQuoteStatus({ ...row, seeded: true }, null, { allowReference: true })).toBe('unavailable');
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

  it('withholds an aging timestamped IBKR observation', () => {
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
    }, null)).toBe('unavailable');
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

describe('CFTC reference highlights preview', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({
    metric: `Asset ${index + 1}`,
    asOf: '2026-09-08', status: 'current', zScore1Y: (index + 1) * (index % 2 ? -0.3 : 0.3),
    latest: 12000, wwChg: 200,
  }));
  const snapshot = {
    reportDate: '2026-09-08', source: 'cftc-public-reporting-environment',
    schemaVersion: 'cftc-positioning-v3', calculationVersion: 'cftc-combined-net-sample-z-v2',
    decisionEligible: true, contentComplete: true, data: rows,
  };

  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T12:00:00Z')));
  afterEach(() => jest.restoreAllMocks());

  test('fills the reference card with eleven signed highlights and discloses the weekly report date', () => {
    render(<CftcPreview data={snapshot} />);
    const table = screen.getByRole('table', { name: 'CFTC positioning preview' });
    const displayed = within(table).getAllByRole('row').slice(1);
    expect(displayed).toHaveLength(11);
    expect(displayed.map((entry) => within(entry).getAllByRole('cell')[0].textContent))
      .toEqual(['Asset 14', 'Asset 13', 'Asset 12', 'Asset 11', 'Asset 10', 'Asset 9', 'Asset 8', 'Asset 7', 'Asset 6', 'Asset 5', 'Asset 4']);
    expect(within(displayed[0]).getByText('-4.20')).toHaveClass('is-negative');
    expect(within(displayed[1]).getByText('3.90')).toHaveClass('is-positive');
    expect(within(displayed[0]).getByText('-4.20')).toHaveClass('is-extreme');
    expect(within(displayed[1]).getByText('3.90')).toHaveClass('is-extreme');
    expect(table).toHaveAttribute('title', expect.stringContaining('AS OF SEP 8'));
    expect(within(table).getByRole('button', { name: /Official CFTC.*AS OF SEP 8/ }))
      .toHaveAttribute('data-data-status', 'historical');
    expect(table).not.toHaveTextContent('LIVE');
  });

  test('uses the same strict score outlines and sign colors for validated numeric strings', () => {
    render(<CftcPreview data={{
      ...snapshot,
      data: [
        { ...rows[0], metric: 'Boundary', latest: '12000', wwChg: '200', zScore1Y: '2' },
        { ...rows[0], metric: 'Outside', latest: '-12000', wwChg: '-200', zScore1Y: '-2.00001' },
        { ...rows[0], metric: 'Small score', zScore1Y: '0.25' },
      ],
    }} />);
    const boundary = within(screen.getByText('Boundary').closest('tr')).getAllByRole('cell');
    expect(boundary[1]).not.toHaveClass('is-positive');
    expect(boundary[2]).not.toHaveClass('is-positive');
    expect(boundary[3]).toHaveClass('is-positive');
    expect(boundary[3]).not.toHaveClass('is-extreme');
    const outside = within(screen.getByText('Outside').closest('tr')).getAllByRole('cell');
    expect(outside[1]).toHaveClass('is-negative');
    expect(outside[1]).not.toHaveClass('is-extreme');
    expect(outside[2]).toHaveClass('is-negative');
    expect(outside[2]).not.toHaveClass('is-extreme');
    expect(outside[3]).toHaveTextContent('-2.00');
    expect(outside[3]).toHaveClass('is-negative', 'is-extreme');
    const small = within(screen.getByText('Small score').closest('tr')).getAllByRole('cell')[3];
    expect(small).toHaveClass('is-positive');
    expect(small).not.toHaveClass('is-extreme');
  });

  test.each([
    ['aged report', { reportDate: '2026-08-25', data: rows.map((row) => ({ ...row, asOf: '2026-08-25' })) }, false, 'AUG 25'],
    ['failed refresh', {}, true, 'SEP 8'],
    ['stale report cache', { cacheState: 'stale' }, false, 'SEP 8'],
  ])('preserves the %s as clearly dated reference evidence', (_label, overrides, refreshFailed, date) => {
    render(<CftcPreview data={{ ...snapshot, ...overrides }} refreshFailed={refreshFailed} />);
    const table = screen.getByRole('table', { name: 'CFTC positioning preview' });
    expect(within(table).getAllByRole('row')).toHaveLength(12);
    expect(table).toHaveAttribute('title', expect.stringContaining(`STALE · REFERENCE ONLY · AS OF ${date}`));
    const marker = within(table).getByRole('button');
    expect(marker).toHaveAttribute('data-data-status', 'reference');
    fireEvent.click(marker);
    expect(screen.getByRole('status')).toHaveTextContent(date === 'AUG 25' ? 'Updated Aug 25, 2026' : 'Updated Sep 8, 2026');
  });

  test('shows unavailable when the report has no verified scored rows', () => {
    render(<CftcPreview data={{ ...snapshot, source: 'mock' }} />);
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('radar reference volume card', () => {
  const datedCftcSnapshot = {
    snapshotType: 'cftc-positioning',
    source: 'cftc-public-reporting-environment',
    sourceVerified: true,
    schemaVersion: 'cftc-positioning-v3',
    calculationVersion: 'cftc-combined-net-sample-z-v2',
    datasetIds: { legacy: 'srt6-5q2f' },
    sourceContentHash: 'a'.repeat(64),
    date: '2026-07-07',
    reportDate: '2026-07-07',
    retrievedAt: '2026-07-12T20:15:09Z',
    data: [],
  };

  const fullMoneyFlow = {
    verdict: 'neutral',
    reasons: ['Net liquidity is mixed while volume is balanced; the two do not agree on a direction.'],
    layers: {
      netLiquidity: {
        status: 'ok',
        latest: {
          date: '2026-10-21', netLiquidity: 5801, fedBalanceSheet: 6753, treasuryGeneralAccount: 952, reverseRepo: 0.2,
          regime: 'mixed',
          changes: { '1w': { pct: -0.0121 }, '13w': { pct: -0.0196 } },
        },
        history: [
          { date: '2026-10-14', netLiquidity: 5872, fedBalanceSheet: 6755, treasuryGeneralAccount: 883, reverseRepo: 0.2 },
          { date: '2026-10-21', netLiquidity: 5801, fedBalanceSheet: 6753, treasuryGeneralAccount: 952, reverseRepo: 0.2 },
        ],
      },
      usStack: { date: '2026-10-01', regime: 'yellow', growth3m: 0.0618, stackToGdp: 0.94 },
      participation: {
        status: 'ok', regime: 'balanced', asOf: '2026-10-23',
        windows: { '1m': { upDownRatio: 0.98 }, '3m': { upDownRatio: 1.051 } },
        latest: { signal: 'light decline' },
        volumeTrend: {
          status: 'ok', asOf: '2026-10-23', baselineSessions: 252, read: 'light',
          latest: { date: '2026-10-23', volume: 15.7e9 },
          windows: { '1w': -0.1, '1m': -0.08, '3m': -0.09 },
        },
      },
      margin: {
        status: 'ok',
        latest: {
          marginDebt: 1480, freeCredit: 434, asOf: '2026-09-30', leverage: 'falling',
          changes: {
            '1m': { marginDebt: 0.018, freeCredit: 0.0206 },
            '3m': { marginDebt: -0.0147, freeCredit: -0.0158 },
            '12m': { marginDebt: 0.314, freeCredit: 0.0875 },
          },
        },
      },
      moneyFunds: {
        status: 'ok',
        latest: { date: '2026-08-31', retailMoneyFunds: 3034, change1w: -0.001, change4w: 0.0083, change13w: 0.0035, change52w: 0.055 },
      },
    },
  };

  const situationReport = {
    date: '2026-07-13',
    snapshotType: 'market-structure',
    contentComplete: true,
    data: {
      signals: [
        { id: 'spxGammaExposure', label: 'SPX Gamma Exposure', value: 'Negative', tone: 'negative' },
        { id: 'systematicFlowRisk', label: 'Systematic Flow Risk', value: 'Bearish', tone: 'negative' },
        { id: 'pvBandRiskReward', label: 'PV Band Risk/Reward', value: 'Neutral', tone: 'neutral' },
        { id: 'strategicAllocation', label: 'Strategic Allocation', value: 'Risk On', tone: 'positive' },
      ],
      chartMetrics: { spxGammaVolatilityThrottle: { gammaThrottle: -8.28 } },
      blocks: [{ type: 'paragraph', text: 'Dealers will start the week in negative gamma territory.' }],
      charts: [],
    },
  };

  const originalResizeObserver = global.ResizeObserver;

  // The expanded Money Flow view draws Recharts containers, which need it.
  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}

      unobserve() {}

      disconnect() {}
    };
  });

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver;
  });

  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-13T21:00:00.000Z'));
    MarketDataService.getDollarLiquidityModels.mockResolvedValue({ models: {} });
    MarketDataService.getMoneyFlow.mockResolvedValue({
      verdict: 'neutral',
      reasons: ['Net liquidity is mixed while volume is balanced; the two do not agree on a direction.'],
      layers: {
        netLiquidity: {
          status: 'ok',
          latest: {
            date: '2026-10-21', netLiquidity: 5801, regime: 'mixed',
            changes: { '13w': { change: -116, direction: 'contracting' } },
          },
        },
        participation: {
          status: 'ok', regime: 'balanced', asOf: '2026-10-23',
          windows: { '1m': { upDownRatio: 0.98 } },
          latest: { signal: 'light decline' },
        },
      },
    });
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
    MarketDataService.getMarketShareVolume.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
  });

  afterEach(async () => {
    await act(async () => { await Promise.resolve(); });
    resetSessionResourceStore();
    window.sessionStorage.clear();
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('dates the CFTC header by the weekly positions and keeps the source-check time in its tooltip', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => datedCftcSnapshot });
    render(<RadarReferencePanels />);
    const card = screen.getByRole('region', { name: 'CFTC Positioning' });
    const date = await within(card).findByText('As of Jul 7, 2026');
    expect(date).toHaveAttribute('datetime', '2026-07-07');
    expect(date.closest('header')).toHaveClass('efr-reference-card__header--dated');
    expect(date).toHaveAttribute('title', expect.stringContaining('Published weekly, usually Friday at 15:30 ET.'));
    expect(date).toHaveAttribute('title', expect.stringContaining('Last checked Jul 12, 2026 13:15 PT.'));
    expect(within(card).getByRole('button', { name: 'CFTC Positioning', exact: true })).toHaveAttribute('aria-haspopup', 'dialog');

    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...datedCftcSnapshot, retrievedAt: '2026-07-13T20:15:09Z' }),
    });
    await act(async () => { jest.advanceTimersByTime(15 * 60 * 1000); });
    await waitFor(() => expect(date).toHaveAttribute('title', expect.stringContaining('Last checked Jul 13, 2026 13:15 PT.')));
    expect(date).toHaveTextContent('As of Jul 7, 2026');
  });

  test.each([
    { source: 'mock' },
    { sourceVerified: false },
    { reportDate: '2026-07-14', date: '2026-07-14' },
    { reportDate: null, date: null },
  ])('does not present an unverified CFTC header date: %p', async (overrides) => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...datedCftcSnapshot, ...overrides }) });
    render(<RadarReferencePanels />);
    await act(async () => { await Promise.resolve(); });
    const card = screen.getByRole('region', { name: 'CFTC Positioning' });
    expect(card.querySelector('header time')).not.toBeInTheDocument();
  });

  test('renders three reference cards with Money Flow as one layered percent grid', async () => {
    MarketDataService.getMoneyFlow.mockResolvedValue(fullMoneyFlow);
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(situationReport);

    render(<RadarReferencePanels />);

    const referenceBar = screen.getByRole('region', { name: 'Normal / Reference' });
    expect(within(referenceBar).queryByRole('heading', { name: 'Normal / Reference' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByText('Select any panel for the full source view')).not.toBeInTheDocument();
    const grid = referenceBar.querySelector('.efr-reference__grid');
    const cards = Array.from(grid.children);
    const cftc = screen.getByRole('region', { name: 'CFTC Positioning' });
    const quads = screen.getByRole('region', { name: 'Global Quads' });
    const moneyFlow = screen.getByRole('region', { name: 'Money Flow' });
    expect(cards).toEqual([cftc, quads, moneyFlow]);
    expect(within(referenceBar).queryByRole('region', { name: 'Dollar Liquidity' })).not.toBeInTheDocument();
    // Volume is a row of the grid now; the exchange-volume table lives in the expanded view.
    expect(within(referenceBar).queryByRole('region', { name: 'Volume' })).not.toBeInTheDocument();
    expect(MarketDataService.getMarketShareVolume).not.toHaveBeenCalled();

    const table = await within(moneyFlow).findByRole('table', { name: 'Money flow' });
    // No header bar: the verdict fills the top-left cell and the title heads the Flow column.
    expect(moneyFlow.querySelector('header')).not.toBeInTheDocument();
    const [verdictCell, ...columns] = within(table).getAllByRole('columnheader');
    await waitFor(() => expect(verdictCell).toHaveTextContent('Neutral'));
    expect(verdictCell).toHaveClass('money-flow-block--flat');
    expect(within(columns[0]).getByRole('button', { name: 'Money Flow' })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(columns.map((cell) => cell.textContent)).toEqual(['Money Flow', 'Level', '1W', '1M', '3M', '1Y', 'Read']);

    // The layers run down the left, each spanning its own rows, to Global Quads' thirteen rows.
    await waitFor(() => expect(within(table).getAllByRole('rowheader').map((cell) => cell.getAttribute('rowspan')))
      .toEqual(['3', '2', '3', '4']));
    const tiles = within(table).getAllByRole('rowheader');
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    // Each tile is filled with its read's color; the figure behind it is in the tooltip.
    expect(tiles.map((tile) => tile.textContent)).toEqual(['Liquiditymixed', 'Tapebalanced', 'Investorsde-levering', 'Mechanicalselling']);
    expect(tiles.map((tile) => tile.className.match(/money-flow-block--(\w+)/)[1])).toEqual(['flat', 'flat', 'down', 'down']);
    expect(tiles[0]).toHaveAttribute('title', 'Fed net liquidity 3M: −1.96%');
    expect(tiles[3]).toHaveAttribute('title', expect.stringContaining('2 of 4 signals bearish'));

    const row = (label) => within(table).getByText(label).closest('tr');
    const cells = (label) => Array.from(row(label).querySelectorAll('td')).map((cell) => cell.textContent);
    // Every value prints without a sign; the Fed inputs are shares of net liquidity.
    expect(cells('Fed net liquidity')).toEqual(['Fed net liquidity', '5.80T', '1.21%', '—', '1.96%', '—', 'mixed']);
    expect(cells('Treasury cash released')).toEqual(['Treasury cash released', '952B', '1.18%', '—', '—', '—', '']);
    expect(within(row('Treasury cash released')).getByText('1.18%')).toHaveClass('is-down');
    // A window the source can't fill stays blank; a missing reading in a window it can fill is a dash.
    expect(cells('Up vs down volume')).toEqual(['Up vs down volume', '0.98×', '', '2.00%', '5.10%', '', 'balanced']);
    expect(cells('US volume vs 1Y avg')).toEqual(['US volume vs 1Y avg', '15.70B', '10.00%', '8.00%', '9.00%', '', 'light']);
    expect(within(table).queryByText('Reverse repo released')).not.toBeInTheDocument();
    expect(within(table).queryByText('U.S. M2 stack')).not.toBeInTheDocument();
    // A shrinking cash balance is money put to work, so it reads green.
    expect(within(row('Free credit deployed')).getByText('1.58%')).toHaveClass('is-up');
    expect(within(row('Free credit deployed')).getByText('deploying')).toHaveClass('money-flow-block--up');
    expect(cells('Dealer gamma')).toEqual(['Dealer gamma', 'GVT −8.28', 'Amplifies moves', 'Negative']);
    expect(cells('Strategic allocation')).toEqual(['Strategic allocation', '', '', 'Risk On']);
    expect(table.textContent.replace('GVT −8.28', '')).not.toMatch(/\$|−|\+/);

    expect(within(referenceBar).queryByRole('button', { name: /full view/i })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByRole('region', { name: 'Market Situation' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByRole('region', { name: 'Style Factors' })).not.toBeInTheDocument();
    expect(within(referenceBar).queryByRole('region', { name: 'Currencies' })).not.toBeInTheDocument();
    await waitFor(() => expect(moneyFlow).toHaveAttribute('data-status', 'historical'));
    // The monthly U.S. stack loads only when the expanded view opens.
    expect(MarketDataService.getDollarLiquidityModels).not.toHaveBeenCalled();
  });

  test('opens and closes each expanded window from its title without a separate close button', async () => {
    MarketDataService.getMarketShareVolume.mockResolvedValue({ totalMarket: [], totalExchange: [], meta: { status: 'missing' } });
    const { container } = render(<RadarReferencePanels />);
    const referenceBar = screen.getByRole('region', { name: 'Normal / Reference' });
    for (const title of ['CFTC Positioning', 'Global Quads', 'Money Flow']) {
      const card = within(referenceBar).getByRole('region', { name: title });
      const trigger = within(card).getByRole('button', { name: title });
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole('dialog', { name: title });
      expect(dialog).toBeVisible();
      // Expanded windows must escape the fitted overview's transform and clipping.
      expect(container).not.toContainElement(dialog);
      expect(dialog.classList.contains('efr-reference-dialog--cftc')).toBe(title === 'CFTC Positioning');
      const popupTitle = within(dialog).getByRole('button', { name: title });
      expect(popupTitle).toHaveClass('dashboard-table-dialog__title');
      expect(within(dialog).queryByRole('button', { name: /^Close / })).not.toBeInTheDocument();
      await waitFor(() => expect(popupTitle).toHaveFocus());
      fireEvent.click(popupTitle);
      expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument();
      await waitFor(() => expect(trigger).toHaveFocus());
    }
    expect(within(referenceBar).queryByText(/full view/i)).not.toBeInTheDocument();
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
      'money-flow',
    ]);
    expect(latestStatuses.find(({ id }) => id === 'global-quads')).toEqual(expect.objectContaining({
      status: expect.stringMatching(/loading|unavailable/),
      detail: 'UNAVAILABLE',
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
          <output data-testid="money-flow-parent-status">{statuses['money-flow'].status}</output>
          <RadarReferencePanels onDashboardStatusChange={handleStatusChange} />
        </>
      );
    };

    render(<StatefulParent />);

    await waitFor(() => expect(screen.getByTestId('money-flow-parent-status')).toHaveTextContent('mixed'));
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

  test('expands to the same grid with every signal, the volume table and the full report', async () => {
    MarketDataService.getMoneyFlow.mockResolvedValue(fullMoneyFlow);
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(situationReport);
    MarketDataService.getMarketShareVolume.mockResolvedValue({ totalMarket: [], totalExchange: [], meta: { status: 'missing' } });

    render(<RadarReferencePanels />);

    fireEvent.click(await screen.findByRole('button', { name: 'Money Flow' }));
    const dialog = await screen.findByRole('dialog', { name: 'Money Flow' });
    const table = await within(dialog).findByRole('table', { name: 'Money flow' });
    expect(table).toHaveClass('money-flow-grid--expanded');
    await waitFor(() => expect(within(table).getAllByRole('rowheader').map((cell) => cell.getAttribute('rowspan')))
      .toEqual(['5', '2', '3', '4']));
    expect(within(table).getByText('Reverse repo released')).toBeInTheDocument();
    expect(within(table).getByText('U.S. M2 stack').closest('tr')).toHaveTextContent('0.94×');
    expect(within(dialog).getByText(/Investors and Mechanical are context and do not vote/)).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Volume · vs trailing averages' })).toBeInTheDocument();
    await waitFor(() => expect(MarketDataService.getMarketShareVolume).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText('UNAVAILABLE')).toBeInTheDocument();
    expect(within(dialog).getByTestId('market-structure-reader')).toBeInTheDocument();
  });

  test.each([
    ['missing', undefined],
    ['unavailable', { status: 'unavailable', windows: {}, read: 'unavailable' }],
  ])('marks Money Flow mixed when the Cboe volume trend is %s', async (_case, volumeTrend) => {
    const onDashboardStatusChange = jest.fn();
    MarketDataService.getMoneyFlow.mockResolvedValue({
      ...fullMoneyFlow,
      layers: {
        ...fullMoneyFlow.layers,
        participation: { ...fullMoneyFlow.layers.participation, volumeTrend },
      },
    });

    render(<RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />);

    const moneyFlow = screen.getByRole('region', { name: 'Money Flow' });
    await waitFor(() => expect(moneyFlow).toHaveAttribute('data-status', 'mixed'));
    const status = onDashboardStatusChange.mock.calls.at(-1)[0].find(({ id }) => id === 'money-flow');
    expect(status.diagnostics).toEqual(expect.arrayContaining([{ label: 'Volume', value: 'Unavailable' }]));
    expect(status.issues).toContain('The Cboe volume trend is unavailable.');
  });

  test('dates the Money Flow volume diagnostic by the Cboe session', async () => {
    const onDashboardStatusChange = jest.fn();
    MarketDataService.getMoneyFlow.mockResolvedValue(fullMoneyFlow);

    render(<RadarReferencePanels onDashboardStatusChange={onDashboardStatusChange} />);

    await waitFor(() => expect(
      onDashboardStatusChange.mock.calls.at(-1)[0].find(({ id }) => id === 'money-flow'),
    ).toEqual(expect.objectContaining({
      status: 'historical',
      diagnostics: expect.arrayContaining([{ label: 'Volume', value: 'OCT 23' }]),
    })));
  });
});
