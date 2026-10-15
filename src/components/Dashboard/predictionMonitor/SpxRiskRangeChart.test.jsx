import React, { act } from 'react';
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SpxRiskRangeChart } from './SpxRiskRangeChart';
import { useRiskRangeChartModel } from './useRiskRangeChartModel';
import { useRiskRangeChartPlot } from './useRiskRangeChartPlot';
import { MARKET_UI } from './marketUi';
import { formatIntradayTimeTick } from './riskRangeChartAxes';
import PersistentSurface from '../../common/PersistentSurface';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const NOW = Date.parse('2026-09-11T21:05:00Z');
const FUTURE = '2026-09-11T22:00:00Z';
const TIME_A = Date.parse('2026-09-11T20:00:00Z');
const TIME_B = Date.parse('2026-09-11T21:00:00Z');
const DATES = ['2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'];
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
// Chart/reference fixtures remain local to this test. The extracted chart owns
// no provider subscriptions, requests, position-derived prices, or trade actions.
const dailyRange = (date, index = 0) => ({
  date, status: 'available',
  startAt: Date.parse(`${date}T13:30:00Z`), endAt: Date.parse(`${date}T21:00:00Z`),
  references: [{ label: 'LRR', value: 6300 + index }, { label: 'HRR', value: 6500 + index }],
});
const chart = (overrides = {}) => ({
  status: 'available', availability: 'live', source: 'ibkr_historical_bars',
  asOf: '2026-09-11T21:00:00Z', latestAt: '2026-09-11T21:00:00Z', expiresAt: FUTURE,
  fit: 'exact', previousClose: 6380, latestValue: 6430,
  points: [{ timestamp: TIME_A, value: '6400.25', high: '6401' }, { timestamp: TIME_B, value: 6430 }],
  dailyRanges: [dailyRange('2026-09-11')],
  sessionWindow: { startAt: '2026-09-11T13:30:00Z', endAt: '2026-09-11T21:00:00Z' },
  ...overrides,
});
const multiDayChart = (dates = DATES) => chart({
  points: dates.flatMap((date, index) => [
    { timestamp: Date.parse(`${date}T13:30:00Z`), value: 6400 + index, sessionDate: date },
    { timestamp: Date.parse(`${date}T21:00:00Z`), value: 6410 + index, sessionDate: date },
  ]),
  dailyRanges: dates.map(dailyRange),
});
const snapshot = () => ({
  chart: chart(),
  riskRange: {
    status: 'available', expiresAt: FUTURE, date: '2026-09-11', trend: 'bullish', lrr: 6200, hrr: 6600,
  },
  session: { state: 'closed' },
});
const modelProps = (prepared, overrides = {}) => ({
  snapshot: prepared, nowMs: NOW, marketUi: MARKET_UI.sp500, chartRange: '1d',
  tradingClock: null, checkingHours: false, loading: false, resourceRefreshing: false,
  ...overrides,
});

test.each([
  ['bitcoin', 'ethereum', 'Ethereum'],
  ['ethereum', 'bitcoin', 'Bitcoin'],
  ['gold', 'silver', 'Silver'],
  ['silver', 'gold', 'Gold'],
])('replaces the %s header timestamp with a direct %s switch', (marketId, targetId, targetLabel) => {
  const onMarketChange = jest.fn();
  render(<SpxRiskRangeChart
    snapshot={snapshot()}
    nowMs={NOW}
    marketUi={MARKET_UI[marketId]}
    onMarketChange={onMarketChange}
  />);

  expect(screen.queryByTestId(`${MARKET_UI[marketId].symbol.toLowerCase()}-chart-as-of`)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: `Switch to ${targetLabel}` }));
  expect(onMarketChange).toHaveBeenCalledWith(targetId);
});

const ES_NOW = Date.parse('2026-09-14T23:38:08Z');
const CASH_OPEN = Date.parse('2026-09-14T13:30:00Z');
const CASH_CLOSE = Date.parse('2026-09-14T20:00:00Z');
const ES_OPEN = Date.parse('2026-09-14T22:00:00Z');
const ES_LATEST = Date.parse('2026-09-14T23:30:00Z');
const overnightEsSnapshot = () => ({
  chart: chart({
    status: 'historical', availability: 'historical', historicalThroughDate: '2026-09-14',
    asOf: '2026-09-14T19:55:00Z', latestAt: '2026-09-14T19:55:00Z',
    latestValue: 7610, sessionWindow: null,
    points: [{ timestamp: CASH_OPEN, value: 7600 }, { timestamp: Date.parse('2026-09-14T19:55:00Z'), value: 7610 }],
    dailyRanges: [{ ...dailyRange('2026-09-14'), startAt: CASH_OPEN, endAt: CASH_CLOSE,
      references: [{ label: 'LRR', value: 7550 }, { label: 'HRR', value: 7700 }] }],
  }),
  session: { state: 'closed', openTime: '2026-09-14T13:30:00Z', closeTime: '2026-09-14T20:00:00Z' },
  contracts: { event: { resolverSymbol: 'ESU26' } },
  chartReferences: {
    basis: { symbol: 'SPX' },
    contract: {
      symbol: 'ESU26', instrument: { symbol: 'ES', displaySymbol: 'ESU26', secType: 'FUT', exchange: 'CME' },
      freshness: { status: 'unavailable' },
      chart: chart({
        asOf: '2026-09-14T23:30:00Z', latestAt: '2026-09-14T23:30:00Z', expiresAt: '2026-09-14T23:40:00Z',
        latestValue: 7628, sessionDate: '2026-09-15', sessionMode: 'current', dailyRanges: [],
        refreshPending: true, refreshRetained: true,
        points: [{ timestamp: ES_OPEN, value: 7620, sessionDate: '2026-09-15' }, { timestamp: ES_LATEST, value: 7628, sessionDate: '2026-09-15' }],
        sessionWindow: {
          profileId: 'cme_futures', source: 'official_exchange_session', timeZone: 'America/New_York',
          sessionDate: '2026-09-15', state: 'resolver_open',
          startAt: '2026-09-14T22:00:00Z', endAt: '2026-09-15T20:00:00Z',
        },
      }),
    },
  },
});
const checkpointWithCurrentEsSnapshot = () => {
  const prepared = overnightEsSnapshot();
  const reference = prepared.chartReferences.contract.chart;
  const asOf = '2026-09-14T23:38:00Z';
  Object.assign(reference, {
    source: 'ibkr_completed_history_checkpoint', latestSource: 'ibkr_live_native_quote',
    includesVerifiedCurrentPoint: true, currentSessionSource: 'ibkr_live_native_quote', currentSessionAsOf: asOf,
    latestAt: asOf, asOf, latestValue: 7627.5, expiresAt: '2026-09-14T23:48:00Z',
    points: [...reference.points, {
      timestamp: Date.parse(asOf), value: 7627.5, sessionDate: '2026-09-15', source: 'ibkr_live_native_quote',
      availability: 'live', fit: 'exact', verifiedCurrent: true,
    }],
  });
  return prepared;
};
const CASH_NOW = Date.parse('2026-09-14T15:08:00Z');
const CASH_LATEST = Date.parse('2026-09-14T15:00:00Z');
const cashSessionEsSnapshot = () => {
  const prepared = overnightEsSnapshot();
  const reference = prepared.chartReferences.contract.chart;
  Object.assign(reference, {
    sessionDate: '2026-09-14', asOf: '2026-09-14T15:00:00Z', latestAt: '2026-09-14T15:00:00Z', expiresAt: '2026-09-14T15:10:00Z',
    points: [
      { timestamp: Date.parse('2026-09-13T22:00:00Z'), value: 7990, sessionDate: '2026-09-14' },
      { timestamp: CASH_OPEN - 60_000, value: 7980, sessionDate: '2026-09-14' },
      { timestamp: CASH_OPEN, value: 7610, sessionDate: '2026-09-14' },
      { timestamp: CASH_LATEST, value: 7620, sessionDate: '2026-09-14' },
    ],
    sessionWindow: { ...reference.sessionWindow, sessionDate: '2026-09-14', startAt: '2026-09-13T22:00:00Z', endAt: '2026-09-14T20:00:00Z' },
  });
  Object.assign(prepared.chart, {
    status: 'available', availability: 'live', expiresAt: '2026-09-14T15:10:00Z',
    points: [{ timestamp: CASH_OPEN, value: 7600 }, { timestamp: CASH_LATEST, value: 7610 }],
  });
  return prepared;
};
const nativeResizeObserver = global.ResizeObserver;
let observers;

