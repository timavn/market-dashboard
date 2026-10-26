import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioResearchHistory from './PortfolioResearchHistory';

// Prepared research display rows only: these fixtures never enter runtime data.
const makeRow = (overrides = {}) => ({
  key: 'the-call-2026-09-09',
  dateLabel: 'Sep 9',
  productLabel: 'The Call',
  note: 'Previously published research context.',
  ...overrides,
});

const makeProps = (overrides = {}) => ({
  rowId: 'long-account-GLD',
  rows: [makeRow()],
  historyDays: 5,
  loading: false,
  error: null,
  ...overrides,
});

const disclosure = (container) => container.querySelector('details');

test('keeps one native details root, its summary, and ordered three-column display rows', () => {
  const { container } = render(<PortfolioResearchHistory {...makeProps({ rows: [
    makeRow(),
    makeRow({ key: 'early-look-2026-09-08', dateLabel: 'Sep 8', productLabel: 'Early Look', note: 'Earlier research.' }),
  ] })} />);
  const details = disclosure(container);
  expect(container.children).toHaveLength(1);
  expect(container.firstElementChild).toBe(details);
  expect(details).toHaveClass('pcv2-intel-history');
  expect(details.children[0].tagName).toBe('SUMMARY');
  expect(details.children[0]).toHaveTextContent('Previous 5 market days (2 product rows)');
  const body = details.children[1];
  expect(body).toHaveClass('pcv2-intel-history-body');
  expect(body.children).toHaveLength(2);
  expect([...body.children].map((row) => [...row.children].map((cell) => cell.textContent)))
    .toEqual([
      ['Sep 9', 'The Call', 'Previously published research context.'],
      ['Sep 8', 'Early Look', 'Earlier research.'],
    ]);
  expect([...body.children[0].children].map((cell) => cell.className)).toEqual([
    'pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-time',
    'pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-product',
    'pcv2-intel-cell pcv2-intel-span-16 pcv2-intel-reference-note ',
  ]);
  expect(body.children[0].children[2]).toHaveAttribute('title', 'Previously published research context.');
});

test('starts closed and lets the native summary open and close without a controlled prop', () => {
  const { container } = render(<PortfolioResearchHistory {...makeProps()} />);
  const details = disclosure(container);
  const summary = details.querySelector('summary');
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  fireEvent.click(summary);
  expect(details.open).toBe(false);
});

