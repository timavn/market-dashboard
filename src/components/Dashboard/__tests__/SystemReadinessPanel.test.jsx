import React, { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import SystemReadinessPanel, {
  deriveProductsStatus,
  deriveSystemRailStatus,
  getSystemStatusServiceDefinitions,
  normalizeHedgeyeProducts,
  normalizeLoginStatus,
  normalizeSystemStatus,
} from '../SystemReadinessPanel';
import { MarketDataService } from '../../../services/api/marketDataService';

let mockTheme = 'light';

test('consolidated status definitions contain no legacy worker surface', () => {
  const definitions = getSystemStatusServiceDefinitions();
  expect(definitions).toContainEqual({
    id: 'ai',
    label: 'AI',
    summary: 'Analyst + ingestion',
  });
  expect(definitions).toContainEqual({
    id: 'resolver-sources',
    label: 'Resolver sources',
    summary: 'Prediction-market inputs',
    nonCore: true,
  });
  expect(JSON.stringify(definitions)).not.toMatch(/Hermes|research-ingestion/i);
});

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getLoginStatus: jest.fn(),
    getSystemStatus: jest.fn(),
    getHedgeyeFreshness: jest.fn(),
    runLoginAction: jest.fn(),
  },
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
    label: 'Portfolio',
    status: 'online',
    details: [
      { id: 'ibkr-sidecar', label: 'IBKR sidecar', status: 'online' },
      { id: 'gateway-session', label: 'Gateway session', status: 'online' },
      { id: 'managed-account', label: 'Managed account', status: 'online' },
      { id: 'fresh-session', label: 'Session', status: 'online' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    status: 'online',
    details: [
      { id: 'analyst-runtime', label: 'The Analyst', status: 'online' },
      { id: 'gmail-ingestion', label: 'Gmail Function', status: 'online' },
    ],
  },
  {
    id: 'resolver-sources',
    label: 'Resolver sources',
    status: 'online',
    nonCore: true,
    details: [
      {
        id: 'ibkr-dated-futures',
        label: 'IBKR dated futures',
        status: 'online',
        sourceStatus: 'live',
        role: 'live_dated_futures',
        neutral: false,
        coverage: { requested: 3, verified: 3, rejected: 0, status: 'complete' },
        optionalCoverage: { requested: 1, verified: 0, rejected: 1 },
        symbols: [
          { symbol: 'CLU6', status: 'offline', sourceStatus: 'unavailable', errorCode: 'LIVE_MARKET_MARK_REQUIRED' },
          { symbol: 'GCQ6', status: 'online', sourceStatus: 'live' },
          { symbol: 'ESU6', status: 'online', sourceStatus: 'live' },
          { symbol: 'NQU6', status: 'online', sourceStatus: 'live' },
        ],
      },
      {
        id: 'kalshi-resolver',
        label: 'Kalshi resolver venues',
        status: 'online',
        sourceStatus: 'available',
        role: 'resolver_venue',
        neutral: false,
      },
      {
        id: 'forecastex-publications',
        label: 'ForecastEx public publications',
        status: 'online',
        sourceStatus: 'available',
        role: 'official_publication',
        neutral: false,
      },
      {
        id: 'coinbase-proxy',
        label: 'Coinbase proxy',
        status: 'online',
        sourceStatus: 'available',
        role: 'proxy_only',
        neutral: false,
      },
      {
        id: 'bls-cpi-publication',
        label: 'BLS CPI publication',
        status: 'online',
        sourceStatus: 'pending_release',
        role: 'official_publication',
        neutral: true,
        due: false,
      },
    ],
  },
];

function statusPayload({
  checkedAt = new Date().toISOString(),
  services = onlineServices,
} = {}) {
  return { checkedAt, overall: 'online', services };
}

function loginPayload({
  checkedAt = new Date().toISOString(),
  overrides = {},
  actions,
} = {}) {
  const details = [
    { id: 'ibkr-gateway', status: 'online', state: 'connected', required: true },
    { id: 'gmail-oauth', status: 'online', state: 'fresh', required: true },
    { id: 'aws-admin', status: 'online', state: 'fresh', required: false },
    { id: 'aws-api', status: 'online', state: 'fresh', required: true },
    { id: 'aws-bridge', status: 'closed', state: 'disabled', required: false },
  ].map((detail) => ({
    ...detail,
    checkedAt,
    verifiedAt: detail.state === 'disabled' ? null : checkedAt,
    expiresAt: null,
    ...(overrides[detail.id] || {}),
  }));
  return {
    version: 1,
    checkedAt,
    service: {
      id: 'logins',
      status: 'online',
      details,
    },
    ...(actions ? { actions } : {}),
  };
}

