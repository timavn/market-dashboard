import React, { act } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import rotationCatalog from '../../constants/marketRotationCatalog.json';
import useMarketDailyResearch from '../../hooks/useMarketDailyResearch';
import useMarketDailySnapshot from '../../hooks/useMarketDailySnapshot';
import { mergeMarketRotationSnapshots, retainMarketRotationSnapshot } from '../../utils/marketRotationReference.cjs';
import { mergeMarketDailyReference } from '../../utils/marketDailyReference.cjs';
import MarketPulseRibbon, { usableDailySnapshot } from './MarketPulseRibbon';

jest.mock('../../hooks/useMarketDailySnapshot', () => ({ ...jest.requireActual('../../hooks/useMarketDailySnapshot'), __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useMarketDailyResearch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useMarketRotationSnapshot', () => ({
  ...jest.requireActual('../../hooks/useMarketRotationSnapshot'),
  __esModule: true,
  default: () => ({ snapshot: null, loading: false }),
}));

const NOW = new Date('2026-09-22T18:00:00.000Z').getTime();
const AS_OF = '2026-09-22T17:59:00.000Z';
const row = (ticker, changePercent, fields = {}) => ({
  ticker,
  name: `${ticker} company`,
  changePercent,
  asOf: AS_OF,
  status: 'delayed', marketDate: '2026-09-22',
  source: 'Yahoo Finance',
  sourceUrl: `https://finance.yahoo.com/quote/${ticker}`,
  ...fields,
});
const fixture = (overrides = {}) => ({
  status: 'available',
  asOf: AS_OF,
  expiresAt: '2026-09-22T18:10:00.000Z',
  source: 'Yahoo Finance and State Street',
  sourceUrl: 'https://www.ssga.com',
  universe: { label: 'S&P 500 · SPY', count: 503, asOf: '2026-09-21' },
  coverage: { quotes: 503, total: 503, history50: 503, history200: 503, year: 503, intraday: 503, intradayVolume: 503, intradayGain: 503, reversalComparisons: 503, sectorComparisons: 503 },
  breadth: { advancing: 306, declining: 190, unchanged: 7, above50Pct: 63, above200Pct: 71, newHighs: 22, newLows: 9, medianReturn: 0.42 },
  winners: [row('AAA', 8.15), row('BBB', 5.84), row('CCC', 4.03)],
  losers: [row('DDD', -6.91), row('EEE', -5.11), row('FFF', -4.66)],
  leadership: {
    leadingSector: row('XLI', 1.21, { name: 'Industrials ETF' }),
    laggingSector: row('XLP', -0.51, { name: 'Consumer staples ETF' }),
    lift: row('AAA', 8.15, { contributionPp: 0.11 }),
    drag: row('DDD', -6.91, { contributionPp: -0.04 }),
  },
  outliers: {
    relativeVolume: row('AAA', 8.15, { ratio: 3.2, cutoff: '2026-09-22T17:30:00.000Z' }),
    unusualGain: row('BBB', 5.84, { sessions: 40, cutoff: '2026-09-22T17:30:00.000Z' }),
    reversal: row('CCC', 4.03, { gapPercent: -1.75 }),
    againstSector: row('FFF', -4.66, { sectorName: 'Industrials', sectorChangePercent: 1.21 }),
  },
  ...overrides,
});
const expandedOutlierFixture = () => {
  const snapshot = fixture();
  return {
    ...snapshot,
    outlierDetails: {
      relativeVolume: [snapshot.outliers.relativeVolume, row('RV2', 2.4, { ratio: 2.8 }), row('RV3', -1.2, { ratio: 2.2 })],
      unusualGain: [snapshot.outliers.unusualGain, row('UG2', 3.7, { sessions: 40 }), row('UG3', 2.6, { sessions: 40 })],
      reversal: [snapshot.outliers.reversal, row('RE2', -2.1, { gapPercent: 0.8 }), row('RE3', 1.6, { gapPercent: -0.7 })],
      againstSector: [snapshot.outliers.againstSector, row('AS2', 2.2, { sectorName: 'Technology', sectorChangePercent: -0.4 }), row('AS3', -1.9, { sectorName: 'Energy', sectorChangePercent: 0.5 })],
    },
  };
};
const rotationFixture = () => {
  const expiresAt = '2026-09-22T18:10:00.000Z';
  const quote = (ticker, changePercent) => ({
    ...row(ticker, changePercent),
    ...[...rotationCatalog.themes, ...rotationCatalog.instruments].find(item => item.ticker === ticker),
    expiresAt, marketDate: '2026-09-22', proxy: true,
  });
  return {
    status: 'available', source: 'Yahoo Finance', proxy: true, asOf: AS_OF, expiresAt,
    themes: {
      software: quote('IGV', 1.25), semiconductors: quote('SMH', -0.65),
      leader: quote('URA', 2.4), laggard: quote('TAN', -2.1),
      coverage: { verified: rotationCatalog.themes.length, total: rotationCatalog.themes.length, comparable: true, expiresAt },
    },
    factors: rotationCatalog.factors.map(definition => ({
      id: definition.id, label: definition.label, left: quote(definition.left, 1.2),
      right: quote(definition.right, 0.4), spreadPp: 0.8,
      asOf: AS_OF, expiresAt, status: 'delayed', marketDate: '2026-09-22', source: 'Yahoo Finance', proxy: true,
    })),
  };
};

const expandedDailyFixture = () => {
  const snapshot = expandedOutlierFixture();
  const observed = (ticker, changePercent, fields = {}) => row(ticker, changePercent, { marketDate: '2026-09-22', ...fields });
  return {
    ...snapshot,
    breadth: { ...snapshot.breadth, upOnePercent: 78, downOnePercent: 39, lowerQuartileReturn: -0.62, upperQuartileReturn: 1.14 },
    leadershipDetails: {
      leadingSectors: [observed('XLI', 1.21), observed('XLF', 0.94)],
      laggingSectors: [observed('XLP', -0.51), observed('XLU', -0.37)],
      lifts: [observed('AAA', 8.15, { contributionPp: 0.11 }), observed('BBB', 5.84, { contributionPp: 0.08 })],
      drags: [observed('DDD', -6.91, { contributionPp: -0.04 }), observed('EEE', -5.11, { contributionPp: -0.03 })],
      sectorParticipation: { advancing: 8, declining: 3, unchanged: 0, total: 11 },
    },
    moverDetails: {
      winners: [...snapshot.winners, observed('WIN4', 3.81), observed('WIN5', 3.45)],
      losers: [...snapshot.losers, observed('LOSE4', -3.76), observed('LOSE5', -3.12)],
    },
  };
};

