import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import PortfolioFactorQuadMatrix from '../PortfolioFactorQuadMatrix';
import { buildPortfolioQuadExposure } from '../../../utils/portfolioFactorExposure';
import { GAPS, GROUPS } from '../../../services/quadResearch/catalog.cjs';

const gold = GROUPS.flatMap(group => group.benchmarks).find(benchmark => benchmark.symbol === 'GLD');
const researchCell = {
  exposureId: gold.exposureId, quad: 1, status: 'supported', classification: 'filled',
  rank: 3, peerCount: 5, meanReturn: 0.025, observations: 12, episodes: 4,
  rankInterval: [2, 4], sampleStart: '2007Q2', sampleEnd: '2026Q2', benchmark: gold,
  diagnostics: { bootstrap: Object.fromEntries([2, 4, 8].map(blockLength => [blockLength, {
    blockLength, seed: 42, draws: 5000, validDraws: 4900, invalidDraws: 100,
    interval: { lower: 2, upper: 4 }, reason: null,
  }])) },
};
const research = {
  schemaVersion: 1, source: 'independent-quad-research', historicalOnly: true,
  available: true, verified: true, version: 'b'.repeat(64), methodology: { version: 'quad-ranks-v1' },
  cutoff: '2026Q2', generatedAt: '2026-09-08T12:00:00.000Z',
  groups: GROUPS, cells: [researchCell], sourceHashes: ['a'.repeat(64)],
};

const holdings = [
  { symbol: 'OIH', marketValue: 4500 },
  { symbol: 'OIH', marketValue: -6000 },
  { symbol: 'QQQ', marketValue: 9000 },
];

const renderMatrix = (props = {}) => render(<PortfolioFactorQuadMatrix
  rows={buildPortfolioQuadExposure(holdings, 100000, true)}
  available
  onSelectFactor={jest.fn()}
  onClearFactor={jest.fn()}
  {...props}
/>);

