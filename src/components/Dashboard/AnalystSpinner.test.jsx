import React from 'react';
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystSpinner from './AnalystSpinner';

afterEach(() => jest.useRealTimers());

test('the indicator is a ring at the requested size, hidden from screen readers, with no timer of its own', () => {
  jest.useFakeTimers();
  const { container } = render(<AnalystSpinner size={16} />);
  const ring = container.querySelector('svg.analyst-spinner');
  expect(ring).toHaveAttribute('aria-hidden', 'true');
  expect(ring).toHaveAttribute('width', '16');
  expect(ring).toHaveAttribute('height', '16');
  expect(ring.querySelector('.analyst-spinner-track')).toBeInTheDocument();
  expect(ring.querySelector('.analyst-spinner-arc')).toBeInTheDocument();
  expect(ring).toHaveTextContent('');
  expect(jest.getTimerCount()).toBe(0);
});

test('a label alone makes the ring announce itself as a status', () => {
  const { getByRole } = render(<AnalystSpinner label="Loading" />);
  expect(getByRole('status', { name: 'Loading' })).toHaveClass('analyst-spinner');
});

test('with elapsed the blue seconds still follow the ring', () => {
  jest.useFakeTimers();
  const { container } = render(<AnalystSpinner label="Loading" elapsed />);
  expect(container.querySelector('.analyst-spinner-group')).toHaveAttribute('role', 'status');
  act(() => { jest.advanceTimersByTime(2_000); });
  expect(container.querySelector('.analyst-spinner-elapsed')).toHaveTextContent('2s');
});
