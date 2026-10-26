import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import AnalystReviewSources from './AnalystReviewSources';
import { pendingReviewSourceItems } from '../../services/analyst/analystReviewSourceCatalog.cjs';
import { reviewSourceDisplayItems } from '../../services/analyst/analystReviewSourcePresentation.cjs';

test('Predictive Sources keeps label, date and status aligned through queued, ready and unavailable states', () => {
  const style = document.createElement('style');
  style.textContent = require('fs').readFileSync(require('path').join(__dirname, 'AnalystReviewSources.css'), 'utf8');
  document.head.appendChild(style);
  try {
    const items = reviewSourceDisplayItems(pendingReviewSourceItems('prediction-markets-review'));
    const view = render(<AnalystReviewSources reviewKind="prediction-markets-review" loading phase="Queued" />);
    const rows = screen.getAllByRole('listitem');
    const assertColumns = () => {
      expect(screen.getAllByRole('listitem')).toEqual(rows);
      rows.forEach(row => {
        expect([...row.children].map(cell => cell.className)).toEqual([
          'analyst-review-source-label', 'analyst-review-source-time', 'analyst-review-source-status',
        ]);
        expect(getComputedStyle(row).alignItems).toBe('center');
        const status = row.querySelector('.analyst-review-source-status-content');
        // A checking row leads with the spinner group; a settled row with its icon and label.
        const [first, second] = status.children;
        const content = first.classList.contains('analyst-spinner-group') ? 'spinner' : `${first.tagName.toLowerCase()}+${second?.tagName}`;
        expect(content).toBe(row.classList.contains('is-checking') ? 'spinner' : 'svg+SPAN');
        expect(getComputedStyle(status).display).toBe('grid');
        expect(getComputedStyle(status).gridTemplateColumns).toBe('12px minmax(0, 1fr)');
        expect(getComputedStyle(status).alignItems).toBe('center');
        expect(getComputedStyle(status).textAlign).toBe('left');
      });
    };
    assertColumns();
    const sources = { state: 'complete', items: items.map(item => ({ ...item, status: 'ready', observedAt: '2026-10-08T16:05:00Z' })) };
    const captured = JSON.stringify(sources);
    view.rerender(<AnalystReviewSources reviewKind="prediction-markets-review" sources={sources} />);
    assertColumns();
    // The setup board has no IB Gateway/holdings/balance dependency (AGENTS.md).
    expect(screen.queryByText('IB Gateway')).not.toBeInTheDocument();
    expect(screen.getByText('Kalshi contracts').closest('li')).toHaveTextContent(/Ready$/);
    expect(JSON.stringify(sources)).toBe(captured);
    view.rerender(<AnalystReviewSources reviewKind="prediction-markets-review" sources={{ state: 'failed', items: items.map(item => ({ ...item, status: 'unavailable' })) }} />);
    assertColumns();
    expect(screen.getAllByRole('button', { name: /Show explanation/ })).toHaveLength(items.length);
    expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  } finally {
    style.remove();
  }
});

test('source rows and header keep the same structure through pending, ready and failed acquisition', () => {
  const items = reviewSourceDisplayItems(pendingReviewSourceItems('portfolio-review'));
  const view = render(<AnalystReviewSources reviewKind="portfolio-review" loading phase="Gathering sources…" />);
  const section = screen.getByRole('region', { name: 'Review sources' });
  const heading = section.querySelector('header');
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(items.length);
  const labels = rows.map(row => row.querySelector('.analyst-review-source-label'));
  expect(within(heading).getByRole('status', { name: 'Response running' })).toHaveTextContent('Gathering sources…');
  expect(screen.queryByText('Checking sources…')).not.toBeInTheDocument();
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ state: 'complete', items: items.map(item => ({
    ...item, status: 'ready', observedAt: '2026-09-18T17:05:00Z',
  })) }} />);
  expect(section.querySelector('header')).toBe(heading);
  expect(screen.getAllByRole('listitem')).toEqual(rows);
  expect(rows.map(row => row.querySelector('.analyst-review-source-label'))).toEqual(labels);
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ state: 'failed', items }} phase="Gathering sources…" />);
  expect(screen.getAllByRole('listitem')).toEqual(rows);
  expect(section).toHaveAttribute('aria-busy', 'false');
  expect(screen.getAllByText('Unavailable')).toHaveLength(items.length);
  expect(screen.queryByText('Checking')).not.toBeInTheDocument();
  expect(screen.queryByText('Gathering sources…')).not.toBeInTheDocument();
});

test.each(['queued', 'accepted', 'preparing', 'running', 'checking'])('%s source metadata keeps the loading roster in place before any captured rows arrive', state => {
  const view = render(<AnalystReviewSources reviewKind="portfolio-review" loading />);
  const section = screen.getByRole('region', { name: 'Review sources' });
  const list = screen.getByRole('list');
  const rows = screen.getAllByRole('listitem');
  expect(screen.getByText('Portfolio research archive').closest('li')).toHaveTextContent('Checking');
  const sources = { basis: 'review', runId: 'new-run', state, items: [] };
  const captured = JSON.stringify(sources);
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getByRole('list')).toBe(list);
  expect(screen.getAllByRole('listitem')).toEqual(rows);
  expect(section).toHaveAttribute('aria-busy', 'true');
  expect(screen.getAllByText('Checking')).toHaveLength(rows.length);
  expect(screen.queryByText(/Unavailable|UNAVAILABLE/)).not.toBeInTheDocument();
  expect(JSON.stringify(sources)).toBe(captured);
});

test('partial acquisition fills reserved rows in place and preserves explicit failed evidence', () => {
  const items = reviewSourceDisplayItems(pendingReviewSourceItems('portfolio-review'));
  const view = render(<AnalystReviewSources reviewKind="portfolio-review" loading />);
  const rows = screen.getAllByRole('listitem');
  const sources = { basis: 'review', runId: 'new-run', state: 'running', items: [
    { id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: '2026-10-08T16:05:00Z' },
    { id: 'portfolioBalance', label: 'IBKR account exposure', status: 'unavailable' },
  ] };
  const captured = JSON.stringify(sources);
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getAllByRole('listitem')).toEqual(rows);
  expect(within(rows[0]).getByText('Ready')).toBeVisible();
  expect(screen.queryByText('IBKR account exposure')).not.toBeInTheDocument();
  expect(screen.getAllByText('Checking')).toHaveLength(items.length - 1);
  expect(screen.getByText('Portfolio research archive').closest('li')).toHaveTextContent('Checking');
  expect(JSON.stringify(sources)).toBe(captured);
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ ...sources, state: 'complete',
    items: items.map(item => ({ ...item, status: 'ready', observedAt: '2026-10-08T16:05:00Z' })) }} />);
  expect(screen.getAllByRole('listitem')).toEqual(rows);
  expect(screen.getAllByText('Ready')).toHaveLength(items.length);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'false');
});

