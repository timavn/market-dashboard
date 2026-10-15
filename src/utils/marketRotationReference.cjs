'use strict';

const catalog = require('../constants/marketRotationCatalog.json');
const MARKET_ROTATION_MAX_PAIR_SKEW_MS = 5 * 60_000;
const MAX_THEME_SKEW_MS = 20 * 60_000;

const THEME_COUNT = catalog.themes.length;
const QUOTE_DEFINITIONS = new Map([...catalog.themes, ...catalog.instruments].map((row) => [row.ticker, row]));
const FUTURE_TOLERANCE_MS = 5_000;
const REJECTED_FLAGS = [
  'stale', 'isStale', 'mock', 'isMock', 'seed', 'seeded', 'synthetic',
  'inferred', 'fromCache', 'cached', 'cacheOnly', 'cache_only', 'offline', 'disconnected', 'refreshFailed',
  'fallback', 'portfolioDerived', 'portfolio_derived',
];
const REJECTED_STATUS = /(?:^|[\s_-])(?:offline|disconnected|stale|expired|mock|seed|seeded|synthetic|inferred|cache|cached|hit|fallback|error|portfolio-derived)(?:$|[\s_-])/i;
const EVIDENCE_FIELDS = ['status', 'availability', 'freshness', 'dataType', 'source', 'provider'];
const METADATA_FIELDS = ['meta', 'metadata', '_cache', 'providerStatus', 'flags', 'quality', 'provenance'];
const QUOTE_STATUSES = new Set(['delayed', 'last-close']);

const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const isHttpsUrl = (value) => {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
};

// Check the evidence for this record, not independent records beside it.
// An unavailable factor must not invalidate the other verified pairs.
const hasRejectedEvidence = (value) => {
  if (!isObject(value)) return false;
  if (REJECTED_FLAGS.some((key) => value[key] === true)
    || value.connected === false || value.available === false || value.hit === true
    || ['cache', 'cached', 'hit', 'stale'].includes(String(value.cacheStatus || '').toLowerCase())
    || EVIDENCE_FIELDS.some((key) => REJECTED_STATUS.test(String(value[key] || '')))) return true;
  return METADATA_FIELDS.some((key) => hasRejectedEvidence(value[key]));
};

const hasValidTimes = (value, now, allowRetained = false) => {
  const observed = timestamp(value?.asOf);
  const expires = timestamp(value?.expiresAt);
  const verified = timestamp(value?.verifiedAt);
  const retained = allowRetained && value?.retained === true
    && Number.isFinite(verified) && verified <= now + FUTURE_TOLERANCE_MS
    && verified >= observed - FUTURE_TOLERANCE_MS && verified < expires;
  if (value?.retained === true && !retained) return false;
  return Number.isFinite(observed) && observed <= now + FUTURE_TOLERANCE_MS
    && Number.isFinite(expires) && (expires > now || retained) && expires > observed;
};

const hasMarketDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

function validateMarketRotationQuote(row, now = Date.now(), allowRetained = false) {
  const definition = QUOTE_DEFINITIONS.get(row?.ticker);
  if (!isObject(row) || hasRejectedEvidence(row) || !hasValidTimes(row, now, allowRetained)
    || !QUOTE_STATUSES.has(row.status) || !hasMarketDate(row.marketDate)
    || !definition || row.name !== definition.name
    || (definition.id && row.id !== definition.id)
    || !isText(row.source) || !isHttpsUrl(row.sourceUrl) || !isHttpsUrl(row.issuerUrl)
    || row.proxy !== true
    || typeof row.changePercent !== 'number' || !Number.isFinite(row.changePercent)) return null;
  return row;
}

function validateMarketRotationPair(pair, now = Date.now(), allowRetained = false) {
  if (!isObject(pair)) return null;
  const definition = catalog.factors.find((row) => row.id === pair.id);
  if (!definition) return null;
  if (hasRejectedEvidence(pair)) {
    return { ...pair, left: null, right: null, spreadPp: null, status: 'unavailable' };
  }
  const leftQuote = validateMarketRotationQuote(pair.left, now, allowRetained);
  const rightQuote = validateMarketRotationQuote(pair.right, now, allowRetained);
  const left = leftQuote?.ticker === definition.left ? leftQuote : null;
  const right = rightQuote?.ticker === definition.right ? rightQuote : null;
  const unavailable = { ...pair, left, right, spreadPp: null, status: 'unavailable' };
  if (!hasValidTimes(pair, now, allowRetained)
    || !QUOTE_STATUSES.has(pair.status) || !isText(pair.source)
    || !left || !right || left.status !== right.status || pair.status !== left.status
    || left.marketDate !== right.marketDate || pair.marketDate !== left.marketDate
    || Math.abs(timestamp(left.asOf) - timestamp(right.asOf)) > MARKET_ROTATION_MAX_PAIR_SKEW_MS
    || typeof pair.spreadPp !== 'number' || !Number.isFinite(pair.spreadPp)
    || Math.abs(pair.spreadPp - (left.changePercent - right.changePercent)) > 1e-9) return unavailable;
  const oldestLeg = Math.min(timestamp(left.asOf), timestamp(right.asOf));
  const newestLeg = Math.max(timestamp(left.asOf), timestamp(right.asOf));
  if (timestamp(pair.asOf) < oldestLeg - FUTURE_TOLERANCE_MS
    || timestamp(pair.asOf) > newestLeg + FUTURE_TOLERANCE_MS) return unavailable;
  return {
    ...pair,
    left,
    right,
    expiresAt: new Date(Math.min(timestamp(pair.expiresAt), timestamp(left.expiresAt), timestamp(right.expiresAt))).toISOString(),
  };
}

