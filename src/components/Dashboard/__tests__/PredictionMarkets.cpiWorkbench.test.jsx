import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as PredictionMarketsModule from '../PredictionMarkets';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import {
  getMacroSignalQuotePlan,
  normalizePredictionMarketSignals,
} from '../../../utils/predictionMarketSignals';

const PredictionMarkets = PredictionMarketsModule.default || PredictionMarketsModule;

jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getRiskRanges: jest.fn(),
    getHedgeyeSnapshot: jest.fn(),
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
    forecastMonth: 'May 2026',
    publishedText: '06/03/2026 02:56 PM EDT',
    releaseDate: { date: '2026-07-14' },
    scenarios: [
      { key: 'upside', label: 'Upside', value: 4.19 },
      { key: 'base', label: 'Base Case', value: 4.08 },
      { key: 'downside', label: 'Downside', value: 3.97 },
    ],
  },
};

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
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T3.8_YES',
    question: 'KXCPIYOY-26JUN-T3.8_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T3.8_YES',
    yes_bid: 0.49,
    yes_ask: 0.50,
    no_bid: 0.48,
    no_ask: 0.51,
    max_payout_per_contract: 1,
  },
  {
    id: 'ibkr:3.9',
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T3.9_YES',
    question: 'KXCPIYOY-26JUN-T3.9_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T3.9_YES',
    yes_bid: 0.27,
    yes_ask: 0.28,
    no_bid: 0.70,
    no_ask: 0.73,
    max_payout_per_contract: 1,
  },
  {
    id: 'ibkr:4.0',
    venue: 'IBKR',
    source_api: 'IBKR_TWS_API',
    tradable_in_ibkr: true,
    category: 'Inflation',
    underlying: 'KXCPIYOY',
    contract_title: 'KXCPIYOY-26JUN-T4.0_YES',
    question: 'KXCPIYOY-26JUN-T4.0_YES',
    api_raw_symbol: 'KXCPIYOY-26JUN-T4.0_YES',
    yes_bid: 0.11,
    yes_ask: 0.12,
    no_bid: 0.70,
    no_ask: 0.72,
    max_payout_per_contract: 1,
  },
];

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

beforeEach(() => {
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
});

afterEach(() => {
  jest.clearAllMocks();
  delete global.ResizeObserver;
  delete global.fetch;
});

test('does not render open CPI positions as contract rows when live catalog is missing', async () => {
  const { container } = render(<PredictionMarkets portfolioData={{
    accountId: 'U25779973',
    accountSummary: { netLiquidation: 190539 },
    summary: { totalValue: 190539 },
  }} />);

  expect(await screen.findByText('CPI Model')).toBeInTheDocument();

  await waitFor(() => {
    expect(screen.getByText('CPI Model')).toBeInTheDocument();
  });

  const calendarHeader = container.querySelector('.cpi-calendar-header');
  expect(calendarHeader).toBeInTheDocument();
  expect(screen.queryByText('CPI PREDICTION CALCULATOR')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Assumptions/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Recalculate/i })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'CPI Model' })).toBeInTheDocument();
  expect(calendarHeader).toHaveTextContent('Active: June 2026');
  const settlement = screen.getByText('Settlement Tuesday, July 14, 2026 · 8:30 AM ET');
  expect(settlement).toBeInTheDocument();
  expect(settlement).toHaveClass('cpi-calendar-settlement');
  const jun25Card = screen.getByRole('button', { name: /Jun 25/i });
  const jul25Card = screen.getByRole('button', { name: /Jul 25/i });
  const jun26Card = screen.getByRole('button', { name: /Jun 26/i });
  expect(jun25Card).toHaveTextContent('2.80%');
  expect(jun25Card).toHaveClass('context');
  expect(jul25Card).toHaveTextContent('2.70%');
  expect(jul25Card).toHaveClass('down');
  expect(jun26Card).toHaveAttribute('aria-pressed', 'true');
  expect(jun26Card).toHaveClass('active');
  expect(jun26Card).toHaveClass('neutral');
  expect(jun26Card).toHaveClass('nowcast');
  expect(jun26Card).toHaveTextContent('+10%');
  expect(jun26Card).toHaveTextContent('0%');
  expect(jun26Card).toHaveTextContent('-5%');
  expect(screen.getByRole('button', { name: /May 26/i })).toHaveTextContent('4.25%');
  expect(calendarHeader).not.toHaveTextContent('FINAL PENDING');
  await waitFor(() => {
    expect(jun26Card).toHaveTextContent('3.97');
    expect(jun26Card).toHaveTextContent('4.08%');
  });
  expect(jun26Card).toHaveTextContent('4.08');
  expect(jun26Card).toHaveTextContent('4.19');
  expect(jun26Card.querySelector('.cpi-calendar-scenario-upper-line')).toBeInTheDocument();
  expect(jun26Card.querySelector('.cpi-calendar-scenario-base-line')).toBeInTheDocument();
  expect(jun26Card.querySelector('.cpi-calendar-scenario-lower-line')).toBeInTheDocument();
  expect(jun26Card.querySelector('.cpi-calendar-scenario-base-bar')).not.toBeInTheDocument();
  expect(jun26Card.querySelector('.cpi-calendar-scenario-upper-bar')).not.toBeInTheDocument();
  expect(jul25Card).toHaveTextContent('X.XX upper');
  expect(jul25Card).toHaveTextContent('X.XX base');
  expect(jul25Card).toHaveTextContent('X.XX lower');
  fireEvent.click(screen.getByRole('button', { name: /Oct 25/i }));
  expect(screen.getByText('Active: October 2025')).toBeInTheDocument();
  expect(screen.getByText('Settlement Thursday, November 13, 2025 · 8:30 AM ET')).toBeInTheDocument();
  expect(screen.getByText('Contracts')).toBeInTheDocument();
  expect(screen.getByText('Payday')).toBeInTheDocument();
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText('Live data is unavailable for this section.').length).toBeGreaterThanOrEqual(1);
  expect(container.querySelector('.cpi-ladder-table')).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-matrix-table')).not.toBeInTheDocument();
  expect(screen.queryByText('YES (Above Strike)')).not.toBeInTheDocument();
  expect(screen.queryByText('NO (Below Strike)')).not.toBeInTheDocument();
  expect(screen.queryByText(/KXCPIYOY-26JUN-T4\.0_NO/)).not.toBeInTheDocument();
  expect(screen.queryByText('-$306')).not.toBeInTheDocument();
  expect(screen.queryByText('Open CPI positions found, contract catalog missing')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/IBKR contract provider/i)).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText(/IBKR contract provider/i));

  expect(await screen.findByText('0 of 7 target strikes loaded')).toBeInTheDocument();
  expect(await screen.findByText('7 target strikes shown')).toBeInTheDocument();
  expect(await screen.findByText(/Last refreshed:/)).toBeInTheDocument();
  expect(await screen.findByText('Target strikes: 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4')).toBeInTheDocument();
  expect(await screen.findByText('Found strikes: None')).toBeInTheDocument();
  expect(await screen.findByText('Missing strikes: 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4')).toBeInTheDocument();
  expect(await screen.findByText('Discovered contracts: 0 total, 0 added last run')).toBeInTheDocument();
  expect(screen.queryByText(/using fallback price/)).not.toBeInTheDocument();
});

