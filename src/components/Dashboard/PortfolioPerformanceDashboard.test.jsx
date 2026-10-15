import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioPerformanceDashboard from './PortfolioPerformanceDashboard';

test('unconnected history shows unavailable metrics without synthetic returns or current dates', () => {
  const { container } = render(<PortfolioPerformanceDashboard />);
  expect(screen.getByText('Verified performance history unavailable')).toBeInTheDocument();
  expect(screen.getByText('Annualized Return')).toBeInTheDocument();
  expect(screen.getByText('Monthly Returns')).toBeInTheDocument();
  expect(screen.getByText('Performance Trend')).toBeInTheDocument();
  expect(container).not.toHaveTextContent('50.3%');
  expect(container).not.toHaveTextContent('19.4%');
  expect(container).not.toHaveTextContent('10,575.42');
  expect(container).not.toHaveTextContent('All data as of');
});

test('shows supplied historical outcomes and their observation date', () => {
  render(<PortfolioPerformanceDashboard observedAt="2026-08-31T12:00:00Z" realizedKPIs={{
    netRealized: 12, totalGains: 15, totalLosses: -3, winRate: 75, profitFactor: 5,
  }} />);
  expect(screen.getByText('$12.00')).toBeInTheDocument();
  expect(screen.getByText('Realized history checked Aug 31, 2026')).toBeInTheDocument();
  expect(screen.getByText('Verified account-equity history unavailable.')).toBeInTheDocument();
});
