import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioResearchPanel from './PortfolioResearchPanel';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

// Keep catalog contents outside this composition test. All four research
// sections are real components; this leaf emits only an explicit test payload.
jest.mock('./LeveragedProductsCell', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ symbol, onSelect }) => React.createElement('button', {
      type: 'button', onClick: () => onSelect({ symbol, product: { ticker: 'TESTL' } }),
    }, `Select test product for ${symbol}`),
  };
});

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const currentRow = () => ({
  key: 'the-call', productId: 'the-call', productLabel: 'The Call', state: 'available',
  factLines: ['GLD remains in the published list.', 'Published supporting detail.'],
  marketDate: '2026-09-10', publishedAt: '2026-09-10T13:42:00Z',
  reference: { sourceUrl: '/research/the-call/current' },
});
const makeProps = () => ({
  rowId: 'account-a-GLD', symbol: 'GLD', expandedProducts: new Set(),
  actions: {
    onExplainBeta: jest.fn(), onExplainQuad: jest.fn(),
    onSelectLeveragedProduct: jest.fn(), onToggleProduct: jest.fn(),
  },
  model: freeze({
    healthStatus: 'verified', busy: true,
    decision: {
      metrics: {
        trade: { value: 'BULLISH', tone: 'is-positive' },
        trend: { value: 'NEUTRAL' }, beta: { value: '0.42' },
        factorContribution: { value: '+3.7%' }, quad: { value: null },
        signal: { value: 'ADDED' }, lowRange: { value: '180' }, highRange: { value: '200' },
        otherExposure: { value: 'Gold' }, coverage: { value: 'PARTIAL' },
      },
      quadRanking: { groups: [[{ quad: 2 }], [{ quad: 1 }]], orderText: '2 > 1' },
    },
    marketContext: {
      metrics: {
        zScore: { value: '+1.25' },
        sizingVolatility: { value: '18.0%', onClick: jest.fn(), buttonLabel: 'Explain GLD sizing volatility' },
        volatilityIndex: { value: 'GVZ 18.25' }, usdCorrelation: { value: '-0.72' },
        stopLoss: { value: '191.00', onClick: jest.fn(), buttonLabel: 'Explain GLD stop loss' },
      },
      sizingVolatilityDisplay: { text: '18.0%', badge: { label: '63D', className: 'is-reference' } },
      volatilityReadings: [],
    },
    products: { rows: [currentRow()], loading: false },
    history: {
      rows: [{ key: '2026-09-09:the-call', productLabel: 'The Call', dateLabel: 'Sep 9', note: 'Earlier published GLD detail.' }],
      historyDays: 5, loading: false, error: false,
    },
  }),
});

