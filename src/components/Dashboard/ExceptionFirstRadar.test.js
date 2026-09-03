import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar, {
  BACKDROP_GROUPS,
  invertPercentageReturn,
  normalizeUsdFirstCurrencyRow,
} from './ExceptionFirstRadar';
import VolatilityMetricRow, { buildVolatilityMetricChart } from './VolatilityMetricRow';
import { VOL_RANGES } from '../../utils/volatilityRegimes';
import {
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
} from './dashboardStatus';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
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
    default: ({ currencyPanel, correlationStatus }) => (
      <div data-testid="usd-matrix">
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
  getRowQuoteStatus: (row) => (
    row?.availability === 'reference' ? 'delayed' : row?.availability || 'unavailable'
  ),
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

describe('Exception-First header', () => {
  test('uses the fixed 43-row long/short macro roster in category order', () => {
    expect(BACKDROP_GROUPS.map(({ id }) => id)).toEqual([
      'us', 'europe', 'asia', 'commodities', 'rates', 'crypto',
    ]);
    expect(BACKDROP_GROUPS.flatMap(({ rows }) => rows.map(({ symbols }) => symbols[0]))).toEqual([
      'SPX', 'RSP', 'DJI', 'IXIC', 'RUT', 'QQQ', 'SMH',
      'STOXX600', 'SX5E', 'FTSE', 'CAC', 'DAX', 'N100',
      'N225', 'HSI', 'CSI300', 'SSEC', 'KOSPI', 'TAIEX', 'NIFTY50', 'AXJO',
      'CRB', 'BZ', 'CL', 'NG', 'GC', 'SI', 'HG', 'PL', 'ZC',
      'UST2Y', 'UST5Y', 'UST10Y', 'UST30Y', 'CURVE_2s10s', 'BUND10Y', 'IG_OAS', 'HY_OAS',
      'BTC', 'ETH', 'BNB', 'XRP', 'SOL',
    ]);
    expect(BACKDROP_GROUPS.flatMap(({ rows }) => rows)).toHaveLength(43);
  });

  test('replaces the title with the market pulse ribbon', () => {
    render(<ExceptionFirstRadar />);

    expect(screen.getByLabelText('Market pulse ribbon')).toBeInTheDocument();
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
    const volatilityCard = screen.getByRole('region', { name: 'Volatility · 3M Map' });
    const vixRow = screen.getByLabelText('VIX current volatility');

    rerender(
      <ExceptionFirstRadar
        marketData={marketData}
        volatilityState={{ snapshot: { VIX: CURRENT_VIX }, refreshing: true }}
      />,
    );

    expect(screen.queryByText(/Refreshing verified market data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Refreshing verified volatility data/i)).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /S&P 500/ })).toHaveTextContent('7,463.63');
    expect(screen.getByLabelText('VIX volatility from six months ago to 7/15')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Volatility · 3M Map' })).toBe(volatilityCard);
    expect(screen.getByLabelText('VIX current volatility')).toBe(vixRow);
  });

  test('keeps a one-minute-old volatility reference visible without marking it delayed yet', () => {
    const now = Date.now();
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
              lastVerifiedAt: new Date(now - 60 * 1000).toISOString(),
              retainedUntil: new Date(now + 29 * 60 * 1000).toISOString(),
            },
          },
        }}
      />,
    );

    const row = screen.getByLabelText('VXN last verified volatility; refresh delayed');
    expect(row).toHaveClass('is-refresh-delayed');
    expect(within(row).getByText('21.51')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Refresh delayed · last verified/i }))
      .not.toBeInTheDocument();
    expect(within(row).queryByText('NO LIVE SERIES')).not.toBeInTheDocument();
  });

  test('applies the shared two-minute D threshold to a Yahoo Nasdaq quote', () => {
    const now = Date.now();
    const nasdaq = {
      symbol: 'IXIC',
      name: 'Nasdaq',
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
    expect(priceCell).toHaveAttribute('data-source', 'yahoo');
    expect(priceCell).toHaveAttribute('data-availability', 'delayed');
    expect(within(priceCell).queryByRole('button', { name: /Delayed quote/i }))
      .not.toBeInTheDocument();

    rerender(<ExceptionFirstRadar marketData={{
      us: [{ ...nasdaq, quoteAsOf: new Date(now - 121 * 1000).toISOString() }],
    }} />);

    row = screen.getByRole('row', { name: /Nasdaq/ });
    priceCell = within(row).getAllByRole('cell')[1];
    expect(within(priceCell).getByRole('button', { name: /Delayed quote/i }))
      .toHaveTextContent('D');
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
    expect(screen.getByRole('row', { name: /S&P 500/ })).toHaveTextContent('7,463.63');
    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.65');

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
        'TICKER', 'PRICE', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y',
      ]);
    expect(Array.from(currencySheet.querySelectorAll('thead th'))
      .every((header) => header.classList.contains('usd-currency-spreadsheet__header')))
      .toBe(true);
    const currencyRows = Array.from(currencySheet.querySelectorAll('tbody tr'));
    expect(currencyRows.every((row) => row.children.length === 18)).toBe(true);
    expect(currencyRows.map((row) => row.children[0].textContent))
      .toEqual(['DXY', 'UUP', 'USD/EUR', 'USD/JPY', 'USD/GBP']);
    expect(currencyRows.map((row) => row.children[9].textContent))
      .toEqual(['USD/AUD', 'USD/CAD', 'USD/MXN', 'USD/CHF', 'USD/CNY']);
    expect(currencyRows[0]).toHaveTextContent('DXY100.75D0.02%1.23%2.34%3.45%4.56%5.67%6.78%');
    expect(currencyRows[0].children[1].textContent).toBe('100.75D');
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

  test('uses compact side rails and verified multi-horizon backdrop returns', () => {
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
                symbol: 'UST30Y',
                price: 5.06,
                changePercent: -0.78,
                fifteenDayChangePct: 4.2,
                monthChangePct: -1.2,
                threeMonthChangePct: 2.7,
                sixMonthChangePct: 5.6,
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
                fifteenDayChangePct: -2.52,
                monthChangePct: -1.5,
                threeMonthChangePct: -4.91,
                sixMonthChangePct: -10.4,
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
      .toHaveTextContent('EU');
    expect(within(usSection).getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['ASSET', 'Price', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y']);
    expect(within(usSection).queryByText('Data')).not.toBeInTheDocument();
    expect(backdrop).toHaveAttribute('data-status', 'delayed');
    expect(within(backdrop).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Market Backdrop' })).not.toBeInTheDocument();

    const spxRow = within(usSection).getByRole('row', { name: /S&P 500/ });
    const spxCells = within(spxRow).getAllByRole('cell');
    ['S&P 500', '7,463.63', '1.25%', '2.50%', '3.50%', '9.75%', '12.25%', '0.00%', '22.75%'].forEach((value, index) => {
      expect(spxCells[index]).toHaveTextContent(value);
    });
    expect(spxCells[2]).toHaveClass('is-positive');
    expect(spxCells[3]).toHaveClass('is-negative');
    expect(spxCells[7]).toHaveClass('is-neutral');
    expect(spxCells[3]).toHaveAttribute('title', 'Historical return as of 2026-07-16T00:00:00.000Z');
    expect(spxCells[1]).toHaveAttribute(
      'title',
      'Yahoo Finance · delayed · as of 2026-07-16T20:00:00.000Z · ibkr: stale_quote; delayed_data',
    );
    expect(spxCells[1]).toHaveAttribute('data-source', 'yahoo');
    expect(spxCells[1]).toHaveAttribute('data-availability', 'delayed');
    expect(spxCells[1]).toHaveAttribute('data-quote-status', 'delayed');
    expect(within(spxCells[1]).getByRole('button', {
      name: /Delayed quote · as of 2026-07-16T20:00:00.000Z/,
    })).toHaveTextContent('D');

    const marketBackdropStatus = onDashboardStatusChange.mock.calls.at(-1)[0]
      .find(({ id }) => id === 'market-backdrop');
    expect(marketBackdropStatus.diagnostics).toEqual(expect.arrayContaining([
      { label: 'Providers', value: expect.stringContaining('Yahoo Finance delayed') },
      { label: 'As of', value: '2026-07-16T20:00:00.000Z' },
    ]));

    const unavailableRow = within(usSection).getByRole('row', { name: /Dow 30/ });
    const unavailableCells = within(unavailableRow).getAllByRole('cell');
    ['Dow 30', '—', '—', '—', '—', '—', '—', '—', '—'].forEach((value, index) => {
      expect(unavailableCells[index]).toHaveTextContent(value);
    });

    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /Copper/ }))
      .toHaveTextContent('Copper6.26D1.10%3.19%1.75%3.26%12.10%——');
    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /WTI Oil/ }))
      .toHaveTextContent('WTI Oil81.46D3.80%13.26%8.40%13.97%6.20%——');
    const hyOasRow = within(screen.getByRole('region', { name: 'Rates' })).getByRole('row', { name: /HY OAS/ });
    expect(hyOasRow).toHaveTextContent('HY OAS2.71D1.20%2.52%1.50%4.91%10.40%——');
    expect(within(hyOasRow).getByRole('button', { name: /Historical reference/i }))
      .toHaveTextContent('D');
    expect(within(screen.getByRole('region', { name: 'Rates' })).getByRole('row', { name: /UST 30Y/ }))
      .toHaveTextContent('UST 30Y5.060D0.78%4.20%1.20%2.70%5.60%——');
    expect(within(screen.getByRole('region', { name: 'Crypto' })).getByRole('row', { name: /Solana/ }))
      .toHaveTextContent('Solana / USD75.22D0.50%6.73%2.40%15.67%20.10%——');
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
    const priceCell = within(row).getAllByRole('cell')[1];
    expect(priceCell).toHaveTextContent('7,669.22');
    expect(priceCell).toHaveAttribute('data-quote-status', 'delayed');
    expect(within(priceCell).getByRole('button', {
      name: /Refresh delayed · last verified 2026-09-02T17:01:49.771Z/,
    })).toHaveTextContent('D');
  });

  test('renders the derived 2s10s row in basis points', () => {
    render(
      <ExceptionFirstRadar
        marketData={{
          rates: {
            us_treasuries: [{
              symbol: 'CURVE_2s10s',
              price: '-42.5',
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

    const row = within(screen.getByRole('region', { name: 'Rates' }))
      .getByRole('row', { name: /2s10s Curve/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual([
      '2s10s Curve', '-42.5 bpsD', '1.2 bps', '3.4 bps', '5.6 bps',
      '7.8 bps', '9.1 bps', '2.3 bps', '4.5 bps',
    ]);
    expect(cells[2]).toHaveClass('is-positive');
    expect(cells[3]).toHaveClass('is-negative');
  });

  test('renders a scaled volatility chart with aligned axes', () => {
    const { container } = render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    const volatilityCard = screen.getByRole('region', { name: 'Volatility · 3M Map' });
    expect(within(volatilityCard).queryByRole('heading', { name: 'Volatility · 3M Map' }))
      .not.toBeInTheDocument();
    expect(volatilityCard).toHaveAttribute('data-status', 'mixed');
    expect(within(volatilityCard).queryByRole('button', { name: /status details/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exceptions Now' })).not.toBeInTheDocument();
    const seriesGrid = within(volatilityCard).getByRole('group', { name: '8 volatility series' });
    expect(seriesGrid).toHaveStyle('--efr-vol-row-count: 8');
    expect(within(seriesGrid).getAllByRole('article')).toHaveLength(8);
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
      <ExceptionFirstRadar
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
      <ExceptionFirstRadar
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

    expect(screen.getByLabelText('VIX current volatility')).toHaveTextContent('16.65');
    expect(screen.getByLabelText('VIX volatility from six months ago to 7/15')).toBeInTheDocument();
    expect(screen.queryByText('Loading current volatility data…')).not.toBeInTheDocument();
  });

  test('does not render stale volatility values as current data', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, freshness: 'stale' } } }} />);

    expect(screen.getByLabelText('VIX volatility data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('16.65')).not.toBeInTheDocument();
  });

  test('does not render volatility values without a verified observation date', () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, asOf: null } } }} />);

    expect(screen.getByLabelText('VIX volatility data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('16.65')).not.toBeInTheDocument();
  });

  test('colors current VIX values by their regime', () => {
    const { rerender } = render(
      <ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 16.56 } } }} />,
    );
    const greenRow = screen.getByLabelText('VIX current volatility');
    expect(within(greenRow).getByText('16.56'))
      .toHaveClass('efr-vol-regime-value--green');
    expect(within(greenRow).getByText('<20')).toBeInTheDocument();

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 20 } } }} />);
    const orangeRow = screen.getByLabelText('VIX current volatility');
    expect(within(orangeRow).getByText('20.00'))
      .toHaveClass('efr-vol-regime-value--yellow');
    expect(within(orangeRow).getByText('20–29')).toBeInTheDocument();

    rerender(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: { ...CURRENT_VIX, lastPx: 40 } } }} />);
    const redRow = screen.getByLabelText('VIX current volatility');
    expect(within(redRow).getByText('40.00'))
      .toHaveClass('efr-vol-regime-value--red');
    expect(within(redRow).getByText('29+')).toBeInTheDocument();
  });

  test('opens a centered fundamental explainer from every volatility ticker', async () => {
    render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    ['VIX', 'VVIX', 'RVX', 'VXN', 'GVZ', 'OVX', 'BITVX', 'MOVE'].forEach((symbol) => {
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
    expect(within(row).getByText('92.40')).toHaveClass('efr-vol-regime-value--green');
    expect(within(row).getByText('<100')).toBeInTheDocument();
    expect(within(row).getByLabelText('MOVE volatility from six months ago to close')).toBeInTheDocument();
  });

  test('uses green, red, and neutral direction colors for metrics and chart segments', () => {
    render(
      <ExceptionFirstRadar
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
