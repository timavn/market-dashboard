import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import DashboardGuide, {
  DASHBOARD_GUIDE_SECTIONS,
  METHODOLOGY_LABELS,
} from './DashboardGuide';

describe('DashboardGuide', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('renders the front page in exact operator order without reading live data', () => {
    render(<article data-testid="guide"><DashboardGuide /></article>);

    const guide = screen.getByTestId('guide');
    expect(within(guide).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual(DASHBOARD_GUIDE_SECTIONS.map(([, label]) => label));
    expect(screen.getAllByTestId('dashboard-guide-chapter')).toHaveLength(7);
    screen.getAllByTestId('dashboard-guide-chapter').forEach((chapter) => {
      expect(within(chapter).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
        .toEqual([
          'What it shows',
          'How to read it',
          'Worked example',
          'Exact math',
          'Inputs and cadence',
          'Hedgeye Process connection',
          'Dashboard-specific behavior',
          'Failure states',
        ]);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('documents quote direction, timeless examples, and the production formulas', () => {
    render(<article data-testid="guide"><DashboardGuide /></article>);

    const guide = screen.getByTestId('guide');
    expect(guide).toHaveTextContent(/one U\.S\. dollar buys 1\.500 Australian dollars/i);
    expect(guide).toHaveTextContent(/1\.500 × \(1 − 0\.0203\) = 1\.46955 AUD per USD/i);
    expect(guide).toHaveTextContent(/USD weakened relative to AUD/i);
    expect(guide).toHaveTextContent(/illustrative values only/i);
    expect(guide).toHaveTextContent(/inverted return rᵢ = 1 ÷ \(1 \+ r\) − 1/i);
    expect(guide).toHaveTextContent(/price levels, not returns/i);
    expect(guide).toHaveTextContent(/DXY is the U\.S\. Dollar Index level/i);
    expect(guide).toHaveTextContent(/UUP is an exchange-traded dollar proxy/i);
    expect(guide).toHaveTextContent(/sample SD\[ln\(Pₜ ÷ Pₜ₋₁\)\] × √252 × 100/i);
    expect(guide).toHaveTextContent(/Low: <8 · Moderate: 8–<14 · High: ≥14/i);
    expect(guide).toHaveTextContent(/52 and 156 consecutive reporting observations/i);
    expect(guide).toHaveTextContent(/current observation is included/i);
    expect(guide).toHaveTextContent(/renormalizes across finite components/i);
    expect(guide).toHaveTextContent(/All average windows exclude the current observation/i);
    expect(guide).toHaveTextContent(/does not require a full window/i);
  });

  test('covers every source category, data state, and reference table', () => {
    render(<article data-testid="guide"><DashboardGuide /></article>);

    METHODOLOGY_LABELS.forEach((label) => {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    });
    [
      'Live',
      'Delayed',
      'Historical',
      'Refresh delayed',
      'Manual',
      'Partial',
      'Unavailable',
    ].forEach((state) => {
      expect(within(screen.getByRole('table', { name: 'Dashboard data-state legend' }))
        .getByRole('rowheader', { name: state })).toBeInTheDocument();
    });
    expect(screen.getByRole('table', { name: 'Volatility index definitions' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Implemented volatility regime ranges' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Global liquidity score weights' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Dashboard formula index' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Dashboard formula index' }))
      .getAllByRole('cell')
      .filter((cell) => cell.cellIndex === 2)
      .every((cell) => METHODOLOGY_LABELS.includes(cell.textContent))).toBe(true);
    expect(screen.getByRole('table', { name: 'Dashboard source and cadence matrix' })).toBeInTheDocument();
    screen.getAllByRole('link', { name: 'Hedgeye Process Guide' }).forEach((link) => {
      expect(link).toHaveAttribute('href', 'https://app.hedgeye.com/education');
    });
  });
});