test('an active source response without a known review roster stays checking rather than announcing failure', () => {
  const view = render(<AnalystReviewSources sources={{ state: 'running', items: [] }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking sources…');
  view.rerender(<AnalystReviewSources sources={{ state: 'failed', items: [] }} />);
  expect(screen.getByRole('status')).toHaveTextContent('UNAVAILABLE');
});

test('a settled capture with fewer recorded sources shrinks naturally without reserving empty rows', () => {
  const view = render(<AnalystReviewSources reviewKind="portfolio-review" loading />);
  const list = screen.getByRole('list');
  expect(list).not.toHaveAttribute('style');
  const sources = { conversationId: 'captured-conversation', state: 'failed', items: [{ id: 'portfolio', label: 'IBKR holdings', status: 'unavailable' }] };
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getByRole('list')).toBe(list);
  expect(list).not.toHaveAttribute('style');
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.queryByText('PCA model')).not.toBeInTheDocument();
});

test('review-source order stays consistent when acquisition publishes captured rows in a different order', () => {
  const sources = { items: [
    { id: 'portfolioPca', label: 'PCA model', status: 'unavailable' },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-09-18' },
    { id: 'hedgai-signals', label: 'HedgAI Signals', status: 'ready', publishedAt: '2026-09-18' },
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable' },
  ] };
  const captured = JSON.stringify(sources);
  render(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getAllByRole('listitem').map(row => row.querySelector('.analyst-review-source-label').textContent))
    .toEqual(['IB Gateway', 'HedgAI Signals', 'Risk Ranges', 'PCA model']);
  expect(JSON.stringify(sources)).toBe(captured);
});

test.each(['succeeded', 'complete', 'failed', 'cancelled', 'interrupted'])('terminal %s captures do not leave unresolved source rows checking', state => {
  const sources = { state, runId: 'captured-run', items: [{ id: 'portfolioPca', label: 'PCA model', status: 'checking' }] };
  const captured = JSON.stringify(sources);
  render(<AnalystReviewSources sources={sources} loading phase="Gathering sources…" />);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'false');
  expect(screen.getByText('Unavailable')).toBeVisible();
  expect(screen.queryByText('Checking')).not.toBeInTheDocument();
  expect(JSON.stringify(sources)).toBe(captured);
});

test('a stopped read ends busy presentation and leaves unfinished rows Not checked, never Checking or Unavailable', () => {
  const sources = { state: 'running', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-18T17:05:00Z' },
    { id: 'portfolioPca', label: 'PCA model', status: 'checking' },
    { id: 'ibGateway', label: 'IB Gateway', status: 'checking' },
  ] };
  render(<AnalystReviewSources sources={sources} readFailed phase="Gathering sources…" />);
  const section = screen.getByRole('region', { name: 'Review sources' });
  expect(section).toHaveAttribute('aria-busy', 'false');
  expect(screen.getByText('Ready')).toBeVisible();
  expect(screen.getByText('Sep 18 10:05 PDT')).toBeVisible();
  for (const label of ['PCA model', 'IB Gateway']) {
    const row = screen.getByText(label).closest('li');
    expect(row.querySelector('.analyst-review-source-status')).toHaveTextContent(/^Not checked$/);
    expect(row).toHaveClass('is-unchecked');
    expect(row).not.toHaveTextContent(/Checking|Unavailable|Disconnected|Unverified/);
  }
  expect(section.querySelector('header')).toHaveTextContent('Unavailable');
  expect(screen.queryByRole('button', { name: /Show explanation/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Gathering sources…')).not.toBeInTheDocument();
});

test('Sources without rows never synthesize Unavailable account rows or an Unverified Gateway', () => {
  const statusOf = label => screen.getByText(label).closest('li').querySelector('.analyst-review-source-status');
  const view = render(<AnalystReviewSources reviewKind="portfolio-review" sources={{ state: 'running' }} readFailed />);
  // A failed read checked nothing: unfinished rows read Not checked.
  expect(statusOf('IB Gateway')).toHaveTextContent(/^Not checked$/);
  expect(statusOf('Risk Ranges')).toHaveTextContent(/^Not checked$/);
  expect(screen.getByRole('list')).not.toHaveTextContent(/Unavailable|Unverified|Disconnected|Checking/);
  // Only a capture the server settled without rows reports its sources missing.
  view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ state: 'failed' }} />);
  expect(statusOf('IB Gateway')).toHaveTextContent(/^Not checked$/);
  expect(statusOf('Risk Ranges')).toHaveTextContent(/^Missing$/);
  expect(screen.getByRole('list')).not.toHaveTextContent(/Unavailable|Unverified|Disconnected|Checking/);
  // Only a capture that recorded the pause lists the alpha-code row, as Pending.
  view.rerender(<AnalystReviewSources reviewKind="prediction-markets-review" sources={{ state: 'failed' }} />);
  expect(statusOf('Monthly Inflation Nowcast')).toHaveTextContent(/^Missing$/);
  expect(screen.queryByText('Alpha codes')).not.toBeInTheDocument();
});

test('a transient read failure keeps unfinished rows checking and shows Reconnecting in the progress cell', () => {
  const style = document.createElement('style');
  style.textContent = require('fs').readFileSync(require('path').join(__dirname, 'AnalystReviewSources.css'), 'utf8');
  document.head.appendChild(style);
  try {
    const sources = { basis: 'review', state: 'running', items: [
      { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-18T17:05:00Z' },
      { id: 'portfolioPca', label: 'PCA model', status: 'checking' },
    ] };
    const view = render(<AnalystReviewSources sources={sources} loading reconnecting phase="Gathering sources…" />);
    const section = screen.getByRole('region', { name: 'Review sources' });
    const row = screen.getByText('PCA model').closest('li');
    expect(section).toHaveAttribute('aria-busy', 'true');
    expect(row).toHaveTextContent('Checking');
    expect(row).toHaveClass('is-checking');
    expect(row.querySelector('.analyst-spinner')).not.toBeNull();
    expect(section.querySelector('header')).toHaveTextContent('Reconnecting…');
    expect(screen.queryByText(/Unavailable|Gathering sources…/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show explanation/ })).not.toBeInTheDocument();
    view.rerender(<AnalystReviewSources sources={sources} loading phase="Gathering sources…" />);
    expect(within(section.querySelector('header')).getByRole('status', { name: 'Response running' })).toHaveTextContent('Gathering sources…');
    view.rerender(<AnalystReviewSources sources={{ ...sources, state: 'failed' }} reconnecting phase="Gathering sources…" />);
    expect(row).toHaveTextContent('Unavailable');
    expect(section).toHaveAttribute('aria-busy', 'false');
    expect(getComputedStyle(row.querySelector('svg')).animation).not.toMatch(/analyst-spin/);
    expect(section.querySelector('header')).not.toHaveTextContent(/Reconnecting|Gathering/);
  } finally {
    style.remove();
  }
});

test('older captures with duplicate source products preserve the final captured overlay once', () => {
  const sources = { items: [
    { id: 'hedgai-signals', label: 'HedgAI Signals', status: 'missing' },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-09-28' },
    { id: 'hedgai-signals', label: 'HedgAI Signals', status: 'ready', publishedAt: '2026-09-28T12:43:00Z' },
  ] };
  const original = JSON.stringify(sources);
  render(<AnalystReviewSources sources={sources} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getAllByText('HedgAI Signals')).toHaveLength(1);
  expect(screen.getByText('2/2 ready')).toBeInTheDocument();
  expect(screen.getByText('Sep 28 05:43 PDT')).toHaveAttribute('datetime', '2026-09-28T12:43:00Z');
  expect(JSON.stringify(sources)).toBe(original);
});

