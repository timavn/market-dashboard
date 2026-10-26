import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioMetricVerificationModal from './PortfolioMetricVerificationModal';

// Prepared explanation fixtures only. The portfolio owner validates provider inputs.
const makeSelection = (overrides = {}) => ({
  symbol: 'AMZN',
  metric: 'Beta',
  takeaway: 'The historical estimate measures sensitivity to SPY.',
  formula: 'Beta = covariance / variance',
  equation: '0.000142 / 0.000100 = 1.42',
  result: '1.42',
  details: ['252 daily returns through 2026-09-09.', 'Historical reference; not an executable quote.'],
  ...overrides,
});

// ATR 6 on a 100 close: 6% ATR, a 12% stop, MIN 0.125 / 0.12 → 1.25, MAX 0.25 / 0.12 → 2.00.
const makePositionReference = (overrides = {}) => ({
  available: true,
  value: '1.25–2.00%',
  asOf: '2026-09-09',
  source: 'Verified adjusted daily history',
  minWeight: 1.25,
  maxWeight: 2,
  relativeAtr: 0.06,
  floorApplied: false,
  stopDistance: 0.12,
  atr14: { value: 6, asOf: '2026-09-09' },
  referencePrice: { value: 100, asOf: '2026-09-09' },
  ...overrides,
});

const makeQuadSelection = () => ({
  symbol: 'OIH',
  metric: 'Quad +EV',
  classification: {
    profile: {
      symbol: 'OIH',
      secondaryExposureIds: [],
      classificationNote: 'Oil-services equities use the Energy classification.',
      classificationSources: ['https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/'],
      reviewedAt: '2026-09-07',
    },
    exposure: { label: 'Energy', dimension: 'equitySectors' },
    ranking: {
      orderText: '3 → 2 → 1 → 4',
      fits: [
        { quad: 4, status: 'worst', rank: 1 },
        { quad: 2, status: 'best', rank: 4 },
        { quad: 3, status: 'best', rank: 2 },
        { quad: 1, status: 'not-listed' },
      ],
    },
  },
});

const makeProps = (overrides = {}) => ({
  active: true,
  selection: makeSelection(),
  positionSizeReference: null,
  onClose: jest.fn(),
  ...overrides,
});

