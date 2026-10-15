import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import MacroSignalsCard from './MacroSignalsCard';
import LegacyInflationNowcastPanel from './InflationNowcastPanel 2';

function makeSignal({
  ticker,
  name,
  assetClass,
  side = 'long',
  group = 'Index',
}) {
  return {
    id: ticker.toLowerCase(),
    ticker,
    name,
    assetClass,
    side,
    trade: side === 'short' ? 'Sell' : 'Buy',
    trend: side === 'short' ? 'bear' : 'bull',
    tail: null,
    forecastLow: 90,
    forecastHigh: 110,
    spotPrice: 100,
    referencePrice: 100,
    upsidePct: 10,
    downsidePct: -10,
    score: 75,
    canonical: {
      symbol: ticker,
      label: name,
      group,
      trend: side === 'short' ? 'SHORT' : 'LONG',
      trackerTrend: side === 'short' ? 'BEARISH' : 'BULLISH',
      riskTrend: side === 'short' ? 'BEARISH' : 'BULLISH',
      lrr: 90,
      hrr: 110,
      price: 100,
      score: 75,
    },
  };
}

const MIXED_SIGNALS = [
  makeSignal({
    ticker: 'UST10Y',
    name: '10Y Yield',
    assetClass: 'FI',
    group: 'Rates',
  }),
  makeSignal({
    ticker: 'DXY',
    name: 'Dollar Index',
    assetClass: 'FX',
    group: 'FX',
  }),
  makeSignal({
    ticker: 'COPPER',
    name: 'Copper',
    assetClass: 'CMD',
    group: 'Commodities',
  }),
  makeSignal({
    ticker: 'DRAM',
    name: 'DRAM',
    assetClass: 'EQ',
  }),
  makeSignal({
    ticker: 'COMPQ',
    name: 'Nasdaq',
    assetClass: 'EQ',
  }),
  makeSignal({
    ticker: 'SPX',
    name: 'S&P 500',
    assetClass: 'EQ',
  }),
  makeSignal({
    ticker: 'AAPL',
    name: 'Apple Inc.',
    assetClass: 'EQ',
  }),
  makeSignal({
    ticker: 'HYG',
    name: 'High Yield Corporate Bonds',
    assetClass: 'FI',
    group: 'Credit',
  }),
  makeSignal({
    ticker: 'BTC',
    name: 'Bitcoin',
    assetClass: 'CRPT',
    group: 'Crypto',
  }),
];

function expectTickerVisible(ticker) {
  expect(screen.getAllByText(ticker).length).toBeGreaterThan(0);
}

function expectTickerAbsent(ticker) {
  expect(screen.queryAllByText(ticker)).toHaveLength(0);
}

const NOWCAST = {
  date: '2026-06-15',
  publishedAt: '2026-06-15T12:48:00+00:00',
  data: {
    publishedText: '06/15/2026 08:48 AM EDT',
    forecastMonth: 'June 2026',
    releaseDate: { date: '2026-07-14', raw: 'July 14th' },
    metric: 'Headline CPI M/M',
    outlook: 'Probable Disinflation',
    summary: 'Our base-case nowcast for June is +0.30% m/m.',
    scenarios: [
      { key: 'upside', label: 'Upside', value: 0.4 },
      { key: 'base', label: 'Base Case', value: 0.3 },
      { key: 'downside', label: 'Downside', value: 0.2 },
    ],
  },
};

