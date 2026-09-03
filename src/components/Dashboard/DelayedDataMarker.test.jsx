import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DelayedDataMarker, {
  DEFAULT_DELAYED_DATA_THRESHOLD_MS,
  formatDelayedDataTimestamp,
  shouldMarkDataDelayed,
} from './DelayedDataMarker';

describe('DelayedDataMarker', () => {
  const now = new Date('2026-09-02T18:20:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['delayed', 'refresh-delayed', 'historical', 'reference', 'stale'])(
    'renders a subscript D for %s data older than two minutes',
    (status) => {
      render(
        <DelayedDataMarker
          status={status}
          title={`${status} observation`}
          updatedAt="2026-09-02T18:17:59.000Z"
        />,
      );
      const marker = screen.getByRole('button', { name: new RegExp(`${status} observation`) });
      expect(marker).toHaveTextContent('D');
      expect(marker).toHaveAttribute('data-data-status', status);
      expect(marker).toHaveClass('dashboard-delayed-data-marker-trigger');
    },
  );

  it('shows the actual updated timestamp only after the D is clicked', () => {
    const { baseElement, container } = render(
      <DelayedDataMarker
        status="delayed"
        title="Delayed quote"
        updatedAt="2026-09-02T18:17:59.000Z"
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Delayed quote/i }));
    const timestamp = screen.getByRole('status');
    expect(timestamp).toHaveTextContent(/Updated Sep 2, 2026/);
    expect(container).not.toContainElement(timestamp);
    expect(baseElement).toContainElement(timestamp);
    expect(timestamp).toHaveClass('dashboard-delayed-data-timestamp');
    expect(timestamp).toHaveStyle({ visibility: 'visible' });
  });

  it('keeps the portaled timestamp open when it is clicked and closes it outside', () => {
    render(
      <DelayedDataMarker
        status="delayed"
        title="Delayed quote"
        updatedAt="2026-09-02T18:17:59.000Z"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Delayed quote/i }));
    const timestamp = screen.getByRole('status');
    fireEvent.pointerDown(timestamp);
    expect(timestamp).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps daily historical observations on their source date', () => {
    expect(formatDelayedDataTimestamp('2026-08-31T00:00:00.000Z', 'historical'))
      .toBe('Updated Aug 31, 2026');
  });

  it('does not mark provider-delayed data while its observation is under two minutes old', () => {
    render(
      <DelayedDataMarker
        status="delayed"
        title="Yahoo quote"
        updatedAt="2026-09-02T18:18:01.000Z"
      />,
    );

    expect(screen.queryByRole('button', { name: /Yahoo quote/i })).not.toBeInTheDocument();
    expect(shouldMarkDataDelayed('delayed', '2026-09-02T18:18:01.000Z', now.getTime())).toBe(false);
  });

  it('shows D when a fresh observation crosses the shared two-minute threshold', () => {
    render(
      <DelayedDataMarker
        status="delayed"
        title="Yahoo quote"
        updatedAt="2026-09-02T18:18:01.000Z"
      />,
    );

    act(() => {
      jest.advanceTimersByTime(2_000);
    });

    expect(screen.getByRole('button', { name: /Yahoo quote/i })).toBeInTheDocument();
    expect(DEFAULT_DELAYED_DATA_THRESHOLD_MS).toBe(120_000);
  });

  it('marks delayed data when its update timestamp is missing or invalid', () => {
    const { rerender } = render(<DelayedDataMarker status="delayed" title="Unknown update" />);
    expect(screen.getByRole('button', { name: /Unknown update/i })).toBeInTheDocument();
    rerender(<DelayedDataMarker status="delayed" title="Invalid update" updatedAt="not-a-time" />);
    expect(screen.getByRole('button', { name: /Invalid update/i })).toBeInTheDocument();
  });

  it('does not mark live or unavailable data', () => {
    const { container, rerender } = render(<DelayedDataMarker status="live" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DelayedDataMarker status="unavailable" />);
    expect(container).toBeEmptyDOMElement();
    expect(shouldMarkDataDelayed('current', null, now.getTime())).toBe(false);
  });
});
