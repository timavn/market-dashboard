import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PredictionMarketSp500Research from './PredictionMarketSp500Research';
import { MarketDataService } from '../../services/api/marketDataService';

jest.mock('../../services/api/marketDataService', () => ({
  MarketDataService: { getPredictionMarketSp500Research: jest.fn() },
}));

const stat = (value, reason = null) => ({ value, reason, observations: value == null ? 0 : 4, successes: value == null ? 0 : 2, interval95: value == null ? null : { low: 0.15, high: 0.85, method: 'Wilson' } });

const ready = {
  schemaVersion: 1,
  researchVersion: 'spx-fes-poker-ledger-v1',
  collector: {
    status: 'capturing', resolverSymbol: 'ESU26', resolverMonthLabel: 'Sep-26', measurementDate: '2026-08-20',
    lastTradeAt: '2026-08-20T20:00:00Z', resolutionAt: '2026-08-21T15:00:00Z', payoutAt: '2026-08-21T17:00:00Z',
    startedAt: '2026-08-20T13:30:00Z',
  },
  exploratory: { status: 'exploratory', label: 'Exploratory — 1/30 resolved FES event-days.', warning: 'Confluence is ordinal context only.' },
  actionFrequency: {
    qualifiedDayActionRate: stat(0.5), qualifiedStrikeActionRate: stat(0.25), yesRate: stat(1), noRate: stat(0),
    addOnRate: stat(0), reEntryRate: stat(null, 'No verified re-entry.'), multiStrikeLadderRate: stat(0),
    offSetupFillRate: stat(0), earlyExitRate: stat(0), holdToResolutionRate: stat(1),
  },
  performance: {
    resolvedContracts: 1, uniqueEventDays: 1, netPnl: stat(0.54), aggregateRoi: stat(1.1), pnlPer100Risk: stat(110),
    profitFactor: stat(null, 'No realized losing contract.'), averageWin: stat(0.54), averageLoss: stat(null), fees: stat(0.02),
    expectancyPerContract: stat(0.54), maximumRealizedDrawdown: stat(0),
  },
  calibration: {
    label: 'Market-price calibration and selection; not a personal probability forecast.', hitRate: stat(1), profitableDayRate: stat(1),
    averageFillImpliedProbability: stat(0.44), allInBreakevenProbability: stat(0.46), empiricalMinusPaidProbability: stat(0.56),
    brierScore: stat(0.194), logLoss: stat(0.82),
  },
  executionAndPath: {
    sampleExecutions: 1, preFillSpread: stat(0.02), preFillBidDepth: stat(20), preFillAskDepth: stat(25), fillVersusPriorAsk: stat(0),
    depthParticipation: stat(0.04), plus5BidChange: stat(0.03), plus15BidChange: stat(-0.01), plus30BidChange: stat(0.05),
    bestBidExcursion: stat(0.08), worstBidExcursion: stat(-0.04), lastPreCloseBidChange: stat(0.02),
  },
  outcomeGeometry: {
    label: 'ForecastEx payout is outcome authority; official-final CME settlement supplies resolver distance and margin.',
    sampleContracts: 1,
    officialEsSettlementCoverage: stat(1), cashSpxCloseCoverage: stat(1), publishedCashRangeContainedCloseRate: stat(1),
    averageDistanceToStrike: stat(25), averageSideAdjustedSettlementMargin: stat(25),
  },
  passAnalysis: { label: 'Hypothetical pre-fee only.', passedOpportunities: 2, resolvedPassedOpportunities: 1, averageCounterfactualPerContract: stat(-0.2), totalCounterfactualPerContract: stat(-0.2) },
  coverage: { entryContextCoverage: stat(1) },
  cohorts: {
    dimensions: [{ key: 'cashRangeZone', label: 'Cash-SPX range zone' }, { key: 'vixRegime', label: 'VIX regime' }],
    tables: {
      cashRangeZone: { label: 'Cash-SPX range zone', rows: [{ cohort: 'top third', qualifiedOpportunityCount: 2, contractCount: 1, uniqueDays: 1, actionRate: stat(0.5), hitRate: stat(1), pnl: stat(0.54), roi: stat(1.1), calibrationGap: stat(0.56), quotePathChange: stat(-0.01), contextCoverage: stat(1) }] },
      vixRegime: { label: 'VIX regime', rows: [{ cohort: 'under 20', qualifiedOpportunityCount: 2, contractCount: 1, uniqueDays: 1, actionRate: stat(0.5), hitRate: stat(1), pnl: stat(0.54), roi: stat(1.1), calibrationGap: stat(0.56), quotePathChange: stat(-0.01), contextCoverage: stat(1) }] },
    },
  },
  hands: [{ eventDate: '2026-08-20', generationKey: 'FES_082026', resolverSymbol: 'ESU26', entryContext: { directionalAlignment: 'aligned bullish', cashRangeZone: 'top third', strikeZone: 'middle third', basis: 20, gammaSign: 'positive', vixRegime: 'under 20' }, qualifiedStrikeCount: 2, actionCount: 1, passCount: 1, action: [{ direction: 'BUY', side: 'YES', strike: 6400, fillPrice: 0.46, qualified: true, actionType: 'qualified_entry' }], passes: [{ side: 'YES', strike: 6450, ask: 0.22 }], outcome: [{ result: 'YES', officialEsSettlement: 6425, side: 'YES', strike: 6400, sideAdjustedSettlementMargin: 25, cashSpxClose: 6410, cashSpxClosingRangeZone: 'top third', publishedCashRangeContainedClose: true }], pnl: 0.54, legacyUnmatched: true }],
  provenance: { spx: { status: 'verified_live', source: 'ibkr_live', asOf: '2026-08-20T19:59:50Z' }, es: { status: 'verified_live_direct_last', source: 'ibkr_live_native_quote', symbol: 'ESU26' } },
};

