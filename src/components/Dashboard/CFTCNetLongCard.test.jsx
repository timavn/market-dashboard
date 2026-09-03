import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import CFTCNetLongCard from './CFTCNetLongCard';

jest.mock('axios', () => ({ get: jest.fn() }));


const CURRENT_ROW = {
  category: 'EQUITIES',
  metric: 'SPX (Index + E-mini)',
  cftcContractMarketCode: '13874A',
  seriesType: 'legacy-noncommercial-combined',
  asOf: '2026-08-11',
  status: 'current',
  decisionEligible: true,
  latest: 25427,
  wwChg: 32375,
  zScore1Y: 2.42,
  zScore3Y: 1.62,
};

const snapshot = (overrides = {}) => ({
  date: '2026-08-11',
  reportDate: '2026-08-11',
  source: 'cftc-public-reporting-environment',
  contentComplete: true,
  decisionEligible: true,
  data: [CURRENT_ROW],
  ...overrides,
});

const resource = (data, overrides = {}) => ({
  data,
  loading: false,
  refreshing: false,
  error: null,
  ...overrides,
});

describe('CFTCNetLongCard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-17T15:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders the loading state without stale rows', () => {
    render(<CFTCNetLongCard resourceState={resource(null, { loading: true })} />);
    expect(screen.getByText('Loading CFTC Data...')).toBeInTheDocument();
    expect(screen.queryByText('SPX (Index + E-mini)')).not.toBeInTheDocument();
  });

  test('labels a current verified report as official CFTC', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot())} />);
    expect(screen.getByTestId('cftc-source-badge')).toHaveTextContent('OFFICIAL CFTC');
    expect(screen.getByTestId('cftc-freshness')).toHaveTextContent('AS OF AUG 11');
    expect(screen.getByText('SPX (Index + E-mini)')).toBeInTheDocument();
    expect(screen.getByText('25,427')).toBeInTheDocument();
    expect(screen.getByText(/Official Combined futures \+ options/)).toBeInTheDocument();
  });

  test('shows partial and unavailable rows explicitly', () => {
    const partial = {
      ...CURRENT_ROW,
      category: 'COMMODITIES',
      metric: 'GOLD',
      cftcContractMarketCode: '088691',
      seriesType: 'disaggregated-managed-money-combined',
      status: 'partial',
      decisionEligible: false,
      zScore3Y: null,
    };
    const unavailable = {
      ...partial,
      metric: 'COPPER',
      cftcContractMarketCode: '085692',
      status: 'unavailable',
      latest: null,
      wwChg: null,
      zScore1Y: null,
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      contentComplete: false,
      data: [CURRENT_ROW, partial, unavailable],
    }))} />);
    expect(screen.getByTestId('cftc-freshness')).toHaveTextContent('PARTIAL · AS OF AUG 11');
    expect(screen.getByTestId('cftc-row-status-088691')).toHaveTextContent('PARTIAL');
    expect(screen.getByTestId('cftc-row-status-085692')).toHaveTextContent('UNAVAILABLE');
  });

  test('renders stale retained data as unmistakable reference-only data', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      date: '2026-07-28',
      reportDate: '2026-07-28',
      data: [{ ...CURRENT_ROW, asOf: '2026-07-28' }],
    }))} />);
    expect(screen.getByTestId('cftc-freshness')).toHaveTextContent(
      'STALE · REFERENCE ONLY · AS OF JUL 28',
    );
  });

  test('renders an explicit unavailable body when the official table has no rows', () => {
    render(<CFTCNetLongCard resourceState={resource(snapshot({
      contentComplete: false,
      decisionEligible: false,
      data: [],
    }))} />);
    expect(screen.getByTestId('cftc-unavailable')).toHaveTextContent('OFFICIAL CFTC ROWS UNAVAILABLE');
    expect(screen.getByTestId('cftc-freshness')).toHaveTextContent('REFERENCE ONLY');
  });

  test('preserves Eurodollar as a dated discontinued reference', () => {
    const eurodollar = {
      category: 'RATES',
      metric: 'Eurodollar',
      cftcContractMarketCode: '132741',
      seriesType: 'legacy-noncommercial-combined',
      asOf: '2023-06-13',
      status: 'discontinued',
      decisionEligible: false,
      latest: 47762,
      wwChg: -6488,
      zScore1Y: null,
      zScore3Y: null,
    };
    render(<CFTCNetLongCard resourceState={resource(snapshot({ data: [CURRENT_ROW, eurodollar] }))} />);
    expect(screen.getByTestId('cftc-row-status-132741')).toHaveTextContent(
      'DISCONTINUED · 2023-06-13',
    );
  });
});
