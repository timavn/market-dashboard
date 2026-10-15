import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

let mockDashboardMounts = 0;
let mockDashboardUnmounts = 0;

jest.mock('./components/Dashboard/PortfolioDashboard', () => {
  const mockReact = jest.requireActual('react');
  return ({
    processDocumentId,
    onOpenProcess,
    onNavigateProcess,
    onCloseProcess,
  }) => {
  const [draft, setDraft] = mockReact.useState('');
  mockReact.useEffect(() => {
    mockDashboardMounts += 1;
    return () => { mockDashboardUnmounts += 1; };
  }, []);
  return (
    <div data-testid="mock-dashboard">
      Dashboard mounted
      <label>Dashboard draft<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
      <button type="button" onClick={onOpenProcess}>Open process</button>
      <button
        type="button"
        onClick={() => onNavigateProcess('#/process/exposure-lab')}
      >
        Open exposure guide
      </button>
      <button
        type="button"
        onClick={() => onNavigateProcess('#/process/dashboard-guide')}
      >
        Open dashboard guide
      </button>
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
          <button
            type="button"
            onClick={() => onCloseProcess()}
          >
            Close process naturally
          </button>
        </div>
      )}
    </div>
  );
  };
});

describe('App hash routing', () => {
  beforeEach(() => {
    mockDashboardMounts = 0;
    mockDashboardUnmounts = 0;
    window.localStorage.clear();
    window.scrollTo = jest.fn();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('redirects the legacy How It Works route to the Dashboard Guide', () => {
    const replaceState = jest.spyOn(window.history, 'replaceState');
    window.location.hash = '/how-it-works';
    render(<App />);

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'dashboard-guide',
    );
    expect(window.location.hash).toBe('#/process/dashboard-guide');
    expect(replaceState).toHaveBeenCalledWith(null, '', '#/process/dashboard-guide');
    replaceState.mockRestore();
  });

  test('keeps a visited dashboard mounted while the redirected guide is open', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Dashboard draft'), { target: { value: 'keep me' } });

    window.location.hash = '/how-it-works';
    await waitFor(() => expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'dashboard-guide',
    ));
    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-dashboard').closest('[data-surface-active]'))
      .toHaveAttribute('data-surface-active', 'true');
    expect(mockDashboardMounts).toBe(1);
    expect(mockDashboardUnmounts).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Close process' }));
    expect(await screen.findByDisplayValue('keep me')).toBeInTheDocument();
    expect(mockDashboardMounts).toBe(1);
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

  test('switching a directly addressed Process document does not back out of the app on close', async () => {
    window.location.hash = '/process/exposure-lab';
    const backSpy = jest.spyOn(window.history, 'back');
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open methods' }));
    expect(window.history.state?.processOverlayEntry).not.toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Close process naturally' }));

    await waitFor(() => expect(screen.queryByTestId('mock-process-overlay')).not.toBeInTheDocument());
    expect(backSpy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    backSpy.mockRestore();
  });

  test('opens the Exposure Lab guide from the dashboard at its addressable route', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open exposure guide' }));

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'exposure-lab-guide',
    );
    expect(window.location.hash).toBe('#/process/exposure-lab');
  });

  test('opens the Dashboard Guide from the dashboard at its addressable route', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard guide' }));

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'dashboard-guide',
    );
    expect(window.location.hash).toBe('#/process/dashboard-guide');
  });

  test('opens a directly addressed Dashboard Guide inside the overlay', () => {
    window.location.hash = '/process/dashboard-guide';
    render(<App />);

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'dashboard-guide',
    );
  });

  test('opens a directly addressed Exposure Lab guide inside the overlay', () => {
    window.location.hash = '/process/exposure-lab';
    render(<App />);

    expect(screen.getByTestId('mock-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('mock-process-overlay')).toHaveAttribute(
      'data-document-id',
      'exposure-lab-guide',
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
