import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPortfolioBrief, { PortfolioResearchUpdates, PortfolioReviewPlaceholder } from './AnalystPortfolioBrief';
import usePortfolioSecurityNames from '../../hooks/usePortfolioSecurityNames';

const wholeText = expected => (_, element) => element.textContent === expected
  && !Array.from(element.children).some(child => child.textContent === expected);

jest.mock('../../hooks/usePortfolioSecurityNames', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

const asOf = '2026-09-04T20:05:00Z';
const metric = (value, observations) => ({ value, observations, status: 'verified_history', source: 'adjusted history', asOf: '2026-09-04' });
// ATR 2.5 on a 100 reference price: 5% stop distance → MIN 2.5%, MAX 5%, long stop 95.
const sizing = (atr = 2.5, price = 100) => ({ atr14: metric(atr, 14), referencePrice: metric(price, 1) });
const row = (holding, extra = {}) => ({ holding, heldSide: 'LONG', weightPct: 4, trade: 'BULLISH', trend: 'NEUTRAL', priorSignals: { trend: 'BULLISH' }, sizingInputs: sizing(), sources: { trend: { publishedAt: '2026-09-04T14:30:00Z', citation: { id: 'rta', title: 'Real-Time Alert' } } }, ...extra });
const sizedRow = (holding, extra = {}) => row(holding, {
  weightPct: 3, trade: 'BULLISH', trend: 'BULLISH', priorSignals: {},
  valuationPrice: 100, netLiquidation: 100000, lrr: 90, hrr: 110,
  sources: {
    trade: { publishedAt: '2026-09-04T14:30:00Z', citation: { id: 'trade', title: 'Trade report' } },
    trend: { publishedAt: '2026-09-04T14:30:00Z', citation: { id: 'trend', title: 'Trend report' } },
  },
  ...extra,
});
const brief = () => ({ available: true, asOf, coverageComplete: false, metrics: { longMarketValue: 159845.17, shortMarketValue: -50583.65, grossExposure: 210428.82, grossLeverage: 1.2334, netExposure: 109261.52, netExposurePctOfNlv: 64.04 }, holdings: [row('IGV'), row('HYG', { trade: 'BEARISH' }), row('TWO'), row('THREE'), row('FBY', { trade: null, trend: null })], nextSession: [], citations: [] });
const message = () => ({ text: 'Legacy report: {"action":"REMOVE"} VIEW LARGER IMAGE cite_xyz', portfolioBrief: brief() });

test('the centered review puts Gross first and Net last without redundant labels', () => {
  const data = message(); data.portfolioBrief.metrics.valuationComplete = false;
  render(<AnalystPortfolioBrief message={data} onCitation={jest.fn()} />);
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  expect(report).toHaveClass('portfolio-brief-centered');
  expect(report).not.toHaveTextContent('Good morning');
  expect(within(report).queryByRole('heading', { name: 'Portfolio Review' })).not.toBeInTheDocument();
  expect(report.querySelector('header')).toBeNull();
  expect(report).not.toHaveTextContent('Exposure includes verified marks only; some position values are unavailable.');
  const exposure = screen.getByRole('region', { name: 'Exposure and risk' });
  expect(within(exposure).getAllByRole('rowheader').map(item => item.textContent)).toEqual(['Gross', 'Long', 'Short', 'Net']);
  expect(exposure.querySelector('.is-long .portfolio-exposure-value')).toHaveTextContent('$159,845');
  expect(exposure.querySelector('.is-short .portfolio-exposure-value')).toHaveTextContent('-$50,584');
  expect(exposure).toHaveTextContent('123%');
  expect(exposure).not.toHaveTextContent(/\.\d/);
  expect(exposure).not.toHaveTextContent('of NLV');
  expect(screen.queryByRole('region', { name: 'Coverage' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Legacy report:|VIEW LARGER IMAGE|cite_xyz/)).not.toBeInTheDocument();
});

test('exposure table separates whole-dollar values from Current, Δ and Previous weights side by side', () => {
  const data = message();
  data.portfolioBrief.metrics = { longMarketValue: 150000.4, shortMarketValue: -50000, grossExposure: 200000,
    netExposure: 100000, netLiquidation: 100000, grossLeverage: 2, netExposurePctOfNlv: 100 };
  render(<AnalystPortfolioBrief message={data} />);
  const table = screen.getByRole('table', { name: 'Portfolio exposure' });
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Exposure', 'Value', 'Current', 'Δ', 'Previous']);
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map(position => within(position).getAllByRole('cell').map(cell => cell.textContent))).toEqual([
    ['$200,000', '200%', '—', '—'], ['$150,000', '150%', '—', '—'], ['-$50,000', '50%', '—', '—'], ['$100,000', '100%', '—', '—'],
  ]);
  for (const position of rows.slice(0, 4)) {
    const [value, current, change, previous] = within(position).getAllByRole('cell');
    expect(value).toHaveClass('portfolio-exposure-value');
    expect(value.querySelector('.portfolio-exposure-amount')).toBeInTheDocument();
    expect(current).toHaveClass('portfolio-exposure-percent');
    expect(change).toHaveClass('portfolio-exposure-change', 'signal-unavailable', { exact: true });
    expect(previous).toHaveClass('portfolio-exposure-percent');
  }
  expect(rows[2].querySelector('.portfolio-exposure-sign')).toHaveTextContent('-');
});

test('every Current weight is an unsigned magnitude while captured Short and negative Net dollars keep their signs', () => {
  const data = message();
  data.portfolioBrief.metrics = { longMarketValue: 50000, shortMarketValue: -150000, grossExposure: 200000,
    netExposure: -100000, netLiquidation: 100000, grossLeverage: 2, netExposurePctOfNlv: -100 };
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={data} />);
  const table = screen.getByRole('table', { name: 'Portfolio exposure' });
  const rows = within(table).getAllByRole('row').slice(1);
  const weights = rows.slice(0, 4).map(position => within(position).getAllByRole('cell')[1]);
  expect(weights.map(cell => cell.textContent)).toEqual(['200%', '50%', '150%', '100%']);
  for (const cell of weights) expect(cell.children).toHaveLength(0);
  expect(rows[2]).toHaveClass('is-short');
  expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('-$150,000');
  expect(rows[3]).toHaveClass('is-net-negative');
  expect(within(rows[3]).getAllByRole('cell')[0]).toHaveTextContent('-$100,000');
  expect(JSON.stringify(data)).toBe(original);
});

test('legacy exposure without captured NLV keeps dollar values and captured ratios without inventing Long or Short percentages', () => {
  render(<AnalystPortfolioBrief message={message()} />);
  const table = screen.getByRole('table', { name: 'Portfolio exposure' });
  expect(within(table).getAllByRole('row').slice(1).map(position => within(position).getAllByRole('cell')[1].textContent))
    .toEqual(['123%', '$159,845', '-$50,584', '64%']);
});

test('unavailable holdings still show the gateway message without an opening line', () => {
  const data = message();
  data.portfolioBrief.available = false;
  data.portfolioBrief.reviewedAt = '2026-09-22T13:00:00Z';
  render(<AnalystPortfolioBrief message={data} />);
  expect(screen.getByRole('article', { name: 'Portfolio Review summary' })).not.toHaveTextContent('Good morning');
  expect(screen.getByText('Unavailable — connect to IB Gateway.')).toBeInTheDocument();
});

test('a verified Gateway never reads as a disconnect when only the captured book or its prices failed', () => {
  const data = message();
  data.portfolioBrief.available = false;
  data.portfolioBrief.unavailableReason = 'prices_unverified';
  const { rerender } = render(<AnalystPortfolioBrief message={data} />);
  expect(screen.getByText('Unavailable — live prices could not be verified.')).toBeInTheDocument();
  expect(screen.queryByText(/connect to IB Gateway/i)).not.toBeInTheDocument();
  rerender(<AnalystPortfolioBrief message={{ ...data, portfolioBrief: { ...data.portfolioBrief, unavailableReason: 'holdings_unverified' } }} />);
  expect(screen.getByText('Unavailable — live holdings could not be verified.')).toBeInTheDocument();
  rerender(<AnalystPortfolioBrief message={{ ...data, portfolioBrief: { ...data.portfolioBrief, unavailableReason: 'gateway_unverified' } }} />);
  expect(screen.getByText('Unavailable — the IB Gateway connection could not be verified.')).toBeInTheDocument();
  // Only the captured disconnect verdict asks the reader to connect.
  rerender(<AnalystPortfolioBrief message={{ ...data, portfolioBrief: { ...data.portfolioBrief, unavailableReason: 'gateway_disconnected' } }} />);
  expect(screen.getByText('Unavailable — connect to IB Gateway.')).toBeInTheDocument();
  rerender(<AnalystPortfolioBrief message={{ ...data, portfolioBrief: { ...data.portfolioBrief, available: true, reviewedAt: asOf,
    historicalHoldings: true, unavailableReason: 'prices_unverified' } }} />);
  expect(screen.getByText('Last verified holdings. Refresh to update.')).toBeVisible();
  expect(screen.queryByText(/connect to IB Gateway/i)).not.toBeInTheDocument();
  // An unloadable saved capture keeps its own explicit copy.
  rerender(<AnalystPortfolioBrief message={data} unavailableText="Unavailable — saved review could not be loaded." />);
  expect(screen.getByText('Unavailable — saved review could not be loaded.')).toBeInTheDocument();
});

