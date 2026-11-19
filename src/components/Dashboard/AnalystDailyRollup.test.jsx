import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystDailyRollup from './AnalystDailyRollup';
import usePortfolioSecurityNames from '../../hooks/usePortfolioSecurityNames';
import hedgaiBaseline from '../../../data/research/hedgai/2026-09-28-baseline.json';

const wholeText = expected => (_, element) => element.textContent === expected
  && !Array.from(element.children).some(child => child.textContent === expected);

jest.mock('../../hooks/usePortfolioSecurityNames', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

const source = { id: 'early', product: 'early-look', title: 'The Great Finding Out', publicationDate: '2026-09-18' };

test('research comparisons retain the latest publication at left and the full source interval at right', () => {
  const citations = [
    { id: 'first-range', product: 'risk-ranges', publicationDate: '2026-08-31' },
    { id: 'middle-range', product: 'risk-ranges', publicationDate: '2026-09-03' },
    { id: 'latest-range', product: 'risk-ranges', publishedAt: '2026-09-04T14:30:00Z', publicationDate: '2026-09-04' },
  ];
  const cells = ['SPY', 'SPDR S&P 500 ETF Trust', 'Bullish', 'Neutral'];
  const data = { version: 1, citations, sections: [{ id: 'risk-ranges', title: 'Trend & range changes', citationIds: ['middle-range'], blocks: [{
    type: 'table', columns: ['Ticker', 'Security', 'Prior Trend', 'Trend'], rows: [{ cells, citationIds: ['first-range', 'latest-range'] }],
  }] }] };
  const captured = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} holdingsAsOf="2026-09-30T17:53:10Z" />);
  const region = screen.getByRole('region', { name: 'Trend/Ranges/Coverage/Outbucket' });
  const dateline = region.querySelector('.portfolio-review-dateline');
  expect(dateline).toHaveClass('has-period');
  expect(dateline.querySelector('.portfolio-review-primary-date')).toHaveTextContent('Sep 4, 2026 07:30 PDT');
  expect(dateline.querySelector('.portfolio-review-period')).toHaveTextContent('Period: Aug 31, 2026 – Sep 4, 2026');
  expect(dateline).not.toHaveTextContent(/Sep 30|·|Compared with/);
  expect(within(region).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['SPY', 'SPDR S&P 500 ETF Trust', 'Bullish → Neutral']);
  expect(JSON.stringify(data)).toBe(captured);
});

test('statistics and model datelines keep their meanings without becoming publication periods', () => {
  const positioning = 'Positioning: Sep 30, 2026 10:53 PDT';
  const tickDates = `${positioning} · Statistics: Sep 28, 2026`;
  const modelDates = `${positioning} · Statistics: Sep 25, 2026 · 252-session model · 72% of gross exposure modeled`;
  const data = { version: 1, sections: [
    { id: 'hedgai-signals', title: 'HedgAI Signals', blocks: [
      { type: 'paragraph', text: tickDates }, { type: 'paragraph', text: 'Captured Tick research.' },
    ] },
    { id: 'factor-exposure', title: 'Factor exposure', portfolioObservedAt: '2026-09-30T17:53:10Z', asOf: '2026-09-25', blocks: [
      { type: 'paragraph', text: 'Portfolio captured Sep 30, 2026 10:53 PDT · 252-session model through Sep 25, 2026 · 72% of gross exposure modeled' },
      { type: 'paragraph', text: 'Captured factor research.' },
    ] },
  ] };
  const captured = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} holdingsAsOf="2026-10-01T17:00:00Z" />);
  for (const [title, expected] of [['Tick', tickDates], ['Factor exposure', modelDates]]) {
    const region = screen.getByRole('region', { name: title });
    const dateline = region.querySelector('.portfolio-review-dateline');
    expect(dateline).toHaveTextContent(expected.replace('Positioning: ', ''));
    expect(dateline).toHaveAttribute('title', expected);
    expect(dateline).not.toHaveClass('has-period');
    expect(region.querySelector('.portfolio-review-period')).toBeNull();
    expect(dateline).not.toHaveTextContent('Oct 1');
  }
  expect(JSON.stringify(data)).toBe(captured);
});

test.each(['Report: Sep 28, 2026', 'Published Sep 28, 2026 · Data as of Sep 25, 2026'])(
  'market structure separates publication and data dates in saved and new reports: %s', publication => {
    const citation = { id: 'structure', product: 'market-structure', title: 'Market Situation Report', publicationDate: '2026-09-28' };
    const data = { version: 1, citations: [citation], sections: [{ id: 'market-structure', title: 'Market structure & flows', blocks: [
      { type: 'paragraph', text: publication, citationIds: [citation.id] },
      { type: 'table', columns: ['SPX metric', 'Reading', 'As of'], rows: [
        { cells: ['Gamma throttle', '6.82', 'Sep 25, 2026'], citationIds: [citation.id], provenance: { publicationDate: '2026-09-28', chartDate: '2026-09-25' } },
        { cells: ['10-day realized volatility', '10.98', 'Sep 25, 2026'], citationIds: [citation.id] },
      ] },
    ] }] };
    const captured = JSON.stringify(data);
    const onCitation = jest.fn();
    render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
    expect(screen.getByText(wholeText('Sep 28, 2026 · Data as of: Sep 25, 2026'))).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Data as of' })).toBeVisible();
    expect(screen.getAllByRole('cell', { name: 'Sep 25, 2026' })).toHaveLength(2);
    expect(screen.getByRole('cell', { name: '6.82' })).toBeVisible();
    expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
    expect(JSON.stringify(data)).toBe(captured);
  },
);

test.each(['Sep 24, 2026', '—'])('market structure does not claim a shared data date when another row is %s', otherDate => {
  render(<AnalystDailyRollup rollup={{ version: 1, sections: [{ id: 'market-structure', title: 'Market structure & flows', blocks: [
    { type: 'paragraph', text: 'Report: Sep 28, 2026' },
    { type: 'table', columns: ['SPX metric', 'Reading', 'As of'], rows: [
      { cells: ['Gamma throttle', '6.82', 'Sep 25, 2026'] },
      { cells: ['Zero-gamma level', '7,659', otherDate] },
    ] },
  ] }] }} />);
  expect(screen.getByText(wholeText('Sep 28, 2026'))).toBeVisible();
  expect(screen.queryByText(/· Data as of/)).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Sep 25, 2026' })).toBeVisible();
  expect(screen.getByRole('cell', { name: otherDate })).toBeVisible();
});