test('missing CPI nowcast never renders zero estimates or fake recommendation', async () => {
  MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValueOnce({ positions: [], meta: { source: 'ibkr_live' } });

  render(<PredictionMarkets />);

  expect((await screen.findAllByText('Missing Data')).length).toBeGreaterThanOrEqual(1);
  await waitFor(() => {
    expect(predictionMarketsIngestService.refreshIbkr).toHaveBeenCalledWith({
      cpi: expect.objectContaining({
        metric: 'Headline CPI YoY',
        forecastMonth: 'June 2026',
        reportMonth: 'June 2026',
        releaseCode: 'Jun 26',
        targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
      }),
    });
  });
  expect(screen.getAllByText('Live data is unavailable for this section.').length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(/0\.00\s+lower/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/0\.00\s+base/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/0\.00\s+upper/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/3\.8 YES/)).not.toBeInTheDocument();
  expect(screen.queryByText(/4\.0 NO hedge/)).not.toBeInTheDocument();
});

test('connected with no live IBKR catalog clears the spinner and shows no-live-data state', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });

  render(<PredictionMarkets />);

  expect(await screen.findByText('3.97')).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText('Loading IBKR CPI contracts…')).not.toBeInTheDocument();
  });
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText('Live data is unavailable for this section.').length).toBeGreaterThanOrEqual(1);

  fireEvent.click(screen.getByLabelText(/IBKR contract provider/i));
  expect(await screen.findByText('0 of 7 target strikes loaded')).toBeInTheDocument();
  expect(await screen.findByText('Discovered contracts: 0 total, 0 added last run')).toBeInTheDocument();
});