test('every review section dates its captured inputs without refreshing old research to the review date', () => {
  const data = message();
  data.portfolioBrief.reviewedAt = '2026-09-28T23:00:00Z';
  data.portfolioBrief.dailyRollup = { version: 1, citations: [
    { id: 'old-call', product: 'the-call', publicationDate: '2026-09-03' },
  ], sections: [
    { id: 'company-catalysts', title: 'Company catalysts & sector research', blocks: [
      { type: 'paragraph', text: 'Captured research.', citationIds: ['old-call'] },
    ] },
  ] };
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={data} onCitation={jest.fn()} />);
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  within(report).getAllByRole('heading', { level: 2 }).forEach(heading => {
    expect(heading.nextElementSibling).toHaveClass('portfolio-review-dateline');
  });
  expect(within(screen.getByRole('region', { name: 'Exposure and risk' })).getByText(wholeText('Sep 4, 2026 13:05 PDT'))).toBeVisible();
  const company = screen.getByRole('region', { name: 'Company catalysts & sector research' });
  expect(within(company).getByText(wholeText('Sep 3, 2026'))).toBeVisible();
  expect(company.querySelector('.portfolio-review-dateline')).not.toHaveClass('has-period');
  expect(JSON.stringify(data)).toBe(original);
});

test('position sections keep their original holdings date beside the complete captured research period', () => {
  const data = brief();
  data.reviewedAt = '2026-09-05T23:00:00Z';
  const tradeCitation = { id: 'older-trade', title: 'Trade report', publicationDate: '2026-09-02' };
  const trendCitation = { id: 'older-trend', title: 'Trend report', publicationDate: '2026-09-03' };
  const tickSource = { publishedAt: '2026-08-31T12:43:00Z', citation: { ...tickCitation, publicationDate: '2026-08-31' } };
  data.holdings = [sizedRow('XLE', { weightPct: 7,
    sources: {
      trade: { publishedAt: '2026-09-02T14:30:00Z', citation: tradeCitation },
      trend: { publishedAt: '2026-09-03T14:30:00Z', citation: trendCitation },
    },
    tick: capturedTick({ source: tickSource }),
  })];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const section = screen.getByRole('region', { name: 'Corrections' });
  const dateline = section.querySelector('.portfolio-review-dateline');
  expect(dateline).toHaveClass('has-period');
  expect(dateline.querySelector('.portfolio-review-primary-date')).toHaveTextContent('Sep 4, 2026 13:05 PDT');
  expect(dateline.querySelector('.portfolio-review-period')).toHaveTextContent('Period: Aug 31, 2026 – Sep 3, 2026');
  expect(dateline).not.toHaveTextContent(/Sep 5|·|Research:/);
  fireEvent.click(within(section).getByRole('button', { name: /XLE Trend: Bullish · Sep 3, 2026 07:30 PDT/ }));
  expect(onCitation).toHaveBeenCalledWith(trendCitation);
  expect(JSON.stringify(data)).toBe(original);
});

test('Trade and Trend breaks are Action required and their signal sources still open', () => {
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={message()} onCitation={onCitation} />);
  const exceptions = screen.getByRole('region', { name: 'Action required' });
  expect(within(exceptions).getByRole('table', { name: 'Action required' })).toBeVisible();
  expect(exceptions).not.toHaveTextContent('FBY');
  expect(exceptions).toHaveTextContent('Reduce to 2.5% MIN');
  expect(exceptions).toHaveTextContent('Exit to 0.0%');
  fireEvent.click(within(exceptions).getByRole('button', { name: /IGV Trend: Neutral.*View source/ }));
  expect(onCitation).toHaveBeenCalledWith(expect.objectContaining({ id: 'rta' }));
  expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument();
  expect(exceptions).not.toHaveTextContent(/Verify Trade|Verify Trend/);
  expect(screen.getByRole('table', { name: 'Corrections' })).toHaveTextContent('Unavailable');
});

