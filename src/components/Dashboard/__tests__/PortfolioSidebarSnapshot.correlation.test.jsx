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

jest.mock('../portfolio/PortfolioBalanceCard', () => ({ accountId }) => (
  <section data-testid="portfolio-balance" data-account={accountId} />
));

const portfolioData = {
  dataSource: 'ibkr_api',
  liveSessionVerified: true,
  fromCache: false,
  socketVerifiedAt: new Date().toISOString(),
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

const VERIFIED_COMPARISON = {
  current: true,
  comparisonSafe: true,
  referenceOnly: false,
  dataAvailability: {
    structuralStatus: 'verified',
    canonicalSourceVerified: true,
    current: true,
    comparisonSafe: true,
    referenceOnly: false,
  },
};

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
  const view = render(sidebarElement(props));
  view.rerenderSidebar = (nextProps = {}) => {
    view.rerender(sidebarElement(nextProps));
  };
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

  test('keeps the comparison scaffold mounted while live portfolio data is loading', () => {
    renderSidebar({
      portfolioData: null,
      loading: true,
      rtaPositions: {
        ...VERIFIED_COMPARISON,
        available: true,
        comparisonAvailable: true,
        longCount: 4,
        shortCount: 3,
        dataQuality: { status: 'ok', warnings: [] },
      },
      etfProSnapshot: {
        ...VERIFIED_COMPARISON,
        available: true,
        comparisonAvailable: true,
        longCount: 24,
        shortCount: 13,
        rows: makeEtfProRows(24, 13),
        dataQuality: { status: 'ok', warnings: [] },
      },
    });

    const positionTable = screen.getByRole('table', {
      name: /portfolio versus rta and etf pro position comparison/i,
    });
    expect(screen.getByTestId('portfolio-refresh-state'))
      .toHaveTextContent('Syncing live IBKR');
    expect(screen.getByTestId('rta-long-count')).toHaveTextContent('4');
    expect(screen.getByTestId('etf-pro-long-count')).toHaveTextContent('24');
    expect(within(positionTable).getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('Gross Exposure')).not.toBeInTheDocument();
    expect(screen.getByTestId('portfolio-balance')).toBeInTheDocument();
  });

  test('labels and retains a current verified snapshot only while its refresh is pending', () => {
    const freshPortfolio = {
      ...portfolioData,
      accountId: 'U25779973',
      socketVerifiedAt: new Date().toISOString(),
    };
    const view = renderSidebar({
      portfolioData: freshPortfolio,
      refreshing: true,
    });

    expect(screen.getByTestId('portfolio-refresh-state'))
      .toHaveTextContent(/Refreshing · last verified as of/);
    expect(screen.getByText('Gross Exposure')).toBeInTheDocument();

    view.rerenderSidebar({
      portfolioData: {
        ...freshPortfolio,
        socketVerifiedAt: new Date(Date.now() - 61_000).toISOString(),
      },
      refreshing: true,
    });

    expect(screen.getByTestId('portfolio-refresh-state'))
      .toHaveTextContent('Syncing live IBKR');
    expect(screen.queryByText('Gross Exposure')).not.toBeInTheDocument();
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
        ...VERIFIED_COMPARISON,
        available: true,
        comparisonAvailable: true,
        longCount: 4,
        shortCount: 3,
        dataQuality: { status: 'ok', warnings: [] },
      },
      etfProSnapshot: {
        ...VERIFIED_COMPARISON,
        available: true,
        comparisonAvailable: true,
        longCount: 24,
        shortCount: 13,
        rows: makeEtfProRows(1, 1),
        dataQuality: { status: 'ok', warnings: [] },
      },
    });

    expect(screen.getByTestId('rta-long-count')).toHaveTextContent('4');
    expect(screen.getByTestId('rta-short-count')).toHaveTextContent('3');
    expect(screen.getByTestId('rta-net-percent')).toHaveTextContent('+14%');
    expect(screen.getByTestId('rta-net-bar').children).toHaveLength(3);
    expect(screen.getByTestId('etf-pro-long-count')).toHaveTextContent('24');
    expect(screen.getByTestId('etf-pro-short-count')).toHaveTextContent('13');
    expect(screen.getByTestId('etf-pro-net-percent')).toHaveTextContent('+30%');
    expect(screen.getByTestId('etf-pro-net-bar').children).toHaveLength(3);
  });

  test.each([
    ['stale cache', { _cache: { stale: true }, dataQuality: { status: 'ok' } }],
    ['failed comparison', { comparisonAvailable: false, dataQuality: { status: 'ok' } }],
    ['unavailable response', { available: false, dataQuality: { status: 'ok' } }],
    ['data-quality warning', { dataQuality: { status: 'warning' } }],
    ['missing safety metadata', {
      current: undefined,
      comparisonSafe: undefined,
      referenceOnly: undefined,
      dataAvailability: undefined,
      dataQuality: { status: 'ok' },
    }],
    ['inconsistent nested safety metadata', {
      dataAvailability: {
        ...VERIFIED_COMPARISON.dataAvailability,
        comparisonSafe: false,
      },
      dataQuality: { status: 'ok' },
    }],
    ['canonical-source reference', {
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        structuralStatus: 'unverified',
        canonicalSourceVerified: false,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
      },
      dataQuality: { status: 'ok' },
    }],
  ])('shows no RTA or ETF Pro comparison for a %s', (_label, invalidState) => {
    renderSidebar({
      rtaPositions: {
        ...VERIFIED_COMPARISON,
        available: true,
        comparisonAvailable: true,
        longCount: 1,
        shortCount: 22,
        ...invalidState,
      },
      etfProSnapshot: {
        ...VERIFIED_COMPARISON,
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

  test('uses SYS for status details without a duplicate portfolio status button', () => {
    renderSidebar({
      portfolioData: { ...portfolioData, accountId: 'U25779973' },
      interestValidationLoading: true,
      interestValidation: {
        available: true,
        status: 'learning',
        modelStatus: 'learning',
        source: 'ibkr_interest_validation',
        accountMatched: true,
        requestedAccount: 'U25779973',
        generatedAt: new Date().toISOString(),
        mtd: {
          verifiedDebit: 326.79,
          liveNetAccrued: -326.79,
        },
        latest: {
          point: 3.91,
          upper: 5.25,
          actual: 4.02,
          residual: 0.11,
        },
        calibration: {
          sampleCount: 7,
        },
        guard: {
          available: true,
          mode: 'graduated',
          appliedReserve: 331.04,
        },
      },
    });

    expect(screen.queryByTestId('interest-validation')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/show status details for ibkr/i)).not.toBeInTheDocument();
  });

  test('does not render a duplicate portfolio status control for invalid validation data', () => {
    renderSidebar({
      portfolioData: { ...portfolioData, accountId: 'U25779973' },
      interestValidation: {
        available: false,
        status: 'unavailable',
        source: 'ibkr_interest_validation',
        latest: {
          point: 999,
          upper: 999,
        },
        guard: {
          available: false,
          appliedReserve: null,
        },
      },
    });

    expect(screen.queryByTestId('interest-validation')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/show status details for ibkr/i)).not.toBeInTheDocument();
  });

  test('fails closed on exposure when direct market values are missing', () => {
    renderSidebar({
      portfolioData: {
        ...portfolioData,
        liveSessionVerified: true,
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

  test('does not expose ETF Pro warnings through a duplicate portfolio status button', () => {
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

    expect(screen.queryByLabelText(/show status details for ibkr/i)).not.toBeInTheDocument();
    expect(screen.queryByText('ETF Pro data quality: warning')).not.toBeInTheDocument();
  });

  test('does not expose cross-provider mismatches through a duplicate portfolio status button', () => {
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

    expect(screen.queryByLabelText(/show status details for ibkr/i)).not.toBeInTheDocument();
  });

  test('does not expose a green portfolio status button when providers are current', () => {
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

    expect(screen.queryByLabelText(/show status details for ibkr/i)).not.toBeInTheDocument();
  });
});

describe('PortfolioBreakdown correlation cleanup', () => {
  test('keeps construction focused on sizing and positions', () => {
    render(<PortfolioBreakdown portfolioData={portfolioData} />);

    expect(screen.queryByText('Correlation Concentration')).not.toBeInTheDocument();
    expect(screen.queryByText('Portfolio Construction')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Show research intelligence for GLD',
    })).toBeInTheDocument();
    expect(screen.getByText(/^LONG \(2\)$/)).toBeInTheDocument();
    expect(screen.getByText(/^SHORT \(0\)$/)).toBeInTheDocument();
    expect(screen.getByText('No short positions')).toBeInTheDocument();
    expect(screen.queryByText('Side:')).not.toBeInTheDocument();
  });
});
