import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import MorningTldrOverlay from './MorningTldrOverlay';

jest.mock('./MorningTldrPanel', () => () => (
  <div data-testid="mock-morning-tldr-panel">
    Morning TL;DR panel
  </div>
));

describe('MorningTldrOverlay', () => {
  test('uses the Process overlay shell and centers the TL;DR dialog', () => {
    render(<MorningTldrOverlay onClose={jest.fn()} />);

    expect(screen.getByTestId('morning-tldr-overlay')).toHaveClass('process-overlay-host');
    expect(screen.getByRole('dialog', { name: 'Morning TL;DR' })).toHaveClass(
      'process-overlay-dialog',
      'morning-tldr-overlay-dialog',
    );
    expect(screen.getByTestId('mock-morning-tldr-panel')).toBeInTheDocument();
  });

  test('closes from the backdrop or Escape', () => {
    const onClose = jest.fn();
    render(<MorningTldrOverlay onClose={onClose} />);

    fireEvent.click(screen.getByTestId('morning-tldr-overlay-backdrop'));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