test('shows every source with its readiness and original source timestamp', () => {
  render(<AnalystReviewSources sources={{
    runId: 'review-1', checkedAt: '2026-09-18T21:00:00Z',
    items: [
      { id: 'holdings', label: 'Portfolio holdings', status: 'ready', observedAt: '2026-09-18T17:05:00Z' },
      { id: 'risk', label: 'Risk Ranges', status: 'missing', observedAt: null, detail: 'Today’s publication has not arrived.' },
      { id: 'orders', label: 'Open orders', status: 'checking', observedAt: null },
      { id: 'markets', label: 'Prediction markets', status: 'unavailable', observedAt: null },
    ],
  }} />);
  expect(screen.getByRole('heading', { name: 'Sources' })).toBeInTheDocument();
  expect(screen.getByText('1/4 ready')).toBeInTheDocument();
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(4);
  expect(within(rows[0]).getByText('Ready')).toBeInTheDocument();
  expect(within(rows[0]).getByText('Sep 18 10:05 PDT')).toHaveAttribute('datetime', '2026-09-18T17:05:00Z');
  expect(within(rows[1]).getByText('Missing')).toBeInTheDocument();
  expect(rows[1]).toHaveClass('is-missing');
  expect(rows[1]).toHaveAttribute('title', 'Today’s publication has not arrived.');
  expect(within(rows[2]).getByText('Checking')).toBeInTheDocument();
  expect(within(rows[3]).getByText('Unavailable')).toBeInTheDocument();
  expect(screen.queryByText(/14:00|AM|PM/)).not.toBeInTheDocument();
});

test('never uses the check time when a source observation is missing or invalid', () => {
  render(<AnalystReviewSources sources={{
    checkedAt: '2026-09-18T21:00:00Z',
    items: [
      { id: 'risk', label: 'Risk Ranges', status: 'missing', observedAt: 'not-a-date' },
      { id: 'holdings', label: 'Portfolio holdings', status: 'offline' },
    ],
  }} />);
  expect(screen.getByText('0/2 ready')).toBeInTheDocument();
  expect(screen.getAllByLabelText('Source time unavailable')).toHaveLength(2);
  expect(screen.getByText('Missing').closest('li')).toHaveTextContent('Risk Ranges');
  expect(screen.getByText('Unavailable').closest('li')).toHaveTextContent('Portfolio holdings');
  expect(screen.queryByText(/Sep 18/)).not.toBeInTheDocument();
});

test('partial archive shows its original capture and retained coverage without claiming readiness', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial', observedAt: '2026-09-18T17:05:00Z',
      detail: 'Complete available archive scan; 2 products with archived gaps', diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL' } },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-09-18' },
  ] }} />);
  expect(screen.getByText('1/2 ready')).toBeVisible();
  const archive = screen.getAllByRole('listitem')[0];
  expect(within(archive).getByText('Partial')).toBeVisible();
  expect(archive).toHaveClass('is-partial');
  expect(archive).toHaveAttribute('title', 'Complete available archive scan; 2 products with archived gaps');
  expect(within(archive).getByText('Sep 18 10:05 PDT')).toHaveAttribute('datetime', '2026-09-18T17:05:00Z');
  expect(within(archive).queryByText('Ready')).not.toBeInTheDocument();
  expect(screen.queryByText(/ARCHIVE_PARTIAL|Recovered/)).not.toBeInTheDocument();
});

test('preserves date-only publications and displays midnight as 00:00 without AM or PM', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'publication', label: 'Early Look', status: 'ready', publishedAt: '2026-09-18' },
    { id: 'holdings', label: 'Portfolio holdings', status: 'ready', observedAt: '2026-09-18T07:00:00Z' },
  ] }} />);
  expect(screen.getByText('Sep 18')).toHaveAttribute('datetime', '2026-09-18');
  expect(screen.getByText('Sep 18 00:00 PDT')).toBeInTheDocument();
  expect(screen.queryByText(/AM|PM|24:00/)).not.toBeInTheDocument();
});

test('uses an exact publication timestamp when the observation only supplies a date', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'holdings', label: 'IBKR holdings', status: 'ready', observedAt: '2026-09-18T17:25:00Z' },
    { id: 'risk', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-18', publishedAt: '2026-09-18T08:12:00-04:00' },
    { id: 'nowcast', label: 'Monthly Inflation Nowcast', status: 'ready', observedAt: '2026-09-18', publishedAt: '2026-09-18T13:01:24Z' },
  ] }} />);
  expect(screen.getByText('Sep 18 10:25 PDT')).toHaveAttribute('datetime', '2026-09-18T17:25:00Z');
  expect(screen.getByText('Sep 18 05:12 PDT')).toHaveAttribute('datetime', '2026-09-18T08:12:00-04:00');
  expect(screen.getByText('Sep 18 06:01 PDT')).toHaveAttribute('datetime', '2026-09-18T13:01:24Z');
  expect(screen.queryByText('Sep 18')).not.toBeInTheDocument();
});

test('keeps exact observations first and does not infer source times without a timezone', () => {
  render(<AnalystReviewSources sources={{ checkedAt: '2026-09-18T21:00:00Z', items: [
    { id: 'holdings', label: 'IBKR holdings', status: 'ready', observedAt: '2026-09-18T17:25:00Z', publishedAt: '2026-09-18T13:01:24Z' },
    { id: 'date-only', label: 'CFTC Positioning', status: 'ready', observedAt: '2026-09-15', publishedAt: '2026-09-15T10:00:00' },
    { id: 'unknown', label: 'Risk Ranges', status: 'unavailable', publishedAt: '2026-09-18T08:12:00' },
  ] }} />);
  expect(screen.getByText('Sep 18 10:25 PDT')).toBeInTheDocument();
  expect(screen.getByText('Sep 15')).toHaveAttribute('datetime', '2026-09-15');
  expect(screen.getByLabelText('Source time unavailable')).toBeInTheDocument();
  expect(screen.queryByText(/06:01|14:00|10:00|08:12/)).not.toBeInTheDocument();
});

test('shows a concise checking state before sources arrive and unavailable after a failed check', () => {
  const view = render(<AnalystReviewSources loading />);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Checking sources…');
  view.rerender(<AnalystReviewSources />);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'false');
  expect(screen.getByRole('status')).toHaveTextContent('UNAVAILABLE');
  expect(screen.queryByText(/ready/)).not.toBeInTheDocument();
});

