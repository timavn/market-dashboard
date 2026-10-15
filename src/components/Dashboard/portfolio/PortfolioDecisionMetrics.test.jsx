import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioDecisionMetrics from './PortfolioDecisionMetrics';
import { getLeveragedProducts } from '../../../constants/leveragedProductCatalog';

// Prepared display fixtures only. Provider validation remains in the owner.
const makeMetrics = (overrides = {}) => ({
  tick: { value: 'BULLISH', meta: 'HedgAI · Sep 10, 2026', tone: 'is-positive' },
  trade: { value: 'BULLISH', meta: 'Risk Ranges · Sep 10, 2026', tone: 'is-positive' },
  trend: { value: 'BEARISH', meta: 'The Call · Sep 10, 2026', tone: 'is-negative' },
  beta: { value: '1.41', meta: '252D vs SPY · Sep 9, 2026', tone: 'is-positive', className: 'is-reference' },
  factorContribution: { value: '-3.7%', meta: 'Financials · signed % NAV', title: 'Current signed position contribution.', tone: 'is-negative' },
  quad: { value: 'Not covered', meta: 'No verified chart ranking.' },
  signal: { value: 'HIGH', meta: 'Signal Strength · Sep 10, 2026', tone: 'is-positive' },
  lowRange: { value: '120.25', meta: 'Risk Ranges · Sep 10, 2026', title: 'Low price risk range', tone: '' },
  highRange: { value: '132.75', meta: 'Risk Ranges · Sep 10, 2026', title: 'High price risk range', tone: '' },
  otherExposure: { value: 'Financials', meta: 'Sector · controlled', title: 'Sector · Financials' },
  coverage: { value: 'PARTIAL', meta: 'Partial research coverage', title: 'Missing verified signal.', tone: 'is-negative' },
  ...overrides,
});

const makeProps = (overrides = {}) => ({
  symbol: 'BKLN',
  metrics: makeMetrics(),
  quadRanking: null,
  onExplainBeta: jest.fn(),
  onExplainQuad: jest.fn(),
  onSelectLeveragedProduct: jest.fn(),
  ...overrides,
});

const primaryGrid = (symbol = 'BKLN') => screen.getByLabelText(`${symbol} decision intelligence`);
const secondaryGrid = (symbol = 'BKLN') => screen.getByLabelText(`${symbol} supplemental decision intelligence`);

test('preserves four wrapper-free grids, header labels, cell order, and the existing twenty-column layout', () => {
  const { container } = render(<PortfolioDecisionMetrics {...makeProps()} />);
  const headers = screen.getByLabelText('Decision intelligence headers');
  const secondaryHeaders = screen.getByLabelText('Decision intelligence secondary headers');
  expect([...container.children]).toEqual([headers, primaryGrid(), secondaryHeaders, secondaryGrid()]);
  expect(headers).toHaveClass('pcv2-intel-grid', 'pcv2-intel-header');
  expect(secondaryHeaders).toHaveClass('pcv2-intel-grid', 'pcv2-intel-header');
  expect(primaryGrid()).toHaveClass('pcv2-intel-grid', 'pcv2-intel-values');
  expect(secondaryGrid()).toHaveClass('pcv2-intel-grid', 'pcv2-intel-values');
  expect([...headers.children].map((cell) => cell.textContent))
    .toEqual(['Tick', 'Trade', 'Trend', 'Beta', 'Factor Ctrb', 'Quad +EV']);
  expect([...secondaryHeaders.children].map((cell) => cell.textContent))
    .toEqual(['Levered products', 'Signal strength', 'LRR', 'HRR', 'Other exposure', 'Coverage']);
  expect([...primaryGrid().children].map((cell) => cell.textContent))
    .toEqual(['BULLISH', 'BULLISH', 'BEARISH', '1.41', '-3.7%', 'Not covered']);
  expect([...secondaryGrid().children].map((cell) => cell.textContent))
    .toEqual(['—', 'HIGH', '120.25', '132.75', 'Financials', 'PARTIAL']);
  [headers, primaryGrid()].forEach((grid) => [...grid.children].forEach((cell, index) => {
    expect(cell).toHaveClass('pcv2-intel-cell', `pcv2-intel-span-${index < 4 ? 3 : 4}`);
  }));
  [secondaryHeaders, secondaryGrid()].forEach((grid) => {
    [...grid.children].forEach((cell, index) => {
      expect(cell).toHaveClass('pcv2-intel-cell', `pcv2-intel-span-${index === 2 || index === 3 ? 2 : 4}`);
    });
  });
  expect(within(secondaryHeaders).getByText('LRR')).toHaveAttribute('title', 'Low price risk range');
  expect(within(secondaryHeaders).getByText('HRR')).toHaveAttribute('title', 'High price risk range');
  expect(within(secondaryHeaders).getByText('Coverage')).not.toHaveAttribute('title');
});

