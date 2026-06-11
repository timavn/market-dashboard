import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioBreakdown from '../PortfolioBreakdown';
import PortfolioSidebarSnapshot from '../portfolio/PortfolioSidebarSnapshot';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getPortfolioCorrelationConcentration: jest.fn(),
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

const concentrationResponse = {
  scores: {
    concentrationScore: 42,
    effectiveIndependentBets: 2.4,
    largestClusterPct: 18,
    grossPct: 18,
    netPct: 18,
  },
  coverage: {
    scoredPct: 18,
    scoredCount: 2,
    unscoredCount: 1,
    cashPct: 5,
  },
  clusters: [
    {
      id: 'GLD-NEM',
      label: 'Gold',
      memberCount: 2,
      grossClusterPct: 18,
      netClusterPct: 18,
      longPct: 18,
      shortPct: 0,
      correlationAdjustedGrossPct: 17.8,
      topDriver: 'GLD',
      members: [
        { symbol: 'GLD', label: 'Gold', labelSource: 'expected-value' },
        { symbol: 'NEM', label: 'Gold', labelSource: 'correlated-anchor' },
      ],
    },
  ],
  pairwise: [
    { symbols: ['GLD', 'NEM'], correlation: 0.83, weightedImpact: 80 },
  ],
  unscored: [
    { symbol: 'OPT', reason: 'Options are unscored in v1' },
  ],
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSidebar(props = {}) {
  return render(
    <PortfolioSidebarSnapshot
      portfolioData={portfolioData}
      portfolioAccountsData={[]}
      loading={false}
      rtaPositions={{ available: true, longCount: 0, shortCount: 0 }}
      etfProSnapshot={{ rows: [] }}
      accounts={['U25779973']}
      connection={{ connected: true }}
      selectedAccount="U25779973"
      onAccountChange={jest.fn()}
      onRefresh={jest.fn()}
      {...props}
    />,
  );
}

describe('PortfolioSidebarSnapshot correlation / exposure lens', () => {
  beforeEach(() => {
    MarketDataService.getPortfolioCorrelationConcentration.mockReset();
  });

  test('renders first-load loading state', () => {
    const initial = createDeferred();
    MarketDataService.getPortfolioCorrelationConcentration.mockReturnValue(initial.promise);

    renderSidebar();

    expect(screen.getByText('Correlation / Exposure')).toBeInTheDocument();
    expect(screen.getByText('Calculating correlation...')).toBeInTheDocument();
  });

  test('renders populated concentration data', async () => {
    MarketDataService.getPortfolioCorrelationConcentration.mockResolvedValue(concentrationResponse);

    renderSidebar();

    expect((await screen.findAllByText('Gold')).length).toBeGreaterThan(0);
    expect(screen.getByText('2.4')).toBeInTheDocument();
    expect(screen.getAllByText('Long-biased').length).toBeGreaterThan(0);
    expect(screen.getByText('GLD')).toBeInTheDocument();
    expect(screen.getByText('NEM')).toBeInTheDocument();
    expect(screen.getByText('Cash 5%')).toBeInTheDocument();
    expect(screen.getByText('Unscored 1')).toBeInTheDocument();
    expect(screen.getByText('OPT')).toBeInTheDocument();
  });

  test('renders endpoint errors instead of a blank panel', async () => {
    MarketDataService.getPortfolioCorrelationConcentration.mockRejectedValue(new Error('Correlation failed'));

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByText('Correlation failed')).toBeInTheDocument();
    });
  });

  test('does not refetch when an equivalent portfolio poll changes object identity', async () => {
    MarketDataService.getPortfolioCorrelationConcentration.mockResolvedValue(concentrationResponse);

    const { rerender } = renderSidebar();
    expect((await screen.findAllByText('Gold')).length).toBeGreaterThan(0);
    expect(MarketDataService.getPortfolioCorrelationConcentration).toHaveBeenCalledTimes(1);

    rerender(
      <PortfolioSidebarSnapshot
        portfolioData={{
          ...portfolioData,
          holdings: [
            { ...portfolioData.holdings[0], marketValue: 10020 },
            { ...portfolioData.holdings[1], marketValue: 8010 },
          ],
        }}
        portfolioAccountsData={[]}
        loading={false}
        rtaPositions={{ available: true, longCount: 0, shortCount: 0 }}
        etfProSnapshot={{ rows: [] }}
        accounts={['U25779973']}
        connection={{ connected: true }}
        selectedAccount="U25779973"
        onAccountChange={jest.fn()}
        onRefresh={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(MarketDataService.getPortfolioCorrelationConcentration).toHaveBeenCalledTimes(1);
    });
  });

  test('keeps stale data visible while a manual refresh is loading', async () => {
    const refresh = createDeferred();
    MarketDataService.getPortfolioCorrelationConcentration
      .mockResolvedValueOnce(concentrationResponse)
      .mockReturnValueOnce(refresh.promise);

    renderSidebar();
    expect((await screen.findAllByText('Gold')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));

    expect(MarketDataService.getPortfolioCorrelationConcentration).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getPortfolioCorrelationConcentration.mock.calls[1][0].forceRefresh).toBe(true);
    expect(screen.getAllByText('Gold').length).toBeGreaterThan(0);
    expect(screen.getByText('Updating...')).toBeInTheDocument();

    refresh.resolve({
      ...concentrationResponse,
      scores: { ...concentrationResponse.scores, effectiveIndependentBets: 3.1 },
    });

    await waitFor(() => {
      expect(screen.queryByText('Updating...')).not.toBeInTheDocument();
    });
    expect(screen.getByText('3.1')).toBeInTheDocument();
  });

  test('keeps stale data visible when refresh errors after a prior success', async () => {
    MarketDataService.getPortfolioCorrelationConcentration
      .mockResolvedValueOnce(concentrationResponse)
      .mockRejectedValueOnce(new Error('Correlation failed'));

    renderSidebar();
    expect((await screen.findAllByText('Gold')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Showing previous snapshot/)).toBeInTheDocument();
    });
    expect(screen.getAllByText('Gold').length).toBeGreaterThan(0);
  });
});

describe('PortfolioBreakdown correlation cleanup', () => {
  test('keeps construction focused on sizing and positions', () => {
    render(<PortfolioBreakdown portfolioData={portfolioData} />);

    expect(screen.queryByText('Correlation Concentration')).not.toBeInTheDocument();
    expect(screen.getByText('Position Sizes')).toBeInTheDocument();
    expect(screen.getByText('GLD')).toBeInTheDocument();
    expect(screen.getAllByText('Longs').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Shorts').length).toBeGreaterThan(1);
    expect(screen.getByText('No short positions')).toBeInTheDocument();
    expect(screen.queryByText('Side:')).not.toBeInTheDocument();
  });
});
