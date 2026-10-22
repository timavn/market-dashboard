import { normalizeResearchDate } from '../../../utils/researchDateFormat';
import { safeResearchUrl } from '../../../utils/researchSourceUrl';
import { canonicalProductState } from '../../../utils/securityIntelligenceV2';
import { isCanonicalResearchBias, normalizeResearchBias } from '../../../utils/researchBias.cjs';
import { finiteOptionalNumber } from '../../../utils/portfolioNumbers';

// Pure research row projection. Callers retain source acceptance, request
// ownership, and caching; these builders never fetch or turn references into quotes.
export const SECURITY_RESEARCH_EXCLUDED_PRODUCTS = new Set([
  'cftc-positioning',
  'crypto-quant',
  'market-structure',
  'volume',
]);
// Security-specific trackers should render only when the publication has a
// verified reference for this symbol; a blank placeholder implies coverage.
const SECURITY_RESEARCH_REFERENCE_REQUIRED_PRODUCTS = new Set(['momo-tracker']);
const RESEARCH_REFERENCE_KIND_PRIORITY = Object.freeze({
  primary_risk_range: 130,
  supplemental_risk_range: 125,
  historical_risk_range: 125,
  portfolio_solutions_rank: 125,
  tracker_trade: 125,
  trade_signal: 125,
  signal_strength_added: 125,
  signal_strength_removed: 125,
  signal_strength_listed: 125,
  signal_strength_membership: 125,
  etf_pro_change: 120,
  real_time_alert: 120,
  investing_idea_position: 125,
  portfolio_solutions_mover: 115,
  position_mention: 115,
  position_change: 110,
  position_reference: 90,
  risk_range: 85,
  portfolio_rank: 80,
  commodity_mention: 70,
  factor_mention: 70,
  sector_mention: 70,
  country_mention: 70,
  macro_mention: 70,
  summary_mention: 60,
  mention: 60,
});

export const formatResearchDateLabel = (value) => {
  const date = normalizeResearchDate(value);
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
};

export const getResearchDatumDate = (datum) => normalizeResearchDate(
  datum?.marketDate
  || datum?.sourceDate
  || datum?.contentDate
  || datum?.publicationDate
  || datum?.asOfDate
  || datum?.date
  || datum?.source?.marketDate
  || datum?.source?.sourceDate
);

export const getResearchProductId = (datum) => String(
  datum?.productId
  || datum?.product
  || datum?.sourceId
  || datum?.source?.productId
  || datum?.source?.id
  || datum?.source?.name
  || ''
).trim().toLowerCase();

export const researchSourceLabel = (datum) => {
  const label = datum?.productLabel
    || datum?.sourceLabel
    || datum?.source?.label
    || datum?.source?.name
    || datum?.productId
    || datum?.product
    || datum?.sourceId;
  return label && typeof label !== 'object' ? String(label) : 'Research';
};

export const asArray = (value) => (Array.isArray(value) ? value : []);

export const researchReferenceText = (reference) => (
  reference?.excerpt
  || reference?.description
  || reference?.summary
  || reference?.headline
  || ''
);

export const normalizeResearchReferenceText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const researchEvidenceExcerpt = (reference) => {
  const rawText = normalizeResearchReferenceText(researchReferenceText(reference));
  if (!rawText) return '';
  if (!/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(rawText)) {
    return rawText;
  }
  const tokens = [reference?.matchedText, reference?.exposureLabel]
    .map((value) => normalizeResearchReferenceText(value))
    .filter((value) => value.length > 1);
  if (tokens.length === 0) return '';
  const sentences = rawText.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
  const relevant = sentences.filter((sentence) => (
    !/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(sentence)
      && tokens.some((token) => new RegExp(
        `(^|[^A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9])`,
        'i',
      ).test(sentence))
  ));
  return normalizeResearchReferenceText(relevant.join(' '));
};

const formatResearchReferenceNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : null;
};

