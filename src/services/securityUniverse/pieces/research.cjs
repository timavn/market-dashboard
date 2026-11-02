'use strict';

const EQUIVALENCE = require('../../../constants/instrumentEquivalence.json');
const { sameSignalInstrument } = require('../../../utils/publishedResearchSignals.cjs');
const { canonicalTradeResearch } = require('../../../utils/canonicalTradeResearch.cjs');
const { available, flagged, unavailable, withStatus } = require('../fields.cjs');

const SOURCE = 'Security intelligence';
// A published trade the archive has not re-read within this long may be missing.
const ARCHIVE_MAX_AGE_MS = 15 * 60_000;

function emptyResearch(reason) {
  return withStatus({ trade: unavailable(reason, { source: SOURCE }), trend: unavailable(reason, { source: SOURCE }),
    tail: unavailable('no-published-tail-source'), riskRange: unavailable(reason, { source: SOURCE }),
    signalStrength: unavailable(reason, { source: SOURCE }), signalStrengthShorts: unavailable(reason, { source: SOURCE }),
    statedTrend: unavailable(reason, { source: SOURCE }), alphaCode: unavailable(reason, { source: SOURCE }) });
}

// Trade as the Predictive Markets board and every other surface pick it
// (canonicalTradeResearch): the latest dated publication with explicit Trade
// evidence, kept until a later report states otherwise, with its source text.
function tradeField(response, symbol, decision) {
  if (decision?.status === 'conflict') return unavailable('conflicting-published-trade-signals', { source: SOURCE });
  const trade = canonicalTradeResearch(response, symbol, { date: response.marketDate });
  if (trade.status !== 'available') {
    return unavailable(decision?.reason || 'no-verified-published-trade-signal', { source: SOURCE });
  }
  return available(trade.direction, { source: trade.sourceLabel || trade.source, sourceId: trade.source, asOf: trade.sourceDate,
    publishedAt: trade.sourcePublishedAt, sourceTicker: trade.ticker, sourceUrl: trade.sourceUrl,
    sourceText: trade.signalProvenance?.sourceText || null, ...(trade.retainedPublication ? { retained: true } : {}) });
}

// The latest Trend or Alpha Code a publication states for this exact instrument
// (never a spot reference or an ETF's index). Two different statements on the
// latest date are a conflict.
function statedField(readings, symbol, field, missing) {
  const rows = (readings || []).filter(row => row && !flagged(row) && row.referenceOnly !== true
    && sameSignalInstrument(row.sourceTicker || row.ticker, symbol) && /^\d{4}-\d{2}-\d{2}$/.test(row.date || ''));
  if (!rows.length) return unavailable(missing, { source: 'Published research archive' });
  const latestDate = rows.map(row => row.date).sort().at(-1);
  // A midnight placeholder is a date, not a send time.
  const sent = row => (/T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(String(row.publishedAt || '')) ? NaN : Date.parse(row.publishedAt || ''));
  const dated = rows.filter(row => row.date === latestDate);
  const latestSent = dated.every(row => Number.isFinite(sent(row))) ? Math.max(...dated.map(sent)) : null;
  const latest = latestSent === null ? dated : dated.filter(row => sent(row) === latestSent);
  // The same levels printed in two styles (a code, a legend) are one reading.
  const value = row => (field === 'alphaCode' ? JSON.stringify([row.levels?.trade ?? null, row.levels?.trend ?? null, row.levels?.unit ?? null]) : row.value);
  if (new Set(latest.map(value)).size > 1) return unavailable(`conflicting-published-${field === 'alphaCode' ? 'alpha-codes' : 'trend-statements'}`, { source: 'Published research archive', asOf: latestDate });
  const row = latest[0];
  return available(field === 'alphaCode' ? row.levels : row.value, { source: row.sourceLabel || row.sourceProduct, sourceId: row.sourceProduct || null,
    asOf: row.date, publishedAt: row.publishedAt || null, sourceTicker: row.sourceTicker, sourceUrl: row.sourceUrl || null, sourceText: row.sourceText });
}

function descriptorField(descriptor, extra = {}) {
  if (!descriptor || flagged(descriptor)) return unavailable('research-reading-unverified', { source: SOURCE });
  const source = descriptor.sourceLabel || descriptor.sourceId || SOURCE;
  if (descriptor.status !== 'available') return unavailable(descriptor.reason || 'unavailable', { source, asOf: descriptor.sourceDate || null });
  return available(descriptor.value, { source, sourceId: descriptor.sourceId || null, asOf: descriptor.sourceDate || null,
    publishedAt: descriptor.publishedAt || null, ...extra });
}

