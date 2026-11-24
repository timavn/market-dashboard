const registry = require('../../../infra/lambdas/gmail_ingestor/research_products.json');
const { automatedSourceReadiness } = require('./analystSourceReadiness.cjs');
const { pendingReviewSourceItems: pendingSources } = require('./analystReviewSourceCatalog.cjs');

const REVIEW_KINDS = new Set(['portfolio-review', 'balance-review', 'prediction-markets-review', 'daily-review']);
const SOURCE_STATES = new Set(['ready', 'partial', 'missing', 'checking', 'unavailable', 'pending']);
const CAPTURE_KINDS = new Set(['captured', 'review-captured']);
// A check's own duration exists only after it settles; paused sources never ran.
const TIMED_STATES = new Set(['ready', 'partial', 'missing', 'unavailable']);
const MAX_ELAPSED_MS = 600_000;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const archiveReasons = value => (Array.isArray(value) ? value : []).filter(reason => typeof reason === 'string'
  && /^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(reason)).slice(0, 40);
const ARCHIVE_QUALIFICATIONS = {
  'source-provenance-missing': 'No original source link, email identity, or artifact was captured',
  'source-uri-unavailable': 'The original source URL is unavailable',
  'unverified-source-field': 'Some published fields failed verification',
  'unverified-source': 'The publication failed verification',
  'source-action-details-missing': 'Published action details are missing',
  'source-action-rows-invalid': 'Published action rows failed validation',
  'source-extraction-unavailable': 'Publication content could not be extracted',
  'invalid-source-roster': 'The published roster failed validation',
  'ambiguous-source-revision': 'Conflicting publication revisions could not be resolved',
  'invalid-publication-date': 'The publication date could not be verified',
  'source-product-missing': 'The publication product identity is missing',
};
const CAPTURE_FAILURES = {
  IBKR_GATEWAY_NOT_VERIFIED: {
    reason: 'The IB Gateway connection could not be verified when this review was captured.',
    remedy: 'Verify IB Gateway in Systems, then refresh this review.',
  },
  IBKR_GATEWAY_READINESS_TIMEOUT: {
    reason: 'IB Gateway readiness could not be verified within the one-second check. No current account data was acquired.',
    remedy: 'Verify the IB Gateway connection in Systems, then refresh this review.',
  },
  IBKR_SERVICE_UNAVAILABLE: {
    reason: 'The local IBKR service could not be reached for the readiness check. Its Gateway connection could not be verified.',
    remedy: 'Verify the local IBKR service in Systems, then refresh this review.',
  },
  IBKR_GATEWAY_NOT_AUTHENTICATED: {
    reason: 'An authenticated IB Gateway session could not be verified when this review was captured.',
    remedy: 'Sign in to IB Gateway, verify API access in Systems, then refresh this review.',
  },
  ...Object.fromEntries(['IBKR_GATEWAY_NOT_CONNECTED', 'GATEWAY_UNAVAILABLE'].map(code => [code, {
    reason: 'The IB Gateway connection could not be verified when this review was captured.',
    remedy: 'Verify the IB Gateway connection in Systems, then refresh this review.',
  }])),
  ...Object.fromEntries(['BALANCE_REQUEST_TIMEOUT', 'IBKR_BALANCE_REQUEST_TIMEOUT', 'BALANCE_SNAPSHOT_TIMEOUT',
    'IBKR_BALANCE_TIMEOUT', 'IBKR_HOLDINGS_TIMEOUT', 'IBKR_POSITIONS_REQUEST_TIMEOUT',
    'IBKR_SOCKET_VERIFICATION_TIMEOUT', 'OPEN_ORDERS_TIMEOUT'].map(code => [code, {
    reason: 'The source request timed out before verified evidence could be captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify the affected source response in Systems, then refresh this review. The saved capture stays unchanged.',
  }])),
  BALANCE_SERVICE_UNAVAILABLE: {
    reason: 'The local balance service could not be reached when this review was captured. The IB Gateway connection state was not established by this failure.',
    remedy: 'Verify the local balance service in Systems, then refresh this review.',
  },
  IBKR_GATEWAY_RECONNECTING: {
    reason: 'The local IBKR service was still connecting to IB Gateway when this review was captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Wait for the IB Gateway connection to verify in Systems, then refresh this review.',
  },
  IBKR_GATEWAY_API_UNRESPONSIVE: {
    reason: 'The IB Gateway API did not respond to the local IBKR service when this review was captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify that IB Gateway is running and its API is enabled in Systems, then refresh this review.',
  },
  IBKR_CLIENT_ID_IN_USE: {
    reason: 'Another API connection was using the local IBKR service’s IB Gateway client ID when this review was captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Close the other IB Gateway API connection using this client ID, then refresh this review.',
  },
  IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED: {
    reason: 'This source was not requested because the IB Gateway connection could not be verified first. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify IB Gateway in Systems, then refresh this review.',
  },
  IBKR_HOLDINGS_SERVICE_UNAVAILABLE: {
    reason: 'The local IBKR service could not deliver holdings when this review was captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify the local IBKR service in Systems, then refresh this review.',
  },
  IBKR_HOLDINGS_REQUEST_FAILED: {
    reason: 'The holdings request failed before verified positions could be captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify the holdings response in Systems, then refresh this review. The saved capture stays unchanged.',
  },
  IBKR_HOLDINGS_UNVERIFIED: {
    reason: 'Holdings were received but could not be verified as complete and current. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify the holdings response in Systems, then refresh this review. The saved capture stays unchanged.',
  },
  IBKR_BALANCE_UNVERIFIED: {
    reason: 'Account balances could not be verified when this review was captured. This does not establish that IB Gateway was disconnected.',
    remedy: 'Verify the balance response in Systems, then refresh this review. The saved capture stays unchanged.',
  },
  SOURCE_PAUSED: {
    reason: 'Paused for now. This source returns when it is re-enabled.',
    remedy: 'No action is needed while this source is paused.',
  },
  SOURCE_NOT_ATTEMPTED: {
    reason: 'This source was not checked before the review settled.',
    remedy: 'Refresh this review to check this source.',
  },
  SOURCE_CHECK_INCOMPLETE: {
    reason: 'This source check had not finished when the review settled.',
    remedy: 'Refresh this review to check this source again.',
  },
  RESEARCH_PUBLICATION_LATE: {
    reason: 'The publication was due but had not arrived when this review was captured.',
    remedy: 'Verify publication delivery, then refresh this review to capture the latest research.',
  },
  RESEARCH_PUBLICATION_MISSING: {
    reason: 'The expected publication was not present in this review’s capture.',
    remedy: 'Verify publication delivery, then refresh this review to capture the latest research.',
  },
  RESEARCH_NOT_DUE: {
    reason: 'No new publication was due for this review’s date.',
    remedy: 'No action is needed.',
  },
};
// Sources the user paused (AGENTS.md) keep their place as Pending in a roster
// built without a capture. Only the sidecar knows which are paused.
const PAUSABLE_SOURCES = new Set(['alphaCodes']);
const pausedSources = binding => new Set((Array.isArray(binding?.pausedSources) ? binding.pausedSources : [])
  .filter(id => PAUSABLE_SOURCES.has(id)));
