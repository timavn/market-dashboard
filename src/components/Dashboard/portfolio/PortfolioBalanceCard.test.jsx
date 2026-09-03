import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBalanceCard from './PortfolioBalanceCard';
import PersistentSurface from '../../common/PersistentSurface';
import { MarketDataService } from '../../../services/api/marketDataService';
import { resetSessionResourceStore } from '../../../utils/sessionResourceStore';
import { clearPortfolioBalanceReferenceSnapshotsForTests } from '../../../hooks/usePortfolioBalance';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getPortfolioBalance: jest.fn(),
    previewPortfolioBalance: jest.fn(),
  },
}));

function liveBalance(overrides = {}) {
  const now = new Date().toISOString();
  return {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    accountId: 'U1',
    snapshotId: 'snapshot-1',
    observedAt: now,
    socketVerifiedAt: now,
    accountValuesObservedAt: now,
    fromCache: false,
    currency: 'USD',
    settlement: {
      state: 'pending',
      date: '2026-08-05',
      horizonDate: '2026-08-07',
      pending: true,
    },
    activity: {
      openOrderCount: 0,
      sameDayExecutionCount: 2,
      previewAvailable: true,
      previewUnavailableReason: null,
    },
    exposure: {
      netLiquidation: 195000,
      longMarketValue: 195000,
      shortMarketValue: 100000,
      grossMarketValue: 295000,
      netMarketValue: 95000,
      longPercent: 100,
      shortPercent: 51.282,
      grossPercent: 151.282,
      netPercent: 48.718,
    },
    margin: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      health: 'healthy',
      availableFunds: 110000,
      excessLiquidity: 115000,
      buyingPower: 380000,
      initialDeficit: 0,
      maintenanceDeficit: 0,
      excessLiquidityPercent: 58.974,
    },
    cash: {
      securitiesCashFloor: 114000,
      worstSettlementDate: '2026-08-07',
      shortCollateral: 102000,
      noBorrowBalance: 12000,
      addLongRoom: 12000,
      trimRequired: 0,
      noBorrowLongLimit: 207000,
    },
    buffer: {
      baseReserve: 2000,
      shortShockReserve: 5100,
      totalReserve: 7100,
      balance: 4900,
      addLongRoom: 4900,
      trimRequired: 0,
      bufferedLongLimit: 199900,
    },
    interestExposure: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      interpretation: 'debit_interest_exposure_only',
      actionable: false,
      current: {
        effectiveDate: '2026-08-05',
        securitiesCash: 115000,
        shortCollateral: 102000,
        estimatedDebitPrincipal: 0,
      },
      projected: {
        effectiveDate: '2026-08-07',
        securitiesCash: 114000,
        shortCollateral: 102000,
        estimatedDebitPrincipal: 0,
      },
      policy: {
        totalReserve: 7100,
        estimatedDebitPrincipalAfterReserve: 0,
      },
    },
    shortPositions: [{
      conId: 756733,
      symbol: 'SPY',
      quantity: -1000,
      absoluteQuantity: 1000,
      priorClose: 100,
      collateralPerShare: 102,
      collateral: 102000,
    }],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PortfolioBalanceCard', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    clearPortfolioBalanceReferenceSnapshotsForTests();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('separates broker margin health from debit-interest exposure', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance());
    render(<PortfolioBalanceCard accountId="U1" />);

    const card = await screen.findByTestId('portfolio-balance');
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'live'));
    expect(within(card).getByText('Portfolio balance')).toBeInTheDocument();
    expect(within(card).getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
    expect(within(card).getByTestId('portfolio-balance-buffered')).toHaveTextContent('$0');
    expect(within(card).getByTestId('portfolio-balance-long-limit')).toHaveTextContent('$0');
    expect(within(card).getByText(/not a margin call or sell instruction/i))
      .toBeInTheDocument();
    expect(within(card).getByText('Current long')).toBeInTheDocument();
    expect(within(card).getByText('Current short')).toBeInTheDocument();
    expect(within(card).getByTestId('portfolio-balance-settlement'))
      .toHaveTextContent('Pending settlements included through Aug 7');
    expect(within(card).queryByText(/one-use/i)).not.toBeInTheDocument();
  });

  test('shows verified Kalshi accounting without adding it to stock controls', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance({
      eventContracts: {
        venue: 'KALSHI',
        positionCount: 3,
        contractQuantity: 42,
        marketValue: 1490,
        initialMargin: 1490,
        maintenanceMargin: 1490,
        capacityContribution: 0,
        verification: 'ibkr_kalshi_commodity_segment_reconciled',
      },
    }));
    render(<PortfolioBalanceCard accountId="U1" />);

    const card = await screen.findByTestId('portfolio-balance');
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'live'));
    expect(within(card).getByText(
      'Kalshi: 3 positions · $1,490 value · fully margined · $0 interest-model contribution',
    )).toBeInTheDocument();
    expect(within(card).queryByText(/KALSHI.*shares/i)).not.toBeInTheDocument();
  });

  test('renders ForecastEx and mixed canonical event venues by their actual names', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance({
      eventContracts: {
        venues: ['FORECASTX', 'KALSHI'],
        venue: null,
        positionCount: 3,
        contractQuantity: 42,
        marketValue: 1490,
        initialMargin: 1490,
        maintenanceMargin: 1490,
        capacityContribution: 0,
        verification: 'ibkr_event_contract_commodity_segment_reconciled',
      },
    }));
    render(<PortfolioBalanceCard accountId="U1" />);

    const card = await screen.findByTestId('portfolio-balance');
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'live'));
    expect(within(card).getByText(
      'ForecastEx + Kalshi: 3 positions · $1,490 value · fully margined · $0 interest-model contribution',
    )).toBeInTheDocument();
  });

  test('does not expose capacity when event venue evidence is malformed', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance({
      eventContracts: {
        venues: ['UNKNOWN'],
        positionCount: 1,
        marketValue: 100,
        capacityContribution: 0,
      },
    }));
    render(<PortfolioBalanceCard accountId="U1" />);

    const card = await screen.findByTestId('portfolio-balance');
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'live'));
    expect(within(card).queryByTestId('portfolio-balance-exact')).not.toBeInTheDocument();
    expect(within(card).getByText(
      'Interest exposure is unavailable until IBKR provides complete balance evidence. No amount is inferred.',
    )).toBeInTheDocument();
  });

  test('keeps the verified snapshot mounted while the next 15-second poll is in flight', async () => {
    jest.useFakeTimers();
    const next = deferred();
    MarketDataService.getPortfolioBalance
      .mockResolvedValueOnce(liveBalance())
      .mockReturnValueOnce(next.promise);
    render(<PortfolioBalanceCard accountId="U1" />);

    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'live');

    act(() => jest.advanceTimersByTime(15_000));
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'live');
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');

    await act(async () => {
      next.resolve(liveBalance({ snapshotId: 'snapshot-2' }));
      await Promise.resolve();
    });
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'live');
  });

  test('keeps every number mounted across three completed polling cycles', async () => {
    jest.useFakeTimers();
    MarketDataService.getPortfolioBalance.mockImplementation(() => (
      Promise.resolve(liveBalance())
    ));
    render(<PortfolioBalanceCard accountId="U1" />);

    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    for (let cycle = 0; cycle < 3; cycle += 1) {
      act(() => jest.advanceTimersByTime(15_000));
      expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
      expect(screen.getByText('Current long')).toBeInTheDocument();
      await act(async () => Promise.resolve());
      await act(async () => Promise.resolve());
      expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'live');
      expect(screen.getByTestId('portfolio-balance-buffered')).toHaveTextContent('$0');
    }

    expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(4);
  });

  test('keeps expired numbers reference-only after the 45-second boundary', async () => {
    jest.useFakeTimers();
    const next = deferred();
    MarketDataService.getPortfolioBalance
      .mockResolvedValueOnce(liveBalance())
      .mockReturnValueOnce(next.promise);
    render(<PortfolioBalanceCard accountId="U1" />);

    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    await act(async () => {
      jest.advanceTimersByTime(45_000);
      await Promise.resolve();
    });
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'last_verified');
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
    expect(screen.getAllByText(/Last verified .* · reconnecting/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Trade preview'));
    expect(screen.getByRole('button', { name: 'Preview trade' })).toBeDisabled();
  });

  test.each([
    'GATEWAY_UNAVAILABLE',
    'IBKR_POSITIONS_CLIENT_UNAVAILABLE',
    'IBKR_SOCKET_VERIFICATION_TIMEOUT',
    'IBKR_CLIENT_ID_IN_USE',
    'IBKR_BALANCE_REQUEST_TIMEOUT',
  ])('keeps non-executable reference numbers after %s', async (errorCode) => {
    jest.useFakeTimers();
    MarketDataService.getPortfolioBalance
      .mockResolvedValueOnce(liveBalance())
      .mockRejectedValueOnce({
        response: { data: { errorCode, message: `${errorCode} broker failure` } },
      });
    render(<PortfolioBalanceCard accountId="U1" />);
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    act(() => jest.advanceTimersByTime(15_000));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'last_verified');
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
    fireEvent.click(screen.getByText('Trade preview'));
    expect(screen.getByRole('button', { name: 'Preview trade' })).toBeDisabled();
  });

  test('keeps a fresh snapshot reference-only after an untyped transport timeout', async () => {
    jest.useFakeTimers();
    MarketDataService.getPortfolioBalance
      .mockResolvedValueOnce(liveBalance())
      .mockRejectedValueOnce(new Error('Request timed out - server may be busy'));
    render(<PortfolioBalanceCard accountId="U1" />);
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    act(() => jest.advanceTimersByTime(15_000));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'last_verified');
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
  });

  test('starts immediately when opened and stops all polling while the surface is hidden', async () => {
    jest.useFakeTimers();
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance());
    const view = render(
      <PersistentSurface eager active={false}>
        <PortfolioBalanceCard accountId="U1" />
      </PersistentSurface>,
    );

    await act(async () => Promise.resolve());
    act(() => jest.advanceTimersByTime(30_000));
    expect(MarketDataService.getPortfolioBalance).not.toHaveBeenCalled();

    view.rerender(
      <PersistentSurface eager active>
        <PortfolioBalanceCard accountId="U1" />
      </PersistentSurface>,
    );
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(1);

    view.rerender(
      <PersistentSurface eager active={false}>
        <PortfolioBalanceCard accountId="U1" />
      </PersistentSurface>,
    );
    act(() => jest.advanceTimersByTime(30_000));
    await act(async () => Promise.resolve());
    expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(1);
  });

  test('pauses the 15-second poll while the browser document is hidden', async () => {
    jest.useFakeTimers();
    let hidden = false;
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance());
    try {
      render(<PortfolioBalanceCard accountId="U1" />);
      await act(async () => Promise.resolve());
      await act(async () => Promise.resolve());
      expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(1);

      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      act(() => jest.advanceTimersByTime(45_000));
      await act(async () => Promise.resolve());
      expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(1);

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await act(async () => Promise.resolve());
      await act(async () => Promise.resolve());
      expect(MarketDataService.getPortfolioBalance).toHaveBeenCalledTimes(2);
    } finally {
      if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
      else delete document.hidden;
    }
  });

  test('keeps a fresh snapshot visible through one non-disconnect validation failure', async () => {
    jest.useFakeTimers();
    MarketDataService.getPortfolioBalance
      .mockResolvedValueOnce(liveBalance())
      .mockRejectedValueOnce({
        response: {
          data: {
            errorCode: 'BALANCE_RESPONSE_UNVERIFIED',
            message: 'The replacement response did not pass validation.',
          },
        },
      });
    render(<PortfolioBalanceCard accountId="U1" />);
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    act(() => jest.advanceTimersByTime(15_000));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    expect(screen.getByTestId('portfolio-balance')).toHaveAttribute('data-status', 'live');
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
  });

  test('clears the old account immediately and ignores its late response', async () => {
    const first = deferred();
    MarketDataService.getPortfolioBalance
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(liveBalance({ accountId: 'U2', snapshotId: 'u2' }));
    const view = render(<PortfolioBalanceCard accountId="U1" />);
    view.rerender(<PortfolioBalanceCard accountId="U2" />);

    await waitFor(() => expect(screen.getByTestId('portfolio-balance'))
      .toHaveAttribute('data-status', 'live'));
    await act(async () => {
      first.resolve(liveBalance({ accountId: 'U1', snapshotId: 'late-u1' }));
      await Promise.resolve();
    });
    expect(MarketDataService.getPortfolioBalance).toHaveBeenLastCalledWith({ account: 'U2' });
    expect(screen.getByTestId('portfolio-balance-exact')).toHaveTextContent('No broker deficit');
  });

  test('disables trade preview while open orders exist but keeps the balance visible', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance({
      activity: {
        openOrderCount: 1,
        sameDayExecutionCount: 0,
        previewAvailable: false,
        previewUnavailableReason: 'open_orders_present',
      },
    }));
    render(<PortfolioBalanceCard accountId="U1" />);

    await screen.findByTestId('portfolio-balance-exact');
    fireEvent.click(screen.getByText('Trade preview'));
    expect(screen.getByText(/Resolve open orders/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview trade' })).toBeDisabled();
  });

  test('requests and renders a read-only long preview', async () => {
    MarketDataService.getPortfolioBalance.mockResolvedValue(liveBalance());
    MarketDataService.previewPortfolioBalance.mockResolvedValue({
      available: true,
      status: 'preview',
      source: 'ibkr_live_session',
      accountId: 'U1',
      fromCache: false,
      observedAt: new Date().toISOString(),
      orderSubmitted: false,
      cash: { noBorrowBalance: 7000 },
      buffer: { balance: -100 },
      exact: { remainingRoom: 7000, trimRequired: 0 },
      buffered: { remainingRoom: 0, trimRequired: 100 },
      exposure: { longMarketValue: 200000, shortMarketValue: 100000 },
    });
    render(<PortfolioBalanceCard accountId="U1" />);

    await screen.findByTestId('portfolio-balance-exact');
    fireEvent.click(screen.getByText('Trade preview'));
    fireEvent.change(screen.getByLabelText('Portfolio balance preview dollar amount'), {
      target: { value: '5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview trade' }));

    const projection = await screen.findByTestId('portfolio-balance-projection');
    expect(MarketDataService.previewPortfolioBalance).toHaveBeenCalledWith({
      accountId: 'U1',
      action: 'add_long',
      amount: 5000,
    });
    expect(within(projection).getByText('$100')).toBeInTheDocument();
    expect(within(projection).getByText(/broker margin not projected · no order submitted/i))
      .toBeInTheDocument();
  });
});