test('preserves prepared values, source/date provenance, reference treatment, and semantic tones', () => {
  const metrics = makeMetrics();
  render(<PortfolioDecisionMetrics {...makeProps({ metrics })} />);
  const metricOrder = [
    ...['tick', 'trade', 'trend', 'beta', 'factorContribution', 'quad'].map((key, index) => [key, primaryGrid().children[index]]),
    ...['signal', 'lowRange', 'highRange', 'otherExposure', 'coverage'].map((key, index) => [key, secondaryGrid().children[index + 1]]),
  ];
  metricOrder.forEach(([key, cell]) => {
    const metric = metrics[key];
    expect(cell).toHaveAttribute('title', metric.title || metric.meta);
    expect(cell).toHaveAccessibleName([metric.value, metric.meta, metric.title].filter(Boolean).join(' · '));
  });
  metricOrder.filter(([key]) => metrics[key].tone).forEach(([key, cell]) => {
    expect(within(cell).getByText(metrics[key].value)).toHaveClass(metrics[key].tone);
  });
  metricOrder.filter(([key]) => metrics[key].className).forEach(([key, cell]) => {
    expect(cell).toHaveClass(metrics[key].className);
  });
  expect(primaryGrid().children[3]).toHaveClass('is-reference');
  expect(primaryGrid().children[0]).not.toHaveClass('is-reference');
  expect(screen.queryByText('LIVE', { exact: true })).not.toBeInTheDocument();
});

