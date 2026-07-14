import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import EtfProPanel from '../EtfProPanel';

jest.mock('../../../utils/dateFreshness', () => ({ isFreshForToday: jest.fn(() => true) }));

const snapshot = {
  meta: { snapshotDate: '2026-07-13', source: 'gmail-html-full-book-applied-actions' },
  rows: [
    { id: 'AAA', ticker: 'AAA', etf: 'Alpha ETF', assetClass: 'Equity', call: 'Long', lastPrice: 20, trendLowEnd: 18, trendHighEnd: 22, dateAdded: '2026-07-01', daysHeld: 12, absolutePerformance: 3.5, relativePerformance: null },
    { id: 'BBB', ticker: 'BBB', etf: 'Beta ETF', assetClass: 'Fixed Income', call: 'Short', lastPrice: null, trendLowEnd: 48, trendHighEnd: 52, dateAdded: '2026-07-02', daysHeld: null, absolutePerformance: null, relativePerformance: -1.2 },
  ],
  changes: { addedLongs: ['AAA'], removedLongs: [], addedShorts: ['BBB'], removedShorts: ['CCC'] },
  dataQuality: { status: 'ok', warnings: [] },
};

describe('EtfProPanel', () => {
  test('summarizes positioning and renders unavailable values without substitutes', () => {
    render(<EtfProPanel snapshot={snapshot} onClose={jest.fn()} onRefresh={jest.fn()} />);
    expect(screen.getByText('Latest ETF Pro Changes')).toBeInTheDocument();
    expect(screen.getAllByText('AAA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BBB').length).toBeGreaterThan(0);
    expect(screen.getByText('CCC')).toBeInTheDocument();
    expect(screen.getByText('+3.50%')).toBeInTheDocument();
    expect(screen.getByText('-1.20%')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  test('filters the table by side and search query', () => {
    render(<EtfProPanel snapshot={snapshot} onClose={jest.fn()} onRefresh={jest.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Shorts' }));
    expect(screen.queryByText('Alpha ETF')).not.toBeInTheDocument();
    expect(screen.getByText('Beta ETF')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search ETF Pro positions' }), { target: { value: 'not-found' } });
    expect(screen.getByText('No ETF Pro positions match this view.')).toBeInTheDocument();
  });
});
