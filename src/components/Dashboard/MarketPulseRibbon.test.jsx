import React, { act } from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import MarketPulseRibbon, {
  PULSE_CATEGORIES,
  PULSE_ROTATION_MS,
  selectTopMovers,
} from './MarketPulseRibbon';

jest.mock('./RadarReferencePanels', () => ({
  getRowQuoteStatus: (row) => {
    if (row?.freshness && row.freshness !== 'current') return 'unavailable';
    if (row?.availability === 'current') return 'live';
    if (row?.availability === 'delayed') return 'delayed';
    if (row?.availability === 'historical') return 'historical';
    return 'unavailable';
  },
}));

const quote = (symbol, price, changePercent, overrides = {}) => ({
  symbol,
  price,
  changePercent,
  availability: 'delayed',
  dataType: 'delayed',
  source: 'yahoo',
  timestamp: '2026-07-14T20:00:00.000Z',
  quoteAsOf: '2026-07-14T20:00:00.000Z',
  sparklineData: [Number(price) - 1, Number(price) - 0.5, Number(price)],
  ...overrides,
});

const currentVol = (lastPx, overrides = {}) => ({
  lastPx,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cboe',
  ...overrides,
});

const historicalMove = (lastPx = 92.4) => ({
  lastPx,
  availability: 'historical',
  freshness: 'historical',
  quoteMode: 'end-of-day',
  source: 'yahoo',
});

const rankedMarketData = () => ({
  us: [
    quote('SPX', 7543.59, 0.5),
    quote('QQQ', 711.74, 2.2),
    quote('RUT', 2962.61, -1.1),
  ],
  sectors: [quote('XLV', 145.2, -3.4)],
  rates: {
    us_treasuries: [
      quote('UST2Y', 4.32, -9, { unit: 'yield' }),
      quote('UST10Y', 4.58, -0.65, { unit: 'yield' }),
      quote('UST30Y', 5.09, -0.2, { unit: 'yield' }),
    ],
    credit: [
      quote('LQD', 107.21, 0.23, { unit: 'price' }),
      quote('HYG', 79.68, 0.2, { unit: 'price' }),
    ],
  },
  commodities: [
    quote('BZ', 85.54, 2.69),
    quote('CL', 79.95, 2.32),
    quote('SI', 59, 1.78),
    quote('GC', 4057.2, 12),
  ],
  crypto: [
    quote('BTC', 64499.98, 3.6),
    quote('ETH', 1874.5, 5.66),
    quote('SOL', 77.09, 2.97),
    quote('XRP', 1.11, 20),
    quote('BNB', 579.69, 18),
    quote('ADA', 0.16, 15),
  ],
  currencies: [quote('USD', 100.94, 25)],
});

