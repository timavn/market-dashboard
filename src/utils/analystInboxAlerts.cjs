const { typedAnalystSignal, sourceActionEvidence } = require('./analystFindingPresentation.cjs');

const SOURCE_ACTIONS = new Set(['exit', 'trim', 'cover', 'roster removal']);
const payloadOf = finding => finding?.payload || finding || {};
const eventOf = finding => payloadOf(finding).event || {};
const actionOf = finding => finding?.action || payloadOf(finding).action;
function publicationTime(event) {
  const value = event.publishedAt;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return NaN;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}
const hasProvenance = event => Boolean(event.sourceMessageId || event.sourceEventId || event.eventKey);
const isUnread = finding => finding.unread === true || finding.unread === 1;
// Contrary instructions on held positions; separate from ordinary unread alerts.
const isActionRequired = finding => payloadOf(finding).severity === 'action-required';
const SUPPRESSED_OPERATIONAL_IDS = new Set([
  'attention:operations:gmail.ingestion',
  'attention:operations:research-verification',
  'attention:operations:hermes.quant-analyst',
  'attention:operations:hermes.quant-developer',
  'attention:operations:hermes.security',
  'attention:operations:hermes.status',
  'attention:operations:dashboard.hermes-bridge',
]);

function suppressedAnalystInboxFinding(finding) {
  const payload = payloadOf(finding);
  // Delivery status stays in Sources/Systems; retired worker identities also
  // remove their retained messages without erasing historical evidence.
  if (SUPPRESSED_OPERATIONAL_IDS.has(finding?.id || payload.id)) return true;
  return payload.managedBy === 'review-sources'
    && !(payload.sourceDiscrepancy === true && Array.isArray(payload.sourceQuality?.issues) && payload.sourceQuality.issues.length);
}

function sourceNamespace(event, citation = {}) {
  let origin = '';
  try {
    const url = new URL(event.sourceUrl || citation.sourceUri);
    // Message identifiers differ by publication. Only a publisher's origin
    // belongs in the comparison key, never an individual message identifier.
    origin = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
  } catch { /* Some imported publications have only a source message id. */ }
  return [event.providerKey || event.sourceProvider || event.publisher || '', origin];
}

function comparisonKey(finding) {
  const payload = payloadOf(finding);
  const event = eventOf(finding);
  const symbol = finding.symbol || payload.symbol;
  if (!symbol || !event.entityId || !event.productKey || !event.fieldPath) return null;
  return JSON.stringify([symbol, event.entityId, event.productKey, event.fieldPath, ...sourceNamespace(event, payload.citation)]);
}

function canonicalDuplicate(rows) {
  // A duplicate import must not reopen an acknowledged publication. A stable
  // identifier also makes the projection independent of database result order.
  return [...rows].sort((a, b) => Number(isUnread(a)) - Number(isUnread(b))
    || String(a.id || payloadOf(a).id || '').localeCompare(String(b.id || payloadOf(b).id || '')))[0];
}

function citationOf(finding) {
  const event = eventOf(finding);
  return payloadOf(finding).citation || {
    title: event.productLabel,
    product: event.productKey,
    publicationDate: event.marketDate || event.publishedAt,
    sourceUri: event.sourceUrl || (event.sourceMessageId ? `gmail://message/${event.sourceMessageId}` : undefined),
    excerpt: event.excerpt,
  };
}

function recordedPosition(rows, now) {
  const verified = rows.map(payloadOf).filter(payload => payload.holdingsVerified === true
    && typeof payload.quantity === 'number' && Number.isFinite(payload.quantity)
    && Number.isFinite(Date.parse(payload.holdingsVerifiedAt)) && Date.parse(payload.holdingsVerifiedAt) <= now);
  if (!verified.length) return null;
  const latestTime = Math.max(...verified.map(payload => Date.parse(payload.holdingsVerifiedAt)));
  const latest = verified.filter(payload => Date.parse(payload.holdingsVerifiedAt) === latestTime);
  const sides = new Set(latest.map(payload => Math.sign(payload.quantity)));
  if (sides.size !== 1) return null;
  const side = Math.sign(latest[0].quantity);
  return { side: side < 0 ? 'SHORT' : side > 0 ? 'LONG' : 'CLOSED', asOf: latest[0].holdingsVerifiedAt };
}

