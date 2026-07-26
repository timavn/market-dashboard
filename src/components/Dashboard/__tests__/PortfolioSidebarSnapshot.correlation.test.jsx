import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBreakdown from '../PortfolioBreakdown';
import PortfolioSidebarSnapshot from '../portfolio/PortfolioSidebarSnapshot';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getSecurityIntelligence: jest.fn(() => new Promise(() => {})),
    getSecurityRiskMetrics: jest.fn(() => new Promise(() => {})),
    getVolatilitySnapshot: jest.fn(() => new Promise(() => {})),
    getUsdCorrelations: jest.fn(() => new Promise(() => {})),
  },
}));

const portfolioData = {
  dataSource: 'ibkr_api',
  summary: {
    totalValue: 100000,
  },
  holdings: [
    { symbol: 'GLD', description: 'Gold', marketValue: 10000, quantity: 50, price: 200 },
    { symbol: 'NEM', description: 'Newmont Mining', marketValue: 8000, quantity: 120, price: 66 },
  ],
  accountSummary: {
    netLiquidation: 100000,
    totalCashValue: 5000,
    currency: 'USD',
  },
};

let fundingSequence = 0;

function makeFunding(overrides = {}) {
  const observedAt = new Date(Date.now() + fundingSequence).toISOString();
  fundingSequence += 1;
  const shortPositions = (overrides.shortPositions || [
    {
      conId: 756733,
      symbol: 'MACRO',
      quantity: -1000,
      priorClose: 100,
      currentPrice: 100,
      directBid: 100,
      directAsk: 100,
      directLast: 100,
      currentPriceSource: 'ibkr_ticker_direct_max',
      priorCloseSource: 'ibkr_live_tick_close',
      currency: 'USD',
      snapshotTimestamp: observedAt,
      marketDataType: 1,
    },
  ]).map((position) => ({
    directBid: position.currentPrice,
    directAsk: position.currentPrice,
    directLast: position.currentPrice,
    priorCloseSource: 'ibkr_live_tick_close',
    ...position,
  }));

  return {
    accountId: 'U25779973',
    status: 'live',
    source: 'ibkr_live_session',
    observedAt,
    socketVerifiedAt: observedAt,
    accountValuesObservedAt: observedAt,
    fromCache: false,
    currency: 'USD',
    baseCurrency: 'USD',
    positionScope: 'stocks_only',
    netLiquidation: 195000,
    totalCashValueSecurities: 115000,
    totalCashValueCommodities: 0,
    commodityMaintenanceMargin: 0,
    grossPositionValue: 295000,
    stockMarketValue: 95000,
    accruedCashSecurities: 0,
    settledCashByDateSecurities: {
      20260723: 115000,
      20260724: 114000,
    },
    settledCashByDateCommodities: {
      20260723: 0,
      20260724: 0,
    },
    accountReady: true,
    settledShortPositionsVerified: true,
    settlementStatus: 'settled',
    noSameDayExecutionsVerified: true,
    sameDayExecutionCount: 0,
    openOrderCount: 0,
    ...overrides,
    shortPositions,
    shortPositionCount: Object.prototype.hasOwnProperty.call(
      overrides,
      'shortPositionCount',
    )
      ? overrides.shortPositionCount
      : shortPositions.length,
  };
}

function makeFundingReference(overrides = {}) {
  const observedAt = new Date().toISOString();
  const reference = {
    schemaVersion: 1,
    referenceOnly: true,
    actionable: false,
    referenceKind:
      'completed_market_session_with_current_settlement_ladder',
    accountId: 'U25779973',
    status: 'reference',
    source: 'ibkr_completed_session_reference',
    observedAt,
    socketVerifiedAt: observedAt,
    accountValuesObservedAt: observedAt,
    fromCache: false,
    currency: 'USD',
    baseCurrency: 'USD',
    positionScope: 'stocks_only',
    netLiquidation: 195000,
    totalCashValueSecurities: 114000,
    totalCashValueCommodities: 0,
    commodityMaintenanceMargin: 0,
    grossPositionValue: 295000,
    stockMarketValue: 95000,
    accruedCashSecurities: 0,
    settledCashByDateSecurities:
      '20260725:115000;20260727:114000',
    settledCashByDateCommodities: '20260725:0;20260727:0',
    shortPositionReferences: [{
      conId: 756733,
      symbol: 'MACRO',
      quantity: -1000,
      referenceClose: 100,
      referenceCloseSource: 'ibkr_historical_daily_close',
      referenceCloseSessionDate: '2026-07-24',
      referenceCloseObservedAt: observedAt,
      currency: 'USD',
    }],
    shortStockReferenceCloseValue: 100000,
    accountReady: true,
    openPositionCount: 2,
    shortPositionCount: 1,
    openOrderCount: 0,
    executionCountObserved: 0,
    referenceSessionDate: '2026-07-24',
    cashLedgerObservedDate: '2026-07-25',
    settlementHorizonDate: '2026-07-27',
    settlementVerification: 'reference_segment_ladders_double_snapshot',
    ...overrides,
  };
  return reference;
}

function makeLiveFundingPortfolio(fundingOverrides = {}, portfolioOverrides = {}) {
  return {
    ...portfolioData,
    accountId: 'U25779973',
    liveSessionVerified: true,
    fromCache: false,
    funding: makeFunding(fundingOverrides),
    accountSummary: {
      ...portfolioData.accountSummary,
      netLiquidation: 195000,
      lastUpdated: new Date().toISOString(),
      source: 'ibkr_live_session',
    },
    ...portfolioOverrides,
  };
}