test('research security tables resolve missing descriptive names while captured names stay immutable', () => {
  usePortfolioSecurityNames.mockReturnValueOnce({
    DBMF: { name: 'iMGP DBi Managed Futures Strategy ETF', source: 'Verified security catalog' },
    MSFT: { name: 'Current Microsoft name', source: 'Verified security catalog' },
  });
  const data = { version: 1, sections: [
    { id: 'company-catalysts', title: 'Company catalysts & sector research', blocks: [{ type: 'table', columns: ['Ticker', 'Security', 'Position', 'Product', 'Reading', 'Why'], rows: [
      { cells: ['DBMF', '—', 'Long 2.20%', 'The Call', 'Bullish', 'Supports the captured Long.'] },
      { cells: ['MSFT', 'Captured Microsoft name', 'Long 3.18%', 'The Call', 'Bullish', 'Supports the captured Long.'] },
    ] }] },
    { id: 'other', title: 'Other research', blocks: [{ type: 'table', columns: ['Ticker', 'Security', 'Reading'], rows: [{ cells: ['DBMF', '—', 'Wait'] }] }] },
  ] };
  const before = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  expect(usePortfolioSecurityNames).toHaveBeenLastCalledWith([
    { holding: 'DBMF', securityName: '' }, { holding: 'MSFT', securityName: 'Captured Microsoft name' }, { holding: 'DBMF', securityName: '' },
  ]);
  const region = screen.getByRole('region', { name: 'Company catalysts & sector research' });
  expect(within(region).getByText('iMGP DBi Managed Futures Strategy ETF').closest('.analyst-security-name')).toHaveAttribute('title', 'iMGP DBi Managed Futures Strategy ETF · Current security name · Verified security catalog');
  expect(within(region).getByText('Captured Microsoft name').closest('.analyst-security-name')).toHaveAttribute('title', 'Captured Microsoft name');
  expect(screen.queryByText('Current Microsoft name')).not.toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Other research' })).getByText('iMGP DBi Managed Futures Strategy ETF')).toBeVisible();
  expect(JSON.stringify(data)).toBe(before);
});

test('combined HedgAI table keeps ten named readings visible, groups separate, and the complete dated book expandable', () => {
  const visible = [
    ['QQQ', 'Nasdaq-100', 'Short', '—', 'Short 48.0%', 'Short excluded'],
    ['GLD', 'Gold', 'Wait', '—', 'Long 63.6%', 'Await Buy'],
    ['XLE', 'Energy', 'Long', '—', 'Long 87.5%', 'Included'],
    ['UJB', 'High-yield credit', 'Long', '—', 'Long 81.2%', 'Included'],
    ['SLX', 'Steel', 'Short', '—', 'Short 66.7%', 'Included'],
    ['SPY', 'S&P 500', 'Long', '—', 'Long 60.0%', 'Included'],
    ['PALL', 'Palladium', 'Wait', 'Closed Long', 'Long 63.2%', 'Closed'],
    ['XLY', 'Consumer discretionary', 'Long', '—', 'Long 68.0%', 'Included'],
    ['IWM', 'Russell 2000', 'Long', '—', 'Long 60.0%', 'Included'],
    ['SLV', 'Silver', 'Wait', '—', 'Long 64.7%', 'Await Buy'],
  ];
  const data = { version: 1, sections: [{ id: 'hedgai-signals', title: 'HedgAI Signals', blocks: [
    { type: 'table', groupRows: true, columns: ['Ticker', 'Security', 'Now', 'Today', 'History', '60% filter'],
      rows: visible.map((cells, index) => ({ cells, group: index < 5 ? 'Top AI Signals' : 'Need More Data AI Signals',
        cellTitles: ['', cells[0] === 'UJB' ? 'High Yield Corp Bond $HYG · Source-listed ticker UJB' : cells[1], '',
          cells[0] === 'PALL' ? 'Sep 28, 2026 08:43 ET · Closed Long: Palladium' : '',
          cells[0] === 'GLD' ? 'Long 63.6% · 11 signals · W/L 1.28 · Sep 28, 2026' : '', ''] })) },
    { type: 'table', groupRows: true, disclosure: 'Full HedgAI book · 47 securities',
      columns: ['Ticker', 'Security', 'Position'], rows: hedgaiBaseline.rows.map(row => ({
        group: row.group === 'top' ? 'Top AI Signals' : 'Need More Data AI Signals',
        cells: [row.ticker, row.sourceLabel, row.position],
      })) },
  ] }] };
  const saved = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  const region = screen.getByRole('region', { name: 'Tick' });
  const table = region.querySelector('.analyst-hedgai-summary');
  expect(table).toHaveClass('analyst-hedgai-summary');
  expect(within(table).getByRole('columnheader', { name: 'Tick' })).toBeVisible();
  expect(table.querySelectorAll('tbody tr:not(.analyst-research-group)')).toHaveLength(10);
  expect(table.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(2);
  for (const security of ['Nasdaq-100', 'Gold', 'Palladium', 'S&P 500', 'Consumer discretionary']) {
    expect(within(table).getByText(security)).toBeVisible();
  }
  expect(within(table).getByText('High-yield credit').closest('.analyst-security-name')).toHaveAttribute('title', 'High Yield Corp Bond $HYG · Source-listed ticker UJB');
  expect(within(table).getByText('Gold').closest('tr')).toHaveTextContent('Wait');
  expect(within(table).getByText('Gold').closest('tr').querySelector('td[title*="11 signals"]')).toBeInTheDocument();
  expect(within(table).getByText('Nasdaq-100').closest('tr')).toHaveTextContent('Short excluded');
  within(within(table).getByText('Nasdaq-100').closest('tr')).getAllByText('Short').forEach(word => expect(word).toHaveClass('analyst-process--negative'));
  expect(within(table).getByText('Palladium').closest('tr')).toHaveTextContent('WaitClosed Long');
  within(table).getAllByText('Wait').forEach(word => expect(word).toHaveClass('analyst-process--muted'));
  const disclosure = within(region).getByText(wholeText('Full Tick book · 47 securities')).closest('details');
  expect(disclosure).not.toHaveAttribute('open');
  expect(within(disclosure).queryByText('META')).not.toBeInTheDocument();
  expect(disclosure.querySelector('table')).toBeNull();
  fireEvent.click(disclosure.querySelector('summary'));
  expect(disclosure).toHaveAttribute('open');
  expect(within(disclosure).getByText('META')).toBeVisible();
  expect(disclosure.querySelectorAll('tbody tr:not(.analyst-research-group)')).toHaveLength(47);
  expect(JSON.stringify(data)).toBe(saved);
});

test('HedgAI keeps six active rows above a closed 47-security disclosure with both source groups and linked evidence', () => {
  const citation = { id: 'hedgai-image', product: 'hedgai-signals', productLabel: 'HedgAI Signals',
    title: 'Reviewed HedgAI publication', publicationDate: '2026-09-28', sourceUri: '/api/research/hedgai/source/hedgai-image' };
  const activeTickers = new Set(['XLE', 'SLX', 'UJB', 'SPY', 'IWM', 'XLY']);
  const rows = hedgaiBaseline.rows;
  const data = { version: 1, citations: [citation], sections: [{ id: 'hedgai-signals', title: 'HedgAI Signals',
    citationIds: [citation.id], blocks: [
      { type: 'table', columns: ['Ticker', 'Security', 'HedgAI'], rows: rows.filter(row => activeTickers.has(row.ticker))
        .map(row => ({ cells: [row.ticker, row.sourceLabel, 'Bullish'], citationIds: [citation.id] })) },
      { type: 'paragraph', text: 'Shorts Closed: Platinum. Remaining Long META Up 13%.', citationIds: [citation.id] },
      { type: 'table', disclosure: `Full HedgAI book · ${rows.length} securities`,
        columns: ['Ticker', 'Security', 'Group', 'Position', 'Bull batting', 'Bear batting'], rows: rows.map(row => ({
          cells: [row.ticker, row.sourceLabel, row.group === 'top' ? 'Top' : 'Need more data', row.position,
            `${(row.metrics.buy.battingAverage * 100).toFixed(1)}%`, `${(row.metrics.short.battingAverage * 100).toFixed(1)}%`], citationIds: [citation.id],
        })) },
    ] }] };
  const onCitation = jest.fn();
  const original = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const region = screen.getByRole('region', { name: 'Tick' });
  const disclosure = within(region).getByText(wholeText('Full Tick book · 47 securities')).closest('details');
  expect(disclosure).not.toHaveAttribute('open');
  expect(disclosure.querySelectorAll('tbody tr')).toHaveLength(0);
  expect(region.querySelector('table tbody').querySelectorAll('tr')).toHaveLength(6);
  within(region).getAllByText('Bullish').forEach(word => expect(word).toHaveClass('analyst-process--positive'));
  expect(within(region).getByText('Long')).toHaveClass('analyst-process--positive');
  fireEvent.click(disclosure.querySelector('summary'));
  expect(disclosure.querySelectorAll('tbody tr')).toHaveLength(47);
  expect(disclosure).toHaveTextContent('Top');
  expect(disclosure).toHaveTextContent('Need more data');
  expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});
const rollup = () => ({ version: 1, citations: [source], sections: [{
  id: 'macro', title: 'Macro outlook', citationIds: ['early'], blocks: [
    { type: 'paragraph', text: 'Quad 4 is a forecast scenario. Long position remains Bullish; short-term growth is Neutral.', citationIds: ['early'] },
    { type: 'table', columns: ['Asset', 'Trade', 'Trend'], rows: [{ cells: ['SPX', 'Bullish', 'Bearish'], citationIds: ['early'] }] },
  ],
}] });

test('all security tables share compact identity columns and blue tickers without changing metric tables', () => {
  const securityName = 'Brent Crude Oil Continuous Contract';
  render(<AnalystDailyRollup rollup={{ version: 1, sections: [{ id: 'positions', title: 'Positioning', blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Positioning'], rows: [{ cells: ['BRENT', securityName, 'Long'] }] },
    { type: 'table', columns: ['Ticker', 'Security', 'Research positioning change'], rows: [{ cells: ['BRENT', securityName, 'Added to Long mentions'] }] },
    { type: 'table', columns: ['Signal', 'Published reading'], rows: [{ cells: ['SPX Gamma', 'Neutral'] }] },
  ] }] }} />);
  const tables = screen.getAllByRole('table');
  for (const table of tables.slice(0, 2)) {
    expect(table).toHaveClass('analyst-security-table');
    expect(within(table).getByText('BRENT')).toHaveClass('analyst-process--ticker');
    expect(within(table).getByText(securityName).closest('.analyst-security-name')).toHaveAttribute('title', securityName);
    expect(table.querySelectorAll('col')).toHaveLength(3);
  }
  expect(tables[2]).not.toHaveClass('analyst-security-table');
  expect(screen.getByRole('heading', { name: 'Positioning' })).toHaveClass('analyst-portfolio-title');
});

