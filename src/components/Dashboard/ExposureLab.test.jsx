import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExposureLab from './ExposureLab';
import { resetSessionResourceStore } from '../../utils/sessionResourceStore';

const mockGetExposureLabSnapshot = jest.fn();
const mockGetExposureLabUniverse = jest.fn();
const mockSaveExposureLabSecurityReview = jest.fn();

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: {
    getExposureLabSnapshot: (...args) => mockGetExposureLabSnapshot(...args),
    getExposureLabUniverse: (...args) => mockGetExposureLabUniverse(...args),
    saveExposureLabSecurityReview: (...args) => mockSaveExposureLabSecurityReview(...args),
  },
}));

const snapshot = {
  status: 'available',
  modelVersion: 'exposure-lab-ridge-v2',
  asOf: '2026-08-21',
  historicalOnly: true,
  executable: false,
  portfolioState: { mode: 'live' },
  portfolio: {
    netExposurePct: 6.5,
    grossExposurePct: 18.5,
    predictedAnnualizedVolPct: 11.3,
    factorAnnualizedVolPct: 8.8,
  },
  coverage: {
    modeledGrossNavPct: 18.5,
    modeledPositionCount: 2,
    seasonedPositionCount: 2,
    preliminaryPositionCount: 0,
    totalPositionCount: 2,
  },
  factors: [
    {
      id: 'market', label: 'Market', family: 'Market', formula: 'SPY',
      netExposurePct: 9.1, spyRelativeExposurePct: -90.9,
      contributionToTotalRiskPct: 60,
    },
    {
      id: 'style-value', label: 'Value', family: 'Style', formula: 'IWD - IWF',
      netExposurePct: -2.2, spyRelativeExposurePct: -2.1,
      contributionToTotalRiskPct: 20,
    },
  ],
  positions: [{
    symbol: 'AAA',
    name: 'Alpha',
    side: 'long',
    signedWeightPct: 12.5,
    observations: 180,
    sampleQuality: {
      observations: 180,
      tier: 120,
      tierLabel: '120+',
      state: 'seasoned',
      preliminary: false,
      complete: true,
      nextTier: null,
      observationsToNextTier: 0,
    },
    rSquared: 0.82,
    contributions: { market: 8.2, 'style-value': -1.1 },
    loadings: {
      market: { value: 0.66 },
      'style-value': { value: -0.09 },
    },
  }],
  correlations: {
    '90': {
      market: {
        market: { value: 1, observations: 90 },
        'style-value': { value: -0.25, observations: 90 },
      },
      'style-value': {
        market: { value: -0.25, observations: 90 },
        'style-value': { value: 1, observations: 90 },
      },
    },
  },
  correlation: {
    status: 'available',
    defaultWindow: 90,
    windows: [30, 90, 180],
    coverage: {
      defaultWindowAvailableCellPct: 100,
      positionsWithHistory: 2,
      positionCount: 2,
    },
    modes: {
      positionPosition: {
        label: 'Position × Position',
        rowAxis: [
          { id: 'AAA', symbol: 'AAA', label: 'Alpha', side: 'long', grossWeightPct: 12.5 },
          { id: 'BBB', symbol: 'BBB', label: 'Beta', side: 'short', grossWeightPct: 6 },
        ],
        columnAxis: [
          { id: 'AAA', symbol: 'AAA', label: 'Alpha', side: 'long', grossWeightPct: 12.5 },
          { id: 'BBB', symbol: 'BBB', label: 'Beta', side: 'short', grossWeightPct: 6 },
        ],
        matrices: {
          '90': {
            window: 90,
            minimumObservations: 72,
            values: [[1, -0.72], [-0.72, 1]],
            rawValues: [[1, 0.72], [0.72, 1]],
            observations: [[90, 90], [90, 90]],
            reasons: [[null, null], [null, null]],
          },
        },
      },
      positionFactor: {
        label: 'Position × Factor',
        rowAxis: [
          { id: 'AAA', symbol: 'AAA', label: 'Alpha', side: 'long', grossWeightPct: 12.5 },
          { id: 'BBB', symbol: 'BBB', label: 'Beta', side: 'short', grossWeightPct: 6 },
        ],
        columnAxis: [
          { id: 'market', label: 'Market', family: 'Market', formula: 'SPY' },
          { id: 'style-value', label: 'Value', family: 'Style', formula: 'IWD - IWF' },
        ],
        matrices: {
          '90': {
            window: 90,
            minimumObservations: 72,
            values: [[0.8, -0.25], [-0.4, 0.15]],
            rawValues: [[0.8, -0.25], [0.4, -0.15]],
            observations: [[90, 90], [90, 90]],
            reasons: [[null, null], [null, null]],
          },
        },
      },
      factorFactor: {
        label: 'Factor × Factor',
        rowAxis: [
          { id: 'market', label: 'Market', family: 'Market', formula: 'SPY' },
          { id: 'style-value', label: 'Value', family: 'Style', formula: 'IWD - IWF' },
        ],
        columnAxis: [
          { id: 'market', label: 'Market', family: 'Market', formula: 'SPY' },
          { id: 'style-value', label: 'Value', family: 'Style', formula: 'IWD - IWF' },
        ],
        matrices: {
          '90': {
            window: 90,
            minimumObservations: 72,
            values: [[1, -0.25], [-0.25, 1]],
            rawValues: [[1, -0.25], [-0.25, 1]],
            observations: [[90, 90], [90, 90]],
            reasons: [[null, null], [null, null]],
          },
        },
      },
    },
    pairs: {
      shrinkage: 0.2,
      commonRisk: [{
        left: { symbol: 'AAA' }, right: { symbol: 'CCC' },
        pnlCorrelation: 0.61, rawCorrelation: 0.61,
        annualizedVarianceContributionPct2: 0.42, observations: 90,
      }],
      offsets: [{
        left: { symbol: 'AAA' }, right: { symbol: 'BBB' },
        pnlCorrelation: -0.72, rawCorrelation: 0.72,
        annualizedVarianceContributionPct2: -0.31, observations: 90,
      }],
    },
  },
  geography: {
    status: 'partial',
    allocation: {
      status: 'partial',
      coverage: { knownGrossCoveragePct: 67.57, unknownGrossNavPct: 6 },
      region: {
        rowAxis: [
          { id: 'North America', label: 'North America' },
          { id: 'Unknown', label: 'Unknown' },
        ],
        columnAxis: [
          { id: 'net', label: 'Net % NAV' },
          { id: 'long', label: 'Long % NAV' },
          { id: 'short', label: 'Short % NAV' },
          { id: 'gross', label: 'Gross % NAV' },
        ],
        values: [[12.5, 12.5, 0, 12.5], [-6, 0, -6, 6]],
      },
      country: {
        rowAxis: [
          { id: 'US', label: 'United States', countryCode: 'US', region: 'North America' },
          { id: 'Unknown', label: 'Unknown' },
        ],
        columnAxis: [
          { id: 'net', label: 'Net % NAV' },
          { id: 'long', label: 'Long % NAV' },
          { id: 'short', label: 'Short % NAV' },
          { id: 'gross', label: 'Gross % NAV' },
        ],
        values: [[12.5, 12.5, 0, 12.5], [-6, 0, -6, 6]],
      },
      positions: [{
        symbol: 'AAA', grossWeightPct: 12.5, available: true,
        basis: 'country_of_risk', allocations: [{ countryCode: 'US', weightPct: 100 }],
        sourceName: 'Issuer filing', sourceAsOf: '2026-06-30', sourceUrl: null,
      }],
    },
    sensitivity: {
      status: 'available',
      rowAxis: [
        { id: 'portfolio', label: 'Portfolio', side: 'portfolio', grossWeightPct: 18.5 },
        { id: 'AAA', symbol: 'AAA', label: 'Alpha', side: 'long', grossWeightPct: 12.5 },
      ],
      columnAxis: [
        { id: 'geo-us', label: 'US', symbol: 'SPY' },
        { id: 'geo-canada', label: 'Canada', symbol: 'EWC' },
      ],
      matrices: {
        '90': {
          window: 90,
          minimumObservations: 72,
          values: [[0.31, -0.12], [0.48, -0.22]],
          rawValues: [[0.31, -0.12], [0.48, -0.22]],
          observations: [[90, 90], [90, 90]],
          reasons: [[null, null], [null, null]],
        },
      },
      coverageByWindow: {
        '90': { modeledGrossCoveragePct: 67.57, portfolioObservations: 90 },
      },
    },
  },
  hedgeScenarios: {
    blockers: ['historical_factor_model_non_executable', 'reviewed_security_master_not_active'],
    rows: [],
  },
};

