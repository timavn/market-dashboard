const crypto = require('crypto');

const RESEARCH_EVENT_PARSER_PREFIX = 'research-event-ledger-v2';

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

function eventTimeMs(item = {}) {
  const parsed = new Date(item.eventTime || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
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
  if (eventSequence(item) === null) reasons.push('sequence-missing');
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
    reasons.push('payload-invalid');
  }
  if (!String(item.parserVersion || '').startsWith(RESEARCH_EVENT_PARSER_PREFIX)) {
    reasons.push('parser-version-invalid');
  }
  if (!String(item.eventHash || '').match(/^[a-f0-9]{64}$/i)) reasons.push('event-hash-missing');
  return reasons;
}

function rejection(item, reasons) {
  return {
    eventKey: eventIdentity(item),
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
  return {
    snapshotDate: eventDate(item),
    parsedAt: item.eventTime,
    source,
    sourceKind: source.includes('full-book') ? 'gmail-html-full-book' : 'gmail-html-action',
    sourceFile: item.sourceArtifact || null,
    sourceMessageId: item.sourceMessageId,
    sourceSequence: eventSequence(item),
    sourceEventKey: item.eventKey || null,
    parserVersion: item.parserVersion,
  };
}

function buildEtfProPayloadsFromResearchEvents(items = []) {
  const supportedTypes = new Set(['FULL_BOOK_CHECKPOINT', 'POSITION_ACTION']);
  const selected = sortResearchEvents(items).filter((item) => item?.productKey === 'etf-pro');
  const sourceMessageIds = new Set(selected.map((item) => item?.sourceMessageId).filter(Boolean));
  const fullBooks = [];
  const actionGroups = new Map();
  const rejected = [];

  selected.forEach((item) => {
    const reasons = validateBaseEvent(item, 'etf-pro', supportedTypes);
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

  return {
    fullBooks,
    actions,
    rejected,
    sourceMessageIds: [...sourceMessageIds].sort(),
    selectedEventCount: selected.length,
  };
}

function materializeRtaResearchEvents(items = [], { timeZone = 'America/New_York' } = {}) {
  const selected = sortResearchEvents(items).filter((item) => item?.productKey === 'real-time-alert');
  const sourceMessageIds = new Set(selected.map((item) => item?.sourceMessageId).filter(Boolean));
  const rejected = [];
  const byDate = new Map();

  selected.forEach((item) => {
    const reasons = validateBaseEvent(item, 'real-time-alert', new Set(['POSITION_ACTION']));
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

  return {
    snapshots,
    rejected,
    sourceMessageIds: [...sourceMessageIds].sort(),
    selectedEventCount: selected.length,
    materializedEventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
  };
}

function mergeRtaMaterializations(v2 = {}, legacy = {}) {
  const v2SourceIds = new Set(v2.sourceMessageIds || []);
  const alerts = [];
  (v2.snapshots || []).forEach((snapshot) => {
    (snapshot.data?.alerts || []).forEach((alert) => alerts.push({ ...alert, snapshotDate: snapshot.date }));
  });
  let legacyEventCount = 0;
  (legacy.snapshots || []).forEach((snapshot) => {
    (snapshot.data?.alerts || []).forEach((alert) => {
      if (alert.sourceMessageId && v2SourceIds.has(alert.sourceMessageId)) return;
      legacyEventCount += 1;
      alerts.push({ ...alert, snapshotDate: snapshot.date });
    });
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

  return {
    snapshots,
    rejected: [...(v2.rejected || []), ...(legacy.rejected || [])],
    selectedMessageCount: new Set([
      ...(v2.sourceMessageIds || []),
      ...snapshots.flatMap((snapshot) => snapshot.sourceMessageIds || []),
    ]).size,
    selectedEventCount: Number(v2.selectedEventCount || 0),
    v2EventCount: Number(v2.materializedEventCount || 0),
    legacyEventCount,
    materializedEventCount: snapshots.reduce((sum, snapshot) => sum + snapshot.itemCount, 0),
  };
}

module.exports = {
  buildEtfProPayloadsFromResearchEvents,
  compareResearchEvents,
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
  sortResearchEvents,
};
