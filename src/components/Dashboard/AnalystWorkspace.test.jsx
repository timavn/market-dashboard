import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnalystPanel from './AnalystPanel';
import PersistentSurface from '../common/PersistentSurface';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';
import ReactMarkdown from 'react-markdown';
import * as analystMarkdown from './analystMarkdown';
jest.mock('./AnalystLandingStatus', () => ({ __esModule: true, default: () => null }));
jest.mock('remark-gfm', () => function mockGfm() {});
jest.mock('react-markdown', () => ({ __esModule: true, default: jest.fn(({ children }) => <div>{children}</div>), defaultUrlTransform: value => value }));
jest.mock('../../hooks/usePortfolioSecurityNames', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('../../services/analyst/analystClient', () => ({ analystWorkspaceApi: { request: jest.fn(), events: jest.fn() }, analystApi: { imports: jest.fn(async () => ({ imports: [] })) }, analystWebSocketUrl: jest.fn() }));
let conversations, stream;
const make = (id, text) => ({ id, title: `Chat ${id}`, kind: 'chat', created_at: '2026-09-04T14:00:00Z', messages: [{ id: `${id}-message`, text, role: 'assistant', state: 'complete' }], activeTurn: null, lastTurn: null, message_count: 1, archived: false });
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, writable: true, value: jest.fn(() => `request-${Math.random().toString(36).slice(2)}`) });
  conversations = { a: make('a', 'Only answer A'), b: make('b', 'Only answer B') };
  stream = { close: jest.fn(), addEventListener: jest.fn() };
  api.events.mockImplementation(() => stream);
  api.request.mockReset();
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/inbox') return { findings: [], unread: 0 };
    if (path.startsWith('/requests/')) return { status: 'missing' };
    if (path === '/daily') return { ready: false, date: '2026-09-04', missing: [{ label: 'Market Situation Report' }] };
    if (path.startsWith('/conversations?')) return { conversations: Object.values(conversations).filter(c => c.archived === path.includes('archived=true')), cursor: 0 };
    if (path.startsWith('/conversations/')) {
      const id = path.split('/')[2].split('?')[0];
      if (path.endsWith('/sources')) return { conversationId: id,
        items: [{ id: 'holdings', label: 'IBKR holdings', status: 'ready', observedAt: '2026-09-04T15:00:00Z' }] };
      if (method === 'DELETE') { delete conversations[id]; return { ok: true }; }
      if (method === 'PATCH') { conversations[id].archived = body.archived; return { ok: true }; }
      if (path.endsWith('/stop')) { conversations[id].activeTurn = null; return { ok: true }; }
      if (!conversations[id]) throw Object.assign(new Error('Conversation not found.'), { code: 'HTTP_404' });
      return { conversation: { ...conversations[id], messages: [...conversations[id].messages] } };
    }
    throw new Error(`Unexpected ${path}`);
  });
});
async function open(id) { fireEvent.click(await historyRows().findByRole('button', { name: `Open conversation: Chat ${id}` })); await screen.findByText(`Only answer ${id.toUpperCase()}`); }
// History rows live on the Analyst home tab; leave an open chat to reach them.
const home = () => { const back = screen.queryByRole('button', { name: 'Back to The Analyst' }); if (back) fireEvent.click(back); };
const historyRows = () => { home(); return screen; };
// The open chat's title sits in the header beside the way back home.
const expectSelected = async title => expect(await screen.findByText(title, { selector: '.analyst-chat-title' })).toBeInTheDocument();
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Dated Analyst chats are filed under the user's Pacific calendar day.
const pacificToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function portfolioExposureAmount(value) {
  // Dollar-only captures repeat the Value in Current. Require one Value match
  // across exposure sections so saved posts stay bound to their own book.
  const matches = screen.getAllByRole('region', { name: 'Exposure and risk' })
    .flatMap(region => [...region.querySelectorAll('.portfolio-exposure-value')].flatMap(cell => within(cell).queryAllByText(value)));
  expect(matches).toHaveLength(1);
  return matches[0];
}
const findPortfolioExposureAmount = (value, options) => waitFor(() => portfolioExposureAmount(value), options);
function reportPosition(text, offset = 600, messageId) {
  return jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const report = this.matches('.analyst-message, .portfolio-brief-centered')
      && (messageId ? this.getAttribute('data-message-id') === messageId : this.textContent.includes(text));
    return { top: report ? 100 + offset - this.closest('.analyst-transcript').scrollTop : 100,
      left: 0, right: 800, bottom: 900, width: 800, height: 800, x: 0, y: 100, toJSON() {} };
  });
}
function expectReviewProgress() {
  const report = screen.getByRole('log', { name: 'Conversation' });
  const sources = within(report).getByRole('region', { name: 'Review sources' });
  const dots = within(report).getAllByRole('status', { name: 'Response running' });
  expect(dots).toHaveLength(1);
  expect(sources.querySelector('header')).toContainElement(dots[0]);
  expect(report.querySelector('.analyst-record-date')).toBeNull();
  return report;
}

test.each(['complete', 'running'])('%s Predictive Markets Review starts with market details and hides technical failures', async state => {
  const saved = '# Predictive Markets Review\n\nPartial\n\n## Monitored markets\n\n### Silver\n\n**Venue:** ForecastEx\n\n**Missing evidence**\n\n- Client error 415 Unsupported Media Type for url http://127.0.0.1:3001/api/refresh';
  conversations = { prediction: { ...make('prediction', saved), kind: 'prediction-markets-review', title: 'Predictive Markets Review', trading_date: '2026-09-18' } };
  conversations.prediction.messages[0].state = state;
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
  await screen.findByText(/### Silver/);
  const report = screen.getByRole('log', { name: 'Conversation' });
  expect(report).not.toHaveTextContent('Missing data');
  expect(report).toHaveTextContent('ForecastEx');
  expect(report).not.toHaveTextContent('2026-09-18');
  expect(report).not.toHaveTextContent(/Predictive Markets Review|Partial|Monitored markets|Missing evidence|Client error|415|127\.0\.0\.1/);
  await waitFor(() => expect(within(report).getByRole('region', { name: 'Review sources' })).toHaveTextContent('IB Gateway'));
  expect(conversations.prediction.messages[0].text).toBe(saved);
});

test('prediction reviews retain verified comparisons and explicit follow-ups without a duplicate automatic summary', async () => {
  conversations = { prediction: { ...make('prediction', '### Silver\n\n**Trend:** Neutral\n\n**Quoted level:** 57¢ · implied 57%'), kind: 'prediction-markets-review', title: 'Predictive Markets Review' } };
  conversations.prediction.messages.push(
    { id: 'automatic', role: 'assistant', state: 'complete', reviewNarrative: true, text: 'Duplicated automatic analysis' },
    { id: 'question', role: 'user', state: 'complete', text: 'Compare the two Silver thresholds.' },
    { id: 'answer', role: 'assistant', state: 'complete', text: 'The higher threshold has lower quoted implied odds.' },
  );
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
  await screen.findByText(/### Silver/);
  const report = screen.getByRole('log', { name: 'Conversation' });
  expect(report).toHaveTextContent('implied 57%');
  expect(report).toHaveTextContent('Compare the two Silver thresholds.');
  expect(report).toHaveTextContent('The higher threshold has lower quoted implied odds.');
  expect(report).not.toHaveTextContent('Duplicated automatic analysis');
});

test('prediction report removes its private marker only at render and preserves the saved research table', async () => {
  const saved = '<!-- analyst-prediction-research-rollup -->\n\n## Interactive Brokers\n\n### CPI\n\n| Metric | Published reading |\n|---|---|\n| Forecast | 0.2% |\n\n## Kalshi\n\n### Ethereum\n\nTrend Neutral.';
  conversations = { prediction: { ...make('prediction', saved), kind: 'prediction-markets-review', title: 'Predictive Markets Review' } };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
  await screen.findByText(/## Interactive Brokers/);
  const report = screen.getByRole('article', { name: 'Predictive Markets Review' });
  expect(report).not.toHaveTextContent('analyst-prediction-research-rollup');
  expect(report).toHaveTextContent('| Metric | Published reading |');
  expect(report).toHaveTextContent('## Kalshi');
  expect(report).toHaveTextContent('Trend Neutral.');
  expect(conversations.prediction.messages[0].text).toBe(saved);
});

test('empty legacy Miscellaneous rows stay hidden while an explicitly saved selection stays selected', async () => {
  conversations = {
    misc: { ...make('misc', ''), kind: 'daily-chat', title: 'Miscellaneous', trading_date: '2026-09-04', created_at: '2026-09-05T04:00:00Z', messages: [], message_count: 0 },
    portfolio: { ...make('portfolio', 'Portfolio report'), kind: 'portfolio-review', title: 'Portfolio Review', trading_date: '2026-09-04' },
    balance: { ...make('balance', 'Balance report'), kind: 'balance-review', title: 'Balance Review', trading_date: '2026-09-04' },
    prediction: { ...make('prediction', 'Prediction report'), kind: 'prediction-markets-review', title: 'Predictive Markets Review', trading_date: '2026-09-04' },
    a: make('a', 'Only answer A'),
  };
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('misc'));
  render(<AnalystPanel />);
  await expectSelected('Miscellaneous');
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/misc'));
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
  await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  expect(historyRows().getAllByRole('button', { name: /^Open conversation:/ }).map(button => button.textContent)).toEqual([
    'Portfolio Review1 message', 'Balance Review1 message', 'Predictive Markets Review1 message', 'Chat a1 message',
  ]);
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Miscellaneous' })).not.toBeInTheDocument();
});

test('populated Miscellaneous remains available and sends into its existing conversation', async () => {
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => 'misc-first-message' });
  conversations = { misc: { ...make('misc', 'Earlier miscellaneous answer'), kind: 'daily-chat', title: 'Miscellaneous', trading_date: '2026-09-04' } };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/messages') {
      conversations.misc = { ...conversations.misc, message_count: 2, messages: [...conversations.misc.messages, { id: 'question', role: 'user', state: 'complete', text: body.text }] };
      return { conversation: conversations.misc };
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Miscellaneous' }));
  await screen.findByText('Earlier miscellaneous answer');
  const input = screen.getByRole('textbox', { name: 'Message The Analyst' });
  fireEvent.change(input, { target: { value: 'A question for today' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('A question for today');
  expect(api.request).toHaveBeenCalledWith('/messages', { text: 'A question for today', conversationId: 'misc', requestId: 'misc-first-message' });
  await waitFor(() => expect(historyRows().getByRole('button', { name: 'Open conversation: Miscellaneous' })).toHaveTextContent('2 messages'));
});

test('server-owned portfolio refresh opens the returned review and preserves its originating chat', async () => {
  Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => 'portfolio-refresh-request' });
  const original = JSON.parse(JSON.stringify(conversations.a));
  const request = api.request.getMockImplementation();
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/messages') {
      conversations.portfolio = {
        ...make('portfolio', 'Fresh portfolio findings'), kind: 'portfolio-review', title: 'Portfolio Review',
        messages: [{ id: 'refresh-question', role: 'user', state: 'complete', text: body.text },
          { id: 'refresh-report', role: 'assistant', state: 'complete', text: 'Fresh portfolio findings' }],
        message_count: 2,
      };
      return { conversation: conversations.portfolio };
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'refresh my portfolio' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Fresh portfolio findings');
  const report = screen.getByRole('log', { name: 'Conversation' });
  expect(report).toHaveTextContent('refresh my portfolio');
  expect(report).not.toHaveTextContent('Only answer A');
  expect(api.request).toHaveBeenCalledWith('/messages', { text: 'refresh my portfolio', conversationId: 'a', requestId: 'portfolio-refresh-request' });
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('portfolio');
  expect(conversations.a).toEqual(original);
  await open('a');
  expect(screen.getByRole('log', { name: 'Conversation' })).not.toHaveTextContent('refresh my portfolio');
});

test('reload restores the last selected conversation, draft and scroll without creating a chat', async () => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ a: 'Saved draft A' }));
  localStorage.setItem('analyst.workspace.scrolls', JSON.stringify({ a: 183 }));
  render(<AnalystPanel />);
  await screen.findByText('Only answer A');
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Saved draft A');
  expect(screen.getByRole('log', { name: 'Conversation' }).scrollTop).toBe(183);
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test('completed review history survives reload and exhausted reads with only navigation metadata saved', async () => {
  conversations.saved = { ...make('saved', 'Private captured account report'), kind: 'balance-review', revision: 4,
    title: 'Balance Review', message_count: 3, holdings: [{ symbol: 'PRIVATE_ACCOUNT_HOLDING' }],
    lastTurn: { id: 'saved-turn', state: 'complete', request_id: 'saved-request', error: 'Private turn diagnostic' },
    portfolioBrief: { metrics: { grossExposure: 987654 }, holdings: [{ symbol: 'PRIVATE_ACCOUNT_HOLDING' }] },
    citations: [{ excerpt: 'Private captured publication' }] };
  const request = api.request.getMockImplementation();
  const sourceRead = deferred();
  let cold = false;
  api.request.mockImplementation((path, body, method) => {
    if (cold && (path.startsWith('/conversations?') || path.startsWith('/conversations/saved?') || path === '/conversations/saved')) return Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503' }));
    if (path === '/conversations/saved/sources') return sourceRead.promise;
    return request(path, body, method);
  });
  const view = render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Balance Review' }));
  await screen.findByText('Private captured account report');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my unsent question' } });
  const transcript = screen.getByRole('log');
  transcript.scrollTop = 173;
  fireEvent.scroll(transcript);
  view.unmount();
  const index = JSON.parse(localStorage.getItem('analyst.workspace.sidebar'));
  expect(index.find(row => row.id === 'saved')).toEqual({ id: 'saved', archived: false,
    title: 'Balance Review', kind: 'balance-review', created_at: '2026-09-04T14:00:00Z', revision: 4,
    state: 'complete', message_count: 3, activeTurn: null,
    lastTurn: { id: 'saved-turn', state: 'complete', request_id: 'saved-request' } });
  expect(JSON.stringify(index)).not.toMatch(/PRIVATE_ACCOUNT_HOLDING|987654|Private captured|Private turn|messages|citations|portfolioBrief|holdings/);

  cold = true;
  api.request.mockClear();
  render(<AnalystPanel />);
  await expectSelected('Balance Review');
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('IB Gateway');
  expect(screen.getByRole('textbox')).toHaveValue('Keep my unsent question');
  expect(screen.getByRole('log').scrollTop).toBe(173);
  expect(screen.queryByText('Private captured account report')).not.toBeInTheDocument();
  await screen.findByRole('button', { name: 'Retry conversation' });
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?'))).toHaveLength(3));
  expect(api.request.mock.calls.filter(([path]) => path.split('?')[0] === '/conversations/saved')).toHaveLength(3);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('saved');

  cold = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry conversation' }));
  await screen.findByText('Private captured account report');
  await act(async () => sourceRead.resolve({ conversationId: 'saved', basis: 'review', runId: 'saved-capture', state: 'ready',
    items: [{ id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-10-08T12:00:00Z' }] }));
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('Oct 8');
  expect(screen.getByRole('textbox')).toHaveValue('Keep my unsent question');
  expect(screen.getByRole('log').scrollTop).toBe(173);
  // The saved rows and the history retry sit on the Analyst home.
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open conversation: Balance Review' })).toHaveTextContent('3 messages');
  expect(screen.queryByText('No saved conversations.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument());
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test.each(['detail hydration', 'event recovery'])('%s restores review Sources that kept checking through transient read failures, without changing its capture or Gateway status', async recovery => {
  jest.useFakeTimers();
  try {
    const saved = { ...make('saved', 'Completed captured review'), kind: 'balance-review', title: 'Balance Review', revision: 4,
      lastTurn: { id: 'saved-turn', state: 'complete', request_id: 'saved-request' } };
    conversations.saved = saved;
    localStorage.setItem('analyst.workspace.selected', JSON.stringify('saved'));
    localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([saved]));
    const detail = deferred();
    const sources = { conversationId: 'saved', basis: 'review', runId: 'saved-capture', state: 'partial',
      items: Array.from({ length: 20 }, (_, index) => ({ id: index === 0 ? 'ibGateway' : `captured-product-${index}`,
        label: index === 0 ? 'IB Gateway' : `Captured product ${index}`, status: index < 13 ? 'ready' : 'partial',
        ...(index === 0 ? { observedAt: '2026-10-09T15:30:00Z' } : { publishedAt: '2026-10-08T12:00:00Z' }) })) };
    const request = api.request.getMockImplementation();
    let detailReads = 0;
    let sourceReads = 0;
    api.request.mockImplementation((path, body, method) => {
      // The record is unreadable at first, so its Sources are read by conversation ID.
      if (path.startsWith('/conversations/saved?') || path === '/conversations/saved') return ++detailReads <= 3
        ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503' })) : detail.promise;
      if (path === '/conversations/saved/sources') return ++sourceReads <= 3
        ? Promise.reject(Object.assign(new Error('Sources warming up.'), { code: 'HTTP_503' })) : Promise.resolve(sources);
      return request(path, body, method);
    });
    render(<AnalystPanel />);
    // Its three transient record reads exhaust first, so Sources are read by conversation ID.
    await act(async () => jest.advanceTimersByTimeAsync(600));
    expect(sourceReads).toBe(1);
    await act(async () => jest.advanceTimersByTimeAsync(1500));
    expect(sourceReads).toBe(2);
    // AGENTS.md: transient metadata-read failures keep unfinished rows Checking
    // and keep reading; they never settle the capture as Unavailable.
    const retrying = screen.getByRole('region', { name: 'Review sources' });
    expect(retrying).not.toHaveTextContent(/ready/);
    expect(retrying).toHaveAttribute('aria-busy', 'true');
    expect(retrying.querySelector('header')).toHaveTextContent('Reconnecting…');
    expect(retrying).not.toHaveTextContent('Unavailable');
    if (recovery === 'detail hydration') await act(async () => detail.resolve({ conversation: saved, cursor: 0 }));
    else {
      const unavailable = stream.addEventListener.mock.calls.find(([name]) => name === 'unavailable')[1];
      const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
      act(() => { unavailable(); ready({ data: JSON.stringify({ cursor: 0 }) }); });
      await act(async () => jest.advanceTimersByTimeAsync(0));
    }
    expect(sourceReads).toBe(3);
    await act(async () => jest.advanceTimersByTimeAsync(6000));
    const sourceTable = screen.getByRole('region', { name: 'Review sources' });
    expect(sourceTable).toHaveTextContent('13/20 ready');
    expect(sourceTable).toHaveAttribute('aria-busy', 'false');
    expect(within(sourceTable).getByText('IB Gateway').closest('.analyst-review-source')).toHaveTextContent('Ready');
    expect(within(sourceTable).queryByRole('button', { name: 'IB Gateway: Unavailable. Show explanation' })).not.toBeInTheDocument();
    expect(within(sourceTable).getByText('Captured product 19').closest('.analyst-review-source')).toHaveTextContent('Partial');
    expect(sourceReads).toBe(4);
    await act(async () => detail.resolve({ conversation: saved, cursor: 0 }));
    await act(async () => jest.advanceTimersByTimeAsync(0));
    const settledReads = sourceReads;
    const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
    act(() => { ready({ data: JSON.stringify({ cursor: 0 }) }); ready({ data: JSON.stringify({ cursor: 0 }) }); });
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    expect(sourceReads).toBe(settledReads);
    expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('13/20 ready');
    expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('saved');
    expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('reload automatically retries transient history and selected reads without resubmitting a completed chat', async () => {
  const view = render(<AnalystPanel />);
  await open('a');
  view.unmount();
  const request = api.request.getMockImplementation();
  const reads = { history: 0, conversation: 0 };
  api.request.mockImplementation((path, body, method) => {
    const key = path.startsWith('/conversations?') ? 'history' : path === '/conversations/a' ? 'conversation' : null;
    if (key && ++reads[key] < 3) return Promise.reject(Object.assign(new Error('API warming up.'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
    return request(path, body, method);
  });
  api.request.mockClear();
  render(<AnalystPanel />);
  await expectSelected('Chat a');
  await screen.findByText('Only answer A');
  await waitFor(() => expect(reads).toEqual({ history: 3, conversation: 3 }));
  expect(screen.queryByRole('button', { name: 'Retry conversation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test('verified sidebar rows survive list omissions and reload until an exact deletion receipt evicts them', async () => {
  const view = render(<AnalystPanel />);
  await open('a');
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path.startsWith('/conversations?')
    ? Promise.resolve({ conversations: [conversations.b], cursor: 0 }) : request(path, body, method));
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'unopened', type: 'complete' }) }));
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?'))).toHaveLength(2));
  await expectSelected('Chat a');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).some(row => row.id === 'a')).toBe(true);
  view.unmount();
  render(<AnalystPanel />);
  await expectSelected('Chat a');
  await screen.findByText('Only answer A');
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 2, conversation_id: 'a', type: 'deleted' }) }));
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).some(row => row.id === 'a')).toBe(false);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBeNull();
});

test.each(['ANALYST_CONVERSATION_NOT_FOUND', 'ANALYST_CONVERSATION_DELETED'])('a verified selected %s response evicts persisted navigation without transient retries', async serverCode => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('deleted'));
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([make('deleted', 'Private deleted report')]));
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/conversations/deleted'
    ? Promise.reject(Object.assign(new Error('Conversation unavailable.'), { code: serverCode, serverCode,
      status: serverCode === 'ANALYST_CONVERSATION_DELETED' ? 410 : 404 }))
    : request(path, body, method));
  render(<AnalystPanel />);
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat deleted' })).not.toBeInTheDocument());
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/deleted')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).some(row => row.id === 'deleted')).toBe(false);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBeNull();
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
});

test.each(['deleted', 'archived'])('a saved row the full list omits is read and evicted once the server says it is %s', async outcome => {
  // Deleted or archived while this page was closed: no event will ever arrive.
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([make('gone', 'Old capture'), conversations.a]));
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/gone') {
      return outcome === 'deleted'
        ? Promise.reject(Object.assign(new Error('Conversation was deleted'), { code: 'HTTP_410', serverCode: 'ANALYST_CONVERSATION_DELETED', status: 410 }))
        : Promise.resolve({ conversation: { ...make('gone', 'Old capture'), archived: true }, cursor: 0 });
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await waitFor(() => expect(JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).some(row => row.id === 'gone')).toBe(false));
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat gone' })).not.toBeInTheDocument();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeVisible();
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a')).toHaveLength(0);
});

test.each(['code-less 404', 'archived'])('a %s read keeps the saved receipt, draft and reader position', async failure => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a, conversations.b]));
  localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ a: 'Unsent question for A' }));
  localStorage.setItem('analyst.workspace.scrolls', JSON.stringify({ a: 141 }));
  const request = api.request.getMockImplementation();
  let unreadable = true;
  if (failure === 'archived') conversations.a = { ...conversations.a, archived: true };
  api.request.mockImplementation((path, body, method) => path === '/conversations/a' && unreadable && failure !== 'archived'
    ? Promise.reject(Object.assign(new Error('Not found'), { code: 'HTTP_404', status: 404 }))
    : request(path, body, method));
  render(<AnalystPanel />);
  await screen.findByRole('button', { name: 'Retry conversation' });
  expect(screen.getByText(/Conversation unavailable/)).toBeVisible();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('a');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).a).toBe('Unsent question for A');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.scrolls')).a).toBe(141);
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Unsent question for A');
  // Archived rows are excluded from history, never treated as deleted. The
  // open chat hides history, so the saved receipt is what proves it here.
  const listed = failure !== 'archived';
  expect(JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).some(row => row.id === 'a')).toBe(listed);
  unreadable = false;
  conversations.a = { ...conversations.a, archived: false };
  fireEvent.click(screen.getByRole('button', { name: 'Retry conversation' }));
  await screen.findByText('Only answer A');
  expect(screen.getByRole('log').scrollTop).toBe(141);
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Unsent question for A');
});

