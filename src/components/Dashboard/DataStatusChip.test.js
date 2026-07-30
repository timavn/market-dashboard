import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import DataStatusChip from './DataStatusChip';

describe('DataStatusChip', () => {
  it('keeps delayed data explicit and separate from live status', () => {
    render(<DataStatusChip status="delayed" detail="AS OF JUL 10" />);

    const chip = screen.getByLabelText('DELAYED · AS OF JUL 10');
    expect(chip).toHaveAttribute('data-status', 'delayed');
    expect(chip).toHaveClass('efr-status-chip--delayed');
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('maps analytical as-of state to the neutral historical tone', () => {
    render(<DataStatusChip status="as-of" />);

    const chip = screen.getByLabelText('AS OF');
    expect(chip).toHaveAttribute('data-status', 'historical');
    expect(chip).toHaveClass('efr-status-chip--historical');
  });

  it('supports a color-only indicator without hiding its status from assistive technology', () => {
    render(<DataStatusChip status="delayed" detail="AS OF JUL 10" indicatorOnly />);

    const chip = screen.getByLabelText('DELAYED · AS OF JUL 10');
    expect(chip).toHaveClass('efr-status-chip--indicator-only', 'efr-status-chip--delayed');
    expect(chip).toHaveAttribute('data-indicator', 'stale');
    expect(chip).toHaveAttribute('title', 'DELAYED · AS OF JUL 10');
    expect(screen.queryByText('DELAYED')).not.toBeInTheDocument();
    expect(screen.queryByText('AS OF JUL 10')).not.toBeInTheDocument();
  });

  it('maps indicator colors to live, stale, asof, and error', () => {
    const { rerender } = render(<DataStatusChip status="live" indicatorOnly />);
    expect(screen.getByLabelText('LIVE')).toHaveAttribute('data-indicator', 'live');

    rerender(<DataStatusChip status="delayed" indicatorOnly />);
    expect(screen.getByLabelText('DELAYED')).toHaveAttribute('data-indicator', 'stale');

    rerender(<DataStatusChip status="stale" indicatorOnly />);
    expect(screen.getByLabelText('DELAYED')).toHaveAttribute('data-indicator', 'stale');

    rerender(<DataStatusChip status="mixed" indicatorOnly />);
    expect(screen.getByLabelText('MIXED / DELAYED')).toHaveAttribute('data-indicator', 'stale');

    rerender(<DataStatusChip status="historical" indicatorOnly />);
    expect(screen.getByLabelText('AS OF')).toHaveAttribute('data-indicator', 'asof');

    rerender(<DataStatusChip status="manual" indicatorOnly />);
    expect(screen.getByLabelText('MANUAL')).toHaveAttribute('data-indicator', 'asof');

    rerender(<DataStatusChip status="loading" indicatorOnly />);
    expect(screen.getByLabelText('LOADING')).toHaveAttribute('data-indicator', 'asof');

    rerender(<DataStatusChip status="unavailable" indicatorOnly />);
    expect(screen.getByLabelText('UNAVAILABLE')).toHaveAttribute('data-indicator', 'error');

    rerender(<DataStatusChip status="offline" indicatorOnly />);
    expect(screen.getByLabelText('OFFLINE')).toHaveAttribute('data-indicator', 'error');
  });

  it('renders a plain color circle with no inner symbols', () => {
    const { container } = render(<DataStatusChip status="historical" indicatorOnly />);
    expect(container.querySelector('svg circle')).toBeInTheDocument();
    expect(container.querySelector('svg path')).not.toBeInTheDocument();
  });

  it('never silently treats an unknown state as live', () => {
    render(<DataStatusChip status="mystery-provider-state" />);

    expect(screen.getByLabelText('UNAVAILABLE')).toHaveAttribute('data-status', 'unavailable');
  });

  it('opens concise diagnostics from the status button', () => {
    render(
      <DataStatusChip
        status="mixed"
        label="USD DATA"
        detail="CURRENCIES DELAYED · CORRELATIONS AS OF JUL 17"
        context="USD Data"
        diagnostics={[
          { label: 'Currencies', value: '8 delayed · 2 missing' },
          { label: 'Correlations', value: 'AS OF JUL 17' },
        ]}
        issues={['Missing: USD/CNY, USD/MXN']}
        indicatorOnly
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'USD DATA · CURRENCIES DELAYED · CORRELATIONS AS OF JUL 17',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'USD Data data status' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByText('Sources have mixed freshness or availability; see the counts below.'))
      .toBeInTheDocument();
    expect(within(dialog).getByText('8 delayed · 2 missing')).toBeInTheDocument();
    expect(within(dialog).getByText('Missing: USD/CNY, USD/MXN')).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<DataStatusChip status="unavailable" context="Market Backdrop" indicatorOnly />);
    const trigger = screen.getByRole('button', { name: 'UNAVAILABLE' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Market Backdrop data status' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Market Backdrop data status' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('explains custom stale, partial, and provisional labels without implying live data', () => {
    const { rerender } = render(
      <DataStatusChip status="delayed" label="STALE" context="CFTC Positioning" indicatorOnly />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'STALE' }));
    expect(screen.getByText('The latest data is older than the freshness limit.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'STALE' }));

    rerender(<DataStatusChip status="delayed" label="PARTIAL" context="Dollar Liquidity" indicatorOnly />);
    fireEvent.click(screen.getByRole('button', { name: 'PARTIAL' }));
    expect(screen.getByText('Some expected source data is missing; available values are shown.'))
      .toBeInTheDocument();
  });
});