const formatEmbeddedResearchJson = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!(text.startsWith('{') && text.endsWith('}'))) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const symbol = String(parsed.ticker || parsed.symbol || parsed.security || '').trim().toUpperCase();
    const lrr = formatResearchReferenceNumber(parsed.lrr ?? parsed.low ?? parsed.riskRangeLow);
    const hrr = formatResearchReferenceNumber(parsed.hrr ?? parsed.high ?? parsed.riskRangeHigh);
    if (lrr !== null || hrr !== null) {
      const trend = normalizeResearchBias(parsed.trend);
      return [
        symbol || null,
        `LRR ${lrr || '—'} – HRR ${hrr || '—'}`,
        trend ? `Trend ${trend}` : null,
      ].filter(Boolean).join(' · ');
    }
    const rank = formatResearchReferenceNumber(parsed.rank);
    if (symbol && rank !== null) {
      return [
        `${symbol} ranked #${rank}`,
        parsed.positionSizing ? `Sizing ${parsed.positionSizing}` : null,
        parsed.weekAgo ? `Weekly ${parsed.weekAgo}` : null,
        parsed.monthAgo ? `Monthly ${parsed.monthAgo}` : null,
      ].filter(Boolean).join('; ');
    }
    const change = formatResearchReferenceNumber(parsed.change);
    if (symbol && change !== null) return `${symbol} rank change ${change}`;
  } catch (_error) {
    return null;
  }
  return null;
};

const formatResearchReferenceDetail = (reference) => {
  const rawText = researchEvidenceExcerpt(reference);
  const text = formatEmbeddedResearchJson(rawText)
    || normalizeResearchReferenceText(rawText);
  if (!text) return null;
  const direction = displayDirectionForReference(reference);
  if (!direction) return text;
  const escapedDirection = direction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directionAlreadyLabeled = new RegExp(
    `(^|[·—:;])\\s*${escapedDirection}\\b|\\b(?:trend|trade)\\s+${escapedDirection}\\b`,
    'i',
  ).test(text);
  return directionAlreadyLabeled
    ? text
    : `${direction} · ${text}`;
};

const researchReferenceScore = (reference, detail) => {
  const kind = String(reference?.kind || '').trim().toLowerCase();
  let score = RESEARCH_REFERENCE_KIND_PRIORITY[kind] || 50;
  const matchType = String(reference?.matchType || '').trim().toLowerCase();
  if (matchType === 'direct') score += 20;
  else if (matchType === 'direct_alias') score += 15;
  if (reference?.direction) score += 5;
  if (reference?.value !== undefined && reference?.value !== null) score += 5;
  if (detail.length <= 240) score += 8;
  if (detail.length > 420) score -= 12;
  if (detail.length > 600) score -= 18;
  if (/\b(unsubscribe|manage your preferences|prepared exclusively|having trouble viewing)\b/i.test(detail)) {
    score -= 90;
  }
  if (/^[A-Z0-9./=^_-]{1,20}$/.test(detail)) score -= 18;
  if (/^[{[]/.test(normalizeResearchReferenceText(researchReferenceText(reference)))) score -= 20;
  return score;
};

const isResearchBoilerplate = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return true;
  if (/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(text)) {
    return true;
  }
  return /^[A-Z0-9./=^_-]{1,20}$/.test(text);
};

const researchEvidenceScore = (reference, detail) => (
  researchReferenceScore(reference, detail)
  + (reference?.matchedText ? 5 : 0)
);

const compactResearchEvidence = (productId, references) => {
  const ranked = asArray(references).map((reference) => {
    const rawText = researchEvidenceExcerpt(reference);
    const detail = formatResearchReferenceDetail(reference);
    const kind = String(reference?.kind || '').trim().toLowerCase();
    return {
      reference,
      rawText,
      detail,
      kind,
      score: detail && !isResearchBoilerplate(rawText)
        ? researchEvidenceScore(reference, detail)
        : Number.NEGATIVE_INFINITY,
    };
  }).filter((item) => item.detail && Number.isFinite(item.score)).sort((left, right) => (
    right.score - left.score
    || String(left.reference?.publishedAt || '').localeCompare(String(right.reference?.publishedAt || ''))
    || right.rawText.length - left.rawText.length
  ));

  const selected = [];
  ranked.forEach((candidate) => {
    const normalized = candidate.rawText.toLowerCase();
    const duplicate = selected.some((item) => {
      const existing = item.rawText.toLowerCase();
      if (existing === normalized) return true;
      // A short structured/ticker-only match is redundant when a richer
      // excerpt from the same publication already contains it.
      if (Math.min(existing.length, normalized.length) < 40) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      if (item.reference?.sourceEventId && item.reference.sourceEventId === candidate.reference?.sourceEventId) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      if (productId === 'portfolio-solutions' && item.kind === candidate.kind) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      return existing.includes(normalized) || normalized.includes(existing);
    });
    if (!duplicate) selected.push(candidate);
  });
  return selected;
};

const RESEARCH_FACT_LINE_LIMIT = 4;
const RESEARCH_FACT_ORDER = Object.freeze({
  rank: 10,
  sizing: 20,
  weeklyChange: 30,
  monthlyChange: 40,
  riskRange: 50,
  trend: 60,
  trade: 70,
  buyTrade: 80,
  sellTrade: 90,
  signalStrength: 100,
  position: 110,
  etfPro: 120,
});

const ensureResearchSentence = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return null;
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

const formatResearchSignedChange = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = normalizeResearchReferenceText(value);
  const arrowMatch = text.match(/^([▲△↑▼▽↓])\s*([+-]?\d+(?:\.\d+)?)$/);
  if (arrowMatch) {
    const magnitude = Math.abs(Number(arrowMatch[2]));
    return /[▲△↑]/.test(arrowMatch[1]) ? `+${magnitude}` : `-${magnitude}`;
  }
  const numeric = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return text;
  const formatted = formatResearchReferenceNumber(numeric);
  return numeric > 0 ? `+${formatted}` : formatted;
};