test('saved product-list indications do not appear as published Trade while captured Trend remains visible', () => {
  const data = brief();
  data.holdings = [sizedRow('LISTED', {
    trade: null, weightPct: 7,
    signalContext: { trade: { status: 'indication', value: 'BULLISH', rule: 'portfolio-solutions-listed',
      source: { publishedAt: asOf, citation: { id: 'listing', title: 'Portfolio Solutions' } } } },
  })];
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={jest.fn()} />);
  const position = screen.getByRole('row', { name: /LISTED/ });
  const fields = position.querySelectorAll('.portfolio-position-field');
  expect(fields[0]).toHaveTextContent('Tick—');
  expect(fields[1]).toHaveTextContent('Trade—');
  expect(fields[2]).toHaveTextContent('TrendBullish');
  expect(within(position).queryByRole('button', { name: /LISTED Trade: Bullish/ })).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test('retained published Trade displays its captured source without changing current portfolio rules', () => {
  const data = brief();
  const citation = { id: 'retained', title: 'Early Look', publicationDate: '2026-09-03', sourceUri: 'https://app.hedgeye.com/feed_items/123' };
  data.holdings = [sizedRow('IGV', { trade: null, weightPct: 7, researchSignals: { trade: {
    status: 'historical', value: 'BEARISH', referenceOnly: true, executable: false, currentDecisionEligible: false,
    signalProvenance: { field: 'trade', method: 'explicit-statement', sourceField: 'article.bodyText', sourceText: 'IGV Trade is Bearish.' },
    source: { publishedAt: '2026-09-03T12:00:00Z', citation },
  } } })];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const position = screen.getByRole('row', { name: /IGV/ });
  const trade = within(position).getByRole('button', { name: /IGV Trade: Bearish · Sep 3, 2026 05:00 PDT · View source/ });
  expect(trade).toHaveClass('signal-bearish');
  expect(position).not.toHaveTextContent('Exit to 0.0%');
  expect(position).toHaveTextContent('Overweight');
  fireEvent.click(trade);
  expect(onCitation).toHaveBeenCalledWith(citation);
  expect(JSON.stringify(data)).toBe(original);
});

test.each([true, false])('the empty position sections stay present without including ordinary holdings with coverageComplete %s', coverageComplete => {
  const data = brief();
  data.coverageComplete = coverageComplete;
  data.holdings = [sizedRow('CALM'), row('NOTREND', { trend: null }), row('NOSIGNALS', { trade: null, trend: null })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.getByRole('table', { name: 'Action required' })).toHaveTextContent(coverageComplete ? 'No positions need immediate action' : 'Unavailable');
  expect(screen.getByRole('table', { name: 'Corrections' })).toHaveTextContent(coverageComplete ? 'No corrections' : 'Unavailable');
  expect(screen.queryByText(/CALM|NOTREND|NOSIGNALS|Some checks need verification|No confirmed|Verify Trade|Verify Trend/)).not.toBeInTheDocument();
});

test('five long and five short corrections expand inline without including ordinary holdings', () => {
  const data = brief();
  data.holdings = ['LONG', 'SHORT'].flatMap(heldSide => Array.from({ length: 7 }, (_, index) => sizedRow(`${heldSide}-${index}`, {
    heldSide, trade: heldSide === 'LONG' ? 'BULLISH' : 'BEARISH', trend: heldSide === 'LONG' ? 'BULLISH' : 'BEARISH', weightPct: heldSide === 'LONG' ? 7 + index : 1.5 - index / 10,
  })));
  data.holdings.push(sizedRow('ORDINARY'));
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const table = screen.getByRole('table', { name: 'Corrections' });
  for (const side of ['Long', 'Short']) {
    expect(within(within(table).getByRole('rowgroup', { name: `${side} positions` })).getAllByRole('row')).toHaveLength(5);
  }
  expect(table.querySelectorAll('.portfolio-position-row')).toHaveLength(10);
  expect(table).not.toHaveTextContent('ORDINARY');
  fireEvent.click(screen.getByRole('button', { name: 'Show all 14 corrections' }));
  expect(table.querySelectorAll('.portfolio-position-row')).toHaveLength(14);
  fireEvent.click(screen.getByRole('button', { name: 'Show fewer corrections' }));
  expect(table.querySelectorAll('.portfolio-position-row')).toHaveLength(10);
});

test('weight corrections keep side ordering and colored group borders while Trade exits move to Action required', () => {
  const data = brief();
  data.holdings = ['LONG', 'SHORT'].flatMap(heldSide => {
    const trade = heldSide === 'LONG' ? 'BULLISH' : 'BEARISH';
    const position = (name, extra = {}) => sizedRow(`${heldSide}-${name}`, { heldSide, trade, trend: trade, ...extra });
    return [position('ORDINARY'), position('UNDER', { weightPct: 1.5 }), position('OVER', { weightPct: 7 }), position('EXIT', { trade: heldSide === 'LONG' ? 'BEARISH' : 'BULLISH' })];
  });
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const urgent = screen.getByRole('table', { name: 'Action required' });
  expect([...urgent.querySelectorAll('.portfolio-position-row th strong')].map(cell => cell.textContent)).toEqual(['LONG-EXIT', 'SHORT-EXIT']);
  for (const [side, first, second] of [['LONG', 'OVER', 'UNDER'], ['SHORT', 'UNDER', 'OVER']]) {
    const group = within(screen.getByRole('table', { name: 'Corrections' })).getByRole('rowgroup', { name: `${side === 'LONG' ? 'Long' : 'Short'} positions` });
    expect(group).toHaveClass('portfolio-position-section', `is-${side.toLowerCase()}`);
    expect(group.querySelector('th[scope="rowgroup"]')).toBeNull();
    expect(within(group).queryByText(side, { exact: true })).not.toBeInTheDocument();
    const rows = within(group).getAllByRole('row');
    expect(rows.map(position => position.querySelector('strong').textContent)).toEqual([`${side}-${first}`, `${side}-${second}`]);
    const overweight = within(group).getByRole('row', { name: new RegExp(`${side}-OVER`) });
    expect(within(overweight).getByText('Overweight')).not.toHaveClass('portfolio-position-action');
    expect(overweight.querySelector('.portfolio-position-action')).toBeNull();
    expect(within(group).getByRole('row', { name: new RegExp(`${side}-UNDER`) })).toHaveTextContent('Underweight');
    for (const position of rows) {
      expect(position).toHaveClass('portfolio-position-row', { exact: true });
      for (const direction of within(position).getAllByText(wholeText(side === 'LONG' ? 'Bullish' : 'Bearish'))) {
        expect(direction).toHaveClass(side === 'LONG' ? 'signal-bullish' : 'signal-bearish');
      }
    }
  }
});

test('position tables keep compact headers and captured names without classification or sizing labels', () => {
  const names = { DBMF: { name: 'Current renamed fund', source: 'Verified catalog' }, UNKNOWN: { name: 'Known company', source: 'SEC company ticker directory' } };
  // Action required renders first, then Corrections.
  usePortfolioSecurityNames.mockReturnValueOnce(names).mockReturnValueOnce(names);
  const data = brief();
  data.holdings = [sizedRow('DBMF', { securityName: 'iMGP DBi Managed Futures Strategy ETF', weightPct: 1 }),
    sizedRow('IBIT', { securityName: 'iShares Bitcoin Trust ETF', weightPct: 0.5 }),
    sizedRow('UNKNOWN', { weightPct: 1 })];
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const table = screen.getByRole('table', { name: 'Corrections' });
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
    'Ticker', 'Security', 'T/T/T', '%', 'M/M/S', 'Review', 'Product',
  ]);
  expect(within(table).getByRole('columnheader', { name: 'T/T/T' })).toHaveAttribute('title', 'Tick / Trade / Trend');
  expect(within(table).getByRole('columnheader', { name: 'Ticker' }).children).toHaveLength(0);
  expect(table).not.toHaveTextContent(/Classification|Beta|ATR sizing|Commodity policy/);
  expect(table.querySelector('.portfolio-position-classification')).toBeNull();
  expect(table.querySelector('.portfolio-position-sizing-basis')).toBeNull();
  const managedFutures = within(table).getByRole('row', { name: /DBMF/ });
  const capturedName = within(managedFutures).getByText('iMGP DBi Managed Futures Strategy ETF');
  expect(capturedName).toHaveClass('analyst-process--ticker');
  expect(capturedName.closest('.portfolio-position-name')).toHaveAttribute('title', 'iMGP DBi Managed Futures Strategy ETF');
  const bitcoin = within(table).getByRole('row', { name: /IBIT/ });
  // IBIT has no separate commodity policy; its band comes from its own ATR like every other security.
  expect(bitcoin).not.toHaveTextContent('Commodity');
  expect(bitcoin.querySelector('.portfolio-position-limits')).toHaveTextContent('MIN2.5%MAX5.0%Stop95.00');
  const resolvedName = within(within(table).getByRole('row', { name: /UNKNOWN/ })).getByText('Known company');
  expect(resolvedName).toHaveClass('analyst-process--ticker');
  expect(resolvedName.closest('.portfolio-position-name')).toHaveAttribute('title', 'Known company · Current security name · SEC company ticker directory');
  expect(table).not.toHaveTextContent('Current renamed fund');
  expect(JSON.stringify(data)).toBe(original);
});

test('missing security names remain empty instead of repeating the ticker', () => {
  const data = brief(); data.holdings = [sizedRow('UNKNOWN', { weightPct: 1 })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /UNKNOWN/ });
  expect(within(position).getAllByRole('cell')[0]).toHaveTextContent('—');
});

test('the weight sits in its own % column after T/T/T, and a missing weight reads as a dash', () => {
  const data = brief(); data.holdings = [row('BWET', { weightPct: null, trade: 'BEARISH' }), sizedRow('HELD', { weightPct: 1.73, trade: 'BEARISH' })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const missing = screen.getByRole('row', { name: /BWET/ });
  expect(within(missing).getByRole('rowheader')).toHaveTextContent(/^BWET$/);
  expect(within(missing).getAllByRole('cell')[2]).toHaveTextContent(/^—$/);
  const held = screen.getByRole('row', { name: /HELD/ });
  expect(within(held).getByRole('rowheader')).toHaveTextContent(/^HELD$/);
  expect(within(held).getAllByRole('cell')[2]).toHaveClass('portfolio-position-weight');
  expect(within(held).getAllByRole('cell')[2]).toHaveTextContent(/^1\.73%$/);
});

test('position tables show dated product calls beside Review and open all of that product’s evidence', () => {
  const onCitation = jest.fn();
  const first = { id: 'call-first', product: 'the-call', productLabel: 'The Call', publicationDate: '2026-09-03', title: 'The Call' };
  const confirmed = { ...first, id: 'call-confirmed', publicationDate: '2026-09-04' };
  const action = { id: 'etf-action', product: 'etf-pro', productLabel: 'ETF Pro', publicationDate: '2026-09-04', title: 'ETF Pro' };
  const data = brief();
  data.holdings = [sizedRow('ETHA', { weightPct: 1, productReadings: [
    { product: 'the-call', productLabel: 'The Call', reading: 'Source Long position', kind: 'source-position', date: '2026-09-03', relation: 'direct', sourceTicker: 'ETHA', citations: [first] },
    { product: 'the-call', productLabel: 'The Call', reading: 'Source Long position', kind: 'source-position', date: '2026-09-04', relation: 'direct', sourceTicker: 'ETHA', citations: [confirmed] },
    { product: 'etf-pro', productLabel: 'ETF Pro', reading: 'Sell some', kind: 'action', date: '2026-09-04', relation: 'direct', sourceTicker: 'ETHA', citations: [action] },
  ] })];
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const position = within(screen.getByRole('table', { name: 'Corrections' })).getByRole('row', { name: /ETHA/ });
  const cells = within(position).getAllByRole('cell');
  expect(cells[4]).toHaveClass('portfolio-position-review');
  expect(cells[5]).toHaveClass('portfolio-position-products');
  // A confirmed call keeps one line, dated by its latest publication.
  const call = within(cells[5]).getByRole('button', { name: 'Sep 4 The Call: Long · View source' });
  expect(call).toHaveTextContent(/^Sep 4 The Call: Long$/);
  expect(call.querySelector('.analyst-process--positive')).toHaveTextContent('Long');
  expect(call.querySelector('time.portfolio-position-product-date')).toHaveAttribute('dateTime', '2026-09-04');
  expect(within(cells[5]).getByRole('button', { name: 'Sep 4 ETF Pro: Sell some · View source' })).toHaveTextContent('Sep 4 ETF Pro: Sell some');
  fireEvent.click(call);
  expect(onCitation).toHaveBeenCalledWith(first, { relatedSources: [first, confirmed] });
  expect(JSON.stringify(data)).toBe(original);
});

test('saved position products preserve the publisher label and visible proxy instrument without filling missing evidence', () => {
  const citation = { id: 'crypto-reading', product: 'crypto-quant', productLabel: 'Crypto Quant', publicationDate: '2026-09-04', title: 'Crypto Quant' };
  const data = brief();
  data.holdings = [sizedRow('ETHA', { weightPct: 1 }), sizedRow('UNKNOWN', { weightPct: 1 })];
  data.dailyRollup = { version: 1, sections: [{ id: 'position-confirmations', blocks: [{ type: 'table', rows: [{ holding: 'ETHA', heldSide: 'LONG', evidence: [
    { product: 'crypto-quant', productLabel: 'Crypto Quant', reading: 'Bullish Trend', kind: 'trend', date: '2026-09-04', relation: 'proxy', sourceTicker: 'ETH', citations: [citation] },
  ] }] }] }] };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} historical />);
  const table = screen.getByRole('table', { name: 'Corrections' });
  const productCell = within(within(table).getByRole('row', { name: /ETHA/ })).getAllByRole('cell')[5];
  expect(productCell).toHaveTextContent('Sep 4 Crypto Quant: Bullish Trend (ETH proxy)');
  expect(productCell.querySelector('.analyst-process--positive')).toHaveTextContent('Bullish');
  const missingProduct = within(within(table).getByRole('row', { name: /UNKNOWN/ })).getAllByRole('cell')[5];
  expect(missingProduct).toHaveTextContent(/^—$/);
});

