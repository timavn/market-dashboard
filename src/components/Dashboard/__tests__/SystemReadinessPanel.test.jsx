import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import SystemReadinessPanel from '../SystemReadinessPanel';
import { MarketDataService } from '../../../services/api/marketDataService';

let mockTheme = 'light';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getSystemReadiness: jest.fn(),
    runSystemReadinessRepair: jest.fn(),
  },
}));

jest.mock('../../../context/ThemeContext', () => ({
  useTheme: () => ({ theme: mockTheme }),
}));

function readinessPayload({
  status = 'ready',
  ready = status === 'ready',
  checkedAt = new Date().toISOString(),
  checks,
  capabilities,
  rootCauses,
  researchProductMatrix,
} = {}) {
  return {
    version: 1,
    status,
    ready,
    checkedAt,
    summary: {},
    ...(capabilities ? { capabilities } : {}),
    ...(rootCauses ? { rootCauses } : {}),
    ...(researchProductMatrix ? { researchProductMatrix } : {}),
    groups: [
      {
        id: 'local-stack',
        label: 'Local stack',
        checks: checks || [
          {
            id: 'api',
            label: 'Dashboard API',
            status: 'pass',
            blocking: true,
            summary: 'Express answered the readiness request.',
            observedAt: checkedAt,
            ageSeconds: 1,
          },
          {
            id: 'sidecar',
            label: 'IBKR sidecar',
            status: 'pass',
            blocking: true,
            summary: 'Sidecar is live and responsive.',
            observedAt: checkedAt,
            ageSeconds: 2,
          },
        ],
      },
    ],
  };
}

