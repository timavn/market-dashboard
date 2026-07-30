import React, { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import SystemReadinessPanel, { normalizeHedgeyeProducts } from '../SystemReadinessPanel';
import { MarketDataService } from '../../../services/api/marketDataService';

let mockTheme = 'light';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: { getSystemStatus: jest.fn(), getHedgeyeFreshness: jest.fn() },
}));

jest.mock('../../../context/ThemeContext', () => ({
  useTheme: () => ({ theme: mockTheme }),
}));

const onlineServices = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    status: 'online',
    details: [
      { id: 'api-server', label: 'API server', status: 'online' },
      { id: 'react-ui', label: 'React UI', status: 'online' },
    ],
  },
  {
    id: 'market-data',
    label: 'Market data',
    status: 'online',
    details: [
      { id: 'primary-provider', label: 'Primary provider', status: 'online' },
      { id: 'fresh-quote', label: 'Fresh quote', status: 'online' },
    ],
  },
  {
    id: 'live-portfolio',
    label: 'Live portfolio',
    status: 'online',
    details: [
      { id: 'ibkr-sidecar', label: 'IBKR sidecar', status: 'online' },
      { id: 'gateway-session', label: 'Gateway session', status: 'online' },
      { id: 'managed-account', label: 'Managed account', status: 'online' },
      { id: 'fresh-session', label: 'Fresh session', status: 'online' },
    ],
  },
  {
    id: 'hermes-gmail',
    label: 'Hermes / Gmail',
    status: 'online',
    details: [
      { id: 'hermes-analyst', label: 'Hermes Analyst', status: 'online' },
      { id: 'hermes-developer', label: 'Hermes Developer', status: 'online' },
      { id: 'hermes-security', label: 'Hermes Security', status: 'online' },
      { id: 'gmail-ingestion', label: 'Gmail Ingestion', status: 'online' },
    ],
  },
];

function statusPayload({
  checkedAt = new Date().toISOString(),
  services = onlineServices,
} = {}) {
  return { checkedAt, overall: 'online', services };
}

function productsPayload({
  checkedAt = new Date().toISOString(),
  status = 'fresh',
} = {}) {
  return {
    meta: { timestamp: checkedAt },
    dataTypes: {
      'risk-ranges': { status, date: '2026-07-29' },
      'early-look': { status, date: '2026-07-29' },
      'bitcoin-trend-tracker': { status, date: '2026-07-29' },
      'momo-tracker': { status, date: '2026-07-29' },
      'signal-strength': { status, date: '2026-07-29' },
      'portfolio-solutions': { status, date: '2026-07-29' },
      'the-macro-show': { status, date: '2026-07-29' },
      'the-call': { status, date: '2026-07-29' },
      'real-time-alert': { status, date: '2026-07-29' },
      volume: { status, date: '2026-07-29' },
      'market-structure': { status, date: '2026-07-29' },
      'cftc-positioning': { status, date: '2026-07-29' },
      'etf-pro': { status, date: '2026-07-29' },
      'inflation-nowcast': { status, date: '2026-07-29' },
    },
  };
}

