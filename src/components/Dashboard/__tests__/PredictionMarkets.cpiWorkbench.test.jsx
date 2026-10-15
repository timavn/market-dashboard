import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as PredictionMarketsModule from '../PredictionMarkets';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import {
  getMacroSignalQuotePlan,
  normalizePredictionMarketSignals,
} from '../../../utils/predictionMarketSignals';

const PredictionMarkets = PredictionMarketsModule.default || PredictionMarketsModule;

const PRE_RELEASE_TEST_TIME = new Date('2026-07-01T12:00:00Z');
const LIVE_EVENT_UPDATED_AT = '2026-07-01T11:59:00Z';

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getRiskRanges: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
    getHedgeyeInflationNowcastHistory: jest.fn(),
    getQuotes: jest.fn(),
    getHedgeyeFreshness: jest.fn(),
    getPortfolioPredictionMarketPositions: jest.fn(),
  },
}));

jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  getAggregatedEvents: jest.fn(),
  refreshIbkr: jest.fn(),
  discoverIbkr: jest.fn(),
  getProviderStatus: jest.fn(),
  getCurrentCpiRelease: jest.fn(),
  getCpiOfficialFinals: jest.fn(),
  getCpiBenchmarks: jest.fn(),
}));

jest.mock('../../../utils/predictionMarketSignals', () => ({
  getMacroSignalQuotePlan: jest.fn(() => []),
  normalizePredictionMarketSignals: jest.fn(() => ({ rows: [] })),
}));

const PROVIDERS = {
  ibkr: {
    status: 'connected_no_contracts',
    message: 'IBKR connected, no event contracts discovered',
    gateway: { ok: true },
  },
  forecastex: {
    status: 'connected_no_contracts',
    message: 'IBKR connected, no event contracts discovered',
  },
  cme: {
    status: 'connected_no_contracts',
    message: 'IBKR connected, no event contracts discovered',
  },
};

const YOY_NOWCAST = {
  date: '2026-06-03',
  publishedAt: '2026-06-03T18:56:00Z',
  data: {
    metric: 'Headline CPI YoY',
    forecastMonth: 'June 2026',
    publishedText: '06/03/2026 02:56 PM EDT',
    releaseDate: { date: '2026-07-14' },
    scenarios: [
      { key: 'upside', label: 'Upside', value: 4.19 },
      { key: 'base', label: 'Base Case', value: 4.08 },
      { key: 'downside', label: 'Downside', value: 3.97 },
    ],
  },
};

const CURRENT_CPI_RELEASE = {
  ok: true,
  releaseKey: 'KXCPIYOY#2026-06',
  reportMonth: '2026-06',
  forecastMonth: 'June 2026',
  releaseDate: '2026-07-14',
  eventTicker: 'KXCPIYOY-26JUN',
  targetStrikes: [3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4],
  request: {
    cpi: {
      releaseKey: 'KXCPIYOY#2026-06',
      metric: 'Headline CPI YoY',
      forecastMonth: 'June 2026',
      reportMonth: 'June 2026',
      reportMonthId: '2026-06',
      releaseCode: 'Jun 26',
      releaseDate: '2026-07-14',
      eventTicker: 'KXCPIYOY-26JUN',
      targetStrikes: [3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4],
    },
  },
  events: [],
  providers: PROVIDERS,
};

const JULY_NOWCAST = {
  date: '2026-07-02',
  publishedAt: '2026-07-02T18:56:00Z',
  data: {
    metric: 'Headline CPI YoY',
    forecastMonth: 'July 2026',
    publishedText: '07/02/2026 02:56 PM EDT',
    releaseDate: { date: '2026-08-12' },
    scenarios: [
      { key: 'upside', label: 'Upside', value: 3.59 },
      { key: 'base', label: 'Base Case', value: 3.48 },
      { key: 'downside', label: 'Downside', value: 3.37 },
    ],
  },
};

const JULY_CURRENT_CPI_RELEASE = {
  ...CURRENT_CPI_RELEASE,
  reportMonth: '2026-07',
  forecastMonth: 'July 2026',
  releaseDate: '2026-08-12',
  eventTicker: 'KXCPIYOY-26JUL',
  request: {
    cpi: {
      ...CURRENT_CPI_RELEASE.request.cpi,
      forecastMonth: 'July 2026',
      reportMonth: 'July 2026',
      reportMonthId: '2026-07',
      releaseCode: 'Jul 26',
      releaseDate: '2026-08-12',
      eventTicker: 'KXCPIYOY-26JUL',
    },
  },
};

const CPI_HISTORY_VALUES = [
  ['2025-07', 2.72, 2.60, 2.49],
  ['2025-08', 2.94, 2.83, 2.71],
  ['2025-09', 3.21, 3.10, 2.99],
  ['2025-10', 3.07, 2.96, 2.85],
  ['2025-11', 3.15, 3.04, 2.93],
  ['2025-12', 2.67, 2.56, 2.45],
  ['2026-01', 2.61, 2.50, 2.39],
  ['2026-02', 2.55, 2.44, 2.33],
  ['2026-03', 3.42, 3.31, 3.20],
  ['2026-04', 3.73, 3.62, 3.51],
  ['2026-05', 4.35, 4.24, 4.13],
  ['2026-06', 3.94, 3.83, 3.72],
  ['2026-07', 3.58, 3.47, 3.36],
];

const CPI_NOWCAST_HISTORY = {
  entries: CPI_HISTORY_VALUES.map(([monthId, upper, base, lower]) => ({
    monthId,
    releaseAt: monthId === '2026-07' ? '2026-08-12T12:30:00.000Z' : null,
    status: monthId === '2026-07' ? 'provisional' : 'final-pre-release',
    publishedAt: monthId === '2026-07' ? '2026-08-05T14:39:06.000Z' : null,
    source: { kind: 'gmail', messageId: `message-${monthId}` },
    scenarios: {
      upper: { raw: upper, rounded: Math.round((upper + Number.EPSILON) * 10) / 10 },
      base: { raw: base, rounded: Math.round((base + Number.EPSILON) * 10) / 10 },
      lower: { raw: lower, rounded: Math.round((lower + Number.EPSILON) * 10) / 10 },
    },
  })),
};

const CPI_OFFICIAL_FINALS = [
  ['2025-07', 2.7],
  ['2025-08', 2.9],
  ['2025-09', 3.0],
  ['2025-10', 2.9],
  ['2025-11', 2.7],
  ['2025-12', 2.7],
  ['2026-01', 2.4],
  ['2026-02', 2.4],
  ['2026-03', 3.3],
  ['2026-04', 3.8],
  ['2026-05', 4.3],
  ['2026-06', 3.5],
].map(([id, value]) => ({ id, value, source: 'bls_api' }));

function cpiBenchmarkPayload(period, overrides = {}) {
  const releaseAt = period === '2026-07'
    ? '2026-08-12T12:30:00.000Z'
    : '2026-07-14T12:30:00.000Z';
  return {
    ok: true,
    period,
    metric: 'headline-cpi-yoy',
    unit: 'percent',
    fetchedAt: '2026-07-01T12:00:00.000Z',
    sources: [
      {
        id: 'wall-street-consensus',
        kind: 'consensus',
        status: 'available',
        point: 3.80,
        asOf: '2026-06-30T14:00:00.000Z',
        releaseAt,
        source: 'trading_economics_consensus',
        sourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
        reason: null,
      },
      {
        id: 'cleveland-fed',
        kind: 'nowcast',
        status: 'available',
        point: 3.85,
        asOf: '2026-06-30T14:30:00.000Z',
        releaseAt,
        source: 'cleveland_fed_inflation_nowcasting',
        sourceUrl: 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
        reason: null,
      },
    ],
    ...overrides,
  };
}

