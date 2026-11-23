import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExceptionFirstRadar from './ExceptionFirstRadar';
import { markRetainedReference } from '../../utils/marketQuoteReference.cjs';
import { formatDelayedDataTimestamp } from './DelayedDataMarker';

jest.mock('./GlobalMarketDayCycleHeader', () => () => null);
jest.mock('./MarketPulseRibbon', () => () => null);
jest.mock('./USDCorrelationMatrix', () => ({
  __esModule: true,
  ...jest.requireActual('./USDCorrelationMatrix'),
  default: () => null,
}));
jest.mock('./RadarReferencePanels', () => ({
  __esModule: true,
  ...jest.requireActual('./RadarReferencePanels'),
  default: () => null,
}));

const OBSERVED_AT = '2026-09-14T18:59:00.000Z';
const NOW = Date.parse('2026-09-14T19:00:00.000Z');
// Provenance shows the original observation time in the shared 24-hour display format.
const observedLabel = (value, status = 'delayed') => formatDelayedDataTimestamp(value, status)
  .replace(/^(?:Updated|Observation) /, '');
const OBSERVED_LABEL = observedLabel(OBSERVED_AT);
const DELAYED_QUOTE = {
  availability: 'delayed',
  source: 'yahoo',
  dataType: 'delayed',
  freshness: 'current',
  quoteAsOf: OBSERVED_AT,
  changePercent: 1.25,
};
const LIVE_QUOTE = {
  ...DELAYED_QUOTE,
  symbol: 'SPX',
  price: 6421.35,
  availability: 'current',
  source: 'ibkr',
  dataType: 'live',
};
const OFFLINE_PROVIDER = { ibkr: { connected: false, status: 'offline' } };
const CENTER_CARDS = [
  { id: 'us', label: 'US', asset: 'S&P 500', symbol: 'SPX', price: 6421.35, formatted: '6,421' },
  // London has closed by 19:59 London time, so its print is final and reads C.
  { id: 'europe', label: 'Europe', asset: 'STOXX Europe 600 (Europe-wide)', symbol: 'STOXX600', price: 550.27, formatted: '550', closed: true },
  { id: 'asia', label: 'Asia', asset: 'Nikkei 225 (Japan)', symbol: 'N225', price: 42500.25, formatted: '42,500' },
  { id: 'commodities', label: 'Commodities', asset: 'CRB Index', symbol: 'CRB', price: 309.62, formatted: '310' },
  { id: 'rates', label: 'Rates', asset: 'UST 2Y', symbol: 'UST2Y', price: 3.614, formatted: '3.614' },
  { id: 'crypto', label: 'Crypto', asset: 'Bitcoin/USD', symbol: 'BTC', price: 104532.16, formatted: '104,532' },
];

describe('compact market-card prices with provider provenance', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  test.each(CENTER_CARDS)('$label places its verified price between Asset and Day', (card) => {
    const row = { ...DELAYED_QUOTE, symbol: card.symbol, price: card.price };
    render(<ExceptionFirstRadar marketData={{ [card.id]: [row] }} />);

    const table = screen.getByRole('table', { name: `${card.label} market performance` });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent))
      .toEqual(['ASSET', 'Price', 'DAY', '15D', '1M', '3M', '6M', 'YTD', '1Y']);
    const firstRow = within(table).getAllByRole('row')[1];
    const cells = within(firstRow).getAllByRole('cell');
    expect(cells.slice(0, 3).map((cell) => cell.textContent))
      .toEqual([card.asset, `${card.formatted}${card.closed ? 'C' : 'D'}`, '1.25%']);
    expect(cells[1]).toHaveAttribute('data-quote-status', 'delayed');
    expect(cells[1]).toHaveAttribute('title', `${card.price} · Yahoo Finance · Delayed · ${OBSERVED_LABEL}`);
    expect(within(cells[1]).getByRole('button', { name: `Yahoo Finance · Delayed · ${OBSERVED_LABEL}${card.closed ? '. Close, market closed' : ''}` }))
      .toHaveTextContent(card.closed ? 'C' : 'D');
  });

  test('keeps a verified overview price and its original time after the provider disconnects', () => {
    const { rerender } = render(<ExceptionFirstRadar
      marketData={{ us: [LIVE_QUOTE] }} providerStatus={{ ibkr: { connected: true } }}
    />);
    const livePrice = screen.getByRole('cell', { name: /^S&P 500 price 6,421\./ });
    expect(livePrice).toHaveAttribute('data-quote-status', 'live');
    expect(within(livePrice).queryByRole('button')).not.toBeInTheDocument();

    rerender(<ExceptionFirstRadar marketData={{ us: [LIVE_QUOTE] }} providerStatus={OFFLINE_PROVIDER} />);

    const retainedPrice = screen.getByRole('cell', { name: /^S&P 500 price 6,421\./ });
    expect(retainedPrice).toHaveTextContent('6,421D');
    expect(retainedPrice).toHaveAttribute('data-quote-status', 'refresh-delayed');
    expect(retainedPrice).toHaveAttribute('title',
      `6421.35 · IBKR · Refresh delayed · ${observedLabel(OBSERVED_AT, 'refresh-delayed')}`);
    expect(within(retainedPrice).getByRole('button', {
      name: `IBKR · Refresh delayed · ${observedLabel(OBSERVED_AT, 'refresh-delayed')}`,
    })).toHaveTextContent('D');
  });

  test('shows an explicitly retained provider observation as dated reference after a failed refresh', () => {
    const originalQuote = { ...LIVE_QUOTE, quoteAsOf: '2026-09-11T20:00:00.000Z' };
    const retained = markRetainedReference(originalQuote, 'provider_refresh_unavailable', NOW);
    render(<ExceptionFirstRadar marketData={{ us: [retained] }} providerStatus={OFFLINE_PROVIDER} />);

    const originalLabel = observedLabel(originalQuote.quoteAsOf, 'refresh-delayed');
    const price = screen.getByRole('cell', { name: /^S&P 500 price 6,421\./ });
    expect(price).toHaveAttribute('data-quote-status', 'refresh-delayed');
    expect(price).toHaveTextContent('6,421D');
    expect(price).toHaveAttribute('title', `6421.35 · IBKR · Refresh delayed · ${originalLabel}`);
    expect(within(price).getByRole('button', { name: `IBKR · Refresh delayed · ${originalLabel}` }))
      .toHaveTextContent('D');
  });

  test.each([
    ['mock', { source: 'mock' }],
    ['seed', { seeded: true }],
    ['cache-only', { cacheOnly: true }],
    ['unverified stale', { freshness: 'stale' }],
    ['missing observation time', { quoteAsOf: null }],
  ])('withholds the price for %s input', (_label, invalid) => {
    render(<ExceptionFirstRadar marketData={{ us: [{ ...LIVE_QUOTE, ...invalid }] }} />);

    const price = screen.getByRole('cell', { name: /^S&P 500 price —\./ });
    expect(price).toHaveTextContent(/^—$/);
    expect(price).toHaveAttribute('data-quote-status', 'unavailable');
    expect(within(price).queryByRole('button')).not.toBeInTheDocument();
  });
});
