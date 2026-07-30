import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

jest.mock('./components/Dashboard/PortfolioDashboard', () => ({
  processDocumentId,
  onOpenProcess,
  onNavigateProcess,
  onCloseProcess,
}) => (
  <div data-testid="mock-dashboard">
    Dashboard mounted
    <button type="button" onClick={onOpenProcess}>Open process</button>
    {processDocumentId && (
      <div
        data-testid="mock-process-overlay"
        data-document-id={processDocumentId}
      >
        <button
          type="button"
          onClick={() => onNavigateProcess('#/process/methods')}
        >
          Open methods
        </button>
        <button
          type="button"
          onClick={() => onCloseProcess({ replace: true })}
        >
          Close process
        </button>
      </div>
    )}
  </div>
));

describe('App hash routing', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.scrollTo = jest.fn();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('loads the legacy system guide separately and returns to the dashboard', async () => {
    window.location.hash = '/how-it-works';
    render(<App />);

    expect(screen.getByTestId('how-it-works-page')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-dashboard')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Dashboard$/i }));
    expect(await screen.findByTestId('mock-dashboard')).toBeInTheDocument();
  });

  test('opens Process over the still-mounted dashboard and closes without leaving the SPA', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open process' }));

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(await screen.findByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'the-process',
    );
    expect(window.location.hash).toBe('#/process');

    fireEvent.click(screen.getByRole('button', { name: 'Close process' }));
    await waitFor(() => expect(screen.queryByTestId('mock-process-overlay')).not.toBeInTheDocument());
    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  test('navigates among Process documents without unmounting the dashboard', () => {
    window.location.hash = '/process';
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open methods' }));

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'methods-index',
    );
    expect(window.location.hash).toBe('#/process/methods');
  });

  test('opens a directly addressed Method inside the overlay', () => {
    window.location.hash = '/process/methods/position-sizing';
    render(<App />);

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'position-sizing',
    );
  });

  test('redirects the legacy white-paper route to Process', () => {
    window.location.hash = '/white-paper';
    render(<App />);

    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'the-process',
    );
    expect(window.location.hash).toBe('#/process');
  });

  test('redirects retired Principles and Playbook routes to Process', () => {
    window.location.hash = '/process/principles';
    const view = render(<App />);

    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'the-process',
    );
    expect(window.location.hash).toBe('#/process');

    view.unmount();
    window.location.hash = '/process/playbook';
    render(<App />);
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'the-process',
    );
    expect(window.location.hash).toBe('#/process');
  });

  test('treats unknown hashes as dashboard routes', async () => {
    window.location.hash = '/process';
    render(<App />);
    expect(screen.getByTestId('mock-process-overlay')).toBeInTheDocument();

    window.location.hash = '/not-a-route';

    await waitFor(() => expect(screen.queryByTestId('mock-process-overlay')).not.toBeInTheDocument());
    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
  });
});
