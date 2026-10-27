import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  FileText,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import {
  analystApi,
  analystWebSocketUrl,
} from '../../services/analyst/analystClient';
import { prepareAnalystMarkdown } from './analystMarkdown';
import { presentPredictionMarkdown } from './analystPredictionMarkdown';
import { remarkAnalystProcessColors } from './analystProcessColors';
import { remarkAnalystAccountComparison } from './analystAccountComparison';
import './AnalystReportText.css';
import './AnalystPanel.css';
import './AnalystAccountComparison.css';
import AnalystPortfolioBrief from './AnalystPortfolioBrief';
import AnalystPredictionReport from './AnalystPredictionReport';
import SourceLibrary from './AnalystSourceLibrary';
import AnalystSemanticText from './AnalystSemanticText';
import { formatAnalystReportDate } from '../../utils/analystReportDates';
import AnalystReportLink from './AnalystReportLink';

const STREAM_COMMIT_INTERVAL_MS = 150;
const REVIEW_POLL_INTERVAL_MS = 1_000;
const REVIEW_POLL_MAX_BACKOFF_MS = 5_000;
const HISTORY_LOAD_ERROR = 'Conversation history is temporarily unavailable.';
const REVIEW_ACTIONS = [
  { id: 'portfolio-review', label: 'Portfolio Review', message: 'Run Portfolio Review' },
  { id: 'prediction-markets-review', label: 'Predictive Markets Review', message: 'Run Predictive Markets Review' },
];
const ACTIVE_STATES = new Set(['queued', 'running', 'starting']);

const requestId = (prefix) => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
const entityId = (value) => value?.conversationId || value?.id || value?.storedSessionId || value?.session_id || null;

const normalizeTimestamp = (value, fallback = new Date().toISOString()) => {
  if (value == null || value === '') return fallback;
  let parsed;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    parsed = new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
  } else {
    parsed = new Date(value);
  }
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
};

const titleFromPrompt = (value) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').replace(/^[#>*_`\-\s]+/, '').trim();
  if (!normalized) return 'New conversation';
  const clipped = normalized.slice(0, 64).trim();
  return normalized.length > clipped.length ? `${clipped.replace(/[.,;:!?\s]+$/, '')}…` : clipped;
};

const messageText = (message) => {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || '').filter(Boolean).join('\n');
  }
  return '';
};

const normalizeMessages = (messages) => (Array.isArray(messages) ? messages : [])
  .filter((message) => ['user', 'assistant'].includes(message?.role) && messageText(message))
  .map((message, index) => ({
    id: message.id || `history:${index}:${message.role}`,
    role: message.role,
    text: messageText(message),
    citations: Array.isArray(message.citations) ? message.citations : [],
    streaming: false,
  }));

const normalizeReviewSummary = (conversation) => ({
  id: conversation.conversationId,
  conversationId: conversation.conversationId,
  type: 'review',
  reviewKind: conversation.reviewKind,
  title: conversation.title || REVIEW_ACTIONS.find((row) => row.id === conversation.reviewKind)?.label || 'Review',
  createdAt: normalizeTimestamp(conversation.createdAt),
  updatedAt: normalizeTimestamp(conversation.updatedAt || conversation.createdAt),
  state: conversation.state || 'ready',
  phase: conversation.phase || null,
  outcome: conversation.outcome || null,
  activeRunId: conversation.activeRunId || null,
  latestRunId: conversation.latestRunId || null,
  retryable: conversation.retryable === true,
  reviewError: conversation.error || null,
  hermesSessionId: conversation.hermesSessionId || null,
});

const normalizeGeneralSummary = (session) => {
  const id = entityId(session);
  const createdAt = session.started_at || session.startedAt || session.created_at || session.createdAt;
  return {
    id,
    conversationId: id,
    type: 'general',
    title: String(session.title || 'Conversation'),
    createdAt: normalizeTimestamp(createdAt),
    updatedAt: normalizeTimestamp(session.updated_at || session.updatedAt || session.last_active || session.lastActive || createdAt),
    state: session.running ? 'running' : 'ready',
    messageCount: Number(session.visibleMessageCount ?? session.message_count ?? session.messageCount) || 0,
    hermesSessionId: id,
    runtimeSessionId: session.sessionId || session.session_id || null,
    legacyReview: session.legacyReview === true,
  };
};

const initialConversationState = {
  entities: {},
  selectedId: null,
};

const mergeEntity = (current = {}, incoming = {}) => ({
  ...current,
  ...incoming,
  createdAt: current.createdAt || incoming.createdAt,
  messages: incoming.messages ?? current.messages,
  reviewMessages: incoming.reviewMessages ?? current.reviewMessages,
  chatMessages: incoming.chatMessages ?? current.chatMessages,
  runtimeSessionId: incoming.runtimeSessionId ?? current.runtimeSessionId,
});

const appendUniqueMessage = (messages, message) => {
  const rows = Array.isArray(messages) ? messages : [];
  if (message.id && rows.some((row) => row.id === message.id)) return rows;
  const last = rows[rows.length - 1];
  if (last && last.role === message.role && last.text === message.text && message.role === 'user') return rows;
  return [...rows, message];
};

