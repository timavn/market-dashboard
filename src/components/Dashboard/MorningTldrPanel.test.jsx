import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import MorningTldrPanel from './MorningTldrPanel';
import { MarketDataService } from '../../services/api/marketDataService';
import PersistentSurface from '../common/PersistentSurface';

const mockUseMarketStructureReport = jest.fn();
const mockMarketStructureRefresh = jest.fn();

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getMorningTldrArchive: jest.fn(),
    getMorningTldrDay: jest.fn(),
    getMorningTldrStatus: jest.fn(),
    getIbkrInterestValidationStatus: jest.fn(),
  },
}));

jest.mock('../../hooks/useMarketStructureReport', () => ({
  useMarketStructureReport: (options) => mockUseMarketStructureReport(options),
}));

const productIds = ['top-3-things', 'risk-ranges', 'early-look', 'the-call', 'the-macro-show', 'signal-strength'];
const sectionIds = [...productIds, 'market-structure'];
const dates = [
  '2026-08-06', '2026-08-05', '2026-08-04', '2026-08-03', '2026-07-31',
  '2026-07-30', '2026-07-29', '2026-07-28', '2026-07-27', '2026-07-24',
];

const MARKET_STRUCTURE_CHART = 'a'.repeat(64);

const makeMarketStructure = (date) => ({
  date,
  publishedAt: `${date}T12:00:00.000Z`,
  snapshotType: 'market-structure',
  schemaVersion: 'market-structure-v3',
  contentComplete: true,
  article: { reportHeading: 'WEEKLY GAME PLAN' },
  data: {
    signals: [],
    charts: [{
      id: MARKET_STRUCTURE_CHART,
      contentUrl: `/api/hedgeye/market-structure/${date}/charts/${MARKET_STRUCTURE_CHART}`,
    }],
    blocks: [
      { id: 'copy', type: 'paragraph', text: `Exact-date Market Structure narrative for ${date}.` },
      { id: 'chart', type: 'chart', chartId: MARKET_STRUCTURE_CHART },
    ],
  },
});

const marketStructureReports = new Map();
const getMarketStructure = (date) => {
  if (!date) return null;
  if (!marketStructureReports.has(date)) {
    marketStructureReports.set(date, makeMarketStructure(date));
  }
  return marketStructureReports.get(date);
};

const makeDay = (date, { missing = [] } = {}) => {
  const snapshots = {
    'top-3-things': {
      date,
      data: {
        intro: 'Three source-listed priorities for the morning.',
        items: [
          { rank: 1, title: 'USD', body: 'The dollar is making fresh two-month lows.' },
          { rank: 2, title: 'Gold', body: 'Gold remains the clean inverse-dollar expression.' },
          { rank: 3, title: 'ATHs', body: 'RSP and IWM reached all-time highs.' },
        ],
      },
      article: { headline: 'Access Show, Slide Deck & Top 3 Things' },
    },
    'risk-ranges': {
      date,
      data: {
        AAPL: { lrr: 200, hrr: 220, trend: 'NEUTRAL', prevClose: 210 },
        VIX: { lrr: 14.74, hrr: 17.88, trend: 'BEARISH', prevClose: 16.2 },
        GOOGL: { lrr: 330, hrr: 390, trend: 'BEARISH', prevClose: 378 },
        MSFT: { lrr: 450, hrr: 541, trend: 'BULLISH', prevClose: 500 },
      },
    },
    'early-look': {
      date,
      data: {
        UST10Y: { lrr: 4.59, hrr: 4.74, trend: 'BULLISH', originalName: '10-Year U.S. Treasury Yield (UST10Y)' },
        HYG: { lrr: 78.95, hrr: 79.70, trend: 'BULLISH', originalName: 'High Yield (HYG)' },
        LQD: { lrr: 105.4, hrr: 107.1, trend: 'BEARISH', originalName: 'Investment Grade Corporate Bond ETF (LQD)' },
      },
      article: {
        keyTakeaways: [`Watch the dollar on ${date}.`],
        sections: {
          'The Big Picture': 'A Quad 3-1-2 setup is in view, with #Quad4 risk, a Quad 2 recovery marker, and Quad Count = 3-1-2.',
          'Tech Stocks': 'Grateful for another day of being able to move at all.\n\nOur Levels\n\n10-Year U.S. Treasury Yield (UST10Y) 4.59-4.74 (bullish)\nHigh Yield (HYG) 78.95-79.70 (bullish)\nInvestment Grade Corporate Bond ETF (LQD) 105.4-107.1 (bearish)\n\nBest of luck out there today,\n\nKM',
        },
        bodyText: 'The Big Picture\nA Quad 3-1-2 setup is in view, with #Quad4 risk, a Quad 2 recovery marker, and Quad Count = 3-1-2.\n\nBest of luck out there today,\n\nKM\n\n( VIEW LARGER IMAGE )\nPlease visit https://app.hedgeye.com/feed_items/185672 for more information.\n© 2026 Hedgeye Risk Management LLC, all rights reserved.',
      },
    },
    'the-call': {
      date,
      data: { longs: ['A'], shorts: ['B'], neutrals: ['N'] },
      article: {
        sections: {
          'Top 5 Most Actionable': "(Positioning based on Hedgeye's Macro Signals, sector analysis and Signal Strength)\n\nDraftKings, Inc. (DKNG) : Draft Kings detail.\n\nAirbnb, Inc. (ABNB) : Airbnb detail.\n\nThe RealReal, Inc. (REAL) : Real detail.\n\n10x Genomics, Inc. (TXG) : TXG detail.\n\nCloudflare, Inc. (NET) : NET detail.",
          'Macro Commentary': 'Macro commentary detail.',
          'Sector Summary': 'Restaurants: Analyst\n\nSweetgreen, Inc. (SG) : Sweetgreen detail.\n\nCAVA Group, Inc. (CAVA) : CAVA detail.\n\nConsumer Staples: Analyst\n\nMonster Beverage Corporation (MNST) : Monster detail.',
        },
        bodyText: 'Top 5 Most Actionable\nA remains actionable.',
      },
    },
    'the-macro-show': { date, data: { longs: ['A'], shorts: ['B'], neutrals: [] }, article: { summary: 'Dollar pressure remains central: a bearish dollar, bullish yields, and Quad 3 keep the macro frame in focus.' } },
    'signal-strength': {
      date,
      data: {
        added: ['A'],
        removed: ['B'],
        stocks: [
          { ticker: 'A', daysOn: 2, percentChangeSinceSignal: 1.5 },
          { ticker: 'C', daysOn: 8, percentChangeSinceSignal: -0.4 },
          { ticker: 'D', daysOn: 0, percentChangeSinceSignal: 0 },
        ],
      },
      meta: { stockCount: 3 },
    },
    // Stored short-list editions from the ended trial remain; the panel never shows them.
    'signal-strength-shorts': {
      date,
      snapshotType: 'signal-strength-shorts',
      stockCount: 1,
      data: {
        added: ['E'],
        removed: ['F'],
        membershipComplete: true,
        stocks: [{ ticker: 'E', side: 'short', daysOn: 3, totalReturn: 4.2 }],
      },
    },
  };
  const previousDate = '2026-08-05';
  const previousSnapshots = Object.fromEntries(productIds.map((id) => [id, {
    date: previousDate,
    data: id === 'risk-ranges'
      ? {
        GOOGL: { lrr: 331, hrr: 386, trend: 'BULLISH' },
        VIX: { lrr: 14.7, hrr: 18, trend: 'BEARISH' },
        MSFT: { lrr: 450, hrr: 541, trend: 'BULLISH' },
        TLT: { lrr: 100, hrr: 105, trend: 'NEUTRAL', prevClose: 98 },
      }
      : id === 'the-call' || id === 'the-macro-show'
        ? { longs: ['OLD'], shorts: [], neutrals: [] }
        : {},
  }]));
  missing.forEach((id) => { snapshots[id] = null; });
  return {
    date,
    snapshots,
    previousSnapshots,
    availableProducts: productIds.filter((id) => !missing.includes(id)),
    missingProducts: missing,
    historical: date !== '2026-08-06',
  };
};

