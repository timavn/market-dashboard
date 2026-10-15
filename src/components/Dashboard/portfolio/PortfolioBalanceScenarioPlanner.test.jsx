import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBalanceScenarioPlanner, {
  normalizeVerifiedInterestStatus,
} from './PortfolioBalanceScenarioPlanner';
import { usePortfolioBalance } from '../../../hooks/usePortfolioBalance';
import { MarketDataService } from '../../../services/api/marketDataService';
import PersistentSurface from '../../common/PersistentSurface';

jest.mock('../../../hooks/usePortfolioBalance', () => ({
  usePortfolioBalance: jest.fn(),
}));

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getIbkrInterestValidationLedger: jest.fn(),
    getIbkrInterestValidationStatus: jest.fn(),
    previewPortfolioBalance: jest.fn(),
  },
}));

function interestStatus(overrides = {}) {
  const now = new Date().toISOString();
  return {
    source: 'ibkr_interest_validation',
    generatedAt: now,
    configured: true,
    accountMatched: true,
    available: true,
    actionable: false,
    status: 'learning',
    modelStatus: 'learning',
    modelStatusReason: 'calibration_in_progress',
    capabilities: {
      ready: true,
      status: 'ready',
      requiredSections: {
        tierInterestDetails: true,
        interestAccruals: true,
        cashTransactions: true,
        cashReport: true,
      },
      optionalSections: { stockBorrowFeeDetails: false },
      missingSections: [],
    },
    lastError: null,
    mtd: {
      status: 'verified',
      verifiedDebit: 57.97,
      actualDayCount: 4,
      throughDate: '2026-08-07',
    },
    forecast: {
      status: 'awaiting',
      valueDate: '2026-08-10',
      principal: null,
      point: null,
      upper: null,
      accrualDays: null,
      effectiveAnnualRate: null,
      issuedAt: null,
      rateEvidence: null,
    },
    comparison: {
      status: 'awaiting',
      outcome: 'pending',
      valueDate: '2026-08-10',
      forecastLower: null,
      forecastPoint: null,
      forecastUpper: null,
      actual: null,
      residual: null,
      issuedAt: null,
      verifiedAt: null,
      lastVerified: null,
    },
    flex: {
      status: 'ready',
      latest: {
        fetchedAt: now,
        toDate: '2026-08-07',
        reportHash: 'a'.repeat(64),
        revisionHash: 'b'.repeat(64),
      },
    },
    ...overrides,
  };
}

function liveSnapshot() {
  const now = new Date().toISOString();
  return {
    available: true,
    status: 'live',
    accountId: 'U1',
    snapshotId: 'snapshot-1',
    observedAt: now,
    exposure: {
      available: true,
      status: 'live',
      longMarketValue: 120000,
      shortMarketValue: 40000,
      grossMarketValue: 160000,
      netMarketValue: 80000,
      longPercent: 60,
      shortPercent: 20,
      grossPercent: 80,
      netPercent: 40,
      netLiquidation: 200000,
    },
    activity: { openOrderCount: 0 },
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
      excessLiquidityPercent: 57.5,
    },
    settlement: {
      state: 'pending',
      date: '2026-08-05',
      horizonDate: '2026-08-07',
      pending: true,
    },
    cash: {
      securitiesCashFloor: 50000,
      worstSettlementDate: '2026-08-07',
      shortCollateral: 40000,
      netAccruedInterest: -102.32,
      noBorrowBalance: 10000,
      addLongRoom: 10000,
      trimRequired: 0,
      noBorrowLongLimit: 130000,
    },
    buffer: {
      totalReserve: 5000,
      balance: 5000,
      addLongRoom: 5000,
      trimRequired: 0,
    },
    interestExposure: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      interpretation: 'debit_interest_exposure_only',
      actionable: false,
      current: {
        effectiveDate: '2026-08-05',
        securitiesCash: 50000,
        shortCollateral: 40000,
        estimatedDebitPrincipal: 0,
      },
      projected: {
        effectiveDate: '2026-08-07',
        securitiesCash: 50000,
        shortCollateral: 40000,
        estimatedDebitPrincipal: 0,
      },
      policy: {
        totalReserve: 5000,
        estimatedDebitPrincipalAfterReserve: 0,
      },
    },
    capacity: { available: true, status: 'live' },
  };
}

