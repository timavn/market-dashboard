import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProcessOverlay from './ProcessOverlay';

jest.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'light',
    themePreference: 'light',
    toggleTheme: jest.fn(),
    setThemePreference: jest.fn(),
  }),
}));

describe('ProcessOverlay', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.requestAnimationFrame = (callback) => callback();
    Element.prototype.scrollIntoView = jest.fn();
  });

  test('uses a non-modal dialog, labels it from the article title, and focuses search', () => {
    render(
      <ProcessOverlay
        documentId="the-process"
        onClose={jest.fn()}
        onNavigate={jest.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Process' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(screen.getByRole('searchbox', { name: 'Search Process documents' })).toHaveFocus();
  });

  test('closes with Escape and when the backdrop is clicked', () => {
    const onClose = jest.fn();
    render(
      <ProcessOverlay
        documentId="the-process"
        onClose={onClose}
        onNavigate={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('process-overlay-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