describe('SystemReadinessPanel', () => {
  beforeEach(() => {
    mockTheme = 'light';
    MarketDataService.getSystemReadiness.mockReset();
    MarketDataService.runSystemReadinessRepair.mockReset();
  });

  test('renders a verified ready checklist and reports aggregate status to the rail', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload());

    render(
      <SystemReadinessPanel
        open
        onClose={jest.fn()}
        onStatusChange={onStatusChange}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: 'System readiness' });
    expect(await within(dialog).findByText('Ready')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Local stack' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Dashboard API' })).toBeInTheDocument();
    expect(within(dialog).getByText('2 checks')).toBeInTheDocument();
    expect(within(dialog).getByText('2 passed')).toBeInTheDocument();
    expect(MarketDataService.getSystemReadiness).toHaveBeenCalledWith({ refresh: false });
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('ready'));
  });

  test('maps an unrecognized check to a blocking failure instead of trusting a ready aggregate', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      checks: [
        {
          id: 'gmail',
          label: 'Gmail authentication',
          status: 'mystery',
          blocking: false,
          summary: '',
        },
      ],
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    const check = await screen.findByRole('article', { name: 'Gmail authentication' });
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(check).toHaveAttribute('data-status', 'fail');
    expect(check).toHaveAttribute('data-blocking', 'true');
    expect(within(check).getByText('Unrecognized readiness status: mystery.')).toBeInTheDocument();
  });

  test('shows impact and exact recovery instructions for a degraded dependency', async () => {
    const checkedAt = new Date().toISOString();
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      status: 'degraded',
      ready: false,
      checkedAt,
      checks: [
        {
          id: 'hermes',
          label: 'Hermes workers',
          status: 'warn',
          blocking: false,
          summary: 'Latest worker heartbeat is outside its cadence.',
          detail: 'Quant Developer last ran six days ago.',
          observedAt: checkedAt,
          ageSeconds: 518400,
          impact: 'Automated monitoring is unavailable.',
          recovery: {
            kind: 'command',
            label: 'Run Hermes diagnostics',
            command: 'npm run verify:workflow',
          },
        },
      ],
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Automated monitoring is unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Run Hermes diagnostics')).toBeInTheDocument();
    expect(screen.getByText('npm run verify:workflow')).toBeInTheDocument();
  });

  test('uses capabilities so an ancillary failure degrades instead of blocking core operation', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      status: 'degraded',
      ready: false,
      capabilities: [{
        id: 'automation.hermes',
        label: 'Hermes and Gmail automation',
        description: 'Scheduled jobs are completing.',
        status: 'degraded',
        blocking: false,
        checkIds: ['hermes-analyst', 'hermes-developer'],
        rootCauseIds: ['HERMES_SCHEDULE_STALE'],
      }],
      rootCauses: [{
        id: 'HERMES_SCHEDULE_STALE',
        errorCode: 'HERMES_SCHEDULE_STALE',
        checkId: 'hermes-analyst',
        label: 'Hermes scheduling',
        status: 'fail',
        summary: 'No scheduled invocation was observed.',
        owner: 'automation-operations',
        capabilityIds: ['automation.hermes'],
        affectedCheckIds: ['hermes-analyst', 'hermes-developer'],
      }],
      checks: [
        {
          id: 'hermes-analyst',
          label: 'Hermes analyst',
          status: 'fail',
          blocking: true,
          summary: 'No scheduled invocation was observed.',
          errorCode: 'HERMES_SCHEDULE_STALE',
          owner: 'automation-operations',
          capabilityIds: ['automation.hermes'],
        },
        {
          id: 'hermes-developer',
          label: 'Hermes developer',
          status: 'fail',
          blocking: true,
          summary: 'No scheduled invocation was observed.',
          errorCode: 'HERMES_SCHEDULE_STALE',
          owner: 'automation-operations',
          capabilityIds: ['automation.hermes'],
        },
      ],
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('Hermes and Gmail automation')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'What needs attention' }))
      .getByText('HERMES_SCHEDULE_STALE')).toBeInTheDocument();
    expect(screen.getByText('Owner: automation-operations · affects 2 checks')).toBeInTheDocument();
    const affectedChecks = screen.getByRole('list', { name: 'Hermes scheduling affected checks' });
    expect(within(affectedChecks).getByText('Hermes analyst')).toBeInTheDocument();
    expect(within(affectedChecks).getByText('Hermes developer')).toBeInTheDocument();
    expect(screen.getByText('1 root cause')).toBeInTheDocument();
  });

  test('renders the cadence-aware research product matrix and degrades without blocking live portfolio', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      status: 'ready',
      ready: true,
      researchProductMatrix: {
        schemaVersion: 1,
        marketDate: '2026-07-21',
        status: 'failed',
        collectionErrors: [],
        products: [
          {
            id: 'risk-ranges',
            label: 'Risk Ranges',
            cadence: 'market_day_0800',
            due: true,
            status: 'missing',
            stages: { received: false, parsed: false, validated: false, indexed: false },
            detail: 'Risk Ranges are due but no artifact was received.',
            errorCode: 'RESEARCH_PRODUCT_DUE_MISSING',
          },
          {
            id: 'the-call',
            label: 'The Call',
            cadence: 'event_driven',
            due: false,
            status: 'not_due',
            stages: { received: false, parsed: false, validated: false, indexed: false },
            detail: 'No publication is due.',
          },
          {
            id: 'signal-strength',
            label: 'Signal Strength',
            cadence: 'event_driven',
            due: true,
            status: 'indexed',
            publicationDate: '2026-07-21',
            observedAt: new Date().toISOString(),
            stages: { received: true, parsed: true, validated: true, indexed: true },
            detail: 'All stages complete.',
          },
        ],
      },
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    const matrix = screen.getByRole('region', { name: 'Research product pipeline' });
    expect(within(matrix).getByText('Market date 2026-07-21')).toBeInTheDocument();
    expect(within(matrix).getByText('Risk Ranges')).toBeInTheDocument();
    expect(within(matrix).getByText('Missing')).toBeInTheDocument();
    expect(within(matrix).getByText('The Call')).toBeInTheDocument();
    expect(within(matrix).getByText('Not due')).toBeInTheDocument();
    expect(within(matrix).getByText('Signal Strength')).toBeInTheDocument();
    expect(within(matrix).getByText('Indexed')).toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  test('runs only an automatic repair action exposed by the readiness contract', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      status: 'blocked',
      ready: false,
      checks: [{
        id: 'ui',
        label: 'Dashboard UI',
        status: 'fail',
        blocking: true,
        summary: 'UI is not listening.',
        owner: 'local-operations',
        recovery: {
          kind: 'command',
          label: 'Start missing services.',
          command: 'npm start',
          automatic: true,
          actionId: 'start-local-stack',
        },
      }],
    }));
    MarketDataService.runSystemReadinessRepair.mockResolvedValue({
      message: 'The safe local recovery was started.',
    });

    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run safe repair' }));

    await waitFor(() => expect(MarketDataService.runSystemReadinessRepair)
      .toHaveBeenCalledWith('start-local-stack'));
    expect(await screen.findByText('The safe local recovery was started.')).toBeInTheDocument();
  });

  test('manual refresh sends the cache-bypass flag', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload());
    render(<SystemReadinessPanel open onClose={jest.fn()} />);
    await screen.findByText('Ready');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh checks' }));

    await waitFor(() => expect(MarketDataService.getSystemReadiness).toHaveBeenCalledWith({ refresh: true }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });

  test('clears a prior ready state and blocks the rail when refresh fails', async () => {
    const onStatusChange = jest.fn();
    MarketDataService.getSystemReadiness
      .mockResolvedValueOnce(readinessPayload())
      .mockRejectedValueOnce(new Error('API connection refused'));

    render(
      <SystemReadinessPanel
        open
        onClose={jest.fn()}
        onStatusChange={onStatusChange}
      />,
    );
    await screen.findByText('Ready');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh checks' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('API connection refused');
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('npm start')).toBeInTheDocument();
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith('blocked'));
  });

  test('rejects a stale readiness response instead of rendering old passes', async () => {
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload({
      checkedAt: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
    }));

    render(<SystemReadinessPanel open onClose={jest.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Readiness response is stale');
    expect(screen.queryByRole('heading', { name: 'Dashboard API' })).not.toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  test('uses the dark theme and closes from Escape', async () => {
    mockTheme = 'dark';
    const onClose = jest.fn();
    MarketDataService.getSystemReadiness.mockResolvedValue(readinessPayload());

    render(<SystemReadinessPanel open onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'System readiness' });
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(dialog).toHaveClass('sr-panel--dark');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
