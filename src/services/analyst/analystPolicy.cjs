const { createHash } = require('crypto');
const { isTradingDateKey } = require('../../utils/usEquityMarketCalendar.cjs');
const { evaluatePortfolioRule } = require('../../utils/portfolioReviewRules.js');
const { describeAnalystFinding, typedAnalystSignal: typedSignalEvent } = require('../../utils/analystFindingPresentation.cjs');
const { automatedSourceReadiness, sourceLibraryRows } = require('./analystSourceReadiness.cjs');
const REQUIRED_PRODUCTS = Object.freeze([
  ['risk-ranges', 'Risk Ranges'], ['early-look', 'Early Look'], ['bitcoin-trend-tracker', 'Bitcoin Tracker'],
  ['momo-tracker', 'MOMO'], ['signal-strength', 'Signal Strength'], ['portfolio-solutions', 'Portfolio Solutions'],
  ['etf-pro', 'ETF Pro'], ['top-3-things', 'Top 3 Things'], ['market-structure', 'Market Situation Report'],
]);
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const easternDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
// The user's own calendar day. It files dated Analyst conversations; market
// sessions, closes and publications keep their Eastern exchange dates.
const pacificDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
function easternMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  return Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
}
function marketCloseMinutes(date) {
  // NYSE early close: Friday after Thanksgiving, July 3 trading day, Christmas Eve.
  const d = new Date(`${date}T12:00:00Z`);
  const early = date.endsWith('-12-24') || date.endsWith('-07-03') || (d.getUTCMonth() === 10 && d.getUTCDay() === 5 && d.getUTCDate() >= 23 && d.getUTCDate() <= 29);
  return early ? 780 : 960;
}
function marketSession(now = new Date()) {
  const date = easternDate(now);
  if (!isTradingDateKey(date)) return 'closed';
  const minutes = easternMinutes(now);
  return minutes < 570 ? 'pre-market' : minutes < marketCloseMinutes(date) ? 'open' : 'closed';
}
function portfolioCaptureWindow(now = new Date()) {
  const date = easternDate(now);
  const marketDay = isTradingDateKey(date);
  const captureMinute = marketCloseMinutes(date) + 30;
  return { date, marketDay, due: marketDay && easternMinutes(now) >= captureMinute, captureMinute,
    scheduledTime: `${String(Math.floor(captureMinute / 60)).padStart(2, '0')}:${String(captureMinute % 60).padStart(2, '0')}`,
    timeZone: 'America/New_York' };
}
function dailyReadiness(evidence, now = new Date()) {
  const { products = [], indexed = [], errors = [] } = evidence;
  const date = easternDate(now);
  const marketDay = isTradingDateKey(date);
  const required = REQUIRED_PRODUCTS.map(([id, label]) => {
    const row = products.find(p => (p.product || p.id) === id);
    const local = indexed.filter(p => p.product === id && p.publication_date === date);
    const observed = Date.parse(row?.observedAt);
    const currentLocal = local.filter(p => !Number.isFinite(observed) || Date.parse(p.indexed_at) >= observed);
    const localReady = currentLocal.length > 0;
    const stages = ['received', 'parsed', 'validated', 'indexed'];
    const missingStages = stages.filter(stage => row?.stages?.[stage] !== true);
    const sameDate = (row?.latestPublicationDate || row?.publicationDate)?.slice(0, 10) === date;
    const ready = sameDate && !missingStages.length && localReady && row?.status !== 'failed';
    return { id, label, ready, missingStages, publicationDate: row?.latestPublicationDate || row?.publicationDate || null, reason: !sameDate ? 'Today’s publication has not arrived' : !localReady ? 'Local indexing of the current publication incomplete' : missingStages.length ? `Waiting for ${missingStages.join(', ')}` : row?.status === 'failed' ? 'Publication failed validation' : null, fingerprint: fingerprint([row?.evidenceHash, local.map(p => [p.document_id, p.content_hash]).sort()]) };
  });
  return { date, checkedAt: now.toISOString(), marketDay, marketSession: marketSession(now), ready: marketDay && !errors.length && required.every(p => p.ready), required, missing: required.filter(p => !p.ready), errors, fingerprint: fingerprint(required.map(p => p.fingerprint)), automatedSources: sourceLibraryRows(automatedSourceReadiness(evidence, now)) };
}
function setupCapacity({ market, nlv, nlvVerified, funding, fundingVerified, existingLoss, exposureVerified, unitLoss, fees = 0, proposed = Infinity }) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  if (!nlvVerified || !fundingVerified || !exposureVerified || !finite(nlv) || nlv <= 0 || !finite(funding) || funding < 0 || !finite(existingLoss) || existingLoss < 0 || !finite(unitLoss) || unitLoss <= 0 || !finite(fees) || fees < 0) return { allowed: false, contracts: null, reason: 'Verified NLV, setup exposure, funding, and native maximum loss are required.' };
  const cap = nlv * (market === 'cpi' ? 0.15 : 0.05);
  const remaining = Math.max(0, Math.min(cap - existingLoss, funding));
  const contracts = Math.max(0, Math.floor(Math.min(proposed, remaining / (unitLoss + fees))));
  return { allowed: contracts > 0, cap, existingLoss, remaining, contracts, proposedLoss: contracts * (unitLoss + fees), combinedLoss: existingLoss + contracts * (unitLoss + fees) };
}
function actionFor(event) {
  if (event.qualityStatus !== 'validated' || !['security', 'ticker', 'equity', 'etf'].includes(String(event.entityType).toLowerCase())) return null;
  const text = String(event.action || event.actionType || '').toLowerCase();
  if (['exit', 'sell', 'sell_all', 'liquidate'].includes(text)) return 'exit';
  if (['trim', 'reduce', 'sell_partial', 'sell-some'].includes(text)) return 'trim';
  if (['cover', 'cover_short', 'buy_to_cover'].includes(text)) return 'cover';
  if (text === 'remove' || event.eventType === 'roster_removal') return 'roster removal';
  if (typedSignalEvent(event)) return 'signal change';
  // Action extraction only within the typed action field of an exact validated entity reference.
  if (event.productKey === 'real-time-alert' && /action|alert/i.test(event.fieldPath || '')) {
    const excerpt = String(event.excerpt || '');
    if (/\b(?:trim|reduc(?:e|ing)|partial)\b/i.test(excerpt)) return 'trim';
    if (/\bcover(?:ing)?\b/i.test(excerpt)) return 'cover';
    if (/\b(?:sell(?:ing)?|exit(?:ing)?|close|closing)\b/i.test(excerpt)) return 'exit';
  }
  return null;
}
// Explicit share-class spelling aliases only; no commodity, index, or ETF proxies.
const SECURITY_ALIASES = { 'BRK-B': 'BRK.B', 'BRK B': 'BRK.B', 'BRK-A': 'BRK.A', 'BRK A': 'BRK.A', 'BF-B': 'BF.B', 'BF B': 'BF.B' };
const canonicalSecurity = value => SECURITY_ALIASES[String(value).toUpperCase()] || String(value).toUpperCase();
function unavailableHoldingsInput(value) {
  return value?.connected === false || ['stale', 'isStale', 'from_cache', 'fromCache', 'cacheOnly', 'mock', 'isMock', 'seed', 'seeded'].some(flag => value?.[flag] === true)
    || ['status', 'freshness', 'source', 'provider'].some(field => /^(?:offline|disconnected|error|failed|unavailable|stale|cache-only|mock|seed|seeded)$/i.test(String(value?.[field] || '')));
}
function currentHoldingFor(holdings, symbol, quantity, now) {
  const rows = (holdings.currentHoldings || []).filter(row => canonicalSecurity(row.holding) === canonicalSecurity(symbol));
  if (rows.length !== 1 || rows[0].quantity !== quantity || unavailableHoldingsInput(rows[0])) return null;
  const value = rows[0].currentHolding;
  const observedAt = Date.parse(value?.asOf);
  if (rows[0].heldSide !== (quantity < 0 ? 'SHORT' : 'LONG') || !value || unavailableHoldingsInput(value)
    || value.source !== 'ibkr' || value.basis !== 'absolute_market_value_over_net_liquidation'
    || typeof value.weightPct !== 'number' || !Number.isFinite(value.weightPct) || value.weightPct < 0
    || !Number.isFinite(observedAt) || observedAt > now.getTime() + 30000 || now.getTime() - observedAt > 60000) return null;
  return { ...value };
}
function evaluateFinding(event, holdings, previous, now = new Date()) {
  const action = actionFor(event);
  if (!action) return null;
  const signalEvent = typedSignalEvent(event);
  if (signalEvent) event = { ...event, signalValue: signalEvent.value, signalField: signalEvent.field };
  const symbol = String(event.entityId || '').toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,24}$/.test(symbol)) return null;
  let verified = holdings?.liveVerified === true && holdings?.complete === true && !unavailableHoldingsInput(holdings)
    && Array.isArray(holdings.positions) && Date.parse(holdings.asOf) <= now.getTime() + 30000 && now.getTime() - Date.parse(holdings.asOf) <= 60000;
  const positions = verified ? holdings.positions.filter(p => p.category !== 'event_contract' && canonicalSecurity(p.symbol) === canonicalSecurity(symbol)) : [];
  verified = verified && positions.every(p => !unavailableHoldingsInput(p) && (p.quantity ?? p.position) != null && (p.quantity ?? p.position) !== '' && Number.isFinite(Number(p.quantity ?? p.position)));
  const quantity = verified ? positions.reduce((sum, p) => sum + Number(p.quantity ?? p.position), 0) : null;
  if (verified && !quantity && !previous) return null;
  const initialQuantity = previous?.initialQuantity ?? quantity;
  let state = verified ? 'open' : 'pending verification';
  let rule = null;
  if (verified && previous) {
    if (action === 'exit' && quantity <= 0 && initialQuantity > 0 || action === 'cover' && quantity >= 0 && initialQuantity < 0) state = 'resolved';
    else if (action === 'trim' && Number.isFinite(event.targetQuantity) && Math.abs(quantity) <= Math.abs(event.targetQuantity)) state = 'resolved';
    else if (action === 'trim' && Math.abs(quantity) < Math.abs(initialQuantity)) state = 'partially addressed';
    else if (!quantity) state = 'resolved';
  }
  if (action === 'signal change' && verified && quantity) {
    const holding = holdings.ruleHoldings?.find(row => canonicalSecurity(row.holding) === canonicalSecurity(symbol) && row.heldSide === (quantity < 0 ? 'SHORT' : 'LONG'));
    const sourceTime = Date.parse(holding?.sources?.[signalEvent.field]?.publishedAt);
    if (holding?.[signalEvent.field] && holding[signalEvent.field] !== signalEvent.value && sourceTime > Date.parse(event.publishedAt)) {
      if (!previous) return null;
      state = 'resolved';
    } else if (holding?.[signalEvent.field] === signalEvent.value) {
      rule = evaluatePortfolioRule(holding, holdings.asOf);
      if (rule.status === 'aligned') { if (!previous) return null; state = 'resolved'; }
      else state = rule.status === 'conflict' ? 'open' : 'pending verification';
    } else state = 'pending verification';
  }
  const sourceId = event.sourceMessageId || event.sourceEventId || event.eventKey;
  const id = previous?.id || fingerprint([sourceId, symbol, event.fieldPath || event.eventType]);
  const finding = { id, sourceId, symbol, action, state, initialQuantity, quantity, event, publicationTime: event.publishedAt, holdingsVerifiedAt: verified ? holdings.asOf : previous?.holdingsVerifiedAt || null, marketSession: marketSession(now), citation: { id: `cite_${fingerprint(event).slice(0, 32)}`, title: event.productLabel, product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`, excerpt: event.excerpt } };
  finding.summary = `${symbol} · ${describeAnalystFinding(finding).headline}`;
  finding.rule = rule;
  finding.holdingsVerified = verified;
  finding.currentHolding = verified && quantity ? currentHoldingFor(holdings, symbol, quantity, now) : null;
  finding.signalField = signalEvent?.field || null;
  finding.fingerprint = fingerprint([action, event.signalValue, event.excerpt, event.contentSha256, state, rule?.weightPct, rule?.targetWeight]);
  return finding;
}
function costDecision({ projectedMonthly, monthToDate, complete }) {
  const safe = complete === true && Number.isFinite(projectedMonthly) && Number.isFinite(monthToDate) && projectedMonthly < 15 && monthToDate < 15;
  return { cadenceMinutes: safe ? 1 : 15, safe, threshold: 15, budget: 20, reason: safe ? 'Conservative incremental AWS projection is below $15/month.' : 'Cost evidence is incomplete or the $15 guard threshold was reached.' };
}
module.exports = { REQUIRED_PRODUCTS, dailyReadiness, marketSession, easternDate, pacificDate, portfolioCaptureWindow, setupCapacity, actionFor, evaluateFinding, costDecision, fingerprint };