const researchLabeledValue = (value, labelPattern) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return null;
  const match = text.match(new RegExp(
    `\\b(?:${labelPattern})\\b\\s*(?::|=|is)?\\s*([^;·|]+?)(?=\\s*(?:[;·|]|$))`,
    'i',
  ));
  return normalizeResearchReferenceText(match?.[1]);
};

const RESEARCH_BIAS_REFERENCE_KINDS = new Set([
  'primary_risk_range',
  'historical_risk_range',
  'risk_range',
  'supplemental_risk_range',
  'tracker_trade',
  'trade_signal',
  'investing_idea_position',
]);

const structuredResearchBiasValue = (reference) => {
  const kind = String(reference?.kind || '').trim().toLowerCase();
  if (!RESEARCH_BIAS_REFERENCE_KINDS.has(kind)) return null;
  const rawValue = reference?.value;
  const valueCandidate = rawValue && typeof rawValue === 'object'
    ? rawValue.bias
      ?? rawValue.trend
      ?? rawValue.direction
      ?? rawValue.trade
      ?? rawValue.signal
      ?? (kind === 'investing_idea_position' ? rawValue.side : null)
    : rawValue;
  const fromValue = normalizeResearchBias(valueCandidate);
  if (fromValue) return fromValue;

  // POSITIVE/NEGATIVE are frequently narrative sentiment markers. Only use
  // an already-canonical direction as a fallback when no structured value is
  // present, so prose cannot become a decision-grade bias.
  return isCanonicalResearchBias(reference?.direction)
    ? normalizeResearchBias(reference.direction)
    : null;
};

const displayDirectionForReference = (reference) => {
  const kind = String(reference?.kind || '').trim().toLowerCase();
  if (RESEARCH_BIAS_REFERENCE_KINDS.has(kind)) {
    return structuredResearchBiasValue(reference);
  }
  const direction = String(reference?.direction || '').trim().toUpperCase();
  return direction || null;
};

export const historicalResearchDisplayRow = ({ key, productLabel, reference = null }) => {
  const direction = displayDirectionForReference(reference);
  const rawNote = reference
    ? (formatResearchReferenceDetail(reference) || researchReferenceText(reference))
    : undefined;
  const note = direction && !String(rawNote || '').startsWith(`${direction} ·`)
    ? `${direction} · ${rawNote}`
    : rawNote;
  return {
    key,
    productLabel,
    dateLabel: formatResearchDateLabel(getResearchDatumDate(reference)),
    note,
  };
};

