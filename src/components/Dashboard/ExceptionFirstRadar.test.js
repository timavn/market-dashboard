import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar, {
  BACKDROP_GROUPS,
  VolatilityMapPanel,
  invertPercentageReturn,
  normalizeUsdFirstCurrencyRow,
} from './ExceptionFirstRadar';
import VolatilityMetricRow, { buildVolatilityMetricChart } from './VolatilityMetricRow';
import { VOL_RANGES } from '../../utils/volatilityRegimes';
import { formatDelayedDataTimestamp } from './DelayedDataMarker';
import { getRowQuoteStatus } from './RadarReferencePanels';
import { mergeMarketDataPreservingPeriods } from '../../utils/dashboardMarketPeriods';
import {
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
} from './dashboardStatus';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
jest.mock('../../hooks/useMarketDailySnapshot', () => ({
  __esModule: true,
  ...jest.requireActual('../../hooks/useMarketDailySnapshot'),
  default: () => ({ snapshot: null, loading: false }),
}));
jest.mock('./USDCorrelationMatrix', () => {
  const isAttributedFxvlSnapshot = (row) => {
    const source = String(row?.source || '').trim().toLowerCase();
    return /^cme(?:\b|[-_])/.test(source) || /^yahoo(?:\b|[-_])/.test(source);
  };
  const isDisplayableFxvlSnapshot = (row) => {
    if (!row || !Number.isFinite(Number(row.lastPx)) || !isAttributedFxvlSnapshot(row)) return false;
    const quoteMode = String(row.quoteMode || '').toLowerCase();
    if (
      row.availability === 'historical'
      && row.freshness === 'historical'
      && quoteMode === 'end-of-day'
    ) {
      return true;
    }
    return row.availability === 'available'
      && row.freshness === 'current'
      && ['live', 'real-time', 'realtime', 'delayed'].includes(quoteMode);
  };

  return {
    __esModule: true,
    isDisplayableFxvlSnapshot,
    isAttributedFxvlSnapshot,
    getFxVolatilityRowProps: jest.requireActual('./USDCorrelationMatrix').getFxVolatilityRowProps,
    default: ({ currencyPanel, correlationStatus, showFxVolatility }) => (
      <div data-testid="usd-matrix" data-show-fx-volatility={String(showFxVolatility)}>
        {currencyPanel}
        {correlationStatus}
      </div>
    ),
  };
});
jest.mock('./RadarReferencePanels', () => ({
  __esModule: true,
  default: () => <section className="efr-reference" aria-label="Normal / Reference" />,
  aggregateQuoteStatus: () => 'delayed',
  CurrenciesPreview: ({ ariaLabel, rows, maxRows = 5 }) => (
    <div aria-label={ariaLabel}>{(rows || []).slice(0, maxRows).map(({ name }) => name).join(', ')}</div>
  ),
  getRowQuoteStatus: jest.fn((row) => (
    row?.availability === 'reference' ? 'delayed' : row?.availability || 'unavailable'
  )),
}));

const CURRENT_VIX = {
  lastPx: 16.65,
  day1Ago: 15.03,
  day15Ago: 14.8,
  week1Ago: 15.57,
  week4Ago: 22.22,
  month3Ago: 19.23,
  month6Ago: 15.45,
  priorYearClose: 14.95,
  dayChangePct: 10.78,
  fifteenDayChangePct: 12.5,
  weekChangePct: 6.94,
  monthChangePct: -25.07,
  threeMonthChangePct: -13.42,
  sixMonthChangePct: 7.77,
  ytdChangePct: 11.37,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cboe',
  asOf: '2026-07-15T20:15:01.000Z',
};

const HISTORICAL_MOVE = {
  ...CURRENT_VIX,
  lastPx: 92.4,
  availability: 'historical',
  freshness: 'historical',
  quoteMode: 'end-of-day',
  source: 'yahoo',
  asOf: '2026-07-13T20:30:00.000Z',
};

const USD_CURRENCY_ROWS = [
  { symbol: 'EURUSD', name: 'EUR/USD' },
  { symbol: 'USDJPY', name: 'USD/JPY' },
  { symbol: 'GBPUSD', name: 'GBP/USD' },
  { symbol: 'AUDUSD', name: 'AUD/USD' },
  { symbol: 'USDCAD', name: 'USD/CAD' },
  { symbol: 'USDMXN', name: 'USD/MXN' },
  { symbol: 'USDCHF', name: 'USD/CHF' },
  { symbol: 'NZDUSD', name: 'NZD/USD' },
  { symbol: 'USDCNY', name: 'USD/CNY' },
  { symbol: 'EURGBP', name: 'EUR/GBP' },
  {
    symbol: 'USD',
    name: 'DXY',
    price: 100.75,
    changePercent: -0.02,
    fifteenDayChangePct: 1.23,
    monthChangePct: 2.34,
    threeMonthChangePct: 3.45,
    sixMonthChangePct: 4.56,
    ytdChangePct: 5.67,
    oneYearChangePct: 6.78,
    availability: 'delayed',
    periodReturnsStatus: 'historical',
    periodReturnsAsOf: '2026-07-14',
  },
  {
    symbol: 'UUP',
    name: 'UUP',
    price: 28.12,
    changePercent: 0.04,
    fifteenDayChangePct: 0.5,
    monthChangePct: 1.1,
    threeMonthChangePct: 2.2,
    sixMonthChangePct: 3.3,
    ytdChangePct: 4.4,
    oneYearChangePct: 5.5,
    availability: 'delayed',
    periodReturnsStatus: 'historical',
    periodReturnsAsOf: '2026-07-14',
  },
];

const USD_INDEX_BIAS = {
  verified: true,
  trend: 'BULLISH',
  date: '2026-09-18',
  lrr: 99.53,
  hrr: 100.81,
  sourceUrl: 'https://app.hedgeye.com/feed_items/187366',
  source: 'Early Look',
};