test('formats ready capture timestamps consistently and keeps their provenance in secondary detail', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'marketSituation', label: 'Market data', status: 'ready', observedAt: '2026-09-19T14:59:43Z', publishedAt: '2026-09-18', timestampKind: 'review-captured', detail: 'Review capture; source data through 2026-09-18' },
    { id: 'market-situation-report', label: 'Market Situation Report', status: 'ready', observedAt: '2026-09-18T10:30:42+00:00', publishedAt: '2026-09-18', timestampKind: 'captured' },
    { id: 'date-only', label: 'Date-only source', status: 'ready', observedAt: '2026-09-18', timestampKind: 'captured' },
  ] }} />);
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Sep 19 07:59 PDT');
  expect(rows[0]).toHaveAttribute('title', 'Review capture; source data through 2026-09-18');
  expect(within(rows[0]).getByText('Sep 19 07:59 PDT')).toHaveAttribute('datetime', '2026-09-19T14:59:43Z');
  expect(rows[1]).toHaveTextContent('Sep 18 03:30 PDT');
  expect(screen.queryByText(/Captured/)).not.toBeInTheDocument();
});

test('formats ready PCA and CFTC clocks consistently while keeping their dated scope in tooltips', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'portfolioPca', label: 'PCA model', status: 'ready', observedAt: '2026-09-18T23:53:05.512Z', sessionDate: '2026-09-18', timestampKind: 'model-generated', detail: 'Model through 2026-09-18' },
    { id: 'cftc', label: 'CFTC Positioning', status: 'ready', observedAt: '2026-09-18T20:15:08.864659+00:00', publishedAt: '2026-09-15', timestampKind: 'captured', detail: 'Report date: 2026-09-15' },
  ] }} />);
  expect(screen.getByText('2/2 ready')).toBeVisible();
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('Sep 18 16:53 PDT')).toHaveAttribute('datetime', '2026-09-18T23:53:05.512Z');
  expect(rows[0]).toHaveAttribute('title', 'Model through 2026-09-18');
  expect(within(rows[1]).getByText('Sep 18 13:15 PDT')).toHaveAttribute('datetime', '2026-09-18T20:15:08.864659+00:00');
  expect(rows[1]).toHaveAttribute('title', 'Report date: 2026-09-15');
  for (const row of rows) expect(within(row).getByText('Ready')).toBeVisible();
  expect(screen.queryByText(/Captured|Checking|Unavailable|AM|PM/)).not.toBeInTheDocument();
});

test('unavailable and missing sources show dashes even when a failed attempt or prior publication has a date', () => {
  render(<AnalystReviewSources sources={{ basis: 'review', items: [
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable', observedAt: '2026-09-20T14:00:00Z' },
    { id: 'portfolioBalance', label: 'IBKR account exposure', status: 'unavailable', observedAt: '2026-09-20T14:00:00Z' },
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', status: 'unavailable' },
    { id: 'cftc', label: 'CFTC Positioning', status: 'missing', observedAt: '2026-09-18T20:15:00Z', publishedAt: '2026-09-18' },
    { id: 'pca', label: 'PCA model', status: 'offline', observedAt: '2026-09-19' },
  ] }} />);
  expect(screen.getByText('0/3 ready')).toBeVisible();
  for (const row of screen.getAllByRole('listitem')) {
    const missing = row.textContent.includes('CFTC Positioning');
    // Failed account requests alone never establish a Gateway disconnect.
    const expected = missing ? 'Missing' : row.textContent.includes('IB Gateway') ? 'Unverified' : 'Unavailable';
    expect(within(row).getByText(expected)).toBeVisible();
    expect(within(row).getByLabelText('Source time unavailable')).toHaveTextContent('—');
    expect(row.querySelector('time')).toBeNull();
    expect(row).toHaveClass(missing ? 'is-missing' : 'is-unavailable');
  }
  expect(screen.queryByText(/Sep 18|Sep 19|Sep 20/)).not.toBeInTheDocument();
});

test('does not infer a disconnected Gateway from a failed saved balance capture', () => {
  const items = [
    { id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: '2026-09-18T17:05:00Z', requiresIbGateway: true },
    { id: 'balance', label: 'IBKR balances', status: 'unavailable', requiresIbGateway: true },
    { id: 'risk', label: 'Risk Ranges', status: 'unavailable' },
  ];
  render(<AnalystReviewSources sources={{ basis: 'review', items }} />);
  expect(screen.getByText('1/2 ready')).toBeVisible();
  expect(within(screen.getAllByRole('listitem')[0]).getByText('Ready')).toBeVisible();
  expect(within(screen.getAllByRole('listitem')[1]).getByText('Unavailable')).toBeVisible();
  expect(screen.queryByText(/connect to IB Gateway/)).not.toBeInTheDocument();
});

test('one captured Gateway connection replaces account categories while keeping independent quote and research checks', () => {
  const sources = { basis: 'review', state: 'complete', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-08T16:00:00Z' },
    { id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: '2026-10-08T16:05:00Z' },
    { id: 'portfolioBalance', label: 'IBKR account exposure', status: 'unavailable' },
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', status: 'unavailable' },
    { id: 'gold', label: 'Gold · ForecastEx', status: 'unavailable', requiresIbGateway: true },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-10-08' },
  ] };
  const capture = JSON.stringify(sources);
  render(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  const gateway = screen.getByText('IB Gateway').closest('li');
  expect(within(gateway).getByText('Ready')).toBeVisible();
  expect(within(gateway).getByText('Oct 8 09:00 PDT')).toHaveAttribute('datetime', '2026-10-08T16:00:00Z');
  expect(screen.queryByText(/IBKR holdings|IBKR account exposure|IBKR open orders/)).not.toBeInTheDocument();
  expect(screen.getByText('Gold · ForecastEx').closest('li')).toHaveTextContent('Unavailable');
  expect(screen.getByText('2/3 ready')).toBeVisible();
  expect(JSON.stringify(sources)).toBe(capture);
});

test('a verified Gateway failure shows one Disconnected status and its captured explanation', () => {
  render(<AnalystReviewSources sources={{ state: 'failed', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', diagnostic: { code: 'IBKR_GATEWAY_NOT_CONNECTED',
      reason: 'The Gateway connection was disconnected at capture.', remedy: 'Sign in to IB Gateway, then refresh.' } },
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable' },
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', status: 'unavailable' },
  ] }} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'IB Gateway: Disconnected. Show explanation' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('The Gateway connection was disconnected at capture.');
  expect(screen.getByRole('dialog')).toHaveTextContent('Sign in to IB Gateway, then refresh.');
});


test('source display switches to PST in winter and highlights each verified date', () => {
  render(<AnalystReviewSources sources={{ items: [
    { id: 'holdings', label: 'IBKR holdings', status: 'ready', observedAt: '2026-01-05T07:15:00Z' },
    { id: 'publication', label: 'Early Look', status: 'ready', publishedAt: '2026-01-05' },
  ] }} />);
  expect(screen.getByText('Jan 4 23:15 PST')).toHaveClass('analyst-process--key');
  expect(screen.getByText('Jan 5')).toHaveClass('analyst-process--key');
});