test('preserves the same open disclosure through loading, replacement rows, error, and empty rerenders', () => {
  const props = makeProps();
  const view = render(<PortfolioResearchHistory {...props} />);
  const details = disclosure(view.container);
  fireEvent.click(details.querySelector('summary'));

  view.rerender(<PortfolioResearchHistory {...props} loading />);
  expect(disclosure(view.container)).toBe(details);
  expect(details.open).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent('Loading verified historical references…');
  expect(screen.queryByText(props.rows[0].note)).not.toBeInTheDocument();

  view.rerender(<PortfolioResearchHistory {...props} rows={[makeRow({ note: 'Replacement context.' })]} />);
  expect(disclosure(view.container)).toBe(details);
  expect(details.open).toBe(true);
  expect(screen.getByText('Replacement context.')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();

  view.rerender(<PortfolioResearchHistory {...props} rows={[]} error="Provider detail" />);
  expect(disclosure(view.container)).toBe(details);
  expect(details.open).toBe(true);
  expect(screen.getByText('Historical references unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('Replacement context.')).not.toBeInTheDocument();

  view.rerender(<PortfolioResearchHistory {...props} rows={[]} />);
  expect(disclosure(view.container)).toBe(details);
  expect(details.open).toBe(true);
  expect(screen.getByText('No verified historical references returned.')).toBeInTheDocument();
});

test('does not force a closed disclosure open when its props refresh', () => {
  const props = makeProps({ loading: true });
  const view = render(<PortfolioResearchHistory {...props} />);
  const details = disclosure(view.container);
  view.rerender(<PortfolioResearchHistory {...props} loading={false} historyDays={3} />);
  expect(disclosure(view.container)).toBe(details);
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')).toHaveTextContent('Previous 3 market days (1 product rows)');
});

test('resets native disclosure state when the position panel unmounts and remounts', () => {
  const props = makeProps();
  const view = render(<PortfolioResearchHistory {...props} />);
  const initialDetails = disclosure(view.container);
  fireEvent.click(initialDetails.querySelector('summary'));
  expect(initialDetails.open).toBe(true);
  view.rerender(null);
  expect(initialDetails).not.toBeInTheDocument();
  view.rerender(<PortfolioResearchHistory {...props} />);
  expect(disclosure(view.container)).not.toBe(initialDetails);
  expect(disclosure(view.container).open).toBe(false);
});

test('keeps duplicate security positions independently open or closed', () => {
  const props = makeProps();
  const { container } = render(<>
    <PortfolioResearchHistory {...props} />
    <PortfolioResearchHistory {...props} rowId="other-account-GLD" />
  </>);
  const [first, second] = container.querySelectorAll('details');
  fireEvent.click(first.querySelector('summary'));
  expect(first.open).toBe(true);
  expect(second.open).toBe(false);
  fireEvent.click(second.querySelector('summary'));
  fireEvent.click(first.querySelector('summary'));
  expect(first.open).toBe(false);
  expect(second.open).toBe(true);
});

test('preserves dated row identities when the same product is updated and reordered', () => {
  const latest = makeRow();
  const earlier = makeRow({ key: 'the-call-2026-09-08', dateLabel: 'Sep 8', note: 'Earlier context.' });
  const props = makeProps({ rows: [latest, earlier] });
  const view = render(<PortfolioResearchHistory {...props} />);
  const latestNode = screen.getByText('Sep 9').parentElement;
  const earlierNode = screen.getByText('Sep 8').parentElement;
  view.rerender(<PortfolioResearchHistory {...props} rows={[earlier, { ...latest, note: 'Corrected context.' }]} />);
  const body = disclosure(view.container).querySelector('.pcv2-intel-history-body');
  expect([...body.children]).toEqual([earlierNode, latestNode]);
  expect(within(latestNode).getByText('Corrected context.')).toHaveAttribute('title', 'Corrected context.');
  expect(within(earlierNode).getByText('Earlier context.')).toBeInTheDocument();
});

test('gives loading priority over prepared rows and errors without exposing their content', () => {
  const { container } = render(<PortfolioResearchHistory {...makeProps({ loading: true, error: 'Raw provider failure' })} />);
  const details = disclosure(container);
  expect(details.querySelector('summary')).toHaveTextContent('Previous 5 market days (loading…)');
  expect(screen.getByRole('status')).toHaveTextContent('Loading verified historical references…');
  expect(screen.queryByText('Previously published research context.')).not.toBeInTheDocument();
  expect(screen.queryByText('Historical references unavailable.')).not.toBeInTheDocument();
  expect(details).not.toHaveTextContent('Raw provider failure');
  expect(container.querySelector('.analyst-spinner')).toHaveAttribute('aria-hidden', 'true');
});

test('preserves the existing prepared-row branch ahead of error messaging for historical context', () => {
  render(<PortfolioResearchHistory {...makeProps({ error: 'Raw history response detail' })} />);
  expect(screen.getByText('Previously published research context.')).toBeInTheDocument();
  expect(screen.queryByText('Historical references unavailable.')).not.toBeInTheDocument();
  expect(screen.queryByText('Raw history response detail')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test.each([
  ['Internal historical-provider failure', 'Historical references unavailable.'],
  [null, 'No verified historical references returned.'],
])('shows only a concise empty state for error %p', (error, expected) => {
  const { container } = render(<PortfolioResearchHistory {...makeProps({ rows: [], error })} />);
  const empty = screen.getByText(expected);
  expect(empty).toHaveClass('pcv2-intel-span-20', 'pcv2-intel-history-empty');
  expect(empty.parentElement).toHaveClass('is-empty');
  expect(disclosure(container).querySelector('summary')).toHaveTextContent('Previous 5 market days (0 product rows)');
  expect(container).not.toHaveTextContent('Internal historical-provider failure');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('renders prepared research as escaped text without links, buttons, or executable controls', () => {
  const note = '<a href="https://example.com">Historical context</a>';
  const { container } = render(<PortfolioResearchHistory {...makeProps({ rows: [makeRow({
    dateLabel: '<b>Sep 9</b>',
    productLabel: '<button>The Call</button>',
    note,
    reference: { sourceUrl: 'https://example.com' },
  })] })} />);
  expect(screen.getByText('<b>Sep 9</b>')).toBeInTheDocument();
  expect(screen.getByText('<button>The Call</button>')).toBeInTheDocument();
  expect(screen.getByText(note)).toHaveAttribute('title', note);
  expect(container.querySelectorAll('a, button, input, select, textarea, b')).toHaveLength(0);
});

test('does not invent a note or tooltip when the prepared row has no detail', () => {
  const { container } = render(<PortfolioResearchHistory {...makeProps({ rows: [makeRow({ note: '' })] })} />);
  const noteCell = container.querySelector('.pcv2-intel-reference-note');
  expect(noteCell).toBeEmptyDOMElement();
  expect(noteCell).not.toHaveAttribute('title');
  expect(container).not.toHaveTextContent('UNAVAILABLE');
});
