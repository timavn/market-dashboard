import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, RefreshCw, Search, Send, Square, Trash2 } from 'lucide-react';
import AnalystSpinner from './AnalystSpinner';
import { analystWorkspaceApi as api } from '../../services/analyst/analystClient';
import { Message, SourceLibrary } from './AnalystConversationPanel';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { PortfolioResearchUpdates, PortfolioReviewPlaceholder } from './AnalystPortfolioBrief';
import AnalystInbox from './AnalystInbox';
import { safeResearchUrl } from '../../utils/researchSourceUrl';
import useAnalystInbox from '../../hooks/useAnalystInbox';
import { balanceReviewMessages } from './balanceReviewPresentation';
import { analystReviewMessages } from './analystReviewMessages';
import AnalystReviewSources from './AnalystReviewSources';
import AnalystLandingStatus from './AnalystLandingStatus';
import useAnalystReviewSources from '../../hooks/useAnalystReviewSources';
import AnalystSourceExcerpt from './AnalystSourceExcerpt';
import AnalystSourceEmail from './AnalystSourceEmail';
import { formatResearchSourceDate } from '../../utils/researchDateFormat';
import { formatAnalystReportDate } from '../../utils/analystReportDates';
import { reuseAnalystEvidence } from '../../services/analyst/analystEvidenceIdentity';
import { hydrateAnalystCapturedCitations } from '../../services/analyst/analystCapturedCitations';
import useAnalystCapturedHistory from '../../hooks/useAnalystCapturedHistory';
import useAnalystReportContainment from '../../hooks/useAnalystReportContainment';

const loadHorizonStats = symbols => api.request(`/horizon-stats?symbols=${encodeURIComponent(symbols.join(','))}`).then(result => result.rows || {});

const reviews = [['portfolio-review', 'Portfolio Review'], ['prediction-markets-review', 'Predictive Markets Review']];
// Balance Review is retired into Portfolio Review. Saved Balance chats stay
// readable and deletable, but cannot be launched or refreshed.
const retiredReviewKinds = ['balance-review'];
const isReviewKind = kind => reviews.some(([review]) => review === kind) || retiredReviewKinds.includes(kind);
const sourcesAnchoredReview = kind => ['portfolio-review', 'prediction-markets-review'].includes(kind);
// Dated Analyst chats are filed under the user's Pacific calendar day.
const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});
const pacificDate = value => pacificDay.format(value);
const isDailyConversation = row => row.kind === 'daily-chat' || isReviewKind(row.kind);
const conversationDay = row => {
  if (isDailyConversation(row) && /^\d{4}-\d{2}-\d{2}$/.test(row.trading_date || '')) return row.trading_date;
  const created = new Date(row.created_at);
  return pacificDate(Number.isFinite(created.getTime()) ? created : new Date());
};
// Sidebar groups follow Pacific calendar days, whatever the browser's own zone.
const dateGroup = (day, today) => {
  if (day === today) return { key: 'today', label: 'Today' };
  if (day === new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)) return { key: 'yesterday', label: 'Yesterday' };
  return { key: day, label: new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', month: 'long', day: 'numeric', ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) }) };
};
function placeDailyChats(items) {
  const ordered = items.filter(row => row.kind !== 'daily-chat');
  for (const chat of items.filter(row => row.kind === 'daily-chat')) {
    const sameDayReview = row => row.trading_date === chat.trading_date && isReviewKind(row.kind);
    let anchor = ordered.findLastIndex(row => sameDayReview(row) && row.kind === 'prediction-markets-review');
    if (anchor < 0) anchor = ordered.findLastIndex(sameDayReview);
    ordered.splice(anchor < 0 ? 0 : anchor + 1, 0, chat);
  }
  return ordered;
}
const saved = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`analyst.workspace.${key}`)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(`analyst.workspace.${key}`, JSON.stringify(value)); } catch { /* Memory state still works if storage is full. */ } };
const LAUNCH_TTL_MS = 10 * 60_000;
// The start POST's 45 s acceptance budget, with a margin for its commit.
const LAUNCH_START_BUDGET_MS = 60_000;
// A review start can wait up to 45 s for durable acceptance. Persist only its
// exact request reference so a reload keeps one Starting slot and reconciles it.
const savedLaunches = () => {
  const rows = saved('launches', []);
  const now = Date.now();
  return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object' && reviews.some(([kind]) => kind === row.kind)
    && typeof row.requestId === 'string' && row.requestId.startsWith('review-start:') && row.requestId.length <= 200
    && row.launchKey === `${row.kind}:` && /^\d{4}-\d{2}-\d{2}$/.test(row.tradingDate || '')
    && Number.isFinite(Date.parse(row.startedAt)) && Math.abs(now - Date.parse(row.startedAt)) < LAUNCH_TTL_MS)
    .map(({ kind, requestId, tradingDate, launchKey, startedAt }) => ({ kind, requestId, tradingDate, launchKey, startedAt })) : [];
};
const rememberLaunch = opening => save('launches', [...savedLaunches().filter(row => row.launchKey !== opening.launchKey),
  { kind: opening.kind, requestId: opening.requestId, tradingDate: opening.trading_date, launchKey: opening.launchKey, startedAt: opening.created_at }]);
const forgetLaunch = requestId => save('launches', savedLaunches().filter(row => row.requestId !== requestId));
const reviewOpening = ({ kind, requestId, launchKey, startedAt, tradingDate }) => ({ id: `pending-review:${requestId}`, kind, requestId, launchKey,
  title: reviews.find(([review]) => review === kind)?.[1], created_at: startedAt, trading_date: tradingDate,
  message_count: 0, state: 'starting', pending: true, archived: false });
const restoredSelection = () => {
  const selected = saved('selected', null);
  if (typeof selected !== 'string') return null;
  if (selected.startsWith('pending-review:')) return savedLaunches().some(row => `pending-review:${row.requestId}` === selected) ? selected : null;
  return selected;
};
const reviewPhaseLabel = phase => ({ queued: 'Queued…', acquiring: 'Gathering sources…', rendering: 'Writing review…', summarizing: 'Summarizing…' })[phase];
const capturedBalancePrimary = message => message?.balancePrimary?.available === true
  && message.reviewRunId === message.balancePrimary.runId && Boolean(message.text?.trim());
const balancePrimaryReady = conversation => {
  if (conversation?.kind !== 'balance-review') return false;
  const message = conversation.messages?.findLast(row => row.role === 'assistant' && !row.reviewNarrative && row.reviewRunId);
  const active = conversation.activeTurn;
  // Narrative retries keep the captured post binding, while their new request
  // ID does not carry the acquisition's top-level progress metadata.
  const samePostRetry = Boolean(message?.reviewPostId && active?.review_post_id === message.reviewPostId
    && active.request_id?.startsWith('narrative-retry:')
    && (!conversation.reviewRunId || conversation.reviewRunId === message.reviewRunId));
  return capturedBalancePrimary(message) && message.balancePrimaryIncluded !== false
    && (message.turn_id === active?.id || message.reviewRunId === conversation.reviewRunId || samePostRetry);
};
// Landing actions keep the review titles as accessible names; the visible
// labels are shorter and the shortcut keys work while focus is in the panel.
const landingActions = [
  { kind: 'portfolio-review', label: 'Portfolio review', key: 'P' },
  { kind: 'prediction-markets-review', label: 'Predictive markets', key: 'M' },
];
const landingTabs = [['chats', 'Chats'], ['inbox', 'Inbox'], ['sources', 'Sources']];
const ResponseDots = ({ phase, since }) => <div className={`analyst-running-dots${phase ? ' has-phase' : ''}`} role="status" aria-label="Response running" aria-description={phase}><AnalystSpinner size={18} elapsed since={since} />{phase && <small className="sr-only">{phase}</small>}</div>;
const acceptedConversation = (entities, request) => request && Object.values(entities).find(conversation =>
  (!request.conversationId || conversation.id === request.conversationId)
  && [conversation.activeTurn, conversation.lastTurn].some(turn => turn?.request_id === request.requestId));
const acceptedReviewLaunch = (conversation, request) => conversation?.kind === request.kind
  && (conversation.reviewRequestId === request.requestId
    || [conversation.activeTurn, conversation.lastTurn].some(turn => turn?.request_id === request.requestId));
const receiptInScope = (row, { query }) => !row.archived
  && (!query || [row.title, ...(row.messages || []).map(message => message.text)].some(text => String(text || '').toLowerCase().includes(query.toLowerCase())));
const sidebarMessageCount = row => {
  if (Number.isSafeInteger(row.message_count) && row.message_count >= 0) return row.message_count;
  if (!Array.isArray(row.messages)) return null;
  const review = isReviewKind(row.kind);
  return new Set(row.messages.filter(message => !message.internal && (message.role !== 'assistant' || message.text?.trim() || message.portfolioBrief || capturedBalancePrimary(message))).map(message =>
    review && message.role === 'assistant' && (message.reviewPostId || message.reviewRunId || message.reviewNarrative || /^(daily-report|review-message):/.test(message.source_id || ''))
      ? `review:${message.reviewPostId || 'base'}` : `message:${message.id}`)).size;
};
const sidebarCountLabel = row => {
  const count = sidebarMessageCount(row);
  return count === null ? '' : `${count} ${count === 1 ? 'message' : 'messages'}`;
};
const SidebarStatus = ({ row, conversation, starting, deleting }) => {
  const balanceReady = balancePrimaryReady(conversation);
  const phase = reviewPhaseLabel(row.reviewPhase);
  const loading = deleting || starting || (row.kind !== 'audit' && !balanceReady
    && Boolean(phase || row.activeTurn || ['running', 'accepted'].includes(row.state)));
  const label = deleting ? 'Deleting…' : starting ? 'Starting…' : row.kind === 'audit' ? 'Audit history'
    : balanceReady ? sidebarCountLabel({ ...conversation, message_count: undefined })
      : phase || (loading ? 'Responding…' : sidebarCountLabel(row));
  return <small>{loading
    // A delete is quick: the ring alone, no seconds counting beside them.
    ? <AnalystSpinner size={10} className="analyst-conversation-running-icon" text={label} elapsed={!deleting} since={row.activeTurn?.created_at} />
    : <span className="analyst-conversation-status-text">{label}</span>}</small>;
};
// Retain navigation through API restarts, without retaining report, source, or
// account evidence in the browser. Missing list rows are not deletion receipts.
const sidebarMetadata = row => {
  if (!row || typeof row.id !== 'string' || row.id.startsWith('pending-') || row.archived) return null;
  const metadata = { id: row.id, archived: false };
  for (const key of ['title', 'kind', 'created_at', 'updated_at', 'trading_date', 'state', 'reviewPhase', 'reviewState', 'reviewRunId', 'reviewRequestId']) {
    if (typeof row[key] === 'string' || row[key] === null) metadata[key] = row[key];
  }
  if (Number.isSafeInteger(row.revision)) metadata.revision = row.revision;
  const count = sidebarMessageCount(row);
  if (count !== null) metadata.message_count = count;
  for (const key of ['activeTurn', 'lastTurn']) {
    if (row[key] === null) metadata[key] = null;
    else if (row[key] && typeof row[key] === 'object') metadata[key] = Object.fromEntries(
      ['id', 'state', 'request_id'].filter(field => typeof row[key][field] === 'string').map(field => [field, row[key][field]]));
  }
  if (Object.prototype.hasOwnProperty.call(row, 'activeTurn') && row.activeTurn !== undefined) metadata.state = row.activeTurn?.state || row.lastTurn?.state || null;
  return metadata;
};
const restoredSidebar = () => {
  const rows = saved('sidebar', []);
  return Array.isArray(rows) ? rows.map(sidebarMetadata).filter(Boolean) : [];
};
const transientReadError = error => !error.code || error.code === 'ANALYST_REQUEST_TIMEOUT' || /^HTTP_(?:408|429|5\d\d)$/.test(error.code)
  || [408, 429].includes(error.status) || error.status >= 500;