function livePortfolioData(netLiquidation = 100000) {
  return {
    dataSource: 'ibkr_api',
    dataQuality: { status: 'ok' },
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation,
      source: 'ibkr_live_session',
      socketVerifiedAt: LIVE_EVENT_UPDATED_AT,
    },
  };
}

const CPI_POSITIONS = [
  {
    symbol: 'KXCPIYOY',
    description: 'KXCPIYOY-26JUN-T4.0_NO',
    accountId: 'U25779973',
    quantity: 427.27,
    price: 0.9249888829077634,
    marketValue: 395.22,
    costBasis: 305.6236032895,
    gainLoss: 89.6,
    secType: 'OPT',
    assetClass: 'Prediction Markets',
    conid: 872435582,
    isPredictionMarket: true,
  },
];

const CPI_DISCOVERY = {
  metric: 'Headline CPI YoY',
  forecastMonth: 'June 2026',
  reportMonth: 'June 2026',
  releaseCode: 'Jun 26',
  targetStrikes: [3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4],
  foundStrikes: [],
  missingStrikes: [3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4],
  contractsTotal: 0,
  contractsAdded: 0,
};

const LIVE_CPI_EVENTS = [
  {
    id: 'ibkr:3.8',
    conId: 3801,
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    exchange: 'FORECASTX',
    tradingClass: 'KXCPIYOY',
    catalog_source: 'ibkr_contract_details',
    quote_side: 'YES',
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
    question: 'KXCPIYOY-26JUN-T3.8_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T3.8_YES',
    yes_bid: 0.49,
    yes_ask: 0.50,
    no_bid: 0.48,
    no_ask: 0.51,
    volume: 1250,
    max_payout_per_contract: 1,
    releaseKey: 'KXCPIYOY#2026-06',
    status: 'open',
    expiration_time: '20991231',
    updated_at: LIVE_EVENT_UPDATED_AT,
  },
  {
    id: 'ibkr:3.9',
    conId: 3901,
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    exchange: 'FORECASTX',
    tradingClass: 'KXCPIYOY',
    catalog_source: 'ibkr_contract_details',
    quote_side: 'YES',
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T3.9_YES',
    question: 'KXCPIYOY-26JUN-T3.9_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T3.9_YES',
    yes_bid: 0.27,
    yes_ask: 0.28,
    no_bid: 0.70,
    no_ask: 0.73,
    volume: 9200,
    max_payout_per_contract: 1,
    releaseKey: 'KXCPIYOY#2026-06',
    status: 'open',
    expiration_time: '20991231',
    updated_at: LIVE_EVENT_UPDATED_AT,
  },
  {
    id: 'ibkr:4.0',
    conId: 4001,
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    exchange: 'FORECASTX',
    tradingClass: 'KXCPIYOY',
    catalog_source: 'ibkr_contract_details',
    quote_side: 'YES',
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
    question: 'KXCPIYOY-26JUN-T4.0_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T4.0_YES',
    yes_bid: 0.11,
    yes_ask: 0.12,
    no_bid: 0.70,
    no_ask: 0.72,
    volume: 176534.04,
    max_payout_per_contract: 1,
    releaseKey: 'KXCPIYOY#2026-06',
    status: 'open',
    expiration_time: '20991231',
    updated_at: LIVE_EVENT_UPDATED_AT,
  },
];

function makeLiveKalshiCpiEvent(strike, overrides = {}) {
  const strikeLabel = Number(strike).toFixed(1);
  return {
    id: `kalshi:${strikeLabel}`,
    venue: 'Kalshi',
    source_api: 'kalshi_trade_api_v2',
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: `KXCPIYOY-26JUN-T${strikeLabel}_YES`,
    question: `Will CPI be above ${strikeLabel}%?`,
    api_raw_symbol: `KXCPIYOY-26JUN-T${strikeLabel}_YES`,
    yes_bid: 0.39,
    yes_ask: 0.41,
    no_bid: 0.59,
    no_ask: 0.61,
    volume: 100,
    max_payout_per_contract: 1,
    releaseKey: 'KXCPIYOY#2026-06',
    status: 'open',
    expiration_time: '20991231',
    updated_at: LIVE_EVENT_UPDATED_AT,
    ...overrides,
  };
}

const PROVIDERS_WITH_CPI_DISCOVERY = {
  ...PROVIDERS,
  ibkr: {
    ...PROVIDERS.ibkr,
    last_success_at: '2026-06-20T01:56:17.766Z',
    cpi_discovery: CPI_DISCOVERY,
    contracts_total: 0,
    contracts_added: 0,
  },
};

function makeLiveCpiProviders(foundStrikes = [3.8, 3.9, 4]) {
  return {
    ...PROVIDERS,
    ibkr: {
      status: 'connected',
      execution_ready: true,
      gateway: { ok: true },
      last_success_at: LIVE_EVENT_UPDATED_AT,
      cpi_discovery: {
        ...CPI_DISCOVERY,
        foundStrikes,
        missingStrikes: CPI_DISCOVERY.targetStrikes.filter((strike) => !foundStrikes.includes(strike)),
        contractsTotal: foundStrikes.length,
      },
      contracts_total: foundStrikes.length,
      contracts_added: 0,
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(PRE_RELEASE_TEST_TIME);
  window.localStorage.clear();

  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  global.fetch = jest.fn((url) => {
    const path = String(url);
    if (path.includes('/contracts')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ contracts: [] }) });
    if (path.includes('/settings')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: {} }) });
    if (path.includes('/analytics')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    if (path.includes('/risk')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });

  getMacroSignalQuotePlan.mockReturnValue([]);
  normalizePredictionMarketSignals.mockReturnValue({ rows: [] });

  MarketDataService.getRiskRanges.mockResolvedValue({});
  MarketDataService.getHedgeyeSnapshot.mockImplementation((snapshotType) => (
    snapshotType === 'inflation-nowcast' ? Promise.resolve(YOY_NOWCAST) : Promise.resolve(null)
  ));
  MarketDataService.getHedgeyeInflationNowcastHistory.mockResolvedValue(CPI_NOWCAST_HISTORY);
  MarketDataService.getQuotes.mockResolvedValue({});
  MarketDataService.getHedgeyeFreshness.mockResolvedValue({ dataTypes: {} });
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: CPI_POSITIONS });

  predictionMarketsIngestService.getAggregatedEvents.mockResolvedValue({
    events: [],
    dashboardEvents: [],
    providers: PROVIDERS_WITH_CPI_DISCOVERY,
  });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: [],
    dashboardEvents: [],
    providers: PROVIDERS_WITH_CPI_DISCOVERY,
  });
  predictionMarketsIngestService.discoverIbkr.mockResolvedValue({
    events: [],
    dashboardEvents: [],
    providers: PROVIDERS_WITH_CPI_DISCOVERY,
    cpi_discovery: CPI_DISCOVERY,
  });
  predictionMarketsIngestService.getCurrentCpiRelease.mockResolvedValue(CURRENT_CPI_RELEASE);
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({ ok: true, finals: [] });
  predictionMarketsIngestService.getCpiBenchmarks.mockImplementation((period) => (
    Promise.resolve(cpiBenchmarkPayload(period))
  ));
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  delete global.ResizeObserver;
  delete global.fetch;
});