test('live CPI quotes render contracts while payday stays exposure-only without positions', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
  predictionMarketsIngestService.refreshIbkr.mockResolvedValue({
    events: LIVE_CPI_EVENTS,
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
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

  expect(await screen.findByText('Contracts')).toBeInTheDocument();
  await waitFor(() => {
    expect(container.querySelector('.cpi-matrix-table')).toBeInTheDocument();
  });
  expect(screen.getByText('Payday')).toBeInTheDocument();

  const payoffCard = screen.getByText('Payday').closest('.pmv2-card-chrome');
  expect(payoffCard).toBeInTheDocument();
  expect(payoffCard).toHaveTextContent('Missing Data');
  expect(payoffCard).not.toHaveTextContent('Scenario Exposure');
  expect(payoffCard.querySelector('.cpi-payoff-map-svg')).not.toBeInTheDocument();

  const matrixRows = [...container.querySelectorAll('.cpi-matrix-table tbody tr')];
  const row40 = matrixRows.find((row) => row.textContent.includes('Above 4.0 YES'));
  expect(row40).toBeTruthy();
  expect(row40).toHaveTextContent('Loss');
  expect(row40).toHaveTextContent('Win');
  expect(row40).toHaveTextContent('67c');
  expect(row40).toHaveTextContent('12c');
  expect(row40).toHaveTextContent('+55c');
  expect(screen.queryByText('Best Executable Lines')).not.toBeInTheDocument();
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
  const payoffCard = screen.getByText('Payday').closest('.pmv2-card-chrome');
  expect(payoffCard).toHaveTextContent('Downside');
  expect(payoffCard).toHaveTextContent('Base');
  expect(payoffCard).toHaveTextContent('Upside');
  expect(payoffCard).toHaveTextContent('Above 4.0 NO');
  expect(payoffCard).toHaveTextContent('427');
  expect(payoffCard).toHaveTextContent('Net Payoff');
  expect(payoffCard).not.toHaveTextContent('Missing Data');
  expect(screen.queryByText('KXCPIYOY-26JUN-T4.0_NO')).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-matrix-card .cpi-matrix-table')).not.toBeInTheDocument();
  expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText('IBKR connected; CPI positions loaded from portfolio, contract catalog missing')).not.toBeInTheDocument();
  expect(screen.queryByText('4 held CPI positions found; no executable live contract catalog quotes available')).not.toBeInTheDocument();
});

test('one-sided CPI quotes do not fabricate missing ask or mid values', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
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
        yes_bid: 0.59,
        yes_ask: null,
        yes_mid: 0.61,
        no_bid: 0.33,
        no_ask: 0.37,
        no_mid: 0.35,
        max_payout_per_contract: 1,
      },
    ],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
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

  expect(await screen.findByText('CPI Model')).toBeInTheDocument();
  await waitFor(() => {
    expect(container.querySelector('.cpi-matrix-table')).toBeInTheDocument();
  });
  const matrixText = container.querySelector('.cpi-matrix-table').textContent;
  expect(matrixText).not.toContain('Above 3.8 YES');
  expect(matrixText).not.toContain('59c');
  expect(matrixText).not.toContain('61c');
  expect(matrixText).toContain('Above 3.8 NO');
  expect(matrixText).toContain('37c');
});

test('stale or portfolio-seeded CPI rows do not render as live contract data', async () => {
  MarketDataService.getPortfolioPredictionMarketPositions.mockResolvedValue({ positions: [] });
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
        data_quality_flags: ['portfolio_seed', 'stale_quote'],
      },
    ],
    dashboardEvents: [],
    providers: {
      ...PROVIDERS,
      ibkr: {
        status: 'connected',
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

  expect(await screen.findByText('CPI Model')).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });
  expect(container.querySelector('.cpi-ladder-table')).not.toBeInTheDocument();
  expect(container.querySelector('.cpi-matrix-table')).not.toBeInTheDocument();
  expect(screen.queryByText('35c')).not.toBeInTheDocument();
  expect(screen.queryByText('36c')).not.toBeInTheDocument();
});

test('discover sends CPI target context and surfaces diagnostics', async () => {
  render(<PredictionMarkets />);

  expect(await screen.findByText('CPI Model')).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getAllByText('Missing Data').length).toBeGreaterThanOrEqual(1);
  });

  predictionMarketsIngestService.discoverIbkr.mockClear();
  fireEvent.click(screen.getByLabelText(/IBKR contract provider/i));
  const discoverButton = await screen.findByTitle('Discover IBKR event contracts');
  await waitFor(() => {
    expect(discoverButton).not.toBeDisabled();
  });
  fireEvent.click(discoverButton);

  await waitFor(() => {
    expect(predictionMarketsIngestService.discoverIbkr).toHaveBeenCalledWith({
      cpi: expect.objectContaining({
        metric: 'Headline CPI YoY',
        forecastMonth: 'June 2026',
        reportMonth: 'June 2026',
        releaseCode: 'Jun 26',
        targetStrikes: [3.8, 3.9, 4, 4.1, 4.2, 4.3, 4.4],
      }),
    });
  });
  expect(await screen.findByText('Missing strikes: 3.8, 3.9, 4.0, 4.1, 4.2, 4.3, 4.4')).toBeInTheDocument();
});

test('refresh timeout clears spinner and leaves an explicit no-live-data error state', async () => {
  predictionMarketsIngestService.refreshIbkr.mockRejectedValueOnce(new Error('IBKR sidecar timed out after 30000ms'));

  render(<PredictionMarkets />);

  expect(await screen.findByText('CPI Model')).toBeInTheDocument();
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