test('manual coverage uses compact archive dates with captured status and full details on hover', () => {
  const sources = { basis: 'indexed-research', detail: 'Available indexed archive; complete delivery was not verified.', items: [
    { id: 'bitcoin-tracker', label: 'Bitcoin Tracker', status: 'partial',
      publicationLabel: 'Archive: Jan 30, 2026; coverage monitor: Oct 5, 2026. Partial provenance.' },
    { id: 'cftc-positioning', label: 'CFTC Positioning', status: 'late',
      publicationLabel: 'Archive: Sep 29, 2026; coverage monitor: Sep 22, 2026, marked late.' },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'indexed', publicationLabel: 'Oct 5, 2026' },
    { id: 'missing', label: 'Unavailable product', status: 'unavailable' },
  ] };
  const captured = JSON.stringify(sources);
  render(<AnalystReviewSources sources={sources} />);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('class', 'analyst-review-sources');
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('title', sources.detail);
  expect(screen.getByText('3/4 indexed')).toBeVisible();
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(4);
  expect(within(rows[0]).getByText('Jan 30', { exact: true })).toHaveClass('analyst-process--key');
  expect(rows[0]).toHaveAttribute('title', sources.items[0].publicationLabel);
  expect(rows[0]).not.toHaveTextContent(/Archive|coverage monitor|2026|Oct 5|provenance/);
  expect(within(rows[0]).getByText('Partial', { exact: true })).toBeVisible();
  expect(rows[0]).toHaveClass('is-partial');
  expect(within(rows[1]).getByText('Sep 29', { exact: true })).toHaveClass('analyst-process--key');
  expect(rows[1]).toHaveAttribute('title', sources.items[1].publicationLabel);
  expect(rows[1]).not.toHaveTextContent(/Archive|coverage monitor|2026|Sep 22|marked late/);
  expect(within(rows[1]).getByText('Late', { exact: true })).toBeVisible();
  expect(rows[1]).toHaveClass('is-late');
  expect(within(rows[2]).getByText('Indexed', { exact: true })).toBeVisible();
  expect(within(rows[2]).getByText('Oct 5', { exact: true })).toHaveClass('analyst-process--key');
  expect(rows[2]).toHaveClass('is-indexed');
  expect(within(rows[3]).getByText('Unavailable')).toBeVisible();
  expect(within(rows[3]).getByLabelText('Source time unavailable')).toHaveTextContent('—');
  expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText(/\bready\b|all-clear/i)).not.toBeInTheDocument();
  expect(JSON.stringify(sources)).toBe(captured);
});

test('indexed publication labels use Pacific time without substituting acquisition timestamps', () => {
  const sources = { basis: 'indexed-research', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'indexed',
      publicationLabel: 'Oct 5, 2026, 14:17 UTC', observedAt: '2027-01-05T20:00:00Z', publishedAt: '2027-01-05' },
    { id: 'early-look', label: 'Early Look', status: 'partial',
      publicationLabel: 'Jan 5, 2026, 07:15 UTC — partial provenance' },
  ] };
  const captured = JSON.stringify(sources);
  render(<AnalystReviewSources sources={sources} />);
  expect(screen.getByText('2/2 indexed')).toBeVisible();
  expect(screen.getByText('Oct 5 07:17 PDT')).toHaveClass('analyst-process--key');
  expect(screen.getByText('Jan 4 23:15 PST')).toHaveClass('analyst-process--key');
  expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('title', 'Jan 4, 2026 23:15 PST — partial provenance');
  expect(screen.getAllByRole('listitem')[1]).not.toHaveTextContent(/2026|provenance/);
  expect(screen.queryByText(/UTC|2027/)).not.toBeInTheDocument();
  expect(JSON.stringify(sources)).toBe(captured);
});

test('legacy indexed dates use the same compact dates without adding a year or time', () => {
  const sources = { basis: 'indexed-research', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'indexed', publicationLabel: '30 September' },
    { id: 'market-structure', label: 'Volume / Market Structure', status: 'indexed', publicationLabel: '20 March' },
  ] };
  render(<AnalystReviewSources sources={sources} />);
  expect(screen.getByText('Sep 30')).toBeVisible();
  expect(screen.getByText('Mar 20')).toBeVisible();
  expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('title', '30 September');
  expect(screen.getAllByRole('listitem')[1]).toHaveAttribute('title', '20 March');
  expect(screen.queryByText(/\b20\d{2}\b|PST|PDT/)).not.toBeInTheDocument();
  expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText('2/2 indexed')).toBeVisible();
});

test('manual and Portfolio Sources share exactly the same container and date-status grid', () => {
  const view = render(<AnalystReviewSources sources={{ basis: 'review', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-10-05' },
  ] }} />);
  const portfolioSection = screen.getByRole('region', { name: 'Review sources' });
  const portfolioListClass = portfolioSection.querySelector('ul').className;
  const portfolioHeadingClass = portfolioSection.querySelector('header').className;
  const portfolioCellClasses = [...screen.getByRole('listitem').children].map(cell => cell.className);
  expect(portfolioSection).toHaveAttribute('class', 'analyst-review-sources');
  expect(portfolioCellClasses).toEqual(['analyst-review-source-label', 'analyst-review-source-time', 'analyst-review-source-status']);

  view.rerender(<AnalystReviewSources sources={{ basis: 'indexed-research', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'indexed', publicationLabel: 'Oct 5, 2026 in archive; current monitor dated Sep 30, 2026.' },
  ] }} />);
  const manualSection = screen.getByRole('region', { name: 'Review sources' });
  const manualRow = screen.getByRole('listitem');
  expect(manualSection).toHaveAttribute('class', 'analyst-review-sources');
  expect(manualSection.querySelector('ul')).toHaveAttribute('class', portfolioListClass);
  expect(manualSection.querySelector('header')).toHaveAttribute('class', portfolioHeadingClass);
  expect([...manualRow.children].map(cell => cell.className)).toEqual(portfolioCellClasses);
  expect(within(manualRow).getByText('Oct 5', { exact: true })).toHaveClass('analyst-process--key');
  expect(manualRow).toHaveAttribute('title', 'Oct 5, 2026 in archive; current monitor dated Sep 30, 2026.');
  expect(manualRow).not.toHaveTextContent(/2026|Sep 30|archive|monitor/);
  expect(within(manualRow).getByText('Indexed', { exact: true })).toBeVisible();
  expect(screen.getByText('1/1 indexed')).toBeVisible();
  expect(screen.queryByText('Ready', { exact: true })).not.toBeInTheDocument();
});

test('partial source opens its captured explanation and evidenced remedy without changing readiness or dates', () => {
  const sources = { runId: 'saved-capture', items: [
    { id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial', observedAt: '2026-09-18T17:05:00Z',
      detail: 'Two archived publications could not be verified.', diagnostic: { remedy: 'Reimport the two affected publications and verify their captured content.' } },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-09-18' },
  ] };
  const original = JSON.stringify(sources);
  render(<AnalystReviewSources sources={sources} />);
  const status = screen.getByRole('button', { name: 'Portfolio research archive: Partial. Show explanation' });
  expect(status).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(status);
  const explanation = screen.getByRole('dialog', { name: 'Portfolio research archive · Partial' });
  expect(status).toHaveAttribute('aria-expanded', 'true');
  expect(status).toHaveAttribute('aria-controls', explanation.id);
  expect(within(explanation).getByText('Two archived publications could not be verified.')).toBeVisible();
  expect(within(explanation).getByText(/Reimport the two affected publications/)).toBeVisible();
  expect(screen.getByText('1/2 ready')).toBeVisible();
  expect(screen.getByText('Sep 18 10:05 PDT')).toHaveAttribute('datetime', '2026-09-18T17:05:00Z');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(JSON.stringify(sources)).toBe(original);
});

