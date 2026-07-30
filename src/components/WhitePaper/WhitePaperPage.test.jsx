import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import WhitePaperPage from './WhitePaperPage';

jest.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: jest.fn() }),
}));

test('keeps the legacy component import mapped to the Position Sizing note', () => {
  window.scrollTo = jest.fn();
  render(<WhitePaperPage />);

  expect(screen.getByTestId('process-page')).toHaveAttribute('data-document-id', 'position-sizing');
  expect(document.querySelector('#position-sizing-title')).toHaveTextContent('Position Sizing');
});