const expandedRotationFixture = () => {
  const snapshot = rotationFixture();
  const returns = { IGV: 1.25, SMH: -0.65, CIBR: 1.8, SKYY: 0.6, XBI: -1.4, KRE: 0.8, ITB: -0.8, XRT: 0.2, TAN: -2.1, URA: 2.4 };
  snapshot.themes.ranked = rotationCatalog.themes.map(definition => ({
    ...row(definition.ticker, returns[definition.ticker]), ...definition,
    expiresAt: snapshot.expiresAt, marketDate: '2026-09-22', proxy: true,
  })).sort((left, right) => right.changePercent - left.changePercent);
  return snapshot;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  useMarketDailySnapshot.mockReturnValue({ snapshot: null, loading: false });
  useMarketDailyResearch.mockReturnValue({ items: [], loading: false });
});
afterEach(() => jest.useRealTimers());

test('keeps six static panels and four fixed rows per panel', () => {
  const { container } = render(<MarketPulseRibbon snapshot={fixture()} />);
  expect(screen.getAllByRole('heading')).toHaveLength(6);
  const tables = screen.getAllByRole('table');
  expect(tables).toHaveLength(6);
  tables.forEach((table) => expect(within(table).getAllByRole('row')).toHaveLength(4));
  expect(container.querySelector('.efr-market-pulse__metrics')).toBeInTheDocument();
  expect(container.querySelector('svg')).not.toBeInTheDocument();
  expect(screen.getByText('306')).toBeInTheDocument();
  expect(screen.getByText('190')).toBeInTheDocument();
  expect(screen.getByText('63% / 71%')).toBeInTheDocument();
  expect(screen.getByText('+0.42%')).toHaveClass('is-positive');
  const before = container.textContent;
  act(() => jest.advanceTimersByTime(24_000));
  expect(container.textContent).toBe(before);
  expect(useMarketDailySnapshot).toHaveBeenCalledWith({ enabled: false });
});

test('pairs three gainers and decliners with complete names on hover and correctly labeled SPY contribution', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const movers = screen.getByRole('table', { name: 'Top three gainers and decliners' });
  expect(within(movers).getAllByRole('columnheader')).toHaveLength(6);
  expect(within(movers).getByText('AAA')).toBeInTheDocument();
  expect(within(movers).getByText('FFF')).toBeInTheDocument();
  expect(within(movers).getByText('AAA company')).toHaveAttribute('title', expect.stringContaining('AAA company'));
  expect(within(movers).getByText('-6.91%')).toHaveClass('is-negative');
  expect(screen.getByText('SPY lift')).toBeInTheDocument();
  expect(screen.getByText('+0.11 pp')).toBeInTheDocument();
  expect(screen.queryByText(/index lift/i)).not.toBeInTheDocument();
});

test('discloses the proxy universe, coverage, provider and observation time without adding a caption row', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const breadth = screen.getByRole('heading', { name: /MARKET BREADTH/ });
  expect(breadth).toHaveAttribute('title', expect.stringContaining('503 / 503 verified quotes'));
  expect(breadth).toHaveAttribute('title', expect.stringContaining('ETF proxy'));
  expect(breadth).toHaveAttribute('title', expect.stringContaining('Sep 22 13:59 ET'));
  expect(breadth).toHaveAttribute('title', expect.stringContaining('Yahoo Finance'));
  expect(within(breadth).getByRole('button', { name: 'Updated Sep 22 13:59 ET' })).toHaveTextContent('D');
  expect(breadth.title).not.toMatch(/AM|PM/);
});

test('renders outlier baselines and percentage points without converting missing numbers to zero', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const outliers = screen.getByRole('table', { name: 'Unusual activity readings' });
  expect(within(outliers).getByText(/AAA 3.2× usual/)).toBeInTheDocument();
  expect(within(outliers).getByText('-1.75%')).toHaveClass('is-negative');
  expect(within(outliers).getByText('+4.03%')).toHaveClass('is-positive');
  expect(within(outliers).getByText('Same-time relative volume').closest('tr')).toHaveAttribute('title', expect.stringContaining('same elapsed session time'));
  expect(within(outliers).getByText('Same-time relative volume').closest('tr')).toHaveAttribute('title', expect.stringContaining('Comparison through Sep 22 13:30 ET'));
  expect(within(outliers).getByText('Largest gain in 40 sessions').closest('tr')).toHaveAttribute('title', expect.stringContaining('Comparison through Sep 22 13:30 ET'));
  expect(within(outliers).getByText('Open → now').closest('tr')).toHaveAttribute('title', expect.stringContaining('prior regular-session close'));
});

test('keeps independently verified fields in a partial snapshot and exposes the actual coverage', () => {
  render(<MarketPulseRibbon snapshot={fixture({
    status: 'partial', coverage: { total: 503, quotes: 499 },
    breadth: { advancing: null, declining: null, medianReturn: null, above50Pct: 63, above200Pct: null },
    winners: [], losers: [], outliers: {},
  })} />);
  expect(screen.getByText('63% / —')).toBeInTheDocument();
  expect(screen.getByText('Industrials ETF')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /MARKET BREADTH/ })).toHaveAttribute('title', expect.stringContaining('499 / 503'));
  expect(screen.queryByText('+0.00%')).not.toBeInTheDocument();
  expect(screen.queryByText('AAA company')).not.toBeInTheDocument();
});