test.each([
  { id: 'macro-show', title: 'Macro Show' },
  { title: 'Macro Show' },
  { id: 'company-catalysts', title: 'Company catalysts & sector research' },
  { title: 'Company catalysts & sector research' },
  { id: 'the-call', title: 'The Call' },
  { title: 'The Call' },
])('research securities are compact directional ticker lists for $title', section => {
  const macroSource = { id: 'macro-source', product: 'macro-show', title: 'Daily Macro Show', publicationDate: '2026-09-21' };
  const data = { version: 1, citations: [macroSource], sections: [{ ...section, blocks: [
    { type: 'paragraph', text: 'Rates are the focus this morning.', citationIds: [macroSource.id] },
    { type: 'table', columns: ['Ticker', 'Security', 'Positioning'], rows: [
      { cells: ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'Short'], citationIds: [macroSource.id] },
      { cells: ['SPY', 'SPDR S&P 500 ETF Trust', 'Long'], citationIds: [macroSource.id] },
      { cells: ['CORN', 'Teucrium Corn Fund', 'Long'], citationIds: [macroSource.id] },
      { cells: ['SPY', 'SPDR S&P 500 ETF Trust', 'Long'], citationIds: [macroSource.id] },
      { cells: ['XLF', 'Financial Select Sector SPDR Fund', 'Neutral'], citationIds: [macroSource.id] },
      { cells: ['SPY', 'SPDR S&P 500 ETF Trust', 'Short'], citationIds: [macroSource.id] },
    ] },
  ] }] };
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const region = screen.getByRole('region', { name: section.title });
  expect(within(region).queryByRole('table')).not.toBeInTheDocument();
  expect([...region.querySelectorAll('p:not(.portfolio-review-dateline)')].map(node => node.textContent)).toEqual([
    'Rates are the focus this morning.', 'Long: SPY, CORN', 'Short: TLT, SPY', 'Neutral: XLF',
  ]);
  expect(within(region).getByText('Long')).toHaveClass('analyst-process--positive');
  expect(within(region).getByText('Short')).toHaveClass('analyst-process--negative');
  expect(within(region).getByText('Neutral')).toHaveClass('analyst-process--muted');
  ['SPY', 'CORN', 'TLT', 'XLF'].forEach(ticker => {
    within(region).getAllByText(ticker).forEach(node => expect(node).toHaveClass('analyst-process--ticker'));
  });
  expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test.each([
  { id: 'macro-show', title: 'Macro Show' },
  { title: 'Macro Show' },
])('Macro Show positioning changes group added and removed tickers with original source evidence for $title', section => {
  const macroSource = { id: 'macro-source', product: 'macro-show', title: 'Daily Macro Show', publicationDate: '2026-09-21' };
  const changes = [
    ['XLE', 'Energy Select Sector SPDR Fund', 'No longer listed Long'],
    ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'Added to Short mentions'],
    ['SPY', 'SPDR S&P 500 ETF Trust', 'Added to Long mentions'],
    ['CORN', 'Teucrium Corn Fund', 'Added to Long mentions'],
    ['SPY', 'SPDR S&P 500 ETF Trust', 'Added to Long mentions'],
    ['OIH', 'VanEck Oil Services ETF', 'No longer listed Short'],
    ['XLF', 'Financial Select Sector SPDR Fund', 'Added to Neutral mentions'],
    ['GLD', 'SPDR Gold Shares', 'No longer listed Neutral'],
  ];
  const data = { version: 1, citations: [macroSource], sections: [{ ...section, blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Research positioning change'], rows: changes.map(cells => ({ cells, citationIds: [macroSource.id] })) },
  ] }] };
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const region = screen.getByRole('region', { name: section.title });
  expect(within(region).queryByRole('table')).not.toBeInTheDocument();
  expect([...region.querySelectorAll('p:not(.portfolio-review-dateline)')].map(node => node.textContent)).toEqual([
    'Added Long: SPY, CORN', 'Added Short: TLT', 'Added Neutral: XLF',
    'Removed Long: XLE', 'Removed Short: OIH', 'Removed Neutral: GLD',
  ]);
  ['Long', 'Short', 'Neutral'].forEach((direction, index) => {
    within(region).getAllByText(direction).forEach(node => expect(node).toHaveClass(`analyst-process--${['positive', 'negative', 'muted'][index]}`));
  });
  [
    ['Added Long:', 'Added', 'positive'],
    ['Added Short:', 'Added', 'negative'],
    ['Added Neutral:', 'Added', 'muted'],
    ['Removed Long:', 'Removed', 'positive'],
    ['Removed Short:', 'Removed', 'negative'],
    ['Removed Neutral:', 'Removed', 'muted'],
  ].forEach(([prefix, action, tone]) => {
    const line = [...region.querySelectorAll('p:not(.portfolio-review-dateline)')].find(node => node.textContent.startsWith(prefix));
    expect(within(line).getByText(action)).toHaveClass(`analyst-process--${tone}`);
  });
  changes.forEach(([ticker, security]) => {
    expect(within(region).getByText(ticker)).toHaveClass('analyst-process--ticker');
    expect(within(region).getByTitle(security)).toHaveTextContent(ticker);
  });
  expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test('Macro Show change lists preserve reversals and unrecognized source labels without recasting them as additions', () => {
  const data = { version: 1, sections: [{ id: 'macro-show', title: 'Macro Show', blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Research positioning change'], rows: [
      { cells: ['SPY', 'SPDR S&P 500 ETF Trust', 'Long → Short'] },
      { cells: ['XLF', 'Financial Select Sector SPDR Fund', 'Long → Short'] },
      { cells: ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'Short → Long'] },
      { cells: ['CORN', 'Teucrium Corn Fund', 'Retained pending review'] },
    ] },
  ] }] };
  const original = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  const region = screen.getByRole('region', { name: 'Macro Show' });
  expect(within(region).queryByRole('table')).not.toBeInTheDocument();
  expect([...region.querySelectorAll('p:not(.portfolio-review-dateline)')].map(node => node.textContent)).toEqual([
    'Long → Short: SPY, XLF', 'Short → Long: TLT', 'Retained pending review: CORN',
  ]);
  expect(region).not.toHaveTextContent('Added');
  expect(region).not.toHaveTextContent('Removed');
  within(region).getAllByText('Long').forEach(node => expect(node).toHaveClass('analyst-process--positive'));
  within(region).getAllByText('Short').forEach(node => expect(node).toHaveClass('analyst-process--negative'));
  expect(within(region).getByText('CORN')).toHaveClass('analyst-process--ticker');
  expect(JSON.stringify(data)).toBe(original);
});