const tickCitation = { id: 'tick-position', product: 'hedgai-signals', title: 'HedgAI source publication', publicationDate: '2026-09-04' };
const capturedTick = (extra = {}) => ({ value: 'BEARISH', status: 'published', qualified: true,
  position: 'Short', contribution: 'Short', sourceTicker: 'XLE', sourceLabel: 'Energy',
  citationIds: ['tick-position', 'tick-history'], source: { publishedAt: '2026-09-04T12:43:00Z', citation: tickCitation },
  contextOnly: true, decisionEligible: false, executable: false, ...extra });

test('Tick precedes Trade and Trend in one signal cell while retaining separate captured evidence', () => {
  const data = brief();
  const metricsCitation = { id: 'tick-history', product: 'hedgai-signals', title: 'HedgAI historical statistics' };
  data.citations = [tickCitation, metricsCitation];
  data.holdings = [sizedRow('XLE', { weightPct: 1, tick: capturedTick() })];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const position = screen.getByRole('row', { name: /XLE/ });
  const button = within(position).getByRole('button', { name: /XLE Tick: Bearish.*HedgAI Signals.*05:43.*View source/ });
  expect(button).toHaveClass('signal-bearish');
  const signalCell = button.closest('td');
  const fields = signalCell.querySelectorAll('.portfolio-position-field');
  expect(Array.from(fields, field => field.querySelector('small').textContent)).toEqual(['Tick', 'Trade', 'Trend']);
  expect(Array.from(fields, field => field.parentElement)).toEqual([signalCell, signalCell, signalCell]);
  expect(within(signalCell).getByRole('button', { name: /XLE Trade: Bullish/ })).toHaveClass('signal-bullish');
  expect(within(signalCell).getByRole('button', { name: /XLE Trend: Bullish/ })).toHaveClass('signal-bullish');
  expect(within(position).getAllByRole('cell')).toHaveLength(6);
  expect(position).toHaveTextContent('TradeBullishTrendBullish');
  expect(position).toHaveTextContent('Underweight');
  expect(position).not.toHaveTextContent(/Exit|Reduce|Cover/);
  fireEvent.click(button);
  expect(onCitation).toHaveBeenCalledWith(tickCitation, { relatedSources: [tickCitation, metricsCitation] });
  expect(JSON.stringify(data)).toBe(original);
});

test.each([
  ['historical', capturedTick({ status: 'historical', contribution: 'Last known Short' }), '—'],
  ['missing', undefined, '—'],
  ['uncited', capturedTick({ source: null }), '—'],
  ['undated', capturedTick({ source: { citation: tickCitation } }), '—'],
  ...['offline', 'stale', 'cacheOnly', 'mock', 'seeded', 'inferred', 'fixture', 'fromCache'].map(flag => [flag, capturedTick({ [flag]: true }), '—']),
  ['source offline', capturedTick({ source: { publishedAt: '2026-09-04T12:43:00Z', citation: tickCitation, offline: true } }), '—'],
  ['metadata unverified', capturedTick({ metadata: { sourceVerified: false } }), '—'],
  ['mismatched', capturedTick({ value: 'BULLISH', position: 'Short' }), '—'],
  ['historical Wait', capturedTick({ value: 'NEUTRAL', position: 'Wait', status: 'historical' }), '—'],
  ['uncited Wait', capturedTick({ value: 'NEUTRAL', position: 'Wait', source: null }), '—'],
  ['stale Wait', capturedTick({ value: 'NEUTRAL', position: 'Wait', stale: true }), '—'],
  ['mismatched Wait', capturedTick({ value: 'BULLISH', position: 'Wait' }), '—'],
])('Tick preserves %s without inventing a direction or changing Trend', (_name, tick, expected) => {
  const data = brief(); data.holdings = [sizedRow('XLE', { weightPct: 1, tick })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /XLE/ });
  const tickField = position.querySelector('.portfolio-position-tick');
  expect(tickField).toHaveTextContent(`Tick${expected}`);
  expect(within(tickField).getByText(expected)).toHaveClass('signal-unavailable');
  expect(position).toHaveTextContent('TradeBullishTrendBullish');
});

test.each([
  ['published Buy below the strategy threshold', capturedTick({ value: 'BULLISH', position: 'Buy', qualified: false,
    metrics: { buy: { battingAverage: 0.4, signals: 20 } } }), 'Bullish', 'signal-bullish'],
  ['published Short with unavailable statistics', capturedTick({ qualified: false, metrics: { unavailable: true, status: 'unavailable' } }), 'Bearish', 'signal-bearish'],
  ['legacy excluded Short', capturedTick({ value: null, status: 'excluded', qualified: false }), 'Bearish', 'signal-bearish'],
  ['legacy Wait', capturedTick({ value: null, qualified: false, status: 'wait', position: 'Wait', contribution: 'Await Buy' }), 'Neutral', 'signal-neutral'],
  ['published Wait', capturedTick({ value: 'NEUTRAL', qualified: false, status: 'published', position: 'Wait' }), 'Neutral', 'signal-neutral'],
])('Tick shows the original captured %s independently of historical strategy statistics', (_name, tick, expected, className) => {
  const data = brief(); data.holdings = [sizedRow('XLE', { weightPct: 1, tick })];
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /XLE/ });
  const tickField = position.querySelector('.portfolio-position-tick');
  expect(within(tickField).getByText(expected)).toHaveClass(className);
  expect(position).toHaveTextContent('TradeBullishTrendBullish');
  expect(position).toHaveTextContent('Underweight');
  expect(JSON.stringify(data)).toBe(original);
});

test.each([
  ['published', capturedTick({ value: 'NEUTRAL', position: 'Wait', qualified: false })],
  ['legacy', capturedTick({ value: null, position: 'Wait', status: 'wait', contribution: 'Await Buy', qualified: false })],
])('captured %s Wait displays Neutral with its gray color, dated evidence, and no-direction tooltip', (_name, tick) => {
  const data = brief();
  data.citations = [tickCitation];
  data.holdings = [sizedRow('XLE', { weightPct: 1, tick })];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const button = screen.getByRole('button', { name: /XLE Tick: Neutral.*Wait and Watch: no directional call.*HedgAI Signals.*05:43.*View source/ });
  expect(button).toHaveTextContent('Neutral');
  expect(button).toHaveClass('signal-neutral');
  expect(button).toHaveAttribute('title', expect.stringContaining('Wait and Watch: no directional call'));
  expect(button).not.toHaveTextContent('Wait');
  fireEvent.click(button);
  expect(onCitation).toHaveBeenCalledWith(tickCitation);
  expect(JSON.stringify(data)).toBe(original);
});

test.each(['LONG', 'SHORT'])('weight flags preserve %s Trade exit and Trend reduction instructions', heldSide => {
  const trade = heldSide === 'LONG' ? 'BULLISH' : 'BEARISH';
  const data = brief();
  data.holdings = [sizedRow('TRADEEXIT', { heldSide, weightPct: 7, trade: heldSide === 'LONG' ? 'BEARISH' : 'BULLISH', trend: trade }), sizedRow('TRENDREDUCE', { heldSide, weightPct: 7, trade, trend: 'NEUTRAL' })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const exit = screen.getByRole('row', { name: /TRADEEXIT/ });
  const reduce = screen.getByRole('row', { name: /TRENDREDUCE/ });
  expect(exit).toHaveClass('portfolio-position-row', { exact: true });
  expect(exit).toHaveTextContent('Overweight');
  expect(exit).toHaveTextContent(`${heldSide === 'SHORT' ? 'Cover' : 'Exit'} to 0.0%`);
  expect(within(exit).getByText(`${heldSide === 'SHORT' ? 'Cover' : 'Exit'} to 0.0%`)).toHaveClass('portfolio-position-action');
  expect(within(exit).getByText('Overweight')).not.toHaveClass('portfolio-position-action');
  expect(reduce).toHaveTextContent('Reduce to 2.5% MIN');
  expect(within(reduce).getByText('Reduce to 2.5% MIN')).toHaveClass('portfolio-position-action');
  expect(within(reduce).getByText('Overweight')).not.toHaveClass('portfolio-position-action');
  expect(reduce).not.toHaveTextContent('Trim 2.0 pp to 5.0% MAX');
});

test('underweight exceptions report the shortfall without suggesting an addition', () => {
  const data = brief(); data.holdings = [sizedRow('SMALL', { weightPct: 1.5 })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /SMALL/ });
  expect(position).toHaveTextContent('Underweight');
  expect(position).toHaveTextContent('1.0 pp below MIN');
  expect(position).not.toHaveTextContent(/Buy|Increase|Add|Reduce|Exit|Cover/i);
});