test('CPI sizing accepts only fresh socket-verified live IBKR NLV', () => {
  const now = new Date('2026-07-21T17:00:00Z');
  const freshSocketVerifiedAt = '2026-07-21T16:59:00Z';
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    dataQuality: { status: 'ok' },
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 190539,
      source: 'ibkr_live_session',
      socketVerifiedAt: freshSocketVerifiedAt,
    },
  }, now)).toBe(190539);

  expect(PredictionMarketsModule.getCpiAccountValue(
    null,
    { portfolioEquity: 100000 },
  )).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    accountSummary: { netLiquidation: 190539 },
  })).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    accountSummary: { netLiquidation: 190539 },
  })).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    summary: { totalValue: 190539 },
  })).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    liveSessionVerified: true,
    fromCache: true,
    accountSummary: {
      netLiquidation: 190539,
      source: 'ibkr_live_session',
      socketVerifiedAt: freshSocketVerifiedAt,
    },
  }, now)).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    liveSessionVerified: true,
    dataQuality: { status: 'stale' },
    accountSummary: {
      netLiquidation: 190539,
      source: 'ibkr_live_session',
      socketVerifiedAt: freshSocketVerifiedAt,
    },
  }, now)).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    liveSessionVerified: false,
    accountSummary: {
      netLiquidation: 190539,
      source: 'ibkr_live_session',
      socketVerifiedAt: freshSocketVerifiedAt,
    },
  }, now)).toBeNull();
  expect(PredictionMarketsModule.getCpiAccountValue({
    dataSource: 'ibkr_api',
    liveSessionVerified: true,
    accountSummary: {
      netLiquidation: 190539,
      source: 'ibkr_live_session',
      socketVerifiedAt: '2026-07-21T16:54:59.999Z',
    },
  }, now)).toBeNull();
});

test('does not render open CPI positions as contract rows when live catalog is missing', async () => {
  const { container } = render(<PredictionMarkets portfolioData={{
    accountId: 'U25779973',
    accountSummary: { netLiquidation: 190539 },
    summary: { totalValue: 190539 },
  }} />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();

  const calendarHeader = container.querySelector('.cpi-calendar-header');
  expect(calendarHeader).toBeInTheDocument();
  expect(screen.queryByText('CPI PREDICTION CALCULATOR')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Assumptions/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Calculate' })).toBeDisabled();
  const settlement = screen.getByText('Settles Jul 14 · 8:30 AM ET');
  expect(settlement).toBeInTheDocument();
  expect(settlement).toHaveClass('cpi-ledger-settlement');
  const jun25Card = screen.getByRole('button', { name: /Jun 25/i });
  const jul25Card = screen.getByRole('button', { name: /Jul 25/i });
  const jun26Card = screen.getByRole('button', { name: /Jun 26/i });
  expect(jun25Card).toHaveTextContent('2.8%');
  expect(jun25Card).toHaveTextContent('actual');
  expect(jul25Card).toHaveTextContent('2.7%');
  expect(jul25Card).toHaveTextContent('actual');
  expect(jun26Card).toHaveAttribute('aria-pressed', 'true');
  expect(jun26Card).toHaveClass('active');
  expect(screen.getByRole('button', { name: /May 26/i })).toHaveTextContent('4.3%');
  expect(calendarHeader).not.toHaveTextContent('FINAL PENDING');
  await waitFor(() => {
    expect(jun26Card).toHaveTextContent('3.8%est');
  });
  expect(calendarHeader).not.toHaveTextContent('+10%');
  expect(calendarHeader).not.toHaveTextContent('-5%');
  expect(container.querySelector('.cpi-calendar-mini-chart')).not.toBeInTheDocument();
  expect(container.querySelector('[class*="cpi-calendar-axis"]')).not.toBeInTheDocument();
  expect(container.querySelector('[class*="cpi-calendar-scenario"]')).not.toBeInTheDocument();
  expect(container.querySelector('[class*="cpi-calendar-bar"]')).not.toBeInTheDocument();

  const forecastRail = container.querySelector('.cpi-forecast-rail');
  expect(forecastRail).toHaveTextContent('Hedgeye3.83%');
  expect(forecastRail).toHaveTextContent('Range3.72%–3.94%');
  expect(forecastRail).toHaveTextContent('Cleveland Fed3.85%');
  expect(forecastRail).toHaveTextContent('Street3.80%');
  expect(within(forecastRail).getByRole('link', { name: 'Street' })).toHaveAttribute(
    'href',
    'https://tradingeconomics.com/united-states/inflation-cpi',
  );
  expect(within(forecastRail).getByRole('link', { name: 'Cleveland Fed' })).toHaveAttribute(
    'href',
    'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
  );
  expect(screen.queryByRole('table', { name: /CPI forecast comparison/i })).not.toBeInTheDocument();
  const octoberButton = screen.getByRole('button', { name: /Oct 25/i });
  fireEvent.click(octoberButton);
  expect(await screen.findByRole('heading', { name: /CPI OCT 2025/i })).toBeInTheDocument();
  expect(octoberButton).toHaveAttribute('aria-pressed', 'true');
  await waitFor(() => {
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledWith('2025-10');
  });
  expect(screen.getByText('Settles Nov 13 · 8:30 AM ET')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Contract ladder' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Contract ladder' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Current book' })).toBeInTheDocument();
  expect(screen.getAllByText('Oct 25 has passed')).toHaveLength(2);
  expect(screen.queryByText('Missing Data')).not.toBeInTheDocument();
  expect(screen.queryByText(/No source-matched Hedgeye CPI nowcast/)).not.toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'CPI contracts' })).not.toBeInTheDocument();
  expect(screen.queryByText('YES (Above Strike)')).not.toBeInTheDocument();
  expect(screen.queryByText('NO (Below Strike)')).not.toBeInTheDocument();
  expect(screen.queryByText(/KXCPIYOY-26JUN-T4\.0_NO/)).not.toBeInTheDocument();
  expect(screen.queryByText('-$306')).not.toBeInTheDocument();
  expect(screen.queryByText('Open CPI positions found, contract catalog missing')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/IBKR contract provider/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/using fallback price/)).not.toBeInTheDocument();
});

test('promotes the BLS final into the calendar and expires the old month panels', async () => {
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({
    ok: true,
    finals: [{ id: '2026-06', value: 3.5, source: 'bls_api' }],
  });

  const { container } = render(<PredictionMarkets />);

  const juneCard = await screen.findByRole('button', { name: /Jun 26; 3\.5% actual/i });
  expect(juneCard).toHaveTextContent('3.5%actual');
  await waitFor(() => {
    expect(container.querySelectorAll('.cpi-expired-month')).toHaveLength(2);
  });
  expect(screen.getAllByText('Jun 26 has passed')).toHaveLength(2);
  expect(screen.queryByText(/No source-matched Hedgeye CPI nowcast/)).not.toBeInTheDocument();
});

