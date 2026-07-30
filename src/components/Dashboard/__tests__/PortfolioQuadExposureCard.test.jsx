import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioQuadExposureCard from '../PortfolioQuadExposureCard';

const {
  aggregatePortfolioQuadExposures,
} = require('../../../utils/portfolioQuadExposure');

jest.mock('../../../utils/portfolioQuadExposure', () => ({
  aggregatePortfolioQuadExposures: jest.fn(),
}));

const goldLabel = {
  exposureId: 'asset-gold',
  label: 'Gold',
  dimension: 'asset_class',
  isPrimary: true,
  currentFit: { status: 'favored', rank: 1 },
  previousFit: { status: 'not-listed', rank: null },
  transition: 'improved',
  alignment: 'aligned',
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders live overlap concentration and prior-to-current deterioration', () => {
  aggregatePortfolioQuadExposures.mockReturnValue({
    availability: {
      available: true,
      availability: 'live',
      code: 'live',
      message: 'Verified live portfolio exposure is available.',
    },
    positions: [
      {
        positionKey: 'U1#100',
        symbol: 'GLD',
        conid: 100,
        description: 'SPDR Gold Shares',
        side: 'long',
        classificationStatus: 'reviewed',
        labels: [goldLabel],
        weightPct: 10,
        grossWeightPct: 10,
        weightAvailability: true,
        alignment: 'aligned',
      },
    ],
    exposures: [
      {
        exposureId: 'fixed-income-credit',
        label: 'Credit',
        dimension: 'fixed_income_sector',
        longPct: 18,
        shortPct: 2,
        grossPct: 20,
        netPct: 16,
        positionCount: 2,
        contributors: [
          { symbol: 'LQD', grossWeightPct: 12 },
          { symbol: 'HYG', grossWeightPct: 8 },
        ],
        previousFit: { status: 'favored', rank: 1 },
        currentFit: { status: 'unfavorable', rank: 1 },
        transition: 'deteriorated',
        alignment: 'conflict',
      },
      {
        exposureId: 'asset-gold',
        label: 'Gold',
        dimension: 'asset_class',
        longPct: 10,
        shortPct: 0,
        grossPct: 10,
        netPct: 10,
        positionCount: 1,
        contributors: [{ symbol: 'GLD', grossWeightPct: 10 }],
        previousFit: { status: 'not-listed', rank: null },
        currentFit: { status: 'favored', rank: 1 },
        transition: 'improved',
        alignment: 'aligned',
      },
    ],
    coverage: {
      totalPositionCount: 1,
      classifiedPositionCount: 1,
      classifiedGrossWeightPct: 100,
    },
  });

  render(
    <PortfolioQuadExposureCard
      portfolioData={{ accountId: 'U1' }}
      currentQuad="q3"
      previousQuad="q2"
      currentPeriodLabel="Jul-26"
      previousPeriodLabel="Jun-26"
      selectedAccount="U1"
    />
  );

  expect(screen.getByText('Q2 → Q3')).toBeInTheDocument();
  expect(screen.getByText('1/1')).toBeInTheDocument();
  expect(screen.getByText('100.0%')).toBeInTheDocument();

  const table = screen.getByRole('table', { name: 'Quad exposure summary' });
  const creditRow = within(table).getByRole('row', { name: /Credit/ });
  expect(within(creditRow).getByText('20.0%')).toBeInTheDocument();
  expect(within(creditRow).getByText('Worst #1')).toBeInTheDocument();
  expect(within(creditRow).getByText(/Best #1 → Worst #1 · Deteriorated/)).toBeInTheDocument();
  expect(within(creditRow).getByText('Conflict')).toBeInTheDocument();
  expect(within(creditRow).getByText(/LQD 12.0% · HYG 8.0%/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Security Map' }));
  const securityTable = screen.getByRole('table', { name: 'Security exposure map' });
  expect(within(securityTable).getByText('GLD')).toBeInTheDocument();
  expect(within(securityTable).getAllByText('Gold').length).toBeGreaterThan(0);
  expect(within(securityTable).getByText('Reviewed')).toBeInTheDocument();
});

test('fails closed for stale marks while retaining static reviewed labels', () => {
  aggregatePortfolioQuadExposures.mockReturnValue({
    availability: {
      available: false,
      availability: 'unavailable',
      code: 'stale_marks',
      message: 'Portfolio marks are completed-session references.',
    },
    positions: [
      {
        positionKey: 'U1#100',
        symbol: 'GLD',
        conid: 100,
        description: 'SPDR Gold Shares',
        side: 'long',
        classificationStatus: 'reviewed',
        labels: [goldLabel],
        marketValue: null,
        weightPct: null,
        grossWeightPct: null,
        weightAvailability: false,
        weightUnavailableReason: 'Verified live marks are required.',
        alignment: 'aligned',
      },
    ],
    exposures: [],
    coverage: {
      totalPositionCount: 1,
      classifiedPositionCount: 1,
      classifiedGrossWeightPct: null,
    },
  });

  render(
    <PortfolioQuadExposureCard
      portfolioData={{ accountId: 'U1' }}
      currentQuad="q3"
      previousQuad="q2"
    />
  );

  expect(screen.getByText('No verified live portfolio exposure')).toBeInTheDocument();
  expect(screen.getByText('Portfolio marks are completed-session references.')).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'Quad exposure summary' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Exposure Summary' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Security Map' })).not.toBeDisabled();

  const table = screen.getByRole('table', { name: 'Security exposure map' });
  const goldRow = within(table).getByRole('row', { name: /GLD/ });
  expect(within(goldRow).getByText('Unavailable')).toBeInTheDocument();
  expect(within(goldRow).getAllByText('Gold').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Gross coverage Unavailable')).toBeInTheDocument();
});
