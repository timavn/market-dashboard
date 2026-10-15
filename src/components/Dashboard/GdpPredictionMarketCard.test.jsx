import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import GdpPredictionMarketCard from './GdpPredictionMarketCard';
import { buildGdpContractRows, gdpThresholdGap, selectGdpForecasts, selectGdpReadings } from '../../utils/gdpPredictionMarket';
import cardView from '../../services/predictionMarketTest/cardView.cjs';
import officialHistory from '../../../data/research/gdp/official-history.json';

const { createCardView } = cardView;

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

const NOW = Date.parse('2026-09-09T16:00:00.000Z');
const QUARTER = '2026-Q3';
const UNIT = 'percent_qoq_saar';
const BEA = 'https://www.bea.gov/news/schedule';
const forecast = (overrides = {}) => ({
  sourceId: 'hedgeye', value: 4.02, quarter: QUARTER, unit: UNIT,
  modelType: 'gdp_nowcast', publishedAt: '2026-08-31T12:00:00.000Z',
  sourceUrl: 'https://app.hedgeye.com/feed_items/186614', targetStage: null,
  reviewedAt: '2026-09-09T15:00:00.000Z', verifiedAt: '2026-09-09T15:00:00.000Z', ...overrides,
});
const reading = (overrides = {}) => ({
  quarter: QUARTER, unit: UNIT, stage: 'advance', value: 3.8,
  releasedAt: '2026-10-29T12:30:00.000Z', sourceUrl: 'https://www.bea.gov/news/2026/gdp', ...overrides,
});
function snapshot() {
  const event = {
    ticker: 'RGDP_Q326', generationId: 'RGDP_Q326', productCode: 'RGDP',
    measuredQuarter: QUARTER, settlementStage: 'third', unit: UNIT,
    closeTime: '2026-12-23T13:30:00.000Z', resolutionAt: '2026-12-23T13:30:00.000Z',
    payoutAt: '2026-12-23T15:00:00.000Z',
    rulesUrl: 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf',
  };
  return {
    status: 'available',
    gdp: {
      quarter: QUARTER, metric: 'real_gdp', unit: UNIT,
      schedule: [
        { stage: 'advance', releaseAt: '2026-10-29T12:30:00.000Z', sourceUrl: BEA },
        { stage: 'second', releaseAt: '2026-11-25T13:30:00.000Z', sourceUrl: BEA },
        { stage: 'third', releaseAt: '2026-12-23T13:30:00.000Z', sourceUrl: BEA },
      ],
      forecasts: [forecast(), forecast({
        sourceId: 'gdpnow', value: 4.7, publishedAt: '2026-09-03T16:00:00.000Z',
        sourceUrl: 'https://www.atlantafed.org/research-and-data/data/gdpnow', targetStage: 'advance',
      })],
      forecastHistory: [forecast({ value: 3.95, publishedAt: '2026-08-28T12:00:00.000Z' }), forecast()],
      readings: [],
      priorQuarter: { quarter: '2026-Q2', schedule: [
        { stage: 'third', releaseAt: '2026-09-30T12:30:00.000Z', sourceUrl: BEA },
      ], readings: [reading({ quarter: '2026-Q2', stage: 'second', value: 3.3, releasedAt: '2026-08-27T12:30:00.000Z' })] },
      futureForecasts: [],
    },
    contracts: {
      status: 'available', source: 'ibkr_tws_forecastex_live',
      asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), event,
      lines: [-0.5, 0, 4].map((threshold) => ({
        contractId: `RGDP_Q326_${threshold}`, threshold, comparator: '>',
        source: 'ibkr_tws_forecastex_live', status: 'available', directNative: true, derivedFields: [],
        updatedAt: new Date(NOW).toISOString(),
        yesBid: 0.43, yesAsk: 0.47, noBid: null, noAsk: 0.59,
        yesBidSize: 20, yesAskSize: 30, noBidSize: null, noAskSize: 15,
        volume24h: 112, openInterest: 345,
      })),
    },
  };
}

