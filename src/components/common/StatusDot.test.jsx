import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import StatusDot from './StatusDot';

describe('StatusDot', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1024,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 768,
    });
  });

  test('opens a centered draggable plaintext dialog and closes it', () => {
    render(
      <StatusDot
        label="Rates region"
        status="active"
        sources={[
          {
            id: 'ust2y',
            label: '2-Yr (UST2Y)',
            detail: 'Live',
            status: 'current',
            detailRows: [{ id: 'ust2y:updated', text: '6/23/2026, 3:00:40 PM' }],
          },
          {
            id: 'ust5y',
            label: '5-Yr (UST5Y)',
            detail: 'Error',
            status: 'stale',
            detailRows: [{ id: 'ust5y:error', text: 'Quote refresh failed' }],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /rates region/i }));

    const dialog = screen.getByRole('dialog', { name: /rates region/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass('fixed');
    expect(Number.parseInt(dialog.style.left, 10)).toBeGreaterThan(0);
    expect(screen.getByTestId('status-source-card-ust2y')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-ust5y')).toHaveAttribute('data-status-tone', 'error');
    expect(screen.getByText('2-Yr (UST2Y)')).toHaveClass('text-emerald-700');
    expect(screen.getByText('5-Yr (UST5Y)')).toHaveClass('text-[#b54708]');
    expect(screen.getByText('Quote refresh failed')).toBeInTheDocument();

    const originalLeft = dialog.style.left;
    fireEvent.mouseDown(dialog, { button: 0, clientX: 300, clientY: 220 });
    fireEvent.mouseMove(document, { clientX: 360, clientY: 260 });
    fireEvent.mouseUp(document);
    expect(dialog.style.left).not.toBe(originalLeft);

    fireEvent.click(screen.getByRole('button', { name: /close rates region/i }));
    expect(screen.queryByRole('dialog', { name: /rates region/i })).not.toBeInTheDocument();
  });

  test('labels historical source data as neutral as-of data', () => {
    render(
      <StatusDot
        label="Volatility data"
        emoji="🟢"
        sources={[
          {
            id: 'move',
            label: 'MOVE — Yahoo Finance',
            detail: 'end-of-day · as of 7/13/2026, 4:30:00 PM',
            status: 'historical',
            updatedAt: '2026-07-13T20:30:00.000Z',
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /volatility data/i }));
    expect(screen.getByTestId('status-source-card-move')).toHaveAttribute('data-status-tone', 'as of');
    expect(screen.getByText('As of').parentElement).toHaveClass('text-[#42648f]');
  });
});