const makeStatus = (date, {
  revision = 'revision-1',
  states = {},
} = {}) => ({
  schemaVersion: 1,
  date,
  generatedAt: `${date}T16:00:00.000Z`,
  contentRevision: revision,
  products: Object.fromEntries(productIds.map((id) => [id, {
    state: states[id] || 'saved',
    observedAt: `${date}T15:00:00.000Z`,
  }])),
});

describe('MorningTldrPanel', () => {
  beforeEach(() => {
    mockMarketStructureRefresh.mockReset();
    mockUseMarketStructureReport.mockReset();
    mockUseMarketStructureReport.mockImplementation(({ date }) => ({
      data: getMarketStructure(date),
      loading: false,
      refreshing: false,
      errorMessage: null,
      refresh: mockMarketStructureRefresh,
    }));
    MarketDataService.getMorningTldrArchive.mockResolvedValue({
      dates: dates.map((date) => ({ date, availableProducts: productIds, missingProducts: [] })),
      visibleDays: 10,
      retentionDays: 730,
      latestDate: dates[0],
    });
    MarketDataService.getMorningTldrDay.mockImplementation((date) => Promise.resolve(makeDay(date)));
    MarketDataService.getMorningTldrStatus.mockImplementation((date) => Promise.resolve(makeStatus(date)));
    MarketDataService.getIbkrInterestValidationStatus.mockReturnValue(
      new Promise(() => {}),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('renders ten saved date tabs and exact-date values without legacy tabs', async () => {
    render(<MorningTldrPanel />);

    expect((await screen.findAllByText('GOOGL')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('tab')).toHaveLength(10);
    expect(screen.getByRole('tab', { name: /August 6, 2026/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Morning TL;DR')).toBeInTheDocument();
    const contents = screen.getByRole('complementary', { name: 'TL;DR contents' });
    expect(within(contents).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '1Top 3 Things',
      '2Risk Ranges',
      '3Early Look',
      '4The Call',
      '5Macro Show',
      '6Signal Strength',
      '7Market Structure',
    ]);
    expect(screen.getAllByTestId(/^morning-tldr-section-/).map((section) => (
      section.dataset.sectionId
    ))).toEqual(sectionIds);
    expect(screen.getByTestId('morning-tldr-section-market-structure'))
      .toHaveTextContent('Exact-date Market Structure narrative for 2026-08-06.');
    expect(screen.getByText(/August 6, 2026 · 7 of 7 publications saved/i))
      .toBeInTheDocument();
    const topThree = screen.getByTestId('top-three-things-list');
    expect(within(topThree).getAllByRole('listitem')).toHaveLength(3);
    expect(within(topThree).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'USD', 'Gold', 'ATHs',
    ]);
    expect(screen.getAllByRole('button', { name: /The Call/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/What changed vs Aug 5, 2026/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Published levels for this date')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Prior close \(Aug 5, 2026\).*Actionable/i })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.queryByRole('heading', { name: /What changed since Aug 5, 2026/i })).not.toBeInTheDocument();
    expect(screen.queryByText('New risk ranges')).not.toBeInTheDocument();
    expect(screen.queryByText(/Added instruments/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Removed instruments/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Range changes \(lower \/ upper\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Trend changes$/)).not.toBeInTheDocument();
    const comparisonTable = screen.getByTestId('risk-comparison-table');
    expect(comparisonTable).toHaveClass('tldr-wiki-comparison-table');
    expect(within(comparisonTable).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Instrument', 'Trend', 'LRR', 'Prior close (Aug 5, 2026)Actionable ↓', 'HRR',
    ]);
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.queryByTestId('morning-tldr-section-signal-strength-shorts')).not.toBeInTheDocument();
    expect(screen.queryByText(/Signal Strength Shorts/)).not.toBeInTheDocument();
    const comparisonRows = screen.getAllByTestId(/^risk-comparison-row-/);
    expect(comparisonRows).toHaveLength(5);
    expect(comparisonRows[0]).toHaveAttribute('data-key', 'GOOGL');
    expect(comparisonRows[1]).toHaveAttribute('data-key', 'VIX');
    expect(comparisonRows[2]).toHaveAttribute('data-key', 'MSFT');
    expect(comparisonRows[3]).toHaveAttribute('data-key', 'AAPL');
    expect(comparisonRows[4]).toHaveAttribute('data-key', 'TLT');
    const trendRow = screen.getByTestId('risk-comparison-row-GOOGL');
    expect(within(trendRow).getByText('BULLISH')).toBeInTheDocument();
    expect(within(trendRow).getByText('BEARISH')).toBeInTheDocument();
    const trendRatio = within(trendRow).getByTestId('risk-reward-ratio-GOOGL');
    expect(trendRatio).toHaveTextContent('4 : 1');
    expect(trendRatio).toHaveAccessibleName('Downside to upside ratio 4 to 1');
    expect(trendRatio).not.toHaveTextContent('%');
    expect(within(trendRatio).getByText('4')).toHaveClass('tldr-wiki-risk-ratio__downside');
    expect(within(trendRatio).getByText(':')).toHaveClass('tldr-wiki-risk-ratio__separator');
    expect(within(trendRatio).getByText('1')).toHaveClass('tldr-wiki-risk-ratio__upside');
    const trendCells = within(trendRow).getAllByRole('cell');
    expect(trendCells[0]).toContainElement(trendRatio);
    expect(trendCells[2]).not.toContainElement(trendRatio);
    const shiftedClose = within(trendRow).getByTestId('risk-close-GOOGL');
    expect(shiftedClose).toHaveAttribute('data-range-position', '80.0');
    expect(shiftedClose).toHaveStyle('--tldr-risk-close-position: 80%');
    expect(within(shiftedClose).getByText('378')).toHaveAccessibleName(
      'Prior close 378, 80% through the published Risk Range',
    );
    const lrrFooter = within(trendRow).getByTestId('risk-level-footer-GOOGL-lrr');
    expect(lrrFooter).toHaveTextContent('-1-12.7%');
    expect(within(lrrFooter).getByText('-1')).toHaveClass('tldr-wiki-risk-level__delta');
    expect(within(lrrFooter).getByText('-12.7%')).toHaveClass('tldr-wiki-risk-level__percent');
    const hrrFooter = within(trendRow).getByTestId('risk-level-footer-GOOGL-hrr');
    expect(hrrFooter).toHaveTextContent('+4+3.2%');
    expect(within(hrrFooter).getByText('+4')).toHaveClass('tldr-wiki-risk-level__delta');
    expect(within(hrrFooter).getByText('+3.2%')).toHaveClass('tldr-wiki-risk-level__percent');
    const addedRow = screen.getByTestId('risk-comparison-row-AAPL');
    expect(addedRow).toHaveClass('tldr-wiki-comparison-row--added');
    expect(within(addedRow).getAllByText('NEW')).toHaveLength(2);
    expect(within(addedRow).getByText('210')).toBeInTheDocument();
    expect(within(addedRow).getByTestId('risk-reward-ratio-AAPL')).toHaveTextContent('1 : 1');
    expect(within(addedRow).getByTestId('risk-close-AAPL')).toHaveAttribute('data-range-position', '50.0');
    expect(within(addedRow).getByTestId('risk-level-footer-AAPL-lrr')).toHaveTextContent('NEW-4.8%');
    expect(within(addedRow).getByTestId('risk-level-footer-AAPL-hrr')).toHaveTextContent('NEW+4.8%');
    const unchangedRow = screen.getByTestId('risk-comparison-row-MSFT');
    expect(within(unchangedRow).getByText('BULLISH')).toBeInTheDocument();
    expect(within(unchangedRow).getByText('450', { selector: '.tldr-wiki-risk-level__value' })).toHaveClass('tldr-wiki-trend--positive');
    expect(within(unchangedRow).getByText('541', { selector: '.tldr-wiki-risk-level__value' })).toHaveClass('tldr-wiki-trend--positive');
    expect(within(unchangedRow).getAllByText('+0')).toHaveLength(2);
    const bearishRow = screen.getByTestId('risk-comparison-row-VIX');
    expect(within(bearishRow).getByText('14.74', { selector: '.tldr-wiki-risk-level__value' })).toHaveClass('tldr-wiki-trend--negative');
    expect(within(bearishRow).getByText('17.88', { selector: '.tldr-wiki-risk-level__value' })).toHaveClass('tldr-wiki-trend--negative');
    const removedRow = screen.getByTestId('risk-comparison-row-TLT');
    expect(removedRow).toHaveClass('tldr-wiki-comparison-row--removed');
    expect(within(removedRow).getAllByText('—')).toHaveLength(4);
    expect(within(removedRow).getByText('Prior 100')).toBeInTheDocument();
    expect(within(removedRow).getByText('Prior 105')).toBeInTheDocument();
    expect(within(removedRow).getByText('Prior 98')).toBeInTheDocument();
    expect(screen.queryByText(/Show all .* changed instruments/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('BEARISH').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BULLISH').length).toBeGreaterThan(0);
    expect(screen.getAllByText('NEUTRAL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BEARISH').some((node) => node.classList.contains('tldr-wiki-trend--negative'))).toBe(true);
    expect(screen.getAllByText('BULLISH').some((node) => node.classList.contains('tldr-wiki-trend--positive'))).toBe(true);
    expect(screen.getAllByText('NEUTRAL').some((node) => node.classList.contains('tldr-wiki-trend--neutral'))).toBe(true);
    expect(screen.queryByText('Range only')).not.toBeInTheDocument();
    expect(screen.getAllByText('1', { selector: '.tldr-quad-label--1' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('2', { selector: '.tldr-quad-label--2' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('3', { selector: '.tldr-quad-label--3' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('4', { selector: '.tldr-quad-label--4' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('QUAD', { selector: '.tldr-quad-word.tldr-quad-label--3' }).length).toBeGreaterThan(0);
    const earlyLevels = screen.getByTestId('early-look-levels');
    expect(within(earlyLevels).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '10-Year U.S. Treasury Yield (UST10Y) 4.59-4.74 (BULLISH)',
      'High Yield (HYG) 78.95-79.7 (BULLISH)',
      'Investment Grade Corporate Bond ETF (LQD) 105.4-107.1 (BEARISH)',
    ]);
    expect(screen.getAllByRole('heading', { name: 'Our Levels' })).toHaveLength(1);
    expect(screen.getAllByText(/10-Year U\.S\. Treasury Yield \(UST10Y\)/)).toHaveLength(1);
    expect(screen.getAllByText(/Best of luck out there today/)).toHaveLength(1);
    expect(screen.getByText(/Best of luck out there today/)).toBeInTheDocument();
    expect(screen.queryByText(/VIEW LARGER IMAGE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Please visit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/© 2026/)).not.toBeInTheDocument();
    expect(screen.queryByText('Positioning, actionable names, and sector notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Position mentions and the show summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Added and removed names from the latest edition')).not.toBeInTheDocument();
    expect(screen.queryByText("Position lists are the source publication's mentions, not an execution instruction.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Retrieved from the dashboard's saved Hedgeye email snapshots/)).not.toBeInTheDocument();
    expect(screen.queryByText('Event-driven feed')).not.toBeInTheDocument();
    expect(screen.queryByText('Overview')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved publication index')).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved editions, newest first/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing sources stay missing/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Saved today')).not.toBeInTheDocument();
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);
    const theCallSection = screen.getByTestId('morning-tldr-section-the-call');
    expect(within(theCallSection).getByText('Long', { selector: 'dt' })).toHaveClass('tldr-wiki-position-label--positive');
    expect(within(theCallSection).getByText('Short', { selector: 'dt' })).toHaveClass('tldr-wiki-position-label--negative');
    expect(within(theCallSection).getByText('Neutral', { selector: 'dt' })).toHaveClass('tldr-wiki-position-label--neutral');
    expect(within(theCallSection).getByText('A', { selector: '.tldr-wiki-position-list--positive' })).toBeInTheDocument();
    expect(within(theCallSection).getByText('B', { selector: '.tldr-wiki-position-list--negative' })).toBeInTheDocument();
    expect(within(theCallSection).getByText('N', { selector: '.tldr-wiki-position-list--neutral' })).toBeInTheDocument();
    expect(within(theCallSection).getByText('Added', { selector: 'dt' })).toHaveClass('tldr-wiki-position-label--positive');
    expect(within(theCallSection).getByText('Removed', { selector: 'dt' })).toHaveClass('tldr-wiki-position-label--negative');
    expect(screen.queryByText(/Added \/ entered|Removed \/ exited/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Morning Brief$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Changes$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Read$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Refresh$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Tools$/ })).not.toBeInTheDocument();
    const signalTable = screen.getByTestId('signal-strength-table');
    expect(within(signalTable).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Days On', 'Ticker', '% Change Since Signal',
    ]);
    expect(within(signalTable).getAllByRole('row')).toHaveLength(4);
    expect(within(signalTable).getByTestId('signal-strength-row-A')).toHaveTextContent('2A+1.5%');
    const signalRowA = within(signalTable).getByTestId('signal-strength-row-A');
    expect(within(signalRowA).getByRole('cell', { name: '+1.5%' })).toHaveClass('tldr-wiki-number--positive');
    const signalRowC = within(signalTable).getByTestId('signal-strength-row-C');
    expect(signalRowC).toHaveTextContent('8C-0.4%');
    expect(within(signalRowC).getByRole('cell', { name: '-0.4%' })).toHaveClass('tldr-wiki-number--negative');
    expect(within(signalTable).getByTestId('signal-strength-row-D')).toHaveTextContent('0D0.0%');
    expect(screen.queryByText('Entry Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Price')).not.toBeInTheDocument();
    expect(screen.queryByText('Analyst')).not.toBeInTheDocument();
    expect(screen.queryByText("Analyst's Best Idea Rank")).not.toBeInTheDocument();
    expect(screen.queryByText('Signal Date')).not.toBeInTheDocument();
    expect(screen.queryByText('Edition for this date')).not.toBeInTheDocument();
    expect(screen.queryByText(/The ingested publication contains explicit additions\/removals/)).not.toBeInTheDocument();
    expect(screen.queryByText('Publication note')).not.toBeInTheDocument();
  });

  test('cycles the prior-close ranking through actionable, upside, and downside views', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    const table = screen.getByTestId('risk-comparison-table');
    const rowKeys = () => within(table).getAllByTestId(/^risk-comparison-row-/).map((row) => row.dataset.key);
    const sortButton = within(table).getByRole('button', { name: /sorted by largest move/i });

    expect(rowKeys()).toEqual(['GOOGL', 'VIX', 'MSFT', 'AAPL', 'TLT']);
    fireEvent.click(sortButton);
    expect(sortButton).toHaveAccessibleName(/sorted by largest upside/i);
    expect(rowKeys()).toEqual(['VIX', 'MSFT', 'AAPL', 'GOOGL', 'TLT']);
    fireEvent.click(sortButton);
    expect(sortButton).toHaveAccessibleName(/sorted by largest downside/i);
    expect(rowKeys()).toEqual(['GOOGL', 'MSFT', 'VIX', 'AAPL', 'TLT']);
  });

  test('splits The Call security write-ups into readable paragraphs', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    const topFive = screen.getByTestId('tldr-top-five-security-blocks');
    expect(within(topFive).getAllByTestId(/^tldr-top-five-security-blocks-\d+$/).map((item) => item.textContent)).toEqual([
      'DraftKings, Inc. (DKNG) : Draft Kings detail.',
      'Airbnb, Inc. (ABNB) : Airbnb detail.',
      'The RealReal, Inc. (REAL) : Real detail.',
      '10x Genomics, Inc. (TXG) : TXG detail.',
      'Cloudflare, Inc. (NET) : NET detail.',
    ]);
    [
      'DraftKings, Inc. (DKNG)',
      'Airbnb, Inc. (ABNB)',
      'The RealReal, Inc. (REAL)',
      '10x Genomics, Inc. (TXG)',
      'Cloudflare, Inc. (NET)',
    ].forEach((name) => {
      expect(within(topFive).getByText(name, { selector: 'strong.tldr-wiki-security-name' })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Positioning based on Hedgeye's Macro Signals/)).not.toBeInTheDocument();

    const sectorSummary = screen.getByTestId('tldr-sector-security-blocks');
    expect(within(sectorSummary).getByText(/Sweetgreen, Inc\. \(SG\)/)).toBeInTheDocument();
    expect(within(sectorSummary).getByText(/CAVA Group, Inc\. \(CAVA\)/)).toBeInTheDocument();
    expect(within(sectorSummary).getByText(/Monster Beverage Corporation \(MNST\)/)).toBeInTheDocument();
    [
      'Sweetgreen, Inc. (SG)',
      'CAVA Group, Inc. (CAVA)',
      'Monster Beverage Corporation (MNST)',
    ].forEach((name) => {
      expect(within(sectorSummary).getByText(name, { selector: 'strong.tldr-wiki-security-name' })).toBeInTheDocument();
    });
  });

  test('finds, highlights, and navigates to a visible ticker without clearing the search', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    const input = screen.getByRole('searchbox', { name: 'Search TL;DR' });
    const ticker = within(screen.getByTestId('risk-comparison-row-GOOGL')).getByText('GOOGL');
    ticker.scrollIntoView = jest.fn();

    fireEvent.change(input, { target: { value: 'googl' } });

    await waitFor(() => expect(ticker).toHaveAttribute('data-tldr-search-match', 'true'));
    const results = screen.getByRole('listbox', { name: 'TL;DR search results' });
    const riskRangesGroup = within(results).getByRole('group', { name: 'Risk Ranges' });
    expect(within(riskRangesGroup).getAllByRole('option')).toHaveLength(1);
    expect(within(riskRangesGroup).getByRole('option')).toHaveTextContent('GOOGL');
    expect(results).not.toHaveTextContent(/\bmatches?\b/i);
    expect(screen.getByRole('button', { name: /Find TL;DR match/i })).toBeEnabled();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(ticker).toHaveAttribute('data-tldr-search-current', 'true');
    expect(ticker.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    expect(input).toHaveValue('googl');
    expect(screen.getByRole('listbox', { name: 'TL;DR search results' })).toBeVisible();
    expect(within(riskRangesGroup).getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  test('groups results by product and lists every mention separately', async () => {
    const day = makeDay('2026-08-06');
    day.snapshots['early-look'].article.keyTakeaways = ['CLOZ is on the Early Look radar.'];
    day.snapshots['the-macro-show'].article.summary = 'CLOZ opened the discussion. CLOZ remained in focus. CLOZ closed the discussion.';
    MarketDataService.getMorningTldrDay.mockResolvedValue(day);
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search TL;DR' }), { target: { value: 'cloz' } });

    const results = await screen.findByRole('listbox', { name: 'TL;DR search results' });
    const groups = within(results).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toEqual([
      'tldr-search-group-early-look',
      'tldr-search-group-the-macro-show',
    ]);
    expect(within(groups[0]).getByText('Early Look')).toBeInTheDocument();
    expect(within(groups[0]).getAllByRole('option')).toHaveLength(1);
    expect(within(groups[1]).getByText('Macro Show')).toBeInTheDocument();
    expect(within(groups[1]).getAllByRole('option')).toHaveLength(3);
    within(groups[1]).getAllByRole('option').forEach((mention) => {
      expect(within(mention).getAllByText(/CLOZ/i, { selector: 'mark' })).toHaveLength(1);
    });
    expect(results).not.toHaveTextContent(/\bmatches?\b/i);

    const macroMentions = within(groups[1]).getAllByRole('option');
    fireEvent.click(macroMentions[1]);
    expect(results).toBeVisible();
    expect(macroMentions[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(macroMentions[2]);
    expect(results).toBeVisible();
    expect(macroMentions[2]).toHaveAttribute('aria-selected', 'true');
  });

  test('includes Market Structure narrative in TL;DR search', async () => {
    render(<MorningTldrPanel />);
    await screen.findByText('Exact-date Market Structure narrative for 2026-08-06.');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search TL;DR' }), {
      target: { value: 'exact-date market structure' },
    });

    const results = await screen.findByRole('listbox', { name: 'TL;DR search results' });
    const group = within(results).getByRole('group', { name: 'Market Structure' });
    expect(within(group).getByRole('option')).toHaveTextContent(/Exact-date Market Structure/i);
  });

  test('tracks the contents highlight as the article scrolls', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    const root = screen.getByTestId('morning-tldr-article-scroll');
    const sections = screen.getAllByTestId(/^morning-tldr-section-/);
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, left: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
    });
    const tops = {
      'top-3-things': -600,
      'risk-ranges': 0,
      'early-look': 1400,
      'the-call': 200,
      'the-macro-show': 1800,
      'signal-strength': 2800,
      'market-structure': 3400,
    };
    sections.forEach((section) => {
      const top = tops[section.dataset.sectionId];
      Object.defineProperty(section, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top, left: 0, right: 1000, bottom: top + 600, width: 1000, height: 600 }),
      });
    });

    fireEvent.scroll(root);
    await waitFor(() => expect(screen.getByRole('button', { name: /The Call/i })).toHaveClass('is-active'));
  });

  test('selects the final contents item at the true bottom of the article', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    const root = screen.getByTestId('morning-tldr-article-scroll');
    const sections = screen.getAllByTestId(/^morning-tldr-section-/);
    Object.defineProperty(root, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, left: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
    });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 1000 });
    Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(root, 'scrollTop', { configurable: true, value: 4000 });
    const tops = {
      'top-3-things': 0,
      'risk-ranges': 0,
      'early-look': 120,
      'the-call': 180,
      'the-macro-show': 220,
      'signal-strength': 900,
      'market-structure': 1400,
    };
    sections.forEach((section) => {
      const top = tops[section.dataset.sectionId];
      Object.defineProperty(section, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top, left: 0, right: 1000, bottom: top + 600, width: 1000, height: 600 }),
      });
    });

    fireEvent.scroll(root);
    await waitFor(() => expect(screen.getByRole('button', { name: /Market Structure/i })).toHaveClass('is-active'));
  });

  test('loads the selected saved edition and scopes the reader to that date', async () => {
    render(<MorningTldrPanel />);
    await screen.findByText('Watch the dollar on 2026-08-06.');

    fireEvent.click(screen.getByRole('tab', { name: /August 5, 2026/i }));
    await waitFor(() => expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledWith('2026-08-05'));
    expect(await screen.findByText('Watch the dollar on 2026-08-05.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /August 5, 2026/i })).toHaveAttribute('aria-selected', 'true');
    expect(mockUseMarketStructureReport).toHaveBeenLastCalledWith(expect.objectContaining({
      active: true,
      date: '2026-08-05',
    }));
    expect(screen.getByText('Exact-date Market Structure narrative for 2026-08-05.'))
      .toBeInTheDocument();
    expect(screen.getByText(/August 5, 2026 · 7 of 7 publications saved/i)).toBeInTheDocument();
  });

  test('shows Market Structure missing without carrying another date forward', async () => {
    mockUseMarketStructureReport.mockImplementation(({ date }) => ({
      data: date === '2026-08-06' ? getMarketStructure(date) : null,
      loading: false,
      refreshing: false,
      errorMessage: date && date !== '2026-08-06'
        ? `No Market Structure report was published for ${date}.`
        : null,
      refresh: mockMarketStructureRefresh,
    }));
    render(<MorningTldrPanel />);
    await screen.findByText('Exact-date Market Structure narrative for 2026-08-06.');

    fireEvent.click(screen.getByRole('tab', { name: /August 5, 2026/i }));

    const section = await screen.findByTestId('morning-tldr-section-market-structure');
    await waitFor(() => expect(section).toHaveTextContent(
      'No complete dated market research report is available.',
    ));
    expect(section).toHaveTextContent('Not published');
    expect(section).not.toHaveTextContent('Market Structure status API unavailable');
    expect(section).not.toHaveTextContent('2026-08-06');
    expect(await screen.findByText(/August 5, 2026 · 6 of 7 publications saved/i))
      .toBeInTheDocument();
  });

  test('manual refresh preserves the selected date, search, and scroll position', async () => {
    render(<MorningTldrPanel />);
    await screen.findAllByText('GOOGL');

    fireEvent.click(screen.getByRole('tab', { name: /August 5, 2026/i }));
    await screen.findByText('Watch the dollar on 2026-08-05.');
    const articleScroll = screen.getByTestId('morning-tldr-article-scroll');
    Object.defineProperty(articleScroll, 'scrollTop', { configurable: true, writable: true, value: 420 });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search TL;DR' }), {
      target: { value: 'googl' },
    });

    fireEvent.click(screen.getByTitle('Refresh morning TL;DR'));
    await waitFor(() => expect(MarketDataService.getMorningTldrArchive).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus)
      .toHaveBeenCalledWith('2026-08-05', { force: true }));
    await waitFor(() => expect(screen.getByTitle('Refresh morning TL;DR')).not.toHaveAttribute('aria-busy'));
    expect(MarketDataService.getMorningTldrDay)
      .toHaveBeenLastCalledWith('2026-08-05', { force: true });
    expect(mockMarketStructureRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: /August 5, 2026/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search TL;DR' })).toHaveValue('googl');
    expect(articleScroll.scrollTop).toBe(420);
  });

  test('shows neutral current-day publication availability without pipeline warnings', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    MarketDataService.getMorningTldrDay.mockResolvedValue(makeDay('2026-08-06', {
      missing: ['top-3-things', 'the-call', 'the-macro-show'],
    }));
    MarketDataService.getMorningTldrStatus.mockResolvedValue(makeStatus('2026-08-06', {
      states: {
        'top-3-things': 'awaiting',
        'the-call': 'processing',
        'the-macro-show': 'failed',
        'signal-strength': 'saved_update_failed',
      },
    }));

    render(<MorningTldrPanel />);

    expect(await screen.findByText('No Top 3 Things edition is available yet')).toBeInTheDocument();
    expect(screen.getByText("Preparing today's Call")).toBeInTheDocument();
    expect(screen.getByText('No Macro Show edition is available yet')).toBeInTheDocument();
    expect(within(screen.getByTestId('morning-tldr-section-risk-ranges'))
      .getByText('Saved', { selector: '.tldr-wiki-status' })).toBeInTheDocument();
    expect(within(screen.getByTestId('morning-tldr-section-signal-strength'))
      .getByText('Saved', { selector: '.tldr-wiki-status' })).toBeInTheDocument();
    expect(screen.queryByText(/processing failed|update failed|status unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Last checked/i)).toBeInTheDocument();
  });

  test('keeps IBKR and API health messages out of the market-information view', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    MarketDataService.getMorningTldrStatus.mockRejectedValue(new Error('TLDR status API unavailable'));
    MarketDataService.getIbkrInterestValidationStatus.mockResolvedValue({
      source: 'ibkr_interest_validation',
      available: true,
      comparison: { status: 'verified', outcome: 'miss' },
    });
    mockUseMarketStructureReport.mockImplementation(({ date }) => ({
      data: getMarketStructure(date),
      loading: false,
      refreshing: false,
      errorMessage: 'Market Structure API unavailable',
      refresh: mockMarketStructureRefresh,
    }));

    render(<MorningTldrPanel />);

    await screen.findAllByText('GOOGL');
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalled());
    expect(MarketDataService.getIbkrInterestValidationStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId('morning-interest-audit')).not.toBeInTheDocument();
    expect(screen.queryByText(/TLDR status API unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Market Structure API unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/refresh delayed|interest model|IBKR MTD/i)).not.toBeInTheDocument();
  });

  test('updates a missing Macro Show automatically when the status revision changes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    const initialDay = makeDay('2026-08-06', { missing: ['the-macro-show'] });
    const updatedDay = makeDay('2026-08-06');
    MarketDataService.getMorningTldrDay
      .mockResolvedValueOnce(initialDay)
      .mockResolvedValue(updatedDay);
    MarketDataService.getMorningTldrStatus
      .mockResolvedValueOnce(makeStatus('2026-08-06', {
        revision: 'revision-before-macro',
        states: { 'the-macro-show': 'awaiting' },
      }))
      .mockResolvedValue(makeStatus('2026-08-06', { revision: 'revision-with-macro' }));

    render(<MorningTldrPanel />);
    expect(await screen.findByText('No Macro Show edition is available yet')).toBeInTheDocument();
    expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    expect(await screen.findByText(/Dollar pressure remains central/)).toBeInTheDocument();
    expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledTimes(2);
    expect(within(screen.getByTestId('morning-tldr-section-the-macro-show'))
      .getByText('Saved', { selector: '.tldr-wiki-status' })).toBeInTheDocument();
  });

  test('reloads Signal Strength when a second same-day edition replaces the first', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    const firstEdition = makeDay('2026-08-06');
    firstEdition.snapshots['signal-strength'].data = {
      added: ['FIRST'],
      removed: [],
      stocks: [{ ticker: 'FIRST', daysOn: 1, percentChangeSinceSignal: 0.5 }],
    };
    firstEdition.snapshots['signal-strength'].meta.stockCount = 1;
    const secondEdition = makeDay('2026-08-06');
    secondEdition.snapshots['signal-strength'].data = {
      added: ['SECOND'],
      removed: [],
      stocks: [{ ticker: 'SECOND', daysOn: 0, percentChangeSinceSignal: 0.1 }],
    };
    secondEdition.snapshots['signal-strength'].meta.stockCount = 1;
    MarketDataService.getMorningTldrDay
      .mockResolvedValueOnce(firstEdition)
      .mockResolvedValue(secondEdition);
    MarketDataService.getMorningTldrStatus
      .mockResolvedValueOnce(makeStatus('2026-08-06', { revision: 'signal-edition-1' }))
      .mockResolvedValue(makeStatus('2026-08-06', { revision: 'signal-edition-2' }));

    render(<MorningTldrPanel />);
    expect(await screen.findByTestId('signal-strength-row-FIRST')).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
    });

    expect(await screen.findByTestId('signal-strength-row-SECOND')).toBeInTheDocument();
    expect(screen.queryByTestId('signal-strength-row-FIRST')).not.toBeInTheDocument();
    expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(2);
  });

  test('pauses while inactive and checks on return only when the status interval is due', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    const { rerender } = render(
      <PersistentSurface active>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await screen.findAllByText('GOOGL');
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(1));

    rerender(
      <PersistentSurface active={false}>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await act(async () => {
      jest.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve();
    });
    expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledTimes(1);

    rerender(
      <PersistentSurface active>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(2));
    expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledTimes(1);
  });

  test('reopens within the status interval without an activation-only request', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    const { rerender } = render(
      <PersistentSurface active>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await screen.findAllByText('GOOGL');
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(1));

    rerender(
      <PersistentSurface active={false}>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await act(async () => {
      jest.advanceTimersByTime(30 * 1000);
      await Promise.resolve();
    });
    rerender(
      <PersistentSurface active>
        <MorningTldrPanel />
      </PersistentSurface>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getMorningTldrDay).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Dollar pressure remains central/)).toBeInTheDocument();
  });

  test('retains verified exact-date content without surfacing refresh failures', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T16:00:00.000Z'));
    MarketDataService.getMorningTldrDay
      .mockResolvedValueOnce(makeDay('2026-08-06'))
      .mockResolvedValueOnce(makeDay('2026-08-05'));

    render(<MorningTldrPanel />);
    expect(await screen.findByText(/Dollar pressure remains central/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Refresh morning TL;DR'));
    await waitFor(() => expect(MarketDataService.getMorningTldrStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle('Refresh morning TL;DR')).not.toHaveAttribute('aria-busy'));

    expect(screen.getByText(/Dollar pressure remains central/)).toBeInTheDocument();
    expect(within(screen.getByTestId('morning-tldr-section-the-macro-show'))
      .getByText('Saved', { selector: '.tldr-wiki-status' })).toBeInTheDocument();
    expect(screen.queryByText(/update failed|refresh delayed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Watch the dollar on 2026-08-05/)).not.toBeInTheDocument();
  });

  test('labels a missing product instead of carrying it forward', async () => {
    MarketDataService.getMorningTldrDay.mockResolvedValue(makeDay('2026-08-06', { missing: ['signal-strength'] }));
    render(<MorningTldrPanel />);
    expect((await screen.findAllByText('Not published')).length).toBeGreaterThan(0);
    expect(screen.getByText('No Signal Strength edition is available')).toBeInTheDocument();
  });

  test('does not render a partial Signal Strength membership list as a full table', async () => {
    const day = makeDay('2026-08-06');
    day.snapshots['signal-strength'].data.stocks = [{ ticker: 'A' }];
    day.snapshots['signal-strength'].meta.stockCount = 67;
    MarketDataService.getMorningTldrDay.mockResolvedValue(day);
    render(<MorningTldrPanel />);

    await screen.findAllByText('GOOGL');
    expect(screen.queryByTestId('signal-strength-table')).not.toBeInTheDocument();
    const signalSection = screen.getByTestId('morning-tldr-section-signal-strength');
    expect(within(signalSection).getByText('A', { selector: '.tldr-wiki-position-list--positive' })).toBeInTheDocument();
    expect(within(signalSection).getByText('B', { selector: '.tldr-wiki-position-list--negative' })).toBeInTheDocument();
  });

  test('shows current rows without marking them new when no prior range edition exists', async () => {
    const day = makeDay('2026-08-06');
    day.previousSnapshots['risk-ranges'] = null;
    MarketDataService.getMorningTldrDay.mockResolvedValue(day);
    render(<MorningTldrPanel />);

    expect(await screen.findByText(/No prior Risk Ranges edition is available/)).toBeInTheDocument();
    const comparisonRows = screen.getAllByTestId(/^risk-comparison-row-/);
    expect(comparisonRows).toHaveLength(4);
    comparisonRows.forEach((row) => expect(row).toHaveAttribute('data-state', 'uncompared'));
    expect(screen.queryByText('NEW')).not.toBeInTheDocument();
  });

  test('shows a missing current endpoint without an inferred delta', async () => {
    const day = makeDay('2026-08-06');
    day.snapshots['risk-ranges'].data.GOOGL.lrr = null;
    MarketDataService.getMorningTldrDay.mockResolvedValue(day);
    render(<MorningTldrPanel />);

    const row = await screen.findByTestId('risk-comparison-row-GOOGL');
    const lrrCell = within(row).getAllByRole('cell')[1];
    expect(lrrCell).toHaveTextContent('—');
    expect(lrrCell).not.toHaveTextContent(/[+-]\d/);
  });
});