function projectedFinding(transition, previous, latest, position) {
  const payload = payloadOf(transition);
  const event = eventOf(transition);
  const latestPayload = payloadOf(latest);
  const latestEvent = eventOf(latest);
  const previousEvent = previous ? eventOf(previous) : null;
  const holdings = { currentHolding: latestPayload.currentHolding || null };
  for (const field of ['quantity', 'holdingsVerified', 'holdingsVerifiedAt', 'currentHolding', 'rule']) {
    if (Object.hasOwn(latestPayload, field)) holdings[field] = latestPayload[field];
  }
  return {
    ...transition,
    payload: {
      ...payload,
      ...holdings,
      event: previousEvent ? { ...event, previousEvent } : { ...event },
      alertContext: {
        kind: previousEvent ? 'signal-transition' : 'source-action',
        // A publication establishes the first reported new state, not the
        // unobserved instant at which a publisher changed its assessment.
        changedAt: event.publishedAt,
        previousAt: previousEvent?.publishedAt || null,
        lastConfirmedAt: latestEvent.publishedAt,
        previousCitation: previous ? citationOf(previous) : null,
        latestCitation: citationOf(latest),
        latestEvent,
        recordedPosition: position,
      },
    },
  };
}

function signalAlerts(rows, now) {
  const position = recordedPosition(rows, now);
  if (position?.side === 'CLOSED') return [];
  const fields = new Set(rows.map(row => typedAnalystSignal(eventOf(row))?.field).filter(Boolean));
  const result = [];
  for (const field of fields) {
    const observations = rows.filter(row => {
      const signal = typedAnalystSignal(eventOf(row));
      return !signal || signal.field === field;
    });
    // An undated observation cannot be safely ordered around a purported flip.
    if (observations.some(row => !Number.isFinite(publicationTime(eventOf(row))))) continue;
    const publications = new Map();
    for (const row of observations) {
      const time = publicationTime(eventOf(row));
      if (!publications.has(time)) publications.set(time, []);
      publications.get(time).push(row);
    }
    let previous = null;
    let transition = null;
    let latest = null;
    for (const [, duplicates] of [...publications].sort(([a], [b]) => a - b)) {
      const signals = duplicates.map(row => typedAnalystSignal(eventOf(row)));
      const valid = duplicates.every(row => eventOf(row).qualityStatus === 'validated' && hasProvenance(eventOf(row)))
        && signals.every(signal => signal?.field === field)
        && new Set(signals.map(signal => signal?.value)).size === 1;
      if (!valid) {
        // Missing or contradictory evidence breaks continuity. Never bridge it
        // to manufacture a before/after comparison or keep an obsolete alert.
        previous = null;
        transition = null;
        latest = null;
        continue;
      }
      const row = canonicalDuplicate(duplicates);
      const signal = typedAnalystSignal(eventOf(row));
      if (latest && typedAnalystSignal(eventOf(latest)).value !== signal.value) {
        previous = latest;
        transition = row;
      }
      latest = row;
    }
    if (transition && previous && latest) result.push(projectedFinding(transition, previous, latest, position));
  }
  return result;
}

function sourceActionAlert(rows, now, positionRows = rows) {
  const position = recordedPosition(positionRows, now);
  if (!['LONG', 'SHORT'].includes(position?.side)) return null;
  const dated = rows.filter(row => eventOf(row).qualityStatus === 'validated'
    && hasProvenance(eventOf(row)) && Number.isFinite(publicationTime(eventOf(row))));
  if (!dated.length) return null;
  const latestTime = Math.max(...dated.map(row => publicationTime(eventOf(row))));
  const latest = dated.filter(row => publicationTime(eventOf(row)) === latestTime);
  if (new Set(latest.map(sourceActionKind)).size !== 1) return null;
  const row = canonicalDuplicate(latest);
  const action = sourceActionKind(row);
  if (position.side === 'SHORT' && ['exit', 'trim'].includes(action)
      || position.side === 'LONG' && action === 'cover') return null;
  const normalized = { ...row, action, payload: { ...payloadOf(row), action } };
  return projectedFinding(normalized, null, normalized, position);
}