describe('Exception-First header', () => {
  test('renders published arrows and ranges across every asset table independently of quote availability', () => {
    const reading = { ...USD_INDEX_BIAS, lrr: 10.53, hrr: 20.81,
      tick: 'BEARISH', tickEvidence: { source: 'HedgAI Signals', date: '2026-09-17' },
      trade: 'NEUTRAL', tradeEvidence: { source: 'The Call', date: '2026-09-16' },
    };
    const readings = {
      SPX: { ...reading, trend: 'BULLISH', lrr: 6444.3, hrr: 6500.9 },
      DAX: { ...reading, trend: 'NEUTRAL' },
      N225: { ...reading, trend: 'BEARISH' },
      CL: reading,
      UST10Y: { ...reading, lrr: 4.012, hrr: 4.145 },
      BTC: { ...reading, lrr: 79664, hrr: 89001 },
      VIX: { ...reading, trend: 'BEARISH' },
      USD: { ...reading, ...USD_INDEX_BIAS },
      USDJPY: { ...reading, lrr: 140.15, hrr: 143.75 },
      // Reverse-pair research must never annotate a normalized USD-first row.
      EURUSD: { ...reading, lrr: 1.1, hrr: 1.2 },
    };
    const original = JSON.stringify(readings);
    render(<ExceptionFirstRadar
      marketData={{ currencies: USD_CURRENCY_ROWS }}
      volatilityState={{ snapshot: { VIX: CURRENT_VIX }, loading: false }}
      dashboardResearchState={{ status: 'available', readings }}
    />);
    [
      ['S&P 500', 'Bullish', '6,444', '6,501'],
      ['DAX', 'Neutral', '10.5', '20.8'],
      ['Nikkei 225', 'Bearish', '10.5', '20.8'],
      ['WTI Oil', 'Bullish', '10.5', '20.8'],
      ['UST 10Y', 'Bullish', '4.012', '4.145'],
      ['Bitcoin/USD', 'Bullish', '79,664', '89,001'],
      ['VIX', 'Bearish', '10.5', '20.8'],
      ['USD Index', 'Bullish', '99.5', '100.8'],
      ['USD/JPY', 'Bullish', '140.15', '143.75'],
    ].forEach(([label, trend, lower, upper]) => {
      expect(screen.getByRole('img', { name: `${label} trend: ${trend}` })).toBeVisible();
      expect(screen.getByRole('img', { name: `${label} trend: ${trend}` }).parentElement).toHaveTextContent('Te');
      expect(screen.getByRole('img', { name: `${label} tick: Bearish` }).parentElement).toHaveTextContent('Ti ↓');
      expect(screen.getByRole('img', { name: `${label} trade: Neutral` }).parentElement).toHaveTextContent('Ta →');
      expect(screen.getByLabelText(`${label} Risk Range: ${lower} to ${upper}`)).toBeVisible();
    });
    expect(screen.queryByRole('img', { name: /USD\/EUR trend:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /UUP trend:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Ethereum.*trend:/ })).not.toBeInTheDocument();
    expect(JSON.stringify(readings)).toBe(original);
    expect(screen.getByRole('img', { name: 'DAX trend: Neutral' })).toHaveTextContent('→');
  });

  test('simplifies overview prices without rounding provider data or detail views', () => {
    const crypto = [
      { symbol: 'BTC', price: 87543.21, label: /Bitcoin/, expected: '87,543' },
      { symbol: 'BNB', price: 654.32, label: /BNB/, expected: '654' },
      { symbol: 'SOL', price: 63.47, label: /Solana/, expected: '63.5' },
      { symbol: 'XRP', price: 2.5278, label: /XRP/, expected: '2.53' },
      { symbol: 'ADA', price: 0.004567, label: /Cardano/, expected: '0.00457' },
      { symbol: 'ETH', price: 2000.5, label: /Ethereum/, expected: '—', availability: 'unavailable' },
    ];
    const marketData = { crypto: crypto.map(({ symbol, price, availability = 'delayed' }) => ({
      symbol, price, availability, source: 'yahoo',
      quoteAsOf: '2026-09-14T18:00:00Z', changePercent: 1.25,
    })) };
    const original = JSON.stringify(marketData);
    render(<ExceptionFirstRadar marketData={marketData} />);
    const section = screen.getByRole('region', { name: 'Crypto' });
    crypto.forEach(({ label, price, expected, availability }) => {
      const cells = within(within(section).getByRole('row', { name: label })).getAllByRole('cell');
      expect(cells[1].textContent).toBe(`${expected}${availability ? '' : 'D'}`);
      expect(cells[1].title).toContain(availability ? 'Unavailable' : String(price));
      expect(cells[2].textContent).toBe(availability ? '—' : '1.25%');
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Expand Crypto markets' }));
    const detail = screen.getByRole('dialog', { name: 'Crypto' });
    const bitcoinCells = within(within(detail).getByRole('row', { name: /Bitcoin/ })).getAllByRole('cell');
    expect(bitcoinCells[1].textContent).toBe('87,543.21D');
    expect(JSON.stringify(marketData)).toBe(original);
  });

  test('shows one decimal for USD Index while preserving FX quote and return precision', () => {
    const marketData = { currencies: [
      ...USD_CURRENCY_ROWS.filter(({ symbol }) => ['USD', 'UUP'].includes(symbol)),
      { symbol: 'USDJPY', name: 'USD/JPY', price: 154.392, changePercent: 0.1234, availability: 'delayed' },
      { symbol: 'USDCHF', name: 'USD/CHF', price: 0.81234, changePercent: -0.1234, availability: 'delayed' },
    ] };
    const original = JSON.stringify(marketData);
    render(<ExceptionFirstRadar marketData={marketData} />);
    const table = screen.getByRole('table', { name: 'USD currency spreadsheet' });
    [
      [/USD Index/, '100.8D', '0.02%'],
      [/UUP/, '28.1D', '0.04%'],
      [/USD\/JPY/, '154.39D', '0.12%'],
      [/USD\/CHF/, '0.812D', '0.12%'],
    ].forEach(([name, price, change]) => {
      const cells = within(within(table).getByRole('row', { name })).getAllByRole('cell');
      expect(cells[1].textContent).toBe(price);
      expect(cells[2].textContent).toBe(change);
    });
    expect(JSON.stringify(marketData)).toBe(original);
  });

  test('moves G5RV into the volatility table and disables the separate FX graph', () => {
    render(<ExceptionFirstRadar
      volatilityState={{ snapshot: { VIX: CURRENT_VIX } }}
      correlationState={{ fxvlSnapshot: {
        ...HISTORICAL_MOVE, lastPx: 5.87, measure: 'realized',
      } }}
    />);

    const table = screen.getByRole('table', { name: 'Volatility performance' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).getByRole('row', { name: /G5RV G5 FX 1M realized vol/ })).toHaveTextContent('5.87');
    expect(screen.getAllByText('G5RV')).toHaveLength(1);
    expect(screen.getByTestId('usd-matrix')).toHaveAttribute('data-show-fx-volatility', 'false');
  });

  test('preserves the macro roster and eight summary rows with related commodities grouped together', () => {
    expect(BACKDROP_GROUPS.map(({ id }) => id)).toEqual([
      'us', 'europe', 'asia', 'commodities', 'rates', 'crypto',
    ]);
    expect(BACKDROP_GROUPS.flatMap(({ rows }) => rows.map(({ symbols }) => symbols[0]))).toEqual([
      'SPX', 'RSP', 'MID', 'RUT', 'NDX', 'DJI', 'IXIC', 'SMH', 'XLF', 'VNQ',
      'STOXX600', 'SX5E', 'FTSE', 'DAX', 'CAC', 'FTSEMIB', 'IBEX', 'SMI',
      'N225', 'HSI', 'CSI300', 'NIFTY50', 'SSEC', 'KOSPI', 'TAIEX', 'AXJO', 'JKSE', 'KLSE',
      'CRB', 'CL', 'BZ', 'NG', 'RB', 'GC', 'HG', 'SI', 'PL', 'PA', 'ZC', 'ZW', 'ZS',
      'UST2Y', 'UST10Y', 'BUND10Y', 'JGB10Y', 'GILT10Y', 'CURVE_2s10s',
      'OAT10Y', 'BTP10Y', 'ACGB10Y', 'CAN10Y', 'KTB10Y', 'IG_OAS', 'HY_OAS',
      'BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK',
    ]);
    expect(BACKDROP_GROUPS.flatMap(({ rows }) => rows)).toHaveLength(62);
    expect(BACKDROP_GROUPS.map(({ rows }) => rows
      .filter(({ summary }) => summary).map(({ symbols }) => symbols[0])))
      .toEqual([
        ['SPX', 'RSP', 'MID', 'RUT', 'NDX', 'SMH', 'XLF', 'VNQ'],
        ['STOXX600', 'SX5E', 'FTSE', 'DAX', 'CAC', 'FTSEMIB', 'IBEX', 'SMI'],
        ['N225', 'HSI', 'CSI300', 'NIFTY50', 'KOSPI', 'TAIEX', 'AXJO', 'JKSE'],
        ['CRB', 'CL', 'BZ', 'NG', 'GC', 'HG', 'ZC', 'ZS'],
        ['UST2Y', 'UST10Y', 'BUND10Y', 'JGB10Y', 'GILT10Y', 'CURVE_2s10s', 'IG_OAS', 'HY_OAS'],
        ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK'],
      ]);
  });

  test('keeps daily readings in the original top strip', () => {
    render(<ExceptionFirstRadar />);

    expect(screen.getByLabelText('Daily market readings')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exception-First Radar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dashboard data status')).not.toBeInTheDocument();
  });

  test('keeps the Market Backdrop and reference strip inside the primary grid', () => {
    const { container } = render(<ExceptionFirstRadar />);

    const primaryGrid = container.querySelector('.efr-primary-grid');
    const backdrop = screen.getByRole('region', { name: 'Market Backdrop' });
    const reference = screen.getByRole('region', { name: 'Normal / Reference' });

    expect(primaryGrid).toContainElement(backdrop);
    expect(primaryGrid).toContainElement(reference);
    expect(backdrop.parentElement).toBe(primaryGrid);
    expect(reference.parentElement).toBe(primaryGrid);
  });

  test('keeps eight rows in each market summary when provider observations are unavailable', () => {
    const onDashboardStatusChange = jest.fn();
    render(<ExceptionFirstRadar onDashboardStatusChange={onDashboardStatusChange} />);

    const backdrop = screen.getByRole('region', { name: 'Market Backdrop' });
    for (const label of ['US', 'Europe', 'Asia', 'Commodities', 'Rates', 'Crypto']) {
      const card = within(backdrop).getByRole('region', { name: label });
      const rows = within(card).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        const valueCells = within(row).getAllByRole('cell').slice(1);
        expect(valueCells.map(({ textContent }) => textContent))
          .toEqual(['—', '—', '—', '—', '—', '—', '—', '—']);
      }
    }
    const status = onDashboardStatusChange.mock.calls.at(-1)[0]
      .find(({ id }) => id === 'market-backdrop');
    expect(status.diagnostics).toEqual(expect.arrayContaining([
      { label: 'Coverage', value: '0/62 markets' },
    ]));
  });

  test('opens one top-layer detail table and restores trigger focus on Escape', async () => {
    render(<ExceptionFirstRadar />);

    const usSection = screen.getByRole('region', { name: 'US' });
    const trigger = within(usSection).getByRole('button', { name: 'Expand US markets' });
    expect(within(usSection).getAllByRole('row')).toHaveLength(9);
    expect(within(usSection).getByText('S&P MidCap 400')).toBeInTheDocument();
    expect(within(usSection).queryByText('Dow 30')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'US' });
    expect(dialog.parentElement).toHaveClass('efr-backdrop-overlay');
    expect(dialog.parentElement.parentElement).toBe(document.body);
    expect(dialog).not.toHaveAttribute('data-open-direction');
    expect(within(dialog).getAllByRole('row')).toHaveLength(11);
    expect(within(dialog).getByRole('button', { name: 'US', exact: true })).toHaveClass('dashboard-table-dialog__title');
    expect(within(dialog).getByText('S&P MidCap 400')).toBeInTheDocument();
    expect(within(dialog).getByText('Dow 30')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'US' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test.each(BACKDROP_GROUPS)('uses the same detail popup for $label and closes on an outside click', ({ label, rows }) => {
    render(<ExceptionFirstRadar />);
    fireEvent.click(screen.getByRole('button', { name: `Expand ${label} markets` }));
    const dialog = screen.getByRole('dialog', { name: label });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog).toHaveClass('efr-backdrop-dialog');
    expect(dialog.parentElement).toHaveClass('efr-backdrop-overlay');
    expect(dialog).not.toHaveAttribute('style');
    expect(within(dialog).getAllByRole('row')).toHaveLength(rows.length + 1);
    expect(within(dialog).getByRole('button', { name: label, exact: true })).toHaveTextContent(label);
    fireEvent.click(within(dialog).getByRole('table'));
    expect(dialog).toBeInTheDocument();
    fireEvent.pointerDown(dialog.parentElement);
    expect(dialog).toBeInTheDocument();
    fireEvent.click(dialog.parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test.each(BACKDROP_GROUPS)('closes $label from its popup title without a separate close button', async ({ label }) => {
    render(<ExceptionFirstRadar />);
    const trigger = screen.getByRole('button', { name: `Expand ${label} markets` });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: label });
    const title = within(dialog).getByRole('button', { name: label, exact: true });
    expect(within(dialog).queryByRole('button', { name: /^Close / })).not.toBeInTheDocument();
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.click(title);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  test('shows the provider reason when no verified volatility snapshot is available', () => {
    render(
      <ExceptionFirstRadar
        volatilityState={{
          error: 'No verified current volatility rows are available; retrying automatically.',
          retry: jest.fn(),
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Current volatility data unavailable: No verified current volatility rows are available; retrying automatically.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('keeps verified card values visible without rendering background-refresh notices', () => {
    const marketData = {
      us: [{
        symbol: 'SPX',
        name: 'S&P 500',
        price: 7463.63,
        changePercent: 1.25,
        availability: 'delayed',
        source: 'yahoo',
        quoteAsOf: '2026-07-16T20:00:00.000Z',
      }],
    };
    const { rerender } = render(
      <ExceptionFirstRadar
        marketData={marketData}
        volatilityState={{ snapshot: { VIX: CURRENT_VIX } }}
      />,
    );
    const volatilityCard = screen.getByRole('region', { name: 'Volatility' });
    const vixRow = screen.getByLabelText('VIX current volatility');

    rerender(
      <ExceptionFirstRadar
        marketData={marketData}
        volatilityState={{ snapshot: { VIX: CURRENT_VIX }, refreshing: true }}
      />,
    );

    expect(screen.queryByText(/Refreshing verified market data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refreshing verified volatility data/i)).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /S&P 500/ })).toHaveTextContent('1.25%');
    expect(screen.getByRole('table', { name: 'Volatility performance' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Volatility' })).toBe(volatilityCard);
    expect(screen.getByLabelText('VIX current volatility')).toBe(vixRow);
  });

  test('marks retained volatility delayed immediately with its original provider observation', () => {
    const now = Date.now();
    const lastVerifiedAt = new Date(now - 60 * 1000).toISOString();
    render(
      <ExceptionFirstRadar
        volatilityState={{
          snapshot: {
            NazVol: {
              ...CURRENT_VIX,
              lastPx: 21.51,
              availability: 'reference',
              freshness: 'refresh-delayed',
              refreshDelayed: true,
              lastVerifiedAt,
              retainedUntil: new Date(now + 29 * 60 * 1000).toISOString(),
            },
          },
        }}
      />,
    );

    const row = screen.getByLabelText('VXN last verified volatility; refresh delayed');
    expect(row).toHaveClass('is-refresh-delayed');
    expect(within(row).getByText('21.5')).toBeInTheDocument();
    const marker = within(row).getByRole('button', { name: /Refresh delayed · last verified/i });
    expect(marker).toHaveTextContent('D');
    expect(marker).toHaveAccessibleName(expect.stringContaining(CURRENT_VIX.asOf));
    expect(marker).not.toHaveAccessibleName(expect.stringContaining(lastVerifiedAt));
    expect(within(row).queryByText('NO LIVE SERIES')).not.toBeInTheDocument();
  });

  test('marks a Yahoo Nasdaq quote delayed immediately and preserves its observation time', () => {
    const now = Date.now();
    const nasdaq = {
      symbol: 'NDX',
      name: 'Nasdaq 100',
      price: 26232.87,
      changePercent: 0.51,
      availability: 'delayed',
      dataType: 'delayed',
      source: 'yahoo',
      warning: 'ibkr: missing_timestamp; invalid_mark; delayed_data',
      quoteAsOf: new Date(now - 30 * 1000).toISOString(),
    };
    const { rerender } = render(<ExceptionFirstRadar marketData={{ us: [nasdaq] }} />);

    let row = screen.getByRole('row', { name: /Nasdaq/ });
    let priceCell = within(row).getAllByRole('cell')[1];
    expect(priceCell).toHaveTextContent('26,233');
    expect(priceCell).toHaveAttribute('data-source', 'yahoo');
    expect(priceCell).toHaveAttribute('data-availability', 'delayed');
    expect(within(priceCell).getByRole('button', { name: /Yahoo Finance · Delayed/i }))
      .toHaveTextContent('D');
    expect(within(priceCell).getByRole('button', { name: /Yahoo Finance · Delayed/i }))
      .toHaveAccessibleName(expect.stringContaining(formatDelayedDataTimestamp(nasdaq.quoteAsOf).replace('Updated ', '')));

    const olderObservationTime = new Date(now - 121 * 1000).toISOString();
    rerender(<ExceptionFirstRadar marketData={{
      us: [{ ...nasdaq, quoteAsOf: olderObservationTime }],
    }} />);

    row = screen.getByRole('row', { name: /Nasdaq/ });
    priceCell = within(row).getAllByRole('cell')[1];
    expect(within(priceCell).getByRole('button', { name: /Yahoo Finance · Delayed/i }))
      .toHaveTextContent('D');
    expect(within(priceCell).getByRole('button', { name: /Yahoo Finance · Delayed/i }))
      .toHaveAccessibleName(expect.stringContaining(formatDelayedDataTimestamp(olderObservationTime).replace('Updated ', '')));
  });

  test('routes retained-data refresh failures to Systems without rendering inline notices', () => {
    const onDashboardStatusChange = jest.fn();
    render(
      <ExceptionFirstRadar
        marketData={{
          us: [{
            symbol: 'SPX',
            name: 'S&P 500',
            price: 7463.63,
            changePercent: 1.25,
            availability: 'delayed',
            source: 'yahoo',
            quoteAsOf: '2026-07-16T20:00:00.000Z',
          }],
        }}
        marketDataError="market provider offline"
        volatilityState={{
          snapshot: { VIX: CURRENT_VIX },
          error: 'volatility provider offline',
        }}
        onDashboardStatusChange={onDashboardStatusChange}
      />,
    );

    expect(screen.queryByText(/Market quote refresh delayed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Live refresh failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /S&P 500/ })).toHaveTextContent('1.25%');
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.7');

    const latestStatuses = onDashboardStatusChange.mock.calls.at(-1)[0];
    expect(latestStatuses.find(({ id }) => id === 'market-backdrop').issues)
      .toContain('market provider offline');
    expect(latestStatuses.find(({ id }) => id === 'volatility').issues)
      .toContain('volatility provider offline');
  });

  test('routes unavailable market data to Systems without rendering a layout-shifting banner', () => {
    const onDashboardStatusChange = jest.fn();
    const marketDataError = Object.assign(
      new Error('Verified live data has an observation timestamp beyond the allowed future tolerance.'),
      {
        code: 'LIVE_RESOURCE_FUTURE_TIMESTAMP',
        observedAt: '2026-08-18T00:05:00.001Z',
        ageMs: -300_001,
        thresholdMs: 300_000,
      },
    );
    render(
      <ExceptionFirstRadar
        marketDataError={marketDataError}
        volatilityState={{ snapshot: { VIX: CURRENT_VIX } }}
        onDashboardStatusChange={onDashboardStatusChange}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Market quotes unavailable/i)).not.toBeInTheDocument();

    const latestStatuses = onDashboardStatusChange.mock.calls.at(-1)[0];
    expect(latestStatuses.find(({ id }) => id === 'market-backdrop'))
      .toEqual(expect.objectContaining({
        status: 'unavailable',
        issues: expect.arrayContaining([
          'Verified live data has an observation timestamp beyond the allowed future tolerance. Observed 2026-08-18T00:05:00.001Z (301s ahead; future tolerance 300s).',
        ]),
      }));
  });

  test('composes currencies and correlation status inside the USD card', () => {
    const onDashboardStatusChange = jest.fn();
    render(
      <ExceptionFirstRadar
        marketData={{ currencies: USD_CURRENCY_ROWS }}
        correlationState={{
          correlations: { SPX: {} },
          rollingStats: { SPX: {} },
          calculationDate: '2026-07-14',
        }}
        onDashboardStatusChange={onDashboardStatusChange}
      />,
    );

    const usdCard = screen.getByLabelText('USD');
    expect(within(usdCard).getByRole('heading', { name: 'Dollar' })).toBeInTheDocument();
    const currencySheet = within(usdCard).getByRole('table', { name: 'USD currency spreadsheet' });
    expect(currencySheet).not.toHaveTextContent('Dollar & Majors');
    expect(currencySheet).not.toHaveTextContent('USD Crosses');
    expect(Array.from(currencySheet.querySelectorAll('thead th')).map(({ textContent }) => textContent))
      .toEqual([
        'TICKER', 'PRICE', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y',
      ]);
    expect(Array.from(currencySheet.querySelectorAll('thead th'))
      .every((header) => header.classList.contains('usd-currency-spreadsheet__header')))
      .toBe(true);
    const currencyRows = Array.from(currencySheet.querySelectorAll('tbody tr'));
    expect(currencyRows.every((row) => row.children.length === 9)).toBe(true);
    expect(currencyRows.map((row) => row.children[0].textContent))
      .toEqual(['USD Index—', 'UUP', 'USD/EUR', 'USD/JPY', 'USD/GBP',
        'USD/AUD', 'USD/CAD', 'USD/MXN', 'USD/CHF', 'USD/CNY']);
    expect(currencyRows[0]).toHaveTextContent('USD Index—100.8D0.02%1.23%2.34%3.45%4.56%5.67%6.78%');
    expect(currencyRows[0].children[1].textContent).toBe('100.8D');
    expect(currencyRows[0].children[6].textContent).toBe('4.56%');
    expect(within(usdCard).queryByRole('table', { name: 'Dollar & Majors currency instruments' })).not.toBeInTheDocument();
    expect(within(usdCard).queryByRole('table', { name: 'USD Crosses currency instruments' })).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('NZD/USD')).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('EUR/GBP')).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('1M IV')).not.toBeInTheDocument();
    expect(within(usdCard).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    const latestStatuses = onDashboardStatusChange.mock.calls.at(-1)[0];
    const usdStatus = latestStatuses.find(({ id }) => id === 'usd');
    expect(usdStatus).toEqual(expect.objectContaining({
      status: 'mixed',
      detail: 'CURRENCIES DELAYED · CORRELATIONS AS OF JUL 14',
    }));
    expect(screen.queryByLabelText('USD correlations')).not.toBeInTheDocument();
  });

  test.each([
    ['BULLISH', 'Bullish', 'is-positive', '↑'],
    ['BEARISH', 'Bearish', 'is-negative', '↓'],
    ['NEUTRAL', 'Neutral', 'is-neutral', '→'],
  ])('shows the verified %s USD trend as a noninteractive indicator', (trend, label, tone, symbol) => {
    render(<ExceptionFirstRadar
      marketData={{ currencies: USD_CURRENCY_ROWS }}
      usdIndexBiasState={{ status: 'available', bias: { ...USD_INDEX_BIAS, trend } }}
    />);
    const table = screen.getByRole('table', { name: 'USD currency spreadsheet' });
    const row = within(table).getByRole('row', { name: /USD Index/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[0].textContent).toBe(`USD IndexTe ${symbol}(99.5–100.8)`);
    const indicator = within(cells[0]).getByRole('img', { name: `USD Index trend: ${label}` });
    expect(indicator).toHaveClass(tone);
    expect(indicator).toHaveAttribute('title', `USD Index trend: ${label} · Early Look · 2026-09-18`);
    expect(indicator).not.toHaveAttribute('href');
    expect(indicator).not.toHaveAttribute('tabindex');
    expect(indicator.closest('a, button')).toBeNull();
    expect(within(cells[0]).getByLabelText('USD Index Risk Range: 99.5 to 100.8'))
      .toHaveAttribute('title', 'USD Index Risk Range: 99.53–100.81 · Early Look · 2026-09-18');
    expect(cells[1].textContent).toBe('100.8D');
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).queryByRole('link')).not.toBeInTheDocument();
    for (const name of [/UUP/, /USD\/EUR/, /USD\/JPY/]) {
      expect(within(within(table).getByRole('row', { name })).queryByRole('link')).not.toBeInTheDocument();
    }
  });

  test('keeps verified research bias visible when the USD Index quote is unavailable', () => {
    const index = { ...USD_CURRENCY_ROWS.find(row => row.symbol === 'USD'), availability: 'unavailable' };
    render(<ExceptionFirstRadar
      marketData={{ currencies: [index] }}
      usdIndexBiasState={{ status: 'available', bias: USD_INDEX_BIAS }}
    />);
    const table = screen.getByRole('table', { name: 'USD currency spreadsheet' });
    const row = within(table).getByRole('row', { name: /USD Index/ });
    expect(within(row).getByRole('img', { name: 'USD Index trend: Bullish' })).toBeVisible();
    expect(within(row).getByLabelText('USD Index Risk Range: 99.5 to 100.8')).toBeVisible();
    expect(within(row).getAllByRole('cell').slice(1).map(cell => cell.textContent))
      .toEqual(['—', '—', '—', '—', '—', '—', '—', '—']);
    expect(row).not.toHaveTextContent('100.8D');
  });

  test.each([
    { status: 'unavailable', bias: USD_INDEX_BIAS },
    { status: 'error', bias: USD_INDEX_BIAS },
    { status: 'available', bias: { ...USD_INDEX_BIAS, verified: false } },
  ])('clears unavailable or unverified research bias without changing the independently verified quote: %j', state => {
    const marketData = { currencies: USD_CURRENCY_ROWS };
    const { rerender } = render(<ExceptionFirstRadar
      marketData={marketData}
      usdIndexBiasState={{ status: 'available', bias: USD_INDEX_BIAS }}
    />);
    expect(screen.getByRole('img', { name: 'USD Index trend: Bullish' })).toBeVisible();
    rerender(<ExceptionFirstRadar marketData={marketData} usdIndexBiasState={state} />);
    const table = screen.getByRole('table', { name: 'USD currency spreadsheet' });
    const cells = within(within(table).getByRole('row', { name: /USD Index/ })).getAllByRole('cell');
    expect(cells[0].textContent).toBe('USD Index—');
    expect(within(cells[0]).queryByRole('link')).not.toBeInTheDocument();
    expect(within(cells[0]).queryByRole('img')).not.toBeInTheDocument();
    expect(cells[1].textContent).toBe('100.8D');
    expect(cells[2].textContent).toBe('0.02%');
  });

  test('settles status publishing when the parent stores each update', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const publishSpy = jest.fn();
    const marketData = { currencies: USD_CURRENCY_ROWS };
    const correlationState = {
      correlations: { SPX: {} },
      rollingStats: { SPX: {} },
      calculationDate: '2026-07-14',
    };
    const StatefulParent = () => {
      const [statuses, setStatuses] = useState(createUnknownDashboardCardStatuses);
      const handleStatusChange = useCallback((updates) => {
        publishSpy(updates);
        setStatuses((current) => mergeDashboardCardStatuses(current, updates));
      }, []);
      return (
        <>
          <output data-testid="usd-parent-status">{statuses.usd.status}</output>
          <ExceptionFirstRadar
            marketData={marketData}
            correlationState={correlationState}
            onDashboardStatusChange={handleStatusChange}
          />
        </>
      );
    };

    render(<StatefulParent />);

    await waitFor(() => expect(screen.getByTestId('usd-parent-status')).toHaveTextContent('mixed'));
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

  test('uses named market groups and verified multi-horizon backdrop returns', () => {
    const onDashboardStatusChange = jest.fn();
    render(
      <ExceptionFirstRadar
        marketData={{
          us: [
            {
              symbol: 'SPX',
              price: 7463.63,
              changePercent: 1.25,
              fifteenDayChangePct: -2.5,
              monthChangePct: 3.5,
              threeMonthChangePct: 9.75,
              sixMonthChangePct: 12.25,
              ytdChangePct: 0,
              oneYearChangePct: 22.75,
              availability: 'delayed',
              source: 'yahoo',
              dataType: 'delayed',
              quoteAsOf: '2026-07-16T20:00:00.000Z',
              warning: 'ibkr: stale_quote; delayed_data',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              periodReturnsStatus: 'historical',
            },
            {
              symbol: 'DJI',
              price: 52210.26,
              changePercent: 0.4,
              fifteenDayChangePct: 2,
              monthChangePct: 3,
              threeMonthChangePct: 8,
              sixMonthChangePct: 10,
              availability: 'unavailable',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              periodReturnsStatus: 'historical',
            },
          ],
          commodities: [
            {
              symbol: 'CL',
              price: 81.46,
              changePercent: 3.8,
              fifteenDayChangePct: 13.26,
              monthChangePct: 8.4,
              threeMonthChangePct: -13.97,
              sixMonthChangePct: -6.2,
              availability: 'delayed',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              periodReturnsStatus: 'historical',
            },
            {
              symbol: 'HG',
              price: 6.26,
              changePercent: -1.1,
              fifteenDayChangePct: 3.19,
              monthChangePct: 1.75,
              threeMonthChangePct: 3.26,
              sixMonthChangePct: 12.1,
              availability: 'delayed',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              periodReturnsStatus: 'historical',
            },
          ],
          rates: {
            us_treasuries: [
              {
                symbol: 'UST10Y',
                price: 5.06,
                changePercent: -0.78,
                dayChangeBps: -4,
                fifteenDayChangePct: 4.2,
                fifteenDayChangeBps: 21.2,
                monthChangePct: -1.2,
                monthChangeBps: -6.1,
                threeMonthChangePct: 2.7,
                threeMonthChangeBps: 13.3,
                sixMonthChangePct: 5.6,
                sixMonthChangeBps: 26.8,
                availability: 'delayed',
                periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
                periodReturnsStatus: 'historical',
              },
            ],
            credit: [
              {
                symbol: 'HY_OAS',
                price: 2.71,
                changePercent: 1.2,
                dayChangeBps: 3.2,
                fifteenDayChangePct: -2.52,
                fifteenDayChangeBps: -7.0,
                monthChangePct: -1.5,
                monthChangeBps: -4.1,
                threeMonthChangePct: -4.91,
                threeMonthChangeBps: -14.0,
                sixMonthChangePct: -10.4,
                sixMonthChangeBps: -31.5,
                availability: 'historical',
                periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
                periodReturnsStatus: 'historical',
              },
            ],
          },
          crypto: [
            {
              symbol: 'SOL',
              price: 75.22,
              changePercent: -0.5,
              fifteenDayChangePct: -6.73,
              monthChangePct: -2.4,
              threeMonthChangePct: -15.67,
              sixMonthChangePct: 20.1,
              availability: 'delayed',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              periodReturnsStatus: 'historical',
            },
          ],
        }}
        onDashboardStatusChange={onDashboardStatusChange}
      />,
    );

    const backdrop = screen.getByRole('region', { name: 'Market Backdrop' });
    const usSection = within(backdrop).getByRole('region', { name: 'US' });
    expect(within(usSection).getByRole('heading', { name: 'US' })).toHaveTextContent('US');
    expect(within(screen.getByRole('region', { name: 'Europe' })).getByRole('heading', { name: 'Europe' }))
      .toHaveTextContent('Europe');
    within(backdrop).getAllByRole('table').forEach((table) => {
      expect(within(table).getAllByRole('columnheader').map((header) => header.textContent))
        .toEqual(['ASSET', 'Price', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y']);
      within(table).getAllByRole('row').slice(1).forEach((row) => {
        expect(within(row).getAllByRole('cell')).toHaveLength(9);
      });
    });
    expect(within(usSection).queryByText('Data')).not.toBeInTheDocument();
    expect(backdrop).toHaveAttribute('data-status', 'delayed');
    expect(within(backdrop).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Market Backdrop' })).not.toBeInTheDocument();

    const spxRow = within(usSection).getByRole('row', { name: /S&P 500/ });
    const spxCells = within(spxRow).getAllByRole('cell');
    ['S&P 500', '7,464D', '1.25%', '2.50%', '3.50%', '9.75%', '12.25%', '0.00%', '22.75%'].forEach((value, index) => {
      expect(spxCells[index]).toHaveTextContent(value);
    });
    expect(spxCells[2]).toHaveClass('is-positive');
    expect(spxCells[3]).toHaveClass('is-negative');
    expect(spxCells[7]).toHaveClass('is-neutral');
    expect(spxCells[3]).toHaveAttribute('title', 'Historical return · Jul 16, 2026');
    expect(spxCells[1]).toHaveAttribute(
      'title',
      `7463.63 · Yahoo Finance · Delayed · ${formatDelayedDataTimestamp('2026-07-16T20:00:00.000Z').replace('Updated ', '')}`,
    );
    expect(spxCells[1]).toHaveAttribute('data-source', 'yahoo');
    expect(spxCells[1]).toHaveAttribute('data-availability', 'delayed');
    expect(spxCells[1]).toHaveAttribute('data-quote-status', 'delayed');
    expect(within(spxCells[1]).getByRole('button', {
      name: /Yahoo Finance · Delayed · Jul 16, 2026/,
    })).toHaveTextContent('D');

    const marketBackdropStatus = onDashboardStatusChange.mock.calls.at(-1)[0]
      .find(({ id }) => id === 'market-backdrop');
    expect(marketBackdropStatus.diagnostics).toEqual(expect.arrayContaining([
      { label: 'Providers', value: expect.stringContaining('Yahoo Finance delayed') },
      { label: 'As of', value: '2026-07-16T20:00:00.000Z' },
    ]));

    expect(within(usSection).queryByRole('row', { name: /Dow 30/ })).not.toBeInTheDocument();
    fireEvent.click(within(usSection).getByRole('button', { name: 'Expand US markets' }));
    const usDialog = screen.getByRole('dialog', { name: 'US' });
    expect(within(usDialog).getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['ASSET', 'Price', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y']);
    const unavailableRow = within(usDialog).getByRole('row', { name: /Dow 30/ });
    const unavailableCells = within(unavailableRow).getAllByRole('cell');
    ['Dow 30', '—', '—', '—', '—', '—', '—', '—', '—'].forEach((value, index) => {
      expect(unavailableCells[index]).toHaveTextContent(value);
    });
    fireEvent.click(within(usDialog).getByRole('button', { name: 'US', exact: true }));

    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /Copper/ }))
      .toHaveTextContent('Copper6.26D1.10%3.19%1.75%3.26%12.10%——');
    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /WTI Oil/ }))
      .toHaveTextContent('WTI Oil81.5D3.80%13.26%8.40%13.97%6.20%——');
    const ratesSection = screen.getByRole('region', { name: 'Rates' });
    expect(within(ratesSection).getByRole('row', { name: /UST 10Y/ }))
      .toHaveTextContent('UST 10Y5.060D0.78%4.20%1.20%2.70%5.60%——');
    expect(within(ratesSection).getByRole('row', { name: /HY OAS/ }))
      .toHaveTextContent('HY OAS2.710D1.20%2.52%1.50%4.91%10.40%——');
    fireEvent.click(within(ratesSection).getByRole('button', { name: 'Expand Rates markets' }));
    const ratesDialog = screen.getByRole('dialog', { name: 'Rates' });
    const hyOasRow = within(ratesDialog).getByRole('row', { name: /HY OAS/ });
    expect(hyOasRow).toHaveTextContent('HY OAS2.710D1.20%2.52%1.50%4.91%10.40%——');
    expect(within(hyOasRow).getByRole('button', { name: /Historical reference/i }))
      .toHaveTextContent('D');
    fireEvent.click(within(ratesDialog).getByRole('button', { name: 'Rates', exact: true }));
    const cryptoSection = screen.getByRole('region', { name: 'Crypto' });
    const cryptoRows = within(cryptoSection).getAllByRole('row').slice(1);
    expect(cryptoRows).toHaveLength(8);
    ['Bitcoin/USD', 'Ethereum/USD', 'BNB/USD', 'XRP/USD', 'Solana/USD', 'Cardano/USD', 'Dogecoin/USD', 'Chainlink/USD'].forEach((label, index) => {
      expect(within(cryptoRows[index]).getByText(label, { exact: true })).toBeInTheDocument();
    });
    expect(within(cryptoSection).getByRole('row', { name: /Solana/ }))
      .toHaveTextContent('Solana/USD75.2D0.50%6.73%2.40%15.67%20.10%——');
    fireEvent.click(within(cryptoSection).getByRole('button', { name: 'Expand Crypto markets' }));
    expect(within(screen.getByRole('dialog', { name: 'Crypto' })).getByRole('row', { name: /Solana/ }))
      .toHaveTextContent('Solana/USD75.22D0.50%6.73%2.40%15.67%20.10%——');
  });

  test('keeps native S&P 500 and Russell timeframe returns when live IBKR quotes refresh', () => {
    const now = Date.parse('2026-09-30T18:00:00.000Z');
    const quoteAsOf = '2026-09-30T17:59:30.000Z';
    const periodReturnsAsOf = '2026-09-29T20:00:00.000Z';
    const indices = [
      { symbol: 'SPX', label: 'S&P 500', series: '^GSPC', price: 7695.23, day: 0.32,
        returns: [2.13, 3.42, 5.67, 8.91, 10.12, 14.56] },
      { symbol: 'RUT', label: 'Russell 2000', series: '^RUT', price: 2808.11, day: -0.01,
        returns: [-1.24, 2.35, 4.68, 7.9, 9.01, 12.34] },
    ];
    const fields = ['fifteenDayChangePct', 'monthChangePct', 'threeMonthChangePct',
      'sixMonthChangePct', 'ytdChangePct', 'oneYearChangePct'];
    const historicalData = { us: indices.map(({ symbol, label, series, price, returns }) => ({
      symbol, name: label, price: price - 1,
      source: 'yahoo', dataType: 'historical', availability: 'historical',
      quoteAsOf: '2026-09-29T20:00:00.000Z',
      periodReturnsStatus: 'historical', periodReturnsAsOf,
      periodReturnsSource: 'yahoo', periodSourceSeriesId: series,
      periodSourceInstrument: series, periodObservationFrequency: 'daily',
      ...Object.fromEntries(fields.map((field, index) => [field, returns[index]])),
    })) };
    const liveData = { us: indices.map(({ symbol, label, price, day }) => ({
      symbol, name: label, price, changePercent: day,
      source: 'ibkr', dataType: 'live', availability: 'current', freshness: 'current', quoteAsOf,
      periodReturnsStatus: 'unavailable', periodReturnsAsOf: null,
      ...Object.fromEntries(fields.map((field) => [field, null])),
    })) };
    const originalHistory = JSON.stringify(historicalData);
    const originalQuotes = JSON.stringify(liveData);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    getRowQuoteStatus.mockImplementation(jest.requireActual('./RadarReferencePanels').getRowQuoteStatus);
    try {
      const marketData = mergeMarketDataPreservingPeriods(historicalData, liveData);
      render(<ExceptionFirstRadar marketData={marketData} providerStatus={{ ibkr: { connected: true } }} />);
      const assertIndices = (surface) => indices.forEach(({ label, series, price, day, returns }) => {
        const cells = within(within(surface).getByRole('row', { name: new RegExp(label) }))
          .getAllByRole('cell');
        expect(cells[1]).toHaveAttribute('data-source', 'ibkr');
        expect(cells[1]).toHaveAttribute('data-quote-status', 'live');
        expect(cells[1].title).toContain(`${price} · IBKR · Live · `);
        expect(within(cells[1]).queryByRole('button')).not.toBeInTheDocument();
        expect(cells[2]).toHaveTextContent(`${Math.abs(day).toFixed(2)}%`);
        const historicalTitle = `Yahoo Finance · Last verified historical return · ${formatDelayedDataTimestamp(periodReturnsAsOf, 'historical').replace('Updated ', '')} · ${series}`;
        cells.slice(3).forEach((cell, index) => {
          expect(cell).toHaveTextContent(`${Math.abs(returns[index]).toFixed(2)}%`);
          expect(cell.title).toBe(historicalTitle);
          expect(cell.title).not.toContain('IBKR');
          expect(cell.title).not.toContain('Sep 30');
          expect(within(cell).getByRole('button', { name: /Yahoo Finance · Last verified historical return · Sep 29, 2026/ }))
            .toHaveTextContent('D');
        });
      });
      const usSection = screen.getByRole('region', { name: 'US' });
      assertIndices(usSection);
      fireEvent.click(within(usSection).getByRole('button', { name: 'Expand US markets' }));
      assertIndices(screen.getByRole('dialog', { name: 'US' }));
      expect(JSON.stringify(historicalData)).toBe(originalHistory);
      expect(JSON.stringify(liveData)).toBe(originalQuotes);
    } finally {
      nowSpy.mockRestore();
      getRowQuoteStatus.mockImplementation((row) => (
        row?.availability === 'reference' ? 'delayed' : row?.availability || 'unavailable'
      ));
    }
  });

  test('keeps a retained S&P 500 reference visible with a delayed icon', () => {
    render(
      <ExceptionFirstRadar
        marketData={{
          us: [{
            symbol: 'SPX',
            name: 'S&P 500',
            price: 7669.22,
            changePercent: 0.49,
            availability: 'reference',
            source: 'ibkr',
            dataType: 'live',
            freshness: 'refresh-delayed',
            quoteAsOf: '2026-09-02T17:01:49.771Z',
            lastVerifiedAt: '2026-09-02T17:01:49.771Z',
            displayDelayed: true,
            displayOnly: true,
            executable: false,
          }],
        }}
      />,
    );

    const row = screen.getByRole('row', { name: /S&P 500/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('7,669D');
    expect(cells[2]).toHaveTextContent('0.49%');
    expect(cells[1]).toHaveAttribute('data-quote-status', 'delayed');
    expect(within(cells[1]).getByRole('button', {
      name: /IBKR · Refresh delayed · Sep 2, 2026/,
    })).toHaveTextContent('D');
  });

  test('renders verified curve percentages without relabeling legacy basis-point deltas', () => {
    render(
      <ExceptionFirstRadar
        marketData={{
          rates: {
            us_treasuries: [{
              symbol: 'CURVE_2s10s',
              price: '-42.5',
              backdropPercentageReturns: {
                latestObservationChange: { value: 2.75, from: '2026-07-15T00:00:00Z', asOf: '2026-07-16T00:00:00Z', interval: 'daily', status: 'historical' },
                fifteenDayChangePct: -8.7, monthChangePct: 11.64,
                threeMonthChangePct: 15.51, sixMonthChangePct: -27.25,
                ytdChangePct: 5.13, oneYearChangePct: 9.57,
              },
              changePercent: 1.2,
              fifteenDayChangePct: -3.4,
              monthChangePct: 5.6,
              threeMonthChangePct: 7.8,
              sixMonthChangePct: -9.1,
              ytdChangePct: 2.3,
              oneYearChangePct: 4.5,
              unit: 'bps',
              source: 'derived',
              dataType: 'derived',
              availability: 'historical',
              periodReturnsStatus: 'historical',
              periodReturnsAsOf: '2026-07-16T00:00:00.000Z',
              quoteAsOf: '2026-07-16T00:00:00.000Z',
            }],
          },
        }}
      />,
    );

    const ratesSection = screen.getByRole('region', { name: 'Rates' });
    fireEvent.click(within(ratesSection).getByRole('button', { name: 'Expand Rates markets' }));
    const row = within(screen.getByRole('dialog', { name: 'Rates' }))
      .getByRole('row', { name: /2s10s Curve/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '2s10s Curve', '-42.5D', '2.75%D', '8.70%', '11.64%',
      '15.51%', '27.25%', '5.13%', '9.57%',
    ]);
    expect(cells[2]).toHaveClass('is-positive');
    expect(cells[3]).toHaveClass('is-negative');
  });

  test('does not invent a daily move when a historical yield provider has no daily observation', () => {
    render(
      <ExceptionFirstRadar
        marketData={{
          rates: {
            eu_sovereigns: [{
              symbol: 'BUND10Y',
              price: '2.97',
              changePercent: '-2.51',
              changeUnit: 'bps',
              dayChangeBps: null,
              fifteenDayChangeBps: -7.6,
              monthChangeBps: -7.6,
              threeMonthChangeBps: 6,
              sixMonthChangeBps: 15.6,
              ytdChangeBps: 16.3,
              oneYearChangeBps: 45.1,
              source: 'fred',
              availability: 'historical',
              quoteAsOf: '2026-06-01T00:00:00.000Z',
              periodReturnsStatus: 'historical',
              periodReturnsAsOf: '2026-06-01T00:00:00.000Z',
            }],
          },
        }}
      />,
    );

    const row = within(screen.getByRole('region', { name: 'Rates' }))
      .getByRole('row', { name: /Germany 10Y/ });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'Germany 10Y', '2.970D', '—', '—', '—', '—', '—', '—', '—',
    ]);
  });

  test('keeps monthly reference levels without presenting monthly moves as Day or 15D', () => {
    render(<ExceptionFirstRadar marketData={{ rates: { eu_sovereigns: [{
      symbol: 'BUND10Y', price: '3.18', changePercent: '3.57', dayChangeBps: null,
      source: 'fred', availability: 'historical', warning: 'historical_observation',
      quoteAsOf: '2026-08-01T00:00:00Z',
      periodReturnsStatus: 'historical', periodReturnsAsOf: '2026-08-01T00:00:00Z',
      latestObservationChange: {
        value: 3.57, interval: 'monthly', from: '2026-07-01T00:00:00Z',
        asOf: '2026-08-01T00:00:00Z', status: 'historical',
      },
      backdropPercentageReturns: { fifteenDayChangePct: 3.57, monthChangePct: 3.57 },
    }] } }} />);
    const row = within(screen.getByRole('region', { name: 'Rates' }))
      .getByRole('row', { name: /Germany 10Y/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('3.180D');
    expect(cells[2]).toHaveTextContent(/^—$/);
    expect(cells[3]).toHaveTextContent(/^—$/);
    expect(cells[4]).toHaveTextContent('3.57%');
    expect(cells[1].title).toBe('3.18 · FRED · Monthly observation · Aug 2026');
    const marker = within(cells[1]).getByRole('button', { name: 'FRED · Monthly observation · Aug 2026' });
    expect(marker).toHaveAttribute('title', '');
    fireEvent.click(marker);
    expect(screen.getByRole('status')).toHaveTextContent('FRED · Monthly observation · Aug 2026');
    expect(screen.getByRole('status')).not.toHaveTextContent(/Updated|historical_observation|T00:/);
  });

  test('shows official daily yield provenance and the original observation date', () => {
    render(<ExceptionFirstRadar marketData={{ rates: { eu_sovereigns: [{
      symbol: 'GILT10Y', price: '5.291', changePercent: '0.20',
      source: 'bank_of_england', sourceInstrument: '10-year nominal par yield',
      observationFrequency: 'daily', availability: 'historical',
      quoteAsOf: '2026-09-23T00:00:00Z',
    }] } }} />);
    const row = within(screen.getByRole('region', { name: 'Rates' }))
      .getByRole('row', { name: /UK 10Y/ });
    const price = within(row).getAllByRole('cell')[1];
    expect(price.title).toBe('5.291 · Bank of England · Historical reference · Sep 23, 2026 · 10-year nominal par yield');
    expect(price.title).not.toMatch(/T00:|AM|PM/);
  });

  test.each([
    ['daily', 'D', '2026-07-15', '2026-07-16'],
  ])('shows the dated last %s change when the daily move is unavailable', (interval, marker, from, asOf) => {
    render(<ExceptionFirstRadar marketData={{ rates: { eu_sovereigns: [{
      symbol: 'BUND10Y', price: '2.97', changePercent: null, dayChangeBps: null,
      source: 'fred', availability: 'historical', quoteAsOf: `${asOf}T00:00:00Z`,
      latestObservationChange: {
        value: -1.23, interval, from: `${from}T00:00:00Z`, asOf: `${asOf}T00:00:00Z`, status: 'historical',
      },
    }] } }} />);
    const rates = screen.getByRole('region', { name: 'Rates' });
    fireEvent.click(within(rates).getByRole('button', { name: 'Expand Rates markets' }));
    const row = within(screen.getByRole('dialog', { name: 'Rates' })).getByRole('row', { name: /Germany 10Y/ });
    const day = within(row).getAllByRole('cell')[2];
    expect(day).toHaveTextContent(`1.23%${marker}`);
    expect(day).toHaveClass('is-negative');
    expect(day.title).toContain('Jul 15, 2026 to Jul 16, 2026');
    expect(day.title).toContain(interval);
  });

  test('renders a scaled volatility chart with aligned axes', () => {
    const { container } = render(<VolatilityMapPanel layout="map" volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    const volatilityCard = screen.getByRole('region', { name: 'Volatility · 3M Map' });
    expect(within(volatilityCard).queryByRole('heading', { name: 'Volatility · 3M Map' }))
      .not.toBeInTheDocument();
    expect(volatilityCard).toHaveAttribute('data-status', 'mixed');
    expect(within(volatilityCard).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exceptions Now' })).not.toBeInTheDocument();
    const seriesGrid = within(volatilityCard).getByRole('group', { name: '9 volatility series' });
    expect(seriesGrid).toHaveStyle('--efr-vol-row-count: 9');
    expect(within(seriesGrid).getAllByRole('article')).toHaveLength(9);
    const chart = screen.getByLabelText('VIX volatility from six months ago to 7/15');
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('.efr-vol-sparkline__y-tick text')).toHaveLength(3);
    expect(chart.querySelector('.efr-vol-sparkline__y-axis')).toBeInTheDocument();
    expect(Array.from(chart.querySelectorAll('.efr-vol-sparkline__regime-band')).map((band) => band.className.baseVal))
      .toEqual([
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--green',
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--yellow',
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--red',
      ]);

    const segments = Array.from(chart.querySelectorAll('.efr-vol-sparkline__segment'));
    const linePointXs = [
      segments[0].getAttribute('x1'),
      ...segments.map((segment) => segment.getAttribute('x2')),
    ];
    const xTicks = Array.from(chart.querySelectorAll('.efr-vol-sparkline__x-tick'));
    expect(xTicks.map((tick) => tick.querySelector('text')?.textContent))
      .toEqual(['6M', '3M', '1M', '15D', '1D', '7/15']);
    expect(xTicks.map((tick) => tick.querySelector('text')?.getAttribute('x')))
      .toEqual(linePointXs);
    expect(chart.querySelectorAll('circle')).toHaveLength(0);
    expect(segments.map((segment) => segment.getAttribute('data-segment')))
      .toEqual(['6M-3M', '3M-1M', '1M-15D', '15D-1D', '1D-7/15']);
    expect(segments.map((segment) => segment.classList.contains('is-rising')
      ? 'rising'
      : segment.classList.contains('is-falling') ? 'falling' : 'flat'))
      .toEqual(['rising', 'rising', 'falling', 'rising', 'rising']);
    expect(container.querySelector('.efr-vol-sparkline__labels')).not.toBeInTheDocument();
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.65');
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('+12.50%');
    const vixRow = screen.getByLabelText('VIX current volatility');
    expect(Array.from(vixRow.querySelectorAll('.efr-vol-row__metrics small'))
      .map((label) => label.textContent)).toEqual(['DAY', '15D', '1M', '3M', '6M']);
    expect(vixRow.querySelectorAll('.efr-vol-row__metrics small'))
      .toHaveLength(5);
    expect(within(vixRow).getByText('-25.07%')).toBeInTheDocument();
    expect(Array.from(vixRow.querySelectorAll('.efr-vol-row__metric-level'))
      .map((level) => level.textContent)).toEqual(['15.03', '14.80', '22.22', '19.23', '15.45']);
    expect(Array.from(vixRow.querySelectorAll('.efr-vol-row__metric-level'))
      .map((level) => level.className)).toEqual([
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
      'efr-vol-row__metric-level efr-vol-row__metric-level--yellow',
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
    ]);
    expect(within(vixRow).queryByText('Regime')).not.toBeInTheDocument();
    expect(within(vixRow).getByText('Investable')).toBeInTheDocument();
  });

  test('superimposes the verified VIX Risk Range with prediction-market third bands', () => {
    render(
      <VolatilityMapPanel layout="map"
        volatilityState={{ snapshot: { VIX: CURRENT_VIX } }}
        vixRiskRangeState={{
          status: 'available',
          range: {
            status: 'available',
            verified: true,
            source: 'risk_range_publication',
            lrr: 14.5,
            hrr: 17.5,
            date: '2026-07-15',
          },
        }}
      />,
    );

    const chart = screen.getByRole('img', {
      name: /with verified VIX Risk Range 14\.50 to 17\.50 for 2026-07-15/i,
    });
    expect(Array.from(chart.querySelectorAll('[data-risk-range-band]'))
      .map((band) => band.getAttribute('data-risk-range-band')))
      .toEqual(['lower-third', 'upper-third']);
    expect(Array.from(chart.querySelectorAll('[data-risk-range-line]'))
      .map((line) => line.getAttribute('data-risk-range-line')))
      .toEqual(['lrr', 'hrr']);
    expect(within(chart).getByText('LRR 14.50')).toBeInTheDocument();
    expect(within(chart).getByText('HRR 17.50')).toBeInTheDocument();
    expect(within(chart).queryByText('RR UNAVAILABLE')).not.toBeInTheDocument();
  });

  test('puts a verified Risk Range above spot for any volatility measure', () => {
    render(
      <VolatilityMetricRow
        row={CURRENT_VIX}
        symbol="VVIX"
        available
        riskRangeStatus="available"
        riskRange={{
          status: 'available',
          verified: true,
          source: 'risk_range_publication',
          lrr: 82.25,
          hrr: 94.75,
          date: '2026-07-15',
        }}
        ariaLabel="VVIX current volatility"
      />,
    );

    const row = screen.getByLabelText('VVIX current volatility');
    const range = within(row).getByLabelText('VVIX Risk Range');

    expect(within(row).getByText('VVIX', { selector: '.efr-vol-row__ticker' }))
      .toBeInTheDocument();
    expect(range).toHaveTextContent('HRR94.75');
    expect(range).toHaveTextContent('LRR82.25');
    expect(within(row).getByText('16.65', { selector: '.efr-vol-row__spot' }))
      .toBeInTheDocument();
    expect(within(row).getByRole('img', {
      name: /with verified VVIX Risk Range 82\.25 to 94\.75/i,
    })).toBeInTheDocument();
  });

  test('renders no VIX range band when the supplied provenance is cache-only', () => {
    render(
      <VolatilityMapPanel layout="map"
        volatilityState={{ snapshot: { VIX: CURRENT_VIX } }}
        vixRiskRangeState={{
          status: 'available',
          range: {
            status: 'available',
            verified: true,
            source: 'cache_only',
            lrr: 14.5,
            hrr: 17.5,
            date: '2026-07-15',
          },
        }}
      />,
    );

    const chart = screen.getByRole('img', { name: /rr unavailable/i });
    expect(chart.querySelectorAll('[data-risk-range-band]')).toHaveLength(0);
    expect(chart.querySelectorAll('[data-risk-range-line]')).toHaveLength(0);
    expect(within(chart).getByText('RR UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByLabelText('VIX Risk Range')).not.toBeInTheDocument();
  });

  test('adds contextual headroom to a narrow volatility series', () => {
    const chart = buildVolatilityMetricChart({
      month6Ago: 21.2,
      month3Ago: 21.6,
      week4Ago: 27.7,
      day15Ago: 24.8,
      day1Ago: 27.5,
      lastPx: 26,
      asOf: '2026-07-31T20:00:00.000Z',
    }, undefined, undefined, {
      regimeRanges: VOL_RANGES.NazVol.ranges,
    });

    expect(chart.yTicks.map(({ value }) => value)).toEqual([40, 27.5, 15]);
    expect(chart.yTicks.map(({ label }) => label)).toEqual(['40', '28', '15']);
    expect(chart.points.every(({ y }) => y > chart.plotTop && y < chart.plotBottom)).toBe(true);
  });

  test('keeps the current snapshot visible during a background refresh', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX }, loading: true }} />);

    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.7');
    expect(screen.getByRole('table', { name: 'Volatility performance' })).toBeInTheDocument();
    expect(screen.queryByText('Loading current volatility data…')).not.toBeInTheDocument();
  });

  test('does not render stale volatility values as current data', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, freshness: 'stale' } } }} />);

    expect(screen.getByLabelText('VIX volatility data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('16.7')).not.toBeInTheDocument();
  });

  test('does not render volatility values without a verified observation date', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, asOf: null } } }} />);

    expect(screen.getByLabelText('VIX volatility data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('16.7')).not.toBeInTheDocument();
  });

  test('colors current VIX values by their regime', () => {
    const { rerender } = render(
      <ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 16.56 } } }} />,
    );
    const greenRow = screen.getByLabelText('VIX current volatility');
    expect(within(greenRow).getByText('16.6'))
      .toHaveClass('efr-vol-regime-value--green');
    expect(within(greenRow).getByText('<20')).toBeInTheDocument();

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 20 } } }} />);
    const orangeRow = screen.getByLabelText('VIX current volatility');
    expect(within(orangeRow).getByText('20'))
      .toHaveClass('efr-vol-regime-value--yellow');
    expect(within(orangeRow).getByText('20–29')).toBeInTheDocument();

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 40 } } }} />);
    const redRow = screen.getByLabelText('VIX current volatility');
    expect(within(redRow).getByText('40'))
      .toHaveClass('efr-vol-regime-value--red');
    expect(within(redRow).getByText('>29')).toBeInTheDocument();
  });

  test('opens a centered fundamental explainer from every volatility ticker', async () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    ['VIX', 'VVIX', 'RVX', 'VXN', 'VXEEM', 'GVZ', 'OVX', 'BITVX', 'MOVE'].forEach((symbol) => {
      expect(screen.getByRole('button', { name: `Explain ${symbol} volatility index` }))
        .toHaveAttribute('aria-haspopup', 'dialog');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Explain VIX volatility index' }));
    const dialog = screen.getByRole('dialog', { name: 'Cboe Volatility Index' });

    expect(dialog).toHaveAttribute('data-indicator', 'VIX');
    expect(within(dialog).getByText('What it is')).toBeInTheDocument();
    expect(within(dialog).getByText('How it is used')).toBeInTheDocument();
    expect(within(dialog).getByText('Role in the process')).toBeInTheDocument();
    expect(within(dialog).getByText('How it is calculated')).toBeInTheDocument();
    expect(within(dialog).getByText(/Index = 100 × √\(constant 30-day expected variance\)/))
      .toBeInTheDocument();
    const ranges = within(dialog).getByRole('region', { name: 'VIX dashboard process ranges' });
    expect(within(ranges).getByText('< 20')).toBeInTheDocument();
    expect(within(ranges).getByText('20 to < 29')).toBeInTheDocument();
    expect(within(ranges).getByText('≥ 29')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Official Cboe VIX methodology/i }))
      .toHaveAttribute('href', expect.stringContaining('cboe.com'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Explain BITVX volatility index' }));
    const bitvxDialog = screen.getByRole('dialog', { name: 'Cboe Bitcoin ETF Volatility Index' });
    expect(within(bitvxDialog).getByText('No validated process bands yet.')).toBeInTheDocument();
    expect(within(bitvxDialog).getByText(/shown as context only/i)).toBeInTheDocument();
    fireEvent.click(within(bitvxDialog).getByRole('button', { name: 'Close BITVX explainer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Explain MOVE volatility index' }));
    const moveDialog = screen.getByRole('dialog', { name: 'ICE BofA MOVE Index' });
    expect(within(moveDialog).getByText(/weighted basket of option-implied U\.S\. yield volatilities/i))
      .toBeInTheDocument();
    expect(within(moveDialog).queryByText('option strike')).not.toBeInTheDocument();
  });

  test('keeps the retained historical MOVE observation date in its accessible label', () => {
    render(
      <ExceptionFirstRadar
        volatilityState={{
          lastUpdated: '2026-07-15T19:45:00.000Z',
          snapshot: {
            MOVE: { ...HISTORICAL_MOVE, asOf: '2026-07-10T20:15:00.000Z' },
          },
        }}
      />,
    );

    const row = screen.getByLabelText('MOVE end-of-day volatility as of JUL 10');
    expect(within(row).queryByText('AS OF JUL 10')).not.toBeInTheDocument();
    expect(within(row).queryByText(/EOD/)).not.toBeInTheDocument();
    expect(within(row).queryByText('JUL 15')).not.toBeInTheDocument();
    expect(within(row).getByText('92.4')).toHaveClass('efr-vol-regime-value--green');
    expect(within(row).getByText('<100')).toBeInTheDocument();
    expect(row).toHaveAttribute('data-status', 'historical');
  });

  test('uses green, red, and neutral direction colors for metrics and chart segments', () => {
    render(
      <VolatilityMapPanel layout="map"
        volatilityState={{
          snapshot: {
            VIX: {
              ...CURRENT_VIX,
              month3Ago: 25,
              month6Ago: 30,
              week4Ago: 20,
              day15Ago: 15,
              week1Ago: 15,
              day1Ago: 16,
              lastPx: 16,
              priorYearClose: 30,
              dayChangePct: 0,
              fifteenDayChangePct: -2,
              monthChangePct: -20,
              threeMonthChangePct: 5,
              sixMonthChangePct: -3,
            },
          },
        }}
      />,
    );

    const row = screen.getByLabelText('VIX current volatility');
    const metricValues = Array.from(row.querySelectorAll('.efr-vol-row__metrics > span'));
    expect(metricValues.map((metric) => metric.className))
      .toEqual(['is-flat', 'is-falling', 'is-falling', 'is-rising', 'is-falling']);
    expect(Array.from(row.querySelectorAll('.efr-vol-row__metric-level'))
      .map((level) => level.className)).toEqual([
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
      'efr-vol-row__metric-level efr-vol-row__metric-level--green',
      'efr-vol-row__metric-level efr-vol-row__metric-level--yellow',
      'efr-vol-row__metric-level efr-vol-row__metric-level--yellow',
      'efr-vol-row__metric-level efr-vol-row__metric-level--red',
    ]);

    const chart = within(row).getByLabelText('VIX volatility from six months ago to 7/15');
    expect(Array.from(chart.querySelectorAll('.efr-vol-sparkline__regime-band')).map((band) => band.className.baseVal))
      .toEqual([
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--green',
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--yellow',
        'efr-vol-sparkline__regime-band efr-vol-sparkline__regime-band--red',
      ]);
    const segments = Array.from(chart.querySelectorAll('.efr-vol-sparkline__segment'));
    expect(segments.map((segment) => segment.className.baseVal))
      .toEqual([
        'efr-vol-sparkline__segment is-falling',
        'efr-vol-sparkline__segment is-falling',
        'efr-vol-sparkline__segment is-falling',
        'efr-vol-sparkline__segment is-rising',
        'efr-vol-sparkline__segment is-flat',
      ]);
  });

});

