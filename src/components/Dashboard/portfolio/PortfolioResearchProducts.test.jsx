import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioResearchProducts from './PortfolioResearchProducts';
import { formatResearchSourceDate, formatResearchTime } from '../../../utils/researchDateFormat';

const makeRow = (overrides = {}) => ({
  key: 'the-call-current',
  productId: 'the-call',
  productLabel: 'The Call',
  state: 'available',
  factLines: ['GLD remains a preferred long.', 'Risk remains contained.'],
  marketDate: '2026-09-10',
  publishedAt: '2026-09-10T13:42:00Z',
  reference: { sourceUrl: '/research/the-call/current' },
  ...overrides,
});

const makeProps = (overrides = {}) => ({
  rowId: 'long-account-GLD',
  symbol: 'GLD',
  rows: [makeRow()],
  loading: false,
  expandedProducts: new Set(),
  onToggleProduct: jest.fn(),
  ...overrides,
});

const expandedProducts = () => new Set(['long-account-GLD:the-call']);
const productRow = () => screen.getByTestId('research-product-row-long-account-GLD-the-call');
const contextRegion = () => screen.getByRole('region', { name: 'The Call facts for GLD' });

test('preserves the compact reference header, row columns, order, and wrapper-free structure', () => {
  const { container } = render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow(), makeRow({ key: 'early-look-current', productId: 'early-look', productLabel: 'Early Look' })],
  })} />);
  expect([...container.children]).toHaveLength(3);
  const header = screen.getByLabelText('GLD research product references');
  expect([...header.children].map((cell) => cell.textContent)).toEqual(['TIME', 'PRODUCT', 'DETAIL']);
  expect([...header.children].map((cell) => cell.className)).toEqual([
    'pcv2-intel-cell pcv2-intel-span-2',
    'pcv2-intel-cell pcv2-intel-span-2',
    'pcv2-intel-cell pcv2-intel-span-16',
  ]);
  expect(screen.getAllByTestId(/research-product-row-/).map((row) => row.dataset.productId))
    .toEqual(['the-call', 'early-look']);
  const row = productRow();
  expect(row.children).toHaveLength(3);
  expect(row.children[0]).toHaveTextContent('09:42');
  expect(row.children[1]).toHaveClass('pcv2-intel-span-2');
  expect(row.children[2]).toHaveClass('pcv2-intel-span-16');
  expect(row.children[2]).toHaveAttribute('title', 'GLD remains a preferred long.');
  expect(row).not.toHaveClass('is-empty');
});

test.each([
  ['unavailable', 'UNAVAILABLE', 'The Call evidence is unavailable for GLD'],
  ['conflict', 'CONFLICT', 'The Call contains conflicting current rows for GLD'],
  ['empty', 'N/A', 'The Call has no verified mention for GLD'],
])('renders %s evidence without interactive context or retained facts', (state, detail, title) => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ state })],
    expandedProducts: expandedProducts(),
  })} />);
  const row = productRow();
  expect(row).toHaveClass('is-empty');
  expect(row.classList.contains('is-unavailable')).toBe(state === 'unavailable');
  const label = within(row).getByText(detail);
  expect(label).toHaveAttribute('title', title);
  expect(label.classList.contains('is-na')).toBe(state === 'empty');
  expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByText('Risk remains contained.')).not.toBeInTheDocument();
});

test('emits the same scoped key from both buttons and changes expansion only when controlled props change', () => {
  const props = makeProps();
  const view = render(<PortfolioResearchProducts {...props} />);
  const product = screen.getByRole('button', { name: 'View The Call facts for GLD' });
  const detail = screen.getByRole('button', { name: 'View The Call context for GLD' });
  const target = 'research-product-context-long-account-GLD-the-call';
  expect(product).toHaveAttribute('aria-controls', target);
  expect(detail).toHaveAttribute('aria-controls', target);
  fireEvent.click(product);
  fireEvent.click(detail);
  expect(props.onToggleProduct.mock.calls).toEqual([
    ['long-account-GLD:the-call'],
    ['long-account-GLD:the-call'],
  ]);
  expect(props.expandedProducts.size).toBe(0);
  expect(product).toHaveAttribute('aria-expanded', 'false');
  expect(detail).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region')).not.toBeInTheDocument();

  view.rerender(<PortfolioResearchProducts {...props} expandedProducts={expandedProducts()} />);
  expect(contextRegion()).toHaveAttribute('id', target);
  expect(product).toHaveAttribute('aria-expanded', 'true');
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  expect(product).toHaveAccessibleName('Collapse The Call facts for GLD');
  expect(detail).toHaveAccessibleName('Collapse The Call context for GLD');
  fireEvent.click(detail);
  expect(props.onToggleProduct).toHaveBeenLastCalledWith('long-account-GLD:the-call');
  expect(contextRegion()).toBeInTheDocument();
  view.rerender(<PortfolioResearchProducts {...props} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('does not expand another position when the same product is selected elsewhere', () => {
  render(<PortfolioResearchProducts {...makeProps({
    rowId: 'short-other-account-GLD',
    expandedProducts: expandedProducts(),
  })} />);
  expect(screen.getByRole('button', { name: 'View The Call facts for GLD' }))
    .toHaveAttribute('aria-controls', 'research-product-context-short-other-account-GLD-the-call');
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('shows only the header and loading row while preserving the owner selection for the next render', () => {
  const props = makeProps({ expandedProducts: expandedProducts() });
  const view = render(<PortfolioResearchProducts {...props} />);
  expect(contextRegion()).toBeInTheDocument();
  view.rerender(<PortfolioResearchProducts {...props} loading />);
  expect(screen.getByLabelText('GLD research product references')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Loading verified research…');
  expect(screen.queryByTestId(/research-product-row-/)).not.toBeInTheDocument();
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(props.expandedProducts.has('long-account-GLD:the-call')).toBe(true);
  expect(props.onToggleProduct).not.toHaveBeenCalled();
  view.rerender(<PortfolioResearchProducts {...props} />);
  expect(contextRegion()).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('keeps only the header when the validated product projection is empty', () => {
  const { container } = render(<PortfolioResearchProducts {...makeProps({ rows: [] })} />);
  expect(container.children).toHaveLength(1);
  expect(screen.getByLabelText('GLD research product references')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.queryByText('UNAVAILABLE')).not.toBeInTheDocument();
});

test.each([
  [['One current fact.'], ['One current fact.']],
  [['Summary fact.', 'Second fact.', 'Third fact.'], ['Second fact.', 'Third fact.']],
])('preserves context fact slicing for %j', (factLines, expectedContext) => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ factLines })],
    expandedProducts: expandedProducts(),
  })} />);
  expect(within(productRow()).getByRole('button', { name: 'Collapse The Call context for GLD' }))
    .toHaveTextContent(factLines[0]);
  expect(within(contextRegion()).getAllByRole('listitem').map((item) => item.textContent))
    .toEqual(expectedContext);
  expect(within(contextRegion()).getByRole('list', { name: 'The Call fact list for GLD' })).toBeInTheDocument();
});