function conversationReducer(state, action) {
  if (action.type === 'UPSERT_MANY') {
    const entities = { ...state.entities };
    action.entities.forEach((entity) => {
      if (!entity?.id) return;
      entities[entity.id] = mergeEntity(entities[entity.id], entity);
    });
    return { ...state, entities };
  }
  if (action.type === 'UPSERT') {
    return {
      ...state,
      entities: {
        ...state.entities,
        [action.entity.id]: mergeEntity(state.entities[action.entity.id], action.entity),
      },
    };
  }
  if (action.type === 'SELECT') return { ...state, selectedId: action.id || null };
  if (action.type === 'NEW_CHAT') return { ...state, selectedId: null };
  if (action.type === 'REPLACE_ID') {
    const prior = state.entities[action.from] || {};
    const existing = state.entities[action.to] || {};
    const entities = { ...state.entities };
    delete entities[action.from];
    entities[action.to] = mergeEntity(mergeEntity(prior, existing), { ...action.entity, id: action.to, conversationId: action.to });
    return {
      ...state,
      entities,
      selectedId: state.selectedId === action.from ? action.to : state.selectedId,
    };
  }
  if (action.type === 'REMOVE') {
    const entities = { ...state.entities };
    delete entities[action.id];
    return { ...state, entities, selectedId: state.selectedId === action.id ? null : state.selectedId };
  }
  if (action.type === 'REVIEW_DETAIL') {
    const detail = action.conversation;
    const id = detail.conversationId;
    const summary = normalizeReviewSummary(detail);
    const current = state.entities[id] || {};
    return {
      ...state,
      entities: {
        ...state.entities,
        [id]: mergeEntity(current, {
          ...summary,
          reviewMessages: normalizeMessages(detail.messages),
          detailLoaded: true,
          latestRun: detail.latestRun || null,
          activeRunId: detail.latestRun?.active ? detail.latestRun.runId : null,
          latestRunId: detail.latestRun?.runId || summary.latestRunId,
          state: detail.latestRun?.state || summary.state,
          retryable: detail.latestRun?.retryable === true,
          reviewError: detail.latestRun?.error || summary.reviewError,
        }),
      },
    };
  }
  if (action.type === 'SESSION') {
    const current = state.entities[action.id] || {};
    const isReview = current.type === 'review' || action.review;
    const patch = {
      id: action.id,
      conversationId: action.id,
      title: action.title || current.title || 'Conversation',
      type: isReview ? 'review' : 'general',
      hermesSessionId: action.hermesSessionId || current.hermesSessionId || action.id,
      runtimeSessionId: action.runtimeSessionId || null,
      streaming: action.running === true,
      opening: false,
      connectionError: null,
      ...(isReview
        ? { chatMessages: normalizeMessages(action.messages) }
        : { messages: normalizeMessages(action.messages), detailLoaded: true }),
    };
    return { ...state, entities: { ...state.entities, [action.id]: mergeEntity(current, patch) } };
  }
  if (action.type === 'APPEND_MESSAGE') {
    const current = state.entities[action.id];
    if (!current) return state;
    const key = current.type === 'review' ? 'chatMessages' : 'messages';
    return {
      ...state,
      entities: {
        ...state.entities,
        [action.id]: { ...current, [key]: appendUniqueMessage(current[key], action.message) },
      },
    };
  }
  if (action.type === 'APPEND_DELTA') {
    const current = state.entities[action.id];
    if (!current || !action.text) return state;
    const key = current.type === 'review' ? 'chatMessages' : 'messages';
    const rows = [...(current[key] || [])];
    const last = rows[rows.length - 1];
    if (last?.role === 'assistant' && last.streaming) {
      rows[rows.length - 1] = { ...last, text: `${last.text || ''}${action.text}` };
    } else {
      rows.push({ id: `stream:${action.id}:${Date.now()}`, role: 'assistant', text: action.text, citations: [], streaming: true });
    }
    return { ...state, entities: { ...state.entities, [action.id]: { ...current, [key]: rows, streaming: true } } };
  }
  if (action.type === 'COMPLETE_MESSAGE') {
    const current = state.entities[action.id];
    if (!current) return state;
    const key = current.type === 'review' ? 'chatMessages' : 'messages';
    const rows = [...(current[key] || [])];
    const last = rows[rows.length - 1];
    const completed = {
      id: action.message.id || last?.id || `assistant:${Date.now()}`,
      role: 'assistant',
      text: action.message.text || last?.text || '',
      citations: action.message.citations || [],
      streaming: false,
    };
    if (last?.role === 'assistant' && last.streaming) rows[rows.length - 1] = completed;
    else if (completed.text) rows.push(completed);
    return { ...state, entities: { ...state.entities, [action.id]: { ...current, [key]: rows, streaming: false, state: current.type === 'general' ? 'ready' : current.state } } };
  }
  if (action.type === 'ACTIVITY') {
    const current = state.entities[action.id];
    if (!current) return state;
    return { ...state, entities: { ...state.entities, [action.id]: { ...current, streaming: action.running, opening: false } } };
  }
  if (action.type === 'ENTITY_ERROR') {
    const current = state.entities[action.id];
    if (!current) return state;
    const key = current.type === 'review' ? 'chatMessages' : 'messages';
    const message = {
      id: `error:${action.id}:${action.code || action.text}`,
      role: 'assistant',
      text: action.text,
      error: true,
      streaming: false,
      citations: [],
    };
    return {
      ...state,
      entities: {
        ...state.entities,
        [action.id]: {
          ...current,
          [key]: appendUniqueMessage(current[key], message),
          streaming: false,
          opening: false,
          connectionError: action.text,
        },
      },
    };
  }
  if (action.type === 'INTERRUPT_STREAMS') {
    const entities = { ...state.entities };
    Object.entries(entities).forEach(([id, entity]) => {
      if (!entity.streaming) return;
      const key = entity.type === 'review' ? 'chatMessages' : 'messages';
      entities[id] = {
        ...entity,
        streaming: false,
        [key]: appendUniqueMessage(entity[key], {
          id: `interrupted:${id}`,
          role: 'assistant',
          text: 'The response was interrupted while Hermes restarted. You can send it again after reconnection.',
          error: true,
          streaming: false,
          citations: [],
        }),
      };
    });
    return { ...state, entities };
  }
  return state;
}