test('makes only the beta and quad headings explanatory controls, keeping metric values noninteractive', () => {
  const props = makeProps();
  render(<PortfolioDecisionMetrics {...props} />);
  const beta = screen.getByRole('button', { name: 'Explain BKLN beta calculation' });
  const quad = screen.getByRole('button', { name: 'Explain BKLN quad ranking' });
  expect(beta).toHaveClass('pcv2-intel-header-button');
  expect(beta).toHaveAttribute('type', 'button');
  expect(beta).toHaveAttribute('title', 'Click for beta calculation and a plain-English takeaway');
  expect(quad).toHaveAttribute('title', 'Click for the primary factor, chart ranks, and a plain-English takeaway');
  fireEvent.click(beta);
  fireEvent.click(quad);
  expect(props.onExplainBeta).toHaveBeenCalledTimes(1);
  expect(props.onExplainQuad).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('button')).toEqual([beta, quad]);
  expect(within(primaryGrid()).queryByRole('button')).not.toBeInTheDocument();
  expect(within(secondaryGrid()).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('preserves a supplied quad order and tied groups without sorting or recalculating them', () => {
  const quadRanking = {
    groups: [[{ quad: 3 }, { quad: 1 }], [{ quad: 4 }], [{ quad: 2 }]],
    orderText: '3 = 1 > 4 > 2',
  };
  render(<PortfolioDecisionMetrics {...makeProps({
    metrics: makeMetrics({ quad: { value: null, meta: 'Financials · chart order · = tied' } }),
    quadRanking,
  })} />);
  const order = screen.getByLabelText('Quad order 3 = 1 > 4 > 2');
  expect(order).toHaveClass('pcv2-intel-quad-order');
  expect(order.textContent).toBe('3=1›4›2');
  expect([...order.querySelectorAll('.pcv2-intel-quad')].map((chip) => [chip.textContent, chip.className]))
    .toEqual([
      ['3', 'pcv2-intel-quad is-q3'],
      ['1', 'pcv2-intel-quad is-q1'],
      ['4', 'pcv2-intel-quad is-q4'],
      ['2', 'pcv2-intel-quad is-q2'],
    ]);
  expect([...order.querySelectorAll('.pcv2-intel-quad-arrow')].map((arrow) => arrow.textContent))
    .toEqual(['=', '›', '›']);
  expect(primaryGrid().children[5]).toHaveAttribute('title', 'Financials · chart order · = tied');
  expect(within(order).queryByRole('button')).not.toBeInTheDocument();
});

test.each(['Not covered', 'Unclassified'])('keeps the prepared %s explanation without inventing a quad ranking', (value) => {
  const { container } = render(<PortfolioDecisionMetrics {...makeProps({
    metrics: makeMetrics({ quad: { value, meta: 'No controlled chart mapping.' } }),
  })} />);
  expect(primaryGrid().children[5]).toHaveTextContent(value);
  expect(primaryGrid().children[5]).toHaveAttribute('title', 'No controlled chart mapping.');
  expect(container.querySelector('.pcv2-intel-quad-order')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Explain BKLN quad ranking' })).toBeInTheDocument();
});

test('renders loading and empty display states exactly as prepared rather than inventing values', () => {
  render(<PortfolioDecisionMetrics {...makeProps({ metrics: makeMetrics({
    tick: { value: '—', meta: 'Published Tick unavailable', tone: 'is-muted' },
    trade: { value: '…', meta: 'Loading verified research', tone: 'is-muted' },
    trend: { value: '—', meta: 'Verified trend unavailable', tone: 'is-muted' },
    beta: { value: '…', meta: 'Historical beta unavailable', tone: 'is-muted' },
    signal: { value: '…', meta: 'Loading verified research', tone: 'is-muted' },
    lowRange: { value: '…', meta: 'Risk range unavailable', tone: 'is-muted' },
    highRange: { value: '—', meta: 'Risk range unavailable', tone: 'is-muted' },
  }) })} />);
  expect([...primaryGrid().children].slice(1, 4).map((cell) => cell.textContent)).toEqual(['…', '—', '…']);
  expect([...secondaryGrid().children].slice(1, 4).map((cell) => cell.textContent)).toEqual(['…', '…', '—']);
  expect(within(primaryGrid().children[1]).getByText('…')).toHaveClass('is-muted');
  expect(screen.queryByText('BULLISH')).not.toBeInTheDocument();
  expect(screen.queryByText('120.25')).not.toBeInTheDocument();
});

test('does not retain prior metrics when the owner supplies an unavailable projection', () => {
  const props = makeProps();
  const view = render(<PortfolioDecisionMetrics {...props} />);
  const unavailableMetrics = Object.fromEntries(Object.keys(props.metrics).map((key) => [key, {
    value: '—', meta: 'Verified data unavailable', tone: 'is-muted',
  }]));
  view.rerender(<PortfolioDecisionMetrics {...props} metrics={unavailableMetrics} />);
  [...primaryGrid().children, ...secondaryGrid().children].forEach((cell) => {
    expect(cell).toHaveTextContent(/^—$/);
    expect(within(cell).getByText('—')).toHaveClass('is-muted');
    expect(cell).not.toHaveClass('is-reference');
  });
  expect(screen.queryByText('1.41')).not.toBeInTheDocument();
  expect(screen.queryByText('-3.7%')).not.toBeInTheDocument();
  expect(screen.queryByText('BULLISH')).not.toBeInTheDocument();
});

test('keeps valid reference-only signals dated without promoting them to executable data', () => {
  render(<PortfolioDecisionMetrics {...makeProps({ metrics: makeMetrics({
    trade: { value: 'BULLISH', meta: 'Reference only · Risk Ranges · Sep 9, 2026', tone: 'is-positive', className: 'is-reference' },
    factorContribution: { value: '—', meta: 'Verified live NAV contribution unavailable', tone: 'is-muted' },
  }) })} />);
  const trade = primaryGrid().children[1];
  expect(trade).toHaveClass('is-reference');
  expect(trade).toHaveAttribute('title', 'Reference only · Risk Ranges · Sep 9, 2026');
  expect(within(trade).getByText('BULLISH')).toHaveClass('is-positive');
  expect(primaryGrid().children[4]).toHaveTextContent('—');
  expect(screen.queryByRole('button', { name: /trade|buy|sell|order|size/i })).not.toBeInTheDocument();
  expect(screen.queryByText('LIVE', { exact: true })).not.toBeInTheDocument();
});

test('preserves numeric zero and explicitly empty prepared values', () => {
  render(<PortfolioDecisionMetrics {...makeProps({ metrics: makeMetrics({
    beta: { value: 0, meta: '252D vs SPY · Sep 9, 2026', tone: 'is-muted' },
    factorContribution: { value: '0.0%', meta: 'Zero signed contribution', tone: 'is-muted' },
    otherExposure: { value: '', meta: '', title: null },
  }) })} />);
  expect(primaryGrid().children[3]).toHaveTextContent(/^0$/);
  expect(primaryGrid().children[3]).toHaveAccessibleName('0 · 252D vs SPY · Sep 9, 2026');
  expect(primaryGrid().children[4]).toHaveTextContent('0.0%');
  expect(secondaryGrid().children[4].firstElementChild).toBeEmptyDOMElement();
  expect(secondaryGrid().children[4]).not.toHaveAttribute('title');
});

test('renders prepared metric content as text, not HTML or new controls', () => {
  const value = '<img src=x onerror=alert(1)>';
  const meta = '<a href="https://example.com">Source</a>';
  const { container } = render(<PortfolioDecisionMetrics {...makeProps({ metrics: makeMetrics({
    otherExposure: { value, meta, title: '<button>Details</button>' },
  }) })} />);
  expect(screen.getByText(value)).toBeInTheDocument();
  expect(secondaryGrid().children[4]).toHaveAttribute('title', '<button>Details</button>');
  expect(secondaryGrid().children[4]).toHaveAccessibleName(`${value} · ${meta} · <button>Details</button>`);
  expect(container.querySelectorAll('img, a, script, input, select, textarea')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Details' })).not.toBeInTheDocument();
});

test('uses the latest symbol, explanation callbacks, and values on rerender without retaining a quad order', () => {
  const first = makeProps({ symbol: 'IAK', quadRanking: { groups: [[{ quad: 1 }]], orderText: '1' } });
  const view = render(<PortfolioDecisionMetrics {...first} />);
  fireEvent.click(screen.getByRole('button', { name: 'Explain IAK beta calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Explain IAK quad ranking' }));
  expect(screen.getByLabelText('Quad order 1')).toBeInTheDocument();
  const next = makeProps({ symbol: 'GLD', metrics: makeMetrics({ beta: { value: '-0.05', meta: '252D vs SPY · Sep 10, 2026', tone: 'is-negative' } }) });
  view.rerender(<PortfolioDecisionMetrics {...next} />);
  fireEvent.click(screen.getByRole('button', { name: 'Explain GLD beta calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Explain GLD quad ranking' }));
  expect(first.onExplainBeta).toHaveBeenCalledTimes(1);
  expect(first.onExplainQuad).toHaveBeenCalledTimes(1);
  expect(next.onExplainBeta).toHaveBeenCalledTimes(1);
  expect(next.onExplainQuad).toHaveBeenCalledTimes(1);
  expect(primaryGrid('GLD').children[3]).toHaveTextContent('-0.05');
  expect(secondaryGrid('GLD')).toBeInTheDocument();
  expect(screen.queryByLabelText('IAK decision intelligence')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Quad order 1')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Explain IAK/ })).not.toBeInTheDocument();
});

test('forwards the existing leveraged-product selection and switches catalog and callback with the symbol', () => {
  const first = makeProps({ symbol: 'IAK' });
  const view = render(<PortfolioDecisionMetrics {...first} />);
  const faz = within(secondaryGrid('IAK')).getByRole('button', { name: 'View FAZ −3× details for IAK' });
  expect(faz).toHaveClass('is-negative', 'is-proxy');
  fireEvent.click(faz);
  expect(first.onSelectLeveragedProduct).toHaveBeenCalledWith({
    baseSymbol: 'IAK', product: getLeveragedProducts('IAK').find((product) => product.ticker === 'FAZ'),
  });
  const next = makeProps({ symbol: 'GLD' });
  view.rerender(<PortfolioDecisionMetrics {...next} />);
  const ugld = within(secondaryGrid('GLD')).getByRole('button', { name: 'View UGLD +2× details for GLD' });
  expect(ugld).toHaveClass('is-positive');
  expect(ugld).not.toHaveClass('is-proxy');
  fireEvent.click(ugld);
  expect(next.onSelectLeveragedProduct).toHaveBeenCalledWith({
    baseSymbol: 'GLD', product: getLeveragedProducts('GLD').find((product) => product.ticker === 'UGLD'),
  });
  expect(first.onSelectLeveragedProduct).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /View FAZ/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('does not mutate prepared metrics or ranking data while rendering or handling explanation clicks', () => {
  const metrics = Object.freeze(Object.fromEntries(Object.entries(makeMetrics()).map(([key, value]) => [key, Object.freeze(value)])));
  const quadRanking = Object.freeze({
    groups: Object.freeze([Object.freeze([Object.freeze({ quad: 4 })]), Object.freeze([Object.freeze({ quad: 2 })])]),
    orderText: '4 > 2',
  });
  const before = JSON.stringify({ metrics, quadRanking });
  render(<PortfolioDecisionMetrics {...makeProps({ metrics, quadRanking })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Explain BKLN beta calculation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Explain BKLN quad ranking' }));
  expect(JSON.stringify({ metrics, quadRanking })).toBe(before);
});