const sameObservation = (left, right) => left && right && [
  'id', 'ticker', 'name', 'changePercent', 'asOf', 'expiresAt', 'marketDate', 'status',
  'source', 'sourceUrl', 'issuerUrl', 'proxy',
].every((key) => left[key] === right[key]);

function validateThemeRanking(rows, { software, semiconductors, leader, laggard, coverage }, now, allowRetained) {
  if (!Array.isArray(rows) || rows.length !== THEME_COUNT || !coverage.comparable
    || coverage.verified !== THEME_COUNT || !software || !semiconductors || !leader || !laggard) return [];
  const verified = rows.map((row) => validateMarketRotationQuote(row, now, allowRetained));
  if (verified.some((row) => !row || !catalog.themes.some((definition) => definition.id === row.id))
    || new Set(verified.map((row) => row.id)).size !== THEME_COUNT
    || new Set(verified.map((row) => row.ticker)).size !== THEME_COUNT
    || verified.some((row) => row.marketDate !== software.marketDate || row.status !== software.status)
    || Math.max(...verified.map((row) => timestamp(row.asOf)))
      - Math.min(...verified.map((row) => timestamp(row.asOf))) > MAX_THEME_SKEW_MS) return [];
  const ordered = [...verified].sort((left, right) => right.changePercent - left.changePercent
    || left.ticker.localeCompare(right.ticker));
  if (verified.some((row, index) => row.ticker !== ordered[index].ticker)
    || !sameObservation(verified[0], leader) || !sameObservation(verified.at(-1), laggard)
    || !sameObservation(verified.find((row) => row.id === 'software'), software)
    || !sameObservation(verified.find((row) => row.id === 'semiconductors'), semiconductors)) return [];
  return verified;
}