function projection() {
  return {
    available: true,
    status: 'preview',
    source: 'ibkr_live_session',
    accountId: 'U1',
    fromCache: false,
    observedAt: new Date().toISOString(),
    orderSubmitted: false,
    exposure: {
      longMarketValue: 121000,
      shortMarketValue: 41000,
      grossMarketValue: 162000,
      netMarketValue: 80000,
      longPercent: 60.5,
      shortPercent: 20.5,
      grossPercent: 81,
      netPercent: 40,
    },
    exact: { remainingRoom: 9000, trimRequired: 0 },
    buffered: { remainingRoom: 4000, trimRequired: 0 },
  };
}

function interestLedgerResponse() {
  const generatedAt = new Date().toISOString();
  return {
    source: 'ibkr_verified_interest_ledger',
    available: true,
    status: 'verified_history',
    accountId: 'U1',
    accountMatched: true,
    accountMasked: '••••U1',
    fromCache: false,
    generatedAt,
    summary: {
      source: 'ibkr_verified_interest_evidence_export',
      accountScoped: true,
      accountIdentifierIncluded: false,
      generatedAt,
      recovered: {
        immutableFlexRevisions: 1,
        tierDetailRows: 1,
        tierDetailDates: 1,
        tierDetailFrom: '2026-08-10',
        tierDetailThrough: '2026-08-10',
        dailyDebitActualDates: 1,
        dailyDebitActualFrom: '2026-08-10',
        dailyDebitActualThrough: '2026-08-10',
        liveMtdCheckpoints: 1,
        forecastRows: 1,
        matchedForecastRows: 0,
        cashPostings: 1,
      },
      formulaAudit: { rows: 1, exactToCentRows: 1, maxAbsoluteResidual: 0 },
      postedMarginInterestByPostingMonth: [{ month: '2026-08', net: -1.03 }],
      unavailableSections: {
        interestAccrualRows: 'not_returned_by_configured_flex_query',
        cashReportRows: 'not_returned_by_configured_flex_query',
        dailyStockBorrowFeeRows: 'not_returned_by_configured_flex_query',
      },
    },
    ledger: [{ date: '2026-08-10', flex_actual_debit_cost: 1.03, row_status: 'verified_evidence_present' }],
    observations: [{
      session_date: '2026-08-10',
      observed_at: generatedAt,
      live_mtd_net_accrued_signed: -84.97,
      live_mtd_cost_display: 84.97,
      source: 'ibkr_live_interest_observation',
    }],
    forecasts: [{
      value_date: '2026-08-10',
      accrual_days: 1,
      estimated_principal: 7194.79,
      point_forecast: 1.03,
      upper_forecast: 2.03,
      effective_annual_rate: 0.0513,
      comparison_status: 'awaiting_flex_actual',
      model_status: 'provisional',
    }],
    formulaAudit: [{
      value_date: '2026-08-10',
      interest_type: 'Debit Interest',
      principal: 7194.79,
      annual_rate_percent: 5.13,
      day_count: 360,
      formula_interest_absolute: 1.03,
      ibkr_interest_absolute: 1.03,
      residual_ibkr_minus_formula: 0,
    }],
    postings: [{
      posted_date: '2026-08-10',
      covered_month: '2026-07',
      category: 'margin_debit_interest',
      amount_signed: -1.03,
      currency: 'USD',
      transaction_type: 'Broker Interest Paid',
      description: 'USD DEBIT INT FOR JUL-2026',
    }],
  };
}

describe('PortfolioBalanceScenarioPlanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MarketDataService.getIbkrInterestValidationStatus.mockReturnValue(
      new Promise(() => {}),
    );
    MarketDataService.getIbkrInterestValidationLedger.mockReturnValue(
      new Promise(() => {}),
    );
    MarketDataService.previewPortfolioBalance.mockResolvedValue(projection());
    usePortfolioBalance.mockReturnValue({
      status: 'unavailable',
      snapshot: null,
      error: { message: 'IBKR is disconnected.' },
      loading: false,
      refreshing: false,
      refresh: jest.fn(),
    });
  });

  test('renders the selected Exposure Map design with live account values', () => {
    const snapshot = liveSnapshot();
    snapshot.exposure = {
      ...snapshot.exposure,
      longMarketValue: 171386,
      shortMarketValue: 31946,
      grossMarketValue: 203332,
      netMarketValue: 139440,
      longPercent: 95.8,
      shortPercent: 17.9,
      grossPercent: 113.7,
      netPercent: 78,
    };
    snapshot.cash = {
      ...snapshot.cash,
      securitiesCashFloor: 15361,
      noBorrowBalance: -17347,
      addLongRoom: 0,
      trimRequired: 17347,
      noBorrowLongLimit: 154039,
    };
    snapshot.buffer = {
      totalReserve: 3629,
      balance: -20976,
      addLongRoom: 0,
      trimRequired: 20976,
    };
    snapshot.interestExposure = {
      ...snapshot.interestExposure,
      current: {
        ...snapshot.interestExposure.current,
        effectiveDate: '2026-08-19',
        estimatedDebitPrincipal: 17221.56,
      },
      projected: {
        ...snapshot.interestExposure.projected,
        effectiveDate: '2026-08-20',
        securitiesCash: 15361,
        estimatedDebitPrincipal: 17347,
      },
      policy: {
        totalReserve: 3629,
        estimatedDebitPrincipalAfterReserve: 20976,
      },
    };
    snapshot.settlement = {
      ...snapshot.settlement,
      horizonDate: '2026-08-20',
      pending: true,
    };
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      executable: true,
      snapshot,
      error: null,
      loading: false,
      refreshing: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const exposure = screen.getByRole('region', { name: 'Exposure map' });
    expect(within(exposure).getByRole('heading', { name: 'Exposure Map' }))
      .toBeInTheDocument();
    expect(within(exposure).getByRole('meter', {
      name: 'Long exposure 95.8% of Net Liquidation Value, $171,386',
    })).toHaveAttribute('aria-valuenow', '95.8');
    expect(screen.getByText('No broker margin deficit')).toBeInTheDocument();
    expect(screen.getAllByText('$17,347').length).toBeGreaterThan(0);
    expect(screen.getByText('$20,976 estimated debit principal after reserve'))
      .toBeInTheDocument();
    expect(screen.getByText(/Policy reserve \$3,629 · not a margin call/))
      .toBeInTheDocument();
    expect(screen.getByText('Pending through Aug 20')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Interest' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+Long scenario' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '-Short scenario' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Long+Short scenario' })).toHaveTextContent('Combined');
    expect(screen.getByText(/Verified /)).toBeInTheDocument();
  });

  test('shows live account-matched MTD net interest with compact ledger provenance', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus());

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const interest = await screen.findByRole('region', { name: 'Interest' });
    expect(await within(interest).findByText('$102.32')).toBeInTheDocument();
    expect(within(interest).getByLabelText(
      /Net interest \$102.32, Net cost, IBKR as of/,
    ))
      .toBeInTheDocument();
    expect(MarketDataService.getIbkrInterestValidationStatus)
      .toHaveBeenCalledWith({ account: 'U1', refreshLive: true });
  });

  test('retains a fresh verified interest read and pauses polling while the panel is hidden', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      executable: true,
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus());

    const view = render(
      <PersistentSurface active>
        <PortfolioBalanceScenarioPlanner accountId="U1" />
      </PersistentSurface>,
    );
    expect(await screen.findByText(/Daily actual pending/i)).toBeInTheDocument();
    const calls = MarketDataService.getIbkrInterestValidationStatus.mock.calls.length;

    view.rerender(
      <PersistentSurface active={false}>
        <PortfolioBalanceScenarioPlanner accountId="U1" />
      </PersistentSurface>,
    );
    view.rerender(
      <PersistentSurface active>
        <PortfolioBalanceScenarioPlanner accountId="U1" />
      </PersistentSurface>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('$102.32')).toBeInTheDocument();
    expect(MarketDataService.getIbkrInterestValidationStatus).toHaveBeenCalledTimes(calls);
  });

  test('opens the verified interest ledger in a centered window and restores focus on close', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus());
    MarketDataService.getIbkrInterestValidationLedger.mockResolvedValue(interestLedgerResponse());

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);
    const openButton = screen.getByRole('button', { name: 'View ledger' });
    fireEvent.click(openButton);

    const ledger = await screen.findByRole('dialog', { name: 'IBKR Interest Ledger' });
    expect(ledger.parentElement).toHaveClass('dashboard-interest-ledger-host');
    expect(ledger).not.toHaveAttribute('data-placement');
    expect(await within(ledger).findByText('Rate math is fully reproduced.')).toBeInTheDocument();
    expect(MarketDataService.getIbkrInterestValidationLedger).toHaveBeenCalledWith({
      account: 'U1',
      signal: expect.any(AbortSignal),
    });

    fireEvent.click(within(ledger).getByRole('tab', { name: 'Daily ledger' }));
    expect(within(ledger).getByRole('table', { name: 'Daily ledger' })).toBeInTheDocument();
    expect(within(ledger).getByText('verified evidence present')).toBeInTheDocument();

    fireEvent.click(within(ledger).getByRole('tab', { name: 'Formula audit' }));
    expect(within(ledger).getByRole('table', { name: 'Formula audit' })).toBeInTheDocument();
    expect(within(ledger).getByText('Debit Interest')).toBeInTheDocument();

    fireEvent.click(within(ledger).getByRole('button', { name: 'Close interest ledger' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'IBKR Interest Ledger' }))
      .not.toBeInTheDocument());
    await waitFor(() => expect(openButton).toHaveFocus());
  });

  test('shows a pending state instead of zero when current-month rows are absent', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus({
      available: false,
      status: 'unavailable',
      mtd: {
        status: 'awaiting',
        verifiedDebit: null,
        actualDayCount: 0,
        throughDate: '2026-08-07',
      },
    }));

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const interest = await screen.findByRole('region', { name: 'Interest' });
    expect(await within(interest).findByText('$102.32')).toBeInTheDocument();
    await waitFor(() => expect(
      within(interest).getByLabelText(/Accrual estimate unavailable/),
    ).toHaveTextContent('Estimate—'));
    expect(within(interest).queryByText('$0.00')).not.toBeInTheDocument();
  });

  test('shows the verified posted aggregate and keeps daily fees unavailable without Flex detail rows', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    const latest = interestStatus().flex.latest;
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus({
      stockBorrowFees: {
        status: 'verified',
        daily: {
          status: 'awaiting',
          valueDate: null,
          amount: null,
          positionCount: 0,
          rowCount: 0,
          reason: 'flex_query_borrow_fee_details_not_configured',
        },
        aggregate: {
          status: 'verified',
          source: 'ibkr_flex_cash_transactions',
          total: 405.83,
          periodFrom: '2026-06-24',
          periodTo: '2026-08-07',
          throughDate: '2026-08-07',
          latestMonth: { month: '2026-07', amount: 405.83 },
          months: [{ month: '2026-07', amount: 405.83, transactionCount: 1 }],
          reason: null,
        },
        evidence: {
          source: 'ibkr_flex_interest_web_service',
          reportHash: latest.reportHash,
          revisionHash: latest.revisionHash,
          fetchedAt: latest.fetchedAt,
        },
      },
    }));

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const interest = await screen.findByRole('region', { name: 'Interest' });
    expect(await within(interest).findByText('$405.83')).toBeInTheDocument();
    expect(within(interest).getByLabelText(
      'Borrow fees $405.83 posted total, daily unavailable',
    )).toHaveTextContent('Borrow$405.83Daily —');
  });

  test('shows verified zero net MTD and keeps a Friday accrual block active all weekend', async () => {
    const now = new Date().toISOString();
    const snapshot = liveSnapshot();
    snapshot.cash.netAccruedInterest = 0;
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot,
      error: null,
      loading: false,
      refreshing: false,
    });
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus({
      mtd: {
        status: 'verified',
        verifiedDebit: 0,
        actualDayCount: 0,
        throughDate: '2026-08-07',
      },
      forecast: {
        status: 'issued',
        valueDate: '2026-08-14',
        principal: 15718.56,
        point: 2.24,
        upper: 2.8,
        accrualDays: 3,
        effectiveAnnualRate: 0.0513,
        issuedAt: now,
        activeForDate: '2026-08-16',
        coveredValueDates: ['2026-08-14', '2026-08-15', '2026-08-16'],
        coverageFrom: '2026-08-14',
        coverageThrough: '2026-08-16',
        basisSessionDate: '2026-08-14',
        cashAnchorDate: '2026-08-14',
        nextSessionDate: '2026-08-17',
        kind: 'completed_session_window',
        rateEvidence: {
          source: 'ibkr_official_margin_rates',
          url: 'https://www.interactivebrokers.com/en/trading/margin-rates.php',
          fetchedAt: now,
          scheduleHash: 'c'.repeat(64),
          provisional: true,
        },
      },
    }));

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const interest = await screen.findByRole('region', { name: 'Interest' });
    expect(await within(interest).findByText('$0.00')).toBeInTheDocument();
    expect(await within(interest).findByText('$2.24')).toBeInTheDocument();
    expect(within(interest).getByLabelText(
      /Accrual estimate \$2.24, forecast band \$1.68 to \$2.80, Aug 14–Aug 16, 3 days, 5.13% provisional, \$15,719 estimated principal/,
    )).toBeInTheDocument();
  });

  test('renders a verified zero forecast as a number instead of a dash', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
    });
    const now = new Date().toISOString();
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue(interestStatus({
      forecast: {
        status: 'issued',
        valueDate: '2026-08-16',
        principal: 0,
        point: 0,
        upper: 0,
        accrualDays: 1,
        effectiveAnnualRate: 0.0513,
        issuedAt: now,
        activeForDate: '2026-08-16',
        coveredValueDates: ['2026-08-16'],
        coverageFrom: '2026-08-16',
        coverageThrough: '2026-08-16',
        basisSessionDate: '2026-08-14',
        cashAnchorDate: '2026-08-16',
        nextSessionDate: '2026-08-17',
        kind: 'closed_day_remaining_window',
        rateEvidence: {
          source: 'ibkr_official_margin_rates',
          url: 'https://www.interactivebrokers.com/en/trading/margin-rates.php',
          fetchedAt: now,
          scheduleHash: 'c'.repeat(64),
          provisional: true,
        },
      },
    }));

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const interest = await screen.findByRole('region', { name: 'Interest' });
    expect(await within(interest).findByText('$0.00')).toBeInTheDocument();
    expect(within(interest).getByLabelText(
      /Accrual estimate \$0.00, forecast band \$0.00 to \$0.00, Aug 16, 1 day/,
    )).toBeInTheDocument();
  });

  test('hides retained MTD interest until a fresh live balance returns', () => {
    const snapshot = liveSnapshot();
    snapshot.cash.netAccruedInterest = 12.5;
    usePortfolioBalance.mockReturnValue({
      status: 'last_verified',
      executable: false,
      snapshot,
      lastVerifiedAt: snapshot.observedAt,
      error: { message: 'The sidecar is restarting.' },
      loading: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    expect(screen.queryByRole('region', { name: 'Interest' })).not.toBeInTheDocument();
    expect(screen.queryByText('$12.50')).not.toBeInTheDocument();
    expect(screen.getByText(/Last verified .* Reconnect to view current values/))
      .toBeInTheDocument();
  });

  test('isolates stale Flex evidence while rejecting stale, cached, mock, and seeded status payloads', () => {
    const stale = interestStatus({
      generatedAt: '2026-08-08T00:00:00.000Z',
      flex: {
        status: 'ready',
        latest: {
          fetchedAt: '2026-08-01T00:00:00.000Z',
          toDate: '2026-07-31',
          reportHash: 'a'.repeat(64),
          revisionHash: 'b'.repeat(64),
        },
      },
    });
    const now = Date.parse('2026-08-08T00:00:00.000Z');

    expect(normalizeVerifiedInterestStatus(stale, now)).toMatchObject({
      mtd: { status: 'awaiting', verifiedDebit: null },
      stockBorrowFees: { status: 'awaiting' },
    });
    expect(normalizeVerifiedInterestStatus({
      ...interestStatus(),
      generatedAt: '2026-08-07T00:00:00.000Z',
    }, now)).toBeNull();
    expect(normalizeVerifiedInterestStatus({ ...interestStatus(), fromCache: true })).toBeNull();
    expect(normalizeVerifiedInterestStatus({ ...interestStatus(), mock: true })).toBeNull();
    expect(normalizeVerifiedInterestStatus({ ...interestStatus(), seeded: true })).toBeNull();
  });

  test('accepts an immutable Friday forecast on Sunday after Flex and issuance exceed 36 hours', () => {
    const now = Date.parse('2026-08-16T23:00:00.000Z');
    const response = interestStatus({
      generatedAt: '2026-08-16T22:59:30.000Z',
      flex: {
        status: 'ready',
        latest: {
          fetchedAt: '2026-08-14T10:00:00.000Z',
          toDate: '2026-08-13',
          reportHash: 'a'.repeat(64),
          revisionHash: 'b'.repeat(64),
        },
      },
      forecast: {
        status: 'issued',
        valueDate: '2026-08-14',
        activeForDate: '2026-08-16',
        coveredValueDates: ['2026-08-14', '2026-08-15', '2026-08-16'],
        coverageFrom: '2026-08-14',
        coverageThrough: '2026-08-16',
        basisSessionDate: '2026-08-14',
        cashAnchorDate: '2026-08-14',
        nextSessionDate: '2026-08-17',
        kind: 'completed_session_window',
        principal: 15000,
        point: 6.41,
        upper: 8.02,
        accrualDays: 3,
        effectiveAnnualRate: 0.0513,
        issuedAt: '2026-08-14T20:30:00.000Z',
        rateEvidence: {
          source: 'ibkr_official_margin_rates',
          url: 'https://www.interactivebrokers.com/en/trading/margin-rates.php',
          scheduleHash: 'c'.repeat(64),
          provisional: true,
        },
      },
    });

    expect(normalizeVerifiedInterestStatus(response, now)).toMatchObject({
      mtd: { status: 'awaiting', verifiedDebit: null },
      forecast: {
        status: 'issued',
        point: 6.41,
        activeForDate: '2026-08-16',
        coverageThrough: '2026-08-16',
      },
    });
  });

  test('shows a stable no-live-data state without status pills or raw values', () => {
    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    expect(screen.getByText('Live IBKR exposure is unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+Long/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /-Short/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Long\+Short/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portfolio balance' })).not.toBeInTheDocument();
    expect(screen.queryByText('UNAVAILABLE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refresh portfolio balance/ })).not.toBeInTheDocument();
    expect(screen.queryByText('$120,000')).not.toBeInTheDocument();
  });

  test('keeps all current exposure numbers visible when capacity evidence is missing', () => {
    const snapshot = liveSnapshot();
    snapshot.cash = null;
    snapshot.buffer = null;
    snapshot.capacity = {
      available: false,
      status: 'unavailable',
      errorCode: 'SHORT_POSITION_EVIDENCE_MISSING',
      reason: 'short_position_evidence_missing',
    };
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot,
      error: null,
      loading: false,
      refreshing: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const exposure = screen.getByRole('region', { name: 'Exposure map' });
    expect(within(exposure).getByText('$120,000')).toBeInTheDocument();
    expect(within(exposure).getByText('$40,000')).toBeInTheDocument();
    expect(within(exposure).getByText('$160,000')).toBeInTheDocument();
    expect(within(exposure).getByText('$80,000')).toBeInTheDocument();
    expect(screen.getByText(/Interest exposure unavailable until IBKR provides complete position detail/))
      .toBeInTheDocument();
    expect(screen.queryByText(/short_position_evidence_missing/i)).not.toBeInTheDocument();
  });

  test('renders exposure plus separate broker margin and interest values', () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      executable: true,
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const exposure = screen.getByRole('region', { name: 'Exposure map' });
    expect(within(exposure).getByRole('meter', {
      name: 'Long exposure 60.0% of Net Liquidation Value, $120,000',
    })).toHaveAttribute('aria-valuenow', '60');
    const totalSummary = within(exposure).getByLabelText(
      'Total portfolio value $200,000, 100.0% of Net Liquidation Value',
    );
    expect(totalSummary).toHaveTextContent('Total Value(100.0%)$200,000');
    const totalHeading = within(totalSummary).getByRole('group', {
      name: 'Total Value 100.0%',
    });
    expect(totalHeading).toHaveClass(
      'portfolio-scenario-planner__exposure-summary-heading',
    );
    expect(within(totalHeading).getByText('(100.0%)')).toHaveClass('is-neutral');
    expect(within(totalHeading).queryByText('$200,000')).not.toBeInTheDocument();
    expect(within(totalSummary).getByText('$200,000')).toBeInTheDocument();

    const grossSummary = within(exposure).getByLabelText(
      'Gross exposure 80.0% of Net Liquidation Value, $160,000',
    );
    expect(grossSummary).toHaveTextContent('Gross(80.0%)$160,000');
    const grossHeading = within(grossSummary).getByRole('group', {
      name: 'Gross 80.0%',
    });
    expect(grossHeading).toHaveClass(
      'portfolio-scenario-planner__exposure-summary-heading',
    );
    expect(within(grossHeading).getByText('(80.0%)')).toHaveClass('is-accent');
    expect(within(grossHeading).queryByText('$160,000')).not.toBeInTheDocument();

    const netSummary = within(exposure).getByLabelText(
      'Net exposure 40.0% of Net Liquidation Value, $80,000',
    );
    expect(netSummary).toHaveTextContent('Net(40.0%)$80,000');
    expect(netSummary).toHaveClass('is-positive');
    const netHeading = within(netSummary).getByRole('group', {
      name: 'Net 40.0%',
    });
    expect(netHeading).toHaveClass(
      'portfolio-scenario-planner__exposure-summary-heading',
    );
    expect(within(netHeading).getByText('(40.0%)')).toHaveClass('is-positive');
    expect(within(netHeading).queryByText('$80,000')).not.toBeInTheDocument();
    expect(screen.getByText('No broker margin deficit')).toBeInTheDocument();
    expect(screen.getByText('Projected debit principal')).toBeInTheDocument();
    expect(screen.queryByText(/trim/i)).not.toBeInTheDocument();
  });

  test('colors negative net exposure red', () => {
    const snapshot = liveSnapshot();
    snapshot.exposure.netMarketValue = -80000;
    snapshot.exposure.netPercent = -40;
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      executable: true,
      snapshot,
      error: null,
      loading: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    const netExposure = within(screen.getByRole('region', { name: 'Exposure map' }))
      .getByLabelText('Net exposure -40.0% of Net Liquidation Value, -$80,000');
    expect(netExposure).toHaveClass('is-negative');
    expect(netExposure).not.toHaveClass('is-positive');
    expect(within(netExposure).getByText('(-40.0%)')).toHaveClass('is-negative');
  });

  test('fails closed on last-verified balance data and disables every scenario control', () => {
    const snapshot = liveSnapshot();
    usePortfolioBalance.mockReturnValue({
      status: 'last_verified',
      executable: false,
      snapshot,
      lastVerifiedAt: snapshot.observedAt,
      error: { message: 'The sidecar is restarting.' },
      loading: false,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    expect(screen.queryByText('$120,000')).not.toBeInTheDocument();
    expect(screen.getByText(/Last verified .* Reconnect to view current values/))
      .toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Exposure map' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+Long/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /-Short/ })).toBeDisabled();
    expect(MarketDataService.previewPortfolioBalance).not.toHaveBeenCalled();
  });

  test('does not disable scenario editing during a background balance refresh', () => {
    usePortfolioBalance.mockReturnValue({
      status: 'refreshing',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: true,
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+Long/ }));

    expect(within(screen.getByRole('region', { name: 'Exposure map' }))
      .getByText('$120,000')).toBeInTheDocument();
    expect(screen.getByLabelText(/Long ticker/)).toBeEnabled();
  });

  test('preserves expanded rows and unsaved inputs when a verified snapshot is replaced', () => {
    let currentSnapshot = liveSnapshot();
    usePortfolioBalance.mockImplementation(() => ({
      status: 'live',
      snapshot: currentSnapshot,
      error: null,
      loading: false,
      refreshing: false,
    }));

    const { rerender } = render(<PortfolioBalanceScenarioPlanner accountId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+Long/ }));
    fireEvent.change(screen.getByLabelText(/Long ticker/), { target: { value: 'SPY' } });

    const replacementSnapshot = liveSnapshot();
    currentSnapshot = {
      ...replacementSnapshot,
      snapshotId: 'snap-2',
      cash: {
        ...replacementSnapshot.cash,
        noBorrowBalance: 9100,
        addLongRoom: 9100,
      },
      interestExposure: {
        ...replacementSnapshot.interestExposure,
        projected: {
          ...replacementSnapshot.interestExposure.projected,
          estimatedDebitPrincipal: 900,
        },
        policy: {
          ...replacementSnapshot.interestExposure.policy,
          estimatedDebitPrincipalAfterReserve: 5900,
        },
      },
    };
    rerender(<PortfolioBalanceScenarioPlanner accountId="U1" />);

    expect(screen.getByLabelText(/Long ticker/)).toHaveValue('SPY');
    expect(screen.getByRole('button', { name: /\+Long/ })).toHaveTextContent('1 row');
    expect(screen.getAllByText('$900').length).toBeGreaterThan(0);
  });

  test('collects long and short legs and renders a read-only verified projection', async () => {
    usePortfolioBalance.mockReturnValue({
      status: 'live',
      snapshot: liveSnapshot(),
      error: null,
      loading: false,
      refreshing: false,
      refresh: jest.fn(),
    });

    render(<PortfolioBalanceScenarioPlanner accountId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+Long/ }));
    fireEvent.change(screen.getByLabelText(/Long ticker/), { target: { value: 'AAPL' } });
    fireEvent.change(screen.getByPlaceholderText('Size'), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: /-Short/ }));
    fireEvent.change(screen.getByLabelText(/Short ticker/), { target: { value: 'SPY' } });
    fireEvent.change(screen.getByPlaceholderText('Size'), { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: /Long\+Short/ }));
    await waitFor(() => expect(MarketDataService.previewPortfolioBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'U1',
        legs: expect.arrayContaining([
          expect.objectContaining({ action: 'buy_long', symbol: 'AAPL', quantity: 10 }),
          expect.objectContaining({ action: 'add_short', symbol: 'SPY', quantity: 5 }),
        ]),
      }),
    ));

    const planner = screen.getByTestId('portfolio-balance-planner');
    expect(within(planner).getByText(/No order submitted/)).toBeInTheDocument();
    expect(within(planner).getByText('$121,000')).toBeInTheDocument();
    const projected = within(planner).getByRole('region', { name: 'New exposure' });
    expect(within(projected).getByLabelText(
      '60.5% of Net Liquidation Value, $121,000',
    )).toHaveTextContent('(60.5% of NLV)$121,000');
  });
});