test('Macro Show change lists preserve unrelated positioning and company research change tables', () => {
  const data = { version: 1, sections: [
    { id: 'macro-show', title: 'Macro Show', blocks: [
      { type: 'table', columns: ['Ticker', 'Security', 'Research positioning change'], rows: [{ cells: ['SPY', 'SPDR S&P 500 ETF Trust', 'Added to Long mentions'] }] },
    ] },
    { id: 'company-catalysts', title: 'Company catalysts & sector research', blocks: [
      { type: 'table', columns: ['Ticker', 'Security', 'Research positioning change'], rows: [{ cells: ['CORN', 'Teucrium Corn Fund', 'Added to Long mentions'] }] },
    ] },
    { id: 'unrelated-positions', title: 'Positioning', blocks: [
      { type: 'table', columns: ['Ticker', 'Security', 'Positioning'], rows: [{ cells: ['TLT', 'iShares 20+ Year Treasury Bond ETF', 'Short'] }] },
    ] },
  ] };
  render(<AnalystDailyRollup rollup={data} />);
  const macro = screen.getByRole('region', { name: 'Macro Show' });
  const catalysts = screen.getByRole('region', { name: 'Company catalysts & sector research' });
  const positioning = screen.getByRole('region', { name: 'Positioning' });
  expect(within(macro).queryByRole('table')).not.toBeInTheDocument();
  expect(macro.querySelector('p:not(.portfolio-review-dateline)')).toHaveTextContent('Added Long: SPY');
  expect(within(catalysts).getByRole('columnheader', { name: 'Research positioning change' })).toBeVisible();
  expect(within(catalysts).getByRole('row', { name: 'CORN Teucrium Corn Fund Added to Long mentions' })).toBeVisible();
  expect(within(positioning).getByRole('columnheader', { name: 'Positioning' })).toBeVisible();
  expect(within(positioning).getByRole('row', { name: 'TLT iShares 20+ Year Treasury Bond ETF Short' })).toBeVisible();
});