function validateMarketRotationSnapshot(value, now = Date.now(), allowRetained = false) {
  if (!isObject(value) || !['available', 'partial'].includes(value.status)
    || hasRejectedEvidence(value) || !hasValidTimes(value, now, allowRetained)
    || !isText(value.source) || value.proxy !== true) return null;

  const rawThemes = isObject(value.themes) ? value.themes : {};
  const rawCoverage = rawThemes.coverage;
  const verifiedCoverage = isObject(rawCoverage) && Number.isInteger(rawCoverage.verified)
    && rawCoverage.verified >= 0 && rawCoverage.verified <= THEME_COUNT
    && rawCoverage.total === THEME_COUNT && !hasRejectedEvidence(rawCoverage);
  const coverage = verifiedCoverage
    ? { ...rawCoverage, comparable: rawCoverage.comparable === true && (timestamp(rawCoverage.expiresAt) > now
      || (allowRetained && rawCoverage.retained === true && hasValidTimes(rawCoverage, now, true))) }
    : { verified: 0, total: THEME_COUNT, comparable: false };
  const themesPermitted = !hasRejectedEvidence(rawThemes);
  const themeQuote = (row, expectedId) => {
    const verified = themesPermitted ? validateMarketRotationQuote(row, now, allowRetained) : null;
    return verified && catalog.themes.some((definition) => definition.id === verified.id
      && (!expectedId || definition.id === expectedId)) ? verified : null;
  };
  const software = themeQuote(rawThemes.software, 'software');
  const semiconductors = themeQuote(rawThemes.semiconductors, 'semiconductors');
  // Fixed rows may have a newer observation than the retained full-roster ranking.
  const rawRanked = Array.isArray(rawThemes.ranked) ? rawThemes.ranked : [];
  const rankingSoftware = rawThemes.coverage?.retained && allowRetained
    ? themeQuote(rawRanked.find((row) => row?.id === 'software') || rawThemes.rankingSoftware, 'software') : software;
  const rankingSemiconductors = rawThemes.coverage?.retained && allowRetained
    ? themeQuote(rawRanked.find((row) => row?.id === 'semiconductors') || rawThemes.rankingSemiconductors, 'semiconductors') : semiconductors;
  const fullCoverage = themesPermitted && rankingSoftware && rankingSemiconductors
    && coverage.comparable && coverage.verified === THEME_COUNT;
  let leader = fullCoverage ? themeQuote(rawThemes.leader) : null;
  let laggard = fullCoverage ? themeQuote(rawThemes.laggard) : null;
  const rankedRows = [rankingSoftware, rankingSemiconductors, leader, laggard];
  if (rankedRows.some((row) => !row)
    || rankedRows.some((row) => row.marketDate !== rankingSoftware.marketDate || row.status !== rankingSoftware.status)
    || Math.max(...rankedRows.map((row) => timestamp(row.asOf)))
      - Math.min(...rankedRows.map((row) => timestamp(row.asOf))) > MAX_THEME_SKEW_MS
    || leader.changePercent < laggard.changePercent) {
    leader = null;
    laggard = null;
  }
  const ranked = themesPermitted ? validateThemeRanking(rawThemes.ranked,
    { software: rankingSoftware, semiconductors: rankingSemiconductors, leader, laggard, coverage }, now, allowRetained) : [];
  if (ranked.length) {
    coverage.expiresAt = new Date(Math.min(timestamp(coverage.expiresAt),
      ...ranked.map((row) => timestamp(row.expiresAt)))).toISOString();
  } else if (rawThemes.ranked != null && (!Array.isArray(rawThemes.ranked) || rawThemes.ranked.length > 0)) {
    // A contradictory supplied roster cannot support a full-roster headline either.
    // Missing/empty expanded evidence keeps the older compact API contract valid.
    leader = null;
    laggard = null;
  }
  const factors = catalog.factors.map((definition) => {
    const candidates = Array.isArray(value.factors)
      ? value.factors.filter((pair) => pair?.id === definition.id) : [];
    return candidates.length === 1 ? validateMarketRotationPair(candidates[0], now, allowRetained)
      : { id: definition.id, label: definition.label, left: null, right: null, spreadPp: null, status: 'unavailable' };
  });
  const validFactors = factors.filter((pair) => QUOTE_STATUSES.has(pair.status));
  if (!software && !semiconductors && !leader && !laggard && validFactors.length === 0) return null;
  return {
    ...value,
    status: software && semiconductors && leader && laggard && validFactors.length === catalog.factors.length
      ? 'available' : 'partial',
    themes: { ...rawThemes, software, semiconductors, leader, laggard, ranked, coverage },
    factors,
  };
}

// A retained observation is evidence accepted while its provider freshness was
// valid. Only these bounded, informational records may outlive that freshness.
const withVerification = (row, now) => row && {
  ...row, verifiedAt: row.verifiedAt || new Date(now).toISOString(),
};
const retain = (row) => row && { ...row, retained: true };
const validPair = (pair) => pair && QUOTE_STATUSES.has(pair.status) && Number.isFinite(pair.spreadPp);
const rankingRows = (themes) => themes?.ranked?.length ? themes.ranked
  : [themes?.rankingSoftware || themes?.software, themes?.rankingSemiconductors || themes?.semiconductors,
    themes?.leader, themes?.laggard].filter(Boolean);
const rankingTime = (themes) => Math.min(...rankingRows(themes).map((row) => timestamp(row.asOf)));
const validRanking = (themes) => themes?.leader && themes?.laggard && themes?.coverage?.comparable;

function retainPair(pair) {
  return validPair(pair) ? { ...retain(pair), left: retain(pair.left), right: retain(pair.right) } : pair;
}

function retainRanking(themes) {
  if (!validRanking(themes)) return themes;
  return {
    ...themes, leader: retain(themes.leader), laggard: retain(themes.laggard),
    ranked: (themes.ranked || []).map(retain), coverage: retain(themes.coverage),
    rankingSoftware: retain(themes.rankingSoftware || themes.software),
    rankingSemiconductors: retain(themes.rankingSemiconductors || themes.semiconductors),
  };
}

function retainMarketRotationSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    ...snapshot, retained: true,
    themes: { ...retainRanking(snapshot.themes), software: retain(snapshot.themes.software),
      semiconductors: retain(snapshot.themes.semiconductors) },
    factors: snapshot.factors.map(retainPair),
  };
}

function restoreMarketRotationSnapshot(snapshot, now = Date.now()) {
  if (!isObject(snapshot) || !isObject(snapshot.themes) || !Array.isArray(snapshot.factors)) return null;
  // Restore does not confer verification on arbitrary stored values.
  // Every restored record must carry the original in-window acceptance time.
  const restored = retainMarketRotationSnapshot(snapshot);
  return validateMarketRotationSnapshot(restored, now, true);
}

