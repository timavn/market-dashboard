import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystInbox from './AnalystInbox';
import { buildAnalystInbox } from '../../utils/analystInboxAlerts.cjs';

const finding = (overrides = {}) => ({
  id: 'amzn', symbol: 'AMZN', action: 'signal change', state: 'pending verification', unread: 1,
  payload: {
    action: 'signal change', summary: 'A signal changed. Verified holding: 15. Reading this finding does not confirm a trade.',
    holdingsVerifiedAt: '2026-09-14T19:02:36.957411Z', marketSession: 'open',
    publicationTime: '2026-09-14T00:00:00Z',
    event: { entityId: 'AMZN', eventType: 'risk_range', signalValue: 'BEARISH', qualityStatus: 'validated',
      productKey: 'risk-ranges', productLabel: 'Risk Ranges', fieldPath: 'data.AMZN',
      sourceMessageId: 'today', publishedAt: '2026-09-14T00:00:00Z', marketDate: '2026-09-14' },
    citation: { title: 'Risk Ranges', publicationDate: '2026-09-14', excerpt: 'AMZN trend BEARISH' },
  },
  ...overrides,
});

const currentHolding = (asOf, weightPct = 1.25) => ({
  weightPct, source: 'ibkr', asOf, basis: 'absolute_market_value_over_net_liquidation',
});

const attention = (id, overrides = {}) => ({ id, unread: 1, payload: {
  attentionVersion: 1, state: 'open', kind: 'operational', priority: 0, fingerprint: `${id}-revision`,
  publicationTime: '2026-09-22T15:30:00Z', presentation: {
    subject: 'IB Gateway', date: '2026-09-22', rows: [
      { label: 'Issue', text: 'IB Gateway is disconnected.' },
      { label: 'Impact', text: 'Portfolio holdings and balances cannot refresh.' },
      { label: 'Next step', text: 'Reconnect IB Gateway.' },
    ], sourceLinks: [{ label: 'Systems', citation: { title: 'IB Gateway status', sourceUri: '/systems' } }],
  }, ...overrides,
} });