test('keyboard opens the explanation and Escape returns focus without closing the Analyst', async () => {
  const closeAnalyst = jest.fn();
  window.addEventListener('keydown', closeAnalyst);
  try {
    render(<AnalystReviewSources sources={{ items: [{ id: 'interestStatus', label: 'Interest accruals', status: 'unavailable', detail: 'The captured balance request timed out.' }] }} />);
    const status = screen.getByRole('button', { name: 'Interest accruals: Unavailable. Show explanation' });
    await userEvent.tab();
    expect(status).toHaveFocus();
    // user-event 13 uses a separate DOM event wrapper; React must flush the native button activation.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => { await userEvent.keyboard('{Enter}'); });
    expect(screen.getByRole('dialog', { name: 'Interest accruals · Unavailable' })).toHaveFocus();
    closeAnalyst.mockClear();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(status).toHaveFocus();
    expect(status).toHaveAttribute('aria-expanded', 'false');
    expect(closeAnalyst).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', closeAnalyst);
  }
});

test('same status toggles its popup, another source replaces it, and outside controls retain their action', () => {
  const outsideAction = jest.fn();
  render(<><AnalystReviewSources sources={{ items: [
    { id: 'archive', label: 'Research archive', status: 'partial' },
    { id: 'interestStatus', label: 'Interest accruals', status: 'unavailable' },
  ] }} /><button type="button" onClick={outsideAction}>Outside control</button></>);
  const partial = screen.getByRole('button', { name: 'Research archive: Partial. Show explanation' });
  const unavailable = screen.getByRole('button', { name: 'Interest accruals: Unavailable. Show explanation' });
  fireEvent.click(partial);
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Research archive · Partial');
  fireEvent.click(partial);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(partial);
  fireEvent.click(unavailable);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Interest accruals · Unavailable');
  expect(partial).toHaveAttribute('aria-expanded', 'false');
  const outside = screen.getByRole('button', { name: 'Outside control' });
  fireEvent.mouseDown(outside);
  fireEvent.click(outside);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(outsideAction).toHaveBeenCalledTimes(1);
});

