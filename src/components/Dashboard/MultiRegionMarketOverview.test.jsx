import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  CurrenciesCompactRail,
  QuotesTable,
  SectorsCompactRail,
  quoteProvenanceLabel,
  quoteStatusSource,
} from './MultiRegionMarketOverview';

jest.mock('./MarketVolumeTable', () => () => null);
jest.mock('./VolatilityTable', () => ({ VolatilityTableWithTabs: () => null }));
jest.mock('./USDCorrelationMatrix', () => () => null);
jest.mock('../../hooks/useUsdCorrelations', () => ({
  __esModule: true,
  default: () => ({
    correlations: null,
    rollingStats: null,
    correlationsTimestamp: null,
    calculationDate: null,
    loading: false,
    error: null,
    retry: jest.fn(),
  }),
}));

describe('multi-region quote provenance', () => {
  const originalResizeObserver = global.ResizeObserver;
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;

  beforeAll(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}

      disconnect() {}
    };
    global.requestAnimationFrame = (callback) => {
      callback();
      return 1;
    };
    global.cancelAnimationFrame = () => {};
  });

  afterAll(() => {
    global.ResizeObserver = originalResizeObserver;
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('renders a Yahoo fallback price with explicit delayed provenance', () => {
    const quote = {
      symbol: 'SPX',
      price: '7757.64',
      changePercent: '0.62',
      source: 'yahoo',
      dataType: 'delayed',
      availability: 'delayed',
      quoteAsOf: '2026-08-07T20:50:24.000Z',
    };

    render(
      <QuotesTable
        indices={[{ symbol: 'SPX', name: 'S&P 500' }]}
        data={[quote]}
        loading={false}
      />,
    );

    const priceCell = screen.getByLabelText(/S&P 500 price 7,758/i);
    expect(priceCell).toHaveTextContent('7,758');
    expect(priceCell).toHaveAttribute('data-source', 'yahoo');
    expect(priceCell).toHaveAttribute('data-availability', 'delayed');
    expect(priceCell).toHaveAttribute('title', expect.stringContaining('Yahoo delayed'));
    const marker = within(priceCell).getByRole('button', { name: /Yahoo delayed/i });
    expect(marker).toHaveTextContent('D');
    expect(quoteProvenanceLabel(quote)).toContain('Yahoo delayed');
    expect(quoteStatusSource(quote, 30000)).toMatchObject({
      status: 'delayed',
      stateLabel: 'Delayed',
      updatedAt: quote.quoteAsOf,
    });
  });

  it('colors crypto by elapsed 24 hours and international indices by their local session', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-07T01:00:00.000Z'));
    try {
      render(<QuotesTable indices={[
        { symbol: 'BTC', name: 'Bitcoin' },
        { symbol: 'ETH', name: 'Ethereum' },
        { symbol: 'N225', name: 'Nikkei 225' },
      ]} data={[
        { symbol: 'BTC', price: 83000, availability: 'delayed', source: 'yahoo', quoteAsOf: '2026-10-06T02:00:00.000Z' },
        { symbol: 'ETH', price: 2540, availability: 'delayed', source: 'yahoo', quoteAsOf: '2026-10-06T01:00:00.000Z' },
        { symbol: 'N225', price: 70000, availability: 'delayed', source: 'yahoo', quoteAsOf: '2026-10-06T06:00:00.000Z', sessionDate: '2026-10-06' },
      ]} loading={false} />);
      expect(within(screen.getByLabelText(/Bitcoin price/)).getByRole('button'))
        .toHaveAttribute('data-data-age', 'same-session');
      expect(within(screen.getByLabelText(/Ethereum price/)).getByRole('button'))
        .toHaveAttribute('data-data-age', 'older-session');
      expect(within(screen.getByLabelText(/Nikkei 225 price/)).getByRole('button'))
        .toHaveAttribute('data-data-age', 'older-session');
    } finally {
      now.mockRestore();
    }
  });

  it('uses magnitude-based overview precision while keeping percentage changes precise', () => {
    const rows = [
      { symbol: 'SPX', name: 'S&P 500', price: '7639.04', expected: '7,639' },
      { symbol: 'SMH', name: 'Semiconductors', price: '544.38', expected: '544' },
      { symbol: 'SI', name: 'Silver', price: '63.47', expected: '63.5' },
      { symbol: 'XRP', name: 'XRP', price: '2.5278', expected: '2.53' },
      { symbol: 'ADA', name: 'Cardano', price: '0.004567', expected: '0.00457' },
      { symbol: 'NG', name: 'Natural Gas', price: '3.000', expected: '3' },
    ];
    const quotes = rows.map(({ symbol, price }) => Object.freeze({
      symbol,
      price,
      changePercent: '1.23',
      source: 'yahoo',
      availability: 'delayed',
      quoteAsOf: '2026-08-07T20:50:24.000Z',
    }));

    render(<QuotesTable indices={rows} data={quotes} loading={false} />);

    rows.forEach(({ name, price, expected }, index) => {
      const row = screen.getByRole('row', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
      expect(within(row).getByLabelText(new RegExp(`price ${expected.replace('.', '\\.')}`)))
        .toHaveTextContent(expected);
      expect(within(row).getByText('+1.23', { exact: true })).toBeInTheDocument();
      expect(quotes[index].price).toBe(price);
    });
  });

  it('keeps yield and basis-point precision for rate rows', () => {
    render(
      <QuotesTable
        indices={[
          { symbol: 'UST10Y', name: 'UST 10Y' },
          { symbol: 'SPREAD', name: 'Curve spread', unit: 'bps' },
        ]}
        data={[
          { symbol: 'UST10Y', price: '4.50', changePercent: '0.62' },
          { symbol: 'SPREAD', price: '123.4', changePercent: '2.4', unit: 'bps' },
        ]}
        loading={false}
        priceLabel="YIELD"
      />,
    );

    expect(screen.getByLabelText(/UST 10Y price 4\.50/)).toHaveTextContent('4.50');
    expect(screen.getByLabelText(/Curve spread price 123\.4/)).toHaveTextContent('123.4');
    expect(screen.getByText('0.62', { exact: false })).toHaveTextContent('+0.62');
    expect(screen.getByText('+2.4', { exact: true })).toBeInTheDocument();
  });

  it('simplifies dollar index and fund prices while preserving currency-pair precision', () => {
    render(
      <CurrenciesCompactRail
        data={[
          { symbol: 'USD', price: '100.94' },
          { symbol: 'UUP', price: '28.00' },
          { symbol: 'EURUSD', price: '1.17123' },
          { symbol: 'USDJPY', price: '147.321' },
        ]}
        loading={false}
      />,
    );

    expect(within(screen.getByRole('row', { name: /^DXY / })).getByText('101', { exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^UUP / })).getByText('28', { exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^EUR\/USD / })).getByText('1.17123', { exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^USD\/JPY / })).getByText('147.321', { exact: true })).toBeInTheDocument();
  });

  it('applies the same price display to the sector rail', () => {
    render(
      <SectorsCompactRail
        data={[
          { symbol: 'SPX', price: '7639.04' },
          { symbol: 'XLK', price: '156.78' },
          { symbol: 'XLF', price: '54.32' },
        ]}
        loading={false}
      />,
    );

    expect(within(screen.getByRole('row', { name: /^S&P 500 / })).getByText('7,639', { exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Technology / })).getByText('157', { exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Financials / })).getByText('54.3', { exact: true })).toBeInTheDocument();
  });

  it('marks historical prices as non-live references', () => {
    const quote = {
      symbol: 'UST2Y',
      price: '4.340',
      source: 'fred',
      availability: 'historical',
      quoteAsOf: '2026-08-31T00:00:00.000Z',
    };

    render(
      <QuotesTable
        indices={[{ symbol: 'UST2Y', name: 'UST 2Y' }]}
        data={[quote]}
        loading={false}
        priceLabel="YIELD"
      />,
    );

    const priceCell = screen.getByLabelText(/UST 2Y price 4\.34/i);
    const marker = within(priceCell).getByRole('button', { name: /FRED historical/i });
    expect(marker).toHaveTextContent('D');
  });

  it('keeps a failed two-provider quote explicitly unavailable', () => {
    render(
      <QuotesTable
        indices={[{ symbol: 'RUT', name: 'Russell' }]}
        data={[{
          symbol: 'RUT',
          price: null,
          source: null,
          availability: 'unavailable',
          warning: 'no_quote_available',
        }]}
        loading={false}
      />,
    );

    const priceCell = screen.getByLabelText(/Russell price —\. Quote unavailable/i);
    expect(priceCell).toHaveTextContent('—');
    expect(priceCell).toHaveAttribute('data-source', 'unavailable');
    expect(priceCell).toHaveAttribute('data-availability', 'unavailable');
  });
});
