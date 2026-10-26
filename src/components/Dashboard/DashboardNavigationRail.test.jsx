import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardNavigationRail from './DashboardNavigationRail';

jest.mock('../../services/analyst/analystClient', () => ({
  analystWorkspaceApi: { request: jest.fn(() => new Promise(() => {})) },
}));
jest.mock('../../utils/processDocumentDrafts', () => ({ synchronizeProcessDrafts: jest.fn() }));

describe('DashboardNavigationRail', () => {
  test('renders each destination as a card that marks and selects only its own window', () => {
    const onPortfolio = jest.fn();
    const onBalance = jest.fn();
    render(<DashboardNavigationRail
      activeItemId="balance"
      activeItemIds={['balance']}
      items={[
        { id: 'portfolio', group: 'primary', label: 'Portfolio', onSelect: onPortfolio },
        { id: 'balance', group: 'primary', label: 'Balance', title: 'Portfolio balance', onSelect: onBalance },
      ]}
      systemReadinessStatus="unknown"
    />);

    const portfolio = screen.getByRole('button', { name: 'Portfolio' });
    const balance = screen.getByRole('button', { name: 'Balance' });
    expect(portfolio).toHaveClass('dashboard-navigation-rail__card');
    expect(portfolio).not.toHaveClass('is-active');
    expect(balance).toHaveClass('is-active');
    expect(balance).toHaveAttribute('aria-current', 'page');
    expect(balance).toHaveAttribute('title', 'Portfolio balance');

    fireEvent.click(balance);
    expect(onBalance).toHaveBeenCalledTimes(1);
    expect(onPortfolio).not.toHaveBeenCalled();
  });

  test('exposes system readiness on the Systems card', () => {
    render(<DashboardNavigationRail
      items={[{ id: 'system', group: 'utility', label: 'Systems', onSelect: jest.fn() }]}
      systemReadinessStatus="offline"
    />);

    expect(screen.getByRole('button', { name: 'Systems' })).toHaveAttribute('data-readiness-status', 'offline');
    expect(screen.getByText('System status: offline')).toBeInTheDocument();
  });
});