beforeEach(() => {
  observers = [];
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnect = jest.fn();
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
      this.callback([{ target, contentRect: { width: 884, height: 260 } }]);
    }
    unobserve() {}
  };
});

afterEach(() => {
  if (nativeResizeObserver) global.ResizeObserver = nativeResizeObserver;
  else delete global.ResizeObserver;
});

test('prepares verified basis points, exact-date ranges, metadata, and domain without mutating input', () => {
  const prepared = snapshot();
  prepared.chart.points.push({ timestamp: 'invalid', value: 9000 });
  prepared.chart.ath = { status: 'available', value: 6800, date: '2026-09-09' };
  freeze(prepared);
  const before = JSON.stringify(prepared);
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(prepared) });
  expect(result.current.plot.points).toEqual([
    { timestamp: TIME_A, value: 6400.25, high: 6401 }, { timestamp: TIME_B, value: 6430 },
  ]);
  expect(result.current.plot.selectedRiskRange).toEqual({ lrr: 6300, hrr: 6500 });
  expect(result.current.plot.domain).toEqual([6250, 6550]);
  expect(result.current.plot.oneDayPriceAxis.ticks).toEqual([6250, 6300, 6350, 6400, 6450, 6500, 6550]);
  expect(result.current.shell).toMatchObject({
    chartAvailable: true, chartDisplayPhase: 'ready', selectedRange: '1d', rangeAvailable: true,
    displayedValue: 6430, headerAsOf: '2026-09-11T21:00:00Z', athValue: 6800, athDate: '2026-09-09',
    athReference: { value: 6550, edge: 'top' },
  });
  expect(result.current.plot.intradayTimeAxis.hasSessionEndpoints).toBe(true);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([Date.parse('2026-09-11T13:30:00Z'), TIME_B]);
  expect(JSON.stringify(prepared)).toBe(before);
});

test('preserves latest variant range precedence and permits snapshot range only for the same chart date', () => {
  const prepared = snapshot();
  prepared.chart.dailyRanges = [];
  prepared.chart.rangeDates = ['2026-09-11'];
  const { result, rerender } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(prepared) });
  expect(result.current.plot.selectedRiskRange).toBe(prepared.riskRange);
  rerender(modelProps({ ...prepared, riskRange: { ...prepared.riskRange, date: '2026-09-10' } }));
  expect(result.current.plot.rangeAvailable).toBe(false);
  expect(result.current.plot.selectedRiskRange).toBeNull();
  rerender(modelProps({ ...prepared, chart: { ...prepared.chart, references: [{ label: 'LRR', value: 6320 }, { label: 'HRR', value: 6520 }] } }));
  expect(result.current.plot.selectedRiskRange).toEqual({ lrr: 6320, hrr: 6520 });
});

test.each(['chart', 'snapshot'])('limits the first 1D chart to its observations when the %s session window spans five days', (source) => {
  const prepared = snapshot();
  const wideWindow = { startAt: '2026-09-07T13:30:00Z', endAt: '2026-09-11T21:00:00Z' };
  if (source === 'chart') {
    prepared.chart.sessionWindow = wideWindow;
  } else {
    prepared.chart.sessionWindow = null;
    prepared.session = { ...prepared.session, openTime: wideWindow.startAt, closeTime: wideWindow.endAt };
  }
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared)) });
  expect(result.current.plot.chartAvailable).toBe(true);
  expect(result.current.plot.points).toHaveLength(2);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([TIME_A, TIME_B]);
  expect(result.current.plot.intradayTimeAxis.hasSessionEndpoints).toBe(false);
});

test('uses a valid fallback session when the chart carries a multi-day session window', () => {
  const prepared = snapshot();
  prepared.session = { state: 'closed', openTime: '2026-09-11T13:30:00Z', closeTime: '2026-09-11T21:00:00Z' };
  prepared.chart.sessionWindow = { startAt: '2026-09-07T13:30:00Z', endAt: '2026-09-11T21:00:00Z' };
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared)) });
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([Date.parse(prepared.session.openTime), TIME_B]);
  expect(result.current.plot.intradayTimeAxis.hasSessionEndpoints).toBe(true);
});