test('keeps released June expired while the official final request is pending, then promotes 3.5%', async () => {
  jest.setSystemTime(new Date('2026-08-09T12:00:00Z'));
  expect(PredictionMarketsModule.isCpiMonthExpired({ releaseDate: '2026-07-14' }, Date.now())).toBe(true);
  let resolveOfficialFinals;
  predictionMarketsIngestService.getCpiOfficialFinals.mockImplementation(() => new Promise((resolve) => {
    resolveOfficialFinals = resolve;
  }));

  const { container } = render(<PredictionMarkets />);

  const junePendingCard = await screen.findByRole('button', { name: /Jun 26/i });
  expect(junePendingCard).toHaveTextContent('—');
  expect(screen.getAllByText('Jun 26 has passed')).toHaveLength(2);
  expect(container.querySelectorAll('.cpi-expired-month')).toHaveLength(2);
  expect(screen.queryByText(/No inflation nowcast snapshot is available/)).not.toBeInTheDocument();
  expect(screen.queryByText(/No source-matched Hedgeye CPI nowcast/)).not.toBeInTheDocument();

  resolveOfficialFinals({
    ok: true,
    finals: [{ id: '2026-06', value: 3.5, source: 'bls_release' }],
  });

  const juneFinalCard = await screen.findByRole('button', { name: /Jun 26; 3\.5% actual/i });
  expect(juneFinalCard).toHaveTextContent('3.5%actual');
  expect(juneFinalCard.querySelector('small')).toHaveTextContent('actual');
  expect(juneFinalCard.querySelector('.cpi-calendar-bar')).not.toBeInTheDocument();
});

test('retries a failed official-final request and promotes the released June final', async () => {
  jest.setSystemTime(new Date('2026-08-09T12:00:00Z'));
  predictionMarketsIngestService.getCpiOfficialFinals
    .mockRejectedValueOnce(new Error('official CPI request timed out'))
    .mockResolvedValueOnce({
      ok: true,
      finals: [{ id: '2026-06', value: 3.5, source: 'bls_release' }],
    });

  render(<PredictionMarkets />);

  await waitFor(() => {
    expect(predictionMarketsIngestService.getCpiOfficialFinals).toHaveBeenCalledTimes(1);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(2000);
    await Promise.resolve();
  });

  expect(predictionMarketsIngestService.getCpiOfficialFinals).toHaveBeenCalledTimes(2);
  const juneFinalCard = await screen.findByRole('button', { name: /Jun 26; 3\.5% actual/i });
  expect(juneFinalCard.querySelector('small')).toHaveTextContent('actual');
  expect(juneFinalCard.querySelector('.cpi-calendar-bar')).not.toBeInTheDocument();
});

test('keeps the operational July nowcast visible when released June is selected', async () => {
  jest.setSystemTime(new Date('2026-08-09T12:00:00Z'));
  window.localStorage.setItem('marketDashboard.predictionMarkets.workbench.v1', JSON.stringify({
    activeCpiMonthId: '2026-06',
  }));
  MarketDataService.getHedgeyeSnapshot.mockImplementation((snapshotType) => (
    snapshotType === 'inflation-nowcast' ? Promise.resolve(JULY_NOWCAST) : Promise.resolve(null)
  ));
  predictionMarketsIngestService.getCurrentCpiRelease.mockResolvedValue(JULY_CURRENT_CPI_RELEASE);
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({
    ok: true,
    finals: [{ id: '2026-06', value: 3.5, source: 'bls_release' }],
  });

  render(<PredictionMarkets />);

  const juneCard = await screen.findByRole('button', { name: /Jun 26; 3\.5% actual/i });
  const julyCard = await screen.findByRole('button', { name: /Jul 26/i });
  await waitFor(() => expect(julyCard).toHaveTextContent('3.5%est'));
  expect(juneCard).toHaveAttribute('aria-pressed', 'true');
  expect(julyCard).not.toHaveTextContent('upper');
  expect(julyCard).not.toHaveTextContent('lower');
  expect(julyCard).not.toHaveTextContent('provisional');
  expect(julyCard).not.toHaveTextContent('0.00%');
});

test('shows historical forecasts and source-linked benchmarks in the compact rail', async () => {
  jest.setSystemTime(new Date('2026-08-09T12:00:00Z'));
  MarketDataService.getHedgeyeSnapshot.mockImplementation((snapshotType) => (
    snapshotType === 'inflation-nowcast' ? Promise.resolve(JULY_NOWCAST) : Promise.resolve(null)
  ));
  predictionMarketsIngestService.getCurrentCpiRelease.mockResolvedValue(JULY_CURRENT_CPI_RELEASE);
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({
    ok: true,
    finals: [{ id: '2026-06', value: 3.5, source: 'bls_release' }],
  });

  const { container } = render(<PredictionMarkets />);
  const julyCard = await screen.findByRole('button', { name: /Jul 26/i });
  await waitFor(() => expect(julyCard).toHaveTextContent('3.5%est'));
  const juneCard = screen.getByRole('button', { name: /Jun 26; 3\.5% actual/i });
  expect(juneCard).toHaveTextContent('3.5%actual');
  fireEvent.click(juneCard);

  const forecastRail = container.querySelector('.cpi-forecast-rail');
  expect(forecastRail).toHaveTextContent('Hedgeye3.83%');
  expect(forecastRail).toHaveTextContent('Range3.72%–3.94%');
  await waitFor(() => expect(forecastRail).toHaveTextContent('Street3.80%'));
  expect(forecastRail).toHaveTextContent('Cleveland Fed3.85%');
  expect(forecastRail).toHaveTextContent('Forecast as of Final pre-release');
  expect(within(forecastRail).getByRole('link', { name: 'Street' })).toHaveAttribute(
    'href',
    'https://tradingeconomics.com/united-states/inflation-cpi',
  );
  expect(within(forecastRail).getByRole('link', { name: 'Cleveland Fed' })).toHaveAttribute(
    'href',
    'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
  );
  expect(screen.queryByRole('table', { name: /CPI forecast comparison/i })).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-calendar-mini-chart')).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-calendar-header')).not.toHaveTextContent('X.XX');
});

test('keeps benchmark rows explicit and suppresses every comparison when consensus is missing', async () => {
  predictionMarketsIngestService.getCpiBenchmarks.mockImplementation((period) => Promise.resolve(
    cpiBenchmarkPayload(period, {
      sources: [
        {
          id: 'wall-street-consensus',
          kind: 'consensus',
          status: 'unavailable',
          point: null,
          asOf: null,
          releaseAt: '2026-07-14T12:30:00.000Z',
          source: 'trading_economics_consensus',
          sourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
          reason: 'Wall Street consensus has not been published for this month.',
        },
        {
          id: 'cleveland-fed',
          kind: 'nowcast',
          status: 'available',
          point: 3.85,
          asOf: '2026-06-30T14:30:00.000Z',
          releaseAt: '2026-07-14T12:30:00.000Z',
          source: 'cleveland_fed_inflation_nowcasting',
          sourceUrl: 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
          reason: null,
        },
      ],
    }),
  ));

  const { container } = render(<PredictionMarkets />);

  const forecastRail = container.querySelector('.cpi-forecast-rail');
  const streetRow = within(forecastRail).getByText('Street').closest('div');
  await waitFor(() => {
    expect(streetRow).toHaveAttribute(
      'title',
      expect.stringContaining('Wall Street consensus has not been published'),
    );
  });
  expect(streetRow).toHaveTextContent('Street—');
  expect(forecastRail).toHaveTextContent('Hedgeye3.83%');
  expect(forecastRail).toHaveTextContent('Cleveland Fed3.85%');
  expect(streetRow).not.toHaveTextContent('0.00%');
  expect(screen.queryByText(/pp$/)).not.toBeInTheDocument();
});

