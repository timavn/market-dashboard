import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PredictionMarketsHub, {
  buildRiskRangeThirdBands,
  calculatePositionPayoff,
  centerPredictionContractList,
  classifyPredictionMarketPosition,
  getWtiContractPresentation,
  getSummarySignalProvenance,
  normalizeForecastChartPoints,
  normalizeSpxCoverSnapshot,
  normalizeSummary,
  normalizeLivePositionsPayload,
  selectIbkrContractPositions,
} from '../PredictionMarketsHub';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import { resetSessionResourceStore } from '../../../utils/sessionResourceStore';
import useHedgaiTickResearch from '../../../hooks/useHedgaiTickResearch';

jest.mock('../../../hooks/useHedgaiTickResearch', () => ({ __esModule: true, default: jest.fn() }));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: { getPortfolioPredictionMarketPositions: jest.fn() },
}));

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: {
    getPredictionMarketsOverview: jest.fn(),
    getSpxPredictionMarketsOverview: jest.fn(),
    getSpxCoverSnapshot: jest.fn(),
  },
}));

const mockWtiWorkbench = jest.fn();
const mockSpxWorkbench = jest.fn();
const mockCpiWorkbench = jest.fn();
jest.mock('../WtiWorkbench', () => (props) => {
  mockWtiWorkbench(props);
  return <div>WTI Workbench</div>;
});
jest.mock('../PredictionMarketsSandbox', () => (props) => {
  mockSpxWorkbench(props);
  return <div>SPX Workbench</div>;
});
jest.mock('../PredictionMarkets', () => (props) => {
  mockCpiWorkbench(props);
  return <div>CPI Workbench</div>;
});