test('the 10 bp buffer and invalid sizing evidence never create exceptions', () => {
  const data = brief(); data.holdings = [sizedRow('MINBUFFER', { weightPct: 2.4 }), sizedRow('MAXBUFFER', { weightPct: 5.1 }),
    ...['stale', 'offline', 'cacheOnly', 'mock', 'seed'].map(flag => sizedRow(`INVALID-ATR-${flag}`, {
      weightPct: flag === 'stale' || flag === 'mock' ? 1 : 8,
      sizingInputs: { ...sizing(), atr14: { ...sizing().atr14, [flag]: true } },
    })),
    ...['stale', 'mock'].map(flag => sizedRow(`INVALID-PRICE-${flag}`, {
      weightPct: 8, sizingInputs: { ...sizing(), referencePrice: { ...sizing().referencePrice, [flag]: true } },
    })),
  ];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.getByRole('region', { name: 'Corrections' })).toHaveTextContent('Unavailable');
  expect(screen.queryByText(/Overweight|Underweight/)).not.toBeInTheDocument();
});

test('stop evidence does not create a report section or an exception', () => {
  const data = brief(); data.stopCoverage = { status: 'captured', asOf };
  data.holdings = ['missing', 'partial', 'oversized', 'wrong_side', 'unavailable'].map(status => sizedRow(status, { stopCheck: { status, coveragePct: 60 } }));
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  for (const name of ['Action required', 'Corrections']) {
    const section = screen.getByRole('region', { name });
    expect(section).toHaveTextContent('Unavailable');
    expect(section.querySelectorAll('.portfolio-position-row')).toHaveLength(0);
  }
  // Only the ATR stop column headers mention a stop; captured stop coverage stays out of the report.
  expect(screen.queryAllByText(/stop/i)).toEqual([]);
  expect([...document.querySelectorAll('[title*="Stop"]')].map(element => element.textContent)).toEqual(['M/M/S', 'M/M/S']);
  expect(screen.queryByText(/none found|60.0% covered/i)).not.toBeInTheDocument();
});

test('a dated opposing Trend retains the MIN warning when Trade is unavailable', () => {
  // ATR 5 on 100: 10% stop distance → MIN 1.25%, MAX 2.5%.
  const data = brief(); data.holdings = [row('AMZN', { weightPct: 1.365, trade: null, trend: 'BEARISH', sizingInputs: sizing(5) }), row('BUFFER', { weightPct: 2.6, trade: null, trend: 'BEARISH' })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /AMZN/ });
  expect(position).toHaveTextContent('1.365%');
  expect(position).toHaveTextContent('Reduce to 1.25% MIN');
  expect(position).not.toHaveTextContent(/Trade remains|Exit|Verify Trade/);
  expect(screen.queryByRole('row', { name: /BUFFER/ })).not.toBeInTheDocument();
});

test('the limits cell shows the ATR-derived MIN, MAX and stop with 25 bp precision', () => {
  // ATR 2 on 100: 4% stop distance → MIN roundUp(3.125) = 3.25%, MAX roundDown(6.25) = 6.25%.
  const data = brief(); data.holdings = [
    sizedRow('LONGATR', { weightPct: 7.25, sizingInputs: sizing(2) }),
    sizedRow('SHORTATR', { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -7.25, sizingInputs: sizing(2) }),
  ];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const long = screen.getByRole('row', { name: /LONGATR/ });
  const limits = long.querySelector('.portfolio-position-limits');
  expect(Array.from(limits.querySelectorAll('.portfolio-position-field'), field => field.textContent)).toEqual(['MIN3.25%', 'MAX6.25%', 'Stop96.00']);
  expect(within(limits).getByText('96.00')).toHaveAttribute('title', '2 × ATR below the last close (4.0%) · costs 0.29% of NLV at this weight');
  expect(long).toHaveTextContent('Trim 1.0 pp to 6.25% MAX');
  const short = screen.getByRole('row', { name: /SHORTATR/ });
  expect(short.querySelector('.portfolio-position-limits')).toHaveTextContent('MIN3.25%MAX6.25%Stop104.00');
  expect(within(short).getByText('104.00')).toHaveAttribute('title', expect.stringContaining('2 × ATR above the last close (4.0%)'));
  const header = within(screen.getByRole('table', { name: 'Corrections' })).getByRole('columnheader', { name: 'M/M/S' });
  expect(header).toHaveAttribute('title', 'MIN / MAX / Stop · MIN and MAX cost 0.125% and 0.25% of NLV if the 2 × ATR stop is hit');
});

test('missing ATR leaves MIN, MAX and the stop as dashes while a Trade exit still shows', () => {
  const data = brief(); data.holdings = [sizedRow('NOATR', { trade: 'BEARISH', sizingInputs: {} })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /NOATR/ });
  expect(position.querySelector('.portfolio-position-limits')).toHaveTextContent('MIN—MAX—Stop—');
  expect(within(position).getByText('—', { selector: '.portfolio-position-limits [title="Stop needs verified ATR and price"]' })).toBeInTheDocument();
  expect(position).toHaveTextContent('Exit to 0.0%');
  expect(position).not.toHaveTextContent(/Beta/);
});

test('an ATR too large to size exits with the volatility copy instead of a beta or risk-cap label', () => {
  // ATR 60 on 100: MIN rounds up to 0.25% while MAX rounds down to 0, so the position cannot be sized.
  const data = brief(); data.holdings = [sizedRow('WILD', { sizingInputs: sizing(60) })];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const position = screen.getByRole('row', { name: /WILD/ });
  expect(position).toHaveTextContent('Exit to 0.0%');
  expect(position).toHaveTextContent('Too volatile to size');
  expect(position.querySelector('.portfolio-position-limits')).toHaveTextContent('MIN0.25%MAX0.0%Stop—');
  expect(position).not.toHaveTextContent(/Beta|risk cap/i);
});

test('a verified current volatility exit names the rule and cites only the ATR sizing input', () => {
  const rule = { ...sizedRow('WILD', { sizingInputs: sizing(60) }), status: 'conflict', rule: 'RISK_CAP', action: 'EXIT', targetLabel: 'Target', targetWeight: 0, reduction: 3 };
  const payload = { publicationTime: '2026-09-05T14:30:00Z', holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(), event: { qualityStatus: 'validated', eventType: 'trend_signal', signalValue: 'NEUTRAL' }, signalField: 'trend', rule };
  const data = brief(); data.holdings = [rule];
  render(<PortfolioResearchUpdates brief={data} findings={[{ id: 'a', symbol: 'WILD', state: 'open', action: 'signal change', payload }]} onCitation={jest.fn()} />);
  const conflict = screen.getByRole('heading', { name: 'Exit under volatility rule' }).closest('article');
  expect(conflict).toHaveTextContent('WILD — Too volatile to size');
  expect(conflict).toHaveTextContent('Current weight 3.0% → Target 0.0%');
  expect(conflict.querySelector('.portfolio-brief-source')).toHaveTextContent(/^Sizing inputs · ATR Sep 4, 2026/);
  expect(conflict).not.toHaveTextContent(/Beta/);
});