function explicitSourceActionKind(finding) {
  const event = eventOf(finding);
  const { action } = sourceActionEvidence(event);
  if (['SELL-SOME', 'SELL-PARTIAL', 'TRIM', 'REDUCE'].includes(action)) return 'trim';
  if (['SELL', 'SELL-ALL', 'EXIT', 'LIQUIDATE'].includes(action)) return 'exit';
  if (['COVER', 'COVER-SOME', 'COVER-SHORT', 'BUY-TO-COVER'].includes(action)) return 'cover';
  if (['REMOVE', 'ROSTER-REMOVAL'].includes(action)) return 'roster removal';
  return null;
}

const sourceActionKind = finding => explicitSourceActionKind(finding) || actionOf(finding);

function sourceActionText(event) {
  const excerpt = String(event.excerpt || '').trim();
  try {
    const data = JSON.parse(excerpt);
    return typeof data.headline === 'string' ? data.headline.trim().replace(/\s+/g, ' ') : null;
  } catch {
    return excerpt ? excerpt.replace(/\s+/g, ' ') : null;
  }
}

function sourceActionAliasKey(finding) {
  const event = eventOf(finding);
  const text = sourceActionText(event);
  // Matching normalized actions alone is insufficient: two distinct actions
  // may name the same security in one publication. Match the source headline,
  // message, and content revision before collapsing parser field aliases.
  if (!event.sourceMessageId || !event.contentSha256 || !text) return null;
  return JSON.stringify([finding.symbol || payloadOf(finding).symbol, event.entityId,
    event.productKey, publicationTime(event), event.sourceMessageId,
    event.contentSha256, text, sourceNamespace(event, payloadOf(finding).citation)[0]]);
}

function publicSourceOrigin(finding) {
  const origin = sourceNamespace(eventOf(finding), payloadOf(finding).citation)[1];
  return /^https?:/.test(origin) ? origin : '';
}

function aliasContentScore(finding) {
  const event = eventOf(finding);
  let structured = false;
  try {
    const data = JSON.parse(event.excerpt);
    structured = typeof data?.headline === 'string' && typeof data?.action === 'string';
  } catch { /* Plain source headlines are still valid evidence. */ }
  return Number(structured) * 4 + Number(Boolean(publicSourceOrigin(finding))) * 2 + Number(Boolean(event.action));
}

function mergeSourceActionAliases(aliases) {
  if (aliases.length === 1) return aliases[0];
  const identity = canonicalDuplicate(aliases);
  const content = [...aliases].sort((a, b) => aliasContentScore(b) - aliasContentScore(a)
    || String(a.id || '').localeCompare(String(b.id || '')))[0];
  const linked = [...aliases].sort((a, b) => Number(Boolean(publicSourceOrigin(b))) - Number(Boolean(publicSourceOrigin(a)))
    || aliasContentScore(b) - aliasContentScore(a) || String(a.id || '').localeCompare(String(b.id || '')))[0];
  const explicitAction = aliases.map(eventOf).find(event => event.action)?.action;
  const event = { ...eventOf(content), ...(explicitAction ? { action: explicitAction } : {}) };
  const citation = citationOf(linked);
  const positions = aliases.map(row => payloadOf(row).alertContext?.recordedPosition).filter(Boolean)
    .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
  const latestPosition = positions[0];
  const positionConflict = positions.some(position => Date.parse(position.asOf) === Date.parse(latestPosition?.asOf)
    && position.side !== latestPosition?.side);
  if (positionConflict) return null;
  return {
    ...identity,
    action: sourceActionKind(content),
    payload: {
      ...payloadOf(identity), action: sourceActionKind(content), event, citation,
      alertContext: { ...payloadOf(identity).alertContext, latestEvent: event, latestCitation: citation, recordedPosition: latestPosition },
    },
  };
}