function makeFundingReferencePortfolio(
  referenceOverrides = {},
  portfolioOverrides = {},
) {
  return {
    ...makeLiveFundingPortfolio({}, {
      funding: null,
      fundingUnavailableReason: 'non_settlement_day',
    }),
    fundingReference: makeFundingReference(referenceOverrides),
    ...portfolioOverrides,
  };
}

function currentNyDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function currentLocalDate() {
  return new Date().toLocaleDateString('en-CA');
}

function makeHoldings(longCount, shortCount) {
  return [
    ...Array.from({ length: longCount }, (_, index) => ({
      symbol: `LONG${index}`,
      quantity: 1,
      marketValue: 1000 + index,
    })),
    ...Array.from({ length: shortCount }, (_, index) => ({
      symbol: `SHORT${index}`,
      quantity: -1,
      marketValue: -1000 - index,
    })),
  ];
}

function makeEtfProRows(longCount, shortCount) {
  return [
    ...Array.from({ length: longCount }, (_, index) => ({
      ticker: `EL${index}`,
      call: 'Long',
    })),
    ...Array.from({ length: shortCount }, (_, index) => ({
      ticker: `ES${index}`,
      call: 'Short',
    })),
  ];
}

function sidebarElement(componentProps = {}) {
  return (
    <PortfolioSidebarSnapshot
      portfolioData={portfolioData}
      portfolioAccountsData={[]}
      loading={false}
      rtaPositions={{ available: true, longCount: 0, shortCount: 0, dataQuality: { status: 'ok' } }}
      etfProSnapshot={{ available: false, rows: [], dataQuality: { status: 'ok' } }}
      hedgeyeChangelog={null}
      hedgeyeChangelogLoading={false}
      hedgeyeChangelogLastSuccessAt="2026-06-18T13:00:00Z"
      accounts={['U25779973']}
      connection={{ connected: true }}
      predictionMarketProviderStatus={{
        providers: {
          ibkr: {
            status: 'connected',
            gateway: { ok: true },
            contracts_total: 7,
          },
        },
      }}
      selectedAccount="U25779973"
      onAccountChange={jest.fn()}
      onRefresh={jest.fn()}
      {...componentProps}
    />
  );
}

function renderSidebar(props = {}) {
  const {
    autoLockEstimate = true,
    ...componentProps
  } = props;
  const view = render(sidebarElement(componentProps));
  view.rerenderSidebar = (nextProps = {}) => {
    view.rerender(sidebarElement(nextProps));
  };
  if (autoLockEstimate) {
    const lockButton = screen.queryByRole('button', {
      name: 'Lock one-use estimate',
    });
    if (lockButton) {
      fireEvent.click(lockButton);
    }
  }
  return view;
}