test('a code-less 404 retries the selected conversation automatically with capped backoff', async () => {
  jest.useFakeTimers();
  try {
    localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
    localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a]));
    const request = api.request.getMockImplementation();
    let reads = 0;
    api.request.mockImplementation((path, body, method) => path === '/conversations/a' && ++reads <= 3
      ? Promise.reject(Object.assign(new Error('Not found'), { code: 'HTTP_404', status: 404 }))
      : request(path, body, method));
    render(<AnalystPanel />);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    expect(reads).toBe(1);
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeVisible();
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(reads).toBe(2);
    await act(async () => jest.advanceTimersByTimeAsync(1999));
    expect(reads).toBe(2);
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(reads).toBe(3);
    await act(async () => jest.advanceTimersByTimeAsync(4000));
    expect(reads).toBe(4);
    expect(screen.getByText('Only answer A')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry conversation' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('a');
  } finally { jest.useRealTimers(); }
});

test.each(['code-less 404', 'archived'])('a selected %s read stays bounded while the event stream is open', async failure => {
  jest.useFakeTimers();
  try {
    localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
    localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a, conversations.b]));
    const request = api.request.getMockImplementation();
    if (failure === 'archived') conversations.a = { ...conversations.a, archived: true };
    api.request.mockImplementation((path, body, method) => path === '/conversations/a' && failure !== 'archived'
      ? Promise.reject(Object.assign(new Error('Not found'), { code: 'HTTP_404', status: 404 }))
      : request(path, body, method));
    render(<AnalystPanel />);
    await act(async () => jest.advanceTimersByTimeAsync(0));
    const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
    act(() => { stream.readyState = 1; stream.onopen(); ready({ data: JSON.stringify({ cursor: 9 }) }); });
    await act(async () => jest.advanceTimersByTimeAsync(30_000));
    const reads = predicate => api.request.mock.calls.filter(([path]) => predicate(path)).length;
    // The open stream's two-second tick must not re-read it; only the capped
    // backoff (1, 2, 4, 8, 15 s) retries a code-less 404, and archived is final.
    expect(reads(path => path === '/conversations/a')).toBeLessThanOrEqual(failure === 'archived' ? 3 : 9);
    expect(reads(path => path.startsWith('/conversations?'))).toBeLessThanOrEqual(4);
    expect(reads(path => path === '/inbox')).toBeLessThanOrEqual(9);
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeVisible();
    expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('a');
  } finally { jest.useRealTimers(); }
});

test('a completed list-only snapshot replaces a persisted acceptance state before cold reload', async () => {
  conversations.a = { ...conversations.a, revision: 1, activeTurn: { id: 'accepted-turn', request_id: 'accepted-request', state: 'accepted' } };
  const view = render(<AnalystPanel />);
  await open('a');
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('Responding…');
  const request = api.request.getMockImplementation();
  const completed = { id: 'a', title: 'Chat a', kind: 'chat', created_at: '2026-09-04T14:00:00Z', revision: 2, state: 'complete', message_count: 3, archived: false };
  api.request.mockImplementation((path, body, method) => path.startsWith('/conversations?')
    ? Promise.resolve({ conversations: [completed, conversations.b], cursor: 0 }) : request(path, body, method));
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'unopened', type: 'complete' }) }));
  await waitFor(() => expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('3 messages'));
  const stored = JSON.parse(localStorage.getItem('analyst.workspace.sidebar')).find(row => row.id === 'a');
  expect(stored.state).toBe('complete');
  expect(stored.activeTurn).toBeUndefined();
  view.unmount();
  api.request.mockImplementation((path, body, method) => path.startsWith('/conversations')
    ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503' })) : request(path, body, method));
  // Reading the row went home; reopen Chat a across the reload.
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  render(<AnalystPanel />);
  await expectSelected('Chat a');
  await screen.findByRole('button', { name: 'Retry conversation' });
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('3 messages');
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).not.toHaveTextContent('Responding…');
});

test('live event recovery refreshes completed selected history after cold-start reads exhaust', async () => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  const request = api.request.getMockImplementation();
  let cold = true;
  api.events.mockClear();
  api.request.mockImplementation((path, body, method) => cold && path.startsWith('/conversations')
    ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503' })) : request(path, body, method));
  render(<AnalystPanel />);
  await waitFor(() => expect(api.events).toHaveBeenCalledWith('latest'));
  await screen.findByRole('button', { name: 'Retry conversation' }, { timeout: 2000 });
  cold = false;
  const unavailable = stream.addEventListener.mock.calls.find(([name]) => name === 'unavailable')[1];
  const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
  act(() => { unavailable(); ready({ data: JSON.stringify({ cursor: 142_281 }) }); });
  await screen.findByText('Only answer A');
  await expectSelected('Chat a');
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat b' })).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument());
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test.each(['before', 'after'])('a live-tail handshake %s initial snapshots resolves closes the accepted-chat and completion gap', async order => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a, conversations.b]));
  localStorage.setItem('analyst.workspace.scrolls', JSON.stringify({ a: 121 }));
  const initialRows = Object.values(conversations);
  const initialConversation = conversations.a;
  const history = deferred();
  const detail = deferred();
  const request = api.request.getMockImplementation();
  let historyReads = 0;
  let detailReads = 0;
  api.request.mockImplementation((path, body, method) => {
    if (path.startsWith('/conversations?')) return ++historyReads === 1 ? history.promise
      : Promise.resolve({ conversations: Object.values(conversations), cursor: 20 });
    if (path === '/conversations/a') return ++detailReads === 1 ? detail.promise
      : Promise.resolve({ conversation: conversations.a, cursor: 20 });
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await waitFor(() => expect(historyReads).toBe(1));
  await waitFor(() => expect(detailReads).toBe(1));
  const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
  if (order === 'before') act(() => ready({ data: JSON.stringify({ cursor: 20 }) }));
  await act(async () => {
    history.resolve({ conversations: initialRows, cursor: 10 });
    detail.resolve({ conversation: initialConversation, cursor: 10 });
    conversations.c = make('c', 'Only answer C');
    conversations.a = { ...conversations.a, revision: 2, messages: [{ id: 'new-answer', role: 'assistant', text: 'Completed in the subscription gap', state: 'complete' }] };
  });
  if (order === 'after') act(() => ready({ data: JSON.stringify({ cursor: 20 }) }));
  await screen.findByText('Completed in the subscription gap');
  await expectSelected('Chat a');
  expect(screen.getByRole('log').scrollTop).toBe(121);
  expect(await historyRows().findByRole('button', { name: 'Open conversation: Chat c' })).toBeVisible();
  expect(historyReads).toBe(2);
  expect(detailReads).toBe(2);
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test('a later sidebar snapshot cannot skip streamed completion while an older selected detail is pending', async () => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a]));
  const detail = deferred();
  const request = api.request.getMockImplementation();
  let detailReads = 0;
  api.request.mockImplementation((path, body, method) => {
    if (path.startsWith('/conversations?')) return Promise.resolve({ conversations: Object.values(conversations), cursor: 30 });
    if (path === '/conversations/a') return ++detailReads === 1 ? detail.promise
      : Promise.resolve({ conversation: conversations.a, cursor: 30 });
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await waitFor(() => expect(detailReads).toBe(1));
  const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
  act(() => ready({ data: JSON.stringify({ cursor: 20 }) }));
  const original = conversations.a;
  conversations.a = { ...conversations.a, revision: 2, messages: [{ id: 'completion', role: 'assistant', text: 'Streamed completion after the detail snapshot', state: 'complete' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 25, conversation_id: 'a', type: 'complete' }) }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
  await act(async () => detail.resolve({ conversation: original, cursor: 21 }));
  await screen.findByText('Streamed completion after the detail snapshot');
  expect(detailReads).toBe(2);
  await expectSelected('Chat a');
});

test.each(['draft', 'activeTurn', 'running', 'accepted'])('empty Miscellaneous with %s remains accessible without being selected automatically', async activity => {
  conversations = { misc: { ...make('misc', ''), kind: 'daily-chat', title: 'Miscellaneous', trading_date: '2026-09-04', messages: [], message_count: 0 } };
  if (activity === 'draft') localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ misc: 'An unsent question' }));
  else if (activity === 'activeTurn') conversations.misc.activeTurn = { id: 'misc-turn' };
  else conversations.misc.state = activity;
  render(<AnalystPanel />);
  expect(await historyRows().findByRole('button', { name: 'Open conversation: Miscellaneous' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Miscellaneous' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue(activity === 'draft' ? 'An unsent question' : ''));
});

test('a Systems health card never reaches the Inbox; it belongs in Systems', async () => {
  const request = api.request.getMockImplementation();
  const citation = { title: 'Systems', product: 'dashboard-health', publicationDate: '2026-09-22',
    sourceUri: '/api/system-readiness', excerpt: 'IB Gateway is disconnected. Portfolio holdings and balances cannot refresh.' };
  const alert = { id: 'gateway', unread: 1, payload: { attentionVersion: 1, kind: 'operational', state: 'open',
    presentation: { subject: 'IB Gateway', date: '2026-09-22', rows: [{ label: 'Issue', text: 'IB Gateway is disconnected.' }],
      sourceLinks: [{ label: 'Systems', citation }] } } };
  api.request.mockImplementation((path, body, method) => path === '/inbox' ? Promise.resolve({ attentionVersion: 1, findings: [alert], unread: 1 }) : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }));
  expect(await screen.findByText('No new items requiring attention.')).toBeInTheDocument();
  expect(screen.queryByText('IB Gateway is disconnected.')).not.toBeInTheDocument();
});

// Opens an Inbox Source whose citation names a stored email; `stored` says whether the server has it.
async function openEmailedSource(stored) {
  const request = api.request.getMockImplementation();
  const citation = { id: 'cite_vlo', title: 'Signal Strength: VLO Removed', product: 'signal-strength', publicationDate: '2026-10-29',
    sourceUri: 'https://app.hedgeye.com/feed_items/189162', excerpt: 'VLO Removed', sourceMessageId: '1a1882c17cfb415f', clipTicker: 'VLO' };
  const alert = { id: 'vlo', unread: 1, payload: { attentionVersion: 1, kind: 'opportunity', state: 'open',
    presentation: { subject: 'VLO', date: '2026-10-29', rows: [{ label: 'Action', text: 'Removed' }], sourceLinks: [{ label: 'Signal Strength', citation }] } } };
  const email = '<html><head></head><body><b>REMOVING:</b> MPC, NOW, <mark id="analyst-source-hit">VLO</mark></body></html>';
  api.request.mockImplementation((path, body, method) => {
    if (path === '/inbox') return Promise.resolve({ attentionVersion: 1, findings: [alert], unread: 1 });
    if (path.startsWith('/source-email/')) return stored ? Promise.resolve({ html: email, found: true }) : Promise.reject(Object.assign(new Error('Source email not stored'), { code: 'HTTP_404' }));
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Source', exact: true }));
  const popover = screen.getByRole('dialog', { name: 'Citation source' });
  expect(api.request).toHaveBeenCalledWith('/source-email/1a1882c17cfb415f?find=VLO');
  // The title reads plainly; the report opens from the link under the email.
  expect(within(popover).getByText('Signal Strength: VLO Removed')).not.toHaveAttribute('href');
  expect(within(popover).getByRole('link', { name: 'Open original report ↗' })).toHaveAttribute('href', citation.sourceUri);
  return { popover, email };
}

test('an emailed inbox Source shows the original email clipped around the ticker, with the report link under it', async () => {
  const { popover, email } = await openEmailedSource(true);
  const frame = await within(popover).findByTitle('Original email: Signal Strength: VLO Removed');
  expect(frame.tagName).toBe('IFRAME');
  expect(frame.getAttribute('srcdoc')).toBe(email);
  // Nothing in the email runs; its links open in a new tab.
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  expect(popover.querySelector('blockquote')).toBeNull();
});

test('an emailed inbox Source keeps the excerpt when the original email was never stored', async () => {
  const { popover } = await openEmailedSource(false);
  await waitFor(() => expect(popover.querySelector('blockquote')).toHaveTextContent('VLO Removed'));
  expect(popover.querySelector('iframe')).toBeNull();
});

test('inbox shows the named source signal and preserves acknowledgment and citation actions', async () => {
  const dispatch = jest.spyOn(window, 'dispatchEvent');
  const request = api.request.getMockImplementation();
  const alert = { id: 'alert', symbol: 'IBIT', action: 'signal change', state: 'pending verification', unread: 1,
    payload: { action: 'signal change', summary: 'Bitcoin Tracker reported signal change. Reading this finding does not confirm a trade.',
      event: { eventType: 'trade_signal', signalValue: 'BULLISH', qualityStatus: 'validated', productLabel: 'Bitcoin Tracker', marketDate: '2026-09-14',
        entityId: 'IBIT', signalProvenance: { field: 'trade', method: 'explicit-field', sourceField: 'data.IBIT.trade', sourceText: 'IBIT trade BULLISH' } },
      citation: { title: 'Bitcoin Tracker', excerpt: 'IBIT trade BULLISH', publicationDate: '2026-09-14', sourceUri: 'https://app.hedgeye.com/feed_items/source' } } };
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/inbox') return { findings: [{ ...alert }], unread: alert.unread };
    if (path === '/inbox/alert/read') { alert.unread = 0; return { ok: true }; }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }));
  await screen.findByRole('heading', { name: 'IBIT' });
  const inbox = screen.getByRole('region', { name: 'Portfolio inbox' });
  expect(within(inbox).queryByRole('heading', { name: 'Portfolio inbox' })).not.toBeInTheDocument();
  expect(within(inbox).getByText('Trade:')).toBeInTheDocument();
  expect(within(inbox).queryByRole('listitem')).not.toBeInTheDocument();
  expect(within(inbox).getByText('Bullish', { exact: true })).toHaveClass('analyst-inbox-signal--positive');
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
    type: 'analyst-inbox', detail: { findings: [alert], unread: 1, actionRequired: 0 },
  }));
  expect(screen.getByRole('tab', { name: /^Inbox/ })).toHaveTextContent('Inbox1');
  expect(api.request.mock.calls.some(([path]) => path === '/monitor')).toBe(false);
  expect(screen.queryByText(/pending verification|does not confirm a trade|signal change/i)).not.toBeInTheDocument();
  const source = screen.getByRole('button', { name: 'Source' });
  fireEvent.click(source);
  // Inbox Source is a compact popover: publication, date and excerpt, with the title opening the report.
  const popover = screen.getByRole('dialog', { name: 'Citation source' });
  expect(popover).toHaveClass('is-anchored');
  expect(popover).toHaveTextContent('IBIT trade BULLISH');
  expect(popover).not.toHaveTextContent('Source evidence');
  expect(within(popover).getByRole('link', { name: 'Bitcoin Tracker ↗' })).toHaveAttribute('href', alert.payload.citation.sourceUri);
  fireEvent.click(source);
  expect(screen.queryByRole('dialog', { name: 'Citation source' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('textbox', { name: 'Message The Analyst' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/inbox/alert/read', { acknowledge: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument());
  expect(screen.getByRole('tab', { name: /^Inbox/ })).toHaveTextContent(/^Inbox$/);
  dispatch.mockRestore();
});

test('with room left of the Analyst window, an inbox Source docks there centered on the window and holds still on scroll', async () => {
  const request = api.request.getMockImplementation();
  const alert = { id: 'alert', symbol: 'IBIT', action: 'signal change', state: 'pending verification', unread: 1,
    payload: { action: 'signal change', event: { eventType: 'trade_signal', signalValue: 'BULLISH', qualityStatus: 'validated', productLabel: 'Bitcoin Tracker', marketDate: '2026-09-14',
      entityId: 'IBIT', signalProvenance: { field: 'trade', method: 'explicit-field', sourceField: 'data.IBIT.trade', sourceText: 'IBIT trade BULLISH' } },
    citation: { title: 'Bitcoin Tracker', excerpt: 'IBIT trade BULLISH', publicationDate: '2026-09-14', sourceUri: 'https://app.hedgeye.com/feed_items/source' } } };
  api.request.mockImplementation(async (path, body, method) => (path === '/inbox' ? { findings: [alert], unread: 1 } : request(path, body, method)));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }));
  await screen.findByRole('heading', { name: 'IBIT' });
  const card = screen.getByRole('heading', { name: 'IBIT' }).closest('.analyst-inbox-finding');
  const rect = (left, top) => ({ left, top, right: left + 440, bottom: top + 400, width: 440, height: 400, x: left, y: top });
  const bounds = jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function bounds() {
    if (this.classList.contains('analyst-workspace')) return rect(600, 8);
    return rect(0, 0);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  const popover = screen.getByRole('dialog', { name: 'Citation source' });
  expect(popover).toHaveClass('is-docked');
  expect(popover.style).toMatchObject({ width: '420px', left: '168px', top: '208px', maxHeight: '400px' });
  expect(card).toHaveAttribute('data-cited');
  fireEvent.scroll(document);
  expect(popover.style.top).toBe('208px');
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(card).not.toHaveAttribute('data-cited');
  bounds.mockRestore();
});

test('an inbox Source with several publications shows one at a time, paged by its arrows or its squares', async () => {
  const request = api.request.getMockImplementation();
  const citation = (title, excerpt) => ({ title, excerpt, publicationDate: '2026-10-30' });
  const alert = { id: 'alert', unread: 1, payload: { attentionVersion: 1, state: 'open', kind: 'opportunity', priority: 0, fingerprint: 'alert-revision',
    publicationTime: '2026-10-30T15:30:00Z', presentation: { subject: 'UNH', date: '2026-10-30', rows: [{ label: 'Issue', text: 'UNH changed.' }],
      sourceLinks: [{ label: 'Alert', citation: citation('Real-Time Alert: UNH Sell', 'SELL SIGNAL UNH') },
        { label: 'Signal', citation: citation('Signal Strength: UNH Removed', 'REMOVING: UNH') }] } } };
  api.request.mockImplementation(async (path, body, method) => (path === '/inbox' ? { findings: [alert], unread: 1 } : request(path, body, method)));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('tab', { name: /^Inbox/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
  const popover = screen.getByRole('dialog', { name: 'Citation source' });
  const shown = () => [popover.querySelector('.analyst-source-pager span').textContent, popover.querySelectorAll('article').length,
    within(popover).getAllByRole('button', { name: /^Source \d/ }).map(square => square.getAttribute('aria-current'))];
  expect(shown()).toEqual(['1 of 2 · Real-Time Alert', 1, ['true', null]]);
  expect(popover).toHaveTextContent('SELL SIGNAL UNH');
  fireEvent.click(within(popover).getByRole('button', { name: 'Source 2: Signal Strength: UNH Removed' }));
  expect(shown()).toEqual(['2 of 2 · Signal Strength', 1, [null, 'true']]);
  expect(popover).toHaveTextContent('REMOVING: UNH');
  fireEvent.click(within(popover).getByRole('button', { name: 'Next source' }));
  expect(shown()[0]).toBe('1 of 2 · Real-Time Alert');
  fireEvent.click(within(popover).getByRole('button', { name: 'Previous source' }));
  expect(shown()[0]).toBe('2 of 2 · Signal Strength');
});

test('new chat creates no row; search is server-side and review actions remain available', async () => {
  render(<AnalystPanel />);
  await screen.findByRole('button', { name: 'Portfolio Review' });
  expect(screen.getByRole('button', { name: 'Predictive Markets Review' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Balance Review' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Start a review' })).getAllByRole('button').map(button => [button.getAttribute('aria-label'), button.textContent, button.getAttribute('aria-keyshortcuts')])).toEqual([
    ['Portfolio Review', 'Portfolio reviewP', 'P'], ['Predictive Markets Review', 'Predictive marketsM', 'M']]);
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'The Analyst', exact: true }), { key: 'U' });
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/'))).toBe(false);
  expect(screen.queryByText(/Waiting for|Research ready|Market Situation Report/i)).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path]) => path === '/daily')).toBe(false);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle in archived body' } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations?q=needle%20in%20archived%20body&archived=false'));
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
});

test('history has no archive controls and keeps legacy hidden conversations hidden', async () => {
  conversations.old = { ...make('old', 'Archived answer'), archived: true };
  render(<AnalystPanel />);
  await open('a');
  home();
  expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByRole('checkbox', { name: 'Show archived' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Archive conversation/ })).not.toBeInTheDocument();
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat old' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path, , method]) => path.includes('archived=true') || method === 'PATCH')).toBe(false);
  expect(Object.keys(conversations)).toEqual(['a', 'b', 'old']);
});

test('a message the server never received returns to the composer once, with no banner or retry button', async () => {
  const text = 'Find bitcoin alpha codes for today.';
  localStorage.setItem('analyst.workspace.outbox', JSON.stringify({ requestId: 'never-arrived', conversationId: null, text }));
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/requests/never-arrived'
    ? Promise.resolve({ status: 'missing', requestId: 'never-arrived' }) : request(path, body, method));
  const view = render(<AnalystPanel />);
  await screen.findByText('Not sent · ↵ to resend');
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue(text);
  expect(screen.queryByRole('button', { name: /Retry|Resend/ })).not.toBeInTheDocument();
  expect(document.querySelector('.analyst-inline-error')).toBeNull();
  // Its ID stays so a late arrival still reconciles, but the note is said once.
  expect(JSON.parse(localStorage.getItem('analyst.workspace.outbox'))).toMatchObject({ requestId: 'never-arrived', settled: true });
  view.unmount();
  api.request.mockClear();
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue(text);
  expect(screen.queryByText('Not sent · ↵ to resend')).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path]) => path === '/requests/never-arrived')).toBe(false);
});

test('a stopped response states its condition once, with Retry as the only action', async () => {
  conversations.a = { ...conversations.a, lastTurn: { id: 'stopped-turn', state: 'interrupted', request_id: 'stopped-request', error: 'Response stopped. Retry is available.' } };
  render(<AnalystPanel />);
  await open('a');
  expect(await screen.findByText('Response stopped.')).toBeVisible();
  expect(screen.queryByText(/Retry is available/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect(document.querySelector('.analyst-inline-error')).toBeNull();
});

test('editing a returned draft ends its not-sent note', async () => {
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages'
    ? Promise.reject(Object.assign(new Error('The Analyst is connecting.'), { code: 'ANALYST_STARTING' })) : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  const input = screen.getByRole('textbox', { name: 'Message The Analyst' });
  fireEvent.change(input, { target: { value: 'Original question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Not sent · Analyst connecting · ↵ to resend');
  fireEvent.change(input, { target: { value: 'Original question, revised' } });
  expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();
});

test('exhausted request reads keep the selected chat and Resend carries the same ID', async () => {
  const requestId = 'chat-confirmation-retry';
  const owner = 'a';
  const submission = { requestId, conversationId: owner, text: 'Already submitted request' };
  localStorage.setItem('analyst.workspace.outbox', JSON.stringify(submission));
  localStorage.setItem('analyst.workspace.selected', JSON.stringify(owner));
  localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ [owner]: 'Keep the newer draft' }));
  const request = api.request.getMockImplementation();
  let reads = 0;
  const accepted = { ...make('a', 'Accepted response recovered'),
    lastTurn: { id: 'accepted-turn', request_id: requestId, state: 'complete' } };
  api.request.mockImplementation((path, body, method) => {
    if (path === '/messages') return Promise.resolve({ created: false, conversation: accepted });
    if (path !== `/requests/${requestId}`) return request(path, body, method);
    reads += 1;
    return Promise.reject(Object.assign(new Error('Connection interrupted.'), { code: 'ANALYST_REQUEST_TIMEOUT' }));
  });
  render(<AnalystPanel />);
  await screen.findByRole('button', { name: 'Resend' }, { timeout: 2000 });
  expect(screen.getByText('Delivery unconfirmed: Already submitted request')).toBeVisible();
  expect(reads).toBe(3);
  expect(screen.queryByRole('region', { name: 'Review sources' })).not.toBeInTheDocument();
  expect(screen.getByText('Only answer A')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('Keep the newer draft');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.outbox'))).toEqual(submission);
  conversations[accepted.id] = accepted;
  fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
  await screen.findByText('Accepted response recovered');
  expect(api.request.mock.calls.filter(([path]) => path === '/messages').map(([, body]) => body.requestId)).toEqual([requestId]);
  expect(screen.getByRole('textbox')).toHaveValue('Keep the newer draft');
  expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.outbox'))).toBeNull();
});

test('Portfolio launch reserves account tables before acceptance without displaying any financial values', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  const report = expectReviewProgress();
  const body = within(report).getByRole('article', { name: 'Portfolio Review summary' });
  expect(body).toHaveAttribute('aria-busy', 'true');
  expect(within(body).getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Loading…');
  expect(within(body).getByRole('table', { name: 'Portfolio exposure' }).querySelectorAll('tbody tr')).toHaveLength(4);
  expect(within(body).getByRole('region', { name: 'Action required' })).toHaveTextContent('Loading…');
  expect(within(body).getByRole('table', { name: 'Action required' })).toBeVisible();
  expect(body).not.toHaveTextContent(/\$|\d+\.\d+%/);
});

test.each([
  ['p', 'portfolio-review'],
  ['M', 'prediction-markets-review'],
])('the landing shortcut %s starts its review, but not while typing', async (key, kind) => {
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === `/daily/${kind}`
    ? Promise.resolve({ conversation: conversations.a }) : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message The Analyst' }), { key });
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'The Analyst', exact: true }), { key, metaKey: true });
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/'))).toBe(false);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Open conversation: Chat a' }), { key });
  await screen.findByText('Only answer A');
  expect(api.request).toHaveBeenCalledWith(`/daily/${kind}`, { requestId: expect.stringMatching(/^review-start:/) });
});