const dateGroup = (iso) => {
  const date = new Date(normalizeTimestamp(iso));
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - target.getTime()) / 86_400_000);
  if (days === 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  return {
    key: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
    label: date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }),
  };
};

const statusText = (entity) => {
  if (entity.opening) return 'Opening…';
  if (entity.streaming || ACTIVE_STATES.has(entity.state)) return 'Running';
  if (['failed', 'cancelled'].includes(entity.state)) return 'Failed';
  if (entity.type === 'review') return String(entity.outcome || 'Ready').replaceAll('_', ' ');
  const count = Number(entity.messageCount) || (entity.messages || []).length;
  return count ? `${count} msgs` : 'Saved chat';
};

const TABLE_PRESENTATION_CLASSES = new Set(['is-account-comparison', 'is-holdings-check', 'is-holdings-contracts', 'is-realignment-check']);
const MarkdownTable = ({ children, className }) => {
  const classes = String(className || '').split(/\s+/).filter(name => TABLE_PRESENTATION_CLASSES.has(name));
  return <div className={['analyst-table-frame', ...classes].join(' ')}><table>{children}</table></div>;
};
const MARKDOWN_COMPONENTS = { table: MarkdownTable };

// Transcript refreshes can replace message records without changing the answer.
// Keep completed Markdown independent of those updates so old answers are not
// parsed again while the user types or the next response is streaming.
const COMPLETED_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  a: ({ href, children }) => <AnalystReportLink href={href}>{children}</AnalystReportLink>,
};
const CompletedMarkdown = memo(function CompletedMarkdown({ markdown, reviewKind }) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkAnalystAccountComparison,
    [remarkAnalystProcessColors, { reviewKind }]], [reviewKind]);
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPLETED_COMPONENTS}>
      {markdown.replace(/<!-- analyst-(?:details|daily-rollup|prediction-research-rollup) -->/g, '\n\n')}
    </ReactMarkdown>
  );
});

// Name a source by its publication title; a product ID is a fallback, and an
// unclassified publication's "unknown" product is never a name.
const citationLabel = citation => citation.title
  || (/^unknown$/i.test(citation.product || '') ? '' : citation.product) || 'Source';

const Message = memo(function Message({ message, onCitation, inboxFindings, reviewKind, historical = false, captureUnavailable = false }) {
  const deferredPortfolio = reviewKind === 'portfolio-review' && message.role === 'assistant'
    && (message.portfolioBriefIncluded === false || message.reviewBodyIncluded === false) && !message.portfolioBrief;
  const pendingPortfolio = reviewKind === 'portfolio-review' && message.role === 'assistant' && !message.portfolioBrief
    && (deferredPortfolio || !message.text?.trim() || ['queued', 'accepted', 'starting', 'running', 'reviewing'].includes(message.reviewState || message.state));
  const terminalMarkdown = useMemo(() => (
    message.role === 'assistant' && !message.streaming && !message.portfolioBrief && !deferredPortfolio
      ? prepareAnalystMarkdown(message.text, { reviewKind })
      : ''
  ), [message.role, message.streaming, message.text, message.portfolioBrief, deferredPortfolio, reviewKind]);
  if (pendingPortfolio) return <AnalystPortfolioBrief message={message} deferred={deferredPortfolio} historical={historical}
    unavailableText={captureUnavailable ? 'Unavailable — saved review could not be loaded.' : undefined}
    loading={!captureUnavailable && (deferredPortfolio || ['queued', 'accepted', 'starting', 'running', 'reviewing'].includes(message.reviewState || message.state))} />;
  if (reviewKind === 'prediction-markets-review' && message.role === 'assistant' && !message.streaming) {
    // Shared Sources owns acquisition progress. A withheld or empty body must
    // not introduce a separate blank report or timestamp-only placeholder.
    if (!terminalMarkdown.trim()) return null;
    return <AnalystPredictionReport messageId={message.id} markdown={terminalMarkdown} citations={message.citations} onCitation={onCitation} error={message.error} />;
  }
  if (message.reviewBodyIncluded === false && !message.portfolioBrief) return <article data-message-id={message.id}
    className="analyst-captured-report-placeholder portfolio-brief-centered" aria-busy="true">
    <p>{formatAnalystReportDate(message.created_at)}</p>
  </article>;
  if (message.portfolioBrief) return <AnalystPortfolioBrief message={message} onCitation={onCitation} inboxFindings={inboxFindings} historical={historical} />;
  if (deferredPortfolio || (message.role === 'assistant' && message.streaming && !message.text?.trim())) return null;
  return (
    <article data-message-id={message.id} className={`analyst-message analyst-message--${message.role}${reviewKind === 'portfolio-review' && message.role === 'assistant' ? ' analyst-portfolio-markdown' : ''}${message.error ? ' is-error' : ''}`}>
      <span className="analyst-message-role">{message.role === 'user' ? 'You' : 'The Analyst'}</span>
      <div className="analyst-markdown">
        {message.role === 'assistant' && !message.streaming ? <CompletedMarkdown markdown={terminalMarkdown} reviewKind={reviewKind} /> : <p className={message.streaming ? 'analyst-streaming-text' : undefined}>{message.role === 'assistant' ? <AnalystSemanticText>{presentPredictionMarkdown(message.text, { reviewKind })}</AnalystSemanticText> : message.text}</p>}
      </div>
      {Array.isArray(message.citations) && message.citations.length > 0 && (
        <div className="analyst-message-citations" aria-label="Sources">
          {message.citations.slice(0, 30).map((citation, index) => (
            <button key={citation.id || index} type="button" className="analyst-citation-chip" title={citationLabel(citation)} onClick={() => onCitation(citation)}>
              <FileText size={11} aria-hidden="true" />
              {`[${index + 1}] ${citationLabel(citation)}`}
            </button>
          ))}
        </div>
      )}
    </article>
  );
});

