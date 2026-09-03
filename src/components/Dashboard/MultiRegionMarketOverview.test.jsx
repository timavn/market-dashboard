import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  QuotesTable,
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

    const priceCell = screen.getByLabelText(/S&P 500 price 7,757\.64/i);
    expect(priceCell).toHaveTextContent('7,757.64');
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
