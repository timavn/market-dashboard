
const { createHash, randomUUID } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { validateLocalRequest, rejectWebSocketUpgrade, createMessageBudget } = require('../security/localTrust.cjs');
const { getAnalystRuntimeGate } = require('./analystRuntimeGate.cjs');
const { REVIEW_TIME_PROMPT, REVIEW_RETRIEVAL_PROMPT } = require('./analystReviewPrompt.cjs');
const { PAGE_TOOL, validManualBinding, beginManualEvidence, noteManualPage, manualEvidenceSatisfied, manualEvidencePrompt } = require('./analystManualEvidence.cjs');

const ANALYST_SOURCE = 'market-dashboard-analyst';
// The isolated Analyst profile owns its model, reasoning effort, and service tier.
// Session creation must not override the user's configured runtime.
const ANALYST_MCP_TOOL_PREFIX = 'mcp__market_dashboard_analyst__';
const READ_ONLY_SKILL_TOOLS = new Set(['skills_list', 'skill_view']);
const CITATION_TOKEN_PATTERN = /(?:\uE200\s*)?(cite_[a-f0-9]{32})(?:\s*\uE201)?/g;
// The model may wrap IDs as \uE200cite\uE202<id>[\uE202<id>…]\uE201; the
// literal "cite" and the \uE202 separators are markup, not answer text.
const CITATION_GROUP_PREFIX_PATTERN = /\uE200\s*cite\s*\uE202/g;
const LEGACY_CITATION_ARTIFACT_PATTERN = /(?:\uE200\s*)?\[invalid citation removed\](?:\s*\uE201)?/gi;
const TOOL_RESULT_WRAPPER_PATTERN = /^<untrusted_tool_result\s+source="([^"]+)">\s*([\s\S]*?)\s*<\/untrusted_tool_result>$/;
const APPROVED_TOOLS = new Set([
  'get_research_coverage',
  'get_briefing_packet',
  'get_market_situation_context',
  'search_research',
  'get_research_source',
  'get_research_page_image',
  'get_dashboard_context',
  'get_process_context',
  'get_portfolio_context',
  'get_portfolio_verification_page',
  'get_balance_context',
  'get_live_market_snapshot',
  'get_prediction_market_snapshot',
  'get_market_history',
  'get_company_fundamentals',
  'get_macro_series',
]);

