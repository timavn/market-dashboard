import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import LeveragedProductsCell, { calculateLeveragedProductsFitScale } from './LeveragedProductsCell';
import LeveragedProductModal from './LeveragedProductModal';
import { getLeveragedProducts } from '../../../constants/leveragedProductCatalog';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: { getLeveragedProductOverlap: jest.fn() },
}));

const selectionFor = (baseSymbol, ticker) => ({
  baseSymbol,
  product: getLeveragedProducts(baseSymbol).find(product => product.ticker === ticker),
});

const verifiedOverlap = () => ({
  available: true,
  status: 'available',
  fromCache: false,
  baseSymbol: 'IAK',
  referenceSymbol: 'XLF',
  weightedOverlapPct: 9.6,
  sharedHoldings: 17,
  asOf: '2026-09-10',
  sources: [
    { symbol: 'IAK', provider: 'iShares', asOf: '2026-09-10' },
    { symbol: 'XLF', provider: 'State Street', asOf: '2026-09-10' },
  ],
});

let clock;
beforeEach(() => {
  clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T18:00:00Z'));
  MarketDataService.getLeveragedProductOverlap.mockReset();
  MarketDataService.getLeveragedProductOverlap.mockResolvedValue({ available: false, status: 'unavailable' });
});

afterEach(() => { clock.mockRestore(); });