test('the Chats tab lists saved conversations with their status and opens one', async () => {
  conversations.b = { ...conversations.b, kind: 'prediction-markets-review', title: 'Predictive Markets Review', updated_at: '2026-09-05T20:41:00Z' };
  conversations.a = { ...conversations.a, state: 'running' };
  render(<AnalystPanel />);
  expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true');
  const chats = screen.getByRole('tabpanel');
  await waitFor(() => expect(within(chats).getAllByRole('button', { name: /^Open conversation:/ })).toHaveLength(2));
  expect(within(chats).getByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveTextContent('1 message');
  expect(within(chats).getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('Responding…');
  fireEvent.click(within(chats).getByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText('Only answer A');
  await expectSelected('Chat a');
  expect(screen.queryByRole('tablist', { name: 'Analyst home' })).not.toBeInTheDocument();
});

test.each([
  ['Portfolio Review', 'portfolio-review'],
  ['Predictive Markets Review', 'prediction-markets-review'],
])('the landing action %s still opens its existing review workflow', async (label, kind) => {
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === `/daily/${kind}`
    ? Promise.resolve({ conversation: conversations.a }) : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  await screen.findByText('Only answer A');
  expect(api.request).toHaveBeenCalledWith(`/daily/${kind}`, { requestId: expect.stringMatching(/^review-start:/) });
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
});

test.each([
  ['Portfolio Review', 'portfolio-review'],
  ['Predictive Markets Review', 'prediction-markets-review'],
])('%s immediately shows Sources and one running indicator before acceptance, then clears it on completion', async (label, kind) => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === `/daily/${kind}` ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Keep this unsent draft' } });
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  const report = expectReviewProgress();
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(report).not.toHaveTextContent(/Portfolio Review|Predictive Markets Review|Balance Review|2026-09-18/);
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(api.request).toHaveBeenCalledWith(`/daily/${kind}`, { requestId: expect.stringMatching(/^review-start:/) });
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
  // A reload restores this one Starting slot from its exact request reference only.
  const launchRequest = api.request.mock.calls.find(([path]) => path === `/daily/${kind}`)[1].requestId;
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe(`pending-review:${launchRequest}`);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([{ kind, requestId: launchRequest,
    tradingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), launchKey: `${kind}:`, startedAt: expect.any(String) }]);

  conversations.review = { ...make('review', ''), title: label, kind, trading_date: '2026-09-18', messages: [], activeTurn: { id: 'review-turn' } };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  expectReviewProgress();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('review');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
  conversations.review = { ...conversations.review, activeTurn: null, lastTurn: { id: 'review-turn', state: 'complete' },
    messages: [{ id: 'finished', role: 'assistant', state: 'complete', text: 'The completed review is ready.' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'review' }) }));
  await screen.findByText('The completed review is ready.');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(report.querySelector('.analyst-record-date')).toBeNull();
});

test.each(['Back to The Analyst', 'history'])('%s navigation leaves a pending launch and its late response cannot select the review', async destination => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat b' });
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  expectReviewProgress();
  if (destination === 'history') await open('b');
  else fireEvent.click(screen.getByRole('button', { name: destination, exact: true }));
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  conversations.review = { ...make('review', 'Late launched review'), kind: 'portfolio-review' };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  expect(screen.queryByText('Late launched review')).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe(destination === 'history' ? 'b' : null);
  const destinationContent = destination === 'Back to The Analyst' ? screen.getByRole('group', { name: 'Start a review' }) : screen.getByText('Only answer B');
  expect(destinationContent).toBeInTheDocument();
});

test('duplicate clicks share one pending launch and a newer different review keeps its loading shell', async () => {
  const portfolio = deferred();
  const predictive = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? portfolio.promise
    : path === '/daily/prediction-markets-review' ? predictive.promise : request(path, body, method));
  render(<AnalystPanel />);
  const start = screen.getByRole('button', { name: 'Portfolio Review', exact: true });
  act(() => { start.click(); start.click(); });
  expect(api.request.mock.calls.filter(([path]) => path === '/daily/portfolio-review')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Back to The Analyst' }));
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  expectReviewProgress();
  conversations.portfolio = { ...make('portfolio', 'Older portfolio response'), kind: 'portfolio-review' };
  await act(async () => portfolio.resolve({ conversation: conversations.portfolio }));
  expectReviewProgress();
  expect(screen.queryByText('Older portfolio response')).not.toBeInTheDocument();
  conversations.predictive = { ...make('predictive', 'Newer predictive response'), kind: 'prediction-markets-review' };
  await act(async () => predictive.resolve({ conversation: conversations.predictive }));
  expect(screen.getByText('Newer predictive response')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('predictive');
  expect(api.request).toHaveBeenCalledWith('/daily/prediction-markets-review', { requestId: expect.stringMatching(/^review-start:/) });
});

test('acceptance clears launch progress without waiting for the history list request', async () => {
  const pending = deferred();
  const history = deferred();
  let blockHistory = false;
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise
    : blockHistory && path.startsWith('/conversations?') ? history.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  expectReviewProgress();
  blockHistory = true;
  conversations.review = { ...make('review', 'Saved review returned immediately'), kind: 'prediction-markets-review' };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  expect(screen.getByText('Saved review returned immediately')).toBeInTheDocument();
  await expectSelected('Chat review');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeEnabled();
  await act(async () => history.resolve({ conversations: Object.values(conversations), cursor: 0 }));
});

test('a completed metadata-only acceptance counts review posts without a history response', async () => {
  const pending = deferred();
  const history = deferred();
  const request = api.request.getMockImplementation();
  let accepted = false;
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise
    : accepted && path.startsWith('/conversations?') ? history.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  accepted = true;
  conversations.review = { ...make('review', ''), title: 'Predictive Markets Review', kind: 'prediction-markets-review',
    messages: [{ id: 'report', role: 'assistant', state: 'complete', text: 'Completed balance report', reviewPostId: 'base' },
      { id: 'explanation', role: 'assistant', state: 'complete', text: 'Additional balance findings', reviewPostId: 'base', reviewNarrative: true }] };
  delete conversations.review.message_count;
  await act(async () => pending.resolve({ conversation: conversations.review }));
  const row = historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  expect(row).toHaveTextContent('1 message');
  expect(row).not.toHaveTextContent('undefined');
  await act(async () => history.resolve({ conversations: Object.values(conversations), cursor: 0 }));
  expect(row).toHaveTextContent('1 message');
});

test.each([
  ['portfolio-review', 'Portfolio Review'],
  ['prediction-markets-review', 'Predictive Markets Review'],
])('%s shows its Starting slot in history before server acceptance or a list refresh', async (kind, label) => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === `/daily/${kind}` ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
  expectReviewProgress();
  expect(api.request.mock.calls.some(([path]) => path.includes('/conversations/pending-review:'))).toBe(false);
  // Leaving for the history keeps the pending launch in its Starting slot.
  const row = historyRows().getByRole('button', { name: `Open conversation: ${label}` });
  expect(row).toHaveTextContent('Starting…');
  // A history request that began before acceptance must leave the local start.
  await screen.findByRole('button', { name: 'Open conversation: Chat a' });
  expect(row).toBeVisible();
  conversations.review = { ...make('review', ''), title: label, kind, messages: [],
    activeTurn: { id: 'accepted', state: 'accepted' }, reviewPhase: 'queued' };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  expect(screen.getAllByRole('button', { name: `Open conversation: ${label}` })).toHaveLength(1);
  expect(screen.getByRole('button', { name: `Open conversation: ${label}` })).toHaveTextContent('Queued…');
  fireEvent.click(screen.getByRole('button', { name: `Open conversation: ${label}` }));
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
});

test('a Starting review cannot be deleted and its late receipt opens the one accepted chat without any delete', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  const row = historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  expect(row).toHaveTextContent('Starting…');
  // The row has only its trash action, which cannot act until the start is accepted.
  expect([...row.closest('.analyst-conversation-row').querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
    .toEqual(['Open conversation: Predictive Markets Review', 'Delete conversation: Predictive Markets Review']);
  expect(historyRows().getByRole('button', { name: 'Delete conversation: Predictive Markets Review' })).toBeDisabled();
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Predictive Markets Review' }));
  // Reopen the Starting slot so its late receipt can select the accepted chat.
  fireEvent.click(row);
  conversations.review = { ...make('review', 'Late accepted Predictive capture'), title: 'Predictive Markets Review', kind: 'prediction-markets-review' };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  await screen.findByText('Late accepted Predictive capture');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('review');
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
  expect(historyRows().getByRole('button', { name: 'Delete conversation: Predictive Markets Review' })).toBeEnabled();
  expect(api.request.mock.calls.some(([, , method]) => method === 'DELETE')).toBe(false);
});

test.each(['late success', 'lost response'])('a Predictive launch reconciles a durable receipt before its %s without a second chat', async response => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  const requestId = api.request.mock.calls.find(([path]) => path === '/daily/prediction-markets-review')[1].requestId;
  const transcript = expectReviewProgress();
  fireEvent.scroll(transcript, { target: { scrollTop: 75 } });
  conversations.review = { ...make('review', ''), title: 'Predictive Markets Review', kind: 'prediction-markets-review',
    reviewRequestId: requestId, revision: 1, messages: [], reviewPhase: 'queued',
    activeTurn: { id: 'accepted-turn', state: 'accepted', request_id: 'daily-turn:captured-run' } };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'review' }) }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('review');
  expect(transcript.scrollTop).toBe(75);

  conversations.review = { ...conversations.review, revision: 2, reviewPhase: null, activeTurn: null,
    lastTurn: { id: 'accepted-turn', state: 'complete' }, messages: [{ id: 'captured-report', role: 'assistant',
      state: 'complete', text: 'Completed captured Predictive report', reviewRunId: 'captured-run' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 2, conversation_id: 'review' }) }));
  await screen.findByText('Completed captured Predictive report');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  fireEvent.scroll(transcript, { target: { scrollTop: 125 } });
  if (response === 'lost response') await act(async () => pending.reject(new Error('The Analyst request timed out.')));
  else await act(async () => pending.resolve({ conversation: conversations.review }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(transcript.scrollTop).toBe(125);
  expect(api.request.mock.calls.filter(([path]) => path === '/daily/prediction-markets-review')).toHaveLength(1);
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
});

test('a Predictive launch does not adopt another review request from the sidebar', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  const requestId = api.request.mock.calls.find(([path]) => path === '/daily/prediction-markets-review')[1].requestId;
  conversations.other = { ...make('other', 'Independent captured review'), title: 'Other Predictive review',
    kind: 'prediction-markets-review', reviewRequestId: 'review-start:another-request' };
  const reads = api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?')).length;
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'other' }) }));
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?')).length).toBeGreaterThan(reads));
  expect(screen.queryByText('Independent captured review')).not.toBeInTheDocument();
  expectReviewProgress();
  conversations.review = { ...make('review', 'Requested captured review'), title: 'Predictive Markets Review',
    kind: 'prediction-markets-review', reviewRequestId: requestId };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  await screen.findByText('Requested captured review');
  expect(historyRows().getByRole('button', { name: 'Open conversation: Other Predictive review' })).toBeVisible();
});

async function startOverSavedPredictive() {
  const today = pacificToday();
  const captured = { ...make('today', 'Saved current-day Predictive capture'), title: 'Predictive Markets Review',
    kind: 'prediction-markets-review', trading_date: today, created_at: new Date().toISOString(), reviewRequestId: 'review-start:previous-capture' };
  conversations = { today: captured, prior: { ...make('prior', 'Saved previous-day Predictive capture'),
    title: 'Previous Predictive Review', kind: 'prediction-markets-review', trading_date: '2025-01-02' } };
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  home();
  // The new start sits at the top; the earlier report keeps its own row.
  const [starting, saved] = historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  expect(starting).toHaveTextContent('Starting…');
  expect(saved).not.toHaveTextContent('Starting…');
  expect(screen.getByRole('button', { name: 'Open conversation: Previous Predictive Review' })).toBeVisible();
  expect(conversations.today).toBe(captured);
  fireEvent.click(starting);
  expectReviewProgress();
  return { today, captured, pending };
}

test('starting today\'s Predictive review again files the new run in its own chat above the saved one', async () => {
  const { today, captured, pending } = await startOverSavedPredictive();
  const fresh = { ...make('fresh', 'New current-day Predictive capture'), title: 'Predictive Markets Review',
    kind: 'prediction-markets-review', trading_date: today, created_at: new Date().toISOString() };
  conversations = { fresh, ...conversations, today: { ...captured, trading_date: null } };
  await act(async () => pending.resolve({ conversation: fresh }));
  await screen.findByText('New current-day Predictive capture');
  home();
  await waitFor(() => expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(2));
  fireEvent.click(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })[1]);
  await screen.findByText('Saved current-day Predictive capture');
});

test('a Predictive start that fails leaves only the saved report', async () => {
  const { pending } = await startOverSavedPredictive();
  await act(async () => pending.reject(new Error('Could not start the review.')));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not start the review.');
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
  await screen.findByText('Saved current-day Predictive capture');
  home();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Previous Predictive Review' })).toBeVisible();
});

test('starting today\'s Predictive review while it is still running stays in its row', async () => {
  const today = pacificToday();
  const running = { ...make('today', 'Running Predictive capture'), title: 'Predictive Markets Review', kind: 'prediction-markets-review',
    trading_date: today, created_at: new Date().toISOString(), state: 'running', activeTurn: { id: 'capture-turn', state: 'running' } };
  conversations = { today: running };
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
  await act(async () => pending.resolve({ conversation: running }));
  home();
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
});

test('a review started after 9 p.m. Pacific files under the Pacific day and history groups by Pacific day', async () => {
  // 21:30 PDT on Oct 9 is already Oct 10 in New York.
  jest.useFakeTimers({ now: new Date('2026-10-10T04:30:00Z') });
  try {
    conversations = {
      today: { ...make('today', 'Saved Pacific-day Predictive capture'), title: 'Predictive Markets Review',
        kind: 'prediction-markets-review', trading_date: '2026-10-09' },
      morning: { ...make('morning', 'Pacific morning answer'), created_at: '2026-10-09T12:00:00Z' },
      earlier: { ...make('earlier', 'Previous Pacific evening answer'), created_at: '2026-10-09T05:00:00Z' },
    };
    const pending = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise : request(path, body, method));
    render(<AnalystPanel />);
    await act(async () => jest.advanceTimersByTimeAsync(300));
    const group = label => [...screen.getByRole('heading', { name: label }).closest('section')
      .querySelectorAll('.analyst-conversation-item')].map(button => button.getAttribute('aria-label'));
    expect(group('Today')).toEqual(['Open conversation: Predictive Markets Review', 'Open conversation: Chat morning']);
    expect(group('Yesterday')).toEqual(['Open conversation: Chat earlier']);
    fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
    expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([expect.objectContaining({ tradingDate: '2026-10-09' })]);
    // The new start files under the Pacific day, above the earlier report.
    home();
    expect(group('Today')).toEqual(['Open conversation: Predictive Markets Review', 'Open conversation: Predictive Markets Review',
      'Open conversation: Chat morning']);
    expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })[0]).toHaveTextContent('Starting…');
  } finally { jest.useRealTimers(); }
});

test.each(['accepted', 'reviewing', 'complete'])('an empty %s Predictive body leaves progress in Sources without a date-only report', async state => {
  conversations.a = { ...conversations.a, kind: 'prediction-markets-review', briefsIncluded: false,
    reviewPhase: state === 'complete' ? null : 'acquiring',
    activeTurn: state === 'complete' ? null : { id: 'capture-turn', state: 'running' },
    messages: [{ id: 'capture-post', role: 'assistant', state, text: '', reviewBodyIncluded: false,
      created_at: '2026-09-04T14:00:00Z', reviewRunId: 'capture-run' }] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const transcript = screen.getByRole('log', { name: 'Conversation' });
  await within(transcript).findByRole('region', { name: 'Review sources' });
  expect(transcript.querySelector('[data-message-id="capture-post"]')).toBeNull();
  expect(transcript).not.toHaveTextContent(/Sep 4|2026-09-04/);
});

test('server review phases update the existing post and retain generic response status for a follow-up', async () => {
  conversations.a = { ...conversations.a, kind: 'balance-review', revision: 1, reviewPhase: 'queued',
    activeTurn: { id: 'review-turn', state: 'accepted' }, messages: [] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const status = () => screen.getByRole('status', { name: 'Response running' });
  await waitFor(() => expect(status()).toHaveTextContent('Queued…'));
  for (const [index, phase, label] of [[2, 'acquiring', 'Gathering sources…'], [3, 'rendering', 'Writing review…'], [4, 'summarizing', 'Summarizing…']]) {
    conversations.a = { ...conversations.a, revision: index, reviewPhase: phase, messages: [{
      id: 'single-review-post', role: 'assistant', state: 'reviewing', text: 'Progressive verified findings', reviewRunId: 'run-1',
    }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: index, conversation_id: 'a' }) }));
    await waitFor(() => expect(status()).toHaveTextContent(label));
    expect(within(screen.getByRole('log')).getAllByText('Progressive verified findings')).toHaveLength(1);
  }
  conversations.a = { ...conversations.a, revision: 5, reviewPhase: null, activeTurn: { id: 'followup-turn', state: 'running' } };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 5, conversation_id: 'a' }) }));
  await waitFor(() => expect(status()).not.toHaveTextContent('Summarizing…'));
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('Responding…');
});

test('an accepted start survives a failed history refresh without an error or duplicate submission', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  let accepted = false;
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review' ? pending.promise
    : accepted && path.startsWith('/conversations?') ? Promise.reject(new Error('History request timed out.'))
    : request(path, body, method));
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  accepted = true;
  conversations.review = { ...make('review', 'Accepted report'), title: 'Predictive Markets Review', kind: 'prediction-markets-review' };
  await act(async () => pending.resolve({ conversation: conversations.review }));
  await expectSelected('Predictive Markets Review');
  expect(screen.getByText('Accepted report')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(api.request.mock.calls.filter(([path]) => path === '/daily/prediction-markets-review')).toHaveLength(1);
});

test('lightweight accepted refresh preserves the same captured brief until a full response replaces it', async () => {
  const capturedBrief = { available: true, asOf: '2026-09-04T20:05:00Z', metrics: {},
    holdings: [{ holding: 'IGV', heldSide: 'LONG', weightPct: 4, trade: 'BEARISH', trend: 'BULLISH', sizingInputs: {}, sources: {} }], nextSession: [] };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1,
    lastTurn: { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' },
    messages: [{ id: 'captured-message', role: 'assistant', state: 'complete', text: 'Saved report', portfolioBrief: capturedBrief }] };
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByRole('row', { name: /IGV/ });
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  conversations.a = { ...conversations.a, revision: 2, briefsIncluded: false, activeTurn: { id: 'refresh-turn' }, reviewPhase: 'queued',
    messages: [{ id: 'captured-message', role: 'assistant', state: 'complete', text: 'Saved report' }] };
  await act(async () => pending.resolve({ conversation: conversations.a }));
  expect(screen.getByRole('row', { name: /IGV/ })).toBeVisible();
  expect(conversations.a.messages[0].portfolioBrief).toBeUndefined();
  // A later complete projection can remove evidence; only the explicitly
  // incomplete acceptance is permitted to preserve the original payload.
  conversations.a = { ...conversations.a, revision: 3, briefsIncluded: true,
    messages: [{ ...conversations.a.messages[0], portfolioBrief: { available: false, holdings: [], metrics: {} } }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await waitFor(() => expect(screen.queryByRole('row', { name: /IGV/ })).not.toBeInTheDocument());
});

test('a rejected compact capture clears previously verified metrics even when its run and revision match', async () => {
  const capturedBrief = { available: true, runId: 'same-run', reportRevision: 'same-revision',
    asOf: '2026-09-04T20:05:00Z', metrics: { grossExposure: 1234 }, holdings: [], nextSession: [] };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1,
    messages: [{ id: 'captured-message', role: 'assistant', state: 'complete', text: 'Saved report', portfolioBrief: capturedBrief }] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await findPortfolioExposureAmount('$1,234');
  const exposure = screen.getByRole('region', { name: 'Exposure and risk' });
  const exposureTable = within(exposure).getByRole('table', { name: 'Portfolio exposure' });
  const exceptions = screen.getByRole('region', { name: 'Action required' });
  conversations.a = { ...conversations.a, revision: 2, briefsIncluded: false,
    messages: [{ ...conversations.a.messages[0], portfolioBrief: { ...capturedBrief,
      presentation: 'compact', available: false, metrics: {} } }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByText('Unavailable — connect to IB Gateway.');
  expect(screen.queryAllByText('$1,234')).toHaveLength(0);
  expect(screen.getByRole('region', { name: 'Exposure and risk' })).toBe(exposure);
  expect(within(exposure).getByRole('table', { name: 'Portfolio exposure' })).toBe(exposureTable);
  expect(exposureTable.querySelectorAll('tbody tr')).toHaveLength(4);
  expect(exposureTable.querySelectorAll('tbody td')).toHaveLength(16);
  expect([...exposureTable.querySelectorAll('tbody td')].every(cell => cell.textContent === '—')).toBe(true);
  expect(screen.getByRole('region', { name: 'Action required' })).toBe(exceptions);
  expect(exceptions).toHaveTextContent('Unavailable');
});

test('Portfolio sections keep their slots and tables from an empty loading post through partial, ready and unavailable captures', async () => {
  const pending = { id: 'stable-post', role: 'assistant', state: 'reviewing', text: '',
    reviewPostId: 'stable-post', reviewRunId: 'stable-run', turn_id: 'stable-turn' };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1,
    activeTurn: { id: 'stable-turn' }, reviewRunId: 'stable-run', reviewPhase: 'acquiring', messages: [pending] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const transcript = screen.getByRole('log', { name: 'Conversation' });
  await waitFor(() => expect(transcript.querySelector('[data-message-id="stable-post"]')).toBeInTheDocument());
  Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1800 }, clientHeight: { configurable: true, value: 500 } });
  const article = transcript.querySelector('[data-message-id="stable-post"]');
  const slots = [...article.querySelectorAll('.portfolio-review-section')];
  const exposure = within(article).getByRole('table', { name: 'Portfolio exposure' });
  const positions = within(article).getByRole('table', { name: 'Action required' });
  expect(slots.length).toBeGreaterThanOrEqual(3);
  expect(article).toHaveAttribute('aria-busy', 'true');
  expect(within(article).getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Loading…');
  expect(positions).toHaveTextContent('Loading…');
  const expectSameSlots = () => {
    expect(transcript.querySelector('[data-message-id="stable-post"]')).toBe(article);
    const current = [...article.querySelectorAll('.portfolio-review-section')];
    expect(current).toHaveLength(slots.length);
    current.forEach((slot, index) => expect(slot).toBe(slots[index]));
    expect(within(article).getByRole('table', { name: 'Portfolio exposure' })).toBe(exposure);
    expect(within(article).getByRole('table', { name: 'Action required' })).toBe(positions);
  };
  fireEvent.scroll(transcript, { target: { scrollTop: 180 } });
  const partial = { presentation: 'compact', available: false, runId: 'stable-run', metrics: {}, holdings: [],
    dailyRollup: { version: 1, sections: [{ id: 'market-drivers', title: "Today's market drivers",
      blocks: [{ type: 'paragraph', text: 'The first captured research reading.' }] }] } };
  conversations.a = { ...conversations.a, revision: 2, messages: [{ ...pending, portfolioBrief: partial }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await within(article).findByText('The first captured research reading.');
  expectSameSlots();
  expect(transcript.scrollTop).toBe(180);
  const ready = { ...partial, available: true, asOf: '2026-09-04T20:05:00Z',
    metrics: { grossExposure: 500 }, holdings: [{ holding: 'IGV', heldSide: 'LONG', weightPct: 4,
      trade: 'BEARISH', trend: 'BULLISH', sizingInputs: {}, sources: {} }] };
  conversations.a = { ...conversations.a, revision: 3, messages: [{ ...pending, portfolioBrief: ready }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 2, conversation_id: 'a' }) }));
  await findPortfolioExposureAmount('$500');
  expect(within(positions).getByRole('row', { name: /IGV/ })).toBeVisible();
  expectSameSlots();
  expect(transcript.scrollTop).toBe(180);
  conversations.a = { ...conversations.a, revision: 4, activeTurn: null, reviewPhase: null,
    lastTurn: { id: 'stable-turn', state: 'complete' }, messages: [{ ...pending, state: 'complete',
      portfolioBrief: { ...ready, available: false } }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 3, conversation_id: 'a' }) }));
  await within(article).findByText('Unavailable — connect to IB Gateway.');
  expectSameSlots();
  expect(screen.queryAllByText('$500')).toHaveLength(0);
  expect(within(positions).queryByRole('row', { name: /IGV/ })).not.toBeInTheDocument();
  expect(positions).toHaveTextContent('Unavailable');
  expect(article).not.toHaveAttribute('aria-busy', 'true');
  expect(transcript.scrollTop).toBe(180);
});

