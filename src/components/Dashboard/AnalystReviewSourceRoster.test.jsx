import React from 'react';
import { render, screen, within } from '@testing-library/react';
import AnalystReviewSources from './AnalystReviewSources';
import { loadingReviewSourceItems, rememberReviewSourceRoster } from '../../services/analyst/analystReviewSourceRoster';
import { pendingReviewSourceItems } from '../../services/analyst/analystReviewSourceCatalog.cjs';

const kind = 'prediction-markets-review';
const labels = () => within(screen.getByRole('region', { name: 'Review sources' })).getAllByRole('listitem')
  .map(row => row.querySelector('.analyst-review-source-label').textContent);
const loaded = (rows, capturedAt = '2026-11-19T16:49:30Z') => ({ conversationId: 'c', runId: 'r', basis: 'review', state: 'succeeded',
  capturedAt, items: rows.map(([id, label]) => ({ id, label, status: 'ready', observedAt: capturedAt })) });
const cited = [['risk-ranges', 'Risk Ranges'], ['marketPrices', 'Market prices'], ['top-3-things', 'Top 3 Things'], ['early-look', 'Early Look']];

beforeEach(() => localStorage.clear());

test('without a loaded review the catalog reserves the loading rows', () => {
  expect(loadingReviewSourceItems(kind)).toEqual(pendingReviewSourceItems(kind));
  expect(loadingReviewSourceItems('portfolio-review').map(row => row.id)).toEqual(pendingReviewSourceItems('portfolio-review').map(row => row.id));
});

test('a loaded review keeps its rows for the next load, as ids and labels only', () => {
  const { unmount } = render(<AnalystReviewSources reviewKind={kind} sources={loaded(cited)} />);
  const settledRows = labels();
  unmount();
  expect(loadingReviewSourceItems(kind)).toEqual(cited.map(([id, label]) => ({ id, label, status: 'checking', observedAt: null })));
  expect(localStorage.getItem('analyst.reviewSourceRoster.v1')).not.toMatch(/ready|observedAt/);
  // The next launch shows the same rows in the same order while it loads.
  render(<AnalystReviewSources reviewKind={kind} loading phase="Starting…" />);
  expect(labels()).toEqual(settledRows);
  // Another review kind keeps its own catalog rows.
  expect(loadingReviewSourceItems('portfolio-review')).toEqual(pendingReviewSourceItems('portfolio-review'));
});

test('a queued reservation never flashes rows the loaded review does not show', () => {
  rememberReviewSourceRoster(kind, loaded(cited), cited.map(([id, label]) => ({ id, label })));
  const queued = { conversationId: 'c', runId: 'r2', basis: 'review', state: 'queued',
    items: pendingReviewSourceItems(kind) };
  const { rerender } = render(<AnalystReviewSources reviewKind={kind} sources={queued} loading />);
  expect(labels()).toEqual(cited.map(([, label]) => label));
  // Once a result arrives, a row still being checked outside the reserved rows is shown.
  const partial = { ...queued, state: 'acquiring', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-11-19T16:49:30Z' },
    { id: 'the-call', label: 'The Call', status: 'checking', observedAt: null }] };
  rerender(<AnalystReviewSources reviewKind={kind} sources={partial} loading />);
  expect(labels()).toEqual([...cited.map(([, label]) => label), 'The Call']);
});

test('older, failed and undated reviews never replace the remembered rows', () => {
  const rows = cited.map(([id, label]) => ({ id, label }));
  rememberReviewSourceRoster(kind, loaded(cited), rows);
  const other = [{ id: 'kalshiContracts', label: 'Kalshi contracts' }];
  rememberReviewSourceRoster(kind, loaded([], '2026-11-18T10:00:00Z'), other);
  rememberReviewSourceRoster(kind, { ...loaded([]), state: 'failed', capturedAt: '2026-11-20T10:00:00Z' }, other);
  rememberReviewSourceRoster(kind, { ...loaded([]), capturedAt: undefined }, other);
  rememberReviewSourceRoster(kind, { ...loaded([]), basis: 'indexed-research', capturedAt: '2026-11-20T10:00:00Z' }, other);
  expect(loadingReviewSourceItems(kind).map(row => row.id)).toEqual(cited.map(([id]) => id));
  rememberReviewSourceRoster(kind, loaded([], '2026-11-20T10:00:00Z'), other);
  expect(loadingReviewSourceItems(kind).map(row => row.id)).toEqual(['kalshiContracts']);
});

test('unreadable storage falls back to the catalog', () => {
  localStorage.setItem('analyst.reviewSourceRoster.v1', '{not json');
  expect(loadingReviewSourceItems(kind)).toEqual(pendingReviewSourceItems(kind));
  localStorage.setItem('analyst.reviewSourceRoster.v1', JSON.stringify({ [kind]: { rows: [{ id: 5 }, { label: 'No id' }] } }));
  expect(loadingReviewSourceItems(kind)).toEqual(pendingReviewSourceItems(kind));
});