test('ignores a short session window from a different day before selecting the matching fallback', () => {
  const prepared = snapshot();
  prepared.chart.sessionWindow = { startAt: '2026-09-10T13:30:00Z', endAt: '2026-09-10T21:00:00Z' };
  prepared.session = { state: 'closed', openTime: '2026-09-11T13:30:00Z', closeTime: '2026-09-11T21:00:00Z' };
  render(<SpxRiskRangeChart snapshot={freeze(prepared)} nowMs={NOW} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-session-open-time', '2026-09-11T13:30:00.000Z');
  expect(canvas).toHaveAttribute('data-session-close-time', '2026-09-11T21:00:00.000Z');
});

test.each(['ready', 'loading', 'hidden'])('the first %s 1D plot matches a refreshed 5D-to-1D round trip without needing the toggle', (initialState) => {
  const prepared = freeze({ ...snapshot(), chart: {
    ...chart({ sessionWindow: { startAt: '2026-09-07T13:30:00Z', endAt: '2026-09-11T21:00:00Z' } }),
    variants: { '5d': multiDayChart() },
  } });
  const view = (currentSnapshot, chartRange = '1d', active = true) => (
    <PersistentSurface active={active} eager preserveLayoutWhenInactive>
      <SpxRiskRangeChart snapshot={currentSnapshot} chartRange={chartRange} nowMs={NOW} loading={!currentSnapshot} />
    </PersistentSurface>
  );
  const { rerender } = render(view(initialState === 'loading' ? null : prepared, '1d', initialState !== 'hidden'));
  if (initialState !== 'ready') rerender(view(prepared));
  const canvas = screen.getByTestId('spx-chart-canvas');
  const drawing = () => ({
    curves: [...canvas.querySelectorAll('.recharts-line-curve')].map((curve) => curve.getAttribute('d')),
    ticks: canvas.querySelector('.recharts-xAxis')?.textContent,
  });
  expect(screen.getByRole('tab', { name: '1D' })).toHaveAttribute('aria-selected', 'true');
  expect(canvas).toHaveAttribute('data-chart-point-count', '2');
  expect(canvas).not.toHaveAttribute('data-session-count');
  const firstDrawing = drawing();
  expect(firstDrawing.curves).toHaveLength(1);
  const refreshed = freeze({ ...prepared, chart: { ...prepared.chart, sessionWindow: null } });
  rerender(view(refreshed));
  expect(drawing()).toEqual(firstDrawing);
  rerender(view(refreshed, '5d'));
  expect(canvas).toHaveAttribute('data-session-count', '5');
  rerender(view(refreshed));
  expect(drawing()).toEqual(firstDrawing);
});

test('clears invalidated basis series and distinguishes first-load, terminal, retained-refresh, and dated-reference phases', () => {
  const prepared = snapshot();
  const { result, rerender } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(prepared) });
  ['fromCache', 'cachedOnly', 'cacheOnly', 'seeded', 'mock', 'stale', 'refreshFailed'].forEach((flag) => {
    rerender(modelProps({ ...prepared, chart: { ...prepared.chart, [flag]: true } }));
    expect(result.current.plot.chartAvailable).toBe(false);
    expect(result.current.plot.points).toEqual([]);
    expect(result.current.shell.chartDisplayPhase).toBe('unavailable');
  });
  rerender(modelProps(null, { loading: true }));
  expect(result.current.shell).toMatchObject({ chartIsLoading: true, chartDisplayPhase: 'first-load' });
  rerender(modelProps({ chart: { status: 'unavailable', reason: 'Provider offline.' } }, { loading: true }));
  expect(result.current.shell).toMatchObject({ chartIsLoading: false, chartDisplayPhase: 'unavailable' });
  rerender(modelProps({ ...prepared, chart: { ...prepared.chart, refreshing: true, refreshRetained: true } }));
  expect(result.current.shell).toMatchObject({ chartAvailable: true, chartRefreshActive: true, retainedChartRefresh: true, chartDisplayPhase: 'retained-refresh' });
  rerender(modelProps(prepared, { resourceRefreshing: true }));
  expect(result.current.shell.chartDisplayPhase).toBe('refreshing-with-chart');
  rerender(modelProps({ ...prepared, referenceOnly: true }, { resourceRefreshing: true }));
  expect(result.current.shell.chartDisplayPhase).toBe('dated-reference');
  rerender(modelProps(prepared, { nowMs: Date.parse(FUTURE) + 1 }));
  expect(result.current.plot.points).toEqual([]);
});

test('clips independently accepted contract history to the cash session and never substitutes a rejected series', () => {
  const prepared = snapshot();
  prepared.chartReferences = {
    basis: { symbol: 'SPX' },
    contract: {
      symbol: 'ESZ6', freshness: { status: 'delayed' },
      chart: chart({ points: [
        { timestamp: TIME_A - 1, value: 6390 }, { timestamp: TIME_A, value: 6420 },
        { timestamp: TIME_B, value: 6450 }, { timestamp: TIME_B + 1, value: 6460 },
      ] }),
    },
  };
  const { result, rerender } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared)) });
  expect(result.current.plot.contractPoints).toEqual([
    { timestamp: TIME_A - 1, value: 6390, contractValue: 6390 },
    { timestamp: TIME_A, value: 6420, contractValue: 6420 },
    { timestamp: TIME_B, value: 6450, contractValue: 6450 },
  ]);
  expect(result.current.shell).toMatchObject({ contractSeriesSymbol: 'ESZ6', contractSeriesState: 'delayed', contractChartPointCount: 3 });
  rerender(modelProps({ ...prepared, chartReferences: { ...prepared.chartReferences, contract: {
    ...prepared.chartReferences.contract, chart: { ...prepared.chartReferences.contract.chart, cacheOnly: true },
  } } }));
  expect(result.current.plot.points).toHaveLength(2);
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.shell.contractSeriesState).toBe('unavailable');
});

