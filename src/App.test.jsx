import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

jest.mock('./components/Dashboard/PortfolioDashboard', () => ({ onOpenHowItWorks }) => (
  <div data-testid="mock-dashboard">
    Dashboard mounted
    <button type="button" onClick={onOpenHowItWorks}>Open guide</button>
  </div>
));

describe('App hash routing', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.scrollTo = jest.fn();
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  test('loads the guide directly without mounting the dashboard and returns on hash change', async () => {
    window.location.hash = '/how-it-works';
    render(<App />);

    expect(screen.getByTestId('how-it-works-page')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-dashboard')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Dashboard$/i }));
    expect(await screen.findByTestId('mock-dashboard')).toBeInTheDocument();
  });

  test('opens the guide from the dashboard and treats unknown hashes as dashboard routes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open guide' }));
    expect(await screen.findByTestId('how-it-works-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/how-it-works');

    window.location.hash = '/not-a-route';
    expect(await screen.findByTestId('mock-dashboard')).toBeInTheDocument();
  });
});