function mergeMarketRotationSnapshots(previous, payload, now = Date.now()) {
  const incoming = validateMarketRotationSnapshot(payload, now, true);
  if (!incoming) return retainMarketRotationSnapshot(previous);
  const select = (prior, next) => {
    if (!next || (prior && (timestamp(next.asOf) < timestamp(prior.asOf)
      || (prior.retained && timestamp(next.asOf) === timestamp(prior.asOf))))) return retain(prior);
    return withVerification(next, now);
  };
  const themes = {
    ...incoming.themes,
    software: select(previous?.themes.software, incoming.themes.software),
    semiconductors: select(previous?.themes.semiconductors, incoming.themes.semiconductors),
  };
  if (validRanking(incoming.themes)
    && (!validRanking(previous?.themes) || rankingTime(incoming.themes) > rankingTime(previous.themes)
      || (!previous.themes.coverage.retained && rankingTime(incoming.themes) === rankingTime(previous.themes)))) {
    themes.leader = withVerification(incoming.themes.leader, now);
    themes.laggard = withVerification(incoming.themes.laggard, now);
    themes.ranked = incoming.themes.ranked.map((row) => withVerification(row, now));
    themes.rankingSoftware = withVerification(incoming.themes.rankingSoftware || incoming.themes.software, now);
    themes.rankingSemiconductors = withVerification(incoming.themes.rankingSemiconductors || incoming.themes.semiconductors, now);
    themes.coverage = withVerification({ ...incoming.themes.coverage,
      asOf: new Date(rankingTime(incoming.themes)).toISOString() }, now);
  } else if (validRanking(previous?.themes)) {
    const held = retainRanking(previous.themes);
    for (const key of ['leader', 'laggard', 'ranked', 'coverage', 'rankingSoftware', 'rankingSemiconductors']) themes[key] = held[key];
  }
  const factors = incoming.factors.map((pair) => {
    const prior = previous?.factors.find((row) => row.id === pair.id);
    if (!validPair(pair) || (validPair(prior) && (timestamp(pair.asOf) < timestamp(prior.asOf)
      || (prior.retained && timestamp(pair.asOf) === timestamp(prior.asOf))))) {
      return validPair(prior) ? retainPair(prior) : pair;
    }
    return { ...withVerification(pair, now), left: withVerification(pair.left, now), right: withVerification(pair.right, now) };
  });
  const records = [themes.software, themes.semiconductors, themes.leader, themes.laggard,
    ...factors.filter(validPair)].filter(Boolean);
  return {
    ...incoming,
    status: themes.software && themes.semiconductors && validRanking(themes) && factors.every(validPair)
      ? 'available' : 'partial',
    asOf: new Date(Math.min(...records.map((row) => timestamp(row.asOf)))).toISOString(),
    expiresAt: previous ? new Date(Math.max(...records.map((row) => timestamp(row.expiresAt)))).toISOString() : incoming.expiresAt,
    verifiedAt: new Date(Math.min(...records.map((row) => timestamp(row.verifiedAt)))).toISOString(),
    retained: records.some((row) => row.retained === true), themes, factors,
  };
}

function ageMarketRotationSnapshot(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  const expired = (row) => row && timestamp(row.expiresAt) <= now;
  if (expired(snapshot)) return retainMarketRotationSnapshot(snapshot);
  let themes = snapshot.themes;
  if (expired(themes.coverage) || rankingRows(themes).some(expired)) themes = retainRanking(themes);
  themes = { ...themes,
    software: expired(themes.software) ? retain(themes.software) : themes.software,
    semiconductors: expired(themes.semiconductors) ? retain(themes.semiconductors) : themes.semiconductors,
  };
  const factors = snapshot.factors.map((pair) => expired(pair) || expired(pair.left) || expired(pair.right) ? retainPair(pair) : pair);
  return { ...snapshot, themes, factors,
    retained: snapshot.retained || [themes.software, themes.semiconductors, themes.leader, themes.laggard, ...factors]
      .some((row) => row?.retained === true) };
}

function nextMarketRotationExpiry(snapshot) {
  const candidates = [snapshot, snapshot.themes?.coverage,
    snapshot.themes?.software, snapshot.themes?.semiconductors,
    ...rankingRows(snapshot.themes), ...snapshot.factors.flatMap((pair) => [pair, pair.left, pair.right])];
  return Math.min(...candidates.filter((row) => row && !row.retained)
    .map((row) => timestamp(row.expiresAt)).filter(Number.isFinite));
}

module.exports = {
  validateMarketRotationQuote, validateMarketRotationPair, validateMarketRotationSnapshot,
  mergeMarketRotationSnapshots, retainMarketRotationSnapshot, restoreMarketRotationSnapshot,
  ageMarketRotationSnapshot, nextMarketRotationExpiry,
};