test.each(["Today's market drivers", 'Today’s market drivers'])('the three topic titles in %s sit above their unchanged body text', title => {
  const blocks = [
    { type: 'paragraph', title: 'USD', text: 'USD — Bullish TRADE with USD strength.' },
    { type: 'paragraph', text: 'BITCOIN — Long alongside Gold.' },
    { type: 'paragraph', text: 'SPX — Bearish below the level — Neutral at the boundary.' },
  ];
  render(<AnalystDailyRollup rollup={{ version: 1, sections: [{ id: 'market-drivers', title, blocks }] }} />);
  const section = screen.getByRole('region', { name: title });
  const headings = within(section).getAllByRole('heading', { level: 3 });
  expect(headings.map(node => node.textContent)).toEqual(['USD', 'BITCOIN', 'SPX']);
  headings.forEach(heading => {
    expect(heading).toHaveClass('analyst-portfolio-topic');
    expect(heading.nextElementSibling.tagName).toBe('P');
  });
  expect([...section.querySelectorAll('p:not(.portfolio-review-dateline)')].map(node => node.textContent)).toEqual([
    'Bullish TRADE with USD strength.', 'Long alongside Gold.', 'Bearish below the level — Neutral at the boundary.',
  ]);
  expect(within(section).getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(within(section).getByText('Bearish')).toHaveClass('analyst-process--negative');
});

test.each(['metadata', 'legacy'])('%s sector captions occupy their own headings without creating captions for every company paragraph', format => {
  const sectors = [
    ['Consumer Staples', 'Procter & Gamble (PG) remains Bullish on the captured reading.'],
    ['Gaming, Lodging & Leisure', 'Marriott (MAR) remains Long; the outlook is unchanged.'],
    ['Retail', 'Helen of Troy (HELE) remains Bearish after the update.'],
    ['Health Care', 'UnitedHealth (UNH) remains Short in this publication.'],
  ];
  const continuation = 'Deckers (DECK) remains Neutral while the short-term outlook is unchanged.';
  const introduction = 'The sector research remains attached to this captured publication.';
  const untitled = 'This is a complete research sentence. Its second clause — and its original wording — remain together.';
  const blocks = [{ type: 'paragraph', text: introduction, citationIds: [source.id] }];
  sectors.forEach(([title, body]) => {
    blocks.push({ type: 'paragraph', ...(format === 'metadata' ? { title } : {}), text: `${title} — ${body}`, citationIds: [source.id] });
    if (title === 'Retail') blocks.push({ type: 'paragraph', text: continuation, citationIds: [source.id] });
  });
  blocks.push({ type: 'paragraph', text: untitled, citationIds: [source.id] });
  const data = { version: 1, securityTickers: ['PG', 'MAR', 'HELE', 'DECK', 'UNH'], citations: [source], sections: [{ id: 'company-catalysts', title: 'Company catalysts & sector research', blocks }] };
  const captured = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystDailyRollup stableLayout rollup={data} onCitation={onCitation} />);
  const section = screen.getByRole('region', { name: 'Company catalysts & sector research' });
  const body = section.querySelector('.portfolio-review-section-body');
  const headings = within(section).getAllByRole('heading', { level: 3 });
  expect(headings.map(node => node.textContent)).toEqual(sectors.map(([title]) => title));
  headings.forEach((heading, index) => {
    expect(heading).toHaveClass('analyst-portfolio-topic');
    expect(heading.closest('p')).toBeNull();
    expect(heading.nextElementSibling.tagName).toBe('P');
    expect(heading.nextElementSibling).toHaveTextContent(sectors[index][1]);
    expect(heading.nextElementSibling.textContent).toBe(sectors[index][1]);
    expect(heading.parentElement).toHaveClass('analyst-portfolio-topic-block');
    expect(heading.parentElement.style.height).toBe('');
    expect(heading.parentElement.style.overflow).toBe('');
  });
  expect([...body.querySelectorAll('p')].map(paragraph => paragraph.textContent)).toEqual([
    introduction, sectors[0][1], sectors[1][1], sectors[2][1], continuation, sectors[3][1], untitled,
  ]);
  const retail = within(section).getByRole('heading', { level: 3, name: 'Retail' });
  expect(retail.parentElement.nextElementSibling.textContent).toBe(continuation);
  expect(retail.parentElement.nextElementSibling.tagName).toBe('P');
  expect(within(section).queryByRole('heading', { name: /^Deckers|Helen of Troy|Marriott|Procter|UnitedHealth/ })).not.toBeInTheDocument();
  expect(within(section).getByText('Bullish')).toHaveClass('analyst-process--positive');
  expect(within(section).getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(within(section).getByText('Neutral')).toHaveClass('analyst-process--muted');
  ['PG', 'MAR', 'HELE', 'DECK', 'UNH'].forEach(ticker => expect(within(section).getByText(ticker)).toHaveClass('analyst-process--ticker'));
  expect(within(section).queryByText('short-term', { selector: '.analyst-process--negative' })).not.toBeInTheDocument();
  expect(section.style.getPropertyValue('--portfolio-review-section-height')).toBe('');
  expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(captured);
});

test('a captured sector title in metadata appears above body-only text and leaves following company commentary uncaptioned', () => {
  const retail = 'Helen of Troy (HELE) remains Bearish in the captured update.';
  const continuation = 'Deckers (DECK) remains Neutral in the same retail publication.';
  const data = { version: 1, sections: [{ id: 'company-catalysts', title: 'Company catalysts & sector research', blocks: [
    { type: 'paragraph', title: 'Retail', text: retail },
    { type: 'paragraph', text: continuation },
  ] }] };
  const captured = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  const section = screen.getByRole('region', { name: 'Company catalysts & sector research' });
  expect(within(section).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['Retail']);
  const heading = within(section).getByRole('heading', { level: 3, name: 'Retail' });
  expect(heading.nextElementSibling.textContent).toBe(retail);
  expect(heading.parentElement.nextElementSibling.textContent).toBe(continuation);
  expect([...section.querySelectorAll('p:not(.portfolio-review-dateline)')].map(paragraph => paragraph.textContent)).toEqual([retail, continuation]);
  expect(JSON.stringify(data)).toBe(captured);
});

test('research paragraphs and table cells keep directional and Quad semantics', () => {
  render(<AnalystDailyRollup rollup={rollup()} />);
  const section = screen.getByRole('region', { name: 'Macro outlook' });
  expect(within(section).getByText('Quad 4')).toHaveClass('analyst-process--quad-4');
  expect(within(section).getByText('Long')).toHaveClass('analyst-process--positive');
  expect(within(section).getByText('Neutral')).toHaveClass('analyst-process--muted');
  expect(within(section).getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(section.querySelector('p:not(.portfolio-review-dateline)')).toHaveTextContent('short-term growth');
});

test('no section carries a Sources footer because its title already names the product', () => {
  const onCitation = jest.fn();
  const { container } = render(<AnalystDailyRollup rollup={rollup()} onCitation={onCitation} />);
  expect(container.querySelector('.analyst-daily-rollup-citations')).toBeNull();
  expect(screen.queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Source:/ })).not.toBeInTheDocument();
});

test('Signal Strength reads as Changes then Current holdings with a signed Return', () => {
  const data = { version: 1, sections: [{ id: 'signal-strength', title: 'Signal Strength', blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Change'], rows: [
      { cells: ['CP', 'Canadian Pacific Kansas City Limited', 'Added'] },
      { cells: ['BTI', 'British American Tobacco p.l.c.', 'Removed'] },
    ] },
    { type: 'table', columns: ['Ticker', 'Security', 'Days on', 'Since signal'], rows: [
      { cells: ['ELF', 'e.l.f. Beauty Inc.', '134', '52.18%'] },
      { cells: ['XYZ', 'Example Corp', '12', '-3.40%'] },
      { cells: ['FLAT', 'Flat Corp', '2', '0.00%'] },
    ] },
  ] }] };
  const original = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  const [changes, holdings] = within(screen.getByRole('region', { name: 'Signal Strength' })).getAllByRole('table');
  expect(changes.caption).toHaveTextContent('Changes');
  expect(within(changes).getByText('Added')).toHaveClass('analyst-process--positive');
  expect(within(changes).getByText('Removed')).toHaveClass('analyst-process--negative');
  expect(holdings.caption).toHaveTextContent('Current holdings');
  expect(within(holdings).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Ticker', 'Security', 'Days on', 'Return']);
  expect(within(holdings).getByText('52.18%')).toHaveClass('analyst-process--positive');
  expect(within(holdings).getByText('-3.40%')).toHaveClass('analyst-process--negative');
  expect(within(holdings).getByText('0.00%')).not.toHaveClass('analyst-process--positive');
  expect(JSON.stringify(data)).toBe(original);
});

