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

function withResolvedEtfProCounts(payload) {
  if (!payload) return payload;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const { longs, shorts } = classifyEtfProRows(rows);
  return {
    ...payload,
    meta: {
      ...(payload.meta || {}),
      rowCount: rows.length,
      longCount: longs.size,
      shortCount: shorts.size,
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

function sortPayloadsChronologically(payloads) {
  return [...(payloads || [])].filter(Boolean).sort((a, b) => {
    const dateCompare = String(getPayloadDate(a) || '').localeCompare(String(getPayloadDate(b) || ''));
    if (dateCompare !== 0) return dateCompare;
    return getPayloadTime(a) - getPayloadTime(b);
  });
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
  if (actionDate.localeCompare(baseDate) > 0) return true;
  if (actionDate.localeCompare(baseDate) < 0) return false;
  return getPayloadTime(actionPayload) > getPayloadTime(basePayload);
}

function isPayloadNewer(candidate, basePayload) {
  const candidateDate = getPayloadDate(candidate);
  const baseDate = getPayloadDate(basePayload);
  if (candidateDate && baseDate) {
    const dateCompare = candidateDate.localeCompare(baseDate);
    if (dateCompare !== 0) return dateCompare > 0;
  }
  return getPayloadTime(candidate) > getPayloadTime(basePayload);
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
    source.includes('all-active-tickers')
  );
}

function mergeDataQualityWarnings(...payloads) {
  const warnings = [];
  const removedButMissing = [];
  const duplicateAdds = [];
  for (const payload of payloads) {
    const dataQuality = payload?.dataQuality || {};
    warnings.push(...(dataQuality.warnings || []));
    removedButMissing.push(...(dataQuality.removedButMissing || []));
    duplicateAdds.push(...(dataQuality.duplicateAdds || []));
  }
  return {
    warnings: [...new Set(warnings.filter(Boolean))],
    removedButMissing: [...new Set(removedButMissing.filter(Boolean))],
    duplicateAdds: [...new Set(duplicateAdds.filter(Boolean))],
  };
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
  const addedByTicker = new Map(
    (Array.isArray(actionPayload.rows) ? actionPayload.rows : [])
      .filter((row) => String(row.action || '').toUpperCase() === 'ADD')
      .map((row) => [normalizeTicker(row.ticker), row])
      .filter(([ticker]) => ticker),
  );
  const removedButMissing = [];
  const duplicateAdds = [];
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
  ];

  return withResolvedEtfProCounts({
    ...basePayload,
    meta: {
      ...(basePayload.meta || {}),
      snapshotDate: actionPayload.meta?.snapshotDate || basePayload.meta?.snapshotDate || null,
      parsedAt: actionPayload.meta?.parsedAt || basePayload.meta?.parsedAt || null,
      sourceFile: actionPayload.meta?.sourceFile || basePayload.meta?.sourceFile || null,
      source: options.source || 'gmail-html-action-applied-to-active-book',
      sourceKind: isActiveEtfProSnapshot(basePayload) ? 'active-open-positions' : basePayload.meta?.sourceKind,
      headline: actionPayload.meta?.headline || basePayload.meta?.headline || null,
      baseSnapshotDate: basePayload.meta?.baseSnapshotDate || basePayload.meta?.snapshotDate || null,
      actionCount: Array.isArray(actionPayload.rows) ? actionPayload.rows.length : 0,
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
      ...(actionPayload.rows || []),
    ],
    dataQuality: {
      status: warnings.length > 0 ? 'warning' : 'ok',
      removedButMissing: [...new Set([...existingQuality.removedButMissing, ...removedButMissing])],
      duplicateAdds: [...new Set([...existingQuality.duplicateAdds, ...duplicateAdds])],
      warnings: [...new Set(warnings)],
    },
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
    dataQuality: {
      status: basePayload.dataQuality?.status || 'ok',
      removedButMissing: basePayload.dataQuality?.removedButMissing || [],
      duplicateAdds: basePayload.dataQuality?.duplicateAdds || [],
      warnings: basePayload.dataQuality?.warnings || [],
    },
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

function buildGmailStaleWarnings({ hermesPayloads, now = new Date(), staleDays = 2 } = {}) {
  const allPayloads = [
    ...(Array.isArray(hermesPayloads?.actions) ? hermesPayloads.actions : []),
    ...(Array.isArray(hermesPayloads?.fullBooks) ? hermesPayloads.fullBooks : []),
  ];
  const newest = pickNewestPayload(allPayloads);
  if (!newest) return ['ETF Pro Gmail ingestion has no stored ETF Pro emails.'];
  const newestTime = getPayloadTime(newest);
  if (!newestTime) return [];
  const ageMs = now.getTime() - newestTime;
  if (ageMs <= staleDays * 24 * 60 * 60 * 1000) return [];
  const newestDate = newest.meta?.snapshotDate || new Date(newestTime).toISOString();
  return [`ETF Pro Gmail ingestion is stale; latest stored ETF Pro email is ${newestDate}.`];
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

function resolveEtfProPayloadFromSources({
  localPayload,
  emailPayload,
  hermesPayloads = {},
  now = new Date(),
} = {}) {
  const emailFullBookPayload = pickNewestPayload(hermesPayloads.fullBooks || []);
  const emailActionPayloads = [
    ...(Array.isArray(hermesPayloads.actions) ? hermesPayloads.actions : []),
    ...(isEtfProActionPayload(emailPayload) ? [emailPayload] : []),
  ];
  const gmailWarnings = buildGmailStaleWarnings({ hermesPayloads, now });

  if (isActiveEtfProSnapshot(localPayload)) {
    if (emailFullBookPayload && isPayloadNewer(emailFullBookPayload, localPayload)) {
      return appendWarnings(
        resolveEtfProFromBase({
          basePayload: {
            ...emailFullBookPayload,
            meta: {
              ...(emailFullBookPayload.meta || {}),
              sourceKind: 'gmail-html-full-book',
            },
          },
          actionPayloads: emailActionPayloads,
          source: 'gmail-html-full-book-applied-actions',
        }),
        gmailWarnings,
      );
    }

    return appendWarnings(
      resolveEtfProFromBase({
        basePayload: localPayload,
        actionPayloads: emailActionPayloads,
        source: 'gmail-html-action-applied-to-active-book',
      }),
      gmailWarnings,
    );
  }

  if (localPayload && !emailPayload && !emailFullBookPayload) {
    return appendWarnings(localPayload, gmailWarnings);
  }

  if (emailFullBookPayload) {
    return appendWarnings(
      resolveEtfProFromBase({
        basePayload: {
          ...emailFullBookPayload,
          meta: {
            ...(emailFullBookPayload.meta || {}),
            sourceKind: 'gmail-html-full-book',
          },
        },
        actionPayloads: emailActionPayloads,
        source: 'gmail-html-full-book-applied-actions',
      }),
      ['ETF Pro lineup email used because no active open-position base exists.', ...gmailWarnings],
    );
  }

  if (!localPayload) return appendWarnings(emailPayload || null, gmailWarnings);
  if (!emailPayload?.meta?.snapshotDate) return appendWarnings(localPayload, gmailWarnings);

  const localDate = localPayload.meta?.snapshotDate || null;
  const emailDate = emailPayload.meta.snapshotDate;
  if (localDate && emailDate.localeCompare(localDate) < 0) return appendWarnings(localPayload, gmailWarnings);

  const localRows = Array.isArray(localPayload.rows) ? localPayload.rows : [];
  const emailRows = Array.isArray(emailPayload.rows) ? emailPayload.rows : [];
  if (isEtfProActionPayload(emailPayload) && localRows.length > emailRows.length) {
    return appendWarnings(applyEtfProActionUpdate(localPayload, emailPayload), gmailWarnings);
  }

  if (!localDate || emailDate.localeCompare(localDate) > 0 || emailRows.length >= Math.max(localRows.length, 1)) {
    return appendWarnings(emailPayload, gmailWarnings);
  }

  return appendWarnings(localPayload, gmailWarnings);
}

module.exports = {
  applyEtfProActionUpdate,
  classifyEtfProRows,
  dedupeEtfProActions,
  getPayloadDate,
  isActiveEtfProSnapshot,
  isEtfProActionAfterBase,
  isEtfProActionPayload,
  pickNewestPayload,
  resolveEtfProFromBase,
  resolveEtfProPayloadFromSources,
  sortPayloadsChronologically,
  withResolvedEtfProCounts,
};
