const crypto = require('crypto');
const { isMarketDay } = require('./analyticsDailyBrief.cjs');

const DEFAULT_MIN_PRIMARY_COUNT = 30;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateFromIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function previousMarketDate(date) {
  let cursor = addDays(date, -1);
  while (!isMarketDay(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}

function newYorkParts(now) {
  const values = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now)).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function expectedRiskRangePublication(now = new Date(), {
  deadlineHour = 8,
  deadlineMinute = 15,
} = {}) {
  const parts = newYorkParts(now);
  const today = dateFromIso(parts.date);
  if (!today) {
    return { expectedDate: parts.date, pendingDate: null, marketDay: false, afterDeadline: false };
  }
  const marketDay = isMarketDay(today);
  const afterDeadline = marketDay &&
    (parts.hour > deadlineHour || (parts.hour === deadlineHour && parts.minute >= deadlineMinute));
  if (!marketDay) {
    return {
      expectedDate: isoDate(previousMarketDate(addDays(today, 1))),
      pendingDate: null,
      marketDay: false,
      afterDeadline: false,
    };
  }
  if (!afterDeadline) {
    return {
      expectedDate: isoDate(previousMarketDate(today)),
      pendingDate: parts.date,
      marketDay: true,
      afterDeadline: false,
    };
  }
  return {
    expectedDate: parts.date,
    pendingDate: null,
    marketDay: true,
    afterDeadline: true,
  };
}

function classifyRiskRangeSource(item = {}) {
  const source = String(item.source || '').toLowerCase();
  if (source.includes('early-look')) return 'supplemental';
  if (source.includes('risk-ranges-email') || source.includes('risk-range-email')) return 'primary';
  if (source.includes('hedgeye') || source.includes('risk-range')) return 'primary';
  return 'unknown';
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9./=^_-]{0,79}$/.test(ticker) ? ticker : null;
}

function strictFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const normalized = typeof value === 'string' ? value.trim().replace(/,/g, '') : value;
  if (normalized === '') return null;
  const number = typeof normalized === 'number' ? normalized : Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeRiskRangeItem(item = {}) {
  const ticker = normalizeTicker(item.ticker);
  const lrr = strictFiniteNumber(item.lrr);
  const hrr = strictFiniteNumber(item.hrr);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) ? item.date : null;
  const sourceClass = classifyRiskRangeSource(item);
  const reasons = [];
  if (!ticker) reasons.push('invalid-ticker');
  if (!date) reasons.push('invalid-date');
  if (lrr === null) reasons.push('invalid-lrr');
  if (hrr === null) reasons.push('invalid-hrr');
  if (lrr !== null && hrr !== null && lrr > hrr) reasons.push('inverted-range');
  if (sourceClass === 'unknown') reasons.push('unknown-source');
  if (reasons.length > 0) {
    return {
      valid: false,
      ticker: ticker || item.ticker || null,
      date,
      sourceClass,
      reasons,
    };
  }
  return {
    valid: true,
    ticker,
    date,
    sourceClass,
    value: {
      lrr,
      hrr,
      trend: item.trend || 'N/A',
      timestamp: item.updatedAt || item.scrapedAt || null,
      date,
      source: item.source || null,
      provenance: sourceClass,
    },
  };
}

function selectPublicationRows(items, publicationDate) {
  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeRiskRangeItem)
    .filter((item) => item.date === publicationDate);
  const invalid = normalized.filter((item) => !item.valid);
  const valid = normalized.filter((item) => item.valid);
  const primary = valid.filter((item) => item.sourceClass === 'primary');
  const supplemental = valid.filter((item) => item.sourceClass === 'supplemental');
  const merged = new Map();
  supplemental.forEach((item) => merged.set(item.ticker, item));
  primary.forEach((item) => merged.set(item.ticker, item));
  return { invalid, primary, supplemental, merged };
}

