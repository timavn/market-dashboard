const VALID_TICKER_PATTERN = /^[A-Z][A-Z0-9./-]{0,9}$/;
const RESERVED_TICKERS = new Set([
  'ADD',
  'ALERT',
  'BUY',
  'BUYING',
  'CLOSE',
  'CLOSING',
  'COVER',
  'COVERING',
  'LONG',
  'REMOVE',
  'SELL',
  'SELLING',
  'SHORT',
  'SHORTING',
  'SIGNAL',
]);
const SUPPORTED_ACTIONS = new Set(['BUY', 'SELL', 'COVER', 'SELL-SOME', 'ADD', 'REMOVE']);

function normalizeRealTimeAlerts(snapshot) {
  const data = snapshot?.data || {};
  if (Array.isArray(data.alerts)) return data.alerts.filter(Boolean);
  if (data.alert) return [data.alert].filter(Boolean);
  return [];
}

function normalizeTicker(rawTicker) {
  if (!rawTicker) return null;
  const cleaned = String(rawTicker).trim().toUpperCase();
  if (!VALID_TICKER_PATTERN.test(cleaned) || RESERVED_TICKERS.has(cleaned)) return null;
  return cleaned;
}

function normalizeSide(rawSide) {
  const side = String(rawSide || '').trim().toLowerCase();
  return side === 'long' || side === 'short' ? side : null;
}