test('shows one direct Bitcoin line without the proxy-fit panel or binary settlement clock', () => {
  const prepared = snapshot();
  prepared.chart = chart({ source: 'kalshi_perpetual_public_candles' });
  prepared.perpetualReference = {
    referenceKind: 'perpetual_contract',
    instrument: { ticker: 'KXBTCPERP', priceUnit: 'USD/BTC' },
  };
  prepared.chartReferences = {
    basis: { symbol: 'BTC', chart: prepared.chart },
    // Even a leftover legacy role cannot duplicate the direct price line.
    contract: { symbol: 'BTC-USD', chart: prepared.chart },
  };
  prepared.proxyFit = { status: 'available', proxyLabel: 'COINBASE BTC-USD', underlyingLabel: 'BITCOIN' };
  render(<SpxRiskRangeChart
    snapshot={prepared}
    marketUi={MARKET_UI.bitcoin}
    nowMs={NOW}
    tradingClock={{ state: 'open', headline: 'OPEN · CLOSES IN 1h', title: 'Binary contract hours' }}
  />);
  expect(screen.getByTestId('spx-1d-price-line')).toBeInTheDocument();
  expect(screen.getByTestId('spx-1d-latest-reference')).toHaveTextContent(/^BTC /);
  expect(screen.queryByTestId('spx-1d-contract-line')).not.toBeInTheDocument();
  expect(screen.queryByTestId('spx-1d-contract-reference')).not.toBeInTheDocument();
  expect(screen.queryByText('PROXY FIT')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Selected contract trading hours')).not.toBeInTheDocument();
  expect(screen.getByText('KALSHI PERP')).toHaveAttribute('title', expect.stringContaining('KXBTCPERP'));
  expect(screen.getByText('BTC PERP')).toBeInTheDocument();
  expect(screen.getByTestId('spx-chart-canvas')).not.toHaveClass('has-proxy-fit');
});

test('labels the Ethereum Coinbase chart as a proxy separate from its prediction settlement input', () => {
  const prepared = snapshot();
  prepared.chart = chart({ source: 'coinbase_exchange_public_candles', fit: 'proxy' });
  render(<SpxRiskRangeChart snapshot={prepared} marketUi={MARKET_UI.ethereum} nowMs={NOW} />);
  expect(screen.getByText('COINBASE PROXY')).toHaveAttribute('title', expect.stringContaining('settlement input is shown above the contract ladder'));
});

test('keeps the SPX 1D plot on its cash session when verified ES overnight observations arrive', () => {
  const prepared = freeze(overnightEsSnapshot());
  const before = JSON.stringify(prepared);
  const props = modelProps(prepared, { nowMs: ES_NOW });
  const { result, rerender } = renderHook((next) => {
    const model = useRiskRangeChartModel(next);
    return { ...model, drawing: useRiskRangeChartPlot(model.plot) };
  }, { initialProps: props });
  const first = result.current;
  expect(first.plot.contractPoints).toEqual([]);
  expect(first.plot.points).toEqual(prepared.chart.points);
  expect(first.plot.intradayTimeAxis).toMatchObject({
    domain: [CASH_OPEN, CASH_CLOSE], hasSessionEndpoints: true, timeZone: 'America/New_York', clock24: true,
  });
  expect(first.plot.intradayRiskRangeDomain).toBeNull();
  expect(first.plot.contractLatest).toBeNull();
  expect(first.plot.contractChartAvailable).toBe(false);
  expect(JSON.stringify(prepared)).toBe(before);
  rerender({ ...props, nowMs: ES_NOW + 1000 });
  expect(result.current.drawing).toBe(first.drawing);
  expect(result.current.plot.contractPoints).toBe(first.plot.contractPoints);
  expect(result.current.plot.intradayTimeAxis).toBe(first.plot.intradayTimeAxis);
  rerender({ ...props, nowMs: Date.parse('2026-09-14T23:40:01Z') });
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
});

test('does not stretch a 1D cash chart across a weekend to reach the current ES session', () => {
  const prepared = overnightEsSnapshot();
  const previousFriday = Date.parse('2026-09-11T13:30:00Z');
  const previousFridayClose = Date.parse('2026-09-11T20:00:00Z');
  prepared.chart = chart({
    status: 'historical', availability: 'historical', historicalThroughDate: '2026-09-11',
    asOf: '2026-09-11T20:00:00Z', latestAt: '2026-09-11T20:00:00Z',
    points: [{ timestamp: previousFriday, value: 7600 }, { timestamp: previousFridayClose, value: 7610 }],
    dailyRanges: [dailyRange('2026-09-11')], sessionWindow: null,
  });
  prepared.session = { state: 'closed', openTime: '2026-09-11T13:30:00Z', closeTime: '2026-09-11T20:00:00Z' };
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: ES_NOW }) });
  expect(result.current.plot.points).toHaveLength(2);
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([previousFriday, previousFridayClose]);
});

test.each([
  ['provider bars', overnightEsSnapshot],
  ['restored history with native quote', checkpointWithCurrentEsSnapshot],
])('omits overnight %s from the cash-session chart and keeps its bands aligned', (name, prepare) => {
  render(<SpxRiskRangeChart snapshot={freeze(prepare())} nowMs={ES_NOW} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-contract-series-point-count', '0');
  expect(canvas.querySelectorAll('.recharts-line-curve')).toHaveLength(1);
  expect(screen.queryByTestId('spx-1d-contract-reference')).not.toBeInTheDocument();
  const xTicks = [...canvas.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')].map((node) => node.textContent);
  expect(xTicks.join(' ')).not.toMatch(/OPEN|CLOSE/);
  expect(xTicks[0]).toBe('09:30');
  expect(xTicks.at(-1)).toBe('16:00 ET');
  expect(xTicks.join(' ')).not.toMatch(/Sep|AM|PM/);
  const cashBoundaryLines = [...canvas.querySelectorAll('.recharts-reference-line-line')]
    .filter((line) => ['#dc2626', '#059669'].includes(line.getAttribute('stroke')));
  expect(cashBoundaryLines).toHaveLength(2);
  const cashCloseX = Number(cashBoundaryLines[0].getAttribute('x2'));
  cashBoundaryLines.forEach((line) => expect(Number(line.getAttribute('x2'))).toBeCloseTo(cashCloseX));
  const cashBands = [...canvas.querySelectorAll('.recharts-reference-area-rect')]
    .filter((area) => ['#fee2e2', '#dcfce7'].includes(area.getAttribute('fill')));
  expect(cashBands).toHaveLength(2);
  cashBands.forEach((area) => expect(Number(area.getAttribute('x')) + Number(area.getAttribute('width'))).toBeCloseTo(cashCloseX));
});

test('keeps restored ES history and native overnight quotes outside the SPX cash plot', () => {
  const prepared = freeze(checkpointWithCurrentEsSnapshot());
  const before = JSON.stringify(prepared);
  const { result, rerender } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(prepared, { nowMs: ES_NOW }) });
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
  expect(result.current.plot.intradayRiskRangeDomain).toBeNull();
  expect(JSON.stringify(prepared)).toBe(before);
  rerender(modelProps(prepared, { nowMs: Date.parse('2026-09-14T23:48:01Z') }));
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
});

test.each([
  ['checkpoint only', (reference) => { delete reference.includesVerifiedCurrentPoint; delete reference.currentSessionAsOf; reference.points.pop(); }],
  ['missing native point', (reference) => { reference.points.pop(); }],
  ['unverified native point', (reference) => { reference.points.at(-1).verifiedCurrent = false; }],
  ['proxy point', (reference) => { reference.points.at(-1).fit = 'proxy'; }],
  ['wrong point session', (reference) => { reference.points.at(-1).sessionDate = '2026-09-14'; }],
  ['stale point', (reference) => { reference.points.at(-1).stale = true; }],
  ['delayed point', (reference) => { reference.points.at(-1).availability = 'delayed'; }],
  ['synthetic point', (reference) => { reference.points.at(-1).source = 'synthetic'; }],
  ['invalid native price', (reference) => { reference.points.at(-1).value = Infinity; reference.latestValue = Infinity; }],
  ['mismatched observation time', (reference) => { reference.currentSessionAsOf = '2026-09-14T23:30:00Z'; }],
  ['mismatched latest source', (reference) => { reference.latestSource = 'ibkr_completed_history_checkpoint'; }],
  ['mismatched current source', (reference) => { reference.currentSessionSource = 'ibkr_completed_history_checkpoint'; }],
])('does not promote restored ES history with %s to a current overnight series', (name, invalidate) => {
  const prepared = checkpointWithCurrentEsSnapshot();
  invalidate(prepared.chartReferences.contract.chart);
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: ES_NOW }) });
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
});

