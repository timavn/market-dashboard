const crypto = require('crypto');
const { normalizeRtaAlertEvent } = require('./rtaPositionReconstruction.cjs');

const RESEARCH_EVENT_PARSER_PREFIX = 'research-event-ledger-v2';
const RESEARCH_EVENT_VERIFICATION_HASH_VERSION = 'research-event-content-v1';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function numberToPlainString(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return '-0';
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return raw;
  const [, sign, whole, fraction = '', exponentText] = match;
  const digits = `${whole}${fraction}`;
  const decimalIndex = whole.length + Number(exponentText);
  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function verificationStableValue(value) {
  if (Array.isArray(value)) return value.map(verificationStableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, verificationStableValue(value[key])]),
    );
  }
  if (typeof value === 'number') return numberToPlainString(value);
  return value;
}

function computeResearchEventVerificationHash({ eventType, payload } = {}) {
  const canonical = JSON.stringify(verificationStableValue({ eventType, payload }));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker) ? ticker : null;
}

function eventSequence(item = {}) {
  const explicit = Number(item.sequence);
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;
  const suffix = String(item.eventKey || '').match(/#(\d{4,})$/)?.[1];
  return suffix ? Number(suffix) : null;
}

function storedEventSequence(item = {}) {
  return Number.isInteger(item.sequence) && item.sequence >= 0
    ? item.sequence
    : null;
}

function sourceEventCount(item = {}) {
  return Number.isInteger(item.sourceEventCount) && item.sourceEventCount > 0
    ? item.sourceEventCount
    : null;
}

function sourceGroupCompleteness(items = []) {
  const groups = new Map();
  for (const item of items) {
    const sourceMessageId = String(item?.sourceMessageId || '').trim();
    if (!sourceMessageId) continue;
    const group = groups.get(sourceMessageId) || [];
    group.push(item);
    groups.set(sourceMessageId, group);
  }

  const incomplete = new Map();
  for (const [sourceMessageId, group] of groups.entries()) {
    const counts = group.map(sourceEventCount);
    const validCounts = new Set(counts.filter((count) => count !== null));
    const sequences = group.map(storedEventSequence);
    const validSequences = sequences.filter((sequence) => sequence !== null);
    const uniqueSequences = [...new Set(validSequences)].sort((a, b) => a - b);
    const reasons = [];

    if (counts.some((count) => count === null)) {
      reasons.push('source-event-count-missing');
    }
    if (validCounts.size > 1) {
      reasons.push('source-event-count-inconsistent');
    }

    const expectedCount = validCounts.size === 1 ? [...validCounts][0] : null;
    if (expectedCount !== null && group.length !== expectedCount) {
      reasons.push('source-event-count-mismatch');
    }
    if (validSequences.length !== uniqueSequences.length) {
      reasons.push('source-event-sequence-duplicate');
    }
    if (
      expectedCount !== null
      && (
        validSequences.length !== group.length
        || uniqueSequences.length !== expectedCount
        || uniqueSequences.some((sequence, index) => sequence !== index)
      )
    ) {
      reasons.push('source-event-sequence-incomplete');
    }
    if (reasons.length > 0) incomplete.set(sourceMessageId, [...new Set(reasons)]);
  }

  return { groups, incomplete };
}

function eventTimeMs(item = {}) {
  const parsed = new Date(item.eventTime || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function authoritativeCheckpointTimeMs(value) {
  if (value && typeof value === 'object') {
    return timestampMs(
      value.authoritativeCheckpointTime
      || value.asOf
      || value.capturedAt
      || value.eventTime
      || value.meta?.parsedAt,
    );
  }
  return timestampMs(value);
}

function researchIssueTimeMs(item = {}) {
  const candidates = [
    item.eventTime,
    item.parsedAt,
    item.meta?.parsedAt,
    item.capturedAt,
    item.meta?.capturedAt,
    item.scrapedAt,
    item.meta?.scrapedAt,
    item.receivedAt,
    item.meta?.receivedAt,
  ];
  for (const value of candidates) {
    const parsed = timestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function filterIssuesAfterAuthoritativeCheckpoint(items = [], authoritativeCheckpointTime = null) {
  const list = Array.isArray(items) ? items : [];
  const checkpointMs = authoritativeCheckpointTimeMs(authoritativeCheckpointTime);
  if (checkpointMs === null) return [...list];
  return list.filter((item) => {
    const issueMs = researchIssueTimeMs(item);
    return issueMs === null || issueMs > checkpointMs;
  });
}

function latestCompleteIssueTime(items = []) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const times = items.map(researchIssueTimeMs);
  if (times.some((value) => value === null)) return null;
  return new Date(Math.max(...times)).toISOString();
}

function compareResearchEvents(a = {}, b = {}) {
  const aTime = eventTimeMs(a);
  const bTime = eventTimeMs(b);
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  if (aTime !== bTime) return aTime - bTime;
  const messageCompare = String(a.sourceMessageId || '').localeCompare(String(b.sourceMessageId || ''));
  if (messageCompare !== 0) return messageCompare;
  const sequenceCompare = (eventSequence(a) ?? Number.MAX_SAFE_INTEGER) -
    (eventSequence(b) ?? Number.MAX_SAFE_INTEGER);
  if (sequenceCompare !== 0) return sequenceCompare;
  return String(a.eventKey || '').localeCompare(String(b.eventKey || ''));
}

function sortResearchEvents(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort(compareResearchEvents);
}

function eventDate(item, timeZone = 'America/New_York') {
  const date = new Date(item?.eventTime || '');
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA', { timeZone });
}

function eventIdentity(item = {}) {
  return item.eventKey || [
    item.eventTime || '',
    item.sourceMessageId || '',
    String(eventSequence(item) ?? ''),
  ].join('#');
}

function validateBaseEvent(item, productKey, supportedTypes) {
  const reasons = [];
  if (!item || typeof item !== 'object') return ['event-not-object'];
  if (item.productKey !== productKey) reasons.push('product-key-mismatch');
  if (!supportedTypes.has(item.eventType)) reasons.push('unsupported-event-type');
  if (eventTimeMs(item) === null) reasons.push('invalid-event-time');
  if (!String(item.sourceMessageId || '').trim()) reasons.push('source-message-id-missing');
  const sequence = storedEventSequence(item);
  const expectedCount = sourceEventCount(item);
  if (sequence === null) reasons.push('sequence-missing');
  if (expectedCount === null) {
    reasons.push('source-event-count-missing');
  } else if (sequence !== null && sequence >= expectedCount) {
    reasons.push('source-event-sequence-out-of-range');
  }
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
    reasons.push('payload-invalid');
  }
  if (!String(item.parserVersion || '').startsWith(RESEARCH_EVENT_PARSER_PREFIX)) {
    reasons.push('parser-version-invalid');
  }
  if (!String(item.eventHash || '').match(/^[a-f0-9]{64}$/i)) reasons.push('event-hash-missing');
  if (item.verificationHashVersion !== RESEARCH_EVENT_VERIFICATION_HASH_VERSION) {
    reasons.push('verification-hash-version-missing');
  } else if (!String(item.verificationHash || '').match(/^[a-f0-9]{64}$/i)) {
    reasons.push('verification-hash-missing');
  } else if (item.verificationHash !== computeResearchEventVerificationHash(item)) {
    reasons.push('verification-hash-mismatch');
  }
  return reasons;
}

function rejection(item, reasons) {
  return {
    eventKey: eventIdentity(item),
    eventTime: researchIssueTimeMs(item) === null
      ? null
      : new Date(researchIssueTimeMs(item)).toISOString(),
    sourceMessageId: item?.sourceMessageId || null,
    code: 'invalid-research-event',
    reasons,
  };
}

function buildChanges(rows) {
  const changes = {
    previousDate: null,
    addedLongs: [],
    removedLongs: [],
    addedShorts: [],
    removedShorts: [],
  };
  rows.forEach((row) => {
    const prefix = row.action === 'ADD' ? 'added' : 'removed';
    const suffix = String(row.call).toLowerCase() === 'short' ? 'Shorts' : 'Longs';
    changes[`${prefix}${suffix}`].push(row.ticker);
  });
  Object.keys(changes).forEach((key) => {
    if (Array.isArray(changes[key])) changes[key] = [...new Set(changes[key])];
  });
  changes.added = [...new Set([...changes.addedLongs, ...changes.addedShorts])];
  changes.removed = [...new Set([...changes.removedLongs, ...changes.removedShorts])];
  return changes;
}

function eventMeta(item, source) {
  const declaredSource = String(item?.source || '').trim();
  const declaredSourceKind = String(item?.sourceKind || '').trim();
  const sourceArtifact = item?.sourceArtifact || null;
  return {
    snapshotDate: eventDate(item),
    parsedAt: item.eventTime,
    source,
    sourceKind: source.includes('full-book') ? 'gmail-html-full-book' : 'gmail-html-action',
    sourceFile: sourceArtifact,
    sourceArtifact,
    // These declarations are retained only as diagnostics. The v1 research
    // verification hash binds eventType + payload, not provenance fields, so
    // they must never confer manual-authoritative status.
    sourceProvider: declaredSource || null,
    sourceProviderKind: declaredSourceKind || null,
    sourceMessageId: item.sourceMessageId,
    sourceSequence: eventSequence(item),
    sourceEventKey: item.eventKey || null,
    parserVersion: item.parserVersion,
    declaredCapturedAt: item.capturedAt || null,
    declaredContentHash: item.contentHash || null,
    authoritativeCheckpoint: false,
    provenanceVerified: false,
    declaredProvenance: item.provenance && typeof item.provenance === 'object'
      ? { ...item.provenance }
      : null,
  };
}

function buildEtfProPayloadsFromResearchEvents(items = []) {
  const supportedTypes = new Set(['FULL_BOOK_CHECKPOINT', 'POSITION_ACTION']);
  const selected = sortResearchEvents(items).filter((item) => item?.productKey === 'etf-pro');
  const sourceMessageIds = new Set(selected.map((item) => item?.sourceMessageId).filter(Boolean));
  const sourceCompleteness = sourceGroupCompleteness(selected);
  const fullBooks = [];
  const actionGroups = new Map();
  const rejected = [];

  selected.forEach((item) => {
    const sourceMessageId = String(item?.sourceMessageId || '').trim();
    const reasons = [
      ...validateBaseEvent(item, 'etf-pro', supportedTypes),
      ...(sourceCompleteness.incomplete.get(sourceMessageId) || []),
    ];
    if (reasons.length > 0) {
      rejected.push(rejection(item, reasons));
      return;
    }

    if (item.eventType === 'FULL_BOOK_CHECKPOINT') {
      const rows = Array.isArray(item.payload.rows) ? item.payload.rows : [];
      const normalizedRows = rows.map((row, index) => {
        const ticker = normalizeTicker(row?.ticker);
        const side = String(row?.call || row?.side || '').trim().toLowerCase();
        if (!ticker || !['long', 'short'].includes(side)) return null;
        return {
          ...row,
          id: row.id || `${ticker}_${index}`,
          ticker,
          call: side === 'short' ? 'Short' : 'Long',
        };
      });
      if (rows.length === 0 || normalizedRows.some((row) => !row)) {
        rejected.push(rejection(item, ['full-book-rows-invalid']));
        return;
      }
      const meta = eventMeta(item, 'research-event-ledger-v2-full-book');
      fullBooks.push({
        meta: {
          ...meta,
          headline: item.payload.headline || null,
          rowCount: normalizedRows.length,
          longCount: normalizedRows.filter((row) => row.call === 'Long').length,
          shortCount: normalizedRows.filter((row) => row.call === 'Short').length,
        },
        rows: normalizedRows,
        changes: null,
        data: {
          fullBookLongs: normalizedRows.filter((row) => row.call === 'Long').map((row) => row.ticker),
          fullBookShorts: normalizedRows.filter((row) => row.call === 'Short').map((row) => row.ticker),
        },
      });
      return;
    }

    const ticker = normalizeTicker(item.payload.ticker);
    const action = String(item.payload.action || '').trim().toUpperCase();
    const side = String(item.payload.call || item.payload.side || '').trim().toLowerCase();
    const actionReasons = [];
    if (!ticker) actionReasons.push('action-ticker-invalid');
    if (!['ADD', 'REMOVE'].includes(action)) actionReasons.push('action-invalid');
    if (!['long', 'short'].includes(side)) actionReasons.push('action-side-invalid');
    if (actionReasons.length > 0) {
      rejected.push(rejection(item, actionReasons));
      return;
    }
    const groupKey = `${item.eventTime}#${item.sourceMessageId}`;
    const group = actionGroups.get(groupKey) || { events: [], first: item };
    group.events.push({
      ...item.payload,
      ticker,
      action,
      call: side === 'short' ? 'Short' : 'Long',
      sourceSequence: eventSequence(item),
      sourceEventKey: item.eventKey || null,
    });
    actionGroups.set(groupKey, group);
  });

  const actions = [...actionGroups.values()].map(({ events, first }) => {
    const rows = events.sort((a, b) => a.sourceSequence - b.sourceSequence);
    const changes = buildChanges(rows);
    return {
      meta: {
        ...eventMeta(first, 'research-event-ledger-v2-action'),
        headline: first.payload.headline || null,
        rowCount: rows.length,
        actionCount: rows.length,
      },
      rows,
      changes,
      data: { ...changes },
    };
  });

  const rejectedSources = new Set(
    rejected.map((item) => String(item.sourceMessageId || '').trim()).filter(Boolean),
  );
  const completeSourceMessageIds = [...sourceCompleteness.groups.keys()]
    .filter((sourceMessageId) => (
      !sourceCompleteness.incomplete.has(sourceMessageId)
      && !rejectedSources.has(sourceMessageId)
    ))
    .sort();

  return {
    fullBooks,
    actions,
    rejected,
    completeSourceMessageIds,
    sourceMessageIds: [...sourceMessageIds].sort(),
    selectedEventCount: selected.length,
  };
}

function normalizedSide(value) {
  const side = String(value || '').trim().toLowerCase();
  return ['long', 'short'].includes(side) ? side : null;
}

function etfProPayloadSignatures(payloads, eventKind) {
  return (payloads || []).flatMap((payload) => (
    Array.isArray(payload?.rows) ? payload.rows : []
  )).map((row) => {
    const ticker = normalizeTicker(row?.ticker);
    if (!ticker) return `invalid:${String(row?.ticker || '')}`;
    const side = normalizedSide(row?.call || row?.side);
    if (!side) return `invalid-side:${ticker}:${String(row?.call || row?.side || '')}`;
    if (eventKind === 'action') {
      return `${String(row?.action || '').trim().toUpperCase()}:${side}:${ticker}`;
    }
    return `${side}:${ticker}`;
  }).sort();
}

function groupPayloadsBySource(payloads = []) {
  const groups = new Map();
  payloads.forEach((payload, index) => {
    const sourceMessageId = String(payload?.meta?.sourceMessageId || '').trim();
    const key = sourceMessageId || `__missing_source_${index}`;
    const group = groups.get(key) || { sourceMessageId: sourceMessageId || null, payloads: [] };
    group.payloads.push(payload);
    groups.set(key, group);
  });
  return groups;
}

function sameSignatures(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function partitionEtfProLegacyCoverage({
  canonicalPayloads = {},
  legacyPayloads = {},
  authoritativeCheckpointTime = null,
} = {}) {
  const uncoveredFullBooks = [];
  const uncoveredActions = [];
  const coverageGaps = [];
  const supersededFullBooks = [];
  const supersededActions = [];
  const supersededCoverageGaps = [];

  const compareKind = (eventKind, legacy, canonical, uncovered, superseded) => {
    const canonicalGroups = groupPayloadsBySource(canonical);
    for (const legacyGroup of groupPayloadsBySource(legacy).values()) {
      const canonicalGroup = legacyGroup.sourceMessageId
        ? canonicalGroups.get(legacyGroup.sourceMessageId)
        : null;
      const legacySignatures = etfProPayloadSignatures(legacyGroup.payloads, eventKind);
      const canonicalSignatures = etfProPayloadSignatures(canonicalGroup?.payloads || [], eventKind);
      if (
        canonicalGroup
        && legacySignatures.length > 0
        && sameSignatures(legacySignatures, canonicalSignatures)
      ) {
        continue;
      }
      const gap = {
        eventTime: latestCompleteIssueTime([
          ...legacyGroup.payloads,
          ...(canonicalGroup?.payloads || []),
        ]),
        sourceMessageId: legacyGroup.sourceMessageId,
        eventKind,
        legacyEventCount: legacySignatures.length,
        canonicalEventCount: canonicalSignatures.length,
        reason: canonicalGroup
          ? 'canonical-event-signature-mismatch'
          : 'canonical-source-message-missing',
      };
      if (
        authoritativeCheckpointTimeMs(authoritativeCheckpointTime) !== null
        && filterIssuesAfterAuthoritativeCheckpoint([gap], authoritativeCheckpointTime).length === 0
      ) {
        superseded.push(...legacyGroup.payloads);
        supersededCoverageGaps.push(gap);
        continue;
      }
      uncovered.push(...legacyGroup.payloads);
      coverageGaps.push(gap);
    }
  };

  compareKind(
    'full-book',
    legacyPayloads.fullBooks || [],
    canonicalPayloads.fullBooks || [],
    uncoveredFullBooks,
    supersededFullBooks,
  );
  compareKind(
    'action',
    legacyPayloads.actions || [],
    canonicalPayloads.actions || [],
    uncoveredActions,
    supersededActions,
  );

  return {
    uncoveredFullBooks,
    uncoveredActions,
    coverageGaps,
    supersededFullBooks,
    supersededActions,
    supersededCoverageGaps,
  };
}

function materializeRtaResearchEvents(items = [], { timeZone = 'America/New_York' } = {}) {
  const selected = sortResearchEvents(items).filter((item) => item?.productKey === 'real-time-alert');
  const sourceMessageIds = new Set(selected.map((item) => item?.sourceMessageId).filter(Boolean));
  const sourceCompleteness = sourceGroupCompleteness(selected);
  const rejected = [];
  const byDate = new Map();

  selected.forEach((item) => {
    const sourceMessageId = String(item?.sourceMessageId || '').trim();
    const reasons = [
      ...validateBaseEvent(item, 'real-time-alert', new Set(['POSITION_ACTION'])),
      ...(sourceCompleteness.incomplete.get(sourceMessageId) || []),
    ];
    const date = eventDate(item, timeZone);
    if (!date) reasons.push('snapshot-date-invalid');
    if (reasons.length > 0) {
      rejected.push(rejection(item, reasons));
      return;
    }
    const alerts = byDate.get(date) || [];
    alerts.push({
      ...item.payload,
      eventTime: item.eventTime,
      source: 'research-event-ledger-v2',
      sourceMessageId: item.sourceMessageId,
      sourceSequence: eventSequence(item),
      sourceEventKey: item.eventKey || null,
    });
    byDate.set(date, alerts);
  });

  const snapshots = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, alerts]) => {
    const sourceIds = [...new Set(alerts.map((alert) => alert.sourceMessageId).filter(Boolean))].sort();
    return {
      date,
      snapshotType: 'real-time-alert',
      source: 'research-event-ledger-v2',
      scrapedAt: alerts.map((alert) => alert.eventTime).filter(Boolean).sort().at(-1) || null,
      itemCount: alerts.length,
      sourceMessageIds: sourceIds,
      dataVersion: `research-event-ledger-v2:${crypto.createHash('sha256').update(stableJson({ date, alerts })).digest('hex')}`,
      data: { alerts },
    };
  });

  const rejectedSources = new Set(
    rejected.map((item) => String(item.sourceMessageId || '').trim()).filter(Boolean),
  );
  const completeSourceMessageIds = [...sourceCompleteness.groups.keys()]
    .filter((sourceMessageId) => (
      !sourceCompleteness.incomplete.has(sourceMessageId)
      && !rejectedSources.has(sourceMessageId)
    ))
    .sort();

  return {
    snapshots,
    rejected,
    completeSourceMessageIds,
    sourceMessageIds: [...sourceMessageIds].sort(),
    selectedEventCount: selected.length,
    materializedEventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
  };
}

function filterLegacyRejectionsByCompleteCanonicalSources(
  legacyRejections = [],
  completeCanonicalSourceMessageIds = [],
) {
  const completeSources = new Set(completeCanonicalSourceMessageIds);
  return (Array.isArray(legacyRejections) ? legacyRejections : []).filter((item) => {
    const sourceMessageId = String(item?.sourceMessageId || '').trim();
    return !sourceMessageId || !completeSources.has(sourceMessageId);
  });
}

function mergeRtaMaterializations(
  v2 = {},
  legacy = {},
  { authoritativeCheckpointTime = null } = {},
) {
  const flattenAlerts = (snapshots) => (snapshots || []).flatMap((snapshot) =>
    (snapshot.data?.alerts || []).map((alert) => ({ ...alert, snapshotDate: snapshot.date })));
  const v2Alerts = flattenAlerts(v2.snapshots);
  const legacyAlerts = flattenAlerts(legacy.snapshots);
  const groupAlerts = (alerts) => {
    const groups = new Map();
    alerts.forEach((alert, index) => {
      const sourceMessageId = String(alert?.sourceMessageId || '').trim();
      const key = sourceMessageId || `__missing_source_${index}`;
      const group = groups.get(key) || { sourceMessageId: sourceMessageId || null, alerts: [] };
      group.alerts.push(alert);
      groups.set(key, group);
    });
    return groups;
  };
  const alertSignatures = (alerts) => alerts.map((alert) => {
    const normalized = normalizeRtaAlertEvent(alert, {});
    return JSON.stringify({
      ticker: normalized.ticker,
      action: normalized.action,
      intent: normalized.intent,
      side: normalized.side,
    });
  }).sort();
  const v2Groups = groupAlerts(v2Alerts);
  const legacyGroups = groupAlerts(legacyAlerts);
  const completeCanonicalSources = new Set(v2.completeSourceMessageIds || []);
  const partialCanonicalSources = new Set();
  const canonicalCoverageGaps = [];

  for (const [key, legacyGroup] of legacyGroups.entries()) {
    if (!legacyGroup.sourceMessageId) {
      canonicalCoverageGaps.push({
        eventTime: latestCompleteIssueTime(legacyGroup.alerts),
        sourceMessageId: null,
        eventKind: 'action',
        legacyEventCount: legacyGroup.alerts.length,
        canonicalEventCount: 0,
        reason: 'canonical-source-message-id-unavailable',
      });
      continue;
    }
    const canonicalGroup = v2Groups.get(key);
    if (!canonicalGroup) {
      canonicalCoverageGaps.push({
        eventTime: latestCompleteIssueTime(legacyGroup.alerts),
        sourceMessageId: legacyGroup.sourceMessageId,
        eventKind: 'action',
        legacyEventCount: legacyGroup.alerts.length,
        canonicalEventCount: 0,
        reason: 'canonical-source-message-missing',
      });
      continue;
    }
    if (!completeCanonicalSources.has(key)) {
      partialCanonicalSources.add(key);
      canonicalCoverageGaps.push({
        eventTime: latestCompleteIssueTime([
          ...legacyGroup.alerts,
          ...canonicalGroup.alerts,
        ]),
        sourceMessageId: legacyGroup.sourceMessageId,
        eventKind: 'action',
        legacyEventCount: legacyGroup.alerts.length,
        canonicalEventCount: canonicalGroup.alerts.length,
        reason: 'canonical-source-sequence-incomplete',
      });
      continue;
    }
    const canonicalSignatures = alertSignatures(canonicalGroup.alerts);
    const legacySignatures = alertSignatures(legacyGroup.alerts);
    if (!sameSignatures(canonicalSignatures, legacySignatures)) {
      partialCanonicalSources.add(key);
      canonicalCoverageGaps.push({
        eventTime: latestCompleteIssueTime([
          ...legacyGroup.alerts,
          ...canonicalGroup.alerts,
        ]),
        sourceMessageId: legacyGroup.sourceMessageId,
        eventKind: 'action',
        legacyEventCount: legacySignatures.length,
        canonicalEventCount: canonicalSignatures.length,
        reason: 'canonical-event-signature-mismatch',
      });
    }
  }

  const alerts = [];
  v2Alerts.forEach((alert) => {
    if (alert.sourceMessageId && partialCanonicalSources.has(alert.sourceMessageId)) return;
    alerts.push(alert);
  });
  let legacyEventCount = 0;
  legacyAlerts.forEach((alert, index) => {
    const sourceKey = String(alert?.sourceMessageId || '').trim() || `__missing_source_${index}`;
    const canonicalGroup = alert.sourceMessageId ? v2Groups.get(sourceKey) : null;
    if (canonicalGroup && !partialCanonicalSources.has(sourceKey)) return;
    legacyEventCount += 1;
    alerts.push(alert);
  });
  alerts.sort((a, b) => compareResearchEvents({
    eventTime: a.eventTime,
    sourceMessageId: a.sourceMessageId,
    sequence: a.sourceSequence ?? 0,
    eventKey: a.sourceEventKey,
  }, {
    eventTime: b.eventTime,
    sourceMessageId: b.sourceMessageId,
    sequence: b.sourceSequence ?? 0,
    eventKey: b.sourceEventKey,
  }));

  const byDate = new Map();
  alerts.forEach((alert) => {
    const date = alert.snapshotDate || eventDate(alert);
    const bucket = byDate.get(date) || [];
    const canonicalAlert = { ...alert };
    delete canonicalAlert.snapshotDate;
    bucket.push(canonicalAlert);
    byDate.set(date, bucket);
  });
  const snapshots = [...byDate.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([date, dateAlerts]) => ({
      date,
      snapshotType: 'real-time-alert',
      source: v2.selectedEventCount > 0
        ? 'research-event-ledger-v2-with-legacy-migration'
        : 'gmail-ledger-legacy-migration',
      scrapedAt: dateAlerts.map((alert) => alert.eventTime).filter(Boolean).sort().at(-1) || null,
      itemCount: dateAlerts.length,
      sourceMessageIds: [...new Set(dateAlerts.map((alert) => alert.sourceMessageId).filter(Boolean))].sort(),
      dataVersion: `research-replay-v3:${crypto.createHash('sha256').update(stableJson({ date, alerts: dateAlerts })).digest('hex')}`,
      data: { alerts: dateAlerts },
    }));
  const migrationRejections = filterLegacyRejectionsByCompleteCanonicalSources(
    legacy.rejected,
    v2.completeSourceMessageIds,
  );
  const allRejections = [...(v2.rejected || []), ...migrationRejections];
  const rejected = filterIssuesAfterAuthoritativeCheckpoint(
    allRejections,
    authoritativeCheckpointTime,
  );
  const blockingCoverageGaps = filterIssuesAfterAuthoritativeCheckpoint(
    canonicalCoverageGaps,
    authoritativeCheckpointTime,
  );
  const rejectedSet = new Set(rejected);
  const blockingCoverageGapSet = new Set(blockingCoverageGaps);

  return {
    snapshots,
    rejected,
    supersededRejections: allRejections.filter((item) => !rejectedSet.has(item)),
    selectedMessageCount: new Set([
      ...(v2.sourceMessageIds || []),
      ...snapshots.flatMap((snapshot) => snapshot.sourceMessageIds || []),
    ]).size,
    selectedEventCount: Number(v2.selectedEventCount || 0),
    v2EventCount: Number(v2.materializedEventCount || 0),
    legacyEventCount,
    materializedEventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
    canonicalCoverageGaps: blockingCoverageGaps,
    supersededCanonicalCoverageGaps: canonicalCoverageGaps
      .filter((item) => !blockingCoverageGapSet.has(item)),
  };
}

module.exports = {
  RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
  buildEtfProPayloadsFromResearchEvents,
  compareResearchEvents,
  computeResearchEventVerificationHash,
  filterLegacyRejectionsByCompleteCanonicalSources,
  filterIssuesAfterAuthoritativeCheckpoint,
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
  partitionEtfProLegacyCoverage,
  sortResearchEvents,
};
