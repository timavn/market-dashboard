import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBreakdown from '../PortfolioBreakdown';
import PortfolioSidebarSnapshot from '../portfolio/PortfolioSidebarSnapshot';

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

function renderSidebar(props = {}) {
  return render(
    <PortfolioSidebarSnapshot
      portfolioData={portfolioData}
      portfolioAccountsData={[]}
      loading={false}
      rtaPositions={{ available: true, longCount: 0, shortCount: 0 }}
      etfProSnapshot={{ rows: [] }}
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
      {...props}
    />,
  );
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
    expect(screen.getByLabelText(/show last updated time for latest hedgeye updates/i)).toBeInTheDocument();
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

    const ibkrStatusButton = screen.getByLabelText(/show last updated time for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟡');

    fireEvent.click(ibkrStatusButton);

    const sourceCards = screen.getAllByTestId(/status-source-card-/);
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
    expect(etfProCard).toHaveAttribute('data-status-tone', 'error');
    expect(within(etfProCard).getByText('ETF Pro')).toBeInTheDocument();
    expect(within(etfProCard).getByText('Error')).toBeInTheDocument();
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

    const ibkrStatusButton = screen.getByLabelText(/show last updated time for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟡');

    fireEvent.click(ibkrStatusButton);

    expect(screen.queryByTestId('status-source-card-ibkr')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-source-card-portfolio')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-rta')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-etf-pro')).toHaveAttribute('data-status-tone', 'live');
    expect(screen.getByTestId('status-source-card-prediction-markets')).toHaveAttribute('data-status-tone', 'error');
    expect(screen.queryByText('Portfolio differs')).not.toBeInTheDocument();
    expect(screen.queryByText(/RTA count mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ETF Pro count mismatch/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('status-source-card-prediction-markets')).getByText('Error')).toBeInTheDocument();
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

    const ibkrStatusButton = screen.getByLabelText(/show last updated time for ibkr/i);
    expect(ibkrStatusButton).toHaveTextContent('🟢');

    fireEvent.click(ibkrStatusButton);

    expect(screen.getAllByTestId(/status-source-card-/)).toHaveLength(4);
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
    expect(screen.getByText('Portfolio Construction')).toBeInTheDocument();
    expect(screen.getByText('GLD')).toBeInTheDocument();
    expect(screen.getByText('Longs')).toBeInTheDocument();
    expect(screen.getByText('Shorts')).toBeInTheDocument();
    expect(screen.getByText('No short positions')).toBeInTheDocument();
    expect(screen.queryByText('Side:')).not.toBeInTheDocument();
  });
});