test('Exposure & risk sets Current, Δ in basis points and Previous side by side under both observation dates', () => {
  const data = brief(); data.comparison = { status: 'available', baselineAsOf: '2026-09-02T14:30:00Z', metrics: {
    grossLeverage: { previous: 1.3, current: 1.2334 }, netExposurePctOfNlv: { previous: 60, current: 64.04 },
    grossExposure: { previous: 211000, current: 210428.82 }, netExposure: { previous: 100000, current: 109261.52 },
  } };
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.queryByRole('region', { name: 'Since previous close' })).not.toBeInTheDocument();
  const section = screen.getByRole('region', { name: 'Exposure and risk' });
  const dateline = section.querySelector('.portfolio-review-dateline');
  expect(dateline).toHaveTextContent('Sep 4, 2026 13:05 PDT');
  expect(dateline).toHaveTextContent('Previous positioning: Sep 2, 2026 07:30 PDT');
  expect(within(section).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Exposure', 'Value', 'Current', 'Δ', 'Previous']);
  expect(within(section).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Gross', 'Long', 'Short', 'Net']);
  expect(within(section).getByRole('row', { name: 'Gross $210,429 123% -666 bp 130%' })).toBeInTheDocument();
  expect(within(section).getByRole('row', { name: 'Net $109,262 64% +404 bp 60%' })).toBeInTheDocument();
  expect(section).not.toHaveTextContent(/AM|PM|211,000|\.\d+%/);
  expect(JSON.stringify(data)).toBe(original);
});

test('comparison uses captured dollar pairs only when percentage pairs are unavailable', () => {
  const data = brief(); data.metrics = {}; data.comparison = { status: 'available', metrics: { grossExposure: { previous: 200000, current: 201000 }, netExposure: { previous: null, current: 5000 } } };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const section = screen.getByRole('region', { name: 'Exposure and risk' });
  expect(within(section).getAllByRole('rowheader')).toHaveLength(4);
  expect(within(section).getByRole('row', { name: 'Net — $5,000 — —' })).toBeInTheDocument();
  expect(within(section).getByRole('row', { name: 'Gross — $201,000 +$1,000 $200,000' })).toBeInTheDocument();
  expect(within(section).getByRole('row', { name: 'Long — — — —' })).toBeInTheDocument();
});

test('an unavailable previous close preserves independently verified current exposures without inventing a change', () => {
  const data = brief(); data.comparison = { status: 'unavailable', baselineKind: 'previous-session-close', baselineSessionDate: '2026-09-03' };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const section = screen.getByRole('region', { name: 'Exposure and risk' });
  expect(within(section).getByRole('row', { name: 'Gross $210,429 123% — —' })).toBeInTheDocument();
  expect(within(section).getByRole('row', { name: 'Net $109,262 64% — —' })).toBeInTheDocument();
  expect(section).toHaveTextContent('Sep 3, 2026');
  expect(section).toHaveTextContent('Previous close unavailable');
});

test('previous-close comparison renders original account observation times and broker exposure pairs without changing the saved capture', () => {
  const data = brief(); data.comparison = {
    status: 'available', baselineKind: 'previous-session-close', baselineSessionDate: '2026-10-07',
    baselineSessionCloseAt: '2026-10-07T20:00:00Z', baselineAsOf: '2026-10-07T21:27:00Z', currentAsOf: '2026-10-09T02:37:00Z',
    metrics: { grossLeverage: { previous: 1.69509, current: 1.70480 }, netExposurePctOfNlv: { previous: 37.117, current: 29.039 } },
  };
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const section = screen.getByRole('region', { name: 'Exposure and risk' });
  expect(section).toHaveTextContent('Previous: Oct 7, 2026 14:27 PDT');
  expect(section).not.toHaveTextContent('Current positioning:');
  // Both sides round to 170%; the Δ keeps the 97 bp move visible.
  expect(within(section).getByRole('row', { name: 'Gross $210,429 170% +97 bp 170%' })).toBeInTheDocument();
  expect(within(section).getByRole('row', { name: 'Net $109,262 29% -808 bp 37%' })).toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test('current and previous exposure use their own captured NLV and directional colors', () => {
  const data = brief();
  data.metrics = { longMarketValue: 50000, shortMarketValue: -150000, grossExposure: 200000,
    netExposure: -100000, netLiquidation: 100000, grossLeverage: 2, netExposurePctOfNlv: -100 };
  data.comparison = { status: 'available', metrics: {
    longMarketValue: { previous: 150000, current: 50000 }, shortMarketValue: { previous: -50000, current: -150000 },
    grossExposure: { previous: 200000, current: 200000 }, netExposure: { previous: 100000, current: -100000 },
    netLiquidation: { previous: 200000, current: 100000 }, grossLeverage: { previous: 1, current: 2 },
    netExposurePctOfNlv: { previous: 50, current: -100 },
  } };
  const original = JSON.stringify(data);
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const table = screen.getByRole('table', { name: 'Portfolio exposure' });
  const rows = within(table).getAllByRole('row').slice(1);
  // Short grows by magnitude; Net keeps its sign.
  expect(rows.map(position => within(position).getAllByRole('cell').slice(1).map(cell => cell.textContent))).toEqual([
    ['200%', '+10,000 bp', '100%'], ['50%', '-2,500 bp', '75%'], ['150%', '+12,500 bp', '25%'], ['100%', '-15,000 bp', '50%'],
  ]);
  const weights = position => [1, 3].map(index => within(position).getAllByRole('cell')[index]);
  weights(rows[1]).forEach(cell => expect(cell).toHaveClass('signal-bullish'));
  weights(rows[2]).forEach(cell => expect(cell).toHaveClass('signal-bearish'));
  expect(weights(rows[3])[0]).toHaveClass('signal-bearish');
  expect(weights(rows[3])[1]).toHaveClass('signal-bullish');
  // Δ colors follow the displayed sign: green up, red down.
  expect(rows.map(position => within(position).getAllByRole('cell')[2].className)).toEqual([
    'portfolio-exposure-change signal-bullish', 'portfolio-exposure-change signal-bearish', 'portfolio-exposure-change signal-bullish',
    'portfolio-exposure-change signal-bearish',
  ]);
  expect(JSON.stringify(data)).toBe(original);
});

test('captured interest stays out of Exposure & risk', () => {
  const data = brief();
  data.metrics = { ...data.metrics, netLiquidation: 100000, netAccruedInterest: -412.37 };
  data.comparison = { status: 'available', metrics: { netAccruedInterest: { previous: -388.05, current: -412.37 } } };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const exposure = screen.getByRole('region', { name: 'Exposure and risk' });
  expect(within(exposure).queryByRole('rowheader', { name: 'Interest' })).not.toBeInTheDocument();
  expect(exposure).not.toHaveTextContent(/\$412|\$388/);
});

test('legacy missing prior side totals stay unavailable instead of borrowing the current denominator', () => {
  const data = brief(); data.metrics.netLiquidation = 100000;
  data.comparison = { status: 'available', metrics: {
    longMarketValue: { previous: 200000, current: 159845.17 },
    netLiquidation: { previous: null, current: 100000 },
  } };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const table = screen.getByRole('table', { name: 'Portfolio exposure' });
  expect(within(table).getByRole('row', { name: 'Long $159,845 $159,845 -$40,155 $200,000' })).toBeInTheDocument();
  const short = within(table).getAllByRole('row')[3];
  expect(within(short).getAllByRole('cell').slice(1).map(cell => cell.textContent)).toEqual(['51%', '—', '—']);
  expect(within(short).getAllByRole('cell')[3]).toHaveClass('signal-unavailable');
});

test('unsupported comparisons and factor totals stay out of the report', () => {
  const data = brief(); data.comparison = { status: 'unavailable', metrics: { grossExposure: { previous: 1, current: 2 } } };
  data.factorExposure = { status: 'unavailable', label: 'Factor exposure', rows: [{ label: 'Growth', longPct: 40 }] };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Previous close unavailable');
  expect(screen.queryByText('$2')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Factor exposure' })).toHaveTextContent('Unavailable');
  expect(screen.queryByText('Growth')).not.toBeInTheDocument();
});

test('omits the redundant asset exposure table even when the saved report includes totals', () => {
  const data = brief(); data.factorExposure = { status: 'partial', label: 'Asset exposure', coveragePct: 75, rows: [{ label: 'Equities', longPct: 55, shortPct: -40, netPct: 15 }, { label: 'Unclassified', longPct: null, shortPct: null, netPct: null }] };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.queryByRole('region', { name: 'Asset exposure' })).not.toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'Asset exposure' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Action required' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Corrections' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Factor exposure' })).toHaveTextContent('Unavailable');
  expect(screen.queryByText('Growth')).not.toBeInTheDocument();
});

test('daily rollup replaces the old automated Quad outlook and renders every substantive section', () => {
  const data = brief(); data.quadOutlook = { to: 4, citation: { id: 'early-look', title: 'Early Look' }, publishedAt: '2026-09-18' };
  data.nextSession = [{ text: 'Old summary' }];
  data.dailyRollup = { version: 1, sections: Array.from({ length: 10 }, (_, index) => ({ id: `section-${index}`, title: `Research section ${index}`, blocks: [{ type: 'paragraph', text: `Verified research ${index}` }] })) };
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.queryByRole('region', { name: 'Session outlook' })).not.toBeInTheDocument();
  expect(screen.queryByText('Old summary')).not.toBeInTheDocument();
  expect(screen.getByText('Verified research 9')).toBeVisible();
});

test('an empty current rollup never falls back to the legacy inferred Quad scenario or next-session summary', () => {
  const data = brief(); data.quadOutlook = { to: 4, citation: { id: 'early-look', title: 'Early Look' }, publishedAt: '2026-09-18' };
  data.nextSession = [{ text: 'Old summary' }];
  data.dailyRollup = { version: 1, sections: [] };
  const { rerender } = render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.queryByRole('region', { name: 'Session outlook' })).not.toBeInTheDocument();
  expect(screen.queryByText('Quad 4')).not.toBeInTheDocument();
  data.quadOutlook = null;
  rerender(<AnalystPortfolioBrief message={{ portfolioBrief: { ...data } }} />);
  expect(screen.queryByRole('region', { name: 'Next session' })).not.toBeInTheDocument();
  expect(screen.queryByText('Old summary')).not.toBeInTheDocument();
});

test('saved unavailable holdings do not prevent the cited research rollup from rendering', () => {
  const data = brief(); data.available = false; data.reviewedAt = asOf; data.historicalHoldings = true;
  data.dailyRollup = { version: 1, sections: [{ id: 'day', title: 'The day ahead', blocks: [{ type: 'paragraph', text: 'Published research remains available.' }] }] };
  const { rerender } = render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Unavailable');
  expect(screen.queryByText('$210,429')).not.toBeInTheDocument();
  expect(screen.getByText('Published research remains available.')).toBeVisible();
  expect(screen.getByText('Unavailable — connect to IB Gateway.')).toBeVisible();
  expect(screen.queryByText(/Verified portfolio evidence|Last verified holdings/)).not.toBeInTheDocument();
  rerender(<AnalystPortfolioBrief message={{ portfolioBrief: { ...data, available: true } }} />);
  expect(screen.getByText('Last verified holdings. Connect to IB Gateway to update.')).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Portfolio Review' })).not.toBeInTheDocument();
});

test('saved Session outlook colors each Quad and held side without changing the scenario or source', () => {
  const data = brief();
  const citation = { id: 'early-look', title: 'Early Look', publicationDate: '2026-09-18' };
  data.quadOutlook = { from: 2, to: 3, citation, publishedAt: '2026-09-18' };
  data.holdings = [row('XLF', { weightPct: 4 }), row('XLU', { weightPct: 3 }), row('XLI', { heldSide: 'SHORT', weightPct: 2 })];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} onCitation={onCitation} />);
  const outlook = screen.getByRole('region', { name: 'Session outlook' });
  expect(outlook).toHaveTextContent('Quad 2 → Quad 3 scenario');
  expect(within(outlook).getByText('Quad 2')).toHaveClass('analyst-process--quad-2');
  expect(within(outlook).getByText('Quad 3')).toHaveClass('analyst-process--quad-3');
  for (const long of within(outlook).getAllByText('long')) expect(long).toHaveClass('analyst-process--positive');
  expect(within(outlook).getByText('short')).toHaveClass('analyst-process--negative');
  expect(outlook).toHaveTextContent('XLU (long), XLI (short) align with this Quad’s playbook.');
  expect(outlook).not.toHaveTextContent(/Scenario review using|holdings mapped|Trade\/Trend rules determine/);
  fireEvent.click(within(outlook).getByRole('button', { name: 'Early Look' }));
  expect(onCitation).toHaveBeenCalledWith(citation);
  expect(JSON.stringify(data)).toBe(original);
});

