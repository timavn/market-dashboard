import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import ContractLadder, { ContractQuoteCell, CpiLadderReferenceRow } from './ContractLadder';
import { MARKET_UI } from './marketUi';
import { buildLiveFesPositionMap, parseLiveFesPosition } from './predictionPositionOverlay';
import {
  buildGoldLadderProximityLevels,
  buildLadderProximityLevels,
  selectContractLinesForReference,
} from './contractLadderGeometry';
import { formatDelayedDataTimestamp } from '../DelayedDataMarker';

const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const GENERATION = 'FES_260910';
const VENUE = Object.freeze({ id: 'forecastex', label: 'ForecastEx' });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
// Test-only accepted native rows. Parent integration tests continue to cover
// provider/offline/cache/seed rejection and the live-position envelope gate.
const analysis = (threshold, overrides = {}) => ({
  line: {
    ticker: `${GENERATION}_${threshold}`,
    threshold,
    comparator: '>',
    status: 'available',
    yesBid: 0.42,
    yesAsk: 0.45,
    noBid: 0.51,
    noAsk: 0.56,
    yesBidSize: 10,
    yesAskSize: 20,
    noBidSize: 30,
    noAskSize: 40,
    volume24h: 1234,
    openInterest: 5678,
    ...overrides,
  },
});
const reference = (overrides = {}) => ({
  status: 'available', availability: 'live', fit: 'exact', label: 'ES',
  value: 6100, source: 'IBKR',
  asOf: new Date(NOW - 10_000).toISOString(),
  expiresAt: new Date(NOW + 30_000).toISOString(),
  ...overrides,
});
const snapshot = (spot = reference(), overrides = {}) => freeze({
  spot,
  contractReferenceLabel: 'ES',
  contracts: { event: { ticker: GENERATION, resolverSymbol: 'ES' } },
  ...overrides,
});
const ladder = (props = {}) => (
  <ContractLadder
    nowMs={NOW}
    snapshot={snapshot()}
    analyses={freeze([analysis(6090), analysis(6110)])}
    venueSelection={VENUE}
    {...props}
  />
);
const strikeRow = (label) => screen.getByTitle(`Settles above ${label}`).closest('tr');
const lastCell = (row) => within(row).getAllByRole('cell').slice(-1)[0];