const buildStructuredResearchFacts = (productId, evidence, symbol) => {
  const reference = evidence?.reference || {};
  const kind = String(evidence?.kind || reference.kind || '').trim().toLowerCase();
  const text = normalizeResearchReferenceText(evidence?.rawText || researchReferenceText(reference));
  const normalizedSymbol = String(symbol || reference.matchedText || '').trim().toUpperCase();
  const facts = [];
  const add = (key, factText) => {
    const sentence = ensureResearchSentence(factText);
    if (sentence) facts.push({ key, text: sentence });
  };

  if (productId === 'portfolio-solutions') {
    const rankValue = finiteOptionalNumber(reference.value);
    const rankMatch = text.match(/\branked?\s*#?\s*(\d+(?:\.\d+)?)/i);
    const rank = rankValue === null
      ? formatResearchReferenceNumber(rankMatch?.[1])
      : formatResearchReferenceNumber(rankValue);
    if (rank && normalizedSymbol) {
      add('rank', `${normalizedSymbol} is ranked #${rank} today`);
    }

    const sizing = researchLabeledValue(text, '(?:position\\s+)?sizing');
    if (sizing) add('sizing', `Recommended position sizing is ${sizing}`);

    const weekly = researchLabeledValue(text, 'weekly(?:\\s+rank\\s+change)?');
    if (weekly) add('weeklyChange', `Weekly rank change is ${formatResearchSignedChange(weekly)}`);
    const monthly = researchLabeledValue(text, 'monthly(?:\\s+rank\\s+change)?');
    if (monthly) add('monthlyChange', `Monthly rank change is ${formatResearchSignedChange(monthly)}`);

    if (kind === 'portfolio_solutions_mover') {
      const period = text.match(/\b(weekly|monthly)\b/i)?.[1]?.toLowerCase();
      const change = formatResearchSignedChange(
        finiteOptionalNumber(reference.value) ?? text.match(/\brank\s+change\s+([▲△↑▼▽↓]?\s*[+-]?\d+(?:\.\d+)?)/i)?.[1],
      );
      if (period && change) {
        add(
          period === 'weekly' ? 'weeklyChange' : 'monthlyChange',
          `${period === 'weekly' ? 'Weekly' : 'Monthly'} rank change is ${change}`,
        );
      }
    }
    return facts;
  }

  if (['primary_risk_range', 'supplemental_risk_range', 'historical_risk_range', 'risk_range'].includes(kind)) {
    const rangeValue = reference.value && typeof reference.value === 'object' ? reference.value : {};
    const lrrMatch = text.match(/\bLRR\s*\$?([\d,.]+)/i);
    const hrrMatch = text.match(/\bHRR\s*\$?([\d,.]+)/i);
    const lrr = formatResearchReferenceNumber(
      rangeValue.lrr ?? rangeValue.low ?? (lrrMatch ? Number(lrrMatch[1].replace(/,/g, '')) : null),
    );
    const hrr = formatResearchReferenceNumber(
      rangeValue.hrr ?? rangeValue.high ?? (hrrMatch ? Number(hrrMatch[1].replace(/,/g, '')) : null),
    );
    if (lrr && hrr && normalizedSymbol) add('riskRange', `${normalizedSymbol} risk range is ${lrr}–${hrr}`);
    const trend = structuredResearchBiasValue({
      ...reference,
      value: rangeValue,
    });
    if (trend && normalizedSymbol) add('trend', `${normalizedSymbol} trend is ${trend}`);
    return facts;
  }

  if (kind === 'investing_idea_position') {
    const value = reference.value && typeof reference.value === 'object' ? reference.value : {};
    const side = String(value.side || value.position || '').trim().toUpperCase();
    const bias = normalizeResearchBias(
      value.bias || (side === 'LONG' ? 'BULLISH' : side === 'SHORT' ? 'BEARISH' : ''),
    );
    const previousClose = finiteOptionalNumber(value.prevClose ?? value.previousClose);
    const lrr = finiteOptionalNumber(value.lrr);
    const hrr = finiteOptionalNumber(value.hrr);
    if (side && normalizedSymbol) add('position', `${normalizedSymbol} Investing Ideas position is ${side}`);
    if (bias && normalizedSymbol) add('bias', `${normalizedSymbol} Investing Ideas bias is ${bias}`);
    if (previousClose !== null) add('previousClose', `Previous close is ${formatResearchReferenceNumber(previousClose)}`);
    if (lrr !== null && hrr !== null && lrr <= hrr && normalizedSymbol) {
      add('riskRange', `${normalizedSymbol} Investing Ideas risk range is ${formatResearchReferenceNumber(lrr)}–${formatResearchReferenceNumber(hrr)}`);
    }
    return facts;
  }

  if (['tracker_trade', 'trade_signal'].includes(kind)) {
    const trade = structuredResearchBiasValue(reference);
    if (trade && normalizedSymbol) add('trade', `${normalizedSymbol} trade signal is ${trade}`);
    const buyTrade = researchLabeledValue(text, 'buy\\s+trade');
    if (buyTrade) add('buyTrade', `Buy Trade is ${buyTrade}`);
    const sellTrade = researchLabeledValue(text, 'sell\\s+trade');
    if (sellTrade) add('sellTrade', `Sell Trade is ${sellTrade}`);
    return facts;
  }

  if (kind.startsWith('signal_strength_')) {
    if (!normalizedSymbol) return facts;
    if (kind === 'signal_strength_added') add('signalStrength', `${normalizedSymbol} was added to Signal Strength`);
    else if (kind === 'signal_strength_removed') add('signalStrength', `${normalizedSymbol} was removed from Signal Strength`);
    else if (kind === 'signal_strength_short_added') add('signalStrength', `${normalizedSymbol} was added to Signal Strength Shorts`);
    else if (kind === 'signal_strength_short_removed') add('signalStrength', `${normalizedSymbol} was removed from Signal Strength Shorts`);
    else if (kind === 'signal_strength_short_membership') add('signalStrength', `${normalizedSymbol} is on Signal Strength Shorts`);
    else {
      const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
      if (direction) add('signalStrength', `${normalizedSymbol} Signal Strength status is ${direction}`);
    }
    return facts;
  }

  if (kind === 'position_mention') {
    const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
    if (direction && normalizedSymbol) {
      add('position', `${normalizedSymbol} is listed ${direction} in ${researchSourceLabel(reference)}`);
    }
    return facts;
  }

  if (kind === 'etf_pro_change') {
    const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
    if (direction && normalizedSymbol) {
      const action = direction === 'ADD' || direction === 'ADDED'
        ? 'was added to'
        : direction === 'REMOVE' || direction === 'REMOVED' ? 'was removed from' : `has a ${direction} update in`;
      add('etfPro', `${normalizedSymbol} ${action} ETF Pro`);
    }
    return facts;
  }

  return facts;
};

const clipResearchFocusText = (value, tokens, maxLength = 280) => {
  const text = normalizeResearchReferenceText(value);
  if (!text || text.length <= maxLength) return text;
  const lowerText = text.toLowerCase();
  const tokenIndex = tokens.map((token) => lowerText.indexOf(token.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  let start = Math.max(0, tokenIndex - Math.floor(maxLength * 0.3));
  let end = Math.min(text.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  if (start > 0) {
    const nextSpace = text.indexOf(' ', start);
    if (nextSpace > start && nextSpace < end) start = nextSpace + 1;
  }
  if (end < text.length) {
    const previousSpace = text.lastIndexOf(' ', end);
    if (previousSpace > start) end = previousSpace;
  }
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? '… ' : ''}${excerpt}${end < text.length ? ' …' : ''}`;
};

const researchFocusSentence = (reference, symbol, fallbackText = null) => {
  const text = normalizeResearchReferenceText(fallbackText || researchEvidenceExcerpt(reference));
  if (!text) return null;
  const tokens = [
    reference?.matchedText,
    reference?.exposureLabel,
    symbol,
  ].map((value) => normalizeResearchReferenceText(value)).filter(Boolean);
  const tokenMatcher = tokens.length > 0
    ? new RegExp(
      `(^|[^A-Za-z0-9])(?:${tokens.map((token) => token.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})(?=$|[^A-Za-z0-9])`,
      'i',
    )
    : null;
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
  let focus = sentences.find((sentence) => tokenMatcher?.test(sentence)) || sentences[0] || text;
  if (focus.length > 280) {
    const clauses = focus.split(/\s*(?:;|\||•)\s*/).filter(Boolean);
    const matchedClause = clauses.find((clause) => tokenMatcher?.test(clause));
    if (matchedClause) focus = matchedClause;
  }
  return clipResearchFocusText(focus, tokens);
};

const buildResearchFactLines = (productId, evidence, symbol) => {
  const rankedEvidence = asArray(evidence);
  const structuredFacts = [];
  rankedEvidence.forEach((item, evidenceIndex) => {
    buildStructuredResearchFacts(productId, item, symbol).forEach((fact, factIndex) => {
      structuredFacts.push({
        ...fact,
        reference: item.reference,
        evidenceIndex,
        factIndex,
      });
    });
  });

  const candidates = structuredFacts.length > 0
    ? structuredFacts.sort((left, right) => (
      (RESEARCH_FACT_ORDER[left.key] ?? 500) - (RESEARCH_FACT_ORDER[right.key] ?? 500)
      || left.evidenceIndex - right.evidenceIndex
      || left.factIndex - right.factIndex
    ))
    : rankedEvidence.map((item, evidenceIndex) => ({
      key: `source-${evidenceIndex}`,
      text: researchFocusSentence(item.reference, symbol, item.rawText),
      reference: item.reference,
      evidenceIndex,
      factIndex: 0,
    }));

  const selected = [];
  candidates.some((candidate) => {
    if (!candidate.text) return false;
    const text = candidate.text;
    const normalized = normalizeResearchReferenceText(text).toLowerCase();
    const duplicate = selected.some((item) => (
      item.key === candidate.key
      || normalizeResearchReferenceText(item.text).toLowerCase() === normalized
    ));
    if (!duplicate) selected.push({ ...candidate, text });
    return selected.length >= RESEARCH_FACT_LINE_LIMIT;
  });
  return selected;
};

const selectResearchProductDetails = (productId, references) => {
  const ranked = references.map((reference) => {
    const detail = formatResearchReferenceDetail(reference);
    const kind = String(reference?.kind || '').trim().toLowerCase();
    return {
      reference,
      detail,
      kind,
      kindPriority: RESEARCH_REFERENCE_KIND_PRIORITY[kind] || 50,
      score: detail ? researchReferenceScore(reference, detail) : Number.NEGATIVE_INFINITY,
    };
  }).filter((item) => item.detail && !isResearchBoilerplate(researchEvidenceExcerpt(item.reference))).sort((left, right) => (
    right.score - left.score
    || String(right.reference?.publishedAt || '').localeCompare(String(left.reference?.publishedAt || ''))
    || left.detail.length - right.detail.length
  ));

  if (ranked.length === 0) return { selected: [], details: [] };
  const top = ranked[0];
  const candidates = ranked.filter((item) => (
    top.kindPriority >= 110
      ? item.kindPriority >= top.kindPriority - 15
      : item.score >= top.score - 32
  ));
  const limit = ['portfolio-solutions', 'real-time-alert', 'etf-pro', 'signal-strength'].includes(productId)
    ? 4
    : 3;
  const selected = [];
  candidates.some((candidate) => {
    const normalized = candidate.detail.toLowerCase();
    const moverPeriod = candidate.kind === 'portfolio_solutions_mover'
      ? normalized.match(/\b(weekly|monthly)\b/)?.[1]
      : null;
    const duplicate = selected.some((item) => {
      const existing = item.detail.toLowerCase();
      if (existing === normalized) return true;
      if (
        productId === 'portfolio-solutions'
        && moverPeriod
        && item.kind === 'portfolio_solutions_rank'
        && existing.includes(moverPeriod)
      ) return true;
      return item.kind === candidate.kind
        && Math.min(existing.length, normalized.length) >= 8
        && (existing.includes(normalized) || normalized.includes(existing));
    });
    if (!duplicate) selected.push(candidate);
    return selected.length >= limit;
  });
  if (selected.length === 0) selected.push(top);
  return {
    selected,
    details: selected.map((item) => item.detail),
  };
};

const latestResearchPublicationTime = (references, product = null) => {
  const validCandidates = (values) => values.filter(Boolean)
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.timestamp));
  const referenceCandidates = validCandidates(
    references.map((reference) => reference?.publishedAt)
      .filter((value) => !/T00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?$/i.test(String(value || ''))),
  );
  const productCandidates = validCandidates([product?.publishedAt, product?.latestPublishedAt]);
  const fallbackCandidates = validCandidates(references.map((reference) => reference?.publishedAt));
  return [referenceCandidates, productCandidates, fallbackCandidates]
    .find((candidates) => candidates.length > 0)
    ?.sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
};

export const buildResearchProductRows = ({
  references,
  symbol = null,
  productsById = new Map(),
  productOrder = new Map(),
  marketDate = null,
  requireCurrentIndexed = false,
  groupByDate = false,
  includeEmptyProducts = false,
}) => {
  const groups = new Map();
  if (includeEmptyProducts && !groupByDate) {
    productsById.forEach((product, productId) => {
      if (
        !productId
        || productId === 'unknown'
        || SECURITY_RESEARCH_EXCLUDED_PRODUCTS.has(productId)
        || SECURITY_RESEARCH_REFERENCE_REQUIRED_PRODUCTS.has(productId)
        || product?.cadence === 'unsupported'
      ) return;
      groups.set(productId, {
        key: productId,
        productId,
        product,
        marketDate: normalizeResearchDate(product.marketDate || marketDate) || marketDate,
        references: [],
      });
    });
  }
  references.forEach((reference) => {
    const productId = getResearchProductId(reference);
    const referenceDate = getResearchDatumDate(reference);
    if (
      !productId
      || productId === 'unknown'
      || SECURITY_RESEARCH_EXCLUDED_PRODUCTS.has(productId)
      || !referenceDate
    ) return;
    const product = productsById.get(productId) || null;
    if (requireCurrentIndexed && (
      !product
      || !['indexed', 'not_due'].includes(String(product.status || '').toLowerCase())
      || normalizeResearchDate(product.marketDate || marketDate) !== marketDate
    )) return;
    const key = groupByDate ? `${referenceDate}\u0000${productId}` : productId;
    const group = groups.get(key) || {
      key,
      productId,
      product,
      marketDate: referenceDate,
      references: [],
    };
    group.references.push(reference);
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => {
    const selection = selectResearchProductDetails(group.productId, group.references);
    const evidence = compactResearchEvidence(group.productId, group.references);
    const factEntries = buildResearchFactLines(group.productId, evidence, symbol);
    const selectedReference = selection.selected[0]?.reference || group.references[0];
    const sourceReference = factEntries
      .map((item) => item.reference)
      .find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || selection.selected.map((item) => item.reference)
      .find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || group.references.find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || selectedReference;
    const productLabel = group.product?.label || researchSourceLabel(selectedReference);
    const publishedAt = latestResearchPublicationTime(group.references, group.product);
    const productStatus = String(group.product?.status || '').trim().toLowerCase();
    const hasEvidence = evidence.length > 0;
    const productDateMismatch = Boolean(
      !groupByDate
      && marketDate
      && normalizeResearchDate(group.product?.marketDate || group.marketDate) !== normalizeResearchDate(marketDate)
    );
    const isUnavailable = !hasEvidence && (
      productDateMismatch || !['indexed', 'not_due'].includes(productStatus)
    );
    return {
      key: group.key,
      productId: group.productId,
      productLabel,
      marketDate: group.marketDate,
      publishedAt,
      referenceCount: group.references.length,
      references: group.references,
      evidence,
      factLines: factEntries.map((item) => item.text),
      status: productStatus || null,
      state: hasEvidence ? 'available' : isUnavailable ? 'unavailable' : 'empty',
      reference: {
        ...selectedReference,
        id: `${group.marketDate}-${group.productId}-product-row`,
        productId: group.productId,
        productLabel,
        marketDate: group.marketDate,
        publishedAt,
        direction: null,
        excerpt: selection.details.join(' · ') || null,
        sourceUrl: sourceReference?.sourceUrl || sourceReference?.url || null,
      },
    };
  }).sort((left, right) => {
    if (groupByDate && left.marketDate !== right.marketDate) {
      return String(right.marketDate).localeCompare(String(left.marketDate));
    }
    if (!groupByDate) {
      const orderDelta = (productOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER)
        - (productOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER);
      if (orderDelta !== 0) return orderDelta;
    }
    const leftTime = Date.parse(left.publishedAt || '');
    const rightTime = Date.parse(right.publishedAt || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    return (productOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER)
      - (productOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER)
      || left.productLabel.localeCompare(right.productLabel);
  });
};

const canonicalNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : value === null || value === undefined || value === '' ? '—' : String(value);
};

export const buildCanonicalResearchProductRows = ({
  security,
  productOrder = new Map(),
  marketDate = null,
}) => Object.values(security?.products || {})
  .filter((product) => {
    const productId = String(product?.id || '').trim().toLowerCase();
    return productId
      && !SECURITY_RESEARCH_EXCLUDED_PRODUCTS.has(productId)
      && !SECURITY_RESEARCH_REFERENCE_REQUIRED_PRODUCTS.has(productId);
  })
  .map((product) => {
    const productId = String(product.id).trim().toLowerCase();
    const state = canonicalProductState(product);
    const fields = product.fields || {};
    const factLines = [];
    const addField = (label, field, formatter = canonicalNumber) => {
      if (!field || field.value === null || field.value === undefined || field.value === '') return;
      factLines.push(`${label} ${formatter(field.value)}`);
    };
    const addBiasField = (label, field) => {
      const value = normalizeResearchBias(field?.value);
      if (value) factLines.push(`${label} ${value}`);
    };

    if (state === 'available') {
      if (productId === 'portfolio-solutions') {
        // Portfolio Solutions has a product-specific fact vocabulary. Do not
        // let the derived BULLISH trade/trend fields displace the useful rank
        // headline in the collapsed row.
        const canonicalEvidence = (fields.facts || []).map((fact, index) => ({
          reference: {
            ...fact,
            id: fact?.sourceEventId || `${productId}-${index}`,
            productId,
            productLabel: product.label,
            matchedText: security?.symbol || null,
            kind: fact?.kind,
            value: fact?.value,
            excerpt: fact?.excerpt || null,
          },
          rawText: fact?.excerpt || '',
        }));
        const structuredFactLines = buildResearchFactLines(
          productId,
          canonicalEvidence,
          security?.symbol,
        ).map((fact) => fact.text).filter(Boolean);
        factLines.push(...structuredFactLines);
        if (factLines.length === 0 && fields.rank?.value !== null && fields.rank?.value !== undefined) {
          const canonicalSymbol = String(security?.symbol || '').trim().toUpperCase();
          if (canonicalSymbol) {
            factLines.push(`${canonicalSymbol} is ranked #${canonicalNumber(fields.rank.value)} today.`);
          }
        }
      } else {
        addBiasField('Trade', fields.trade);
        addBiasField('Trend', fields.trend);
        if (fields.bias?.value) {
          const bias = normalizeResearchBias(fields.bias.value);
          factLines.push([
            fields.side || fields.bias.side || null,
            bias ? `Bias ${bias}` : null,
          ].filter(Boolean).join(' · '));
        }
        if (fields.riskRange?.value) {
          const range = fields.riskRange.value;
          factLines.push(`LRR ${canonicalNumber(range.lrr)} – HRR ${canonicalNumber(range.hrr)}`);
        }
        if (fields.previousClose !== null && fields.previousClose !== undefined) {
          factLines.push(`Previous close ${canonicalNumber(fields.previousClose)}`);
        }
        addField('Action', fields.action);
        addField('Rank', fields.rank);
        addField('Sizing', fields.sizing);
        (fields.facts || []).forEach((fact) => {
          if (fact?.excerpt && !factLines.includes(fact.excerpt)) factLines.push(fact.excerpt);
        });
      }
      if (factLines.length === 0) factLines.push('Verified current structured row');
    }

    const firstFact = (fields.facts || [])[0] || {};
    const reference = {
      id: `${product.marketDate || marketDate || 'current'}-${productId}-canonical-row`,
      productId,
      productLabel: product.label,
      marketDate: product.marketDate || marketDate,
      publishedAt: product.publishedAt || firstFact.publishedAt || null,
      sourceUrl: product.sourceUrl || firstFact.sourceUrl || null,
      sourceEventId: firstFact.sourceEventId || product.evidenceIds?.[0] || null,
      qualityStatus: product.qualityStatus || firstFact.qualityStatus || null,
      matchType: 'direct',
      excerpt: factLines.join(' · ') || null,
    };

    return {
      key: productId,
      productId,
      productLabel: product.label || productId,
      marketDate: product.marketDate || marketDate,
      publishedAt: product.publishedAt || firstFact.publishedAt || null,
      referenceCount: product.evidenceIds?.length || 0,
      references: [reference],
      evidence: fields.facts || [],
      factLines,
      status: state,
      state,
      reference,
    };
  })
  .sort((left, right) => (
    (productOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER)
      - (productOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER)
    || left.productLabel.localeCompare(right.productLabel)
  ));