test('a single Quad 4 scenario and next-session narrative use the same directional colors', () => {
  const data = brief();
  data.quadOutlook = { to: 4, citation: { id: 'early-look', title: 'Early Look' }, publishedAt: '2026-09-18' };
  const { rerender } = render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  expect(within(screen.getByRole('region', { name: 'Session outlook' })).getByText('Quad 4')).toHaveClass('analyst-process--quad-4');
  data.quadOutlook = null;
  data.nextSession = [{ text: 'Quad 1 supports the long position; the short position retains a Bearish Trend.' }];
  rerender(<AnalystPortfolioBrief message={{ portfolioBrief: { ...data } }} />);
  const session = screen.getByRole('region', { name: 'Next session' });
  expect(within(session).getByText('Quad 1')).toHaveClass('analyst-process--quad-1');
  expect(within(session).getByText('long')).toHaveClass('analyst-process--positive');
  expect(within(session).getByText('short')).toHaveClass('analyst-process--negative');
  expect(within(session).getByText('Bearish')).toHaveClass('analyst-process--negative');
});

test('new validated held research appears separately; stale current weights and unheld events are excluded', () => {
  const payload = { publicationTime: '2026-09-05T14:30:00Z', holdingsVerifiedAt: asOf, event: { qualityStatus: 'validated', eventType: 'trend_signal', signalValue: 'NEUTRAL' }, rule: { ...row('IGV'), status: 'conflict', action: 'REDUCE', reduction: 2, targetWeight: 2 }, signalField: 'trend' };
  render(<PortfolioResearchUpdates brief={brief()} findings={[{ id: 'a', symbol: 'IGV', state: 'open', action: 'signal change', payload }, { id: 'b', symbol: 'UNHELD', state: 'open', payload }, { id: 'c', symbol: 'HYG', state: 'resolved', payload }]} onCitation={jest.fn()} />);
  expect(screen.getByRole('region', { name: 'Research since this snapshot' })).toHaveTextContent('IGV');
  expect(screen.queryByText(/UNHELD|Current weight/)).not.toBeInTheDocument();
  expect(screen.getByText(/current holding needs verification/)).toBeInTheDocument();
});

test('verified current holdings with missing sizing inputs remain a sizing verification gap', () => {
  const payload = { publicationTime: '2026-09-05T14:30:00Z', holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(), event: { qualityStatus: 'validated', eventType: 'trend_signal', signalValue: 'NEUTRAL' }, signalField: 'trend' };
  render(<PortfolioResearchUpdates brief={brief()} findings={[{ id: 'a', symbol: 'IGV', state: 'pending verification', action: 'signal change', payload }]} onCitation={jest.fn()} />);
  expect(screen.getByText('Rule comparison needs additional verified inputs.')).toBeInTheDocument();
  expect(screen.queryByText(/current holding needs verification/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Current weight/)).not.toBeInTheDocument();
});


test('loading, partial, ready and rejected captures keep account sections and columns in the same slots', () => {
  const base = { id: 'stable-review', created_at: asOf, state: 'reviewing' };
  const { rerender } = render(<AnalystPortfolioBrief message={base} />);
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  const exposure = screen.getByRole('region', { name: 'Exposure and risk' });
  const exceptions = screen.getByRole('region', { name: 'Action required' });
  const exposureRows = within(exposure).getAllByRole('row');
  const exposureColumns = within(exposure).getAllByRole('columnheader');
  const sectionOrder = [...report.querySelectorAll('.portfolio-review-section')].map(section => section.getAttribute('aria-label'));
  expect(exposure).toHaveTextContent('Loading…');
  expect(exceptions).toHaveTextContent('Loading…');
  expect(exposure).not.toHaveTextContent('$');
  expect(report).toHaveAttribute('aria-busy', 'true');
  const partial = { ...brief(), available: false, dailyRollup: { version: 1, sections: [{ id: 'market-drivers', title: "Today's market drivers", blocks: [{ type: 'paragraph', text: 'Captured partial research.' }] }] } };
  rerender(<AnalystPortfolioBrief message={{ ...base, portfolioBrief: partial }} />);
  expect(screen.getByRole('article', { name: 'Portfolio Review summary' })).toBe(report);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toBe(exposure);
  expect(screen.getByRole('region', { name: 'Action required' })).toBe(exceptions);
  expect(screen.queryByText('$210,429')).not.toBeInTheDocument();
  expect(screen.queryByRole('row', { name: /IGV/ })).not.toBeInTheDocument();
  expect(screen.getByText('Captured partial research.')).toBeVisible();
  const ready = { ...brief(), dailyRollup: partial.dailyRollup };
  rerender(<AnalystPortfolioBrief message={{ ...base, state: 'complete', portfolioBrief: ready }} />);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toBe(exposure);
  expect(screen.getByRole('region', { name: 'Action required' })).toBe(exceptions);
  expect(within(exposure).getAllByRole('row')).toEqual(exposureRows);
  expect(within(exposure).getAllByRole('columnheader')).toEqual(exposureColumns);
  expect(screen.getByText('$210,429')).toBeVisible();
  rerender(<AnalystPortfolioBrief message={{ ...base, state: 'failed', portfolioBrief: { ...ready, available: false } }} />);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toBe(exposure);
  expect(screen.getByRole('region', { name: 'Action required' })).toBe(exceptions);
  expect(exceptions).toHaveTextContent('Unavailable');
  expect(screen.queryByText('$210,429')).not.toBeInTheDocument();
  expect(screen.queryByRole('row', { name: /IGV/ })).not.toBeInTheDocument();
  expect([...report.querySelectorAll('.portfolio-review-section')].map(section => section.getAttribute('aria-label'))).toEqual(sectionOrder);
  for (const section of [exposure, exceptions]) {
    expect(section).toHaveClass('portfolio-review-section');
    expect(section.querySelector('.portfolio-review-section-body')).toBeInTheDocument();
  }
});