test('rejects a mismatched benchmark month without displaying its values', async () => {
  predictionMarketsIngestService.getCpiBenchmarks.mockResolvedValue(
    cpiBenchmarkPayload('2026-05'),
  );

  const { container } = render(<PredictionMarkets />);

  const forecastRail = container.querySelector('.cpi-forecast-rail');
  const streetRow = within(forecastRail).getByText('Street').closest('div');
  const clevelandRow = within(forecastRail).getByText('Cleveland Fed').closest('div');
  await waitFor(() => {
    expect(streetRow).toHaveAttribute(
      'title',
      expect.stringContaining('did not match the selected month and metric'),
    );
  });
  expect(streetRow).toHaveTextContent('Street—');
  expect(clevelandRow).toHaveTextContent('Cleveland Fed—');
  expect(streetRow).not.toHaveTextContent('3.80%');
  expect(clevelandRow).not.toHaveTextContent('3.85%');
});

test('refreshes selected-month benchmarks every thirty minutes while unreleased', async () => {
  const { container } = render(<PredictionMarkets />);

  await waitFor(() => {
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledWith('2026-06');
  });
  await waitFor(() => {
    expect(container.querySelector('.cpi-forecast-rail')).toHaveTextContent('Street3.80%');
  });
  predictionMarketsIngestService.getCpiBenchmarks.mockClear();
  await act(async () => {
    jest.advanceTimersByTime(29 * 60 * 1000);
    await Promise.resolve();
  });
  expect(predictionMarketsIngestService.getCpiBenchmarks).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(60 * 1000);
    await Promise.resolve();
  });
  expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(1);
  expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledWith('2026-06');
});

test('missing CPI nowcast never renders zero estimates or fake recommendation', async () => {
  MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValueOnce({ positions: [], meta: { source: 'ibkr_live' } });

  render(<PredictionMarkets />);

  expect((await screen.findAllByText('Missing Data')).length).toBeGreaterThanOrEqual(1);
  expect(await screen.findByText('No inflation nowcast snapshot is available.')).toBeInTheDocument();
  expect(predictionMarketsIngestService.refreshIbkr).not.toHaveBeenCalled();
  expect(screen.getAllByText('Live data is unavailable for this section.').length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(/0\.00\s+lower/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/0\.00\s+base/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/0\.00\s+upper/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/0\.00\s*→\s*0\.0/)).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Scenario net payoff' })).not.toBeInTheDocument();
  expect(screen.queryByText(/3\.8 YES/)).not.toBeInTheDocument();
  expect(screen.queryByText(/4\.0 NO hedge/)).not.toBeInTheDocument();
});

test('connected with no live IBKR catalog clears the spinner and shows no-live-data state', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });

  render(<PredictionMarkets />);

  const juneCard = await screen.findByRole('button', { name: /Jun 26/i });
  await waitFor(() => expect(juneCard).toHaveTextContent('3.8%est'));
  await waitFor(() => {
    expect(screen.queryByText('Loading IBKR CPI contracts…')).not.toBeInTheDocument();
  });
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText('Live data is unavailable for this section.').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByRole('button', { name: 'Discover IBKR Contracts' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh Quotes' })).toBeInTheDocument();
});

test('live CPI quotes render the five-column ladder while the current book stays empty', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: LIVE_CPI_EVENTS,
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
        execution_ready: true,
        gateway: { ok: true },
        last_success_at: '2026-06-20T01:56:17.766Z',
        cpi_discovery: {
          ...CPI_DISCOVERY,
          foundStrikes: [3.8, 3.9, 4],
          missingStrikes: [4.1, 4.2, 4.3, 4.4],
          contractsTotal: 3,
        },
        contracts_total: 3,
        contracts_added: 0,
      },
    },
  });

  const { container } = render(<PredictionMarkets />);

  const contractsTable = await screen.findByRole('table', { name: 'CPI contracts' });
  const contractRegion = screen.getByRole('region', { name: 'Contract ladder' });
  expect(within(contractRegion).queryByRole('heading', { name: 'Contract ladder' }))
    .not.toBeInTheDocument();
  expect(within(contractRegion).queryByText('Data')).not.toBeInTheDocument();
  expect(within(contractsTable).getAllByRole('columnheader').map((header) => header.textContent))
    .toEqual(['Contract', 'Fair (c)', 'Ask (c)', 'Edge (c)', 'Volume']);
  expect(await screen.findByText(/^Live \d/i)).toBeInTheDocument();

  const currentBook = screen.getByRole('heading', { name: 'Current book' }).closest('.cpi-current-book');
  expect(currentBook).toBeInTheDocument();
  expect(currentBook).toHaveTextContent('No live positions');
  expect(currentBook).toHaveTextContent('Risk budget');
  expect(within(currentBook).getByRole('button', { name: 'Calculate' })).toBeDisabled();

  const matrixRows = [...container.querySelectorAll('.cpi-contract-table tbody tr')];
  const row40 = matrixRows.find((row) => row.textContent.includes('Above 4.0 YES'));
  expect(row40).toBeTruthy();
  expect(within(row40).getAllByRole('cell')).toHaveLength(5);
  expect(row40).toHaveTextContent('12c');
  expect(row40).not.toHaveTextContent('Win');
  expect(row40).not.toHaveTextContent('Loss');
  expect(screen.queryByText('Best Executable Lines')).not.toBeInTheDocument();
});

test('keeps the verified contracts ladder free of the removed provider header', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValueOnce({
    events: LIVE_CPI_EVENTS,
    providerEvents: LIVE_CPI_EVENTS,
    dashboardEvents: [],
    providers: makeLiveCpiProviders(),
  });

  render(<PredictionMarkets />);

  const contractsTable = await screen.findByRole('table', { name: 'CPI contracts' });
  expect(screen.getByRole('table', { name: 'CPI contracts' })).toBe(contractsTable);
  expect(screen.queryByRole('heading', { name: 'Contract ladder' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/IBKR contract provider/i)).not.toBeInTheDocument();
});

