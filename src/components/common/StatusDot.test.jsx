import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

    const statusButton = screen.getByRole('button', { name: 'Show status details for Rates region' });
    expect(statusButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(statusButton);

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
    const sourceCard = screen.getByTestId('status-source-card-move');
    expect(sourceCard).toHaveAttribute('data-status-tone', 'as of');
    expect(within(sourceCard).getByText('MOVE — Yahoo Finance')).toHaveClass('text-[#42648f]');
    expect(within(sourceCard).getByText('As of')).toBeInTheDocument();
  });

  test.each([
    ['stale', 'error'],
    ['inactive', 'error'],
    ['missing', 'unknown'],
    ['error', 'error'],
  ])('derives the no-source dialog state for %s instead of hardcoding Live', (status, expectedTone) => {
    render(
      <StatusDot
        label={`${status} feed`}
        status={status}
        updatedAt="2026-07-18T12:00:00.000Z"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Show status details for ${status} feed` }));

    const row = screen.getByTestId('status-source-card-updated');
    expect(row).toHaveAttribute('data-status-tone', expectedTone);
    expect(within(row).queryByText('Live')).not.toBeInTheDocument();
  });

  test.each([
    ['missing', 'inactive'],
    ['error', 'inactive'],
    ['unknown', 'unknown'],
    ['delayed', 'delayed'],
  ])('keeps an aggregate with a %s source fail-closed', (sourceStatus, aggregateStatus) => {
    render(
      <StatusDot
        label={`${sourceStatus} aggregate`}
        emoji="🟢"
        sources={[
          { id: 'healthy', label: 'Healthy source', status: 'current' },
          { id: 'problem', label: 'Problem source', status: sourceStatus },
        ]}
      />,
    );

    const button = screen.getByRole('button', { name: `Show status details for ${sourceStatus} aggregate` });
    expect(button).toHaveAttribute('data-status', aggregateStatus);
    expect(screen.getByTestId('status-dot-visual')).not.toHaveTextContent('🟢');
  });

  test('uses a larger native button target without changing the visible dot size', () => {
    render(<StatusDot label="Compact feed" status="active" size={8} />);

    const button = screen.getByRole('button', { name: 'Show status details for Compact feed' });
    const visualDot = screen.getByTestId('status-dot-visual');
    expect(button).toHaveStyle({ width: '24px', height: '24px' });
    expect(visualDot).toHaveStyle({ width: '8px', height: '8px' });
  });

  test('leaves keyboard activation to the native button click without double toggling', () => {
    render(<StatusDot label="Keyboard feed" status="active" />);

    const button = screen.getByRole('button', { name: 'Show status details for Keyboard feed' });
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Keyboard feed' })).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Keyboard feed' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Keyboard feed' })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