test.each([
  { id: 'risk-ranges', title: 'Trend & range changes' },
  { title: 'Trend & range changes' },
  { id: 'risk-ranges', title: 'Trend/Ranges/Coverage/Outbucket' },
])('risk range section $title gives every comparison a concise table caption', section => {
  const blocks = [
    { type: 'table', columns: ['Ticker', 'Security', 'Prior Trend', 'Trend'], rows: [{ cells: ['VIX', 'Volatility Index', 'Neutral', 'Bearish'] }] },
    { type: 'table', columns: ['Ticker', 'Security', 'Prior range', 'Published range', 'Trend'], rows: [{ cells: ['AAPL', 'Apple Inc.', '321–345', '322–345', 'Bullish'] }] },
    { type: 'table', columns: ['Ticker', 'Security', 'Coverage change'], rows: [{ cells: ['XLE', 'Energy Select Sector SPDR Fund', '+ Risk Ranges'] }] },
    { type: 'table', columns: ['Ticker', 'Security', 'OutBucket Trend', 'Since'], rows: [{ cells: ['OIH', 'VanEck Oil Services ETF', 'Bearish', 'Sep 18'] }] },
  ];
  const data = { version: 1, sections: [{ ...section, blocks }, ...rollup().sections] };
  const original = JSON.stringify(data);
  render(<AnalystDailyRollup rollup={data} />);
  const region = screen.getByRole('region', { name: 'Trend/Ranges/Coverage/Outbucket' });
  expect(within(region).getByRole('heading')).toHaveTextContent('Trend/Ranges/Coverage/Outbucket');
  const captions = ['Trend', 'Ranges', 'Coverage', 'Outbucket'];
  captions.forEach((label, index) => {
    const table = within(region).getByRole('table', { name: label, exact: true });
    expect(table.querySelector('caption')).toHaveTextContent(label);
    expect(table.firstElementChild.tagName).toBe('CAPTION');
    expect(within(table).getAllByRole('cell').map(cell => cell.textContent)).toEqual(index === 0
      ? ['VIX', 'Volatility Index', 'Neutral → Bearish'] : blocks[index].rows[0].cells);
  });
  const macroTable = screen.getByRole('table', { name: 'Macro outlook' });
  expect(macroTable.querySelector('caption')).toBeNull();
  expect(JSON.stringify(data)).toBe(original);
});

test('saved security comparisons remove Research list and retain full names without inventing missing tickers', () => {
  const security = 'Brent Crude Oil Continuous Contract';
  const data = { version: 1, sections: [{ title: 'Trend & range changes', blocks: [
    { type: 'table', columns: ['Instrument', 'Prior Trend', 'Trend', 'Research list'], rows: [{ cells: [security, 'Neutral', 'Bullish', 'Risk Ranges'] }] },
    { type: 'table', columns: ['Securities', 'Prior range', 'Published range', 'Trend'], rows: [{ cells: [security, '97–112', '97–111', 'Bullish'] }] },
  ] }] };
  render(<AnalystDailyRollup rollup={data} />);
  expect(screen.getAllByRole('cell', { name: security })).toHaveLength(2);
  expect(screen.getAllByTitle(security)).toHaveLength(2);
  expect(screen.getAllByRole('columnheader', { name: 'Ticker' })).toHaveLength(2);
  expect(screen.getAllByRole('columnheader', { name: 'Security', exact: true })).toHaveLength(2);
  expect(screen.queryByText('Research list')).not.toBeInTheDocument();
  expect(screen.queryByText('Risk Ranges')).not.toBeInTheDocument();
  expect(screen.getAllByRole('cell', { name: '—' })).toHaveLength(2);
});