const universe = {
  status: 'available',
  securityMaster: { status: 'available', reviewedCount: 0 },
  meta: {
    universeCount: 1411,
    snapshotCount: 1452,
    riskRangeRowCount: 3194,
    latestSourceDate: '2026-08-21',
    stateCounts: { catalogued: 119, structured: 393, candidate: 899 },
  },
  rows: [
    {
      ticker: 'SPY', name: 'S&P 500', discoveryState: 'catalogued', confidence: 'high',
      firstSeen: null, lastSeen: null, mentionCount: 1, pullCount: 1,
      products: [{ product: 'dashboard-security-universe' }], existingUniverse: true,
      identityStatus: 'unverified', analysisEligible: false,
    },
    {
      ticker: 'ABNB', name: 'Airbnb', discoveryState: 'structured', confidence: 'high',
      firstSeen: '2026-01-02', lastSeen: '2026-08-21', mentionCount: 4, pullCount: 3,
      products: [{ product: 'risk-ranges-table' }], existingUniverse: false,
      identityStatus: 'unverified', analysisEligible: false,
    },
  ],
};

function snapshotWithPositionMatrix(count) {
  const axis = Array.from({ length: count }, (_, index) => ({
    id: `P${String(index).padStart(3, '0')}`,
    symbol: `P${String(index).padStart(3, '0')}`,
    label: `Position ${index}`,
    side: index % 2 ? 'short' : 'long',
    grossWeightPct: count - index,
  }));
  const values = axis.map((_, rowIndex) => axis.map((__, columnIndex) => (
    rowIndex === columnIndex ? 1 : 0.1
  )));
  const observations = axis.map(() => axis.map(() => 90));
  const reasons = axis.map(() => axis.map(() => null));
  return {
    ...snapshot,
    correlation: {
      ...snapshot.correlation,
      coverage: {
        defaultWindowAvailableCellPct: 100,
        positionsWithHistory: count,
        positionCount: count,
      },
      modes: {
        ...snapshot.correlation.modes,
        positionPosition: {
          label: 'Position × Position',
          rowAxis: axis,
          columnAxis: axis,
          matrices: {
            '90': {
              window: 90,
              minimumObservations: 72,
              values,
              rawValues: values,
              observations,
              reasons,
            },
          },
        },
      },
      pairs: { shrinkage: 0.2, commonRisk: [], offsets: [] },
    },
  };
}

