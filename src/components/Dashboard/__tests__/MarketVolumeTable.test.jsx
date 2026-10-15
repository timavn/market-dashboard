import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import MarketVolumeTable from '../MarketVolumeTable';
import { useDashboardResource } from '../../../hooks/useDashboardResource';
import {
  EXCHANGE_VOLUME_METHODOLOGY,
  EXCHANGE_VOLUME_WINDOWS,
  calculateExchangeVolumeMetrics,
} from '../../../utils/exchangeVolume.cjs';
import {
  exUsVolumeMetadata,
  requiredExUsVolumeDates,
} from '../../../utils/exUsVolume.cjs';
import { EX_US_VOLUME_PROXY } from '../../../constants/volumeMarkets.cjs';

jest.mock('../../../hooks/useDashboardResource', () => ({ useDashboardResource: jest.fn() }));
jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: { getMarketShareVolume: jest.fn() },
}));

const verifiedResponse = () => ({
  asOf: '2026-09-08',
  totalMarket: [],
  totalExchange: [
    { date: '2026-09-08', volume: 120 },
    { date: '2026-09-04', volume: 100 },
  ],
  metrics: {
    exchange: {
      priorDay: 120, avg1M: 100, avg3M: 100, avg1Y: 100,
      pctPriorDay: 20, pct1M: 4, pct3M: -12, pct1Y: -15,
    },
  },
  meta: {
    status: 'current',
    verified: true,
    provider: 'Cboe',
    sourceType: 'cboe-consolidated-volume',
    methodologyVersion: EXCHANGE_VOLUME_METHODOLOGY,
    asOfTradingDate: '2026-09-08',
    expectedTradingDate: '2026-09-08',
    fetchedAt: '2026-09-09T12:59:00.000Z',
    comparisonWindows: EXCHANGE_VOLUME_WINDOWS,
    sourceBreakdown: [{
      id: 'cboeConsolidatedVolume', label: 'Cboe', provider: 'Cboe',
      dataset: 'Historical Market Volume',
      description: 'Tape A+B+C share volume, including FINRA-reported trades in listed stocks.',
    }],
  },
});

const verifiedExUsResponse = (volumeAtIndex = index => index === 0 ? 150 : index === 1 ? 120 : 100) => {
  const asOf = '2026-09-08';
  const totalExchange = requiredExUsVolumeDates(asOf).map((date, index) => ({ date, volume: volumeAtIndex(index) }));
  return {
    asOf,
    totalMarket: [],
    totalExchange,
    metrics: { exchange: calculateExchangeVolumeMetrics(totalExchange.map(row => row.volume)) },
    meta: exUsVolumeMetadata(asOf, '2026-09-09T12:59:00.000Z', 'current', {
      contract: { ...EX_US_VOLUME_PROXY.instrument, conId: 49954149 },
    }),
  };
};

const verifiedBothResponse = () => ({ ...verifiedResponse(), exUs: verifiedExUsResponse() });

const resource = (data, overrides = {}) => ({
  data, error: null, initialLoading: false, availability: 'reference', ...overrides,
});

const expectUnavailable = () => {
  expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
  expect(screen.queryByText('9/8')).not.toBeInTheDocument();
  expect(screen.queryByText('20%')).not.toBeInTheDocument();
  const table = screen.getByRole('table', { name: 'Exchange volume comparisons' });
  expect(within(table).getAllByText('—')).toHaveLength(8);
  expect(table.querySelector('.positive, .negative, .mw-trend-up, .mw-trend-down')).toBeNull();
};