describe('PortfolioSidebarSnapshot correlation / exposure cleanup', () => {
  test('does not render the removed correlation / exposure card', () => {
    renderSidebar();
    const positionTable = screen.getByRole('table', {
      name: /portfolio versus rta and etf pro position comparison/i,
    });

    expect(screen.queryByText('Correlation / Exposure')).not.toBeInTheDocument();
    expect(screen.queryByText('Calculating correlation...')).not.toBeInTheDocument();
    expect(screen.getByText('Gross Exposure')).toBeInTheDocument();
    expect(within(positionTable).getByText('Portfolio')).toBeInTheDocument();
    expect(within(positionTable).getByText('RTA')).toBeInTheDocument();
  });

  test('ignores stale API summary counts and uses holdings-derived side counts', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        summary: {
          ...portfolioData.summary,
          longCount: 20,
          shortCount: 26,
        },
        holdings: [
          { symbol: 'DBMF', quantity: -200, marketValue: 12000 },
          { symbol: 'VFC', quantity: 400, marketValue: -8000 },
          { symbol: 'CLOSED', quantity: 0, marketValue: 0 },
        ],
      },
    });
    const positionTable = screen.getByRole('table', {
      name: /portfolio versus rta and etf pro position comparison/i,
    });

    expect(within(positionTable).queryByText('20')).not.toBeInTheDocument();
    expect(within(positionTable).queryByText('26')).not.toBeInTheDocument();
    expect(within(positionTable).getAllByText('1').length).toBeGreaterThanOrEqual(2);
  });

  test('renders RTA and ETF Pro counts and net bars only for clean current comparisons', () => {
    renderSidebar({
      rtaPositions: {
        available: true,
        comparisonAvailable: true,
        longCount: 1,
        shortCount: 22,
        dataQuality: { status: 'ok', warnings: [] },
      },
      etfProSnapshot: {
        available: true,
        comparisonAvailable: true,
        longCount: 21,
        shortCount: 13,
        rows: makeEtfProRows(1, 1),
        dataQuality: { status: 'ok', warnings: [] },
      },
    });

    expect(screen.getByTestId('rta-long-count')).toHaveTextContent('1');
    expect(screen.getByTestId('rta-short-count')).toHaveTextContent('22');
    expect(screen.getByTestId('rta-net-percent')).toHaveTextContent('-91%');
    expect(screen.getByTestId('rta-net-bar').children).toHaveLength(3);
    expect(screen.getByTestId('etf-pro-long-count')).toHaveTextContent('21');
    expect(screen.getByTestId('etf-pro-short-count')).toHaveTextContent('13');
    expect(screen.getByTestId('etf-pro-net-percent')).toHaveTextContent('+24%');
    expect(screen.getByTestId('etf-pro-net-bar').children).toHaveLength(3);
  });

  test.each([
    ['stale cache', { _cache: { stale: true }, dataQuality: { status: 'ok' } }],
    ['failed comparison', { comparisonAvailable: false, dataQuality: { status: 'ok' } }],
    ['unavailable response', { available: false, dataQuality: { status: 'ok' } }],
    ['data-quality warning', { dataQuality: { status: 'warning' } }],
  ])('shows no RTA or ETF Pro comparison for a %s', (_label, invalidState) => {
    renderSidebar({
      rtaPositions: {
        available: true,
        comparisonAvailable: true,
        longCount: 1,
        shortCount: 22,
        ...invalidState,
      },
      etfProSnapshot: {
        available: true,
        comparisonAvailable: true,
        longCount: 21,
        shortCount: 13,
        rows: makeEtfProRows(21, 13),
        ...invalidState,
      },
    });

    expect(screen.getByTestId('rta-long-count')).toHaveTextContent('—');
    expect(screen.getByTestId('rta-short-count')).toHaveTextContent('—');
    expect(screen.getByTestId('rta-net-percent')).toHaveTextContent('—');
    expect(screen.getByTestId('rta-net-bar').children).toHaveLength(0);
    expect(screen.getByTestId('rta-net-percent').parentElement).toHaveClass('pf-netbar-wrap--muted');

    expect(screen.getByTestId('etf-pro-long-count')).toHaveTextContent('—');
    expect(screen.getByTestId('etf-pro-short-count')).toHaveTextContent('—');
    expect(screen.getByTestId('etf-pro-net-percent')).toHaveTextContent('—');
    expect(screen.getByTestId('etf-pro-net-bar').children).toHaveLength(0);
    expect(screen.getByTestId('etf-pro-net-percent').parentElement).toHaveClass('pf-netbar-wrap--muted');
  });

  test('shows live dollar amounts and keeps 165% gross exposure within the 200% scale', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        holdings: [
          { symbol: 'LONGS', quantity: 1, marketValue: 109000 },
          { symbol: 'SHORTS', quantity: -1, marketValue: -56000 },
        ],
        accountSummary: {
          netLiquidation: 100000,
          totalCashValue: 48000,
          currency: 'USD',
        },
      },
      hedgeyeChangelogLastSuccessAt: '2026-06-18T13:00:00Z',
    });

    expect(screen.getByText('165%')).toBeInTheDocument();
    expect(screen.getByText('($165,000)')).toBeInTheDocument();
    expect(screen.getByText('53%')).toBeInTheDocument();
    expect(screen.getByText('(+53,000)')).toBeInTheDocument();
    expect(screen.getByText('48%')).toBeInTheDocument();
    expect(screen.getByText('($48,000)')).toBeInTheDocument();

    expect(screen.getByTestId('exposure-segment-gross-exposure')).toHaveStyle({
      left: '50%',
      width: '41.25%',
    });
  });

  test('shows guarded long capacity and broker-native exposure for a fresh verified funding snapshot', () => {
    renderSidebar({
      portfolioData: makeLiveFundingPortfolio({
        accruedCashSecurities: -750,
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'live');
    expect(within(guard).getByTestId('cash-debit-guard-hero')).toHaveTextContent(
      'BUFFERED MAX ESTIMATE $3,250 LONGS AFTER SETTLEMENT',
    );
    expect(within(guard).getByText('One use only')).toBeInTheDocument();
    expect(within(guard).getByText('Securities settled cash · Jul 24')).toBeInTheDocument();
    expect(within(guard).getByText('IBKR adjusted cash')).toBeInTheDocument();
    expect(within(guard).getByText('Policy buffer')).toBeInTheDocument();
    expect(within(guard).getByText('$2,000 base + $6,000 short shock')).toBeInTheDocument();
    expect(within(guard).getByText('Current long')).toBeInTheDocument();
    expect(within(guard).getByText('Short collateral')).toBeInTheDocument();
    expect(within(guard).getByText('Negative accrued cash')).toBeInTheDocument();
    expect(within(guard).getByText('-$750')).toBeInTheDocument();

    const grossBar = screen.getByRole('group', { name: 'Gross Exposure' });
    const netBar = screen.getByRole('group', { name: 'Net Exposure' });
    expect(within(grossBar).getByText('151%')).toBeInTheDocument();
    expect(within(grossBar).getByText('($295,000)')).toBeInTheDocument();
    expect(within(netBar).getByText('49%')).toBeInTheDocument();
    expect(within(netBar).getByText('(+95,000)')).toBeInTheDocument();
  });

  test('shows the exact post-settlement trim when guarded headroom is negative', () => {
    renderSidebar({
      portfolioData: makeLiveFundingPortfolio({
        totalCashValueSecurities: 99000,
        settledCashByDateSecurities: '20260723:99000;20260724:98000',
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(within(guard).getByTestId('cash-debit-guard-hero')).toHaveTextContent(
      'BUFFERED TRIM ESTIMATE $12,000 LONGS AFTER SETTLEMENT',
    );
    expect(within(guard).getByText(/Selling longs may not stop today/)).toBeInTheDocument();
  });

  test('hides actionable sizing until one snapshot is locked and consumed', () => {
    const onRefresh = jest.fn();
    renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio(),
      onRefresh,
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(within(guard).queryByTestId('cash-debit-guard-hero'))
      .not.toBeInTheDocument();
    fireEvent.click(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    }));

    expect(within(guard).getByTestId('cash-debit-guard-hero'))
      .toBeInTheDocument();
    expect(within(guard).getByText('One use only')).toBeInTheDocument();
    expect(within(guard).getByLabelText('Planned trade action')).toBeDisabled();

    fireEvent.click(within(guard).getByRole('button', {
      name: 'Refresh for another estimate',
    }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(within(guard).queryByTestId('cash-debit-guard-hero'))
      .not.toBeInTheDocument();
    expect(within(guard).getByText('Snapshot consumed')).toBeInTheDocument();
    expect(within(guard).queryByRole('button', {
      name: 'Lock one-use estimate',
    })).not.toBeInTheDocument();
  });

  test('synchronously hides a locked estimate when the live snapshot changes', () => {
    const view = renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio(),
    });
    const guard = screen.getByTestId('cash-debit-guard');
    fireEvent.click(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    }));
    expect(within(guard).getByTestId('cash-debit-guard-hero')).toBeInTheDocument();

    view.rerenderSidebar({
      portfolioData: makeLiveFundingPortfolio({
        totalCashValueSecurities: 110000,
        settledCashByDateSecurities: {
          20260723: 110000,
          20260724: 109000,
        },
      }),
    });

    expect(within(guard).queryByTestId('cash-debit-guard-hero'))
      .not.toBeInTheDocument();
    expect(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    })).toBeInTheDocument();
  });

  test('lets the user raise the adverse-short buffer before locking', () => {
    renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio(),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    fireEvent.change(
      within(guard).getByLabelText('Adverse short move buffer percent'),
      { target: { value: '20' } },
    );
    fireEvent.click(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    }));

    expect(within(guard).getByTestId('cash-debit-guard-hero')).toHaveTextContent(
      'BUFFERED TRIM ESTIMATE $11,000 LONGS AFTER SETTLEMENT',
    );
    expect(within(guard).getByText('$2,000 base + $21,000 short shock'))
      .toBeInTheDocument();
  });

  test.each([
    [
      'stale funding',
      () => {
        const staleAt = new Date(Date.now() - 61_000).toISOString();
        return {
          portfolioData: makeLiveFundingPortfolio({
            observedAt: staleAt,
            socketVerifiedAt: staleAt,
            accountValuesObservedAt: staleAt,
          }),
        };
      },
    ],
    [
      'offline portfolio',
      () => ({
        portfolioData: makeLiveFundingPortfolio({}, {
          dataSource: 'ibkr_offline',
          liveSessionVerified: false,
          funding: null,
        }),
        connection: { connected: false, kind: 'gateway_offline' },
      }),
    ],
    [
      'delayed provider status',
      () => ({
        portfolioData: makeLiveFundingPortfolio(),
        connection: {
          connected: true,
          statusRefreshDelayed: true,
        },
      }),
    ],
    [
      'account mismatch',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          accountId: 'U00000000',
        }),
      }),
    ],
    [
      'cached funding',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          fromCache: true,
        }),
      }),
    ],
    [
      'invalid funding decision',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          openOrderCount: 1,
        }),
      }),
    ],
    [
      'unverified settlement',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          settledShortPositionsVerified: undefined,
        }),
      }),
    ],
    [
      'unsettled securities activity',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          settlementStatus: 'pending',
        }),
      }),
    ],
    [
      'unverified same-day executions',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          noSameDayExecutionsVerified: undefined,
        }),
      }),
    ],
    [
      'same-day executions present',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          sameDayExecutionCount: 1,
        }),
      }),
    ],
    [
      'unverified short evidence',
      () => {
        const observedAt = new Date().toISOString();
        return {
          portfolioData: makeLiveFundingPortfolio({
            shortPositions: [{
              quantity: -1000,
              priorClose: 100,
              currentPrice: 100,
              currentPriceSource: 'ibkr_ticker_direct_max',
              currency: 'USD',
              snapshotTimestamp: observedAt,
              marketDataType: 3,
            }],
          }),
        };
      },
    ],
    [
      'unverified current-price source',
      () => {
        const observedAt = new Date().toISOString();
        return {
          portfolioData: makeLiveFundingPortfolio({
            shortPositions: [{
              quantity: -1000,
              priorClose: 100,
              currentPrice: 100,
              currentPriceSource: 'ibkr_ticker_market_price',
              currency: 'USD',
              snapshotTimestamp: observedAt,
              marketDataType: 1,
            }],
          }),
        };
      },
    ],
    [
      'unverified prior-close source',
      () => {
        const observedAt = new Date().toISOString();
        return {
          portfolioData: makeLiveFundingPortfolio({
            shortPositions: [{
              conId: 756733,
              symbol: 'MACRO',
              quantity: -1000,
              priorClose: 100,
              priorCloseSource: 'unknown',
              currentPrice: 100,
              currentPriceSource: 'ibkr_ticker_direct_max',
              currency: 'USD',
              snapshotTimestamp: observedAt,
              marketDataType: 1,
            }],
          }),
        };
      },
    ],
    [
      'short evidence count mismatch',
      () => ({
        portfolioData: makeLiveFundingPortfolio({
          shortPositionCount: 2,
        }),
      }),
    ],
    [
      'short exposure evidence mismatch',
      () => {
        const observedAt = new Date().toISOString();
        return {
          portfolioData: makeLiveFundingPortfolio({
            shortPositions: [{
              conId: 756733,
              symbol: 'MACRO',
              quantity: -900,
              priorClose: 100,
              currentPrice: 100,
              currentPriceSource: 'ibkr_ticker_direct_max',
              currency: 'USD',
              snapshotTimestamp: observedAt,
              marketDataType: 1,
            }],
          }),
        };
      },
    ],
  ])('fails closed without numeric guard output for %s', (_label, buildProps) => {
    renderSidebar(buildProps());

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'unavailable');
    expect(within(guard).getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(within(guard).queryByTestId('cash-debit-guard-hero')).not.toBeInTheDocument();
    expect(within(guard).queryByTestId('cash-debit-projection')).not.toBeInTheDocument();
  });

  test('clears the numeric guard while a fresh portfolio refresh is pending', () => {
    renderSidebar({
      portfolioData: makeLiveFundingPortfolio(),
      refreshing: true,
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'refreshing');
    expect(within(guard).getAllByText('Refreshing').length).toBeGreaterThan(0);
    expect(within(guard).queryByTestId('cash-debit-guard-hero')).not.toBeInTheDocument();
  });

  test('shows the sanitized unsettled reason when live funding is intentionally unavailable', () => {
    renderSidebar({
      portfolioData: makeLiveFundingPortfolio({}, {
        funding: null,
        fundingUnavailableReason: 'unsettled_securities_activity',
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'unavailable');
    expect(within(guard).getByText(
      'Unsettled securities activity prevents safe cash sizing.',
    )).toBeInTheDocument();
    expect(within(guard).queryByTestId('cash-debit-guard-hero')).not.toBeInTheDocument();
  });

  test('shows the non-settlement-day reason without numeric sizing', () => {
    renderSidebar({
      portfolioData: makeLiveFundingPortfolio({}, {
        funding: null,
        fundingUnavailableReason: 'non_settlement_day',
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'unavailable');
    expect(within(guard).getByText(
      'Cash sizing is unavailable outside a U.S. securities settlement day.',
    )).toBeInTheDocument();
    expect(within(guard).queryByTestId('cash-debit-guard-hero')).not.toBeInTheDocument();
  });

  test('shows a clearly labeled Friday-close reference with no trade controls', () => {
    renderSidebar({
      portfolioData: makeFundingReferencePortfolio(),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'reference');
    expect(within(guard).getByText('Historical · Fri, Jul 24'))
      .toBeInTheDocument();
    expect(within(guard).getByText('Historical only.'))
      .toBeInTheDocument();
    const hero = within(guard).getByTestId('cash-debit-guard-hero');
    expect(within(hero).getByText('Estimated long headroom'))
      .toBeInTheDocument();
    expect(within(hero).getByText('$4,000')).toBeInTheDocument();
    expect(within(hero).getByText(
      'Remaining after short collateral and safety reserves',
    )).toBeInTheDocument();
    expect(within(guard).getByText('Securities cash floor · Jul 27'))
      .toBeInTheDocument();
    expect(within(guard).getByText('Less: required short collateral'))
      .toBeInTheDocument();
    expect(within(guard).getByText('Less: 5% safety buffer'))
      .toBeInTheDocument();
    expect(within(guard).getByText(
      /IBKR cash Sat, Jul 25 · prices Fri, Jul 24 close · settlements included through Mon, Jul 27/,
    )).toBeInTheDocument();
    expect(within(guard).queryByLabelText('Planned trade action'))
      .not.toBeInTheDocument();
    expect(within(guard).queryByLabelText(
      'Adverse short move buffer percent',
    )).not.toBeInTheDocument();
    expect(within(guard).queryByRole('button')).not.toBeInTheDocument();
    expect(within(guard).queryByTestId('cash-debit-projection'))
      .not.toBeInTheDocument();
  });

  test('uses non-actionable trim wording for a negative Friday-close reference', () => {
    renderSidebar({
      portfolioData: makeFundingReferencePortfolio({
        totalCashValueSecurities: 98000,
        settledCashByDateSecurities:
          '20260725:99000;20260727:98000',
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    const hero = within(guard).getByTestId('cash-debit-guard-hero');
    expect(within(hero).getByText('Estimated long reduction'))
      .toBeInTheDocument();
    expect(within(hero).getByText('$12,000')).toBeInTheDocument();
    expect(within(hero).getByText(
      'Needed to restore the no-borrow cash buffer',
    )).toBeInTheDocument();
    expect(within(guard).queryByRole('button')).not.toBeInTheDocument();
  });

  test('shows the broker-derived Thursday close after a Friday holiday', () => {
    renderSidebar({
      portfolioData: makeFundingReferencePortfolio({
        grossPositionValue: 95000,
        stockMarketValue: 95000,
        settledCashByDateSecurities:
          '20260704:115000;20260706:114000',
        settledCashByDateCommodities:
          '20260704:0;20260706:0',
        shortPositionReferences: [],
        shortStockReferenceCloseValue: 0,
        openPositionCount: 1,
        shortPositionCount: 0,
        referenceSessionDate: '2026-07-02',
        cashLedgerObservedDate: '2026-07-04',
        settlementHorizonDate: '2026-07-06',
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'reference');
    expect(within(guard).getByText('Historical · Thu, Jul 2'))
      .toBeInTheDocument();
    expect(within(guard).getByText(
      /IBKR cash Sat, Jul 4 · prices Thu, Jul 2 close · settlements included through Mon, Jul 6/,
    )).toBeInTheDocument();
    expect(within(guard).queryByRole('button')).not.toBeInTheDocument();
    expect(within(guard).queryByLabelText('Planned trade action'))
      .not.toBeInTheDocument();
  });

  test('hides a malformed weekend reference instead of treating it as live', () => {
    const fundingReference = makeFundingReference();
    fundingReference.shortPositionReferences[0].currentPrice = 100;
    renderSidebar({
      portfolioData: makeFundingReferencePortfolio({}, {
        fundingReference,
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    expect(guard).toHaveAttribute('data-status', 'unavailable');
    expect(within(guard).queryByTestId('cash-debit-guard-hero'))
      .not.toBeInTheDocument();
    expect(within(guard).queryByRole('button')).not.toBeInTheDocument();
  });

  test('fails closed on exposure when direct market values are missing and funding is unavailable', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        liveSessionVerified: true,
        funding: null,
        holdings: [
          {
            symbol: 'UNMARKED',
            quantity: 100,
            marketValue: null,
            price: 50,
          },
        ],
        dataQuality: {
          status: 'partial',
          missingMarketValueCount: 1,
          missingMarketValueSymbols: ['UNMARKED'],
        },
      },
    });

    const grossBar = screen.getByRole('group', { name: 'Gross Exposure' });
    const longBar = screen.getByRole('group', { name: 'Long Exposure' });
    expect(within(grossBar).getByText('—')).toBeInTheDocument();
    expect(within(longBar).getByText('—')).toBeInTheDocument();
    expect(within(grossBar).queryByText(/\$/)).not.toBeInTheDocument();
    expect(within(longBar).queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('exposure-segment-gross-exposure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exposure-segment-long-exposure')).not.toBeInTheDocument();
  });

  test('projects adding to a verified low-priced short with a required limit and no editable broker evidence', () => {
    const observedAt = new Date().toISOString();
    renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio({
        grossPositionValue: 196010,
        stockMarketValue: 193990,
        shortPositions: [{
          conId: 10101,
          symbol: 'PENNY',
          quantity: -1000,
          priorClose: 1.01,
          currentPrice: 1.01,
          currentPriceSource: 'ibkr_ticker_direct_max',
          currency: 'USD',
          snapshotTimestamp: observedAt,
          marketDataType: 1,
        }],
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    fireEvent.change(within(guard).getByLabelText('Planned trade action'), {
      target: { value: 'add_short' },
    });
    expect(within(guard).getByRole('option', { name: 'Add to short' })).toBeInTheDocument();
    expect(within(guard).queryByLabelText('Planned short prior close')).not.toBeInTheDocument();
    expect(within(guard).queryByLabelText('Planned short price')).not.toBeInTheDocument();
    expect(within(guard).getByLabelText('Limit price')).toBeRequired();
    fireEvent.change(within(guard).getByLabelText('Verified short position'), {
      target: { value: '10101' },
    });
    fireEvent.change(within(guard).getByLabelText('Planned add-to-short shares'), {
      target: { value: '1000' },
    });
    expect(within(guard).queryByTestId('cash-debit-projection')).not.toBeInTheDocument();
    expect(within(guard).getByText('Enter a positive limit price.')).toBeInTheDocument();
    fireEvent.change(within(guard).getByLabelText('Limit price'), {
      target: { value: '1.02' },
    });
    expect(within(guard).queryByTestId('cash-debit-projection')).not.toBeInTheDocument();
    expect(within(guard).getByText(/must be at or below the verified live bid/i))
      .toBeInTheDocument();
    fireEvent.change(within(guard).getByLabelText('Limit price'), {
      target: { value: '1.01' },
    });
    fireEvent.click(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    }));

    const projection = within(guard).getByTestId('cash-debit-projection');
    expect(within(projection).getByText('+$109,010')).toBeInTheDocument();
    expect(within(projection).getByText(/\$197,020/)).toBeInTheDocument();
    expect(within(guard).queryByText(/short capacity/i)).not.toBeInTheDocument();
    expect(within(guard).getByText(/Stock-borrow fees/)).toBeInTheDocument();
    expect(within(guard).getByText(/only to a limit order at the entered price or better/i))
      .toBeInTheDocument();
    expect(within(guard).getByText(/submitted immediately against this live snapshot/i))
      .toBeInTheDocument();
    expect(within(guard).getByText(/market-order short sizing is unsupported/i))
      .toBeInTheDocument();
  });

  test('covers only the selected verified short and rejects excess shares', () => {
    renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio(),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    fireEvent.change(within(guard).getByLabelText('Planned trade action'), {
      target: { value: 'cover_short' },
    });
    expect(within(guard).queryByLabelText('Planned short prior close')).not.toBeInTheDocument();
    expect(within(guard).queryByLabelText('Planned short price')).not.toBeInTheDocument();
    expect(within(guard).getByLabelText('Limit price')).toBeRequired();
    fireEvent.change(within(guard).getByLabelText('Verified short position'), {
      target: { value: '756733' },
    });
    fireEvent.change(within(guard).getByLabelText('Planned cover shares'), {
      target: { value: '1001' },
    });
    fireEvent.change(within(guard).getByLabelText('Limit price'), {
      target: { value: '100' },
    });

    expect(within(guard).queryByTestId('cash-debit-projection')).not.toBeInTheDocument();
    expect(within(guard).getByText('Cover shares exceed that exact verified short.')).toBeInTheDocument();

    fireEvent.change(within(guard).getByLabelText('Planned cover shares'), {
      target: { value: '100' },
    });
    fireEvent.click(within(guard).getByRole('button', {
      name: 'Lock one-use estimate',
    }));

    const projection = within(guard).getByTestId('cash-debit-projection');
    expect(within(projection).getByText('+$4,800')).toBeInTheDocument();
    expect(within(projection).getByText(/\$285,000/)).toBeInTheDocument();
    expect(within(guard).getByLabelText('Planned cover shares')).toBeDisabled();
  });

  test('does not enable short sizing when baseline conId identity is missing', () => {
    const observedAt = new Date().toISOString();
    renderSidebar({
      autoLockEstimate: false,
      portfolioData: makeLiveFundingPortfolio({
        shortPositions: [{
          conId: null,
          symbol: 'NO-ID',
          quantity: -1000,
          priorClose: 100,
          currentPrice: 100,
          currentPriceSource: 'ibkr_ticker_direct_max',
          currency: 'USD',
          snapshotTimestamp: observedAt,
          marketDataType: 1,
        }],
      }),
    });

    const guard = screen.getByTestId('cash-debit-guard');
    fireEvent.change(within(guard).getByLabelText('Planned trade action'), {
      target: { value: 'add_short' },
    });

    expect(within(guard).getByLabelText('Verified short position')).toBeDisabled();
    expect(within(guard).getByText(
      'No uniquely identified live short is available for sizing.',
    )).toBeInTheDocument();
    expect(within(guard).queryByTestId('cash-debit-projection')).not.toBeInTheDocument();
  });

  test('keeps live Gateway exposure visible when Flex baseline is unavailable', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        holdings: [
          { symbol: 'LONGS', quantity: 1, marketValue: 109000 },
          { symbol: 'SHORTS', quantity: -1, marketValue: -56000 },
        ],
        accountSummary: {
          netLiquidation: 100000,
          totalCashValue: 48000,
          currency: 'USD',
        },
      },
      exposureReconciliation: {
        status: 'disabled',
        source: 'ibkr_flex_web_service',
        flex: null,
      },
    });

    expect(screen.getByText('165%')).toBeInTheDocument();
    expect(screen.getByText('Flex baseline')).toBeInTheDocument();
    expect(screen.getByText('Flex baseline disabled')).toBeInTheDocument();
    expect(screen.queryByText('Long funding gap')).not.toBeInTheDocument();
  });

  test('shows Flex funding gap as a reconciliation baseline, not live exposure', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        holdings: [
          { symbol: 'LIVE_LONG', quantity: 1, marketValue: 100000 },
          { symbol: 'LIVE_SHORT', quantity: -1, marketValue: -25000 },
        ],
        accountSummary: {
          netLiquidation: 100000,
          totalCashValue: 25000,
          currency: 'USD',
        },
      },
      exposureReconciliation: {
        status: 'ready',
        source: 'ibkr_flex_web_service',
        flex: {
          date: '2026-06-23',
          reportDate: '2026-06-23',
          accountId: 'U25779973',
          currency: 'USD',
          positionCount: 2,
          exposure: {
            hasData: true,
            nlv: 100000,
            longMV: 108000,
            shortMV: 25000,
            grossMV: 133000,
            netMV: 83000,
            cashValue: 10000,
            longPct: 108,
            shortPct: 25,
            grossPct: 133,
            netPct: 83,
            cashPct: 10,
            targetCashBuffer: 5000,
            equityCashSurplus: -8000,
            longFundingGap: 13000,
          },
        },
      },
    });

    expect(screen.getByText('Flex baseline')).toBeInTheDocument();
    expect(screen.getByText('Long funding gap')).toBeInTheDocument();
    expect(screen.getByText('$13,000')).toBeInTheDocument();
    expect(screen.getByText('Cash surplus after longs')).toBeInTheDocument();
    expect(screen.getByText('-$8,000')).toBeInTheDocument();
    expect(screen.getByText(/Live vs Flex differs:/)).toBeInTheDocument();
  });

  test('renders latest Hedgeye updates feed items', () => {
    const today = currentNyDate();
    renderSidebar({
      hedgeyeChangelog: {
        'real-time-alert': {
          currentDate: today,
          eventTime: `${today}T13:00:00Z`,
          alerts: [
            { ticker: 'ATZAF', action: 'BUY', signalPhrase: 'ATZAF added to Long' },
          ],
        },
        'risk-ranges': {
          currentDate: today,
          eventTime: `${today}T08:00:00Z`,
          trendChanges: [
            { ticker: 'NVDA', oldTrend: 'BULLISH', newTrend: 'NEUTRAL' },
          ],
        },
      },
    });

    expect(screen.getByText('FEED')).toBeInTheDocument();
    expect(screen.getByLabelText(/show status details for latest hedgeye updates/i)).toBeInTheDocument();
    expect(screen.getByText('ATZAF')).toBeInTheDocument();
    expect(screen.getByText('Added to')).toBeInTheDocument();
    expect(screen.getByText('LONG')).toBeInTheDocument();
    expect(screen.getByTestId('latest-update-source-ATZAF')).toHaveClass('pf-update__source');
    expect(screen.getByTestId('latest-update-source-ATZAF')).toHaveTextContent('Real Time Alerts');
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.getByText('BULLISH')).toBeInTheDocument();
    expect(screen.getByText('NEUTRAL')).toBeInTheDocument();
  });

  test('marks portfolio status yellow when ETF Pro has data-quality warnings', () => {
    const today = currentLocalDate();
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        accountSummary: {
          ...portfolioData.accountSummary,
          lastUpdated: new Date().toISOString(),
        },
      },
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 2,
        shortCount: 0,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [{ ticker: 'SJM', call: 'Long' }, { ticker: 'GLD', call: 'Long' }],
        dataQuality: {
          status: 'warning',
          warnings: ['ETF Pro Gmail ingestion is stale; latest stored ETF Pro email is 2026-06-18.'],
        },
      },
    });

    const ibkrStatusButton = screen.getByLabelText(/show status details for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟡');

    fireEvent.click(ibkrStatusButton);

    const sourceCards = screen.getAllByTestId(
      /^status-source-card-(portfolio|rta|etf-pro|prediction-markets)$/
    );
    expect(sourceCards).toHaveLength(4);
    expect(sourceCards.map((card) => within(card).getByRole('heading').textContent)).toEqual([
      'Portfolio',
      'RTA',
      'ETF Pro',
      'Prediction markets',
    ]);
    expect(screen.queryByTestId('status-source-card-ibkr')).not.toBeInTheDocument();
    expect(screen.queryByText('Connection')).not.toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();

    const portfolioCard = screen.getByTestId('status-source-card-portfolio');
    expect(portfolioCard).toHaveAttribute('data-status-tone', 'live');
    expect(within(portfolioCard).getAllByText('Live').length).toBeGreaterThan(0);

    const etfProCard = screen.getByTestId('status-source-card-etf-pro');
    expect(etfProCard).toHaveAttribute('data-status-tone', 'stale');
    expect(within(etfProCard).getByText('ETF Pro')).toBeInTheDocument();
    expect(within(etfProCard).getByText('Stale')).toBeInTheDocument();
    expect(screen.getAllByText('Portfolio').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ETF Pro').length).toBeGreaterThan(0);
    expect(screen.getByText('ETF Pro data quality: warning')).toBeInTheDocument();
    expect(screen.getByText('ETF Pro Gmail ingestion is stale; latest stored ETF Pro email is 2026-06-18.')).toBeInTheDocument();
  });

  test('marks portfolio status yellow for RTA, ETF Pro, and CPI provider mismatches', () => {
    const today = currentLocalDate();
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        holdings: makeHoldings(28, 25),
        accountSummary: {
          ...portfolioData.accountSummary,
          lastUpdated: new Date().toISOString(),
        },
      },
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 7,
        shortCount: 0,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: makeEtfProRows(20, 14),
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected_positions_only',
            message: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
            gateway: { ok: true },
          },
        },
      },
    });

    const ibkrStatusButton = screen.getByLabelText(/show status details for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟡');

    fireEvent.click(ibkrStatusButton);

    expect(screen.queryByTestId('status-source-card-ibkr')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-source-card-portfolio')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-rta')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-etf-pro')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-prediction-markets')).toHaveAttribute('data-status-tone', 'stale');
    expect(screen.queryByText('Portfolio differs')).not.toBeInTheDocument();
    expect(screen.queryByText(/RTA count mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ETF Pro count mismatch/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('status-source-card-prediction-markets')).getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('Prediction markets: IBKR connected; CPI positions loaded from portfolio, contract catalog missing')).toBeInTheDocument();
  });

  test('marks portfolio status green when portfolio, RTA, ETF Pro, and CPI contracts are current', () => {
    const today = currentLocalDate();
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        holdings: makeHoldings(2, 1),
        accountSummary: {
          ...portfolioData.accountSummary,
          lastUpdated: new Date().toISOString(),
        },
      },
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 2,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: makeEtfProRows(2, 1),
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected',
            gateway: { ok: true },
            contracts_total: 7,
          },
        },
      },
    });

    const ibkrStatusButton = screen.getByLabelText(/show status details for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟢');

    fireEvent.click(ibkrStatusButton);

    expect(screen.getAllByTestId(
      /^status-source-card-(portfolio|rta|etf-pro|prediction-markets)$/
    )).toHaveLength(4);
    expect(screen.queryByTestId('status-source-card-ibkr')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-source-card-portfolio')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-rta')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-etf-pro')).toHaveAttribute('data-status-tone', 'live');
    const predictionMarketsCard = screen.getByTestId('status-source-card-prediction-markets');
    expect(predictionMarketsCard).toHaveAttribute('data-status-tone', 'live');
    expect(within(predictionMarketsCard).getAllByText('Live').length).toBeGreaterThan(0);
  });
});

describe('PortfolioBreakdown correlation cleanup', () => {
  test('keeps construction focused on sizing and positions', () => {
    render(<PortfolioBreakdown portfolioData={portfolioData} />);

    expect(screen.queryByText('Correlation Concentration')).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio Construction')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByText('GLD')).toBeInTheDocument();
    expect(screen.getByText('Longs')).toBeInTheDocument();
    expect(screen.getByText('Shorts')).toBeInTheDocument();
    expect(screen.getByText('No short positions')).toBeInTheDocument();
    expect(screen.queryByText('Side:')).not.toBeInTheDocument();
  });
});