test('preserves native four-sided quotes, nine-column layout, strike order and marker placement', () => {
  const inputs = freeze([analysis(6090), analysis(6110)]);
  const before = JSON.stringify(inputs);
  render(ladder({ analyses: inputs }));
  const section = screen.getByRole('region', { name: 'S&P 500 prediction-market contract ladder' });
  expect(section).toHaveAttribute('data-market-symbol', 'SPX');
  expect(section).toHaveAttribute('data-contract-row-count', '2');
  expect(section).toHaveAttribute('data-fit-mode', 'no-scroll');
  expect(section.style.getPropertyValue('--pm-spx-ladder-row-share')).toBe('50%');
  expect(screen.getByRole('columnheader', { name: 'ES SETTLES ABOVE' })).toBeInTheDocument();
  const row = strikeRow('6,090');
  expect(within(row).getAllByRole('cell')).toHaveLength(9);
  expect(within(row).getByLabelText('Yes bid: 42¢, displayed size 10 contracts')).toHaveTextContent('42¢× 10');
  expect(within(row).getByLabelText('Yes ask: 45¢, displayed size 20 contracts')).toHaveTextContent('45¢× 20');
  expect(within(row).getByLabelText('No bid: 51¢, displayed size 30 contracts')).toHaveClass('pm-spx-quote-group-start');
  expect(within(row).getByLabelText('No ask: 56¢, displayed size 40 contracts')).toHaveTextContent('56¢× 40');
  expect(row).toHaveTextContent('1,2345,6783¢ / 5¢');
  expect(lastCell(row)).toHaveTextContent('−10.00 (−0.16%)');
  expect(lastCell(row)).toHaveClass('is-negative');
  expect(lastCell(strikeRow('6,110'))).toHaveTextContent('+10.00 (+0.16%)');
  expect(lastCell(strikeRow('6,110'))).toHaveClass('is-positive');
  const marker = screen.getByRole('row', { name: 'EXACT · ES · LIVE 6,100.00' });
  expect(row.nextElementSibling).toBe(marker);
  expect(marker.nextElementSibling).toBe(strikeRow('6,110'));
  expect(within(marker).getByRole('cell')).toHaveAttribute('colspan', '9');
  expect(screen.getAllByTestId('spx-live-marker-segment')).toHaveLength(5);
  expect(section.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
  expect(JSON.stringify(inputs)).toBe(before);
});

test('does not synthesize missing opposite-side quotes or quote sizes', () => {
  render(ladder({
    analyses: freeze([analysis(6090, {
      status: 'incomplete', yesBidSize: 0, yesAskSize: null,
      noBid: null, noAsk: null, noBidSize: 99, noAskSize: 88,
    })]),
  }));
  const row = strikeRow('6,090');
  expect(row).toHaveClass('is-incomplete');
  expect(within(row).getByLabelText('Yes bid: 42¢, displayed size 0 contracts')).toHaveTextContent('× 0');
  expect(within(row).getByLabelText('Yes ask: 45¢, displayed size unavailable')).toHaveTextContent('SIZE —');
  expect(within(row).getByLabelText('No bid: no live quote')).toHaveTextContent('—NO QUOTE');
  expect(within(row).getByLabelText('No ask: no live quote')).toHaveTextContent('—NO QUOTE');
  expect(within(row).queryByText(/55¢|58¢|× 99|× 88/)).not.toBeInTheDocument();
  expect(row).toHaveTextContent('3¢ / —');
});

test('quote cells preserve a zero price and hide a size when its price is unavailable', () => {
  render(<table><tbody><tr>
    <ContractQuoteCell outcome="Yes" side="bid" price={0} size={0} />
    <ContractQuoteCell outcome="No" side="ask" price={null} size={500} groupStart />
  </tr></tbody></table>);
  expect(screen.getByLabelText('Yes bid: 0¢, displayed size 0 contracts')).not.toHaveClass('is-empty');
  expect(screen.getByLabelText('No ask: no live quote')).toHaveClass('is-empty', 'pm-spx-quote-group-start');
  expect(screen.queryByText('× 500')).not.toBeInTheDocument();
});

test('clears the native rows when the parent removes accepted analyses after provider failure', () => {
  const { rerender } = render(ladder());
  expect(screen.getAllByLabelText('Yes bid: 42¢, displayed size 10 contracts')).toHaveLength(2);
  rerender(ladder({ analyses: [], snapshot: snapshot(null, { contracts: { reason: 'NO LIVE BOOK' } }) }));
  expect(screen.queryByLabelText(/displayed size/)).not.toBeInTheDocument();
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'NO LIVE BOOK' })).toHaveAttribute('colspan', '9');
  const section = screen.getByRole('region');
  expect(section).toHaveAttribute('data-contract-row-count', '0');
  expect(section.style.getPropertyValue('--pm-spx-ladder-row-share')).toBe('100%');
  rerender(ladder({ analyses: [], snapshot: snapshot(null) }));
  expect(screen.getByText('NO VERIFIED ACTIVE SP500 LINES')).toBeInTheDocument();
});