describe('USD-first currency normalization', () => {
  test('uses exact reciprocal price and return math without mutating provider data', () => {
    const source = {
      symbol: 'EURUSD',
      name: 'EUR/USD',
      price: 1.25,
      change: 0.1,
      changePercent: 10,
      fifteenDayChangePct: 5,
      weekChangePct: -10,
      monthChangePct: -15,
      threeMonthChangePct: 25,
      sixMonthChangePct: -30,
      thirtyDayChangePct: -20,
      ytdChangePct: 0,
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      sourceStatus: 'current',
      quoteAsOf: '2026-07-15T19:50:00.000Z',
      periodReturnsAsOf: '2026-07-14',
      periodReturnsStatus: 'historical',
    };
    const sourceSnapshot = { ...source };

    const normalized = normalizeUsdFirstCurrencyRow(source);

    expect(source).toEqual(sourceSnapshot);
    expect(normalized).not.toBe(source);
    expect(normalized.symbol).toBe('EURUSD');
    expect(normalized.name).toBe('USD/EUR');
    expect(normalized.price).toBeCloseTo(0.8, 10);
    expect(normalized.change).toBeNull();
    expect(normalized.changePercent).toBeCloseTo(-9.0909090909, 8);
    expect(normalized.fifteenDayChangePct).toBeCloseTo(-4.7619047619, 8);
    expect(normalized.weekChangePct).toBeCloseTo(11.1111111111, 8);
    expect(normalized.monthChangePct).toBeCloseTo(17.6470588235, 8);
    expect(normalized.threeMonthChangePct).toBeCloseTo(-20, 8);
    expect(normalized.sixMonthChangePct).toBeCloseTo(42.8571428571, 8);
    expect(normalized.thirtyDayChangePct).toBeCloseTo(25, 10);
    expect(normalized.ytdChangePct).toBe(0);
    expect(normalized).toEqual(expect.objectContaining({
      availability: 'delayed',
      source: 'yahoo',
      dataType: 'delayed',
      freshness: 'current',
      sourceStatus: 'current',
      quoteAsOf: '2026-07-15T19:50:00.000Z',
      periodReturnsAsOf: '2026-07-14',
      periodReturnsStatus: 'historical',
    }));
  });

  test('leaves USD-base pairs and dollar benchmarks unchanged', () => {
    const usdJpy = { symbol: 'USDJPY', name: 'USD/JPY', price: 162, changePercent: 1 };
    const dxy = { symbol: 'USD', name: 'DXY', price: 100, changePercent: 0.2 };
    const uup = { symbol: 'UUP', name: 'UUP', price: 28, changePercent: 0.1 };

    expect(normalizeUsdFirstCurrencyRow(usdJpy)).toBe(usdJpy);
    expect(normalizeUsdFirstCurrencyRow(dxy)).toBe(dxy);
    expect(normalizeUsdFirstCurrencyRow(uup)).toBe(uup);
  });

  test('fails closed for invalid reciprocal inputs and impossible returns', () => {
    const normalized = normalizeUsdFirstCurrencyRow({
      symbol: 'GBPUSD',
      name: 'GBP/USD',
      price: 0,
      changePercent: 3,
      availability: 'delayed',
      source: 'yahoo',
    });

    expect(normalized).toEqual(expect.objectContaining({
      name: 'USD/GBP',
      price: null,
      change: null,
      changePercent: null,
      availability: 'unavailable',
    }));
    expect(invertPercentageReturn(-100)).toBeNull();
    expect(invertPercentageReturn('bad')).toBeNull();
    expect(invertPercentageReturn(0)).toBe(0);
  });

  test('preserves stale source diagnostics instead of laundering the quote state', () => {
    const normalized = normalizeUsdFirstCurrencyRow({
      symbol: 'AUDUSD',
      name: 'AUD/USD',
      price: 0.7,
      changePercent: 1,
      availability: 'delayed',
      freshness: 'stale',
      sourceStatus: 'stale',
      source: 'yahoo',
      quoteAsOf: '2026-07-10T19:50:00.000Z',
    });

    expect(normalized).toEqual(expect.objectContaining({
      name: 'USD/AUD',
      availability: 'delayed',
      freshness: 'stale',
      sourceStatus: 'stale',
      source: 'yahoo',
      quoteAsOf: '2026-07-10T19:50:00.000Z',
    }));
  });
});