describe('PredictionMarketSp500Research', () => {
  afterEach(() => jest.clearAllMocks());

  test('renders collector identity, exploratory HUD, cohorts, hands, and provenance read-only', async () => {
    MarketDataService.getPredictionMarketSp500Research.mockResolvedValue(ready);
    const { container } = render(<PredictionMarketSp500Research accountId="U123" />);

    expect(await screen.findByRole('heading', { name: /ESU26.*SP500 hand ledger/i })).toBeTruthy();
    expect(screen.getByText('Exploratory — 1/30 resolved FES event-days.')).toBeTruthy();
    expect(screen.getByText('Qualified-day action')).toBeTruthy();
    expect(screen.getByText('Market-price calibration and selection; not a personal probability forecast.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Outcome geometry' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Cash-SPX range zone' })).toBeTruthy();
    expect(screen.getByText('aligned bullish')).toBeTruthy();
    expect(screen.getByText('Legacy / unmatched', { exact: true }).parentElement).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[data-available="false"]').getAttribute('title')).toMatch(/No realized losing contract|No verified re-entry/);

    fireEvent.change(screen.getByLabelText('Cohort'), { target: { value: 'vixRegime' } });
    expect(screen.getByRole('columnheader', { name: 'VIX regime' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '30D' }));
    await waitFor(() => expect(MarketDataService.getPredictionMarketSp500Research).toHaveBeenLastCalledWith({ account: 'U123', window: '30d' }));
    fireEvent.click(screen.getByText('Data provenance and availability'));
    expect(screen.getByText('ibkr_live_native_quote')).toBeTruthy();
  });

  test('renders an explicit unavailable state without stale data', async () => {
    MarketDataService.getPredictionMarketSp500Research.mockRejectedValue({ response: { data: { error: { message: 'Collector offline.' } } } });
    render(<PredictionMarketSp500Research accountId="U123" />);
    expect(await screen.findByText('Collector offline.')).toBeTruthy();
    expect(screen.queryByText(/ESU26/)).toBeNull();
  });
});