test('preserves the selected available-without-facts context without inventing a toggle or fact', () => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ factLines: [] })],
    expandedProducts: expandedProducts(),
  })} />);
  expect(within(productRow()).getByText('Verified current structured row for GLD')).toBeInTheDocument();
  expect(within(productRow()).queryByRole('button')).not.toBeInTheDocument();
  expect(contextRegion()).toBeInTheDocument();
  expect(within(contextRegion()).queryByRole('listitem')).not.toBeInTheDocument();
  expect(within(contextRegion()).getByRole('link', { name: 'OPEN SOURCE ↗' })).toBeInTheDocument();
});

test.each([
  'javascript:alert(1)',
  ' data:text/html,<p>unsafe</p> ',
  '//example.com/research',
  null,
])('omits unsafe or missing source URL %p', (sourceUrl) => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ reference: { sourceUrl } })],
    expandedProducts: expandedProducts(),
  })} />);
  expect(within(contextRegion()).queryByRole('link')).not.toBeInTheDocument();
  expect(within(contextRegion()).getByText('SOURCE UNAVAILABLE')).toHaveAttribute('aria-disabled', 'true');
});

test.each([
  [{ sourceUrl: ' https://app.hedgeye.com/insights/verified ' }, 'https://app.hedgeye.com/insights/verified'],
  [{ sourceUrl: ' /research/the-call/current ' }, '/research/the-call/current'],
  [{ url: '/research/legacy-url' }, '/research/legacy-url'],
])('keeps a safe source destination and dated secondary provenance for %j', (reference, expectedHref) => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ reference })],
    expandedProducts: expandedProducts(),
  })} />);
  const context = contextRegion();
  expect(within(context).getByText('Source: The Call · Sep 10, 2026 · 09:42 ET')).toBeInTheDocument();
  const links = within(context).getAllByRole('link', { name: 'OPEN SOURCE ↗' });
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute('href', expectedHref);
  expect(links[0]).toHaveAttribute('target', '_blank');
  expect(links[0]).toHaveAttribute('rel', 'noreferrer');
  expect(within(context).queryByText('SOURCE UNAVAILABLE')).not.toBeInTheDocument();
});

test('does not display synthetic midnight as a publication time or source time', () => {
  render(<PortfolioResearchProducts {...makeProps({
    rows: [makeRow({ publishedAt: '2026-09-10T00:00:00.000Z' })],
    expandedProducts: expandedProducts(),
  })} />);
  expect(productRow().children[0]).toHaveTextContent('—');
  const provenance = within(contextRegion()).getByText('Source: The Call · Sep 10, 2026');
  expect(provenance).not.toHaveTextContent('ET');
});

test.each([
  ['2026-01-15T14:42:00Z', '09:42'],
  ['2026-07-15T14:42:00Z', '10:42'],
  ['2026-03-08T06:59:00Z', '01:59'],
  ['2026-03-08T07:01:00Z', '03:01'],
  ['2026-09-10T00:00:00Z', '—'],
  ['2026-09-10T00:00:00.000+00:00', '—'],
  ['2026-09-10', '—'],
  ['not-a-time', '—'],
  [null, '—'],
])('formats research publication time %p as %p', (value, expected) => {
  expect(formatResearchTime(value)).toBe(expected);
});

test('preserves source calendar date independently of New York clock conversion', () => {
  expect(formatResearchSourceDate('2026-01-15')).toBe('Jan 15, 2026');
  expect(formatResearchSourceDate('2026-07-15T01:00:00Z')).toBe('Jul 15, 2026');
  expect(formatResearchSourceDate(null)).toBe('Date unavailable');
});