describe('MacroSignalsCard inflation nowcast', () => {
  test('the legacy duplicate nowcast component also requires supplied observations', () => {
    const { rerender } = render(<LegacyInflationNowcastPanel />);
    expect(screen.getByText('Verified inflation nowcast unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('0.30%')).not.toBeInTheDocument();
    rerender(<LegacyInflationNowcastPanel inflationNowcast={NOWCAST} />);
    expect(screen.getByText('0.30%')).toBeInTheDocument();
    expect(screen.getByText('Published 06/15/2026 08:48 AM EDT')).toBeInTheDocument();
  });
  test('shows the supplied inflation nowcast snapshot on the MACRO tab', () => {
    render(<MacroSignalsCard signals={[]} inflationNowcast={NOWCAST} />);

    expect(screen.getByText('Inflation Nowcast')).toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
    expect(screen.getByText('Probable Disinflation')).toBeInTheDocument();
    expect(screen.getByText('Release Jul 14, 2026')).toBeInTheDocument();
    expect(screen.getByText('Published 06/15/2026 08:48 AM EDT')).toBeInTheDocument();
    expect(screen.getByText('0.40%')).toBeInTheDocument();
    expect(screen.getByText('0.30%')).toBeInTheDocument();
    expect(screen.getByText('0.20%')).toBeInTheDocument();
    expect(screen.queryByText(NOWCAST.data.summary)).not.toBeInTheDocument();
  });

  test('hides inflation nowcast outside the MACRO tab', () => {
    render(<MacroSignalsCard signals={[]} inflationNowcast={NOWCAST} />);

    fireEvent.click(screen.getByRole('tab', { name: 'EQ' }));

    expect(screen.queryByText('Inflation Nowcast')).not.toBeInTheDocument();
  });

  test('missing snapshots leave both the nowcast and signals explicitly unavailable', () => {
    render(<MacroSignalsCard signals={[]} inflationNowcast={null} />);

    expect(screen.getByText('Inflation Nowcast')).toBeInTheDocument();
    expect(screen.getByText('Verified inflation nowcast unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Verified signals unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('0.30%')).not.toBeInTheDocument();
    expect(screen.queryByText('SHORTS')).not.toBeInTheDocument();
    expect(screen.queryByText('VIX')).not.toBeInTheDocument();
    expect(screen.queryByText(/Published/)).not.toBeInTheDocument();
  });

  test('does not fall back to manual values when a snapshot cannot be parsed', () => {
    render(<MacroSignalsCard signals={[]} inflationNowcast={{ data: { metric: 'Core PCE' } }} />);

    expect(screen.getByText('Inflation Nowcast')).toBeInTheDocument();
    expect(screen.getByText(/Latest Hedgeye nowcast is not a native Headline CPI nowcast/)).toHaveAttribute('role', 'status');
    expect(screen.queryByText('0.30%')).not.toBeInTheDocument();
  });
});

describe('MacroSignalsCard asset tab filtering', () => {
  test.each([undefined, null, []])('missing signals %j do not create selectable demo rows on any tab', (signals) => {
    render(<MacroSignalsCard signals={signals} inflationNowcast={NOWCAST} />);
    expect(screen.getByText('Verified signals unavailable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'EQ' }));
    expect(screen.getByText('Verified signals unavailable.')).toBeInTheDocument();
    expectTickerAbsent('COMPQ');
    expectTickerAbsent('SPX');
    expectTickerAbsent('VIX');
  });

  test('supplied signals retain their canonical publication date and clear on provider failure', () => {
    const onSelectSignal = jest.fn();
    const signal = { ...MIXED_SIGNALS[1], canonical: { ...MIXED_SIGNALS[1].canonical,
      date: '2026-08-31', publishedAt: '2026-08-31T12:00:00Z' } };
    const { rerender } = render(<MacroSignalsCard signals={[signal]} onSelectSignal={onSelectSignal} inflationNowcast={NOWCAST} />);
    fireEvent.click(screen.getByRole('button', { name: /DXY Dollar Index/ }));
    expect(onSelectSignal).toHaveBeenCalledWith(signal);
    expect(onSelectSignal.mock.calls[0][0].canonical.publishedAt).toBe('2026-08-31T12:00:00Z');
    rerender(<MacroSignalsCard signals={[signal]} error="Provider offline" inflationNowcast={NOWCAST} />);
    expectTickerAbsent('DXY');
    expect(screen.getByText('Verified signals unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Provider offline/)).toBeInTheDocument();
    expect(screen.getByText('Published 06/15/2026 08:48 AM EDT')).toBeInTheDocument();
  });

  test('MACRO tab includes only broad macro indicators', () => {
    render(<MacroSignalsCard signals={MIXED_SIGNALS} inflationNowcast={NOWCAST} />);

    expect(screen.getByText('Inflation Nowcast')).toBeInTheDocument();
    expectTickerVisible('UST10Y');
    expectTickerVisible('DXY');
    expectTickerVisible('COPPER');
    expectTickerAbsent('DRAM');
    expectTickerAbsent('COMPQ');
    expectTickerAbsent('SPX');
    expectTickerAbsent('AAPL');
    expectTickerAbsent('HYG');
    expectTickerAbsent('BTC');
  });

  test('non-macro asset tabs still filter by asset class', () => {
    render(<MacroSignalsCard signals={MIXED_SIGNALS} inflationNowcast={NOWCAST} />);

    fireEvent.click(screen.getByRole('tab', { name: 'EQ' }));
    expect(screen.getByRole('tab', { name: 'EQ' })).toHaveAttribute('aria-selected', 'true');
    expectTickerVisible('DRAM');
    expectTickerVisible('COMPQ');
    expectTickerVisible('SPX');
    expectTickerVisible('AAPL');
    expectTickerAbsent('UST10Y');

    fireEvent.click(screen.getByRole('tab', { name: 'FI' }));
    expectTickerVisible('UST10Y');
    expectTickerVisible('HYG');
    expectTickerAbsent('DXY');

    fireEvent.click(screen.getByRole('tab', { name: 'FX' }));
    expectTickerVisible('DXY');
    expectTickerAbsent('COPPER');

    fireEvent.click(screen.getByRole('tab', { name: 'CMD' }));
    expectTickerVisible('COPPER');
    expectTickerAbsent('BTC');

    fireEvent.click(screen.getByRole('tab', { name: 'CRPT' }));
    expectTickerVisible('BTC');
    expectTickerAbsent('DRAM');
  });
});
