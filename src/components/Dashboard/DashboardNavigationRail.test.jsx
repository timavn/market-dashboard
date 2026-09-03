import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardNavigationRail from './DashboardNavigationRail';

describe('DashboardNavigationRail prediction-market indicators', () => {
  test('puts the tone and accessible research description on only the matching button', () => {
    const onSp500 = jest.fn();
    const onWti = jest.fn();
    render(<DashboardNavigationRail
      activeItemId="predictionMonitor-wti"
      activeItemIds={['predictionMonitor-wti']}
      items={[
        {
          id: 'predictionMonitor-sp500', group: 'primary', label: 'SP500',
          onSelect: onSp500,
        },
        {
          id: 'predictionMonitor-wti', group: 'primary', label: 'WTI',
          title: 'WTI Prediction Monitor', onSelect: onWti,
          indicatorTone: 'bearish',
          indicatorDescription: 'Aligned bearish Trade and Trend in the upper Risk Range third.',
        },
      ]}
      systemReadinessStatus="unknown"
    />);

    const sp500 = screen.getByRole('button', { name: 'SP500' });
    const wti = screen.getByRole('button', { name: 'WTI' });
    expect(sp500).not.toHaveAttribute('data-indicator-tone');
    expect(wti).toHaveAttribute('data-indicator-tone', 'bearish');
    expect(wti).toHaveAccessibleDescription(
      'Aligned bearish Trade and Trend in the upper Risk Range third.',
    );
    expect(wti).toHaveAttribute(
      'title',
      'WTI Prediction Monitor. Aligned bearish Trade and Trend in the upper Risk Range third.',
    );
    expect(wti).toHaveClass('is-active');

    wti.focus();
    expect(wti).toHaveFocus();
    fireEvent.click(wti);
    expect(onWti).toHaveBeenCalledTimes(1);
    expect(onSp500).not.toHaveBeenCalled();
  });

  test('ignores unsupported tones instead of exposing an indicator', () => {
    render(<DashboardNavigationRail
      items={[{
        id: 'predictionMonitor-gold', group: 'primary', label: 'Gold', onSelect: jest.fn(),
        indicatorTone: 'warning', indicatorDescription: 'Unverified signal',
      }]}
      systemReadinessStatus="unknown"
    />);

    const gold = screen.getByRole('button', { name: 'Gold' });
    expect(gold).not.toHaveAttribute('data-indicator-tone');
    expect(gold).not.toHaveAttribute('aria-describedby');
  });

  test('renders prediction-market tiers as labeled groups without changing the card template', () => {
    render(<DashboardNavigationRail
      items={[
        { id: 'portfolio', group: 'primary', label: 'Portfolio', onSelect: jest.fn() },
        { id: 'predictionMonitor-silver', group: 'primary', sectionLabel: 'T1', label: 'Silver', onSelect: jest.fn() },
        { id: 'predictionMonitor-gold', group: 'primary', sectionLabel: 'T1', label: 'Gold', onSelect: jest.fn() },
        { id: 'predictionMonitor-sp500', group: 'primary', sectionLabel: 'T2', label: 'SP500', onSelect: jest.fn() },
      ]}
      systemReadinessStatus="unknown"
    />);

    const tierOne = screen.getByRole('region', { name: 'T1 prediction markets' });
    const tierTwo = screen.getByRole('region', { name: 'T2 prediction markets' });
    expect(tierOne).toHaveAttribute('data-navigation-tier', 'T1');
    expect(tierTwo).toHaveAttribute('data-navigation-tier', 'T2');
    expect(tierOne).toHaveTextContent('Silver');
    expect(tierOne).toHaveTextContent('Gold');
    expect(tierTwo).toHaveTextContent('SP500');
    expect(screen.getByRole('button', { name: 'Silver' })).toHaveClass('dashboard-navigation-rail__card');
  });
});