test.each([
  ['expired', { expiresAt: new Date(NOW - 1).toISOString() }],
  ['failed refresh', { refreshFailed: true }],
  ['unaccepted pending refresh', { refreshPending: true }],
  ['cache-only', { cachedOnly: true }],
  ['seeded', { seeded: true }],
  ['mock provenance', { source: 'mock' }],
  ['portfolio-derived provenance', { source: 'portfolio-derived' }],
  ['offline provider', { status: 'offline' }],
])('omits %s references without modifying independently accepted native quotes', (_label, overrides) => {
  render(ladder({ snapshot: snapshot(reference(overrides)) }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  const row = strikeRow('6,090');
  expect(lastCell(row)).toHaveTextContent(/^—$/);
  expect(row).not.toHaveAttribute('data-spot-proximity');
  expect(within(row).getByLabelText('Yes bid: 42¢, displayed size 10 contracts')).toBeInTheDocument();
});

test('accepts retained refresh and matching dated close references without relabeling the close live', () => {
  const { rerender } = render(ladder({
    snapshot: snapshot(reference({ refreshPending: true, refreshRetained: true })),
  }));
  expect(screen.getByRole('row', { name: 'EXACT · ES · LIVE 6,100.00' })).toBeInTheDocument();
  const close = reference({
    status: 'historical', availability: 'historical',
    asOf: '2026-09-09T20:00:00.000Z', historicalThroughDate: '2026-09-09',
    expiresAt: '2026-09-09T21:00:00.000Z',
  });
  rerender(ladder({ snapshot: snapshot(close) }));
  expect(screen.getByRole('row', { name: 'EXACT · ES · LAST CLOSE 6,100.00 (9/9)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /LAST CLOSE/ })).toHaveAttribute('data-data-status', 'historical');
  rerender(ladder({ snapshot: snapshot({ ...close, historicalThroughDate: '2026-09-08' }) }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
});

test('retained last-verified references preserve the original timestamp and stop at their generation or expiry boundary', () => {
  const retained = reference({
    status: 'last_verified', availability: 'last_verified', retainedAvailability: 'live',
    displayOnly: true, executable: false, generationKey: GENERATION,
    retainedUntil: new Date(NOW + 10_000).toISOString(),
  });
  const { rerender } = render(ladder({ snapshot: snapshot(retained) }));
  const marker = screen.getByRole('row', { name: 'EXACT · ES · DELAYED 6,100.00' });
  expect(marker).toHaveClass('is-last-verified');
  const trigger = within(marker).getByRole('button', { name: /EXACT · ES · DELAYED/ });
  expect(trigger).toHaveAttribute('data-data-status', 'delayed');
  expect(trigger).toHaveAccessibleName(`EXACT · ES · DELAYED 6,100.00. ${formatDelayedDataTimestamp(retained.asOf, 'delayed')}`);
  fireEvent.click(trigger);
  expect(screen.getByRole('status')).toHaveTextContent(formatDelayedDataTimestamp(retained.asOf, 'delayed'));
  rerender(ladder({ snapshot: snapshot({ ...retained, generationKey: 'FES_260909' }) }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  rerender(ladder({ snapshot: snapshot(retained), nowMs: NOW + 10_000 }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
});

test('delayed exact references require resolver identity while explicit proxies preserve their own label', () => {
  const delayed = reference({
    status: 'delayed', availability: 'delayed', retainedAvailability: 'live',
    displayDelayed: true, displayOnly: true, executable: false, clientVerified: true,
  });
  const { rerender } = render(ladder({ snapshot: snapshot(delayed) }));
  expect(screen.getByRole('row', { name: 'EXACT · ES · DELAYED 6,100.00' })).toBeInTheDocument();
  rerender(ladder({ snapshot: snapshot({ ...delayed, label: 'SPX' }) }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  rerender(ladder({ snapshot: snapshot({ ...delayed, label: 'SPX', fit: 'proxy' }) }));
  expect(screen.getByRole('row', { name: 'PROXY · SPX · DELAYED 6,100.00' })).toBeInTheDocument();
  rerender(ladder({ snapshot: snapshot({ ...delayed, stale: true }) }));
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
});

const cpiReference = (overrides = {}) => ({
  status: 'available', kind: 'hedgeye_base', executable: false,
  reportMonth: '2026-08', value: 2.9, source: 'Hedgeye',
  asOf: '2026-09-10T17:00:00.000Z', expiresAt: new Date(NOW + 30_000).toISOString(),
  ...overrides,
});
const cpiSnapshot = (overrides = {}) => snapshot(null, {
  contracts: { event: { ticker: 'KXCPIYOY-26AUG', reportMonth: '2026-08' } },
  ladderReference: cpiReference(overrides),
});

test('renders a sourced same-period CPI reference as a dated non-executable reference, with inclusive-bucket geometry', () => {
  render(ladder({
    snapshot: cpiSnapshot(), marketUi: MARKET_UI.cpi,
    analyses: freeze([analysis(2.9, { ticker: 'CPI-2.8-3.0', comparator: 'inclusive_range', lowerBound: 2.8, upperBound: 3.0 })]),
  }));
  expect(screen.getByRole('columnheader', { name: 'Δ HYE BASE' })).toBeInTheDocument();
  const row = screen.getByTitle('Inclusive range 2.8–3.0').closest('tr');
  expect(row).toHaveAttribute('data-spot-proximity', 'dark');
  expect(lastCell(row)).toHaveTextContent('0.00 (0.00%)');
  const marker = screen.getByRole('row', { name: 'HEDGEYE BASE 9/10/26 2.9%' });
  expect(marker).toBe(screen.getByTestId('cpi-ladder-reference-row'));
  expect(within(marker).getByRole('cell')).toHaveAttribute('colspan', '9');
  expect(marker).not.toHaveTextContent('LIVE');
  expect(screen.queryByTestId('spx-live-marker-line')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test.each([
  ['wrong report period', { reportMonth: '2026-07' }],
  ['executable', { executable: true }],
  ['unsourced', { source: ' ' }],
  ['expired at the boundary', { expiresAt: new Date(NOW).toISOString() }],
  ['unavailable', { status: 'unavailable' }],
])('does not place a %s CPI reference on the ladder', (_label, overrides) => {
  render(ladder({ snapshot: cpiSnapshot(overrides), marketUi: MARKET_UI.cpi, analyses: [analysis(3)] }));
  expect(screen.queryByTestId('cpi-ladder-reference-row')).not.toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Δ HYE BASE' })).not.toBeInTheDocument();
  expect(lastCell(strikeRow('3.0'))).toHaveTextContent(/^—$/);
});

test('CPI reference rows retain custom labels and an explicit unavailable pull date', () => {
  render(<table><tbody><CpiLadderReferenceRow
    reference={cpiReference({ label: 'HEDGEYE PUBLISHED BASE', asOf: null })}
    columnCount={9}
  /></tbody></table>);
  expect(screen.getByRole('row', { name: 'HEDGEYE PUBLISHED BASE DATE UNAVAILABLE 2.9%' })).toBeInTheDocument();
});

test('groups only current-generation same-account positive positions without deriving quotes from their cost', () => {
  const positions = freeze([
    { localSymbol: `${GENERATION}_6090_YES`, quantity: 2, avgCost: 0.2, account: 'DU1' },
    { description: `${GENERATION}_6090_YES`, position: 3, averageCost: 0.4, accountId: 'DU1' },
    { ticker: `${GENERATION}_6090_NO`, quantity: 2, avgCost: 0.25, accountId: 'DU1' },
    { localSymbol: 'FES_260909_6090_YES', quantity: 9, avgCost: 0.9, account: 'DU1' },
    { localSymbol: `${GENERATION}_6090_YES`, quantity: 8, avgCost: 0.8, account: 'DU2' },
    { localSymbol: `${GENERATION}_6090_NO`, quantity: -7, avgCost: 0.7, account: 'DU1' },
    { localSymbol: `${GENERATION}_6090_NO`, quantity: 0, avgCost: 0.7, account: 'DU1' },
    { localSymbol: `${GENERATION}_6090_NO`, quantity: 6, avgCost: 1.1, account: 'DU1' },
  ]);
  const before = JSON.stringify(positions);
  const map = buildLiveFesPositionMap(positions, { generationKey: 'fes_260910', accountId: ' DU1 ' });
  expect([...map.keys()]).toEqual([`${GENERATION}_6090`]);
  expect(map.get(`${GENERATION}_6090`).map(({ side, quantity, averageCost, cost }) => ({ side, quantity, averageCost, cost })))
    .toEqual([
      { side: 'YES', quantity: 5, averageCost: 0.32, cost: 1.6 },
      { side: 'NO', quantity: 2, averageCost: 0.25, cost: 0.5 },
    ]);
  render(ladder({
    positionMap: map,
    analyses: [analysis(6090, { contractId: ` ${GENERATION.toLowerCase()}_6090 `, yesBid: null, yesAsk: null, noBid: null, noAsk: null }), analysis(6110)],
  }));
  const row = strikeRow('6,090');
  expect(within(row).getByLabelText('Live IBKR position: YES, cost $1.60, average price 32¢, quantity 5')).toHaveTextContent('YES - $1.60 (32¢ × 5)');
  expect(within(row).getByLabelText('Live IBKR position: NO, cost $0.50, average price 25¢, quantity 2')).toHaveTextContent('NO - $0.50 (25¢ × 2)');
  expect(within(row).getAllByText('NO QUOTE')).toHaveLength(4);
  expect(within(strikeRow('6,110')).queryByLabelText(/Live IBKR position/)).not.toBeInTheDocument();
  expect(parseLiveFesPosition({ localSymbol: 'FES_260910_6090_YES', quantity: 1, avgCost: null })).toBeNull();
  expect(JSON.stringify(positions)).toBe(before);
});

test('keeps the geometry alias and selects frozen range rows without changing their object identity', () => {
  const inputs = freeze([
    analysis(6100, { comparator: 'inclusive_range', lowerBound: 6095, upperBound: 6105 }),
    analysis(6120), analysis(6080), analysis(6140), analysis(6060),
  ]);
  expect(buildGoldLadderProximityLevels).toBe(buildLadderProximityLevels);
  const selected = selectContractLinesForReference(inputs, 6100, 1);
  expect(selected).toEqual([inputs[2], inputs[0], inputs[1]]);
  expect(selected[1]).toBe(inputs[0]);
  expect(buildLadderProximityLevels(selected.map(({ line }) => line), 6100)).toEqual(new Map([[1, 'dark'], [0, 'dark'], [2, 'dark']]));
  expect(selectContractLinesForReference(inputs, null, 1, 2)).toEqual([inputs[4], inputs[2]]);
});