// Only the server's explicit not-found or deleted reason verifies that saved
// navigation may be evicted. A bare 404 can come from a restarting route.
const verifiedMissing = error => ['ANALYST_CONVERSATION_NOT_FOUND', 'ANALYST_CONVERSATION_DELETED'].includes(error?.serverCode);
const recoverableRead = error => transientReadError(error) || (error.code === 'HTTP_404' && !error.serverCode);
const recoveryDelay = attempt => Math.min(1000 * 2 ** attempt, 15_000);
const EVENT_SOURCE_CLOSED = 2;
// Saved turn errors end by offering a retry; the note's own Retry already does.
const responseFailureLabel = error => String(error || '').replace(/\s*Retry is available\.?\s*$/i, '') || 'Response interrupted.';
const sendFailureLabel = error => {
  if (error.code === 'ANALYST_STARTING') return 'Not sent · Analyst connecting';
  if (error.code === 'ANALYST_REQUEST_TIMEOUT') return 'Not sent · Timed out';
  return error.code ? `Not sent · ${error.message}` : 'Not sent · Analyst unreachable';
};
// A repeated click must land on the disabled row being deleted, never on the row below it.
const DELETE_ROW_HOLD_MS = 1000;
// An Inbox Source docks in the empty space left of the Analyst window when there is room for it.
const DOCKED_SOURCE_WIDTH = 420;
const DOCKED_SOURCE_MIN_WIDTH = 320;
// The product a publication came from: its title up to the colon ("Real-Time Alert: UNH Sell").
const sourceProduct = source => String(source?.title || source?.product || 'Source').split(':')[0];
const highlightTexts = value => Array.isArray(value) ? value.filter(text => typeof text === 'string') : [];
function citationPublications(source, context) {
  const publications = [];
  const byId = new Map();
  const related = Array.isArray(context?.relatedSources) ? context.relatedSources : [];
  for (const publication of [{ ...source, highlightTexts: highlightTexts(context?.highlightTexts) }, ...related]) {
    if (!publication || typeof publication !== 'object') continue;
    const index = publication.id ? byId.get(publication.id) : undefined;
    if (index !== undefined) {
      const previous = publications[index];
      publications[index] = { ...previous, ...publication, highlightTexts: [...new Set([
        ...highlightTexts(previous.highlightTexts), ...highlightTexts(publication.highlightTexts),
      ])] };
    } else {
      if (publication.id) byId.set(publication.id, publications.length);
      publications.push({ ...publication, highlightTexts: highlightTexts(publication.highlightTexts) });
    }
  }
  return publications;
}