describe('MarketPulseRibbon', () => {
  test('shows four asset-class cards using universe labels and the top three verified movers', () => {
    render(<MarketPulseRibbon marketData={rankedMarketData()} />);

    const equities = screen.getByLabelText('Equities market pulse');
    const rates = screen.getByLabelText('Rates market pulse');
    const commodities = screen.getByLabelText('Commodities market pulse');
    const crypto = screen.getByLabelText('Crypto market pulse');

    expect(within(equities).getByRole('heading')).toHaveTextContent('U.S. Healthcare Sector (XLV)');
    expect(within(equities).getByText('XLV', { exact: true })).toHaveClass('efr-pulse-metric__ticker');
    expect(within(rates).getByRole('heading')).toHaveTextContent('10-Year U.S. Treasury Yield');
    expect(within(rates).getByText('UST10Y', { exact: true })).toHaveClass('efr-pulse-metric__ticker');
    expect(within(commodities).getByRole('heading')).toHaveTextContent('Brent Crude Oil Continuous Contract');
    expect(within(commodities).getByText('BRENT', { exact: true })).toHaveClass('efr-pulse-metric__ticker');
    expect(within(crypto).getByRole('heading')).toHaveTextContent('Ethereum');
    expect(within(crypto).getByText('ETH', { exact: true })).toHaveClass('efr-pulse-metric__ticker');

    const equityChart = within(equities).getByRole('img', { name: 'U.S. Healthcare Sector (XLV) intraday sparkline for 7/14' });
    expect(equityChart.querySelector('.efr-pulse-sparkline__x-axis')).toBeInTheDocument();
    expect(equityChart.querySelector('.efr-pulse-sparkline__y-axis')).toBeInTheDocument();
    expect(equityChart).toHaveTextContent('OPEN');
    expect(equityChart).toHaveTextContent('7/14');
    expect(equityChart).toHaveTextContent('CLOSE');
    expect(equityChart).not.toHaveTextContent('START');
    expect(equityChart).not.toHaveTextContent('LAST');

    expect(screen.queryByText(/TOP \d\/3/)).not.toBeInTheDocument();
    expect(within(equities).queryByText('Equities')).not.toBeInTheDocument();

    expect(screen.queryByText('DXY')).not.toBeInTheDocument();
    expect(screen.queryByText('U.S. Dollar Index')).not.toBeInTheDocument();
    expect(screen.queryByText('Binance Coin')).not.toBeInTheDocument();
    expect(screen.queryByText('Ripple')).not.toBeInTheDocument();
  });

  test('rotates one card at a time left to right through its ranked movers', () => {
    jest.useFakeTimers();
    const { unmount } = render(
      <MarketPulseRibbon
        marketData={{
          us: [
            quote('SPX', 7500, 3),
            quote('QQQ', 700, 2),
            quote('RUT', 2900, 1),
          ],
          rates: {
            us_treasuries: [
              quote('UST10Y', 4.5, -0.8, { unit: 'yield' }),
              quote('UST30Y', 4.9, -0.5, { unit: 'yield' }),
            ],
          },
        }}
      />,
    );
    const equities = screen.getByLabelText('Equities market pulse');
    const rates = screen.getByLabelText('Rates market pulse');

    expect(within(equities).getByRole('heading')).toHaveTextContent('S&P 500');
    expect(within(rates).getByRole('heading')).toHaveTextContent('10-Year U.S. Treasury');

    act(() => jest.advanceTimersByTime(PULSE_ROTATION_MS));
    expect(within(equities).getByRole('heading')).toHaveTextContent('Nasdaq 100 (QQQ)');
    expect(within(rates).getByRole('heading')).toHaveTextContent('10-Year U.S. Treasury');

    act(() => jest.advanceTimersByTime(PULSE_ROTATION_MS));
    expect(within(equities).getByRole('heading')).toHaveTextContent('Nasdaq 100 (QQQ)');
    expect(within(rates).getByRole('heading')).toHaveTextContent('30-Year U.S. Treasury');

    act(() => jest.advanceTimersByTime(PULSE_ROTATION_MS * 3));
    expect(within(equities).getByRole('heading')).toHaveTextContent('Russell 2000');

    unmount();
    jest.useRealTimers();
  });

  test('excludes stale, historical, mismatched, and unapproved crypto rows from ranking', () => {
    const equities = PULSE_CATEGORIES.find(({ id }) => id === 'equities');
    const crypto = PULSE_CATEGORIES.find(({ id }) => id === 'crypto');
    const marketData = {
      us: [
        quote('SPX', 7500, 1),
        quote('QQQ', 700, 9, { freshness: 'stale' }),
        quote('RUT', 2900, 8, { availability: 'historical', dataType: 'historical' }),
        quote('NOT_IN_UNIVERSE', 10, 20),
      ],
      crypto: [
        quote('ETH', 1800, 5),
        quote('BTC', 64000, 3),
        quote('SOL', 77, 2),
        quote('XRP', 1.1, 25),
        quote('BNB', 580, 20),
      ],
    };

    expect(selectTopMovers(marketData, equities).map(({ ticker }) => ticker)).toEqual(['SPX']);
    expect(selectTopMovers(marketData, crypto).map(({ ticker }) => ticker))
      .toEqual(['ETH', 'BTC', 'SOL']);
  });

  test('withholds an intraday chart when its verified quote date is missing', () => {
    render(
      <MarketPulseRibbon
        marketData={{
          us: [quote('SPX', 7500, 1, { quoteAsOf: null, timestamp: null })],
        }}
      />,
    );

    expect(screen.getByLabelText('S&P 500 intraday series unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /S&P 500 intraday sparkline/ })).not.toBeInTheDocument();
  });

  test('pairs supported movers with their exact volatility measure', () => {
    render(
      <MarketPulseRibbon
        marketData={{
          us: [quote('QQQ', 711.74, 3)],
          rates: { us_treasuries: [quote('UST10Y', 4.58, -0.65, { unit: 'yield' })] },
          commodities: [quote('CL', 79.95, 2.32)],
          crypto: [quote('BTC', 64499.98, 3.6)],
        }}
        volatilityState={{
          snapshot: {
            VIX: currentVol(16.57),
            NazVol: currentVol(22.2),
            MOVE: historicalMove(),
            OVX: currentVol(61.15),
          },
        }}
      />,
    );

    const equities = screen.getByLabelText('Equities market pulse');
    const rates = screen.getByLabelText('Rates market pulse');
    const commodities = screen.getByLabelText('Commodities market pulse');
    const crypto = screen.getByLabelText('Crypto market pulse');

    expect(within(equities).getByLabelText(/VXN volatility 22\.20/)).toHaveTextContent('VXN22.20D');
    expect(within(equities).queryByText('VIX')).not.toBeInTheDocument();
    expect(within(rates).getByLabelText(/MOVE volatility 92\.40/))
      .toHaveClass('efr-pulse-vol--historical');
    expect(within(rates).getByLabelText(/MOVE volatility 92\.40/)).toHaveTextContent('MOVE92.40DCLOSE');
    expect(within(commodities).getByLabelText(/OVX volatility 61\.15/)).toBeInTheDocument();
    expect(within(crypto).queryByLabelText(/volatility/)).not.toBeInTheDocument();
  });

  test('keeps a one-minute-old retained volatility callout visible without D yet', () => {
    const now = Date.now();
    render(
      <MarketPulseRibbon
        marketData={{ us: [quote('QQQ', 711.74, 3)] }}
        volatilityState={{
          snapshot: {
            NazVol: currentVol(22.2, {
              availability: 'reference',
              freshness: 'refresh-delayed',
              refreshDelayed: true,
              lastVerifiedAt: new Date(now - 60 * 1000).toISOString(),
              retainedUntil: new Date(now + 29 * 60 * 1000).toISOString(),
            }),
          },
        }}
      />,
    );

    const metric = screen.getByLabelText(/VXN volatility 22\.20/);
    expect(metric).toHaveClass('efr-pulse-vol--refresh-delayed');
    expect(metric).toHaveTextContent('VXN22.20');
    expect(metric).not.toHaveTextContent('D');
    expect(within(metric).queryByRole('button', { name: /refresh delayed/i }))
      .not.toBeInTheDocument();
  });

  test('never promotes stale or unavailable volatility values', () => {
    render(
      <MarketPulseRibbon
        marketData={{
          us: [quote('SPX', 7543.59, 0.5)],
          rates: { us_treasuries: [quote('UST10Y', 4.58, -0.65, { unit: 'yield' })] },
        }}
        volatilityState={{
          snapshot: {
            VIX: currentVol(16.57, { freshness: 'stale' }),
            MOVE: { ...historicalMove(), availability: 'unavailable' },
          },
        }}
      />,
    );

    expect(screen.getByLabelText('VIX volatility unavailable')).toHaveTextContent('VIX—NO DATA');
    expect(screen.getByLabelText('MOVE volatility unavailable')).toHaveTextContent('MOVE—CLOSE');
    expect(screen.queryByText('16.57')).not.toBeInTheDocument();
    expect(screen.queryByText('92.40')).not.toBeInTheDocument();
  });

  test('keeps the last verified values visible during a background refresh', () => {
    const marketData = { us: [quote('SPX', 7543.59, 0.5)] };
    const { rerender } = render(
      <MarketPulseRibbon marketData={marketData} marketDataLoading={false} />,
    );

    rerender(<MarketPulseRibbon marketData={marketData} marketDataLoading />);

    const equities = screen.getByLabelText('Equities market pulse');
    expect(equities).toHaveTextContent('7,543.59');
    expect(within(equities).getByRole('button', { name: /Delayed quote · as of/i }))
      .toHaveTextContent('D');
    expect(equities).not.toHaveTextContent('DLY');
    expect(equities).not.toHaveTextContent('LOAD');
  });
});
