import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import MarketPulseRibbon from './MarketPulseRibbon';

jest.mock('./RadarReferencePanels', () => ({
  getRowQuoteStatus: (row) => row?.availability === 'delayed' ? 'delayed' : 'unavailable',
}));

const quote = (symbol, price, changePercent) => ({
  symbol,
  price,
  changePercent,
  availability: 'delayed',
  dataType: 'delayed',
  source: 'yahoo',
  timestamp: '2026-07-14T14:15:00.000Z',
  sparklineData: [price - 1, price - 0.5, price],
});

const currentVix = {
  lastPx: 16.57,
  day1Ago: 17.18,
  week1Ago: 15.1,
  week4Ago: 20.2,
  dayChangePct: -3.44,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cboe',
};

const currentMove = {
  ...currentVix,
  lastPx: 92.4,
  source: 'yahoo',
};

describe('MarketPulseRibbon', () => {
  test('embeds VIX and MOVE while replacing the risk regime with WTI oil', () => {
    render(
      <MarketPulseRibbon
        marketData={{
          us: [quote('SPX', 7522.55, 0.1)],
          currencies: [quote('USD', 104.32, 0.21)],
          rates: { us_treasuries: [quote('UST10Y', 4.21, -0.03)] },
          commodities: [quote('CL', 78.64, 1.12)],
        }}
        volatilityState={{ snapshot: { VIX: currentVix, MOVE: currentMove } }}
      />
    );

    expect(screen.getByText('7,522.55')).toBeInTheDocument();
    expect(screen.getByText('104.32')).toBeInTheDocument();
    expect(screen.getByText('4.21%')).toBeInTheDocument();
    expect(screen.getByText('78.64')).toBeInTheDocument();
    expect(screen.getByLabelText('VIX volatility 16.57')).toBeInTheDocument();
    expect(screen.getByLabelText('MOVE volatility 92.40')).toBeInTheDocument();
    expect(within(screen.getByLabelText('VIX volatility 16.57')).getByText('16.57'))
      .toHaveClass('efr-pulse-vol__value--green');
    expect(within(screen.getByLabelText('MOVE volatility 92.40')).getByText('92.40'))
      .toHaveClass('efr-pulse-vol__value--green');
    expect(screen.queryByText(/risk regime/i)).not.toBeInTheDocument();
  });

  test('applies the shared middle and high regimes to header VIX and MOVE values', () => {
    const { rerender } = render(
      <MarketPulseRibbon
        volatilityState={{
          snapshot: {
            VIX: { ...currentVix, lastPx: 20 },
            MOVE: { ...currentMove, lastPx: 100 },
          },
        }}
      />,
    );

    expect(within(screen.getByLabelText('VIX volatility 20.00')).getByText('20.00'))
      .toHaveClass('efr-pulse-vol__value--yellow');
    expect(within(screen.getByLabelText('MOVE volatility 100.00')).getByText('100.00'))
      .toHaveClass('efr-pulse-vol__value--yellow');

    rerender(
      <MarketPulseRibbon
        volatilityState={{
          snapshot: {
            VIX: { ...currentVix, lastPx: 40 },
            MOVE: { ...currentMove, lastPx: 120 },
          },
        }}
      />,
    );

    expect(within(screen.getByLabelText('VIX volatility 40.00')).getByText('40.00'))
      .toHaveClass('efr-pulse-vol__value--red');
    expect(within(screen.getByLabelText('MOVE volatility 120.00')).getByText('120.00'))
      .toHaveClass('efr-pulse-vol__value--red');
  });

  test('does not render stale VIX as a current reading', () => {
    render(
      <MarketPulseRibbon
        volatilityState={{ snapshot: { VIX: { ...currentVix, freshness: 'stale' } } }}
      />
    );

    expect(screen.getByLabelText('S&P 500 market pulse')).toHaveTextContent('VIX—NO DATA');
    expect(screen.queryByText('16.57')).not.toBeInTheDocument();
  });

  test('does not fill unavailable MOVE with a fallback value', () => {
    render(
      <MarketPulseRibbon
        volatilityState={{ snapshot: { MOVE: { ...currentMove, availability: 'unavailable' } } }}
      />
    );

    expect(screen.getByLabelText('MOVE volatility unavailable')).toHaveTextContent('MOVE—NO DATA');
    expect(screen.queryByText('92.40')).not.toBeInTheDocument();
  });

  test('does not present historical MOVE as a current market-pulse reading', () => {
    render(
      <MarketPulseRibbon
        volatilityState={{
          snapshot: {
            MOVE: {
              ...currentMove,
              availability: 'historical',
              freshness: 'historical',
              quoteMode: 'end-of-day',
            },
          },
        }}
      />,
    );

    expect(screen.getByLabelText('MOVE volatility unavailable')).toHaveTextContent('MOVE—NO DATA');
    expect(screen.queryByText('92.40')).not.toBeInTheDocument();
  });
});