test('keeps the compact factor card free of headings, extra side controls, tabs, and footer copy', () => {
  renderMatrix();
  const panel = screen.getByLabelText('Factor exposure balance');
  expect(within(panel).queryByRole('heading')).not.toBeInTheDocument();
  expect(within(panel).queryByRole('tablist')).not.toBeInTheDocument();
  expect(within(panel).getAllByRole('rowheader')).toHaveLength(45);
  ['Cash', 'Cryptocurrency', 'Managed Futures', 'Unclassified'].forEach(name => (
    expect(within(panel).queryByRole('rowheader', { name, exact: true })).not.toBeInTheDocument()
  ));
  expect(panel).not.toHaveTextContent(/illustrative|alignment|playbooks|Best #|Worst #|Large blue bars|outweighs/i);
  ['Long', 'Short', 'Net'].forEach(name => expect(within(panel).queryByRole('button', { name, exact: true })).not.toBeInTheDocument());
  expect(within(panel).getAllByRole('columnheader').map(header => header.textContent)).toEqual([
    'Factor', 'Net % NAV', 'Q1 Goldilocks', 'Q2 Reflation', 'Q3 Stagflation', 'Q4 Deflation',
  ]);
});

test('uses bare colored numbers while preserving the exact worksheet rank meaning accessibly', () => {
  renderMatrix();
  const best = screen.getByRole('cell', { name: 'Tech, Quad 2: Best #1' });
  const worst = screen.getByRole('cell', { name: 'Utilities, Quad 2: Worst #1' });
  expect(best).toHaveTextContent(/^1$/);
  expect(best).toHaveClass('is-best', 'is-first');
  expect(worst).toHaveTextContent(/^1$/);
  expect(worst).toHaveClass('is-worst', 'is-first');
  expect(screen.getByRole('cell', { name: 'Energy, Quad 2: Best #4' })).toHaveTextContent(/^4$/);
  [2, 4].forEach(quad => {
    const unlisted = screen.getByRole('cell', { name: `Materials, Quad ${quad}: Unavailable: Research unavailable.` });
    expect(unlisted).toHaveTextContent(/^—$/);
    expect(unlisted).toHaveAttribute('title', expect.stringContaining('Research unavailable'));
  });
  [1, 2, 3, 4].forEach(quad => {
    expect(screen.getByRole('columnheader', { name: new RegExp(`^Q${quad}`) })).toHaveClass(`is-q${quad}`);
  });
});

test('includes both books in signed net exposure and keeps the underlying quad ranks unchanged', () => {
  renderMatrix();
  const netCell = screen.getByLabelText('Net exposure to Energy: -1.5% of NAV');
  expect(netCell).toHaveTextContent('-1.5%');
  expect(netCell.querySelector('.pcv2-factor-matrix__exposure')).toHaveClass('is-negative');
  expect(netCell).toHaveAttribute('title', expect.stringContaining('Long 4.5%; short 6.0%'));
  expect(screen.getByLabelText('Net exposure to Tech: 9.0% of NAV')).toHaveTextContent('+9.0%');
  expect(screen.getByRole('cell', { name: 'Energy, Quad 2: Best #4' })).toHaveTextContent(/^4$/);
});

test('retains classification rows and ranks but suppresses unavailable weights and filters', () => {
  renderMatrix({ rows: buildPortfolioQuadExposure(holdings, 100000, false), available: false });
  expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
  expect(screen.getByLabelText('Energy exposure unavailable')).toHaveTextContent('N/A');
  expect(screen.queryByRole('button', { name: /Filter by Energy/ })).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Energy, Quad 3: Best #2' })).toHaveTextContent('2');
  expect(document.querySelector('.pcv2-factor-matrix__bar')).not.toBeInTheDocument();
});

test('labels dated valuations and withholds only incomplete factor totals', () => {
  const missing = { symbol: 'XLE', marketValue: null };
  renderMatrix({
    rows: buildPortfolioQuadExposure(holdings, 100000, true, [missing]),
    valuation: { asOf: '2026-09-04', unavailableHoldings: [missing] },
  });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: /Net % NAV/ })).toHaveTextContent('Sep 4 close');
  expect(screen.getByRole('columnheader', { name: /Net % NAV/ })).toHaveAttribute('title', expect.stringContaining('2026-09-04 closing prices'));
  expect(screen.getByLabelText('Energy exposure unavailable')).toHaveAttribute('title', 'Missing verified valuation for XLE');
  expect(screen.queryByRole('button', { name: /Filter by Energy/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Net exposure to Tech: 9.0% of NAV')).toHaveTextContent('+9.0%');
});

test('keeps every factor in alphabetical order through refreshes, missing marks and disconnects', () => {
  const view = renderMatrix();
  const labels = () => screen.getAllByRole('rowheader').map(cell => cell.textContent);
  const initial = labels();
  expect(initial).toEqual([...initial].sort((a, b) => a.localeCompare(b)));
  const states = [
    { available: true, rows: buildPortfolioQuadExposure([{ symbol: 'OIH', marketValue: 50000 }], 100000, true, [{ symbol: 'QQQ' }]) },
    { available: false, rows: buildPortfolioQuadExposure([], 100000, false) },
    { available: true, rows: buildPortfolioQuadExposure(holdings, 100000, true) },
  ];
  states.forEach(props => {
    view.rerender(<PortfolioFactorQuadMatrix {...props} />);
    expect(labels()).toEqual(initial);
    expect(screen.getByRole('cell', { name: 'Materials, Quad 1: Best #5' })).toHaveTextContent('5');
    expect(screen.getByRole('columnheader', { name: 'Factor' })).toHaveAttribute('aria-sort', 'ascending');
  });
});

test('distinguishes zero, unavailable exposure and unlisted ranks without signed rounded zeros', () => {
  renderMatrix({ rows: buildPortfolioQuadExposure([
    { symbol: 'OIH', marketValue: -10 },
    { symbol: 'GLD', marketValue: 10 },
  ], 100000, true, [{ symbol: 'QQQ' }]) });
  ['Energy', 'Gold', 'Utilities'].forEach(factor => {
    const cell = screen.getByLabelText(`Net exposure to ${factor}: 0.0% of NAV`);
    expect(cell).toHaveTextContent(/^0.0%$/);
    expect(cell.querySelector('.pcv2-factor-matrix__bar')).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText('Tech exposure unavailable')).toHaveTextContent('N/A');
  expect(screen.getByRole('cell', { name: 'Materials, Quad 2: Unavailable: Research unavailable.' })).toHaveTextContent('—');
});

test('uses a loading state only for an initial portfolio load', () => {
  renderMatrix({ available: false, loading: true, rows: buildPortfolioQuadExposure([], null, false) });
  expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  expect(screen.getByLabelText('Energy exposure unavailable')).toHaveTextContent('…');
  expect(screen.getByRole('cell', { name: 'Energy, Quad 2: Best #4' })).toHaveTextContent('4');
});

test('preserves all 141 published cells exactly and uses a dash for all 39 unsupported gaps', () => {
  const rows = buildPortfolioQuadExposure(holdings, 100000, true);
  renderMatrix({ estimates: { ...research, cells: [] } });
  let count = 0;
  rows.forEach(row => [1, 2, 3, 4].forEach(quad => {
    const fit = row.quadFits[`q${quad}`];
    if (fit.status === 'not-listed') return;
    count += 1;
    const rankLabel = `${fit.status === 'best' ? 'Best' : 'Worst'} #${fit.rank}`;
    const cell = screen.getByRole('cell', { name: `${row.label}, Quad ${quad}: ${rankLabel}` });
    expect(cell).toHaveTextContent(new RegExp(`^${fit.rank}$`));
    expect(cell).toHaveAttribute('title', `${row.label} · Quad ${quad} · ${rankLabel}`);
    expect(cell.className).toBe(`pcv2-factor-matrix__rank is-${fit.status}${fit.rank === 1 ? ' is-first' : ''}`);
    expect(within(cell).queryByRole('button')).not.toBeInTheDocument();
  }));
  expect(count).toBe(141);
  expect(screen.getAllByText('—', { exact: true })).toHaveLength(39);
  expect(screen.queryByText(/not listed/i)).not.toBeInTheDocument();
});

test('stars only independent eligible cells and opens a compact, attributed explanation', () => {
  renderMatrix({ estimates: research });
  const cell = screen.getByRole('cell', { name: /Gold, Quad 1: Rank 3 of 5\*/ });
  expect(cell).toHaveTextContent(/^3\*$/);
  expect(cell).toHaveClass('is-independent');
  expect(cell).not.toHaveClass('is-best', 'is-worst');
  fireEvent.click(within(cell).getByRole('button'));
  const dialog = screen.getByRole('dialog', { name: 'Rank 3 of 5*' });
  expect(dialog).toHaveTextContent('Independently calculated historical rank');
  expect(dialog).toHaveTextContent('2.50%');
  expect(dialog).toHaveTextContent('2007Q2–2026Q2');
  expect(dialog).toHaveTextContent('12 quarters · 4 episodes');
  expect(dialog).toHaveTextContent('80% rank intervals2–4 (2q blocks)');
  expect(dialog).toHaveTextContent('Sep 8, 2026');
  expect(dialog).toHaveTextContent('different methodology');
  expect(dialog).toHaveTextContent('GDP advance releases arrive after quarter-end');
  expect(within(dialog).getByRole('link', { name: 'GLD ↗' })).toHaveAttribute('href', gold.sourceUrl);
});

test('keeps historical ranks available independently of disconnected portfolio quotes', () => {
  renderMatrix({ available: false, rows: buildPortfolioQuadExposure([], null, false), estimates: research });
  expect(screen.getByLabelText('Gold exposure unavailable')).toHaveTextContent('N/A');
  expect(screen.queryByRole('button', { name: /Filter by Gold/ })).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: /Gold, Quad 1: Rank 3 of 5\*/ })).toHaveTextContent('3*');
});