function productsPayload({
  checkedAt = new Date().toISOString(),
  marketSession,
  status = 'fresh',
} = {}) {
  return {
    date: '2026-08-02',
    ...(marketSession ? { marketSession } : {}),
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
    MarketDataService.getLoginStatus.mockReset();
    MarketDataService.getSystemStatus.mockReset();
    MarketDataService.getHedgeyeFreshness.mockReset();
    MarketDataService.runLoginAction.mockReset();
    MarketDataService.getLoginStatus.mockResolvedValue(loginPayload());
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

  test('normalizes only the versioned allowlisted login shape and recomputes aggregation', () => {
    const checkedAt = new Date().toISOString();
    const payload = loginPayload({
      checkedAt,
      overrides: {
        'ibkr-gateway': {
          status: 'offline',
          state: 'disconnected',
          reason: 'IB Gateway is not authenticated.',
          recovery: {
            kind: 'local-action',
            actionId: 'open-ibkr-gateway',
            label: 'Caller-controlled label',
          },
          accountId: 'U12345678',
        },
      },
    });
    payload.service.balance = 999999;
    const normalized = normalizeLoginStatus(payload);

    expect(normalized.status).toBe('offline');
    expect(normalized.details[0]).toMatchObject({
      id: 'ibkr-gateway',
      status: 'offline',
      state: 'disconnected',
      recovery: {
        kind: 'local-action',
        actionId: 'open-ibkr-gateway',
        label: 'Open IB Gateway',
      },
    });
    expect(JSON.stringify(normalized)).not.toMatch(/U12345678|999999|Caller-controlled/);
    expect(() => normalizeLoginStatus({ ...payload, version: 2 })).toThrow(/not valid/i);
  });

  test('closes recent snapshot feeds during a closed market session but keeps old or pending data actionable', () => {
    const normalized = normalizeHedgeyeProducts({
      date: '2026-08-02',
      marketSession: 'closed',
      meta: { timestamp: '2026-08-02T18:00:00.000Z' },
      dataTypes: {
        'risk-ranges': { status: 'fresh', date: '2026-07-31' },
        'early-look': { status: 'stale', date: '2026-07-31' },
        'cftc-positioning': { status: 'stale', date: '2026-05-06' },
        volume: { status: 'stale', date: '2026-03-20' },
        'inflation-nowcast': { status: 'pending', date: '2026-07-31' },
        'etf-pro': { status: 'error', date: '2026-07-31' },
      },
    });

    expect(normalized.find(({ id }) => id === 'risk-ranges').status).toBe('closed');
    expect(normalized.find(({ id }) => id === 'early-look').status).toBe('closed');
    expect(normalized.find(({ id }) => id === 'cftc-positioning').status).toBe('attention');
    expect(normalized.find(({ id }) => id === 'volume').status).toBe('attention');
    expect(normalized.find(({ id }) => id === 'inflation-nowcast').status).toBe('attention');
    expect(normalized.find(({ id }) => id === 'etf-pro').status).toBe('offline');
    expect(deriveProductsStatus(normalized)).toBe('attention');
  });

  test('loads on first open and does not request again solely because it reopened', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    const { rerender } = render(
      <SystemReadinessPanel open={false} onClose={jest.fn()} />,
    );

    expect(MarketDataService.getSystemStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Systems' })).not.toBeInTheDocument();

    rerender(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByRole('dialog', { name: 'Systems' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(7));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Products')).toBeInTheDocument();

    rerender(<SystemReadinessPanel open={false} onClose={jest.fn()} />);
    rerender(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Online')).toHaveLength(7);
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

    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(6));
    expect(screen.getByRole('button', { name: 'Expand Products' })).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByTitle('Refresh systems')).toBeDisabled();

    await act(async () => {
      resolveProducts(productsPayload());
      await pendingProducts;
    });

    await waitFor(() => expect(screen.getAllByText('Online')).toHaveLength(7));
    expect(screen.getByTitle('Refresh systems')).not.toBeDisabled();
  });

  test('renders Logins first among seven concise categories and treats a peripheral outage as attention', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => {
        if (service.id === 'live-portfolio') {
          return { ...service, status: 'offline', reason: 'Gateway signed out' };
        }
        if (service.id === 'ai') {
          return { ...service, status: 'unknown', reason: 'Verification unavailable' };
        }
        return service;
      }),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);

    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    await within(dialog).findByText('Error');
    const categoryRows = within(within(dialog).getByRole('list', { name: 'Current system status' }))
      .getAllByRole('listitem');
    expect(categoryRows).toHaveLength(7);
    expect(within(categoryRows[0]).getByText('Logins')).toBeInTheDocument();
    expect(within(dialog).getByText('Logins')).toBeInTheDocument();
    expect(within(dialog).getByText('Dashboard')).toBeInTheDocument();
    expect(within(dialog).getByText('Market data')).toBeInTheDocument();
    expect(within(dialog).getByText('Portfolio')).toBeInTheDocument();
    expect(within(dialog).getByText('AI')).toBeInTheDocument();
    expect(within(dialog).getByText('Resolver sources')).toBeInTheDocument();
    expect(within(dialog).getByText('API + UI')).toBeInTheDocument();
    expect(within(dialog).getByText('Quotes + freshness')).toBeInTheDocument();
    expect(within(dialog).getByText('IBKR session')).toBeInTheDocument();
    expect(within(dialog).getByText('Analyst + ingestion')).toBeInTheDocument();
    expect(within(dialog).getByText('Prediction-market inputs')).toBeInTheDocument();
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

  test('allowlists resolver-source details and excludes the non-core service from rail aggregation', () => {
    const suppliedResolver = {
      id: 'resolver-sources',
      label: 'Caller-controlled label',
      status: 'attention',
      nonCore: false,
      reason: 'One dated future is unavailable.',
      details: [
        {
          id: 'ibkr-dated-futures',
          label: 'Caller-controlled futures label',
          status: 'attention',
          sourceStatus: 'degraded',
          coverage: { requested: 3, verified: 2, rejected: 1, status: 'partial' },
          optionalCoverage: { requested: 1, verified: 1, rejected: 0 },
          symbols: [
            { symbol: 'NQU6', status: 'offline', sourceStatus: 'unavailable', errorCode: 'QUOTE_STALE' },
            { symbol: 'CLU6', status: 'online', sourceStatus: 'live' },
            { symbol: 'UNSAFE', status: 'online', sourceStatus: 'live' },
          ],
        },
        {
          id: 'kalshi-resolver',
          status: 'unknown',
          sourceStatus: 'not_started',
          neutral: true,
          reason: 'Not yet observed.',
        },
        { id: 'forecastex-publications', status: 'online', sourceStatus: 'available' },
        {
          id: 'coinbase-proxy',
          label: 'Exact crypto resolver',
          role: 'resolver',
          status: 'online',
          sourceStatus: 'available',
        },
        {
          id: 'bls-cpi-publication',
          status: 'online',
          sourceStatus: 'pending_release',
          neutral: true,
          due: false,
          released: false,
          releaseAt: '2026-08-19T12:30:00.000Z',
        },
        { id: 'hedgeye-risk-ranges', status: 'online' },
      ],
    };
    const normalized = normalizeSystemStatus(statusPayload({
      services: [
        ...onlineServices.filter((service) => service.id !== 'resolver-sources'),
        suppliedResolver,
      ],
    }));
    const resolver = normalized.services.find((service) => service.id === 'resolver-sources');

    expect(resolver).toMatchObject({
      label: 'Resolver sources',
      status: 'attention',
      nonCore: true,
    });
    expect(resolver.details.map((detail) => detail.id)).toEqual([
      'ibkr-dated-futures',
      'kalshi-resolver',
      'forecastex-publications',
      'coinbase-proxy',
      'bls-cpi-publication',
    ]);
    expect(resolver.details[0]).toMatchObject({
      label: 'IBKR dated futures',
      summary: '2/3 exact verified · CLU6 optional proxy live',
      coverage: { requested: 3, verified: 2, rejected: 1, status: 'partial' },
    });
    expect(resolver.details[0].symbols.map(({ symbol }) => symbol)).toEqual(['CLU6', 'NQU6']);
    expect(resolver.details.find(({ id }) => id === 'coinbase-proxy')).toMatchObject({
      label: 'Coinbase proxy',
      role: 'proxy_only',
    });
    expect(resolver.details.find(({ id }) => id === 'kalshi-resolver')).toMatchObject({
      status: 'unknown',
      neutral: true,
      statusLabel: 'Not observed',
    });
    expect(resolver.details.find(({ id }) => id === 'bls-cpi-publication')).toMatchObject({
      status: 'online',
      neutral: true,
      due: false,
      released: false,
      statusLabel: 'Scheduled',
    });
    expect(deriveSystemRailStatus(normalized.services)).toBe('online');
  });

  test('keeps Resolver sources collapsed and renders five source rows without another request', async () => {
    const resolver = onlineServices.find((service) => service.id === 'resolver-sources');
    const attentionResolver = {
      ...resolver,
      status: 'attention',
      reason: 'IBKR dated-futures coverage is partial.',
      details: resolver.details.map((detail) => (
        detail.id === 'ibkr-dated-futures'
          ? {
            ...detail,
            status: 'attention',
            sourceStatus: 'degraded',
            coverage: { requested: 3, verified: 2, rejected: 1, status: 'partial' },
            reason: 'NQU6 does not have a fresh verified quote.',
          }
          : detail
      )),
    };
    const onStatusChange = jest.fn();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => (
        service.id === 'resolver-sources' ? attentionResolver : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);
    const expand = await screen.findByRole('button', {
      name: 'Expand Resolver sources checklist',
    });
    await waitFor(() => expect(
      within(screen.getByTestId('system-service-summary-resolver-sources')).getByText('Attention'),
    ).toBeInTheDocument());
    expect(screen.queryByRole('list', { name: 'Resolver sources checklist' }))
      .not.toBeInTheDocument();

    fireEvent.click(expand);
    const checklist = screen.getByRole('list', { name: 'Resolver sources checklist' });
    expect(within(checklist).getAllByRole('listitem')).toHaveLength(5);
    expect(within(checklist).getByText('IBKR dated futures')).toBeInTheDocument();
    expect(within(checklist).getByText('2/3 exact verified · CLU6 optional proxy unavailable')).toBeInTheDocument();
    expect(within(checklist).getByText('Kalshi resolver venues')).toBeInTheDocument();
    expect(within(checklist).getByText('ForecastEx public publications')).toBeInTheDocument();
    expect(within(checklist).getByText('Coinbase proxy')).toBeInTheDocument();
    expect(within(checklist).getByText('Non-resolving spot reference only')).toBeInTheDocument();
    expect(within(checklist).getByText('BLS CPI publication')).toBeInTheDocument();
    expect(within(checklist).getByText('Scheduled')).toBeInTheDocument();
    expect(within(checklist).queryByText(/Hedgeye|Risk Ranges/i)).not.toBeInTheDocument();
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('online'));
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
      name: 'Expand Portfolio checklist',
    }));

    expect(screen.getByTestId('system-service-summary-live-portfolio'))
      .toHaveClass('sr-service__summary--expanded');

    const portfolioChecklist = screen.getByRole('list', {
      name: 'Portfolio checklist',
    });
    expect(within(portfolioChecklist).getAllByRole('listitem')).toHaveLength(4);
    expect(within(portfolioChecklist).getByText('IBKR sidecar')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Dashboard-to-IBKR bridge')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Gateway session')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Authenticated gateway link')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Managed account')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Position account access')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Session')).toBeInTheDocument();
    expect(within(portfolioChecklist).getByText('Session freshness')).toBeInTheDocument();
    expect(within(portfolioChecklist).getAllByText('Online')).toHaveLength(1);
    expect(within(portfolioChecklist).getAllByText('Error')).toHaveLength(2);
    expect(within(portfolioChecklist).getAllByText('Unknown')).toHaveLength(1);
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand Dashboard checklist',
    }));

    expect(screen.getByTestId('system-service-summary-dashboard'))
      .toHaveClass('sr-service__summary--expanded');
    expect(screen.getByTestId('system-service-summary-live-portfolio'))
      .not.toHaveClass('sr-service__summary--expanded');

    expect(screen.queryByRole('list', { name: 'Portfolio checklist' }))
      .not.toBeInTheDocument();
    const dashboardChecklist = screen.getByRole('list', { name: 'Dashboard checklist' });
    expect(within(dashboardChecklist).getAllByRole('listitem')).toHaveLength(10);
    expect(within(dashboardChecklist).getByText('API server')).toBeInTheDocument();
    expect(within(dashboardChecklist).getByText('React UI')).toBeInTheDocument();
    expect(within(dashboardChecklist).getByText('Volatility')).toBeInTheDocument();
    expect(within(dashboardChecklist).getByText('Volume')).toBeInTheDocument();
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Expand Products' }));
    expect(screen.getByTestId('system-service-summary-products'))
      .toHaveClass('sr-service__summary--expanded');
    expect(screen.queryByRole('list', { name: 'Dashboard checklist' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', {
      name: 'Hedgeye products pulled by the dashboard',
    })).toBeInTheDocument();
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
  });

  test('keeps dashboard card diagnostics isolated under the Dashboard category', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());

    render(
      <SystemReadinessPanel
        open
        onClose={jest.fn()}
        dashboardCards={{
          volatility: {
            status: 'mixed',
            detail: 'JUL 31, 2026',
            diagnostics: [{ label: 'Coverage', value: '5/7 series' }],
            issues: ['MOVE is unavailable.'],
          },
          'cftc-positioning': {
            status: 'historical',
            date: 'MAY 6',
            sourceDate: '2026-05-06',
          },
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Expand Dashboard checklist' }));

    const dashboardChecklist = screen.getByRole('list', { name: 'Dashboard checklist' });
    const volatilityRow = within(dashboardChecklist)
      .getByTestId('system-dashboard-card-volatility');
    expect(volatilityRow).toHaveAttribute('data-status', 'attention');
    expect(volatilityRow).toHaveAttribute('data-dashboard-status', 'mixed');
    expect(within(volatilityRow).getByRole('button', {
      name: 'Attention · JUL 31, 2026',
    })).toHaveClass('efr-status-chip--plain');
    expect(within(dashboardChecklist).getByTestId('system-dashboard-card-usd'))
      .toHaveAttribute('data-status', 'error');
    const cftcRow = within(dashboardChecklist)
      .getByTestId('system-dashboard-card-cftc-positioning');
    expect(cftcRow).toHaveAttribute('data-status', 'closed');
    expect(within(cftcRow).getByText('2026-05-06')).toBeInTheDocument();
    expect(within(cftcRow).getByRole('button', { name: 'Closed' }))
      .toHaveClass('efr-status-chip--plain');
    expect(within(dashboardChecklist).queryByText('MIXED / DELAYED')).not.toBeInTheDocument();

    fireEvent.click(within(volatilityRow).getByRole('button', {
      name: 'Attention · JUL 31, 2026',
    }));
    const statusDialog = screen.getByRole('dialog', {
      name: 'Dashboard · Volatility data status',
    });
    expect(within(statusDialog).getByText('Coverage')).toBeInTheDocument();
    expect(within(statusDialog).getByText('5/7 series')).toBeInTheDocument();
    expect(within(statusDialog).getByText('MOVE is unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Systems' })).toBeInTheDocument();
  });

  test('uses blue Closed for recent Dashboard references and closed-session Hedgeye feeds', async () => {
    const onStatusChange = jest.fn();
    const recentReferenceDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getHedgeyeFreshness.mockResolvedValue(productsPayload({
      marketSession: 'closed',
      status: 'stale',
    }));

    render(
      <SystemReadinessPanel
        open
        onClose={jest.fn()}
        onStatusChange={onStatusChange}
        dashboardCards={{
          volatility: {
            status: 'mixed',
            sourceDate: recentReferenceDate,
          },
          'global-quads': { status: 'manual' },
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Closed')).toHaveLength(1);
    expect(onStatusChange).toHaveBeenLastCalledWith('online');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Dashboard checklist' }));
    const dashboardChecklist = screen.getByRole('list', { name: 'Dashboard checklist' });
    const volatilityRow = within(dashboardChecklist)
      .getByTestId('system-dashboard-card-volatility');
    const quadsRow = within(dashboardChecklist)
      .getByTestId('system-dashboard-card-global-quads');

    expect(volatilityRow).toHaveAttribute('data-status', 'closed');
    expect(within(volatilityRow).getByRole('button', { name: 'Closed' }))
      .toHaveClass('efr-status-chip--closed', 'efr-status-chip--plain');
    expect(quadsRow).toHaveAttribute('data-status', 'closed');
    expect(within(quadsRow).getByRole('button', { name: 'Closed' }))
      .toHaveClass('efr-status-chip--closed', 'efr-status-chip--plain');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Products' }));
    const productsList = screen.getByRole('list', {
      name: 'Hedgeye products pulled by the dashboard',
    });
    expect(within(productsList).getAllByText('Closed')).toHaveLength(14);
  });

  test('puts attention product reasons behind a second disclosure', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getHedgeyeFreshness.mockResolvedValue(productsPayload({ status: 'stale' }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Expand Products' }));
    const productsList = screen.getByRole('list', {
      name: 'Hedgeye products pulled by the dashboard',
    });
    const riskRangesRow = within(productsList).getAllByRole('listitem')
      .find((row) => within(row).queryByText('Risk Ranges'));

    expect(within(riskRangesRow).getByRole('button', {
      name: 'Expand Risk Ranges issue',
    })).toBeInTheDocument();
    expect(within(riskRangesRow).queryByText('The latest available data is from 2026-07-29.'))
      .not.toBeInTheDocument();

    fireEvent.click(within(riskRangesRow).getByRole('button', {
      name: 'Expand Risk Ranges issue',
    }));

    expect(within(riskRangesRow).getByText('ISSUE')).toBeInTheDocument();
    expect(within(riskRangesRow).getByText('The latest available data is from 2026-07-29.'))
      .toBeInTheDocument();
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
      name: 'Expand AI checklist',
    }));

    const aiChecklist = screen.getByRole('list', { name: 'AI checklist' });
    expect(within(aiChecklist).getByText('The Analyst')).toBeInTheDocument();
    expect(within(aiChecklist).getByText('Gmail Function')).toBeInTheDocument();
    expect(within(aiChecklist).getByText('On-demand research assistant')).toBeInTheDocument();
    expect(within(aiChecklist).getByText('Hedgeye email ingestion')).toBeInTheDocument();
    expect(within(aiChecklist).getAllByText('Online')).toHaveLength(2);
    expect(within(aiChecklist).queryByText(/Hermes Developer|Hermes Security/)).not.toBeInTheDocument();
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

    expect(screen.getAllByText('2026-07-29')).toHaveLength(6);
    expect(screen.queryByText('2026-07-30')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand AI checklist',
    }));
    const aiChecklist = screen.getByRole('list', { name: 'AI checklist' });
    expect(within(aiChecklist).getAllByText('2026-07-29')).toHaveLength(2);
  });

  test('shows the exact Analyst issue in the expanded checklist', async () => {
    const analystIssue = 'The Analyst runtime is unavailable; restart the repository-owned stack.';
    const analystIssueParts = [
      'The Analyst runtime is unavailable.',
      'Restart the repository-owned stack.',
    ];
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      overall: 'attention',
      services: onlineServices.map((service) => (
        service.id === 'ai'
          ? {
            ...service,
            status: 'attention',
            reason: analystIssue,
            details: service.details.map((detail) => (
              detail.id === 'analyst-runtime'
                ? {
                  ...detail,
                  status: 'attention',
                  reason: analystIssue,
                }
                : detail
            )),
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand AI checklist',
    }));

    const aiChecklist = screen.getByRole('list', { name: 'AI checklist' });
    expect(within(aiChecklist)
      .queryByText(analystIssueParts[0]))
      .not.toBeInTheDocument();

    fireEvent.click(within(aiChecklist).getByRole('button', {
      name: 'Expand The Analyst issue',
    }));

    expect(screen.getByText(analystIssueParts[0]))
      .toBeInTheDocument();
    expect(screen.getByText(analystIssueParts[1]))
      .toBeInTheDocument();
  });

  test('renders failed Analyst and stale Gmail evidence as Error with exact reasons', async () => {
    const gmailReason = 'Gmail Function heartbeat is stale; scheduled ingestion must succeed again.';
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: onlineServices.map((service) => (
        service.id === 'ai'
          ? {
            ...service,
            status: 'offline',
            reason: 'One or more AI components are unavailable.',
            details: service.details.map((detail) => ({
              ...detail,
              status: 'offline',
              reason: detail.id === 'gmail-ingestion'
                ? gmailReason
                : 'The Analyst runtime is unavailable or has unverified process provenance.',
            })),
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    await within(dialog).findByText('Error');
    expect(within(dialog).queryByText('Unknown')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', {
      name: 'Expand AI checklist',
    }));
    const checklist = within(dialog).getByRole('list', { name: 'AI checklist' });
    expect(within(checklist).getAllByText('Error')).toHaveLength(2);
    expect(within(checklist).queryByText('Unknown')).not.toBeInTheDocument();

    fireEvent.click(within(checklist).getByRole('button', {
      name: 'Expand Gmail Function issue',
    }));
    expect(within(checklist).getByText('Gmail Function heartbeat is stale.'))
      .toBeInTheDocument();
    expect(within(checklist).getByText('Scheduled ingestion must succeed again.'))
      .toBeInTheDocument();
  });

  test('allows both AI component issues to stay expanded at the same time', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      overall: 'attention',
      services: onlineServices.map((service) => (
        service.id === 'ai'
          ? {
            ...service,
            status: 'attention',
            details: service.details.map((detail) => {
              if (detail.id === 'analyst-runtime') {
                return {
                  ...detail,
                  status: 'attention',
                  reason: 'The Analyst runtime needs attention.',
                };
              }
              if (detail.id === 'gmail-ingestion') {
                return {
                  ...detail,
                  status: 'offline',
                  reason: 'Gmail Function did not complete successfully; a fresh heartbeat is required.',
                };
              }
              return detail;
            }),
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', {
      name: 'Expand AI checklist',
    }));

    const aiChecklist = screen.getByRole('list', { name: 'AI checklist' });
    const analystToggle = within(aiChecklist).getByRole('button', {
      name: 'Expand The Analyst issue',
    });
    const gmailToggle = within(aiChecklist).getByRole('button', {
      name: 'Expand Gmail Function issue',
    });

    fireEvent.click(analystToggle);
    fireEvent.click(gmailToggle);

    expect(analystToggle).toHaveAttribute('aria-expanded', 'true');
    expect(gmailToggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(aiChecklist).getByText('The Analyst runtime needs attention.'))
      .toBeInTheDocument();
    expect(within(aiChecklist).getByText('Gmail Function did not complete successfully.'))
      .toBeInTheDocument();
    expect(within(aiChecklist).getByText('A fresh heartbeat is required.'))
      .toBeInTheDocument();
  });

  test('keeps market-data reasons behind a second concise disclosure', async () => {
    const delayedReason = 'Only delayed provider data is available; current live quotes are unavailable.';
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      overall: 'attention',
      services: onlineServices.map((service) => (
        service.id === 'market-data'
          ? {
            ...service,
            status: 'attention',
            details: service.details.map((detail) => ({
              ...detail,
              status: 'attention',
              reason: delayedReason,
            })),
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Expand Market data checklist' }));
    const marketDataChecklist = screen.getByRole('list', { name: 'Market data checklist' });

    expect(within(marketDataChecklist).queryByText('Only delayed provider data is available; current live quotes are unavailable.'))
      .not.toBeInTheDocument();
    expect(within(marketDataChecklist).getByText('Live quote source')).toBeInTheDocument();
    expect(within(marketDataChecklist).getByText('Age and session check')).toBeInTheDocument();

    fireEvent.click(within(marketDataChecklist).getByRole('button', {
      name: 'Expand Primary provider issue',
    }));

    expect(within(marketDataChecklist).getByText('ISSUE')).toBeInTheDocument();
    expect(within(marketDataChecklist).getByText('Only delayed provider data is available.'))
      .toBeInTheDocument();
    expect(within(marketDataChecklist).getByText('Current live quotes are unavailable.'))
      .toBeInTheDocument();
    expect(within(marketDataChecklist).queryByText(delayedReason)).not.toBeInTheDocument();
  });

  test('shows mixed coverage as a live provider with an attention-level fresh quote', async () => {
    const mixedReason = 'Live IBKR quotes are available; some requested instruments are using delayed Yahoo data.';
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      overall: 'attention',
      services: onlineServices.map((service) => (
        service.id === 'market-data'
          ? {
            ...service,
            status: 'attention',
            details: [
              { id: 'primary-provider', label: 'Primary provider', status: 'online' },
              { id: 'fresh-quote', label: 'Fresh quote', status: 'attention', reason: mixedReason },
            ],
          }
          : service
      )),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Expand Market data checklist' }));
    const marketDataChecklist = screen.getByRole('list', { name: 'Market data checklist' });

    expect(within(marketDataChecklist).queryByRole('button', {
      name: 'Expand Primary provider issue',
    })).not.toBeInTheDocument();
    const freshQuoteToggle = within(marketDataChecklist).getByRole('button', {
      name: 'Expand Fresh quote issue',
    });
    fireEvent.click(freshQuoteToggle);
    expect(within(marketDataChecklist).getByText('Live IBKR quotes are available.'))
      .toBeInTheDocument();
    expect(within(marketDataChecklist).getByText('Some requested instruments are using delayed Yahoo data.'))
      .toBeInTheDocument();
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

    await screen.findByText('Error');
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

    await screen.findByText('Attention');
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('attention'));
    expect(onStatusChange).not.toHaveBeenCalledWith('offline');
    expect(screen.getByTitle('Refresh systems')).not.toBeDisabled();
  });

  test('maps missing and unrecognized service results to Unknown', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      services: [{ id: 'dashboard', status: 'mystery' }],
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getAllByText('Unknown')).toHaveLength(5));
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('refreshes only on command', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledWith({ refresh: false });

    fireEvent.click(screen.getByTitle('Refresh systems'));

    await waitFor(() => expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MarketDataService.getLoginStatus).toHaveBeenLastCalledWith({
      refresh: true,
    }));
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('shows precise login state, timestamps, purpose, and a fixed recovery action', async () => {
    const checkedAt = new Date().toISOString();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({ checkedAt }));
    MarketDataService.getLoginStatus.mockResolvedValue(loginPayload({
      checkedAt,
      overrides: {
        'ibkr-gateway': {
          status: 'offline',
          state: 'disconnected',
          reason: 'IB Gateway is not authenticated.',
          recovery: {
            kind: 'local-action',
            actionId: 'open-ibkr-gateway',
            label: 'Open something unsafe',
          },
        },
      },
    }));
    MarketDataService.runLoginAction.mockResolvedValue({ accepted: true });

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Logins checklist' }));
    const checklist = screen.getByRole('list', { name: 'Logins checklist' });
    expect(within(checklist).getByText('Brokerage + prediction markets')).toBeInTheDocument();
    expect(within(checklist).getAllByText('Required').length).toBeGreaterThan(0);
    expect(await within(checklist).findByText('Disconnected')).toBeInTheDocument();
    expect(within(checklist).getAllByText('Online')).toHaveLength(3);
    expect(within(checklist).queryByText('Kalshi API')).not.toBeInTheDocument();
    expect(within(checklist).queryByText('Connected')).not.toBeInTheDocument();
    expect(within(checklist).queryByText('Fresh')).not.toBeInTheDocument();
    expect(within(checklist).getAllByText(/Checked|Verified/).length).toBeGreaterThan(0);

    fireEvent.click(within(checklist).getByRole('button', {
      name: 'Expand IBKR Gateway login details',
    }));
    const recovery = within(checklist).getByRole('button', { name: 'Open IB Gateway' });
    expect(within(checklist).queryByText('Open something unsafe')).not.toBeInTheDocument();
    fireEvent.click(recovery);

    await waitFor(() => expect(MarketDataService.runLoginAction)
      .toHaveBeenCalledWith('open-ibkr-gateway'));
    await waitFor(() => expect(within(checklist).getByRole('status'))
      .toHaveTextContent('IB Gateway launched. Complete login; socket and portfolio verification is pending.'));
    await waitFor(() => expect(recovery).not.toBeDisabled());
  });

  test('renders AWS recovery as a fixed SSO login action', async () => {
    const checkedAt = new Date().toISOString();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({ checkedAt }));
    MarketDataService.getLoginStatus.mockResolvedValue(loginPayload({
      checkedAt,
      overrides: {
        'aws-admin': {
          status: 'unknown',
          state: 'unverified',
          reason: 'AWS Admin SSO could not be verified before the timeout.',
          recovery: {
            kind: 'local-action',
            actionId: 'aws-admin-login',
            label: 'Caller-controlled label',
          },
        },
      },
    }));
    MarketDataService.runLoginAction.mockResolvedValue({ accepted: true });
    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Logins checklist' }));
    const checklist = screen.getByRole('list', { name: 'Logins checklist' });
    fireEvent.click(within(checklist).getByRole('button', {
      name: 'Expand AWS Admin login details',
    }));
    await waitFor(() => expect(within(checklist).getByText(
      'AWS Admin SSO could not be verified before the timeout.',
    )).toBeInTheDocument());

    const action = within(checklist).getByRole('button', { name: 'Refresh AWS SSO' });
    fireEvent.click(action);
    await waitFor(() => expect(MarketDataService.runLoginAction)
      .toHaveBeenCalledWith('aws-admin-login'));
    await waitFor(() => expect(within(checklist).getByRole('status'))
      .toHaveTextContent('Interactive flow launched. Complete browser authorization; AWS role verification is pending.'));
    expect(MarketDataService.getLoginStatus).toHaveBeenLastCalledWith({ refresh: false });
  });

  test('polls every two seconds while an interactive login action is active', async () => {
    jest.useFakeTimers();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getLoginStatus
      .mockResolvedValueOnce(loginPayload({
        overrides: {
          'aws-admin': {
            status: 'closed',
            state: 'signed_out',
            reason: 'AWS Admin SSO session has expired; refresh it before operator changes.',
            recovery: {
              kind: 'local-action',
              actionId: 'aws-admin-login',
              label: 'Refresh AWS SSO',
            },
          },
        },
      }))
      .mockResolvedValue(loginPayload({
        overrides: {
          'aws-admin': {
            status: 'closed',
            state: 'signed_out',
            reason: 'AWS Admin SSO session has expired; refresh it before operator changes.',
            recovery: {
              kind: 'local-action',
              actionId: 'aws-admin-login',
              label: 'Refresh AWS SSO',
            },
          },
        },
        actions: {
          'aws-admin-login': {
            state: 'awaiting_user',
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      }));
    MarketDataService.runLoginAction.mockResolvedValue({ accepted: true, state: 'awaiting_user' });

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Logins checklist' }));
    const checklist = screen.getByRole('list', { name: 'Logins checklist' });
    fireEvent.click(within(checklist).getByRole('button', {
      name: 'Expand AWS Admin login details',
    }));
    fireEvent.click(within(checklist).getByRole('button', { name: 'Refresh AWS SSO' }));
    await waitFor(() => expect(MarketDataService.runLoginAction)
      .toHaveBeenCalledWith('aws-admin-login'));
    await waitFor(() => expect(within(checklist).getByText('Waiting for browser authorization'))
      .toBeInTheDocument());

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MarketDataService.getLoginStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('clears prior online results when refresh fails', async () => {
    MarketDataService.getSystemStatus
      .mockResolvedValueOnce(statusPayload())
      .mockRejectedValueOnce(new Error('API connection refused'));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Online')).toHaveLength(7);

    fireEvent.click(screen.getByTitle('Refresh systems'));

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Unknown')).toHaveLength(5);
    expect(screen.getAllByText('Online')).toHaveLength(2);
    expect(screen.queryByText('API connection refused')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
  });

  test('polls only Logins every minute while keeping the checked core snapshot visible', async () => {
    jest.useFakeTimers();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getLoginStatus.mockImplementation(async () => loginPayload());
    const onStatusChange = jest.fn();

    render(<SystemReadinessPanel open onClose={jest.fn()} onStatusChange={onStatusChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText('Online')).toHaveLength(7);

    for (let minute = 0; minute < 5; minute += 1) {
      await act(async () => {
        jest.advanceTimersByTime(60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(screen.getAllByText('Online')).toHaveLength(7);
    expect(screen.queryByText('Status expired')).not.toBeInTheDocument();
    expect(onStatusChange).toHaveBeenLastCalledWith('online');
    expect(MarketDataService.getSystemStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeFreshness).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledTimes(6);
  });

  test('stops login polling when the panel closes', async () => {
    jest.useFakeTimers();
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload());
    MarketDataService.getLoginStatus.mockImplementation(async () => loginPayload());
    const { rerender } = render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledTimes(1);

    rerender(<SystemReadinessPanel open={false} onClose={jest.fn()} />);
    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });
    expect(MarketDataService.getLoginStatus).toHaveBeenCalledTimes(1);
  });

  test('rejects stale responses instead of displaying old green statuses', async () => {
    MarketDataService.getSystemStatus.mockResolvedValue(statusPayload({
      checkedAt: new Date(Date.now() - (2 * 60 * 1000)).toISOString(),
    }));
    MarketDataService.getHedgeyeFreshness.mockRejectedValue(new Error('Unavailable'));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());
    expect(screen.getAllByText('Online')).toHaveLength(1);
    expect(screen.getAllByText('Unknown')).toHaveLength(6);
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

    render(
      <>
        <button type="button" data-navigation-item-id="system">Systems rail toggle</button>
        <SystemReadinessPanel open onClose={onClose} />
      </>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Systems' });
    await waitFor(() => expect(screen.getByTitle('Refresh systems')).not.toBeDisabled());

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Systems rail toggle' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});