test('shows the full positive-volume provider ladder with Volume after Edge', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({
    ok: true,
    finals: CPI_OFFICIAL_FINALS.slice(0, -1),
  });

  const providerEvents = [
    makeLiveKalshiCpiEvent(3.0, {
      volume: '176534.04',
      yes_bid: null,
      yes_ask: null,
      no_bid: null,
      no_ask: null,
    }),
    makeLiveKalshiCpiEvent(3.1, { volume: 0 }),
    makeLiveKalshiCpiEvent(3.2, {
      volume: null,
      total_volume: 900000,
      open_interest: 800000,
      liquidity: 700000,
    }),
    makeLiveKalshiCpiEvent(3.3, {
      volume: 25,
      yes_bid: 0.19,
      yes_ask: 0.20,
      no_bid: 0.80,
      no_ask: 0.81,
    }),
    makeLiveKalshiCpiEvent(3.4, { volume: 'not-a-number' }),
    makeLiveKalshiCpiEvent(3.8, { id: 'kalshi:duplicate-3.8', volume: 999999 }),
    ...LIVE_CPI_EVENTS,
  ];
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: LIVE_CPI_EVENTS,
    providerEvents,
    dashboardEvents: [],
    providers: makeLiveCpiProviders(),
  });

  render(<PredictionMarkets />);

  const contractsTable = await screen.findByRole('table', { name: 'CPI contracts' });
  const headers = within(contractsTable).getAllByRole('columnheader');
  expect(headers.at(-2)).toHaveTextContent('Edge');
  expect(headers.at(-1)).toHaveTextContent('Volume');

  const contractRows = within(contractsTable).getAllByRole('row').slice(1);
  expect(contractRows).toHaveLength(5);
  expect(within(contractRows[0]).getByText('Above 3.0 YES')).toBeInTheDocument();
  expect(within(contractRows[1]).getByText('Above 3.3 YES')).toBeInTheDocument();
  expect(within(contractRows[2]).getByText('Above 3.8 YES')).toBeInTheDocument();
  expect(within(contractRows[3]).getByText('Above 3.9 YES')).toBeInTheDocument();
  expect(within(contractRows[4]).getByText('Above 4.0 YES')).toBeInTheDocument();
  expect(within(contractsTable).queryByText('Above 3.1 YES')).not.toBeInTheDocument();
  expect(within(contractsTable).queryByText('Above 3.2 YES')).not.toBeInTheDocument();
  expect(within(contractsTable).queryByText('Above 3.4 YES')).not.toBeInTheDocument();

  const row30Cells = within(contractRows[0]).getAllByRole('cell');
  expect(row30Cells[1]).toHaveTextContent('–');
  expect(row30Cells[2]).toHaveTextContent('–');
  expect(row30Cells[3]).toHaveTextContent('–');
  expect(row30Cells[4]).toHaveTextContent('176.5K');

  const row38Cells = within(contractRows[2]).getAllByRole('cell');
  expect(row38Cells[2]).toHaveTextContent('50c');
  expect(row38Cells[4]).toHaveTextContent('1.3K');
  expect(within(contractsTable).getAllByText('Above 3.8 YES')).toHaveLength(1);
  const positiveEdgeRows = [...contractsTable.querySelectorAll('tbody tr.edge-positive-row')];
  expect(positiveEdgeRows.length).toBeGreaterThan(0);
  positiveEdgeRows.forEach((row) => {
    expect(row.cells[3]).toHaveTextContent(/^\+/);
  });
});

test('shows an explicit state when live current-release contracts have no direct positive volume', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  const providerEvents = LIVE_CPI_EVENTS.map((event, index) => ({
    ...event,
    id: `${event.id}:no-volume`,
    volume: [0, null, 'not-a-number'][index],
    total_volume: 500000,
    open_interest: 400000,
    liquidity: 300000,
  }));
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: LIVE_CPI_EVENTS,
    providerEvents,
    dashboardEvents: [],
    providers: makeLiveCpiProviders(),
  });

  render(<PredictionMarkets />);

  expect(await screen.findByText('No live-volume contracts')).toBeInTheDocument();
  expect(screen.getByText('No verified current-release contracts have positive venue volume.')).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'CPI contracts' })).not.toBeInTheDocument();
});

test('renders every live target strike once and keeps held positions in the current book', async () => {
  const targetStrikes = [3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8];
  const liveEvents = targetStrikes.map((strike, index) => ({
    ...LIVE_CPI_EVENTS[0],
    id: `ibkr:july-${strike.toFixed(1)}`,
    conId: 7000 + index,
    contract_title: `KXCPIYOY-26JUL-T${strike.toFixed(1)}_YES`,
    question: `KXCPIYOY-26JUL-T${strike.toFixed(1)}_YES`,
    api_raw_symbol: `KXCPIYOY-26JUL-T${strike.toFixed(1)}_YES`,
    releaseKey: 'KXCPIYOY#2026-07',
  }));
  const julyDiscovery = {
    ...CPI_DISCOVERY,
    forecastMonth: 'July 2026',
    reportMonth: 'July 2026',
    targetStrikes,
    foundStrikes: targetStrikes,
    missingStrikes: [],
    contractsTotal: targetStrikes.length,
  };
  const julyProviders = {
    ...PROVIDERS,
    ibkr: {
      ...PROVIDERS.ibkr,
      status: 'connected',
      execution_ready: true,
      gateway: { ok: true },
      cpi_discovery: julyDiscovery,
      contracts_total: targetStrikes.length,
      last_success_at: LIVE_EVENT_UPDATED_AT,
    },
  };
  const julyRelease = {
    ...JULY_CURRENT_CPI_RELEASE,
    targetStrikes,
    events: liveEvents,
    providers: julyProviders,
    request: {
      ...JULY_CURRENT_CPI_RELEASE.request,
      cpi: {
        ...JULY_CURRENT_CPI_RELEASE.request.cpi,
        targetStrikes,
      },
    },
  };

  MarketDataService.getHedgeyeSnapshot.mockImplementation((snapshotType) => (
    snapshotType === 'inflation-nowcast' ? Promise.resolve(JULY_NOWCAST) : Promise.resolve(null)
  ));
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
    positions: [
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUL-T3.3_YES',
        accountId: 'U25779973',
        quantity: 20,
        avgCost: 0.6,
        conid: 7331,
        secType: 'OPT',
      },
      {
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUL-T3.4_YES',
        accountId: 'U25779973',
        quantity: 10,
        avgCost: 0.24,
        conid: 7341,
        secType: 'OPT',
      },
    ],
    meta: { source: 'ibkr_live' },
  });
  predictionMarketsIngestService.getCurrentCpiRelease.mockResolvedValue(julyRelease);
  predictionMarketsIngestService.getAggregatedEvents.mockResolvedValue({
    events: liveEvents,
    dashboardEvents: [],
    providers: julyProviders,
  });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: liveEvents,
    dashboardEvents: [],
    providers: julyProviders,
  });

  const { container } = render(<PredictionMarkets />);

  await waitFor(() => {
    expect(container.querySelector('.cpi-contract-ladder .cpi-contract-table')).toBeInTheDocument();
  });

  const contractsCard = container.querySelector('.cpi-contract-ladder');
  const contractRows = [...contractsCard.querySelectorAll('.cpi-contract-table tbody tr')];
  const contractTitles = contractRows.map((row) => (
    row.querySelector('.cpi-contract-name strong')?.textContent
  ));
  expect(contractTitles).toEqual(targetStrikes.map((strike) => `Above ${strike.toFixed(1)} YES`));
  expect(new Set(contractTitles).size).toBe(targetStrikes.length);
  expect(contractsCard).not.toHaveTextContent('Hedge / Open');
  expect(contractsCard).not.toHaveTextContent('AVG');
  expect(contractsCard).not.toHaveTextContent(/Best|Small|Avoid/);

  const currentBook = screen.getByRole('heading', { name: 'Current book' }).closest('.cpi-current-book');
  expect(currentBook).toHaveTextContent('Above 3.3 YES');
  expect(currentBook).toHaveTextContent('Above 3.4 YES');
});