test('keeps catalog ordering, signed tones, and proxy-only ticker markup in the compact cell', () => {
  const onSelect = jest.fn();
  const onAncestorClick = jest.fn();
  document.addEventListener('click', onAncestorClick);
  try {
    render(<LeveragedProductsCell symbol=" gld " onSelect={onSelect} />);
    const row = screen.getByTestId('leveraged-products-GLD');
    expect(row).toHaveAttribute('data-fit-scale', '1.0000');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map(button => button.textContent)).toEqual(['UGLD +2×', 'UGL +2×', 'GLL −2×']);
    expect(buttons[0]).toHaveClass('is-positive');
    expect(buttons[0]).not.toHaveClass('is-proxy');
    expect(buttons[1]).toHaveClass('is-positive', 'is-proxy');
    expect(buttons[2]).toHaveClass('is-negative', 'is-proxy');
    expect(within(buttons[1]).getByText('UGL')).toHaveClass('pcv2-leveraged-product-ticker');
    expect(within(buttons[1]).getByText('+2×')).not.toHaveClass('pcv2-leveraged-product-ticker');

    fireEvent.click(buttons[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(selectionFor('GLD', 'UGL'));
    expect(onAncestorClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  } finally {
    document.removeEventListener('click', onAncestorClick);
  }
});

test('renders the unchanged compact dash when no leveraged mapping exists', () => {
  render(<LeveragedProductsCell symbol="BKLN" onSelect={jest.fn()} />);
  const cell = screen.getByLabelText(/No current leveraged product mapping/);
  expect(cell).toHaveClass('pcv2-intel-span-4', 'pcv2-leveraged-products-cell');
  expect(within(cell).getByText('—')).toHaveClass('is-muted');
  expect(within(cell).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByTestId('leveraged-products-BKLN')).not.toBeInTheDocument();
});

test('never enlarges products that fit and reserves the existing four-pixel fit gutter', () => {
  expect(calculateLeveragedProductsFitScale(220, 180)).toBe(1);
  expect(calculateLeveragedProductsFitScale(200, 250)).toBeCloseTo(196 / 250, 6);
  expect(calculateLeveragedProductsFitScale(0, 250)).toBe(1);
  expect(calculateLeveragedProductsFitScale(200, Number.NaN)).toBe(1);
});

test('shows verified dated overlap in secondary modal detail without changing the product cell', async () => {
  MarketDataService.getLeveragedProductOverlap.mockResolvedValue(verifiedOverlap());
  const { container } = render(
    <LeveragedProductModal active selection={selectionFor('IAK', 'FAZ')} onClose={jest.fn()} />,
  );
  const modal = screen.getByRole('dialog', { name: 'FAZ' });
  expect(container).not.toContainElement(modal);
  expect(modal).toHaveAttribute('aria-modal', 'true');
  expect(await within(modal).findByText('Loose proxy · 10% overlap')).toBeInTheDocument();
  expect(within(modal).getByText(/17 shared holdings · Sep 10, 2026/)).toBeInTheDocument();
  expect(within(modal).getByText('Loose proxy · 10% overlap')).toHaveAttribute(
    'title', 'Weighted overlap: the smaller portfolio weight for each shared holding, summed.',
  );
  expect(within(modal).getByTestId('leveraged-product-direction')).toHaveTextContent('−3× daily');
  expect(within(modal).getByTestId('leveraged-product-direction')).toHaveClass('is-negative');
  expect(within(modal).getByText('Daily reset · Multi-day returns may diverge.')).toBeInTheDocument();
  expect(within(modal).queryByText(/live quote required|inverse/i)).not.toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledWith({
    baseSymbol: 'IAK', referenceSymbol: 'XLF', signal: expect.any(AbortSignal),
  });
});

test.each([
  ['cache-only', { fromCache: true }],
  ['unavailable', { available: false, status: 'unavailable' }],
  ['stale holdings date', { asOf: '2026-09-02' }],
  ['missing holdings date', { asOf: undefined }],
  ['missing source provenance', { sources: [] }],
  ['only one source', { sources: [{ provider: 'iShares', asOf: '2026-09-10' }] }],
  ['non-numeric percentage', { weightedOverlapPct: 'unknown' }],
  ['mismatched base security', { baseSymbol: 'GLD' }],
  ['mismatched reference security', { referenceSymbol: 'XLK' }],
])('omits overlap for %s responses while retaining the proxy qualification', async (_label, overrides) => {
  MarketDataService.getLeveragedProductOverlap.mockResolvedValue({ ...verifiedOverlap(), ...overrides });
  render(<LeveragedProductModal active selection={selectionFor('IAK', 'FAZ')} onClose={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  const modal = screen.getByRole('dialog', { name: 'FAZ' });
  expect(within(modal).getByText('Loose proxy')).toBeInTheDocument();
  expect(within(modal).getByText('Broad financials; insurance is only a minority of this benchmark.')).toBeInTheDocument();
  expect(within(modal).queryByText(/% overlap|shared holdings/)).not.toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).toHaveBeenCalledTimes(1);
});

test('keeps failed overlap requests quiet without fabricating a percentage', async () => {
  MarketDataService.getLeveragedProductOverlap.mockRejectedValue(new Error('provider diagnostic detail'));
  render(<LeveragedProductModal active selection={selectionFor('IAK', 'FAZ')} onClose={jest.fn()} />);
  await act(async () => { await Promise.resolve(); });
  const modal = screen.getByRole('dialog', { name: 'FAZ' });
  expect(within(modal).getByText('Loose proxy')).toBeInTheDocument();
  expect(within(modal).queryByText(/% overlap|shared holdings|provider diagnostic detail/)).not.toBeInTheDocument();
});

test('does not fetch or imply a percentage for a direct product without comparable holdings', () => {
  render(<LeveragedProductModal active selection={selectionFor('GLD', 'UGLD')} onClose={jest.fn()} />);
  const modal = screen.getByRole('dialog', { name: 'UGLD' });
  expect(within(modal).getByText('Direct')).toBeInTheDocument();
  expect(within(modal).queryByText(/% overlap/)).not.toBeInTheDocument();
  expect(within(modal).getByTestId('leveraged-product-direction')).toHaveClass('is-positive');
  expect(MarketDataService.getLeveragedProductOverlap).not.toHaveBeenCalled();
});

test('delegates only close, Escape, and backdrop actions to its controlled owner', () => {
  const onClose = jest.fn();
  const selection = selectionFor('GLD', 'UGLD');
  const view = render(<LeveragedProductModal active selection={selection} onClose={onClose} />);
  const modal = screen.getByRole('dialog', { name: 'UGLD' });
  const close = within(modal).getByRole('button', { name: 'Close leveraged product details' });
  expect(close).toHaveFocus();
  fireEvent.mouseDown(within(modal).getByText('Tracks'));
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(close);
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(modal.parentElement);
  expect(onClose).toHaveBeenCalledTimes(3);

  view.rerender(<LeveragedProductModal active={false} selection={selection} onClose={onClose} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(3);
  view.rerender(<LeveragedProductModal active selection={null} onClose={onClose} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(MarketDataService.getLeveragedProductOverlap).not.toHaveBeenCalled();
});
