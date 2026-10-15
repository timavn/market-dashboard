import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import ReactMarkdown from 'react-markdown';
import {
  emphasizeHedgeyeViewLevels,
  normalizeAnalystPositionTables,
  omitRedundantPositionSections,
  splitAnalystFactText,
} from './AnalystPanel';
import AnalystPanel from './AnalystConversationPanel';
import AnalystSurfaceBoundary from './AnalystSurfaceBoundary';
import AnalystLoading from './AnalystLoading';
import PersistentSurface from '../common/PersistentSurface';
import { analystApi } from '../../services/analyst/analystClient';

jest.mock('remark-gfm', () => function remarkGfmMock() {});
jest.mock('react-markdown', () => {
  function MarkdownMock({ children }) {
    MarkdownMock.renderSpy(children);
    return <div>{String(children || '')}</div>;
  }
  MarkdownMock.renderSpy = jest.fn();
  return MarkdownMock;
});

jest.mock('../../services/analyst/analystClient', () => ({
  analystApi: {
    status: jest.fn(),
    reviewConversations: jest.fn(),
    createReviewConversation: jest.fn(),
    reviewConversation: jest.fn(),
    reviewStatus: jest.fn(),
    retryReviewConversation: jest.fn(),
    catalog: jest.fn(),
    imports: jest.fn(),
    post: jest.fn(),
  },
  analystWebSocketUrl: () => 'ws://localhost/ws/analyst',
  stageAnalystPdf: jest.fn(),
  validateAnalystPdf: jest.fn(),
}));

class FakeWebSocket {
  static OPEN = 1;