test('a metadata-only partial revision rehydrates the exact active compact book before archive completion', async () => {
  const post = { id: 'active-report', role: 'assistant', state: 'reviewing', text: '', turn_id: 'active-turn',
    reviewRunId: 'active-run', reviewPostId: 'active-post', portfolioBrief: { presentation: 'compact', available: false,
      runId: 'active-run', reportRevision: 'first-research', metrics: {}, holdings: [], dailyRollup: { version: 1, sections: [{
        id: 'drivers', title: 'Market drivers', blocks: [{ type: 'paragraph', text: 'First captured research' }],
      }] } } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, briefsIncluded: false,
    activeTurn: { id: 'active-turn' }, reviewRunId: 'active-run', reviewPhase: 'acquiring', messages: [post] };
  const request = api.request.getMockImplementation();
  let reads = 0;
  const hydrated = deferred();
  api.request.mockImplementation((path, body, method) => {
    if (path.startsWith('/conversations/a?includeBriefs=false')) {
      reads += 1;
      if (reads === 3) return hydrated.promise;
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText('First captured research');
  const metadata = { ...post, text: 'New verified book report' }; delete metadata.portfolioBrief;
  conversations.a = { ...conversations.a, revision: 2, messages: [metadata] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, type: 'progress', conversation_id: 'a', payload: { runId: 'active-run', reportRevision: 'verified-book' } }) }));
  await waitFor(() => expect(reads).toBe(3));
  expect(screen.getByText('First captured research')).toBeVisible();
  const verified = { ...post, portfolioBrief: { ...post.portfolioBrief, available: true,
    reportRevision: 'verified-book', metrics: { grossExposure: 200 }, asOf: '2026-09-04T20:05:00Z' } };
  conversations.a = { ...conversations.a, messages: [verified] };
  await act(async () => hydrated.resolve({ conversation: conversations.a }));
  await findPortfolioExposureAmount('$200');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(conversations.a.activeTurn).not.toBeNull();
  expect(api.request.mock.calls.some(([path]) => path === '/conversations/a')).toBe(false);
});

test('latest-only progress keeps each warm saved body and its citation bound to the same capture', async () => {
  const citation = { id: 'old-source', product: 'risk-ranges', title: 'Original saved publication',
    publicationDate: '2026-09-04', excerpt: 'The original captured publication body.' };
  const saved = { id: 'old-post', reviewPostId: 'old-post', role: 'assistant', state: 'complete', reviewRunId: 'old-run',
    text: 'Original saved export', citations: [citation], portfolioBrief: { available: true, runId: 'old-run',
      reportRevision: 'old-revision', metrics: { grossExposure: 100 }, holdings: [], dailyRollup: { version: 1,
        citations: [citation], sections: [{ id: 'drivers', title: 'Market drivers', citationIds: [citation.id],
          blocks: [{ type: 'paragraph', text: 'Original saved research reading.', citationIds: [citation.id] }] }] } } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, messages: [saved] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await findPortfolioExposureAmount('$100');
  const article = screen.getByRole('article', { name: 'Portfolio Review summary' });
  conversations.a = { ...conversations.a, revision: 2, briefsIncluded: false, briefScope: 'latest',
    activeTurn: { id: 'new-turn' }, reviewRunId: 'new-run', reviewPhase: 'acquiring', messages: [
      { id: saved.id, reviewPostId: saved.reviewPostId, role: 'assistant', state: 'complete', reviewRunId: 'old-run', reviewBodyIncluded: false },
      { id: 'new-post', reviewPostId: 'new-post', role: 'assistant', state: 'reviewing', reviewRunId: 'new-run',
        turn_id: 'new-turn', text: '', portfolioBrief: { presentation: 'compact', available: true, runId: 'new-run',
          metrics: { grossExposure: 200 }, holdings: [] } },
    ] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await findPortfolioExposureAmount('$200');
  expect(portfolioExposureAmount('$100').closest('article')).toBe(article);
  expect(article).toHaveTextContent('Original saved research reading.');
  fireEvent.click(within(article).getByRole('button', { name: 'Source: Original saved publication · Sep 4, 2026' }));
  expect(screen.getByRole('dialog', { name: 'Citation source' })).toHaveTextContent(citation.excerpt);
  expect(api.request.mock.calls.some(([path]) => path.includes('briefMessageId='))).toBe(false);
});

test('opening a cold completed Portfolio reads its latest compact primary without full historical hydration', async () => {
  const old = { id: 'old-post', reviewPostId: 'old-post', role: 'assistant', state: 'complete', reviewRunId: 'old-run',
    reviewBodyIncluded: false, created_at: '2026-09-04T14:00:00Z' };
  const latest = { id: 'latest-post', reviewPostId: 'latest-post', role: 'assistant', state: 'complete', reviewRunId: 'latest-run',
    reviewBodyIncluded: true, text: '', portfolioBrief: { presentation: 'compact', available: true, runId: 'latest-run',
      metrics: { grossExposure: 250 }, holdings: [] } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', activeTurn: null, briefsIncluded: false, messages: [old, latest] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await findPortfolioExposureAmount('$250');
  const placeholder = screen.getByRole('log', { name: 'Conversation' }).querySelector('[data-message-id="old-post"]');
  expect(placeholder).toHaveClass('analyst-captured-report-placeholder', 'portfolio-brief-centered');
  expect(placeholder).toHaveAttribute('aria-busy', 'true');
  expect(within(placeholder).getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Loading…');
  expect(within(placeholder).getByRole('table', { name: 'Action required' })).toHaveTextContent('Loading…');
  expect(placeholder).not.toHaveTextContent('$250');
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a?includeBriefs=false&briefScope=latest')).toHaveLength(1);
  expect(api.request.mock.calls.some(([path]) => path === '/conversations/a')).toBe(false);
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeEnabled();
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
});

test('an older failed post keeps its published partial report and status line when its saved body loads', async () => {
  const originalObserver = global.IntersectionObserver;
  const observers = [];
  global.IntersectionObserver = jest.fn(callback => {
    const observer = { callback, observe: jest.fn(), disconnect: jest.fn() }; observers.push(observer); return observer;
  });
  const status = 'Review interrupted: the server deadline passed before every source finished. Refresh to retry with fresh evidence.';
  try {
    const old = { id: 'failed-post', reviewPostId: 'failed-post', role: 'assistant', state: 'failed', reviewState: 'failed',
      reviewRunId: 'failed-run', reviewBodyIncluded: false, created_at: '2026-09-04T14:00:00Z' };
    const latest = { id: 'latest-post', reviewPostId: 'latest-post', role: 'assistant', state: 'complete', reviewRunId: 'latest-run',
      reviewBodyIncluded: true, text: '', portfolioBrief: { presentation: 'compact', available: true, runId: 'latest-run',
        metrics: { grossExposure: 250 }, holdings: [] } };
    conversations.a = { ...conversations.a, kind: 'portfolio-review', activeTurn: null, briefsIncluded: false, messages: [old, latest] };
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path.endsWith('briefMessageId=failed-post')
      ? Promise.resolve({ conversation: { ...conversations.a, messages: [{ ...old, reviewBodyIncluded: true, text: '',
        reviewStatusLine: status, portfolioBrief: { presentation: 'compact', available: true, runId: 'failed-run',
          metrics: { grossExposure: 100 }, holdings: [] } }] } })
      : request(path, body, method));
    render(<AnalystPanel />);
    fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
    await findPortfolioExposureAmount('$250');
    const placeholder = screen.getByRole('log', { name: 'Conversation' }).querySelector('[data-message-id="failed-post"]');
    expect(within(placeholder).queryByRole('note')).not.toBeInTheDocument();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    act(() => observers.at(-1).callback([{ target: placeholder, isIntersecting: true }]));
    await findPortfolioExposureAmount('$100');
    const loaded = screen.getByRole('log', { name: 'Conversation' }).querySelector('[data-message-id="failed-post"]');
    expect(within(loaded).getByRole('note')).toHaveTextContent(status);
    expect(loaded).not.toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('note').filter(note => note.textContent === status)).toHaveLength(1);
  } finally { global.IntersectionObserver = originalObserver; }
});

test('a rejected exact saved-body read settles its existing report slots without spinning and can retry after reopening the chat', async () => {
  const originalObserver = global.IntersectionObserver;
  const observers = [];
  global.IntersectionObserver = jest.fn(callback => {
    const observer = { callback, observe: jest.fn(), disconnect: jest.fn() }; observers.push(observer); return observer;
  });
  try {
    const old = { id: 'old-post', reviewPostId: 'old-post', role: 'assistant', state: 'complete', reviewRunId: 'old-run',
      reviewBodyIncluded: false, created_at: '2026-09-04T14:00:00Z' };
    const latest = { id: 'latest-post', reviewPostId: 'latest-post', role: 'assistant', state: 'complete', reviewRunId: 'latest-run',
      reviewBodyIncluded: true, text: '', portfolioBrief: { presentation: 'compact', available: true, runId: 'latest-run',
        metrics: { grossExposure: 250 }, holdings: [] } };
    conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, activeTurn: null, briefsIncluded: false, messages: [old, latest] };
    const exact = deferred();
    const request = api.request.getMockImplementation();
    let exactReads = 0;
    api.request.mockImplementation((path, body, method) => {
      if (path.endsWith('briefMessageId=old-post')) {
        exactReads += 1;
        return exactReads === 1 ? exact.promise : Promise.resolve({ conversation: { ...conversations.a, messages: [{ ...old,
          reviewBodyIncluded: true, portfolioBrief: { presentation: 'compact', available: true, runId: 'old-run',
            metrics: { grossExposure: 100 }, holdings: [] } }] } });
      }
      return request(path, body, method);
    });
    render(<AnalystPanel />);
    fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
    await findPortfolioExposureAmount('$250');
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    const placeholder = transcript.querySelector('[data-message-id="old-post"]');
    const sections = [...placeholder.querySelectorAll('.portfolio-review-section')];
    const exposure = within(placeholder).getByRole('table', { name: 'Portfolio exposure' });
    const positions = within(placeholder).getByRole('table', { name: 'Action required' });
    expect(placeholder).toHaveClass('analyst-captured-report-placeholder');
    expect(placeholder).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    act(() => observers.at(-1).callback([{ target: placeholder, isIntersecting: true }]));
    expect(exactReads).toBe(1);
    await act(async () => exact.reject(new Error('Saved body read unavailable.')));
    await within(placeholder).findByText('Unavailable — saved review could not be loaded.');
    expect(transcript.querySelector('[data-message-id="old-post"]')).toBe(placeholder);
    const settledSections = [...placeholder.querySelectorAll('.portfolio-review-section')];
    expect(settledSections).toHaveLength(sections.length);
    settledSections.forEach((section, index) => expect(section).toBe(sections[index]));
    expect(within(placeholder).getByRole('table', { name: 'Portfolio exposure' })).toBe(exposure);
    expect(within(placeholder).getByRole('table', { name: 'Action required' })).toBe(positions);
    expect(placeholder).not.toHaveAttribute('aria-busy', 'true');
    expect(placeholder).not.toHaveTextContent(/Loading|\$|\d+\.\d+%/);
    expect(positions).toHaveTextContent('Unavailable');
    for (let seq = 1; seq <= 3; seq += 1) {
      conversations.a = { ...conversations.a, revision: seq + 1 };
      act(() => stream.onmessage({ data: JSON.stringify({ seq, conversation_id: 'a' }) }));
      await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.includes('briefScope=latest')).length).toBeGreaterThanOrEqual(seq + 1));
      act(() => observers.at(-1).callback([{ target: placeholder, isIntersecting: true }]));
    }
    expect(exactReads).toBe(1);
    expect(portfolioExposureAmount('$250')).toBeVisible();
    expect(api.request.mock.calls.some(([path]) => path === '/daily/portfolio-review')).toBe(false);
    await open('b');
    fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Chat a' }));
    await findPortfolioExposureAmount('$250');
    const reopened = transcript.querySelector('[data-message-id="old-post"]');
    act(() => observers.at(-1).callback([{ target: reopened, isIntersecting: true }]));
    await findPortfolioExposureAmount('$100');
    expect(exactReads).toBe(2);
    expect(portfolioExposureAmount('$250')).toBeVisible();
    expect(screen.queryByText('Unavailable — saved review could not be loaded.')).not.toBeInTheDocument();
  } finally { global.IntersectionObserver = originalObserver; }
});

test.each(['ready', 'partial', 'checking', 'unavailable'])('a blank managed running post reveals its verified compact primary with %s balance before any progress frame', async balanceStatus => {
  const position = reportPosition(null, 600, 'managed-post');
  try {
    const saved = { id: 'saved-post', reviewPostId: 'saved-post', role: 'assistant', state: 'complete', reviewRunId: 'saved-run',
      text: 'Original saved export', portfolioBrief: { available: true, runId: 'saved-run', metrics: { grossExposure: 100 }, holdings: [] } };
    const pending = { id: 'managed-post', reviewPostId: 'new-run', role: 'assistant', state: 'running', text: '',
      reviewRunId: 'new-run', turn_id: 'new-turn', portfolioBrief: { presentation: 'compact', available: false,
        runId: 'new-run', reportRevision: 'pending-book', metrics: {}, holdings: [] } };
    conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, messages: [saved],
      lastTurn: { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' } };
    const receipt = deferred();
    const primary = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => {
      if (path === '/daily/portfolio-review') return receipt.promise;
      if (path === '/conversations/a/sources' && conversations.a.activeTurn) return Promise.resolve({
        conversationId: 'a', runId: 'new-run', state: 'running', items: [
          { id: 'portfolio', label: 'Verified book', status: 'ready', observedAt: '2026-09-04T20:05:00Z' },
          { id: 'portfolioBalance', label: 'Verified balance', status: balanceStatus, observedAt: '2026-09-04T20:05:00Z' },
          { id: 'portfolioResearchArchive', label: 'Research archive', status: 'checking' },
        ],
      });
      if (path === '/conversations/a?includeBriefs=false&briefScope=latest' && conversations.a.activeTurn) return primary.promise;
      return request(path, body, method);
    });
    render(<AnalystPanel />);
    fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
    await findPortfolioExposureAmount('$100');
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 1800 }, clientHeight: { configurable: true, value: 500 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    conversations.a = { ...conversations.a, briefsIncluded: false, revision: 2, activeTurn: { id: 'new-turn' },
      reviewRunId: 'new-run', reviewPhase: 'acquiring', messages: [saved, pending] };
    await act(async () => receipt.resolve({ conversation: conversations.a }));
    await within(screen.getByText('IB Gateway').closest('li')).findByText('Ready');
    expect(transcript.scrollTop).toBe(0);
    const loadingReport = transcript.querySelector('[data-message-id="managed-post"]');
    const loadingExposure = within(loadingReport).getByRole('region', { name: 'Exposure and risk' });
    expect(loadingExposure).toHaveTextContent('Loading…');
    const gatewaySource = screen.getByText('IB Gateway').closest('li');
    expect(gatewaySource).toHaveClass('is-ready');
    expect(gatewaySource).toHaveTextContent('Ready');
    expect(screen.queryByText('Verified book')).not.toBeInTheDocument();
    expect(screen.queryByText('Verified balance')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable — connect to IB Gateway.')).not.toBeInTheDocument();
    expect(screen.queryAllByText('$200')).toHaveLength(0);
    fireEvent.scroll(transcript, { target: { scrollTop: 175 } });
    conversations.a = { ...conversations.a, messages: [saved, { ...pending,
      portfolioBrief: { ...pending.portfolioBrief, available: true, reportRevision: 'verified-book', metrics: { grossExposure: 200 },
        asOf: '2026-09-04T20:05:00Z' } }] };
    await act(async () => primary.resolve({ conversation: conversations.a }));
    await findPortfolioExposureAmount('$200');
    expect(transcript.scrollTop).toBe(175);
    expect(transcript.querySelector('[data-message-id="managed-post"]')).toBe(loadingReport);
    expect(within(loadingReport).getByRole('region', { name: 'Exposure and risk' })).toBe(loadingExposure);
    expect(portfolioExposureAmount('$100')).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('Research archive');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(conversations.a.messages[1].state).toBe('running');
    expect(conversations.a.activeTurn).not.toBeNull();
    fireEvent.scroll(transcript, { target: { scrollTop: 175 } });
    conversations.a = { ...conversations.a, revision: 3, messages: [saved, { ...conversations.a.messages[1],
      portfolioBrief: { ...conversations.a.messages[1].portfolioBrief, reportRevision: 'later-research' } }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
    await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.includes('briefScope=latest')).length).toBeGreaterThan(2));
    expect(transcript.scrollTop).toBe(175);
  } finally { position.mockRestore(); }
});

test('a saved Balance Review stays readable and deletable but can no longer be refreshed or launched', async () => {
  conversations.a = { ...conversations.a, kind: 'balance-review', title: 'Balance Review', revision: 1, messages: [
    { id: 'saved', role: 'assistant', state: 'complete', reviewPostId: 'saved', reviewRunId: 'saved-run',
      text: '# Balance Review\n\n**Net liquidation:** $100.00', balancePrimary: { available: true, runId: 'saved-run' } },
  ] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Balance Review' }));
  await screen.findByText(/\$100\.00/);
  expect(historyRows().queryByRole('button', { name: /^Update review/ })).not.toBeInTheDocument();
  expect(historyRows().getByRole('button', { name: 'Delete conversation: Balance Review' })).toBeEnabled();
  expect(within(screen.getByRole('group', { name: 'Start a review' })).queryByRole('button', { name: 'Balance Review' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path]) => path === '/daily/balance-review')).toBe(false);
});

test.each(['unavailable', 'foreign-run', 'old-capture'])('Balance %s cannot quiet or certify the new capture', async failure => {
  const pending = { id: 'managed', role: 'assistant', state: 'running', reviewPostId: 'current', turn_id: 'active-turn',
    reviewRunId: 'active-run', text: failure === 'old-capture' ? '' : '# Balance Review\n\n**Net liquidation:** $200.00',
    balancePrimary: { available: failure !== 'unavailable', runId: failure === 'foreign-run' ? 'foreign-run' : 'active-run' } };
  conversations.a = { ...conversations.a, kind: 'balance-review', revision: 1, activeTurn: { id: 'active-turn' },
    reviewRunId: 'active-run', reviewPhase: 'acquiring', messages: [
      { id: 'saved', role: 'assistant', state: 'complete', reviewPostId: 'saved', reviewRunId: 'saved-run',
        text: '# Balance Review\n\n**Net liquidation:** $100.00', balancePrimary: { available: true, runId: 'saved-run' } }, pending,
    ] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText(/\$100\.00/);
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('Gathering');
});

test.each(['ready', 'partial', 'checking', 'unavailable'])('captured book with %s balance refreshes only its matching active run and never waits for archive readiness', async balanceStatus => {
  const post = { id: 'active-report', role: 'assistant', state: 'reviewing', text: '', turn_id: 'active-turn',
    reviewRunId: 'active-run', portfolioBrief: { presentation: 'compact', available: false, runId: 'active-run',
      reportRevision: 'first-research', metrics: {}, holdings: [], dailyRollup: { version: 1, sections: [{
        id: 'drivers', title: 'Market drivers', blocks: [{ type: 'paragraph', text: 'First captured research' }],
      }] } } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, briefsIncluded: false,
    activeTurn: { id: 'active-turn' }, reviewRunId: 'active-run', reviewPhase: 'acquiring', messages: [post] };
  const packet = runId => ({ conversationId: 'a', runId, basis: 'review', turnId: runId === 'active-run' ? 'active-turn' : 'older-turn', state: 'running', items: [
    { id: 'ibGateway', label: 'IB Gateway', status: 'ready', connectionState: 'connected', observedAt: '2026-09-04T20:05:00Z' },
    { id: 'portfolio', label: 'Verified book', status: 'ready', observedAt: '2026-09-04T20:05:00Z' },
    { id: 'portfolioBalance', label: 'Verified balance', status: balanceStatus, observedAt: '2026-09-04T20:05:00Z' },
    { id: 'portfolioResearchArchive', label: 'Research archive', status: 'checking' },
  ] });
  const request = api.request.getMockImplementation();
  let packets = 0;
  let reads = 0;
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/a/sources') return Promise.resolve(packet(++packets === 1 ? 'older-run' : 'active-run'));
    if (path.startsWith('/conversations/a?includeBriefs=false') && ++reads > 1) return Promise.resolve({ conversation: {
      ...conversations.a, messages: [{ ...post, portfolioBrief: { ...post.portfolioBrief, available: true,
        reportRevision: 'verified-book', metrics: { grossExposure: 300 } } }],
    } });
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(packets).toBe(1));
  expect(screen.getByText('IB Gateway').closest('li')).toHaveTextContent('Checking');
  expect(screen.getByText('IB Gateway').closest('li')).not.toHaveTextContent('Ready');
  expect(screen.getByText('IB Gateway').closest('li')).not.toHaveTextContent('Unavailable');
  expect(reads).toBe(1);
  expect(screen.queryAllByText('$300')).toHaveLength(0);
  await findPortfolioExposureAmount('$300', { timeout: 3000 });
  await within(screen.getByText('IB Gateway').closest('li')).findByText('Ready');
  expect(reads).toBe(2);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('Research archive');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(conversations.a.activeTurn).not.toBeNull();
});