describe('MarketVolumeTable', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-09T13:00:00.000Z'));
    useDashboardResource.mockReset();
  });

  afterEach(() => { jest.useRealTimers(); });

  it('renders the US server comparisons and an unavailable ex-US row when its source is absent', () => {
    useDashboardResource.mockReturnValue(resource(verifiedResponse()));

    render(<MarketVolumeTable />);

    const table = screen.getByRole('table', { name: 'Exchange volume comparisons' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('US')).toBeInTheDocument();
    expect(within(table).getByText('ex-US')).toBeInTheDocument();
    expect(within(table).queryByText(/Total Market/)).not.toBeInTheDocument();
    const usRow = within(table).getByRole('row', { name: 'US volume' });
    expect(within(usRow).getAllByRole('cell').slice(1).map(({ textContent }) => textContent))
      .toEqual(['20%', '4%', '-12%', '-15%']);
    expect(within(screen.getByRole('row', { name: 'ex-US volume unavailable' })).getAllByText('—')).toHaveLength(4);
    expect(screen.getByText('9/8')).toHaveAttribute('dateTime', '2026-09-08');
    expect(screen.queryByText(/Cboe:/)).not.toBeInTheDocument();
    expect(useDashboardResource.mock.calls.at(-1)[2]).toEqual(expect.objectContaining({
      pollIntervalMs: 15 * 60 * 1000,
      refreshOnActivate: false,
    }));
  });

  it('keeps the compact card to two market rows and numbers, with its date supplied to the parent', () => {
    const onHeaderNoteChange = jest.fn();
    const onMetadataChange = jest.fn();
    const onSourcesChange = jest.fn();
    useDashboardResource.mockReturnValue(resource(verifiedBothResponse()));

    render(<MarketVolumeTable showAsOf={false} onHeaderNoteChange={onHeaderNoteChange} onMetadataChange={onMetadataChange} onSourcesChange={onSourcesChange} />);

    expect(within(screen.getByRole('row', { name: 'US volume' })).getByText('20%')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: 'ex-US volume' })).getAllByRole('cell').slice(1).map(({ textContent }) => textContent))
      .toEqual(['25%', '49%', '50%', '50%']);
    expect(screen.queryByText(/AS OF|ACWX|IBKR|Cboe|proxy|overseas|trading-session averages/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('9/8')).not.toBeInTheDocument();
    expect(onHeaderNoteChange).toHaveBeenLastCalledWith('9/8');
    expect(onMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'current', verified: true, asOfTradingDate: '2026-09-08',
    }));
    expect(onSourcesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'cboeConsolidatedVolume', status: 'current', updatedAt: '2026-09-08' }),
      expect.objectContaining({ id: 'exUs', status: 'current', updatedAt: '2026-09-08' }),
    ]);
  });

  it('shows source and comparison windows only in the existing detail view', () => {
    useDashboardResource.mockReturnValue(resource(verifiedBothResponse()));

    render(<MarketVolumeTable showDetails />);

    expect(screen.getByText(/Cboe consolidated Tape A\+B\+C/)).toBeInTheDocument();
    expect(screen.getByText(/ACWX.*IBKR/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'iShares MSCI ACWI ex U.S. ETF' })).toHaveAttribute('href', EX_US_VOLUME_PROXY.issuerUrl);
    expect(screen.getByText(/not total overseas-exchange volume/)).toBeInTheDocument();
    expect(screen.getByText(/21, 60 and 250 trading-session averages/)).toBeInTheDocument();
    expect(screen.getByText(/not as a standalone bullish or bearish signal/)).toBeInTheDocument();
  });

  it('clears values and parent metadata if a refresh fails while the resource retains old data', () => {
    const data = verifiedBothResponse();
    const onMetadataChange = jest.fn();
    const onHeaderNoteChange = jest.fn();
    const onLastUpdatedChange = jest.fn();
    const onSourcesChange = jest.fn();
    const props = { onMetadataChange, onHeaderNoteChange, onLastUpdatedChange, onSourcesChange };
    useDashboardResource.mockReturnValue(resource(data));
    const { rerender } = render(<MarketVolumeTable {...props} />);
    expect(screen.getByText('20%')).toBeInTheDocument();

    useDashboardResource.mockReturnValue(resource(data, { error: new Error('offline') }));
    rerender(<MarketVolumeTable {...props} />);

    expectUnavailable();
    expect(onHeaderNoteChange).toHaveBeenLastCalledWith('');
    expect(onLastUpdatedChange).toHaveBeenLastCalledWith(null);
    expect(onMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'unavailable', asOfTradingDate: null, verified: false,
    }));
    expect(onSourcesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ status: 'defective', updatedAt: null }),
      expect.objectContaining({ status: 'defective', updatedAt: null }),
    ]);
  });

  it.each([
    ['US', 'ex-US', 'cboeConsolidatedVolume', 'exUs', '25%'],
    ['ex-US', 'US', 'exUs', 'cboeConsolidatedVolume', '20%'],
  ])('clears only %s after its provider fails and keeps the other market and parent date', (failedMarket, survivingMarket, failedId, survivingId, survivingValue) => {
    const data = verifiedBothResponse();
    const onMetadataChange = jest.fn();
    const onHeaderNoteChange = jest.fn();
    const onLastUpdatedChange = jest.fn();
    const onSourcesChange = jest.fn();
    const props = { onMetadataChange, onHeaderNoteChange, onLastUpdatedChange, onSourcesChange };
    useDashboardResource.mockReturnValue(resource(data));
    const { rerender } = render(<MarketVolumeTable {...props} />);
    expect(screen.getByRole('row', { name: `${failedMarket} volume` })).toBeInTheDocument();

    const failedResponse = failedMarket === 'US' ? data : data.exUs;
    failedResponse.meta.status = 'offline';
    failedResponse.meta.verified = false;
    useDashboardResource.mockReturnValue(resource(data));
    rerender(<MarketVolumeTable {...props} />);

    const failedRow = screen.getByRole('row', { name: `${failedMarket} volume unavailable` });
    expect(within(failedRow).getAllByText('—')).toHaveLength(4);
    expect(failedRow.querySelector('.positive, .negative, .mw-trend-up, .mw-trend-down')).toBeNull();
    expect(within(screen.getByRole('row', { name: `${survivingMarket} volume` })).getByText(survivingValue)).toBeInTheDocument();
    expect(screen.queryByText('UNAVAILABLE')).not.toBeInTheDocument();
    expect(onHeaderNoteChange).toHaveBeenLastCalledWith('9/8');
    expect(onLastUpdatedChange).toHaveBeenLastCalledWith('2026-09-08');
    expect(onMetadataChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'partial', verified: true, asOfTradingDate: '2026-09-08',
    }));
    expect(onSourcesChange).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: failedId, status: 'defective', updatedAt: null }),
      expect.objectContaining({ id: survivingId, status: 'current', updatedAt: '2026-09-08' }),
    ]));
  });

  // Shared assertions verify cleared cells, date, colors and direction.
  // eslint-disable-next-line jest/expect-expect
  it.each([
    ['stale', (data) => { data.meta.status = 'stale'; }],
    ['offline', (data) => { data.meta.status = 'offline'; }],
    ['cache-only', (data) => { data.meta.cacheOnly = true; }],
    ['cached response wrapper', (data) => { data._cache = { hit: true }; }],
    ['seeded', (data) => { data.meta.seeded = true; }],
    ['mock', (data) => { data.meta.mock = true; }],
    ['old methodology', (data) => { data.meta.methodologyVersion = 'hedgeye-volume-slide-direct-v1'; }],
    ['missing verification', (data) => { delete data.meta.verified; }],
    ['old market date with a fresh fetch', (data) => {
      data.asOf = '2026-09-04';
      data.meta.asOfTradingDate = '2026-09-04';
      data.totalExchange[0].date = '2026-09-04';
    }],
  ])('withholds %s data', (_label, invalidate) => {
    const data = verifiedResponse();
    invalidate(data);
    useDashboardResource.mockReturnValue(resource(data));

    render(<MarketVolumeTable />);

    expectUnavailable();
  });

  it.each([
    ['stale', data => { data.meta.status = 'stale'; }],
    ['old verification', data => { data.meta.fetchedAt = '2026-09-09T12:00:00.000Z'; }],
    ['disconnected', data => { data.meta.providerConnected = false; }],
    ['cache-only', data => { data.meta.cacheOnly = true; }],
    ['cached response', data => { data._cache = { hit: true }; }],
    ['seeded', data => { data.meta.seeded = true; }],
    ['mock', data => { data.meta.mock = true; }],
  ])('withholds %s ex-US data while retaining verified US comparisons', (_label, invalidate) => {
    const data = verifiedBothResponse();
    invalidate(data.exUs);
    useDashboardResource.mockReturnValue(resource(data));

    render(<MarketVolumeTable />);

    expect(within(screen.getByRole('row', { name: 'ex-US volume unavailable' })).getAllByText('—')).toHaveLength(4);
    expect(within(screen.getByRole('row', { name: 'US volume' })).getByText('20%')).toBeInTheDocument();
    expect(screen.getByText('9/8')).toHaveAttribute('dateTime', '2026-09-08');
  });

  // eslint-disable-next-line jest/expect-expect -- uses the shared unavailable assertions
  it('withholds both markets when the whole response is a cached wrapper', () => {
    useDashboardResource.mockReturnValue(resource({ ...verifiedBothResponse(), _cache: { hit: true } }));

    render(<MarketVolumeTable />);

    expectUnavailable();
  });

  // eslint-disable-next-line jest/expect-expect -- uses the shared unavailable assertions
  it('withholds a browser-persisted response until the provider verifies it', () => {
    useDashboardResource.mockReturnValue(resource(verifiedBothResponse(), { hydratedFromStorage: true }));

    render(<MarketVolumeTable />);

    expectUnavailable();
  });

  it('keeps zero and unavailable values neutral', () => {
    const data = verifiedResponse();
    data.metrics.exchange.pctPriorDay = 0;
    data.metrics.exchange.pct1Y = null;
    data.exUs = verifiedExUsResponse(index => index === 100 ? null : 100);
    useDashboardResource.mockReturnValue(resource(data));

    render(<MarketVolumeTable />);

    const zeroCells = screen.getAllByText('0%');
    expect(zeroCells).toHaveLength(4);
    for (const cell of zeroCells) {
      expect(cell).toHaveClass('region-mw-heat--na');
      expect(cell).not.toHaveClass('positive', 'negative');
    }
    const unavailableCells = screen.getAllByText('—');
    expect(unavailableCells).toHaveLength(2);
    for (const cell of unavailableCells) expect(cell).toHaveClass('region-mw-heat--na');
    expect(screen.queryByText('▲')).not.toBeInTheDocument();
  });
});
