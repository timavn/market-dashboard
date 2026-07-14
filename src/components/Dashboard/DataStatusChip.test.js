import React from 'react';
import { render, screen } from '@testing-library/react';
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

  it('never silently treats an unknown state as live', () => {
    render(<DataStatusChip status="mystery-provider-state" />);

    expect(screen.getByLabelText('UNAVAILABLE')).toHaveAttribute('data-status', 'unavailable');
  });
});
