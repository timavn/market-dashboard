const { createHash } = require('node:crypto');
const { evaluatePortfolioRule } = require('../../utils/portfolioReviewRules.js');
const { sourceActionEvidence, describeAnalystFinding } = require('../../utils/analystFindingPresentation.cjs');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const symbolOf = value => ({ 'BRK-B': 'BRK.B', 'BRK B': 'BRK.B', 'BF-B': 'BF.B' }[String(value).toUpperCase()] || String(value || '').toUpperCase());
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const time = value => Date.parse(value);
const invalid = value => !value || value.connected === false || ['stale', 'isStale', 'cacheOnly', 'cachedOnly', 'cached', 'fromCache', 'from_cache', 'mock', 'isMock', 'seed', 'seeded', 'fixture', 'synthetic', 'inferred', 'fallback', 'refreshFailed'].some(flag => value[flag] === true)
  || ['status', 'freshness', 'source', 'provider'].some(key => /^(?:unavailable|unverified|offline|disconnected|error|failed|stale|cache[-_ ]?only|cached|mock|seed(?:ed)?|fixture|synthetic|inferred|fallback)$/i.test(String(value[key] || '')))
  || ['metadata', 'provenance'].some(key => value[key] && typeof value[key] === 'object' && invalid(value[key]));
const dated = (value, now) => Number.isFinite(time(value)) && time(value) <= now.getTime();
const linked = citation => citation && (citation.id || citation.sourceUri || citation.sourceUrl || citation.url);
const row = (label, value) => ({ label, text: value });
function freshBook(book, now) {
  return book?.liveVerified === true && book.complete === true && !invalid(book)
    && (!book.freshness || book.freshness === 'live')
    && Number.isFinite(time(book.asOf)) && now.getTime() - time(book.asOf) <= 60000 && time(book.asOf) <= now.getTime() + 30000
    && Array.isArray(book.positions) && book.positions.every(position => !invalid(position) && number(position.quantity) !== null && symbolOf(position.symbol));
}
function holdingState(book, symbol, verified, now) {
  if (!verified) return { holdingsVerified: false, quantity: null, currentHolding: null };
  const quantity = book.positions.filter(position => position.category !== 'event_contract' && symbolOf(position.symbol) === symbol).reduce((sum, position) => sum + position.quantity, 0);
  const matches = (book.currentHoldings || []).filter(position => symbolOf(position.holding) === symbol && position.quantity === quantity);
  const weight = matches.length === 1 ? matches[0].currentHolding : null;
  const currentHolding = weight && !invalid(weight) && weight.source === 'ibkr' && weight.basis === 'absolute_market_value_over_net_liquidation'
    && number(weight.weightPct) !== null && weight.weightPct >= 0 && dated(weight.asOf, new Date(now.getTime() + 30000))
    && now.getTime() - time(weight.asOf) <= 60000 ? weight : null;
  return { holdingsVerified: true, holdingsVerifiedAt: book.asOf, quantity, currentHolding };
}
function positionRows(state) {
  if (!state.holdingsVerified) return [];
  return [row('Current position', state.quantity > 0 ? 'Long' : state.quantity < 0 ? 'Short' : 'Not held'),
    ...(state.currentHolding ? [row('Position size', `${state.currentHolding.weightPct.toFixed(2)}%`)] : [])];
}
// A source instruction that opposes a held position needs an immediate decision.
// It is shown apart from ordinary findings and is never cleared by reading it.
const ACTION_REQUIRED = 'action-required';
function finding({ key, material, symbol, kind, action, publishedAt, rows, sourceLinks, state = {}, priority = 1, severity = null }) {
  const id = `attention:${kind}:${hash(key).slice(0, 28)}`;
  // Escalation is a material change, so an already-read finding becomes unread.
  return { attentionVersion: 1, id, sourceId: id, symbol, action, state: 'open', kind, priority, ...(severity ? { severity } : {}),
    publicationTime: new Date(publishedAt).toISOString(), fingerprint: hash(severity ? [material, severity] : material), ...state,
    presentation: { subject: symbol, date: String(publishedAt).slice(0, 10), rows,
      sourceLinks: sourceLinks.filter(link => linked(link.citation)).filter((link, i, all) => all.findIndex(other => (other.citation.id || other.citation.sourceUri) === (link.citation.id || link.citation.sourceUri)) === i) } };
}
function signalEvidence(holding, field, now) {
  const source = holding.sources?.[field];
  return ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(holding[field]) && source && !invalid(source) && dated(source.publishedAt, now) && linked(source.citation)
    && holding.signalContext?.[field]?.status !== 'indication' && holding.signalContext?.[field]?.status !== 'conflict';
}
function portfolioFindings(context, now, verified) {
  if (!verified) return [];
  const book = context.holdings;
  const output = [];
  for (const candidate of book.ruleHoldings || []) {
    const symbol = symbolOf(candidate.holding);
    const state = holdingState(book, symbol, true, now);
    if (!state.quantity || (state.quantity > 0 ? 'LONG' : 'SHORT') !== candidate.heldSide || invalid(candidate)) continue;
    const holding = { ...candidate, weightPct: state.currentHolding?.weightPct ?? null };
    for (const field of ['trade', 'trend']) if (!signalEvidence(candidate, field, now)) holding[field] = null;
    const rule = evaluatePortfolioRule(holding, book.asOf);
    if (rule.status !== 'conflict') continue;
    const field = rule.rule === 'TRADE_BREAK' ? 'trade' : 'trend';
    let publishedAt = candidate.sources?.[field]?.publishedAt;
    const sources = ['trade', 'trend'].filter(key => signalEvidence(candidate, key, now)).map(key => ({ label: `${key === 'trade' ? 'Trade' : 'Trend'} source`, citation: candidate.sources[key].citation }));
    if (['RISK_CAP', 'ABOVE_MAX'].includes(rule.rule)) {
      const metrics = Object.entries(candidate.sizingInputs || {}).filter(([, value]) => value && !invalid(value) && dated(value.asOf, now) && value.source && number(value.value) !== null);
      publishedAt = metrics.map(([, value]) => value.asOf).sort().at(-1);
      for (const [metric, value] of metrics) sources.push({ label: `${metric} evidence`, citation: { id: `cite_${hash([symbol, metric, value.source, value.asOf]).slice(0, 28)}`,
        title: `${symbol} ${metric}`, product: 'process-sizing', publicationDate: String(value.asOf).slice(0, 10), sourceUri: `/api/security-risk-metrics?symbols=${encodeURIComponent(symbol)}&sizingOnly=1`, excerpt: `${metric}: ${value.value}. Source: ${value.source}. Observed: ${value.asOf}.` } });
    }
    if (!sources.length || !publishedAt) continue;
    const side = candidate.heldSide === 'LONG' ? 'Long' : 'Short';
    let explanation;
    if (rule.rule === 'TRADE_BREAK') explanation = `Published Trade is ${rule.trade[0]}${rule.trade.slice(1).toLowerCase()}, opposing the ${side} holding. The process gives Trade priority and calls for an exit.`;
    else if (rule.rule === 'TREND_BREAK') explanation = `Published Trend no longer supports the ${side} holding, which remains above the process MIN. Review the reduction to MIN.`;
    else if (rule.rule === 'RISK_CAP') explanation = 'The verified ATR risk cap is below the process MIN, so the existing process calls for an exit. This is a risk-cap breach.';
    else explanation = 'The verified position exceeds the process MAX after the existing beta and ATR limits. Review the excess exposure.';
    const rows = [...positionRows(state), row('Action', rule.action === 'EXIT' ? `Exit the ${side} position under the process` : 'Reduce position size under the process'), row('Context', explanation)];
    for (const key of ['trade', 'trend']) if (holding[key]) rows.push(row(key === 'trade' ? 'Trade' : 'Trend', holding[key][0] + holding[key].slice(1).toLowerCase()));
    // A published Trade or Trend against the held side contradicts the position.
    // Risk-cap and MAX breaches are sizing reviews, not a contrary source.
    const severity = ['TRADE_BREAK', 'TREND_BREAK'].includes(rule.rule) ? ACTION_REQUIRED : null;
    output.push(finding({ key: [symbol, candidate.heldSide, 'portfolio-rule'], material: [symbol, candidate.heldSide, rule.rule, rule.action, rule.trade, rule.trend],
      symbol, kind: 'portfolio', priority: 0, severity, action: rule.action.toLowerCase(), publishedAt, rows, sourceLinks: sources, state: { ...state, rule: { rule: rule.rule, action: rule.action, status: rule.status } } }));
  }
  return output;
}
const ACTIONS = { SELL: ['Long', 'Sell'], 'SELL-SOME': ['Long', 'Sell some'], 'SELL-PARTIAL': ['Long', 'Sell some'], TRIM: ['Long', 'Sell some'], REDUCE: ['Long', 'Reduce'], EXIT: ['Long', 'Exit'], 'SELL-ALL': ['Long', 'Sell all'], COVER: ['Short', 'Cover'], 'COVER-SOME': ['Short', 'Cover some'], 'COVER-SHORT': ['Short', 'Cover'], 'BUY-TO-COVER': ['Short', 'Cover'] };
const SIDES = { LONG: 'Long', SHORT: 'Short' };
// New positions name the side they establish; a typed ADD carries its own side.
const OPENS = { ADD: null, BUY: 'Long', 'BUY-SOME': 'Long', 'INITIATE-LONG': 'Long', SHORT: 'Short', 'SHORT-SELL': 'Short', 'SELL-SHORT': 'Short', 'INITIATE-SHORT': 'Short', 'ADD-SHORT': 'Short' };
// Roster removals and side-typed position changes are complete instructions, so
// unlike a generic Sell headline they need no report prose to establish scope.
function typedChange(event, evidence) {
  if (event.eventType === 'signal_strength_removed') return { action: 'REMOVE', side: 'Long' }; // Signal Strength lists bullish signals only.
  let source = {};
  try {
    const parsed = JSON.parse(event.excerpt);
    if (parsed && !Array.isArray(parsed) && symbolOf(parsed.ticker || parsed.symbol) === symbolOf(event.entityId)) source = parsed;
  } catch { /* A headline excerpt carries no typed side. */ }
  const side = SIDES[String(event.positionSide || source.side || source.positionSide || '').trim().toUpperCase()] || null;
  if (['REMOVE', 'ROSTER-REMOVAL'].includes(evidence.action)) return { action: 'REMOVE', side };
  if (!Object.hasOwn(OPENS, evidence.action)) return null;
  const opened = OPENS[evidence.action] || side;
  return opened ? { action: 'OPEN', side: opened } : null;
}
// A removal without a stated side still applies to whichever side is held:
// a missed exit costs more than a removal reviewed and kept.
const contradicts = (change, held) => change.action === 'REMOVE' ? !change.side || change.side === held : change.side !== held;
function sourceInstruction(event, now) {
  if (event.qualityStatus !== 'validated' || invalid(event) || !dated(event.publishedAt, now)
    || !event.sourceMessageId || !['security', 'ticker', 'equity', 'etf'].includes(String(event.entityType).toLowerCase())) return null;
  const evidence = sourceActionEvidence(event);
  const exit = ACTIONS[evidence.action] || null;
  const change = exit ? null : typedChange(event, evidence);
  if (!exit && !change) return null;
  const actionKey = exit ? evidence.action : change.action === 'REMOVE' ? 'REMOVE' : `OPEN-${change.side.toUpperCase()}`;
  return { symbol: symbolOf(event.entityId), event, evidence, exit, change, actionKey };
}
function publishedRange(event) {
  const value = event.riskRange || (event.value && typeof event.value === 'object' ? event.value : {});
  const low = Number(value.lrr ?? value.riskRangeLow);
  const high = Number(value.hrr ?? value.riskRangeHigh);
  return Number.isFinite(low) && Number.isFinite(high) && low > 0 && low < high ? `${low}–${high}` : null;
}
function sourceActionFindings(context, now, verified, conflicts, sentenceMemo) {
  if (!verified) return [];
  // The latest instruction per security and product decides; a later re-add
  // from the same product supersedes its earlier removal.
  const latest = new Map();
  for (const event of context.events || []) {
    const instruction = sourceInstruction(event, now);
    // A generic alert headline cannot establish full versus partial action.
    // Require its exact report body/subject or an explicit partial typed action.
    if (!instruction || (instruction.exit && !instruction.evidence.report)) continue;
    const { symbol, actionKey } = instruction;
    const conditionId = `attention:portfolio:${hash([symbol, 'source-action', event.productKey, actionKey]).slice(0, 28)}`;
    const existing = (context.previousAttention || []).find(item => item.id === conditionId && !['resolved', 'superseded'].includes(item.state));
    if (String(event.marketDate || event.publishedAt).slice(0, 10) !== context.marketDate && !existing) continue;
    const slot = `${symbol}\u0000${event.productKey}`;
    const previous = latest.get(slot);
    if (!previous || time(previous.event.publishedAt) < time(event.publishedAt)) latest.set(slot, instruction);
  }
  const output = [];
  for (const { symbol, event, evidence, exit, change, actionKey } of latest.values()) {
    if (conflicts.some(item => item.symbol === symbol)) continue;
    const state = holdingState(context.holdings, symbol, true, now);
    if (!state.quantity) continue;
    const held = state.quantity > 0 ? 'Long' : 'Short';
    if (exit ? exit[0] !== held : !contradicts(change, held)) continue;
    const partial = exit && /some|Reduce/.test(exit[1]);
    const directive = evidence.instruction || '';
    const contextLines = describeAnalystFinding({ event, ...state }, [], now.getTime(), sentenceMemo).sourceContext || [];
    if (exit && !contextLines.length) continue;
    if (partial && number(event.targetQuantity) !== null && Math.abs(state.quantity) <= Math.abs(event.targetQuantity)) continue;
    const product = event.productLabel || 'The source';
    const actionText = exit ? `${exit[1]} — review the ${exit[0]} position`
      : change.action === 'REMOVE' ? `${product} removed ${symbol}${change.side ? ` from its ${change.side} list` : ' (side not stated)'} — exit the ${held} position`
        : `${product} is now ${change.side} — opposes the ${held} position`;
    const range = publishedRange(event);
    const headline = text(event.excerpt).startsWith('{') ? '' : text(event.excerpt);
    const rows = [...positionRows(state), row('Action', actionText)];
    if (range) rows.push(row('Published range', range));
    if (contextLines.length || headline) rows.push(row('Context', contextLines.length ? contextLines.join(' ') : headline));
    const citation = { id: evidence.report?.citationId || `cite_${hash(event.sourceMessageId).slice(0, 24)}`, title: evidence.report?.title || event.productLabel,
      product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`,
      excerpt: directive || evidence.report?.bodyText || event.excerpt };
    output.push(finding({ key: [symbol, 'source-action', event.productKey, actionKey],
      material: exit ? [evidence.action, text(directive), contextLines] : [actionKey, change.side, range, headline],
      symbol, kind: 'portfolio', priority: 0, severity: ACTION_REQUIRED, action: exit ? evidence.action.toLowerCase() : change.action === 'REMOVE' ? 'remove' : 'opposing position',
      publishedAt: event.publishedAt, rows, sourceLinks: [{ label: event.productLabel || 'Source', citation }], state: { ...state, event } }));
  }
  return output;
}
// Without verified holdings, today's exits and removals cannot be matched to the
// book. Surface them as one urgent check instead of silently waiting.
function unverifiedInstructionFindings(context, now, verified) {
  if (verified || !context.marketDate) return [];
  const pending = new Map();
  for (const event of context.events || []) {
    const instruction = sourceInstruction(event, now);
    if (!instruction || instruction.change?.action === 'OPEN'
      || String(event.marketDate || event.publishedAt).slice(0, 10) !== context.marketDate) continue;
    if (!pending.has(instruction.symbol)) pending.set(instruction.symbol, instruction);
  }
  if (!pending.size) return [];
  const symbols = [...pending.keys()].sort();
  const events = [...pending.values()].map(item => item.event);
  const publishedAt = events.map(event => event.publishedAt).sort((a, b) => time(a) - time(b)).at(-1);
  const sourceLinks = events.map(event => ({ label: event.productLabel || 'Source', citation: { id: `cite_${hash(event.sourceMessageId).slice(0, 24)}`, title: event.productLabel,
    product: event.productKey, publicationDate: event.marketDate, sourceUri: event.sourceUrl || `gmail://message/${event.sourceMessageId}`, excerpt: event.excerpt } }));
  return [finding({ key: ['unverified-instructions', context.marketDate], material: symbols, symbol: 'Holdings check', kind: 'operational', priority: 0, severity: ACTION_REQUIRED,
    action: 'verify holdings', publishedAt, sourceLinks, state: { assessmentChannel: 'research' },
    rows: [row('Action', `Confirm whether you hold ${symbols.join(', ')}`),
      row('Context', `Exit or removal instructions were published today for ${symbols.join(', ')} while current holdings could not be verified.`)] })];
}
const DIRECT = new Set(['direct', 'direct_alias']);
const validReference = (reference, now) => reference && !invalid(reference) && reference.qualityStatus === 'indexed' && DIRECT.has(reference.matchType) && dated(reference.publishedAt || reference.marketDate, now) && reference.sourceUrl;
function citationFor(reference) {
  return { id: `cite_${hash([reference.productId, reference.sourceUrl, reference.marketDate, reference.excerpt]).slice(0, 32)}`,
    title: reference.productLabel || reference.productId, product: reference.productId, publicationDate: reference.marketDate, sourceUri: reference.sourceUrl, excerpt: reference.excerpt };
}
function direction(reference) {
  if (!['position_change', 'position_mention', 'position_reference', 'etf_pro_change', 'investing_idea_position', 'real_time_alert'].includes(reference.kind)) return null;
  let value = reference.value;
  try { value = JSON.parse(reference.excerpt); } catch { /* Structured value may already be present. */ }
  const raw = String((value && typeof value === 'object' ? value.side || value.call || value.action : value) || reference.direction || '').toUpperCase();
  if (['LONG', 'BUY', 'ADD', 'BUY-SOME', 'INITIATE-LONG'].includes(raw)) return 'Long';
  if (['SHORT', 'SHORT-SELL', 'SELL-SHORT', 'INITIATE-SHORT', 'ADD-SHORT'].includes(raw)) return 'Short';
  return null;
}
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function sentences(value, sentenceMemo) {
  if (typeof value !== 'string' || value.trim().startsWith('{') || value.trim().startsWith('[')) return [];
  if (sentenceMemo.has(value)) return sentenceMemo.get(value);
  const result = value.split(/\r?\n+/).flatMap(line => [...segmenter.segment(line)].map(part => text(part.segment).replace(/^[•*-]\s*/, '')))
    .filter(line => line.length >= 35 && line.length <= 620 && !/[{}]|\\[nrtu"]|"\s*[:,\]]|https?:\/\/|\b(?:copyright|subscribe|unsubscribe|disclaimer)\b/i.test(line));
  sentenceMemo.set(value, result);
  return result;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (value, symbol) => new RegExp(`(^|[^A-Za-z0-9])${escape(symbol)}(?=$|[^A-Za-z0-9])`, 'i').test(value);
const timely = value => /\b(?:new(?:ly)?|initiat\w*|add(?:ed|ing)?|accelerat\w*|decelerat\w*|deteriorat\w*|improv\w*|turn(?:ed|ing)|flip(?:ped)?|break(?:ing|out)?|broke|catalyst|earnings|inflect\w*|shift\w*|transition\w*|revers\w*|tighten\w*|narrow\w*|rebound\w*|raising|lowering)\b/i.test(value);
const thesis = value => /\b(?:because|due to|driven by|while|despite|given|reflect|benefit|pressure|demand|supply|growth|inflation|earnings|cash flow|valuation|momentum|liquidity|yields?|rates?|dollar|quad[1-4]?|beta|volatility|gamma|WTI|backwardated)\b/i.test(value);
function securityPassage(value, symbol) {
  const forward = new RegExp(`(^|[^A-Za-z0-9])(${escape(symbol)}\\s*\\([^)]{2,70}\\))`).exec(value);
  if (forward) {
    const start = forward.index + forward[1].length;
    const next = /,?\s+and\s+[A-Z][A-Z0-9]{1,5}\s*\([^)]{2,70}\)/.exec(value.slice(start + forward[2].length));
    return next ? value.slice(start, start + forward[2].length + next.index).trim().replace(/,$/, '') : value.slice(start);
  }
  // A roster is insufficient even when its surrounding macro paragraph is
  // substantive. Require a direct subject or named-security sentence.
  return new RegExp(`^(?:\\([^)]*\\)\\s*)?(?:${escape(symbol)}\\b|.{0,90}\\(${escape(symbol)}\\))`).test(value)
    ? value.split(/\balongside\b/i)[0].trim().replace(/[ ,]+$/, '') : null;
}
function passages(context, reference, symbol, sentenceMemo) {
  const result = [];
  const product = (context.documents?.products || []).find(item => item.product === reference.productId && item.publicationDate === reference.marketDate);
  for (const fragment of product?.excerpts || []) {
    const citation = fragment.citation;
    if (!linked(citation)) continue;
    // The reference URL must be visible in the exact document or be its URI.
    // Product/date alone cannot identify one of several same-day editions.
    const doc = product.documents?.find(item => item.documentId === citation.documentId);
    const sameDocument = citation.sourceUri === reference.sourceUrl || doc?.sourceUri === reference.sourceUrl
      || (product.excerpts || []).some(other => other.citation?.documentId === citation.documentId && String(other.excerpt).includes(reference.sourceUrl));
    if (!sameDocument) continue;
    for (const line of sentences(fragment.excerpt, sentenceMemo)) if (mentions(line, symbol)) result.push({ text: line, citation });
  }
  // Direct indexed references are exact evidence too, but truncated fragments
  // cannot become a manufactured complete thesis sentence.
  for (const line of sentences(reference.excerpt, sentenceMemo)) if (mentions(line, symbol) && !line.includes('…')) result.push({ text: line, citation: citationFor(reference) });
  return result;
}
function thesisWatch(value, side) {
  const checks = [
    [/\b(?:bond[- ]market volatility|rate[- ]volatility)\b/i, 'Whether the cited rise in bond-market volatility persists; a reversal would weaken the volatility case.'],
    [/\b(?:oil-cost|airlines)\b/i, 'Whether oil-cost pressure on airlines eases; that would challenge the cited Short case.'],
    [/\b(?:deteriorating local Quad|cyclicals)\b/i, 'Whether the cited local Quad deterioration and weaker cyclical leadership reverse.'],
    [/\b(?:Financials and Discretionary)\b/i, 'Whether Financials and Discretionary recover leadership; that would challenge the cited cyclical Short case.'],
    [/\b(?:higher rates|tightening subsidy)\b/i, 'Whether the cited rate or subsidy pressure eases; that would weaken the Short case.'],
    [/\b(?:earnings|demand)\b/i, `Whether the next earnings or demand update confirms the cited ${side} thesis.`],
    [/\b(?:long.duration|momentum (?:breaks|unwind))\b/i, 'Whether momentum recovers or the cited rate pressure eases; either would challenge the Short case.'],
    [/\b(?:WTI|energy|oil)\b/i, 'Whether the cited oil/energy setup holds in the next published Trade and Trend readings.'],
  ];
  return checks.find(([pattern]) => pattern.test(value))?.[1] || null;
}
function opportunityFindings(context, now, verified, conflicts, sentenceMemo) {
  const output = [];
  for (const [rawSymbol, security] of Object.entries(context.research?.bySymbol || {})) {
    const symbol = symbolOf(rawSymbol);
    if (!/^[A-Z0-9.\-^]{1,24}$/.test(symbol) || conflicts.some(item => item.symbol === symbol)) continue;
    const state = holdingState(context.holdings || {}, symbol, verified, now);
    const references = (security.directReferences || []).filter(reference => validReference(reference, now) && reference.marketDate === context.marketDate);
    const candidates = [];
    for (const reference of references) {
      const side = direction(reference);
      if (!side) continue;
      const peers = references.filter(peer => peer.productId === reference.productId && peer.sourceUrl === reference.sourceUrl);
      const caseRows = peers.flatMap(peer => passages(context, peer, symbol, sentenceMemo)).map(passage => ({ ...passage, text: securityPassage(passage.text, symbol) }))
        .filter(passage => passage.text && timely(passage.text) && thesis(passage.text));
      if (!caseRows.length) continue;
      // A source that describes a reduction or exit is not an add/new idea.
      const selected = caseRows.find(passage => !/\b(?:exit(?:ed|ing)?|sell(?:ing)?[ -]some|cover(?:ed|ing)?|reduc(?:ed|ing)|below minimum)\b/i.test(passage.text));
      if (selected) candidates.push({ reference, side, selected });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => time(b.reference.publishedAt) - time(a.reference.publishedAt));
    const candidate = candidates[0];
    if (candidates.some(other => time(other.reference.publishedAt) === time(candidate.reference.publishedAt) && other.side !== candidate.side)) continue;
    const { reference, side, selected } = candidate;
    // An aligned source roster is confirmation, not a reason to revisit an
    // existing holding. Require an explicit new allocation/add catalyst there.
    if (state.quantity && (state.quantity > 0 ? 'Long' : 'Short') === side
      && !/\b(?:new (?:allocation|asset allocation)|initiat\w*|start(?:ed|ing) (?:buying|shorting)|adding|buying)\b/i.test(selected.text)) continue;
    const watchText = thesisWatch(selected.text, side);
    if (!watchText) continue;
    // Held ideas need a specific constructive catalyst too; opposite-side
    // proposals are reviewed as research, never silently converted to exits.
    const label = state.holdingsVerified && state.quantity ? `Review the ${side} research case` : `Consider a ${side} research idea`;
    const rows = [...positionRows(state), row('Action', label), row('Context', selected.text)];
    const sources = [{ label: reference.productLabel || 'Research source', citation: selected.citation }];
    const contrary = [];
    for (const field of ['trade', 'trend']) {
      const descriptor = security.decision?.[field];
      if (descriptor?.status !== 'available' || !['BULLISH', 'BEARISH', 'NEUTRAL'].includes(descriptor.value) || invalid(descriptor)) continue;
      const source = references.find(peer => peer.productId === descriptor.sourceId && (field === 'trade' ? ['trade_signal', 'tracker_trade'].includes(peer.kind) : ['primary_risk_range', 'trend_signal'].includes(peer.kind)));
      if (!source) continue;
      rows.push(row(field === 'trade' ? 'Trade' : 'Trend', descriptor.value[0] + descriptor.value.slice(1).toLowerCase()));
      sources.push({ label: `${field === 'trade' ? 'Trade' : 'Trend'} source`, citation: citationFor(source) });
      if (descriptor.value !== (side === 'Long' ? 'BULLISH' : 'BEARISH')) contrary.push(`${field === 'trade' ? 'Trade' : 'Trend'} is ${descriptor.value[0]}${descriptor.value.slice(1).toLowerCase()}`);
    }
    const counter = references.filter(peer => direction(peer) && direction(peer) !== side).flatMap(peer => passages(context, peer, symbol, sentenceMemo)).find(passage => thesis(passage.text));
    if (counter) { rows.push(row('Counterpoint', counter.text)); sources.push({ label: 'Counterpoint source', citation: counter.citation }); }
    else if (contrary.length) rows.push(row('Counterpoint', `${contrary.join('; ')}. The research case has not established an aligned process setup.`));
    rows.push(row('Watch', watchText));
    if (verified && !state.quantity) rows.push({ ...row('Portfolio fit', 'This security is not held in the verified book; compare overlapping exposure before considering a position.'), requiresFreshHoldings: true });
    output.push(finding({ key: [symbol, 'research-idea', side, reference.productId], material: [side, text(selected.text), contrary, counter?.text || null], symbol, kind: 'opportunity', action: `${side.toLowerCase()} research idea`,
      publishedAt: reference.publishedAt || reference.marketDate, rows, sourceLinks: sources, state: { ...state, researchOnly: true } }));
  }
  return output;
}
function accountFindings(context, now) {
  const account = context.account || {};
  const fresh = account.verified === true && !invalid(account) && dated(account.asOf, new Date(now.getTime() + 30000)) && now.getTime() - time(account.asOf) <= 60000;
  const output = [];
  for (const issue of account.issues || []) {
    if (typeof issue !== 'string') continue;
    const history = issue.match(/^Interest discrepancy \((\d{4}-\d{2}-\d{2})\):/);
    if (history ? account.historyVerified !== true || !dated(history[1], now) : !fresh) continue;
    const type = history ? 'Interest reconciliation' : issue.startsWith('Maintenance margin deficit') ? 'Maintenance margin'
      : issue.startsWith('Initial margin deficit') ? 'Initial margin' : issue.startsWith('Cash-floor shortfall') ? 'Cash funding'
        : issue.startsWith('Policy buffer shortfall') ? 'Policy buffer' : null;
    if (!type) continue;
    const publishedAt = history ? history[1] : account.asOf;
    const citation = { id: `cite_${hash(['account', type, history?.[1] || 'current']).slice(0, 28)}`, title: 'Verified Balance Review evidence', product: 'portfolio-balance', publicationDate: String(publishedAt).slice(0, 10), sourceUri: '/api/portfolio/balance', excerpt: issue };
    output.push(finding({ key: ['account', type, history?.[1]], material: [type, history ? issue : type], symbol: type, kind: 'account', priority: 0, action: 'review account issue', publishedAt,
      rows: [row('Action', history ? 'Reconcile the verified interest discrepancy' : 'Review the funding or margin shortfall'), row('Context', issue)],
      sourceLinks: [{ label: 'Balance evidence', citation }], state: history ? { researchOnly: true } : { requiresFreshBalance: true, balanceVerified: true, balanceVerifiedAt: account.asOf } }));
  }
  return { findings: output, complete: fresh && account.historyVerified === true };
}
const MARKET_TOPICS = [
  ['Yield curve', /\b(?:yield curve|2s10s|2s\/10s|curve inversion|uninversion)\b/i],
  ['Market structure', /\bgamma\b/i], ['Dollar', /\b(?:U\.?S\.? dollar|dollar index|DXY)\b/i],
  ['Macro regime', /\bquad\s*[1-4]\b/i], ['Liquidity', /\bliquidity\b/i],
];
function marketFindings(context, now, sentenceMemo) {
  const found = new Map();
  for (const product of context.documents?.products || []) {
    if (product.publicationDate !== context.marketDate || !dated(product.publicationDate, now)) continue;
    for (const fragment of product.excerpts || []) {
      if (!linked(fragment.citation)) continue;
      for (const sentence of sentences(fragment.excerpt, sentenceMemo)) {
        if (!timely(sentence) || !thesis(sentence) || sentence.includes('…') || /\b(?:yesterday|last (?:week|month|year)|in 20\d\d|was|had been)\b/i.test(sentence)) continue;
        const topic = MARKET_TOPICS.find(([, pattern]) => pattern.test(sentence));
        if (!topic || found.has(topic[0])) continue;
        if (topic[0] === 'Macro regime' && !/\b(?:shift|transition|expect|forecast|nowcast|moving|more likely)\b/i.test(sentence)) continue;
        const watch = sentence.match(/\b(?:watch|if|unless|until)\b.*$/i)?.[0];
        // Need an explicit decision implication, not just a new numerical reading.
        if (!watch && !/\b(?:risk|support|pressure|headwind|tailwind|squeeze|position|exposure|volatility|caution)\b/i.test(sentence)) continue;
        found.set(topic[0], finding({ key: [topic[0], 'published-market-watch'], material: [sentence], symbol: topic[0], kind: 'market', priority: 2,
          action: 'market watch', publishedAt: fragment.citation.publicationDate || product.publicationDate,
          rows: [row('Action', 'Watch the published market development'), row('Context', sentence), ...(watch ? [row('Watch', watch)] : [])],
          sourceLinks: [{ label: fragment.citation.title || product.product, citation: fragment.citation }], state: { researchOnly: true } }));
      }
    }
  }
  return [...found.values()];
}
function evaluateResearchAttention(context = {}, now = new Date()) {
  now = now instanceof Date ? now : new Date(now);
  // Reuse exact source text only within this evaluation; citations, security
  // relevance and current evidence gates remain specific to each reading.
  const sentenceMemo = new Map();
  const verified = freshBook(context.holdings, now);
  const diagnostics = [...(context.diagnostics || [])];
  if (!verified) diagnostics.push({ component: 'holdings', status: 'unavailable' });
  const portfolio = portfolioFindings(context, now, verified);
  const actions = [...sourceActionFindings(context, now, verified, portfolio, sentenceMemo), ...unverifiedInstructionFindings(context, now, verified)];
  const opportunities = opportunityFindings(context, now, verified, portfolio, sentenceMemo);
  const markets = marketFindings(context, now, sentenceMemo);
  const accounts = accountFindings(context, now);
  const completeKinds = [];
  if (verified && context.holdings.researchComplete !== false && context.research?.scanComplete === true) completeKinds.push('portfolio');
  if (context.research?.scanComplete === true && Array.isArray(context.documents?.products)) completeKinds.push('opportunity', 'market');
  if (accounts.complete) completeKinds.push('account');
  const unique = new Map([...portfolio, ...actions, ...opportunities, ...markets, ...accounts.findings].map(item => [item.id, item]));
  return { findings: [...unique.values()], diagnostics, complete: completeKinds.includes('portfolio') && completeKinds.includes('opportunity') && completeKinds.includes('market'), completeKinds };
}
module.exports = { evaluateResearchAttention, freshBook };