test('settled Portfolio requests do not certify an unavailable primary, and later Balance evidence can request it again', async () => {
  const post = { id: 'active-report', role: 'assistant', state: 'running', text: '', turn_id: 'active-turn',
    reviewRunId: 'active-run', portfolioBrief: { presentation: 'compact', available: false, runId: 'active-run',
      reportRevision: 'pending-book', metrics: { grossExposure: 300 }, holdings: [] } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, briefsIncluded: false,
    activeTurn: { id: 'active-turn' }, reviewRunId: 'active-run', reviewPhase: 'acquiring', messages: [post] };
  let balanceStatus = 'checking';
  let reads = 0;
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/a/sources') return Promise.resolve({ conversationId: 'a', runId: 'active-run', state: 'running', items: [
      { id: 'portfolio', label: 'Captured book', status: 'partial' },
      { id: 'portfolioBalance', label: 'Captured balance', status: balanceStatus },
    ] });
    if (path.startsWith('/conversations/a?includeBriefs=false')) reads += 1;
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByText('IB Gateway').closest('li')).toHaveTextContent('Checking');
  expect(screen.queryByText('Captured book')).not.toBeInTheDocument();
  expect(screen.queryAllByText('$300')).toHaveLength(0);
  expect(screen.queryByText('Unavailable — connect to IB Gateway.')).not.toBeInTheDocument();
  balanceStatus = 'unavailable';
  await waitFor(() => expect(reads).toBe(3), { timeout: 3000 });
  // Failed account requests alone never establish a disconnect.
  expect(screen.getByText('IB Gateway').closest('li')).toHaveTextContent('Unverified');
  expect(screen.queryByText('Captured balance')).not.toBeInTheDocument();
  expect(screen.queryAllByText('$300')).toHaveLength(0);
  expect(screen.queryByText('Unavailable — connect to IB Gateway.')).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Response running' })).toHaveTextContent('Gathering sources…');
});

test('a refresh renders its first compact brief while preserving an older completed post', async () => {
  const original = { id: 'older-report', role: 'assistant', state: 'complete', text: 'Saved report',
    reviewPostId: 'base', reviewRunId: 'older-run', portfolioBrief: { available: true,
      runId: 'older-run', reportRevision: 'older-revision', metrics: { grossExposure: 100 }, holdings: [], nextSession: [] } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, messages: [original],
    lastTurn: { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' } };
  const receipt = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? receipt.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await findPortfolioExposureAmount('$100');
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  const pending = { id: 'fresh-report', role: 'assistant', state: 'reviewing', text: '',
    reviewPostId: 'fresh-post', reviewRunId: 'fresh-run' };
  const olderMetadata = { ...original }; delete olderMetadata.portfolioBrief;
  conversations.a = { ...conversations.a, revision: 2, briefsIncluded: false, activeTurn: { id: 'fresh-turn' },
    reviewPhase: 'queued', messages: [olderMetadata, pending] };
  await act(async () => receipt.resolve({ conversation: conversations.a }));
  expect(portfolioExposureAmount('$100')).toBeVisible();
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  conversations.a = { ...conversations.a, revision: 3, reviewPhase: 'acquiring', messages: [olderMetadata,
    { ...pending, portfolioBrief: { presentation: 'compact', available: true, runId: 'fresh-run', reportRevision: 'fresh-revision',
      metrics: { grossExposure: 200 }, holdings: [], nextSession: [], dailyRollup: { version: 1, sections: [{
        id: 'drivers', title: 'Market drivers', blocks: [{ type: 'paragraph', text: 'Fresh captured research.' }],
      }] } } }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await findPortfolioExposureAmount('$200');
  expect(portfolioExposureAmount('$100')).toBeVisible();
  expect(screen.getAllByRole('article', { name: 'Portfolio Review summary' })).toHaveLength(2);
  expect(screen.getByText('Fresh captured research.')).toBeVisible();
  expect(screen.queryByText('The Analyst view could not render.')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Review sources' })).toBeVisible();
});

test('a rejected launch restores the landing and draft with an error and permits another attempt', async () => {
  const pending = deferred();
  const retry = deferred();
  let requests = 0;
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review'
    ? (++requests === 1 ? pending.promise : retry.promise) : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Saved unsent question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  expectReviewProgress();
  await act(async () => pending.reject(new Error('Review could not start.')));
  expect(screen.getByRole('alert')).toHaveTextContent('Review could not start.');
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Saved unsent question');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  expectReviewProgress();
  expect(requests).toBe(2);
  const starts = api.request.mock.calls.filter(([path]) => path === '/daily/portfolio-review');
  expect(starts[1][1].requestId).toBe(starts[0][1].requestId);
  await act(async () => retry.reject(new Error('Review still unavailable.')));
});

test('saved balance automatic findings share one exceptions section while follow-up replies remain intact', async () => {
  conversations.a.kind = 'balance-review';
  conversations.a.messages = [
    { id: 'report', role: 'assistant', state: 'complete', text: '# Balance Review\n\n## Exceptions & Data Status\n\n- Borrowing balance unavailable.' },
    { id: 'generated', role: 'assistant', state: 'complete', reviewNarrative: true, text: '## Balance issues\n\n- Reconcile the unexpected borrow fee.', citations: [{ id: 'fee', title: 'Broker interest evidence', sourceUri: 'https://example.com/interest' }] },
    { id: 'followup', role: 'assistant', state: 'complete', text: '## Review notes\n\nThe requested follow-up explanation remains available.' },
  ];
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const combined = await screen.findByText(/# Balance Review/);
  expect(combined).toHaveTextContent('Borrowing balance unavailable.');
  expect(combined).toHaveTextContent('Reconcile the unexpected borrow fee.');
  expect(combined).not.toHaveTextContent('Balance issues');
  expect(screen.getByText(/The requested follow-up explanation/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '[1] Broker interest evidence' }));
  expect(screen.getByRole('dialog', { name: 'Citation source' })).toHaveTextContent('Broker interest evidence');
});

test('Balance Review uses the Sources date without a duplicate dated caption or report metadata', async () => {
  conversations.a = { ...conversations.a, kind: 'balance-review', title: 'Balance Review', trading_date: '2026-09-18', messages: [
    { id: 'report', role: 'assistant', state: 'complete', text: '# Balance Review\n\nPartial · USD\n\n**Observed:** 2026-09-18T17:33:54Z\n\n**Net liquidation:** $175,378.64\n\n## Exceptions & Data Status\n\n- Borrowing balance unavailable.' },
  ] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Balance Review' }));
  const report = await screen.findByText(/# Balance Review/);
  expect(report).toHaveTextContent('Net liquidation:');
  expect(report).toHaveTextContent('Borrowing balance unavailable.');
  expect(report).not.toHaveTextContent(/Partial · USD|Observed:/);
  expect(screen.queryByText('Balance Review · 2026-09-18')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('Sep 4 08:00 PDT'));
});

test('daily rollup source footers open the full original excerpt with only the attributed passage highlighted', async () => {
  const topText = 'Front-end yields fell sharply as growth slowed.';
  const earlyText = 'European cyclical shares weakened into the close.';
  const topExcerpt = `Opening research context.\n\n${topText}\n\n${earlyText}\n\nThe rest of the publication remains visible.`;
  const earlyExcerpt = `Separate research context.\n\n${earlyText}\n\n${topText}`;
  const citations = [
    { id: 'top', productLabel: 'Top 3 Things', title: 'Daily drivers', publicationDate: '2026-09-18', sourceUri: 'https://app.hedgeye.com/feed_items/100', excerpt: topExcerpt },
    { id: 'early', productLabel: 'Early Look', title: 'European growth', publicationDate: '2026-09-18', excerpt: earlyExcerpt },
  ];
  conversations.a.kind = 'portfolio-review';
  conversations.a.messages[0].portfolioBrief = { available: true, holdings: [], metrics: {}, dailyRollup: { version: 1, citations, sections: [{
    id: 'drivers', title: 'Today’s market drivers', citationIds: ['top', 'early'], blocks: [
      { type: 'paragraph', text: `Rates — ${topText}`, citationIds: ['top'] },
      { type: 'paragraph', text: `Europe — ${earlyText}`, citationIds: ['early'] },
    ],
  }] } };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const driverSection = await screen.findByRole('region', { name: 'Today’s market drivers' });
  expect(driverSection.lastChild).toHaveTextContent('Sources: Top 3 Things, Early Look');
  fireEvent.click(within(driverSection).getByRole('button', { name: 'Source: Daily drivers · Sep 18, 2026' }));
  let popup = screen.getByRole('dialog', { name: 'Citation source' });
  expect(popup.querySelector('blockquote').textContent).toBe(topExcerpt);
  expect([...popup.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual([topText]);
  expect(within(popup).getByRole('link', { name: 'Open original report ↗' })).toHaveAttribute('href', citations[0].sourceUri);
  fireEvent.click(screen.getByRole('textbox', { name: 'Message The Analyst' }));
  fireEvent.click(within(driverSection).getByRole('button', { name: 'Source: European growth · Sep 18, 2026' }));
  popup = screen.getByRole('dialog', { name: 'Citation source' });
  expect(popup.querySelector('blockquote').textContent).toBe(earlyExcerpt);
  expect([...popup.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual([earlyText]);
});

test('source popup has no X, keeps inside clicks, and dismisses on other Analyst areas without closing Analyst', async () => {
  const onClose = jest.fn();
  conversations.a.messages[0].citations = [{ id: 'source', title: 'Published evidence', excerpt: 'The original source passage remains readable.' }];
  render(<AnalystPanel onClose={onClose} />);
  await open('a');
  const sourceButton = screen.getByRole('button', { name: '[1] Published evidence' });
  fireEvent.click(sourceButton);
  let popup = screen.getByRole('dialog', { name: 'Citation source' });
  expect(screen.queryByRole('button', { name: 'Close citation' })).not.toBeInTheDocument();
  fireEvent.click(within(popup).getByText('The original source passage remains readable.'));
  expect(screen.getByRole('dialog', { name: 'Citation source' })).toBe(popup);
  fireEvent.click(screen.getByRole('textbox', { name: 'Message The Analyst' }));
  expect(screen.queryByRole('dialog', { name: 'Citation source' })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(sourceButton);
  popup = screen.getByRole('dialog', { name: 'Citation source' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to The Analyst' }));
  expect(popup).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
  const library = await screen.findByTestId('analyst-source-library');
  expect(library).toBeVisible();
  expect(within(library).queryByRole('heading', { name: 'Source Library' })).not.toBeInTheDocument();
  expect(within(library).queryByRole('button', { name: 'Close source library' })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

test('retained Analyst reopens its selected conversation, clears source popups, and preserves its draft', async () => {
  conversations.a.messages[0].citations = [{ id: 'source', title: 'Published evidence', excerpt: 'The original source passage remains readable.' }];
  function RetainedAnalyst() {
    const [visible, setVisible] = React.useState(true);
    return <><button onClick={() => setVisible(true)}>Open Analyst window</button>
      {visible && <button onClick={() => setVisible(false)}>Dashboard backdrop</button>}
      <PersistentSurface active={visible}><AnalystPanel onClose={() => setVisible(false)} /></PersistentSurface></>;
  }
  render(<RetainedAnalyst />);
  await open('a');
  const analyst = screen.getByRole('dialog', { name: 'The Analyst', exact: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: '[1] Published evidence' }));
  expect(screen.getByRole('dialog', { name: 'Citation source' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Dashboard backdrop' }));
  expect(screen.queryByRole('dialog', { name: 'The Analyst', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Citation source' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Analyst window' }));
  expect(screen.getByRole('dialog', { name: 'The Analyst', exact: true })).toBe(analyst);
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Keep this draft');
  expect(screen.getByText('Only answer A')).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Citation source' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('analyst-source-library')).not.toBeInTheDocument();
  await open('a');
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Keep this draft');
});

test('one product source button preserves both immutable publications and independent highlights in a stacked popup', async () => {
  const priorText = 'Equity volatility remained elevated during the prior session.';
  const currentText = 'Equity volatility declined materially during the current session.';
  const prior = { id: 'prior-ranges', product: 'risk-ranges', productLabel: 'Risk Ranges', title: 'Prior risk ranges', publicationDate: '2026-09-17', sourceUri: 'https://app.hedgeye.com/feed_items/99', excerpt: `Earlier context. ${priorText} Original closing context.` };
  const current = { id: 'current-ranges', product: 'risk-ranges', productLabel: 'Risk Ranges', title: 'Current risk ranges', publicationDate: '2026-09-18', sourceUri: 'https://app.hedgeye.com/feed_items/100', excerpt: `Current context. ${currentText} Original closing context.` };
  conversations.a.kind = 'portfolio-review';
  conversations.a.messages[0].portfolioBrief = { available: true, holdings: [], metrics: {}, dailyRollup: { version: 1, citations: [current, prior], sections: [{
    id: 'risk-ranges', title: 'Trend & range changes', citationIds: ['current-ranges', 'prior-ranges'], blocks: [
      { type: 'paragraph', text: currentText, citationIds: ['current-ranges'] },
      { type: 'paragraph', text: priorText, citationIds: ['prior-ranges'] },
    ],
  }] } };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Source: Risk Ranges', exact: true }));
  const popup = screen.getByRole('dialog', { name: 'Citation source' });
  const entries = within(popup).getAllByRole('article');
  expect(entries).toHaveLength(2);
  for (const [publication, passage] of [[current, currentText], [prior, priorText]]) {
    const entry = entries.find(item => within(item).queryByText(publication.title));
    expect(entry.querySelector('blockquote').textContent).toBe(publication.excerpt);
    expect([...entry.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual([passage]);
    expect(within(entry).getByRole('link', { name: 'Open original report ↗' })).toHaveAttribute('href', publication.sourceUri);
    expect(entry).toHaveTextContent(publication === current ? 'Sep 18, 2026' : 'Sep 17, 2026');
  }
  expect(within(popup).queryByRole('tablist')).not.toBeInTheDocument();
  expect(within(popup).queryByRole('button')).not.toBeInTheDocument();
});

test.each([
  ['Portfolio Review', 'portfolio-review'],
  ['Predictive Markets Review', 'prediction-markets-review'],
  ['Balance Review', 'balance-review'],
  ['Chat a', 'chat'],
])('%s history counts one message and refreshes to two messages', async (title, kind) => {
  conversations.a = { ...conversations.a, title, kind };
  render(<AnalystPanel />);
  const row = await historyRows().findByRole('button', { name: `Open conversation: ${title}` });
  expect(within(row).getByText('1 message', { exact: true })).toBeInTheDocument();

  conversations.a = {
    ...conversations.a,
    message_count: 2,
    messages: [...conversations.a.messages, { id: 'a-second', role: 'assistant', state: 'complete', text: 'A second response' }],
  };
  await waitFor(() => expect(stream.onmessage).toEqual(expect.any(Function)));
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  expect(await within(row).findByText('2 messages', { exact: true })).toBeInTheDocument();
  expect(within(row).queryByText('1 message', { exact: true })).not.toBeInTheDocument();
});

test('Portfolio Review opens the last saved closing report with a historical date and retains it after reload', async () => {
  const request = api.request.getMockImplementation();
  conversations.a = {
    ...conversations.a, title: 'Portfolio Review', kind: 'portfolio-review', trading_date: '2026-09-04',
    referenceReview: { messageId: 'close', targetDate: '2026-09-04', tradingDate: '2026-09-04', asOf: '2026-09-04T20:05:00.000Z', afterClose: true },
    messages: [
      { id: 'old', role: 'assistant', state: 'complete', text: 'Superseded intraday report', reviewPostId: 'base' },
      { id: 'close', role: 'assistant', state: 'complete', text: 'Friday closing portfolio review', reviewPostId: 'base' },
    ],
  };
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/daily') return { ready: false, marketDay: false, marketSession: 'closed', date: '2026-09-07', portfolioReferenceDate: '2026-09-04' };
    if (path === '/daily/portfolio-review') return { conversation: conversations.a };
    return request(path, body, method);
  });
  const view = render(<AnalystPanel />);
  await screen.findByRole('button', { name: 'Portfolio Review', exact: true });
  expect(screen.queryByText(/Last completed session/)).not.toBeInTheDocument();
  expect(screen.queryByText(/market.*closed|reviews resume|Waiting for/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  await screen.findByText('Friday closing portfolio review');
  expect(screen.getByRole('note')).toHaveTextContent('After-close review · 2026-09-04 · Historical snapshot');
  expect(screen.getByRole('note')).toHaveTextContent('Sep 4, 2026 13:05 PDT');
  expect(screen.queryByText('Superseded intraday report')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Show earlier messages' })).not.toBeInTheDocument();
  view.unmount();
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Portfolio Review' }));
  await screen.findByText('Friday closing portfolio review');
  expect(screen.getByRole('note')).toHaveTextContent('Historical snapshot');
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
});

test.each([true, false])('a historical portfolio review makes an older or intraday observation explicit (after close: %s)', async afterClose => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.referenceReview = { messageId: 'a-message', targetDate: '2026-09-04', tradingDate: afterClose ? '2026-09-03' : '2026-09-04', asOf: afterClose ? '2026-09-04T01:24:30Z' : '2026-09-04T15:00:00Z', afterClose };
  render(<AnalystPanel />);
  await open('a');
  expect(screen.getByRole('note')).toHaveTextContent('The closing review for 2026-09-04 was not saved. Showing the latest available information.');
  // Observation clocks are Pacific; the session dates keep their market meaning.
  expect(screen.getByRole('note')).toHaveTextContent(afterClose ? 'Observed Sep 3, 2026 18:24 PDT' : 'Observed Sep 4, 2026 08:00 PDT');
  expect(screen.getByRole('note')).not.toHaveTextContent(/\bET\b/);
  expect(screen.queryByText(/market.*closed|reviews resume/i)).not.toBeInTheDocument();
});

test('a disconnected refresh retains saved Action required positions until a verified review replaces them', async () => {
  const brief = holding => ({ available: true, asOf: '2026-09-04T20:05:00Z', metrics: {},
    holdings: [{ holding, heldSide: 'LONG', weightPct: 4, trade: 'BEARISH', trend: 'BULLISH', sizingInputs: {}, sources: {} }], nextSession: [] });
  conversations.a.kind = 'portfolio-review';
  conversations.a.messages = [
    { id: 'saved', role: 'assistant', state: 'complete', text: 'Saved report', portfolioBrief: brief('IGV') },
    { id: 'blocked', role: 'assistant', state: 'complete', text: 'Unavailable report', portfolioBrief: { available: false, holdings: [], metrics: {} } },
  ];
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByRole('row', { name: /IGV/ });
  expect(screen.getByRole('note')).toHaveTextContent('The latest refresh could not verify holdings. Showing the last saved portfolio below.');
  expect(screen.queryByText('Verified portfolio evidence is unavailable for this saved review.')).not.toBeInTheDocument();
  expect(screen.getAllByRole('table', { name: 'Action required' })).toHaveLength(1);
  conversations.a.messages.push({ id: 'refreshed', role: 'assistant', state: 'complete', text: 'New report', portfolioBrief: brief('AMZN') });
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByRole('row', { name: /AMZN/ });
  expect(screen.queryByRole('row', { name: /IGV/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/latest refresh could not verify holdings/i)).not.toBeInTheDocument();
});

test('opening a historical placeholder never starts a review', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.referenceReview = { targetDate: '2026-09-04', missing: true };
  conversations.a.messages[0].text = 'Market closed on 2026-09-07. Daily reviews resume on the next exchange trading day.';
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a?includeBriefs=false&briefScope=latest'));
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument());
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/'))).toBe(false);
});

test('a delayed historical placeholder response stays selected without starting recovery', async () => {
  const details = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/conversations/a' ? details.promise : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a'));
  conversations.a = { ...conversations.a, kind: 'portfolio-review', referenceReview: { targetDate: '2026-09-04', missing: true }, messages: [] };
  await act(async () => details.resolve({ conversation: conversations.a }));
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('a');
  await expectSelected('Chat a');
  expect(api.request.mock.calls.some(([path]) => path === '/daily/portfolio-review')).toBe(false);
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
});

test('reopening the same empty history entry never creates or refreshes a review', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.referenceReview = { targetDate: '2026-09-04', missing: true };
  conversations.a.messages = [];
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a?includeBriefs=false&briefScope=latest'));
  fireEvent.click(screen.getByRole('button', { name: 'Back to The Analyst' }));
  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a?includeBriefs=false&briefScope=latest')).toHaveLength(2));
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/') || path === '/messages')).toBe(false);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('a');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
});

test('delayed and duplicate events cannot put A content in B; drafts survive switching', async () => {
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Draft A' } });
  await open('b');
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('');
  conversations.a.messages.push({ id: 'a-final', role: 'assistant', text: 'Late completion for A only', state: 'complete' });
  act(() => { stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }); stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }); });
  await act(async () => { await new Promise(r => setTimeout(r, 500)); });
  expect(screen.queryByText('Late completion for A only')).not.toBeInTheDocument();
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
  await open('a');
  await screen.findByText('Late completion for A only');
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Draft A');
});
test('stop is targeted; closing and remounting reads saved background completion', async () => {
  conversations.a.activeTurn = { id: 'turn-A' };
  const view = render(<AnalystPanel />);
  await open('a');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a/turns/turn-A/stop', {}));
  view.unmount();
  conversations.a.messages.push({ id: 'background', role: 'assistant', text: 'Saved while closed', state: 'complete' });
  render(<AnalystPanel />);
  await open('a');
  await screen.findByText('Saved while closed');
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
});
test('every history row has one trash button and no archive action', async () => {
  conversations.review = { ...make('review', 'Saved review'), title: 'Portfolio Review', kind: 'portfolio-review', trading_date: '2026-09-04' };
  render(<AnalystPanel />);
  await open('a');
  expect(screen.queryByRole('button', { name: /^Archive conversation/ })).not.toBeInTheDocument();
  const buttons = id => [...historyRows().getByRole('button', { name: `Open conversation: ${id}` }).closest('.analyst-conversation-row')
    .querySelectorAll('button')].map(button => button.getAttribute('aria-label'));
  expect(buttons('Chat a')).toEqual(['Open conversation: Chat a', 'Delete conversation: Chat a']);
  expect(buttons('Portfolio Review')).toEqual(['Open conversation: Portfolio Review', 'Delete conversation: Portfolio Review']);
  expect(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' })).toBeEnabled();
  expect(api.request.mock.calls.some(([, , method]) => method === 'DELETE')).toBe(false);
});

test('review history rows have no in-place refresh; a new review starts from the home launcher', async () => {
  conversations.a = { ...conversations.a, kind: 'portfolio-review', title: 'Portfolio Review' };
  conversations.b = { ...conversations.b, kind: 'prediction-markets-review', title: 'Predictive Markets Review' };
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Portfolio Review' });
  expect(historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toBeVisible();
  expect(historyRows().queryByRole('button', { name: /^Update review/ })).not.toBeInTheDocument();
  expect(document.querySelector('.analyst-conversation-refresh')).toBeNull();
});

test('Retry explicitly refreshes the selected portfolio before the open or after the close', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? Promise.resolve({ conversation: conversations.a }) : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/daily/portfolio-review', { refresh: true, conversationId: 'a', requestId: expect.stringMatching(/^review-refresh:/) }));
});
test('saved history remains readable with event-stream outage', async () => {
  render(<AnalystPanel />);
  await open('a');
  act(() => stream.onerror());
  expect(screen.getByText('Only answer A')).toBeInTheDocument();
  await open('b');
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
});

test.each(['portfolio-review', 'prediction-markets-review'])('refreshing %s shows source progress and appends a distinct post', async kind => {
  conversations.a.kind = kind;
  conversations.a.messages[0].reviewPostId = 'base';
  const original = api.request.getMockImplementation();
  let finish;
  api.request.mockImplementation((path, body, method) => {
    if (path === `/daily/${kind}`) return new Promise(resolve => { finish = resolve; });
    if (path === '/conversations/a/sources') return Promise.resolve({ runId: 'new-run', items: [
      { id: 'received', label: 'Received source', status: 'ready', observedAt: '2026-09-04T15:00:00Z' },
      { id: 'missing', label: 'Missing source', status: 'missing', observedAt: null },
    ] });
    return original(path, body, method);
  });
  conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
  render(<AnalystPanel />);
  await open('a');
  const retry = screen.getByRole('button', { name: 'Retry', exact: true });
  fireEvent.click(retry);
  expectReviewProgress();
  expect(screen.getByText('Only answer A')).toBeInTheDocument();
  // A second click while the refresh is starting is ignored.
  fireEvent.click(retry);
  expect(screen.queryByRole('button', { name: 'Show earlier messages' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.filter(([path]) => path === `/daily/${kind}`)).toHaveLength(1);
  expect(api.request).toHaveBeenCalledWith(`/daily/${kind}`, expect.objectContaining({ conversationId: 'a', refresh: true, requestId: expect.any(String) }));
  conversations.a = { ...conversations.a, activeTurn: { id: 'new-turn' } };
  await act(async () => finish({ conversation: conversations.a }));
  expectReviewProgress();
  const checklist = await screen.findByRole('region', { name: 'Review sources' });
  expect(await within(checklist).findByText('Received source')).toBeInTheDocument();
  expect(within(checklist).getByText('Missing source').closest('li')).toHaveTextContent(/—Missing$/);
  expect(screen.queryByText('Updated report')).not.toBeInTheDocument();
  conversations.a = { ...conversations.a, activeTurn: null, lastTurn: { id: 'new-turn', state: 'complete' }, message_count: 2,
    messages: [...conversations.a.messages, { id: 'new-post', role: 'assistant', state: 'complete', text: 'Updated report', reviewPostId: 'new-run', reviewRunId: 'new-run' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByText('Updated report');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByText('Only answer A')).toBeInTheDocument();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('2 messages');
});

test('completing a review keeps its captured source rows visible during the final source check', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.activeTurn = { id: 'review-turn' };
  const pending = deferred();
  const original = api.request.getMockImplementation();
  const sources = { conversationId: 'a', runId: 'review-run', basis: 'review', items: [
    { id: 'research', label: 'Captured research', status: 'ready', observedAt: '2026-09-04T15:00:00Z' },
  ] };
  api.request.mockImplementation((path, body, method) => path === '/conversations/a/sources'
    ? (conversations.a.activeTurn ? Promise.resolve(sources) : pending.promise)
    : original(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  const sourceRow = await screen.findByText('Captured research');

  conversations.a = { ...conversations.a, activeTurn: null, lastTurn: { id: 'review-turn', state: 'complete' },
    messages: [...conversations.a.messages, { id: 'new-review', role: 'assistant', state: 'complete',
      text: 'Completed portfolio report', reviewPostId: 'review-run', reviewRunId: 'review-run' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByText('Completed portfolio report');
  expect(sourceRow).toBeVisible();
  expect(screen.getByText('Captured research')).toBe(sourceRow);
  expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByText('Checking sources…')).not.toBeInTheDocument();
  await act(async () => pending.resolve({ ...sources, state: 'complete' }));
  expect(screen.getByText('Captured research')).toBe(sourceRow);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Review sources' })).toHaveAttribute('aria-busy', 'false'), { timeout: 2000 });
});

test('portfolio refresh progress and failure preserve the saved report and Sources layout', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
  conversations.a.messages[0].portfolioBrief = { available: true, runId: 'saved-run', holdings: [], metrics: {} };
  const sourceItems = [{ id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: '2026-09-04T15:00:00Z' }];
  const request = api.request.getMockImplementation();
  const refresh = deferred();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? refresh.promise
    : path === '/conversations/a/sources' ? Promise.resolve({ conversationId: 'a', runId: 'saved-run', basis: 'review', state: 'complete', items: sourceItems })
      : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(screen.getByRole('article', { name: 'Portfolio Review summary' })).toHaveAttribute('data-message-id', 'a-message'));
  await within(await screen.findByRole('region', { name: 'Review sources' })).findByText('Ready');
  const presentationClass = screen.getByTestId('analyst-panel').className;
  // Retrying the review keeps the report with its Sources in place.
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  expect(report).toHaveAttribute('data-message-id', 'a-message');
  expect(screen.getByTestId('analyst-panel')).toHaveAttribute('class', presentationClass);
  const sources = screen.getByRole('region', { name: 'Review sources' });
  const header = sources.querySelector('header');
  const list = sources.querySelector('ul');
  const sourceRow = within(sources).getByText('IB Gateway').closest('li');
  expect(within(sources).getAllByRole('listitem')).toHaveLength(23);
  expect(within(header).getByRole('status', { name: 'Response running' })).toHaveTextContent('Starting…');
  expect(within(sourceRow).getByText('Checking')).toBeVisible();
  expect(within(sourceRow).queryByText('Sep 4 08:00 PDT')).not.toBeInTheDocument();
  await act(async () => refresh.reject(Object.assign(new Error('IB Gateway unavailable.'), { code: 'IBKR_GATEWAY_NOT_CONNECTED' })));
  expect(screen.getByRole('article', { name: 'Portfolio Review summary' })).toBe(report);
  expect(sources.querySelector('header')).toBe(header);
  expect(sources.querySelector('ul')).toBe(list);
  expect(within(sources).getByText('IB Gateway').closest('li')).toBe(sourceRow);
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByText('IB Gateway unavailable.').closest('[role="alert"]')).toBeInTheDocument();
});

test('a sidebar timeout after an accepted review refresh does not mark the review failed', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
  const original = api.request.getMockImplementation();
  let accepted = false;
  let timedOut = false;
  api.request.mockImplementation(async (path, body, method) => {
    if (path === '/daily/portfolio-review') {
      accepted = true;
      conversations.a = { ...conversations.a, lastTurn: { id: 'refresh-turn', state: 'complete' }, messages: [
        { id: 'refreshed-report', role: 'assistant', state: 'complete', text: 'Completed refreshed portfolio report' },
      ] };
      return { conversation: conversations.a };
    }
    if (accepted && path.startsWith('/conversations?')) {
      timedOut = true;
      throw Object.assign(new Error('The Analyst request timed out.'), { code: 'ANALYST_REQUEST_TIMEOUT' });
    }
    return original(path, body, method);
  });
  render(<AnalystPanel />);
  await open('a');
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  await screen.findByText('Completed refreshed portfolio report');
  await waitFor(() => expect(timedOut).toBe(true));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('The Analyst request timed out.')).not.toBeInTheDocument();
  expect(api.request.mock.calls.filter(([path]) => path === '/daily/portfolio-review')).toHaveLength(1);
});

test('a failed refresh keeps its request ID for retry and clears old source checks', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
  const original = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review'
    ? Promise.reject(new Error('Could not start the review.')) : original(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  await screen.findByText('Could not start the review.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  await screen.findByText('Could not start the review.');
  const requests = api.request.mock.calls.filter(([path]) => path === '/daily/portfolio-review');
  expect(requests).toHaveLength(2);
  expect(requests[0][1].requestId).toBe(requests[1][1].requestId);
  expect(screen.getByText('Only answer A')).toBeInTheDocument();
});

test.each(['portfolio-review', 'prediction-markets-review'])('a completed %s launch preserves its intended opening position', async kind => {
  const position = reportPosition('Newly completed review');
  try {
    const pending = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === `/daily/${kind}` ? pending.promise : request(path, body, method));
    render(<AnalystPanel />);
    const label = { 'portfolio-review': 'Portfolio Review', 'balance-review': 'Balance Review', 'prediction-markets-review': 'Predictive Markets Review' }[kind];
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
    conversations.review = { ...make('review', 'Old review'), kind, activeTurn: { id: 'new-turn' } };
    await act(async () => pending.resolve({ conversation: conversations.review }));
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    expect(transcript.scrollTop).toBe(0);
    conversations.review = { ...conversations.review, activeTurn: null, lastTurn: { id: 'new-turn', state: 'complete' }, messages: [...conversations.review.messages,
      { id: 'completed', role: 'assistant', state: 'complete', text: 'Newly completed review' }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'review' }) }));
    await screen.findByText('Newly completed review');
    const openingPosition = kind === 'balance-review' ? 600 : 0;
    expect(transcript.scrollTop).toBe(openingPosition);
    expect(JSON.parse(localStorage.getItem('analyst.workspace.scrolls')).review).toBe(openingPosition);
    fireEvent.scroll(transcript, { target: { scrollTop: 175 } });
    const reads = api.request.mock.calls.filter(([path]) => path.split('?')[0] === '/conversations/review').length;
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 2, conversation_id: 'review' }) }));
    await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.split('?')[0] === '/conversations/review').length).toBeGreaterThan(reads));
    expect(transcript.scrollTop).toBe(175);
  } finally { position.mockRestore(); }
});

test.each(['portfolio-review', 'prediction-markets-review'])('%s launch preserves a scroll made before acceptance instead of restoring an old report offset', async kind => {
  const position = reportPosition('Accepted captured review');
  try {
    localStorage.setItem('analyst.workspace.scrolls', JSON.stringify({ review: 434 }));
    const receipt = deferred();
    const sources = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => {
      if (path === `/daily/${kind}`) return receipt.promise;
      if (path === '/conversations/review/sources') return sources.promise;
      return request(path, body, method);
    });
    render(<AnalystPanel />);
    fireEvent.click(screen.getByRole('button', { name: kind === 'portfolio-review' ? 'Portfolio Review' : 'Predictive Markets Review', exact: true }));
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    expect(transcript.scrollTop).toBe(0);
    fireEvent.scroll(transcript, { target: { scrollTop: 175 } });
    conversations.review = { ...make('review', 'Accepted captured review'), kind };
    await act(async () => receipt.resolve({ conversation: conversations.review }));
    await screen.findByText('Accepted captured review');
    expect(transcript.scrollTop).toBe(175);
    expect(JSON.parse(localStorage.getItem('analyst.workspace.scrolls')).review).toBe(175);
    const sourceTable = within(transcript).getByRole('region', { name: 'Review sources' });
    await act(async () => sources.resolve({ conversationId: 'review', state: 'complete',
      items: [{ id: 'portfolio', label: 'Captured holdings', status: 'ready', observedAt: '2026-09-04T15:00:00Z' }] }));
    await within(screen.getByText('IB Gateway').closest('li')).findByText('Ready');
    expect(within(transcript).getByRole('region', { name: 'Review sources' })).toBe(sourceTable);
    expect(transcript.scrollTop).toBe(175);
  } finally { position.mockRestore(); }
});

test('an explicit Portfolio refresh keeps the reader position through its loading shell, captured sources and completion', async () => {
  const position = reportPosition(null, 600, 'fresh-report');
  try {
    const original = { id: 'older-report', role: 'assistant', state: 'complete', text: 'Saved report',
      reviewPostId: 'base', reviewRunId: 'older-run', portfolioBrief: { available: true,
        metrics: { grossExposure: 100 }, holdings: [], nextSession: [] } };
    conversations.a = { ...conversations.a, kind: 'portfolio-review', revision: 1, messages: [original],
      lastTurn: { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' } };
    const receipt = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? receipt.promise : request(path, body, method));
    render(<AnalystPanel />);
    fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
    await findPortfolioExposureAmount('$100');
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 750 }, clientHeight: { configurable: true, value: 500 } });
    fireEvent.scroll(transcript, { target: { scrollTop: 225 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    expect(transcript.scrollTop).toBe(225);
    const pending = { id: 'fresh-report', role: 'assistant', state: 'reviewing', text: '',
      reviewPostId: 'fresh-post', reviewRunId: 'fresh-run', turn_id: 'fresh-turn' };
    conversations.a = { ...conversations.a, revision: 2, briefsIncluded: false, activeTurn: { id: 'fresh-turn' },
      reviewPhase: 'acquiring', messages: [original,
        { id: 'empty-pending', role: 'assistant', state: 'running', text: '', reviewPostId: 'empty-post' }, pending] };
    await act(async () => receipt.resolve({ conversation: conversations.a }));
    expect(transcript.scrollTop).toBe(225);
    const loadingReport = transcript.querySelector('[data-message-id="fresh-report"]');
    expect(within(loadingReport).getByRole('region', { name: 'Exposure and risk' })).toHaveTextContent('Loading…');
    fireEvent.scroll(transcript, { target: { scrollTop: 225 } });
    conversations.a = { ...conversations.a, revision: 3, messages: [...conversations.a.messages.slice(0, -1),
      { ...pending, portfolioBrief: { presentation: 'compact', available: false, runId: 'fresh-run',
        metrics: {}, holdings: [], dailyRollup: { version: 1, sections: [{ id: 'drivers', title: 'Market drivers',
          blocks: [{ type: 'paragraph', text: 'Fresh captured research' }] }] } } }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
    await screen.findByText('Fresh captured research');
    expect(transcript.scrollTop).toBe(225);
    expect(transcript.querySelector('[data-message-id="fresh-report"]')).toBe(loadingReport);
    expect(transcript.querySelector('[data-message-id="fresh-report"]')).toHaveTextContent('Fresh captured research');
    expect(screen.getByRole('status', { name: 'Response running' })).toHaveTextContent('Gathering sources…');
    expect(screen.queryByText(/latest refresh could not verify holdings|Unavailable — connect to IB Gateway/i)).not.toBeInTheDocument();
    expect(portfolioExposureAmount('$100')).toBeVisible();
    fireEvent.scroll(transcript, { target: { scrollTop: 225 } });
    const fresh = conversations.a.messages.at(-1);
    conversations.a = { ...conversations.a, revision: 4, messages: [...conversations.a.messages.slice(0, -1),
      { ...fresh, portfolioBrief: { ...fresh.portfolioBrief, available: true, metrics: { grossExposure: 200 } } }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 2, conversation_id: 'a' }) }));
    await findPortfolioExposureAmount('$200');
    expect(transcript.scrollTop).toBe(225);
    conversations.a = { ...conversations.a, revision: 5, activeTurn: null, lastTurn: { id: 'fresh-turn', state: 'complete' },
      messages: conversations.a.messages.filter(message => message.id !== 'empty-pending').map(message => message.id === 'fresh-report'
        ? { ...message, state: 'complete' } : message) };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 3, conversation_id: 'a' }) }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument());
    expect(transcript.scrollTop).toBe(225);
  } finally { position.mockRestore(); }
});