const LIVE_PREDICTION_TOOL = 'get_prediction_market_snapshot';
const LIVE_PORTFOLIO_TOOL = 'get_portfolio_context';
const LIVE_BALANCE_TOOL = 'get_balance_context';
const LIVE_INSTRUCTIONS_PREFIX = '[market-dashboard-live-verification]';
const LIVE_INSTRUCTIONS_SUFFIX = '[/market-dashboard-live-verification]';
const LIVE_SOURCE_LABELS = {
  get_balance_context: 'IBKR balances',
  get_portfolio_context: 'IBKR holdings',
  get_prediction_market_snapshot: 'prediction-market quotes',
};
const LIVE_TOOL_NAMES = new Set([
  LIVE_PREDICTION_TOOL,
  LIVE_PORTFOLIO_TOOL,
  LIVE_BALANCE_TOOL,
]);
const LIVE_BUFFER_MAX_CHARS = 250_000;
const PORTFOLIO_PACKET_BATCH_LIMIT = 3;
const PORTFOLIO_PACKET_MAX_BYTES = 30_000;
const PORTFOLIO_REVIEW_POLL_TIMEOUT_MS = 3 * 60 * 1000;
const PORTFOLIO_REVIEW_INTERNAL_PREFIX = '[market-dashboard-portfolio-review-v1]';
const REVIEW_CONTEXT_V2_PREFIX = '[market-dashboard-review-context-v2]';
const REVIEW_CONTEXT_V2_SUFFIX = '[/market-dashboard-review-context-v2]';
const REVIEW_CONTEXT_V2_MAX_BYTES = 24_000;
const ACCOUNT_COMPARISON_PREFIX = '[market-dashboard-account-comparison-v1]';
const ACCOUNT_COMPARISON_SUFFIX = '[/market-dashboard-account-comparison-v1]';
const ACCOUNT_COMPARISON_GUIDANCE = [
  'Output contract: apply only when this answer compares account, balance, margin, or exposure snapshots, including a follow-up such as "run again". Do not turn unrelated questions into comparisons or rewrite a saved report.',
  'Use one plain spreadsheet-style Markdown table: Metric | [dated earlier snapshot] | [dated later snapshot] | Dollar change | What this means for the account. Replace snapshot headings with evidenced dates and exact 24-hour HH:mm observation times in Pacific time (PDT or PST) when known; preserve row-specific times, currency, and account scope. Keep headers and cells normal-weight.',
  'Include evidenced NLV, initial margin, maintenance margin, available funds, excess liquidity, buying power, gross exposure, long exposure, short exposure magnitude, net exposure, deficit, and accrued debit interest. A signed later-minus-earlier dollar change requires comparable verified same-account, same-currency values with the same metric definition and accounting period, and a tool/code-supported calculation. Show unavailable snapshots and changes as an em dash; never fabricate a baseline or delta. Historical reference evidence never replaces a failed current read.',
  'In the final column give each evidenced metric one or two concise plain-English sentences from a hedge fund portfolio manager perspective. Explain its supported positive, negative, unchanged, or mixed implication for capital, financing, capacity, and exposure. Margin requirements are collateral, not loans; NLV change is not automatically investment P&L; changed position values do not prove executed trades; gross/net exposure does not establish beta neutrality; accrued debit interest is a period balance, not daily cost or interest savings. Do not invent causality or append trade recommendations or position targets. Cite supporting evidence near each row and retain all live-data rules.',
].join('\n');
const MISSING_RUNTIME_SESSION_PATTERN = /\b(?:runtime\s+)?session(?:[_\s-]*id)?(?:\s+["']?[a-z0-9_-]+["']?)?\s+(?:was\s+)?not\s+found\b/i;
const RETRY_PROMPT_PATTERN = /\b(?:retry|refresh|try\s+again|check\s+again|look\s+again|run\s+again|still)\b/i;
const HISTORICAL_PROMPT_PATTERN = /\b(?:historical|history|archive(?:d)?|backtest|yesterday|last\s+(?:week|month|year)|in\s+20\d{2})\b/i;
const PREDICTION_PROMPT_PATTERN = /\b(?:prediction[\s-]+markets?|kalshi|forecastex|event[\s-]+contracts?|market\s+odds|implied\s+probabilit(?:y|ies))\b/i;
const CURRENT_PROMPT_PATTERN = /\b(?:today|current(?:ly)?|now|live|latest|fresh|look|odds|prices?|pricing|board|contracts?|refresh|still)\b/i;
const PORTFOLIO_PROMPT_PATTERN = /\b(?:for\s+us|our\s+(?:portfolio|holdings?|positions?|exposure)|my\s+(?:portfolio|holdings?|positions?|exposure)|portfolio(?:\s+impact)?|holdings?|positions?|exposure|(?:current|live)\s+book|book\s+marks?)\b/i;
const BALANCE_PROMPT_PATTERN = /\b(?:run\s+my\s+balance\b|balance\s+(?:report|review)|current\s+(?:portfolio|account)\s+balance|interest\s+(?:forecast|actuals?|ledger|history)|forecast(?:ed)?\s+interest)\b/i;
const FULL_LIVE_REFRESH_PROMPT_PATTERN = /(?:\bfull\s+live\s+refresh\b|\bfresh\s+numbers\s+across\s+the\s+board\b|\brefresh\s+(?:the\s+)?(?:whole|entire)\s+book\b|\b(?:refresh|ping|pull|check)\b[^.!?]{0,80}\b(?:all|every)\b[^.!?]{0,40}\b(?:apis?|providers?|live\s+sources?)\b)/i;

const ANALYST_SESSION_TITLE_MAX_LENGTH = 100;
const ANALYST_DEFAULT_SESSION_TITLE = 'Misc';
const ANALYST_REVIEW_SESSION_TITLES = new Set([
  'Portfolio Review',
  'Predictive Markets Review',
  'Balance Review',
  // Read-only compatibility for conversations created by the retired GM flow.
  'Options Review',
  'Balance',
]);
const ANALYST_V2_REVIEW_SESSION_TITLES = new Set([
  'Portfolio Review',
  'Predictive Markets Review',
  'Balance Review',
]);
const ANALYST_REVIEW_CONVERSATION_IDS = Object.freeze({
  'portfolio-review': 'review:portfolio-review',
  'prediction-markets-review': 'review:prediction-markets-review',
  'balance-review': 'review:balance-review',
});
const ANALYST_GM_REVIEW_ORDER = Object.freeze(['Portfolio Review', 'Options Review', 'Balance']);
const ANALYST_MANAGED_TITLE_LABELS = Object.freeze({
  misc: ANALYST_DEFAULT_SESSION_TITLE,
  'portfolio-review': 'Portfolio Review',
  'prediction-markets-review': 'Predictive Markets Review',
  'balance-review': 'Balance Review',
  'options-review': 'Options Review',
  balance: 'Balance',
});
const ANALYST_MANAGED_TITLE_SLUGS = new Map(
  Object.entries(ANALYST_MANAGED_TITLE_LABELS).map(([slug, label]) => [label, slug]),
);
const ANALYST_MANAGED_TITLE_PATTERN = /^\[market-dashboard-analyst:(misc|portfolio-review|prediction-markets-review|balance-review|options-review|balance):([0-9a-f-]{36}|canonical)\]$/i;
const ANALYST_REVIEW_FOLLOWUP_TITLE_PATTERN = /^\[market-dashboard-analyst-review:(portfolio-review|prediction-markets-review|balance-review):([0-9a-f-]{36})\]$/i;
const ANALYST_GM_BATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANALYST_GM_COMPANION_REVIEW_KINDS = new Set(['options-review', 'balance']);

function analystProtocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePortfolioReviewError(code, message) {
  const normalizedCode = String(code || 'ANALYST_PORTFOLIO_REVIEW_FAILED');
  if (
    normalizedCode === 'COORDINATOR_FINALIZATION_FAILED'
    || normalizedCode === 'COORDINATOR_SELF_CHECK_FAILED'
    || /\b(?:traceback|nameerror|not defined|nullreference|typeerror)\b/i.test(String(message || ''))
  ) {
    return 'Portfolio Review could not finish because the review service encountered an internal error.';
  }
  return String(message || 'Portfolio Review could not finish.');
}

function portfolioReviewPrompt(runId, packets) {
  const packetIds = (Array.isArray(packets) ? packets : [])
    .map((packet) => String(packet?.packetId || '').trim())
    .filter(Boolean);
  return [
    `${PORTFOLIO_REVIEW_INTERNAL_PREFIX} Run ID: ${runId}.`,
    'Call prepare_portfolio_review with this run ID, then retrieve every packet in its manifest with get_portfolio_review_packet.',
    'Use at most three packet calls in any assistant tool-call batch and wait for each batch to settle before continuing.',
    `Expected packet IDs: ${packetIds.join(', ') || 'read them from the manifest'}.`,
    'The packet tables, section states, reason codes, live-data gates, and verified-none outcomes are server-owned facts: preserve them exactly.',
    'Write the eight report sections in manifest order. Use the model only to synthesize cited Market Situation and Macro prose; do not invent, repair, or replace unavailable data.',
    'Do not call search_research, get_portfolio_context, or any other acquisition tool. Do not use cached, stale, inferred, historical, mock, seed, or fallback trading values.',
  ].join('\n');
}

function managedSessionTitle(label, currentTitle = '', identifier = null) {
  const slug = ANALYST_MANAGED_TITLE_SLUGS.get(label);
  if (!slug) throw new Error('Unsupported managed Analyst conversation name.');
  const current = String(currentTitle || '').trim().match(ANALYST_MANAGED_TITLE_PATTERN);
  const managedIdentifier = identifier || current?.[2] || randomUUID();
  return `[market-dashboard-analyst:${slug}:${managedIdentifier}]`;
}

function isManagedSessionTitle(value) {
  return ANALYST_MANAGED_TITLE_PATTERN.test(String(value || '').trim());
}

function displaySessionTitle(value) {
  const title = String(value || '').trim();
  const reviewFollowup = title.match(ANALYST_REVIEW_FOLLOWUP_TITLE_PATTERN);
  if (reviewFollowup) return ANALYST_MANAGED_TITLE_LABELS[reviewFollowup[1].toLowerCase()] || 'Review';
  const managed = title.match(ANALYST_MANAGED_TITLE_PATTERN);
  if (managed) return ANALYST_MANAGED_TITLE_LABELS[managed[1].toLowerCase()];
  if (!title || ['the analyst', 'new chat'].includes(title.toLowerCase())) {
    return ANALYST_DEFAULT_SESSION_TITLE;
  }
  return title;
}

function managedSessionMetadata(value) {
  const normalized = String(value || '').trim();
  const reviewFollowup = normalized.match(ANALYST_REVIEW_FOLLOWUP_TITLE_PATTERN);
  if (reviewFollowup) {
    const reviewKind = reviewFollowup[1].toLowerCase();
    return {
      reviewKind,
      conversationId: reviewFollowup[2].toLowerCase(),
      managedReviewFollowup: true,
      canonicalReview: false,
      legacyReview: false,
    };
  }
  const managed = normalized.match(ANALYST_MANAGED_TITLE_PATTERN);
  if (!managed || managed[1].toLowerCase() === 'misc') return {};
  const storedReviewKind = managed[1].toLowerCase();
  const reviewKind = storedReviewKind === 'balance' ? 'balance-review' : storedReviewKind;
  const managedId = managed[2].toLowerCase();
  const canonicalReview = managedId === 'canonical'
    && Object.prototype.hasOwnProperty.call(ANALYST_REVIEW_CONVERSATION_IDS, reviewKind);
  return {
    ...(managedId !== 'canonical' ? { gmBatchId: managedId } : {}),
    managedId,
    reviewKind,
    canonicalReview,
    legacyReview: !canonicalReview,
    ...(canonicalReview
      ? { conversationId: ANALYST_REVIEW_CONVERSATION_IDS[reviewKind] }
      : {}),
  };
}

function reviewFollowupSessionTitle(reviewKind, conversationId) {
  const normalizedKind = String(reviewKind || '').trim().toLowerCase();
  const identifier = String(conversationId || '').trim();
  if (!ANALYST_V2_REVIEW_SESSION_TITLES.has(ANALYST_MANAGED_TITLE_LABELS[normalizedKind])
      || !ANALYST_GM_BATCH_ID_PATTERN.test(identifier)) {
    throw analystProtocolError('ANALYST_REVIEW_CONVERSATION_INVALID', 'Invalid review conversation.');
  }
  return `[market-dashboard-analyst-review:${normalizedKind}:${identifier}]`;
}

function deterministicConversationTitle(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*_`\-\s]+/, '')
    .trim();
  if (!normalized) return 'New conversation';
  const clipped = normalized.slice(0, 64).trim();
  return normalized.length > clipped.length ? `${clipped.replace(/[.,;:!?\s]+$/, '')}…` : clipped;
}

function sessionReviewMetadata(value) {
  const managed = managedSessionMetadata(value);
  if (managed.reviewKind) return managed;
  const title = displaySessionTitle(value);
  const slug = ANALYST_MANAGED_TITLE_SLUGS.get(title);
  const reviewKind = slug === 'balance' ? 'balance-review' : slug;
  if (!reviewKind || reviewKind === 'misc') return {};
  return { reviewKind, canonicalReview: false, legacyReview: true };
}

function canonicalReviewSessionTitle(reviewKind) {
  const conversationId = ANALYST_REVIEW_CONVERSATION_IDS[reviewKind];
  const label = ANALYST_MANAGED_TITLE_LABELS[reviewKind];
  if (!conversationId || !label) {
    throw analystProtocolError('ANALYST_REVIEW_KIND_INVALID', 'Unknown review kind.');
  }
  return managedSessionTitle(label, '', 'canonical');
}

function requestedReviewSessionTitle(value) {
  const title = String(value || '').trim();
  if (!title) return null;
  if (!ANALYST_REVIEW_SESSION_TITLES.has(title)) {
    throw new Error('Conversation name must be Portfolio Review, Options Review, or Balance.');
  }
  return title;
}

function requestedGmReviews(value) {
  if (!Array.isArray(value) || value.length !== ANALYST_GM_REVIEW_ORDER.length) {
    throw new Error('GM must start Portfolio Review, Options Review, and Balance exactly once each.');
  }
  const reviewsByTitle = new Map();
  for (const review of value) {
    const conversationTitle = requestedReviewSessionTitle(review?.conversationTitle);
    const text = String(review?.text || '').trim();
    if (!conversationTitle || reviewsByTitle.has(conversationTitle) || !text || text.length > 20_000) {
      throw new Error('GM must include Portfolio Review, Options Review, and Balance exactly once each with valid prompts.');
    }
    reviewsByTitle.set(conversationTitle, { conversationTitle, text });
  }
  if (reviewsByTitle.size !== ANALYST_GM_REVIEW_ORDER.length) {
    throw new Error('GM must include Portfolio Review, Options Review, and Balance exactly once each with valid prompts.');
  }
  return ANALYST_GM_REVIEW_ORDER.map((title) => reviewsByTitle.get(title));
}

function requestedReconnectGmRetry(batchId, reviewKind, text) {
  const normalizedBatchId = String(batchId || '').trim().toLowerCase();
  const normalizedReviewKind = String(reviewKind || '').trim().toLowerCase();
  const normalizedText = String(text || '').trim();
  if (!ANALYST_GM_BATCH_ID_PATTERN.test(normalizedBatchId)) {
    throw new Error('GM retry requires a valid batch ID after reconnect.');
  }
  if (!ANALYST_GM_COMPANION_REVIEW_KINDS.has(normalizedReviewKind)) {
    throw new Error('GM retry can reconstruct only Options Review or Balance.');
  }
  if (!normalizedText || normalizedText.length > 20_000) {
    throw new Error('GM retry requires the original 1–20,000 character review prompt after reconnect.');
  }
  const requirements = liveRequirementsForPrompt(normalizedText);
  const expectedRequirements = normalizedReviewKind === 'options-review'
    ? [LIVE_PORTFOLIO_TOOL, LIVE_PREDICTION_TOOL]
    : [LIVE_PORTFOLIO_TOOL, LIVE_BALANCE_TOOL];
  if (expectedRequirements.some((name) => !requirements.has(name))) {
    throw new Error('GM retry requires the canonical live-data review prompt after reconnect.');
  }
  return {
    batchId: normalizedBatchId,
    reviewKind: normalizedReviewKind,
    text: normalizedText,
  };
}

function analystSessionApiUrl(upstreamHost, sessionId) {
  const url = new URL(upstreamHost);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/api\/ws\/?$/, '/api/');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return new URL(`sessions/${encodeURIComponent(sessionId)}`, url).toString();
}

function analystSessionsApiUrl(upstreamHost, { limit = 50, offset = 0 } = {}) {
  const url = new URL(upstreamHost);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/api\/ws\/?$/, '/api/sessions');
  url.search = '';
  url.hash = '';
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Number(limit) || 50))));
  url.searchParams.set('offset', String(Math.max(0, Number(offset) || 0)));
  url.searchParams.set('source', ANALYST_SOURCE);
  url.searchParams.set('order', 'created');
  return url.toString();
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function isMissingRuntimeSessionError(error) {
  return MISSING_RUNTIME_SESSION_PATTERN.test(String(error?.message || error || ''));
}

function toolLeaf(name) {
  const value = String(name || '');
  if (READ_ONLY_SKILL_TOOLS.has(value)) return value;
  if (!value.startsWith(ANALYST_MCP_TOOL_PREFIX)) return null;
  const leaf = value.slice(ANALYST_MCP_TOOL_PREFIX.length);
  return leaf && !leaf.includes('__') ? leaf : null;
}

function isApprovedTool(name) {
  return READ_ONLY_SKILL_TOOLS.has(name) || APPROVED_TOOLS.has(toolLeaf(name));
}

function liveRequirementsForPrompt(value, previousRequirements = new Set()) {
  const text = String(value || '').trim();
  if (!text) return new Set();

  const historical = HISTORICAL_PROMPT_PATTERN.test(text) && !CURRENT_PROMPT_PATTERN.test(text);
  const predictionMentioned = PREDICTION_PROMPT_PATTERN.test(text);
  const predictionCurrent = predictionMentioned
    && !historical
    && (CURRENT_PROMPT_PATTERN.test(text) || /\b(?:how|what|where)\b/i.test(text));
  const portfolioMentioned = PORTFOLIO_PROMPT_PATTERN.test(text);
  const portfolioCurrent = portfolioMentioned && !historical;
  const balanceMentioned = BALANCE_PROMPT_PATTERN.test(text);
  const balanceCurrent = balanceMentioned && !historical;
  const fullLiveRefresh = FULL_LIVE_REFRESH_PROMPT_PATTERN.test(text) && !historical;
  if (
    RETRY_PROMPT_PATTERN.test(text)
    && !predictionMentioned
    && !portfolioMentioned
    && !balanceMentioned
    && !fullLiveRefresh
  ) {
    return new Set(previousRequirements || []);
  }
  const requirements = new Set();
  if (predictionCurrent || fullLiveRefresh) requirements.add(LIVE_PREDICTION_TOOL);
  if (portfolioCurrent || fullLiveRefresh || (predictionCurrent && /\bfor\s+us\b/i.test(text))) {
    requirements.add(LIVE_PORTFOLIO_TOOL);
  }
  if (balanceCurrent) {
    requirements.add(LIVE_BALANCE_TOOL);
    requirements.add(LIVE_PORTFOLIO_TOOL);
  }
  return requirements;
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.text === 'string') return message.text;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .map((part) => (typeof part === 'string' ? part : (part?.text || '')))
    .join(' ');
}

function historyToolLeaf(message) {
  if (message?.role !== 'tool') return null;
  const rawName = message.name || message.tool_name || message.toolName;
  const explicit = toolLeaf(rawName) || (APPROVED_TOOLS.has(rawName) ? rawName : null);
  if (explicit) return explicit;
  const match = messageText(message).trim().match(TOOL_RESULT_WRAPPER_PATTERN);
  return match ? toolLeaf(match[1]) : null;
}

function inferLiveTurnState(messages) {
  let requirements = new Set();
  let completed = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') {
      requirements = liveRequirementsForPrompt(messageText(projectUserMessage(message)), requirements);
      completed = new Set();
      continue;
    }
    const leaf = historyToolLeaf(message);
    if (
      leaf
      && requirements.has(leaf)
      && liveToolCompletionAccepted(messageText(message))
    ) completed.add(leaf);
  }
  return { requirements, completed };
}

function liveGateSatisfied(context) {
  return [...context.requiredLiveTools].every((name) => context.completedLiveTools.has(name));
}

function liveVerificationPrompt(text, requirements) {
  const verification = requirements?.size
    ? `Before answering, explicitly call each of these tools in this turn: ${[...requirements].join(', ')}. These are the exact sources the response verifier requires. An aggregate dashboard context, a previous turn, or a saved report does not replace these calls. Use only independently verified fresh fields for current claims. If a source is unavailable, do not invent its values or make recommendations that depend on it.`
    : '';
  return [LIVE_INSTRUCTIONS_PREFIX, REVIEW_TIME_PROMPT, REVIEW_RETRIEVAL_PROMPT, verification, LIVE_INSTRUCTIONS_SUFFIX, text].filter(Boolean).join('\n');
}

function liveRefreshError(missingTools) {
  const sources = missingTools.map(name => LIVE_SOURCE_LABELS[name] || name).join(', ');
  return `Could not verify fresh ${sources}. The saved report remains available with its original timestamps. Retry will request these sources again.`;
}

function reconcileLiveTurnHistory(turn, messages, completedText) {
  if (!turn.submittedPrompt || !Number.isFinite(turn.submittedAt) || !Array.isArray(messages)) return false;
  let start = -1;
  messages.forEach((message, index) => { if (message.role === 'user') start = index; });
  if (start < 0 || messageText(messages[start]) !== turn.submittedPrompt) return false;
  const timestamp = messages[start].timestamp;
  const submitted = typeof timestamp === 'number' ? timestamp * 1000 : Date.parse(timestamp);
  if (!Number.isFinite(submitted) || submitted < turn.submittedAt || submitted > Date.now() + 30000) return false;
  const current = messages.slice(start);
  const final = [...current].reverse().find(message => message.role === 'assistant' && messageText(message).trim());
  if (!final || !String(completedText || '').trim() || messageText(final).trim() !== String(completedText).trim()) return false;
  for (const message of current) {
    const name = historyToolLeaf(message);
    if (turn.requiredLiveTools.has(name) && liveToolCompletionAccepted(messageText(message))
        && toolResultLiveVerification(messageText(message)) === true) turn.completedLiveTools.add(name);
  }
  return liveGateSatisfied(turn);
}

function reconcileManualHistory(turn, messages, completedText) {
  if (!turn.manualVerification || !turn.submittedPrompt || !Array.isArray(messages)) return false;
  let start = -1;
  messages.forEach((message, index) => { if (message.role === 'user') start = index; });
  if (start < 0 || messageText(messages[start]) !== turn.submittedPrompt) return false;
  const timestamp = messages[start].timestamp;
  const submitted = typeof timestamp === 'number' ? timestamp * 1000 : Date.parse(timestamp);
  if (!Number.isFinite(submitted) || submitted < turn.submittedAt || submitted > Date.now() + 30_000) return false;
  const current = messages.slice(start);
  const final = [...current].reverse().find(message => message.role === 'assistant' && messageText(message).trim());
  if (!final || messageText(final).trim() !== String(completedText || '').trim()) return false;
  for (const message of current) {
    if (historyToolLeaf(message) !== PAGE_TOOL) continue;
    const page = findToolResultObject(messageText(message), value => value?.captureId === turn.manualVerification.binding.captureId
      && value?.representation === 'portfolio-verification-page-v1' && value?.scope === 'summary');
    noteManualPage(turn, page);
    collectCitations(message, turn.citations);
  }
  return manualEvidenceSatisfied(turn);
}

function portfolioReviewGateSatisfied(context) {
  const review = context?.portfolioReview;
  if (!review) return true;
  return review.packetBatchViolation !== true
    && review.prepareComplete === true
    && [...review.requiredPacketIds].every((packetId) => review.completedPacketIds.has(packetId));
}

function notePortfolioPacketStart(context, toolId) {
  const review = context?.portfolioReview;
  if (!review) return;
  const normalizedToolId = String(toolId || '').trim();
  if (!normalizedToolId) {
    review.packetBatchViolation = true;
    return;
  }
  review.activePacketToolIds.add(normalizedToolId);
  if (review.activePacketToolIds.size > PORTFOLIO_PACKET_BATCH_LIMIT) {
    review.packetBatchViolation = true;
  }
}

function notePortfolioPacketComplete(context, toolId) {
  const review = context?.portfolioReview;
  if (!review) return;
  const normalizedToolId = String(toolId || '').trim();
  if (normalizedToolId) review.activePacketToolIds.delete(normalizedToolId);
}

function responseGateSatisfied(context) {
  return liveGateSatisfied(context) && portfolioReviewGateSatisfied(context) && manualEvidenceSatisfied(context);
}

function resetLiveResponseBuffer(context) {
  context.bufferedAssistantEvents = [];
  context.bufferedAssistantChars = 0;
}

function beginLiveTurn(context, text) {
  context.portfolioReview = null;
  context.manualVerification = null;
  const requirements = liveRequirementsForPrompt(text, context.previousLiveRequirements);
  context.previousLiveRequirements = new Set(requirements);
  context.requiredLiveTools = new Set(requirements);
  context.completedLiveTools = new Set();
  context.liveGateOpen = requirements.size === 0;
  context.liveBufferOverflow = false;
  resetLiveResponseBuffer(context);
  return requirements;
}

function portfolioPacketMatches(expected, candidate) {
  if (!expected || !candidate) return false;
  const continuationIndex = Number(candidate.continuationIndex);
  const continuationCount = Number(candidate.continuationCount);
  const sizeBytes = Number(candidate.sizeBytes);
  return String(candidate.packetId || '') === String(expected.packetId || '')
    && Boolean(String(candidate.packetId || '').trim())
    && String(candidate.group || '') === String(expected.group || '')
    && Boolean(String(candidate.group || '').trim())
    && continuationIndex === Number(expected.continuationIndex)
    && continuationCount === Number(expected.continuationCount)
    && Number.isInteger(continuationIndex)
    && continuationIndex >= 0
    && Number.isInteger(continuationCount)
    && continuationCount > 0
    && continuationIndex < continuationCount
    && String(candidate.sha256 || '') === String(expected.sha256 || '')
    && /^[a-f0-9]{64}$/.test(String(candidate.sha256 || ''))
    && sizeBytes === Number(expected.sizeBytes)
    && Number.isInteger(sizeBytes)
    && sizeBytes > 0
    && sizeBytes <= PORTFOLIO_PACKET_MAX_BYTES;
}

function beginPortfolioReviewTurn(
  context,
  runId,
  packetDescriptors,
  acquiredStatus = 'ready',
  requestId = null,
) {
  const expectedPackets = new Map(
    (Array.isArray(packetDescriptors) ? packetDescriptors : [])
      .map((packet) => [String(packet?.packetId || '').trim(), { ...packet }])
      .filter(([packetId]) => packetId),
  );
  context.previousLiveRequirements = new Set();
  context.requiredLiveTools = new Set();
  context.completedLiveTools = new Set();
  context.portfolioReview = {
    runId,
    acquiredStatus,
    requestId,
    requiredPacketIds: new Set(expectedPackets.keys()),
    expectedPackets,
    completedPacketIds: new Set(),
    packetFragments: new Map(),
    prepareComplete: false,
    activePacketToolIds: new Set(),
    packetBatchViolation: false,
  };
  context.liveGateOpen = false;
  context.liveBufferOverflow = false;
  resetLiveResponseBuffer(context);
}

function queueAssistantEvent(context, event) {
  const text = String(event.text || '');
  if (context.liveGateOpen) return false;
  if (context.bufferedAssistantChars + text.length > LIVE_BUFFER_MAX_CHARS) {
    context.liveBufferOverflow = true;
    return true;
  }
  context.bufferedAssistantEvents.push({ ...event, text });
  context.bufferedAssistantChars += text.length;
  return true;
}

function flushAssistantEvents(browser, context) {
  if (!context.liveGateOpen || context.liveBufferOverflow) return;
  for (const event of context.bufferedAssistantEvents) sendJson(browser, event);
  resetLiveResponseBuffer(context);
}

function validCitation(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && /^cite_[a-f0-9]{32}$/.test(String(value.id || ''))
    && /^doc_[a-f0-9]{32}(?::p\d+)?$/.test(String(value.documentId || ''))
    && typeof value.product === 'string'
    && typeof value.sourceUri === 'string'
    && value.sourceUri.length <= 2_000,
  );
}

function parseToolResultWrapper(value) {
  const match = String(value || '').trim().match(TOOL_RESULT_WRAPPER_PATTERN);
  if (!match || !isApprovedTool(match[1])) return null;
  const lines = match[2].split(/\r?\n/);
  const jsonStart = lines.findIndex((line) => ['{', '['].includes(line.trim()[0]));
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(lines.slice(jsonStart).join('\n').trim());
  } catch (_error) {
    return null;
  }
}

function findToolResultObject(value, predicate, depth = 0, seen = new Set()) {
  if (depth > 10 || value == null) return null;
  if (typeof value === 'string') {
    const wrapped = parseToolResultWrapper(value);
    if (wrapped) return findToolResultObject(wrapped, predicate, depth + 1, seen);
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length > 300_000) {
      return null;
    }
    try {
      return findToolResultObject(JSON.parse(trimmed), predicate, depth + 1, seen);
    } catch (_error) {
      return null;
    }
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (predicate(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findToolResultObject(child, predicate, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function toolResultStatus(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const wrapped = parseToolResultWrapper(value);
    if (wrapped) return toolResultStatus(wrapped, depth + 1);
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try {
      return toolResultStatus(JSON.parse(trimmed), depth + 1);
    } catch (_error) {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = toolResultStatus(item, depth + 1);
      if (status) return status;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (typeof value.status === 'string') return value.status;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) {
    const status = toolResultStatus(value.result, depth + 1);
    if (status) return status;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'content')) {
    return toolResultStatus(value.content, depth + 1);
  }
  return null;
}

function toolResultLiveVerification(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const wrapped = parseToolResultWrapper(value);
    if (wrapped) return toolResultLiveVerification(wrapped, depth + 1);
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try {
      return toolResultLiveVerification(JSON.parse(trimmed), depth + 1);
    } catch (_error) {
      return null;
    }
  }
  if (Array.isArray(value)) {
    let verified = null;
    for (const item of value) {
      const itemVerified = toolResultLiveVerification(item, depth + 1);
      if (itemVerified === false) return false;
      if (itemVerified === true) verified = true;
    }
    return verified;
  }
  if (typeof value !== 'object') return null;
  if (value.liveVerified === false) return false;
  if (
    value.cacheOnly === true
    || value.cached === true
    || value.mock === true
    || value.seeded === true
    || value.fallback === true
  ) return false;
  if (/\b(?:stale|offline|cached?|cache[_ -]?only|mock|seeded?|fallback|inferred|historical)\b/i.test(
    String(value.freshness || value.provenance || ''),
  )) return false;
  if (value.liveVerified === true) return true;
  for (const key of ['result', 'content', 'data']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const verified = toolResultLiveVerification(value[key], depth + 1);
    if (verified != null) return verified;
  }
  return null;
}

function liveToolCompletionAccepted(result) {
  const status = String(toolResultStatus(result) || '').trim().toLowerCase();
  if (/^(?:invalid_request|unavailable|offline|stale|cached?|cache[_ -]?only|mock|seeded?|fallback|error|failed)$/.test(status)) {
    return false;
  }
  return toolResultLiveVerification(result) !== false;
}

function collectVerificationCitationTable(table, output) {
  const fields = new Set(['id', 'documentId', 'product', 'publicationDate', 'publishedAt', 'sourceUri']);
  const required = ['id', 'documentId', 'product', 'publicationDate', 'sourceUri'];
  if (!table || typeof table !== 'object' || Array.isArray(table)
      || !Array.isArray(table.columns) || !Array.isArray(table.rows)
      || !table.columns.every(column => typeof column === 'string' && fields.has(column))
      || new Set(table.columns).size !== table.columns.length
      || !required.every(column => table.columns.includes(column))
      || (Object.hasOwn(table, 'rowCount') && table.rowCount !== table.rows.length)) return;
  for (const row of table.rows) {
    if (!Array.isArray(row) || row.length !== table.columns.length) continue;
    const citation = Object.create(null);
    let valid = true;
    table.columns.forEach((column, index) => {
      const value = row[index];
      if ((typeof value !== 'string' || !value)
          && !(column === 'publishedAt' && value === null)) valid = false;
      citation[column] = value;
    });
    if (valid && validCitation(citation)) output.set(citation.id, { ...citation });
  }
}

function collectCitations(value, output = new Map(), depth = 0) {
  if (depth > 12 || output.size >= 100 || value == null) return output;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const wrapped = parseToolResultWrapper(trimmed);
    if (wrapped) {
      collectCitations(wrapped, output, depth + 1);
    } else if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 250_000) {
      try {
        collectCitations(JSON.parse(trimmed), output, depth + 1);
      } catch (_error) {
        // Plain tool output is not a citation envelope.
      }
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectCitations(item, output, depth + 1));
    return output;
  }
  if (typeof value !== 'object') return output;
  if (value.role === 'tool' && READ_ONLY_SKILL_TOOLS.has(historyToolLeaf(value))) return output;
  if (Object.hasOwn(value, 'researchVerification')) {
    collectVerificationCitationTable(value.researchVerification?.citationTable, output);
  }
  if (Array.isArray(value.citations)) {
    value.citations.forEach((citation) => {
      if (validCitation(citation)) output.set(citation.id, { ...citation });
    });
  }
  Object.values(value).forEach((item) => collectCitations(item, output, depth + 1));
  return output;
}

function sanitizeCitationText(value, allowedIds) {
  const accepted = [];
  const rejected = [];
  const citationNumbers = new Map();
  const ungrouped = String(value || '').replace(CITATION_GROUP_PREFIX_PATTERN, '\uE200').replace(/\uE202/g, ' ');
  let sanitized = ungrouped.replace(CITATION_TOKEN_PATTERN, (_token, citationId) => {
    if (allowedIds.has(citationId)) {
      if (!citationNumbers.has(citationId)) {
        accepted.push(citationId);
        citationNumbers.set(citationId, accepted.length);
      }
      return `[${citationNumbers.get(citationId)}]`;
    }
    rejected.push(citationId);
    return '';
  });
  sanitized = sanitized
    .replace(LEGACY_CITATION_ARTIFACT_PATTERN, '')
    .replace(/[\uE200\uE201]/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+$/gm, '');
  return { text: sanitized, accepted, rejected: [...new Set(rejected)] };
}

function citationsForIds(ids, citations) {
  return [...new Set(ids || [])]
    .map((citationId) => citations.get(citationId))
    .filter(Boolean)
    .slice(0, 30);
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) {
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.close(1013, 'Slow client');
      return;
    }
    socket.send(JSON.stringify(payload));
  }
}

class JsonRpcPeer {
  constructor({ url, socketFactory = (target) => new WebSocket(target), onEvent, onClose }) {
    this.url = url;
    this.socketFactory = socketFactory;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  finishSocket(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connecting = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Hermes gateway disconnected.'));
    }
    this.pending.clear();
    this.onClose?.();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === 1) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = this.socketFactory(this.url);
      this.socket = socket;
      socket.on('message', (raw) => this.handle(raw));
      socket.on('close', () => this.finishSocket(socket));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Hermes gateway connection timed out.')), 15_000);
        socket.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once('close', () => {
          clearTimeout(timer);
          reject(new Error('Hermes gateway disconnected while connecting.'));
        });
      });
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  handle(raw) {
    let frame;
    try {
      frame = JSON.parse(String(raw));
    } catch (_error) {
      return;
    }
    if (frame.id !== undefined && frame.id !== null) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message || 'Hermes RPC failed.'));
      else pending.resolve(frame.result);
      return;
    }
    if (frame.method === 'event' && frame.params?.type) this.onEvent?.(frame.params);
  }

  request(method, params = {}, timeoutMs = 120_000) {
    if (!this.socket || (this.socket.readyState !== WebSocket.OPEN && this.socket.readyState !== 1)) {
      return Promise.reject(new Error('Hermes gateway is not connected.'));
    }
    const id = `analyst-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() {
    const socket = this.socket;
    if (!socket) return;
    this.finishSocket(socket);
    socket.close();
  }
}

function projectUserMessage(message) {
  let content = messageText(message);
  const hiddenPrefixes = [
    [LIVE_INSTRUCTIONS_PREFIX, LIVE_INSTRUCTIONS_SUFFIX],
    [ACCOUNT_COMPARISON_PREFIX, ACCOUNT_COMPARISON_SUFFIX],
    [REVIEW_CONTEXT_V2_PREFIX, REVIEW_CONTEXT_V2_SUFFIX],
  ];
  for (const [prefix, suffix] of hiddenPrefixes) {
    if (!content.startsWith(prefix)) continue;
    const end = content.indexOf(suffix);
    if (end < 0) break;
    content = content.slice(end + suffix.length).trimStart();
    message = { ...message, content, text: content, displayText: content };
  }
  if (
    content.startsWith(PORTFOLIO_REVIEW_INTERNAL_PREFIX)
    || /^Run my Portfolio (?:Daily )?Review\b/i.test(content)
  ) {
    return {
      ...message,
      content: 'Portfolio Review',
      text: 'Portfolio Review',
      displayText: 'Portfolio Review',
      reviewKind: 'portfolio-review',
    };
  }
  return message;
}

function attachReviewContextToPrompt(text, context) {
  if (
    !context
    || context.schema !== 'ReviewContextV2'
    || Buffer.byteLength(JSON.stringify(context), 'utf8') > REVIEW_CONTEXT_V2_MAX_BYTES
  ) return text;
  return [
    REVIEW_CONTEXT_V2_PREFIX,
    JSON.stringify(context),
    REVIEW_CONTEXT_V2_SUFFIX,
    String(text || ''),
  ].join('\n');
}

function projectHistory(messages) {
  const turnCitations = new Map();
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (message?.role === 'tool') collectCitations(message, turnCitations);
    if (message?.role === 'user') return projectUserMessage(message);
    if (message?.role !== 'assistant') return message;
    const content = typeof message.content === 'string' ? message.content : message.text || '';
    const sanitized = sanitizeCitationText(content, new Set(turnCitations.keys()));
    const projected = {
      ...message,
      content: sanitized.text,
      citations: citationsForIds(sanitized.accepted, turnCitations),
      ...(sanitized.rejected.length ? { rejectedCitations: sanitized.rejected } : {}),
    };
    turnCitations.clear();
    return projected;
  });
}

