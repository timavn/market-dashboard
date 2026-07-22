import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import HowItWorksPage from './HowItWorksPage';
import { HOW_IT_WORKS_SECTIONS } from '../../constants/howItWorksContent';

const mockToggleTheme = jest.fn();

jest.mock('../../context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: mockToggleTheme }),
}));

describe('HowItWorksPage', () => {
  beforeEach(() => {
    window.scrollTo = jest.fn();
    mockToggleTheme.mockClear();
  });

  test('documents every configured surface with the standard explanation fields', () => {
    render(<HowItWorksPage onBack={jest.fn()} />);

    expect(document.title).toBe('Dashboard System Guide | Market Dashboard');
    expect(screen.getByRole('heading', { name: 'Dashboard System Guide' })).toBeInTheDocument();

    const expectedCount = HOW_IT_WORKS_SECTIONS.reduce(
      (sum, section) => sum + section.features.length,
      0,
    );
    const cards = screen.getAllByTestId('how-it-works-feature');
    expect(cards).toHaveLength(expectedCount);

    const firstCard = cards[0];
    ['How it works', 'Technology', 'APIs & data sources', 'Math & methodology', 'Hermes role', 'Freshness & failure behavior', 'Why it matters']
      .forEach((label) => expect(within(firstCard).getByText(label)).toBeInTheDocument());

    expect(screen.getByRole('heading', { name: 'Currencies' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Volatility' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Key USD correlations' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live IBKR portfolio snapshot' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Analytics, workflow status & Hermes' })).toBeInTheDocument();
    expect(screen.getByText(/This guide is static: it does not request quotes/i)).toBeInTheDocument();
  });

  test('supports section navigation, theme switching, and return navigation', () => {
    const onBack = jest.fn();
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<HowItWorksPage onBack={onBack} />);

    fireEvent.click(screen.getByRole('button', { name: /Research and models Macro models/i }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(mockToggleTheme).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Dashboard$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