test('shows only cash-hours ES observations and excludes overnight values from both price and time axes', () => {
  const prepared = cashSessionEsSnapshot();
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: CASH_NOW }) });
  expect(result.current.plot.contractPoints.map((point) => point.value)).toEqual([7610, 7620]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
  expect(result.current.plot.intradayTimeAxis.hasSessionEndpoints).toBe(true);
  expect(result.current.plot.intradayRiskRangeDomain).toBeNull();
  expect(result.current.plot.domain[1]).toBeLessThan(7900);
});

test('prefers the verified SPX cash window over an enclosing overnight chart window', () => {
  const prepared = cashSessionEsSnapshot();
  prepared.chart.sessionWindow = { startAt: '2026-09-13T22:00:00Z', endAt: '2026-09-14T20:00:00Z' };
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: CASH_NOW }) });
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
  expect(result.current.plot.contractPoints.map((point) => point.value)).toEqual([7610, 7620]);
});

test('keeps one cash day on the axis when overnight ES observations cross midnight', () => {
  const prepared = overnightEsSnapshot();
  const reference = prepared.chartReferences.contract.chart;
  Object.assign(reference, {
    asOf: '2026-09-15T05:00:00Z', latestAt: '2026-09-15T05:00:00Z', expiresAt: '2026-09-15T05:10:00Z',
    points: [...reference.points, { timestamp: Date.parse('2026-09-15T05:00:00Z'), value: 7630, sessionDate: '2026-09-15' }],
  });
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: Date.parse('2026-09-15T05:05:00Z') }) });
  const axis = result.current.plot.intradayTimeAxis;
  expect(axis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
  expect(axis.includeDate).toBeUndefined();
  expect(formatIntradayTimeTick(axis.domain[0], axis.step, axis)).toBe('09:30');
  expect(formatIntradayTimeTick(axis.domain[1], axis.step, axis)).toBe('16:00');
});

test.each(['fromCache', 'cacheOnly', 'seeded', 'mock', 'stale', 'refreshFailed', 'offline', 'disconnected'])(
  'omits otherwise overlapping cash-hours ES history when %s', (flag) => {
    const prepared = cashSessionEsSnapshot();
    prepared.chartReferences.contract.chart[flag] = true;
    const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: CASH_NOW }) });
    expect(result.current.plot.points).toHaveLength(2);
    expect(result.current.plot.contractPoints).toEqual([]);
    expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
    expect(result.current.plot.intradayRiskRangeDomain).toBeNull();
  },
);

test.each([
  ['other contract', (prepared) => { prepared.contracts.event.resolverSymbol = 'ESZ26'; }],
  ['other instrument', (prepared) => { prepared.chartReferences.contract.instrument.symbol = 'NQ'; }],
  ['unverified session', (prepared) => { prepared.chartReferences.contract.chart.sessionWindow.source = 'inferred'; }],
  ['historical session', (prepared) => { prepared.chartReferences.contract.chart.sessionMode = 'historical'; }],
  ['other provider', (prepared) => { prepared.chartReferences.contract.chart.source = 'synthetic'; }],
  ['future observation', (prepared) => { prepared.chartReferences.contract.chart.latestAt = '2026-09-15T01:00:00Z'; }],
  ['wrong session date', (prepared) => { prepared.chartReferences.contract.chart.sessionWindow.sessionDate = '2026-09-14'; }],
])('does not widen the cash axis for %s', (name, invalidate) => {
  const prepared = overnightEsSnapshot();
  invalidate(prepared);
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: ES_NOW }) });
  expect(result.current.plot.contractPoints).toEqual([]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
});

test('excludes contract observations outside the verified session, after its observation time, or carrying a different session date', () => {
  const prepared = cashSessionEsSnapshot();
  const reference = prepared.chartReferences.contract.chart;
  reference.points = [
    { timestamp: CASH_OPEN - 60_000, value: 9990, sessionDate: '2026-09-14' },
    ...reference.points,
    { timestamp: CASH_LATEST + 60_000, value: 9991, sessionDate: '2026-09-14' },
    { timestamp: CASH_LATEST - 60_000, value: 9992, sessionDate: '2026-09-13' },
  ];
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { nowMs: CASH_NOW }) });
  expect(result.current.plot.contractPoints.map((point) => point.value)).toEqual([7610, 7620]);
  expect(result.current.plot.intradayTimeAxis.domain).toEqual([CASH_OPEN, CASH_CLOSE]);
  expect(result.current.plot.domain[1]).toBeLessThan(8000);
});

test('uses only supported range variants and requires all requested sessions before rendering a multi-day chart', () => {
  const prepared = snapshot();
  prepared.chart.variants = { '5d': multiDayChart() };
  const { result, rerender } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(freeze(prepared), { chartRange: '5d' }) });
  expect(result.current.plot.chartAvailable).toBe(true);
  expect(result.current.plot.multiDayLayout.sessions.map((session) => session.date)).toEqual(DATES);
  expect(result.current.plot.multiDayLayout.closedDays.map(({ date, type }) => ({ date, type }))).toEqual([
    { date: '2026-09-05', type: 'weekend' }, { date: '2026-09-06', type: 'weekend' }, { date: '2026-09-07', type: 'holiday' },
  ]);
  expect(result.current.plot.points.filter((point) => point.value !== null)).toHaveLength(10);
  expect(result.current.shell.riskRangeStructureScore).toMatchObject({ status: 'available', highScore: 4, lowScore: 4, score: 8 });
  rerender(modelProps(prepared, { chartRange: '10d' }));
  expect(result.current.plot.points).toEqual([]);
  expect(result.current.shell.selectedRange).toBe('10d');
  rerender(modelProps(prepared, { chartRange: '5d', marketUi: MARKET_UI.nasdaq100 }));
  expect(result.current.shell.selectedRange).toBe('1d');
  expect(result.current.plot.points).toHaveLength(2);
  rerender(modelProps({ ...prepared, chart: { ...prepared.chart, variants: { '5d': {
    ...prepared.chart.variants['5d'], dailyRanges: prepared.chart.variants['5d'].dailyRanges.slice(1),
  } } } }, { chartRange: '5d' }));
  expect(result.current.plot.points).toEqual([]);
});