test('ticker and security precede unchanged signals and ranges with source evidence in the footer', () => {
  const security = 'Brent Crude Oil Continuous Contract';
  const risk = { id: 'risk', productLabel: 'Risk Ranges', title: 'Risk Ranges', publicationDate: '2026-09-21' };
  const data = { version: 1, citations: [risk], sections: [{ title: 'Trend & range changes', blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Prior Trend', 'Trend'], rows: [
      { cells: ['VIX', 'Volatility Index', 'Neutral', 'Bearish'], citationIds: ['risk'] },
    ] },
    { type: 'table', columns: ['Ticker', 'Security', 'Prior range', 'Published range', 'Trend'], rows: [
      { cells: ['BRENT', security, '97–111', '97–110', 'Bullish'], citationIds: ['risk'] },
    ] },
  ] }] };
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const tables = screen.getAllByRole('table');
  expect(within(tables[0]).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Ticker', 'Security', 'Trend']);
  expect(within(tables[1]).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Ticker', 'Security', 'Prior range', 'Published range', 'Trend']);
  expect(screen.getByRole('row', { name: 'VIX Volatility Index Neutral → Bearish' })).toBeVisible();
  expect(within(tables[0]).getByText('Neutral')).toHaveClass('analyst-process--muted');
  expect(screen.getByRole('row', { name: `BRENT ${security} 97–111 97–110 Bullish` })).toBeVisible();
  expect(screen.getByTitle(security)).toHaveClass('analyst-security-name');
  expect(screen.getByText('Bearish')).toHaveClass('analyst-process--negative');
  expect(screen.getByText('Bullish')).toHaveClass('analyst-process--positive');
  const section = screen.getByRole('region', { name: 'Trend/Ranges/Coverage/Outbucket' });
  expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test('Research list is omitted from every table', () => {
  const data = rollup();
  data.sections[0].blocks = [{ type: 'table', columns: ['Security', 'Research list', 'Reading'],
    rows: [{ cells: ['VIX', 'Internal research classification', 'Bearish'], citationIds: ['early'] }] }];
  render(<AnalystDailyRollup rollup={data} onCitation={jest.fn()} />);
  expect(screen.queryByText('Research list')).not.toBeInTheDocument();
  expect(screen.queryByText('Internal research classification')).not.toBeInTheDocument();
  expect(screen.getByRole('row', { name: 'VIX Bearish' })).toBeVisible();
});

test('coverage changes use compact product additions and removals in saved and new reviews', () => {
  const changes = ['was added to Risk Ranges™', 'was removed from Risk Ranges', 'moved to the #OutBucket', 'No longer in published range table', '+ Signal Strength', '- Risk Ranges'];
  const data = rollup();
  data.sections[0].blocks = [{ type: 'table', columns: ['Ticker', 'Security', 'Coverage change'],
    rows: changes.map((change, i) => ({ cells: [`SEC${i}`, 'Security name', change], citationIds: ['early'] })) }];
  const original = JSON.stringify(data);
  const onCitation = jest.fn();
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows.map(row => within(row).getAllByRole('cell')[2].textContent)).toEqual([
    '+ Risk Ranges', '- Risk Ranges', '+ OutBucket', '- Risk Ranges', '+ Signal Strength', '- Risk Ranges',
  ]);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(JSON.stringify(data)).toBe(original);
});

test('LOW and HIGH show independent published-boundary changes with aligned comparison columns', () => {
  const risk = { id: 'risk', productLabel: 'Risk Ranges', title: 'Risk Ranges', publicationDate: '2026-09-21' };
  const data = { version: 1, citations: [risk], sections: [{ title: 'Trend & range changes', blocks: [
    { type: 'table', columns: ['Ticker', 'Security', 'Prior Trend', 'Trend'], rows: [
      { cells: ['VIX', 'Volatility Index', 'Neutral', 'Bearish'], citationIds: ['risk'] },
    ] },
    { type: 'table', columns: ['Ticker', 'Security', 'Prior range', 'Published range', 'LOW', 'HIGH', 'Trend'], rows: [
      { cells: ['AAPL', 'Apple Inc.', '321–345', '322–345', 'Higher low', 'Unchanged', 'Bullish'], citationIds: ['risk'] },
      { cells: ['GOLD', 'Gold Spot Price', '4,250–4,424', '4,240–4,419', 'Lower low', 'Lower high', 'Neutral'], citationIds: ['risk'] },
      { cells: ['AMZN', 'Amazon Inc.', '242–257', '244–260', 'Higher low', 'Higher high', 'Bearish'], citationIds: ['risk'] },
      { cells: ['VIX', 'Volatility Index', '—–18.67', '14.26–18.57', '—', 'Lower high', 'Bearish'], citationIds: ['risk'] },
    ] },
  ] }] };
  const onCitation = jest.fn();
  render(<AnalystDailyRollup rollup={data} onCitation={onCitation} />);
  const section = screen.getByRole('region', { name: 'Trend/Ranges/Coverage/Outbucket' });
  const tables = within(section).getAllByRole('table');
  expect(section).toHaveClass('has-range-boundaries');
  expect(tables[1]).toHaveClass('analyst-range-boundary-comparison');
  expect(within(tables[1]).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(data.sections[0].blocks[1].columns);
  expect(tables[1].querySelectorAll('col')).toHaveLength(7);
  expect([...tables[0].querySelectorAll('col')].slice(0, 2).map(col => col.className)).toEqual([...tables[1].querySelectorAll('col')].slice(0, 2).map(col => col.className));
  for (const label of ['Higher low', 'Higher high']) for (const node of within(tables[1]).getAllByText(label)) expect(node).toHaveClass('analyst-process--positive');
  for (const label of ['Lower low', 'Lower high']) for (const node of within(tables[1]).getAllByText(label)) expect(node).toHaveClass('analyst-process--negative');
  for (const label of ['Unchanged', '—']) expect(within(tables[1]).getByText(label)).toHaveClass('analyst-process--muted');
  expect(within(tables[1]).getAllByText('Bearish')[0]).toHaveClass('analyst-process--negative');
  expect(within(section).queryByRole('button')).not.toBeInTheDocument();
});

test('source content is rendered as plain text without HTML execution', () => {
  const data = rollup(); data.sections[0].blocks = [{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }];
  const { container } = render(<AnalystDailyRollup rollup={data} />);
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(container.querySelector('img')).toBeNull();
});

test('all substantive sections and rows render without summary truncation', () => {
  const data = rollup(); data.sections = Array.from({ length: 12 }, (_, index) => ({
    id: `section-${index}`, title: `Section ${index}`, blocks: [{ type: 'table', columns: ['Item'], rows: Array.from({ length: 20 }, (_, row) => ({ cells: [`Finding ${index}-${row}`] })) }],
  }));
  render(<AnalystDailyRollup rollup={data} />);
  expect(screen.getAllByRole('region')).toHaveLength(12);
  expect(screen.getByText('Finding 11-19')).toBeVisible();
});

test('empty and unsupported block types do not leave empty report headings', () => {
  render(<AnalystDailyRollup rollup={{ version: 1, sections: [{ title: 'Empty', blocks: [{ type: 'paragraph', text: '' }] }, { title: 'Unsupported', blocks: [{ type: 'html', text: 'Raw content' }] }] }} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
});

test('Portfolio Review keeps each research section through absent, partial, ready and unavailable captures without reserved heights', () => {
  const titles = ['PCA risk', 'Factor exposure', "Today's market drivers", 'Tick', 'Trend/Ranges/Coverage/Outbucket',
    'Macro & regime', 'Macro Show', 'Company catalysts & sector research', 'Signal Strength', 'Market structure & flows'];
  const ids = ['pca-risk', 'factor-exposure', 'market-drivers', 'hedgai-signals', 'risk-ranges',
    'macro-regime', 'macro-show', 'company-catalysts', 'signal-strength', 'market-structure'];
  const { rerender } = render(<AnalystDailyRollup stableLayout loading />);
  const cards = screen.getAllByRole('region');
  const bodies = cards.map(card => card.querySelector('.portfolio-review-section-body'));
  const assertUnchangedLayout = () => {
    expect(screen.getAllByRole('region').map(card => card.getAttribute('aria-label'))).toEqual(titles);
    screen.getAllByRole('region').forEach((card, index) => {
      expect(card).toBe(cards[index]);
      expect(card).toHaveClass('portfolio-review-section');
      // An empty section has no date line (no lone dash under its title); one with content dates it.
      const dateline = card.querySelector('.portfolio-review-dateline');
      expect(card.querySelector('.portfolio-review-section-status') ? dateline : null).toBeNull();
      expect(card.querySelector('.portfolio-review-section-body')).toBe(bodies[index]);
      expect(card.style.getPropertyValue('--portfolio-review-section-height')).toBe('');
    });
  };
  assertUnchangedLayout();
  expect(screen.getAllByText('Loading…')).toHaveLength(10);
  cards.forEach(card => {
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(card.style.getPropertyValue('--portfolio-review-section-height')).toBe('');
  });

  const partial = { version: 1, citations: [source], sections: [{
    id: 'market-drivers', title: "Today's market drivers", blocks: [{ type: 'paragraph', text: 'Captured market reading.', citationIds: [source.id] }],
  }] };
  const savedPartial = JSON.stringify(partial);
  const onCitation = jest.fn();
  rerender(<AnalystDailyRollup stableLayout loading rollup={partial} onCitation={onCitation} />);
  assertUnchangedLayout();
  expect(screen.getAllByText('Loading…')).toHaveLength(9);
  const drivers = screen.getByRole('region', { name: "Today's market drivers" });
  expect(drivers).not.toHaveAttribute('aria-busy');
  expect(within(drivers.querySelector('.portfolio-review-section-body')).getByText('Captured market reading.')).toBeVisible();
  expect(within(drivers).queryByText(/^Sources:/)).not.toBeInTheDocument();
  expect(JSON.stringify(partial)).toBe(savedPartial);

  const ready = { version: 1, sections: ids.map((id, index) => ({ id, title: titles[index],
    blocks: [{ type: 'paragraph', text: `Captured reading ${id}.` }],
  })).reverse() };
  const savedReady = JSON.stringify(ready);
  rerender(<AnalystDailyRollup stableLayout rollup={ready} />);
  assertUnchangedLayout();
  expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  ids.forEach(id => expect(screen.getByText(`Captured reading ${id}.`)).toBeVisible());
  expect(JSON.stringify(ready)).toBe(savedReady);

  rerender(<AnalystDailyRollup stableLayout rollup={{ version: 1, sections: [] }} />);
  assertUnchangedLayout();
  // PCA risk and Factor exposure read Pending; the other eight read Unavailable.
  expect(screen.getAllByText('Unavailable')).toHaveLength(8);
  expect(screen.getAllByText('Pending')).toHaveLength(2);
  expect(screen.queryByText(/Captured reading|Captured market reading/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test.each([false, true])('saved realignment, watch list, aligned and sequence sections stay out of the report (stable layout: %s)', stableLayout => {
  const retired = [
    ['refresh-realignment', 'Highest-priority realignment'], ['refresh-watch-list', 'Watch list'],
    ['refresh-aligned', 'What is already aligned'], ['refresh-sequence', 'Recommended sequence'],
    ['position-confirmations', 'Position confirmations'], ['position-contradictions', 'Position contradictions'],
  ];
  const data = { version: 1, sections: [
    ...retired.map(([id, title]) => ({ id, title, blocks: [{ type: 'paragraph', text: `Retired ${id}.` }] })),
    { id: 'macro-show', title: 'Macro Show', blocks: [{ type: 'paragraph', text: 'Captured Macro Show reading.' }] },
  ] };
  const saved = JSON.stringify(data);
  render(<AnalystDailyRollup stableLayout={stableLayout} rollup={data} />);
  retired.forEach(([id, title]) => {
    expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument();
    expect(screen.queryByText(`Retired ${id}.`)).not.toBeInTheDocument();
  });
  expect(screen.getByText('Captured Macro Show reading.')).toBeVisible();
  expect(JSON.stringify(data)).toBe(saved);
});

test('a paused PCA section keeps its slot with a compact Pending state while other sections load', () => {
  const pending = { version: 1, sections: [{ id: 'pca-risk', title: 'PCA risk', status: 'pending', citationIds: [], blocks: [] }] };
  const saved = JSON.stringify(pending);
  const { rerender } = render(<AnalystDailyRollup stableLayout loading rollup={pending} />);
  const pca = screen.getByRole('region', { name: 'PCA risk' });
  const titles = screen.getAllByRole('region').map(card => card.getAttribute('aria-label'));
  expect(within(pca).getByText('Pending')).toBeVisible();
  expect(within(pca).queryByText(/Loading…|Unavailable/)).not.toBeInTheDocument();
  expect(pca).not.toHaveAttribute('aria-busy');
  expect(pca.style.getPropertyValue('--portfolio-review-section-height')).toBe('');
  expect(screen.getByRole('region', { name: 'Factor exposure' })).toHaveTextContent('Loading…');
  rerender(<AnalystDailyRollup stableLayout rollup={pending} />);
  expect(screen.getAllByRole('region').map(card => card.getAttribute('aria-label'))).toEqual(titles);
  expect(within(screen.getByRole('region', { name: 'PCA risk' })).getByText('Pending')).toBeVisible();
  // Factor exposure reads Pending, not Unavailable, once loading ends with nothing.
  expect(screen.getByRole('region', { name: 'Factor exposure' })).toHaveTextContent('Pending');
  rerender(<AnalystDailyRollup stableLayout rollup={{ version: 1, sections: [{ ...pending.sections[0],
    status: 'ready', blocks: [{ type: 'paragraph', text: 'Captured PCA reading.' }] }] }} />);
  expect(screen.getByText('Captured PCA reading.')).toBeVisible();
  expect(within(screen.getByRole('region', { name: 'PCA risk' })).queryByText('Pending')).not.toBeInTheDocument();
  expect(JSON.stringify(pending)).toBe(saved);
});

test('wide Portfolio Review research tables fit their report width with visible overflow and wrapped cells', () => {
  const style = document.createElement('style');
  style.textContent = require('fs').readFileSync(require('path').join(__dirname, 'AnalystDailyRollup.css'), 'utf8');
  document.head.append(style);
  try {
    const data = { version: 1, sections: [{ id: 'hedgai-signals', title: 'Tick', blocks: [{
      type: 'table', groupRows: true, disclosure: 'Full captured Tick book',
      columns: ['Ticker', 'Security', 'Position'], rows: [{ cells: ['CAPTURED', 'Full captured security name', 'Last known Wait'], group: 'Captured group' }],
    }] }] };
    render(<AnalystDailyRollup stableLayout rollup={data} />);
    fireEvent.click(screen.getByText('Full captured Tick book'));
    const table = screen.getByRole('table', { name: 'Tick' });
    expect(table).toHaveClass('analyst-hedgai-full-book');
    expect(window.getComputedStyle(table.parentElement).overflow).toBe('visible');
    expect(window.getComputedStyle(table).minWidth).toBe('0');
    expect(window.getComputedStyle(table).width).toBe('100%');
    expect(window.getComputedStyle(table).tableLayout).toBe('fixed');
    expect(window.getComputedStyle(table.querySelector('tbody td')).whiteSpace).toBe('normal');
    expect(screen.getByText('Full captured security name').closest('.analyst-security-name')).toHaveAttribute('title', 'Full captured security name');
    const reading = table.querySelector('.analyst-tick-reading');
    expect(reading).toHaveTextContent('Last known Wait');
    expect(window.getComputedStyle(reading).whiteSpace).toBe('nowrap');
    expect(reading).toHaveAttribute('title', 'Last known Wait');
    expect(style.textContent).not.toMatch(/overscroll-behavior:\s*contain|scrollbar-gutter:/);
  } finally { style.remove(); }
});

test('Factor and Tick readings stay on one compact line, security names wrap in full, and hover evidence stays complete', () => {
  const style = document.createElement('style');
  style.textContent = require('fs').readFileSync(require('path').join(__dirname, 'AnalystDailyRollup.css'), 'utf8');
  document.head.append(style);
  try {
    const security = 'Nasdaq-100 · source-listed QQQ proxy';
    const factor = 'Developed markets equity with a very long captured factor name';
    const detail = 'Last known Wait · Nasdaq-100 · source-listed QQQ · Sep 28, 2026';
    const data = { version: 1, sections: [
      { id: 'factor-exposure', title: 'Factor exposure', blocks: [{ type: 'table',
        columns: ['Factor', 'Gross (% NLV)', 'Net (% NLV)', 'Risk contribution'],
        rows: [{ cells: [factor, '20.0%', '+10.0%', '+12.0%'] }] }] },
      { id: 'hedgai-signals', title: 'Tick', blocks: [{ type: 'table', groupRows: true,
        columns: ['Ticker', 'Security', 'Tick', 'Today', 'History', '60% filter'],
        rows: [{ cells: ['QQQ', security, 'Last known Wait', '—', 'Long 63.6%', 'Wait'],
          cellTitles: ['', 'NASDAQ 100 · Source-listed ticker QQQ', detail, '', '', ''] }] }] },
    ] };
    const captured = JSON.stringify(data);
    render(<AnalystDailyRollup stableLayout rollup={data} />);
    const factorName = screen.getByText(factor).closest('.analyst-factor-name');
    const securityName = screen.getByText(security).closest('.analyst-security-name');
    const reading = document.querySelector('.analyst-tick-reading');
    expect(window.getComputedStyle(securityName).whiteSpace).toBe('normal');
    expect(window.getComputedStyle(securityName).textOverflow).not.toBe('ellipsis');
    for (const identity of [factorName, reading]) {
      expect(window.getComputedStyle(identity).whiteSpace).toBe('nowrap');
      expect(window.getComputedStyle(identity).overflow).toBe('hidden');
      expect(window.getComputedStyle(identity).textOverflow).toBe('ellipsis');
      expect(identity.querySelector('br')).toBeNull();
    }
    expect(factorName).toHaveAttribute('title', factor);
    expect(securityName).toHaveAttribute('title', 'NASDAQ 100 · Source-listed ticker QQQ');
    expect(reading).toHaveTextContent('Last known Wait');
    expect(reading).toHaveAttribute('title', detail);
    expect(within(reading).getByText('Wait')).toHaveClass('analyst-process--muted');
    const table = screen.getByRole('table', { name: 'Tick' });
    expect(window.getComputedStyle(table.querySelector('col:nth-child(2)')).width).toBe('18%');
    expect(window.getComputedStyle(table.querySelector('col:nth-child(3)')).width).toBe('18%');
    expect(JSON.stringify(data)).toBe(captured);
  } finally { style.remove(); }
});