function attachAnalystGatewayProxy(server, options = {}) {
  const upstreamHost = options.upstreamHost || process.env.ANALYST_HERMES_URL || 'ws://127.0.0.1:9121/api/ws';
  const token = options.token ?? process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';
  const runtimeGate = options.runtimeGate || (options.contractVerified === undefined ? getAnalystRuntimeGate() : null);
  const isContractVerified = () => runtimeGate ? runtimeGate.isVerified() : options.contractVerified === true;
  const upstreamUrl = `${upstreamHost}${upstreamHost.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  const sessionListFetchImpl = options.sessionListFetchImpl === undefined
    ? globalThis.fetch?.bind(globalThis)
    : options.sessionListFetchImpl;
  const reviewFetchImpl = options.reviewFetchImpl || globalThis.fetch?.bind(globalThis);
  const analystSidecarUrl = String(
    options.analystSidecarUrl || process.env.ANALYST_SIDECAR_URL || 'http://127.0.0.1:6951',
  ).replace(/\/$/, '');
  const analystServiceToken = options.analystServiceToken
    ?? process.env.ANALYST_SERVICE_TOKEN
    ?? '';
  const Wss = options.WebSocketServerImpl || WebSocketServer;
  const wss = new Wss({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const maxClients = 16;
  const handleUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch (_error) {
      return;
    }
    if (pathname !== '/ws/analyst') return;
    const trust = validateLocalRequest(request);
    if (!trust.ok) return rejectWebSocketUpgrade(socket, trust.statusCode);
    if (wss.clients.size >= maxClients) return rejectWebSocketUpgrade(socket, 429);
    wss.handleUpgrade(request, socket, head, (browser) => {
      wss.emit('connection', browser, request);
    });
  };
  server.on('upgrade', handleUpgrade);
  const state = {
    clients: 0,
    connectedUpstreams: 0,
    lastError: null,
    lastConnectedAt: null,
  };

  async function reviewServiceRequest(path, { method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
    if (typeof reviewFetchImpl !== 'function') {
      throw analystProtocolError(
        'ANALYST_REVIEW_SERVICE_UNAVAILABLE',
        'The Analyst review service client is not configured.',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await reviewFetchImpl(`${analystSidecarUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${analystServiceToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const payload = await responsePayload(response);
      if (!response?.ok) {
        throw analystProtocolError(
          payload?.code || 'ANALYST_REVIEW_SERVICE_UNAVAILABLE',
          payload?.error || `Analyst review service HTTP ${response?.status || 'error'}.`,
        );
      }
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw analystProtocolError(
          'ANALYST_REVIEW_SERVICE_TIMEOUT',
          'The Analyst review service request timed out.',
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  wss.on('connection', (browser) => {
    if (!isContractVerified()) {
      sendJson(browser, {
        type: 'error',
        code: 'ANALYST_HERMES_CONTRACT_UNVERIFIED',
        error: 'The Analyst is disabled because its Hermes JSON-RPC contract has not been verified.',
      });
      browser.close(1013, 'Analyst contract unverified');
      return;
    }
    state.clients += 1;
    const createTurnContext = () => ({
      citations: new Map(),
      runtimeSessionId: null,
      storedSessionId: null,
      busy: false,
      previousLiveRequirements: new Set(),
      requiredLiveTools: new Set(),
      completedLiveTools: new Set(),
      liveGateOpen: true,
      liveBufferOverflow: false,
      bufferedAssistantEvents: [],
      bufferedAssistantChars: 0,
      sessionTitle: '',
      hasMessages: false,
      gmBatchId: null,
      reviewKind: null,
      conversationId: null,
      canonicalReview: false,
      legacyReview: false,
      gmStatus: null,
      visibleMessageCount: 0,
      portfolioReview: null,
      manualVerification: null,
    });
    let context = createTurnContext();
    let upstreamConnected = false;
    const turnContextsByRuntime = new Map();
    const turnContextsByStored = new Map();
    // Hermes session.list can briefly lag a successful create/rename/delete.
    // Keep connection-local overlays until the persisted list confirms them so
    // a later list response cannot make a just-created conversation disappear.
    const pendingCreatedSessions = new Map();
    const pendingRuntimeSessions = new Map();
    const pendingSessionTitles = new Map();
    const gmBatches = new Map();
    let browserActionQueue = Promise.resolve();
    let latestSelectionRequestId = '';

    function clearTurn(turn) {
      turn.busy = false;
      turn.citations.clear();
      turn.requiredLiveTools = new Set();
      turn.completedLiveTools = new Set();
      turn.liveGateOpen = true;
      turn.liveBufferOverflow = false;
      turn.manualVerification = null;
      resetLiveResponseBuffer(turn);
      turn.portfolioReview = null;
    }

    function forgetTurnRuntime(turn) {
      if (turn?.runtimeSessionId) turnContextsByRuntime.delete(turn.runtimeSessionId);
      if (turn) turn.runtimeSessionId = null;
    }

    function registerRuntimeSession(
      result,
      fallbackStoredSessionId = null,
      { select = false } = {},
    ) {
      const runtimeSessionId = String(result?.session_id || '').trim();
      if (!runtimeSessionId) throw new Error('Hermes did not return a runtime session ID.');
      const storedSessionId = result.session_key
        || result.stored_session_id
        || result.resumed
        || fallbackStoredSessionId
        || (select ? context.storedSessionId : null)
        || null;
      const existing = (
        (storedSessionId && turnContextsByStored.get(storedSessionId))
        || turnContextsByRuntime.get(runtimeSessionId)
      );
      const turn = existing || createTurnContext();
      if (turn.runtimeSessionId && turn.runtimeSessionId !== runtimeSessionId) {
        turnContextsByRuntime.delete(turn.runtimeSessionId);
      }
      turn.runtimeSessionId = runtimeSessionId;
      turn.storedSessionId = storedSessionId;
      // A session.history response can omit `running`, and a freshly created
      // runtime snapshot remains `false` while its first turn is running. A
      // locally observed in-flight turn is authoritative until its own
      // completion, error, interrupt, or reclaim event arrives.
      turn.busy = turn.busy || Boolean(result.running);
      turnContextsByRuntime.set(runtimeSessionId, turn);
      if (storedSessionId) turnContextsByStored.set(storedSessionId, turn);
      if (select) context = turn;
      return { turn, existing: Boolean(existing) };
    }

    function setRuntimeSession(result, fallbackStoredSessionId = null) {
      return registerRuntimeSession(result, fallbackStoredSessionId, { select: true });
    }

    function turnForEvent(event) {
      const runtimeSessionId = String(event?.session_id || '').trim();
      if (!runtimeSessionId) {
        const busyTurns = [...new Set(turnContextsByRuntime.values())]
          .filter((turn) => turn.busy);
        return busyTurns.length === 1 ? busyTurns[0] : null;
      }
      return turnContextsByRuntime.get(runtimeSessionId) || null;
    }

    function turnFrame(turn, payload) {
      return {
        ...payload,
        ...(turn?.storedSessionId ? { storedSessionId: turn.storedSessionId } : {}),
        ...(turn?.gmBatchId ? { gmBatchId: turn.gmBatchId } : {}),
        ...(turn?.reviewKind ? { reviewKind: turn.reviewKind } : {}),
        ...(turn?.conversationId ? { conversationId: turn.conversationId } : {}),
        ...(turn?.canonicalReview ? { canonicalReview: true } : {}),
        ...(turn?.legacyReview ? { legacyReview: true } : {}),
      };
    }

    function sendTurnFrame(turn, payload) {
      sendJson(browser, turnFrame(turn, payload));
    }

    function sendTurnActivity(turn) {
      sendTurnFrame(turn, {
        type: 'session_status',
        running: Boolean(turn?.busy),
      });
    }

    function gmReviewDescriptor(review) {
      return {
        reviewKind: review.reviewKind,
        title: review.title,
        ...(review.sessionId ? { sessionId: review.sessionId } : {}),
        status: review.status,
        ...(review.error ? { error: review.error } : {}),
      };
    }

    function sendGmReviewStatus(batchId, review) {
      sendJson(browser, {
        type: 'gm_review_status',
        batchId,
        review: gmReviewDescriptor(review),
      });
    }

    function setGmReviewStatus(turn, status, error = null) {
      if (!turn?.gmBatchId || !turn.reviewKind) return;
      turn.gmStatus = status;
      const batch = gmBatches.get(turn.gmBatchId);
      const review = batch?.reviews.get(turn.reviewKind);
      if (!review) return;
      review.status = status;
      review.error = error ? String(error) : null;
      if (turn.storedSessionId) review.sessionId = turn.storedSessionId;
      sendGmReviewStatus(turn.gmBatchId, review);
    }

    const upstream = new JsonRpcPeer({
      url: upstreamUrl,
      socketFactory: options.socketFactory,
      onClose: () => {
        if (upstreamConnected) {
          upstreamConnected = false;
          state.connectedUpstreams = Math.max(0, state.connectedUpstreams - 1);
        }
        for (const turn of new Set(turnContextsByStored.values())) {
          if (turn.busy) setGmReviewStatus(turn, 'failed', 'The Analyst service disconnected during the review.');
          clearTurn(turn);
        }
        turnContextsByRuntime.clear();
        turnContextsByStored.clear();
        context = createTurnContext();
        sendJson(browser, { type: 'connection', status: 'disconnected' });
        if (browser.readyState === WebSocket.OPEN || browser.readyState === 1) {
          browser.close(1012, 'Analyst upstream disconnected');
        }
      },
      onEvent: async (event) => {
        const payload = event.payload || {};
        if (event.type === 'session.reclaimed') {
          const reclaimedRuntimeSessionId = String(payload.session_id || event.session_id || '').trim();
          const reclaimedStoredSessionId = String(
            payload.stored_session_id || payload.session_key || '',
          ).trim();
          const reclaimedTurn = (
            (reclaimedRuntimeSessionId && turnContextsByRuntime.get(reclaimedRuntimeSessionId))
            || (reclaimedStoredSessionId && turnContextsByStored.get(reclaimedStoredSessionId))
          );
          if (!reclaimedTurn) return;
          const interrupted = reclaimedTurn.busy;
          forgetTurnRuntime(reclaimedTurn);
          clearTurn(reclaimedTurn);
          sendTurnActivity(reclaimedTurn);
          if (interrupted) {
            setGmReviewStatus(
              reclaimedTurn,
              'failed',
              'The Analyst connection was interrupted before the response completed.',
            );
            sendTurnFrame(reclaimedTurn, {
              type: 'error',
              code: 'ANALYST_SESSION_INTERRUPTED',
              error: 'The Analyst connection was interrupted before the response completed. Send the message again.',
            });
          }
          return;
        }
        const turn = turnForEvent(event);
        if (!turn) return;
        if (event.type === 'tool.start') {
          if (!isApprovedTool(payload.name)) {
            state.lastError = `Blocked unexpected Hermes tool: ${payload.name || 'unknown'}`;
            setGmReviewStatus(turn, 'failed', state.lastError);
            sendTurnFrame(turn, { type: 'error', error: state.lastError });
            if (turn.runtimeSessionId) {
              upstream.request('session.interrupt', { session_id: turn.runtimeSessionId }, 10_000).catch(() => {});
            }
            return;
          }
          if (
            turn.portfolioReview
            && toolLeaf(payload.name) === 'get_portfolio_review_packet'
          ) notePortfolioPacketStart(turn, payload.tool_id);
          sendTurnFrame(turn, {
            type: 'tool',
            status: 'running',
            name: toolLeaf(payload.name),
            toolId: payload.tool_id,
          });
          return;
        }
        if (event.type === 'tool.complete') {
          if (!isApprovedTool(payload.name)) return;
          const leaf = toolLeaf(payload.name);
          if (leaf === 'get_portfolio_review_packet') {
            notePortfolioPacketComplete(turn, payload.tool_id);
          }
          if (!READ_ONLY_SKILL_TOOLS.has(leaf)) collectCitations(payload.result, turn.citations);
          if (turn.manualVerification && leaf === PAGE_TOOL) {
            const page = findToolResultObject(payload.result, value => value?.captureId === turn.manualVerification.binding.captureId
              && value?.representation === 'portfolio-verification-page-v1' && value?.scope === 'summary');
            noteManualPage(turn, page);
          }
          sendTurnFrame(turn, {
            type: 'tool',
            status: 'complete',
            name: leaf,
            toolId: payload.tool_id,
          });
          if (
            LIVE_TOOL_NAMES.has(leaf)
            && turn.requiredLiveTools.has(leaf)
            && liveToolCompletionAccepted(payload.result)
          ) {
            turn.completedLiveTools.add(leaf);
          }
          if (turn.portfolioReview && leaf === 'prepare_portfolio_review') {
            const prepared = findToolResultObject(payload.result, (value) => (
              value?.runId === turn.portfolioReview.runId
              && Array.isArray(value?.packets)
            ));
            if (prepared) {
              const manifestIds = new Set(
                prepared.packets.map((packet) => String(packet?.packetId || '')).filter(Boolean),
              );
              turn.portfolioReview.prepareComplete = manifestIds.size === turn.portfolioReview.requiredPacketIds.size
                && [...turn.portfolioReview.requiredPacketIds].every((packetId) => (
                  manifestIds.has(packetId)
                  && portfolioPacketMatches(
                    turn.portfolioReview.expectedPackets.get(packetId),
                    prepared.packets.find((packet) => packet?.packetId === packetId),
                  )
                ));
            }
          }
          if (turn.portfolioReview && leaf === 'get_portfolio_review_packet') {
            const packetResult = findToolResultObject(payload.result, (value) => (
              value?.runId === turn.portfolioReview.runId
              && typeof value?.packet?.packetId === 'string'
              && turn.portfolioReview.requiredPacketIds.has(value.packet.packetId)
            ));
            const packet = packetResult?.packet;
            const fragment = typeof packet?.jsonFragment === 'string' ? packet.jsonFragment : null;
            const digest = fragment === null
              ? null
              : createHash('sha256').update(fragment, 'utf8').digest('hex');
            const expectedPacket = packet
              ? turn.portfolioReview.expectedPackets.get(packet.packetId)
              : null;
            const packetBytes = packet ? Buffer.byteLength(JSON.stringify(packet), 'utf8') : Infinity;
            if (
              packet
              && fragment !== null
              && digest === packet.sha256
              && packetBytes <= PORTFOLIO_PACKET_MAX_BYTES
              && portfolioPacketMatches(expectedPacket, packet)
            ) {
              turn.portfolioReview.completedPacketIds.add(packet.packetId);
              turn.portfolioReview.packetFragments.set(packet.packetId, packet);
              const siblings = [...turn.portfolioReview.packetFragments.values()]
                .filter((candidate) => candidate.group === packet.group)
                .sort((left, right) => Number(left.continuationIndex) - Number(right.continuationIndex));
              if (
                siblings.length === Number(packet.continuationCount)
                && siblings.every((candidate, index) => Number(candidate.continuationIndex) === index)
              ) {
                try {
                  collectCitations(JSON.parse(siblings.map((candidate) => candidate.jsonFragment).join('')), turn.citations);
                } catch (_error) {
                  siblings.forEach((candidate) => turn.portfolioReview.completedPacketIds.delete(candidate.packetId));
                }
              }
            }
          }
          turn.liveGateOpen = responseGateSatisfied(turn);
          flushAssistantEvents(browser, turn);
          return;
        }
        if (['approval.request', 'sudo.request', 'secret.request', 'clarify.request'].includes(event.type)) {
          state.lastError = `Blocked unexpected interactive Hermes request: ${event.type}`;
          setGmReviewStatus(turn, 'failed', state.lastError);
          sendTurnFrame(turn, { type: 'error', error: state.lastError });
          if (turn.runtimeSessionId) {
            upstream.request('session.interrupt', { session_id: turn.runtimeSessionId }, 10_000).catch(() => {});
          }
          return;
        }
        if (event.type === 'message.start') {
          turn.busy = true;
          setGmReviewStatus(turn, 'running');
          sendTurnActivity(turn);
          sendTurnFrame(turn, { type: 'message_start' });
          return;
        }
        if (event.type === 'message.delta') {
          const outgoing = turnFrame(turn, {
            type: 'message_delta',
            text: String(payload.text || payload.delta || ''),
          });
          if (!queueAssistantEvent(turn, outgoing)) sendJson(browser, outgoing);
          return;
        }
        if (event.type === 'message.interim') {
          const outgoing = turnFrame(turn, {
            type: 'message_interim',
            text: String(payload.text || ''),
          });
          if (!queueAssistantEvent(turn, outgoing)) sendJson(browser, outgoing);
          return;
        }
        if (event.type === 'message.complete') {
          const completingPortfolioReview = turn.portfolioReview;
          // Tool completion events may omit their full result. Reconcile only this
          // exact response against its freshly persisted tool history before failing it.
          if (!turn.portfolioReview && (!liveGateSatisfied(turn) || !manualEvidenceSatisfied(turn))) {
            try {
              const history = await upstream.request('session.history', { session_id: turn.runtimeSessionId }, 5000);
              if (turn.manualVerification) reconcileManualHistory(turn, history.messages, payload.text);
              else reconcileLiveTurnHistory(turn, history.messages, payload.text);
              turn.liveGateOpen = responseGateSatisfied(turn);
              flushAssistantEvents(browser, turn);
            } catch (_error) { /* Missing verified history keeps the response gate closed. */ }
          }
          turn.busy = false;
          sendTurnActivity(turn);
          const missingTools = [...turn.requiredLiveTools]
            .filter((name) => !turn.completedLiveTools.has(name));
          const missingPackets = turn.portfolioReview
            ? [...turn.portfolioReview.requiredPacketIds]
              .filter((packetId) => !turn.portfolioReview.completedPacketIds.has(packetId))
            : [];
          const missingPrepare = Boolean(turn.portfolioReview && !turn.portfolioReview.prepareComplete);
          const packetBatchViolation = Boolean(turn.portfolioReview?.packetBatchViolation);
          const missingManualEvidence = !manualEvidenceSatisfied(turn);
          if (
            missingTools.length
            || missingPackets.length
            || missingPrepare
            || packetBatchViolation
            || missingManualEvidence
            || turn.liveBufferOverflow
          ) {
            resetLiveResponseBuffer(turn);
            turn.citations.clear();
            turn.liveGateOpen = false;
            sendTurnFrame(turn, {
              type: 'error',
              code: turn.portfolioReview || missingManualEvidence
                ? 'ANALYST_REVIEW_EVIDENCE_INCOMPLETE'
                : 'ANALYST_LIVE_REFRESH_REQUIRED',
              error: turn.liveBufferOverflow
                ? 'The Analyst live response exceeded the guarded buffer; no current-data answer was shown.'
                : packetBatchViolation
                  ? 'Portfolio Review requested more than three evidence packets in one tool-call batch; no unverified answer was shown.'
                : missingManualEvidence
                  ? 'Manual Portfolio Update did not read its complete captured holding roster. Retry is available.'
                : turn.portfolioReview
                  ? 'Portfolio Review did not read every server-enumerated evidence packet; no incomplete answer was shown.'
                : liveRefreshError(missingTools),
              missingTools,
              missingPackets,
              missingPrepare,
              packetBatchViolation,
            });
            if (completingPortfolioReview) {
              sendPortfolioReviewStatus({
                runId: completingPortfolioReview.runId,
                sessionId: turn.storedSessionId,
                requestId: completingPortfolioReview.requestId,
                retryable: true,
                errorCode: 'ANALYST_REVIEW_EVIDENCE_INCOMPLETE',
                error: 'Portfolio Review could not verify every required evidence packet.',
              }, {
                phase: 'complete',
                status: 'failed',
              });
              turn.portfolioReview = null;
            }
            setGmReviewStatus(
              turn,
              'failed',
              turn.liveBufferOverflow
                ? 'The guarded live-data response buffer overflowed.'
                : packetBatchViolation
                  ? 'The review exceeded the three-packet tool-call batch limit.'
                : turn.portfolioReview
                  ? 'The review did not read every required evidence packet.'
                : 'The review did not refresh every required live source.',
            );
            maybeReconcileGmBatch(turn.gmBatchId);
            if (!turn.gmBatchId) {
              reconcilePendingSession(turn.storedSessionId).catch((error) => {
                state.lastError = error.message;
              });
            }
            return;
          }
          flushAssistantEvents(browser, turn);
          turn.visibleMessageCount += 1;
          const sanitized = sanitizeCitationText(payload.text || payload.rendered || '', new Set(turn.citations.keys()));
          sendTurnFrame(turn, {
            type: 'message_complete',
            text: sanitized.text,
            status: payload.status || 'complete',
            error: payload.error || null,
            citations: citationsForIds(sanitized.accepted, turn.citations),
            rejectedCitations: sanitized.rejected,
          });
          turn.citations.clear();
          const completedPortfolioRunId = completingPortfolioReview?.runId || null;
          turn.portfolioReview = null;
          turn.manualVerification = null;
          if (completingPortfolioReview) {
            sendPortfolioReviewStatus({
              runId: completingPortfolioReview.runId,
              sessionId: turn.storedSessionId,
              requestId: completingPortfolioReview.requestId,
              retryable: completingPortfolioReview.acquiredStatus !== 'ready',
            }, {
              phase: 'complete',
              status: completingPortfolioReview.acquiredStatus || 'ready',
              acquiredStatus: completingPortfolioReview.acquiredStatus || 'ready',
            });
          }
          setGmReviewStatus(turn, 'ready');
          maybeReconcileGmBatch(turn.gmBatchId);
          if (!turn.gmBatchId) {
            reconcilePendingSession(turn.storedSessionId).catch((error) => {
              state.lastError = error.message;
            });
          }
          if (completedPortfolioRunId) {
            reviewServiceRequest(
              `/internal/portfolio-review/runs/${encodeURIComponent(completedPortfolioRunId)}/accept`,
              { method: 'POST', body: {}, timeoutMs: 15_000 },
            ).catch((error) => {
              state.lastError = error.message;
            });
          }
          return;
        }
        if (event.type === 'status.update' || event.type === 'session.info') {
          const eventStatus = String(payload.status || '').toLowerCase();
          if (payload.running === true) {
            turn.busy = true;
            sendTurnActivity(turn);
          } else if (
            payload.running === false
            && ['idle', 'complete', 'completed', 'interrupted'].includes(eventStatus)
          ) {
            turn.busy = false;
            sendTurnActivity(turn);
            if (eventStatus === 'interrupted') {
              setGmReviewStatus(turn, 'failed', 'The review was interrupted.');
            }
          }
          sendTurnFrame(turn, {
            type: 'status',
            status: payload.status || (payload.running ? 'streaming' : 'idle'),
          });
          return;
        }
        if (event.type === 'error') {
          const failingPortfolioReview = turn.portfolioReview;
          turn.busy = false;
          resetLiveResponseBuffer(turn);
          sendTurnActivity(turn);
          const errorMessage = failingPortfolioReview
            ? safePortfolioReviewError('ANALYST_PORTFOLIO_REVIEW_FAILED', payload.message)
            : payload.message || 'Hermes reported an error.';
          if (failingPortfolioReview) {
            sendPortfolioReviewStatus({
              runId: failingPortfolioReview.runId,
              sessionId: turn.storedSessionId,
              requestId: failingPortfolioReview.requestId,
              retryable: true,
              errorCode: 'ANALYST_PORTFOLIO_REVIEW_FAILED',
              error: errorMessage,
            }, {
              phase: 'complete',
              status: 'failed',
            });
            turn.portfolioReview = null;
          }
          setGmReviewStatus(turn, 'failed', errorMessage);
          maybeReconcileGmBatch(turn.gmBatchId);
          sendTurnFrame(turn, { type: 'error', error: errorMessage });
        }
      },
    });

    async function connect() {
      if (!isContractVerified()) throw new Error('Analyst contract verification is unavailable.');
      if (!token) throw new Error('Hermes dashboard token is not configured.');
      await upstream.connect();
      if (!upstreamConnected) {
        upstreamConnected = true;
        state.connectedUpstreams += 1;
        state.lastConnectedAt = new Date().toISOString();
      }
      sendJson(browser, { type: 'connection', status: 'connected' });
    }

    function sendPortfolioReviewStatus(payload, {
      started = false,
      phase = null,
      status = null,
      acquiredStatus = null,
    } = {}) {
      if (!payload?.runId) return;
      const nextStatus = status || payload.status || 'running';
      sendJson(browser, {
        type: started ? 'review_started' : 'review_status',
        reviewKind: 'portfolio-review',
        runId: payload.runId,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        status: nextStatus,
        phase: phase || (['starting', 'running'].includes(nextStatus) ? 'acquiring' : 'complete'),
        acquiredStatus: acquiredStatus || payload.acquiredStatus || null,
        retryable: payload.retryable === true || nextStatus === 'failed',
        errorCode: payload.errorCode || null,
        error: payload.error || null,
        restored: Boolean(payload.restored),
      });
    }

    async function activate(result, { requestId = null, select = true } = {}) {
      const { turn, existing } = select
        ? setRuntimeSession(result)
        : registerRuntimeSession(result, result?.stored_session_id || result?.session_key || null, { select: false });
      const history = projectHistory(result.messages || []);
      turn.sessionTitle = String(result.title || result.info?.title || turn.sessionTitle || '').trim();
      const gmMetadata = sessionReviewMetadata(turn.sessionTitle);
      turn.gmBatchId = gmMetadata.gmBatchId || null;
      turn.reviewKind = gmMetadata.reviewKind || null;
      turn.conversationId = gmMetadata.conversationId || null;
      turn.canonicalReview = gmMetadata.canonicalReview === true;
      turn.legacyReview = gmMetadata.legacyReview === true;
      turn.gmStatus = turn.reviewKind ? (turn.busy ? 'running' : 'ready') : null;
      turn.hasMessages = turn.hasMessages || history.some((message) => message.role === 'user');
      turn.visibleMessageCount = history.filter((message) => ['user', 'assistant'].includes(message?.role)).length;
      const inferred = inferLiveTurnState(result.messages || []);
      if (!existing || !turn.busy) {
        turn.citations.clear();
        turn.previousLiveRequirements = new Set(inferred.requirements);
        turn.requiredLiveTools = turn.busy ? new Set(inferred.requirements) : new Set();
        turn.completedLiveTools = turn.busy ? new Set(inferred.completed) : new Set();
        turn.liveGateOpen = !turn.busy || liveGateSatisfied(turn);
        turn.liveBufferOverflow = false;
        resetLiveResponseBuffer(turn);
      } else {
        inferred.completed.forEach((name) => turn.completedLiveTools.add(name));
        turn.liveGateOpen = liveGateSatisfied(turn);
      }
      history.forEach((message) => collectCitations(message, turn.citations));
      sendJson(browser, turnFrame(turn, {
        type: select ? 'session' : 'session_warmed',
        sessionId: turn.runtimeSessionId,
        storedSessionId: turn.storedSessionId,
        ...(requestId ? { requestId } : {}),
        title: displaySessionTitle(turn.sessionTitle),
        messages: history,
        running: turn.busy,
        visibleMessageCount: turn.visibleMessageCount,
      }));
      return { turn, existing };
    }

    function trackCreatedSession(result, storedTitle, turn) {
      if (turn?.storedSessionId) {
        pendingSessionTitles.set(turn.storedSessionId, storedTitle);
        pendingCreatedSessions.set(turn.storedSessionId, {
          id: turn.storedSessionId,
          title: storedTitle,
          source: ANALYST_SOURCE,
          created_at: result.created_at || result.started_at || new Date().toISOString(),
          updated_at: result.updated_at || result.created_at || new Date().toISOString(),
          message_count: Array.isArray(result.messages) ? result.messages.length : 0,
        });
        pendingRuntimeSessions.set(turn.storedSessionId, {
          ...result,
          title: storedTitle,
          session_id: turn.runtimeSessionId,
          stored_session_id: turn.storedSessionId,
        });
      }
    }

    async function createSession({ requestId = null, title = '', hidden = false } = {}) {
      // Keep the selected conversation's in-flight turn intact until Hermes
      // has actually created the replacement runtime. Its later events become
      // background events as soon as activate() switches the runtime ID.
      const storedTitle = String(title || '').trim() || managedSessionTitle(ANALYST_DEFAULT_SESSION_TITLE);
      const result = await upstream.request('session.create', {
        source: ANALYST_SOURCE,
        title: storedTitle,
        follow_profile_config: true,
        cols: 100,
        close_on_disconnect: false,
        ...(hidden ? { hidden: true } : {}),
      });
      const activation = await activate(
        { ...result, title: storedTitle },
        { requestId, select: !requestId || requestId === latestSelectionRequestId },
      );
      trackCreatedSession(result, storedTitle, activation.turn);
      await sendSessionList();
      return activation.turn;
    }

    async function openReviewConversationChat({
      conversationId,
      reviewKind,
      hermesSessionId = '',
      requestId = null,
    }) {
      const storedTitle = reviewFollowupSessionTitle(reviewKind, conversationId);
      let linkedSessionId = String(hermesSessionId || '').trim();
      if (!linkedSessionId) {
        const payload = await reviewServiceRequest(
          `/internal/review-conversations/${encodeURIComponent(conversationId)}`,
          { timeoutMs: 5_000 },
        );
        linkedSessionId = String(payload?.conversation?.hermesSessionId || '').trim();
      }

      const activateReview = async (result, fallbackStoredSessionId = null) => {
        const activation = await activate(
          { ...result, title: storedTitle },
          { requestId, select: !requestId || requestId === latestSelectionRequestId },
        );
        activation.turn.reviewKind = reviewKind;
        activation.turn.conversationId = conversationId;
        activation.turn.canonicalReview = false;
        activation.turn.legacyReview = false;
        activation.turn.managedReviewFollowup = true;
        if (fallbackStoredSessionId && !activation.turn.storedSessionId) {
          activation.turn.storedSessionId = fallbackStoredSessionId;
        }
        return activation;
      };

      if (linkedSessionId) {
        try {
          const result = await upstream.request('session.resume', {
            session_id: linkedSessionId,
            source: ANALYST_SOURCE,
            cols: 100,
          }, 15_000);
          return activateReview(result, linkedSessionId);
        } catch (error) {
          if (!isMissingRuntimeSessionError(error)) throw error;
        }
      }

      const result = await upstream.request('session.create', {
        source: ANALYST_SOURCE,
        title: storedTitle,
        follow_profile_config: true,
        cols: 100,
        hidden: true,
        close_on_disconnect: false,
      });
      const activation = await activateReview(result);
      const storedSessionId = String(activation.turn.storedSessionId || '').trim();
      if (!storedSessionId) {
        throw analystProtocolError(
          'ANALYST_REVIEW_SESSION_INVALID',
          'Hermes did not return a durable review session ID.',
        );
      }
      await reviewServiceRequest(
        `/internal/review-conversations/${encodeURIComponent(conversationId)}/hermes-session`,
        {
          method: 'PUT',
          body: {
            sessionId: storedSessionId,
            ...(linkedSessionId ? { previousSessionId: linkedSessionId } : {}),
          },
          timeoutMs: 5_000,
        },
      );
      return activation;
    }

    function canonicalSessionForKind(sessions, reviewKind) {
      const expectedTitle = canonicalReviewSessionTitle(reviewKind);
      return [...(sessions || [])]
        .filter((session) => String(session?.title || '').trim() === expectedTitle)
        .sort((left, right) => {
          const leftTime = Date.parse(left.created_at || left.createdAt || '') || 0;
          const rightTime = Date.parse(right.created_at || right.createdAt || '') || 0;
          return leftTime - rightTime || String(left.id || '').localeCompare(String(right.id || ''));
        })[0] || null;
    }

    async function openReviewChat(reviewKind, requestId) {
      const storedTitle = canonicalReviewSessionTitle(reviewKind);
      const sessions = await listSessions(15_000);
      const selected = canonicalSessionForKind(sessions, reviewKind);
      if (selected) {
        const pendingRuntime = pendingRuntimeSessions.get(selected.id);
        const result = pendingRuntime
          ? {
              ...pendingRuntime,
              ...await upstream.request('session.history', {
                session_id: pendingRuntime.session_id,
              }, 15_000),
              session_id: pendingRuntime.session_id,
              stored_session_id: selected.id,
            }
          : await upstream.request('session.resume', {
              session_id: selected.id,
              source: ANALYST_SOURCE,
              cols: 100,
            }, 15_000);
        return activate(
          { ...result, title: storedTitle },
          { requestId, select: requestId === latestSelectionRequestId },
        );
      }

      const result = await upstream.request('session.create', {
        source: ANALYST_SOURCE,
        title: storedTitle,
        follow_profile_config: true,
        cols: 100,
        close_on_disconnect: false,
      });
      const activation = await activate(
        { ...result, title: storedTitle },
        { requestId, select: requestId === latestSelectionRequestId },
      );
      trackCreatedSession(result, storedTitle, activation.turn);
      await sendSessionList();
      return activation;
    }

    function mergePendingSessionRows(rows, { includePending = true } = {}) {
      const persisted = (rows || []).filter((session) => (
        session.source === ANALYST_SOURCE
      ));
      const persistedIds = new Set(persisted.map((session) => session.id));
      const pendingOnly = [];
      for (const [sessionId, pending] of includePending ? pendingCreatedSessions : []) {
        // A freshly created Hermes runtime can appear in one session.list call
        // before its REST record and subsequent list reads are consistent. Do
        // not treat that first sighting as durable: keep the optimistic record
        // and runtime until the first completed message reconciliation. This
        // also lets a blank chat be renamed and revisited without flickering.
        if (!persistedIds.has(sessionId)) {
          pendingOnly.push(pending);
        }
      }
      return [...pendingOnly, ...persisted].map((session) => {
        const pendingTitle = pendingSessionTitles.get(session.id);
        if (!pendingTitle) return session;
        if (
          persistedIds.has(session.id)
          && String(session.title || '').trim() === pendingTitle
        ) {
          pendingSessionTitles.delete(session.id);
          return session;
        }
        return { ...session, title: pendingTitle };
      });
    }

    async function listSessions(timeoutMs = 120_000) {
      const result = await upstream.request('session.list', { limit: 100 }, timeoutMs);
      return mergePendingSessionRows(result.sessions || []);
    }

    async function listSessionPage({ limit = 50, offset = 0 } = {}) {
      const pageLimit = Math.max(1, Math.min(100, Number(limit) || 50));
      const pageOffset = Math.max(0, Number(offset) || 0);
      if (typeof sessionListFetchImpl === 'function') {
        try {
          const response = await sessionListFetchImpl(
            analystSessionsApiUrl(upstreamHost, { limit: pageLimit, offset: pageOffset }),
            {
              headers: {
                Accept: 'application/json',
                'X-Hermes-Session-Token': token,
              },
            },
          );
          const payload = await responsePayload(response);
          if (!response?.ok) {
            const detail = typeof payload?.detail === 'string'
              ? payload.detail
              : 'Hermes could not list Analyst conversations.';
            throw new Error(detail);
          }
          const total = Math.max(0, Number(payload?.total) || 0);
          return {
            sessions: mergePendingSessionRows(payload?.sessions || [], { includePending: pageOffset === 0 }),
            limit: pageLimit,
            offset: pageOffset,
            total,
            nextOffset: pageOffset + pageLimit < total ? pageOffset + pageLimit : null,
          };
        } catch (error) {
          // Older or restarting Hermes builds may temporarily lack the REST
          // listing route. Keep the sidebar useful through the bounded RPC
          // projection until the paginated endpoint is available again.
          state.lastError = error.message;
        }
      }

      const sessions = await listSessions(15_000);
      const page = sessions.slice(pageOffset, pageOffset + pageLimit);
      return {
        sessions: page,
        limit: pageLimit,
        offset: pageOffset,
        total: sessions.length,
        nextOffset: pageOffset + page.length < sessions.length ? pageOffset + page.length : null,
      };
    }

    async function sendSessionList({ limit = 50, offset = 0, requestId = null } = {}) {
      const page = await listSessionPage({ limit, offset });
      const sessions = page.sessions;
      const canonicalIds = new Map(
        Object.keys(ANALYST_REVIEW_CONVERSATION_IDS).map((reviewKind) => [
          reviewKind,
          canonicalSessionForKind(sessions, reviewKind)?.id || null,
        ]),
      );
      const projectedSessions = sessions.map((session) => {
          const turn = turnContextsByStored.get(session.id);
          const rawMetadata = sessionReviewMetadata(session.title);
          const duplicateCanonical = rawMetadata.canonicalReview
            && canonicalIds.get(rawMetadata.reviewKind) !== session.id;
          const gmMetadata = duplicateCanonical
            ? {
                reviewKind: rawMetadata.reviewKind,
                canonicalReview: false,
                legacyReview: true,
              }
            : rawMetadata;
          return {
            ...session,
            ...gmMetadata,
            title: displaySessionTitle(session.title),
            running: turn ? Boolean(turn.busy) : Boolean(session.running),
            ...(Number.isInteger(turn?.visibleMessageCount)
              ? { visibleMessageCount: turn.visibleMessageCount }
              : {}),
            ...(turn?.gmStatus ? { gmStatus: turn.gmStatus } : {}),
          };
        });
      sendJson(browser, {
        type: 'session_list',
        sessions: projectedSessions.filter((session) => !session.managedReviewFollowup),
        append: page.offset > 0,
        limit: page.limit,
        offset: page.offset,
        total: page.total,
        nextOffset: page.nextOffset,
        ...(requestId ? { requestId } : {}),
      });
    }

    async function patchPersistedSessionTitle(sessionId, title) {
      const response = await fetchImpl(analystSessionApiUrl(upstreamHost, sessionId), {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Hermes-Session-Token': token,
        },
        body: JSON.stringify({ title }),
      });
      const payload = await responsePayload(response);
      if (!response?.ok) {
        const detail = typeof payload?.detail === 'string'
          ? payload.detail
          : (typeof payload?.error === 'string' ? payload.error : 'Hermes could not rename the conversation.');
        throw new Error(detail);
      }
      const renamedTitle = String(payload?.title || title).trim();
      if (!renamedTitle) throw new Error('Hermes returned an empty conversation name.');
      return renamedTitle;
    }

    const pendingSessionReconciliations = new Map();
    const pendingBatchReconciliations = new Map();

    async function reconcilePendingSession(sessionId) {
      if (
        !sessionId
        || (!pendingCreatedSessions.has(sessionId) && !pendingSessionTitles.has(sessionId))
      ) return;
      if (pendingSessionReconciliations.has(sessionId)) {
        return pendingSessionReconciliations.get(sessionId);
      }

      const reconciliation = (async () => {
        for (const delayMs of [0, 250, 1_000, 3_000]) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const result = await upstream.request('session.list', { limit: 100 });
          const persisted = (result.sessions || []).find((session) => (
            session.id === sessionId && session.source === ANALYST_SOURCE
          ));
          if (!persisted) continue;

          const desiredTitle = pendingSessionTitles.get(sessionId);
          if (desiredTitle && String(persisted.title || '').trim() !== desiredTitle) {
            try {
              await patchPersistedSessionTitle(sessionId, desiredTitle);
            } catch (error) {
              if (/session not found/i.test(String(error?.message || error))) continue;
              throw error;
            }
          }
          // Project one final list while the optimistic shadow is still in
          // place, then release the temporary runtime only after persistence
          // (and any deferred title) has succeeded.
          await sendSessionList();
          pendingCreatedSessions.delete(sessionId);
          pendingRuntimeSessions.delete(sessionId);
          return;
        }
      })().finally(() => pendingSessionReconciliations.delete(sessionId));
      pendingSessionReconciliations.set(sessionId, reconciliation);
      return reconciliation;
    }

    function maybeReconcileGmBatch(batchId) {
      if (!batchId) return;
      const batch = gmBatches.get(batchId);
      if (!batch || [...batch.reviews.values()].some((review) => (
        ['starting', 'running'].includes(review.status)
      ))) return;
      reconcilePendingGmBatch(batchId).catch((error) => {
        state.lastError = error.message;
      });
    }

    async function reconcilePendingGmBatch(batchId) {
      if (pendingBatchReconciliations.has(batchId)) {
        return pendingBatchReconciliations.get(batchId);
      }
      const batch = gmBatches.get(batchId);
      if (!batch) return;
      const sessionIds = [...batch.reviews.values()]
        .map((review) => review.sessionId)
        .filter(Boolean);
      if (!sessionIds.some((sessionId) => (
        pendingCreatedSessions.has(sessionId) || pendingSessionTitles.has(sessionId)
      ))) return;

      const reconciliation = (async () => {
        for (const delayMs of [0, 250, 1_000, 3_000]) {
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const result = await upstream.request('session.list', { limit: 100 });
          const persistedById = new Map((result.sessions || [])
            .filter((session) => session.source === ANALYST_SOURCE)
            .map((session) => [session.id, session]));
          if (sessionIds.some((sessionId) => !persistedById.has(sessionId))) continue;

          for (const sessionId of sessionIds) {
            const desiredTitle = pendingSessionTitles.get(sessionId);
            const persisted = persistedById.get(sessionId);
            if (desiredTitle && String(persisted?.title || '').trim() !== desiredTitle) {
              await patchPersistedSessionTitle(sessionId, desiredTitle);
            }
          }
          await sendSessionList();
          for (const sessionId of sessionIds) {
            pendingCreatedSessions.delete(sessionId);
            pendingRuntimeSessions.delete(sessionId);
          }
          return;
        }
      })().finally(() => pendingBatchReconciliations.delete(batchId));
      pendingBatchReconciliations.set(batchId, reconciliation);
      return reconciliation;
    }

    async function openMostRecent(preferredSessionId = null, requestId = null) {
      const sessions = await listSessions();
      const explicitlyPreferred = preferredSessionId
        ? sessions.find((session) => session.id === preferredSessionId)
        : null;
      const generalSessions = sessions.filter((session) => (
        !sessionReviewMetadata(session.title).reviewKind
      ));
      if (!explicitlyPreferred && !generalSessions.length) {
        return createSession({ requestId });
      }
      const selected = explicitlyPreferred || generalSessions[0];
      const result = await upstream.request('session.resume', {
        session_id: selected.id,
        source: ANALYST_SOURCE,
        cols: 100,
      }, 15_000);
      const select = !requestId || requestId === latestSelectionRequestId;
      return activate({ ...result, title: selected.title }, { requestId, select });
    }

    async function resumeStoredRuntimeForPrompt(turn = context) {
      const storedSessionId = turn.storedSessionId;
      if (!storedSessionId) return openMostRecent();
      const result = await upstream.request('session.resume', {
        session_id: storedSessionId,
        source: ANALYST_SOURCE,
        cols: 100,
      });
      registerRuntimeSession(result, storedSessionId, { select: turn === context });
      return result;
    }

    async function submitPromptWithRecovery(text, turn = context, { visibleText = text } = {}) {
      const submitToCurrentRuntime = async () => {
        if (!turn.runtimeSessionId) await resumeStoredRuntimeForPrompt(turn);
        const runtimeSessionId = turn.runtimeSessionId;
        // Existing Hermes sessions pin their original system prompt. Carry the
        // current conditional output contract on new turns, using the same
        // hidden guidance path as live verification and captured review context.
        const guidedText = [ACCOUNT_COMPARISON_PREFIX, ACCOUNT_COMPARISON_GUIDANCE, ACCOUNT_COMPARISON_SUFFIX, text].join('\n');
        const submittedText = turn.manualVerification
          ? manualEvidencePrompt(guidedText, turn.manualVerification.binding, LIVE_INSTRUCTIONS_PREFIX, LIVE_INSTRUCTIONS_SUFFIX)
          : liveVerificationPrompt(guidedText, turn.requiredLiveTools);
        turn.submittedPrompt = submittedText;
        turn.submittedAt = Date.now();
        return upstream.request('prompt.submit', { session_id: runtimeSessionId, text: submittedText }, 30_000);
      };

      try {
        return await submitToCurrentRuntime();
      } catch (error) {
        if (!isMissingRuntimeSessionError(error) || !turn.storedSessionId) {
          clearTurn(turn);
          sendTurnActivity(turn);
          throw error;
        }
        forgetTurnRuntime(turn);
        turn.busy = false;
        try {
          const pendingPortfolioReview = turn.portfolioReview;
          const pendingManual = turn.manualVerification;
          await resumeStoredRuntimeForPrompt(turn);
          turn.citations.clear();
          turn.busy = true;
          if (pendingManual) {
            beginManualEvidence(turn, pendingManual.binding);
          } else if (pendingPortfolioReview) {
            turn.portfolioReview = pendingPortfolioReview;
            turn.liveGateOpen = responseGateSatisfied(turn);
            resetLiveResponseBuffer(turn);
          } else {
            beginLiveTurn(turn, visibleText);
          }
          sendTurnActivity(turn);
          return await submitToCurrentRuntime();
        } catch (recoveryError) {
          clearTurn(turn);
          sendTurnActivity(turn);
          throw recoveryError;
        }
      }
    }

    async function promptWithOptionalReviewContext(text, runId, target = {}) {
      const normalizedRunId = String(runId || '').trim();
      if (!normalizedRunId || normalizedRunId.length > 200) return text;
      try {
        const payload = await reviewServiceRequest(
          `/internal/reviews/${encodeURIComponent(normalizedRunId)}/context`,
          { timeoutMs: 3_000 },
        );
        const reviewContext = payload?.context;
        const expectedConversationId = String(target.conversationId || '').trim();
        const expectedReviewKind = String(target.reviewKind || '').trim();
        const canonicalMatch = expectedConversationId
          && String(reviewContext?.conversationId || '') === expectedConversationId
          && String(reviewContext?.reviewKind || '') === expectedReviewKind;
        const legacyMatch = !expectedConversationId
          && String(reviewContext?.sessionId || '') === String(target.sessionId || '');
        let workspaceMatch = false;
        if (!canonicalMatch && !legacyMatch && !expectedConversationId
          && reviewContext?.schema === 'ReviewContextV2'
          && String(reviewContext.runId || '') === normalizedRunId
          && reviewContext.conversationId && target.sessionId) {
          const saved = await reviewServiceRequest('/internal/workspace/get', {
            method: 'POST',
            body: { conversationId: reviewContext.conversationId, includeBriefs: false },
            timeoutMs: 3_000,
          });
          workspaceMatch = String(saved?.conversation?.id || '') === String(reviewContext.conversationId)
            && String(saved.conversation.kind || '') === String(reviewContext.reviewKind || '')
            && String(saved.conversation.hermes_id || '') === String(target.sessionId);
        }
        if (
          !reviewContext
          || reviewContext.schema !== 'ReviewContextV2'
          || String(reviewContext.runId || '') !== normalizedRunId
          || (!canonicalMatch && !legacyMatch && !workspaceMatch)
        ) return text;
        const reviewTurn = turnContextsByStored.get(String(target.sessionId || ''));
        if (reviewTurn) collectCitations(reviewContext, reviewTurn.citations);
        return attachReviewContextToPrompt(text, reviewContext);
      } catch (_error) {
        // Follow-up context is an enhancement. A review-store outage must not
        // block an otherwise valid Hermes chat turn, and current-data prompts
        // still pass through the independent live-tool gate below.
        return text;
      }
    }

    async function setSessionTitle(sessionId, title) {
      const sessions = await listSessions();
      const selected = sessions.find((item) => item.id === sessionId);
      if (!selected) throw new Error('Analyst session was not found.');
      const pendingCreate = pendingCreatedSessions.has(selected.id);
      const selectedTurn = turnContextsByStored.get(selected.id);
      const activeRuntime = selectedTurn?.runtimeSessionId;
      let renamedTitle;
      if (activeRuntime) {
        const result = await upstream.request('session.title', {
          session_id: activeRuntime,
          title,
        });
        renamedTitle = String(result?.title || title).trim();
      } else if (pendingCreate) {
        renamedTitle = title;
      } else {
        renamedTitle = await patchPersistedSessionTitle(selected.id, title);
      }

      pendingSessionTitles.set(selected.id, renamedTitle);
      if (selectedTurn) {
        const gmMetadata = sessionReviewMetadata(renamedTitle);
        selectedTurn.sessionTitle = renamedTitle;
        selectedTurn.gmBatchId = gmMetadata.gmBatchId || null;
        selectedTurn.reviewKind = gmMetadata.reviewKind || null;
        selectedTurn.conversationId = gmMetadata.conversationId || null;
        selectedTurn.canonicalReview = gmMetadata.canonicalReview === true;
        selectedTurn.legacyReview = gmMetadata.legacyReview === true;
        selectedTurn.gmStatus = selectedTurn.reviewKind
          ? (selectedTurn.busy ? 'running' : 'ready')
          : null;
      }
      if (pendingCreate) {
        pendingCreatedSessions.set(selected.id, {
          ...pendingCreatedSessions.get(selected.id),
          title: renamedTitle,
          updated_at: new Date().toISOString(),
        });
        if (pendingRuntimeSessions.has(selected.id)) {
          pendingRuntimeSessions.set(selected.id, {
            ...pendingRuntimeSessions.get(selected.id),
            title: renamedTitle,
          });
        }
      }
      return renamedTitle;
    }

    async function broadcastSessionTitle(sessionId, storedTitle) {
      sendJson(browser, {
        type: 'session_renamed',
        sessionId,
        title: displaySessionTitle(storedTitle),
      });
      await sendSessionList();
    }

    async function applyInitialReviewSessionTitle(requestedTitle) {
      const title = requestedReviewSessionTitle(requestedTitle);
      if (!title || context.hasMessages || !context.storedSessionId) return;
      const currentTitle = context.sessionTitle;
      if (
        currentTitle
        && !isManagedSessionTitle(currentTitle)
        && displaySessionTitle(currentTitle) !== ANALYST_DEFAULT_SESSION_TITLE
      ) return;

      const storedTitle = managedSessionTitle(title, currentTitle);
      const renamedTitle = await setSessionTitle(context.storedSessionId, storedTitle);
      await broadcastSessionTitle(context.storedSessionId, renamedTitle);
    }

    function rememberManagedTitle(turn, storedTitle) {
      turn.sessionTitle = storedTitle;
      pendingSessionTitles.set(turn.storedSessionId, storedTitle);
      if (pendingCreatedSessions.has(turn.storedSessionId)) {
        pendingCreatedSessions.set(turn.storedSessionId, {
          ...pendingCreatedSessions.get(turn.storedSessionId),
          title: storedTitle,
          updated_at: new Date().toISOString(),
        });
      }
      if (pendingRuntimeSessions.has(turn.storedSessionId)) {
        pendingRuntimeSessions.set(turn.storedSessionId, {
          ...pendingRuntimeSessions.get(turn.storedSessionId),
          title: storedTitle,
        });
      }
    }

    async function titleGmPrimary(turn, batchId) {
      const storedTitle = managedSessionTitle('Portfolio Review', '', batchId);
      const result = await upstream.request('session.title', {
        session_id: turn.runtimeSessionId,
        title: storedTitle,
      });
      const renamedTitle = String(result?.title || storedTitle).trim();
      if (!renamedTitle) throw new Error('Hermes returned an empty conversation name.');
      rememberManagedTitle(turn, renamedTitle);
      turn.gmBatchId = batchId;
      turn.reviewKind = 'portfolio-review';
      turn.gmStatus = 'starting';
      sendJson(browser, {
        type: 'session_renamed',
        sessionId: turn.storedSessionId,
        title: 'Portfolio Review',
        gmBatchId: batchId,
        reviewKind: 'portfolio-review',
      });
    }

    async function titlePortfolioReview(turn, runId) {
      const storedTitle = managedSessionTitle('Portfolio Review', '', runId);
      const result = await upstream.request('session.title', {
        session_id: turn.runtimeSessionId,
        title: storedTitle,
      }, 15_000);
      const renamedTitle = String(result?.title || storedTitle).trim();
      if (!renamedTitle) throw new Error('Hermes returned an empty conversation name.');
      rememberManagedTitle(turn, renamedTitle);
      turn.gmBatchId = runId;
      turn.reviewKind = 'portfolio-review';
      turn.gmStatus = null;
      sendJson(browser, {
        type: 'session_renamed',
        sessionId: turn.storedSessionId,
        title: 'Portfolio Review',
        gmBatchId: runId,
        reviewKind: 'portfolio-review',
      });
    }

    async function pollPortfolioReview(turn, initial) {
      let snapshot = initial;
      const startedAt = Date.now();
      while (['starting', 'running'].includes(String(snapshot?.status || ''))) {
        if (Date.now() - startedAt >= PORTFOLIO_REVIEW_POLL_TIMEOUT_MS) {
          throw analystProtocolError(
            'ANALYST_PORTFOLIO_REVIEW_TIMEOUT',
            'Portfolio Review acquisition exceeded its three-minute bound. The persisted run can still be reopened without creating another chat.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        snapshot = await reviewServiceRequest(
          `/internal/portfolio-review/runs/${encodeURIComponent(initial.runId)}`,
          { timeoutMs: 15_000 },
        );
      }
      return snapshot;
    }

    async function continuePortfolioReview(turn, initial) {
      try {
        const completed = await pollPortfolioReview(turn, initial);
        const packetDescriptors = Array.isArray(completed.packets) ? completed.packets : [];
        const packetIds = packetDescriptors
          .map((packet) => String(packet?.packetId || '').trim())
          .filter(Boolean);
        if (!packetIds.length) {
          turn.busy = false;
          sendTurnActivity(turn);
          throw analystProtocolError(
            completed.status === 'failed'
              ? completed.errorCode || 'ANALYST_PORTFOLIO_REVIEW_FAILED'
              : 'ANALYST_REVIEW_PACKET_MANIFEST_INVALID',
            completed.error || (
              completed.status === 'failed'
                ? 'Portfolio Review acquisition failed before evidence packets were created.'
                : 'Portfolio Review completed without an evidence packet manifest; no model answer was requested.'
            ),
          );
        }
        if (
          packetIds.length !== packetDescriptors.length
          || new Set(packetIds).size !== packetIds.length
          || !packetDescriptors.every((packet) => portfolioPacketMatches(packet, packet))
        ) {
          throw analystProtocolError(
            'ANALYST_REVIEW_PACKET_MANIFEST_INVALID',
            'Portfolio Review returned an invalid or oversized evidence packet manifest; no model answer was requested.',
          );
        }
        const prompt = portfolioReviewPrompt(completed.runId, packetDescriptors);
        turn.citations.clear();
        turn.busy = true;
        beginPortfolioReviewTurn(
          turn,
          completed.runId,
          packetDescriptors,
          completed.status,
          completed.requestId,
        );
        sendTurnActivity(turn);
        sendPortfolioReviewStatus(completed, {
          phase: 'synthesizing',
          status: 'running',
          acquiredStatus: completed.status,
        });
        await submitPromptWithRecovery(prompt, turn);
      } catch (error) {
        clearTurn(turn);
        sendTurnActivity(turn);
        const code = error.code || 'ANALYST_PORTFOLIO_REVIEW_FAILED';
        const publicError = safePortfolioReviewError(code, error.message);
        state.lastError = publicError;
        sendPortfolioReviewStatus({
          runId: initial.runId,
          sessionId: initial.sessionId || turn.storedSessionId,
          requestId: initial.requestId,
          retryable: true,
          errorCode: code,
          error: publicError,
        }, {
          phase: 'complete',
          status: 'failed',
        });
        sendTurnFrame(turn, {
          type: 'error',
          action: 'start_review',
          code,
          error: publicError,
        });
      }
    }

    async function startPortfolioReview({ reviewKind, sessionId, requestId, retry = false }) {
      if (reviewKind !== 'portfolio-review') {
        throw analystProtocolError(
          'ANALYST_REVIEW_KIND_UNSUPPORTED',
          'Only portfolio-review is supported by the sectioned review runner.',
        );
      }
      const requestedSessionId = String(sessionId || '').trim();
      const requestedRequestId = String(requestId || '').trim();
      if (!requestedSessionId || !requestedRequestId) {
        throw analystProtocolError(
          'ANALYST_REVIEW_INVALID_REQUEST',
          'Portfolio Review requires explicit sessionId and requestId values.',
        );
      }
      const turn = turnContextsByStored.get(requestedSessionId) || context;
      if (turn.storedSessionId !== requestedSessionId || !turn.runtimeSessionId) {
        throw analystProtocolError(
          'ANALYST_REVIEW_SESSION_MISMATCH',
          'Portfolio Review must target the currently opened Analyst conversation.',
        );
      }
      if (turn.busy) {
        throw analystProtocolError(
          'ANALYST_REVIEW_SESSION_BUSY',
          'Wait for the selected Analyst response to finish before starting Portfolio Review.',
        );
      }
      const historyResult = await upstream.request('session.history', {
        session_id: turn.runtimeSessionId,
      }, 15_000);
      const projectedHistory = projectHistory(historyResult?.messages || []);
      const visibleMessages = projectedHistory.filter((message) => ['user', 'assistant'].includes(message?.role));
      if (!retry && (historyResult?.running || visibleMessages.length > 0)) {
        throw analystProtocolError(
          'ANALYST_REVIEW_REQUIRES_EMPTY_SESSION',
          'Portfolio Review can only start from an idle, empty Analyst conversation.',
        );
      }
      if (retry) {
        const prior = await reviewServiceRequest(
          `/internal/portfolio-review/sessions/${encodeURIComponent(requestedSessionId)}`,
          { timeoutMs: 10_000 },
        );
        const retryableStatus = ['partial', 'blocked', 'failed'].includes(String(prior?.status || ''))
          || (prior?.status === 'ready' && !prior?.acceptedAt);
        if (!prior?.completedAt || !retryableStatus) {
          throw analystProtocolError(
            'ANALYST_REVIEW_NOT_RETRYABLE',
            'Portfolio Review retry requires a completed, unaccepted or degraded prior run for this conversation.',
          );
        }
      }

      const runId = randomUUID();
      const originalTitle = turn.sessionTitle;
      await titlePortfolioReview(turn, runId);
      let started;
      try {
        started = await reviewServiceRequest('/internal/portfolio-review/runs', {
          method: 'POST',
          body: {
            reviewKind: 'portfolio-review',
            sessionId: requestedSessionId,
            requestId: requestedRequestId,
            runId,
          },
          timeoutMs: 15_000,
        });
      } catch (error) {
        try {
          const restored = await upstream.request('session.title', {
            session_id: turn.runtimeSessionId,
            title: originalTitle || managedSessionTitle(ANALYST_DEFAULT_SESSION_TITLE),
          }, 15_000);
          const restoredTitle = String(
            restored?.title || originalTitle || managedSessionTitle(ANALYST_DEFAULT_SESSION_TITLE),
          ).trim();
          rememberManagedTitle(turn, restoredTitle);
          const restoredMetadata = sessionReviewMetadata(restoredTitle);
          turn.gmBatchId = restoredMetadata.gmBatchId || null;
          turn.reviewKind = restoredMetadata.reviewKind || null;
          turn.conversationId = restoredMetadata.conversationId || null;
          turn.canonicalReview = restoredMetadata.canonicalReview === true;
          turn.legacyReview = restoredMetadata.legacyReview === true;
          turn.gmStatus = turn.reviewKind ? 'ready' : null;
          sendJson(browser, {
            type: 'session_renamed',
            sessionId: turn.storedSessionId,
            title: displaySessionTitle(restoredTitle),
            ...(turn.gmBatchId ? { gmBatchId: turn.gmBatchId } : {}),
            ...(turn.reviewKind ? { reviewKind: turn.reviewKind } : {}),
          });
        } catch (_restoreError) {
          // Report the launch failure; the empty renamed chat remains readable.
        }
        throw error;
      }
      turn.busy = true;
      turn.hasMessages = true;
      turn.visibleMessageCount += 1;
      sendTurnActivity(turn);
      sendTurnFrame(turn, {
        type: 'user_message',
        text: 'Portfolio Review',
        displayText: 'Portfolio Review',
        reviewKind: 'portfolio-review',
        runId,
      });
      sendPortfolioReviewStatus(started, {
        started: true,
        phase: 'acquiring',
        status: 'running',
      });
      void continuePortfolioReview(turn, started);
      return turn;
    }

    async function createGmCompanionTurn(record, batchId) {
      const storedTitle = managedSessionTitle(record.title, '', batchId);
      const result = await upstream.request('session.create', {
        source: ANALYST_SOURCE,
        title: storedTitle,
        follow_profile_config: true,
        cols: 100,
        close_on_disconnect: false,
      });
      const { turn } = registerRuntimeSession(
        { ...result, title: storedTitle },
        null,
        { select: false },
      );
      if (!turn.storedSessionId) {
        forgetTurnRuntime(turn);
        throw new Error('Hermes did not return a stored session ID for the background review.');
      }
      turn.sessionTitle = storedTitle;
      turn.gmBatchId = batchId;
      turn.reviewKind = record.reviewKind;
      turn.gmStatus = 'starting';
      record.sessionId = turn.storedSessionId;
      trackCreatedSession(result, storedTitle, turn);
      return turn;
    }

    function hydrateGmCompanionTurn(turn, result, record, batchId) {
      const history = Array.isArray(result?.messages) ? result.messages : [];
      const inferred = inferLiveTurnState(history);
      const expected = liveRequirementsForPrompt(record.text);
      if (
        result?.running
        && [...expected].some((name) => !inferred.requirements.has(name))
      ) {
        forgetTurnRuntime(turn);
        turnContextsByStored.delete(turn.storedSessionId);
        clearTurn(turn);
        throw new Error('The running GM review could not be reattached with complete live-data gate evidence.');
      }
      turn.sessionTitle = managedSessionTitle(record.title, '', batchId);
      turn.gmBatchId = batchId;
      turn.reviewKind = record.reviewKind;
      turn.gmStatus = result?.running ? 'running' : 'starting';
      turn.hasMessages = turn.hasMessages || history.some((message) => message?.role === 'user');
      turn.citations.clear();
      history.forEach((message) => collectCitations(message, turn.citations));
      turn.previousLiveRequirements = new Set(inferred.requirements);
      turn.requiredLiveTools = result?.running ? new Set(inferred.requirements) : new Set();
      turn.completedLiveTools = result?.running ? new Set(inferred.completed) : new Set();
      turn.liveGateOpen = !result?.running || liveGateSatisfied(turn);
      turn.liveBufferOverflow = false;
      resetLiveResponseBuffer(turn);
      return Boolean(result?.running);
    }

    async function existingGmCompanionTurn(record, batchId) {
      let turn = record.sessionId ? turnContextsByStored.get(record.sessionId) : null;
      if (!turn && record.sessionId) {
        turn = createTurnContext();
        turn.storedSessionId = record.sessionId;
        turnContextsByStored.set(record.sessionId, turn);
        const result = await resumeStoredRuntimeForPrompt(turn);
        return {
          turn,
          continuing: hydrateGmCompanionTurn(turn, result, record, batchId),
        };
      }
      if (!turn) {
        return {
          turn: await createGmCompanionTurn(record, batchId),
          continuing: false,
        };
      }
      turn.gmBatchId = batchId;
      turn.reviewKind = record.reviewKind;
      turn.gmStatus = turn.busy ? 'running' : 'starting';
      return { turn, continuing: Boolean(turn.busy) };
    }

    async function startGmCompanion(batch, record, { retry = false } = {}) {
      let turn = null;
      try {
        let continuing = false;
        if (retry) {
          const existing = await existingGmCompanionTurn(record, batch.batchId);
          turn = existing.turn;
          continuing = existing.continuing;
        } else {
          turn = await createGmCompanionTurn(record, batch.batchId);
        }
        if (continuing) {
          record.status = 'running';
          record.error = null;
          sendTurnActivity(turn);
          return record;
        }
        const shouldProjectUserMessage = !retry || !turn.hasMessages;
        turn.citations.clear();
        turn.busy = true;
        beginLiveTurn(turn, record.text);
        turn.hasMessages = true;
        record.status = 'starting';
        record.error = null;
        sendTurnActivity(turn);
        if (shouldProjectUserMessage) {
          sendTurnFrame(turn, { type: 'user_message', text: record.text });
        }
        await submitPromptWithRecovery(record.text, turn);
        if (turn.gmStatus === 'starting') turn.gmStatus = 'running';
        if (record.status === 'starting') {
          record.status = 'running';
          record.error = null;
        }
        return record;
      } catch (error) {
        if (turn) {
          clearTurn(turn);
          turn.gmStatus = 'failed';
          sendTurnActivity(turn);
        }
        record.status = 'failed';
        record.error = error.message;
        throw error;
      }
    }

    async function startGmBatch(reviews) {
      if (!context.runtimeSessionId || !context.storedSessionId) {
        throw new Error('Open an empty Analyst conversation before starting GM.');
      }
      if (context.busy) {
        throw new Error('Wait for the selected Analyst response to finish before starting GM.');
      }
      if (context.hasMessages) {
        throw new Error('GM can only start from an empty Analyst conversation.');
      }

      const batchId = randomUUID();
      const records = reviews.map((review) => ({
        reviewKind: ANALYST_MANAGED_TITLE_SLUGS.get(review.conversationTitle),
        title: review.conversationTitle,
        text: review.text,
        status: 'starting',
        error: null,
      }));
      const batch = {
        batchId,
        primarySessionId: context.storedSessionId,
        reviews: new Map(records.map((review) => [review.reviewKind, review])),
      };
      gmBatches.set(batchId, batch);

      const primary = records[0];
      const primaryTurn = context;
      primary.sessionId = primaryTurn.storedSessionId;
      await titleGmPrimary(primaryTurn, batchId);
      primaryTurn.citations.clear();
      primaryTurn.busy = true;
      beginLiveTurn(primaryTurn, primary.text);
      primaryTurn.hasMessages = true;
      sendTurnActivity(primaryTurn);
      sendTurnFrame(primaryTurn, { type: 'user_message', text: primary.text });
      try {
        await submitPromptWithRecovery(primary.text, primaryTurn);
      } catch (error) {
        primary.status = 'failed';
        primary.error = error.message;
        primaryTurn.gmStatus = 'failed';
        throw error;
      }
      if (primary.status === 'starting') primary.status = 'running';
      if (primaryTurn.gmStatus === 'starting') primaryTurn.gmStatus = 'running';

      const companions = records.slice(1);
      await Promise.allSettled(companions.map((review) => startGmCompanion(batch, review)));
      sendJson(browser, {
        type: 'gm_started',
        batchId,
        primarySessionId: primaryTurn.storedSessionId,
        reviews: records.map(gmReviewDescriptor),
      });
      sendSessionList().catch((error) => {
        state.lastError = error.message;
      });
      return primaryTurn;
    }

    async function reconstructGmRetryBatch(batchId, reviewKind, text) {
      const requested = requestedReconnectGmRetry(batchId, reviewKind, text);
      const sessions = await listSessions();
      const matches = sessions.filter((session) => {
        const metadata = managedSessionMetadata(session.title);
        return metadata.gmBatchId?.toLowerCase() === requested.batchId
          && metadata.reviewKind === requested.reviewKind;
      });
      if (matches.length > 1) {
        throw new Error('GM retry found multiple matching managed conversations and was blocked.');
      }
      const review = {
        reviewKind: requested.reviewKind,
        title: ANALYST_MANAGED_TITLE_LABELS[requested.reviewKind],
        text: requested.text,
        ...(matches[0]?.id ? { sessionId: matches[0].id } : {}),
        status: 'failed',
        error: null,
      };
      const batch = {
        batchId: requested.batchId,
        primarySessionId: null,
        reviews: new Map([[review.reviewKind, review]]),
      };
      gmBatches.set(batch.batchId, batch);
      return batch;
    }

    async function retryGmReview(batchId, reviewKind, text = '') {
      const requestedBatchId = String(batchId || '').trim();
      const requestedReviewKind = String(reviewKind || '').trim().toLowerCase();
      const batch = gmBatches.get(requestedBatchId)
        || gmBatches.get(requestedBatchId.toLowerCase())
        || await reconstructGmRetryBatch(requestedBatchId, requestedReviewKind, text);
      const review = batch?.reviews.get(requestedReviewKind);
      if (!batch || !review) throw new Error('GM review was not found.');
      if (review.reviewKind === 'portfolio-review') {
        throw new Error('Start a new GM batch to retry Portfolio Review.');
      }
      if (review.status !== 'failed') throw new Error('Only a failed GM review can be retried.');

      review.status = 'starting';
      review.error = null;
      sendGmReviewStatus(batch.batchId, review);
      try {
        await startGmCompanion(batch, review, { retry: true });
        sendGmReviewStatus(batch.batchId, review);
      } catch (error) {
        review.status = 'failed';
        review.error = error.message;
        sendGmReviewStatus(batch.batchId, review);
      }
      sendSessionList().catch((error) => {
        state.lastError = error.message;
      });
    }

    async function renameSession(sessionId, requestedTitle) {
      const title = String(requestedTitle || '').trim();
      if (!title || title.length > ANALYST_SESSION_TITLE_MAX_LENGTH) {
        throw new Error(`Conversation name must contain 1–${ANALYST_SESSION_TITLE_MAX_LENGTH} characters.`);
      }
      if (typeof fetchImpl !== 'function') {
        throw new Error('Conversation renaming is unavailable because the Hermes session API is not configured.');
      }

      const turn = turnContextsByStored.get(sessionId);
      let reviewMetadata = turn?.reviewKind ? {
        canonicalReview: turn.canonicalReview,
        legacyReview: turn.legacyReview,
      } : null;
      if (!reviewMetadata) {
        const sessions = await listSessions(15_000);
        const selected = sessions.find((candidate) => candidate.id === sessionId);
        if (!selected) throw new Error('Analyst session was not found.');
        reviewMetadata = sessionReviewMetadata(selected.title);
      }
      if (reviewMetadata.canonicalReview) {
        throw analystProtocolError(
          'ANALYST_CANONICAL_REVIEW_IMMUTABLE',
          'The three review conversations have fixed names.',
        );
      }
      if (reviewMetadata.legacyReview) {
        throw analystProtocolError(
          'ANALYST_LEGACY_REVIEW_READ_ONLY',
          'Legacy review chats are read-only archives.',
        );
      }
      const storedTitle = ANALYST_V2_REVIEW_SESSION_TITLES.has(title)
        ? managedSessionTitle(title, turn?.sessionTitle || '')
        : title;
      const renamedTitle = await setSessionTitle(sessionId, storedTitle);
      await broadcastSessionTitle(sessionId, renamedTitle);
    }

    const admitMessage = createMessageBudget();
    let pendingActions = 0;
    browser.on('error', () => browser.close());
    browser.on('message', (raw) => {
      if (!isContractVerified()) { browser.close(1013, 'Analyst verification unavailable'); return; }
      if (!admitMessage() || pendingActions >= 32) { browser.close(1008, 'Analyst request budget exceeded'); return; }
      pendingActions += 1;
      const handleAction = async () => {
        let action = '';
        let actionTurn = null;
        try {
          if (!isContractVerified() || browser.readyState !== WebSocket.OPEN) return;
          const message = JSON.parse(String(raw));
          action = message.action || '';
          if (![
            'open', 'open_review_chat', 'prompt', 'new_prompt', 'review_prompt', 'resume_review', 'manual_verification_prompt',
            'interrupt', 'new_chat', 'gm', 'retry_gm_review',
            'start_review', 'retry_review', 'list_sessions', 'resume', 'cancel_resume',
            'rename_session',
          ].includes(message.action)) {
            throw new Error('Unsupported Analyst action.');
          }
          if (message.action === 'gm' || message.action === 'retry_gm_review') {
            throw analystProtocolError(
              'ANALYST_GM_RETIRED',
              'GM has been retired. Start Portfolio Review, Predictive Markets Review, or Balance Review independently.',
            );
          }
          if (message.action === 'start_review' || message.action === 'retry_review') {
            throw analystProtocolError(
              'ANALYST_REVIEW_PROTOCOL_RETIRED',
              'Review launches use the durable Analyst review HTTP API.',
            );
          }
          await connect();
          if (message.action === 'open') {
            const requestId = String(message.requestId || randomUUID());
            latestSelectionRequestId = requestId;
            await openMostRecent(String(message.sessionId || '').trim() || null, requestId);
          } else if (message.action === 'open_review_chat') {
            const requestId = String(message.requestId || randomUUID());
            const reviewKind = String(message.reviewKind || '').trim();
            latestSelectionRequestId = requestId;
            await openReviewChat(reviewKind, requestId);
          } else if (message.action === 'resume_review') {
            const requestId = String(message.requestId || randomUUID());
            latestSelectionRequestId = requestId;
            await openReviewConversationChat({
              conversationId: String(message.conversationId || '').trim(),
              reviewKind: String(message.reviewKind || '').trim(),
              hermesSessionId: String(message.hermesSessionId || '').trim(),
              requestId,
            });
          } else if (message.action === 'new_chat') {
            const requestId = String(message.requestId || randomUUID());
            latestSelectionRequestId = requestId;
            await createSession({ requestId });
          } else if (message.action === 'list_sessions') {
            await sendSessionList({
              limit: message.limit,
              offset: message.offset,
              requestId: String(message.requestId || '').trim() || null,
            });
          } else if (message.action === 'cancel_resume') {
            latestSelectionRequestId = String(message.requestId || randomUUID());
            sendJson(browser, {
              type: 'resume_cancelled',
              requestId: latestSelectionRequestId,
            });
          } else if (message.action === 'resume') {
            const requestId = String(message.requestId || randomUUID());
            latestSelectionRequestId = requestId;
            const sessions = await listSessions(15_000);
            const selected = sessions.find((session) => session.id === message.sessionId);
            if (!selected) throw new Error('Analyst session was not found.');
            const pendingRuntime = pendingRuntimeSessions.get(selected.id);
            const result = pendingRuntime
              ? {
                  ...pendingRuntime,
                  ...await upstream.request('session.history', {
                    session_id: pendingRuntime.session_id,
                  }, 15_000),
                  session_id: pendingRuntime.session_id,
                  stored_session_id: selected.id,
                }
              : await upstream.request('session.resume', {
                  session_id: selected.id,
                  source: ANALYST_SOURCE,
                  cols: 100,
                }, 15_000);
            await activate(
              { ...result, title: selected.title },
              { requestId, select: requestId === latestSelectionRequestId },
            );
          } else if (message.action === 'rename_session') {
            await renameSession(String(message.sessionId || ''), message.title);
          } else if (message.action === 'manual_verification_prompt') {
            const text = String(message.text || '').trim();
            if (!text || text.length > 20_000 || message.requestId !== message.turnId) throw new Error('Manual verification owner is invalid.');
            const expected = { conversationId: message.conversationId, turnId: message.turnId, captureId: message.captureId };
            const saved = await reviewServiceRequest('/internal/workspace/manual-generation', {
              method: 'POST', body: expected, timeoutMs: 5_000,
            });
            if (!validManualBinding(saved.context, expected)) throw new Error('Manual verification evidence is unavailable.');
            if ((message.sessionId || null) !== (saved.context.hermesSessionId || null)) throw new Error('Manual verification session does not match the saved conversation.');
            const requestId = String(message.requestId);
            latestSelectionRequestId = requestId;
            const turn = message.sessionId ? (await activate(await upstream.request('session.resume', {
              session_id: message.sessionId, source: ANALYST_SOURCE, cols: 100,
            }, 15_000), { requestId })).turn : await createSession({ requestId,
              title: String(message.conversationTitle || 'Manual Portfolio Update') });
            actionTurn = turn;
            turn.citations.clear();
            collectCitations({ citations: saved.citations }, turn.citations);
            turn.busy = true;
            beginLiveTurn(turn, text);
            beginManualEvidence(turn, saved.context);
            sendTurnActivity(turn);
            turn.hasMessages = true;
            turn.visibleMessageCount += 1;
            sendTurnFrame(turn, { type: 'user_message', text, requestId });
            await submitPromptWithRecovery(text, turn, { visibleText: text });
          } else if (message.action === 'new_prompt') {
            const text = String(message.text || '').trim();
            if (!text || text.length > 20_000) throw new Error('Prompt must contain 1–20,000 characters.');
            const requestId = String(message.requestId || randomUUID());
            latestSelectionRequestId = requestId;
            const turn = await createSession({
              requestId,
              title: deterministicConversationTitle(text),
            });
            actionTurn = turn;
            turn.citations.clear();
            turn.busy = true;
            beginLiveTurn(turn, text);
            sendTurnActivity(turn);
            turn.hasMessages = true;
            turn.visibleMessageCount += 1;
            sendTurnFrame(turn, { type: 'user_message', text, requestId });
            await submitPromptWithRecovery(text, turn, { visibleText: text });
          } else if (message.action === 'review_prompt') {
            const text = String(message.text || '').trim();
            if (!text || text.length > 20_000) throw new Error('Prompt must contain 1–20,000 characters.');
            const requestId = String(message.requestId || randomUUID());
            const conversationId = String(message.conversationId || '').trim();
            const reviewKind = String(message.reviewKind || '').trim();
            latestSelectionRequestId = requestId;
            const activation = await openReviewConversationChat({
              conversationId,
              reviewKind,
              hermesSessionId: String(message.hermesSessionId || '').trim(),
              requestId,
            });
            const turn = activation.turn;
            actionTurn = turn;
            turn.citations.clear();
            turn.busy = true;
            beginLiveTurn(turn, text);
            sendTurnActivity(turn);
            turn.hasMessages = true;
            turn.visibleMessageCount += 1;
            sendTurnFrame(turn, { type: 'user_message', text, requestId });
            const hermesText = await promptWithOptionalReviewContext(
              text,
              message.reviewRunId,
              { conversationId, reviewKind, sessionId: turn.storedSessionId },
            );
            await submitPromptWithRecovery(hermesText, turn, { visibleText: text });
          } else if (message.action === 'prompt') {
            const text = String(message.text || '').trim();
            if (!text || text.length > 20_000) throw new Error('Prompt must contain 1–20,000 characters.');
            const requestedSessionId = String(message.sessionId || context.storedSessionId || '').trim();
            if (!requestedSessionId || requestedSessionId !== context.storedSessionId) {
              throw analystProtocolError(
                'ANALYST_PROMPT_SESSION_MISMATCH',
                'The message target no longer matches the displayed Analyst conversation.',
              );
            }
            const requestedConversationId = String(message.conversationId || '').trim();
            if (
              requestedConversationId
              && requestedConversationId !== String(context.conversationId || '')
            ) {
              throw analystProtocolError(
                'ANALYST_PROMPT_CONVERSATION_MISMATCH',
                'The follow-up no longer matches the displayed review conversation.',
              );
            }
            if (!context.runtimeSessionId) {
              if (context.storedSessionId) await resumeStoredRuntimeForPrompt(context);
              else await openMostRecent();
            }
            actionTurn = context;
            context.citations.clear();
            context.busy = true;
            beginLiveTurn(context, text);
            sendTurnActivity(context);
            await applyInitialReviewSessionTitle(message.conversationTitle);
            context.hasMessages = true;
            context.visibleMessageCount += 1;
            sendTurnFrame(context, { type: 'user_message', text });
            const hermesText = await promptWithOptionalReviewContext(
              text,
              message.reviewRunId,
              {
                sessionId: requestedSessionId,
                conversationId: requestedConversationId,
                reviewKind: context.reviewKind,
              },
            );
            await submitPromptWithRecovery(
              hermesText,
              context,
              { visibleText: text },
            );
          } else if (message.action === 'interrupt') {
            if (!context.runtimeSessionId) return;
            actionTurn = context;
            await upstream.request('session.interrupt', { session_id: context.runtimeSessionId }, 15_000);
            context.busy = false;
            resetLiveResponseBuffer(context);
            sendTurnActivity(context);
            sendTurnFrame(context, { type: 'status', status: 'interrupted' });
          }
        } catch (error) {
          state.lastError = error.message;
          if (['prompt', 'new_prompt', 'review_prompt', 'manual_verification_prompt', 'gm', 'start_review', 'retry_review'].includes(action) && actionTurn?.busy) {
            clearTurn(actionTurn);
            sendTurnActivity(actionTurn);
          }
          let requestId = null;
          try { requestId = JSON.parse(String(raw))?.requestId || null; } catch (_error) { /* no-op */ }
          const errorFrame = {
            type: 'error',
            action: action || null,
            code: error.code || null,
            ...(requestId ? { requestId } : {}),
            error: error.message,
          };
          if (actionTurn) sendTurnFrame(actionTurn, errorFrame);
          else sendJson(browser, errorFrame);
        }
      };
      // WebSocket EventEmitter callbacks are not awaited. Without this queue,
      // open/resume, New Chat, list, and rename can complete out of order and
      // overwrite a newer active session with an older response.
      let action = '';
      try {
        action = JSON.parse(String(raw))?.action || '';
      } catch (_error) {
        // The queued handler returns the normal unsupported/malformed error.
      }
      if (['interrupt', 'open', 'open_review_chat', 'resume_review', 'resume', 'cancel_resume', 'list_sessions'].includes(action)) {
        Promise.resolve(handleAction()).finally(() => { pendingActions -= 1; });
      } else {
        browserActionQueue = browserActionQueue.then(handleAction, handleAction).finally(() => { pendingActions -= 1; });
      }
    });

    browser.on('close', () => {
      state.clients = Math.max(0, state.clients - 1);
      upstream.close();
    });
  });

  const unsubscribeGate = runtimeGate?.subscribe((status) => {
    if (!status.verified) for (const client of wss.clients) client.close(1013, 'Analyst verification unavailable');
  });
  return {
    close() {
      unsubscribeGate?.();
      server.off?.('upgrade', handleUpgrade);
      for (const client of wss.clients || []) client.terminate?.();
      wss.close();
    },
    status() {
      return {
        contractVerified: isContractVerified(),
        features: { gm: false },
        connected: isContractVerified() && state.connectedUpstreams > 0,
        status: !isContractVerified()
          ? 'contract_unverified'
          : (state.connectedUpstreams > 0 ? 'connected' : token ? 'idle' : 'misconfigured'),
        clients: state.clients,
        upstreamConnections: state.connectedUpstreams,
        lastConnectedAt: state.lastConnectedAt,
        lastError: state.lastError,
      };
    },
    wss,
  };
}

module.exports = {
  ANALYST_MCP_TOOL_PREFIX,
  ANALYST_SOURCE,
  APPROVED_TOOLS,
  JsonRpcPeer,
  attachAnalystGatewayProxy,
  collectCitations,
  isApprovedTool,
  isMissingRuntimeSessionError,
  beginLiveTurn,
  inferLiveTurnState,
  liveRequirementsForPrompt,
  reconcileLiveTurnHistory,
  notePortfolioPacketComplete,
  notePortfolioPacketStart,
  projectHistory,
  requestedGmReviews,
  safePortfolioReviewError,
  sanitizeCitationText,
  validCitation,
};