describe('SystemReadinessPanel', () => {
  beforeEach(() => {
    mockTheme = 'light';
    MarketDataService.getSystemStatus.mockReset();
    MarketDataService.getHedgeyeFreshness.mockReset();
    MarketDataService.getHedgeyeFreshness.mockResolvedValue(productsPayload());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('normalizes the product endpoint statuses without ambiguous greens', () => {
    const normalized = normalizeHedgeyeProducts({
      meta: { timestamp: new Date().toISOString() },
      dataTypes: {
        'risk-ranges': { status: 'invalid' },
        'early-look': { status: 'current' },
        'bitcoin-trend-tracker': { status: 'stale' },
      },
    });

    expect(normalized.find(({ id }) => id === 'risk-ranges').status).toBe('offline');
    expect(normalized.find(({ id }) => id === 'early-look').status).toBe('online');
    expect(normalized.find(({ id }) => id === 'bitcoin-trend-tracker').status).toBe('attention');
    expect(normalized.find(({ id }) => id === 'momo-tracker').status).toBe('unknown');
  });

  test('does not request or render status while closed, then loads once when opened', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    const { rerender } = render(
      <SystemReadinessPanel open={false} onClose={jest.fn()} />,
    );

    expect(MarketDataService.getSystemStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Systems' })).not.toBeInTheDocument();

    rerender(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByRole('dialog', { name: 'Systems' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(5));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Products')).toBeInTheDocument();
  });

  test('closing during a request cannot leave or restore a transient rail state', async () => {
    let resolveRequest;
    const pendingRequest = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockReturnValue(pendingRequest);

    const { rerender } = render(
      <SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />,
    );
    await waitFor(() => expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1));
    expect(onStatusChange).toHaveBeenLastCalledWith('unknown');

    rerender(
      <SystemReadinessPanel open={false} onClose={jest.fn()} onStatusChange={onStatusChange} />,
    );
    await act(async () => {
      resolveRequest(statusPayload());
      await pendingRequest;
    });

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Systems' })).not.toBeInTheDocument();
  });

  test('shows core service results without waiting for the slower Products check', async () => {
    let resolveProducts;
    const pendingProducts = new Promise((resolve) => {
      resolveProducts = resolve;
    });
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getHedgeyeFreshness.mockReturnValue(pendingProducts);

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(4));
    expect(screen.getByRole('button', { name: 'Expand Products' })).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByTitle('Refresh systems')).toBeDisabled();

    await act(async () => {
      resolveProducts(productsPayload());
      await pendingProducts;
    });

    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(5));
    expect(screen.getByTitle('Refresh systems')).not.toBeDisabled();
  });

  test('renders five concise categories and treats a peripheral outage as attention', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => {
        if (service.id === 'live-portfolio') {
          return { ...service, status: 'offline', reason: 'Gateway signed out' };
        }
        if (service.id === 'hermes-gmail') {
          return { ...service, status: 'unknown', reason: 'Verification unavailable' };
        }
        return service;
      }),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);

    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    await within(dialog).findByText('Offline');
    expect(within(within(dialog).getByRole('list', { name: 'Current system status' }))
      .getAllByRole('listitem')).toHaveLength(5);
    expect(within(dialog).getByText('Dashboard')).toBeInTheDocument();
    expect(within(dialog).getByText('Market data')).toBeInTheDocument();
    expect(within(dialog).getByText('Live portfolio')).toBeInTheDocument();
    expect(within(dialog).getByText('Hermes / Gmail')).toBeInTheDocument();
    expect(within(dialog).getByText('API + UI')).toBeInTheDocument();
    expect(within(dialog).getByText('Quotes + freshness')).toBeInTheDocument();
    expect(within(dialog).getByText('IBKR session')).toBeInTheDocument();
    expect(within(dialog).getByText('Agents + ingestion')).toBeInTheDocument();
    expect(within(dialog).getByText('Products')).toBeInTheDocument();
    expect(within(dialog).getByText('Hedgeye research feeds')).toBeInTheDocument();
    expect(within(dialog).queryByText('Gateway signed out')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Verification unavailable')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Morning operations checklist')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('What needs attention')).not.toBeInTheDocument();
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('attention'));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
  });

  test('expands one concise checklist at a time without another request', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => (
        service.id === 'live-portfolio'
          ? {
            ...service,
            status: 'offline',
            reason: 'IB Gateway is disconnected.',
            details: [
              { id: 'ibkr-sidecar', status: 'online' },
              {
                id: 'gateway-session',
                status: 'offline',
                reason: 'IB Gateway is disconnected.',
              },
              {
                id: 'managed-account',
                status: 'offline',
                reason: 'No managed IBKR account is available.',
              },
              {
                id: 'fresh-session',
                status: 'unknown',
                reason: 'Live portfolio session is unverified.',
              },
            ],
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand Live portfolio checklist',
    }));

    const portfolioChecklist = screen.getByRole('list', {
      name: 'Live portfolio checklist',
    });
    expect(within(portfolioChecklist).getAllByRole('listitem')).toHaveLength(4);
    expect(within(portfolioChecklist).getByText('IBKR sidecar')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Dashboard-to-IBKR bridge')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Gateway session')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Authenticated gateway link')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Managed account')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Position account access')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Fresh session')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Recent verified update')).toBeInTheDocument();
    expect(within(portfolioChecklist).getAllByText('Online')).toHaveLength(1);
    expect(within(portfolioChecklist).getAllByText('Offline')).toHaveLength(2);
    expect(within(portfolioChecklist).getAllByText('Unknown')).toHaveLength(1);
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand Dashboard checklist',
    }));

    expect(screen.queryByRole('list', { name: 'Live portfolio checklist' }))
      .not.toBeInTheDocument();
    const dashboardChecklist = screen.getByRole('list', { name: 'Dashboard checklist' });
    expect(within(dashboardChecklist).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dashboardChecklist).getByText('API server')).toBeInTheDocument();
    expect(within(dashboardChecklist).getByText('React UI')).toBeInTheDocument();
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Expand Products' }));
    expect(screen.queryByRole('list', { name: 'Dashboard checklist' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', {
      name: 'Hedgeye products pulled by the dashboard',
    })).toBeInTheDocument();
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
  });

  test('does not reload when its status callback changes identity during a parent render', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());

    function UnstableCallbackHost() {
      const [railStatus, setRailStatus] = React.useState('unknown');
      return (
        <>
          <span data-testid="rail-status">{railStatus}</span>
          <SystemReadinessPanel
            open
            onClose={jest.fn()}
            onStatusChange={(status) => setRailStatus(status)}
          />
        </>
      );
    }

    render(<UnstableCallbackHost />);
    await waitFor(() => expect(screen.getByTestId('rail-status')).toHaveTextContent('online'));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand Hermes / Gmail checklist',
    }));

    const hermesChecklist = screen.getByRole('list', { name: 'Hermes / Gmail checklist' });
    expect(within(hermesChecklist).getByText('Hermes Analyst')).toBeInTheDocument();
    expect(within(hermesChecklist).getByText('Hermes Developer')).toBeInTheDocument();
    expect(within(hermesChecklist).getByText('Hermes Security')).toBeInTheDocument();
    expect(within(hermesChecklist).getByText('Gmail Ingestion')).toBeInTheDocument();
    expect(within(hermesChecklist).getAllByText('Online')).toHaveLength(4);
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
  });

  test('renders timestamp dates in America/Los_Angeles without UTC day rollover', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-30T05:30:00.000Z'));
    const checkedAt = '2026-07-30T05:30:00.000Z';
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({ checkedAt }));
    MarketDataService.getHedgeyeFreshness.mockResolvedValue(productsPayload({ checkedAt }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getAllByText('2026-07-29')).toHaveLength(5);
    expect(screen.queryByText('2026-07-30')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand Hermes / Gmail checklist',
    }));
    const hermesChecklist = screen.getByRole('list', { name: 'Hermes / Gmail checklist' });
    expect(within(hermesChecklist).getAllByText('2026-07-29')).toHaveLength(4);
  });

  test('reports offline to the rail only when the dashboard core is offline', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => (
        service.id === 'dashboard'
          ? { ...service, status: 'offline', reason: 'API unavailable' }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);

    await screen.findByText('Offline');
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('offline'));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('reports Products problems as rail attention, never a core outage', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getHedgeyeFreshness.mockResolvedValue(productsPayload({
      status: 'stale',
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);

    await waitFor(() => expect(screen.getByText('Attention')).toBeInTheDocument());
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('attention'));
    expect(onStatusChange).not.toHaveBeenCalledWith('offline');
    expect(screen.getByTitle('Refresh systems')).not.toBeDisabled();
  });

  test('maps missing and unrecognized service results to Unknown', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: [{ id: 'dashboard', status: 'mystery' }],
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getAllByText('Unknown')).toHaveLength(4));
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('refreshes only on command', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Refresh systems'));

    await waitFor(() => expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('clears prior online results when refresh fails', async () => {
    MarketDataService.getSystemStatus
      .mockResolvedValueOnce(statusPayload())
      .mockRejectedValueOnce(new Error('API connection refused'));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Online')).toHaveLength(5);

    fireEvent.click(screen.getByTitle('Refresh systems'));

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Unknown')).toHaveLength(4);
    expect(screen.getAllByText('Online')).toHaveLength(1);
    expect(screen.queryByText('API connection refused')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('keeps the checked snapshot visible until the user refreshes', async () => {
    jest.useFakeTimers();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    const onStatusChange = jest.fn();

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText('Online')).toHaveLength(5);

    act(() => {
      jest.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(screen.getAllByText('Online')).toHaveLength(5);
    expect(screen.queryByText('Status expired')).not.toBeInTheDocument();
    expect(onStatusChange).toHaveBeenLastCalledWith('online');
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
  });

  test('rejects stale responses instead of displaying old green statuses', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      checkedAt: new Date(Date.now() - (2 * 60 * 1000)).toISOString(),
    }));
    MarketDataService.getHedgeyeFreshness.mockRejectedValue(new Error('Unavailable'));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(5);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('uses the dark theme and keeps the panel open on Escape', async () => {
    mockTheme = 'dark';
    const onClose = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());

    render(<SystemReadinessPanel open onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    expect(dialog).toHaveClass('sr-panel--dark');
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('closes on an outside click but not a click inside the panel', async () => {
    const onClose = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());

    render(<SystemReadinessPanel open onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});