export default function AnalystConversationPanel({ onClose }) {
  const active = useSurfaceActivity();
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const [connection, setConnection] = useState('disconnected');
  const [serviceStatus, setServiceStatus] = useState(null);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState(null);
  const [globalError, setGlobalError] = useState('');
  const [reviewNextCursor, setReviewNextCursor] = useState(null);
  const [generalNextOffset, setGeneralNextOffset] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingGeneralHistory, setLoadingGeneralHistory] = useState(false);
  const socketRef = useRef(null);
  const reconnectRef = useRef({ attempt: 0, timer: null, stopped: false });
  const stateRef = useRef(state);
  const navigationRef = useRef(0);
  const pendingGeneralRef = useRef(new Map());
  const deltaBuffersRef = useRef(new Map());
  const reviewHistoryRequestRef = useRef(0);
  const reviewHistoryInFlightRef = useRef(null);
  const transcriptRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { stateRef.current = state; }, [state]);

  const sendFrame = useCallback((payload) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  const flushDelta = useCallback((id) => {
    const pending = deltaBuffersRef.current.get(id);
    if (!pending) return;
    if (pending.timer) window.clearTimeout(pending.timer);
    deltaBuffersRef.current.delete(id);
    if (pending.text) dispatch({ type: 'APPEND_DELTA', id, text: pending.text });
  }, []);

  const queueDelta = useCallback((id, text) => {
    if (!id || !text) return;
    const pending = deltaBuffersRef.current.get(id) || { text: '', timer: null };
    pending.text += text;
    if (!pending.timer) pending.timer = window.setTimeout(() => flushDelta(id), STREAM_COMMIT_INTERVAL_MS);
    deltaBuffersRef.current.set(id, pending);
  }, [flushDelta]);

  const loadReviewDetail = useCallback(async (id) => {
    try {
      const payload = await analystApi.reviewConversation(id);
      if (payload.conversation) dispatch({ type: 'REVIEW_DETAIL', conversation: payload.conversation });
    } catch (error) {
      dispatch({ type: 'ENTITY_ERROR', id, text: error.message || 'Review conversation is unavailable.', code: error.code });
    }
  }, []);

  const loadReviewHistory = useCallback(async ({ cursor = '', search = query } = {}) => {
    const normalizedSearch = search.trim();
    const requestKey = `${cursor}\u0000${normalizedSearch}`;
    if (reviewHistoryInFlightRef.current?.key === requestKey) {
      return reviewHistoryInFlightRef.current.promise;
    }
    const historyRequest = reviewHistoryRequestRef.current + 1;
    reviewHistoryRequestRef.current = historyRequest;
    setLoadingHistory(true);
    let operation;
    operation = (async () => {
      try {
        const payload = await analystApi.reviewConversations({ limit: 50, cursor, query: normalizedSearch });
        if (historyRequest !== reviewHistoryRequestRef.current) return;
        const rows = (payload.conversations || []).map(normalizeReviewSummary);
        dispatch({ type: 'UPSERT_MANY', entities: rows });
        setReviewNextCursor(payload.nextCursor || null);
        setGlobalError((current) => (current === HISTORY_LOAD_ERROR ? '' : current));
      } catch (error) {
        if (historyRequest !== reviewHistoryRequestRef.current) return;
        if (error.code !== 'ANALYST_REQUEST_TIMEOUT') setGlobalError(HISTORY_LOAD_ERROR);
      } finally {
        if (reviewHistoryInFlightRef.current?.promise === operation) {
          reviewHistoryInFlightRef.current = null;
        }
        if (historyRequest === reviewHistoryRequestRef.current) setLoadingHistory(false);
      }
    })();
    reviewHistoryInFlightRef.current = { key: requestKey, promise: operation };
    return operation;
  }, [query]);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await analystApi.status();
      setServiceStatus(status);
    } catch (error) {
      setServiceStatus({ status: 'unavailable', error: error.message, readiness: {} });
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refreshStatus();
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refreshStatus();
        loadReviewHistory({ reset: true, search: query });
      }
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, loadReviewHistory, query, refreshStatus]);

  useEffect(() => {
    if (!active) {
      reviewHistoryRequestRef.current += 1;
      reviewHistoryInFlightRef.current = null;
      setLoadingHistory(false);
      return undefined;
    }
    const timer = window.setTimeout(() => loadReviewHistory({ reset: true, search: query }), 250);
    return () => {
      window.clearTimeout(timer);
      reviewHistoryRequestRef.current += 1;
      reviewHistoryInFlightRef.current = null;
    };
  }, [active, loadReviewHistory, query]);

  useEffect(() => {
    const reconnectState = reconnectRef.current;
    const deltaBuffers = deltaBuffersRef.current;
    let intentionalShutdown = false;
    reconnectState.stopped = !active;
    if (!active) {
      if (reconnectState.timer) window.clearTimeout(reconnectState.timer);
      socketRef.current?.close();
      socketRef.current = null;
      setConnection('disconnected');
      return undefined;
    }

    const connect = () => {
      if (reconnectState.stopped) return;
      setConnection('connecting');
      const socket = new WebSocket(analystWebSocketUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        sendFrame({ action: 'list_sessions', limit: 50, offset: 0 });
        const selected = stateRef.current.entities[stateRef.current.selectedId];
        if (selected?.type === 'general' && selected.hermesSessionId && !String(selected.id).startsWith('pending:')) {
          const resumeRequestId = requestId('resume');
          sendFrame({ action: 'resume', sessionId: selected.hermesSessionId, requestId: resumeRequestId });
        } else if (selected?.type === 'review' && selected.hermesSessionId) {
          const resumeRequestId = requestId('resume-review');
          sendFrame({ action: 'resume_review', conversationId: selected.id, reviewKind: selected.reviewKind, hermesSessionId: selected.hermesSessionId, requestId: resumeRequestId });
        }
      };
      socket.onmessage = (event) => {
        let frame;
        try { frame = JSON.parse(event.data); } catch (_error) { return; }
        if (frame.type === 'connection') {
          setConnection(frame.status === 'connected' ? 'connected' : 'disconnected');
          if (frame.status === 'connected') reconnectState.attempt = 0;
          if (frame.status === 'disconnected') socket.close();
          return;
        }
        if (frame.type === 'session_list') {
          const rows = (frame.sessions || [])
            .filter((session) => !session.managedReviewFollowup && !session.canonicalReview)
            .map(normalizeGeneralSummary)
            .filter((session) => session.id);
          dispatch({ type: 'UPSERT_MANY', entities: rows });
          setGeneralNextOffset(Number.isInteger(frame.nextOffset) ? frame.nextOffset : null);
          setLoadingGeneralHistory(false);
          return;
        }
        if (frame.type === 'session' || frame.type === 'session_warmed') {
          const pendingId = frame.requestId ? pendingGeneralRef.current.get(frame.requestId) : null;
          const id = String(frame.conversationId || frame.storedSessionId || pendingId || '').trim();
          if (!id) return;
          const isReview = id.startsWith('review:') || Boolean(frame.reviewKind);
          const patch = {
            id,
            conversationId: id,
            title: frame.title,
            hermesSessionId: frame.storedSessionId,
            runtimeSessionId: frame.sessionId,
            messages: frame.messages || [],
            running: frame.running,
            review: isReview,
          };
          if (pendingId && pendingId !== id) {
            pendingGeneralRef.current.delete(frame.requestId);
            dispatch({ type: 'REPLACE_ID', from: pendingId, to: id, entity: patch });
          }
          dispatch({ type: 'SESSION', ...patch });
          return;
        }
        const id = String(frame.conversationId || frame.storedSessionId || '').trim();
        if (frame.type === 'user_message' && id) {
          dispatch({ type: 'APPEND_MESSAGE', id, message: { id: frame.messageId || `user:${Date.now()}`, role: 'user', text: frame.text, citations: [], streaming: false } });
        } else if (frame.type === 'message_delta' && id) {
          queueDelta(id, frame.text || '');
        } else if (frame.type === 'message_complete' && id) {
          flushDelta(id);
          dispatch({ type: 'COMPLETE_MESSAGE', id, message: { text: frame.text, citations: frame.citations || [] } });
        } else if (frame.type === 'session_status' && id) {
          dispatch({ type: 'ACTIVITY', id, running: frame.running === true });
        } else if (frame.type === 'session_deleted' && frame.sessionId) {
          dispatch({ type: 'REMOVE', id: frame.sessionId });
        } else if (frame.type === 'error') {
          if (frame.action === 'list_sessions') setLoadingGeneralHistory(false);
          const pendingIdForError = frame.requestId ? pendingGeneralRef.current.get(frame.requestId) : null;
          const targetId = id || pendingIdForError || stateRef.current.selectedId;
          if (targetId) dispatch({ type: 'ENTITY_ERROR', id: targetId, text: frame.error || 'The Analyst encountered an error.', code: frame.code });
          else setGlobalError(frame.error || 'The Analyst encountered an error.');
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setConnection('disconnected');
        if (!intentionalShutdown) dispatch({ type: 'INTERRUPT_STREAMS' });
        if (reconnectState.stopped) return;
        const attempt = reconnectState.attempt++;
        const base = [500, 1_000, 2_000, 5_000][Math.min(attempt, 3)];
        const delay = Math.round(base * (0.85 + Math.random() * 0.3));
        reconnectState.timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      intentionalShutdown = true;
      reconnectState.stopped = true;
      if (reconnectState.timer) window.clearTimeout(reconnectState.timer);
      socketRef.current?.close();
      socketRef.current = null;
      deltaBuffers.forEach((pending) => pending.timer && window.clearTimeout(pending.timer));
      deltaBuffers.clear();
    };
  }, [active, flushDelta, queueDelta, sendFrame]);

  const activeReviewRuns = useMemo(() => Object.values(state.entities)
    .filter((entity) => entity.type === 'review'
      && entity.activeRunId
      && !String(entity.activeRunId).startsWith('pending:')
      && ACTIVE_STATES.has(entity.state))
    .map((entity) => ({ id: entity.id, runId: entity.activeRunId })), [state.entities]);
  const activeReviewKey = activeReviewRuns.map((row) => `${row.id}:${row.runId}`).sort().join('|');

  useEffect(() => {
    if (!active || !activeReviewRuns.length) return undefined;
    let cancelled = false;
    let timer = null;
    let failures = 0;
    const poll = async () => {
      let hadFailure = false;
      await Promise.all(activeReviewRuns.map(async ({ id, runId }) => {
        try {
          const payload = await analystApi.reviewStatus(runId);
          const run = payload.run || payload;
          const current = stateRef.current.entities[id];
          if (!current || current.activeRunId !== runId) return;
          dispatch({ type: 'UPSERT', entity: normalizeReviewSummary({
            ...current,
            conversationId: id,
            state: run.state,
            phase: run.phase,
            outcome: run.outcome,
            activeRunId: run.active ? run.runId : null,
            latestRunId: run.runId,
            retryable: run.retryable,
            error: run.error,
            updatedAt: run.updatedAt,
          }) });
          if (!run.active) await loadReviewDetail(id);
        } catch (_error) {
          hadFailure = true;
        }
      }));
      if (cancelled) return;
      failures = hadFailure ? failures + 1 : 0;
      const delay = Math.min(REVIEW_POLL_MAX_BACKOFF_MS, REVIEW_POLL_INTERVAL_MS * (2 ** failures));
      timer = window.setTimeout(poll, delay);
    };
    timer = window.setTimeout(poll, REVIEW_POLL_INTERVAL_MS);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  // The key deliberately owns lifecycle; entity detail changes must not restart the timer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeReviewKey, loadReviewDetail]);

  const reviewReady = useMemo(() => ({
    'portfolio-review': serviceStatus?.readiness?.portfolioReview?.ready !== false,
    'prediction-markets-review': serviceStatus?.readiness?.predictionMarketsReview?.ready !== false,
  }), [serviceStatus]);

  const sortedEntities = useMemo(() => Object.values(state.entities)
    .filter((entity) => entity?.id && !entity.archived)
    .filter((entity) => !query.trim() || String(entity.title || '').toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0) || String(right.id).localeCompare(String(left.id))), [query, state.entities]);

  const groups = useMemo(() => {
    const result = [];
    const byKey = new Map();
    sortedEntities.forEach((entity) => {
      const descriptor = dateGroup(entity.createdAt);
      let group = byKey.get(descriptor.key);
      if (!group) {
        group = { ...descriptor, items: [] };
        byKey.set(descriptor.key, group);
        result.push(group);
      }
      group.items.push(entity);
    });
    return result;
  }, [sortedEntities]);

  const selected = state.selectedId ? state.entities[state.selectedId] : null;
  const rawTranscriptMessages = selected?.type === 'review'
    ? [...(selected.reviewMessages || []), ...(selected.chatMessages || [])]
    : (selected?.messages || []);
  const selectedReviewErrorText = selected?.type === 'review'
    ? String(selected.reviewError?.message || '').trim()
    : '';
  const transcriptMessages = selectedReviewErrorText
    ? rawTranscriptMessages.filter((message) => !(
      message.role === 'assistant' && String(message.text || '').trim() === selectedReviewErrorText
    ))
    : rawTranscriptMessages;
  const running = Boolean(selected && (selected.streaming || ACTIVE_STATES.has(selected.state)));

  useEffect(() => {
    if (transcriptRef.current && selected) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [selected, transcriptMessages.length, running]);

  const openConversation = useCallback((entity) => {
    navigationRef.current += 1;
    setGlobalError('');
    dispatch({ type: 'SELECT', id: entity.id });
    if (entity.type === 'review') {
      loadReviewDetail(entity.id);
      if (entity.hermesSessionId && connection === 'connected') {
        const resumeRequestId = requestId('resume-review');
        sendFrame({ action: 'resume_review', conversationId: entity.id, reviewKind: entity.reviewKind, hermesSessionId: entity.hermesSessionId, requestId: resumeRequestId });
      }
    } else if (!String(entity.id).startsWith('pending:') && connection === 'connected') {
      const resumeRequestId = requestId('resume');
      dispatch({ type: 'UPSERT', entity: { ...entity, opening: true } });
      sendFrame({ action: 'resume', sessionId: entity.hermesSessionId || entity.id, requestId: resumeRequestId });
    }
  }, [connection, loadReviewDetail, sendFrame]);

  const newChat = useCallback(() => {
    navigationRef.current += 1;
    dispatch({ type: 'NEW_CHAT' });
    setInput('');
    setGlobalError('');
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const launchReview = useCallback(async (reviewKind) => {
    const existing = Object.values(stateRef.current.entities).find((entity) => (
      entity.type === 'review' && entity.reviewKind === reviewKind && ACTIVE_STATES.has(entity.state)
    ));
    if (existing) {
      openConversation(existing);
      return;
    }
    const action = REVIEW_ACTIONS.find((row) => row.id === reviewKind);
    if (!action || reviewReady[reviewKind] === false) return;
    const launchRequestId = requestId(reviewKind);
    const pendingId = `pending:review:${launchRequestId}`;
    const now = new Date().toISOString();
    navigationRef.current += 1;
    dispatch({ type: 'UPSERT', entity: {
      id: pendingId,
      conversationId: pendingId,
      type: 'review',
      reviewKind,
      title: action.label,
      createdAt: now,
      updatedAt: now,
      state: 'queued',
      activeRunId: `pending:${launchRequestId}`,
      reviewMessages: [{ id: `${pendingId}:user`, role: 'user', text: action.message, citations: [], streaming: false }],
    } });
    dispatch({ type: 'SELECT', id: pendingId });
    setSidebarExpanded(true);
    setGlobalError('');
    try {
      const payload = await analystApi.createReviewConversation(reviewKind, { requestId: launchRequestId });
      const conversation = normalizeReviewSummary(payload.conversation);
      dispatch({ type: 'REPLACE_ID', from: pendingId, to: conversation.id, entity: conversation });
      await loadReviewDetail(conversation.id);
    } catch (error) {
      dispatch({ type: 'UPSERT', entity: {
        id: pendingId,
        state: 'failed',
        activeRunId: null,
        retryable: true,
        reviewError: { code: error.code, message: error.message, retryable: true },
      } });
    }
  }, [loadReviewDetail, openConversation, reviewReady]);

  const retryReview = useCallback(async () => {
    const current = stateRef.current.entities[stateRef.current.selectedId];
    if (!current || current.type !== 'review' || !current.latestRunId || ACTIVE_STATES.has(current.state)) return;
    const retryRequestId = requestId(`retry:${current.reviewKind}`);
    dispatch({ type: 'UPSERT', entity: { ...current, state: 'queued', activeRunId: `pending:${retryRequestId}`, retryable: false, reviewError: null } });
    try {
      const payload = await analystApi.retryReviewConversation(current.id, { requestId: retryRequestId, previousRunId: current.latestRunId });
      dispatch({ type: 'UPSERT', entity: normalizeReviewSummary(payload.conversation) });
      await loadReviewDetail(current.id);
    } catch (error) {
      dispatch({ type: 'UPSERT', entity: { ...current, state: 'failed', activeRunId: null, retryable: true, reviewError: { code: error.code, message: error.message, retryable: true } } });
    }
  }, [loadReviewDetail]);

  const loadOlder = useCallback(() => {
    if (reviewNextCursor) loadReviewHistory({ cursor: reviewNextCursor });
    if (Number.isInteger(generalNextOffset)) {
      setLoadingGeneralHistory(true);
      const sent = sendFrame({
        action: 'list_sessions',
        limit: 50,
        offset: generalNextOffset,
        requestId: requestId('session-page'),
      });
      if (!sent) {
        setLoadingGeneralHistory(false);
        setGlobalError('Hermes is reconnecting. Older conversations will be available after reconnection.');
      }
    }
  }, [generalNextOffset, loadReviewHistory, reviewNextCursor, sendFrame]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || connection !== 'connected' || running) return;
    setInput('');
    setGlobalError('');
    const current = stateRef.current.entities[stateRef.current.selectedId];
    if (!current) {
      const promptRequestId = requestId('new-prompt');
      const pendingId = `pending:chat:${promptRequestId}`;
      const now = new Date().toISOString();
      pendingGeneralRef.current.set(promptRequestId, pendingId);
      dispatch({ type: 'UPSERT', entity: {
        id: pendingId,
        conversationId: pendingId,
        type: 'general',
        title: titleFromPrompt(text),
        createdAt: now,
        updatedAt: now,
        state: 'running',
        streaming: true,
        messages: [{ id: `${pendingId}:user`, role: 'user', text, citations: [], streaming: false }],
      } });
      dispatch({ type: 'SELECT', id: pendingId });
      sendFrame({ action: 'new_prompt', text, requestId: promptRequestId });
      return;
    }
    dispatch({ type: 'APPEND_MESSAGE', id: current.id, message: { id: `user:${Date.now()}`, role: 'user', text, citations: [], streaming: false } });
    dispatch({ type: 'ACTIVITY', id: current.id, running: true });
    if (current.type === 'review' && !current.runtimeSessionId) {
      sendFrame({
        action: 'review_prompt',
        text,
        requestId: requestId('review-prompt'),
        conversationId: current.id,
        reviewKind: current.reviewKind,
        reviewRunId: current.latestRunId,
        hermesSessionId: current.hermesSessionId || '',
      });
    } else {
      sendFrame({
        action: 'prompt',
        text,
        sessionId: current.hermesSessionId || current.id,
        ...(current.type === 'review' ? { conversationId: current.id, reviewRunId: current.latestRunId } : {}),
      });
    }
  }, [connection, input, running, sendFrame]);

  const canSend = connection === 'connected' && !running && (!selected || !selected.opening)
    && !(selected?.type === 'review' && ACTIVE_STATES.has(selected.state));
  const activeReviewFailure = selected?.type === 'review' && ['failed', 'cancelled'].includes(selected.state) ? selected : null;

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onClose]);

  return (
    <section className="analyst-panel analyst-panel-v2" data-testid="analyst-panel" role="dialog" aria-label="The Analyst" tabIndex={-1}>
      <div className="analyst-workspace">
        <aside className={`analyst-conversation-rail ${sidebarExpanded ? 'is-open' : 'is-collapsed'}`} data-testid="analyst-conversation-rail" aria-label="Analyst conversations and controls">
          <header className="analyst-sidebar-header"><div className="analyst-sidebar-top-actions">
            <button type="button" className="analyst-sidebar-icon-button is-sidebar-toggle" aria-label={sidebarExpanded ? 'Collapse conversation sidebar' : 'Expand conversation sidebar'} aria-expanded={sidebarExpanded} onClick={() => setSidebarExpanded((value) => !value)}>{sidebarExpanded ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}</button>
            <button type="button" className="analyst-sidebar-icon-button is-primary" aria-label="New Chat" title="New Chat" onClick={newChat}><MessageSquarePlus size={16} /></button>
            <button type="button" className="analyst-sidebar-icon-button is-close" aria-label="Close The Analyst" title="Close" onClick={onClose}><X size={17} /></button>
          </div></header>
          <div className="analyst-conversation-content" aria-hidden={!sidebarExpanded}>
            <label className="analyst-conversation-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search conversations</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations…" aria-label="Search conversations" /></label>
            <div className="analyst-conversation-list">
              {!groups.length && <div className="analyst-conversation-empty"><MessageSquare size={16} /><span>{query.trim() ? 'No matching conversations.' : 'New conversations appear here.'}</span></div>}
              {groups.map((group) => <section className="analyst-conversation-date-group" key={group.key} aria-label={group.label}><h3 className="analyst-conversation-date-heading">{group.label}</h3>{group.items.map((entity) => {
                const itemRunning = entity.streaming || ACTIVE_STATES.has(entity.state);
                return <div key={entity.id} className={`analyst-conversation-row${state.selectedId === entity.id ? ' is-active' : ''}${itemRunning ? ' is-running' : ''}${['failed', 'cancelled'].includes(entity.state) ? ' is-failed' : ''}`}>
                  <button type="button" className={`analyst-conversation-item${state.selectedId === entity.id ? ' is-active' : ''}`} aria-label={`Open conversation: ${entity.title}`} aria-current={state.selectedId === entity.id ? 'true' : undefined} onClick={() => openConversation(entity)}><span className="analyst-conversation-copy"><strong>{entity.title}</strong><small>{statusText(entity)}</small></span></button>
                </div>;
              })}</section>)}
              {(reviewNextCursor || Number.isInteger(generalNextOffset)) && !query.trim() && <button type="button" className="analyst-load-older" disabled={loadingHistory || loadingGeneralHistory} onClick={loadOlder}>{loadingHistory || loadingGeneralHistory ? 'Loading…' : 'Load older'}</button>}
            </div>
          </div>
          <nav className="analyst-sidebar-footer" aria-label="Analyst controls"><button type="button" aria-label="History" aria-pressed={sidebarExpanded} onClick={() => setSidebarExpanded(true)}><MessageSquare size={15} /><span>History</span></button><button type="button" aria-label="Sources" onClick={() => setLibraryOpen(true)}><Archive size={15} /><span>Sources</span></button></nav>
        </aside>

        <main className="analyst-chat analyst-chat-v2">
          <div ref={transcriptRef} className={`analyst-transcript analyst-transcript-v2${selected ? '' : ' is-landing'}`} role="log" aria-label="Conversation" aria-live="polite">
            {!selected ? <div className="analyst-landing"><div className="analyst-landing-mark"><MessageSquare size={24} /></div><h1>The Analyst</h1><p>Start a live review or ask a question.</p><div className="analyst-landing-actions" role="group" aria-label="Start a review">{REVIEW_ACTIONS.map((action) => <button key={action.id} type="button" disabled={reviewReady[action.id] === false} onClick={() => launchReview(action.id)}>{action.label}</button>)}</div></div>
              : <div className="analyst-message-list">{transcriptMessages.map((message) => <Message key={message.id} message={message} reviewKind={selected.reviewKind} onCitation={setSelectedCitation} />)}{running && <div className="analyst-running-dots" role="status" aria-label={`${selected.title} is running`}><span /><span /><span /></div>}</div>}
          </div>
          <footer className="analyst-composer-wrap">
            {activeReviewFailure?.reviewError && <div className="analyst-inline-error analyst-review-error" role="alert"><span>{activeReviewFailure.reviewError.message || 'The review could not finish.'}</span>{activeReviewFailure.retryable && <button type="button" onClick={retryReview} disabled={reviewReady[activeReviewFailure.reviewKind] === false}>Retry with fresh data</button>}</div>}
            {globalError && <div className="analyst-inline-error" role="alert">{globalError}</div>}
            {connection !== 'connected' && <div className="analyst-degraded-note">Hermes is reconnecting. Server-owned reviews remain available.</div>}
            <form className="analyst-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (canSend) submit(); } }} placeholder="Message The Analyst…" aria-label="Message The Analyst" disabled={!canSend} rows={2} />{selected?.streaming ? <button type="button" className="analyst-stop-button" onClick={() => sendFrame({ action: 'interrupt' })}><Square size={14} fill="currentColor" />Stop</button> : <button type="submit" className="analyst-send-button" disabled={!canSend || !input.trim()}><Send size={17} /><span className="sr-only">Send</span></button>}</form>
          </footer>
        </main>

        {libraryOpen && <SourceLibrary onClose={() => setLibraryOpen(false)} />}
        {selectedCitation && <aside className="analyst-source-detail" role="dialog" aria-label="Citation source"><header><span>Validated source</span><button type="button" className="analyst-icon-button" aria-label="Close citation" onClick={() => setSelectedCitation(null)}><X size={16} /></button></header><strong>{selectedCitation.title || selectedCitation.product}</strong><dl><div><dt>Product</dt><dd>{selectedCitation.product}</dd></div><div><dt>Published</dt><dd><AnalystSemanticText>{selectedCitation.publicationDate ? formatAnalystReportDate(selectedCitation.publicationDate) : 'Undated'}</AnalystSemanticText></dd></div>{selectedCitation.page && <div><dt>Page</dt><dd>{selectedCitation.page}</dd></div>}<div><dt>Citation</dt><dd>{selectedCitation.id}</dd></div><div><dt>Source</dt><dd>{selectedCitation.sourceUri}</dd></div></dl>{selectedCitation.excerpt && <blockquote>{selectedCitation.excerpt}</blockquote>}</aside>}
      </div>
      <span className="sr-only" aria-live="polite">WebSocket status: {connection}</span>
    </section>
  );
}

export { Message, SourceLibrary, dateGroup };
