import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioQuadReference from '../PortfolioQuadReference';
import expectedValuesData from '../../../constants/expectedValuesData';
import { PORTFOLIO_QUAD_READINGS_KEY } from '../../../utils/portfolioQuadReadings';

const reading = quad => ({ quad, asOf: '2026-09-08', source: 'manual-hedgeye' });
const savedReadings = { global: reading(2), usMonthly: reading(3), usQuarterly: reading(4) };

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-08T15:00:00Z'));
  localStorage.removeItem(PORTFOLIO_QUAD_READINGS_KEY);
});
afterEach(() => {
  jest.useRealTimers();
  localStorage.removeItem(PORTFOLIO_QUAD_READINGS_KEY);
});

const mountWithReadings = () => {
  localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify(savedReadings));
  return render(<PortfolioQuadReference />);
};

test('defaults to U.S. monthly while displaying the three independent current readings', () => {
  mountWithReadings();
  expect(screen.getAllByRole('combobox').map(select => select.getAttribute('aria-label'))).toEqual([
    'U.S. Monthly current quad', 'U.S. Quarterly current quad', 'Global current quad',
  ]);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Current quad readings')).not.toHaveTextContent(/Manual|Sep 8|Aug 31|Not set/);
  expect(screen.getByLabelText('Global current quad')).toHaveValue('2');
  expect(screen.getByLabelText('U.S. Monthly current quad')).toHaveValue('3');
  expect(screen.getByLabelText('U.S. Quarterly current quad')).toHaveValue('4');
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 3 best and worst' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View Quad 3 Stagflation' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getAllByRole('button')).toHaveLength(4);
  expect(screen.queryByText(/Following U.S. Monthly|Follow U.S. Monthly|Hedgeye · Best \/ Worst/)).not.toBeInTheDocument();
  expect(screen.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['', 'Best', 'Worst']);
  expect(screen.getByRole('columnheader', { name: 'Category' })).toBeEmptyDOMElement();
});

test('shows the exact saved Hedgeye labels and order in every quad, independently of portfolio holdings', () => {
  render(<PortfolioQuadReference />);
  const dimensions = {
    'Asset Classes': ['bestAssetClasses', 'worstAssetClasses'],
    'Equity Sectors': ['bestEquitySectors', 'worstEquitySectors'],
    'Equity Style Factors': ['bestEquityStyleFactors', 'worstEquityStyleFactors'],
    'Fixed Income Sectors': ['bestFixedIncomeSectors', 'worstFixedIncomeSectors'],
  };
  expectedValuesData.quadData.forEach((expected, index) => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^View Quad ${index + 1} `) }));
    Object.entries(dimensions).forEach(([dimension, fields]) => {
      ['best', 'worst'].forEach((side, sideIndex) => {
        const list = screen.getByRole('list', { name: `${dimension} ${side}` });
        expect(within(list).getAllByRole('listitem').map(item => item.textContent))
          .toEqual(expected[fields[sideIndex]].split(', '));
      });
    });
  });
  expect(localStorage.getItem(PORTFOLIO_QUAD_READINGS_KEY)).toBeNull();
});

test('keeps an explicit reference selection separate from current readings and restores monthly following', () => {
  mountWithReadings();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 1 Goldilocks' }));
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 1 best and worst' })).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(PORTFOLIO_QUAD_READINGS_KEY))).toEqual(savedReadings);

  fireEvent.change(screen.getByLabelText('U.S. Monthly current quad'), { target: { value: '2' } });
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 1 best and worst' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 2 Reflation' }));
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 2 best and worst' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('U.S. Monthly current quad'), { target: { value: '4' } });
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 4 best and worst' })).toBeInTheDocument();
});

test('restores saved readings on reopen but resets a browsing override to the monthly default', () => {
  const view = mountWithReadings();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 1 Goldilocks' }));
  view.unmount();
  render(<PortfolioQuadReference />);
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 3 best and worst' })).toBeInTheDocument();
});

test('keeps explicitly cleared current quads empty while allowing all four references', () => {
  localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify({ global: null, usMonthly: null, usQuarterly: null }));
  render(<PortfolioQuadReference />);
  screen.getAllByRole('combobox').forEach(select => expect(select).toHaveValue(''));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 3 Stagflation' }));
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 3 best and worst' })).toBeInTheDocument();
  screen.getAllByRole('combobox').forEach(select => expect(select).toHaveValue(''));
});

test('loads published readings without date captions or inbox links when browser storage is corrupt', () => {
  localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, '{invalid');
  render(<PortfolioQuadReference />);
  expect(screen.getByLabelText('Global current quad')).toHaveValue('3');
  expect(screen.getByLabelText('U.S. Monthly current quad')).toHaveValue('2');
  expect(screen.getByLabelText('U.S. Quarterly current quad')).toHaveValue('4');
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 2 best and worst' })).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Current quad readings')).not.toHaveTextContent(/Sep 8|Aug 31/);
  expect(screen.getByLabelText('U.S. Quarterly current quad')).toHaveAttribute('title', expect.stringContaining('2026-08-31'));
});

test('receives monthly updates from another tab without replacing an explicit reference selection', () => {
  mountWithReadings();
  const publish = quad => {
    localStorage.setItem(PORTFOLIO_QUAD_READINGS_KEY, JSON.stringify({ ...savedReadings, usMonthly: reading(quad) }));
    fireEvent(window, new StorageEvent('storage', { key: PORTFOLIO_QUAD_READINGS_KEY }));
  };
  publish(2);
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 2 best and worst' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 1 Goldilocks' }));
  publish(4);
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 1 best and worst' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Quad 4 Deflation' }));
  publish(2);
  expect(screen.getByRole('table', { name: 'Hedgeye Quad 2 best and worst' })).toBeInTheDocument();
});