test('composes the existing sections in order and forwards prepared metrics, wrapper metadata, and explanation actions', () => {
  const props = makeProps();
  const { container, rerender } = render(<PortfolioResearchPanel {...props} />);
  const panel = screen.getByLabelText('Research intelligence for GLD');
  expect(container.children).toHaveLength(1);
  expect(panel).toHaveClass('pcv2-intel-panel');
  expect(panel).toHaveAttribute('id', 'portfolio-research-account-a-GLD');
  expect(panel).toHaveAttribute('data-health-status', 'verified');
  expect(panel).toHaveAttribute('aria-busy', 'true');
  const headings = [
    within(panel).getByLabelText('Decision intelligence headers'),
    within(panel).getByLabelText('Market context headers'),
    within(panel).getByLabelText('GLD research product references'),
    within(panel).getByText('Previous 5 market days (1 product rows)').closest('details'),
  ];
  headings.slice(1).forEach((heading, index) => {
    expect(headings[index].compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  expect(within(panel).getByLabelText('GLD decision intelligence')).toHaveTextContent('BULLISHNEUTRAL0.42+3.7%2›1');
  expect(within(panel).getByLabelText('Quad order 2 > 1')).toBeInTheDocument();
  const context = within(panel).getByLabelText('GLD market context');
  expect(context).toHaveTextContent('+1.25');
  expect(context).toHaveTextContent('18.0%63D');
  expect(context).toHaveTextContent('GVZ 18.25');
  expect(context).toHaveTextContent('-0.72');
  fireEvent.click(within(panel).getByRole('button', { name: 'Explain GLD beta calculation' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Explain GLD quad ranking' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Explain GLD sizing volatility' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Explain GLD stop loss' }));
  fireEvent.click(within(panel).getByRole('button', { name: 'Select test product for GLD' }));
  expect(props.actions.onExplainBeta).toHaveBeenCalledTimes(1);
  expect(props.actions.onExplainQuad).toHaveBeenCalledTimes(1);
  expect(props.model.marketContext.metrics.sizingVolatility.onClick).toHaveBeenCalledTimes(1);
  expect(props.model.marketContext.metrics.stopLoss.onClick).toHaveBeenCalledTimes(1);
  expect(props.actions.onSelectLeveragedProduct).toHaveBeenCalledWith({ symbol: 'GLD', product: { ticker: 'TESTL' } });
  rerender(<PortfolioResearchPanel {...props} model={{ ...props.model, healthStatus: null, busy: false }} />);
  expect(panel).not.toHaveAttribute('data-health-status');
  expect(panel).toHaveAttribute('aria-busy', 'false');
});

test('keeps product expansion controlled and keyed by position identity while preserving source detail', () => {
  const props = makeProps();
  props.expandedProducts = new Set(['account-b-GLD:the-call']);
  const { rerender } = render(<PortfolioResearchPanel {...props} />);
  const button = screen.getByRole('button', { name: 'View The Call facts for GLD' });
  expect(button).toHaveAttribute('aria-controls', 'research-product-context-account-a-GLD-the-call');
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: 'View The Call context for GLD' }));
  expect(props.actions.onToggleProduct.mock.calls).toEqual([['account-a-GLD:the-call'], ['account-a-GLD:the-call']]);
  expect([...props.expandedProducts]).toEqual(['account-b-GLD:the-call']);
  expect(screen.queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
  const selected = new Set(['account-a-GLD:the-call']);
  rerender(<PortfolioResearchPanel {...props} expandedProducts={selected} />);
  const region = screen.getByRole('region', { name: 'The Call facts for GLD' });
  expect(region).toHaveAttribute('id', 'research-product-context-account-a-GLD-the-call');
  expect(within(region).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Published supporting detail.']);
  expect(within(region).getByRole('link', { name: 'OPEN SOURCE ↗' })).toHaveAttribute('href', '/research/the-call/current');
  const summary = screen.getByText('Previous 5 market days (1 product rows)');
  fireEvent.click(summary);
  expect(summary.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('Earlier published GLD detail.')).toBeInTheDocument();
  rerender(<PortfolioResearchPanel {...props} rowId="account-b-GLD" expandedProducts={selected} />);
  expect(screen.getByLabelText('Research intelligence for GLD')).toHaveAttribute('id', 'portfolio-research-account-b-GLD');
  expect(screen.getByRole('button', { name: 'View The Call facts for GLD' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'The Call facts for GLD' })).not.toBeInTheDocument();
});

test('keeps research and history loading independent without rendering retained current facts as available', () => {
  const props = makeProps();
  const loadingModel = {
    ...props.model,
    products: { ...props.model.products, loading: true },
    history: { ...props.model.history, rows: [], loading: true },
  };
  const { rerender } = render(<PortfolioResearchPanel {...props} model={loadingModel} />);
  expect(screen.getByText('Loading verified research…')).toBeInTheDocument();
  expect(screen.queryByTestId('research-product-row-account-a-GLD-the-call')).not.toBeInTheDocument();
  expect(screen.queryByText('GLD remains in the published list.')).not.toBeInTheDocument();
  const summary = screen.getByText('Previous 5 market days (loading…)');
  fireEvent.click(summary);
  expect(screen.getByText('Loading verified historical references…')).toBeInTheDocument();
  expect(screen.getByLabelText('GLD market context')).toHaveTextContent('+1.25');
  rerender(<PortfolioResearchPanel {...props} model={{
    ...props.model, busy: false,
    history: { ...props.model.history, rows: [], loading: false, error: true },
  }} />);
  expect(screen.getByTestId('research-product-row-account-a-GLD-the-call')).toHaveTextContent('GLD remains in the published list.');
  expect(summary).toHaveTextContent('Previous 5 market days (0 product rows)');
  expect(summary.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('Historical references unavailable.')).toBeInTheDocument();
  expect(props.actions.onToggleProduct).not.toHaveBeenCalled();
});
