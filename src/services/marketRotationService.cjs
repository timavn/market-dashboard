'use strict';

const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../constants/marketRotationCatalog.json');
const { mergeMarketRotationSnapshots, restoreMarketRotationSnapshot, ageMarketRotationSnapshot, nextMarketRotationExpiry } = require('../utils/marketRotationReference.cjs');
const REFERENCE_FILE_PATH = path.join(__dirname, '../../data/market-rotation-reference/last-verified-v1.json');
const { chartUrl } = require('./marketDailyService.cjs');
const { parseDailyChart, validParsed } = require('./marketDailyMetrics.cjs');

const SOURCE = 'Yahoo Finance';
const MAX_COMPARISON_SKEW_MS = 5 * 60_000;
const MAX_THEME_SKEW_MS = 20 * 60_000;
const DEFINITIONS = [...new Map([...catalog.themes, ...catalog.instruments].map(row => [row.ticker, row])).values()];
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

function timing(rows) {
  return {
    asOf: rows.length ? iso(Math.min(...rows.map(row => Date.parse(row.asOf)))) : null,
    expiresAt: rows.length ? iso(Math.min(...rows.map(row => Date.parse(row.expiresAt)))) : null,
  };
}

function comparable(rows, maxSkewMs = MAX_COMPARISON_SKEW_MS) {
  if (!rows.length || rows.some(row => !row)) return false;
  const first = rows[0];
  const times = rows.map(row => Date.parse(row.asOf));
  return rows.every(row => row.marketDate === first.marketDate && row.status === first.status)
    && Math.max(...times) - Math.min(...times) <= maxSkewMs;
}

function buildMarketRotationSnapshot({ dailyByTicker = new Map(), nowMs = Date.now() } = {}) {
  const quotes = new Map();
  for (const definition of DEFINITIONS) {
    const parsed = dailyByTicker instanceof Map ? dailyByTicker.get(definition.ticker) : dailyByTicker?.[definition.ticker];
    if (!validParsed(parsed, definition.ticker, nowMs) || parsed.corporateActionToday
      || !Number.isFinite(parsed.changePercent) || !Number.isFinite(parsed.previousClose) || parsed.previousClose <= 0) continue;
    quotes.set(definition.ticker, {
      ...definition, changePercent: parsed.changePercent,
      source: parsed.source, sourceUrl: parsed.sourceUrl, asOf: parsed.asOf, expiresAt: parsed.expiresAt,
      marketDate: parsed.marketDate, status: parsed.status, proxy: true,
    });
  }
  const themeRows = catalog.themes.map(row => quotes.get(row.ticker)).filter(Boolean);
  // Themes rank the latest verified daily readings across the full roster;
  // two-leg factor spreads require the tighter observation window below.
  const themeComparable = themeRows.length === catalog.themes.length && comparable(themeRows, MAX_THEME_SKEW_MS);
  const ranked = themeComparable ? [...themeRows].sort((a, b) => b.changePercent - a.changePercent || a.ticker.localeCompare(b.ticker)) : [];
  const factors = catalog.factors.map(definition => {
    const left = quotes.get(definition.left) || null;
    const right = quotes.get(definition.right) || null;
    const valid = comparable([left, right]);
    return {
      id: definition.id, label: definition.label, left, right,
      spreadPp: valid ? left.changePercent - right.changePercent : null,
      ...timing(valid ? [left, right] : []), source: SOURCE,
      status: valid ? left.status : 'unavailable', marketDate: valid ? left.marketDate : null, proxy: true,
    };
  });
  const observations = [...quotes.values()];
  const complete = themeComparable && factors.every(row => row.status !== 'unavailable');
  return {
    status: complete ? 'available' : observations.length ? 'partial' : 'unavailable', loading: false,
    ...timing(observations),
    expiresAt: observations.length ? iso(Math.max(...observations.map(row => Date.parse(row.expiresAt)))) : null,
    source: SOURCE, proxy: true,
    themes: {
      software: quotes.get(catalog.themes.find(row => row.id === 'software').ticker) || null,
      semiconductors: quotes.get(catalog.themes.find(row => row.id === 'semiconductors').ticker) || null,
      leader: ranked[0] || null, laggard: ranked.at(-1) || null,
      ranked,
      coverage: { verified: themeRows.length, total: catalog.themes.length, comparable: themeComparable,
        expiresAt: timing(themeRows).expiresAt },
    },
    factors,
  };
}