  static CLOSED = 3;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const REVIEW_ACTIONS = [
  ['portfolio-review', 'Portfolio Review', '11111111-1111-4111-8111-111111111111'],
  ['prediction-markets-review', 'Predictive Markets Review', '22222222-2222-4222-8222-222222222222'],
];
// Balance Review is retired: saved Balance chats still list, but it cannot launch.
const SAVED_REVIEWS = [...REVIEW_ACTIONS, ['balance-review', 'Balance Review', '33333333-3333-4333-8333-333333333333']];

const latestSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const nowIso = () => new Date().toISOString();

function readyStatus({ transport = true } = {}) {
  return {
    status: transport ? 'available' : 'degraded',
    contractVerified: true,
    readiness: {
      sessionTransport: {
        ready: transport,
        reason: transport ? null : 'Hermes session transport unavailable',
      },
      reviewCoordinator: { ready: true, reason: null },
      portfolioReview: { ready: true, reason: null },
      predictionMarketsReview: { ready: true, reason: null },
      balanceReview: { ready: true, reason: null },
    },
    sidecar: { ok: true },
  };
}

function reviewSummary(reviewKind, overrides = {}) {
  const [, title, fallbackId] = SAVED_REVIEWS.find(([kind]) => kind === reviewKind);
  const conversationId = overrides.conversationId || fallbackId;
  const state = overrides.state || 'running';
  const latestRunId = overrides.latestRunId || `run:${conversationId}`;
  const active = ['queued', 'running', 'starting'].includes(state);
  return {
    schemaVersion: 1,
    type: 'review',
    conversationId,
    reviewKind,
    title,
    createdAt: overrides.createdAt || nowIso(),
    updatedAt: overrides.updatedAt || overrides.createdAt || nowIso(),
    state,
    phase: active ? 'acquiring' : 'terminal',
    outcome: overrides.outcome ?? (state === 'succeeded' ? 'ready' : null),
    activeRunId: active ? latestRunId : null,
    latestRunId,
    retryable: overrides.retryable === true,
    error: overrides.error || null,
    hermesSessionId: overrides.hermesSessionId || null,
  };
}

function reviewDetail(summary, overrides = {}) {
  const failed = ['failed', 'cancelled'].includes(summary.state);
  const terminal = !['queued', 'running', 'starting'].includes(summary.state);
  const messages = overrides.messages || [
    {
      id: `${summary.latestRunId}:user`,
      role: 'user',
      text: `Run ${summary.title}`,
      runId: summary.latestRunId,
    },
    ...(summary.state === 'succeeded' ? [{
      id: `${summary.latestRunId}:assistant`,
      role: 'assistant',
      text: overrides.report || `# ${summary.title}\n\nVerified live report.`,
      citations: overrides.citations || [],
      runId: summary.latestRunId,
    }] : []),
    ...(failed ? [{
      id: `${summary.latestRunId}:assistant`,
      role: 'assistant',
      text: summary.error?.message || 'The review could not finish.',
      error: summary.error,
      runId: summary.latestRunId,
    }] : []),
  ];
  return {
    ...summary,
    messages,
    runCount: 1,
    latestRun: {
      runId: summary.latestRunId,
      conversationId: summary.conversationId,
      reviewKind: summary.reviewKind,
      state: summary.state,
      phase: summary.phase,
      outcome: summary.outcome,
      active: !terminal,
      retryable: summary.retryable,
      error: summary.error,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
  };
}

let reviewDetails;

async function mountConnected(ui = <AnalystPanel onClose={jest.fn()} />) {
  render(ui);
  await waitFor(() => expect(analystApi.status).toHaveBeenCalled());
  const socket = latestSocket();
  act(() => socket.open());
  act(() => socket.emit({ type: 'connection', status: 'connected' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeEnabled());
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket;
  reviewDetails = new Map();
  analystApi.status.mockResolvedValue(readyStatus());
  analystApi.reviewConversations.mockResolvedValue({ conversations: [], nextCursor: null });
  analystApi.reviewConversation.mockImplementation(async (conversationId) => ({
    conversation: reviewDetails.get(conversationId),
  }));
  analystApi.createReviewConversation.mockImplementation(async (reviewKind, { requestId }) => {
    const summary = reviewSummary(reviewKind);
    reviewDetails.set(summary.conversationId, reviewDetail(summary));
    return {
      ok: true,
      created: true,
      reusedActive: false,
      conversation: summary,
      run: { runId: summary.latestRunId, requestId, state: summary.state, active: true },
    };
  });
  analystApi.reviewStatus.mockImplementation(async (runId) => ({
    run: {
      runId,
      state: 'running',
      phase: 'acquiring',
      outcome: null,
      active: true,
      retryable: false,
      error: null,
      updatedAt: nowIso(),
    },
  }));
  analystApi.retryReviewConversation.mockImplementation(async (conversationId) => {
    const prior = reviewDetails.get(conversationId);
    const summary = reviewSummary(prior.reviewKind, {
      conversationId,
      latestRunId: `${prior.latestRunId}:retry`,
      createdAt: prior.createdAt,
    });
    reviewDetails.set(conversationId, reviewDetail(summary));
    return { ok: true, conversation: summary, run: summary.latestRun };
  });
  analystApi.catalog.mockResolvedValue({ products: [] });
  analystApi.imports.mockResolvedValue({ imports: [] });
  analystApi.post.mockResolvedValue({ ok: true });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('keeps Analyst Markdown normalization helpers intact', () => {
  const markdown = [
    '## Hedgeye View',
    'SPX resistance near 7,800 and support near 7,600.',
    '',
    '### Long equity and ETF positions',
    '| Symbol | Quantity |',
    '| --- | ---: |',
    '| AMZN | 15 |',
    '',
    '## Coverage & Data Quality',
    'Keep this section.',
  ].join('\n');
  expect(emphasizeHedgeyeViewLevels(markdown)).toContain('resistance near **7,800**');
  expect(omitRedundantPositionSections(markdown)).not.toContain('| AMZN |');
  expect(splitAnalystFactText('On August 24, 2026, SPX gained +2.6%.')
    .filter((node) => node.type === 'strong')
    // eslint-disable-next-line testing-library/no-node-access -- Markdown AST nodes, not DOM nodes.
    .map((node) => node.children[0].value)).toEqual(['August 24, 2026', 'SPX', '+2.6%']);
  expect(normalizeAnalystPositionTables('| Contract | Value |\n| --- | --- |\n| SPX | 12 |'))
    .toContain('| SPX | 12 |');
});

test('contains a rejected Analyst lazy chunk without blanking the dashboard', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  const BrokenAnalystChunk = React.lazy(() => Promise.reject(new Error('chunk unavailable')));
  render(
    <>
      <div>Main dashboard remains mounted</div>
      <AnalystSurfaceBoundary>
        <React.Suspense fallback={<AnalystLoading />}>
          <BrokenAnalystChunk />
        </React.Suspense>
      </AnalystSurfaceBoundary>
    </>,
  );
  expect(screen.getByRole('status', { name: 'Loading' })).toHaveTextContent(/^$/);
  expect(await screen.findByRole('alert', { name: 'The Analyst unavailable' })).toBeInTheDocument();
  expect(screen.getByText('Main dashboard remains mounted')).toBeInTheDocument();
  consoleError.mockRestore();
});

test('renders the blank landing immediately and never auto-selects loaded history', async () => {
  let releaseHistory;
  analystApi.reviewConversations.mockReturnValueOnce(new Promise((resolve) => {
    releaseHistory = resolve;
  }));
  render(<AnalystPanel onClose={jest.fn()} />);

  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();
  const actions = within(screen.getByRole('group', { name: 'Start a review' }));
  expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual(
    REVIEW_ACTIONS.map(([, title]) => title),
  );
  expect(screen.queryByText('Quick Reviews')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Review attempt' })).not.toBeInTheDocument();

  const historical = reviewSummary('portfolio-review', {
    state: 'succeeded',
    createdAt: '2026-08-31T16:00:00.000Z',
  });
  await act(async () => releaseHistory({ conversations: [historical], nextCursor: null }));
  expect(await screen.findByRole('button', { name: 'Open conversation: Portfolio Review' }))
    .not.toHaveAttribute('aria-current');
  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();

  const socket = latestSocket();
  act(() => socket.open());
  act(() => socket.emit({ type: 'connection', status: 'connected' }));
  expect(socket.sent.filter((frame) => frame.action === 'list_sessions')).toHaveLength(1);
  expect(socket.sent.some((frame) => ['open', 'new_chat', 'session.create'].includes(frame.action))).toBe(false);
});

test('does not expose raw transport abort text when a background history request times out', async () => {
  const timeout = new Error('signal is aborted without reason');
  timeout.code = 'ANALYST_REQUEST_TIMEOUT';
  analystApi.reviewConversations.mockRejectedValueOnce(timeout);
  render(<AnalystPanel onClose={jest.fn()} />);
  await waitFor(() => expect(analystApi.reviewConversations).toHaveBeenCalled());
  expect(screen.queryByText(/signal is aborted/i)).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();
});

test('ignores a stale filtered history response after a newer unfiltered request', async () => {
  const portfolio = reviewSummary('portfolio-review', { state: 'succeeded' });
  const balance = reviewSummary('balance-review', { state: 'succeeded' });
  let resolveFiltered;
  let unfilteredCalls = 0;
  analystApi.reviewConversations.mockImplementation(({ query }) => {
    if (query === 'Portfolio') {
      return new Promise((resolve) => { resolveFiltered = resolve; });
    }
    unfilteredCalls += 1;
    return Promise.resolve(unfilteredCalls === 1
      ? { conversations: [], nextCursor: null }
      : { conversations: [balance, portfolio], nextCursor: 'full-history-cursor' });
  });

  await mountConnected();
  await waitFor(() => expect(unfilteredCalls).toBeGreaterThanOrEqual(1));
  const search = screen.getByRole('searchbox', { name: 'Search conversations' });
  fireEvent.change(search, { target: { value: 'Portfolio' } });
  await waitFor(() => expect(resolveFiltered).toEqual(expect.any(Function)));
  fireEvent.change(search, { target: { value: '' } });
  expect(await screen.findByRole('button', { name: 'Open conversation: Balance Review' })).toBeInTheDocument();

  await act(async () => resolveFiltered({ conversations: [portfolio], nextCursor: null }));
  expect(screen.getByRole('button', { name: 'Open conversation: Balance Review' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open conversation: Portfolio Review' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load older' })).toBeInTheDocument();
});

test('New Chat returns to landing without creating a row; first prompt creates one deterministic Today row', async () => {
  const socket = await mountConnected();
  const initialFrameCount = socket.sent.length;
  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  expect(screen.getByText('New conversations appear here.')).toBeInTheDocument();
  expect(socket.sent).toHaveLength(initialFrameCount);

  const composer = screen.getByRole('textbox', { name: 'Message The Analyst' });
  fireEvent.change(composer, {
    target: { value: '   Explain duration risk in this portfolio' },
  });
  fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });

  const request = socket.sent.find((frame) => frame.action === 'new_prompt');
  expect(request).toEqual(expect.objectContaining({
    text: 'Explain duration risk in this portfolio',
    requestId: expect.any(String),
  }));
  expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  expect(screen.getByRole('button', {
    name: 'Open conversation: Explain duration risk in this portfolio',
  })).toHaveAttribute('aria-current', 'true');
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();

  act(() => socket.emit({
    type: 'session',
    requestId: request.requestId,
    sessionId: 'runtime-general-one',
    storedSessionId: 'general-one',
    title: 'Explain duration risk in this portfolio',
    messages: [{ role: 'user', content: request.text }],
    running: true,
  }));
  expect(screen.getByRole('button', {
    name: 'Open conversation: Explain duration risk in this portfolio',
  })).toHaveAttribute('aria-current', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  expect(screen.getByRole('group', { name: 'Start a review' })).toBeInTheDocument();
  expect(socket.sent).toHaveLength(initialFrameCount + 1);
});

test('pages ordinary Hermes history and groups epoch started_at by immutable local creation date', async () => {
  const socket = await mountConnected();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  act(() => socket.emit({
    type: 'session_list',
    sessions: [{
      id: 'general-yesterday',
      title: 'Yesterday research',
      started_at: Math.floor(yesterday.getTime() / 1_000),
      last_active: Date.now() / 1_000,
    }],
    offset: 0,
    nextOffset: 50,
    total: 51,
  }));

  expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
  expect(socket.sent).toContainEqual(expect.objectContaining({
    action: 'list_sessions',
    limit: 50,
    offset: 50,
    requestId: expect.any(String),
  }));

  act(() => socket.emit({
    type: 'session_list',
    sessions: [{
      id: 'general-older',
      title: 'Older research',
      started_at: Math.floor((yesterday.getTime() - 86_400_000) / 1_000),
    }],
    append: true,
    offset: 50,
    nextOffset: null,
    total: 51,
  }));
  expect(screen.getByRole('button', { name: 'Open conversation: Yesterday research' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open conversation: Older research' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
});

test.each(REVIEW_ACTIONS)('%s creates exactly one normal dated conversation', async (reviewKind, title, conversationId) => {
  const socket = await mountConnected();
  fireEvent.click(screen.getByRole('button', { name: title, exact: true }));

  await waitFor(() => expect(analystApi.createReviewConversation).toHaveBeenCalledWith(
    reviewKind,
    expect.objectContaining({ requestId: expect.any(String) }),
  ));
  expect(await screen.findByRole('button', { name: `Open conversation: ${title}` }))
    .toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  expect(screen.getAllByRole('status', { name: `${title} is running` })).toHaveLength(1);
  expect(screen.getByText(`Run ${title}`)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Start a review' })).not.toBeInTheDocument();
  expect(socket.sent.some((frame) => ['gm', 'start_review', 'open_review_chat'].includes(frame.action))).toBe(false);
  expect(reviewDetails.has(conversationId)).toBe(true);
});

test('same-kind active clicks reopen one row while different review kinds run concurrently', async () => {
  await mountConnected();
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  await screen.findByRole('button', { name: 'Open conversation: Portfolio Review' });
  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  expect(analystApi.createReviewConversation).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('button', { name: 'Open conversation: Portfolio Review' })).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'Predictive Markets Review', exact: true }));
  await waitFor(() => expect(analystApi.createReviewConversation).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Open conversation: Portfolio Review' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open conversation: Predictive Markets Review' }))
    .toHaveAttribute('aria-current', 'true');
});

test('a late launch response updates its owning row without stealing navigation', async () => {
  let resolveLaunch;
  analystApi.createReviewConversation.mockReturnValueOnce(new Promise((resolve) => {
    resolveLaunch = resolve;
  }));
  const summary = reviewSummary('portfolio-review');
  reviewDetails.set(summary.conversationId, reviewDetail(summary));
  await mountConnected();

  fireEvent.click(screen.getByRole('button', { name: 'Portfolio Review', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();

  await act(async () => resolveLaunch({
    created: true,
    conversation: summary,
    run: { runId: summary.latestRunId, state: 'running', active: true },
  }));
  expect(await screen.findByRole('button', { name: 'Open conversation: Portfolio Review' }))
    .not.toHaveAttribute('aria-current');
  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();
});

test('creation timestamps determine stable sidebar order even when older conversations update', async () => {
  const older = reviewSummary('portfolio-review', {
    state: 'succeeded',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
  });
  const newer = reviewSummary('balance-review', {
    state: 'succeeded',
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:00:00.000Z',
  });
  analystApi.reviewConversations.mockResolvedValue({ conversations: [newer, older], nextCursor: null });
  const socket = await mountConnected();
  await screen.findByRole('button', { name: 'Open conversation: Portfolio Review' });
  act(() => socket.emit({
    type: 'session_list',
    sessions: [{
      id: 'general-old',
      title: 'Older ordinary chat',
      created_at: '2026-08-31T12:00:00.000Z',
      updated_at: '2026-09-02T23:59:59.000Z',
      message_count: 8,
    }],
  }));

  const rail = screen.getByTestId('analyst-conversation-rail');
  const labels = within(rail).getAllByRole('button', { name: /^Open conversation:/ })
    .map((button) => button.getAttribute('aria-label'));
  expect(labels).toEqual([
    'Open conversation: Balance Review',
    'Open conversation: Portfolio Review',
    'Open conversation: Older ordinary chat',
  ]);
  expect(screen.getByRole('heading', { name: 'The Analyst' })).toBeInTheDocument();
});

test('legacy retry stays in the failed conversation and no conversation has an archive control', async () => {
  const failed = reviewSummary('balance-review', {
    state: 'failed',
    retryable: true,
    error: { code: 'REVIEW_PROCESS_RESTARTED', message: 'Review interrupted.', retryable: true },
    createdAt: '2026-09-02T09:00:00.000Z',
  });
  reviewDetails.set(failed.conversationId, reviewDetail(failed));
  analystApi.reviewConversations.mockResolvedValue({ conversations: [failed], nextCursor: null });
  await mountConnected();

  fireEvent.click(await screen.findByRole('button', { name: 'Open conversation: Balance Review' }));
  const retry = await screen.findByRole('button', { name: 'Retry with fresh data' });
  expect(screen.getAllByText('Review interrupted.')).toHaveLength(1);
  fireEvent.click(retry);
  await waitFor(() => expect(analystApi.retryReviewConversation).toHaveBeenCalledWith(
    failed.conversationId,
    expect.objectContaining({
      previousRunId: failed.latestRunId,
      requestId: expect.any(String),
    }),
  ));
  expect(screen.getAllByRole('button', { name: 'Open conversation: Balance Review' })).toHaveLength(1);

  const terminal = reviewSummary('portfolio-review', {
    state: 'succeeded',
    createdAt: '2026-09-01T09:00:00.000Z',
  });
  analystApi.reviewConversations.mockResolvedValue({ conversations: [terminal], nextCursor: null });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), {
    target: { value: 'Portfolio' },
  });
  expect(await screen.findByRole('button', { name: 'Open conversation: Portfolio Review' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Archive conversation/ })).not.toBeInTheDocument();
});

test('stream buffers are conversation-scoped and Markdown parses only at terminal completion', async () => {
  ReactMarkdown.renderSpy.mockClear();
  const socket = await mountConnected();
  act(() => socket.emit({
    type: 'session_list',
    sessions: [
      { id: 'general-a', title: 'Conversation A', created_at: '2026-09-02T10:00:00Z' },
      { id: 'general-b', title: 'Conversation B', created_at: '2026-09-02T11:00:00Z' },
    ],
  }));

  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Conversation A' }));
  const resumeA = socket.sent.find((frame) => frame.action === 'resume' && frame.sessionId === 'general-a');
  act(() => socket.emit({
    type: 'session',
    requestId: resumeA.requestId,
    sessionId: 'runtime-a',
    storedSessionId: 'general-a',
    title: 'Conversation A',
    messages: [],
    running: false,
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Conversation B' }));
  const resumeB = socket.sent.find((frame) => frame.action === 'resume' && frame.sessionId === 'general-b');
  act(() => socket.emit({
    type: 'session',
    requestId: resumeB.requestId,
    sessionId: 'runtime-b',
    storedSessionId: 'general-b',
    title: 'Conversation B',
    messages: [],
    running: false,
  }));

  act(() => socket.emit({ type: 'message_delta', storedSessionId: 'general-a', text: '**private A tail**' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
  expect(screen.queryByText('**private A tail**')).not.toBeInTheDocument();
  expect(ReactMarkdown.renderSpy).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Conversation A' }));
  expect(screen.getByText('**private A tail**')).toBeInTheDocument();
  expect(ReactMarkdown.renderSpy).not.toHaveBeenCalled();
  act(() => socket.emit({
    type: 'message_complete',
    storedSessionId: 'general-a',
    text: '**Terminal A answer**',
    citations: [],
  }));
  expect(screen.getByText('**Terminal A answer**')).toBeInTheDocument();
  expect(ReactMarkdown.renderSpy).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status', { name: 'Conversation A is running' })).not.toBeInTheDocument();
});

test('Hermes interruption clears one loader, reports once, and reconnects without a dashboard reload', async () => {
  jest.spyOn(Math, 'random').mockReturnValue(0);
  const socket = await mountConnected();
  act(() => socket.emit({
    type: 'session_list',
    sessions: [{ id: 'general-restart', title: 'Restart test', created_at: nowIso() }],
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Restart test' }));
  const resume = socket.sent.find((frame) => frame.action === 'resume');
  act(() => socket.emit({
    type: 'session',
    requestId: resume.requestId,
    sessionId: 'runtime-restart',
    storedSessionId: 'general-restart',
    title: 'Restart test',
    messages: [],
    running: true,
  }));
  expect(screen.getByRole('status', { name: 'Restart test is running' })).toBeInTheDocument();

  act(() => socket.emit({ type: 'connection', status: 'disconnected' }));
  expect(await screen.findByText(/response was interrupted while Hermes restarted/i)).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Restart test is running' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeDisabled();

  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  const reconnected = latestSocket();
  act(() => reconnected.open());
  act(() => reconnected.emit({ type: 'connection', status: 'connected' }));
  expect(reconnected.sent).toContainEqual(expect.objectContaining({
    action: 'resume',
    sessionId: 'general-restart',
  }));
  expect(screen.getByRole('textbox', { name: 'Message The Analyst' })).toBeEnabled();
  expect(screen.getAllByText(/response was interrupted while Hermes restarted/i)).toHaveLength(1);
});

test('a hidden retained Analyst closes Hermes and pauses review polling without a false interruption', async () => {
  const activeReview = reviewSummary('portfolio-review');
  reviewDetails.set(activeReview.conversationId, reviewDetail(activeReview));
  analystApi.reviewConversations.mockResolvedValue({ conversations: [activeReview], nextCursor: null });
  jest.useFakeTimers();

  const { rerender } = render(
    <PersistentSurface active eager>
      <AnalystPanel onClose={jest.fn()} />
    </PersistentSurface>,
  );
  await act(async () => {
    jest.advanceTimersByTime(250);
    await Promise.resolve();
    await Promise.resolve();
  });
  const socket = latestSocket();
  act(() => socket.open());
  act(() => socket.emit({ type: 'connection', status: 'connected' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Portfolio Review' }));

  rerender(
    <PersistentSurface active={false} eager>
      <AnalystPanel onClose={jest.fn()} />
    </PersistentSurface>,
  );
  expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  await act(async () => {
    jest.advanceTimersByTime(6_000);
    await Promise.resolve();
  });
  expect(analystApi.reviewStatus).not.toHaveBeenCalled();
  expect(FakeWebSocket.instances).toHaveLength(1);

  rerender(
    <PersistentSurface active eager>
      <AnalystPanel onClose={jest.fn()} />
    </PersistentSurface>,
  );
  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(screen.queryByText(/response was interrupted while Hermes restarted/i)).not.toBeInTheDocument();
});
