function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker) ? ticker : null;
}

function classifyEtfProRows(rows = []) {
  const longs = new Set();
  const shorts = new Set();
  for (const row of rows || []) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) continue;
    if (String(row.call || '').toLowerCase() === 'short') shorts.add(ticker);
    else longs.add(ticker);
  }
  return { longs, shorts };
}

function uniqueValues(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function inspectEtfProRows(rows = []) {
  const positions = new Map();
  const duplicatePositions = [];
  const sideConflicts = [];
  const invalidTickers = [];

  for (const row of rows || []) {
    const ticker = normalizeTicker(row?.ticker);
    if (!ticker) {
      if (row?.ticker != null && String(row.ticker).trim()) invalidTickers.push(String(row.ticker).trim());
      continue;
    }
    const side = String(row.call || row.side || '').toLowerCase() === 'short' ? 'short' : 'long';
    const priorSides = positions.get(ticker) || new Set();
    if (priorSides.has(side)) duplicatePositions.push(`${side}:${ticker}`);
    if (priorSides.size > 0 && !priorSides.has(side)) sideConflicts.push(ticker);
    priorSides.add(side);
    positions.set(ticker, priorSides);
  }

  return {
    duplicatePositions: uniqueValues(duplicatePositions),
    sideConflicts: uniqueValues(sideConflicts),
    invalidTickers: uniqueValues(invalidTickers),
  };
}

function normalizeDataQuality(dataQuality = {}) {
  const normalized = {
    removedButMissing: uniqueValues(dataQuality.removedButMissing),
    duplicateAdds: uniqueValues(dataQuality.duplicateAdds),
    duplicatePositions: uniqueValues(dataQuality.duplicatePositions),
    sideConflicts: uniqueValues(dataQuality.sideConflicts),
    actionConflicts: uniqueValues(dataQuality.actionConflicts),
    invalidTickers: uniqueValues(dataQuality.invalidTickers),
    warnings: uniqueValues(dataQuality.warnings),
  };
  const hasIssues = dataQuality.status === 'warning' ||
    dataQuality.status === 'error' ||
    Object.values(normalized).some((values) => values.length > 0);
  normalized.status = hasIssues
    ? (dataQuality.status === 'error' ? 'error' : 'warning')
    : 'ok';
  return normalized;
}

function withResolvedEtfProCounts(payload) {
  if (!payload) return payload;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const { longs, shorts } = classifyEtfProRows(rows);
  const rowQuality = inspectEtfProRows(rows);
  const dataQuality = normalizeDataQuality({
    ...(payload.dataQuality || {}),
    duplicatePositions: [
      ...(payload.dataQuality?.duplicatePositions || []),
      ...rowQuality.duplicatePositions,
    ],
    sideConflicts: [
      ...(payload.dataQuality?.sideConflicts || []),
      ...rowQuality.sideConflicts,
    ],
    invalidTickers: [
      ...(payload.dataQuality?.invalidTickers || []),
      ...rowQuality.invalidTickers,
    ],
    warnings: [
      ...(payload.dataQuality?.warnings || []),
      ...(rowQuality.duplicatePositions.length > 0
        ? [`ETF Pro active book contains duplicate positions: ${rowQuality.duplicatePositions.join(', ')}`]
        : []),
      ...(rowQuality.sideConflicts.length > 0
        ? [`ETF Pro tickers appear on both sides of the active book: ${rowQuality.sideConflicts.join(', ')}`]
        : []),
      ...(rowQuality.invalidTickers.length > 0
        ? [`ETF Pro active book contains invalid tickers: ${rowQuality.invalidTickers.join(', ')}`]
        : []),
    ],
  });
  const available = payload.available !== false &&
    rows.length > 0 &&
    Boolean(payload.meta?.snapshotDate) &&
    dataQuality.status === 'ok';
  const longCount = available ? longs.size : null;
  const shortCount = available ? shorts.size : null;
  return {
    ...payload,
    available,
    longCount,
    shortCount,
    dataQuality,
    meta: {
      ...(payload.meta || {}),
      rowCount: rows.length,
      available,
      longCount,
      shortCount,
    },
  };
}

function getPayloadDate(payload) {
  return payload?.meta?.snapshotDate || null;
}

function getPayloadTime(payload) {
  const raw = payload?.meta?.parsedAt || payload?.meta?.sourceFileMtime || payload?.meta?.receivedAt || null;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function getPayloadSequence(payload) {
  const sequence = Number(payload?.meta?.sourceSequence);
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : 0;
}

function comparePayloadOrder(a, b) {
  const dateCompare = String(getPayloadDate(a) || '').localeCompare(String(getPayloadDate(b) || ''));
  if (dateCompare !== 0) return dateCompare;
  const timeCompare = getPayloadTime(a) - getPayloadTime(b);
  if (timeCompare !== 0) return timeCompare;
  const messageCompare = String(a?.meta?.sourceMessageId || '').localeCompare(
    String(b?.meta?.sourceMessageId || ''),
  );
  if (messageCompare !== 0) return messageCompare;
  const sequenceCompare = getPayloadSequence(a) - getPayloadSequence(b);
  if (sequenceCompare !== 0) return sequenceCompare;
  return String(a?.meta?.sourceEventKey || '').localeCompare(String(b?.meta?.sourceEventKey || ''));
}

function sortPayloadsChronologically(payloads) {
  return [...(payloads || [])].filter(Boolean).sort(comparePayloadOrder);
}

function pickNewestPayload(payloads) {
  return sortPayloadsChronologically(payloads).at(-1) || null;
}

function isEtfProActionPayload(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const changes = payload?.changes || {};
  const changeCount =
    (changes.addedLongs?.length || 0) +
    (changes.removedLongs?.length || 0) +
    (changes.addedShorts?.length || 0) +
    (changes.removedShorts?.length || 0);
  const headline = payload?.meta?.headline || '';
  return rows.length > 0 && (changeCount > 0 || /\bNew ETF Pro Changes?\b/i.test(headline));
}

function dedupeEtfProActions(payloads) {
  const seen = new Set();
  const result = [];
  for (const payload of payloads || []) {
    if (!payload) continue;
    const changes = payload.changes || {};
    const signature = JSON.stringify({
      date: payload.meta?.snapshotDate || null,
      headline: payload.meta?.headline || null,
      addedLongs: [...(changes.addedLongs || [])].sort(),
      removedLongs: [...(changes.removedLongs || [])].sort(),
      addedShorts: [...(changes.addedShorts || [])].sort(),
      removedShorts: [...(changes.removedShorts || [])].sort(),
    });
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(payload);
  }
  return result;
}

function isEtfProActionAfterBase(actionPayload, basePayload) {
  const actionDate = getPayloadDate(actionPayload);
  const baseDate = getPayloadDate(basePayload);
  if (!actionDate || !baseDate) return false;
  return comparePayloadOrder(actionPayload, basePayload) > 0;
}

function isActiveEtfProSnapshot(payload) {
  const meta = payload?.meta || {};
  const source = `${meta.source || ''} ${meta.sourceKind || ''} ${meta.sourceFile || ''}`.toLowerCase();
  return (
    meta.sourceKind === 'active-open-positions' ||
    source.includes('active-open-positions') ||
    source.includes('current open positions') ||
    source.includes('current-open-positions') ||
    source.includes('manual-current-open-positions') ||
    source.includes('all-active-tickers') ||
    meta.sourceKind === 'gmail-html-full-book' ||
    source.includes('gmail-html-full-book')
  );
}

function mergeDataQualityWarnings(...payloads) {
  const warnings = [];
  const removedButMissing = [];
  const duplicateAdds = [];
  const duplicatePositions = [];
  const sideConflicts = [];
  const actionConflicts = [];
  const invalidTickers = [];
  for (const payload of payloads) {
    const dataQuality = payload?.dataQuality || {};
    warnings.push(...(dataQuality.warnings || []));
    removedButMissing.push(...(dataQuality.removedButMissing || []));
    duplicateAdds.push(...(dataQuality.duplicateAdds || []));
    duplicatePositions.push(...(dataQuality.duplicatePositions || []));
    sideConflicts.push(...(dataQuality.sideConflicts || []));
    actionConflicts.push(...(dataQuality.actionConflicts || []));
    invalidTickers.push(...(dataQuality.invalidTickers || []));
  }
  return normalizeDataQuality({
    warnings,
    removedButMissing,
    duplicateAdds,
    duplicatePositions,
    sideConflicts,
    actionConflicts,
    invalidTickers,
  });
}

function buildAddedRow(row, ticker, actionPayload, nextRows) {
  return {
    id: `${ticker}_${nextRows.length}`,
    etf: row.etf || ticker,
    assetClass: row.assetClass || 'ETF Pro',
    call: row.call || row.side || 'Long',
    ticker,
    dateAdded: actionPayload.meta?.snapshotDate || null,
    entryPrice: row.entryPrice ?? null,
    lastPrice: row.lastPrice ?? row.recentPrice ?? null,
    recentPrice: row.recentPrice ?? row.lastPrice ?? null,
    riskRangeHigh: row.riskRangeHigh ?? row.trendHighEnd ?? null,
    riskRangeLow: row.riskRangeLow ?? row.trendLowEnd ?? null,
    trendHighEnd: row.trendHighEnd ?? row.riskRangeHigh ?? null,
    trendLowEnd: row.trendLowEnd ?? row.riskRangeLow ?? null,
    relativePerformance: row.relativePerformance ?? null,
    absolutePerformance: row.absolutePerformance ?? null,
    daysHeld: 0,
    sourceAction: 'ADD',
  };
}

function applyEtfProActionUpdate(basePayload, actionPayload, options = {}) {
  if (!basePayload || !actionPayload) return actionPayload || basePayload || null;
  const baseRows = Array.isArray(basePayload.rows) ? basePayload.rows : [];
  const changes = actionPayload.changes || {};
  const removedLongs = new Set((changes.removedLongs || []).map(normalizeTicker).filter(Boolean));
  const removedShorts = new Set((changes.removedShorts || []).map(normalizeTicker).filter(Boolean));
  const actionRows = Array.isArray(actionPayload.rows) ? actionPayload.rows : [];
  const addRows = actionRows.filter((row) => String(row.action || '').toUpperCase() === 'ADD');
  const addedByTicker = new Map(
    addRows.map((row) => [normalizeTicker(row.ticker), row]).filter(([ticker]) => ticker),
  );
  const removedButMissing = [];
  const duplicateAdds = [];
  const actionConflicts = [];
  const invalidTickers = [];
  const seenAddKeys = new Set();
  const seenAddSides = new Map();

  for (const row of addRows) {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) {
      if (row.ticker != null && String(row.ticker).trim()) invalidTickers.push(String(row.ticker).trim());
      continue;
    }
    const side = String(row.call || row.side || '').toLowerCase() === 'short' ? 'short' : 'long';
    const key = `${side}:${ticker}`;
    if (seenAddKeys.has(key)) duplicateAdds.push(ticker);
    const priorSide = seenAddSides.get(ticker);
    if (priorSide && priorSide !== side) actionConflicts.push(`${ticker}:added-long-and-short`);
    seenAddKeys.add(key);
    seenAddSides.set(ticker, side);
  }

  const declaredAdds = [
    ...(changes.addedLongs || []).map((ticker) => ({ ticker, side: 'long' })),
    ...(changes.addedShorts || []).map((ticker) => ({ ticker, side: 'short' })),
  ];
  const declaredAddKeys = new Set();
  for (const declared of declaredAdds) {
    const ticker = normalizeTicker(declared.ticker);
    if (!ticker) {
      if (declared.ticker != null && String(declared.ticker).trim()) invalidTickers.push(String(declared.ticker).trim());
      continue;
    }
    const key = `${declared.side}:${ticker}`;
    if (declaredAddKeys.has(key)) duplicateAdds.push(ticker);
    declaredAddKeys.add(key);
    if (!seenAddKeys.has(key)) actionConflicts.push(`${key}:missing-add-row`);
  }
  const seenRemoved = new Set();
  const nextRows = baseRows.filter((row) => {
    const ticker = normalizeTicker(row.ticker);
    if (!ticker) return true;
    const side = String(row.call || '').toLowerCase() === 'short' ? 'short' : 'long';
    const shouldRemove = side === 'short' ? removedShorts.has(ticker) : removedLongs.has(ticker);
    if (shouldRemove) {
      seenRemoved.add(`${side}:${ticker}`);
      return false;
    }
    return true;
  });

  for (const ticker of removedLongs) {
    if (!seenRemoved.has(`long:${ticker}`)) removedButMissing.push(ticker);
  }
  for (const ticker of removedShorts) {
    if (!seenRemoved.has(`short:${ticker}`)) removedButMissing.push(ticker);
  }

  const existingTickers = new Set(nextRows.map((row) => normalizeTicker(row.ticker)).filter(Boolean));
  for (const [ticker, row] of addedByTicker.entries()) {
    if (existingTickers.has(ticker)) {
      duplicateAdds.push(ticker);
      continue;
    }
    nextRows.push(buildAddedRow(row, ticker, actionPayload, nextRows));
    existingTickers.add(ticker);
  }

  const existingQuality = mergeDataQualityWarnings(basePayload);
  const warnings = [
    ...existingQuality.warnings,
    ...(removedButMissing.length > 0
      ? [`ETF Pro remove actions not found in active base: ${removedButMissing.join(', ')}`]
      : []),
    ...(duplicateAdds.length > 0
      ? [`ETF Pro add actions already present in active base: ${duplicateAdds.join(', ')}`]
      : []),
    ...(actionConflicts.length > 0
      ? [`ETF Pro action payload contains conflicting additions: ${actionConflicts.join(', ')}`]
      : []),
    ...(invalidTickers.length > 0
      ? [`ETF Pro action payload contains invalid tickers: ${invalidTickers.join(', ')}`]
      : []),
  ];

  return withResolvedEtfProCounts({
    ...basePayload,
    meta: {
      ...(basePayload.meta || {}),
      snapshotDate: actionPayload.meta?.snapshotDate || basePayload.meta?.snapshotDate || null,
      parsedAt: actionPayload.meta?.parsedAt || basePayload.meta?.parsedAt || null,
      sourceFile: actionPayload.meta?.sourceFile || basePayload.meta?.sourceFile || null,
      sourceMessageId: actionPayload.meta?.sourceMessageId || basePayload.meta?.sourceMessageId || null,
      sourceSequence: actionPayload.meta?.sourceSequence ?? basePayload.meta?.sourceSequence ?? null,
      sourceEventKey: actionPayload.meta?.sourceEventKey || basePayload.meta?.sourceEventKey || null,
      source: options.source || 'gmail-html-action-applied-to-active-book',
      sourceKind: isActiveEtfProSnapshot(basePayload) ? 'active-open-positions' : basePayload.meta?.sourceKind,
      headline: actionPayload.meta?.headline || basePayload.meta?.headline || null,
      baseSnapshotDate: basePayload.meta?.baseSnapshotDate || basePayload.meta?.snapshotDate || null,
      actionCount: actionRows.length,
      appliedActionDates: [
        ...new Set([
          ...(Array.isArray(basePayload.meta?.appliedActionDates) ? basePayload.meta.appliedActionDates : []),
          actionPayload.meta?.snapshotDate,
        ].filter(Boolean)),
      ],
      rowCount: nextRows.length,
    },
    rows: nextRows.map((row, index) => ({ ...row, id: row.id || `${row.ticker}_${index}` })),
    changes,
    actionRows: [
      ...(Array.isArray(basePayload.actionRows) ? basePayload.actionRows : []),
      ...actionRows,
    ],
    dataQuality: normalizeDataQuality({
      ...existingQuality,
      removedButMissing: [...existingQuality.removedButMissing, ...removedButMissing],
      duplicateAdds: [...existingQuality.duplicateAdds, ...duplicateAdds],
      actionConflicts: [...existingQuality.actionConflicts, ...actionConflicts],
      invalidTickers: [...existingQuality.invalidTickers, ...invalidTickers],
      warnings,
    }),
  });
}

function resolveEtfProFromBase({ basePayload, actionPayloads = [], source = 'gmail-html-action-applied-to-active-book' }) {
  if (!basePayload) return null;
  const actions = sortPayloadsChronologically(dedupeEtfProActions(actionPayloads))
    .filter((actionPayload) => isEtfProActionAfterBase(actionPayload, basePayload));
  let payload = {
    ...basePayload,
    meta: {
      ...(basePayload.meta || {}),
      source: actions.length > 0 ? source : (basePayload.meta?.source || 'manual-current-open-positions'),
      baseSnapshotDate: basePayload.meta?.snapshotDate || null,
      appliedActionDates: [],
      rowCount: Array.isArray(basePayload.rows) ? basePayload.rows.length : 0,
    },
    rows: Array.isArray(basePayload.rows) ? basePayload.rows : [],
    dataQuality: normalizeDataQuality(basePayload.dataQuality),
  };

  for (const actionPayload of actions) {
    payload = applyEtfProActionUpdate(payload, actionPayload, { source });
  }

  payload = withResolvedEtfProCounts({
    ...payload,
    meta: {
      ...(payload.meta || {}),
      source: actions.length > 0 ? source : (basePayload.meta?.source || 'manual-current-open-positions'),
      baseSnapshotDate: basePayload.meta?.snapshotDate || null,
    },
  });
  return payload;
}

function appendWarnings(payload, warnings = []) {
  const cleanWarnings = warnings.filter(Boolean);
  const countedPayload = withResolvedEtfProCounts(payload);
  if (!countedPayload || cleanWarnings.length === 0) return countedPayload;
  const existing = countedPayload.dataQuality || {};
  return withResolvedEtfProCounts({
    ...countedPayload,
    dataQuality: {
      ...existing,
      status: 'warning',
      warnings: [...new Set([...(existing.warnings || []), ...cleanWarnings])],
      removedButMissing: existing.removedButMissing || [],
      duplicateAdds: existing.duplicateAdds || [],
    },
  });
}

function normalizeIngestionHealth(health) {
  if (!health) {
    return {
      status: 'unknown',
      rawStatus: 'unknown',
      verified: false,
      healthy: null,
      errorCode: 'GMAIL_HEARTBEAT_UNVERIFIED',
      reason: 'Gmail ingestion health was not provided.',
    };
  }
  const rawStatus = String(health.status || '').trim().toLowerCase();
  const explicitlyHealthy = health.healthy === true || ['healthy', 'ok', 'success'].includes(rawStatus);
  const explicitlyUnhealthy = health.healthy === false ||
    ['auth_required', 'degraded', 'error', 'fail', 'failed', 'stale', 'unhealthy'].includes(rawStatus);
  const defaultErrorCode = rawStatus === 'auth_required'
    ? 'GMAIL_AUTH_REQUIRED'
    : rawStatus === 'stale'
      ? 'GMAIL_POLL_STALE'
      : explicitlyUnhealthy
        ? 'GMAIL_INGESTION_UNHEALTHY'
        : 'GMAIL_HEARTBEAT_UNVERIFIED';
  const defaultReason = rawStatus === 'auth_required'
    ? 'Gmail OAuth authorization requires attention.'
    : rawStatus === 'stale'
      ? 'The scheduled Gmail ingestion heartbeat is stale.'
      : explicitlyUnhealthy
        ? 'The scheduled Gmail ingestion pipeline is unhealthy.'
        : 'Gmail ingestion health could not be verified.';
  return {
    ...health,
    status: explicitlyHealthy ? 'healthy' : explicitlyUnhealthy ? 'unhealthy' : 'unknown',
    rawStatus: rawStatus || 'unknown',
    verified: explicitlyHealthy || explicitlyUnhealthy,
    healthy: explicitlyHealthy ? true : explicitlyUnhealthy ? false : null,
    observedAt: health.observedAt || health.checkedAt || null,
    lastSuccessAt: health.lastSuccessAt || null,
    errorCode: health.errorCode || (explicitlyHealthy ? null : defaultErrorCode),
    reason: health.reason || health.error || (explicitlyHealthy ? null : defaultReason),
  };
}

function applyIngestionHealth(payload, ingestionHealth) {
  if (!payload) return payload;
  const counted = withResolvedEtfProCounts(payload);
  const health = normalizeIngestionHealth(ingestionHealth);
  const structurallyAvailable = counted.available === true;
  const availability = {
    structuralStatus: structurallyAvailable ? 'verified' : 'invalid',
    ingestionStatus: health.status,
    ingestionState: health.rawStatus,
    ingestionVerified: health.verified,
    current: structurallyAvailable && health.healthy === true,
    comparisonSafe: structurallyAvailable && health.healthy === true,
    referenceOnly: structurallyAvailable && health.healthy !== true,
    latestContentAt: counted.meta?.parsedAt || counted.meta?.snapshotDate || null,
    contentDate: counted.meta?.snapshotDate || null,
    pipelineObservedAt: health.observedAt || null,
    pipelineLastSuccessAt: health.lastSuccessAt || null,
    errorCode: structurallyAvailable
      ? (health.healthy !== true
        ? health.errorCode || 'GMAIL_HEARTBEAT_UNVERIFIED'
        : null)
      : 'ETF_PRO_BOOK_INVALID',
    reason: structurallyAvailable
      ? (health.healthy !== true
        ? health.reason || 'Gmail ingestion health could not be verified.'
        : null)
      : 'ETF Pro active book failed structural validation.',
  };

  // Unit-level/offline resolvers may not have a poll-health provider. Runtime
  // callers supply it. Only a verified healthy pipeline may expose rows on the
  // active endpoint; an unverified or unhealthy pipeline retains the complete
  // structurally valid book under lastKnownGood for dated reference use.
  if (health.healthy === true || !ingestionHealth) {
    return {
      ...counted,
      current: structurallyAvailable && health.healthy === true,
      comparisonSafe: structurallyAvailable && health.healthy === true,
      referenceOnly: structurallyAvailable && health.healthy !== true,
      dataAvailability: availability,
      meta: {
        ...(counted.meta || {}),
        current: structurallyAvailable && health.healthy === true,
        comparisonSafe: structurallyAvailable && health.healthy === true,
        referenceOnly: structurallyAvailable && health.healthy !== true,
        structurallyAvailable,
        ingestionStatus: health.status,
        ingestionState: health.rawStatus,
      },
    };
  }

  const archivedRowCount = Array.isArray(counted.rows) ? counted.rows.length : 0;
  const lastKnownGood = structurallyAvailable
    ? {
        ...counted,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        dataAvailability: {
          ...availability,
          current: false,
          comparisonSafe: false,
          referenceOnly: true,
        },
        meta: {
          ...(counted.meta || {}),
          current: false,
          comparisonSafe: false,
          referenceOnly: true,
        },
      }
    : null;
  return {
    ...counted,
    available: false,
    current: false,
    comparisonSafe: false,
    referenceOnly: true,
    rows: [],
    actionRows: [],
    changes: null,
    longCount: null,
    shortCount: null,
    lastKnownGood,
    dataAvailability: availability,
    meta: {
      ...(counted.meta || {}),
      available: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      structurallyAvailable,
      ingestionStatus: health.status,
      ingestionState: health.rawStatus,
      blockedByIngestion: true,
      errorCode: availability.errorCode,
      reason: availability.reason,
      archivedRowCount,
      rowCount: 0,
      longCount: null,
      shortCount: null,
    },
  };
}

function resolveEtfProPayloadFromSources({
  localPayload,
  emailPayload,
  hermesPayloads = {},
  ingestionHealth = null,
} = {}) {
  const fullBookPayloads = [
    ...(Array.isArray(hermesPayloads.fullBooks) ? hermesPayloads.fullBooks : []),
    ...(emailPayload && !isEtfProActionPayload(emailPayload) ? [emailPayload] : []),
  ].map((payload) => ({
    ...payload,
    meta: {
      ...(payload.meta || {}),
      source: payload.meta?.source || 'gmail-html-full-book',
      sourceKind: 'gmail-html-full-book',
    },
  }));
  const emailActionPayloads = [
    ...(Array.isArray(hermesPayloads.actions) ? hermesPayloads.actions : []),
    ...(isEtfProActionPayload(emailPayload) ? [emailPayload] : []),
  ];
  const baseline = pickNewestPayload([
    ...(isActiveEtfProSnapshot(localPayload) ? [localPayload] : []),
    ...fullBookPayloads,
  ]);

  if (baseline) {
    const usesFullBook = baseline.meta?.sourceKind === 'gmail-html-full-book';
    return applyIngestionHealth(
      resolveEtfProFromBase({
        basePayload: baseline,
        actionPayloads: emailActionPayloads,
        source: usesFullBook
          ? 'gmail-html-full-book-applied-actions'
          : 'gmail-html-action-applied-to-active-book',
      }),
      ingestionHealth,
    );
  }

  const incompletePayload = localPayload || pickNewestPayload(emailActionPayloads) || emailPayload || null;
  return applyIngestionHealth(
    appendWarnings(incompletePayload, ['ETF Pro has no complete active-position or full-book baseline.']),
    ingestionHealth,
  );
}

module.exports = {
  applyEtfProActionUpdate,
  applyIngestionHealth,
  classifyEtfProRows,
  comparePayloadOrder,
  dedupeEtfProActions,
  getPayloadDate,
  isActiveEtfProSnapshot,
  isEtfProActionAfterBase,
  isEtfProActionPayload,
  pickNewestPayload,
  normalizeIngestionHealth,
  resolveEtfProFromBase,
  resolveEtfProPayloadFromSources,
  sortPayloadsChronologically,
  withResolvedEtfProCounts,
};
