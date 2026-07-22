import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar, {
  invertPercentageReturn,
  normalizeUsdFirstCurrencyRow,
} from './ExceptionFirstRadar';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
jest.mock('./USDCorrelationMatrix', () => ({ currencyPanel, correlationStatus }) => (
  <div data-testid="usd-matrix">
    {currencyPanel}
    {correlationStatus}
  </div>
));
jest.mock('./RadarReferencePanels', () => ({
  __esModule: true,
  default: () => null,
  aggregateQuoteStatus: () => 'delayed',
  CurrenciesPreview: ({ ariaLabel, rows, maxRows = 5 }) => (
    <div aria-label={ariaLabel}>{(rows || []).slice(0, maxRows).map(({ name }) => name).join(', ')}</div>
  ),
  getRowQuoteStatus: (row) => row?.availability || 'unavailable',
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
    availability: 'delayed',
    periodReturnsStatus: 'historical',
    periodReturnsAsOf: '2026-07-14',
  },
  { symbol: 'UUP', name: 'UUP' },
];

describe('Exception-First header', () => {
  test('replaces the title with the market pulse ribbon', () => {
    render(<ExceptionFirstRadar />);

    expect(screen.getByLabelText('Market pulse ribbon')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exception-First Radar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dashboard data status')).not.toBeInTheDocument();
  });

  test('composes currencies and correlation status inside the USD card', () => {
    render(
      <ExceptionFirstRadar
        marketData={{ currencies: USD_CURRENCY_ROWS }}
        correlationState={{
          correlations: { SPX: {} },
          rollingStats: { SPX: {} },
          calculationDate: '2026-07-14',
        }}
      />,
    );

    const usdCard = screen.getByLabelText('USD');
    expect(within(usdCard).getByRole('heading', { name: 'Currencies · USD First' })).toBeInTheDocument();
    const currencySheet = within(usdCard).getByRole('table', { name: 'USD currency spreadsheet' });
    expect(currencySheet).toHaveTextContent('Dollar & Majors');
    expect(currencySheet).toHaveTextContent('USD Crosses');
    expect(Array.from(currencySheet.querySelectorAll('thead tr:last-child th')).map(({ textContent }) => textContent))
      .toEqual([
        'Ticker', 'Price', 'D', '15D', '1M', '3M', '6M',
        'Ticker', 'Price', 'D', '15D', '1M', '3M', '6M',
      ]);
    const currencyRows = Array.from(currencySheet.querySelectorAll('tbody tr'));
    expect(currencyRows.every((row) => row.children.length === 14)).toBe(true);
    expect(currencyRows.map((row) => row.children[0].textContent))
      .toEqual(['DXY', 'UUP', 'USD/EUR', 'USD/JPY', 'USD/GBP']);
    expect(currencyRows.map((row) => row.children[7].textContent))
      .toEqual(['USD/AUD', 'USD/CAD', 'USD/MXN', 'USD/CHF', 'USD/CNY']);
    expect(currencyRows[0]).toHaveTextContent('DXY100.75-0.02%+1.23%+2.34%+3.45%+4.56%');
    expect(within(usdCard).queryByRole('table', { name: 'Dollar & Majors currency instruments' })).not.toBeInTheDocument();
    expect(within(usdCard).queryByRole('table', { name: 'USD Crosses currency instruments' })).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('NZD/USD')).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('EUR/GBP')).not.toBeInTheDocument();
    const statusIndicator = within(usdCard).getByLabelText(
      'USD DATA · CURRENCIES DELAYED · CORRELATIONS AS OF JUL 14',
    );
    expect(statusIndicator).toHaveAttribute('data-status', 'mixed');
    expect(statusIndicator).toHaveClass('efr-status-chip--indicator-only', 'efr-status-chip--delayed');
    expect(statusIndicator).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(statusIndicator);
    const statusDialog = screen.getByRole('dialog', { name: 'USD Data data status' });
    expect(within(statusDialog).getByText('Sources have mixed freshness or availability; see the counts below.'))
      .toBeInTheDocument();
    expect(within(statusDialog).getByText('CURRENCIES DELAYED · CORRELATIONS AS OF JUL 14'))
      .toBeInTheDocument();
    expect(within(usdCard).queryByText('DELAYED')).not.toBeInTheDocument();
    expect(within(usdCard).queryByText('AS OF · JUL 14')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('USD correlations')).not.toBeInTheDocument();
  });

  test('uses compact side rails and verified multi-horizon backdrop returns', () => {
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
              availability: 'delayed',
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
      />,
    );

    const backdrop = screen.getByRole('region', { name: 'Market Backdrop' });
    const usSection = within(backdrop).getByRole('region', { name: 'US' });
    expect(within(usSection).getByRole('heading', { name: 'US' })).toHaveTextContent('US');
    expect(within(screen.getByRole('region', { name: 'Europe' })).getByRole('heading', { name: 'Europe' }))
      .toHaveTextContent('EU');
    expect(within(usSection).getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['Index', 'Price', 'D', '15D', '1M', '3M', '6M']);
    expect(within(usSection).queryByText('Data')).not.toBeInTheDocument();
    expect(within(backdrop).getByLabelText('DELAYED'))
      .toHaveClass('efr-status-chip--indicator-only', 'efr-status-chip--delayed');
    expect(within(backdrop).queryByText('DELAYED')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Market Backdrop' })).not.toBeInTheDocument();

    const spxRow = within(usSection).getByRole('row', { name: /S&P 500/ });
    const spxCells = within(spxRow).getAllByRole('cell');
    ['S&P 500', '7,463.63', '+1.25%', '-2.50%', '+3.50%', '+9.75%', '+12.25%'].forEach((value, index) => {
      expect(spxCells[index]).toHaveTextContent(value);
    });
    expect(spxCells[3]).toHaveAttribute('title', 'Historical return as of 2026-07-16T00:00:00.000Z');

    const unavailableRow = within(usSection).getByRole('row', { name: /Dow 30/ });
    const unavailableCells = within(unavailableRow).getAllByRole('cell');
    ['Dow 30', '—', '—', '—', '—', '—', '—'].forEach((value, index) => {
      expect(unavailableCells[index]).toHaveTextContent(value);
    });

    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /Copper/ }))
      .toHaveTextContent('Copper6.26-1.10%+3.19%+1.75%+3.26%+12.10%');
    expect(within(screen.getByRole('region', { name: 'Commodities' })).getByRole('row', { name: /WTI Oil/ }))
      .toHaveTextContent('WTI Oil81.46+3.80%+13.26%+8.40%-13.97%-6.20%');
    expect(within(screen.getByRole('region', { name: 'Rates' })).getByRole('row', { name: /HY OAS/ }))
      .toHaveTextContent('HY OAS2.71+1.20%-2.52%-1.50%-4.91%-10.40%');
    expect(within(screen.getByRole('region', { name: 'Rates' })).getByRole('row', { name: /UST 30Y/ }))
      .toHaveTextContent('UST 30Y5.060-0.78%+4.20%-1.20%+2.70%+5.60%');
    expect(within(screen.getByRole('region', { name: 'Crypto' })).getByRole('row', { name: /Solana/ }))
      .toHaveTextContent('Solana / USD75.22-0.50%-6.73%-2.40%-15.67%+20.10%');
  });

  test('renders a scaled volatility chart with aligned axes', () => {
    const { container } = render(<ExceptionFirstRadar volatilityState={{ snapshot: { VIX: CURRENT_VIX } }} />);

    const volatilityCard = screen.getByRole('region', { name: 'Volatility · 3M Map' });
    expect(within(volatilityCard).queryByRole('heading', { name: 'Volatility · 3M Map' }))
      .not.toBeInTheDocument();
    expect(within(volatilityCard).getByLabelText('MIXED / DELAYED'))
      .toHaveClass('efr-status-chip--indicator-only', 'efr-status-chip--delayed');
    expect(within(volatilityCard).getByLabelText('MIXED / DELAYED'))
      .toHaveAttribute('data-status', 'mixed');
    expect(within(volatilityCard).queryByText('MIXED / DELAYED')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Exceptions Now' })).not.toBeInTheDocument();
    const chart = screen.getByLabelText('VIX volatility from six months ago to 7/15');
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('.efr-vol-sparkline__y-tick text')).toHaveLength(3);
    expect(chart.querySelector('.efr-vol-sparkline__y-axis')).toBeInTheDocument();

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

  test('renders retained historical MOVE with its observation date, not the dashboard refresh date', () => {
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
    expect(within(row).getByText('AS OF JUL 10')).toBeInTheDocument();
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
