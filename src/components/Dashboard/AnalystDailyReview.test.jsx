import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystDailyReview, { parseDailyReview } from './AnalystDailyReview';

const sheet = (changes = {}) => ({
  version: 1, asOf: '2026-11-20T21:10:00Z', marketDate: '2026-11-20', session: 'post-market',
  headline: { nlv: 100000, dayPnl: 1000, dayPnlPct: 1.01, basis: 'ibkr-account', pctBasis: 'prior-close-nlv',
    benchmark: { symbol: 'SPY', changePct: 1.54, observedAt: '2026-11-20T21:00:00Z' }, vsBenchmarkPct: -0.53,
    nlvChange: 1000, previousNlv: 99000, previousNlvAsOf: '2026-11-19T21:05:00Z' },
  pnl: { account: { daily: 1000, realized: 250, unrealized: 2000 }, attributed: 950, attributionBasis: 'fills',
    positionPnl: 800, tradingPnl: 150, longPnl: 750, shortPnl: 200, coveragePct: 100, attributedCount: 3, unpriced: [],
    unattributed: 50, byAssetClass: [{ label: 'Stocks & ETFs', pnl: 950, bps: 95 }],
    contributors: [{ symbol: 'AAA', contract: 'AAA', name: 'AAA Inc', side: 'long', pnl: 650, bps: 65, changePct: 10, weightPct: 8.25, held: true }],
    detractors: [{ symbol: 'DDD', contract: 'DDD', name: null, side: 'short', pnl: -120, bps: -12, changePct: 2.1, weightPct: -3, held: true }],
    alphaBeta: { status: 'available', coveragePct: 100, minCoveragePct: 90, benchmark: 'SPY', benchmarkChangePct: 1.54,
      betaExposure: 8460, betaExposurePct: 8.46, marketPnl: 130, selectionPnl: 720, coveredPnl: 850 } },
  trading: { status: 'ready', fillCount: 2, symbolCount: 2, grossNotional: 5700, netNotional: -500, commission: 2,
    rows: [{ symbol: 'AAA', contract: 'AAA', secType: 'STK', action: 'Add', fills: 1, netNotional: 2600, netPctNlv: 2.6, grossNotional: 2600,
      avgBuy: 52, avgSell: null, mark: 55, tradingPnl: 150, realized: 0, commission: 1, firstAt: '2026-11-20T15:00:00Z',
      lastAt: '2026-11-20T15:00:00Z', weightPct: 8.25 }] },
  exposure: { rows: [{ key: 'grossExposure', label: 'Gross', value: 10050, pct: 10.05, previousPct: 9.5, deltaBps: 55 },
    { key: 'netExposure', label: 'Net', value: 6450, pct: 6.45, previousPct: null, deltaBps: null }], nlv: 100000, previousNlv: 99000,
    comparison: { status: 'available', baselineAsOf: '2026-11-19T21:05:00Z', baselineSessionDate: '2026-11-19', rebuilt: false },
    positionCount: 2, longCount: 1, shortCount: 1, assetClasses: [{ label: 'Stocks & ETFs', longPct: 8.25, shortPct: -1.8, netPct: 6.45 }],
    concentrations: [{ symbol: 'AAA', side: 'long', value: 8250, pct: 8.25 }] },
  liquidity: { cash: 93550, buyingPower: 400000, availableFunds: 100000, excessLiquidity: 110000, excessLiquidityPct: 56.2,
    maintenanceMargin: 85000, initialMargin: 89000, health: 'healthy', openOrders: 3 },
  market: { rows: [{ symbol: 'SPX', label: 'S&P 500', kind: 'index', price: 6600, previousClose: 6500, change: 100, changePct: 1.54,
      observedAt: '2026-11-20T21:00:00Z', source: 'yahoo' },
    { symbol: 'UST10Y', label: 'UST 10Y', kind: 'yield', price: 4.92, previousClose: null, change: 0.03, changePct: null,
      observedAt: '2026-11-20T21:05:00Z', source: 'cnbc' }],
    sectors: [{ symbol: 'XLK', changePct: 2.1 }, { symbol: 'XLE', changePct: -0.4 }], vix: null,
    benchmark: { symbol: 'SPY', changePct: 1.54 } },
  prediction: { status: 'ready', asOf: '2026-11-20T21:10:00Z', account: 10000, cash: 9400, atRisk: 600, atRiskPct: 6, maxPayout: 1500,
    value: 650, pnl: 50, realized: 20, openLines: 1, events: 1, unvalued: 0, flags: [{ tone: 'yellow', text: 'Stacked: Gold and Silver both short.' }],
    positions: [{ market: 'Gold', section: 'Metals', side: 'NO', direction: 'SHORT', lines: 2, cost: 600, pct: 6, value: 650, pnl: 50,
      maxPayout: 1500, closeTime: '2026-11-27T22:00:00Z', state: 'HOLD', tone: 'none' }],
    today: { since: '2026-11-20T05:00:00Z', asOf: '2026-11-20T21:10:00Z',
      fills: { count: 1, bought: 133, sold: 0, fees: 2, rows: [{ market: 'Gold', side: 'NO', action: 'buy', contracts: 350, dollars: 133, fills: 1,
        lastAt: '2026-11-20T15:23:35Z', avgPrice: 0.38 }] },
      settlements: { count: 0, cost: 0, revenue: 0, fees: 0, pnl: 0, rows: [] } } },
  notes: [],
  ...changes,
});
const report = value => `## Daily Review\n\n- Day P&L: $1,000\n\n\`\`\`analyst-daily-review\n${JSON.stringify(value)}\n\`\`\`\n`;

