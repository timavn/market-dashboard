const DEFAULT_LIVE_MAX_AGE_MS = 60_000;

function positionIdentityText(position = {}) {
  return [
    position.symbol,
    position.localSymbol,
    position.description,
    position.tradingClass,
    position.contractMonth,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function classifyPredictionMarketPosition(position = {}) {
  const text = positionIdentityText(position);

  if (/\bKXCPI[A-Z0-9]*(?:[-_ ]|$)|\bCPIY\b/.test(text)) {
    return {
      marketFamily: 'cpi',
      marketProduct: 'cpi',
      workbench: 'cpi',
      supported: true,
    };
  }

  if (/\bKXINXU(?:[-_ ]|$)|\bKXINX(?:[-_ ]|$)/.test(text)) {
    return {
      marketFamily: 'spx',
      marketProduct: 'spx',
      workbench: 'spx',
      supported: true,
    };
  }

  if (/\bKXWTIW(?:[-_ ]|$)/.test(text)) {
    return {
      marketFamily: 'wti',
      marketProduct: 'weekly',
      workbench: 'wti',
      supported: true,
    };
  }

  if (/\bKXWTI(?:[-_ ]|$)/.test(text)) {
    return {
      marketFamily: 'wti',
      marketProduct: 'daily',
      workbench: 'wti',
      supported: true,
    };
  }

  if (/\bKXWTI[A-Z0-9]+/.test(text)) {
    return {
      marketFamily: 'wti',
      marketProduct: 'unsupported',
      workbench: 'wti',
      supported: false,
    };
  }

  return {
    marketFamily: 'other',
    marketProduct: 'other',
    workbench: null,
    supported: false,
  };
}

function parseFreshTimestamp(value, now, maxAgeMs) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const ageMs = now - timestamp;
  if (ageMs < -5_000 || ageMs > maxAgeMs) return null;
  return new Date(timestamp).toISOString();
}

function verifyLivePositionSnapshot(snapshot = {}, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Number(options.maxAgeMs)
    : DEFAULT_LIVE_MAX_AGE_MS;
  const source = String(snapshot.source || '').toLowerCase();
  const fetchedAt = parseFreshTimestamp(snapshot.fetched_at || snapshot.fetchedAt, now, maxAgeMs);

  if (snapshot.ok === false) {
    return {
      live: false,
      source: source || 'ibkr_positions',
      fetchedAt: null,
      reason: snapshot.message || snapshot.status || 'Live IBKR positions request failed.',
    };
  }

  if (!fetchedAt) {
    return {
      live: false,
      source: source || 'unknown',
      fetchedAt: null,
      reason: 'Live IBKR positions snapshot is missing a fresh fetch timestamp.',
    };
  }

  const directSnapshot = source === 'ibkr_positions';
  const syncedStream = source === 'stream_cache' && snapshot.sync?.ok === true;
  if (!directSnapshot && !syncedStream) {
    return {
      live: false,
      source: source || 'unknown',
      fetchedAt,
      reason: source === 'stream_cache'
        ? (snapshot.sync?.message || 'IBKR portfolio stream cache was not refreshed successfully.')
        : 'Position source is not a verified live IBKR snapshot.',
    };
  }

  return {
    live: true,
    source,
    fetchedAt,
    reason: null,
  };
}

function aggregatePositionSnapshotStatus(accounts = []) {
  if (!accounts.length) return 'unavailable';
  const liveCount = accounts.filter((account) => account.status === 'live').length;
  if (liveCount === accounts.length) return 'live';
  if (liveCount > 0) return 'partial';
  return 'unavailable';
}

function hasVerifiedAccountCoverage(payload = {}) {
  return Array.isArray(payload.accounts)
    && (payload.ok === true || payload.account_discovery_ok === true);
}

module.exports = {
  DEFAULT_LIVE_MAX_AGE_MS,
  aggregatePositionSnapshotStatus,
  classifyPredictionMarketPosition,
  hasVerifiedAccountCoverage,
  positionIdentityText,
  verifyLivePositionSnapshot,
};