function riskRangeManifestChecksum(items, publicationDate, {
  numericFormat = 'canonical',
} = {}) {
  const formatNumber = (value) => (
    numericFormat === 'python-float-v3' && Number.isInteger(value)
      ? value.toFixed(1)
      : String(value)
  );
  const rows = selectPublicationRows(items, publicationDate).primary
    .map((item) => ({
      hrr: formatNumber(item.value.hrr),
      lrr: formatNumber(item.value.lrr),
      ticker: item.ticker,
      trend: item.value.trend,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function applyPersistedManifestGate(envelope, items, storedManifest, {
  expectedDate,
  pendingDate,
  afterDeadline,
  manifestError = null,
} = {}) {
  const expected = expectedDate || envelope?.manifest?.expectedDate || null;
  const failStatus = pendingDate && !afterDeadline ? 'pending' : 'failed';
  const reasons = [];
  if (manifestError) reasons.push('manifest-unavailable');
  if (!storedManifest) reasons.push('manifest-missing');
  if (storedManifest && storedManifest.publicationDate !== expected) reasons.push('manifest-date-mismatch');
  if (storedManifest && storedManifest.manifestType !== 'primary') reasons.push('manifest-type-invalid');
  if (storedManifest && storedManifest.completionState !== 'complete') reasons.push('manifest-incomplete');
  if (storedManifest && Number(storedManifest.count) !== Number(envelope?.manifest?.primaryCount || 0)) {
    reasons.push('manifest-count-mismatch');
  }
  const acceptedChecksums = [riskRangeManifestChecksum(items, expected)];
  // Parser v3 hashed values before DynamoDB normalized integral Decimals
  // (for example "100.0" became "100" when read back). Accept that exact
  // producer representation as an equivalent receipt, while retaining the
  // canonical checksum for every other parser version.
  if (storedManifest?.parserVersion === 'risk-range-email-v3') {
    acceptedChecksums.push(riskRangeManifestChecksum(items, expected, {
      numericFormat: 'python-float-v3',
    }));
  }
  if (storedManifest && !acceptedChecksums.includes(storedManifest.checksum)) {
    reasons.push('manifest-checksum-mismatch');
  }

  const manifestVerified = reasons.length === 0;
  const activeAvailable = manifestVerified && envelope?.status === 'current' && envelope?.available === true;
  return {
    ...envelope,
    available: activeAvailable,
    status: activeAvailable ? 'current' : failStatus,
    ranges: activeAvailable ? envelope.ranges : {},
    supplementalRanges: activeAvailable ? envelope.supplementalRanges : {},
    manifest: {
      ...(envelope?.manifest || {}),
      expectedDate: expected,
      pendingDate: pendingDate || null,
      afterDeadline: Boolean(afterDeadline),
      persistedManifestVerified: manifestVerified,
      persistedCompletionState: storedManifest?.completionState || null,
      persistedChecksum: storedManifest?.checksum || null,
      persistedParserVersion: storedManifest?.parserVersion || null,
    },
    diagnostics: {
      ...(envelope?.diagnostics || {}),
      manifestReasons: reasons,
      manifestError,
    },
  };
}

function buildRiskRangeEnvelope(items, {
  now = new Date(),
  requestedDate = null,
  minPrimaryCount = DEFAULT_MIN_PRIMARY_COUNT,
  deadlineHour = 8,
  deadlineMinute = 15,
} = {}) {
  const dates = [...new Set((Array.isArray(items) ? items : [])
    .map((item) => item?.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date))))].sort();
  const latestDate = dates.at(-1) || null;
  const expectation = expectedRiskRangePublication(now, { deadlineHour, deadlineMinute });
  const publicationDate = requestedDate || latestDate;
  const rows = selectPublicationRows(items, publicationDate);
  const invalidPrimary = rows.invalid.filter((item) => item.sourceClass === 'primary');
  const enoughPrimary = rows.primary.length >= Math.max(1, Number(minPrimaryCount) || DEFAULT_MIN_PRIMARY_COUNT);

  let status = 'missing';
  if (requestedDate) {
    status = rows.primary.length > 0 && invalidPrimary.length === 0 ? 'historical' : 'invalid';
  } else if (publicationDate) {
    if (!enoughPrimary || invalidPrimary.length > 0) status = 'invalid';
    else if (expectation.pendingDate && publicationDate === expectation.pendingDate) status = 'current';
    else if (expectation.pendingDate && publicationDate === expectation.expectedDate) status = 'pending';
    else if (publicationDate === expectation.expectedDate) status = 'current';
    else if (publicationDate < expectation.expectedDate) status = 'stale';
    else status = 'invalid';
  }

  const available = status === 'current' || status === 'historical';
  const primaryByTicker = new Map();
  rows.primary.forEach((item) => primaryByTicker.set(item.ticker, item));
  const supplementalOnly = new Map(
    rows.supplemental
      .filter((item) => !primaryByTicker.has(item.ticker))
      .map((item) => [item.ticker, item]),
  );
  // Only the primary Risk Ranges publication is decision-grade. Early Look is
  // retained as explicitly supplemental context, never merged into the active
  // ranges object consumed by cards, sizing, or order-entry surfaces.
  const canonicalRanges = Object.fromEntries(
    [...primaryByTicker.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, item]) => [ticker, item.value]),
  );
  const canonicalSupplementalRanges = Object.fromEntries(
    [...supplementalOnly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ticker, item]) => [ticker, { ...item.value, decisionEligible: false }]),
  );
  const dataVersion = publicationDate
    ? `risk-range-envelope-v2:${crypto.createHash('sha256').update(JSON.stringify(canonicalRanges)).digest('hex')}`
    : null;
  const ranges = available ? canonicalRanges : {};
  return {
    schemaVersion: 1,
    available,
    status,
    ranges,
    supplementalRanges: available ? canonicalSupplementalRanges : {},
    manifest: {
      publicationDate,
      expectedDate: expectation.expectedDate,
      pendingDate: expectation.pendingDate,
      marketDay: expectation.marketDay,
      afterDeadline: expectation.afterDeadline,
      primaryCount: rows.primary.length,
      supplementalCount: rows.supplemental.length,
      mergedCount: rows.merged.size,
      decisionRangeCount: primaryByTicker.size,
      supplementalOnlyCount: supplementalOnly.size,
      invalidCount: rows.invalid.length,
      minimumPrimaryCount: Math.max(1, Number(minPrimaryCount) || DEFAULT_MIN_PRIMARY_COUNT),
      parserVersion: 'risk-range-envelope-v2',
      dataVersion,
      latestUpdatedAt: [...primaryByTicker.values()]
        .map((item) => item.value.timestamp)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    },
    diagnostics: {
      invalid: rows.invalid,
      primaryTickers: rows.primary.map((item) => item.ticker).sort(),
      supplementalTickers: rows.supplemental.map((item) => item.ticker).sort(),
      supplementalOnlyTickers: [...supplementalOnly.keys()].sort(),
    },
  };
}

module.exports = {
  DEFAULT_MIN_PRIMARY_COUNT,
  buildRiskRangeEnvelope,
  applyPersistedManifestGate,
  classifyRiskRangeSource,
  expectedRiskRangePublication,
  normalizeRiskRangeItem,
  riskRangeManifestChecksum,
  strictFiniteNumber,
};