describe('AnalystDailyReview', () => {
  it('reads the sheet from the report block and rejects anything else', () => {
    expect(parseDailyReview(report(sheet())).headline.dayPnl).toBe(1000);
    expect(parseDailyReview('Review interrupted: the providers could not complete this review.')).toBeNull();
    expect(parseDailyReview('```analyst-daily-review\n{broken\n```')).toBeNull();
    expect(parseDailyReview(report({ ...sheet(), version: 2 }))).toBeNull();
  });

  it('lays out the day: headline, P&L, trading, exposure, market and Kalshi', () => {
    render(<AnalystDailyReview sheet={sheet()} messageId="m1" />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Daily Review · Fri, Nov 20');
    expect(screen.getByText('After the close · as of Nov 20 13:10 PT')).toBeInTheDocument();
    const headline = within(screen.getByLabelText('Headline'));
    expect(headline.getByText('Day P&L').nextSibling).toHaveTextContent('+$1,000');
    expect(headline.getByText('Day P&L').nextSibling).toHaveClass('is-positive');
    expect(headline.getByText('+1.01%')).toBeInTheDocument();
    expect(headline.getByText('−0.53%')).toHaveClass('is-negative');
    const pnl = within(screen.getByLabelText('P&L'));
    expect(pnl.getByText('Trading P&L').nextSibling).toHaveTextContent('+$150');
    expect(pnl.getByText('From selection').nextSibling).toHaveTextContent('+$720');
    const trades = within(screen.getByLabelText("Today's trades"));
    expect(trades.getByText('Add')).toBeInTheDocument();
    expect(trades.getByText('+2.60%')).toBeInTheDocument();
    expect(trades.getByText('Nov 20 07:00 PT')).toBeInTheDocument();
    const exposure = within(screen.getByRole('table', { name: 'Exposure' }));
    expect(exposure.getByText('+55 bp')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Market')).getByText('+3 bp')).toBeInTheDocument();
    const kalshi = within(screen.getByLabelText('Prediction markets'));
    expect(kalshi.getByText('$600 · 6.0%')).toBeInTheDocument();
    expect(kalshi.getByText('Metals · Gold')).toBeInTheDocument();
    expect(kalshi.getByText('Stacked: Gold and Silver both short.')).toHaveClass('is-caution');
    expect(within(kalshi.getByLabelText('Kalshi fills today')).getByText('38.0')).toBeInTheDocument();
    expect(screen.queryByLabelText('Data gaps')).not.toBeInTheDocument();
  });

  it('shows a gap as N/A with its note, never as zero', () => {
    const base = sheet();
    render(<AnalystDailyReview sheet={sheet({
      headline: { ...base.headline, dayPnl: null, dayPnlPct: null, basis: null, benchmark: null, vsBenchmarkPct: null, nlvChange: null },
      pnl: { ...base.pnl, account: null, attributed: null, positionPnl: null, tradingPnl: null, longPnl: null, shortPnl: null,
        unattributed: null, contributors: [], detractors: [], byAssetClass: [], unpriced: ['AAA', 'BBB'], alphaBeta: { status: 'unavailable' } },
      trading: { status: 'unavailable', fillCount: 0, symbolCount: 0, grossNotional: null, netNotional: null, commission: null, rows: [] },
      prediction: { status: 'unavailable' },
      notes: ["IBKR's official prior closes were unavailable: P&L by position is not shown."],
    })} />);
    const headline = within(screen.getByLabelText('Headline'));
    expect(headline.getByText('Day P&L').nextSibling).toHaveTextContent('N/A');
    expect(headline.queryByText('+$0')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Data gaps')).toHaveTextContent('official prior closes were unavailable');
    expect(screen.getByText('Today’s fills unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Kalshi account unavailable.')).toBeInTheDocument();
    expect(screen.getByText('2 not attributed')).toBeInTheDocument();
  });
});
