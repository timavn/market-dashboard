import React from 'react';
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystSpinner from './AnalystSpinner';

afterEach(() => jest.useRealTimers());

test('the indicator rolls muted digits, hidden from screen readers, on one shared timer that stops with the last one', () => {
  jest.useFakeTimers();
  const intervals = jest.spyOn(global, 'setInterval');
  const { container, unmount: unmountFirst } = render(<AnalystSpinner size={16} />);
  const { unmount: unmountSecond } = render(<AnalystSpinner size={12} />);
  const digits = container.querySelector('.analyst-spinner');
  expect(digits).toHaveAttribute('aria-hidden', 'true');
  expect(digits).toHaveTextContent(/^\d\.\d\d$/);
  const readings = new Set();
  for (let tick = 0; tick < 10; tick += 1) {
    act(() => { jest.advanceTimersByTime(90); });
    readings.add(digits.textContent);
    expect(digits.textContent).toMatch(/^\d\.\d\d$/);
  }
  expect(readings.size).toBeGreaterThan(1);
  expect(intervals.mock.calls.filter(([, delay]) => delay === 90)).toHaveLength(1);
  unmountFirst();
  unmountSecond();
  expect(jest.getTimerCount()).toBe(0);
  intervals.mockRestore();
});

test('with elapsed the blue seconds still follow the digits', () => {
  jest.useFakeTimers();
  const { container } = render(<AnalystSpinner label="Loading" elapsed />);
  expect(container.querySelector('.analyst-spinner-group')).toHaveAttribute('role', 'status');
  act(() => { jest.advanceTimersByTime(2_000); });
  expect(container.querySelector('.analyst-spinner-elapsed')).toHaveTextContent('2s');
});