test('discloses an in-sample benchmark change with its issuer methodology source', () => {
  const quality = GROUPS.flatMap(group => group.benchmarks).find(benchmark => benchmark.symbol === 'QUAL');
  renderMatrix({ estimates: { ...research, cells: [{ ...researchCell, exposureId: quality.exposureId,
    benchmark: quality, peerCount: 7, sampleStart: '2013-Q4' }] } });
  fireEvent.click(screen.getByRole('button', { name: /Explain Quality, Quad 1: Rank 3 of 7/ }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Fund benchmark changed during this sample');
  expect(within(dialog).getByRole('link', { name: 'see issuer methodology ↗' })).toHaveAttribute('href', quality.methodologyChanges[0].sourceUrl);
});

test('all four undefined factors reject supplied calculated ranks', () => {
  const labels = ['FX', 'Cyclical Growth', 'Leverage', 'Size'];
  const cells = GAPS.filter(gap => labels.includes(gap.label)).map(gap => ({ ...researchCell, ...gap }));
  renderMatrix({ estimates: { ...research, cells } });
  expect(screen.queryByText('3*')).not.toBeInTheDocument();
  cells.forEach(cell => {
    const element = screen.getByRole('cell', { name: new RegExp(`^${cell.label}, Quad ${cell.quad}: Unavailable:`) });
    expect(element).toHaveTextContent(/^—$/);
  });
});

test('updates an open detail when an estimate is dropped and exposes its unavailable reason', () => {
  const view = renderMatrix({ estimates: research });
  fireEvent.click(screen.getByRole('button', { name: /Explain Gold, Quad 1: Rank 3 of 5/ }));
  const unavailable = { ...researchCell, status: 'unavailable', classification: 'unstable', rank: null, reason: 'Rank changes too much when one episode is removed.' };
  view.rerender(<PortfolioFactorQuadMatrix rows={buildPortfolioQuadExposure(holdings, 100000, true)} available estimates={{ ...research, cells: [unavailable] }} />);
  const dialog = screen.getByRole('dialog', { name: 'Rank unavailable' });
  expect(dialog).toHaveTextContent(unavailable.reason);
  expect(screen.queryByText('3*')).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: `Gold, Quad 1: Unavailable: ${unavailable.reason}` })).toHaveAttribute('title', expect.stringContaining(unavailable.reason));
});

test('supports focus trap, Escape, focus restoration, and backdrop close', () => {
  renderMatrix({ estimates: research });
  const trigger = screen.getByRole('button', { name: /Explain Gold, Quad 1: Rank 3 of 5/ });
  trigger.focus();
  fireEvent.click(trigger);
  const close = screen.getByRole('button', { name: 'Close Quad research explanation' });
  const source = screen.getByRole('link', { name: 'GLD ↗' });
  expect(close).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(source).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).not.toBe('hidden');
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole('dialog'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByTestId('quad-research-backdrop'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