const chooseExchange = (card, label, option) => {
  fireEvent.click(within(card).getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

const summary = (overrides = {}) => ({
  seriesTicker: 'KXTEST',
  eventTicker: 'KXTEST-26JUL21',
  eventTitle: 'Test event',
  marketTicker: 'KXTEST-26JUL21-T100',
  marketTitle: 'Test above 100',
  closeTime: '2026-07-21T20:00:00.000Z',
  yesBid: 0.42,
  yesAsk: 0.45,
  yesBidSize: 12,
  yesAskSize: 18,
  spread: 0.03,
  marketCount: 20,
  completeBookCount: 17,
  volume24h: 1234,
  openInterest: 4321,
  freshness: { status: 'current', updatedAt: '2026-07-21T19:59:00.000Z' },
  lines: [
    { ticker: 'LINE-1', label: 'Above 2.8%', sortValue: 2.8, yesBid: 0.42, yesAsk: 0.45, noBid: 0.55, noAsk: 0.58, volume24h: 1250 },
    { ticker: 'LINE-2', label: 'Above 2.9%', sortValue: 2.9, yesBid: 0.35, yesAsk: 0.38, noBid: 0.62, noAsk: 0.65, volume24h: 830 },
  ],
  lineCount: 8,
  selection: { method: 'reference_centered', label: 'Centered on Hedgeye base case' },
  reference: {
    status: 'available',
    kind: 'forecast',
    label: 'Hedgeye base case',
    value: 2.85,
    source: 'hedgeye_inflation_nowcast',
  },
  chart: {
    status: 'available',
    source: 'kalshi_trade_api_v2',
    ticker: 'LINE-1',
    label: 'Above 2.8%',
    latestAt: '2026-07-21T20:00:00.000Z',
    points: [
      { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), close: 0.39 },
      { timestamp: Date.parse('2026-07-21T19:00:00.000Z'), close: 0.41 },
      { timestamp: Date.parse('2026-07-21T20:00:00.000Z'), close: 0.43 },
    ],
  },
  signal: {
    name: 'Risk Range',
    status: 'available',
    details: { date: '2026-07-21', lrr: 80, hrr: 86, trend: 'BULLISH' },
  },
  ...overrides,
});

test('normalizes CPI consensus points to the same displayed precision as forecast references', () => {
  expect(normalizeForecastChartPoints({
    unit: 'percent',
    points: [
      { timestamp: 3, value: 3.42 },
      { timestamp: 1, value: 3.52 },
      { timestamp: 2, value: 3.49 },
    ],
  })).toEqual([
    { timestamp: 1, value: 3.5 },
    { timestamp: 2, value: 3.5 },
    { timestamp: 3, value: 3.4 },
  ]);
});

test('builds pale chart bands from the verified lower and upper thirds of a Risk Range', () => {
  const bands = buildRiskRangeThirdBands([
    { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: 75, source: 'RiskRangeData' },
    { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: 87, source: 'RiskRangeData' },
  ]);

  expect(bands).toHaveLength(2);
  expect(bands[0]).toMatchObject({ key: 'lower-third', tone: 'low', y1: 75, y2: 79 });
  expect(bands[1]).toMatchObject({ key: 'upper-third', tone: 'high', y1: 83, y2: 87 });
});

test.each([
  [
    { status: 'stale', kind: 'underlying', label: 'LRR', tone: 'low', value: 75, source: 'RiskRangeData' },
    { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: 87, source: 'RiskRangeData' },
  ],
  [
    { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: 75, source: 'cache' },
    { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: 87, source: 'cache' },
  ],
  [
    { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: 75, source: 'mock' },
    { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: 87, source: 'mock' },
  ],
  [
    { status: 'available', kind: 'forecast', label: 'Low', tone: 'low', value: 2.7, source: 'hedgeye' },
    { status: 'available', kind: 'forecast', label: 'High', tone: 'high', value: 2.9, source: 'hedgeye' },
  ],
])('does not shade a chart from stale, cache, mock, or non-RR references', (...references) => {
  expect(buildRiskRangeThirdBands(references)).toEqual([]);
});

test.each(['stale', 'cache', 'mock', 'seed'])('rejects %s signal provenance even when marked available', (unsafeSource) => {
  expect(getSummarySignalProvenance({
    signal: {
      name: 'SPX Risk Range',
      status: 'available',
      source: unsafeSource,
      asOf: '2026-07-21',
      details: { ticker: 'SPX', date: '2026-07-21', trade: 'BULLISH' },
    },
  })).toMatchObject({
    verified: false,
    product: null,
    source: null,
    sourceDate: null,
  });
});

test.each([
  ['an offline provider', { status: 'offline' }],
  ['stale freshness metadata', { freshness: { status: 'stale' } }],
  ['a missing source date', { asOf: null, details: { ticker: 'SPX', trade: 'BULLISH' } }],
  ['an invalid source date', { asOf: '2026-02-31', details: { ticker: 'SPX', date: '2026-02-31', trade: 'BULLISH' } }],
])('rejects signal provenance with %s', (_case, overrides) => {
  expect(getSummarySignalProvenance({
    signal: {
      name: 'SPX Risk Range',
      status: 'available',
      source: 'RiskRangeData',
      asOf: '2026-07-21',
      details: { ticker: 'SPX', date: '2026-07-21', trade: 'BULLISH' },
      ...overrides,
    },
  }).verified).toBe(false);
});

test('maps the two WTI Kalshi series to their venue-native contract geometry', () => {
  expect(getWtiContractPresentation('KXWTI')).toMatchObject({
    cadence: 'daily',
    geometry: 'threshold',
    columnLabel: 'Above threshold',
  });
  expect(getWtiContractPresentation('KXWTIW')).toMatchObject({
    cadence: 'weekly',
    geometry: 'band',
    columnLabel: 'Settlement band',
  });
  expect(getWtiContractPresentation('KXOTHER')).toBeNull();
});

test('renders every CPI contract percentage with one decimal place', () => {
  const normalized = normalizeSummary({
    status: 'available',
    summary: summary({
      seriesTicker: 'KXCPIYOY',
      lines: [
        { ticker: 'CPI-30', label: 'Above 3%', sortValue: 3, yesBid: 0.5, yesAsk: 0.52, noBid: 0.48, noAsk: 0.5, volume24h: 100 },
        { ticker: 'CPI-31', label: 'Above 3.1%', sortValue: 3.1, yesBid: 0.4, yesAsk: 0.42, noBid: 0.58, noAsk: 0.6, volume24h: 90 },
      ],
    }),
  });

  expect(normalized.lines.map((line) => line.label)).toEqual(['Above 3.0%', 'Above 3.1%']);
});

test('selects exact verified-live IBKR contracts without mixing WTI cadences', () => {
  const positionsState = {
    status: 'live',
    positions: [
      { positionId: 'forecast', description: 'COMCO_081326_82_NO', quantity: 12, avgCost: 0.49 },
      { positionId: 'daily', description: 'KXWTI-26AUG1314-T81.49_NO', quantity: 8, avgCost: 0.22 },
      { positionId: 'weekly', description: 'KXWTIW-26AUG1414-B82_YES', quantity: 4, avgCost: 0.31 },
      { positionId: 'spx', description: 'KXINXU-26AUG13H1600-T7300_YES', quantity: 3, avgCost: 0.55 },
    ],
  };

  expect(selectIbkrContractPositions(positionsState, 'wti', 'daily').map((row) => row.id))
    .toEqual(['forecast', 'daily']);
  expect(selectIbkrContractPositions(positionsState, 'wti', 'weekly').map((row) => row.id))
    .toEqual(['weekly']);
  expect(selectIbkrContractPositions({ ...positionsState, status: 'unavailable' }, 'wti', 'daily'))
    .toEqual([]);
});

const OVERVIEW = {
  ok: true,
  fetchedAt: '2026-07-21T20:00:00.000Z',
  markets: {
    cpi: {
      status: 'available',
      summary: summary({
        seriesTicker: 'KXCPI',
        eventTitle: 'July CPI',
        lines: [
          { ticker: 'CPI-1', label: 'Above 2.8%', sortValue: 2.8, yesBid: 0.42, yesAsk: 0.45, noBid: 0.55, noAsk: 0.58, volume24h: 1250 },
          { ticker: 'CPI-2', label: 'Above 2.9%', sortValue: 2.9, yesBid: 0.35, yesAsk: 0.38, noBid: 0.62, noAsk: 0.65, volume24h: 830 },
        ],
        signal: {
          name: 'Hedgeye Inflation Nowcast',
          status: 'available',
          details: {
            forecastMonth: 'July 2026',
            metric: 'Headline CPI YoY',
            scenarios: [
              { key: 'downside', label: 'Downside', value: 2.7 },
              { key: 'base', label: 'Base Case', value: 2.8 },
              { key: 'upside', label: 'Upside', value: 2.9 },
            ],
          },
        },
        chart: {
          kind: 'forecast',
          status: 'available',
          source: 'cleveland_fed_inflation_nowcasting',
          label: 'CPI YoY nowcast',
          period: '2026-07',
          unit: 'percent',
          consensus: {
            status: 'available',
            kind: 'forecast',
            label: 'Cleveland Fed nowcast',
            value: 3.42,
            source: 'cleveland_fed_inflation_nowcasting',
          },
          references: [
            { status: 'available', kind: 'forecast', label: 'Low', tone: 'low', value: 2.7 },
            { status: 'available', kind: 'forecast', label: 'Base', tone: 'base', value: 2.8 },
            { status: 'available', kind: 'forecast', label: 'High', tone: 'high', value: 2.9 },
          ],
          points: [
            { timestamp: Date.parse('2026-07-20T12:00:00.000Z'), value: 3.38 },
            { timestamp: Date.parse('2026-07-21T12:00:00.000Z'), value: 3.42 },
          ],
        },
      }),
    },
    spx: {
      status: 'available',
      summary: summary({
        seriesTicker: 'KXINXU',
        eventTitle: 'AUG 5 · KALSHI DIRECT',
        lines: [
          { ticker: 'SPX-1', label: 'Above 7,300', sortValue: 7300, yesBid: 0.6, yesAsk: 0.63, noBid: 0.37, noAsk: 0.4, volume24h: 4200 },
          { ticker: 'SPX-2', label: 'Above 7,325', sortValue: 7325, yesBid: 0.51, yesAsk: 0.54, noBid: 0.46, noAsk: 0.49, volume24h: 3100 },
        ],
        signal: {
          name: 'SPX Risk Range',
          status: 'available',
          source: 'RiskRangeData',
          asOf: '2026-07-21',
          details: { ticker: 'SPX', date: '2026-07-21', lrr: 7280, hrr: 7340, trade: 'BULLISH', trend: 'BULLISH' },
        },
        reference: { status: 'available', kind: 'underlying', label: 'S&P 500', displayFormat: 'spx_contract', tone: 'spot', value: 7310, source: 'ibkr' },
        selection: { method: 'reference_centered', label: 'Centered on S&P 500' },
        chart: {
          kind: 'underlying',
          status: 'available',
          source: 'ibkr_historical_bars',
          label: 'S&P 500 index',
          unit: 'index',
          availability: 'current',
          points: [
            { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), value: 7305 },
            { timestamp: Date.parse('2026-07-21T19:00:00.000Z'), value: 7308 },
            { timestamp: Date.parse('2026-07-21T20:00:00.000Z'), value: 7310 },
          ],
          variants: {
            '5d': {
              kind: 'underlying',
              status: 'available',
              source: 'ibkr_historical_bars',
              range: '5d',
              label: 'S&P 500 index',
              unit: 'index',
              availability: 'historical',
              riskRangeStatus: 'partial',
              riskRangeMissingDates: ['2026-07-20'],
              points: [
                { timestamp: Date.parse('2026-07-17T18:00:00.000Z'), value: 7280 },
                { timestamp: Date.parse('2026-07-17T19:00:00.000Z'), value: 7290 },
                { timestamp: Date.parse('2026-07-20T18:00:00.000Z'), value: 7300 },
                { timestamp: Date.parse('2026-07-20T19:00:00.000Z'), value: 7310 },
                { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), value: 7305 },
                { timestamp: Date.parse('2026-07-21T19:00:00.000Z'), value: 7310 },
              ],
              dailyRanges: [
                {
                  date: '2026-07-17',
                  startAt: Date.parse('2026-07-17T18:00:00.000Z'),
                  endAt: Date.parse('2026-07-17T19:00:00.000Z'),
                  references: [
                    { label: 'LRR', tone: 'low', value: 7250 },
                    { label: 'HRR', tone: 'high', value: 7350 },
                  ],
                },
                {
                  date: '2026-07-20',
                  startAt: Date.parse('2026-07-20T18:00:00.000Z'),
                  endAt: Date.parse('2026-07-20T19:00:00.000Z'),
                  references: [
                    { label: 'LRR', tone: 'low', value: 7260 },
                    { label: 'HRR', tone: 'high', value: 7360 },
                  ],
                },
                {
                  date: '2026-07-21',
                  startAt: Date.parse('2026-07-21T18:00:00.000Z'),
                  endAt: Date.parse('2026-07-21T19:00:00.000Z'),
                  references: [
                    { label: 'LRR', tone: 'low', value: 7280 },
                    { label: 'HRR', tone: 'high', value: 7340 },
                  ],
                },
              ],
            },
          },
        },
      }),
    },
    wti: {
      daily: {
        status: 'available',
        summary: summary({
          seriesTicker: 'KXWTI',
          marketTicker: 'KXWTI-DAILY-T84',
          lines: [
            { ticker: 'WTI-1', label: 'Above $83', sortValue: 83, yesBid: 0.43, yesAsk: 0.44, noBid: 0.56, noAsk: 0.57, volume24h: 970 },
            { ticker: 'WTI-2', label: 'Above $84', sortValue: 84, yesBid: 0.31, yesAsk: 0.33, noBid: 0.67, noAsk: 0.69, volume24h: 640 },
          ],
          signal: {
            name: 'WTIC Risk Range',
            status: 'available',
            source: 'RiskRangeData',
            asOf: '2026-07-21',
            details: { ticker: 'WTIC', date: '2026-07-21', lrr: 82.5, hrr: 85, trade: 'BULLISH', trend: 'BULLISH' },
          },
          reference: { status: 'available', kind: 'underlying', label: 'WTI', displayFormat: 'wti_contract', value: 83.5, source: 'ibkr' },
          selection: { method: 'reference_centered', label: 'Centered on WTI' },
          chart: {
            kind: 'underlying',
            status: 'available',
            source: 'ibkr_historical_bars',
            label: 'WTI front-month price',
            unit: 'usd',
            availability: 'current',
            points: [
              { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), value: 83.1 },
              { timestamp: Date.parse('2026-07-21T19:00:00.000Z'), value: 83.4 },
              { timestamp: Date.parse('2026-07-21T20:00:00.000Z'), value: 83.5 },
            ],
            variants: {
              '5d': {
                kind: 'underlying',
                status: 'available',
                source: 'ibkr_historical_bars',
                range: '5d',
                label: 'WTI front-month price',
                unit: 'usd',
                availability: 'historical',
                rangeDates: ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21'],
                riskRangeStatus: 'available',
                riskRangeMissingDates: [],
                points: [
                  { timestamp: Date.parse('2026-07-15T18:00:00.000Z'), value: 81.5 },
                  { timestamp: Date.parse('2026-07-15T19:00:00.000Z'), value: 82.0 },
                  { timestamp: Date.parse('2026-07-16T18:00:00.000Z'), value: 82.1 },
                  { timestamp: Date.parse('2026-07-16T19:00:00.000Z'), value: 82.4 },
                  { timestamp: Date.parse('2026-07-17T18:00:00.000Z'), value: 82.5 },
                  { timestamp: Date.parse('2026-07-17T19:00:00.000Z'), value: 82.8 },
                  { timestamp: Date.parse('2026-07-20T18:00:00.000Z'), value: 82.7 },
                  { timestamp: Date.parse('2026-07-20T19:00:00.000Z'), value: 83.0 },
                  { timestamp: Date.parse('2026-07-21T18:00:00.000Z'), value: 83.1 },
                  { timestamp: Date.parse('2026-07-21T20:00:00.000Z'), value: 83.5 },
                ],
                dailyRanges: [
                  { date: '2026-07-15', startAt: Date.parse('2026-07-15T18:00:00.000Z'), endAt: Date.parse('2026-07-15T19:00:00.000Z'), references: [{ label: 'LRR', tone: 'low', value: 80.8 }, { label: 'HRR', tone: 'high', value: 82.9 }] },
                  { date: '2026-07-16', startAt: Date.parse('2026-07-16T18:00:00.000Z'), endAt: Date.parse('2026-07-16T19:00:00.000Z'), references: [{ label: 'LRR', tone: 'low', value: 81.2 }, { label: 'HRR', tone: 'high', value: 83.2 }] },
                  { date: '2026-07-17', startAt: Date.parse('2026-07-17T18:00:00.000Z'), endAt: Date.parse('2026-07-17T19:00:00.000Z'), references: [{ label: 'LRR', tone: 'low', value: 81.6 }, { label: 'HRR', tone: 'high', value: 83.5 }] },
                  { date: '2026-07-20', startAt: Date.parse('2026-07-20T18:00:00.000Z'), endAt: Date.parse('2026-07-20T19:00:00.000Z'), references: [{ label: 'LRR', tone: 'low', value: 81.9 }, { label: 'HRR', tone: 'high', value: 84.0 }] },
                  { date: '2026-07-21', startAt: Date.parse('2026-07-21T18:00:00.000Z'), endAt: Date.parse('2026-07-21T20:00:00.000Z'), references: [{ label: 'LRR', tone: 'low', value: 82.5 }, { label: 'HRR', tone: 'high', value: 85.0 }] },
                ],
              },
            },
          },
        }),
      },
      weekly: { status: 'unavailable', summary: null, error: 'No current weekly event.' },
    },
  },
};