test.each([null, undefined, '', ' ', NaN, Infinity, false, {}, 'unavailable'])('does not manufacture numbers for an invalid metric: %p', (value) => {
  render(<MarketPulseRibbon snapshot={fixture({
    breadth: { medianReturn: value, above50Pct: value, above200Pct: value, newHighs: value, newLows: value },
    winners: [row('AAA', value)], losers: [], leadership: {}, outliers: {},
  })} />);
  expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
  expect(screen.queryByText('0% / 0%')).not.toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Market breadth readings' })).toHaveTextContent('— / —');
});

test.each([
  { status: 'unavailable' },
  { stale: true }, { isStale: true }, { mock: true }, { isMock: true }, { seeded: true }, { cacheOnly: true }, { fromCache: true },
  { connected: false }, { available: false }, { freshness: 'stale' }, { provider: 'offline' },
  { asOf: '2026-09-22T18:00:06Z' }, { asOf: null }, { source: '' },
  { metadata: { cache_only: true } },
])('clears all values from a rejected snapshot: %p', (override) => {
  render(<MarketPulseRibbon snapshot={fixture(override)} />);
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByText('306')).not.toBeInTheDocument();
  expect(screen.queryByText('AAA')).not.toBeInTheDocument();
  expect(screen.queryByText('Industrials ETF')).not.toBeInTheDocument();
});

test('withholds a contaminated nested quote while preserving independent verified readings', () => {
  const snapshot = fixture({ winners: [row('AAA', 99, { metadata: { mock: true } })] });
  expect(usableDailySnapshot(snapshot)).toBe(true);
  render(<MarketPulseRibbon snapshot={snapshot} />);
  expect(screen.queryByText('+99.00%')).not.toBeInTheDocument();
  expect(screen.getByText('306')).toBeInTheDocument();
});

test('requires observation and provenance on each displayed row', () => {
  render(<MarketPulseRibbon snapshot={fixture({
    winners: [row('AAA', 8.15, { asOf: null })],
    losers: [row('DDD', -6.91, { source: null })],
    leadership: {}, outliers: {},
  })} />);
  const movers = screen.getByRole('table', { name: 'Top three gainers and decliners' });
  expect(within(movers).queryByText('AAA')).not.toBeInTheDocument();
  expect(within(movers).queryByText('DDD')).not.toBeInTheDocument();
});

test('uses the independent snapshot hook and clears values when it reports a failed refresh', () => {
  useMarketDailySnapshot.mockReturnValue({ snapshot: fixture(), loading: false });
  const { rerender } = render(<MarketPulseRibbon />);
  expect(useMarketDailySnapshot).toHaveBeenCalledWith({ enabled: true });
  expect(screen.getByText('306')).toBeInTheDocument();
  useMarketDailySnapshot.mockReturnValue({ snapshot: null, loading: false });
  useMarketDailyResearch.mockReturnValue({ items: [], loading: false });
  rerender(<MarketPulseRibbon />);
  expect(screen.queryByText('306')).not.toBeInTheDocument();
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
});

test('retains the fixed layout while loading without adding a loading bubble', () => {
  useMarketDailySnapshot.mockReturnValue({ snapshot: null, loading: true });
  render(<MarketPulseRibbon />);
  expect(screen.getByLabelText('Daily market readings')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getAllByRole('table')).toHaveLength(6);
  expect(screen.queryByText(/loading|refreshing/i)).not.toBeInTheDocument();
});


test('shows unavailable breadth counts in neutral gray while preserving semantic colors for verified counts', () => {
  render(<MarketPulseRibbon snapshot={fixture({ breadth: { advancing: 1, declining: null, newHighs: null, newLows: 2 } })} />);
  const advances = screen.getByText('Advancing / declining').closest('tr');
  const extremes = screen.getByText('New 52-week highs / lows').closest('tr');
  expect(within(advances).getByText('1')).toHaveClass('is-positive');
  expect(within(advances).getByText('—')).toHaveClass('is-neutral');
  expect(within(extremes).getByText('—')).toHaveClass('is-neutral');
  expect(within(extremes).getByText('2')).toHaveClass('is-negative');
});


test('marks partially covered historical metrics and discloses each eligible denominator', () => {
  render(<MarketPulseRibbon snapshot={fixture({ coverage: { quotes: 503, total: 503, history50: 503, history200: 501, year: 499 } })} />);
  const averages = screen.getByText('Above 50D / 200D average').closest('tr');
  const extremes = screen.getByText('New 52-week highs / lows').closest('tr');
  expect(averages).toHaveTextContent('63% / 71%*');
  expect(averages).toHaveAttribute('title', expect.stringContaining('200D history: 501 / 503 holdings'));
  expect(screen.getByLabelText('200D: partial history coverage')).toHaveAttribute('title', expect.stringContaining('denominator excludes holdings without the complete window'));
  expect(screen.queryByLabelText('50D: partial history coverage')).not.toBeInTheDocument();
  expect(extremes).toHaveTextContent('22 / 9*');
  expect(screen.getByLabelText('52-week: partial history coverage')).toHaveAttribute('title', expect.stringContaining('History available for 499 of 503 holdings'));
});

test('does not add historical coverage markers to unavailable metrics', () => {
  render(<MarketPulseRibbon snapshot={fixture({
    coverage: { total: 503, history50: 500, history200: 501, year: 499 },
    breadth: { above50Pct: null, above200Pct: null, newHighs: null, newLows: null },
  })} />);
  expect(screen.queryByLabelText(/partial history coverage/)).not.toBeInTheDocument();
});