test.each(['portfolio-review', 'prediction-markets-review'])('%s refresh completion and late acceptance do not move the reader', async kind => {
  const position = reportPosition('Completed before acceptance');
  try {
    conversations.a.kind = kind;
    conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
    const pending = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === `/daily/${kind}` ? pending.promise : request(path, body, method));
    render(<AnalystPanel />);
    await open('a');
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    conversations.a = { ...conversations.a, revision: 2, lastTurn: { id: 'new-turn', state: 'complete' }, messages: [...conversations.a.messages,
      { id: 'completed', role: 'assistant', state: 'complete', text: 'Completed before acceptance' }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
    await screen.findByText('Completed before acceptance');
    expect(transcript.scrollTop).toBe(0);
    fireEvent.scroll(transcript, { target: { scrollTop: 225 } });
    await act(async () => pending.resolve({ conversation: conversations.a }));
    expect(transcript.scrollTop).toBe(225);
  } finally { position.mockRestore(); }
});

test('leaving a refreshing report for history cancels its automatic completion scroll', async () => {
  const position = reportPosition('Completed after navigation');
  try {
    conversations.a.kind = 'portfolio-review';
    conversations.a.lastTurn = { id: 'failed-review', state: 'failed', request_id: 'daily-turn:failed-review', error: 'Supporting data timed out' };
    const pending = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === '/daily/portfolio-review' ? pending.promise : request(path, body, method));
    render(<AnalystPanel />);
    await open('a');
    fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
    await open('b');
    const transcript = screen.getByRole('log', { name: 'Conversation' });
    fireEvent.scroll(transcript, { target: { scrollTop: 125 } });
    conversations.a = { ...conversations.a, lastTurn: { id: 'new-turn', state: 'complete' }, messages: [...conversations.a.messages,
      { id: 'completed', role: 'assistant', state: 'complete', text: 'Completed after navigation' }] };
    await act(async () => pending.resolve({ conversation: conversations.a }));
    expect(transcript.scrollTop).toBe(125);
    await open('a');
    expect(screen.getByText('Completed after navigation')).toBeInTheDocument();
    expect(transcript.scrollTop).not.toBe(600);
  } finally { position.mockRestore(); }
});

test('loaded review sources remain visible when switching reviews and reopening the Analyst', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.b.kind = 'prediction-markets-review';
  conversations.a.lastTurn = { id: 'portfolio-turn', state: 'complete' };
  conversations.b.lastTurn = { id: 'prediction-turn', state: 'complete' };
  const original = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/a/sources') return Promise.resolve({ items: [{ id: 'portfolio-research', label: 'Portfolio source', status: 'ready', observedAt: '2026-09-04T15:00:00Z' }] });
    if (path === '/conversations/b/sources') return Promise.resolve({ items: [{ id: 'prediction', label: 'Prediction source', status: 'unavailable', publishedAt: '2026-09-03' }] });
    return original(path, body, method);
  });
  const view = render(<PersistentSurface active><AnalystPanel /></PersistentSurface>);
  await open('a');
  await screen.findByText('Portfolio source');
  await open('b');
  await screen.findByText('Prediction source');

  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Chat a' }));
  expect(screen.getByText('Portfolio source')).toBeVisible();
  expect(screen.getByText('Sep 4 08:00 PDT')).toBeVisible();
  expect(screen.queryByText('Checking sources…')).not.toBeInTheDocument();
  expect(screen.queryByText('Prediction source')).not.toBeInTheDocument();

  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Chat b' }));
  expect(screen.getByText('Prediction source')).toBeVisible();
  expect(screen.getByText('Unavailable')).toBeVisible();
  expect(screen.queryByText('Checking sources…')).not.toBeInTheDocument();
  view.rerender(<PersistentSurface active={false}><AnalystPanel /></PersistentSurface>);
  view.rerender(<PersistentSurface active><AnalystPanel /></PersistentSurface>);
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(screen.getByText('Prediction source')).toBeVisible();
  expect(screen.queryByText('Checking sources…')).not.toBeInTheDocument();
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.endsWith('/sources')).map(([path]) => path)).toEqual([
    '/conversations/a/sources', '/conversations/b/sources',
  ]));
});

test('late source checks cannot appear in another review', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.b.kind = 'balance-review';
  const original = api.request.getMockImplementation();
  let finishSources;
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/a/sources') return new Promise(resolve => { finishSources = resolve; });
    if (path === '/conversations/b/sources') return Promise.resolve({ items: [{ id: 'interestStatus', label: 'Balance source', status: 'missing' }] });
    return original(path, body, method);
  });
  render(<AnalystPanel />);
  await open('a');
  await waitFor(() => expect(finishSources).toBeDefined());
  await open('b');
  await screen.findByText('Balance source');
  await act(async () => finishSources({ items: [{ id: 'portfolio-research', label: 'Portfolio source', status: 'ready', observedAt: '2026-09-04T15:00:00Z' }] }));
  expect(screen.getByText('Balance source')).toBeInTheDocument();
  expect(screen.queryByText('Portfolio source')).not.toBeInTheDocument();
});

test('one click deletes only that chat and its draft, and it never returns through replay, late completion or reload', async () => {
  const view = render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Removed draft' } });
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeDisabled();
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(api.request).toHaveBeenCalledWith('/conversations/a', undefined, 'DELETE');
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 9, type: 'deleted', conversation_id: 'a' }) }));
  await open('b');
  // A late completion for the deleted chat cannot bring it back.
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 10, type: 'complete', conversation_id: 'a' }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).a).toBeUndefined();
  view.unmount();
  render(<AnalystPanel />);
  await open('b');
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.filter(([, , method]) => method === 'DELETE')).toHaveLength(1);
});

test('reload, reconnect and history refresh never delete or hide a saved chat', async () => {
  const view = render(<AnalystPanel />);
  await open('a');
  view.unmount();
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat a' });
  act(() => stream.onerror?.());
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 20, type: 'complete', conversation_id: 'b' }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeEnabled();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat b' })).toBeEnabled();
  expect(api.request.mock.calls.some(([, , method]) => method === 'DELETE')).toBe(false);
});

test('a slow delete keeps a disabled Deleting row in place and a stale refresh cannot reopen it', async () => {
  const request = api.request.getMockImplementation();
  let finishDelete;
  api.request.mockImplementation((path, body, method) => method === 'DELETE'
    ? new Promise(resolve => { finishDelete = () => { delete conversations.a; resolve({ ok: true }); }; })
    : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  const order = () => historyRows().getAllByRole('button', { name: /^Open conversation:/ }).map(button => button.getAttribute('aria-label'));
  const before = order();
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  // The row stays in place, so a repeated click cannot land on the next row.
  const row = historyRows().getByRole('button', { name: 'Open conversation: Chat a' });
  expect(order()).toEqual(before);
  expect(row).toBeDisabled();
  expect(row).toHaveTextContent('Deleting…');
  expect(row.closest('.analyst-conversation-row')).toHaveClass('is-deleting');
  // One indicator: the ring, with no seconds counting beside them.
  expect(row.querySelectorAll('.analyst-spinner')).toHaveLength(1);
  expect(row.querySelector('.analyst-spinner-elapsed')).toBeNull();
  expect(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' })).toBeDisabled();
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  expect(screen.queryByText('Only answer A')).not.toBeInTheDocument();
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 10, conversation_id: 'a' }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeDisabled();
  expect(order()).toEqual(before);
  expect(screen.queryByText('Only answer A')).not.toBeInTheDocument();
  await open('b');
  await act(async () => finishDelete());
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(api.request.mock.calls.filter(([, , method]) => method === 'DELETE')).toHaveLength(1);
});

test('a fast delete acknowledgment holds the disabled row long enough that a repeated click deletes nothing else', async () => {
  conversations.c = make('c', 'Only answer C');
  render(<AnalystPanel />);
  await open('a');
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  // A double or triple click lands on the same in-place row, never on Chat b below it.
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeDisabled();
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(api.request.mock.calls.filter(([, , method]) => method === 'DELETE').map(([path]) => path)).toEqual(['/conversations/a']);
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat b' })).toBeEnabled();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat c' })).toBeEnabled();
});

test.each([false, true])('a failed delete confirmed by GET restores the row and draft, offers Retry delete, and does not steal navigation (switch: %s)', async switched => {
  const request = api.request.getMockImplementation();
  let failDelete;
  let failures = 0;
  api.request.mockImplementation((path, body, method) => method === 'DELETE' && failures++ === 0
    ? new Promise((resolve, reject) => { failDelete = () => reject(new Error('Offline')); })
    : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Keep my draft' } });
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeDisabled();
  if (switched) await open('b');
  await act(async () => failDelete());
  expect(api.request.mock.calls.filter(([path, , method]) => path === '/conversations/a' && method !== 'DELETE').length).toBeGreaterThanOrEqual(2);
  expect(screen.getByRole('alert')).toHaveTextContent('Not deleted · Chat a');
  // Deleting from the history left Chat a; the failure keeps whatever view followed.
  expect(Boolean(screen.queryByText('Only answer B'))).toBe(switched);
  expect(Boolean(screen.queryByRole('group', { name: 'Start a review' }))).toBe(!switched);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).a).toBe('Keep my draft');
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeEnabled();
  // Retry is one more click on the same delete.
  fireEvent.click(screen.getByRole('button', { name: 'Retry deleting conversation: Chat a' }));
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(api.request.mock.calls.filter(([path, , method]) => path === '/conversations/a' && method === 'DELETE')).toHaveLength(2);
});

test('server deletion confirmation wins over a lost HTTP response', async () => {
  const request = api.request.getMockImplementation();
  let failDelete;
  api.request.mockImplementation((path, body, method) => method === 'DELETE'
    ? new Promise((resolve, reject) => { failDelete = () => reject(new Error('Connection lost')); })
    : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  delete conversations.a;
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 11, type: 'deleted', conversation_id: 'a' }) }));
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeDisabled();
  await act(async () => failDelete());
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a committed delete with a lost HTTP response is confirmed by GET 404 without a stream event', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => method === 'DELETE' ? pending.promise : request(path, body, method));
  const view = render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Delete this draft too' } });
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  await open('b');
  delete conversations.a;
  await act(async () => pending.reject(new Error('Connection lost after commit')));
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
  await waitFor(() => expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument(), { timeout: 3000 });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).a).toBeUndefined();
  view.unmount();
  render(<AnalystPanel />);
  await open('b');
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument();
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/') || path === '/messages')).toBe(false);
});