// Which instrument a decision range was published for. A reading routed to this
// symbol through a research alias (SPX → SPY) is a proxy unless the catalog says
// both tickers measure the same instrument (BITCOIN ≡ BTC); so is a key the
// parser rewrote at ingest (GOLD filed as GLD). A range far from the security's
// own completed close (more than 2× either way) is a proxy whatever its key says.
function rangeInstrument(entry, descriptor, symbol, price = null) {
  if (descriptor?.status !== 'available') return {};
  const lrr = Number(descriptor.lrr ?? descriptor.value?.lrr);
  const hrr = Number(descriptor.hrr ?? descriptor.value?.hrr);
  const references = (Array.isArray(entry?.directReferences) ? entry.directReferences : []).filter(reference => reference
    && !flagged(reference) && reference.decisionEligible === true && reference.productId === descriptor.sourceId
    && reference.marketDate === descriptor.sourceDate && Number(reference.value?.lrr) === lrr && Number(reference.value?.hrr) === hrr);
  const keys = [...new Set(references.map(reference => String(reference.matchedText || '').trim().toUpperCase()).filter(Boolean))];
  if (keys.length !== 1) return { sourceInstrument: null, match: 'unverified' };
  const instrument = EQUIVALENCE.rewrittenAtIngest?.[descriptor.sourceId]?.[keys[0]] || keys[0];
  const same = instrument === symbol || (EQUIVALENCE.sameInstrument[symbol] || []).includes(instrument);
  const ratio = Number.isFinite(price) && price > 0 && lrr > 0 && hrr > 0 ? price / ((lrr + hrr) / 2) : null;
  const offScale = ratio !== null && (ratio < 0.5 || ratio > 2);
  return { sourceInstrument: instrument, match: same && !offScale ? 'direct' : 'proxy',
    scaleCheck: ratio === null ? 'not-checked' : offScale ? 'range-scale-differs-from-price' : 'consistent' };
}

// Trade, Trend, risk range and Signal Strength from the shared security research
// projection (AGENTS.md): the same decision descriptors every research surface reads.
function createResearchPiece({ loadSecurityIntelligence, loadReferencePrices = async () => new Map(), tradeArchiveStatus = () => null,
  loadPublishedStatements = async () => null, now = Date.now } = {}) {
  if (typeof loadSecurityIntelligence !== 'function') throw new Error('loadSecurityIntelligence is required');

  async function loadMany(symbols) {
    const [response, prices, statements] = await Promise.all([loadSecurityIntelligence({ symbols }),
      Promise.resolve().then(() => loadReferencePrices(symbols)).catch(() => new Map()),
      Promise.resolve().then(() => loadPublishedStatements()).catch(() => null)]);
    if (!response || flagged(response) || response.schemaVersion !== 2 || !response.bySymbol || typeof response.bySymbol !== 'object') {
      throw new Error('security-intelligence-unavailable');
    }
    const archive = tradeArchiveStatus?.();
    const archiveCurrent = Boolean(archive) && now() - Date.parse(archive.refreshedAt) <= ARCHIVE_MAX_AGE_MS;
    return new Map(symbols.map(symbol => {
      const entry = response.bySymbol[symbol];
      if (!entry || flagged(entry) || !entry.decision) return [symbol, emptyResearch('symbol-not-in-security-intelligence')];
      const { decision } = entry;
      const range = rangeInstrument(entry, decision.riskRange, symbol, prices?.get?.(symbol) ?? null);
      const sameRangeSource = decision.trend?.sourceId && decision.trend.sourceId === decision.riskRange?.sourceId
        && decision.trend.sourceDate === decision.riskRange?.sourceDate;
      let trade = tradeField(response, symbol, decision.trade);
      if (!archiveCurrent) {
        trade = { ...trade, status: trade.status === 'available' ? 'partial' : 'unavailable', reason: 'published-trade-archive-unavailable' };
      }
      const stated = (field, missing) => (statements && archiveCurrent
        ? statedField(statements[field === 'trend' ? 'trends' : 'alphaCodes'], symbol, field, missing)
        : unavailable('published-research-archive-unavailable', { source: 'Published research archive' }));
      const riskRange = descriptorField(decision.riskRange, range);
      return [symbol, withStatus({
        trade,
        trend: descriptorField(decision.trend, sameRangeSource ? range : {}),
        tail: unavailable('no-published-tail-source'),
        riskRange: riskRange.status === 'available'
          ? { ...riskRange, value: { lrr: decision.riskRange.lrr ?? riskRange.value?.lrr ?? null, hrr: decision.riskRange.hrr ?? riskRange.value?.hrr ?? null } }
          : riskRange,
        signalStrength: descriptorField(decision.signalStrength),
        signalStrengthShorts: descriptorField(decision.signalStrengthShorts),
        // What the prose states, beside the Risk Range Trend that sizes positions.
        statedTrend: stated('trend', 'no-stated-trend'),
        alphaCode: stated('alphaCode', 'no-published-alpha-code'),
      })];
    }));
  }

  return { loadMany, empty: emptyResearch };
}

module.exports = { createResearchPiece, emptyResearch, rangeInstrument };