function Harness({ initial = 'overview', initialCadence = 'daily', onClose = jest.fn() }) {
  const [active, setActive] = useState(initial);
  const [cadence, setCadence] = useState(initialCadence);
  return (
    <PredictionMarketsHub
      activeMarket={active}
      onActiveMarketChange={setActive}
      activeWtiCadence={cadence}
      onWtiCadenceChange={setCadence}
      selectedAccount="U1"
      onClose={onClose}
      portfolioData={{ accountId: 'U1' }}
    />
  );
}

describe('PredictionMarketsHub', () => {
  beforeEach(() => {
    useHedgaiTickResearch.mockReturnValue({ readings: {} });
    resetSessionResourceStore();
    jest.clearAllMocks();
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue(OVERVIEW);
    predictionMarketsIngestService.getSpxPredictionMarketsOverview.mockResolvedValue({ market: OVERVIEW.markets.spx });
    predictionMarketsIngestService.getSpxCoverSnapshot.mockResolvedValue({
      ok: true,
      mode: 'live',
      fetchedAt: new Date().toISOString(),
      seriesTicker: 'KXINXU',
      event: {
        ticker: 'KXINXU-26JUL21H1600',
        title: 'S&P 500 cash close',
        closeTime: '2026-07-21T20:00:00.000Z',
        availableOnBrokers: false,
        totalMarketCount: 2,
      },
      markets: OVERVIEW.markets.spx.summary.lines.map((line) => ({
        ticker: line.ticker,
        threshold: line.sortValue,
        yesBid: line.yesBid,
        yesAsk: line.yesAsk,
        noBid: line.noBid,
        noAsk: line.noAsk,
        volume24h: line.volume24h,
        nativeBook: { complete: true, derivedFields: [] },
      })),
      venue: {
        source: 'kalshi_trade_api_v2',
        snapshotType: 'direct_venue',
        volume24h: 7300,
      },
      executable: false,
      policy: { researchOnly: true },
    });
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }],
      positions: [],
      fetchedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    resetSessionResourceStore();
  });


  test('adds sourced Tick before Trade and Trend while disclosing the ETF proxy', async () => {
    useHedgaiTickResearch.mockReturnValue({ readings: { SPX: { verified: true, tick: 'BEARISH', tickEvidence: {
      source: 'HedgAI Signals', sourceTicker: 'SPY', sourceLabel: 'S&P 500', date: '2026-07-20',
      position: 'Short', matchType: 'proxy', basisRelationship: 'SPY ETF → SPX overview reference',
    } } } });
    render(<PredictionMarketsHub />);
    const tick = await screen.findByLabelText('S&P 500 tick signal');
    const trade = screen.getByLabelText('S&P 500 trade signal');
    expect(tick).toHaveTextContent('Ti(SPY) ↓');
    expect(tick.compareDocumentPosition(trade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tick).getByRole('img', { name: 'S&P 500 tick: Bearish' })).toHaveAttribute('data-publication-date', '2026-07-20');
  });
  test('renders the three cover cards and mounts the selected workbench only after opening it', async () => {
    render(<Harness />);

    const overview = await screen.findByTestId('prediction-markets-overview');
    expect(await within(overview).findByText('Above 2.8%')).toBeInTheDocument();
    expect(within(overview).getByText('Above 7,300')).toBeInTheDocument();
    expect(within(overview).getByText('Above $83')).toBeInTheDocument();
    expect(within(overview).queryByLabelText('CPI signals')).not.toBeInTheDocument();
    expect(within(overview).queryByLabelText('CPI trade signal')).not.toBeInTheDocument();
    expect(within(overview).queryByLabelText('CPI trend signal')).not.toBeInTheDocument();
    expect(within(overview).getByLabelText('S&P 500 trade signal')).toHaveTextContent('TRADE:');
    expect(within(overview).getByLabelText('S&P 500 trade signal')).toHaveTextContent('BULLISH');
    expect(within(overview).getByLabelText('S&P 500 trend signal')).toHaveTextContent('TREND:');
    expect(within(overview).getByLabelText('S&P 500 trend signal')).toHaveTextContent('BULLISH');
    expect(within(overview).getByLabelText('WTI trade signal')).toHaveTextContent('TRADE:');
    expect(within(overview).getByLabelText('WTI trade signal')).toHaveTextContent('BULLISH');
    expect(within(overview).getByLabelText('WTI trend signal')).toHaveTextContent('TREND:');
    expect(within(overview).getByLabelText('WTI trend signal')).toHaveTextContent('BULLISH');
    expect(within(overview).queryByText('No current weekly event.')).not.toBeInTheDocument();
    expect(within(overview).getAllByText('YES bid').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('YES ask').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('NO bid').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('NO ask').length).toBeGreaterThan(0);
    expect(within(overview).getAllByText('24h vol').length).toBeGreaterThan(0);
    expect(overview.querySelectorAll('.pm-hub-quote-cell.yes').length).toBeGreaterThan(6);
    expect(overview.querySelectorAll('.pm-hub-quote-cell.no').length).toBeGreaterThan(6);
    expect(overview.querySelector('.pm-hub-line').children).toHaveLength(6);
    expect(within(overview).getByLabelText('Low 2.7%')).toBeInTheDocument();
    expect(within(overview).getByLabelText('Base 2.8%')).toBeInTheDocument();
    expect(within(overview).getByLabelText('High 2.9%')).toBeInTheDocument();
    expect(within(overview).getByLabelText('Low 2.7%').closest('.pm-hub-reference-marker')).toHaveClass('low');
    expect(within(overview).getByLabelText('Base 2.8%').closest('.pm-hub-reference-marker')).toHaveClass('base');
    expect(within(overview).getByLabelText('Base 2.8%').closest('.pm-hub-reference-marker')).toHaveAttribute('data-center-marker', 'true');
    expect(within(overview).getByLabelText('High 2.9%').closest('.pm-hub-reference-marker')).toHaveClass('high');
    const lowReferenceMarker = within(overview).getByLabelText('Low 2.7%').closest('.pm-hub-reference-marker');
    expect(lowReferenceMarker.querySelector('.pm-hub-reference-rule')).not.toBeInTheDocument();
    const cpiRows = Array.from(overview.querySelector('.pm-hub-lines-scroll').children);
    const baseRowIndex = cpiRows.findIndex((row) => row.querySelector('[aria-label="Base 2.8%"]'));
    const matchingContractIndex = cpiRows.findIndex((row) => row.textContent.includes('Above 2.8%'));
    expect(cpiRows[baseRowIndex]).toHaveClass('pm-hub-reference-row', 'pm-hub-reference-marker');
    expect(cpiRows[baseRowIndex].querySelector('.pm-hub-reference-marker')).not.toBeInTheDocument();
    expect(baseRowIndex).toBeLessThan(matchingContractIndex);
    expect(within(overview).getByLabelText('$83.50')).toBeInTheDocument();
    expect(within(overview).getByLabelText('$83.50').closest('.pm-hub-reference-marker')).toHaveAttribute('data-reference-state', 'live');
    expect(within(overview).queryByText('Forecast')).not.toBeInTheDocument();
    expect(within(overview).queryByText('Hedgeye Inflation Nowcast')).not.toBeInTheDocument();
    expect(within(overview).queryByText('SPX Risk Range')).not.toBeInTheDocument();
    expect(within(overview).queryByText('WTIC Risk Range')).not.toBeInTheDocument();
    expect(within(overview).queryByText(/live lines/i)).not.toBeInTheDocument();
    expect(within(overview).queryByText(/Centered on/i)).not.toBeInTheDocument();
    expect(overview.querySelectorAll('.pm-hub-lines-scroll')).toHaveLength(3);
    expect(overview.querySelectorAll('.pm-hub-scroll-reference-marker')).toHaveLength(3);
    expect(overview.querySelectorAll('.pm-hub-scroll-reference-value')).toHaveLength(2);
    expect(Array.from(overview.querySelectorAll('.pm-hub-scroll-reference-value')).map(({ textContent }) => textContent))
      .toEqual(['7,310', '$83.50']);
    expect(overview.querySelectorAll('.pm-hub-scroll-reference-rail')).toHaveLength(3);
    expect(Array.from(overview.querySelectorAll('.pm-hub-scroll-reference-marker'))
      .every((marker) => marker.parentElement?.classList.contains('pm-hub-scroll-reference-rail')))
      .toBe(true);
    expect(within(overview).getByLabelText('CPI consensus forecast chart')).toBeInTheDocument();
    expect(within(overview).getByLabelText('Live 24H chart for S&P 500 index')).toBeInTheDocument();
    expect(within(overview).getByLabelText('Live 24H chart for WTI front-month price')).toBeInTheDocument();
    expect(overview.querySelectorAll('.pm-hub-chart--underlying')).toHaveLength(2);
    expect(overview.querySelectorAll('.pm-hub-chart--underlying .pm-hub-chart-meta')).toHaveLength(0);
    expect(screen.queryByRole('navigation', { name: 'Prediction market view' })).not.toBeInTheDocument();
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('SPX Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();

    const spxCard = screen.getByRole('region', { name: 'S&P 500 market summary' });
    expect(screen.getByTestId('spx-cover-card')).toBe(spxCard);
    const spxSpotSeparator = within(spxCard).getByLabelText('7,310').closest('.pm-hub-reference-marker');
    expect(spxSpotSeparator).toHaveClass('pm-hub-current-price-row', 'pm-hub-current-price-separator');
    expect(spxSpotSeparator).toHaveAttribute('role', 'listitem');
    expect(spxSpotSeparator.querySelector(':scope > .pm-hub-current-price-line')).toBeInTheDocument();
    expect(spxSpotSeparator).not.toHaveClass('pm-hub-reference-row');
    expect(spxSpotSeparator.previousElementSibling).toHaveTextContent('Above 7,300');
    expect(spxSpotSeparator.nextElementSibling).toHaveTextContent('Above 7,325');
    expect(spxCard.querySelector('.pm-hub-scroll-reference-marker .pm-hub-scroll-reference-value'))
      .toHaveTextContent('7,310');
    expect(within(spxCard).queryByText(/AUG 5/i)).not.toBeInTheDocument();
    expect(within(spxCard).queryByText(/KALSHI DIRECT/i)).not.toBeInTheDocument();
    expect(within(spxCard).getByRole('tab', { name: '1D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(spxCard).getByRole('tab', { name: '5D' })).not.toBeDisabled();
    fireEvent.click(within(spxCard).getByRole('tab', { name: '5D' }));
    expect(within(spxCard).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(spxCard).getByLabelText('Close 5D chart for S&P 500 index')).toBeInTheDocument();
    fireEvent.click(within(spxCard).getByRole('tab', { name: '1D' }));
    expect(within(spxCard).getByLabelText('Live 24H chart for S&P 500 index')).toBeInTheDocument();

    const wtiCard = screen.getByRole('region', { name: 'WTI market summary' });
    const wtiSpotSeparator = within(wtiCard).getByLabelText('$83.50').closest('.pm-hub-reference-marker');
    expect(wtiSpotSeparator).toHaveClass('pm-hub-current-price-row', 'pm-hub-current-price-separator');
    expect(wtiSpotSeparator).toHaveAttribute('role', 'listitem');
    expect(wtiSpotSeparator.querySelector(':scope > .pm-hub-current-price-line')).toBeInTheDocument();
    expect(wtiSpotSeparator).not.toHaveClass('pm-hub-reference-row');
    expect(wtiSpotSeparator.previousElementSibling).toHaveTextContent('Above $83');
    expect(wtiSpotSeparator.nextElementSibling).toHaveTextContent('Above $84');
    expect(wtiCard.querySelector('.pm-hub-scroll-reference-marker .pm-hub-scroll-reference-value'))
      .toHaveTextContent('$83.50');
    expect(within(wtiCard).queryByLabelText('KXWTI contract structure')).not.toBeInTheDocument();
    expect(within(wtiCard).queryByText('Daily “Above $X” contracts')).not.toBeInTheDocument();
    expect(within(wtiCard).queryByText('YES = above the line · NO = at or below the line')).not.toBeInTheDocument();
    expect(within(wtiCard).getByText('Above threshold')).toBeInTheDocument();
    expect(within(wtiCard).getByRole('tab', { name: '1D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(wtiCard).getByRole('tab', { name: '5D' })).not.toBeDisabled();
    fireEvent.click(within(wtiCard).getByRole('tab', { name: '5D' }));
    expect(within(wtiCard).getByRole('tab', { name: '5D' })).toHaveAttribute('aria-selected', 'true');
    expect(within(wtiCard).getByLabelText('Close 5D chart for WTI front-month price')).toBeInTheDocument();
    fireEvent.click(within(wtiCard).getByRole('tab', { name: '1D' }));
    expect(within(wtiCard).getByLabelText('Live 24H chart for WTI front-month price')).toBeInTheDocument();
    expect(within(wtiCard).getByRole('tab', { name: 'Daily' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(wtiCard).getByRole('tab', { name: 'Weekly' }));
    expect(within(wtiCard).getByRole('tab', { name: 'Weekly' })).toHaveAttribute('aria-selected', 'true');
    expect(within(wtiCard).getByText('No current weekly event.')).toBeInTheDocument();
    expect(within(wtiCard).queryByText('Above $83')).not.toBeInTheDocument();

    fireEvent.click(within(spxCard).getByRole('button', { name: /^S&P 500$/i }));
    expect(await screen.findByText('SPX Workbench')).toBeInTheDocument();
    expect(screen.getByTestId('prediction-markets-overview').closest('[data-surface-active]'))
      .toHaveAttribute('data-surface-active', 'false');
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
    expect(screen.queryByText('CPI Workbench')).not.toBeInTheDocument();
    expect(mockSpxWorkbench).toHaveBeenLastCalledWith(expect.objectContaining({
      embedded: true,
      sharedPositionsState: expect.objectContaining({ status: 'live' }),
    }));
    expect(screen.queryByRole('button', { name: 'All markets' })).not.toBeInTheDocument();
  });

  test('switches every cover card between Kalshi and verified-live IBKR contract identity', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }],
      positions: [
        {
          positionId: 'U1#forecast',
          accountId: 'U1',
          description: 'COMCO_081326_82_NO',
          quantity: 12,
          avgCost: 0.49,
        },
        {
          positionId: 'U1#daily',
          accountId: 'U1',
          description: 'KXWTI-26AUG1314-T81.49_NO',
          quantity: 8,
          avgCost: 0.22,
        },
        {
          positionId: 'U1#weekly',
          accountId: 'U1',
          description: 'KXWTIW-26AUG1414-B82_YES',
          quantity: 4,
          avgCost: 0.31,
        },
        {
          positionId: 'U1#spx',
          accountId: 'U1',
          description: 'KXINXU-26AUG13H1600-T7300_YES',
          quantity: 3,
          avgCost: 0.55,
        },
        {
          positionId: 'U1#cpi',
          accountId: 'U1',
          description: 'KXCPIYOY-26AUG-T3.1_NO',
          quantity: 7,
          avgCost: 0.41,
        },
      ],
      fetchedAt: new Date().toISOString(),
    });

    render(<Harness />);

    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    const spxCard = screen.getByRole('region', { name: 'S&P 500 market summary' });
    const wtiCard = screen.getByRole('region', { name: 'WTI market summary' });
    await within(wtiCard).findByText('Above $83');
    expect(within(cpiCard).getByLabelText('CPI exchange')).toHaveValue('kalshi');
    expect(within(spxCard).getByLabelText('S&P 500 exchange')).toHaveValue('kalshi');
    expect(within(wtiCard).getByLabelText('WTI exchange')).toHaveValue('kalshi');
    expect(within(wtiCard).getByLabelText('WTI exchange').tagName).toBe('BUTTON');
    expect(wtiCard.querySelector('select')).not.toBeInTheDocument();
    expect(within(wtiCard).getByLabelText('WTI selected contract')).toHaveTextContent('KXWTI');

    chooseExchange(wtiCard, 'WTI exchange', 'IBKR');
    const ibkrWtiContracts = within(wtiCard).getByRole('list', { name: 'Open IBKR WTI contracts' });
    expect(within(ibkrWtiContracts).getByText('COMCO_081326_82_NO')).toBeInTheDocument();
    expect(within(ibkrWtiContracts).getByText('KXWTI-26AUG1314-T81.49_NO')).toBeInTheDocument();
    expect(within(ibkrWtiContracts).getByText('ForecastEx')).toBeInTheDocument();
    expect(within(ibkrWtiContracts).queryByText('KXWTIW-26AUG1414-B82_YES')).not.toBeInTheDocument();
    expect(within(wtiCard).queryByText('Above $83')).not.toBeInTheDocument();

    chooseExchange(spxCard, 'S&P 500 exchange', 'IBKR');
    expect(within(spxCard).getByText('KXINXU-26AUG13H1600-T7300_YES')).toBeInTheDocument();

    chooseExchange(cpiCard, 'CPI exchange', 'IBKR');
    expect(within(cpiCard).getByText('KXCPIYOY-26AUG-T3.1_NO')).toBeInTheDocument();
  });

  test('does not expose cached IBKR position contracts through an exchange selector', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'stale',
      meta: { source: 'cache' },
      positions: [{ description: 'COMCO_081326_82_NO', quantity: 12, avgCost: 0.49 }],
    });

    render(<Harness />);

    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    chooseExchange(wtiCard, 'WTI exchange', 'IBKR');

    expect(within(wtiCard).queryByText('COMCO_081326_82_NO')).not.toBeInTheDocument();
    expect(await within(wtiCard).findByText('Verified-live IBKR positions are unavailable.')).toBeInTheDocument();
  });

  test('distinguishes weekly WTI bands from the daily KXWTI above-threshold ladder', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        wti: {
          ...OVERVIEW.markets.wti,
          weekly: {
            status: 'available',
            summary: summary({
              seriesTicker: 'KXWTIW',
              eventTicker: 'KXWTIW-26JUL2414',
              lines: [
                { ticker: 'KXWTIW-82', label: '$82–$82.99', sortValue: 82, yesBid: 0.19, yesAsk: 0.2, noBid: 0.8, noAsk: 0.81, volume24h: 6700 },
                { ticker: 'KXWTIW-83', label: '$83–$83.99', sortValue: 83, yesBid: 0.13, yesAsk: 0.14, noBid: 0.86, noAsk: 0.87, volume24h: 8500 },
              ],
              reference: { status: 'available', kind: 'underlying', label: 'WTI', displayFormat: 'wti_contract', value: 83.27, source: 'ibkr' },
            }),
          },
        },
      },
    });

    render(<Harness initialCadence="weekly" />);

    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    await within(wtiCard).findByText('$82–$82.99');
    const weeklyStructure = within(wtiCard).getByLabelText('KXWTIW contract structure');
    expect(weeklyStructure).toHaveTextContent('Weekly mutually exclusive price bands');
    expect(weeklyStructure).toHaveTextContent('A different Kalshi series from WTI Oil on Day');
    expect(within(wtiCard).getByText('Settlement band')).toBeInTheDocument();
    expect(within(wtiCard).getByText('$82–$82.99')).toBeInTheDocument();
    expect(within(wtiCard).queryByText('Above $83')).not.toBeInTheDocument();

    fireEvent.click(within(wtiCard).getByRole('button', { name: 'Show KXWTI “Above” lines' }));

    expect(within(wtiCard).getByRole('tab', { name: 'Daily' })).toHaveAttribute('aria-selected', 'true');
    expect(within(wtiCard).queryByLabelText('KXWTI contract structure')).not.toBeInTheDocument();
    expect(within(wtiCard).getByText('Above $83')).toBeInTheDocument();
    expect(within(wtiCard).queryByText('$82–$82.99')).not.toBeInTheDocument();
  });

  test('opens auditable product and source-date details from every SPX and WTI signal button', async () => {
    render(<Harness />);

    const spxTrade = await screen.findByRole('button', { name: 'S&P 500 trade signal' });
    [
      'S&P 500 trade signal',
      'S&P 500 trend signal',
      'WTI trade signal',
      'WTI trend signal',
    ].forEach((name) => {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-haspopup', 'dialog');
    });
    await waitFor(() => expect(spxTrade).toHaveTextContent('BULLISH'));
    expect(spxTrade).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(spxTrade);

    const spxSource = screen.getByRole('dialog', { name: 'Trade source' });
    expect(spxTrade).toHaveAttribute('aria-expanded', 'true');
    expect(within(spxSource).getByText('SPX Risk Range')).toBeInTheDocument();
    expect(within(spxSource).getByText('Jul 21, 2026')).toBeInTheDocument();
    expect(within(spxSource).getByText('RiskRangeData')).toBeInTheDocument();
    expect(within(spxSource).getByText('SPX')).toBeInTheDocument();
    expect(within(spxSource).getByText('Trade')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Trade source' })).not.toBeInTheDocument();
    expect(spxTrade).toHaveFocus();

    const wtiTrend = screen.getByRole('button', { name: 'WTI trend signal' });
    await waitFor(() => expect(wtiTrend).toHaveTextContent('BULLISH'));
    fireEvent.click(wtiTrend);
    const wtiSource = screen.getByRole('dialog', { name: 'Trend source' });
    expect(within(wtiSource).getByText('WTIC Risk Range')).toBeInTheDocument();
    expect(within(wtiSource).getByText('Jul 21, 2026')).toBeInTheDocument();
    expect(within(wtiSource).getByText('RiskRangeData')).toBeInTheDocument();
    expect(within(wtiSource).getByText('WTIC')).toBeInTheDocument();
    expect(within(wtiSource).getByText('Trend')).toBeInTheDocument();
  });

  test.each([
    ['spx', 'SPX Workbench', mockSpxWorkbench, { embedded: true }],
    ['wti', 'WTI Workbench', mockWtiWorkbench, { cadence: 'daily', onBack: expect.any(Function) }],
    ['cpi', 'CPI Workbench', mockCpiWorkbench, { embedded: true }],
  ])('mounts the controlled %s workbench without a shared All markets strip', async (market, label, workbenchMock, expectedProps) => {
    render(<Harness initial={market} />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByTestId('prediction-markets-overview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All markets' })).not.toBeInTheDocument();
    expect(workbenchMock).toHaveBeenLastCalledWith(expect.objectContaining(expectedProps));
  });

  test('returns from the WTI workbench to the prediction-markets overview', async () => {
    render(<Harness initial="wti" />);
    expect(await screen.findByText('WTI Workbench')).toBeInTheDocument();

    const latestWtiProps = mockWtiWorkbench.mock.calls[mockWtiWorkbench.mock.calls.length - 1][0];
    act(() => latestWtiProps.onBack());

    const overview = await screen.findByTestId('prediction-markets-overview');
    expect(overview.closest('[data-surface-active]')).toHaveAttribute('data-surface-active', 'true');
  });

  test('renders Low 3.4% as a direct row between Above 3.3% and Above 3.4%', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: {
          status: 'available',
          summary: summary({
            seriesTicker: 'KXCPI',
            eventTitle: 'July CPI',
            lines: [
              { ticker: 'CPI-33', label: 'Above 3.3%', sortValue: 3.3, yesBid: 0.54, yesAsk: 0.56, noBid: 0.44, noAsk: 0.46, volume24h: 62500 },
              { ticker: 'CPI-34', label: 'Above 3.4%', sortValue: 3.4, yesBid: 0.23, yesAsk: 0.28, noBid: 0.72, noAsk: 0.77, volume24h: 17000 },
            ],
            signal: {
              name: 'Hedgeye Inflation Nowcast',
              status: 'available',
              details: {
                scenarios: [
                  { key: 'downside', label: 'Downside', value: 3.4 },
                  { key: 'base', label: 'Base Case', value: 3.5 },
                  { key: 'upside', label: 'Upside', value: 3.6 },
                ],
              },
            },
          }),
        },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(await within(cpiCard).findByLabelText('Low 3.4%')).toBeInTheDocument();
    const rows = Array.from(cpiCard.querySelector('.pm-hub-lines-scroll').children);
    const above33Index = rows.findIndex((row) => row.textContent.includes('Above 3.3%'));
    const low34Index = rows.findIndex((row) => row.querySelector('[aria-label="Low 3.4%"]'));
    const above34Index = rows.findIndex((row) => row.textContent.includes('Above 3.4%'));

    expect(above33Index).toBeLessThan(low34Index);
    expect(low34Index).toBeLessThan(above34Index);
    expect(rows[low34Index]).toHaveClass('pm-hub-reference-row', 'pm-hub-reference-marker');
    expect(rows[low34Index].querySelector('.pm-hub-reference-marker')).not.toBeInTheDocument();
    expect(rows[low34Index].querySelector('.pm-hub-reference-rule')).not.toBeInTheDocument();
  });

  test('shows every verified-live position without hiding Other and keeps WTI as plain text', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'partial',
      meta: { source: 'ibkr_live', message: 'Account U2 could not be verified.' },
      accounts: [{ accountId: 'U1', status: 'live' }, { accountId: 'U2', status: 'unavailable' }],
      fetchedAt: new Date().toISOString(),
      positions: [
        { positionId: '1', symbol: 'KXWTIW', description: 'KXWTIW-26JUL24-B84.50_YES', accountId: 'U1', quantity: 4, avgCost: 0.32 },
        { positionId: '2', symbol: 'KXALIEN', description: 'Unmapped prediction contract', accountId: 'U1', quantity: 2, avgCost: 0.5 },
      ],
    });

    expect(normalizeSummary({
      status: 'historical',
      summary: {
        historicalOnly: true,
        freshness: { status: 'historical' },
        lines: [{ label: 'Above 7,485', settlementResult: 'YES', settlementValue: 7490.12 }],
      },
    })).toEqual(expect.objectContaining({ available: true, historicalOnly: true }));

    render(<Harness />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('KXWTIW-26JUL24-B84.50_YES')).toBeInTheDocument();
    expect(within(table).getByText('Unmapped prediction contract')).toBeInTheDocument();
    expect(within(table).getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Account U2 could not be verified.')).toBeInTheDocument();
    expect(within(table).getByText('WTI')).toHaveProperty('tagName', 'TD');
    expect(within(table).queryByRole('button', { name: 'WTI' })).not.toBeInTheDocument();
    expect(screen.queryByText('WTI Workbench')).not.toBeInTheDocument();
  });

  test('shows cost, gross payout, payout ratio, and a weighted total for live positions', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }, { accountId: 'U2', status: 'live' }],
      fetchedAt: new Date().toISOString(),
      positions: [
        { positionId: '1', symbol: 'KXCPIYOY', description: 'KXCPIYOY-26JUL-T3.5_YES', accountId: 'U1', quantity: 1999.25, avgCost: 0.09 },
        { positionId: '2', symbol: 'KXCPIYOY', description: 'KXCPIYOY-26JUL-T3.3_YES', accountId: 'U1', quantity: 5999.09, avgCost: 0.57 },
        { positionId: '3', symbol: 'KXCPIYOY', description: 'KXCPIYOY-26JUL-T3.4_YES', accountId: 'U1', quantity: 6394.3, avgCost: 0.21 },
        { positionId: '4', symbol: 'KXCPIYOY', description: 'KXCPIYOY-26JUL-T3.3_YES', accountId: 'U2', quantity: 499.17, avgCost: 0.62 },
      ],
    });

    const payoff = calculatePositionPayoff({ quantity: 10, avgCost: 0.33 });
    expect(payoff).toMatchObject({ payout: 10, valid: true });
    expect(payoff.cost).toBeCloseTo(3.3);
    expect(payoff.ratio).toBeCloseTo(10 / 3.3);
    expect(calculatePositionPayoff({ quantity: 10, avgCost: 0.33, costBasis: 3.5 })).toMatchObject({
      cost: 3.5,
      payout: 10,
      valid: true,
    });

    render(<Harness />);
    const positionsCard = await screen.findByRole('region', { name: 'Prediction-market positions' });
    const table = await within(positionsCard).findByRole('table');
    const scrollRegion = table.querySelector('.pm-hub-position-rows');
    expect(scrollRegion).toHaveAttribute('tabindex', '0');
    expect(scrollRegion).toHaveAttribute('aria-label', 'Open prediction-market contracts');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('$179.93');
    expect(rows[1]).toHaveTextContent('$1,999.25');
    expect(rows[1]).toHaveTextContent('1:11.1');
    expect(rows[2]).toHaveTextContent('$3,419.48');
    expect(rows[2]).toHaveTextContent('$5,999.09');
    expect(rows[2]).toHaveTextContent('1:1.8');
    expect(rows[3]).toHaveTextContent('$1,342.80');
    expect(rows[3]).toHaveTextContent('$6,394.30');
    expect(rows[3]).toHaveTextContent('1:4.8');
    expect(rows[4]).toHaveTextContent('$309.49');
    expect(rows[4]).toHaveTextContent('$499.17');
    expect(rows[4]).toHaveTextContent('1:1.6');

    const totalRow = rows[5];
    expect(totalRow).toHaveTextContent('Total (if all displayed positions win)');
    expect(totalRow).toHaveTextContent('$5,251.70');
    expect(totalRow).toHaveTextContent('$14,891.81');
    expect(totalRow).toHaveTextContent('1:2.8');
  });

  test('replaces the positions heading and live badge with quick market filters', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }],
      fetchedAt: new Date().toISOString(),
      positions: [
        { positionId: 'cpi', symbol: 'KXCPIYOY', description: 'CPI contract', accountId: 'U1', quantity: 2, avgCost: 0.25 },
        { positionId: 'spx', symbol: 'KXINXU', description: 'SP500 contract', accountId: 'U1', quantity: 3, avgCost: 0.35 },
        { positionId: 'wti', symbol: 'KXWTI', description: 'WTI contract', accountId: 'U1', quantity: 4, avgCost: 0.45 },
        { positionId: 'wti-forecastex', symbol: 'COMCO', description: 'COMCO_081326_82_NO', accountId: 'U1', quantity: 1056, avgCost: 0.49151515 },
        { positionId: 'other', symbol: 'KXOTHER', description: 'Other contract', accountId: 'U1', quantity: 5, avgCost: 0.55 },
      ],
    });

    render(<Harness />);
    const positionsCard = await screen.findByRole('region', { name: 'Prediction-market positions' });
    await within(positionsCard).findByRole('table');
    const filterGroup = within(positionsCard).getByRole('group', { name: 'Filter prediction-market positions' });
    expect(within(filterGroup).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filterGroup).getByRole('button', { name: 'CPI' })).toBeInTheDocument();
    expect(within(filterGroup).getByRole('button', { name: 'SP500' })).toBeInTheDocument();
    expect(within(filterGroup).getByRole('button', { name: 'WTI' })).toBeInTheDocument();
    expect(within(positionsCard).queryByText('IBKR Prediction-Market Positions')).not.toBeInTheDocument();
    expect(within(positionsCard).queryByText('Verified-live IBKR account positions only')).not.toBeInTheDocument();
    expect(within(positionsCard).queryByText('Live')).not.toBeInTheDocument();

    fireEvent.click(within(filterGroup).getByRole('button', { name: 'CPI' }));
    expect(within(filterGroup).getByRole('button', { name: 'CPI' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(positionsCard).getByText('CPI contract')).toBeInTheDocument();
    expect(within(positionsCard).queryByText('SP500 contract')).not.toBeInTheDocument();
    expect(within(positionsCard).queryByText('WTI contract')).not.toBeInTheDocument();
    expect(within(positionsCard).queryByText('Other contract')).not.toBeInTheDocument();

    fireEvent.click(within(filterGroup).getByRole('button', { name: 'SP500' }));
    expect(within(positionsCard).getByText('SP500 contract')).toBeInTheDocument();
    expect(within(positionsCard).queryByText('CPI contract')).not.toBeInTheDocument();

    fireEvent.click(within(filterGroup).getByRole('button', { name: 'WTI' }));
    expect(within(positionsCard).getByText('WTI contract')).toBeInTheDocument();
    expect(within(positionsCard).getByText('COMCO_081326_82_NO')).toBeInTheDocument();
    expect(within(positionsCard).getByText('ForecastEx')).toBeInTheDocument();
    expect(within(positionsCard).queryByText('SP500 contract')).not.toBeInTheDocument();

    fireEvent.click(within(filterGroup).getByRole('button', { name: 'All' }));
    expect(within(positionsCard).getByText('Other contract')).toBeInTheDocument();
  });

  test('leaves payoff metrics and the aggregate unavailable for invalid or short positions', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      accounts: [{ accountId: 'U1', status: 'live' }],
      fetchedAt: new Date().toISOString(),
      positions: [
        { positionId: 'invalid', symbol: 'KXCPIYOY', description: 'Missing cost', accountId: 'U1', quantity: 2 },
        { positionId: 'short', symbol: 'KXCPIYOY', description: 'Short contract', accountId: 'U1', quantity: -1, avgCost: 0.4 },
      ],
    });

    expect(calculatePositionPayoff({ quantity: -1, avgCost: 0.4 })).toEqual({
      cost: null,
      payout: null,
      ratio: null,
      valid: false,
    });

    render(<Harness />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent(/Missing cost/);
    expect(rows[1]).toHaveTextContent(/—/);
    expect(rows[2]).toHaveTextContent(/Short contract/);
    expect(rows[2]).toHaveTextContent(/—/);
    expect(rows[3]).toHaveTextContent('Total unavailable');
    expect(rows[3]).toHaveTextContent(/—/);
    expect(rows[3]).not.toHaveTextContent(/1:/);
  });

  test.each([
    [{ status: 'live', meta: { source: 'cache' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ status: 'stale', meta: { source: 'ibkr_live' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ status: 'live', meta: { source: 'mock' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
    [{ meta: { source: 'portfolio_fallback' }, positions: [{ symbol: 'KXWTI', quantity: 1 }] }],
  ])('renders no position rows for non-live payload %#', async (payload) => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue(payload);
    render(<Harness />);

    expect(await screen.findByText('Verified-live IBKR positions are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('keeps an Overview outage local while positions and market navigation remain usable', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockRejectedValue(new Error('Venue offline'));
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      fetchedAt: new Date().toISOString(),
      positions: [{ positionId: '1', symbol: 'KXINXU', description: 'SPX threshold', quantity: 1 }],
    });

    render(<Harness />);
    expect(await screen.findByText(/Market summaries are unavailable: Venue offline/)).toBeInTheDocument();
    expect(screen.getByText('SPX threshold')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'S&P 500 market summary' })).toBeInTheDocument();
  });

  test('localizes a stale market summary without suppressing the other markets', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: { status: 'available', summary: summary({ freshness: { status: 'stale' } }) },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(within(cpiCard).getByText('No verified current lines are available.')).toBeInTheDocument();
    expect(screen.queryByText('Above 2.8%')).not.toBeInTheDocument();
    expect(await screen.findByText('Above 7,300')).toBeInTheDocument();
  });

  test('removes the KXWTI daily explainer while stale venue quotes fail closed', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        wti: {
          ...OVERVIEW.markets.wti,
          daily: {
            status: 'available',
            summary: summary({
              seriesTicker: 'KXWTI',
              freshness: { status: 'stale' },
            }),
          },
        },
      },
    });

    render(<Harness />);

    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    expect(within(wtiCard).queryByLabelText('KXWTI contract structure')).not.toBeInTheDocument();
    expect(within(wtiCard).queryByText('Daily “Above $X” contracts')).not.toBeInTheDocument();
    expect(within(wtiCard).queryByText('YES = above the line · NO = at or below the line')).not.toBeInTheDocument();
    expect(within(wtiCard).getByText('No verified current lines are available.')).toBeInTheDocument();
    expect(within(wtiCard).queryByText('Above $83')).not.toBeInTheDocument();
  });

  test('uses a gray neutral trend pill only for an explicit neutral signal', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        wti: {
          ...OVERVIEW.markets.wti,
          daily: {
            ...OVERVIEW.markets.wti.daily,
            summary: summary({
              signal: {
                name: 'WTIC Risk Range',
                status: 'available',
                source: 'RiskRangeData',
                asOf: '2026-07-21',
                details: { ticker: 'WTIC', date: '2026-07-21', trade: 'BEARISH', trend: 'NEUTRAL' },
              },
            }),
          },
        },
      },
    });

    render(<Harness />);
    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    await within(wtiCard).findByText('NEUTRAL');
    const tradeIndicator = within(wtiCard).getByLabelText('WTI trade signal');
    const trendIndicator = within(wtiCard).getByLabelText('WTI trend signal');
    expect(tradeIndicator).toHaveTextContent('TRADE:');
    expect(within(tradeIndicator).getByText('BEARISH')).toHaveClass('bearish');
    expect(trendIndicator).toHaveTextContent('TREND:');
    expect(within(trendIndicator).getByText('NEUTRAL')).toHaveClass('neutral');
  });

  test('keeps the SPX cover in the quote layout for a verified closed snapshot', async () => {
    predictionMarketsIngestService.getSpxCoverSnapshot.mockResolvedValue({
      ok: true,
      mode: 'closed',
      historicalOnly: true,
      executable: false,
      fetchedAt: new Date().toISOString(),
      seriesTicker: 'KXINXU',
      event: {
        ticker: 'KXINXU-26JUL20H1600',
        title: 'S&P 500 cash close',
        closeTime: '2026-07-20T20:00:00.000Z',
        totalMarketCount: 1,
      },
      markets: [{
        ticker: 'SPX-CLOSE-1',
        threshold: 7485,
        yesBid: 0.61,
        yesAsk: 0.65,
        noBid: 0.35,
        noAsk: 0.39,
        volume24h: 1200,
        nativeBook: { complete: true, derivedFields: ['noBid', 'noAsk'] },
      }],
      venue: {
        source: 'kalshi_trade_api_v2',
        snapshotType: 'historical_quote_close',
        quoteAsOf: '2026-07-20T20:00:00.000Z',
      },
      policy: { historicalOnly: true },
    });

    render(<Harness />);
    const spxCard = await screen.findByRole('region', { name: 'S&P 500 market summary' });
    expect(await within(spxCard).findByText('Above 7,485')).toBeInTheDocument();
    expect(within(spxCard).queryByText('JUL 20 CLOSE')).not.toBeInTheDocument();
    expect(within(spxCard).getByText('NO ask')).toBeInTheDocument();
    expect(within(spxCard).getByText('Above 7,485')).toBeInTheDocument();
    expect(within(spxCard).queryByText('Previous contract · settled')).not.toBeInTheDocument();
    expect(within(spxCard).queryByText('Outcome')).not.toBeInTheDocument();
  });

  test('uses the direct live SPX ladder for WTI-style quote columns on the cover card', async () => {
    predictionMarketsIngestService.getSpxPredictionMarketsOverview.mockResolvedValue({
      market: {
        status: 'unavailable',
        summary: null,
        error: 'The chart response is unavailable.',
      },
    });
    predictionMarketsIngestService.getSpxCoverSnapshot.mockResolvedValue({
      ok: true,
      mode: 'live',
      fetchedAt: new Date().toISOString(),
      seriesTicker: 'KXINXU',
      event: {
        ticker: 'KXINXU-26JUL21H1600',
        title: 'S&P 500 cash close',
        closeTime: '2026-07-21T20:00:00.000Z',
        totalMarketCount: 1,
        availableOnBrokers: false,
      },
      markets: [
        {
          ticker: 'SPX-7300',
          threshold: 7300,
          yesBid: 0.6,
          yesAsk: 0.63,
          noBid: 0.37,
          noAsk: 0.4,
          volume24h: 4200,
          nativeBook: { complete: true, derivedFields: [] },
        },
      ],
      venue: {
        source: 'kalshi_trade_api_v2',
        snapshotType: 'direct_venue',
        volume24h: 4200,
        volumeTotal: 9000,
        openInterest: 5000,
      },
      executable: false,
      policy: { researchOnly: true },
    });

    render(<Harness />);
    const spxCard = await screen.findByRole('region', { name: 'S&P 500 market summary' });
    expect(await within(spxCard).findByText('Current line')).toBeInTheDocument();
    expect(within(spxCard).getByText('YES bid')).toBeInTheDocument();
    expect(within(spxCard).getByText('YES ask')).toBeInTheDocument();
    expect(within(spxCard).getByText('NO bid')).toBeInTheDocument();
    expect(within(spxCard).getByText('NO ask')).toBeInTheDocument();
    expect(within(spxCard).getByText('24h vol')).toBeInTheDocument();
    const row = within(spxCard).getByText('Above 7,300').closest('.pm-hub-line');
    expect(row).toHaveTextContent('60¢');
    expect(row).toHaveTextContent('63¢');
    expect(row).toHaveTextContent('37¢');
    expect(row).toHaveTextContent('40¢');
    expect(row).toHaveTextContent('4.2K');
  });

  test('keeps the quote ladder independent from a later historical chart response', async () => {
    const historicalSpx = {
      status: 'historical',
      summary: {
        historicalOnly: true,
        historicalLabel: 'Previous contract · settled',
        lines: [{ label: 'Above 7,485', settlementResult: 'YES', settlementValue: 7490.12 }],
      },
    };
    let resolveCover;
    predictionMarketsIngestService.getSpxPredictionMarketsOverview.mockResolvedValue({ market: historicalSpx });
    predictionMarketsIngestService.getSpxCoverSnapshot.mockImplementation(() => new Promise((resolve) => {
      resolveCover = resolve;
    }));

    render(<Harness />);
    const spxCard = await screen.findByTestId('spx-cover-card');
    expect(await within(spxCard).findByText('YES bid')).toBeInTheDocument();
    expect(within(spxCard).queryByText('Previous contract · settled')).not.toBeInTheDocument();

    await act(async () => {
      resolveCover({
        ok: true,
        mode: 'live',
        fetchedAt: new Date().toISOString(),
        seriesTicker: 'KXINXU',
        event: {
          ticker: 'KXINXU-26JUL21H1600',
          title: 'S&P 500 cash close',
          closeTime: '2026-07-21T20:00:00.000Z',
          availableOnBrokers: false,
          totalMarketCount: 1,
        },
        markets: [{
          ticker: 'SPX-7300',
          threshold: 7300,
          yesBid: 0.6,
          yesAsk: 0.63,
          noBid: 0.37,
          noAsk: 0.4,
          volume24h: 4200,
          nativeBook: { complete: true, derivedFields: [] },
        }],
        venue: { source: 'kalshi_trade_api_v2', snapshotType: 'direct_venue', volume24h: 4200 },
        executable: false,
        policy: { researchOnly: true },
      });
    });

    expect(await within(spxCard).findByText('YES bid')).toBeInTheDocument();
    expect(within(spxCard).queryByText('Previous contract · settled')).not.toBeInTheDocument();
  });

  test('keeps the verified WTI marker visible when its contract ladder is unavailable', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        wti: {
          ...OVERVIEW.markets.wti,
          daily: {
            status: 'unavailable',
            summary: null,
            error: 'Kalshi rate limit (429)',
            reference: {
              status: 'available',
              kind: 'underlying',
              label: 'WTI',
              displayFormat: 'wti_contract',
              value: 84.08,
              source: 'ibkr',
            },
          },
        },
      },
    });

    render(<Harness />);
    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    await waitFor(() => expect(wtiCard.querySelector('.pm-hub-reference-marker')).not.toBeNull());
    const marker = wtiCard.querySelector('.pm-hub-reference-marker');
    expect(marker).toHaveClass('underlying', 'spot');
    expect(marker.querySelector('strong')).toHaveTextContent('$84.08');
    expect(within(wtiCard).getByText('Kalshi rate limit (429)')).toBeInTheDocument();
  });

  test('uses the verified SPX chart endpoint when the spot reference is unavailable', async () => {
    predictionMarketsIngestService.getSpxPredictionMarketsOverview.mockResolvedValue({
      market: {
        ...OVERVIEW.markets.spx,
        summary: {
          ...OVERVIEW.markets.spx.summary,
          reference: { status: 'unavailable', reason: 'No verified reference is available.' },
        },
      },
    });

    render(<Harness />);
    const spxCard = await screen.findByTestId('spx-cover-card');
    await waitFor(() => expect(spxCard.querySelector('.pm-hub-scroll-reference-marker')).not.toBeNull());

    const referenceRow = spxCard.querySelector('.pm-hub-reference-marker');
    expect(referenceRow).toHaveClass('underlying', 'spot');
    expect(referenceRow).toHaveAttribute('data-center-marker', 'true');
    expect(referenceRow.querySelector('strong')).toHaveTextContent('7,310');
  });

  test('labels the exact WTI contract close when live price is unavailable', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        wti: {
          ...OVERVIEW.markets.wti,
          daily: {
            ...OVERVIEW.markets.wti.daily,
            summary: {
              ...OVERVIEW.markets.wti.daily.summary,
              reference: {
                status: 'available',
                kind: 'underlying',
                label: 'WTI last close',
                displayFormat: 'wti_contract',
                tone: 'close',
                value: 84.08,
                source: 'ibkr_historical_daily_close',
                historicalOnly: true,
              },
            },
          },
        },
      },
    });

    render(<Harness />);
    const wtiCard = await screen.findByRole('region', { name: 'WTI market summary' });
    await waitFor(() => expect(wtiCard.querySelector('.pm-hub-reference-marker')).not.toBeNull());
    const marker = wtiCard.querySelector('.pm-hub-reference-marker');
    expect(marker).toHaveClass('pm-hub-current-price-row', 'underlying', 'close', 'historical');
    expect(marker).not.toHaveClass('historical-layout');
    expect(marker).toHaveAttribute('data-reference-state', 'close');
    expect(marker.querySelector('strong')).toHaveTextContent('$84.08');
  });

  test('does not render cache-backed data as a live intraday chart', async () => {
    predictionMarketsIngestService.getPredictionMarketsOverview.mockResolvedValue({
      ...OVERVIEW,
      markets: {
        ...OVERVIEW.markets,
        cpi: {
          status: 'available',
          summary: summary({
            chart: {
              kind: 'forecast',
              status: 'available',
              source: 'cache',
              label: 'Above 2.8%',
              points: [{ timestamp: Date.parse('2026-07-21T20:00:00.000Z'), value: 3.42 }],
            },
          }),
        },
      },
    });

    render(<Harness />);
    const cpiCard = await screen.findByRole('region', { name: 'CPI market summary' });
    expect(await within(cpiCard).findByText('No current Cleveland Fed CPI consensus nowcast is available.')).toBeInTheDocument();
    expect(within(cpiCard).queryByLabelText('CPI consensus forecast chart')).not.toBeInTheDocument();
  });

  test('removes the blank overview header and its manual refresh control', async () => {
    render(<Harness />);
    expect(await screen.findByText('Above 2.8%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh prediction markets overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All markets' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Prediction Markets' })).not.toBeInTheDocument();
  });

  test('clears prior positions immediately when the selected account changes', async () => {
    let resolveSecond;
    MarketDataService.getPortfolioPredictionMarketPositions
      .mockResolvedValueOnce({
        status: 'live', meta: { source: 'ibkr_live' }, fetchedAt: new Date().toISOString(), positions: [{ positionId: '1', symbol: 'KXCPI', description: 'Old account CPI', quantity: 1 }],
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const { rerender } = render(
      <PredictionMarketsHub activeMarket="overview" onActiveMarketChange={jest.fn()} selectedAccount="U1" onClose={jest.fn()} />,
    );
    expect(await screen.findByText('Old account CPI')).toBeInTheDocument();

    rerender(<PredictionMarketsHub activeMarket="overview" onActiveMarketChange={jest.fn()} selectedAccount="U2" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Old account CPI')).not.toBeInTheDocument());
    expect(screen.getByText('Loading live IBKR positions...')).toBeInTheDocument();

    await act(async () => {
      resolveSecond({ status: 'live', meta: { source: 'ibkr_live' }, fetchedAt: new Date().toISOString(), positions: [] });
    });
  });

  test('clears verified rows synchronously when the dashboard reports an IBKR disconnect', async () => {
    MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
      status: 'live',
      meta: { source: 'ibkr_live' },
      fetchedAt: new Date().toISOString(),
      positions: [{ positionId: '1', symbol: 'KXCPI', description: 'Live CPI position', quantity: 1 }],
    });
    const baseProps = {
      activeMarket: 'overview',
      onActiveMarketChange: jest.fn(),
      selectedAccount: 'U1',
      onClose: jest.fn(),
    };
    const { rerender } = render(
      <PredictionMarketsHub {...baseProps} ibkrConnection={{ connected: true, title: 'IBKR live' }} />,
    );
    expect(await screen.findByText('Live CPI position')).toBeInTheDocument();

    rerender(
      <PredictionMarketsHub {...baseProps} ibkrConnection={{ connected: false, title: 'IB Gateway offline' }} />,
    );
    expect(screen.queryByText('Live CPI position')).not.toBeInTheDocument();
    expect(screen.getByText('IB Gateway offline')).toBeInTheDocument();
  });
});

describe('PredictionMarketsHub normalization', () => {
  test('accepts a complete non-broker direct ladder and never imports settled rows', () => {
    const direct = {
      ok: true,
      mode: 'live',
      fetchedAt: new Date().toISOString(),
      event: { ticker: 'KXINXU-26JUL21H1600', closeTime: '2026-07-21T20:00:00.000Z', totalMarketCount: 1, availableOnBrokers: false },
      venue: { source: 'kalshi_trade_api_v2', snapshotType: 'direct_venue' },
      markets: [{ ticker: 'SPX-7300', threshold: 7300, yesBid: 0.6, yesAsk: 0.63, noBid: 0.37, noAsk: 0.4, nativeBook: { complete: true, derivedFields: [] } }],
      policy: { researchOnly: true },
      executable: false,
    };
    const historical = {
      status: 'historical',
      summary: {
        historicalOnly: true,
        lines: [{ label: 'Above 7,485', settlementResult: 'YES', settlementValue: 7490.12 }],
      },
    };

    const result = normalizeSpxCoverSnapshot(direct, historical);
    expect(result).toEqual(expect.objectContaining({
      status: 'available',
      mode: 'live',
      summary: expect.objectContaining({ historicalOnly: false, availableOnBrokers: false }),
    }));
    expect(result.summary.lines[0]).not.toHaveProperty('settlementResult');
  });

  test('accepts a dated closing quote snapshot but rejects stale direct data', () => {
    const now = Date.parse('2026-08-05T00:00:00.000Z');
    const closed = normalizeSpxCoverSnapshot({
      ok: true,
      mode: 'closed',
      historicalOnly: true,
      executable: false,
      fetchedAt: '2026-08-05T00:01:00.000Z',
      event: { ticker: 'KXINXU-26AUG04H1600', closeTime: '2026-08-04T20:00:00.000Z', totalMarketCount: 1 },
      markets: [{ ticker: 'SPX-CLOSE', threshold: 7735, yesBid: 0.27, yesAsk: 0.99, noBid: 0.01, noAsk: 0.73, volume24h: 16023.45, nativeBook: { complete: true, derivedFields: ['noBid', 'noAsk'] } }],
      venue: { source: 'kalshi_trade_api_v2', snapshotType: 'historical_quote_close', quoteAsOf: '2026-08-04T20:00:00.000Z' },
      policy: { historicalOnly: true },
    }, null, now);
    expect(closed).toEqual(expect.objectContaining({ status: 'available', mode: 'closed' }));
    expect(closed.summary.quoteState).toBe('closed');

    const stale = normalizeSpxCoverSnapshot({
      ok: true,
      mode: 'live',
      fetchedAt: '2026-08-04T23:00:00.000Z',
      event: { ticker: 'KXINXU-26AUG05H1600', closeTime: '2026-08-05T20:00:00.000Z', totalMarketCount: 1 },
      markets: [{ ticker: 'SPX-LIVE', threshold: 7735, yesBid: 0.5, yesAsk: 0.52, noBid: 0.48, noAsk: 0.5, nativeBook: { complete: true, derivedFields: [] } }],
      venue: { source: 'kalshi_trade_api_v2', snapshotType: 'direct_venue' },
      policy: { researchOnly: true },
      executable: false,
    }, null, now);
    expect(stale).toEqual(expect.objectContaining({
      status: 'unavailable',
    }));
  });

  test('centers the verified reference marker without horizontal or animated scrolling', () => {
    const scroller = document.createElement('div');
    const marker = document.createElement('div');
    marker.setAttribute('data-center-marker', 'true');
    scroller.appendChild(marker);
    Object.defineProperties(scroller, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    scroller.getBoundingClientRect = () => ({ top: 100, height: 200 });
    marker.getBoundingClientRect = () => ({ top: 600, height: 24 });

    expect(centerPredictionContractList(scroller)).toBe(true);
    expect(scroller.scrollTop).toBe(412);
  });

  test('classifies daily and weekly WTI before the shared prefix', () => {
    expect(classifyPredictionMarketPosition({ symbol: 'KXWTIW', description: 'KXWTIW-26JUL24-B84.50' })).toBe('wti-weekly');
    expect(classifyPredictionMarketPosition({ symbol: 'KXWTI', description: 'KXWTI-26JUL21-T83.99' })).toBe('wti-daily');
    expect(classifyPredictionMarketPosition({ marketFamily: 'wti', marketProduct: 'weekly', symbol: 'EVENT' })).toBe('wti-weekly');
    expect(classifyPredictionMarketPosition({ marketFamily: 'wti', marketProduct: 'daily', symbol: 'EVENT' })).toBe('wti-daily');
    expect(classifyPredictionMarketPosition({ symbol: 'COMCO', description: 'COMCO_081326_82_NO' })).toBe('wti-forecastex');
    expect(classifyPredictionMarketPosition({ marketFamily: 'wti', marketProduct: 'forecastex-daily', symbol: 'EVENT' })).toBe('wti-forecastex');
    expect(classifyPredictionMarketPosition({ symbol: 'KXUNKNOWN' })).toBe('other');
    expect(classifyPredictionMarketPosition({ marketFamily: 'WTI Weekly', symbol: 'EVENT' })).toBe('wti-weekly');
  });

  test('accepts partial verified-live payloads but rejects cache-only data', () => {
    expect(normalizeLivePositionsPayload({ status: 'partial', positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'partial', positions: [{ symbol: 'KXCPI' }],
    }));
    expect(normalizeLivePositionsPayload({ meta: { source: 'ibkr_live_partial', status: 'partial' }, positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'partial', positions: [{ symbol: 'KXCPI' }],
    }));
    expect(normalizeLivePositionsPayload({ status: 'live', meta: { source: 'cache' }, positions: [{ symbol: 'KXCPI' }] })).toEqual(expect.objectContaining({
      status: 'unavailable', positions: [],
    }));
  });
});