function normalizeIntent(rawIntent) {
  return String(rawIntent || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function getAlertTime(alert, snapshot) {
  return alert?.eventTime || snapshot?.scrapedAt || snapshot?.date || null;
}

function openPosition(positionMap, ticker, side, alert, eventTime) {
  const existing = positionMap.get(ticker);
  positionMap.set(ticker, {
    ticker,
    side,
    name: alert?.name || ticker,
    openedAt: existing?.side === side ? existing.openedAt : eventTime,
    lastActionAt: eventTime,
  });
}

function formatRatioText(longCount, shortCount) {
  if (!longCount && !shortCount) return 'No holdings';
  if (!shortCount) return `${longCount}:0`;
  if (!longCount) return `0:${shortCount}`;
  return `${(longCount / shortCount).toFixed(1)}:1`;
}

function deriveNetBias(longCount, shortCount) {
  if (longCount === shortCount) return 'balanced';
  return longCount > shortCount ? 'long' : 'short';
}

function getTimeMs(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function seedBaselinePositions(positionMap, baseline = {}, onInvalid = null) {
  const asOf = baseline.asOf || baseline.lastUpdated || null;
  const positions = Array.isArray(baseline.holdings)
    ? baseline.holdings
    : [
        ...(Array.isArray(baseline.longs)
          ? baseline.longs.map((ticker) => ({ ticker, side: 'long' }))
          : []),
        ...(Array.isArray(baseline.shorts)
          ? baseline.shorts.map((ticker) => ({ ticker, side: 'short' }))
          : []),
      ];

  positions.forEach((position) => {
    const rawTicker = position?.ticker || position;
    const ticker = normalizeTicker(rawTicker);
    const rawSide = position && typeof position === 'object' ? position.side : 'long';
    const side = normalizeSide(rawSide || 'long');

    if (!ticker || !side) {
      onInvalid?.({
        code: 'malformed-baseline-position',
        ticker: rawTicker ? String(rawTicker).toUpperCase() : null,
        action: 'BASELINE',
        eventTime: asOf,
        message: `RTA baseline contains an invalid position${rawTicker ? ` (${rawTicker})` : ''}.`,
      });
      return;
    }

    const existing = positionMap.get(ticker);
    if (existing && existing.side !== side) {
      onInvalid?.({
        code: 'baseline-side-mismatch',
        ticker,
        action: 'BASELINE',
        eventTime: asOf,
        message: `RTA baseline lists ${ticker} as both long and short.`,
      });
      return;
    }

    positionMap.set(ticker, {
      ticker,
      side,
      name: position?.name || ticker,
      openedAt: position?.openedAt || asOf,
      lastActionAt: position?.lastActionAt || asOf,
      source: position?.source || 'rta-benchmark',
    });
  });

  return asOf;
}

function normalizeAction(rawAction) {
  const action = String(rawAction || '').trim().toUpperCase().replace(/[\s_]+/g, '-');
  if (action === 'COVER-SOME') return 'COVER';
  return action;
}

function signalTextCandidates(alert) {
  return [alert?.signalPhrase, alert?.headline]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function signalDetailsFromText(text) {
  const explicitModifierMatch = text.match(
    /\b(BUY|SELL|COVER(?:-SOME)?|SELL-SOME)\s+SIGNAL\b\s*(?:[-:\u2013\u2014]\s*)?(SHORTING|COVERING|BUYING|SELLING)\b(?:\s+(?:SHORT|LONG))?[\s:-]+([A-Z][A-Z0-9./-]{0,9})\b/i,
  );
  const directSignalMatch = explicitModifierMatch
    ? null
    : text.match(
        /\b(BUY|SELL|COVER(?:-SOME)?|SELL-SOME)\s+SIGNAL\b\s*(?:[-:\u2013\u2014]\s*)?([A-Z][A-Z0-9./-]{0,9})\b/i,
      );

  if (!explicitModifierMatch && !directSignalMatch) return null;

  const rawAction = (explicitModifierMatch?.[1] || directSignalMatch?.[1]).toUpperCase();
  const modifier = (explicitModifierMatch?.[2] || '').toUpperCase();
  const ticker = normalizeTicker(explicitModifierMatch?.[3] || directSignalMatch?.[2]);
  if (!ticker) return null;

  if (modifier === 'COVERING') {
    return { ticker, action: 'COVER', intent: 'close-short', side: 'short' };
  }
  if (modifier === 'SHORTING') {
    return { ticker, action: 'SELL', intent: 'open-short', side: 'short' };
  }
  if (modifier === 'BUYING') {
    return { ticker, action: 'BUY', intent: 'open-long', side: 'long' };
  }
  if (modifier === 'SELLING') {
    return { ticker, action: 'SELL', intent: 'close-long', side: 'long' };
  }

  return { ticker, action: normalizeAction(rawAction), intent: null, side: null };
}

function normalizeAlert(alert, snapshot) {
  const textCandidates = signalTextCandidates(alert);
  const textDetails = textCandidates
    .map(signalDetailsFromText)
    .find(Boolean);
  const combinedText = textCandidates.join(' ');
  const rawIntent = normalizeIntent(alert?.intent);

  // When a complete signal phrase is parseable, its lack of a modifier is
  // meaningful: "SELL SIGNAL HLT" is a plain exit even if stale materialized
  // metadata incorrectly says open-short.
  let intent = textDetails ? textDetails.intent : (rawIntent || null);
  let side = textDetails ? textDetails.side : normalizeSide(alert?.side);
  let action = textDetails?.action || normalizeAction(alert?.action);

  // Some materialized alerts retain a correct ticker but a raw BUY/SELL action.
  // The complete phrase is more authoritative about whether that signal opens or closes.
  if (!textDetails && /\bCOVERING\b/i.test(combinedText)) {
    action = 'COVER';
    intent = 'close-short';
    side = 'short';
  } else if (!textDetails && /\bSHORTING\b/i.test(combinedText)) {
    action = 'SELL';
    intent = 'open-short';
    side = 'short';
  } else if (!textDetails && /\bBUYING\b/i.test(combinedText)) {
    action = 'BUY';
    intent = 'open-long';
    side = 'long';
  }

  return {
    alert,
    ticker: textDetails?.ticker || normalizeTicker(alert?.ticker || alert?.symbol),
    rawTicker: alert?.ticker || alert?.symbol || null,
    action,
    rawAction: alert?.action || null,
    intent,
    side,
    rawSide: alert?.side || null,
    eventTime: getAlertTime(alert, snapshot),
    sourceMessageId:
      alert?.sourceMessageId ||
      alert?.messageId ||
      snapshot?.sourceMessageId ||
      snapshot?.messageId ||
      null,
    text: textCandidates[0] || null,
  };
}

function eventDedupeKey(event) {
  const normalizedParts = [
    event.ticker || String(event.rawTicker || '').trim().toUpperCase(),
    event.action || normalizeAction(event.rawAction),
    event.intent || '',
    event.side || '',
  ];
  if (event.sourceMessageId) {
    return `source:${event.sourceMessageId}:${normalizedParts.join(':')}`;
  }
  return `event:${event.eventTime || ''}:${normalizedParts.join(':')}:${event.text || ''}`;
}

function buildReplayEvents(snapshots) {
  const events = [];
  (Array.isArray(snapshots) ? snapshots : []).forEach((snapshot, snapshotIndex) => {
    normalizeRealTimeAlerts(snapshot).forEach((alert, alertIndex) => {
      const event = normalizeAlert(alert, snapshot);
      events.push({
        ...event,
        timeMs: getTimeMs(event.eventTime),
        snapshotIndex,
        alertIndex,
      });
    });
  });

  return events.sort((a, b) => {
    if (a.timeMs === null && b.timeMs !== null) return 1;
    if (a.timeMs !== null && b.timeMs === null) return -1;
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    if (a.snapshotIndex !== b.snapshotIndex) return a.snapshotIndex - b.snapshotIndex;
    return a.alertIndex - b.alertIndex;
  });
}

function summarizeRealTimeAlertPositions(snapshots, { windowDays = 90, baseline = null } = {}) {
  const positionMap = new Map();
  const invalidEvents = [];
  const warnings = [];
  const recordInvalid = (issue) => {
    invalidEvents.push(issue);
    if (issue.message && !warnings.includes(issue.message)) warnings.push(issue.message);
  };

  const baselineAsOf = baseline
    ? seedBaselinePositions(positionMap, baseline, recordInvalid)
    : null;
  const baselineAsOfMs = getTimeMs(baselineAsOf);
  if (baseline && baselineAsOfMs === null) {
    recordInvalid({
      code: 'malformed-baseline-time',
      ticker: null,
      action: 'BASELINE',
      eventTime: baselineAsOf,
      message: 'RTA baseline is missing a valid as-of timestamp.',
    });
  }

  const orderedEvents = buildReplayEvents(snapshots);
  const seenEvents = new Set();
  let deduplicatedEventCount = 0;
  let processedEventCount = 0;
  let lastUpdated = baselineAsOf || null;

  orderedEvents.forEach((event) => {
    // The official board supersedes every alert at or before its capture time.
    if (
      baselineAsOfMs !== null &&
      event.timeMs !== null &&
      event.timeMs <= baselineAsOfMs
    ) {
      return;
    }

    const dedupeKey = eventDedupeKey(event);
    if (seenEvents.has(dedupeKey)) {
      deduplicatedEventCount += 1;
      return;
    }
    seenEvents.add(dedupeKey);
    processedEventCount += 1;

    if (event.timeMs !== null) lastUpdated = event.eventTime;

    const diagnosticBase = {
      ticker: event.ticker || (event.rawTicker ? String(event.rawTicker).toUpperCase() : null),
      action: event.action || (event.rawAction ? normalizeAction(event.rawAction) : null),
      eventTime: event.eventTime,
      sourceMessageId: event.sourceMessageId,
    };

    if (event.timeMs === null) {
      recordInvalid({
        ...diagnosticBase,
        code: 'malformed-event-time',
        message: 'RTA alert is missing a valid event timestamp.',
      });
      return;
    }
    if (!event.ticker) {
      const rawTicker = event.rawTicker ? ` (${String(event.rawTicker).toUpperCase()})` : '';
      recordInvalid({
        ...diagnosticBase,
        code: 'malformed-ticker',
        message: `RTA alert contains a missing, reserved, or invalid ticker${rawTicker}.`,
      });
      return;
    }
    if (!SUPPORTED_ACTIONS.has(event.action)) {
      const rawAction = event.rawAction ? ` (${String(event.rawAction).toUpperCase()})` : '';
      recordInvalid({
        ...diagnosticBase,
        code: 'malformed-action',
        message: `RTA alert contains a missing or unsupported action${rawAction}.`,
      });
      return;
    }
    if (event.rawSide && !normalizeSide(event.rawSide)) {
      recordInvalid({
        ...diagnosticBase,
        code: 'malformed-side',
        message: `RTA alert contains an invalid side for ${event.ticker}.`,
      });
      return;
    }

    const existing = positionMap.get(event.ticker);

    if (event.action === 'BUY') {
      const explicitlyOpensLong = event.intent === 'open-long';
      if (existing?.side === 'short' && !explicitlyOpensLong) {
        positionMap.delete(event.ticker);
        return;
      }
      openPosition(positionMap, event.ticker, 'long', event.alert, event.eventTime);
      return;
    }

    if (event.action === 'SELL') {
      const explicitlyOpensShort = event.intent === 'open-short';
      if (existing?.side === 'long' && !explicitlyOpensShort) {
        positionMap.delete(event.ticker);
        return;
      }
      openPosition(positionMap, event.ticker, 'short', event.alert, event.eventTime);
      return;
    }

    if (event.action === 'COVER') {
      if (!existing) {
        recordInvalid({
          ...diagnosticBase,
          code: 'unmatched-cover',
          message: `RTA cover for ${event.ticker} does not match an active short.`,
        });
      } else if (existing.side !== 'short') {
        recordInvalid({
          ...diagnosticBase,
          code: 'side-mismatch',
          message: `RTA cover for ${event.ticker} conflicts with its active long side.`,
        });
      } else {
        positionMap.delete(event.ticker);
      }
      return;
    }

    if (event.action === 'SELL-SOME') {
      if (!existing) {
        recordInvalid({
          ...diagnosticBase,
          code: 'unmatched-sell-some',
          message: `RTA sell-some for ${event.ticker} does not match an active long.`,
        });
      } else if (existing.side !== 'long') {
        recordInvalid({
          ...diagnosticBase,
          code: 'side-mismatch',
          message: `RTA sell-some for ${event.ticker} conflicts with its active short side.`,
        });
      } else {
        positionMap.delete(event.ticker);
      }
      return;
    }

    if (event.action === 'ADD') {
      const side = event.side || 'long';
      if (existing && existing.side !== side) {
        recordInvalid({
          ...diagnosticBase,
          code: 'side-mismatch',
          message: `RTA add for ${event.ticker} as ${side} conflicts with its active ${existing.side} side.`,
        });
      } else {
        openPosition(positionMap, event.ticker, side, event.alert, event.eventTime);
      }
      return;
    }

    if (!existing) {
      recordInvalid({
        ...diagnosticBase,
        code: 'unmatched-remove',
        message: `RTA remove for ${event.ticker} does not match an active position.`,
      });
    } else if (event.side && existing.side !== event.side) {
      recordInvalid({
        ...diagnosticBase,
        code: 'side-mismatch',
        message: `RTA remove for ${event.ticker} as ${event.side} conflicts with its active ${existing.side} side.`,
      });
    } else {
      positionMap.delete(event.ticker);
    }
  });

  const reconstructedHoldings = Array.from(positionMap.values()).sort((a, b) => {
    if (a.side !== b.side) return a.side === 'long' ? -1 : 1;
    return a.ticker.localeCompare(b.ticker);
  });
  const reconstructedLongCount = reconstructedHoldings.filter((holding) => holding.side === 'long').length;
  const reconstructedShortCount = reconstructedHoldings.filter((holding) => holding.side === 'short').length;
  const hasInput = Boolean(baseline) || orderedEvents.length > 0;
  const valid = invalidEvents.length === 0;
  const available = hasInput && valid;
  const longCount = available ? reconstructedLongCount : null;
  const shortCount = available ? reconstructedShortCount : null;

  return {
    available,
    lastUpdated,
    windowDays,
    positionSource: 'alert-reconstruction',
    positionSourceConfidence: available ? 'high' : 'low',
    baseline: baseline
      ? {
          id: baseline.id || null,
          asOf: baselineAsOf,
          source: baseline.source || 'rta-benchmark',
        }
      : null,
    dataQuality: {
      status: !hasInput ? 'unavailable' : valid ? 'ok' : 'error',
      warnings,
      invalidEvents,
      processedEventCount,
      deduplicatedEventCount,
    },
    reconstructionWarnings: warnings,
    longCount,
    shortCount,
    ratioText: available ? formatRatioText(longCount, shortCount) : null,
    netBias: available ? deriveNetBias(longCount, shortCount) : null,
    holdings: available ? reconstructedHoldings : [],
  };
}

module.exports = {
  seedBaselinePositions,
  normalizeRealTimeAlerts,
  summarizeRealTimeAlertPositions,
  formatRatioText,
  deriveNetBias,
};