test.each([
  ['multi-day root without a 1D variant', (fiveDay) => ({ ...fiveDay, variants: { '5d': fiveDay } })],
  ['mismatched 1D variant', (fiveDay) => ({ ...fiveDay, variants: { '1d': fiveDay, '5d': fiveDay } })],
  ['multi-session variant labeled 1D', (fiveDay) => ({ ...fiveDay, variants: { '1d': { ...fiveDay, range: '1d' } } })],
  ['multi-day root without range metadata', (fiveDay) => ({ ...fiveDay, range: undefined, dailyRanges: [],
    points: fiveDay.points.map(({ timestamp, value }) => ({ timestamp, value })) })],
])('never displays a five-day history under the 1D tab: %s', (name, prepareChart) => {
  const fiveDay = { ...multiDayChart(), range: '5d' };
  const prepared = freeze({ ...snapshot(), chart: prepareChart(fiveDay) });
  const { result } = renderHook((props) => useRiskRangeChartModel(props), { initialProps: modelProps(prepared) });
  expect(result.current.shell.selectedRange).toBe('1d');
  expect(result.current.plot.chartAvailable).toBe(false);
  expect(result.current.plot.points).toEqual([]);
  expect(result.current.plot.contractPoints).toEqual([]);
});

test('switches from a five-day root to the explicit intraday variant without retaining prior sessions or contract history', () => {
  const oneDay = chart({ range: '1d' });
  const fiveDay = { ...multiDayChart(), range: '5d' };
  const prepared = freeze({
    ...snapshot(),
    chart: { ...fiveDay, variants: { '1d': oneDay, '5d': fiveDay } },
    chartReferences: { contract: { symbol: 'ESZ6', chart: fiveDay } },
  });
  const { rerender } = render(<SpxRiskRangeChart snapshot={prepared} chartRange="5d" nowMs={NOW} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-session-count', '5');
  expect(screen.getByTestId('spx-5d-price-line')).toBeInTheDocument();
  rerender(<SpxRiskRangeChart snapshot={prepared} chartRange="1d" nowMs={NOW} />);
  expect(canvas).toHaveAttribute('data-chart-range', '1d');
  expect(canvas).toHaveAttribute('data-chart-point-count', '2');
  expect(screen.getByTestId('spx-1d-price-line')).toBeInTheDocument();
  expect(screen.queryByTestId('spx-1d-contract-line')).not.toBeInTheDocument();
  expect(screen.queryByTestId('spx-5d-price-line')).not.toBeInTheDocument();
  expect(canvas.querySelector('.recharts-xAxis')).not.toHaveTextContent('SEP');
});

test('keeps memoized points, axes, labels, and actual Recharts element identity stable while only the clock changes', () => {
  const prepared = freeze(snapshot());
  const { result, rerender } = renderHook((props) => {
    const model = useRiskRangeChartModel(props);
    return { ...model, drawing: useRiskRangeChartPlot(model.plot) };
  }, { initialProps: modelProps(prepared, { tradingClock: { headline: 'CLOSED · 2 HOURS' } }) });
  const first = result.current;
  rerender(modelProps(prepared, { nowMs: NOW + 1000, tradingClock: { headline: 'CLOSED · 1 HOUR' } }));
  expect(result.current.shell.chartClockTiming).toBe('1 HOUR');
  expect(result.current.drawing).toBe(first.drawing);
  expect(result.current.plot.points).toBe(first.plot.points);
  expect(result.current.plot.domain).toBe(first.plot.domain);
  expect(result.current.plot.chartLabelOffsets).toBe(first.plot.chartLabelOffsets);
  expect(result.current.plot.intradayTimeAxis).toBe(first.plot.intradayTimeAxis);
});

test('keeps exact Gold settlement schedule identity stable across countdown ticks and removes it when identity expires', () => {
  const prepared = snapshot();
  const venueSelection = {
    id: 'kalshi', venue: {
      id: 'kalshi', catalog: { status: 'available', expiresAt: FUTURE, event: { ticker: 'KXGOLDD-26SEP1117' } },
      settlementBasis: {
        status: 'verified', instrumentScope: 'exact', instrument: 'Metal.Index.GOLD/USD',
        method: '1-minute close', observationAt: '2026-09-11T21:00:00Z', sourceName: 'Pyth',
        sourceUrl: 'https://www.pyth.network/',
      },
    },
    contracts: { event: { ticker: 'KXGOLDD-26SEP1117' } },
  };
  const props = modelProps(freeze(prepared), { marketUi: MARKET_UI.gold, venueSelection: freeze(venueSelection) });
  const { result, rerender } = renderHook((next) => useRiskRangeChartModel(next), { initialProps: props });
  const first = result.current.plot.goldSettlementScheduleVisible;
  expect(first).toMatchObject({ date: '2026-09-11', timestamp: TIME_B, sourceName: 'Pyth' });
  expect(result.current.plot.goldSettlementMarkers).toEqual([]);
  rerender({ ...props, nowMs: NOW + 1000 });
  expect(result.current.plot.goldSettlementScheduleVisible).toBe(first);
  rerender({ ...props, venueSelection: { ...venueSelection, venue: {
    ...venueSelection.venue, catalog: { ...venueSelection.venue.catalog, expiresAt: '2026-09-11T21:00:00Z' },
  } } });
  expect(result.current.plot.goldSettlementScheduleVisible).toBeNull();
});

test('renders the real one-day chart with existing range controls and retains its SVG through countdown updates', () => {
  const prepared = freeze(snapshot());
  const onChartRangeChange = jest.fn();
  const { rerender } = render(<SpxRiskRangeChart snapshot={prepared} nowMs={NOW} onChartRangeChange={onChartRangeChange}
    tradingClock={{ state: 'closed', headline: 'CLOSED · 2 HOURS', title: 'Verified contract schedule.' }} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-chart-range', '1d');
  expect(canvas).toHaveAttribute('data-chart-point-count', '2');
  expect(canvas).toHaveAttribute('data-rr-overlay-count', '1');
  const svg = canvas.querySelector('svg.recharts-surface');
  expect(svg).toBeInTheDocument();
  expect(screen.getByTestId('spx-1d-lrr-reference')).toHaveTextContent('LRR 6,300');
  expect(screen.getByTestId('spx-1d-hrr-reference')).toHaveTextContent('HRR 6,500');
  expect(screen.getByTestId('spx-1d-latest-reference')).toHaveTextContent('SPOT 6,430');
  fireEvent.click(screen.getByRole('tab', { name: '5D' }));
  expect(onChartRangeChange).toHaveBeenCalledWith('5d');
  rerender(<SpxRiskRangeChart snapshot={prepared} nowMs={NOW + 1000} onChartRangeChange={onChartRangeChange}
    tradingClock={{ state: 'closed', headline: 'CLOSED · 1 HOUR', title: 'Verified contract schedule.' }} />);
  expect(canvas.querySelector('svg.recharts-surface')).toBe(svg);
  expect(screen.getByText('1 HOUR')).toBeInTheDocument();
});

test('renders calendar closure annotations and cleans up only its own plot-width observer when leaving multi-day mode', () => {
  const prepared = snapshot();
  prepared.chart.variants = { '5d': multiDayChart() };
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 884, bottom: 260, width: 884, height: 260, toJSON: () => ({}),
  });
  const { rerender, unmount } = render(<SpxRiskRangeChart snapshot={freeze(prepared)} chartRange="5d" nowMs={NOW} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-session-count', '5');
  expect(canvas).toHaveAttribute('data-risk-range-high-structure-score', '4');
  expect(screen.getByTestId('spx-5d-market-closed-label-2026-09-07')).toHaveAttribute('aria-label',
    '2026-09-07: market closed holiday — Labor Day');
  expect(screen.getByTestId('spx-5d-closed-date-2026-09-05')).toHaveTextContent('SAT · SEP 5');
  const plotObserver = observers.find((observer) => observer.targets.some((target) => target.classList.contains('pm-spx-chart-plot')));
  expect(plotObserver).toBeDefined();
  expect(plotObserver.disconnect).not.toHaveBeenCalled();
  const count = observers.length;
  act(() => plotObserver.callback([]));
  expect(observers).toHaveLength(count);
  rerender(<SpxRiskRangeChart snapshot={prepared} chartRange="1d" nowMs={NOW} />);
  expect(plotObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(canvas).toHaveAttribute('data-chart-range', '1d');
  unmount();
  expect(plotObserver.disconnect).toHaveBeenCalledTimes(1);
});

test('measures the multi-day plot when its history arrives after the initial loading render', () => {
  const prepared = freeze({ ...snapshot(), chart: { ...chart(), variants: { '5d': multiDayChart() } } });
  const { rerender } = render(<SpxRiskRangeChart snapshot={null} chartRange="5d" nowMs={NOW} loading />);
  expect(observers.some((observer) => observer.targets.some((target) => target.classList.contains('pm-spx-chart-plot')))).toBe(false);
  rerender(<SpxRiskRangeChart snapshot={prepared} chartRange="5d" nowMs={NOW} />);
  expect(observers.some((observer) => observer.targets.some((target) => target.classList.contains('pm-spx-chart-plot')))).toBe(true);
});

test('removes the real chart after invalidation and preserves distinct loading and unavailable shells', () => {
  const prepared = snapshot();
  const { rerender } = render(<SpxRiskRangeChart snapshot={prepared} nowMs={NOW} />);
  expect(screen.getByTestId('spx-chart-canvas').querySelector('svg.recharts-surface')).toBeInTheDocument();
  rerender(<SpxRiskRangeChart snapshot={{ ...prepared, chart: { ...prepared.chart, refreshFailed: true } }} nowMs={NOW} />);
  const canvas = screen.getByTestId('spx-chart-canvas');
  expect(canvas).toHaveAttribute('data-chart-point-count', '0');
  expect(canvas.querySelector('svg.recharts-surface')).not.toBeInTheDocument();
  expect(within(canvas).getByText('SPX 1D DATA UNAVAILABLE')).toBeInTheDocument();
  rerender(<SpxRiskRangeChart snapshot={null} nowMs={NOW} loading />);
  expect(screen.getByRole('region', { name: 'Loading SPX Risk Range chart' })).toBeInTheDocument();
  expect(within(canvas).getByText('LOADING VERIFIED SPX 1D PRICE HISTORY…')).toBeInTheDocument();
  expect(canvas).toHaveAttribute('data-chart-display-phase', 'first-load');
});

test.each(['sp500', 'nasdaq100', 'gold', 'silver', 'wti', 'brent', 'bitcoin', 'ethereum'])(
  'keeps %s charts free of floating loading and refresh bubbles while preserving chart state',
  (marketId) => {
    const marketUi = MARKET_UI[marketId];
    const prepared = snapshot();
    const { rerender } = render(<SpxRiskRangeChart snapshot={null} marketUi={marketUi} nowMs={NOW} loading />);
    const canvas = screen.getByTestId('spx-chart-canvas');
    const expectNoBubble = () => {
      expect(canvas.querySelector('.pm-spx-chart-refresh-indicator, .app-loading')).not.toBeInTheDocument();
      expect(within(canvas).queryByText(/^(?:loading|refreshing)(?:…|\.{3})?$/i)).not.toBeInTheDocument();
    };
    expectNoBubble();
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'first-load');
    expect(canvas).toHaveAttribute('data-chart-point-count', '0');
    expect(within(canvas).getByText(`LOADING VERIFIED ${marketUi.symbol} 1D PRICE HISTORY…`)).toBeInTheDocument();

    rerender(<SpxRiskRangeChart snapshot={prepared} marketUi={marketUi} nowMs={NOW} />);
    const chartSvg = canvas.querySelector('svg.recharts-surface');
    expect(chartSvg).toBeInTheDocument();
    const refreshStates = [
      { snapshot: prepared, resourceRefreshing: true },
      { snapshot: { ...prepared, refresh: { state: 'refreshing' } } },
      { snapshot: { ...prepared, chart: { ...prepared.chart, refreshing: true, refreshRetained: true } }, retained: true },
      { snapshot: { ...prepared, chart: { ...prepared.chart, refreshPending: true, refreshRetained: true } }, retained: true },
    ];
    for (const { retained, ...props } of refreshStates) {
      rerender(<SpxRiskRangeChart {...props} marketUi={marketUi} nowMs={NOW} />);
      expectNoBubble();
      expect(canvas).toHaveAttribute('data-chart-refresh-status', 'refreshing');
      expect(canvas).toHaveAttribute('data-chart-display-phase', retained ? 'retained-refresh' : 'refreshing-with-chart');
      expect(canvas).toHaveAttribute('data-chart-point-count', '2');
      expect(canvas.querySelector('svg.recharts-surface')).toBe(chartSvg);
    }

    for (const pendingFlag of ['refreshing', 'refreshPending']) {
      rerender(<SpxRiskRangeChart snapshot={{ ...prepared, chart: { ...prepared.chart, [pendingFlag]: true } }} marketUi={marketUi} nowMs={NOW} />);
      expectNoBubble();
      expect(canvas).toHaveAttribute('data-chart-refresh-status', 'refreshing');
      expect(canvas).toHaveAttribute('data-chart-display-phase', 'first-load');
      expect(canvas).toHaveAttribute('data-chart-point-count', '0');
      expect(canvas.querySelector('svg.recharts-surface')).not.toBeInTheDocument();
      expect(within(canvas).getByText(`LOADING VERIFIED ${marketUi.symbol} 1D PRICE HISTORY…`)).toBeInTheDocument();
    }

    rerender(<SpxRiskRangeChart snapshot={{ ...prepared, chart: { ...prepared.chart, refreshFailed: true } }} marketUi={marketUi} nowMs={NOW} />);
    expectNoBubble();
    expect(canvas).toHaveAttribute('data-chart-display-phase', 'unavailable');
    expect(canvas).toHaveAttribute('data-chart-point-count', '0');
    expect(canvas.querySelector('svg.recharts-surface')).not.toBeInTheDocument();
    expect(within(canvas).getByText(`${marketUi.symbol} 1D DATA UNAVAILABLE`)).toBeInTheDocument();
  },
);

const TEN_DATES = ['2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', ...DATES];
const weekendSnapshot = () => ({
  ...snapshot(),
  chart: {
    ...chart(),
    variants: { '10d': { ...multiDayChart(TEN_DATES), expiresAt: '2026-09-15T00:00:00Z',
      ath: { status: 'available', value: 6550, date: '2026-08-13' },
    } },
  },
});

test('advances closed calendar dates at New York midnight without moving Friday prices or redrawing each clock tick', () => {
  const prepared = freeze(weekendSnapshot());
  const props = modelProps(prepared, { chartRange: '10d', nowMs: Date.parse('2026-09-13T03:59:59Z') });
  const { result, rerender } = renderHook((next) => {
    const model = useRiskRangeChartModel(next);
    return { ...model, drawing: useRiskRangeChartPlot(model.plot) };
  }, { initialProps: props });
  const saturday = result.current.plot;
  const saturdayStructure = result.current.shell.riskRangeStructureScore;
  expect(saturday.multiDayLayout.trailingGap.closedDays.map(({ date }) => date)).toEqual(['2026-09-12']);
  rerender({ ...props, nowMs: Date.parse('2026-09-13T04:00:00Z') });
  const sunday = result.current;
  expect(sunday.plot.multiDayLayout.trailingGap.closedDays.map(({ date }) => date)).toEqual(['2026-09-12', '2026-09-13']);
  expect(sunday.plot.latest).toMatchObject({ sessionDate: '2026-09-11', value: saturday.latest.value, timestamp: saturday.latest.timestamp });
  expect(sunday.shell.riskRangeStructureScore).toEqual(saturdayStructure);
  expect(sunday.plot.multiDayLayout.sessions).toHaveLength(10);
  rerender({ ...props, nowMs: Date.parse('2026-09-13T04:00:01Z') });
  expect(result.current.drawing).toBe(sunday.drawing);
  expect(result.current.plot.multiDayLayout).toBe(sunday.plot.multiDayLayout);
});

test('renders trailing weekend bars and dates with textures that resolve inside each mounted chart', () => {
  const prepared = freeze(weekendSnapshot());
  const nowMs = Date.parse('2026-09-14T03:00:00Z');
  const { container } = render(<>
    <div hidden><SpxRiskRangeChart snapshot={prepared} chartRange="10d" nowMs={nowMs} /></div>
    <SpxRiskRangeChart snapshot={prepared} chartRange="10d" nowMs={nowMs} />
  </>);
  const charts = screen.getAllByTestId('spx-chart-canvas');
  const patternIds = [];
  charts.forEach((canvas) => {
    const chartView = within(canvas);
    ['2026-09-12', '2026-09-13'].forEach((date) => {
      expect(chartView.getByTestId(`spx-10d-closed-date-${date}`)).toHaveTextContent(date.endsWith('12') ? '9/12' : '9/13');
      expect(chartView.getByTestId(`spx-10d-market-closed-label-${date}`)).toHaveTextContent('MARKET CLOSED WEEKEND');
      expect(chartView.queryByTestId(`spx-10d-session-${date}`)).not.toBeInTheDocument();
      expect(chartView.queryByTestId(`spx-10d-hrr-${date}`)).not.toBeInTheDocument();
    });
    const weekend = chartView.getByTestId('spx-10d-market-closed-2026-09-12');
    const holiday = chartView.getByTestId('spx-10d-market-closed-2026-09-07');
    [weekend, holiday].forEach((band) => {
      expect(band).toHaveAttribute('fill-opacity', '1');
      expect(Number(band.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(band.getAttribute('height'))).toBeGreaterThan(100);
      const patternId = band.getAttribute('fill').slice(5, -1);
      const pattern = [...canvas.querySelectorAll('pattern')].find(({ id }) => id === patternId);
      expect(pattern).toBeDefined();
      expect(pattern.querySelector('rect')).toBeInTheDocument();
      expect(pattern.querySelector('path')).toBeInTheDocument();
      patternIds.push(patternId);
    });
    expect(weekend.getAttribute('fill')).not.toBe(holiday.getAttribute('fill'));
    const axis = chartView.getByLabelText('10 SPX session dates and closed calendar dates');
    expect(axis.lastElementChild).toHaveTextContent('9/13');
    expect(axis.children).toHaveLength(24);
    const finalBand = chartView.getByTestId('spx-10d-market-closed-2026-09-13');
    const finalBandRight = Number(finalBand.getAttribute('x')) + Number(finalBand.getAttribute('width'));
    const latestLabel = chartView.getByTestId('spx-10d-latest-reference');
    expect(latestLabel).toHaveTextContent('6,419');
    expect(Number(latestLabel.getAttribute('x'))).toBeGreaterThan(finalBandRight);
    expect(Number(chartView.getByTestId('spx-10d-ath-reference').getAttribute('x'))).toBeGreaterThan(finalBandRight);
  });
  expect(new Set(patternIds).size).toBe(patternIds.length);
  expect(container.querySelectorAll('pattern')).toHaveLength(6);
});

test.each(['fromCache', 'cacheOnly', 'seeded', 'mock', 'stale', 'refreshFailed', 'disconnected'])(
  'calendar extension never enables a rejected %s chart', (flag) => {
    const prepared = weekendSnapshot();
    prepared.chart.variants['10d'][flag] = true;
    if (flag === 'disconnected') prepared.chart.variants['10d'].status = 'unavailable';
    render(<SpxRiskRangeChart snapshot={prepared} chartRange="10d" nowMs={Date.parse('2026-09-14T03:00:00Z')} />);
    expect(screen.getByText('SPX 10D DATA UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByTestId('spx-10d-closed-date-2026-09-13')).not.toBeInTheDocument();
    expect(screen.getByTestId('spx-chart-canvas')).toHaveAttribute('data-chart-point-count', '0');
  },
);