function rosterSources(kind, status, paused, code = null) {
  return pendingSources(kind, 'checking').flatMap(item => paused.has(item.id)
    ? [{ ...item, status: 'pending', diagnostic: { code: 'SOURCE_PAUSED' } }]
    : item.id === 'alphaCodes' && status !== 'checking' ? []
      : [{ ...item, status, ...(code ? { diagnostic: { code } } : {}) }]);
}
const boundedExplanation = value => typeof value === 'string'
  ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, 400) : '';
function sourceDiagnostic(value) {
  if (typeof value?.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,119}$/.test(value.code)) return {};
  // Only the trusted source projector's explanation fields may accompany its
  // typed code. Provider messages, evidence and account values stay excluded.
  const diagnostic = { code: value.code };
  for (const field of ['reason', 'remedy']) {
    if (typeof value[field] === 'string' && value[field].trim()) {
      diagnostic[field] = boundedExplanation(value[field]);
    }
    if (!diagnostic[field] && CAPTURE_FAILURES[value.code]?.[field]) diagnostic[field] = CAPTURE_FAILURES[value.code][field];
  }
  return { diagnostic };
}
function sourceDetail(item, diagnostic, coverage) {
  const original = boundedExplanation(item.detail).slice(0, item.id === 'portfolioRefreshResearch' ? 300 : 160);
  const qualifications = [];
  if (coverage) {
    for (const code of [...new Set([...coverage.reasons, ...coverage.products.flatMap(product => product.reasons)])]) {
      const explanation = ARCHIVE_QUALIFICATIONS[code];
      if (!explanation) continue;
      const labels = [...new Set(coverage.products.filter(product => product.reasons.includes(code)).map(product => product.label))];
      const affected = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` and ${labels.length - 3} other products` : '');
      qualifications.push(`${explanation}${affected ? ` (${affected})` : ''}.`);
    }
  }
  // Counts and capture clocks alone do not explain a partial archive. Both
  // popup contracts receive captured qualifications, never provider errors.
  if (qualifications.length && diagnostic) diagnostic.reason = boundedExplanation(qualifications.join(' '));
  const why = qualifications.join(' ') || (coverage ? diagnostic?.reason || 'Some archived publications did not qualify for the captured research projection.'
    : !original ? diagnostic?.reason : '') || '';
  const detail = boundedExplanation([why, original].filter(Boolean).join(' '));
  return detail ? { detail } : {};
}
function archiveCoverage(item) {
  const coverage = item.archiveCoverage;
  if (item.id !== 'portfolioRefreshResearch' || item.status !== 'partial'
    || item.diagnostic?.code !== 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL'
    || !Number.isSafeInteger(coverage?.count) || coverage.count <= 0) return {};
  return { archiveCoverage: { count: coverage.count,
    products: (Array.isArray(coverage.products) ? coverage.products : []).slice(0, 64)
      .filter(product => product && typeof product.id === 'string' && /^[a-z][a-z0-9-]{0,99}$/.test(product.id)
        && typeof product.label === 'string' && ['partial', 'checked', 'no_publications'].includes(product.status))
      .map(product => ({ id: product.id, label: product.label.slice(0, 100), status: product.status, reasons: archiveReasons(product.reasons) })),
    reasons: archiveReasons(coverage.reasons),
  } };
}
function projectedSourceItems(result) {
  return (Array.isArray(result.items) ? result.items : []).slice(0, 64)
    .filter(item => item && typeof item.id === 'string' && typeof item.label === 'string').map(item => {
      const diagnostic = sourceDiagnostic(item.diagnostic);
      const coverage = archiveCoverage(item);
      const status = SOURCE_STATES.has(item.status) && (item.status !== 'ready' || validDate(item.observedAt || item.publishedAt)) ? item.status : 'unavailable';
      return {
        id: item.id.slice(0, 100), label: item.label.slice(0, 100), status,
        ...(item.optional === true ? { optional: true } : {}),
        ...(TIMED_STATES.has(status) && Number.isSafeInteger(item.elapsedMs) && item.elapsedMs >= 0 && item.elapsedMs <= MAX_ELAPSED_MS
          ? { elapsedMs: item.elapsedMs } : {}),
        observedAt: validDate(item.observedAt),
        ...(validDate(item.publishedAt) ? { publishedAt: item.publishedAt } : {}),
        ...(item.verifiedFromCapture === true && item.status === 'ready' && registry.products.some(product => product.id === item.id)
          ? { verifiedFromCapture: true } : {}),
        ...(CAPTURE_KINDS.has(item.timestampKind) && validDate(item.observedAt) ? { timestampKind: item.timestampKind } : {}),
        ...(item.requiresIbGateway === true ? { requiresIbGateway: true } : {}),
        ...(item.id === 'ibGateway' && ['connected', 'disconnected', 'unverified'].includes(item.connectionState)
          ? { connectionState: item.connectionState } : {}),
        ...sourceDetail(item, diagnostic.diagnostic, coverage.archiveCoverage), ...diagnostic, ...coverage,
      };
    });
}
function createReviewSources({ request, call, now = () => new Date() }) {
  const pending = new Map();
  async function acquireReviewSources(conversationId) {
    // Poll acquisition metadata without rebuilding every saved portfolio report.
    const binding = await call('source-binding', { conversationId });
    const { conversation, runId } = binding;
    const paused = pausedSources(binding);
    if (!conversation || conversation.id !== conversationId) throw Object.assign(new Error('Conversation unavailable.'), { statusCode: 404 });
    const kind = conversation.kind;
    if (!REVIEW_KINDS.has(kind)) return { conversationId, reviewKind: kind, runId: null, checkedAt: null, items: [] };
    if (runId != null && (typeof runId !== 'string' || !runId.trim() || runId.length > 256)) {
      throw Object.assign(new Error('Review source binding unavailable.'), { statusCode: 409 });
    }
    if (runId && conversation.reviewStartPending === true && conversation.activeTurn) {
      return { conversationId, reviewKind: kind, runId, state: 'queued', checkedAt: null,
        basis: 'review', items: projectedSourceItems({ items: rosterSources(kind, 'checking', paused) }) };
    }
    if (runId) {
      let result;
      try { result = await request(`/internal/reviews/${encodeURIComponent(runId)}/sources`); }
      catch (error) {
        if (error.statusCode !== 404) throw error;
        if (conversation.activeTurn?.id) {
          // Acceptance commits before worker creation. A missing run is not a
          // terminal acquisition failure while that exact turn still owns it.
          // Recheck ownership because Stop/delete may have won during the read.
          let current;
          try { current = await call('source-binding', { conversationId }); }
          catch (ownershipError) { if (![404, 410].includes(ownershipError.statusCode)) throw ownershipError; }
          const owner = current?.conversation;
          if (current?.runId === runId && owner?.id === conversationId && owner.kind === kind
            && owner.activeTurn?.id === conversation.activeTurn.id
            && ['accepted', 'running'].includes(owner.activeTurn.state)) {
            return { conversationId, reviewKind: kind, runId, state: 'queued', checkedAt: null,
              basis: 'review', items: projectedSourceItems({ items: rosterSources(kind, 'checking', paused) }) };
          }
        }
        // A durable queued turn may fail or be stopped before worker creation.
        // Keep its exact binding; no source, including IB Gateway, was checked.
        return { conversationId, reviewKind: kind, runId, state: 'failed', checkedAt: null,
          basis: 'review', items: projectedSourceItems({ items: rosterSources(kind, 'missing', paused, 'SOURCE_NOT_ATTEMPTED') }) };
      }
      if (result.runId !== runId || result.conversationId !== conversationId || result.reviewKind !== kind) {
        throw Object.assign(new Error('Review source evidence does not belong to this conversation.'), { statusCode: 409 });
      }
      // Explicit projection prevents source evidence, report text, or account
      // values from accidentally escaping through a future sidecar response.
      const items = projectedSourceItems(result);
      return { conversationId, reviewKind: kind, runId, state: result.state,
        ...(validDate(result.capturedAt) ? { capturedAt: result.capturedAt } : {}),
        checkedAt: validDate(result.checkedAt), basis: 'review', items };
    }
    // Readiness describes acquisition before a review exists. It never replaces
    // an old run's sources with today's publications or implies broker access.
    const observed = now();
    const items = rosterSources(kind, conversation.activeTurn ? 'checking' : 'missing', paused);
    if (kind === 'portfolio-review' || kind === 'prediction-markets-review') {
      try {
        const evidence = await request('/internal/workspace/readiness', { method: 'POST', body: {} });
        const products = automatedSourceReadiness(evidence, observed);
        for (const item of items) {
          const product = products.find(row => row.id === item.id);
          if (!product) continue;
          item.status = product.status === 'ready' ? 'ready' : product.status === 'not_received' ? 'missing' : 'unavailable';
          item.observedAt = product.publicationDate;
          if (product.publicationDate) item.publishedAt = product.publicationDate;
        }
      } catch {
        // A failed readiness read is not a source outcome; active checks continue.
        if (!conversation.activeTurn) for (const item of items) if (registry.products.some(product => product.id === item.id)) item.status = 'unavailable';
      }
    }
    return { conversationId, reviewKind: kind, runId: null, state: conversation.activeTurn ? 'running' : 'pending', checkedAt: observed.toISOString(), basis: 'readiness', items };
  }
  function getReviewSources(conversationId) {
    if (pending.has(conversationId)) return pending.get(conversationId);
    const read = acquireReviewSources(conversationId).finally(() => {
      if (pending.get(conversationId) === read) pending.delete(conversationId);
    });
    pending.set(conversationId, read);
    return read;
  }
  return { getReviewSources };
}

module.exports = { createReviewSources };