test('unavailable deletion verification reports uncertainty without claiming the chat is still saved', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  let verificationUnavailable = false;
  api.request.mockImplementation((path, body, method) => {
    if (method === 'DELETE') return pending.promise;
    if (path === '/conversations/a' && verificationUnavailable) return Promise.reject(new Error('History is offline'));
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'Preserve uncertain draft' } });
  fireEvent.click(historyRows().getByRole('button', { name: 'Delete conversation: Chat a' }));
  await open('b');
  verificationUnavailable = true;
  await act(async () => pending.reject(new Error('Connection lost')));
  expect(screen.getByRole('alert')).toHaveTextContent('Delete unconfirmed · Chat a');
  expect(screen.queryByText(/still saved/i)).not.toBeInTheDocument();
  expect(screen.getByText('Only answer B')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).a).toBe('Preserve uncertain draft');
  delete conversations.a;
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 13, type: 'deleted', conversation_id: 'a' }) }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(historyRows().queryByRole('button', { name: 'Open conversation: Chat a' })).not.toBeInTheDocument();
});

test('a stuck review is stopped and run again from Retry without deleting it', async () => {
  conversations.a = { ...conversations.a, title: 'Portfolio Review', kind: 'portfolio-review', trading_date: '2026-09-04',
    state: 'running', activeTurn: { id: 'stuck-turn', state: 'running' } };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => {
    if (path === '/conversations/a/turns/stuck-turn/stop') {
      conversations.a = { ...conversations.a, state: 'interrupted', activeTurn: null,
        lastTurn: { id: 'stuck-turn', state: 'interrupted', error: 'Response stopped. Retry is available.' } };
      return Promise.resolve({ ok: true });
    }
    if (path === '/daily/portfolio-review') return Promise.resolve({ conversation: conversations.a });
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  // While the review is active, Stop is the way out; Retry appears once it stops.
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Portfolio Review' }));
  expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument());
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/daily/portfolio-review', { refresh: true, conversationId: 'a', requestId: expect.stringMatching(/^review-refresh:/) }));
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Portfolio Review' })).toHaveLength(1);
  expect(api.request.mock.calls.some(([, , method]) => method === 'DELETE')).toBe(false);
});

test('Balance narrative retry revalidates its exact captured primary and stays quiet without top-level run metadata', async () => {
  const primary = { id: 'captured-report', role: 'assistant', state: 'complete', turn_id: 'capture-turn',
    reviewRunId: 'captured-run', reviewPostId: 'captured-post', text: '# Balance Review\n\nVerified current account.',
    balancePrimary: { available: true, runId: 'captured-run', reportRevision: 'verified-capture' }, balancePrimaryIncluded: true };
  conversations.a = { ...conversations.a, kind: 'balance-review', revision: 1, reviewRunId: 'captured-run', messages: [primary],
    lastTurn: { id: 'explanation', state: 'interrupted', request_id: 'daily-narrative:captured-run', error: 'Connecting' } };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation(async (path, body, method) => {
    if (path.endsWith('/retry')) {
      const retry = { id: 'retry-turn', state: 'accepted', request_id: body.requestId, review_post_id: 'captured-post' };
      conversations.a = { ...conversations.a, revision: 2, reviewRunId: undefined, activeTurn: retry, lastTurn: retry };
      const { balancePrimary: _marker, balancePrimaryIncluded: _included, ...unmarked } = primary;
      return { conversation: { ...conversations.a, messages: [unmarked] } };
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText(/Verified current account\./);
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  await screen.findByRole('button', { name: 'Stop' });
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument());
  expect(screen.getByText(/Verified current account\./)).toBeVisible();
  expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toHaveTextContent('1 message');
  expect(api.request).toHaveBeenCalledWith('/conversations/a?includeBriefs=false&briefScope=latest');
  expect(api.request.mock.calls.some(([path]) => path === '/daily/balance-review')).toBe(false);
});

test.each(['foreign-post', 'foreign-run', 'ordinary-followup', 'unverified', 'new-capture'])('Balance %s cannot certify an active narrative retry from an older primary', async failure => {
  const report = { id: 'captured-report', role: 'assistant', state: 'complete', turn_id: 'capture-turn',
    reviewRunId: 'captured-run', reviewPostId: 'captured-post', text: '# Balance Review\n\nVerified current account.',
    balancePrimary: { available: failure !== 'unverified', runId: 'captured-run' }, balancePrimaryIncluded: true };
  conversations.a = { ...conversations.a, kind: 'balance-review', revision: 1,
    activeTurn: { id: 'retry-turn', state: 'accepted', review_post_id: failure === 'foreign-post' ? 'foreign-post' : 'captured-post',
      request_id: failure === 'ordinary-followup' ? 'followup-question' : 'narrative-retry:retry-request' },
    reviewRunId: failure === 'foreign-run' ? 'foreign-run' : undefined,
    messages: [report, ...(failure === 'new-capture' ? [{ id: 'new-capture', role: 'assistant', state: 'running', text: '',
      reviewRunId: 'new-run', reviewPostId: 'new-post', turn_id: 'new-turn' }] : [])] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText(/Verified current account\./);
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
});

test('retrying an explanation targets its turn without rerunning the balance review',async()=>{
 Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => 'test-retry-uuid' });
 conversations.a.kind='balance-review';
 conversations.a.lastTurn={id:'explanation-1',state:'failed',request_id:'daily-narrative:run-1',error:'Connecting'};
 const request=api.request.getMockImplementation();
 api.request.mockImplementation(async(path,body,method)=>path.endsWith('/retry')
  ? {conversation:{...conversations.a,lastTurn:{id:'retry-1',state:'accepted'},activeTurn:{id:'retry-1'}}}
  : request(path,body,method));
 render(<AnalystPanel/>);
 await open('a');
 fireEvent.click(screen.getByRole('button',{name:'Retry',exact:true}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/conversations/a/turns/explanation-1/retry',{requestId:expect.stringMatching(/^narrative-retry:/)}));
 expect(api.request.mock.calls.some(([path])=>path==='/daily/balance-review')).toBe(false);
 expect(screen.getByText('Only answer A')).toBeInTheDocument();
});

test('a recovered idle history stream clears the reconnecting notice without needing a new message',async()=>{
 render(<AnalystPanel/>);
 await open('a');
 const unavailable=stream.addEventListener.mock.calls.find(([name])=>name==='unavailable')[1];
 const ready=stream.addEventListener.mock.calls.find(([name])=>name==='ready')[1];
 jest.useFakeTimers();
 try {
  act(()=>unavailable());
  expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
  act(()=>jest.advanceTimersByTime(4000));
  expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  expect(screen.queryByText(/Reconnecting to saved history/)).not.toBeInTheDocument();
  act(()=>ready());
  expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
 } finally { jest.useRealTimers(); }
 expect(screen.getByText('Only answer A')).toBeInTheDocument();
});

test.each(['Question with spaces  ', 'Question with newline\n'])('send clears the raw draft immediately and keeps one thinking indicator: %j', async raw => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  const input = screen.getByRole('textbox', { name: 'Message The Analyst' });
  fireEvent.change(input, { target: { value: raw } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(input).toHaveValue('');
  expect(input).toHaveFocus();
  expect(within(screen.getByRole('log')).getByText(raw.trim())).toBeVisible();
  const dots = screen.getByRole('status', { name: 'Response running' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(api.request.mock.calls.filter(([path]) => path === '/messages')).toHaveLength(1);
  fireEvent.change(input, { target: { value: 'Next question already being composed' } });
  const sent = api.request.mock.calls.find(([path]) => path === '/messages')[1];
  conversations.a = { ...conversations.a, revision: 2, activeTurn: { id: 'turn', request_id: sent.requestId },
    messages: [...conversations.a.messages, { id: 'user', role: 'user', text: raw.trim(), turn_id: 'turn' }] };
  await act(async () => pending.resolve({ conversation: conversations.a }));
  expect(input).toHaveValue('Next question already being composed');
  expect(screen.getByRole('status', { name: 'Response running' })).toBe(dots);
  expect(within(screen.getByRole('log')).getAllByText(raw.trim())).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  act(() => stream.onerror());
  expect(screen.getByRole('status', { name: 'Response running' })).toBe(dots);
  expect(screen.queryByText(/Reconnecting to saved history/)).not.toBeInTheDocument();
  conversations.a = { ...conversations.a, revision: 3, activeTurn: null, lastTurn: { id: 'turn', state: 'complete' },
    messages: [...conversations.a.messages, { id: 'final', role: 'assistant', text: 'Final answer', state: 'complete' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByText('Final answer');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
});

test('new-chat send shows the question before acceptance and carries only the next draft into the new chat', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  const input = screen.getByRole('textbox', { name: 'Message The Analyst' });
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
  fireEvent.change(input, { target: { value: 'New conversation question\n' } });
  expect(api.request.mock.calls.some(([path]) => path === '/messages')).toBe(false);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(api.request).toHaveBeenCalledWith('/messages', { text: 'New conversation question', conversationId: null, requestId: expect.any(String) });
  expect(input).toHaveValue('');
  expect(screen.getByText('New conversation question')).toBeVisible();
  expect(screen.getAllByRole('status', { name: 'Response running' })).toHaveLength(1);
  fireEvent.change(input, { target: { value: 'Next draft' } });
  conversations.c = { ...make('c', 'Answer'), messages: [{ id: 'user-c', role: 'user', text: 'New conversation question' }], activeTurn: { id: 'c-turn' } };
  await act(async () => pending.resolve({ conversation: conversations.c }));
  expect(input).toHaveValue('Next draft');
  expect(screen.getAllByText('New conversation question')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.drafts')).landing).toBe('');
});

test.each(['send', 'review'])('late %s completion after closing preserves the existing selected view', async operation => {
  const pending = deferred();
  const path = operation === 'send' ? '/messages' : '/daily/portfolio-review';
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((url, body, method) => url === path ? pending.promise : request(url, body, method));
  const viewFor = active => <PersistentSurface active={active}><AnalystPanel /></PersistentSurface>;
  const view = render(viewFor(true));
  if (operation === 'send') {
    fireEvent.change(screen.getByRole('textbox', { name: 'Message The Analyst' }), { target: { value: 'A new question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  } else fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  expect(api.request.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
  view.rerender(viewFor(false));
  view.rerender(viewFor(true));
  expect(Boolean(screen.queryByRole('group', { name: 'Start a review' }))).toBe(operation === 'send');
  expect(Boolean(screen.queryByRole('status', { name: 'Response running' }))).toBe(operation === 'review');
  conversations.finished = { ...make('finished', 'Late completed answer'), kind: operation === 'send' ? 'chat' : 'portfolio-review' };
  await act(async () => pending.resolve({ conversation: conversations.finished }));
  expect(Boolean(screen.queryByRole('group', { name: 'Start a review' }))).toBe(operation === 'send');
  expect(Boolean(screen.queryByText('Late completed answer'))).toBe(operation === 'review');
  expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe(operation === 'send' ? null : 'finished');
  if (operation === 'send') fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat finished' }));
  expect(await screen.findByText('Late completed answer')).toBeVisible();
});

test.each([false, true])('send failure restores only the original empty draft and reuses the request ID (new draft: %s)', async edited => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  const input = screen.getByRole('textbox', { name: 'Message The Analyst' });
  fireEvent.change(input, { target: { value: 'Retry this question  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  if (edited) fireEvent.change(input, { target: { value: 'Keep the new draft' } });
  await act(async () => pending.reject(new Error('Could not send.')));
  expect(input).toHaveValue(edited ? 'Keep the new draft' : 'Retry this question  ');
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByText('Only answer A')).toBeVisible();
  if (!edited) {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Not sent · Analyst unreachable · ↵ to resend');
  }
  const sends = api.request.mock.calls.filter(([path]) => path === '/messages');
  expect(sends).toHaveLength(edited ? 1 : 2);
  expect(sends.at(-1)[1].requestId).toBe(sends[0][1].requestId);
});

test('late send acceptance preserves navigation and the next draft in the originating conversation', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Question for A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Next draft A' } });
  await open('b');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft B' } });
  conversations.a = { ...conversations.a, activeTurn: { id: 'a-turn' } };
  await act(async () => pending.resolve({ conversation: conversations.a }));
  expect(screen.getByText('Only answer B')).toBeVisible();
  expect(screen.getByRole('textbox')).toHaveValue('Draft B');
  await open('a');
  expect(screen.getByRole('textbox')).toHaveValue('Next draft A');
});

test('removes the duplicate gray title and does not submit an IME composition or Shift+Enter', async () => {
  render(<AnalystPanel />);
  await open('a');
  expect(within(screen.getByRole('log')).queryByText(/Chat a/)).not.toBeInTheDocument();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Unfinished composition' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  expect(input).toHaveValue('Unfinished composition');
  expect(api.request.mock.calls.filter(([path]) => path === '/messages')).toHaveLength(0);
});

test('history search keeps the event stream open and unrelated Inbox errors do not interrupt responses', async () => {
  render(<AnalystPanel />);
  await open('a');
  const closeCount = stream.close.mock.calls.length;
  home();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Chat' } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations?q=Chat&archived=false'));
  expect(stream.close).toHaveBeenCalledTimes(closeCount);
  await open('a');
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/inbox' ? Promise.reject(new Error('Inbox unavailable')) : request(path, body, method));
  conversations.a = { ...conversations.a, activeTurn: { id: 'a-turn' }, messages: [...conversations.a.messages, { id: 'more', role: 'assistant', state: 'running', text: 'Still responding' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 8, conversation_id: 'a' }) }));
  await screen.findByText('Still responding');
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
});

test.each([['before', false], ['after', false], ['before', true], ['after', true]])('a durable acceptance %s a lost send response keeps the submitted question out of the composer (new draft: %s)', async (order, edited) => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/messages' ? pending.promise : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accepted question  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  if (edited) fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Newer unsent question' } });
  const sent = api.request.mock.calls.find(([path]) => path === '/messages')[1];
  const receipt = async () => {
    conversations.a = { ...conversations.a, revision: 2, activeTurn: { id: 'accepted', request_id: sent.requestId },
      messages: [...conversations.a.messages, { id: 'accepted-user', role: 'user', text: 'Accepted question', turn_id: 'accepted' }, { id: 'accepted-answer', role: 'assistant', text: 'Response has started', state: 'running' }] };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 3, conversation_id: 'a' }) }));
    await screen.findByText('Response has started');
  };
  if (order === 'before') await receipt();
  await act(async () => pending.reject(new Error('Connection lost.')));
  if (order === 'after') await receipt();
  expect(screen.getByRole('textbox')).toHaveValue(edited ? 'Newer unsent question' : '');
  expect(screen.queryByText('Connection lost.')).not.toBeInTheDocument();
  expect(within(screen.getByRole('log')).getAllByText('Accepted question')).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.outbox'))).toBeNull();
});

test.each(['', 'Newer unsent question'])('reload reconciles the accepted outbox without losing a newer draft: %j', async draft => {
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.outbox', JSON.stringify({ conversationId: 'a', requestId: 'accepted-request', text: 'Already sent' }));
  localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ a: draft }));
  conversations.a.lastTurn = { id: 'accepted', request_id: 'accepted-request', state: 'complete' };
  render(<AnalystPanel />);
  await screen.findByText('Only answer A');
  expect(screen.getByRole('textbox')).toHaveValue(draft);
  expect(JSON.parse(localStorage.getItem('analyst.workspace.outbox'))).toBeNull();
  expect(api.request.mock.calls.filter(([path]) => path === '/messages')).toHaveLength(0);
});

test('retrying an unaccepted send preserves a newer draft and the original request ID', async () => {
  const first = deferred();
  const second = deferred();
  const request = api.request.getMockImplementation();
  let count = 0;
  api.request.mockImplementation((path, body, method) => path === '/messages' ? (++count === 1 ? first.promise : second.promise) : request(path, body, method));
  render(<AnalystPanel />);
  await open('a');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Original question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New question in progress' } });
  await act(async () => first.reject(new Error('Send failed.')));
  fireEvent.click(screen.getByRole('button', { name: 'Resend' }));
  expect(screen.getByRole('textbox')).toHaveValue('New question in progress');
  const sends = api.request.mock.calls.filter(([path]) => path === '/messages');
  expect(sends[1][1]).toEqual(sends[0][1]);
  conversations.a = { ...conversations.a, activeTurn: { id: 'retry-turn', request_id: sends[0][1].requestId } };
  await act(async () => second.resolve({ conversation: conversations.a }));
  expect(screen.getByRole('textbox')).toHaveValue('New question in progress');
});

test('a temporary history refresh failure keeps the loaded chat usable without a chat error banner', async () => {
  render(<AnalystPanel />);
  await open('a');
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path.startsWith('/conversations?') ? Promise.reject(new Error('History request timed out.')) : request(path, body, method));
  home();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Chat' } });
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations?q=Chat&archived=false'));
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Chat a' }));
  expect(await screen.findByText('Only answer A')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
});

test('first subscription starts at the server live cursor independently of the sidebar snapshot and skips historical replay', async () => {
  const snapshot = deferred();
  const request = api.request.getMockImplementation();
  localStorage.setItem('analyst.workspace.cursor', JSON.stringify(12));
  api.events.mockClear();
  let initial = true;
  api.request.mockImplementation((path, body, method) => {
    if (path.startsWith('/conversations?')) {
      if (initial) { initial = false; return snapshot.promise; }
      return Promise.resolve({ conversations: Object.values(conversations), cursor: 142_282 });
    }
    return request(path, body, method);
  });
  render(<AnalystPanel />);
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations?q=&archived=false'));
  expect(api.events).toHaveBeenCalledWith('latest');
  const ready = stream.addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
  act(() => ready({ data: JSON.stringify({ cursor: 142_281 }) }));
  await act(async () => snapshot.resolve({ conversations: Object.values(conversations), cursor: 142_281 }));
  expect(api.events).toHaveBeenCalledTimes(1);
  act(() => {
    for (let seq = 1; seq <= 500; seq += 1) stream.onmessage({ data: JSON.stringify({ seq, conversation_id: `old-${seq}`, type: 'delta' }) });
    stream.onmessage({ data: JSON.stringify({ seq: 142_282, conversation_id: 'unopened', type: 'complete' }) });
  });
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?'))).toHaveLength(2));
  expect(api.request.mock.calls.some(([path]) => /^\/conversations\//.test(path))).toBe(false);
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
  expect(JSON.parse(localStorage.getItem('analyst.workspace.cursor'))).toBe(12);
});

test('snapshot subscription delivers newer selected response changes and unopened sidebar rows', async () => {
  const request = api.request.getMockImplementation();
  api.events.mockClear();
  api.request.mockImplementation(async (path, body, method) => {
    const response = await request(path, body, method);
    return path.startsWith('/conversations?') ? { ...response, cursor: 142_281 } : response;
  });
  render(<AnalystPanel />);
  await open('a');
  expect(api.events).toHaveBeenCalledWith('latest');
  conversations.a = { ...conversations.a, revision: 2, activeTurn: { id: 'a-turn' },
    messages: [...conversations.a.messages, { id: 'new-response', role: 'assistant', state: 'running', text: 'Current response after snapshot' }] };
  conversations.c = make('c', 'Only answer C');
  act(() => {
    stream.onmessage({ data: JSON.stringify({ seq: 142_282, conversation_id: 'a', type: 'delta' }) });
    stream.onmessage({ data: JSON.stringify({ seq: 142_283, conversation_id: 'c', type: 'created' }) });
  });
  await screen.findByText('Current response after snapshot');
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  await historyRows().findByRole('button', { name: 'Open conversation: Chat c' });
  expect(api.request.mock.calls.some(([path]) => path === '/conversations/c')).toBe(false);
});

test('navigation shares a pending transcript and a later response invalidation gets one fresh read', async () => {
  const first = deferred();
  const latest = deferred();
  const request = api.request.getMockImplementation();
  let reads = 0;
  api.request.mockImplementation((path, body, method) => path === '/conversations/a'
    ? (++reads === 1 ? first.promise : latest.promise) : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(reads).toBe(1));
  await open('b');
  fireEvent.click(historyRows().getByRole('button', { name: 'Open conversation: Chat a' }));
  expect(reads).toBe(1);
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a', type: 'complete' }) }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
  expect(reads).toBe(1);
  await act(async () => first.resolve({ conversation: { ...conversations.a, revision: 1 } }));
  await waitFor(() => expect(reads).toBe(2));
  const revised = { ...conversations.a, revision: 2, messages: [{ id: 'fresh-a', role: 'assistant', state: 'complete', text: 'Fresh answer after invalidation' }] };
  await act(async () => latest.resolve({ conversation: revised }));
  await screen.findByText('Fresh answer after invalidation');
  expect(reads).toBe(2);
  expect(screen.queryByText('Only answer B')).not.toBeInTheDocument();
});

test.each([undefined, -1, '142281', 1.5])('an invalid snapshot cursor %p never replays browser history and saved chats remain readable', async cursor => {
  localStorage.setItem('analyst.workspace.cursor', '0');
  const request = api.request.getMockImplementation();
  api.events.mockClear();
  api.request.mockImplementation(async (path, body, method) => {
    const result = await request(path, body, method);
    return path.startsWith('/conversations?') ? { ...result, cursor } : result;
  });
  render(<AnalystPanel />);
  await open('a');
  expect(api.events).toHaveBeenCalledWith('latest');
  expect(screen.getByText('Only answer A')).toBeVisible();
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/') || path === '/messages')).toBe(false);
});

test('hidden retained Analyst stops subscriptions and resumes its selected chat from a fresh snapshot', async () => {
  const request = api.request.getMockImplementation();
  let cursor = 10;
  api.events.mockClear();
  api.request.mockImplementation(async (path, body, method) => {
    const result = await request(path, body, method);
    return path.startsWith('/conversations?') ? { ...result, cursor } : result;
  });
  const view = render(<PersistentSurface active><AnalystPanel /></PersistentSurface>);
  await open('a');
  await open('b');
  const oldMessage = stream.onmessage;
  api.request.mockClear();
  view.rerender(<PersistentSurface active={false}><AnalystPanel /></PersistentSurface>);
  expect(stream.close).toHaveBeenCalledTimes(1);
  jest.useFakeTimers();
  try {
    act(() => {
      oldMessage({ data: JSON.stringify({ seq: 11, conversation_id: 'a', type: 'complete' }) });
      jest.advanceTimersByTime(10_000);
    });
    expect(api.request).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
  cursor = 30;
  stream = { close: jest.fn(), addEventListener: jest.fn() };
  view.rerender(<PersistentSurface active><AnalystPanel /></PersistentSurface>);
  await waitFor(() => expect(api.events).toHaveBeenLastCalledWith('latest'));
  expect(screen.getByText('Only answer B')).toBeVisible();
  act(() => stream.onopen());
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?'))).toHaveLength(2));
  expect(api.request.mock.calls.some(([path]) => path === '/conversations/b')).toBe(true);
  expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
});

test('hiding during an invalidated transcript read does not launch queued reads or ancillary requests', async () => {
  const pending = deferred();
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/conversations/a' ? pending.promise : request(path, body, method));
  const view = render(<PersistentSurface active><AnalystPanel /></PersistentSurface>);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a'));
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a', type: 'complete' }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  view.rerender(<PersistentSurface active={false}><AnalystPanel /></PersistentSurface>);
  api.request.mockClear();
  await act(async () => pending.resolve({ conversation: conversations.a }));
  expect(api.request).not.toHaveBeenCalled();
});

test('reconnecting refreshes only selected and active chats instead of every visited transcript', async () => {
  conversations.a.activeTurn = { id: 'active-a' };
  render(<AnalystPanel />);
  await open('a');
  await open('b');
  conversations.c = make('c', 'Only answer C');
  await act(async () => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'c', type: 'created' }) }));
  await open('c');
  api.request.mockClear();
  act(() => stream.onopen());
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/a'));
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/conversations/c'));
  expect(api.request.mock.calls.some(([path]) => path === '/conversations/b')).toBe(false);
});

