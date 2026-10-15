import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { todayInNewYork } from '../utils/morningTldr';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';

export const USD_INDEX_BIAS_REFRESH_MS = 5 * 60 * 1000;

const USD_INDEX_IDENTITIES = new Set([
  'USD', 'DXY', '$USD', 'DX-Y.NYB',
  'U.S. DOLLAR INDEX', 'US DOLLAR INDEX', 'DOLLAR INDEX', 'USD INDEX',
  'U.S. DOLLAR INDEX (USD)', 'U.S. DOLLAR INDEX (DXY)',
  'US DOLLAR INDEX (USD)', 'US DOLLAR INDEX (DXY)',
]);
const identity = (value) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').toUpperCase()
  : '';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// An ETF or another explicit symbol must never inherit the index's research
// merely because its display name mentions the dollar index.
export const isUsdIndexRow = (row) => {
  const fields = typeof row === 'string'
    ? [row]
    : [row?.ticker, row?.symbol, row?.name, row?.originalName];
  const identities = fields.map(identity).filter(Boolean);
  return identities.length > 0 && identities.every((value) => USD_INDEX_IDENTITIES.has(value));
};

const INVALID_FLAGS = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded',
  'cacheOnly', 'cache_only', 'stale', 'isStale', 'offline', 'disconnected',
];
const INVALID_STATUSES = new Set([
  'mock', 'seed', 'seeded', 'cache', 'cached', 'cache-only', 'cache_only', 'stale', 'offline',
  'disconnected', 'error', 'failed', 'unavailable', 'unverified',
]);
const hasInvalidEvidence = (record) => {
  if (!isRecord(record)) return false;
  return INVALID_FLAGS.some((flag) => record[flag] === true)
    || record.sourceVerified === false
    || record.verified === false
    || record.success === false
    || record.connected === false
    || ['status', 'sourceStatus', 'freshness', 'availability', 'cacheState', 'cacheStatus', 'source'].some((field) => (
      INVALID_STATUSES.has(String(record[field] || '').trim().toLowerCase())
    ));
};
const invalidMetadata = (record) => [record, record?.meta, record?.provenance]
  .some(hasInvalidEvidence);

const sourceUrlFor = (payload) => {
  try {
    const url = new URL(payload.article?.feedUrl);
    return url.protocol === 'https:'
      && url.hostname === 'app.hedgeye.com'
      && !url.username && !url.password && !url.port
      && /^\/feed_items\/\d+\/?$/.test(url.pathname)
      ? url.href : null;
  } catch {
    return null;
  }
};

export const normalizeUsdIndexBias = (payload, { date = todayInNewYork() } = {}) => {
  if (!isRecord(payload) || invalidMetadata(payload)
    || payload.source !== 'gmail-html' || payload.date !== date
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const reportTypes = [payload.snapshotType, payload.reportType].filter((value) => value != null);
  if (!reportTypes.length || reportTypes.some((value) => value !== 'early-look')) return null;

  const sourceUrl = sourceUrlFor(payload);
  const htmlPrefix = `hedgeye-email/messages/${date}/early-look/`;
  if (!sourceUrl || typeof payload.htmlSource !== 'string'
    || !payload.htmlSource.startsWith(htmlPrefix)
    || !/^[^/]+\.html$/.test(payload.htmlSource.slice(htmlPrefix.length))
    || !isRecord(payload.data) || invalidMetadata(payload.data)) return null;

  const matches = Object.entries(payload.data).filter(([key, row]) => (
    isRecord(row) && isUsdIndexRow({ ...row, ticker: key })
  ));
  if (matches.length !== 1) return null;

  const [, row] = matches[0];
  const trend = identity(row.trend);
  if (invalidMetadata(row) || !['BULLISH', 'BEARISH', 'NEUTRAL'].includes(trend)) return null;
  if (row.date != null && row.date !== date) return null;
  if (row.asOf != null && (typeof row.asOf !== 'string' || row.asOf.slice(0, 10) !== date)) return null;
  const lrr = typeof row.lrr === 'number' && Number.isFinite(row.lrr) && row.lrr > 0 ? row.lrr : null;
  const hrr = typeof row.hrr === 'number' && Number.isFinite(row.hrr) && row.hrr > 0 ? row.hrr : null;
  if (lrr === null || hrr === null || lrr > hrr) return null;

  // publishedAt can be an ingestion date marker at midnight, so this evidence
  // carries the source's report date without inventing a publication time.
  return { trend, date, lrr, hrr, sourceUrl, source: 'Early Look', verified: true };
};

export default function useUsdIndexBias() {
  const [state, setState] = useState({
    bias: null, status: 'loading', loading: true, error: null,
  });

  useEffect(() => {
    let disposed = false;
    let requestSequence = 0;
    const poll = async () => {
      const request = ++requestSequence;
      const date = todayInNewYork();
      setState((current) => {
        const bias = current.bias?.date === date ? current.bias : null;
        return { bias, status: bias ? 'available' : 'loading', loading: true, error: null };
      });
      try {
        const payload = await MarketDataService.getHedgeyeSnapshot('early-look', date);
        if (disposed || request !== requestSequence) return;
        const bias = date === todayInNewYork() ? normalizeUsdIndexBias(payload, { date }) : null;
        setState({ bias, status: bias ? 'available' : 'unavailable', loading: false, error: null });
      } catch (error) {
        if (disposed || request !== requestSequence) return;
        setState({ bias: null, status: 'unavailable', loading: false, error });
      }
    };
    const stop = startVisibilityAwarePolling({
      poll, intervalMs: USD_INDEX_BIAS_REFRESH_MS, pollOnStart: true,
    });
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  return state;
}