describe('ExposureLab', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    mockGetExposureLabSnapshot.mockReset().mockResolvedValue(snapshot);
    mockGetExposureLabUniverse.mockReset().mockResolvedValue(universe);
    mockSaveExposureLabSecurityReview.mockReset().mockResolvedValue({
      status: 'available',
      auditRecorded: true,
      review: {
        ticker: 'ABNB',
        identityStatus: 'rejected',
        reviewStatus: 'reviewed',
        analysisEligible: false,
        hedgeEligible: false,
        reviewedBy: 'Risk PM',
        reviewReason: 'Test audit rejection.',
        version: 1,
      },
    });
  });

  test('renders dense exposure/correlation/universe tables and keeps hedge actions blocked', async () => {
    const onClose = jest.fn();
    render(
      <ExposureLab
        portfolioData={{
          accountId: 'U1',
          dataSource: 'ibkr_api',
          liveSessionVerified: true,
          fromCache: false,
          summary: { totalValue: 1_000_000 },
          holdings: [{ symbol: 'AAA', marketValue: 125_000, quantity: 100, secType: 'STK' }],
        }}
        connection={{ connected: true }}
        onClose={onClose}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Exposure Lab' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('+12.50%')).toBeInTheDocument();
    expect(screen.getByText('100.0%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Correlation' }));
    const correlationTable = screen.getByRole('table', { name: 'Position × Position 90-session matrix' });
    expect(within(correlationTable).getAllByText('-0.72')).toHaveLength(2);
    expect(correlationTable).toHaveStyle({
      minWidth: '192px',
      minHeight: '66px',
    });
    expect(screen.getByText('Largest common-risk pairs')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Factor × factor' }));
    expect(within(screen.getByRole('table', { name: 'Factor × Factor 90-session matrix' })).getAllByText('-0.25')).toHaveLength(2);

    fireEvent.click(screen.getByRole('tab', { name: 'Geography' }));
    expect(screen.getByRole('table', { name: 'region geography allocation' })).toBeInTheDocument();
    expect(screen.getByText(/Listing exchange, ticker suffix/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sensitivity' }));
    expect(screen.getByRole('table', { name: '90-session de-marketed geography sensitivity matrix' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Universe QA/ }));
    expect(await screen.findByText('ABNB')).toBeInTheDocument();
    expect(screen.getByText('ROWS 2 / 2')).toBeInTheDocument();
    const abnbRow = screen.getByRole('row', { name: /ABNB/ });
    fireEvent.click(within(abnbRow).getByRole('button', { name: 'review' }));
    fireEvent.change(screen.getByLabelText('Identity'), { target: { value: 'rejected' } });
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'Risk PM' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Test audit rejection.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText(/AUDIT RECORDED/)).toBeInTheDocument();
    expect(mockSaveExposureLabSecurityReview).toHaveBeenCalledWith(
      'ABNB',
      expect.objectContaining({
        identityStatus: 'rejected',
        reviewedBy: 'Risk PM',
        expectedVersion: 0,
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Hedge Lab' }));
    expect(screen.getByText('SCENARIO PREVIEW: BLOCKED')).toBeInTheDocument();
    expect(screen.getByText(/No order preview, staging, share conversion/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Factor hedge scenario matrix' })).toHaveStyle({
      minWidth: '920px',
      minHeight: '45px',
    });
    expect(screen.queryByRole('button', { name: /buy|sell|order|submit/i })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockGetExposureLabSnapshot).toHaveBeenCalledWith(expect.objectContaining({ account: 'U1' }));
    });
    expect(mockGetExposureLabUniverse).toHaveBeenCalledTimes(1);
  });

  test('filters Universe QA by case-insensitive ticker prefix only', async () => {
    mockGetExposureLabUniverse.mockResolvedValueOnce({
      ...universe,
      meta: {
        ...universe.meta,
        universeCount: 4,
      },
      rows: [
        {
          ...universe.rows[0],
          ticker: 'AAAU',
          name: 'Physical Gold',
          products: [{ product: 'portfolio-solutions' }],
        },
        {
          ...universe.rows[0],
          ticker: 'SPY',
          name: 'S&P 500',
        },
        {
          ...universe.rows[1],
          ticker: 'PINS',
          name: 'Pinterest',
        },
        {
          ...universe.rows[1],
          ticker: 'PLTR',
          name: 'Palantir',
        },
      ],
    });

    render(
      <ExposureLab
        portfolioData={{
          accountId: 'U1',
          dataSource: 'ibkr_api',
          liveSessionVerified: true,
          fromCache: false,
          summary: { totalValue: 1_000_000 },
          holdings: [{ symbol: 'AAA', marketValue: 125_000, quantity: 100, secType: 'STK' }],
        }}
        connection={{ connected: true }}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: /Universe QA/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search universe by ticker prefix' }), {
      target: { value: 'p' },
    });

    expect(await screen.findByText('PINS')).toBeInTheDocument();
    expect(screen.getByText('PLTR')).toBeInTheDocument();
    expect(screen.queryByText('AAAU')).not.toBeInTheDocument();
    expect(screen.queryByText('SPY')).not.toBeInTheDocument();
    expect(screen.getByText('ROWS 2 / 4')).toBeInTheDocument();
  });

  test('shows Top 20 first and expands/searches the full 75-position matrix', async () => {
    mockGetExposureLabSnapshot.mockResolvedValueOnce(snapshotWithPositionMatrix(75));
    render(
      <ExposureLab
        portfolioData={{
          accountId: 'U1',
          dataSource: 'ibkr_api',
          liveSessionVerified: true,
          fromCache: false,
          summary: { totalValue: 1_000_000 },
          holdings: [{ symbol: 'P000', marketValue: 125_000, quantity: 100, secType: 'STK' }],
        }}
        connection={{ connected: true }}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Correlation' }));
    let table = await screen.findByRole('table', { name: 'Position × Position 90-session matrix' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      table = screen.getByRole('table', { name: 'Position × Position 90-session matrix' });
      expect(within(table).getAllByRole('row')).toHaveLength(76);
    });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search correlation positions' }), {
      target: { value: 'P074' },
    });
    await waitFor(() => {
      table = screen.getByRole('table', { name: 'Position × Position 90-session matrix' });
      expect(within(table).getAllByRole('row')).toHaveLength(2);
      expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    });
  });

  test('edits audited country weights and provenance in the versioned review workflow', async () => {
    mockSaveExposureLabSecurityReview.mockResolvedValueOnce({
      status: 'available',
      auditRecorded: true,
      review: {
        ticker: 'ABNB',
        canonicalSymbol: 'ABNB',
        identityStatus: 'verified',
        instrumentType: 'STK',
        reviewStatus: 'reviewed',
        geography: {
          basis: 'country_of_risk',
          allocations: [{ countryCode: 'US', weightPct: 100 }],
          sourceName: 'Issuer filing',
          sourceAsOf: '2026-06-30',
          sourceUrl: null,
        },
        analysisEligible: false,
        hedgeEligible: false,
        version: 1,
      },
    });
    render(
      <ExposureLab
        portfolioData={{
          accountId: 'U1',
          dataSource: 'ibkr_api',
          liveSessionVerified: true,
          fromCache: false,
          summary: { totalValue: 1_000_000 },
          holdings: [{ symbol: 'AAA', marketValue: 125_000, quantity: 100, secType: 'STK' }],
        }}
        connection={{ connected: true }}
      />,
    );

    fireEvent.click(await screen.findByRole('tab', { name: /Universe QA/ }));
    fireEvent.click(within(await screen.findByRole('row', { name: /ABNB/ })).getByRole('button', { name: 'review' }));
    fireEvent.change(screen.getByLabelText('Identity'), { target: { value: 'verified' } });
    fireEvent.click(screen.getByLabelText('Audited geography'));
    fireEvent.change(screen.getByLabelText('Country 1'), { target: { value: 'US' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Issuer filing' } });
    fireEvent.change(screen.getByLabelText('Source as of'), { target: { value: '2026-06-30' } });
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'Risk PM' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Audited issuer country of risk.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(mockSaveExposureLabSecurityReview).toHaveBeenCalledWith(
      'ABNB',
      expect.objectContaining({
        identityStatus: 'verified',
        instrumentType: 'STK',
        geography: {
          basis: 'country_of_risk',
          allocations: [{ countryCode: 'US', weightPct: 100 }],
          sourceName: 'Issuer filing',
          sourceAsOf: '2026-06-30',
          sourceUrl: '',
        },
        reviewedBy: 'Risk PM',
        expectedVersion: 0,
      }),
    ));
    expect(await screen.findByText(/AUDIT RECORDED/)).toBeInTheDocument();
  });

  test('recovers when the parent portfolio becomes socket verified', async () => {
    mockGetExposureLabSnapshot
      .mockReset()
      .mockRejectedValueOnce({
        response: { data: { reason: 'live_portfolio_unverified' } },
        message: 'Request failed with status code 503',
      })
      .mockResolvedValueOnce(snapshot);

    const portfolioData = {
      accountId: 'U1',
      dataSource: 'ibkr_api',
      liveSessionVerified: false,
      fromCache: false,
      summary: { totalValue: 1_000_000 },
      holdings: [{ symbol: 'AAA', marketValue: 125_000, quantity: 100, secType: 'STK' }],
    };
    const { rerender } = render(
      <ExposureLab
        portfolioData={portfolioData}
        connection={{ connected: true }}
      />,
    );

    expect(await screen.findByText(
      'SNAPSHOT: Waiting for a fresh socket-verified IBKR portfolio; retrying automatically',
    )).toBeInTheDocument();
    expect(screen.queryByText(/live_portfolio_unverified/i)).not.toBeInTheDocument();

    rerender(
      <ExposureLab
        portfolioData={{ ...portfolioData, liveSessionVerified: true }}
        connection={{ connected: true }}
      />,
    );

    expect(await screen.findByText('+12.50%')).toBeInTheDocument();
    await waitFor(() => {
      expect(mockGetExposureLabSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  test('shows a compact preliminary sample tier while retaining modeled factor cells', async () => {
    mockGetExposureLabSnapshot.mockResolvedValueOnce({
      ...snapshot,
      status: 'partial',
      factors: [
        ...snapshot.factors,
        {
          id: 'sector-communication',
          label: 'Communication',
          family: 'Sector',
          formula: 'XLC - SPY',
          netExposurePct: 1.2,
        },
      ],
      coverage: {
        ...snapshot.coverage,
        modeledPositionCount: 1,
        preliminaryPositionCount: 1,
        seasonedPositionCount: 0,
        totalPositionCount: 1,
      },
      positions: [{
        ...snapshot.positions[0],
        symbol: 'SUJA',
        name: 'Short-history security',
        observations: 73,
        sampleQuality: {
          observations: 73,
          tier: 60,
          tierLabel: '60',
          state: 'building',
          preliminary: true,
          complete: false,
          nextTier: 90,
          observationsToNextTier: 17,
        },
      }],
    });

    render(
      <ExposureLab
        portfolioData={{
          accountId: 'U1',
          dataSource: 'ibkr_api',
          liveSessionVerified: true,
          fromCache: false,
          summary: { totalValue: 1_000_000 },
          holdings: [{ symbol: 'SUJA', marketValue: -25_000, quantity: -500, secType: 'STK' }],
        }}
        connection={{ connected: true }}
      />,
    );

    expect(await screen.findByRole('columnheader', { name: 'Sample' })).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: 'Comms' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Security factor exposure matrix' })).toHaveStyle({
      minWidth: '394px',
    });
    const indicator = await screen.findByRole('cell', {
      name: 'SUJA: 73 aligned daily returns; 60-return tier, preliminary; 17 more to the 90-return tier',
    });
    expect(indicator).toHaveTextContent('60');
    expect(screen.getByTitle('SUJA · Market · contribution')).toHaveTextContent('+8.20%');
    expect(screen.getByText('1/1 modeled · 1 prelim')).toBeInTheDocument();
  });
});