test('builds a one-percent live-NLV allocation across every strike and invalidates it when NLV changes', async () => {
  const targetStrikes = [3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8];
  const yesBids = [0.88, 0.76, 0.59, 0.43, 0.28, 0.16, 0.08];
  const liveEvents = targetStrikes.map((strike, index) => ({
    id: `kalshi:july-${strike.toFixed(1)}`,
    venue: 'Kalshi',
    source_api: 'kalshi_trade_api_v2',
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: `Above ${strike.toFixed(1)}%`,
    question: `Will CPI be above ${strike.toFixed(1)}%?`,
    api_raw_symbol: `KXCPIYOY-26JUL-T${strike.toFixed(1)}`,
    yes_bid: yesBids[index],
    yes_ask: yesBids[index] + 0.02,
    no_bid: 0.98 - yesBids[index],
    no_ask: 1 - yesBids[index],
    yes_bid_size: 10000,
    yes_ask_size: 10000,
    order_book_provenance: 'kalshi_market_snapshot_top_of_book',
    quote_retrieved_at: LIVE_EVENT_UPDATED_AT,
    max_payout_per_contract: 1,
    releaseKey: 'KXCPIYOY#2026-07',
    status: 'open',
    expiration_time: '20991231',
    updated_at: LIVE_EVENT_UPDATED_AT,
  }));
  const liveProviders = {
    ...PROVIDERS,
    kalshi: {
      status: 'connected_live',
      display_ready: true,
      last_success_at: LIVE_EVENT_UPDATED_AT,
    },
  };
  const release = {
    ...JULY_CURRENT_CPI_RELEASE,
    targetStrikes,
    events: liveEvents,
    providers: liveProviders,
    request: {
      cpi: {
        ...JULY_CURRENT_CPI_RELEASE.request.cpi,
        targetStrikes,
      },
    },
  };

  MarketDataService.getHedgeyeSnapshot.mockImplementation((snapshotType) => (
    snapshotType === 'inflation-nowcast' ? Promise.resolve(JULY_NOWCAST) : Promise.resolve(null)
  ));
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
    positions: [{
      positionId: 'held-july-3.4',
      symbol: 'KXCPIYOY',
      description: 'KXCPIYOY-26JUL-T3.4_YES',
      quantity: 10,
      avgCost: 0.24,
      secType: 'OPT',
    }],
    meta: { source: 'ibkr_live' },
  });
  predictionMarketsIngestService.getCpiOfficialFinals.mockResolvedValue({
    ok: true,
    finals: CPI_OFFICIAL_FINALS,
  });
  predictionMarketsIngestService.getCurrentCpiRelease.mockResolvedValue(release);
  predictionMarketsIngestService.getAggregatedEvents.mockResolvedValue({
    events: liveEvents,
    dashboardEvents: [],
    providers: liveProviders,
  });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: liveEvents,
    dashboardEvents: [],
    providers: liveProviders,
  });

  const { container, rerender } = render(<PredictionMarkets portfolioData={livePortfolioData()} />);

  const applyButton = await screen.findByRole('button', { name: 'Calculate' });
  await waitFor(() => expect(applyButton).toBeEnabled());
  const currentBook = screen.getByRole('heading', { name: 'Current book' }).closest('.cpi-current-book');
  expect(currentBook).toHaveTextContent('NLV$100,000');
  expect(currentBook).toHaveTextContent('Allowed$1,000.00');

  fireEvent.click(applyButton);

  await waitFor(() => {
    expect(container.querySelectorAll('[data-testid="cpi-allocation-row"]')).toHaveLength(7);
  });
  const allocationRows = [...container.querySelectorAll('[data-testid="cpi-allocation-row"]')];
  expect(allocationRows.map((row) => row.cells[0].textContent)).toEqual(
    targetStrikes.map((strike) => `Above ${strike.toFixed(1)}`),
  );
  expect(new Set(allocationRows.map((row) => row.cells[0].textContent)).size).toBe(7);
  const allocationDetails = currentBook.querySelector('.cpi-allocation-details');
  expect(allocationDetails).toBeInTheDocument();
  expect(allocationDetails).not.toHaveAttribute('open');
  expect(within(allocationDetails).getByText('Allocation details')).toBeInTheDocument();
  expect(allocationDetails).toHaveTextContent('Calibration observations12');
  expect(allocationDetails).toHaveTextContent('Settlement Outcomes');
  expect(currentBook).toHaveTextContent('Above 3.4 YES');

  rerender(<PredictionMarkets portfolioData={livePortfolioData(110000)} />);
  await waitFor(() => {
    expect(container.querySelector('.cpi-allocation-details')).not.toBeInTheDocument();
    expect(currentBook).toHaveTextContent(/prior allocation was invalidated/i);
  });
});

test('active CPI month isolates same-strike contracts and exposure from adjacent months', async () => {
  const juneEvent = {
    ...LIVE_CPI_EVENTS[2],
    id: 'ibkr:june-4.0',
    contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
    question: 'KXCPIYOY-26JUN-T4.0_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T4.0_YES',
    yes_ask: 0.12,
    no_ask: 0.89,
  };
  const julyEvent = {
    ...juneEvent,
    id: 'ibkr:july-4.0',
    contract_title: 'KXCPIYOY-26JUL-T4.0_YES',
    question: 'KXCPIYOY-26JUL-T4.0_YES',
    api_raw_symbol: 'KXCPIYOY-26JUL-T4.0_YES',
    yes_ask: 0.91,
    no_ask: 0.10,
  };
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: [julyEvent, juneEvent],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
        execution_ready: true,
        gateway: { ok: true },
        last_success_at: '2026-06-20T01:56:17.766Z',
        cpi_discovery: {
          ...CPI_DISCOVERY,
          foundStrikes: [4],
          missingStrikes: [3.8, 3.9, 4.1, 4.2, 4.3, 4.4],
          contractsTotal: 2,
        },
        contracts_total: 2,
      },
    },
  });

  const { container } = render(<PredictionMarkets sharedPositionsState={{
    status: 'live',
    positions: [
      {
        positionId: 'june-position',
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUN-T4.0_NO',
        quantity: 11,
        avgCost: 0.31,
      },
      {
        positionId: 'july-position',
        symbol: 'KXCPIYOY',
        description: 'KXCPIYOY-26JUL-T4.0_NO',
        quantity: 23,
        avgCost: 0.47,
      },
    ],
  }} />);

  await waitFor(() => {
    expect(container.querySelector('.cpi-contract-ladder .cpi-contract-table')).toBeInTheDocument();
  });
  const contractsCard = container.querySelector('.cpi-contract-ladder');
  expect(contractsCard).toHaveTextContent('12c');
  expect(contractsCard).not.toHaveTextContent('91c');

  const exposureRows = [...container.querySelectorAll('.cpi-current-book-table tbody tr')];
  expect(exposureRows).toHaveLength(1);
  expect(exposureRows[0]).toHaveTextContent('Above 4.0 NO');
  expect(exposureRows[0]).toHaveTextContent('11');
  expect(exposureRows[0]).not.toHaveTextContent('23');
});