function deduplicateSourceActions(findings) {
  const output = [];
  const documents = new Map();
  for (const finding of findings) {
    const key = actionOf(finding) === 'signal change' ? null : sourceActionAliasKey(finding);
    if (!key) { output.push(finding); continue; }
    if (!documents.has(key)) documents.set(key, []);
    documents.get(key).push(finding);
  }
  for (const aliases of documents.values()) {
    const publicOrigins = new Set(aliases.map(publicSourceOrigin).filter(Boolean));
    const namespaces = new Map();
    for (const finding of aliases) {
      // A saved email-body path and its public article can be one document.
      // Never bridge two known publishers, even if their identifiers collide.
      const namespace = publicSourceOrigin(finding) || (publicOrigins.size === 1 ? [...publicOrigins][0]
        : sourceNamespace(eventOf(finding), payloadOf(finding).citation)[1]);
      if (!namespaces.has(namespace)) namespaces.set(namespace, []);
      namespaces.get(namespace).push(finding);
    }
    for (const documentAliases of namespaces.values()) {
      // A scalar field alias can omit the body that qualifies its generic
      // SELL headline. Share only the exact same document's verified report;
      // explicit full-exit actions still retain their separate meaning.
      const reports = documentAliases.map(row => sourceActionEvidence(eventOf(row)).report).filter(Boolean);
      const report = reports.length && new Set(reports.map(value => value.contentHash)).size === 1 ? reports[0] : null;
      const publisherAliases = report ? documentAliases.map(row => eventOf(row).sourceReport ? row : {
        ...row, payload: { ...payloadOf(row), event: { ...eventOf(row), sourceReport: report } },
      }) : documentAliases;
      const sourceKinds = new Set(publisherAliases.map(explicitSourceActionKind).filter(Boolean));
      const actionGroups = new Map();
      for (const finding of publisherAliases) {
        const explicit = explicitSourceActionKind(finding);
        // Scalar headline imports inherit only an unambiguous action from the
        // exact same source document and headline, never from parser guesses.
        if (!explicit && sourceKinds.size > 1) continue;
        const action = explicit || (sourceKinds.size === 1 ? [...sourceKinds][0] : actionOf(finding));
        if (!actionGroups.has(action)) actionGroups.set(action, []);
        actionGroups.get(action).push({ ...finding, action, payload: { ...payloadOf(finding), action } });
      }
      output.push(...[...actionGroups.values()].map(mergeSourceActionAliases).filter(Boolean));
    }
  }
  return output;
}

// The database keeps every research observation. The inbox projects only the
// latest evidenced transition for each comparable signal and direct source
// actions; recurring unchanged publications never become additional alerts.
const isAttentionFinding = finding => (finding?.attentionVersion || payloadOf(finding).attentionVersion) === 1;
const attentionPriority = finding => {
  const priority = finding?.priority ?? payloadOf(finding).priority;
  return [0, 1, 2].includes(priority) ? priority : 2;
};
const attentionTime = finding => Date.parse(payloadOf(finding).publicationTime || finding?.publicationTime) || 0;
// Undecided contrary instructions lead; a kept one returns to ordinary order.
const urgent = finding => isActionRequired(finding) && isUnread(finding);
const compareAttention = (a, b) => Number(urgent(b)) - Number(urgent(a)) || attentionPriority(a) - attentionPriority(b)
  || attentionTime(b) - attentionTime(a) || String(a.id || '').localeCompare(String(b.id || ''));