test('existing source exclusion warnings disappear while evidenced publication discrepancies remain', () => {
  const warnings = ['Monthly Inflation Nowcast', 'Bitcoin Tracker', 'IBKR account exposure', 'Risk Ranges', 'Portfolio research archive']
    .map((label, index) => attention(`excluded-${index}`, { managedBy: 'review-sources',
      presentation: { subject: label, rows: [{ label: 'Problem', text: `${label} was excluded from this saved review.` }] } }));
  const discrepancy = attention('source-discrepancy', { managedBy: 'review-sources', sourceDiscrepancy: true,
    sourceQuality: { issues: [{ code: 'REVERSED_RISK_RANGE' }] },
    presentation: { subject: 'Early Look', rows: [{ label: 'Issue', text: 'The published lower bound exceeds the upper bound.' }] } });
  const { rerender } = render(<AnalystInbox findings={[...warnings, discrepancy]} />);
  expect(screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(['Early Look']);
  expect(screen.queryByText(/excluded from this saved review/)).not.toBeInTheDocument();
  rerender(<AnalystInbox findings={warnings} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
});

test('retained Research delivery, Quant Analyst and Security checks warnings are removed without hiding source evidence', () => {
  const warnings = [['gmail.ingestion', 'Research delivery'], ['research-verification', 'Research delivery'],
    ['hermes.quant-analyst', 'Quant Analyst'], ['hermes.quant-developer', 'Quant Developer'], ['hermes.security', 'Security checks']]
    .map(([key, subject]) => attention(`attention:operations:${key}`, { presentation: { subject, rows: [{ label: 'Issue', text: 'A scheduled check is unavailable.' }] } }));
  const source = attention('published-issue', { presentation: { subject: 'Early Look', rows: [{ label: 'Issue', text: 'The publication has conflicting bounds.' }] } });
  render(<AnalystInbox findings={[...warnings, source]} />);
  expect(screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(['Early Look']);
  expect(screen.queryByText('A scheduled check is unavailable.')).not.toBeInTheDocument();
});

test('a date-only alert shows when it reached the Inbox, and the date alone only when that is unknown', () => {
  const dated = { publicationTime: '2026-10-27T00:00:00.000Z', presentation: { subject: 'IB Gateway', date: '2026-10-27', rows: [{ label: 'Issue', text: 'Above MAX.' }] } };
  const { unmount } = render(<AnalystInbox findings={[attention('sized', { ...dated, receivedAt: '2026-10-27T15:00:00Z' })]} />);
  expect(screen.getByRole('group', { name: 'Alert actions' })).toHaveTextContent('Oct 27 08:00');
  expect(screen.getByText('Oct 27 08:00')).toHaveAttribute('dateTime', '2026-10-27T15:00:00Z');
  unmount();
  render(<AnalystInbox findings={[attention('legacy', dated)]} />);
  expect(screen.getByText('Oct 27')).toBeInTheDocument();
});

test('operational attention describes the issue and consequence without position filler and acknowledges its revision', () => {
  const item = attention('gateway', { materialRevision: 2 });
  const onCitation = jest.fn();
  const onAcknowledge = jest.fn();
  render(<AnalystInbox findings={[item]} onCitation={onCitation} onAcknowledge={onAcknowledge} />);
  expect(screen.getByRole('heading', { name: 'IB Gateway' })).toBeInTheDocument();
  expect(screen.queryByText('Ticker:')).not.toBeInTheDocument();
  expect(screen.getByText('Issue:').parentElement).toHaveTextContent(/^Issue: IB Gateway is disconnected\.$/);
  expect(screen.getByRole('group', { name: 'Alert actions' })).toHaveTextContent('Sep 22 08:30');
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Issue:', 'Impact:', 'Next step:']);
  expect(screen.queryByText('Current position:')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(onCitation).toHaveBeenCalledWith(item.payload.presentation.sourceLinks[0].citation, expect.objectContaining({ anchor: screen.getByRole('button', { name: 'Source' }) }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onAcknowledge).toHaveBeenCalledWith('gateway', 'gateway-revision', 2);
});

test('orders urgent concerns before newer ideas and colors directional words and Quad labels', () => {
  const idea = attention('idea', { kind: 'opportunity', priority: 1, publicationTime: '2026-09-22T16:30:00Z',
    presentation: { subject: 'ABC', date: '2026-09-22', rows: [
      { label: 'Case', text: 'Long idea with Bullish Trend; short-term weakness and Neutral Trade are counterevidence. Quad 2 supports the research case.' },
    ] } });
  render(<AnalystInbox findings={[idea, attention('resolved', { state: 'resolved' }), attention('gateway')]} />);
  expect(screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(['IB Gateway', 'ABC']);
  expect(screen.getByText('Long')).toHaveClass('analyst-inbox-signal--positive');
  expect(screen.getByText('Bullish')).toHaveClass('analyst-inbox-signal--positive');
  expect(screen.getByText('Neutral')).toHaveClass('analyst-inbox-signal--neutral');
  expect(screen.getByText('Quad 2')).toHaveClass('analyst-inbox-quad--2');
  expect(screen.queryByText('short', { exact: true })).not.toBeInTheDocument();
});

test('a terse Context opens the card as the bold Action, above the ticker, in place of the Action row', () => {
  const alert = attention('ttd', { kind: 'portfolio', severity: 'action-required', presentation: { subject: 'TTD', date: '2026-11-09', sourceLinks: [], rows: [
    { label: 'Process limits', text: 'MIN 1.50% / MAX 2.50%' }, { label: 'Action', text: 'Reduce to MAX 2.50%' },
    { label: 'Trim', text: '0.71 pts (3.21% → 2.50%)' }, { label: 'Context', text: 'Above MAX → trim to MAX.' },
  ] } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Action:', 'Ticker:', 'Process limits:', 'Trim:']);
  expect(screen.getByText('Action:').closest('.analyst-inbox-lead')).toHaveTextContent('Action: Above MAX → trim to MAX.');
  expect(screen.queryByText('Reduce to MAX 2.50%')).not.toBeInTheDocument();
  expect(screen.queryByText('Context:')).not.toBeInTheDocument();
});

test('a prose Context stays below while the Action row opens the card', () => {
  const alert = attention('kdp', { kind: 'opportunity', presentation: { subject: 'KDP', date: '2026-11-09', sourceLinks: [], rows: [
    { label: 'Current position', text: 'Not held' }, { label: 'Action', text: 'New Long idea → review' },
    { label: 'Context', text: 'Margins are improving and the source started buying.' },
  ] } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Action:', 'Ticker:', 'Current position:', 'Context:']);
  expect(screen.getByText('Action:').closest('.analyst-inbox-lead')).toHaveTextContent('New Long idea → review');
});

test('a security card names its source products right under the position', () => {
  const citation = (title, product) => ({ id: `cite_${product}`, title, product, sourceUri: `https://mail.google.com/mail/#all/${product}` });
  const idea = attention('idea', { kind: 'opportunity', presentation: { subject: 'KDP', date: '2026-11-02', rows: [
    { label: 'Current position', text: 'Not held' }, { label: 'Action', text: 'New Long idea → review' },
  ], sourceLinks: [
    { label: 'The Call', citation: citation('The Call @ Hedgeye | Replay & Summary | 11/02/2026', 'the-call') },
    { label: 'Trade source', citation: citation('Signal Strength Shorts', 'signal-strength-shorts') },
    { label: 'Counterpoint source', citation: citation('The Call @ Hedgeye | Replay & Summary | 11/02/2026', 'the-call') },
  ] } });
  const wti = attention('wti', { kind: 'market', presentation: { subject: 'WTI', date: '2026-11-02', rows: [{ label: 'Trade line', text: 'Broke 97 at 96.85 (08:14 PST) → Trade neutral\nReclaimed 97 at 97.17 (08:09 PST)' }],
    sourceLinks: [{ label: 'Top 3 Things Alpha Code', citation: citation('Top 3 Things: WTI Alpha Code', 'top-3-things') }] } });
  render(<AnalystInbox findings={[idea, wti, attention('gateway')]} />);
  const labels = [...document.querySelectorAll('.analyst-inbox-copy dt')].map(term => term.textContent.trim());
  expect(labels.slice(0, 4)).toEqual(['Action:', 'Ticker:', 'Current position:', 'Source:']);
  expect(screen.getAllByText('Source:').map(term => term.nextSibling.textContent)).toEqual(['The Call, Signal Strength Shorts', 'Top 3 Things']);
  // A product name is not a directional call.
  expect(screen.getByText('The Call, Signal Strength Shorts')).not.toHaveClass('analyst-inbox-signal--negative');
  // Operational cards are not about a security.
  expect(screen.getAllByText('Source:')).toHaveLength(2);
  // A line's crosses stack newest first, the older ones muted beneath.
  const crosses = [...document.querySelectorAll('.analyst-inbox-stack dd > span')];
  expect(crosses.map(entry => entry.textContent)).toEqual(['Broke 97 at 96.85 (08:14 PST) → Trade neutral', 'Reclaimed 97 at 97.17 (08:09 PST)']);
  expect(crosses.map(entry => entry.classList.contains('analyst-inbox-stack__older'))).toEqual([false, true]);
});

test('alerts dismissed in the last 24 hours open from one button at the bottom of the Inbox', () => {
  const ago = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  const dismissed = (id, subject, hours) => ({ ...attention(id, { dismissed: { at: ago(hours) },
    presentation: { subject, date: '2026-09-22', rows: [{ label: 'Issue', text: `${subject} is disconnected.` }] } }), unread: 0 });
  render(<AnalystInbox findings={[attention('gateway'), dismissed('older', 'Early Look', 5), dismissed('recent', 'HedgAI Signals', 1), dismissed('stale', 'Old feed', 30)]} />);
  expect(screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(['IB Gateway']);
  const toggle = screen.getByRole('button', { name: 'Dismissed (2)' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  // Most recently dismissed first; a day-old dismissal is gone.
  expect(screen.getAllByRole('heading', { level: 3 }).map(item => item.textContent)).toEqual(['IB Gateway', 'HedgAI Signals', 'Early Look']);
  expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  expect(screen.getAllByText(/^Dismissed [A-Z][a-z]{2} \d+ \d\d:\d\d$/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Hide dismissed' }));
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
});

test('no dismissals, no Dismissed button', () => {
  render(<AnalystInbox findings={[attention('gateway')]} />);
  expect(screen.queryByRole('button', { name: /dismissed/i })).not.toBeInTheDocument();
});

test('fresh holdings expiry removes portfolio actions while retaining research ideas without stale portfolio claims', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-22T15:30:00Z'));
  try {
    const holdings = { quantity: 15, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(), currentHolding: currentHolding(new Date().toISOString()) };
    const portfolio = attention('portfolio', { ...holdings, kind: 'portfolio', presentation: { subject: 'AMZN', date: '2026-09-22', rows: [{ label: 'Action', text: 'Exit the long position.' }] } });
    const idea = attention('idea', { ...holdings, kind: 'opportunity', presentation: { subject: 'ABC', date: '2026-09-22', rows: [
      { label: 'Current position', text: 'Long' }, { label: 'Position size', text: '1.25%' },
      { label: 'Portfolio fit', text: 'Adds to current exposure.', requiresFreshHoldings: true },
      { label: 'Case', text: 'A published Bullish Trade reversal supports further research.' },
    ] } });
    render(<AnalystInbox findings={[portfolio, idea]} />);
    expect(screen.getByRole('heading', { name: 'AMZN' })).toBeInTheDocument();
    // The position reads as its weight alone, green for Long.
    expect(screen.getByText('Current position:').nextSibling).toHaveTextContent(/^LONG 1\.25%$/);
    expect(screen.getByText('Current position:').nextSibling).toHaveClass('analyst-inbox-signal--positive');
    act(() => jest.advanceTimersByTime(65_000));
    expect(screen.queryByRole('heading', { name: 'AMZN' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ABC' })).toBeInTheDocument();
    expect(screen.queryByText('Portfolio fit:')).not.toBeInTheDocument();
    expect(screen.queryByText(/1\.25%/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Unavailable')).toHaveLength(1);
  } finally { jest.useRealTimers(); }
});

test.each([{ providerConnected: false }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }])('unavailable portfolio inputs suppress modern actions (%j)', invalid => {
  const item = attention('portfolio', { ...invalid, kind: 'portfolio', quantity: 15, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString() });
  render(<AnalystInbox findings={[item]} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
});

test('balance expiry removes current deficits but retains dated historical accounting evidence', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-22T15:30:00Z'));
  try {
    const deficit = attention('deficit', { kind: 'account', requiresFreshBalance: true, balanceVerified: true, balanceVerifiedAt: new Date().toISOString(),
      presentation: { subject: 'Account funding', date: '2026-09-22', rows: [{ label: 'Issue', text: 'Verified settled cash is below zero.' }] } });
    const history = attention('history', { kind: 'account', researchOnly: true,
      presentation: { subject: 'Interest reconciliation', date: '2026-09-21', rows: [{ label: 'Issue', text: 'The dated accounting report has an unresolved reconciliation difference.' }] } });
    render(<AnalystInbox findings={[deficit, history]} />);
    expect(screen.getByRole('heading', { name: 'Account funding' })).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(65_000));
    expect(screen.queryByRole('heading', { name: 'Account funding' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Interest reconciliation' })).toBeInTheDocument();
  } finally { jest.useRealTimers(); }
});

test.each([{ providerConnected: false }, { stale: true }, { cacheOnly: true }, { from_cache: true }, { mock: true }, { seeded: true }, { balanceVerified: false }])('unavailable balance inputs suppress current account claims (%j)', invalid => {
  const item = attention('account', { kind: 'account', requiresFreshBalance: true, balanceVerified: true, balanceVerifiedAt: new Date().toISOString(), ...invalid });
  render(<AnalystInbox findings={[item]} />);
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
});

test('leads with current position before the actual signal and dated source without boilerplate', () => {
  render(<AnalystInbox findings={[finding()]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  const inbox = screen.getByRole('region', { name: 'Portfolio inbox' });
  expect(within(inbox).queryByRole('heading', { name: 'Portfolio inbox' })).not.toBeInTheDocument();
  // A date-only publication shows no time of day.
  expect(within(inbox).getByText('Ticker:').parentElement).toHaveTextContent(/^Ticker: AMZN$/);
  expect(within(inbox).getAllByRole('term')[1]).toHaveTextContent('Current position:');
  expect(within(inbox).getAllByRole('definition')[1]).toHaveTextContent(/^Unavailable$/);
  expect(within(inbox).getAllByRole('term').slice(0, 3).map(term => term.textContent.trim())).toEqual([
    'Ticker:', 'Current position:', 'Action:',
  ]);
  expect(within(inbox).getAllByRole('definition')[2]).toHaveTextContent(/^Unavailable$/);
  expect(within(inbox).getByText('Trend:')).toBeInTheDocument();
  expect(within(inbox).queryByRole('list')).not.toBeInTheDocument();
  expect(within(inbox).queryByRole('listitem')).not.toBeInTheDocument();
  expect(within(inbox).getByText('Bearish', { exact: true })).toHaveClass('analyst-inbox-signal--negative');
  expect(within(inbox).getByText('Risk Ranges')).toBeInTheDocument();
  expect(inbox).not.toHaveTextContent(/pending verification|holdings verified|Verified holding|does not confirm|signal changed|marketSession|19:02:36|\bopen\b/i);
});

test('shows the dated change, portfolio implication, and source evidence without repeated daily readings', () => {
  const current = finding();
  const rows = [['prior', '2026-09-09', 'NEUTRAL'], ['changed', '2026-09-10', 'BEARISH'], ['latest', '2026-09-14', 'BEARISH']].map(([id, date, signalValue]) => finding({ id, payload: { ...current.payload,
    quantity: 15, holdingsVerified: true,
    event: { ...current.payload.event, sourceMessageId: id, signalValue, publishedAt: `${date}T00:00:00Z`, marketDate: date, sourceUrl: `https://app.hedgeye.com/feed_items/${id}` },
    citation: { title: 'Risk Ranges', publicationDate: date, sourceUri: `https://app.hedgeye.com/feed_items/${id}` },
  } }));
  const { findings } = buildAnalystInbox({ findings: rows }, '2026-09-14T21:00:00Z');
  const onCitation = jest.fn();
  render(<AnalystInbox findings={findings} onCitation={onCitation} onAcknowledge={jest.fn()} />);
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'AMZN' })).toBeInTheDocument();
  const update = screen.getAllByRole('definition')[3];
  expect(within(update).getByText('Neutral', { exact: true })).toHaveClass('analyst-inbox-signal--neutral');
  expect(within(update).getByText('Bearish', { exact: true })).toHaveClass('analyst-inbox-signal--negative');
  expect(screen.getByText('History:').parentElement).toHaveTextContent('First reported Sep 10, after Neutral on Sep 9. Confirmed Bearish Sep 14.');
  expect(screen.getByText('Context:')).toBeInTheDocument();
  expect(screen.getByText('Context:').parentElement).toHaveTextContent('Trend has weakened further for your long position. If Trade is Bullish, both Neutral and Bearish Trend call for your minimum size.');
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Ticker:', 'Current position:', 'Action:', 'Trend:', 'History:', 'Context:']);
  const details = screen.getAllByRole('definition');
  expect(details[3]).toHaveTextContent('Neutral → Bearish');
  expect(details[4]).toHaveTextContent(/^First reported Sep 10/);
  expect(details[5]).toHaveTextContent(/^Trend has weakened further/);
  expect(within(details[4]).getByText('Neutral')).toHaveClass('analyst-inbox-signal--neutral');
  expect(within(details[4]).getByText('Bearish')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(details[5]).getByText('long')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(details[5]).getByText('Bullish')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(details[5]).getByText('Bearish')).toHaveClass('analyst-inbox-signal--negative');
  expect(screen.getByText('Hedgeye Risk Ranges')).toBeInTheDocument();
  expect(screen.getByText('Ticker:').parentElement).toHaveTextContent(/^Ticker: AMZN$/);
  const actions = screen.getByRole('group', { name: 'Alert actions' });
  expect(within(actions).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  // The date sits between Source and Dismiss.
  expect(actions).toHaveTextContent(/^Hedgeye Risk Ranges\s*SourceSep 10Dismiss$/);
  // The alert's actions sit beneath its Analyst chat.
  const composer = screen.getByRole('textbox', { name: 'Discuss this alert with the Analyst' });
  expect(composer.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Every dated publication opens from the one Source popover.
  expect(within(actions).getAllByRole('button').map(button => button.textContent)).toEqual(['Source', 'Dismiss']);
  fireEvent.click(within(actions).getByRole('button', { name: 'Source' }));
  const [[first, { relatedSources }]] = onCitation.mock.calls;
  expect([first, ...relatedSources]).toEqual(rows.map(row => row.payload.citation));
});

test('uses green for a verified bullish signal while keeping its English label', () => {
  const current = finding();
  render(<AnalystInbox findings={[finding({ payload: { ...current.payload,
    event: { ...current.payload.event, signalValue: 'BULLISH' },
  } })]} />);
  expect(screen.getByRole('heading', { name: 'AMZN' })).toBeInTheDocument();
  expect(within(screen.getAllByRole('definition')[3]).getByText('Bullish')).toHaveClass('analyst-inbox-signal--positive');
});

test('suppresses a generic sell report that identifies no change for an existing short', () => {
  const excerpt = 'Cheer Sell call. Source context: who knows, who cares.';
  const citation = { title: 'Hedgeye Real-Time Alerts', publicationDate: '2026-09-11',
    excerpt, sourceUri: 'https://app.hedgeye.com/feed_items/wing' };
  const alert = { id: 'wing', symbol: 'WING', action: 'exit', unread: 1, payload: {
    action: 'exit', citation,
    quantity: -20, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'SHORT' } },
    event: { entityId: 'WING', eventType: 'position_change', qualityStatus: 'validated',
      productLabel: 'Real-Time Alerts', action: 'SELL', sourceUrl: citation.sourceUri,
      excerpt: JSON.stringify({ ticker: 'WING', action: 'SELL', signalPhrase: 'Cheer Sell', context: 'who knows, who cares' }),
    },
  } };
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  expect(screen.queryByRole('heading', { name: 'WING' })).not.toBeInTheDocument();
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
});

test('shows SJM’s current long position before the report’s explicit partial-sale action', () => {
  const observedAt = new Date().toISOString();
  const instruction = 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today';
  const sourceReport = {
    title: 'SELL SIGNAL SJM $121.95',
    bodyText: `${instruction}... Coaching Notes: I sold 4 Macro positions in ETF Pro.`,
    sourceMessageId: 'sjm-report', publicationDate: '2026-09-14', contentHash: 'sjm-report-content',
  };
  const citation = { title: 'Hedgeye Real-Time Alerts', publicationDate: '2026-09-14',
    sourceUri: 'https://app.hedgeye.com/feed_items/sjm', excerpt: sourceReport.bodyText };
  const alert = { id: 'sjm', symbol: 'SJM', action: 'exit', unread: 1, payload: {
    action: 'exit', citation, quantity: 10, holdingsVerified: true, holdingsVerifiedAt: observedAt,
    currentHolding: currentHolding(observedAt, 2.35),
    alertContext: { kind: 'source-action', changedAt: '2026-09-14', recordedPosition: { side: 'LONG', asOf: observedAt } },
    event: { entityId: 'SJM', eventType: 'position_change', qualityStatus: 'validated',
      productLabel: 'Real-Time Alerts', action: 'SELL', sourceUrl: citation.sourceUri,
      sourceMessageId: 'sjm-report', marketDate: '2026-09-14', publishedAt: '2026-09-14T14:28:00Z',
      excerpt: JSON.stringify({ ticker: 'SJM', action: 'SELL', headline: sourceReport.title }), sourceReport,
    },
  } };
  const onCitation = jest.fn();
  render(<AnalystInbox findings={[alert]} onCitation={onCitation} onAcknowledge={jest.fn()} />);
  const inbox = screen.getByRole('region', { name: 'Portfolio inbox' });
  expect(within(inbox).getByText('Ticker:').parentElement).toHaveTextContent(/^Ticker: SJM$/);
  expect(within(inbox).getAllByRole('term').map(term => term.textContent.trim())).toEqual([
    'Ticker:', 'Current position:', 'Action:', 'Context:',
  ]);
  const details = within(inbox).getAllByRole('definition');
  expect(details[1]).toHaveTextContent(/^Long @ 2.35%$/);
  expect(within(details[1]).getByText('Long')).toHaveClass('analyst-inbox-signal--positive');
  expect(details[2]).toHaveTextContent(/^Sell some — reduce position size$/);
  expect(details[3]).toHaveTextContent(/^Trend remains bullish\.$/);
  expect(within(details[3]).getByText('bullish')).toHaveClass('analyst-inbox-signal--positive');
  expect(inbox).not.toHaveTextContent(/Report:|of portfolio|The report|Portfolio Managers/);
  expect(inbox).not.toHaveTextContent(/sell signal update|goes against your long position|Coaching Notes|sold 4 Macro|Exit the position/i);
  expect(within(inbox).queryByRole('list')).not.toBeInTheDocument();
  fireEvent.click(within(inbox).getByRole('button', { name: 'Source' }));
  expect(onCitation).toHaveBeenCalledWith(citation, expect.objectContaining({ relatedSources: [] }));
});

test('expires current position and size after 60 seconds without a refresh and removes both immediately on failure', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-14T19:00:00Z'));
  try {
    const current = finding();
    const alert = finding({ payload: { ...current.payload, quantity: 15, holdingsVerified: true,
      holdingsVerifiedAt: new Date().toISOString(),
      currentHolding: currentHolding(new Date().toISOString()),
      alertContext: { recordedPosition: { side: 'LONG', asOf: '2026-09-13T19:00:00Z' } },
    } });
    const view = render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
    const position = () => screen.getAllByRole('definition')[1];
    expect(position()).toHaveTextContent(/^Long @ 1.25%$/);
    expect(within(position()).getByText('Long')).toHaveClass('analyst-inbox-signal--positive');
    act(() => jest.advanceTimersByTime(60_000));
    expect(position()).toHaveTextContent(/^Long @ 1.25%$/);
    act(() => jest.advanceTimersByTime(5_000));
    expect(position()).toHaveTextContent(/^Unavailable$/);
    expect(position().querySelector('[class*="signal--positive"], [class*="signal--negative"]')).toBeNull();

    const refreshed = { ...alert, payload: { ...alert.payload, quantity: -15, holdingsVerifiedAt: new Date().toISOString(),
      currentHolding: currentHolding(new Date().toISOString(), 0.85),
    } };
    view.rerender(<AnalystInbox findings={[refreshed]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
    expect(position()).toHaveTextContent(/^Short @ 0.85%$/);
    expect(within(position()).getByText('Short')).toHaveClass('analyst-inbox-signal--negative');
    view.rerender(<AnalystInbox findings={[{ ...refreshed, payload: { ...refreshed.payload, holdingsVerified: false } }]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
    expect(position()).toHaveTextContent(/^Unavailable$/);
    expect(screen.queryByText(/0.85%/)).not.toBeInTheDocument();
    expect(screen.getByText('Bearish', { exact: true })).toBeInTheDocument();
    view.unmount();
  } finally {
    jest.useRealTimers();
  }
});

test('a verified position without a weight reads its side, never a share count', () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-14T19:00:00Z'));
  try {
    const alert = attention('giii', { kind: 'portfolio', severity: 'action-required', quantity: -147.0313, holdingsVerified: true,
      holdingsVerifiedAt: new Date().toISOString(), currentHolding: null, presentation: { subject: 'GIII', date: '2026-09-14', rows: [
        { label: 'Current position', text: 'Short' }, { label: 'Action', text: 'Signal Strength removed GIII (Short) → exit Short' },
      ] } });
    render(<AnalystInbox findings={[alert]} />);
    expect(screen.getByText('Current position:').nextSibling).toHaveTextContent(/^Short$/);
  } finally {
    jest.useRealTimers();
  }
});

test('emphasizes the Russell source index beneath IWM’s RUT Trend update', () => {
  const current = finding();
  const rows = [['prior', '2026-09-09', 'NEUTRAL'], ['changed', '2026-09-10', 'BEARISH']].map(([id, date, signalValue]) => finding({
    id, symbol: 'IWM', payload: { ...current.payload, symbol: 'IWM',
      event: { ...current.payload.event, entityId: 'IWM', fieldPath: 'data.RUT', matchedText: 'RUT',
        matchType: 'structured_membership', excerpt: 'RUT: {"originalName":"Russell 2000"}',
        sourceMessageId: id, signalValue, publishedAt: `${date}T00:00:00Z`, marketDate: date },
      citation: { title: 'Risk Ranges', publicationDate: date },
    },
  }));
  const { findings } = buildAnalystInbox({ findings: rows }, '2026-09-14T21:00:00Z');
  render(<AnalystInbox findings={findings} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  expect(screen.getByText('Ticker:').parentElement).toHaveTextContent(/^Ticker: IWM$/);
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Ticker:', 'Current position:', 'Action:', 'RUT Trend:', 'Underlying:', 'History:']);
  expect(screen.getAllByRole('definition')[3]).toHaveTextContent('Neutral → Bearish');
  const sourceIndex = screen.getByText('Russell 2000 (RUT)');
  expect(sourceIndex.tagName).toBe('STRONG');
  expect(screen.getAllByRole('definition')[4]).toContainElement(sourceIndex);
  expect(screen.getAllByRole('definition')[4]).toHaveTextContent('Russell 2000 (RUT) — tracked by IWM.');
});

test('shows a short-cover action once and omits an empty context row', () => {
  const observedAt = new Date().toISOString();
  const alert = { id: 'xlu', symbol: 'XLU', action: 'cover', unread: 1, payload: {
    action: 'cover', citation: { title: 'Hedgeye Real-Time Alerts', publicationDate: '2026-09-11' },
    quantity: -25, holdingsVerified: true, holdingsVerifiedAt: observedAt,
    currentHolding: currentHolding(observedAt, 1.75),
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'SHORT' } },
    event: { entityId: 'XLU', eventType: 'position_change', qualityStatus: 'validated',
      productLabel: 'Real-Time Alerts', action: 'Cover-SOME',
    },
  } };
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  expect(screen.getByText('Ticker:').parentElement).toHaveTextContent(/^Ticker: XLU$/);
  expect(screen.getAllByRole('definition')[1]).toHaveTextContent(/^Short @ 1.75%$/);
  expect(screen.getAllByRole('definition')[2]).toHaveTextContent(/^Close part of the short position — reduce position size$/);
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Ticker:', 'Current position:', 'Action:']);
  const directions = screen.getAllByText(/^short$/i);
  expect(directions).toHaveLength(2);
  directions.forEach(word => expect(word).toHaveClass('analyst-inbox-signal--negative'));
  expect(screen.queryByText('Context:')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Portfolio inbox' })).not.toHaveTextContent(/Report:|of portfolio|The report recommends/);
  expect(screen.queryByText('Dashboard interpretation:')).not.toBeInTheDocument();
});

test('shows exact source context directly without repeating the action or adding a report preface', () => {
  const summary = 'XLU remains a short hedge against long SPY exposure.';
  const bullet = 'The short-term bounce in XLU leaves its bearish Trend unchanged.';
  const citation = { title: 'Hedgeye Real-Time Alerts', publicationDate: '2026-09-11',
    sourceUri: 'https://app.hedgeye.com/feed_items/xlu-cover' };
  const alert = { id: 'xlu-context', symbol: 'XLU', action: 'cover', payload: {
    action: 'cover', citation,
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'SHORT' } },
    event: { entityId: 'XLU', eventType: 'position_change', qualityStatus: 'validated',
      productLabel: 'Real-Time Alerts', action: 'COVER-SOME', sourceMessageId: 'xlu-report', marketDate: '2026-09-11',
      sourceReport: { entityId: 'XLU', sourceMessageId: 'xlu-report', publicationDate: '2026-09-11', contentHash: 'exact-content',
        title: 'COVER-SOME SIGNAL XLU', summary, bodyText: `${summary}\n• ${bullet}` },
    },
  } };
  const onCitation = jest.fn();
  render(<AnalystInbox findings={[alert]} onCitation={onCitation} />);
  const context = screen.getByText('Context:').parentElement;
  expect(context).toHaveTextContent(`Context: ${summary}`);
  expect(context).not.toHaveTextContent(/The report|buying back|reducing your short exposure|[“”]/);
  expect(screen.queryByText('Report:')).not.toBeInTheDocument();
  expect(context.textContent.split(summary)).toHaveLength(2);
  within(context).getAllByText('short', { exact: true }).forEach(word => expect(word).toHaveClass('analyst-inbox-signal--negative'));
  expect(within(context).getByText('long', { exact: true })).toHaveClass('analyst-inbox-signal--positive');
  expect(screen.getAllByRole('term').filter(term => term.textContent.trim() === 'Context:')).toHaveLength(1);
  expect(within(context).queryByRole('list')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(onCitation).toHaveBeenCalledWith(citation, expect.objectContaining({ relatedSources: [] }));
});

test('keeps short-term time horizons uncolored while coloring the reported bearish signal', () => {
  const citation = { title: 'Hedgeye Real-Time Alerts', publicationDate: '2026-09-11' };
  const alert = { id: 'time-horizon', symbol: 'XLU', action: 'cover', payload: { action: 'cover', citation,
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'SHORT' } },
    event: { entityId: 'XLU', eventType: 'position_change', qualityStatus: 'validated', action: 'COVER-SOME',
      sourceMessageId: 'xlu-report', marketDate: '2026-09-11', sourceReport: {
        entityId: 'XLU', sourceMessageId: 'xlu-report', publicationDate: '2026-09-11', contentHash: 'exact-content',
        bodyText: 'The short-term bounce in XLU leaves its bearish Trend unchanged.',
      },
    },
  } };
  render(<AnalystInbox findings={[alert]} />);
  const quote = screen.getByText('Context:').parentElement;
  expect(quote).toHaveTextContent('The short-term bounce in XLU leaves its bearish Trend unchanged.');
  expect(within(quote).queryByText('short', { exact: true })).not.toBeInTheDocument();
  expect(within(quote).getByText('bearish', { exact: true })).toHaveClass('analyst-inbox-signal--negative');
});

test.each([
  ['unvalidated', { qualityStatus: 'unvalidated' }],
  ['failed', { qualityStatus: 'failed' }],
  ['unknown signal', { signalValue: 'UNAVAILABLE' }],
  ['missing signal', { signalValue: undefined, excerpt: 'AMZN is bearish' }],
])('does not invent a directional label or color from %s evidence', (label, event) => {
  const current = finding();
  render(<AnalystInbox findings={[finding({ payload: { ...current.payload,
    event: { ...current.payload.event, ...event },
  } })]} />);
  expect(screen.getByRole('heading', { name: 'AMZN' })).toBeInTheDocument();
  const update = screen.getAllByRole('definition')[3];
  expect(screen.getAllByRole('term')[3]).toHaveTextContent('Signal:');
  expect(within(update).queryByText(/Bullish|Bearish/)).not.toBeInTheDocument();
  expect(within(update).getByText('Signal details unavailable')).not.toHaveClass('analyst-inbox-signal--negative', 'analyst-inbox-signal--positive');
});

test('empty inbox does not imply a baseline is a new signal alert', () => {
  render(<AnalystInbox findings={buildAnalystInbox({ findings: [finding()] }).findings} />);
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
});

test('keeps source and acknowledgment actions without marking an alert read just by viewing it', async () => {
  const alert = finding();
  const onCitation = jest.fn();
  const onAcknowledge = jest.fn().mockResolvedValue();
  const view = render(<AnalystInbox findings={[alert]} onCitation={onCitation} onAcknowledge={onAcknowledge} />);
  expect(onAcknowledge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(onCitation).toHaveBeenCalledWith(alert.payload.citation, expect.objectContaining({ relatedSources: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith('amzn'));
  view.rerender(<AnalystInbox findings={[{ ...alert, unread: 0 }]} onCitation={onCitation} onAcknowledge={onAcknowledge} />);
  expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'AMZN' })).not.toBeInTheDocument();
  expect(screen.getByText('No new items requiring attention.')).toBeInTheDocument();
});

test('shows a restored alert with a retryable acknowledgment after a save error', () => {
  const onAcknowledge = jest.fn();
  render(<AnalystInbox findings={[finding()]} error="Couldn’t mark this alert as read. Try again." onAcknowledge={onAcknowledge} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t mark this alert as read. Try again.');
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
  expect(screen.getByRole('heading', { name: 'AMZN' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onAcknowledge).toHaveBeenCalledWith('amzn');
});

test('action-required items are pinned first and dismiss with one click', () => {
  const onAcknowledge = jest.fn();
  const urgent = attention('snow', { kind: 'operational', severity: 'action-required', fingerprint: 'snow-fp', materialRevision: 2,
    publicationTime: '2026-09-21T15:30:00Z',
    presentation: { subject: 'SNOW', date: '2026-09-21', rows: [{ label: 'Action', text: 'Investing Ideas removed SNOW from its Long list — exit the Long position' }], sourceLinks: [] } });
  render(<AnalystInbox findings={[attention('gateway'), urgent]} onCitation={jest.fn()} onAcknowledge={onAcknowledge} />);
  const headings = screen.getAllByRole('heading').map(heading => heading.textContent);
  expect(headings.slice(0, 3)).toEqual(['Alerts', 'SNOW', 'Notifications']);
  const card = screen.getByRole('heading', { name: 'SNOW' }).closest('article');
  expect(within(card).queryByRole('button', { name: /Keep/ })).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
  expect(onAcknowledge).toHaveBeenCalledWith('snow', 'snow-fp', 2);
});

test('a security alert puts Tick, Trade, Trend and Tail beside its 1D–90D windows in one table', async () => {
  const stats = { asOf: '2026-10-20', baselineVolPct: 20, columns: [
    { label: '1D', priceChangePct: -1.8, realizedVolPct: 31, volumeRatio: 1.6, rangePct: 8 },
    { label: '15D', priceChangePct: -4.2, realizedVolPct: 26, volumeRatio: 1.3, rangePct: 12 },
    { label: '30D', priceChangePct: -2.1, realizedVolPct: 22, volumeRatio: 1.1, rangePct: 35 },
    { label: '90D', priceChangePct: 6.4, realizedVolPct: 19, volumeRatio: null, rangePct: 68 },
  ] };
  const loadHorizonStats = jest.fn().mockResolvedValue({ XLK: stats });
  const alert = attention('xlk', { kind: 'portfolio', severity: 'action-required', quantity: 10, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    presentation: { subject: 'XLK', date: '2026-10-21', sourceLinks: [], rows: [
      { label: 'Action', text: 'Reduce to MIN 1.50%' }, { label: 'Order', text: 'Sell 2.39 shares' },
      { label: 'Context', text: 'Trend broke → reduce to MIN.' },
      { label: 'Tick', text: 'Bearish' }, { label: 'Trade', text: 'Bullish' }, { label: 'Trend', text: 'Neutral' }, { label: 'Tail', text: 'N/A' },
    ] } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} loadHorizonStats={loadHorizonStats} />);
  const card = screen.getByRole('heading', { name: 'XLK' }).closest('article');
  expect(within(card).queryByText('Tick:')).not.toBeInTheDocument();
  expect(within(card).getByText('Order:').nextSibling).toHaveTextContent(/^Sell 2\.39 shares$/);
  expect(within(card).getByText('Sell')).toHaveClass('analyst-inbox-signal--negative');
  const table = within(card).getByRole('table');
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Tick', 'Trade', 'Trend', 'Tail', '1D', '15D', '30D', '90D']);
  expect(within(table).getByText('Bearish')).toHaveClass('is-negative');
  expect(within(table).getByText('Bullish')).toHaveClass('is-positive');
  expect(within(table).getByText('N/A')).toHaveClass('is-unavailable');
  expect(within(table).getAllByText('—')).toHaveLength(16);
  await waitFor(() => expect(within(table).getByText('−4.2%')).toBeInTheDocument());
  expect(loadHorizonStats).toHaveBeenCalledWith(['XLK']);
  expect(within(table).getByText('−4.2%')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(table).getByText('+6.4%')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(table).getByText('31%')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(table).getByText('1.6×')).not.toHaveClass('analyst-inbox-signal--negative');
  expect(within(table).getByText('—')).toHaveClass('analyst-inbox-signal--muted');
});

test('price and range colors follow their own sign for a short exactly as for a long', async () => {
  const stats = { asOf: '2026-10-20', baselineVolPct: 20, columns: [
    { label: '1D', priceChangePct: -4.0, realizedVolPct: 8, volumeRatio: 1.7, rangePct: 87 },
    { label: '15D', priceChangePct: 2.5, realizedVolPct: 4, volumeRatio: 0.4, rangePct: 11 },
    { label: '30D', priceChangePct: -1.6, realizedVolPct: 4, volumeRatio: 0.4, rangePct: 50 },
    { label: '90D', priceChangePct: -2.7, realizedVolPct: 5, volumeRatio: 0.6, rangePct: 35 },
  ] };
  const alert = attention('emif', { kind: 'portfolio', severity: 'action-required', quantity: -112.5, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    presentation: { subject: 'EMIF', date: '2026-08-31', sourceLinks: [], rows: [
      { label: 'Action', text: 'Cover' }, { label: 'Tick', text: 'N/A' }, { label: 'Trade', text: 'Unknown' }, { label: 'Trend', text: 'N/A' }, { label: 'Tail', text: 'N/A' },
    ] } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} loadHorizonStats={jest.fn().mockResolvedValue({ EMIF: stats })} />);
  const table = within(screen.getByRole('heading', { name: 'EMIF' }).closest('article')).getByRole('table');
  expect(within(table).getAllByText('N/A')).toHaveLength(4);
  await waitFor(() => expect(within(table).getByText('−4.0%')).toBeInTheDocument());
  expect(within(table).getByText('−4.0%')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(table).getByText('+2.5%')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(table).getByText('87%')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(table).getByText('11%')).toHaveClass('analyst-inbox-signal--negative');
});

test('a stance alert lists the latest product calls, then current → target → order, with a trim framed red like an exit', () => {
  const stanceAlert = (id, symbol, quantity, stance) => attention(id, { kind: 'portfolio', severity: 'action-required', quantity,
    holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    presentation: { subject: symbol, date: '2026-10-26', sourceLinks: [], stance, rows: [
      { label: 'Real-Time Alert', text: 'filler' }, { label: 'Tick', text: 'N/A' }, { label: 'Trade', text: 'N/A' }, { label: 'Trend', text: 'N/A' }, { label: 'Tail', text: 'N/A' },
    ] } });
  const lcid = stanceAlert('lcid', 'LCID', -650, { verdict: 'exit', calls: [
    { product: 'Real-Time Alert', action: 'COVER', date: '2026-10-26', bias: 'BULLISH' },
    { product: 'Signal Strength Shorts', action: 'SHORT', date: '2026-08-19', bias: 'BEARISH' },
  ], current: { side: 'SHORT', quantity: 650, weightPct: 1.16 }, target: { side: null, quantity: 0, weightPct: 0 }, order: { verb: 'BUY', quantity: 650, note: 'to close short' } });
  const mpc = stanceAlert('mpc', 'MPC', 7.5, { verdict: 'trim', name: 'Marathon Petroleum Corporation', calls: [
    { product: 'Real-Time Alert', action: 'TRIM', date: '2026-10-26', bias: 'BULLISH' },
    { product: 'Signal Strength', action: 'LONG', date: '2026-09-22', bias: 'BULLISH' },
  ], current: { side: 'LONG', quantity: 7.5, weightPct: 4.25 }, target: { side: 'LONG', quantity: 5.74, weightPct: 3.25 }, order: { verb: 'SELL', quantity: 1.76, upTo: true, note: 'stays long' } });
  render(<AnalystInbox findings={[lcid, mpc]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  const card = screen.getByRole('heading', { name: 'LCID' }).closest('article');
  const [calls, order] = within(card).getAllByRole('table');
  expect(within(calls).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Product', 'Action', 'Date', 'Bias']);
  expect(within(calls).getAllByRole('row').slice(1).map(row => row.textContent)).toEqual(['Real-Time AlertCOVEROct 26BULLISH', 'Signal Strength ShortsSHORTAug 19BEARISH']);
  expect(within(calls).getByText('SHORT')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(calls).getByText('COVER')).not.toHaveClass('analyst-inbox-signal--positive');
  expect(within(calls).getByText('BEARISH')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(order).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Current', 'Target', 'Order']);
  expect(within(order).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['1.16%', '0.00%', 'BUY 650 shares']);
  expect(within(order).getByText('1.16%')).toHaveClass('analyst-inbox-signal--negative');
  expect(within(order).getByText('BUY')).toHaveClass('analyst-inbox-signal--positive');
  expect(within(card).queryByText(/filler/)).not.toBeInTheDocument();
  const trim = screen.getByRole('heading', { name: 'MPC' }).closest('article');
  expect(trim).toHaveClass('is-action-required');
  expect(within(trim).getByText('Marathon Petroleum Corporation')).toBeInTheDocument();
  expect(within(within(trim).getAllByRole('table')[1]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['4.25%', '3.25%', 'SELL 1.76 shares']);
  expect(within(trim).getByText('4.25%')).toHaveClass('analyst-inbox-signal--positive');
});

test('a stance position without a verified weight reads —, never shares; the order keeps shares', () => {
  const alert = attention('unh', { kind: 'portfolio', severity: 'action-required', quantity: 12,
    holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    presentation: { subject: 'UNH', date: '2026-10-30', sourceLinks: [], rows: [{ label: 'Tick', text: 'N/A' }], stance: { verdict: 'trim', calls: [
      { product: 'Real-Time Alert', action: 'SELL SOME', date: '2026-10-30', bias: 'BULLISH' },
    ], current: { side: 'LONG', quantity: 12, weightPct: null }, target: { side: 'LONG', quantity: null, weightPct: null }, order: { verb: 'SELL', quantity: null, note: 'some · stays long' } } } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  const order = within(screen.getByRole('heading', { name: 'UNH' }).closest('article')).getAllByRole('table')[1];
  expect(within(order).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['—', '—', 'SELL some']);
});

test('a Trade/Trend read from list membership looks like a stated one, with its source in the tooltip', () => {
  const alert = attention('hyp', { kind: 'portfolio', severity: 'action-required', quantity: 150, holdingsVerified: true, holdingsVerifiedAt: new Date().toISOString(),
    presentation: { subject: 'HYP', date: '2026-10-15', sourceLinks: [], rows: [
      { label: 'Action', text: 'Exit Long' },
      { label: 'Tick', text: 'N/A' },
      { label: 'Trade', text: 'Bullish', basis: 'inferred', note: 'Inferred from list membership (ETF Pro LONG Oct 14); not stated by the source' },
      { label: 'Trend', text: 'N/A', basis: 'removed', note: 'ETF Pro REMOVE Oct 15: Trade and/or Trend broke; which is not stated' },
      { label: 'Tail', text: 'N/A' },
    ] } });
  render(<AnalystInbox findings={[alert]} onCitation={jest.fn()} onAcknowledge={jest.fn()} />);
  const table = within(screen.getByRole('heading', { name: 'HYP' }).closest('article')).getByRole('table');
  expect(within(table).getByText('Bullish')).toHaveClass('analyst-inbox-bias-cell is-positive', { exact: true });
  expect(within(table).getByText('Bullish')).toHaveAttribute('title', expect.stringMatching(/^Inferred from list membership/));
  expect(within(table).getAllByText('N/A')).toHaveLength(3);
  within(table).getAllByText('N/A').forEach(cell => expect(cell).toHaveClass('analyst-inbox-bias-cell is-unavailable', { exact: true }));
  expect(within(table).queryByText('from list')).not.toBeInTheDocument();
  expect(within(table).queryByText('removed')).not.toBeInTheDocument();
});

test('a Risk Range card draws the full bar with its numbers, centered under the copy, and no text row', () => {
  const card = attention('range', { kind: 'market', presentation: { subject: 'DRAM', date: '2026-11-09', rows: [
    { label: 'Signal', text: 'At the high end of the Risk Range (70%) → reload the Short.' },
    { label: 'Risk Range', text: '35.12–46.65', range: { low: 35.12, high: 46.65, price: 43.2, decimals: 2, unit: '' } }] } });
  const { container } = render(<AnalystInbox findings={[card]} />);
  const bar = screen.getByRole('img', { name: /Price 43\.20 · Risk Range 35\.12–46\.65 · 70%/ });
  expect(bar.closest('.analyst-inbox-range')).toBeInTheDocument();
  for (const figure of ['35.12', '46.65', '43.20', '38.96', '42.81', '70%']) expect(within(bar).getByText(figure)).toBeInTheDocument();
  expect(container).not.toHaveTextContent('Risk Range:');
});

test('an Alpha Code change reads Previous then New straight under its Signal, above Ticker', () => {
  const card = attention('code', { kind: 'market', presentation: { subject: 'WTI', date: '2026-11-10', rows: [
    { label: 'Signal', text: 'WTI Alpha Code changed.' }, { label: 'Previous', text: '97/92' }, { label: 'New', text: '95/91' }] } });
  render(<AnalystInbox findings={[card]} />);
  expect(screen.getAllByRole('term').map(term => term.textContent.trim())).toEqual(['Signal:', 'Previous:', 'New:', 'Ticker:']);
  expect(screen.getByText('Previous:').parentElement).toHaveTextContent('Previous: 97/92');
  expect(screen.getByText('New:').parentElement).toHaveTextContent('New: 95/91');
});

test('a notification leads with its Signal in the bold first line; an Action still leads when there is one', () => {
  const signal = attention('signal', { kind: 'market', presentation: { subject: 'SPX', date: '2026-11-09', rows: [{ label: 'Gamma throttle', text: '-22.33' }, { label: 'Signal', text: 'SPX gamma Neutral → Negative.' }] } });
  const { unmount } = render(<AnalystInbox findings={[signal]} />);
  expect(screen.getByText('Signal:').closest('.analyst-inbox-lead')).toHaveTextContent('Signal: SPX gamma Neutral → Negative.');
  expect(document.querySelector('.analyst-inbox-copy').firstElementChild).toHaveClass('analyst-inbox-lead');
  unmount();
  const action = attention('action', { kind: 'market', presentation: { subject: 'IDX', date: '2026-11-09', rows: [{ label: 'Action', text: 'Reduce to MIN' }, { label: 'Signal', text: 'Trend broke.' }] } });
  render(<AnalystInbox findings={[action]} />);
  expect(screen.getByText('Action:').closest('.analyst-inbox-lead')).toBeInTheDocument();
  expect(screen.getByText('Signal:').closest('.analyst-inbox-lead')).toBeNull();
});

test('past the end of the range only the third and its percentage are blue', () => {
  const card = attention('beyond', { kind: 'market', presentation: { subject: 'IDX', date: '2026-11-09', rows: [{ label: 'Signal', text: 'Top 1/3 RR (127%) → moving against your Short.', beyondRange: true }] } });
  const { container } = render(<AnalystInbox findings={[card]} />);
  expect(container.querySelector('.analyst-inbox-beyond-range')).toHaveTextContent(/^Top 1\/3 RR \(127%\)$/);
  expect(screen.getByText('Signal:').closest('.analyst-inbox-lead')).toHaveTextContent('Signal: Top 1/3 RR (127%) → moving against your Short.');
});

test.each(['process-sizing', 'portfolio-balance', 'dashboard-health'])('an internal %s card has no Source button or Source line', product => {
  const card = attention('internal', { kind: 'market', presentation: { subject: 'TTD', date: '2026-11-09', rows: [{ label: 'Action', text: 'Above MAX → trim to MAX.' }],
    sourceLinks: [{ label: 'atr14 evidence', citation: { id: 'cite_internal', title: 'TTD atr14', product } }] } });
  const { container } = render(<AnalystInbox findings={[card]} />);
  expect(screen.queryByRole('button', { name: 'Source' })).not.toBeInTheDocument();
  expect(container).not.toHaveTextContent('Source:');
});