function createMarketRotationService({
  fetchImpl = global.fetch, now = Date.now, concurrency = 6, refreshMs = 60_000,
  requestTimeoutMs = 6_000, overallTimeoutMs = 25_000,
  referenceFilePath = fetchImpl === global.fetch ? REFERENCE_FILE_PATH : null,
} = {}) {
  const width = Math.max(1, Math.min(8, Math.trunc(concurrency) || 6));
  let snapshot = null;
  if (referenceFilePath) {
    try {
      const stored = JSON.parse(fs.readFileSync(referenceFilePath, 'utf8'));
      if (stored.schemaVersion === 1) snapshot = restoreMarketRotationSnapshot(stored.snapshot, Number(now()));
    } catch { /* No verified reference has been stored yet. */ }
  }

  function persistSnapshot() {
    if (!snapshot || !referenceFilePath) return;
    try {
      fs.mkdirSync(path.dirname(referenceFilePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${referenceFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, snapshot }), { mode: 0o600 });
      fs.renameSync(temporaryPath, referenceFilePath);
    } catch { /* Retain the in-memory evidence if disk persistence fails. */ }
  }
  let completedAt = -Infinity;
  let inFlight = null;
  let activeAttempt = null;
  let disposed = false;

  async function request(ticker, attempt) {
    const url = chartUrl(ticker, '1mo', '1d');
    const controller = new AbortController();
    attempt.controllers.add(controller);
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Provider timeout')); }, requestTimeoutMs);
        }),
        (async () => {
          const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store',
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'Accept-Encoding': 'identity' } });
          if (!response?.ok || attempt.cancelled) return null;
          const payload = await response.json();
          if (attempt.cancelled) return null;
          // Include transport flags in the same integrity check as the payload.
          return parseDailyChart({ ...payload, _transport: response }, { ticker, nowMs: Number(now()), sourceUrl: url });
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      attempt.controllers.delete(controller);
    }
  }

  function cancel(attempt) {
    attempt.cancelled = true;
    for (const controller of attempt.controllers) controller.abort();
  }

  function refresh() {
    if (inFlight || disposed) return inFlight;
    const attempt = { cancelled: false, controllers: new Set() };
    activeAttempt = attempt;
    const next = new Map();
    let index = 0;
    let timer;
    const work = Promise.all(Array.from({ length: Math.min(width, DEFINITIONS.length) }, async () => {
      while (!attempt.cancelled && index < DEFINITIONS.length) {
        const { ticker } = DEFINITIONS[index++];
        try {
          const row = await request(ticker, attempt);
          if (row && !attempt.cancelled) next.set(ticker, row);
        } catch { /* A failed observation is absent; other ETFs remain independent. */ }
      }
    }));
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { cancel(attempt); resolve(); }, overallTimeoutMs);
    });
    inFlight = Promise.race([work, deadline]).catch(() => next.clear()).then(() => {
      if (!disposed && activeAttempt === attempt) {
        // Accept each fixed theme and complete comparison independently. Never
        // combine a newly fetched leg with retained evidence to invent a spread.
        completedAt = Number(now());
        snapshot = mergeMarketRotationSnapshots(snapshot, buildMarketRotationSnapshot({ dailyByTicker: next, nowMs: completedAt }), completedAt);
        persistSnapshot();
      }
    }).finally(() => {
      clearTimeout(timer);
      if (activeAttempt === attempt) { activeAttempt = null; inFlight = null; }
    });
    return inFlight;
  }

  async function getSnapshot() {
    if (disposed) return buildMarketRotationSnapshot({ nowMs: Number(now()) });
    const nowMs = Number(now());
    const expired = snapshot && nextMarketRotationExpiry(snapshot) <= nowMs;
    if (inFlight || nowMs - completedAt >= refreshMs || expired) await (inFlight || refresh());
    snapshot = ageMarketRotationSnapshot(snapshot, Number(now()));
    return snapshot || buildMarketRotationSnapshot({ nowMs: Number(now()) });
  }

  function dispose() {
    disposed = true;
    if (activeAttempt) cancel(activeAttempt);
    snapshot = null;
  }

  return { getSnapshot, dispose };
}

module.exports = { buildMarketRotationSnapshot, createMarketRotationService, MAX_COMPARISON_SKEW_MS, MAX_THEME_SKEW_MS };