test('fresh unchanged predictive snapshots reuse parsed reports but same-revision source corrections appear', async () => {
  conversations.a = { ...conversations.a, kind: 'prediction-markets-review', revision: 5 };
  conversations.a.messages[0].text = '### Silver\n**Trend:** Bullish';
  conversations.a.messages[0].citations = [{ id: 'source', product: 'risk-ranges', title: 'Original publication' }];
  const request = api.request.getMockImplementation();
  api.request.mockImplementation(async (path, body, method) => JSON.parse(JSON.stringify(await request(path, body, method))));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText(/### Silver/);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('IB Gateway'));
  ReactMarkdown.mockClear();
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 6, conversation_id: 'a' }) }));
  await waitFor(() => expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a')).toHaveLength(2));
  expect(ReactMarkdown).not.toHaveBeenCalled();
  conversations.a.messages[0].text = '### Silver\n**Trend:** Bearish';
  conversations.a.messages[0].citations[0].title = 'Corrected captured publication';
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 7, conversation_id: 'a' }) }));
  await screen.findByText(/Bearish/);
  expect(ReactMarkdown).toHaveBeenCalledTimes(1);
});

test('verified progressive review sections display captured citations before terminal completion', async () => {
  const citation = { id: 'partial-source', product: 'risk-ranges', title: 'Captured Risk Ranges', excerpt: 'Verified published reading' };
  conversations.a.kind = 'balance-review';
  conversations.a.activeTurn = { id: 'review-turn' };
  conversations.a.messages = [{ id: 'report-post', role: 'assistant', state: 'reviewing', text: '## Verified research\n\nBullish reading', citations: [citation], reviewRunId: 'run-partial' }];
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText(/Verified research/);
  expect(screen.getByRole('status', { name: 'Response running' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '[1] Captured Risk Ranges' }));
  expect(screen.getByRole('dialog', { name: 'Citation source' })).toHaveTextContent('Verified published reading');
  expect(conversations.a.messages[0].state).toBe('reviewing');
});

test('a progressive Portfolio capture renders its structured report without parsing duplicate raw Markdown', async () => {
  const prepare = jest.spyOn(analystMarkdown, 'prepareAnalystMarkdown');
  const saved = '# PORTFOLIO REVIEW\n\n<!-- analyst-daily-rollup -->\n\nRaw duplicate report';
  conversations.a = { ...conversations.a, kind: 'portfolio-review', briefsIncluded: false,
    activeTurn: { id: 'review-turn' }, reviewPhase: 'acquiring', messages: [{ id: 'report-post', role: 'assistant',
      state: 'reviewing', text: saved, turn_id: 'review-turn', reviewRunId: 'run-partial', portfolioBrief: {
        presentation: 'compact', available: true, runId: 'run-partial', asOf: '2026-09-04T20:05:00Z',
        metrics: { grossExposure: 1234 }, holdings: [], citations: [], dailyRollup: { version: 1, sections: [{
          id: 'market-drivers', title: 'Today’s market drivers', blocks: [{ type: 'paragraph', text: 'Captured research appears promptly.' }],
        }] },
      } }] };
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await findPortfolioExposureAmount('$1,234');
  const report = screen.getByRole('article', { name: 'Portfolio Review summary' });
  expect(report).toHaveTextContent('$1,234');
  expect(report).toHaveTextContent('Captured research appears promptly.');
  expect(report).not.toHaveTextContent(/PORTFOLIO REVIEW|analyst-daily-rollup|Raw duplicate/);
  expect(prepare).not.toHaveBeenCalled();
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Review sources' })).toBeVisible();
  // The review runs edge to edge with the composer, as Predictive boards do.
  expect(screen.getByRole('log', { name: 'Conversation' })).toHaveClass('is-composer-width');
  expect(api.request.mock.calls.some(([path]) => path.startsWith('/conversations/a?includeBriefs=false'))).toBe(true);
  expect(conversations.a.messages[0].text).toBe(saved);
  prepare.mockRestore();
});

test('a legacy Portfolio report hides internal markers and its redundant title without changing captured text', async () => {
  const saved = '# PORTFOLIO REVIEW\n\n<!-- analyst-daily-rollup -->\n\n## Exposure & risk\n\nCaptured exposure.';
  conversations.a.kind = 'portfolio-review';
  conversations.a.messages[0].text = saved;
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const body = await screen.findByText(/Captured exposure/);
  expect(body.closest('.analyst-message')).toHaveClass('analyst-portfolio-markdown');
  expect(body).toHaveTextContent('## Exposure & risk');
  expect(body).not.toHaveTextContent(/PORTFOLIO REVIEW|analyst-daily-rollup/);
  expect(conversations.a.messages[0].text).toBe(saved);
});

test('compact review updates render the terminal receipt without a full historical hydration', async () => {
  conversations.a.kind = 'portfolio-review';
  conversations.a.activeTurn = { id: 'review-turn' };
  render(<AnalystPanel />);
  await open('a');
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a')).toHaveLength(0);
  conversations.a = { ...conversations.a, activeTurn: null, briefsIncluded: false, revision: 2,
    messages: [{ ...conversations.a.messages[0], text: 'Terminal captured review' }] };
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 1, conversation_id: 'a' }) }));
  await screen.findByText('Terminal captured review');
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a')).toHaveLength(0);
  expect(api.request.mock.calls.filter(([path]) => path === '/conversations/a?includeBriefs=false&briefScope=latest')).toHaveLength(2);
  expect(screen.queryByRole('status', { name: 'Response running' })).not.toBeInTheDocument();
});

test('compact Portfolio sources load evidence from the original post only when opened', async () => {
  const source = { id: 'captured-source', product: 'risk-ranges', title: 'Captured publication', publicationDate: '2026-09-04',
    evidenceIncluded: false, captureConversationId: 'a', captureMessageId: 'original-post' };
  const savedBrief = { presentation: 'compact', available: true, holdings: [], metrics: {}, dailyRollup: {
    version: 1, citations: [source], sections: [{ id: 'drivers', title: 'Market drivers', citationIds: [source.id],
      blocks: [{ type: 'paragraph', text: 'Captured published reading for the verified security.', citationIds: [source.id] }] }],
  } };
  conversations.a = { ...conversations.a, kind: 'portfolio-review', briefsIncluded: false, activeTurn: { id: 'review-turn' },
    messages: [{ id: 'original-post', role: 'assistant', state: 'reviewing', text: '', portfolioBrief: savedBrief }] };
  const evidence = deferred();
  const path = '/conversations/a/citations/original-post/captured-source';
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((url, body, method) => url === path ? evidence.promise : request(url, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  const sourceButton = await screen.findByRole('button', { name: 'Source: Captured publication · Sep 4, 2026' });
  expect(api.request.mock.calls.some(([url]) => url === path)).toBe(false);
  fireEvent.click(sourceButton);
  const popup = screen.getByRole('dialog', { name: 'Citation source' });
  expect(popup).toHaveTextContent('Captured publication');
  expect(popup.querySelector('article')).toHaveAttribute('aria-busy', 'true');
  await expectSelected('Chat a');
  await act(async () => evidence.resolve({ citation: { ...source, excerpt: 'Captured published reading for the verified security. Saved publication context.' } }));
  expect(popup).toHaveTextContent('Captured published reading for the verified security. Saved publication context.');
  expect(popup.querySelector('article')).not.toHaveAttribute('aria-busy');
  expect(popup.querySelector('mark')).toHaveTextContent('Captured published reading for the verified security.');
  expect(source.excerpt).toBeUndefined();
});

test('malformed events are contained without transcript reads or render failure', async () => {
  render(<AnalystPanel />);
  await open('a');
  api.request.mockClear();
  act(() => {
    for (const data of ['not JSON', 'null', '{"seq":"1"}', '{"seq":1,"conversation_id":42}']) stream.onmessage({ data });
  });
  expect(screen.getByText('Only answer A')).toBeVisible();
  expect(api.request).not.toHaveBeenCalled();
});

test('a closed event stream at cold start reconnects with capped backoff and recovers history without user action', async () => {
  jest.useFakeTimers();
  try {
    localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
    const request = api.request.getMockImplementation();
    let cold = true;
    const streams = [];
    api.events.mockImplementation(after => {
      const created = { after, readyState: 0, addEventListener: jest.fn() };
      created.close = jest.fn(() => { created.readyState = 2; });
      streams.push(created);
      return created;
    });
    api.request.mockImplementation((path, body, method) => cold && path.startsWith('/conversations')
      ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503', status: 503 })) : request(path, body, method));
    render(<AnalystPanel />);
    await act(async () => jest.advanceTimersByTimeAsync(700));
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeVisible();
    // A 503 answer to the stream request closes an EventSource permanently.
    act(() => { streams[0].readyState = 2; streams[0].onerror(); });
    expect(streams).toHaveLength(1);
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(streams).toHaveLength(2);
    expect(streams[1].after).toBe('latest');
    act(() => { streams[1].readyState = 2; streams[1].onerror(); });
    await act(async () => jest.advanceTimersByTimeAsync(1999));
    expect(streams).toHaveLength(2);
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(streams).toHaveLength(3);
    cold = false;
    const ready = streams[2].addEventListener.mock.calls.find(([name]) => name === 'ready')[1];
    act(() => { streams[2].readyState = 1; streams[2].onopen(); ready({ data: JSON.stringify({ cursor: 77 }) }); });
    await act(async () => jest.advanceTimersByTimeAsync(300));
    expect(screen.getByText('Only answer A')).toBeInTheDocument();
    await expectSelected('Chat a');
    // Later reconnects resume after the observed cursor instead of replaying old events.
    act(() => { streams[2].readyState = 2; streams[2].onerror(); });
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(streams).toHaveLength(4);
    expect(streams[3].after).toBe(77);
    expect(streams.slice(0, 3).every(stream => stream.close.mock.calls.length > 0)).toBe(true);
    expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
    expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
  } finally { jest.useRealTimers(); }
});

test('history and the selected chat retry automatically with capped backoff while the event stream is still down', async () => {
  jest.useFakeTimers();
  try {
    localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
    localStorage.setItem('analyst.workspace.drafts', JSON.stringify({ a: 'Draft kept through the outage' }));
    const request = api.request.getMockImplementation();
    let cold = true;
    api.request.mockImplementation((path, body, method) => cold && path.startsWith('/conversations')
      ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'ANALYST_REQUEST_TIMEOUT' })) : request(path, body, method));
    render(<AnalystPanel />);
    await act(async () => jest.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeVisible();
    const lists = () => api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?')).length;
    const before = lists();
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    // Capped at fifteen seconds: a handful of reads per minute, never a tight loop.
    expect(lists() - before).toBeGreaterThan(2);
    expect(lists() - before).toBeLessThan(25);
    cold = false;
    await act(async () => jest.advanceTimersByTimeAsync(16_000));
    expect(screen.getByText('Only answer A')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toHaveValue('Draft kept through the outage');
    expect(api.request.mock.calls.some(([path]) => path === '/messages' || path.startsWith('/daily/'))).toBe(false);
    expect(historyRows().getByRole('button', { name: 'Open conversation: Chat a' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
  } finally { jest.useRealTimers(); }
});

test('source-progress events revalidate only the selected review Sources without reloading a conversation', async () => {
  conversations.a = { ...conversations.a, kind: 'prediction-markets-review', revision: 1, reviewPhase: 'acquiring',
    activeTurn: { id: 'review-turn', state: 'running' },
    messages: [{ id: 'post', role: 'assistant', state: 'reviewing', text: 'Progressive Predictive findings', turn_id: 'review-turn', reviewRunId: 'run-1' }] };
  conversations.b = { ...conversations.b, kind: 'prediction-markets-review' };
  const request = api.request.getMockImplementation();
  let status = 'checking';
  api.request.mockImplementation((path, body, method) => path === '/conversations/a/sources'
    ? Promise.resolve({ conversationId: 'a', runId: 'run-1', basis: 'review', state: 'running', items: [
      { id: 'risk-ranges', label: 'Risk Ranges', status, ...(status === 'ready' ? { publishedAt: '2026-10-09' } : {}) }] })
    : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText('Progressive Predictive findings');
  const reads = predicate => api.request.mock.calls.filter(([path]) => predicate(path)).length;
  await waitFor(() => expect(reads(path => path === '/conversations/a/sources')).toBe(1));
  const details = reads(path => /^\/conversations\/[ab](\?|$)/.test(path));
  const histories = reads(path => path.startsWith('/conversations?'));
  status = 'ready';
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 40, type: 'source-progress', conversation_id: 'a',
    payload: { runId: 'run-1', source: 'risk-ranges', status: 'ready' } }) }));
  await waitFor(() => expect(screen.getByText('Risk Ranges').closest('li')).toHaveTextContent('Ready'));
  expect(reads(path => path === '/conversations/a/sources')).toBe(2);
  act(() => stream.onmessage({ data: JSON.stringify({ seq: 41, type: 'source-progress', conversation_id: 'b',
    payload: { runId: 'run-2', source: 'risk-ranges', status: 'ready' } }) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
  expect(reads(path => path === '/conversations/b/sources')).toBe(0);
  expect(reads(path => /^\/conversations\/[ab](\?|$)/.test(path))).toBe(details);
  expect(reads(path => path.startsWith('/conversations?'))).toBe(histories);
});

test('review Sources keep reading by conversation ID when the conversation record cannot be read', async () => {
  conversations.a = { ...conversations.a, kind: 'portfolio-review' };
  localStorage.setItem('analyst.workspace.selected', JSON.stringify('a'));
  localStorage.setItem('analyst.workspace.sidebar', JSON.stringify([conversations.a]));
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path.startsWith('/conversations/a?') || path === '/conversations/a'
    ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503', status: 503 }))
    : request(path, body, method));
  render(<AnalystPanel />);
  const sources = screen.getByRole('region', { name: 'Review sources' });
  await waitFor(() => expect(within(sources).getByText('IB Gateway').closest('li')).toHaveTextContent('Ready'));
  expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeVisible();
  expect(sources).toHaveAttribute('aria-busy', 'false');
});

test('a model phase after settled Sources stays in the Sources header for Balance reviews', async () => {
  conversations.a = { ...conversations.a, kind: 'balance-review', revision: 1, reviewPhase: 'summarizing',
    activeTurn: { id: 'narrative-turn', state: 'running', request_id: 'daily-narrative:run-1' },
    messages: [{ id: 'report', role: 'assistant', state: 'complete', text: 'Captured balance report', reviewRunId: 'run-1' }] };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/conversations/a/sources'
    ? Promise.resolve({ conversationId: 'a', runId: 'run-1', basis: 'review', state: 'succeeded', items: [
      { id: 'interestStatus', label: 'Interest accruals', status: 'ready', observedAt: '2026-10-09T15:00:00Z' }] })
    : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText('Captured balance report');
  await waitFor(() => expect(screen.getByRole('region', { name: 'Review sources' })).toHaveTextContent('Interest accruals'));
  const header = () => screen.getByRole('region', { name: 'Review sources' }).querySelector('header');
  expect(within(header()).getByRole('status', { name: 'Response running' })).toHaveTextContent('Summarizing…');
  expect(screen.getAllByRole('status', { name: 'Response running' })).toHaveLength(1);
});

describe('review starts across a reload', () => {
  const requestId = 'review-start:restored-request';
  const kind = 'prediction-markets-review';
  const persist = (startedAt = new Date(Date.now() - 20_000).toISOString()) => localStorage.setItem('analyst.workspace.launches',
    JSON.stringify([{ kind, requestId, tradingDate: pacificToday(), launchKey: `${kind}:`, startedAt }]));

  test('restores the selected Starting slot and reconciles the exact request from live history', async () => {
    persist();
    localStorage.setItem('analyst.workspace.selected', JSON.stringify(`pending-review:${requestId}`));
    render(<AnalystPanel />);
    expect(within(expectReviewProgress()).getByRole('status', { name: 'Response running' })).toHaveTextContent('Starting…');
    const row = historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' });
    expect(row).toHaveTextContent('Starting…');
    await waitFor(() => expect(api.request.mock.calls.some(([path]) => path.startsWith('/conversations?'))).toBe(true));
    // Within its start budget, a history snapshot without the request keeps the slot.
    expect(screen.getByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveTextContent('Starting…');
    // The Starting slot reopens the restored start.
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
    conversations.review = { ...make('review', 'Restored captured Predictive review'), title: 'Predictive Markets Review', kind,
      trading_date: pacificToday(), reviewRequestId: requestId };
    act(() => stream.onmessage({ data: JSON.stringify({ seq: 3, conversation_id: 'review' }) }));
    await screen.findByText('Restored captured Predictive review');
    expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('review');
    expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
    expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
    // Request lookups resolve turn IDs only; they cannot confirm a review start.
    expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/') || path === '/messages' || path.startsWith('/requests/'))).toBe(false);
  });

  test('a second click resends the restored request ID instead of starting another review', async () => {
    persist();
    const pending = deferred();
    const request = api.request.getMockImplementation();
    api.request.mockImplementation((path, body, method) => path === `/daily/${kind}` ? pending.promise : request(path, body, method));
    render(<AnalystPanel />);
    expect(historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveTextContent('Starting…');
    fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
    expect(api.request).toHaveBeenCalledWith(`/daily/${kind}`, { requestId });
    conversations.review = { ...make('review', 'Accepted once'), title: 'Predictive Markets Review', kind, reviewRequestId: requestId };
    await act(async () => pending.resolve({ conversation: conversations.review }));
    await screen.findByText('Accepted once');
    expect(api.request.mock.calls.filter(([path]) => path === `/daily/${kind}`)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
    expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
  });

  test('history after the start budget without the exact request clears the slot and restores today\'s saved row', async () => {
    persist(new Date(Date.now() - 2 * 60_000).toISOString());
    localStorage.setItem('analyst.workspace.selected', JSON.stringify(`pending-review:${requestId}`));
    // A completed review for today, from an earlier request, owns the same history slot.
    conversations.review = { ...make('review', 'Earlier Predictive review'), title: 'Predictive Markets Review', kind,
      trading_date: pacificToday(), state: 'complete', reviewRequestId: 'review-start:earlier-request' };
    render(<AnalystPanel />);
    expect(within(expectReviewProgress()).getByRole('status', { name: 'Response running' })).toHaveTextContent('Starting…');
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t confirm the review start. Start it again.');
    expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
    const rows = screen.getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveTextContent('Starting…');
    expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
    expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBeNull();
    expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/') || path.startsWith('/requests/'))).toBe(false);
  });

  test('a restored start within its budget is settled by history read after the budget and opens today\'s running review', async () => {
    jest.useFakeTimers();
    try {
      persist();
      localStorage.setItem('analyst.workspace.selected', JSON.stringify(`pending-review:${requestId}`));
      // Another request's review of the same kind is already running today.
      conversations.review = { ...make('review', 'Running Predictive review'), title: 'Predictive Markets Review', kind,
        trading_date: pacificToday(), state: 'running', reviewRequestId: 'review-start:other-request' };
      render(<AnalystPanel />);
      await act(async () => jest.advanceTimersByTimeAsync(1000));
      const starting = () => within(expectReviewProgress()).getByRole('status', { name: 'Response running' });
      expect(starting()).toHaveTextContent('Starting…');
      const lists = () => api.request.mock.calls.filter(([path]) => path.startsWith('/conversations?')).length;
      const before = lists();
      await act(async () => jest.advanceTimersByTimeAsync(38_000));
      expect(lists()).toBe(before);
      expect(starting()).toHaveTextContent('Starting…');
      await act(async () => jest.advanceTimersByTimeAsync(2000));
      expect(lists()).toBe(before + 1);
      expect(JSON.parse(localStorage.getItem('analyst.workspace.selected'))).toBe('review');
      await expectSelected('Predictive Markets Review');
      expect(historyRows().getByRole('button', { name: 'Open conversation: Predictive Markets Review' })).not.toHaveTextContent('Starting…');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
      expect(api.request.mock.calls.some(([path]) => path.startsWith('/daily/'))).toBe(false);
    } finally { jest.useRealTimers(); }
  });

  test('an unconfirmed restored start expires after ten minutes while history is unavailable and an older one is never restored', async () => {
    jest.useFakeTimers();
    try {
      persist(new Date(Date.now() - 9 * 60_000).toISOString());
      localStorage.setItem('analyst.workspace.selected', JSON.stringify(`pending-review:${requestId}`));
      const request = api.request.getMockImplementation();
      api.request.mockImplementation((path, body, method) => path.startsWith('/conversations?')
        ? Promise.reject(Object.assign(new Error('API warming up.'), { code: 'HTTP_503', status: 503 })) : request(path, body, method));
      const view = render(<AnalystPanel />);
      await act(async () => jest.advanceTimersByTimeAsync(0));
      expect(within(expectReviewProgress()).getByRole('status', { name: 'Response running' })).toHaveTextContent('Starting…');
      await act(async () => jest.advanceTimersByTimeAsync(61_000));
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t confirm the review start. Start it again.');
      expect(historyRows().queryByRole('button', { name: 'Open conversation: Predictive Markets Review' })).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem('analyst.workspace.launches'))).toEqual([]);
      view.unmount();
      persist(new Date(Date.now() - 11 * 60_000).toISOString());
      localStorage.setItem('analyst.workspace.selected', JSON.stringify(`pending-review:${requestId}`));
      render(<AnalystPanel />);
      expect(historyRows().queryByRole('button', { name: 'Open conversation: Predictive Markets Review' })).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Start a review' })).toBeVisible();
    } finally { jest.useRealTimers(); }
  });
});

test('a Predictive review refreshes in place from the bar above Sources, dated by the report it shows', async () => {
  const saved = { ...make('today', 'Saved Predictive report'), title: 'Predictive Markets Review', kind: 'prediction-markets-review',
    trading_date: pacificToday(), created_at: '2026-10-28T16:40:00Z',
    messages: [{ id: 'report', role: 'assistant', state: 'complete', text: 'Saved Predictive report', reviewPostId: 'base',
      reviewRunId: 'run-1', created_at: '2026-10-28T16:46:00Z' }] };
  conversations = { today: saved };
  const request = api.request.getMockImplementation();
  api.request.mockImplementation((path, body, method) => path === '/daily/prediction-markets-review'
    ? Promise.resolve({ conversation: { ...saved, activeTurn: { id: 'refresh-turn', state: 'running' } } }) : request(path, body, method));
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Predictive Markets Review' }));
  const refresh = await screen.findByRole('button', { name: 'Refresh Predictive Markets Review' });
  const time = refresh.parentElement.querySelector('time');
  expect(time).toHaveAttribute('dateTime', '2026-10-28T16:46:00Z');
  expect(time).toHaveTextContent(/Oct 28.* 09:46 PDT/);
  // The bar sits right above Sources.
  expect(refresh.parentElement.nextElementSibling).toBe(screen.getByRole('region', { name: 'Review sources' }));
  // The boards run edge to edge with the composer.
  expect(screen.getByRole('log', { name: 'Conversation' })).toHaveClass('is-composer-width');
  fireEvent.click(refresh);
  await waitFor(() => expect(api.request).toHaveBeenCalledWith('/daily/prediction-markets-review',
    expect.objectContaining({ refresh: true, conversationId: 'today' })));
  // A running refresh cannot be started twice.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Predictive Markets Review' })).toBeDisabled());
  home();
  expect(historyRows().getAllByRole('button', { name: 'Open conversation: Predictive Markets Review' })).toHaveLength(1);
});

test('ordinary chats have no review Refresh bar', async () => {
  render(<AnalystPanel />);
  fireEvent.click(await historyRows().findByRole('button', { name: 'Open conversation: Chat a' }));
  await screen.findByText('Only answer A');
  expect(screen.queryByRole('button', { name: /^Refresh / })).toBeNull();
  expect(screen.getByRole('log', { name: 'Conversation' })).not.toHaveClass('is-composer-width');
});

test('history days read newest first even when an older row arrives first', async () => {
  conversations = {
    older: { ...make('older', 'Older answer'), created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    newer: { ...make('newer', 'Newer answer'), created_at: new Date().toISOString() },
  };
  render(<AnalystPanel />);
  await historyRows().findByRole('button', { name: 'Open conversation: Chat newer' });
  const headings = [...document.querySelectorAll('.analyst-conversation-item')].map(item => item.closest('section').querySelector('h2, h3')?.textContent);
  expect(headings[0]).toBe('Today');
  expect(screen.getAllByRole('button', { name: /^Open conversation: Chat (?:older|newer)$/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['Open conversation: Chat newer', 'Open conversation: Chat older']);
});