test('close button returns focus and missing diagnostics do not invent a Gateway failure or remedy', () => {
  render(<AnalystReviewSources sources={{ items: [{ id: 'interestStatus', label: 'Interest accruals', status: 'offline',
    diagnostic: { code: 'BALANCE_TIMEOUT', message: 'Unverified provider claim' } }] }} />);
  const status = screen.getByRole('button', { name: 'Interest accruals: Unavailable. Show explanation' });
  fireEvent.click(status);
  const explanation = screen.getByRole('dialog');
  expect(explanation).toHaveTextContent('This source was not verified for this review.');
  expect(explanation).toHaveTextContent('The cause and required fix have not yet been verified.');
  expect(explanation).not.toHaveTextContent(/Gateway|BALANCE_TIMEOUT|Unverified provider claim/);
  expect(screen.getByLabelText('Source time unavailable')).toHaveTextContent('—');
  fireEvent.click(within(explanation).getByRole('button', { name: 'Close source explanation' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(status).toHaveFocus();
});

test('a different capture or a changed source status cannot keep an earlier explanation open', () => {
  const first = { conversationId: 'chat', runId: 'first-capture', items: [{ id: 'interestStatus', label: 'Interest accruals', status: 'unavailable', detail: 'Original captured failure.' }] };
  const view = render(<AnalystReviewSources sources={first} />);
  fireEvent.click(screen.getByRole('button', { name: /Interest accruals: Unavailable/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Original captured failure.');
  view.rerender(<AnalystReviewSources sources={{ ...first, runId: 'next-capture', items: [{ ...first.items[0], detail: 'Different capture.' }] }} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Interest accruals: Unavailable/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Different capture.');
  view.rerender(<AnalystReviewSources sources={{ ...first, runId: 'next-capture', items: [{ ...first.items[0], status: 'ready', observedAt: '2026-09-18T17:05:00Z' }] }} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Show explanation/ })).not.toBeInTheDocument();
  expect(screen.getByText('1/1 ready')).toBeVisible();
});

test('indexed partial coverage explains its original publication detail while retaining compact dates', () => {
  render(<AnalystReviewSources sources={{ basis: 'indexed-research', items: [{ id: 'early-look', label: 'Early Look', status: 'partial',
    publicationLabel: 'Jan 5, 2026, 07:15 UTC — partial provenance', diagnostic: { remedy: 'Verify the original publication provenance.' } }] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Early Look: Partial. Show explanation' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('Jan 4, 2026 23:15 PST — partial provenance');
  expect(screen.getByRole('dialog')).toHaveTextContent('Verify the original publication provenance.');
  expect(screen.getByText('Jan 4 23:15 PST')).toHaveClass('analyst-process--key');
  expect(screen.getByText('1/1 indexed')).toBeVisible();
});

test('structured diagnostic reason and remedy explain a source without a captured detail', () => {
  render(<AnalystReviewSources sources={{ items: [{ id: 'signal-strength', label: 'Signal Strength', status: 'unavailable',
    diagnostic: { reason: 'No eligible publication was present in this review’s capture.',
      remedy: 'Verify publication delivery, then refresh this review to capture the latest research.' } }] }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Signal Strength: Unavailable. Show explanation' }));
  const explanation = screen.getByRole('dialog');
  expect(explanation).toHaveTextContent('No eligible publication was present in this review’s capture.');
  expect(explanation).toHaveTextContent('Verify publication delivery, then refresh this review to capture the latest research.');
  expect(explanation).not.toHaveTextContent('This source was not verified for this review.');
});

test('specific partial diagnosis takes precedence over summary detail without changing the original row tooltip', () => {
  render(<AnalystReviewSources sources={{ items: [{ id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial',
    detail: 'Complete available archive scan; 2 products with archived gaps',
    diagnostic: { reason: 'Two captured publications have incomplete provenance.', remedy: 'Verify the original publication provenance.' } }] }} />);
  const row = screen.getByRole('listitem');
  expect(row).toHaveAttribute('title', 'Complete available archive scan; 2 products with archived gaps');
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio research archive: Partial. Show explanation' }));
  const explanation = screen.getByRole('dialog');
  expect(explanation).toHaveTextContent('Two captured publications have incomplete provenance.');
  expect(explanation).not.toHaveTextContent('Complete available archive scan');
  expect(row).toHaveAttribute('title', 'Complete available archive scan; 2 products with archived gaps');
});

test('settled missing rows show their captured reason in one short gray word with the same status grid', () => {
  const style = document.createElement('style');
  style.textContent = require('fs').readFileSync(require('path').join(__dirname, 'AnalystReviewSources.css'), 'utf8');
  document.head.appendChild(style);
  try {
    const missing = (id, code) => ({ id, label: `Source ${id}`, status: 'missing', ...(code ? { diagnostic: { code } } : {}) });
    const sources = { basis: 'review', state: 'partial', items: [
      { id: 'ready', label: 'Source ready', status: 'ready', publishedAt: '2026-10-09' },
      missing('late', 'RESEARCH_PUBLICATION_LATE'), missing('absent', 'RESEARCH_PUBLICATION_MISSING'),
      missing('rejected', 'RESEARCH_PUBLICATION_REJECTED'), missing('not-captured', 'RESEARCH_PUBLICATION_NOT_CAPTURED'),
      missing('not-attempted', 'SOURCE_NOT_ATTEMPTED'), missing('incomplete', 'SOURCE_CHECK_INCOMPLETE'),
      missing('unverified-gateway', 'IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED'), missing('not-due', 'RESEARCH_NOT_DUE'),
      missing('uncoded'), missing('unknown', 'SOME_FUTURE_CODE'),
    ] };
    const captured = JSON.stringify(sources);
    render(<AnalystReviewSources sources={sources} />);
    const status = id => screen.getByText(`Source ${id}`).closest('li');
    expect(status('late')).toHaveTextContent('Late');
    for (const id of ['absent', 'rejected', 'not-captured', 'uncoded', 'unknown']) expect(status(id)).toHaveTextContent(/Missing$/);
    for (const id of ['not-attempted', 'incomplete', 'unverified-gateway']) expect(status(id)).toHaveTextContent(/Not checked$/);
    expect(status('not-due')).toHaveTextContent(/Not due$/);
    // Not-due publications are not expected yet, so they do not lower readiness.
    expect(screen.getByText('1/10 ready')).toBeVisible();
    for (const row of screen.getAllByRole('listitem')) {
      expect([...row.children].map(cell => cell.className)).toEqual([
        'analyst-review-source-label', 'analyst-review-source-time', 'analyst-review-source-status']);
      const content = row.querySelector('.analyst-review-source-status-content');
      expect(content.children[0].tagName.toLowerCase()).toBe('svg');
      expect(content.children[0]).toHaveAttribute('width', '12');
      expect(getComputedStyle(content).gridTemplateColumns).toBe('12px minmax(0, 1fr)');
      expect(row).not.toHaveTextContent('Unavailable');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Source late: Late. Show explanation' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Source late · Late');
    expect(JSON.stringify(sources)).toBe(captured);
  } finally {
    style.remove();
  }
});

test('paused, optional and settled not-due sources stay visible without counting against readiness', () => {
  const sources = { basis: 'review', state: 'complete', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-10-09' },
    { id: 'portfolioPca', label: 'PCA model', status: 'pending', detail: 'Paused for now. This source returns when it is re-enabled.',
      diagnostic: { code: 'SOURCE_PAUSED' } },
    { id: 'macro-show', label: 'Macro Show', status: 'missing', optional: true },
    { id: 'early-look', label: 'Early Look', status: 'missing', diagnostic: { code: 'RESEARCH_NOT_DUE' } },
    { id: 'the-call', label: 'The Call', status: 'missing', diagnostic: { code: 'RESEARCH_PUBLICATION_LATE' } },
  ] };
  render(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} />);
  expect(screen.getByText('1/2 ready')).toBeVisible();
  const pca = screen.getByText('PCA model').closest('li');
  expect(pca).toHaveTextContent(/Pending$/);
  expect(pca).toHaveClass('is-pending');
  expect(pca).toHaveAttribute('title', 'Paused for now. This source returns when it is re-enabled.');
  expect(within(pca).getByLabelText('Source time unavailable')).toHaveTextContent('—');
  expect(within(pca).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(5);
});

test('a saved pre-board Predictive capture keeps its paused alpha-code scan as Pending without counting against readiness', () => {
  const roster = pendingReviewSourceItems('prediction-markets-review');
  const labels = () => screen.getAllByRole('listitem').map(row => row.querySelector('.analyst-review-source-label').textContent);
  const view = render(<AnalystReviewSources reviewKind="prediction-markets-review" loading phase="Gathering sources…" />);
  // The setup board no longer uses alpha codes (AGENTS.md); only a saved
  // pre-board capture still carries the paused row, after the current roster.
  expect(labels()).not.toContain('Alpha codes');
  const items = [...roster.map(item => ({ ...item, status: 'ready', observedAt: '2026-10-08T16:05:00Z' })),
    { id: 'alphaCodes', label: 'Alpha codes', status: 'pending', observedAt: null, diagnostic: { code: 'SOURCE_PAUSED' } }];
  view.rerender(<AnalystReviewSources reviewKind="prediction-markets-review" sources={{ basis: 'review', state: 'succeeded', items }} />);
  expect(labels()).toEqual([...roster.map(item => item.label), 'Alpha codes']);
  const alpha = screen.getByText('Alpha codes').closest('li');
  expect(alpha).toHaveTextContent(/Pending$/);
  expect(within(alpha).queryByRole('button')).not.toBeInTheDocument();
  const counted = reviewSourceDisplayItems(items).filter(item => item.status !== 'pending').length;
  expect(screen.getByText(`${counted}/${counted} ready`)).toBeVisible();
});

test('an IB Gateway check that failed without a verified disconnect reads Unverified, never Disconnected', () => {
  const view = render(<AnalystReviewSources sources={{ basis: 'review', state: 'failed', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', connectionState: 'unverified',
      diagnostic: { code: 'IBKR_GATEWAY_READINESS_TIMEOUT', reason: 'The readiness check timed out. This does not establish a disconnect.' } },
  ] }} />);
  const gateway = screen.getByText('IB Gateway').closest('li');
  expect(gateway).toHaveTextContent(/Unverified$/);
  expect(gateway).not.toHaveTextContent(/Disconnected|Unavailable/);
  fireEvent.click(within(gateway).getByRole('button', { name: 'IB Gateway: Unverified. Show explanation' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('This does not establish a disconnect.');
  view.rerender(<AnalystReviewSources sources={{ basis: 'review', runId: 'next-capture', state: 'failed', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', connectionState: 'disconnected',
      diagnostic: { code: 'IBKR_GATEWAY_NOT_CONNECTED' } },
  ] }} />);
  expect(screen.getByText('IB Gateway').closest('li')).toHaveTextContent(/Disconnected$/);
});

test('after a verified disconnect the Gateway-dependent ForecastEx book reads Unavailable, never Not checked', () => {
  render(<AnalystReviewSources reviewKind="prediction-markets-review" sources={{ basis: 'review', state: 'failed', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', connectionState: 'disconnected', diagnostic: { code: 'GATEWAY_UNAVAILABLE' } },
    { id: 'silver', label: 'Silver · ForecastEx', status: 'unavailable', requiresIbGateway: true, diagnostic: { code: 'GATEWAY_UNAVAILABLE' } },
    { id: 'gold', label: 'Gold · Kalshi', status: 'missing', diagnostic: { code: 'SOURCE_NOT_ATTEMPTED' } },
  ] }} />);
  const statusOf = label => screen.getByText(label).closest('li').querySelector('.analyst-review-source-status');
  expect(statusOf('IB Gateway')).toHaveTextContent(/^Disconnected$/);
  expect(statusOf('Silver · ForecastEx')).toHaveTextContent(/^Unavailable$/);
  expect(statusOf('Gold · Kalshi')).toHaveTextContent(/^Not checked$/);
});

test('the captured IB Gateway check shows its own duration in its hover detail', () => {
  render(<AnalystReviewSources sources={{ basis: 'review', state: 'succeeded', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-10-09T15:00:00Z', elapsedMs: 420 },
    { id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: '2026-10-09T15:00:02Z', elapsedMs: 900 },
  ] }} />);
  expect(screen.getByText('IB Gateway').closest('li'))
    .toHaveAttribute('title', 'IB Gateway connection verified when this review was captured. · Checked in 0.4 s');
});

test('settled rows add their captured check duration to the existing hover detail only', () => {
  render(<AnalystReviewSources sources={{ basis: 'review', state: 'running', items: [
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-10-09', detail: 'Captured publication', elapsedMs: 1400 },
    { id: 'cftc', label: 'CFTC Positioning', status: 'unavailable', elapsedMs: 64_000 },
    { id: 'early-look', label: 'Early Look', status: 'checking', elapsedMs: 2000 },
    { id: 'the-call', label: 'The Call', status: 'missing', elapsedMs: -5 },
    { id: 'signal', label: 'Signal Strength', status: 'ready', publishedAt: '2026-10-09', elapsedMs: 600_001 },
  ] }} />);
  const row = label => screen.getByText(label).closest('li');
  expect(row('Risk Ranges')).toHaveAttribute('title', 'Captured publication · Checked in 1.4 s');
  expect(row('CFTC Positioning')).toHaveAttribute('title', 'Checked in 1m 04s');
  expect(row('Early Look')).not.toHaveAttribute('title');
  expect(row('The Call')).not.toHaveAttribute('title');
  expect(row('Signal Strength')).not.toHaveAttribute('title');
  expect(screen.queryByText(/Checked in/)).not.toBeInTheDocument();
});

describe('Sources header clock', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-09T15:00:21.300Z')); });
  afterEach(() => { jest.useRealTimers(); });

  test('one hidden gray clock counts from the run start while acquiring and stops when the capture settles', () => {
    const interval = jest.spyOn(global, 'setInterval');
    try {
      const sources = { basis: 'review', runId: 'run', state: 'running', capturedAt: '2026-10-09T15:00:00Z', items: [
        { id: 'risk-ranges', label: 'Risk Ranges', status: 'checking' },
        { id: 'early-look', label: 'Early Look', status: 'checking' },
      ] };
      const view = render(<AnalystReviewSources reviewKind="portfolio-review" sources={sources} phase="Gathering sources…" />);
      const header = screen.getByRole('region', { name: 'Review sources' }).querySelector('header');
      const clock = () => header.querySelector('.analyst-review-sources-elapsed');
      expect(clock()).toHaveTextContent('21s');
      expect(clock()).toHaveAttribute('aria-hidden', 'true');
      expect(clock()).not.toHaveClass('analyst-process--key');
      expect(within(header).getByRole('status', { name: 'Response running' })).not.toHaveTextContent('21s');
      expect(screen.getAllByRole('listitem').every(row => !row.textContent.includes('21s'))).toBe(true);
      act(() => { jest.advanceTimersByTime(699); });
      expect(clock()).toHaveTextContent('21s');
      act(() => { jest.advanceTimersByTime(1); });
      expect(clock()).toHaveTextContent('22s');
      act(() => { jest.advanceTimersByTime(42_000); });
      expect(clock()).toHaveTextContent('1m 04s');
      expect(interval.mock.calls.filter(([, delay]) => delay === 1000)).toHaveLength(1);
      view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ ...sources, state: 'complete',
        items: sources.items.map(item => ({ ...item, status: 'ready', publishedAt: '2026-10-09' })) }} />);
      expect(clock()).toBeNull();
      act(() => { jest.advanceTimersByTime(5000); });
      expect(clock()).toBeNull();
    } finally { interval.mockRestore(); }
  });

  test('a running capture counts from its capture start and failed or loading reads show no clock', () => {
    const running = { basis: 'review', runId: 'run', state: 'acquiring', capturedAt: '2026-10-09T14:59:00Z',
      items: [{ id: 'risk-ranges', label: 'Risk Ranges', status: 'checking' }] };
    const view = render(<AnalystReviewSources reviewKind="portfolio-review" sources={running} />);
    const header = screen.getByRole('region', { name: 'Review sources' }).querySelector('header');
    expect(header.querySelector('.analyst-review-sources-elapsed')).toHaveTextContent('1m 21s');
    view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={running} readFailed />);
    expect(header.querySelector('.analyst-review-sources-elapsed')).toBeNull();
    view.rerender(<AnalystReviewSources reviewKind="portfolio-review" sources={{ basis: 'review', state: 'running', items: [] }} loading />);
    expect(header.querySelector('.analyst-review-sources-elapsed')).toBeNull();
  });
});

test('the header clock keeps counting through a model phase after Sources settle', () => {
  jest.useFakeTimers();
  try {
    jest.setSystemTime(new Date('2026-10-09T15:02:10.000Z'));
    const sources = { basis: 'review', runId: 'run', state: 'succeeded', capturedAt: '2026-10-09T15:00:00Z',
      items: [{ id: 'balance', label: 'IBKR balances', status: 'ready', observedAt: '2026-10-09T15:00:00Z' }] };
    const view = render(<AnalystReviewSources reviewKind="balance-review" sources={sources}
      phase="Summarizing…" modelPhase />);
    const header = screen.getByRole('region', { name: 'Review sources' }).querySelector('header');
    const clock = () => header.querySelector('.analyst-review-sources-elapsed');
    expect(clock()).toHaveTextContent('2m 10s');
    act(() => { jest.advanceTimersByTime(5000); });
    expect(clock()).toHaveTextContent('2m 15s');
    expect(screen.getAllByRole('status', { name: 'Response running' })).toHaveLength(1);
    // The written response ends the model phase and its clock.
    view.rerender(<AnalystReviewSources reviewKind="balance-review" sources={sources} phase="Summarizing…" />);
    expect(clock()).toBeNull();
  } finally { jest.useRealTimers(); }
});

test('a model phase after settled Sources stays in the header progress cell', () => {
  const sources = { basis: 'review', state: 'succeeded', items: [{ id: 'balance', label: 'IBKR balances', status: 'ready', observedAt: '2026-10-09T15:00:00Z' }] };
  const view = render(<AnalystReviewSources reviewKind="balance-review" sources={sources} phase="Summarizing…" modelPhase />);
  const header = screen.getByRole('region', { name: 'Review sources' }).querySelector('header');
  expect(within(header).getByRole('status', { name: 'Response running' })).toHaveTextContent('Summarizing…');
  view.rerender(<AnalystReviewSources reviewKind="balance-review" sources={sources} phase="Gathering sources…" />);
  expect(within(header).queryByRole('status')).not.toBeInTheDocument();
});