test('uses each card header to expand without a separate visible expand icon', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const headers = screen.getAllByRole('button', { name: /^Expand/ });
  expect(headers.map(button => button.getAttribute('aria-label'))).toEqual([
    'Expand market breadth', 'Expand sector leadership and spy impact', 'Expand market themes',
    'Expand market factors', 'Expand winners and losers', 'Expand daily market outliers',
  ]);
  headers.forEach(button => {
    expect(button.closest('h2')).toBeInTheDocument();
    expect(button).not.toHaveTextContent('⤢');
    expect(button).not.toHaveTextContent('↗');
  });
  expect(screen.getByRole('button', { name: 'Open all daily market readings' })).toHaveTextContent('+ All');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('opens all six individual nonmodal expansions beneath their original ribbon cards', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  const triggers = screen.getAllByRole('button', { name: /^Expand/ });
  const cards = triggers.map(trigger => trigger.closest('.market-daily-strip__panel'));
  const compactContent = cards.map(card => card.textContent);
  const measurements = cards.map((card, index) => jest.spyOn(card, 'getBoundingClientRect').mockReturnValue({
    top: 40, bottom: 120, left: 40 + index * 150, right: 190 + index * 150, width: 150, height: 80,
  }));
  const all = screen.getByRole('button', { name: 'Open all daily market readings' });
  fireEvent.click(all);
  const dialogs = screen.getAllByRole('dialog');
  expect(dialogs).toHaveLength(6);
  expect(dialogs.map(dialog => within(dialog).getByRole('heading', { level: 2 }).textContent)).toEqual([
    'MARKET BREADTH · S&P 500', 'LEADERSHIP · S&P 500', 'THEMES · ETF PROXIES', 'FACTORS · ETF SPREADS', 'WINNERS & LOSERS · S&P 500', 'OUTLIERS · S&P 500',
  ]);
  dialogs.forEach((dialog, index) => {
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(dialog).not.toHaveClass('market-daily-detail--all');
    expect(dialog).toHaveStyle({ top: '120px', left: `${40 + index * 150}px`, width: '150px' });
    expect(triggers[index]).toHaveAttribute('aria-expanded', 'true');
    expect(triggers[index]).toHaveAttribute('aria-controls', dialog.id);
    expect(within(dialog).queryByRole('tab')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Sources & definitions')).toBeInTheDocument();
  });
  expect(new Set(dialogs.map(dialog => dialog.id)).size).toBe(6);
  expect(all).toHaveAttribute('aria-expanded', 'true');
  expect(all.getAttribute('aria-controls').split(' ')).toEqual(dialogs.map(dialog => dialog.id));
  expect(screen.queryByRole('dialog', { name: 'DAILY MARKET READINGS' })).not.toBeInTheDocument();
  expect(document.querySelector('.market-daily-detail__backdrop')).toBeInTheDocument();
  expect(within(dialogs[0]).getByText(/Advancers outnumber decliners/)).toBeInTheDocument();
  expect(dialogs[2]).toHaveTextContent('+1.25%');
  expect(dialogs[3]).toHaveTextContent('+0.80 pp');
  const lastSection = within(dialogs[5]).getByRole('region', { name: 'OUTLIERS' });
  expect(within(lastSection).getByText('Same-time relative volume')).toBeInTheDocument();
  expect(within(lastSection).getByText('Against their sectors')).toBeInTheDocument();
  expect(cards.map(card => card.textContent)).toEqual(compactContent);
  dialogs.forEach(dialog => expect(dialog.querySelector('.market-daily-detail__subtitle')).not.toBeInTheDocument());
  [0, 1, 4, 5].forEach(index => {
    expect(triggers[index]).toHaveTextContent('S&P 500');
    expect(triggers[index]).not.toHaveTextContent('SPY');
  });

  measurements.forEach((measure, index) => measure.mockReturnValue({
    top: 30, bottom: 100, left: 48 + index * 140, right: 188 + index * 140, width: 140, height: 70,
  }));
  fireEvent(window, new Event('resize'));
  dialogs.forEach((dialog, index) => {
    expect(dialog).toHaveStyle({ top: '100px', left: `${48 + index * 140}px`, width: '140px' });
  });
});

test('expands twelve ranked outlier readings when opened individually or with all cards while keeping four compact headlines', () => {
  render(<MarketPulseRibbon snapshot={expandedOutlierFixture()} />);
  const compact = screen.getByRole('table', { name: 'Unusual activity readings' });
  const compactHeadlines = within(compact).getAllByRole('row').map(item => item.textContent);
  expect(compactHeadlines).toHaveLength(4);
  expect(within(compact).getByText(/AAA 3.2× usual/)).toBeInTheDocument();
  expect(within(compact).queryByText('RV2')).not.toBeInTheDocument();

  const assertExpandedOutliers = scope => {
    const categories = ['Same-time relative volume', 'Largest gains in 40 sessions', 'Open → now reversals', 'Against their sectors'];
    const tables = categories.map(name => within(scope).getByRole('table', { name }));
    tables.forEach(table => {
      expect(within(table).getAllByRole('columnheader').slice(0, 2).map(header => header.textContent)).toEqual(['Ticker', 'Security']);
      expect(within(table).getAllByRole('rowheader')).toHaveLength(3);
      expect(within(table).getAllByRole('row')).toHaveLength(4);
    });
    expect(tables.flatMap(table => within(table).getAllByRole('rowheader'))).toHaveLength(12);
    ['RV2', 'RV3', 'UG2', 'UG3', 'RE2', 'RE3', 'AS2', 'AS3'].forEach(ticker => {
      expect(within(scope).getByRole('rowheader', { name: ticker })).toBeInTheDocument();
    });
  };

  fireEvent.click(screen.getByRole('button', { name: 'Expand daily market outliers' }));
  assertExpandedOutliers(screen.getByRole('dialog', { name: 'OUTLIERS · S&P 500' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Open all daily market readings' }));
  assertExpandedOutliers(screen.getByRole('dialog', { name: 'OUTLIERS · S&P 500' }));
  expect(within(compact).getAllByRole('row').map(item => item.textContent)).toEqual(compactHeadlines);
});

test('shows a bounded broader perspective in every individual expansion and all cards without growing the strip', () => {
  render(<MarketPulseRibbon snapshot={expandedDailyFixture()} rotationSnapshot={expandedRotationFixture()} />);
  const compactTables = screen.getAllByRole('table');
  const compactContent = compactTables.map(table => table.textContent);
  compactTables.forEach(table => expect(within(table).getAllByRole('row')).toHaveLength(4));
  expect(screen.queryByText('WIN4')).not.toBeInTheDocument();
  expect(screen.queryByText('LOSE5')).not.toBeInTheDocument();

  const sections = [
    {
      trigger: 'Expand market breadth', title: 'MARKET BREADTH',
      assert: scope => {
        expect(within(scope).getAllByRole('rowheader')).toHaveLength(7);
        expect(within(scope).getByText('78')).toBeInTheDocument();
        expect(within(scope).getByText('39')).toBeInTheDocument();
        expect(within(scope).getByText('-0.62%')).toHaveClass('is-negative');
        expect(within(scope).getByText('+1.14%')).toHaveClass('is-positive');
      },
    },
    {
      trigger: 'Expand sector leadership and spy impact', title: 'LEADERSHIP',
      assert: scope => {
        const sectors = within(scope).getByRole('table', { name: 'Sector leadership' });
        const impact = within(scope).getByRole('table', { name: 'Index impact' });
        expect(within(sectors).getAllByRole('rowheader').map(header => header.textContent)).toEqual(['XLI', 'XLF', 'XLP', 'XLU']);
        expect(within(impact).getAllByRole('rowheader').map(header => header.textContent)).toEqual(['AAA', 'BBB', 'DDD', 'EEE']);
        [sectors, impact].forEach(table => expect(within(table).getAllByRole('columnheader').slice(0, 2).map(header => header.textContent)).toEqual(['Ticker', 'Security']));
        expect(within(impact).getByText('+0.08 pp')).toHaveClass('is-positive');
        expect(within(impact).getByText('-0.03 pp')).toHaveClass('is-negative');
      },
    },
    {
      trigger: 'Expand market themes', title: 'THEMES · ETF PROXIES',
      assert: scope => {
        const technology = within(scope).getByRole('table', { name: 'Technology participation' });
        const rotation = within(scope).getByRole('table', { name: 'Broader rotation' });
        expect(within(technology).getAllByRole('rowheader')).toHaveLength(2);
        expect(within(rotation).getAllByRole('rowheader')).toHaveLength(4);
        ['IGV', 'SMH'].forEach(ticker => expect(within(technology).getByText(ticker)).toBeInTheDocument());
        ['URA', 'CIBR', 'TAN', 'XBI'].forEach(ticker => expect(within(rotation).getByText(ticker)).toBeInTheDocument());
        expect(within(rotation).queryByText('SKYY')).not.toBeInTheDocument();
      },
    },
    {
      trigger: 'Expand market factors', title: 'FACTORS · ETF SPREADS',
      assert: scope => {
        const tables = within(scope).getAllByRole('table');
        expect(tables).toHaveLength(2);
        tables.forEach(table => {
          expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Comparison', 'First ETF', 'Second ETF', 'Spread']);
          expect(within(table).getAllByRole('rowheader')).toHaveLength(2);
        });
        const growth = within(scope).getByRole('rowheader', { name: 'Growth vs value' }).closest('tr');
        expect(growth).toHaveTextContent('IWF');
        expect(growth).toHaveTextContent('IWD');
        expect(growth).toHaveTextContent('+1.20%');
        expect(growth).toHaveTextContent('+0.40%');
        expect(growth).toHaveTextContent('+0.80 pp');
      },
    },
    {
      trigger: 'Expand winners and losers', title: 'WINNERS & LOSERS',
      assert: scope => {
        const winners = within(scope).getByRole('table', { name: 'Winners' });
        const losers = within(scope).getByRole('table', { name: 'Losers' });
        expect(within(winners).getAllByRole('rowheader').map(header => header.textContent)).toEqual(['AAA', 'BBB', 'CCC', 'WIN4', 'WIN5']);
        expect(within(losers).getAllByRole('rowheader').map(header => header.textContent)).toEqual(['DDD', 'EEE', 'FFF', 'LOSE4', 'LOSE5']);
      },
    },
  ];

  sections.forEach(section => {
    fireEvent.click(screen.getByRole('button', { name: section.trigger }));
    section.assert(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open all daily market readings' }));
  sections.forEach(section => {
    const dialogTitle = ['MARKET BREADTH', 'LEADERSHIP', 'WINNERS & LOSERS', 'OUTLIERS'].includes(section.title) ? `${section.title} · S&P 500` : section.title;
    section.assert(screen.getByRole('dialog', { name: dialogTitle }));
  });
  expect(compactTables.map(table => table.textContent)).toEqual(compactContent);
});

test('allows keyboard focus to leave the expansion and restores focus to the plus after Escape', async () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const trigger = screen.getByRole('button', { name: 'Open all daily market readings' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialogs = screen.getAllByRole('dialog');
  expect(trigger).toHaveFocus();
  dialogs.forEach(dialog => expect(within(dialog).queryByRole('button', { name: /Close/ })).not.toBeInTheDocument());
  await userEvent.tab();
  expect(within(dialogs[0]).getAllByRole('button')[0]).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('blurs the rest of the page only for the All group and clears blur when it closes', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  const backdrop = () => document.querySelector('.market-daily-detail__backdrop');
  const all = screen.getByRole('button', { name: 'Open all daily market readings' });
  const breadth = screen.getByRole('button', { name: 'Expand market breadth' });
  fireEvent.click(breadth);
  expect(backdrop()).not.toBeInTheDocument();
  fireEvent.click(all);
  expect(backdrop()).toHaveAttribute('aria-hidden', 'true');
  expect(backdrop().parentElement).toBe(document.body);
  expect(document.querySelectorAll('.market-daily-detail__backdrop')).toHaveLength(1);
  fireEvent.click(breadth);
  expect(screen.getAllByRole('dialog')).toHaveLength(5);
  expect(backdrop()).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(backdrop()).not.toBeInTheDocument();
  fireEvent.click(all);
  fireEvent.click(all);
  expect(backdrop()).not.toBeInTheDocument();
  fireEvent.click(all);
  fireEvent.pointerDown(document.body);
  expect(backdrop()).not.toBeInTheDocument();
  fireEvent.click(breadth);
  expect(backdrop()).not.toBeInTheDocument();
});

test('clears rejected daily readings in all open cards while preserving independent rotation evidence', () => {
  const rotation = rotationFixture();
  const { rerender } = render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotation} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open all daily market readings' }));
  expect(within(screen.getByRole('dialog', { name: 'MARKET BREADTH · S&P 500' })).getByText(/Advancers outnumber decliners/)).toBeInTheDocument();
  rerender(<MarketPulseRibbon snapshot={fixture({ stale: true })} rotationSnapshot={rotation} />);
  expect(screen.getAllByRole('dialog')).toHaveLength(6);
  const dialog = screen.getByRole('dialog', { name: 'MARKET BREADTH · S&P 500' });
  const breadth = within(dialog).getByRole('region', { name: 'MARKET BREADTH' });
  expect(within(dialog).getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(within(breadth).getByRole('rowheader', { name: 'Advancing / declining' }).closest('tr')).toHaveTextContent('— / —');
  expect(within(breadth).queryByText(/Advancers outnumber decliners/)).not.toBeInTheDocument();
  expect(within(breadth).queryByText('306')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'THEMES · ETF PROXIES' })).toHaveTextContent('+1.25%');
  expect(screen.getByRole('dialog', { name: 'FACTORS · ETF SPREADS' })).toHaveTextContent('+0.80 pp');
});

test('expands directly below the clicked card at its width with interwoven narrative', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const trigger = screen.getByRole('button', { name: 'Expand market breadth' });
  const card = trigger.closest('.market-daily-strip__panel');
  const geometry = { top: 40, bottom: 120, left: 208, right: 468, width: 260, height: 80 };
  jest.spyOn(card, 'getBoundingClientRect').mockReturnValue(geometry);
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'MARKET BREADTH · S&P 500' });
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog).toHaveClass('market-daily-detail--expanded');
  expect(dialog).toHaveStyle({ top: '120px', left: '208px', width: '260px' });
  expect(dialog).toHaveAttribute('aria-modal', 'false');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(trigger).toHaveAttribute('aria-controls', dialog.id);
  expect(document.querySelector('.market-daily-detail__backdrop')).not.toBeInTheDocument();
  expect(card.getBoundingClientRect()).toEqual(geometry);
  expect(within(dialog).getAllByRole('table')).toHaveLength(2);
  expect(within(dialog).getByText(/Advancers outnumber decliners/)).toBeVisible();
  expect(within(dialog).getAllByRole('rowheader').map(header => header.textContent)).toEqual([
    'Advancing / declining', 'Up ≥1% / down ≥1%', 'Median constituent return', 'Middle 50% of returns',
    'Above 50D average', 'Above 200D average', 'New 52-week highs / lows',
  ]);
  expect(within(dialog).queryByRole('tab')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(within(dialog).queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

test('dismisses on an outside pointer press while inside presses leave the expansion open', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand winners and losers' }));
  const dialog = screen.getByRole('dialog', { name: 'WINNERS & LOSERS · S&P 500' });
  fireEvent.pointerDown(within(dialog).getByRole('heading', { name: 'WINNERS & LOSERS · S&P 500' }));
  expect(dialog).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('keeps every card open while interacting with any expansion or its observation timestamp', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open all daily market readings' }));
  const dialogs = screen.getAllByRole('dialog');
  dialogs.forEach(dialog => {
    const definitions = within(dialog).getByText('Sources & definitions');
    fireEvent.pointerDown(definitions);
    fireEvent.click(definitions);
    expect(screen.getAllByRole('dialog')).toHaveLength(6);
  });
  const leadership = screen.getByRole('button', { name: 'Expand sector leadership and spy impact' }).closest('h2');
  const marker = within(leadership).getByRole('button', { name: /Updated Sep 22 13:59 ET/ });
  fireEvent.pointerDown(marker);
  fireEvent.click(marker);
  expect(screen.getAllByRole('dialog')).toHaveLength(6);
  fireEvent.pointerDown(screen.getByRole('status'));
  expect(screen.getAllByRole('dialog')).toHaveLength(6);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('toggles all cards together and lets an open header close only its own expansion', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  const all = screen.getByRole('button', { name: 'Open all daily market readings' });
  const breadth = screen.getByRole('button', { name: 'Expand market breadth' });
  const themes = screen.getByRole('button', { name: 'Expand market themes' });
  fireEvent.click(all);
  expect(screen.getAllByRole('dialog')).toHaveLength(6);
  fireEvent.pointerDown(breadth);
  fireEvent.click(breadth);
  expect(screen.getAllByRole('dialog')).toHaveLength(5);
  expect(screen.queryByRole('dialog', { name: 'MARKET BREADTH · S&P 500' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'LEADERSHIP · S&P 500' })).toBeInTheDocument();
  expect(breadth).toHaveAttribute('aria-expanded', 'false');
  expect(breadth).not.toHaveAttribute('aria-controls');
  expect(all).toHaveAttribute('aria-expanded', 'false');
  fireEvent.pointerDown(themes);
  fireEvent.click(themes);
  expect(screen.getAllByRole('dialog')).toHaveLength(4);
  expect(screen.queryByRole('dialog', { name: 'THEMES · ETF PROXIES' })).not.toBeInTheDocument();
  fireEvent.pointerDown(breadth);
  fireEvent.click(breadth);
  expect(screen.getAllByRole('dialog')).toHaveLength(5);
  expect(screen.getByRole('dialog', { name: 'MARKET BREADTH · S&P 500' })).toBeInTheDocument();
  fireEvent.pointerDown(all);
  fireEvent.click(all);
  expect(screen.getAllByRole('dialog')).toHaveLength(6);
  expect(all).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(all);
  fireEvent.click(all);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(all).toHaveAttribute('aria-expanded', 'false');
});

test('restores Escape focus to the last toggled header after opening all cards', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open all daily market readings' }));
  const themes = screen.getByRole('button', { name: 'Expand market themes' });
  fireEvent.click(themes);
  expect(screen.getAllByRole('dialog')).toHaveLength(5);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(themes).toHaveFocus();
});

test('toggles the same heading and switches directly to a different ribbon card', () => {
  render(<MarketPulseRibbon snapshot={fixture()} rotationSnapshot={rotationFixture()} />);
  const breadth = screen.getByRole('button', { name: 'Expand market breadth' });
  const leadership = screen.getByRole('button', { name: 'Expand sector leadership and spy impact' });
  const themes = screen.getByRole('button', { name: 'Expand market themes' });
  fireEvent.click(breadth);
  expect(screen.getByRole('dialog', { name: 'MARKET BREADTH · S&P 500' })).toBeInTheDocument();
  fireEvent.click(leadership);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'LEADERSHIP · S&P 500' })).toBeInTheDocument();
  expect(breadth).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(themes);
  expect(screen.getByRole('dialog', { name: 'THEMES · ETF PROXIES' })).toBeInTheDocument();
  expect(themes).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(themes);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(themes).toHaveAttribute('aria-expanded', 'false');
});

test('keeps the expansion attached to the card after viewport geometry changes', () => {
  render(<MarketPulseRibbon snapshot={fixture()} />);
  const trigger = screen.getByRole('button', { name: 'Expand daily market outliers' });
  const card = trigger.closest('.market-daily-strip__panel');
  const measure = jest.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 40, bottom: 120, left: 708, right: 968, width: 260, height: 80 });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toHaveStyle({ top: '120px', left: '708px', width: '260px' });
  measure.mockReturnValue({ top: 20, bottom: 90, left: 620, right: 850, width: 230, height: 70 });
  fireEvent(window, new Event('resize'));
  expect(screen.getByRole('dialog')).toHaveStyle({ top: '90px', left: '620px', width: '230px' });
});

test('removes readings and conclusions from an open popup when the provider fails', () => {
  const { rerender } = render(<MarketPulseRibbon snapshot={fixture()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand market breadth' }));
  expect(within(screen.getByRole('dialog')).getByText(/Advancers outnumber decliners/)).toBeInTheDocument();
  rerender(<MarketPulseRibbon snapshot={null} />);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(within(dialog).queryByText(/Advancers outnumber decliners/)).not.toBeInTheDocument();
  expect(within(dialog).queryByText('306')).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/DELAYED ·/)).not.toBeInTheDocument();
});


test('weaves exact research evidence into its metric group and keeps local source links usable', () => {
  useMarketDailyResearch.mockReturnValue({ loading: false, items: [{
    id: 'AAA:risk-ranges:trend', ticker: 'AAA', horizon: 'Trend', direction: 'BULLISH',
    text: 'AAA Trend is Bullish in Hedgeye’s Risk Ranges.', sourceTitle: 'Risk Ranges',
    sourceUrl: '/api/hedgeye/screenshot/2026-09-22/content?type=risk-ranges', publicationDate: '2026-09-22',
  }, {
    id: 'AAA:early-look:trend', ticker: 'AAA', horizon: 'Trend', direction: 'BULLISH',
    text: 'AAA Trend is Bullish in Hedgeye’s Early Look.', sourceTitle: 'Early Look',
    sourceUrl: 'https://app.hedgeye.com/insights/aaa', publicationDate: '2026-09-22',
  }] });
  render(<MarketPulseRibbon snapshot={fixture()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand winners and losers' }));
  const dialog = screen.getByRole('dialog');
  const winners = within(dialog).getByRole('region', { name: 'Winners' });
  expect(within(winners).getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(within(winners).getByRole('link', { name: /Risk Ranges/ })).toHaveAttribute('href', '/api/hedgeye/screenshot/2026-09-22/content?type=risk-ranges');
  expect(within(winners).queryByRole('link', { name: /Early Look/ })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('heading', { name: 'WINNERS & LOSERS · S&P 500' })).toBeVisible();
  expect(dialog.querySelector('.market-daily-detail__subtitle')).not.toBeInTheDocument();
});

test('shows research for all three outliers and leaves unshown signals available to later categories', () => {
  const research = (ticker, horizon, direction) => ({
    id: `${ticker}:${horizon}`, ticker, horizon, direction,
    text: `${ticker} ${horizon} is ${direction}.`, sourceTitle: 'Risk Ranges',
    sourceUrl: `https://app.hedgeye.com/insights/${ticker.toLowerCase()}-${horizon.toLowerCase()}`,
    publicationDate: '2026-09-22',
  });
  const items = [
    research('AAA', 'Trend', 'BULLISH'), research('AAA', 'Trade', 'BEARISH'),
    research('RV2', 'Trend', 'BULLISH'), research('RV3', 'Trend', 'BEARISH'),
  ];
  useMarketDailyResearch.mockReturnValue({ loading: false, items });
  const snapshot = expandedOutlierFixture();
  snapshot.outlierDetails.unusualGain[0] = row('AAA', 8.15, { sessions: 40 });
  render(<MarketPulseRibbon snapshot={snapshot} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand daily market outliers' }));
  const dialog = screen.getByRole('dialog', { name: 'OUTLIERS · S&P 500' });
  const volume = within(dialog).getByRole('region', { name: 'Same-time relative volume' });
  expect(within(volume).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([
    items[0].sourceUrl, items[2].sourceUrl, items[3].sourceUrl,
  ]);
  const unusualGains = within(dialog).getByRole('region', { name: 'Largest gains in 40 sessions' });
  expect(within(unusualGains).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([items[1].sourceUrl]);
});


test('retains aged informational readings in every daily panel with D and original timestamps in detail', () => {
  const snapshot = fixture({ expiresAt: '2026-09-22T17:59:59Z' });
  render(<MarketPulseRibbon snapshot={snapshot} />);
  expect(screen.getByText('306')).toBeInTheDocument();
  expect(screen.getAllByText('D')).toHaveLength(4);
  expect(screen.getByRole('table', { name: 'Top three gainers and decliners' })).toHaveTextContent('AAA');
  expect(screen.getByRole('table', { name: 'Unusual activity readings' })).toHaveTextContent('3.2× usual');
  fireEvent.click(screen.getByRole('button', { name: 'Expand market breadth' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('D')).toBeInTheDocument();
  expect(dialog).not.toHaveTextContent('LAST VERIFIED');
  expect(dialog).toHaveTextContent('Sep 22 13:59 ET');
  expect(dialog).toHaveTextContent('306 / 190');
});

test('colors retained same-session ribbon Ds orange without changing their observation time', () => {
  render(<MarketPulseRibbon snapshot={fixture({ expiresAt: '2026-09-22T17:59:59Z' })} />);
  const markers = screen.getAllByText('D');
  expect(markers).toHaveLength(4);
  markers.forEach(marker => {
    expect(marker).toHaveClass('dashboard-delayed-data-marker--same-session');
    expect(marker.closest('button')).toHaveAttribute('data-data-age', 'same-session');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Expand market breadth' }));
  const detail = screen.getByRole('dialog');
  expect(within(detail).getByText('D')).toHaveClass('dashboard-delayed-data-marker--same-session');
  expect(detail).toHaveTextContent('Sep 22 13:59 ET');
});

test('colors a header and its detail D red when one contributing observation is from a previous market session', () => {
  const previous = fixture({ asOf: '2026-09-21T17:59:00Z', expiresAt: '2026-09-21T18:10:00Z', marketDate: '2026-09-21' });
  [...previous.winners, ...previous.losers, ...Object.values(previous.leadership), ...Object.values(previous.outliers)].forEach(reading => {
    reading.asOf = '2026-09-21T17:59:00Z';
    reading.marketDate = '2026-09-21';
  });
  const current = fixture({ status: 'partial', breadth: { above50Pct: 65 }, winners: [], losers: [], outliers: {} });
  const merged = mergeMarketDailyReference(previous, current, NOW);
  render(<MarketPulseRibbon snapshot={merged} />);
  const breadth = screen.getByRole('heading', { name: /MARKET BREADTH/ });
  const leadership = screen.getByRole('heading', { name: /^LEADERSHIP/ });
  expect(within(breadth).getByText('D')).toHaveClass('dashboard-delayed-data-marker--older-session');
  expect(within(leadership).getByText('D')).toHaveClass('dashboard-delayed-data-marker--same-session');
  expect(screen.getByText('Above 50D / 200D average').closest('tr')).toHaveTextContent('65% / 71%');
  fireEvent.click(screen.getByRole('button', { name: 'Expand market breadth' }));
  const detail = screen.getByRole('dialog');
  expect(within(detail).getByText('D')).toHaveClass('dashboard-delayed-data-marker--older-session');
  expect(detail).toHaveTextContent('Sep 21 13:59 ET');
});

test('retained breadth keeps its original denominator and timestamp beside newer partial history', () => {
  const original = fixture();
  const partial = fixture({ status: 'partial', asOf: '2026-09-22T18:00:00Z',
    coverage: { total: 503, quotes: 400, history50: 400 },
    breadth: { advancing: null, declining: null, above50Pct: 65 }, winners: [], losers: [], leadership: {}, outliers: {},
  });
  const merged = mergeMarketDailyReference(original, partial, NOW);
  render(<MarketPulseRibbon snapshot={merged} />);
  const advances = screen.getByText('Advancing / declining').closest('tr');
  expect(advances).toHaveTextContent('306 / 190');
  expect(advances).toHaveAttribute('title', expect.stringContaining('503 / 503'));
  expect(advances).toHaveAttribute('title', expect.stringContaining('Sep 22 13:59 ET'));
  fireEvent.click(screen.getByRole('button', { name: 'Expand market breadth' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('306 / 190');
  expect(dialog).toHaveTextContent('65%');
});


test('shows retained themes and factor pairs with their original session in compact and expanded views', () => {
  const rotation = retainMarketRotationSnapshot(mergeMarketRotationSnapshots(null, rotationFixture(), NOW));
  render(<MarketPulseRibbon snapshot={null} rotationSnapshot={rotation} />);
  expect(screen.getByRole('table', { name: 'Daily theme returns' })).toHaveTextContent('IGV+1.25%');
  expect(screen.getByRole('table', { name: 'Daily factor spreads' })).toHaveTextContent('+0.80 pp');
  expect(screen.getAllByText('D')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Expand market factors' }));
  expect(within(screen.getByRole('dialog')).getByText('D')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveTextContent('LAST VERIFIED');
  expect(screen.getByRole('dialog')).toHaveTextContent('Sep 22 13:59 ET');
  expect(screen.getByRole('dialog')).toHaveTextContent('+0.80 pp');
});


test('last-close ribbon readings use independent D buttons that reveal observation time without opening cards', () => {
  const snapshot = fixture({ asOf: '2026-09-21T20:00:00Z', marketDate: '2026-09-21' });
  [...snapshot.winners, ...snapshot.losers, ...Object.values(snapshot.leadership), ...Object.values(snapshot.outliers)].forEach(reading => {
    reading.status = 'last-close';
    reading.asOf = snapshot.asOf;
    reading.marketDate = snapshot.marketDate;
  });
  render(<MarketPulseRibbon snapshot={snapshot} />);
  expect(screen.queryByText('LAST CLOSE')).not.toBeInTheDocument();
  const heading = screen.getByRole('heading', { name: /^LEADERSHIP/ });
  const expansion = within(heading).getByRole('button', { name: 'Expand sector leadership and spy impact' });
  const marker = within(heading).getByRole('button', { name: 'Updated Sep 21 16:00 ET' });
  expect(expansion).not.toContainElement(marker);
  expect(marker).toHaveAttribute('data-data-age', 'older-session');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(marker);
  expect(screen.getByRole('status')).toHaveTextContent('Updated Sep 21 16:00 ET');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(expansion);
  const dialog = screen.getByRole('dialog', { name: 'LEADERSHIP · S&P 500' });
  expect(dialog).not.toHaveTextContent('LAST CLOSE');
  const detailMarker = within(dialog).getByRole('button', { name: /Updated Sep 21 16:00 ET/ });
  fireEvent.click(detailMarker);
  expect(screen.getAllByRole('status').some(status => status.textContent.includes('Sep 21 16:00 ET'))).toBe(true);
  fireEvent.click(expansion);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