function addMetadataCatalog(data) {
  data.marketId = 'gdp';
  data.selectedVenueId = 'forecastex';
  data.venues = { forecastex: {
    id: 'forecastex', label: 'ForecastEx', book: data.contracts, contracts: data.contracts,
    catalog: {
      status: 'available', source: 'forecastex_official_contracts', asOf: new Date(NOW).toISOString(),
      event: data.contracts.event, lines: [],
      thresholds: data.contracts.lines.map((line) => ({
        contractId: line.contractId, threshold: line.threshold, comparator: '>',
        openInterest: 1234, volume24h: null,
        activityAsOf: new Date(NOW).toISOString(),
        activitySourceUrl: 'https://www.forecastex.com/api/contracts?page=1&pageSize=1000&productId=RGDP',
      })),
    },
  } };
  return data;
}

describe('GDP prediction-market card', () => {
  const ladder = () => within(screen.getByRole('region', { name: 'GDP ForecastEx contract ladder' }));
  const details = (label) => { const button = screen.getByRole('button', { name: label }); button.focus(); fireEvent.click(button); };
  test('matches the approved full-width history, comparison strip, and two-panel lower layout', () => {
    render(<GdpPredictionMarketCard snapshot={snapshot()} nowMs={NOW} />);
    expect(screen.getByRole('heading', { name: 'U.S. REAL GDP · QoQ SAAR' })).toBeInTheDocument();
    expect(screen.getByLabelText('GDP release history by quarter and Hedgeye quarterly estimates')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Selected GDP release comparison' })).toBeInTheDocument();
    expect(ladder().getByRole('heading', { name: 'ForecastEx contracts · Q3 2026' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'GDP growth components' })).toBeInTheDocument();
    expect(ladder().getByText(/First report:/)).toHaveTextContent('Oct 29');
    expect(ladder().getByText(/First report:/)).toHaveTextContent('Dec 23 · Third reading');
    expect(screen.getAllByText('5:30 a.m. Pacific / 8:30 a.m. Eastern').length).toBeGreaterThan(0);
    expect(screen.getByText('The October report may move this contract’s price; December’s third reading decides it.')).toBeInTheDocument();
    details('Forecasts & schedule');
    const board = within(screen.getByRole('region', { name: 'GDP forecast board' }));
    expect(board.getByText('4.02%')).toBeInTheDocument();
    expect(board.getByText('Aug 31 · Release target unconfirmed')).toBeInTheDocument();
    expect(board.getByText('Sep 3 · First reading')).toBeInTheDocument();
    expect(board.getByRole('row', { name: /Consensus/ })).toHaveTextContent('UNAVAILABLE');
  });

  test('appends two dated Hedgeye quarters without changing the selected actual or comparison source', () => {
    const data = snapshot();
    data.gdp.futureForecasts = [forecast({ quarter: '2026-Q4', value: 1.46, modelType: 'Enhanced Comparative Base Effects Model' })];
    render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    const selected = screen.getByRole('region', { name: 'Selected GDP release comparison' });
    const before = selected.textContent;
    const q3 = screen.getByRole('button', { name: 'Q3 2026 Hedgeye estimate, 4.02%, published 2026-08-31' });
    const q4 = screen.getByRole('button', { name: 'Q4 2026 Hedgeye estimate, 1.46%, published 2026-08-31' });
    const historyBar = screen.getByRole('button', { name: /Q2 2026 2nd reading/ });
    expect(Number(q3.querySelector('rect.pm-gdp-forecast-fill').getAttribute('x'))).toBeGreaterThan(Number(historyBar.querySelector('rect.pm-gdp-bar-fill').getAttribute('x')));
    expect(Number(q4.querySelector('rect.pm-gdp-forecast-fill').getAttribute('x'))).toBeGreaterThan(Number(q3.querySelector('rect.pm-gdp-forecast-fill').getAttribute('x')));
    fireEvent.change(screen.getByLabelText('GDP chart comparison source'), { target: { value: 'consensus' } });
    expect(q3).toHaveTextContent('4.02%');
    expect(q4).toHaveTextContent('1.46%');
    q4.focus();
    fireEvent.keyDown(q4, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Forecasts & schedule' })).toHaveTextContent('Enhanced Comparative Base Effects Model');
    expect(selected.textContent).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Close GDP details' }));
    expect(q4).toHaveFocus();
  });

  test('keeps a missing Q4 forecast blank without borrowing GDPNow or Q3', () => {
    const data = snapshot();
    data.gdp.futureForecasts = [forecast({ quarter: '2026-Q4', unit: 'percent_yoy', value: 2.28 })];
    render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    const q4 = screen.getByRole('group', { name: 'Q4 2026 Hedgeye estimate, unavailable' });
    expect(q4).toHaveTextContent('Unavailable');
    expect(q4.querySelector('.pm-gdp-forecast-fill')).toBeNull();
    expect(screen.getByRole('button', { name: /Q3 2026 Hedgeye estimate, 4.02%/ })).toBeInTheDocument();
  });

  test('uses uniform quarter dividers, bar widths, release spacing and symmetric edge padding', () => {
    const data = snapshot();
    data.gdp.readingHistory = officialHistory.records.filter((r) => r.kind === 'reading');
    data.gdp.priorQuarter.readings = [];
    data.gdp.futureForecasts = [forecast({ quarter: '2026-Q4', value: 1.46 })];
    render(<GdpPredictionMarketCard snapshot={data} nowMs={Date.parse('2026-09-10T18:00:00Z')} />);
    const chart = screen.getByLabelText('GDP release history by quarter and Hedgeye quarterly estimates');
    const dividers = [...chart.querySelectorAll('.pm-gdp-quarter-line')].map((line) => Number(line.getAttribute('x1'))).sort((a, b) => a - b);
    expect(dividers).toHaveLength(8);
    const quarterWidth = dividers[1] - dividers[0];
    dividers.slice(1).forEach((x, i) => expect(x - dividers[i]).toBeCloseTo(quarterWidth));
    const widths = [...chart.querySelectorAll('.pm-gdp-bar-fill, .pm-gdp-forecast-fill')].map((bar) => Number(bar.getAttribute('width')));
    expect(widths).toHaveLength(15);
    widths.forEach((width) => expect(width).toBeCloseTo(widths[0]));
    const barCenter = (name) => {
      const bar = screen.getByRole('button', { name }).querySelector('.pm-gdp-bar-fill');
      return Number(bar.getAttribute('x')) + Number(bar.getAttribute('width')) / 2;
    };
    const releaseCenters = [
      /Q4 2025 1st reading/, /Q4 2025 2nd reading/, /Q4 2025 3rd reading/,
      /Q1 2026 1st reading/, /Q1 2026 2nd reading/, /Q1 2026 3rd reading/,
    ].map(barCenter);
    releaseCenters.slice(1).forEach((x, i) => expect(x - releaseCenters[i]).toBeCloseTo(quarterWidth / 3));
    expect(releaseCenters[3] - dividers[3]).toBeCloseTo(dividers[4] - releaseCenters[5]);
    const initial = barCenter(/Q3 2025 Initial reading/);
    const updated = barCenter(/Q3 2025 Updated reading/);
    expect(initial - dividers[1]).toBeCloseTo(dividers[2] - updated);
    expect(updated - initial).toBeCloseTo(quarterWidth / 3);
    expect(screen.getByRole('button', { name: /Q2 2025 1st reading, 2025-07-30/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Q2 2025 2nd reading, 2025-08-28/ })).toBeInTheDocument();
    const pending = screen.getByRole('group', { name: 'Q2 2026 3rd reading pending, 2026-09-30' });
    expect(pending).toHaveTextContent('Pending');
    expect(pending.querySelector('rect')).toBeNull();
    expect(screen.getByText('Oct–Nov ’25: delayed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /December 23 initial estimate replaced/ })).toHaveAttribute('href', 'https://apps.bea.gov/scb/issues/2026/01-january/0126-charting-economy.htm');
    fireEvent.click(screen.getByRole('button', { name: /Q2 2025 1st reading, 2025-07-30/ }));
    expect(screen.getByRole('region', { name: 'Selected GDP release comparison' })).toHaveTextContent('Selected · Jul 2025');
  });

  test('zero and negative forecasts share the official chart zero baseline and scale', () => {
    const data = snapshot();
    data.gdp.forecasts = [forecast({ value: 0 })];
    data.gdp.forecastHistory = [];
    data.gdp.futureForecasts = [forecast({ quarter: '2026-Q4', value: -2 })];
    render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    const chart = screen.getByLabelText(/GDP release history by quarter/);
    const baseline = Number(chart.querySelector('.pm-gdp-zero').getAttribute('y1'));
    const zero = screen.getByRole('button', { name: /Q3 2026 Hedgeye estimate, 0.00%/ });
    const negative = screen.getByRole('button', { name: /Q4 2026 Hedgeye estimate, -2.00%/ });
    expect(Number(zero.querySelector('.pm-gdp-forecast-fill').getAttribute('y'))).toBe(baseline);
    expect(Number(negative.querySelector('.pm-gdp-forecast-fill').getAttribute('y'))).toBe(baseline);
    expect(Number(negative.querySelector('.pm-gdp-forecast-fill').getAttribute('height'))).toBeGreaterThan(1.5);
    expect(within(chart).getByText('-2.0%')).toBeInTheDocument();
  });

  test('shows only native sides, sizes, spreads and arithmetic gaps', () => {
    render(<GdpPredictionMarketCard snapshot={snapshot()} nowMs={NOW} />);
    const cells = within(ladder().getByRole('row', { name: /> 4.0%/ })).getAllByRole('cell');
    expect(ladder().getByText('LIVE')).toBeInTheDocument();
    expect(cells[0]).toHaveTextContent('43¢20');
    expect(cells[1]).toHaveTextContent('47¢30');
    expect(cells[2]).toHaveTextContent('—');
    expect(cells[3]).toHaveTextContent('59¢15');
    expect(cells[4]).toHaveTextContent('4¢ / —');
    expect(cells[5]).toHaveTextContent('345');
    expect(cells[6]).toHaveTextContent('-0.02');
    expect(ladder().queryByText('53¢')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy|sell|order/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('GDP contract gap reference'), { target: { value: 'gdpnow' } });
    expect(within(ladder().getByRole('row', { name: /> 4.0%/ })).getByText('-0.70')).toBeInTheDocument();
  });

  test('uses compact native contracts even when venue books have only summaries', () => {
    const compact = createCardView(addMetadataCatalog(snapshot()));
    expect(compact.venues.forecastex.book.lines).toBeUndefined();
    render(<GdpPredictionMarketCard snapshot={compact} nowMs={NOW} />);
    expect(ladder().getByText('LIVE')).toBeInTheDocument();
    expect(ladder().getAllByText('43¢')).toHaveLength(3);
  });

  test('published volume is available in the full ladder without inventing its period', () => {
    const data = addMetadataCatalog(snapshot());
    data.contracts.lines = data.contracts.lines.map((row) => ({ ...row, volume24h: null, volume: 2718 }));
    const { rerender } = render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    details(/All thresholds/);
    const modal = within(screen.getByRole('dialog'));
    expect(modal.getAllByTitle(/Published volume · period unspecified/)).toHaveLength(3);
    expect(modal.getAllByText('2,718')).toHaveLength(3);
    data.contracts.lines = data.contracts.lines.map((row) => ({ ...row, volume24h: 112 }));
    rerender(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    expect(modal.getAllByTitle(/24-hour volume/)).toHaveLength(3);
    expect(modal.queryByText('2,718')).not.toBeInTheDocument();
  });

  test('a failed compact refresh keeps catalog metadata and clears prices', () => {
    const data = addMetadataCatalog(snapshot());
    data.contracts = { ...data.contracts, status: 'unavailable', refreshFailed: true, lines: [] };
    data.displayContracts = data.contracts;
    render(<GdpPredictionMarketCard snapshot={createCardView(data)} nowMs={NOW} />);
    expect(ladder().getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(ladder().getByRole('row', { name: /> -0.5%/ })).toBeInTheDocument();
    expect(ladder().getByRole('row', { name: /> 0.0%/ })).toBeInTheDocument();
    expect(ladder().queryByText('43¢')).not.toBeInTheDocument();
    expect(ladder().getAllByText('1,234')).toHaveLength(3);
  });

  test('unreleased stages remain blank and October cannot settle December', () => {
    const data = snapshot();
    data.gdp.readings = [reading(), reading({ quarter: '2026-Q2', value: 7.1, releasedAt: '2026-08-27T12:30:00.000Z' })];
    const { rerender } = render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    details('Forecasts & schedule');
    expect(within(screen.getByLabelText('Q3 official GDP readings')).getAllByText('—')).toHaveLength(3);
    rerender(<GdpPredictionMarketCard snapshot={data} nowMs={Date.parse('2026-10-29T13:00:00Z')} />);
    const official = within(screen.getByLabelText('Q3 official GDP readings'));
    expect(official.getByLabelText('First reading')).toHaveTextContent('3.8%');
    expect(official.getByLabelText('First revision')).toHaveTextContent('—');
    expect(official.getByLabelText('Second revision')).toHaveTextContent('—');
    expect(ladder().getByText(/First report:/)).toHaveTextContent('Dec 23');
    data.gdp.readings.push(reading({ stage: 'second', value: 3.6, releasedAt: '2026-11-25T13:30:00Z' }));
    rerender(<GdpPredictionMarketCard snapshot={data} nowMs={Date.parse('2026-11-25T14:00:00Z')} />);
    expect(official.getByLabelText('First reading')).toHaveTextContent('3.8%');
    expect(official.getByLabelText('First revision')).toHaveTextContent('3.6%');
    expect(official.getByLabelText('Second revision')).toHaveTextContent('—');
  });

  test.each([
    ['offline', { status: 'offline' }], ['provider disconnected', { connected: false }],
    ['failed refresh', { refreshFailed: true }], ['stale flag', { stale: true }],
    ['cache-only', { cacheOnly: true }], ['cached-only', { cachedOnly: true }],
    ['seeded', { seeded: true }], ['mock', { mock: true }], ['cache source', { source: 'ibkr_cache' }],
    ['expired', { expiresAt: new Date(NOW - 1).toISOString() }],
    ['old observation', { asOf: new Date(NOW - 120_000).toISOString() }], ['undated', { asOf: null }],
  ])('clears %s prices while retaining research', (_label, unsafe) => {
    const data = snapshot();
    const { rerender } = render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    data.contracts = { ...data.contracts, ...unsafe };
    rerender(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    expect(ladder().getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(ladder().queryByText('43¢')).not.toBeInTheDocument();
    expect(ladder().queryByText('LIVE')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Hedgeye 4.02%' })).toBeInTheDocument();
  });

  test.each([null, { quarter: '2026-Q2' }, { unit: 'percent_yoy' }, { metric: 'nominal_gdp' }])('does not invent or misassign research %j', (patch) => {
    const data = patch ? snapshot() : null;
    if (patch) Object.assign(data.gdp, patch);
    render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    expect(ladder().getByRole('heading', { name: 'ForecastEx contracts · Q3 2026' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Hedgeye 4.02%' })).not.toBeInTheDocument();
    expect(screen.queryByText('Oct 29')).not.toBeInTheDocument();
  });

  test('disclosures expose clocks, methodology and source pagination with keyboard dismissal', () => {
    render(<GdpPredictionMarketCard snapshot={snapshot()} nowMs={NOW} />);
    details('Contract rules');
    expect(screen.getByText('YES requires the third estimate to be strictly above the threshold. Equality loses for YES.')).toBeVisible();
    ['Trading cutoff', 'Deciding release', 'Expected payout'].forEach((text) => expect(screen.getByText(text)).toBeVisible());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Contract rules' })).toHaveFocus();
    details('Methodology');
    expect(screen.getByText(/Real GDP is inflation-adjusted/)).toBeVisible();
  });

  test('selecting a historical bar updates estimates and drivers while contracts remain pinned', () => {
    const data = snapshot();
    data.gdp.readingHistory = [reading({ quarter: '2026-Q1', value: -0.4, releasedAt: '2026-04-30' }),
      reading({ quarter: '2026-Q1', stage: 'third', value: -0.2, releasedAt: '2026-06-25' })];
    data.gdp.historicalForecasts = [forecast({ quarter: '2026-Q1', sourceId: 'gdpnow', sourceUrl: 'https://www.atlantafed.org/history.xlsx', publishedAt: '2026-04-29', targetStage: 'advance', value: 0.1 })];
    render(<GdpPredictionMarketCard snapshot={data} nowMs={NOW} />);
    const bar = screen.getByRole('button', { name: 'Q1 2026 1st reading, 2026-04-30, -0.4%' });
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(bar).toHaveAttribute('aria-pressed', 'true');
    const strip = within(screen.getByRole('region', { name: 'Selected GDP release comparison' }));
    expect(strip.getByText('Actual -0.5 pp')).toBeInTheDocument();
    expect(strip.getByText('Revised +0.2 pp')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What drove GDP · Q1 2026' })).toBeInTheDocument();
    expect(ladder().getByRole('heading', { name: 'ForecastEx contracts · Q3 2026' })).toBeInTheDocument();
    expect(ladder().getByRole('row', { name: /> 4.0%/ })).toHaveTextContent('-0.02');
    fireEvent.change(screen.getByLabelText('GDP chart comparison source'), { target: { value: 'consensus' } });
    expect(screen.getByLabelText('GDP chart comparison source')).toHaveValue('consensus');
    expect(bar).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('GDP display integrity', () => {
  test('zero and negative forecasts use arithmetic percentage-point gaps', () => {
    expect(gdpThresholdGap(0, 0)).toBe(0);
    expect(gdpThresholdGap(-0.5, -1.2)).toBe(0.7);
    expect(gdpThresholdGap(4, 4.02)).toBe(-0.02);
    expect(gdpThresholdGap(0, null)).toBeNull();
  });

  test('retains official corrections while selecting the latest verification of each reading', () => {
    const original = reading({ verifiedAt: '2026-10-29T12:35:00.000Z' });
    const correction = reading({ value: 3.9, verifiedAt: '2026-10-29T13:00:00.000Z' });
    expect(selectGdpReadings([original, correction], QUARTER, UNIT, Date.parse('2026-10-29T14:00:00.000Z')))
      .toEqual([correction, original]);
  });

  test('rejects unknown dates, wrong quarters/units and unreviewed Hedgeye without guessing targets', () => {
    const invalid = [forecast({ publishedAt: null }), forecast({ quarter: '2026-Q2' }),
      forecast({ unit: 'percent_yoy' }), forecast({ reviewedAt: null }), forecast({ modelType: null })];
    expect(selectGdpForecasts(invalid, QUARTER, NOW)).toEqual([]);
    expect(selectGdpForecasts([forecast({ value: 0 })], QUARTER, NOW)).toEqual([expect.objectContaining({ value: 0, targetStage: null })]);
    expect(selectGdpReadings([reading({ unit: 'percent_yoy' })], QUARTER, UNIT, Date.parse('2027-01-01'))).toEqual([]);
  });

  test.each([
    { measuredQuarter: '2026-Q2' }, { settlementStage: 'advance' }, { generationId: 'RGDP_Q226' },
    { rulesUrl: 'https://example.com/third-estimate.pdf' }, { unit: 'percent_yoy' },
    { rulesUrl: 'https://data.forecastex.com/regulatory/CPITermsandConditions.pdf' },
  ])('withholds conflicting contract identity %j', (fields) => {
    const data = snapshot();
    Object.assign(data.contracts.event, fields);
    expect(buildGdpContractRows(data, QUARTER, NOW).rows).toEqual([]);
  });

  test.each([
    { directNative: false }, { derivedFields: ['noBid'] }, { stale: true }, { mock: true },
    { seeded: true }, { cacheOnly: true }, { providerStatus: 'disconnected' },
    { updatedAt: new Date(NOW - 120_000).toISOString() }, { source: 'ibkr_portfolio' },
  ])('withholds unsafe native line %j', (fields) => {
    const data = snapshot();
    data.contracts.lines = [{ ...data.contracts.lines[0], ...fields }];
    expect(buildGdpContractRows(data, QUARTER, NOW).rows[0]).toMatchObject({ live: false, yesBid: null, noAsk: null });
  });

  test('a contract identifier must agree with its threshold', () => {
    const data = snapshot();
    data.contracts.lines = [{ ...data.contracts.lines[0], threshold: 10 }];
    expect(buildGdpContractRows(data, QUARTER, NOW).rows).toEqual([]);
  });

  test('catalog prices are never used and undated activity remains blank', () => {
    const data = addMetadataCatalog(snapshot());
    data.contracts = { ...data.contracts, status: 'unavailable', lines: [] };
    data.venues.forecastex.catalog.thresholds = data.venues.forecastex.catalog.thresholds.map((line) => ({
      ...line, yesBid: 0.99, yesBidSize: 999, activityAsOf: null,
    }));
    const result = buildGdpContractRows(data, QUARTER, NOW);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ yesBid: null, yesBidSize: null, openInterest: null, volume24h: null, live: false });
  });
});