test('renders nothing and registers no effective Escape handler without an active selection', () => {
  const props = makeProps({ active: false });
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  view.rerender(<PortfolioMetricVerificationModal {...props} active selection={null} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
});

test('portals the labelled generic calculation directly into the body with unchanged content structure', () => {
  const props = makeProps();
  const { container } = render(<PortfolioMetricVerificationModal {...props} />);
  const modal = screen.getByRole('dialog', { name: 'Beta calculation' });
  expect(container).not.toContainElement(modal);
  expect(modal.parentElement.parentElement).toBe(document.body);
  expect(modal.parentElement).toHaveClass('pcv2-verification-backdrop');
  expect(modal).toHaveClass('pcv2-verification-dialog');
  expect(modal).not.toHaveClass('pcv2-verification-dialog--sizing');
  expect(modal).toHaveAttribute('aria-modal', 'true');
  expect(modal).toHaveAttribute('aria-labelledby', 'pcv2-verification-title');
  expect(within(modal).getByRole('heading', { name: 'Beta calculation' })).toHaveAttribute('id', 'pcv2-verification-title');
  expect(within(modal).getByText('AMZN')).toBeInTheDocument();
  expect(within(modal).getByText('Quick takeaway.').parentElement)
    .toHaveTextContent(`Quick takeaway. ${props.selection.takeaway}`);
  expect(within(modal).getByText(props.selection.formula)).toHaveClass('pcv2-verification-formula');
  expect(within(modal).getByText(props.selection.equation)).toHaveClass('pcv2-verification-equation');
  expect(within(modal).getByText('Result').tagName).toBe('DT');
  expect(within(modal).getByText('1.42').tagName).toBe('DD');
  expect([...modal.querySelector('.pcv2-verification-details').children].map(detail => detail.textContent))
    .toEqual(props.selection.details);
});

test('omits an absent takeaway while retaining zero results and explicitly empty prepared fields', () => {
  const selection = makeSelection({ takeaway: undefined, formula: '', equation: '', result: 0, details: [] });
  render(<PortfolioMetricVerificationModal {...makeProps({ selection })} />);
  const modal = screen.getByRole('dialog', { name: 'Beta calculation' });
  expect(within(modal).queryByText('Quick takeaway.')).not.toBeInTheDocument();
  expect(modal.querySelector('.pcv2-verification-formula')).toBeEmptyDOMElement();
  expect(modal.querySelector('.pcv2-verification-equation')).toBeEmptyDOMElement();
  expect(modal.querySelector('.pcv2-verification-details')).toBeEmptyDOMElement();
  expect(within(modal).getByText('0').tagName).toBe('DD');
});

test('renders prepared explanation strings as text rather than new HTML or controls', () => {
  const selection = makeSelection({
    takeaway: '<img src=x onerror=alert(1)>',
    formula: '<button>Buy</button>',
    equation: '<script>bad()</script>',
    details: ['<a href="https://example.com">Source</a>'],
  });
  render(<PortfolioMetricVerificationModal {...makeProps({ selection })} />);
  const modal = screen.getByRole('dialog', { name: 'Beta calculation' });
  [selection.takeaway, selection.formula, selection.equation, ...selection.details].forEach(value => {
    expect(within(modal).getByText(value)).toBeInTheDocument();
  });
  expect(modal.querySelectorAll('img, script, a, input, select')).toHaveLength(0);
  expect(within(modal).getAllByRole('button')).toHaveLength(1);
});

test('uses the wide position-size explanation and its prepared reference without generic result markup', () => {
  render(<PortfolioMetricVerificationModal {...makeProps({
    selection: { symbol: 'AMZN', metric: 'Position size' },
    positionSizeReference: makePositionReference(),
  })} />);
  const modal = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(modal).toHaveClass('pcv2-verification-dialog--sizing');
  expect(within(modal).getByText('AMZN: 1.25–2.00% of NLV')).toBeInTheDocument();
  expect(within(modal).getByText('AMZN math.').parentElement)
    .toHaveTextContent('ATR 6.00 ÷ close 100.00 = 6.00%. Stop distance = 2 × 6.00% = 12.00%. 0.125% ÷ 12.00% rounds up to 1.25%; 0.25% ÷ 12.00% rounds down to 2.00%.');
  expect(within(modal).getByText(/Operating range based on completed daily bars through 2026-09-09/)).toBeInTheDocument();
  expect(modal.querySelector('.pcv2-sizing-explanation-source'))
    .toHaveTextContent('Source: Verified adjusted daily history. ATR through 2026-09-09.');
  expect(modal.querySelector('.pcv2-verification-result')).not.toBeInTheDocument();
  expect(modal.querySelector('.pcv2-verification-formula')).not.toBeInTheDocument();
  expect(within(modal).queryByRole('button', { name: /order|trade|buy|sell/i })).not.toBeInTheDocument();
});

test('updates the open sizing explanation when its owner invalidates the reference, without retaining the band', () => {
  const props = makeProps({
    selection: { symbol: 'AMZN', metric: 'Position size' },
    positionSizeReference: makePositionReference(),
  });
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  expect(screen.getByText('AMZN: 1.25–2.00% of NLV')).toBeInTheDocument();
  view.rerender(<PortfolioMetricVerificationModal {...props} positionSizeReference={{
    available: false,
    reason: 'Latest completed-session history is unavailable.',
  }} />);
  const modal = screen.getByRole('dialog', { name: 'Position size calculation' });
  expect(within(modal).getByText('Size unavailable.')).toBeInTheDocument();
  expect(within(modal).getByText(/Latest completed-session history is unavailable/)).toBeInTheDocument();
  expect(within(modal).queryByText('AMZN: 1.25–2.00% of NLV')).not.toBeInTheDocument();
  expect(within(modal).queryByText('AMZN math.')).not.toBeInTheDocument();
  expect(modal.querySelector('.pcv2-sizing-explanation-source')).not.toHaveTextContent('ATR through');
  expect(props.onClose).not.toHaveBeenCalled();
});

test('uses the wide quad ranking explanation and classification sources without generic calculation fields', () => {
  render(<PortfolioMetricVerificationModal {...makeProps({ selection: makeQuadSelection() })} />);
  const modal = screen.getByRole('dialog', { name: 'Quad +EV ranking' });
  expect(modal).toHaveClass('pcv2-verification-dialog--sizing');
  expect(within(modal).getByText(/OIH uses Energy in the four-quad \+EV chart/)).toHaveTextContent('Read 3 → 2 → 1 → 4');
  expect(within(modal).getByText('Classification.').parentElement)
    .toHaveTextContent('Equity Sectors → Energy. Oil-services equities use the Energy classification.');
  expect(within(modal).getByText('Chart entries for Energy.').parentElement)
    .toHaveTextContent('Quad 1: not listed; Quad 2: Best #4; Quad 3: Best #2; Quad 4: Worst #1.');
  expect(within(modal).getByRole('link', { name: 'vaneck.com' })).toHaveAttribute(
    'href', 'https://www.vaneck.com/us/en/investments/oil-services-etf-oih/overview/',
  );
  expect(modal.querySelector('.pcv2-verification-result')).not.toBeInTheDocument();
  expect(modal.querySelector('.pcv2-sizing-explanation')).not.toBeInTheDocument();
});

test('keeps generic content tied to the selected snapshot, not unrelated position-size reference updates', () => {
  const props = makeProps();
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  view.rerender(<PortfolioMetricVerificationModal {...props} positionSizeReference={makePositionReference()} />);
  expect(screen.getByText('1.42')).toBeInTheDocument();
  expect(screen.queryByText('AMZN: 1.25–2.00% of NLV')).not.toBeInTheDocument();
  view.rerender(<PortfolioMetricVerificationModal {...props} selection={makeSelection({
    symbol: 'TLT', metric: 'Stop', formula: 'Prepared stop formula', equation: 'Prepared stop inputs', result: '83.76',
  })} />);
  const modal = screen.getByRole('dialog', { name: 'Stop calculation' });
  expect(within(modal).getByText('TLT')).toBeInTheDocument();
  expect(within(modal).getByText('83.76')).toBeInTheDocument();
  expect(within(modal).queryByText('1.42')).not.toBeInTheDocument();
});

test('autofocuses the labelled close button and delegates dismissal to the controlled owner', () => {
  const props = makeProps();
  render(<PortfolioMetricVerificationModal {...props} />);
  const close = screen.getByRole('button', { name: 'Close calculation' });
  expect(close).toHaveFocus();
  expect(close).toHaveAttribute('type', 'button');
  expect(close).toHaveAttribute('title', 'Close');
  fireEvent.click(close);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog', { name: 'Beta calculation' })).toBeInTheDocument();
});

test('dismisses only direct backdrop mousedown events, not dialog content or backdrop clicks', () => {
  const props = makeProps();
  render(<PortfolioMetricVerificationModal {...props} />);
  const modal = screen.getByRole('dialog', { name: 'Beta calculation' });
  fireEvent.mouseDown(within(modal).getByText(props.selection.formula));
  fireEvent.mouseDown(modal);
  fireEvent.click(modal.parentElement);
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(modal.parentElement);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('delegates Escape without swallowing the event and ignores other keys', () => {
  const props = makeProps();
  render(<PortfolioMetricVerificationModal {...props} />);
  fireEvent.keyDown(document, { key: 'Enter' });
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(props.onClose).not.toHaveBeenCalled();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(document, escape);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(escape.defaultPrevented).toBe(false);
});

test('removes the Escape handler while hidden or unselected and restores the retained selection on reactivation', () => {
  const props = makeProps();
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  view.rerender(<PortfolioMetricVerificationModal {...props} active={false} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
  view.rerender(<PortfolioMetricVerificationModal {...props} />);
  expect(screen.getByRole('dialog', { name: 'Beta calculation' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close calculation' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledTimes(1);
  view.rerender(<PortfolioMetricVerificationModal {...props} selection={null} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('removes both the portal and its document Escape handler on unmount', () => {
  const props = makeProps();
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  view.unmount();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
});

test('uses the latest close callback exactly once per action after callback and selection updates', () => {
  const props = makeProps();
  const view = render(<PortfolioMetricVerificationModal {...props} />);
  const latestClose = jest.fn();
  view.rerender(<PortfolioMetricVerificationModal {...props} onClose={latestClose} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  view.rerender(<PortfolioMetricVerificationModal {...props} onClose={latestClose} selection={makeSelection({ symbol: 'TLT' })} />);
  const modal = screen.getByRole('dialog', { name: 'Beta calculation' });
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(within(modal).getByRole('button', { name: 'Close calculation' }));
  fireEvent.mouseDown(modal.parentElement);
  expect(latestClose).toHaveBeenCalledTimes(4);
  expect(props.onClose).not.toHaveBeenCalled();
});