test('a failure after a published partial revision keeps that report in place, stops loading and adds one status line', () => {
  const status = 'Review interrupted: the server deadline passed before every source finished. Refresh to retry with fresh evidence.';
  const partial = { ...brief(), dailyRollup: { version: 1, sections: [{ id: 'market-drivers', title: "Today's market drivers", blocks: [{ type: 'paragraph', text: 'Captured partial research.' }] }] } };
  const base = { id: 'partial-review', created_at: asOf, state: 'reviewing', reviewState: 'running', portfolioBrief: partial };
  const { rerender } = render(<AnalystPortfolioBrief message={base} />);
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  expect(report).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  rerender(<AnalystPortfolioBrief message={{ ...base, state: 'failed', reviewState: 'failed', text: '', reviewStatusLine: status }} />);
  expect(screen.getByRole('article', { name: 'Portfolio Review summary' })).toBe(report);
  expect(report).not.toHaveAttribute('aria-busy');
  expect(report).not.toHaveTextContent('Loading…');
  expect(screen.getByText('Captured partial research.')).toBeVisible();
  expect(screen.getByText('$210,429')).toBeVisible();
  expect(screen.getByRole('note')).toHaveTextContent(status);
  expect(report.lastElementChild).toBe(screen.getByRole('note'));
});

test('the launch and deferred-history placeholder keeps the full report without financial values', () => {
  render(<PortfolioReviewPlaceholder message={{ id: 'deferred-post', created_at: asOf }} deferred historical />);
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  expect(report).toHaveClass('analyst-captured-report-placeholder', 'analyst-historical-report');
  expect(report).toHaveAttribute('data-message-id', 'deferred-post');
  expect(report.querySelectorAll('.portfolio-review-section')).toHaveLength(14);
  expect(report).not.toHaveTextContent('$');
  expect(screen.getByRole('table', { name: 'Portfolio exposure' })).toBeVisible();
  expect(screen.getByRole('table', { name: 'Action required' })).toHaveTextContent('Loading…');
  expect(screen.getByRole('table', { name: 'Corrections' })).toHaveTextContent('Loading…');
});

test('Portfolio Review sections use content height and centered titles with datelines beneath in loading, unavailable and saved captures', () => {
  const style = document.createElement('style');
  style.textContent = ['AnalystPortfolioBrief.css', 'AnalystDailyRollup.css', 'PortfolioReviewDateline.css'].map(filename => {
    const css = require('postcss').parse(require('fs').readFileSync(require('path').join(__dirname, filename), 'utf8'));
    css.walkAtRules(rule => rule.remove());
    return css.toString();
  }).join('\n');
  document.head.append(style);
  try {
    const { rerender } = render(<PortfolioReviewPlaceholder message={{ id: 'compact-review', created_at: asOf }} />);
    const assertCompact = () => {
      const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
      const exposureTable = screen.getByRole('table', { name: 'Portfolio exposure' });
      expect(screen.queryByRole('table', { name: 'Exposure changes since previous close' })).not.toBeInTheDocument();
      expect(exposureTable.querySelectorAll('col')).toHaveLength(5);
      expect(within(exposureTable).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Gross', 'Long', 'Short', 'Net']);
      report.querySelectorAll('.portfolio-review-section').forEach(section => {
        expect(window.getComputedStyle(section).minHeight).toBe('0');
        expect(window.getComputedStyle(section).height).toBe('auto');
        expect(window.getComputedStyle(section).display).toBe('flex');
        expect(window.getComputedStyle(section).flexDirection).toBe('column');
        expect(window.getComputedStyle(section).alignItems).toBe('center');
        expect(window.getComputedStyle(section).overflow).toBe('visible');
        const dates = section.querySelector('.portfolio-review-dateline');
        expect(window.getComputedStyle(dates).textAlign).toBe('center');
        expect(dates.previousElementSibling.tagName).toBe('H2');
        expect(window.getComputedStyle(dates).height).not.toBe('18px');
      });
      expect(report.querySelector('.portfolio-review-section-controls')).toBeNull();
      report.querySelectorAll('.portfolio-review-section-state').forEach(state => expect(state.textContent).not.toBe(''));
      const emptyPosition = report.querySelector('.portfolio-position-placeholder td');
      // An empty-positions placeholder, when shown, must not reserve blank report height.
      expect(emptyPosition ? window.getComputedStyle(emptyPosition).height : 'auto').not.toBe('300px');
    };
    assertCompact();
    rerender(<PortfolioReviewPlaceholder message={{ id: 'compact-review', created_at: asOf }} loading={false} deferred historical />);
    assertCompact();
    rerender(<AnalystPortfolioBrief historical message={{ id: 'compact-review', portfolioBrief: { ...brief(), dailyRollup: {
      version: 1, sections: [{ id: 'signal-strength', title: 'Signal Strength', blocks: [] }],
    } } }} />);
    assertCompact();
    expect(screen.getByRole('region', { name: 'Signal Strength' })).toHaveTextContent('Unavailable');
  } finally { style.remove(); }
});


test.each([[5, 5], [6, 3], [3, 7], [0, 6]])('correction disclosure caps each held side independently with %s Long and %s Short', (longCount, shortCount) => {
  const data = brief();
  data.holdings = [['LONG', longCount], ['SHORT', shortCount]].flatMap(([heldSide, count]) =>
    Array.from({ length: count }, (_, index) => sizedRow(`${heldSide}-${index}`, {
      heldSide, trade: heldSide === 'LONG' ? 'BULLISH' : 'BEARISH', trend: heldSide === 'LONG' ? 'BULLISH' : 'BEARISH',
      weightPct: heldSide === 'LONG' ? 7 + index : 1.5 - index / 10,
    })));
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} />);
  const table = screen.getByRole('table', { name: 'Corrections' });
  expect(table.querySelectorAll('.portfolio-position-row')).toHaveLength(Math.min(5, longCount) + Math.min(5, shortCount));
  const hasMore = longCount > 5 || shortCount > 5;
  const button = screen.queryByRole('button', { name: `Show all ${longCount + shortCount} corrections` });
  expect(Boolean(button)).toBe(hasMore);
});

const inboxAlert = (symbol, quantity, rows, extra = {}) => ({ id: `attention:portfolio:${symbol}`, attentionVersion: 1, symbol, state: 'open', unread: 1,
  kind: 'portfolio', priority: 0, severity: 'action-required', quantity, holdingsVerified: true, holdingsVerifiedAt: asOf,
  currentHolding: { weightPct: quantity < 0 ? -2 : 2 }, presentation: { subject: symbol, date: '2026-09-04', rows: [
    { label: 'Current position', text: quantity < 0 ? 'Short' : 'Long' }, ...rows,
  ], sourceLinks: [{ label: 'Signal Strength', citation: { id: `ss-${symbol}`, title: `Signal Strength: ${symbol}` } }] }, ...extra });

test('every red Inbox alert on a held position has an Action required row, sizing stays in Corrections', () => {
  const onCitation = jest.fn();
  const data = brief();
  data.holdings = [sizedRow('EFX', { heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: -1 }), sizedRow('OVER', { weightPct: 7 })];
  const findings = [
    inboxAlert('EFX', -40, [{ label: 'Action', text: 'Signal Strength Removed Short Sep 4 vs your Short → exit Short' }]),
    // Opened after this capture: the alert still gets its row.
    inboxAlert('GIII', 100, [{ label: 'Action', text: 'ETF Pro Sell Sep 4 → review Long' }]),
    inboxAlert('READ', 100, [{ label: 'Action', text: 'Removed → exit Long' }], { unread: 0 }),
    inboxAlert('BLUE', 100, [{ label: 'Action', text: 'Above MAX' }], { severity: undefined }),
  ];
  render(<AnalystPortfolioBrief message={{ portfolioBrief: data }} inboxFindings={findings} onCitation={onCitation} />);
  const urgent = screen.getByRole('table', { name: 'Action required' });
  expect([...urgent.querySelectorAll('.portfolio-position-row th strong')].map(cell => cell.textContent)).toEqual(['GIII', 'EFX']);
  // Without a Trade or Trend break, Action required answers to its product calls alone.
  expect(within(urgent).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
    'Ticker', 'Security', 'T/T/T', '%', 'M/M/S', 'Product',
  ]);
  expect(urgent.querySelector('.portfolio-position-review')).toBeNull();
  expect(within(urgent).getByRole('row', { name: /EFX/ })).not.toHaveTextContent('Underweight');
  const corrections = screen.getByRole('table', { name: 'Corrections' });
  expect(corrections).toHaveTextContent('OVER');
  expect(corrections).not.toHaveTextContent(/EFX|GIII|READ|BLUE/);
  expect(urgent).not.toHaveTextContent(/READ|BLUE/);
});

test('a saved historical report never takes live Inbox alerts', () => {
  const data = brief();
  data.holdings = [sizedRow('CALM')];
  render(<AnalystPortfolioBrief historical message={{ portfolioBrief: data }} inboxFindings={[inboxAlert('EFX', -40, [{ label: 'Action', text: 'Removed → exit Short' }])]} />);
  expect(screen.getByRole('table', { name: 'Action required' })).not.toHaveTextContent('EFX');
});