export default function AnalystWorkspace({ onClose, holdingsCount }) {
  const active = useSurfaceActivity();
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => { activeRef.current = active; return () => { activeRef.current = false; }; }, [active]);
  const [selected, setSelected] = useState(restoredSelection);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [entities, setEntities] = useState({});
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;
  const loadsInFlight = useRef(new Map());
  const compactBriefReads = useRef(new Map());
  const [rows, setRows] = useState(restoredSidebar);
  const [historyLoaded, setHistoryLoaded] = useState(() => restoredSidebar().length > 0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const latestTailCursor = useRef(null);
  const historySnapshotCursor = useRef(null);
  const detailSnapshotCursors = useRef(new Map());
  const listsInFlight = useRef(new Map());
  const listRevision = useRef({ requested: 0, applied: 0 });
  const firstList = useRef(true);
  const [query, setQuery] = useState('');
  const sidebarScope = useRef({ query });
  sidebarScope.current = { query };
  const [landingTab, setLandingTab] = useState('chats');
  const [drafts, setDrafts] = useState(() => {
    const drafts = saved('drafts', {});
    const outbox = saved('outbox', null);
    const key = outbox?.conversationId || 'landing';
    return outbox?.text && !drafts[key] ? { ...drafts, [key]: outbox.text } : drafts;
  });
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [error, setError] = useState('');
  const [deleteErrors, setDeleteErrors] = useState({});
  const [historyError, setHistoryError] = useState('');
  const [historyReadFailed, setHistoryReadFailed] = useState(false);
  // When the latest applied unfiltered history snapshot was requested.
  const [historySnapshotAt, setHistorySnapshotAt] = useState(0);
  const [unreadableRecord, setUnreadableRecord] = useState(null);
  const [sourceRevalidations, setSourceRevalidations] = useState({});
  const revalidateSources = useCallback(id => {
    if (id && !id.startsWith('pending-')) setSourceRevalidations(previous => ({ ...previous, [id]: (previous[id] || 0) + 1 }));
  }, []);
  const [online, setOnline] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingSend, setPendingSend] = useState(null);
  const sendInFlight = useRef(false);
  const [citation, setCitation] = useState(null);
  const citationGeneration = useRef(0);
  // An anchored citation (Inbox Source) opens beside its button; a second click closes it.
  const [citationAnchor, setCitationAnchor] = useState(null);
  const citationAnchorRef = useRef(null);
  // An anchored Source with several publications shows one at a time, paged from its header or its squares.
  const [citationPage, setCitationPage] = useState(0);
  const openCitation = useCallback((source, context) => {
    const anchor = context?.anchor || null;
    if (anchor && citationAnchorRef.current === anchor) {
      citationAnchorRef.current = null;
      setCitation(null);
      return;
    }
    citationAnchorRef.current = anchor;
    setCitationAnchor(anchor);
    setCitationPage(0);
    const generation = ++citationGeneration.current;
    const publications = citationPublications(source, context).map(publication => ({ ...publication,
      ...(publication.evidenceIncluded === false ? { evidenceLoading: true } : {}) }));
    setCitation(publications);
    void hydrateAnalystCapturedCitations(publications, {
      request: api.request,
      isCurrent: () => citationGeneration.current === generation,
      onResolved: resolved => setCitation(current => current?.map(publication => publication.id === resolved.id
        && publication.captureMessageId === resolved.captureMessageId ? resolved : publication) || null),
    });
  }, []);
  useEffect(() => { if (!citation) { citationGeneration.current += 1; citationAnchorRef.current = null; } }, [citation]);
  const citationSurface = useRef();
  useLayoutEffect(() => {
    const surface = citationSurface.current;
    if (!citation || !citationAnchor || !surface) return undefined;
    const card = citationAnchor.closest('.analyst-inbox-finding');
    card?.setAttribute('data-cited', '');
    // A docked popover sits centered beside the Analyst window, no taller than it, and ignores scrolling.
    const dock = () => {
      const analyst = surface.parentElement.getBoundingClientRect();
      const gap = 12;
      const margin = 8;
      const width = Math.min(DOCKED_SOURCE_WIDTH, analyst.left - gap - margin);
      if (width < DOCKED_SOURCE_MIN_WIDTH) return false;
      surface.classList.add('is-docked');
      surface.style.width = `${width}px`;
      surface.style.left = `${analyst.left - gap - width}px`;
      surface.style.maxHeight = `${analyst.height}px`;
      surface.style.top = `${analyst.top + (analyst.height - surface.offsetHeight) / 2}px`;
      return true;
    };
    const place = () => {
      // A dismissed alert takes its button with it, so its popover closes too.
      if (!citationAnchor.isConnected) { setCitation(null); return; }
      if (dock()) return;
      surface.classList.remove('is-docked');
      surface.style.width = '';
      const container = surface.offsetParent || surface.parentElement;
      const bounds = container.getBoundingClientRect();
      const button = citationAnchor.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      surface.style.maxHeight = '';
      const height = surface.offsetHeight;
      const below = button.bottom - bounds.top + gap;
      const roomBelow = bounds.height - margin - below;
      const roomAbove = button.top - bounds.top - gap - margin;
      // Below when it fits, else above; when neither fits, the roomier side, shortened to fit there.
      const under = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
      const room = under ? roomBelow : roomAbove;
      if (height > room) surface.style.maxHeight = `${Math.max(120, room)}px`;
      const top = under ? below : button.top - bounds.top - gap - Math.min(height, room);
      const left = Math.max(margin, Math.min(button.left - bounds.left, bounds.width - surface.offsetWidth - margin));
      surface.style.top = `${Math.max(margin, top)}px`;
      surface.style.left = `${left}px`;
    };
    place();
    // An original email arrives after the popover opens and makes it taller.
    const grown = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    for (const entry of surface.children) grown?.observe(entry);
    // Only the in-panel popover follows its button; the docked one holds still.
    const scrolled = () => { if (!surface.classList.contains('is-docked')) place(); };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      grown?.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', scrolled, true);
      card?.removeAttribute('data-cited');
      surface.classList.remove('is-docked');
      surface.style.top = '';
      surface.style.left = '';
      surface.style.width = '';
      surface.style.maxHeight = '';
    };
  }, [citation, citationAnchor, citationPage]);
  const pagedCitation = Boolean(citationAnchor && citation?.length > 1);
  const shownCitationPage = pagedCitation ? Math.min(citationPage, citation.length - 1) : 0;
  const turnCitationPage = step => setCitationPage(page => (page + step + citation.length) % citation.length);
  const { inbox, inboxError, loadInbox, acknowledge } = useAnalystInbox();
  const [refreshingIds, setRefreshingIds] = useState([]);
  // An unacknowledged review start survives a reload as the same Starting slot.
  const [restoredLaunches] = useState(() => savedLaunches().map(record => ({ ...reviewOpening(record), restored: true })));
  const [pendingReviews, setPendingReviews] = useState(() => Object.fromEntries(restoredLaunches.map(launch => [launch.id, launch])));
  const pendingReviewsRef = useRef(pendingReviews);
  pendingReviewsRef.current = pendingReviews;
  const launchingReview = pendingReviews[selected] || null;
  const launchesInFlight = useRef(null);
  if (!launchesInFlight.current) launchesInFlight.current = new Map(restoredLaunches.map(launch => [launch.launchKey, launch]));
  const sidebarReceipts = useRef(new Map(rows.map(row => [row.id, row])));
  // A second click on a restored start reuses its exact request reference.
  const reviewRequests = useRef(null);
  if (!reviewRequests.current) reviewRequests.current = new Map(restoredLaunches.map(launch => [launch.launchKey, launch.requestId]));
  const refreshInFlight = useRef(new Set());
  const transcript = useRef();
  const composer = useRef();
  const panel = useRef();
  const scrolls = useRef(saved('scrolls', {}));
  const scrollSaveTimer = useRef();
  const navigation = useRef(0);
  const pendingReviewScroll = useRef(null);
  const historicalScrollAnchor = useRef(null);
  const [unavailableCapturedBodies, setUnavailableCapturedBodies] = useState(() => new Set());
  const currentPrimaryPending = useRef(false);
  const holdCapturedHistory = useCallback(() => Boolean(pendingReviewScroll.current) || currentPrimaryPending.current, []);
  const pendingRequest = useRef(saved('outbox', null));
  const recoveredRequests = useRef(new Set());
  const recoveryReads = useRef(new Map());
  const [sendNote, setSendNote] = useState(null);
  const followReply = useRef(false);
  const removed = useRef(new Set());
  // Rows the user is deleting. Only the trash button adds to this set.
  const deleting = useRef(new Set());
  const deletedByEvent = useRef(new Set());
  const [deletingIds, setDeletingIds] = useState([]);
  const revalidateSelectedSources = useRef();
  useEffect(() => () => { clearTimeout(scrollSaveTimer.current); save('scrolls', scrolls.current); }, []);
  const forget = useCallback(id => {
    removed.current.add(id);
    compactBriefReads.current.delete(id);
    detailSnapshotCursors.current.delete(id);
    sidebarReceipts.current.delete(id);
    save('sidebar', [...sidebarReceipts.current.values()].map(sidebarMetadata).filter(Boolean));
    setPendingReviews(old => { const next = { ...old }; delete next[id]; return next; });
    setDeleteErrors(old => { if (!old[id]) return old; const next = { ...old }; delete next[id]; return next; });
    setRows(old => old.filter(row => row.id !== id));
    setEntities(old => { const next = { ...old }; delete next[id]; return next; });
    setDrafts(old => { const next = { ...old }; delete next[id]; save('drafts', next); return next; });
    delete scrolls.current[id]; save('scrolls', scrolls.current);
    if (pendingRequest.current?.conversationId === id) { pendingRequest.current = null; save('outbox', null); }
    if (selectedRef.current === id) { selectedRef.current = null; navigation.current += 1; setSelected(null); save('selected', null); setError(''); }
  }, []);
  const rememberSidebar = useCallback(conversation => {
    const metadata = sidebarMetadata(conversation);
    if (!metadata || removed.current.has(metadata.id)) return;
    const previous = sidebarReceipts.current.get(metadata.id);
    if ((previous?.revision || 0) > (metadata.revision || 0)) return;
    const next = { ...previous, ...metadata };
    // List metadata supplies the current state without turn objects. Do not
    // let a previous acceptance's turn overwrite that newer completed state.
    if (conversation.activeTurn === undefined && Object.prototype.hasOwnProperty.call(conversation, 'state')) {
      delete next.activeTurn;
      if (conversation.lastTurn === undefined) delete next.lastTurn;
    }
    sidebarReceipts.current.set(metadata.id, next);
    save('sidebar', [...sidebarReceipts.current.values()].map(sidebarMetadata).filter(Boolean));
  }, []);
  const update = useCallback((conversation) => {
    rememberSidebar(conversation);
    if (conversation?.id && !removed.current.has(conversation.id)) setEntities(old => {
      if ((old[conversation.id]?.revision || 0) > (conversation.revision || 0)) {
        return old;
      }
      let incoming = conversation;
      if (conversation.briefsIncluded === false) {
        const prior = new Map((old[conversation.id]?.messages || []).map(message => [message.id, message]));
        // Lightweight acceptance deliberately omits saved brief payloads.
        // Preserve only that marked omission for the same immutable message.
        incoming = { ...conversation, messages: conversation.messages.map(message => {
          const previous = prior.get(message.id);
          const brief = previous?.portfolioBrief;
          if (previous?.balancePrimary && previous.reviewRunId === message.reviewRunId
            && !Object.prototype.hasOwnProperty.call(message, 'balancePrimary')) return { ...message,
              text: message.text || previous.text, balancePrimary: previous.balancePrimary, balancePrimaryIncluded: false };
          if (message.reviewBodyIncluded === false) {
            const sameCapture = message.reviewRunId && previous?.reviewRunId === message.reviewRunId;
            return { ...message, text: sameCapture ? previous.text : '', citations: sameCapture ? previous.citations : [],
              ...(sameCapture && brief ? { portfolioBrief: brief } : {}) };
          }
          if (brief && !Object.prototype.hasOwnProperty.call(message, 'portfolioBrief')) return { ...message,
            portfolioBrief: brief, portfolioBriefIncluded: false };
          if (conversation.kind === 'portfolio-review' && message.role === 'assistant'
            && !Object.prototype.hasOwnProperty.call(message, 'portfolioBrief')
            && (message.reviewRunId || /^(daily-report|review-message):/.test(message.source_id || '')
              || message.text?.includes('<!-- analyst-daily-rollup -->'))) return { ...message, portfolioBriefIncluded: false };
          const sameReport = brief && brief.presentation !== 'compact' && message.portfolioBrief?.presentation === 'compact'
            && brief.runId && brief.runId === message.portfolioBrief.runId
            && brief.reportRevision != null && brief.reportRevision === message.portfolioBrief.reportRevision
            && brief.available === message.portfolioBrief.available;
          return sameReport ? { ...message, portfolioBrief: brief, citations: previous.citations } : message;
        }) };
      }
      const next = reuseAnalystEvidence(old[conversation.id], incoming);
      return next === old[conversation.id] ? old : { ...old, [conversation.id]: next };
    });
  }, [rememberSidebar]);
  const receiveSidebar = useCallback(conversation => {
    if (!conversation?.id || removed.current.has(conversation.id)) return;
    // Durable acceptance is enough to show a chat. A list response is only a
    // reconciliation, and an older in-flight snapshot cannot remove the receipt.
    rememberSidebar(conversation);
    setRows(old => {
      const others = old.filter(row => row.id !== conversation.id);
      return receiptInScope(conversation, sidebarScope.current) ? [conversation, ...others] : others;
    });
  }, [rememberSidebar]);
  const read = useCallback(async path => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await api.request(path); }
      catch (error) {
        if (!transientReadError(error) || attempt === 2 || !activeRef.current) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 450));
        if (!activeRef.current) throw error;
      }
    }
    return null;
  }, []);
  const load = useCallback((id, { invalidate = false, compactReview = false } = {}) => {
    const pending = loadsInFlight.current.get(id);
    if (pending) {
      if (invalidate) pending.again = true;
      if (compactReview) pending.compactReview = true;
      return pending.promise;
    }
    const entry = { again: false, compactReview, tailReconciled: false };
    loadsInFlight.current.set(id, entry);
    entry.promise = (async () => {
      let conversation;
      try {
        do {
          entry.again = false;
          try {
            const path = `/conversations/${encodeURIComponent(id)}`;
            const current = entitiesRef.current[id] || rowsRef.current.find(row => row.id === id);
            const portfolio = current?.kind === 'portfolio-review';
            const balance = current?.kind === 'balance-review';
            const compact = portfolio || balance || entry.compactReview || (refreshInFlight.current.has(id) || current?.briefsIncluded === false
              || current?.activeTurn || ['running', 'accepted'].includes(current?.state))
              && isReviewKind(current.kind);
            const payload = await read(`${path}${compact ? `?includeBriefs=false${portfolio || balance ? '&briefScope=latest' : ''}` : ''}`);
            if (Number.isSafeInteger(payload.cursor)) {
              detailSnapshotCursors.current.set(id, payload.cursor);
              if (!entry.tailReconciled && latestTailCursor.current !== null && payload.cursor < latestTailCursor.current) {
                entry.tailReconciled = true;
                entry.again = true;
              }
            }
            conversation = payload.conversation;
            if (conversation?.archived) {
              // Archived rows stay out of history, but their selection, draft
              // and reader position are never discarded as if deleted. This is
              // the server's answer, so it is not retried automatically.
              if (sidebarReceipts.current.delete(id)) save('sidebar', [...sidebarReceipts.current.values()].map(sidebarMetadata).filter(Boolean));
              setRows(old => old.filter(row => row.id !== id));
              if (selectedRef.current === id) setUnreadableRecord(id);
              return null;
            }
            update(conversation);
            if (compact && !portfolio && !balance && conversation?.briefsIncluded === false && !conversation.activeTurn
              && selectedRef.current === id && !removed.current.has(id)) {
              const full = await read(path);
              conversation = full.conversation;
              update(conversation);
            }
            setHistoryError('');
            setUnreadableRecord(current => current === id ? null : current);
            revalidateSources(id);
          } catch (e) {
            if (verifiedMissing(e)) { forget(id); return null; }
            if (!entry.again) throw e;
          }
        } while (entry.again && activeRef.current);
        return conversation;
      } finally { if (loadsInFlight.current.get(id) === entry) loadsInFlight.current.delete(id); }
    })();
    return entry.promise;
  }, [update, forget, read, revalidateSources]);
  const list = useCallback(({ invalidate = false } = {}) => {
    const path = `/conversations?q=${encodeURIComponent(query)}&archived=false`;
    const pending = listsInFlight.current.get(path);
    if (pending) {
      if (invalidate) pending.again = true;
      return pending.promise;
    }
    const entry = { again: false, tailReconciled: false };
    listsInFlight.current.set(path, entry);
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          const revision = ++listRevision.current.requested;
          const requestedAt = Date.now();
          try {
            const payload = await read(path);
            if (revision >= listRevision.current.applied) {
              listRevision.current.applied = revision;
              const received = payload.conversations.filter(row => !row.archived && !removed.current.has(row.id)).map(row => {
                const receipt = sidebarReceipts.current.get(row.id);
                if (!receipt || (row.revision || 0) >= (receipt.revision || 0)) {
                  const detail = entitiesRef.current[row.id];
                  rememberSidebar(detail && (detail.revision || 0) >= (row.revision || 0) ? detail : row);
                  return row;
                }
                return receipt;
              });
              const outstanding = [...sidebarReceipts.current.values()].filter(row => receiptInScope(row, sidebarScope.current) && !received.some(item => item.id === row.id));
              setRows(old => {
                const next = [...outstanding, ...received];
                // A row being deleted keeps its place until the server acknowledges.
                old.forEach((row, index) => {
                  if (!deleting.current.has(row.id)) return;
                  const at = next.findIndex(item => item.id === row.id);
                  if (at >= 0) next.splice(at, 1);
                  next.splice(Math.min(index, next.length), 0, row);
                });
                return next;
              });
              // The full list leaves out a saved row only once it is archived or
              // deleted, or before a fresh acceptance lands. Its own read tells
              // which, and only that answer evicts it.
              if (!query) outstanding.forEach(row => { if (!deleting.current.has(row.id)) void load(row.id).catch(() => {}); });
              setHistoryReadFailed(false);
              setHistoryError('');
              // A search result is not a complete history snapshot.
              if (!query) setHistorySnapshotAt(requestedAt);
            }
            // The list is the initial snapshot. Subscribe after its high-water
            // mark instead of replaying years of writes from a browser cursor.
            if (Number.isSafeInteger(payload.cursor) && payload.cursor >= 0) {
              historySnapshotCursor.current = payload.cursor;
              if (!entry.tailReconciled && latestTailCursor.current !== null && payload.cursor < latestTailCursor.current) {
                entry.tailReconciled = true;
                entry.again = true;
              }
            } else {
              // A missing snapshot marker cannot safely fall back to years of
              // browser history. Saved chats remain readable through GET.
              setHistoryError('History updates unavailable. Retry history.');
            }
          } catch (error) {
            setHistoryReadFailed(true);
            if (!entry.again) throw error;
          }
        } while (entry.again && activeRef.current);
      } finally {
        setHistoryLoaded(true);
        if (listsInFlight.current.get(path) === entry) listsInFlight.current.delete(path);
      }
    })();
    return entry.promise;
  }, [query, read, rememberSidebar, load]);
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    if (!active || online) { setReconnecting(false); return undefined; }
    const timer = setTimeout(() => setReconnecting(true), 4000);
    return () => clearTimeout(timer);
  }, [active, online]);
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer;
    let attempt = 0;
    // A cold API start can outlast the quick read retries. Keep reconciling
    // history with capped backoff while the Analyst is open.
    const attemptList = () => list().catch(e => {
      if (stopped) return;
      setHistoryError(e.message);
      if (recoverableRead(e)) timer = setTimeout(attemptList, recoveryDelay(attempt++));
    });
    timer = setTimeout(attemptList, firstList.current ? 0 : 150);
    firstList.current = false;
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, list]);
  useEffect(() => {
    if (!active) return undefined;
    const refresh = () => loadInbox().catch(() => {});
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [active, loadInbox]);
  useEffect(() => {
    if (!active) return undefined;
    // Invalidation events are replayable; they never carry content into the selected chat.
    // The server establishes the live high-water mark, independently of a
    // potentially unavailable history read. Reconnects retain Last-Event-ID.
    let stream;
    let observedCursor = 0;
    let cursorKnown = false;
    const dirty = new Set();
    let refreshing = false;
    let closed = false;
    let scheduled;
    let reopenTimer;
    let reopenAttempt = 0;
    let lastAncillaryRefresh = 0;
    let connected = true;
    let tailReady = false;
    const schedule = () => { if (!closed && !scheduled) scheduled = setTimeout(refresh, 80); };
    const refresh = async () => {
      scheduled = null;
      if (refreshing || closed || !dirty.size) return;
      refreshing = true;
      const ids = [...dirty]; dirty.clear();
      try {
        const conversationIds = ids.filter(Boolean);
        const results = await Promise.allSettled(conversationIds.map(id => load(id, { invalidate: true })));
        // Only a transport failure is retried on this two-second tick. A
        // code-less 404 belongs to the selected read's capped backoff.
        results.forEach((result, index) => { if (result.status === 'rejected' && transientReadError(result.reason || {})) dirty.add(conversationIds[index]); });
        // Sidebar and Inbox failures must not interrupt a healthy response.
        if (!closed && (Date.now() - lastAncillaryRefresh > 2000 || ids.includes(''))) {
          lastAncillaryRefresh = Date.now();
          void Promise.allSettled([listRef.current({ invalidate: true }), loadInbox({ invalidate: true })]);
        }
        if (dirty.size && results.every(result => result.status === 'fulfilled')) schedule();
      } finally { refreshing = false; }
    };
    // A non-200 response (a cold start, for example) closes an EventSource
    // for good. Recreate it with capped backoff, resuming after the last
    // observed event so old writes are never replayed.
    const reopen = () => {
      if (closed || reopenTimer) return;
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        if (closed) return;
        stream.close();
        open();
      }, recoveryDelay(reopenAttempt++));
    };
    const open = () => {
      const current = api.events(cursorKnown ? observedCursor : 'latest');
      stream = current;
      const live = () => !closed && stream === current;
      current.onmessage = event => {
        if (!live()) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.seq) || data.seq <= observedCursor
          || (data.conversation_id != null && typeof data.conversation_id !== 'string')) return;
        observedCursor = data.seq;
        cursorKnown = true;
        // EventSource carries Last-Event-ID for reconnects. Every new surface
        // subscription gets a fresh snapshot, so no synchronous browser write
        // is needed for each streamed chunk.
        connected = true;
        setOnline(true);
        const id = data.conversation_id;
        if (data.type === 'source-progress') {
          // Acquisition progress refreshes only the visible Sources table.
          if (id && id === selectedRef.current && !removed.current.has(id)) revalidateSelectedSources.current?.(id);
          return;
        }
        if (data.type === 'deleted') {
          // This window's own delete keeps its disabled row until acknowledged.
          if (deleting.current.has(id)) deletedByEvent.current.add(id);
          else forget(id);
          dirty.delete(id); dirty.add('');
        }
        else if (!removed.current.has(id)) {
          // An unopened chat needs a sidebar update, not a full transcript read.
          // Pending user submissions may need their durable receipt reconciled.
          if (id && (id === selectedRef.current || entitiesRef.current[id]?.activeTurn
            || [...launchesInFlight.current.values()].some(opening => !opening.accepted && !removed.current.has(opening.id))
            || pendingRequest.current?.conversationId === id
            || (pendingRequest.current && !pendingRequest.current.conversationId))) dirty.add(id);
          else dirty.add('');
        }
        schedule();
      };
      current.onopen = () => {
        if (!live()) return;
        connected = true;
        reopenAttempt = 0;
        setOnline(true);
        // Reads already in memory may predate the initial snapshot or reconnect.
        for (const [id, entity] of Object.entries(entitiesRef.current)) {
          if (entity.activeTurn && !removed.current.has(id)) dirty.add(id);
        }
        if (selectedRef.current && rowsRef.current.some(row => row.id === selectedRef.current)) dirty.add(selectedRef.current);
        revalidateSources(selectedRef.current);
        dirty.add('');
        schedule();
      };
      current.onerror = () => {
        if (!live()) return;
        connected = false;
        setOnline(false);
        if (current.readyState === EVENT_SOURCE_CLOSED) reopen();
      };
      current.addEventListener('ready', event => {
        if (!live()) return;
        reopenAttempt = 0;
        try {
          const data = JSON.parse(event.data);
          if (Number.isSafeInteger(data.cursor) && data.cursor >= 0) {
            observedCursor = Math.max(observedCursor, data.cursor);
            cursorKnown = true;
            if (!tailReady) {
              tailReady = true;
              latestTailCursor.current = data.cursor;
              // A list/read that began before the tail handshake may have missed
              // writes in between. Reconcile once against its actual snapshot.
              if (!listsInFlight.current.size && (historySnapshotCursor.current ?? -1) < data.cursor) dirty.add('');
              const id = selectedRef.current;
              revalidateSources(id);
              if (id && !id.startsWith('pending-') && !loadsInFlight.current.has(id) && (detailSnapshotCursors.current.get(id) ?? -1) < data.cursor) dirty.add(id);
              schedule();
            }
          }
        } catch { /* Older ready heartbeats do not carry a cursor. */ }
        if (!connected) {
          if (selectedRef.current && !selectedRef.current.startsWith('pending-')) dirty.add(selectedRef.current);
          revalidateSources(selectedRef.current);
          dirty.add('');
          schedule();
        }
        connected = true;
        setOnline(true);
      });
      current.addEventListener('unavailable', () => { if (live()) { connected = false; setOnline(false); } });
    };
    open();
    // Also reconcile the selected response when the event stream is interrupted.
    const timer = setInterval(() => {
      if (stream.readyState === EVENT_SOURCE_CLOSED) reopen();
      if (!connected && selectedRef.current && entitiesRef.current[selectedRef.current]?.activeTurn) dirty.add(selectedRef.current);
      refresh();
    }, 2000);
    return () => { closed = true; clearInterval(timer); clearTimeout(scheduled); clearTimeout(reopenTimer); stream.close(); };
  }, [active, load, loadInbox, forget, revalidateSources]);
  useEffect(() => {
    if (!active || !historyLoaded || !selected || selected.startsWith('pending-review:')
      || refreshInFlight.current.has(selected)) return undefined;
    let stopped = false;
    let timer;
    let attempt = 0;
    // Keep the receipt, draft and reader position while the server is
    // unreachable, and retry until it answers or verifies a deletion.
    const attemptLoad = () => load(selected).catch(e => {
      if (stopped || selectedRef.current !== selected) return;
      setHistoryError(e.message);
      setUnreadableRecord(selected);
      if (recoverableRead(e)) timer = setTimeout(attemptLoad, recoveryDelay(attempt++));
    });
    attemptLoad();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, historyLoaded, selected, load, refreshingIds]);
  useEffect(() => { if (!active) setCitation(null); }, [active]);
  useEffect(() => {
    if (!active || !citation) return undefined;
    // The dashboard backdrop owns closing the Analyst window. Only dismiss
    // this popup here, and let the original click continue to its destination.
    const dismiss = event => {
      if (citationSurface.current?.contains(event.target) || citationAnchorRef.current?.contains(event.target)) return;
      setCitation(null);
    };
    document.addEventListener('click', dismiss, true);
    return () => document.removeEventListener('click', dismiss, true);
  }, [active, citation]);
  useEffect(() => { if (!active) return undefined; const escape = e => { if (e.key === 'Escape') onClose?.(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [active, onClose]);
  const choose = useCallback(id => { navigation.current += 1; pendingReviewScroll.current = null; followReply.current = false; selectedRef.current = id; setSelected(id); save('selected', id); setError(''); }, []);
  const acceptReviewLaunch = useCallback((opening, opened) => {
    if (!opened?.id || opening.accepted || removed.current.has(opening.id)) return false;
    opening.accepted = opened.id;
    forgetLaunch(opening.requestId);
    // A restored start has no POST of its own to release its launch slot.
    if (opening.restored && launchesInFlight.current.get(opening.launchKey) === opening) launchesInFlight.current.delete(opening.launchKey);
    if (reviewRequests.current.get(opening.launchKey) === opening.requestId) reviewRequests.current.delete(opening.launchKey);
    if (Array.isArray(opened.messages)) update(opened);
    receiveSidebar(opened);
    setPendingReviews(old => { const next = { ...old }; delete next[opening.id]; return next; });
    if (selectedRef.current === opening.id) {
      const priorMessages = opened.activeTurn ? entitiesRef.current[opened.id]?.messages || opened.messages : [];
      if (sourcesAnchoredReview(opening.kind)) {
        scrolls.current[opened.id] = scrolls.current[opening.id] || 0;
        save('scrolls', scrolls.current);
      }
      choose(opened.id);
      if (!sourcesAnchoredReview(opening.kind)) pendingReviewScroll.current = {
        conversationId: opened.id, navigation: navigation.current,
        messageIds: new Set((priorMessages || []).map(message => message.id)), turnId: opened.activeTurn?.id,
      };
    }
    return true;
  }, [choose, receiveSidebar, update]);
  useLayoutEffect(() => {
    // A durable event or sidebar snapshot may arrive before the start POST.
    // Bind that exact request now so the local shell never becomes a second chat.
    for (const opening of launchesInFlight.current.values()) {
      if (opening.accepted) continue;
      const receipt = [...Object.values(entities), ...rows].find(row => acceptedReviewLaunch(row, opening));
      if (receipt) acceptReviewLaunch(opening, receipt);
    }
  }, [entities, rows, acceptReviewLaunch]);
  const dropRestoredLaunch = useCallback((opening, fallbackId = null) => {
    if (launchesInFlight.current.get(opening.launchKey) === opening) launchesInFlight.current.delete(opening.launchKey);
    if (reviewRequests.current.get(opening.launchKey) === opening.requestId) reviewRequests.current.delete(opening.launchKey);
    forgetLaunch(opening.requestId);
    setPendingReviews(old => { if (old[opening.id] !== opening) return old; const next = { ...old }; delete next[opening.id]; return next; });
    if (selectedRef.current === opening.id) { choose(fallbackId); return true; }
    return false;
  }, [choose]);
  // After a reload, history and live events reconcile a restored start by its
  // exact request ID (the conversation's reviewRequestId). Request lookups only
  // know turn IDs, so they cannot confirm a review start.
  const restoredLaunchKey = Object.values(pendingReviews).filter(opening => opening.restored && !opening.accepted)
    .map(opening => `${opening.id}@${opening.created_at}`).join('|');
  useEffect(() => {
    if (!active || !restoredLaunchKey) return undefined;
    // Read history once the start budget has passed, with capped backoff while
    // it is unavailable; that snapshot settles a start that never landed.
    const due = Math.min(...Object.values(pendingReviewsRef.current).filter(opening => opening.restored && !opening.accepted)
      .map(opening => Date.parse(opening.created_at) + LAUNCH_START_BUDGET_MS));
    let stopped = false;
    let timer;
    let attempt = 0;
    const check = () => listRef.current({ invalidate: true }).catch(() => {
      if (!stopped) timer = setTimeout(check, recoveryDelay(attempt++));
    });
    timer = setTimeout(check, Math.max(0, due - Date.now()));
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, restoredLaunchKey]);
  useEffect(() => {
    // A start is accepted within its budget or not at all. A history snapshot
    // requested after that budget without its exact request was never accepted,
    // or its chat was deleted elsewhere.
    for (const opening of Object.values(pendingReviewsRef.current)) {
      if (!opening.restored || opening.accepted || removed.current.has(opening.id)
        || historySnapshotAt < Date.parse(opening.created_at) + LAUNCH_START_BUDGET_MS
        || [...Object.values(entitiesRef.current), ...rowsRef.current].some(row => acceptedReviewLaunch(row, opening))) continue;
      // Today's review of this kind may already be running. Open it, exactly
      // as a repeated click would; otherwise ask for a new start.
      const running = rowsRef.current.find(row => !row.archived && row.kind === opening.kind && row.trading_date === opening.trading_date
        && !removed.current.has(row.id) && (entitiesRef.current[row.id]?.activeTurn || ['running', 'accepted'].includes(row.state)));
      if (dropRestoredLaunch(opening, running?.id) && !running) setError('Couldn’t confirm the review start. Start it again.');
    }
  }, [historySnapshotAt, dropRestoredLaunch]);
  useEffect(() => {
    // An unconfirmed restored start expires instead of staying Starting forever.
    const restored = Object.values(pendingReviews).filter(opening => opening.restored && !opening.accepted);
    if (!restored.length) return undefined;
    const expiresAt = Math.min(...restored.map(opening => Date.parse(opening.created_at) + LAUNCH_TTL_MS));
    const timer = setTimeout(() => {
      for (const opening of restored) {
        if (opening.accepted || Date.parse(opening.created_at) + LAUNCH_TTL_MS > Date.now()) continue;
        if (dropRestoredLaunch(opening)) setError('Couldn’t confirm the review start. Start it again.');
      }
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingReviews, dropRestoredLaunch]);
  useEffect(() => {
    // Retained windows preserve the selected chat and its reader position.
    // Invalidate pending navigation so a late acknowledgment cannot move it.
    if (!active) { latestTailCursor.current = null; navigation.current += 1; }
  }, [active]);
  // One click permanently deletes a saved chat. Only the trash button calls
  // this; nothing deletes a chat automatically. A Starting… row has no saved
  // chat yet, so its trash button waits until the server accepts the start.
  const deleteConversation = async id => {
    if (deleting.current.has(id) || removed.current.has(id) || pendingReviewsRef.current[id]) return;
    const clickedAt = Date.now();
    deleting.current.add(id);
    deletedByEvent.current.delete(id);
    setDeletingIds([...deleting.current]);
    setDeleteErrors(old => { if (!old[id]) return old; const next = { ...old }; delete next[id]; return next; });
    // Keep the row in place as a disabled Deleting… row until the server
    // acknowledges, and retain the transcript and draft until it commits.
    const wasSelected = selectedRef.current === id;
    if (wasSelected) choose(null);
    const nav = navigation.current;
    const deleted = async () => {
      // A repeated click must land on this disabled row, never on the next one.
      const hold = clickedAt + DELETE_ROW_HOLD_MS - Date.now();
      if (hold > 0) await new Promise(resolve => setTimeout(resolve, hold));
      forget(id);
    };
    try {
      await api.request(`/conversations/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await deleted();
    } catch {
      // The durable delete may have committed before its acknowledgment was lost.
      // Reconcile with the server before claiming the conversation is still saved.
      if (removed.current.has(id)) return;
      if (deletedByEvent.current.has(id)) { await deleted(); return; }
      let stillSaved = false;
      try {
        const response = await api.request(`/conversations/${encodeURIComponent(id)}`);
        if (response.conversation?.id === id) { stillSaved = true; update(response.conversation); }
      } catch (verificationError) {
        if (verifiedMissing(verificationError) || verificationError.code === 'HTTP_404') { await deleted(); return; }
      }
      if (removed.current.has(id)) return;
      if (deletedByEvent.current.has(id)) { await deleted(); return; }
      if (wasSelected && navigation.current === nav) choose(id);
      setDeleteErrors(old => ({ ...old, [id]: stillSaved ? 'Not deleted' : 'Delete unconfirmed' }));
    } finally {
      deleting.current.delete(id);
      deletedByEvent.current.delete(id);
      setDeletingIds([...deleting.current]);
    }
  };
  const draftKey = selected || 'landing';
  const draft = drafts[draftKey] || '';
  const editDraft = (key, value) => { const next = { ...draftsRef.current, [key]: value }; draftsRef.current = next; setDrafts(next); save('drafts', next); };
  const receiveSubmission = useCallback((request, accepted, nav) => {
    if (!accepted?.id) return;
    update(accepted);
    receiveSidebar(accepted);
    setSendNote(current => current?.requestId === request.requestId ? null : current);
    if (pendingRequest.current?.requestId === request.requestId) { pendingRequest.current = null; save('outbox', null); }
    if (selectedRef.current === request.conversationId) setError('');
    const key = request.conversationId || 'landing';
    const next = { ...draftsRef.current };
    if (next[key]?.trim() === request.text) next[key] = '';
    if (nav !== undefined && navigation.current === nav && selectedRef.current === request.conversationId) {
      if (accepted.id !== request.conversationId) {
        if (next[key] && !next[accepted.id]) { next[accepted.id] = next[key]; next[key] = ''; }
        choose(accepted.id);
        followReply.current = !sourcesAnchoredReview(accepted.kind);
      }
      setError('');
    }
    draftsRef.current = next; setDrafts(next); save('drafts', next);
  }, [choose, receiveSidebar, update]);
  const recoverRequest = useCallback(request => {
    const existing = recoveryReads.current.get(request.requestId);
    if (existing) return existing;
    const read = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const result = await api.request(`/requests/${encodeURIComponent(request.requestId)}`);
            if (result.status === 'accepted' && result.conversation?.id
              && result.turn?.request_id === request.requestId) return result.conversation;
            if (result.status === 'deleted') {
              if (pendingRequest.current?.requestId === request.requestId) { pendingRequest.current = null; save('outbox', null); }
              if (request.conversationId) forget(request.conversationId);
            }
            return null;
          } catch (error) {
            const transient = !error.code || error.code === 'ANALYST_REQUEST_TIMEOUT' || /^HTTP_(?:408|429|5\d\d)$/.test(error.code);
            if (!transient || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 450));
          }
        }
        return null;
      } finally { recoveryReads.current.delete(request.requestId); }
    })();
    recoveryReads.current.set(request.requestId, read);
    return read;
  }, [forget]);
  // A message that did not go through is an unsent draft: it goes back in the
  // composer with its reason, and sending it again reuses its request ID, so
  // the server returns the original if it did arrive.
  const noteUnsent = useCallback((request, label) => {
    const key = request.conversationId || 'landing';
    if (!draftsRef.current[key]?.trim()) {
      const next = { ...draftsRef.current, [key]: request.text };
      draftsRef.current = next; setDrafts(next); save('drafts', next);
    }
    setSendNote({ ...request, label, separate: draftsRef.current[key].trim() !== request.text });
  }, []);
  const settleMissingRequest = useCallback(request => {
    noteUnsent(request, 'Not sent');
    // Say so once. The request ID stays for a late arrival, without reopening
    // this on every reload or restoring a draft the user has since cleared.
    if (pendingRequest.current?.requestId === request.requestId) {
      pendingRequest.current = { ...pendingRequest.current, settled: true };
      save('outbox', pendingRequest.current);
    }
  }, [noteUnsent]);
  const failRequestConfirmation = useCallback(request => noteUnsent(request, 'Delivery unconfirmed'), [noteUnsent]);
  useEffect(() => {
    const request = pendingRequest.current;
    if (!active || !request || request.settled || sendInFlight.current || recoveredRequests.current.has(request.requestId)) return;
    recoveredRequests.current.add(request.requestId);
    const nav = navigation.current;
    void recoverRequest(request).then(accepted => {
      if (accepted) receiveSubmission(request, accepted, nav);
      else settleMissingRequest(request);
    }).catch(() => failRequestConfirmation(request));
  }, [active, failRequestConfirmation, receiveSubmission, recoverRequest, settleMissingRequest]);
  useLayoutEffect(() => {
    const pending = pendingRequest.current;
    const accepted = acceptedConversation(entities, pending);
    if (!accepted) return;
    // The durable event may arrive after a lost HTTP response, or after a reload.
    // Reconcile that receipt without wiping a newer question or resending anything.
    // Do this before paint so the restored retry draft never shares a visible
    // frame with the server's accepted message.
    receiveSubmission(pending, accepted, pendingSend?.navigation);
  }, [entities, pendingSend, receiveSubmission]);
  const conversation = entities[selected];
  // A history-wide success must not hide this conversation's own failed read.
  const recordUnavailable = !conversation && Boolean(selected) && (Boolean(historyError) || unreadableRecord === selected);
  const selectedRow = rows.find(row => row.id === selected);
  const selectedKind = conversation?.kind || selectedRow?.kind;
  const isReview = isReviewKind(selectedKind);
  const sourceMessage = conversation?.messages.findLast(message => message.reviewRunId || message.portfolioBrief?.runId || /^(daily-report|review-message):/.test(message.source_id || ''));
  const primaryReady = balancePrimaryReady(conversation) || (selectedKind === 'portfolio-review' && sourceMessage?.portfolioBrief?.available === true
    && sourceMessage.portfolioBriefIncluded !== false && sourceMessage.reviewRunId === sourceMessage.portfolioBrief.runId
    && (sourceMessage.turn_id === conversation?.activeTurn?.id || sourceMessage.reviewRunId === conversation?.reviewRunId));
  currentPrimaryPending.current = selectedKind === 'portfolio-review' && Boolean(conversation?.activeTurn) && !primaryReady;
  const reference = conversation?.referenceReview;
  const referenceObserved = reference?.asOf && formatAnalystReportDate(reference.asOf);
  const latestBriefIndex = conversation?.kind === 'portfolio-review' ? conversation.messages.findLastIndex(message => message.portfolioBrief) : -1;
  const availableBriefIndex = conversation?.kind === 'portfolio-review' ? conversation.messages.findLastIndex(message => message.portfolioBrief?.available === true) : -1;
  const briefIndex = availableBriefIndex >= 0 ? availableBriefIndex : latestBriefIndex;
  const messages = useMemo(() => balanceReviewMessages(analystReviewMessages(conversation), conversation?.kind), [conversation]);
  const portfolioBrief = conversation?.messages[briefIndex]?.portfolioBrief;
  const renderedRecords = useRef(new WeakMap());
  const renderedMessages = useMemo(() => (messages?.filter(message => !message.reviewNarrative || (!portfolioBrief && conversation?.kind !== 'prediction-markets-review')) || []).map(message => {
    const prior = renderedRecords.current.get(message);
    if (prior && prior.reference === reference) return prior.rendered;
    const rendered = { ...message, streaming: message.state === 'running' && !message.portfolioBrief && !capturedBalancePrimary(message), ...(message.portfolioBrief ? { portfolioBrief: { ...message.portfolioBrief, reference } } : {}) };
    renderedRecords.current.set(message, { reference, rendered });
    return rendered;
  }), [messages, portfolioBrief, conversation?.kind, reference]);
  const newestPortfolioPost = renderedMessages.findLast(message => message.role === 'assistant' && message.portfolioBrief);
  const receiveCapturedBody = useCallback((id, expected, body) => {
    if (removed.current.has(id)) return;
    if (selectedRef.current === id && transcript.current) {
      const box = transcript.current.getBoundingClientRect();
      const anchor = [...transcript.current.querySelectorAll('[data-message-id]')].find(node => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      });
      if (anchor) historicalScrollAnchor.current = { id, navigation: navigation.current,
        messageId: anchor.getAttribute('data-message-id'), top: anchor.getBoundingClientRect().top };
    }
    setEntities(old => {
      const existing = old[id];
      if (!existing) return old;
      const index = existing.messages.findIndex(message => message.id === expected.id && message.reviewRunId === expected.reviewRunId);
      if (index < 0 || existing.messages[index].portfolioBrief) return old;
      const captured = { ...existing.messages[index], text: body.text, citations: body.citations,
        portfolioBrief: body.portfolioBrief, reviewBodyIncluded: true,
        ...(body.reviewStatusLine ? { reviewStatusLine: body.reviewStatusLine } : {}) };
      const messages = existing.messages.slice(); messages[index] = captured;
      return { ...old, [id]: { ...existing, messages } };
    });
  }, []);
  const capturedBodyUnavailable = useCallback((id, expected) => {
    const key = `${id}:${expected.id}:${expected.reviewRunId}`;
    setUnavailableCapturedBodies(old => old.has(key) ? old : new Set([...old, key]));
  }, []);
  useAnalystCapturedHistory({ active, conversationId: selected, messages: renderedMessages, transcript,
    hold: holdCapturedHistory, onCapturedBody: receiveCapturedBody, onCapturedUnavailable: capturedBodyUnavailable });
  useAnalystReportContainment({ active, transcript, messages: renderedMessages });
  const latestBriefMessage = conversation?.messages[latestBriefIndex];
  const unavailableRefresh = latestBriefIndex > briefIndex
    && ['complete', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(latestBriefMessage?.reviewState || latestBriefMessage?.state);
  const hasBrief = Boolean(portfolioBrief);
  const portfolioPresentation = hasBrief || conversation?.kind === 'portfolio-review'
    || rows.find(row => row.id === selected)?.kind === 'portfolio-review' || launchingReview?.kind === 'portfolio-review';
  const running = Boolean(conversation?.activeTurn);
  const selectedSend = pendingSend && pendingSend.conversationId === selected && (selected || pendingSend.navigation === navigation.current) ? pendingSend : null;
  const acceptedPendingTurn = selectedSend && [conversation?.activeTurn, conversation?.lastTurn].find(turn => turn?.request_id === selectedSend.requestId);
  const optimisticMessage = selectedSend && !acceptedPendingTurn ? selectedSend.message : null;
  const responsePending = running || Boolean(selectedSend && !acceptedPendingTurn);
  const reviewBusy = isReview && (!conversation || (running && !primaryReady) || refreshingIds.includes(selected));
  // Portfolio and Predictive reviews refresh in place from the bar above Sources, dated by the report it shows.
  const refreshable = sourcesAnchoredReview(selectedKind) && Boolean(conversation) && !launchingReview;
  const snapshotAt = reference?.asOf || messages.findLast(message => message.role === 'assistant' && message.reviewPostId)?.created_at;
  // Sources wait for the conversation record, then poll on its ID alone if
  // that read fails: reserved rows never stay Checking with nothing reading.
  const reviewSources = useAnalystReviewSources({ conversationId: isReview ? selected : null,
    reviewKind: selectedKind,
    turnId: conversation?.activeTurn?.id || conversation?.lastTurn?.id,
    captureId: reference?.runId || sourceMessage?.reviewRunId || sourceMessage?.portfolioBrief?.runId || sourceMessage?.source_id,
    active: active && Boolean(conversation || unreadableRecord === selected), running, refreshing: refreshingIds.includes(selected),
    revalidationKey: sourceRevalidations[selected] || 0 });
  revalidateSelectedSources.current = reviewSources.revalidate;
  // Model work (Balance's summary) follows settled Sources; keep its phase in
  // the same header progress cell.
  const summarizing = running && conversation?.reviewPhase === 'summarizing';
  const sourcesPhase = summarizing ? reviewPhaseLabel('summarizing')
    : reviewBusy ? refreshingIds.includes(selected) ? 'Starting…' : reviewPhaseLabel(conversation?.reviewPhase) || 'Checking…' : undefined;
  const balanceCaptureId = selectedKind === 'balance-review' ? conversation?.reviewRunId : null;
  useEffect(() => {
    if (!active || !running || selectedKind !== 'balance-review' || !balanceCaptureId || primaryReady) return undefined;
    let stopped = false;
    let timer;
    const readPrimary = async () => {
      if (stopped || selectedRef.current !== selected || removed.current.has(selected)) return;
      try {
        const current = await load(selected, { compactReview: true });
        if (!current || (current.reviewRunId === balanceCaptureId && (!current.activeTurn || balancePrimaryReady(current)))) return;
      } catch { /* A transient read can retry within this same active capture. */ }
      if (!stopped && selectedRef.current === selected && !removed.current.has(selected)) timer = setTimeout(readPrimary, 750);
    };
    void readPrimary();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, running, selectedKind, selected, balanceCaptureId, primaryReady, load]);
  useEffect(() => {
    if (!active || !running || conversation?.kind !== 'portfolio-review' || !sourceMessage?.reviewRunId) return;
    const capture = sourceMessage.reviewRunId;
    if (sourceMessage.turn_id !== conversation.activeTurn.id && capture !== conversation.reviewRunId) return;
    const sources = reviewSources.sources;
    const core = (sources?.items || []).filter(source => ['portfolio', 'portfolioBalance'].includes(source.id));
    const bookSettled = sources?.conversationId === selected && sources.runId === capture
      && core.some(source => source.id === 'portfolio' && ['ready', 'partial'].includes(source.status));
    const omitted = sourceMessage.portfolioBriefIncluded === false
      && Boolean(sourceMessage.portfolioBrief || sourceMessage.text?.trim());
    if (!omitted && !(bookSettled && sourceMessage.portfolioBrief?.available !== true)) return;
    // A metadata receipt preserves the last captured presentation for display,
    // but cannot certify it as the latest primary. Settled captured book evidence
    // can request it while Balance and independent research remain in flight;
    // the server still verifies whether the exact primary is available.
    const evidence = core.map(source => [source.id, source.status, source.observedAt, source.fingerprint]);
    const revision = omitted ? [sourceMessage.state, sourceMessage.reviewState, sourceMessage.text] : evidence;
    const key = `${sourceMessage.id}:${capture}:${sourceMessage.portfolioBrief?.reportRevision}:${JSON.stringify(revision)}`;
    if (compactBriefReads.current.get(selected) === key) return;
    compactBriefReads.current.set(selected, key);
    void load(selected, { invalidate: true, compactReview: true }).catch(() => {});
  }, [active, running, selected, conversation, sourceMessage, reviewSources.sources, load]);
  const hasConversation = Boolean(conversation);
  const emptyDailyChat = conversation?.kind === 'daily-chat' && conversation.messages.length === 0 && !running;
  useEffect(() => { if (emptyDailyChat) composer.current?.focus(); }, [selected, emptyDailyChat]);
  useLayoutEffect(() => { if (active && transcript.current) transcript.current.scrollTop = scrolls.current[selected || 'landing'] || 0; }, [active, selected, hasConversation]);
  useLayoutEffect(() => {
    const anchor = historicalScrollAnchor.current;
    historicalScrollAnchor.current = null;
    if (!anchor || anchor.id !== selected || anchor.navigation !== navigation.current || !transcript.current) return;
    const node = [...transcript.current.querySelectorAll('[data-message-id]')].find(target => target.getAttribute('data-message-id') === anchor.messageId);
    if (node) transcript.current.scrollTop += node.getBoundingClientRect().top - anchor.top;
  }, [selected, renderedMessages]);
  useLayoutEffect(() => {
    if (sourcesAnchoredReview(selectedKind)) { followReply.current = false; return; }
    if (!followReply.current || !transcript.current) return;
    transcript.current.scrollTop = transcript.current.scrollHeight;
    if (!responsePending) followReply.current = false;
  }, [renderedMessages, optimisticMessage, responsePending, selectedKind]);
  useLayoutEffect(() => {
    const pending = pendingReviewScroll.current;
    if (!pending) return;
    // Sources are part of the review. Populate the report below them without
    // moving the viewport when its acceptance, body, or completion arrives.
    if (sourcesAnchoredReview(selectedKind)) { pendingReviewScroll.current = null; return; }
    if (pending.conversationId !== selected || pending.navigation !== navigation.current) {
      pendingReviewScroll.current = null;
      return;
    }
    if (launchingReview || pending.awaitingAcceptance || !transcript.current) return;
    const index = renderedMessages.findLastIndex(message => message.role === 'assistant'
      && (conversation?.kind === 'portfolio-review' || capturedBalancePrimary(message) || message.state === 'reviewing' || ['complete', 'succeeded'].includes(message.reviewState || message.state))
      && (!pending.messageIds.has(message.id) || (pending.turnId && message.turn_id === pending.turnId))
      && (conversation?.kind === 'portfolio-review' || Boolean(message.text?.trim())));
    if (index < 0) {
      if (['failed', 'interrupted', 'cancelled'].includes(conversation?.lastTurn?.state)) pendingReviewScroll.current = null;
      return;
    }
    // Bind to the initial report shell once. Later source arrivals update its
    // reserved sections without scrolling away from what the user is reading.
    const target = [...transcript.current.querySelectorAll('[data-message-id]')]
      .find(node => node.getAttribute('data-message-id') === renderedMessages[index].id);
    if (!target) return;
    pendingReviewScroll.current = null;
    transcript.current.scrollTop = Math.max(0, transcript.current.scrollTop + target.getBoundingClientRect().top - transcript.current.getBoundingClientRect().top);
    scrolls.current[selected] = transcript.current.scrollTop;
    save('scrolls', scrolls.current);
  }, [selected, selectedKind, conversation, renderedMessages, running, launchingReview]);
  const submit = async retryText => {
    const rawDraft = draftsRef.current[draftKey] || '';
    const retry = typeof retryText === 'string';
    const text = retry ? retryText : rawDraft.trim();
    const clearSubmittedDraft = !retry || rawDraft.trim() === text;
    if (!text || sendInFlight.current || sending || running || launchingReview) return;
    const owner = selected;
    const key = owner || 'landing';
    const nav = navigation.current;
    const pending = pendingRequest.current;
    const requestId = pending?.text === text && pending?.conversationId === owner ? pending.requestId : crypto.randomUUID();
    const submission = { text, conversationId: owner, requestId };
    pendingRequest.current = submission;
    save('outbox', pendingRequest.current);
    sendInFlight.current = true;
    setPendingSend({ ...pendingRequest.current, navigation: nav, message: { id: `pending:${requestId}`, role: 'user', text } });
    if (clearSubmittedDraft) editDraft(key, '');
    followReply.current = true;
    setSending(true); setError(''); setSendNote(null);
    composer.current?.focus();
    const accept = accepted => {
      receiveSubmission(submission, accepted, nav);
      void listRef.current({ invalidate: true }).catch(() => {});
    };
    let confirmationPending = false;
    try {
      const response = await api.request('/messages', submission);
      accept(response.conversation);
    } catch (e) {
      const confirmed = acceptedConversation(entitiesRef.current, submission) || await recoverRequest(submission).catch(() => {
        confirmationPending = true;
        failRequestConfirmation(submission);
        return null;
      });
      if (confirmed) accept(confirmed);
      else {
        if (clearSubmittedDraft && !draftsRef.current[key]) editDraft(key, rawDraft);
        if (!confirmationPending) noteUnsent(submission, sendFailureLabel(e));
      }
    }
    finally {
      sendInFlight.current = false; setSending(false); setPendingSend(null);
    }
  };
  const launch = async (kind, options = {}) => {
    const key = `${kind}:${options.conversationId || ''}`;
    const prior = launchesInFlight.current.get(key);
    // A start restored after a reload has no request in flight; a second click
    // resends its exact request ID, which the server accepts at most once.
    if (prior && !prior.restored) { if (!removed.current.has(prior.id)) choose(prior.accepted || prior.id); return prior.promise; }
    const requestId = options.requestId || reviewRequests.current.get(key) || `review-start:${crypto.randomUUID()}`;
    reviewRequests.current.set(key, requestId);
    const startedAt = new Date();
    const opening = reviewOpening({ kind, requestId, launchKey: key, startedAt: prior?.requestId === requestId ? prior.created_at : startedAt.toISOString(),
      tradingDate: prior?.requestId === requestId ? prior.trading_date : pacificDate(startedAt) });
    launchesInFlight.current.set(key, opening);
    setPendingReviews(old => ({ ...old, [opening.id]: opening }));
    if (!options.conversationId) rememberLaunch(opening);
    choose(opening.id);
    opening.promise = (async () => {
      try {
        const response = await api.request(`/daily/${kind}`, { ...options, requestId });
        acceptReviewLaunch(opening, response.conversation);
        // History failure cannot turn a durably accepted run into a failed start.
        void listRef.current({ invalidate: true }).catch(() => {});
      }
      catch (e) {
        const receipt = [...Object.values(entitiesRef.current), ...rowsRef.current].find(row => acceptedReviewLaunch(row, opening));
        if (receipt) acceptReviewLaunch(opening, receipt);
        if (!opening.accepted && selectedRef.current === opening.id) { choose(null); setError(e.message); }
      }
      finally {
        forgetLaunch(opening.requestId);
        setPendingReviews(old => { const next = { ...old }; delete next[opening.id]; return next; });
        if (launchesInFlight.current.get(key) === opening) launchesInFlight.current.delete(key);
      }
    })();
    return opening.promise;
  };
  const refreshReview = async row => {
    const id = row.id;
    if (retiredReviewKinds.includes(row.kind) || refreshInFlight.current.has(id) || entities[id]?.activeTurn || ['running', 'accepted'].includes(row.state)) return;
    const requestId = reviewRequests.current.get(id) || `review-refresh:${crypto.randomUUID()}`;
    reviewRequests.current.set(id, requestId);
    refreshInFlight.current.add(id);
    setRefreshingIds([...refreshInFlight.current]);
    if (!sourcesAnchoredReview(row.kind)) {
      scrolls.current[id] = 0;
      if (transcript.current) transcript.current.scrollTop = 0;
    }
    choose(id);
    const nav = navigation.current;
    const scrollRequest = { conversationId: id, navigation: nav,
      messageIds: new Set((entities[id]?.messages || []).map(message => message.id)), awaitingAcceptance: !entities[id] };
    pendingReviewScroll.current = scrollRequest;
    try {
      const response = await api.request(`/daily/${row.kind}`, { refresh: true, conversationId: id, requestId });
      if (pendingReviewScroll.current === scrollRequest) {
        scrollRequest.turnId = response.conversation.activeTurn?.id;
        if (scrollRequest.awaitingAcceptance && response.conversation.activeTurn) scrollRequest.messageIds = new Set(response.conversation.messages.map(message => message.id));
        scrollRequest.awaitingAcceptance = false;
      }
      update(response.conversation);
      reviewRequests.current.delete(id);
      // Sidebar availability cannot turn an accepted review into a failure.
      void listRef.current({ invalidate: true }).catch(() => {});
    } catch (e) {
      if (pendingReviewScroll.current === scrollRequest) pendingReviewScroll.current = null;
      if (navigation.current === nav) setError(e.message);
    }
    finally { refreshInFlight.current.delete(id); setRefreshingIds([...refreshInFlight.current]); }
  };
  const retryResponse = async () => {
    if (!terminalError?.request_id?.startsWith('daily-narrative:') && !terminalError?.request_id?.startsWith('narrative-retry:')) {
      return isReview ? refreshReview(conversation) : submit(lastPrompt);
    }
    const id = conversation.id;
    const nav = navigation.current;
    setSending(true); setError('');
    try {
      const response = await api.request(`/conversations/${id}/turns/${terminalError.id}/retry`, { requestId: `narrative-retry:${crypto.randomUUID()}` });
      update(response.conversation);
      if (conversation.kind === 'balance-review') void load(id, { compactReview: true }).catch(() => {});
    } catch (e) { if (navigation.current === nav) setError(e.message); }
    finally { setSending(false); }
  };
  const groups = [];
  // Each start opens its own chat, newest first. Only a review still running, or a chat with nothing in it yet,
  // takes the start in place: present its Starting state in that one history slot while retaining the pending ID
  // for exact receipt reconciliation. Other chats keep their own history rows.
  const existingDailyLaunch = opening => rows.find(row => !row.archived && row.kind === opening.kind
    && row.trading_date === opening.trading_date && !removed.current.has(row.id) && !deletingIds.includes(row.id)
    && (entities[row.id]?.activeTurn || ['running', 'accepted'].includes(row.state) || sidebarMessageCount(entities[row.id] || row) === 0));
  const launchOwners = new Set([...launchesInFlight.current.values()].filter(opening => !opening.accepted
    && !(opening.restored && removed.current.has(opening.id))).map(opening => existingDailyLaunch(opening)?.id).filter(Boolean));
  const pendingDisplayRows = Object.values(pendingReviews).filter(opening => !opening.accepted).map(opening => {
    const existing = existingDailyLaunch(opening);
    return existing ? { ...existing, ...opening, title: existing.title } : opening;
  }).filter(row => !query || row.title.toLowerCase().includes(query.toLowerCase()));
  const visibleRows = [...pendingDisplayRows, ...rows.filter(row => !launchOwners.has(row.id))].map(row => {
    const entity = entities[row.id];
    if (!entity || (entity.revision || 0) < (row.revision || 0)) return row;
    // Detail snapshots carry turn state instead of the list's top-level state.
    // A newer explicit null activeTurn must clear an older running list row.
    const state = Object.prototype.hasOwnProperty.call(entity, 'activeTurn')
      ? { state: entity.activeTurn?.state || entity.lastTurn?.state || null } : {};
    return { ...row, ...entity, ...state };
  }).filter(row => {
    const conversation = entities[row.id] || row;
    // Older workers saved daily placeholders before anyone sent a message.
    // Keep any conversation with content, an active response, or an unsent draft.
    return row.kind !== 'daily-chat'
      || (conversation.messages?.length ?? conversation.message_count) !== 0
      || conversation.activeTurn
      || ['running', 'accepted'].includes(conversation.state)
      || Boolean(drafts[row.id]?.trim());
  });
  const today = pacificDate(new Date());
  for (const row of visibleRows) { const day = conversationDay(row); const group = dateGroup(day, today); let target = groups.find(g => g.key === group.key); if (!target) { target = { ...group, day, items: [] }; groups.push(target); } target.items.push(row); }
  // Days read newest first, whichever row arrived first (a remembered receipt can precede the list).
  groups.sort((a, b) => b.day.localeCompare(a.day));
  for (const group of groups) group.items = placeDailyChats(group.items);
  const terminalError = conversation?.lastTurn && ['failed', 'interrupted'].includes(conversation.lastTurn.state) && !(reference && conversation.lastTurn.request_id?.startsWith('daily-')) ? conversation.lastTurn : null;
  const lastPrompt = conversation?.messages.find(m => m.turn_id === terminalError?.id && m.role === 'user')?.text;
  // Editing the returned draft ends the note; a separate unsent message keeps it.
  const visibleSendNote = sendNote?.conversationId === selected && (sendNote.separate || draft.trim() === sendNote.text) ? sendNote : null;
  const landing = !selected && !selectedSend && !launchingReview;
  // A starting review has no saved row yet; its pending opening carries the title.
  const selectedTitle = conversation?.title || launchingReview?.title || [...rows, ...pendingDisplayRows].find(row => row.id === selected)?.title || '';
  const landingShortcut = e => {
    if (!landing || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const action = landingActions.find(row => row.key === e.key.toUpperCase());
    if (!action) return;
    e.preventDefault();
    launch(action.kind);
  };
  return <section ref={panel} className={`analyst-panel analyst-panel-v2${portfolioPresentation ? ' has-portfolio-brief' : ''}`} data-testid="analyst-panel" role="dialog" aria-label="The Analyst" onKeyDown={landingShortcut}>
    <div className="analyst-workspace">
      <main className={`analyst-chat analyst-chat-v2${landing ? ' is-landing' : ''}`}>
        {!landing && <header className="analyst-chat-header">
          <button type="button" className="analyst-chat-back" aria-label="Back to The Analyst" onClick={() => choose(null)}><ArrowLeft size={14} /><span>The Analyst</span></button>
          {selectedTitle && <span className="analyst-chat-title">{selectedTitle}</span>}
        </header>}
        <div ref={transcript} onScroll={e => { const node = e.currentTarget; followReply.current = !sourcesAnchoredReview(selectedKind) && responsePending && node.scrollHeight - node.scrollTop - node.clientHeight < 80; scrolls.current[selected || 'landing'] = node.scrollTop; clearTimeout(scrollSaveTimer.current); scrollSaveTimer.current = setTimeout(() => save('scrolls', scrolls.current), 150); }} className={`analyst-transcript analyst-transcript-v2${selected || selectedSend || launchingReview ? '' : ' is-landing'}${sourcesAnchoredReview(launchingReview?.kind || selectedKind) ? ' is-composer-width' : ''}`} role="log" aria-label="Conversation" aria-live="polite">
          {launchingReview ? <div className="analyst-message-list"><AnalystReviewSources reviewKind={launchingReview.kind} loading phase="Starting…" />
            {launchingReview.kind === 'portfolio-review' && <PortfolioReviewPlaceholder />}</div>
            : !selected && !selectedSend ? <header className="analyst-landing">
              <div className="analyst-landing-title"><h1>The Analyst</h1></div>
              <AnalystLandingStatus holdingsCount={holdingsCount} />
            </header>
              : <div className="analyst-message-list">
                {refreshable && <div className="analyst-review-refresh">
                  {snapshotAt && <span>As of <time dateTime={snapshotAt}>{formatAnalystReportDate(snapshotAt, { year: false })}</time></span>}
                  <button type="button" className="analyst-review-refresh-button" aria-label={`Refresh ${selectedTitle}`}
                    disabled={running || refreshingIds.includes(selected)} onClick={() => refreshReview(conversation)}>
                    <RefreshCw size={11} aria-hidden="true" /><span>Refresh</span>
                  </button>
                </div>}
                {isReview && <AnalystReviewSources reviewKind={selectedKind} sources={reviewSources.sources} loading={reviewSources.loading}
                  readFailed={reviewSources.readFailed} reconnecting={reviewSources.reconnecting} phase={sourcesPhase} modelPhase={summarizing} />}
                {selectedKind === 'portfolio-review' && !renderedMessages.some(message => message.role === 'assistant')
                  && <PortfolioReviewPlaceholder loading={!recordUnavailable && (!conversation || running)} />}
                {portfolioBrief && <PortfolioResearchUpdates key={selected} brief={portfolioBrief} findings={inbox.findings} onCitation={openCitation} />}
                {unavailableRefresh && <p className="portfolio-brief-caption" role="note">The latest refresh could not verify holdings. Showing the last saved portfolio below.</p>}
                {reference && !portfolioBrief && (!reference.missing || error) && <div className="analyst-reference-note" role="note">
                  {reference.missing ? <p>The portfolio review could not be loaded. Start a new Portfolio review.</p> : <>
                    <p>{reference.afterClose ? 'After-close review' : 'Latest saved review'} · {reference.tradingDate} · Historical snapshot</p>
                    <p>Observed <time dateTime={reference.asOf}>{referenceObserved}</time>. Values and source labels reflect that saved observation.</p>
                    {(reference.tradingDate !== reference.targetDate || !reference.afterClose) && <p>The closing review for {reference.targetDate} was not saved. Showing the latest available information.</p>}
                  </>}
                </div>}
                {portfolioBrief && !portfolioBrief.reviewedAt && reference && (reference.tradingDate !== reference.targetDate || !reference.afterClose) && <p className="portfolio-brief-caption" role="note">Last verified holdings: {reference.tradingDate}. Start a new Portfolio review to check all positions against the latest research.</p>}
                {renderedMessages.map(message => (
                  <Message key={message.id} reviewKind={selectedKind} message={message} onCitation={openCitation}
                    inboxFindings={selectedKind === 'portfolio-review' && message === newestPortfolioPost ? inbox.findings : undefined}
                    captureUnavailable={unavailableCapturedBodies.has(`${selected}:${message.id}:${message.reviewRunId}`)}
                    historical={selectedKind === 'portfolio-review' && Boolean(message.portfolioBrief) && message !== newestPortfolioPost} />
                ))}
                {optimisticMessage && <Message message={optimisticMessage} onCitation={openCitation} />}
                {recordUnavailable && <p className="analyst-conversation-empty">Conversation unavailable. <button type="button" onClick={() => { setHistoryError(''); load(selected).catch(e => setHistoryError(e.message)); }}>Retry conversation</button></p>}
                {!isReview && (responsePending || (!conversation && selected && !recordUnavailable)) && <ResponseDots since={conversation?.activeTurn?.created_at} />}
                {isReview && selectedSend && !reviewBusy && <ResponseDots />}
              </div>}
        </div>
        <footer className="analyst-composer-wrap">
          {terminalError && !responsePending && <div className="analyst-composer-note" role="alert"><span>{responseFailureLabel(terminalError.error)}</span><button type="button" disabled={sending || running} onClick={retryResponse}>Retry</button></div>}
          {error && <div className="analyst-composer-note" role="alert"><span>{error}</span></div>}
          {visibleSendNote && <div className={`analyst-composer-note${visibleSendNote.separate ? ' is-quoted' : ''}`} role="alert">{visibleSendNote.separate
            ? <><span>{visibleSendNote.label}: {visibleSendNote.text}</span><button type="button" disabled={sending || running} onClick={() => submit(visibleSendNote.text)}>Resend</button></>
            : <span>{visibleSendNote.label} · ↵ to resend</span>}</div>}
          {Object.entries(deleteErrors).map(([id, label]) => {
            const title = entities[id]?.title || rows.find(row => row.id === id)?.title || 'Conversation';
            return <div key={id} className="analyst-composer-note" role="alert"><span>{label} · {title}</span><button type="button" aria-label={`Retry deleting conversation: ${title}`} onClick={() => deleteConversation(id)}>Retry</button></div>;
          })}
          <form className="analyst-composer" onSubmit={e => { e.preventDefault(); submit(); }}><textarea ref={composer} aria-label="Message The Analyst" placeholder={landing ? 'Ask about positions, exposure, regime, or a setup…' : 'Message The Analyst…'} value={draft} rows={2} disabled={Boolean(launchingReview)} onChange={e => editDraft(draftKey, e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} />{landing && <span className="analyst-composer-hint" aria-hidden="true">↵ send · ⇧↵ newline</span>}{reconnecting && <span className="analyst-connection-status" role="status">Reconnecting…</span>}{running && !launchingReview ? <button type="button" className="analyst-stop-button" onClick={async () => { try { await api.request(`/conversations/${selected}/turns/${conversation.activeTurn.id}/stop`, {}); await load(selected); } catch (e) { setError(e.message); } }}><Square size={14} />Stop</button> : <button type="submit" className="analyst-send-button" disabled={sending || Boolean(launchingReview) || !draft.trim()} aria-label="Send">{landing ? <ArrowUp size={16} /> : <Send size={17} />}</button>}</form>
        </footer>
        {landing && <div className="analyst-landing-lower">
          <div className="analyst-landing-actions" role="group" aria-label="Start a review">
            {landingActions.map(action => <button key={action.kind} type="button"
              aria-label={reviews.find(([kind]) => kind === action.kind)[1]} aria-keyshortcuts={action.key} onClick={() => launch(action.kind)}>
              <span>{action.label}</span><kbd aria-hidden="true">{action.key}</kbd>
            </button>)}
          </div>
          <section className="analyst-landing-tabs">
            <div className="analyst-landing-tabbar">
              <div role="tablist" aria-label="Analyst home">
                {landingTabs.map(([key, label]) => <button key={key} type="button" role="tab" id={`analyst-landing-tab-${key}`} aria-selected={landingTab === key} aria-controls="analyst-landing-tabpanel"
                  className={key === 'inbox' ? `analyst-landing-tab${inbox.actionRequired > 0 ? ' has-action-required' : inbox.unread > 0 ? ' has-notification' : ''}` : 'analyst-landing-tab'} onClick={() => setLandingTab(key)}>
                  {label}{key === 'inbox' && (inbox.actionRequired > 0 || inbox.unread > 0) && <span className="analyst-landing-tab-counts">
                    {inbox.actionRequired > 0 && <span className="analyst-landing-tab-alert" title="Action required">{inbox.actionRequired}</span>}
                    {inbox.actionRequired > 0 && inbox.unread > 0 && <span className="analyst-landing-tab-separator">/</span>}
                    {inbox.unread > 0 && <span className="analyst-landing-tab-count" title="Unread">{inbox.unread}</span>}
                  </span>}
                </button>)}
              </div>
              {landingTab === 'chats' && <label className="analyst-conversation-search"><Search size={13} /><input type="search" aria-label="Search conversations" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /></label>}
            </div>
            <div id="analyst-landing-tabpanel" role="tabpanel" aria-labelledby={`analyst-landing-tab-${landingTab}`} className={`analyst-landing-tabpanel is-${landingTab}`}>
              {landingTab === 'chats' ? <div className="analyst-conversation-list">{groups.map(group => <section key={group.key} className="analyst-conversation-date-group"><h3 className="analyst-conversation-date-heading">{group.label}</h3>{group.items.map(row => {
              // A row being deleted keeps its place until the server acknowledges.
              const rowDeleting = deletingIds.includes(row.id);
              const rowStarting = Boolean(row.pending) || refreshingIds.includes(row.id);
              return <div key={row.id} className={`analyst-conversation-row has-delete-action${row.id === selected ? ' is-active' : ''}${rowDeleting ? ' is-deleting' : ''}`}>
              <button className={`analyst-conversation-item${row.id === selected ? ' is-active' : ''}`} aria-label={`Open conversation: ${row.title}`} disabled={rowDeleting} onClick={() => choose(row.id)}><span className="analyst-conversation-copy"><strong>{row.title}</strong><SidebarStatus row={row} conversation={entities[row.id]} starting={rowStarting} deleting={rowDeleting} /></span></button>
              <button className="analyst-conversation-delete" title="Delete conversation" aria-label={`Delete conversation: ${row.title}`} disabled={rowDeleting || rowStarting} onClick={() => deleteConversation(row.id)}><Trash2 size={12} /></button>
            </div>; })}</section>)}{historyReadFailed ? <p className="analyst-conversation-empty">History unavailable. <button type="button" onClick={() => list().catch(e => setHistoryError(e.message))}>Retry history</button></p> : !visibleRows.length && <p className="analyst-conversation-empty">{query ? 'No matching conversations.' : 'No saved conversations.'}</p>}</div>
                : landingTab === 'inbox' ? <AnalystInbox findings={inbox.findings} error={inboxError} onCitation={openCitation} onAcknowledge={acknowledge} loadHorizonStats={loadHorizonStats} MessageComponent={Message} />
                  : <SourceLibrary embedded />}
            </div>
          </section>
        </div>}
      </main>
      {citation && <aside ref={citationSurface} className={`analyst-source-detail${citationAnchor ? ' is-anchored' : ''}`} role="dialog" aria-label="Citation source">{!citationAnchor && <header><span>Source evidence</span></header>}
      {pagedCitation && <div className="analyst-source-pager">
        <button type="button" aria-label="Previous source" onClick={() => turnCitationPage(-1)}>‹</button>
        <span>{shownCitationPage + 1} of {citation.length} · {sourceProduct(citation[shownCitationPage])}</span>
        <button type="button" aria-label="Next source" onClick={() => turnCitationPage(1)}>›</button>
      </div>}
      {(pagedCitation ? [citation[shownCitationPage]] : citation).map((source, index) => {
        const title = source.title || source.product;
        const href = source.sourceUri && source.product !== 'dashboard-health' ? safeResearchUrl(source.sourceUri) : null;
        // An emailed publication shows the original, clipped around its ticker, with the report link under it.
        const email = citationAnchor && source.sourceMessageId && source.clipTicker;
        return <article className="analyst-source-publication-entry" key={source.id || index} aria-busy={source.evidenceLoading || undefined}>
        {/* The anchored popover is just the publication, its date and the excerpt; its title opens the report. */}
        <strong>{citationAnchor && href && !email ? <a className="analyst-source-publication" href={href} target="_blank" rel="noopener noreferrer">{title} ↗</a> : title}</strong>
        {(source.publicationDate || source.publishedAt) && <p>{formatResearchSourceDate(source.publicationDate || source.publishedAt)}</p>}
        {!citationAnchor && source.sourceUri && source.product !== 'dashboard-health' && <p>{href ? <a className="analyst-source-publication" href={href} target="_blank" rel="noopener noreferrer">Open original report ↗</a> : source.sourceUri}</p>}
        {email ? <>
          <AnalystSourceEmail messageId={source.sourceMessageId} ticker={source.clipTicker} title={title} excerpt={source.excerpt} highlightTexts={source.highlightTexts} />
          {href && <p className="analyst-source-email-link"><a className="analyst-source-publication" href={href} target="_blank" rel="noopener noreferrer">Open original report ↗</a></p>}
        </> : <AnalystSourceExcerpt excerpt={source.excerpt} highlightTexts={source.highlightTexts} />}
        {source.evidenceError && <p>Source evidence unavailable.</p>}
      </article>;
      })}
      {pagedCitation && <div className="analyst-source-dots" role="group" aria-label="Sources">{citation.map((source, index) =>
        <button key={source.id || index} type="button" className={index === shownCitationPage ? 'is-current' : undefined} aria-current={index === shownCitationPage || undefined}
          aria-label={`Source ${index + 1}: ${source.title || source.product}`} onClick={() => setCitationPage(index)} />)}</div>}
      </aside>}
    </div>
  </section>;
}
