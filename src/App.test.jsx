import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

jest.mock('./components/Dashboard/PortfolioDashboard', () => ({ onOpenProcess }) => (
  <div data-testid="mock-dashboard">
    Dashboard mounted
    <button type="button" onClick={onOpenProcess}>Open process</button>
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

  test('opens The Process from the dashboard and treats unknown hashes as dashboard routes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open process' }));
    expect(await screen.findByTestId('process-page')).toHaveAttribute('data-document-id', 'the-process');
    expect(window.location.hash).toBe('#/process');

    window.location.hash = '/not-a-route';
    expect(await screen.findByTestId('mock-dashboard')).toBeInTheDocument();
  });

  test('opens the canonical Position Sizing technical-note route', () => {
    window.location.hash = '/process/methods/position-sizing';
    render(<App />);

    expect(screen.getByTestId('process-page')).toHaveAttribute('data-document-id', 'position-sizing');
    expect(screen.getByRole('heading', { name: 'Position Sizing' })).toBeInTheDocument();
  });

  test('redirects the legacy white-paper route to the master Process route', () => {
    window.location.hash = '/white-paper';
    render(<App />);

    expect(screen.getByTestId('process-page')).toHaveAttribute('data-document-id', 'the-process');
    expect(window.location.hash).toBe('#/process');
  });

  test('preserves the legacy How It Works route', () => {
    window.location.hash = '/how-it-works';
    render(<App />);
    expect(screen.getByTestId('how-it-works-page')).toBeInTheDocument();
  });
});