test('connected positions-only status explains held CPI exposure without executable quotes', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({
    positions: CPI_POSITIONS,
    meta: { source: 'ibkr_live' },
  });
  predictionMarketsIngestService.getAggregatedEvents.mockResolvedValueOnce({
    events: [],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS_WITH_CPI_DISCOVERY,
      ibkr: {
        ...PROVIDERS_WITH_CPI_DISCOVERY.ibkr,
        status: 'connected_positions_only',
        message: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
        portfolio_cpi_positions: 4,
        portfolio_seed_count: 4,
      },
    },
  });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValueOnce({
    events: [],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS_WITH_CPI_DISCOVERY,
      ibkr: {
        ...PROVIDERS_WITH_CPI_DISCOVERY.ibkr,
        status: 'connected_positions_only',
        message: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
        portfolio_cpi_positions: 4,
        portfolio_seed_count: 4,
      },
    },
  });

  const { container } = render(<PredictionMarkets />);

  expect((await screen.findAllByText('Above 4.0 NO')).length).toBeGreaterThan(0);
  const currentBook = screen.getByRole('heading', { name: 'Current book' }).closest('.cpi-current-book');
  expect(currentBook).toHaveTextContent('Downside');
  expect(currentBook).toHaveTextContent('Base');
  expect(currentBook).toHaveTextContent('Upside');
  expect(currentBook).toHaveTextContent('Above 4.0 NO');
  expect(currentBook).toHaveTextContent('427');
  expect(currentBook).toHaveTextContent('Scenario net payoff');
  expect(currentBook).not.toHaveTextContent('Missing Data');
  expect(screen.queryByText('KXCPIYOY-26JUN-T4.0_NO')).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-contract-ladder .cpi-contract-table')).not.toBeInTheDocument();
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText('IBKR connected; CPI positions loaded from portfolio, contract catalog missing')).not.toBeInTheDocument();
  expect(screen.queryByText('4 held CPI positions found; no executable live contract catalog quotes available')).not.toBeInTheDocument();
});

test('one-sided CPI quotes without their native ask are not promoted into the ladder', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: [
      {
        id: 'ibkr:872435625',
        conId: 872435625,
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        exchange: 'FORECASTX',
        tradingClass: 'KXCPIYOY',
        catalog_source: 'ibkr_contract_details',
        quote_side: 'YES',
        category: 'Inflation',
        underlying: 'KXCPIYOY',
        contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
        question: 'KXCPIYOY-26JUN-T3.8_YES',
        api_raw_symbol: 'KXCPIYOY-26JUN-T3.8_YES',
        yes_bid: 0.59,
        yes_ask: null,
        yes_mid: 0.61,
        no_bid: 0.33,
        no_ask: 0.37,
        no_mid: 0.35,
        max_payout_per_contract: 1,
        releaseKey: 'KXCPIYOY#2026-06',
        status: 'open',
        expiration_time: '20991231',
        updated_at: LIVE_EVENT_UPDATED_AT,
      },
    ],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
        execution_ready: true,
        gateway: { ok: true },
        last_success_at: '2026-06-20T01:56:17.766Z',
        cpi_discovery: {
          ...CPI_DISCOVERY,
          foundStrikes: [3.8],
          missingStrikes: [3.9, 4, 4.1, 4.2, 4.3, 4.4],
          contractsTotal: 1,
        },
        contracts_total: 1,
        contracts_added: 0,
      },
    },
  });

  render(<PredictionMarkets />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });
  expect(screen.queryByRole('table', { name: 'CPI contracts' })).not.toBeInTheDocument();
  expect(screen.queryByText('59c')).not.toBeInTheDocument();
  expect(screen.queryByText('61c')).not.toBeInTheDocument();
  expect(screen.queryByText('37c')).not.toBeInTheDocument();
});

test('flagged stale, cache, seed, mock, wrong-release, and expired provider rows stay hidden', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  const rejectedProviderEvents = [
    'stale_quote',
    'portfolio_seed',
    'mock',
    'cached',
    'wrong_release',
    'expired_contract',
  ].map((flag, index) => makeLiveKalshiCpiEvent(3.0 + (index / 10), {
    id: `kalshi:rejected-${flag}`,
    volume: 1000 + index,
    data_quality_flags: [flag],
  }));
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: [
      {
        id: 'ibkr:872435625',
        venue: 'IBKR',
        source_api: 'IBKR_TWS_API',
        tradable_in_ibkr: true,
        category: 'Inflation',
        underlying: 'KXCPIYOY',
        contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
        question: 'KXCPIYOY-26JUN-T3.8_YES',
        api_raw_symbol: 'KXCPIYOY-26JUN-T3.8_YES',
        yes_bid: 0.35,
        yes_ask: 0.36,
        no_bid: 0.64,
        no_ask: 0.65,
        volume: 1000,
        data_quality_flags: ['portfolio_seed', 'stale_quote'],
      },
    ],
    providerEvents: rejectedProviderEvents,
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
        execution_ready: true,
        gateway: { ok: true },
        last_success_at: '2026-06-20T01:56:17.766Z',
        cpi_discovery: {
          ...CPI_DISCOVERY,
          foundStrikes: [3.8],
          missingStrikes: [3.9, 4, 4.1, 4.2, 4.3, 4.4],
          contractsTotal: 1,
        },
        contracts_total: 1,
        contracts_added: 0,
      },
    },
  });

  const { container } = render(<PredictionMarkets />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });
  expect(container.querySelector('.cpi-contract-table')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Calculate' })).toBeDisabled();
  expect(screen.queryByText(/^Live \d/i)).not.toBeInTheDocument();
  expect(screen.queryByText('35c')).not.toBeInTheDocument();
  expect(screen.queryByText('36c')).not.toBeInTheDocument();
  rejectedProviderEvents.forEach((event) => {
    expect(screen.queryByText(event.question)).not.toBeInTheDocument();
  });
});

test('offline provider payloads cannot render positive-volume CPI rows', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: LIVE_CPI_EVENTS,
    providerEvents: LIVE_CPI_EVENTS,
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'sidecar_offline',
        execution_ready: false,
        gateway: { ok: false },
      },
    },
  });

  render(<PredictionMarkets />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(predictionMarketsIngestService.refreshIbkr).toHaveBeenCalled();
  });
  expect(screen.queryByRole('table', { name: 'CPI contracts' })).not.toBeInTheDocument();
  expect(screen.queryByText('Above 3.8 YES')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Calculate' })).toBeDisabled();
  expect(screen.queryByText(/^Live \d/i)).not.toBeInTheDocument();
});

test('discover sends CPI target context and surfaces diagnostics', async () => {
  render(<PredictionMarkets />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });

  predictionMarketsIngestService.discoverIbkr.mockClear();
  const discoverButton = screen.getByRole('button', { name: 'Discover IBKR Contracts' });
  await waitFor(() => {
    expect(discoverButton).not.toBeDisabled();
  });
  fireEvent.click(discoverButton);

  await waitFor(() => {
    expect(predictionMarketsIngestService.discoverIbkr).toHaveBeenCalledWith({});
  });
});

test('historical month selection never changes the operational refresh request', async () => {
  render(<PredictionMarkets />);

  await waitFor(() => expect(predictionMarketsIngestService.refreshIbkr).toHaveBeenCalledWith({}));
  predictionMarketsIngestService.refreshIbkr.mockClear();
  fireEvent.click(await screen.findByRole('button', { name: /Oct 25/i }));
  expect(screen.getByRole('heading', { name: /CPI OCT 2025/i })).toBeInTheDocument();
  expect(screen.getByText('Historical view')).toBeInTheDocument();
  expect(screen.getAllByText('Oct 25 has passed')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Refresh Quotes' })).not.toBeInTheDocument();
  expect(predictionMarketsIngestService.refreshIbkr).not.toHaveBeenCalled();
});

test('refresh timeout clears spinner and leaves an explicit no-live-data error state', async () => {
  predictionMarketsIngestService.refreshIbkr.mockRejectedValueOnce(new Error('IBKR sidecar timed out after 30000ms'));

  render(<PredictionMarkets />);

  expect(await screen.findByRole('heading', { name: /CPI JUN 2026/i })).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });

  await waitFor(() => {
    expect(predictionMarketsIngestService.refreshIbkr).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Refresh Quotes' })).not.toBeDisabled();
  });
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
});