function attentionEvidenceFreshness(finding, now = Date.now()) {
  const payload = payloadOf(finding);
  const nowTime = new Date(now).getTime();
  const unsafe = ['stale', 'cacheOnly', 'from_cache', 'mock', 'seeded'].some(flag => payload[flag] === true)
    || payload.providerConnected === false;
  const fresh = (verified, value) => {
    const age = nowTime - Date.parse(value);
    return !unsafe && verified === true && Number.isFinite(age) && age >= -30_000 && age <= 60_000;
  };
  return {
    holdings: fresh(payload.holdingsVerified, payload.holdingsVerifiedAt)
      && typeof payload.quantity === 'number' && Number.isFinite(payload.quantity),
    balance: fresh(payload.balanceVerified, payload.balanceVerifiedAt),
  };
}

function activeAttentionFinding(finding, now = Date.now()) {
  const payload = payloadOf(finding);
  const presentation = payload.presentation || finding.presentation;
  const freshness = attentionEvidenceFreshness(finding, now);
  // Review readiness belongs in Sources. Keep stored evidence, but exclude
  // those warnings from both the inbox and its unread count, including legacy
  // rows. Only an evidenced discrepancy in the publication merits an alert.
  return isAttentionFinding(finding) && (finding.state || payload.state) === 'open'
    && !suppressedAnalystInboxFinding(finding)
    // An urgent instruction stays visible through a holdings outage, marked with
    // its last verification time, rather than disappearing until reconnection.
    && (!(payload.kind === 'portfolio' || payload.requiresFreshHoldings) || freshness.holdings || isActionRequired(finding))
    && (!payload.requiresFreshBalance || freshness.balance)
    && typeof presentation?.subject === 'string' && presentation.subject.trim()
    && Array.isArray(presentation.rows) && presentation.rows.some(row => row?.label && row?.text);
}

function buildAnalystInbox(rawResult = {}, now = new Date()) {
  const rows = Array.isArray(rawResult?.findings) ? rawResult.findings : [];
  const attention = rows.filter(finding => activeAttentionFinding(finding, now));
  if (rawResult?.attentionVersion === 1) {
    const findings = attention.sort(compareAttention).map(finding => isActionRequired(finding) && payloadOf(finding).kind === 'portfolio'
      && !attentionEvidenceFreshness(finding, now).holdings ? { ...finding, holdingsStale: true } : finding);
    return { ...rawResult, findings, unread: findings.filter(isUnread).length, actionRequired: findings.filter(urgent).length };
  }
  const groups = new Map();
  const actionPositions = new Map();
  for (const finding of rows) {
    if (isAttentionFinding(finding) || ['resolved', 'unavailable'].includes(finding.state || payloadOf(finding).state)) continue;
    const action = actionOf(finding);
    const key = comparisonKey(finding);
    if (!key || (action !== 'signal change' && !SOURCE_ACTIONS.has(action))) continue;
    const groupKey = `${action === 'signal change' ? 'signal' : 'action'}:${key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(finding);
    if (SOURCE_ACTIONS.has(action)) {
      const symbol = finding.symbol || payloadOf(finding).symbol;
      if (!actionPositions.has(symbol)) actionPositions.set(symbol, []);
      actionPositions.get(symbol).push(finding);
    }
  }
  const nowTime = new Date(now).getTime();
  const findings = deduplicateSourceActions([...groups].flatMap(([key, rows]) => key.startsWith('signal:')
    ? signalAlerts(rows, nowTime)
    : [sourceActionAlert(rows, nowTime, actionPositions.get(rows[0].symbol || payloadOf(rows[0]).symbol))].filter(Boolean)));
  findings.sort((a, b) => publicationTime(eventOf(b)) - publicationTime(eventOf(a))
    || String(a.id || '').localeCompare(String(b.id || '')));
  const projected = [...attention.sort(compareAttention), ...findings];
  return { ...rawResult, findings: projected, unread: projected.filter(isUnread).length };
}

module.exports = { buildAnalystInbox, isActionRequired, isAttentionFinding, activeAttentionFinding, attentionEvidenceFreshness, attentionPriority, suppressedAnalystInboxFinding };
