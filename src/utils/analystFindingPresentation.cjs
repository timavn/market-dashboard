const SIGNAL_LABELS = Object.freeze({ BULLISH: 'Bullish', BEARISH: 'Bearish', NEUTRAL: 'Neutral' });
const SIGNAL_TONES = Object.freeze({ BULLISH: 'positive', BEARISH: 'negative', NEUTRAL: 'neutral' });
const ACTION_HEADLINES = Object.freeze({ exit: 'Exit reported', trim: 'Position reduction reported', cover: 'Short closure reported', 'roster removal': 'Removed from source roster' });

function signalUpdatePresentation(signal, previous, sourceInstrument) {
  return {
    updateLabel: `${sourceInstrument ? `${sourceInstrument} ` : ''}${signal.field === 'trade' ? 'Trade' : 'Trend'}`,
    updateParts: [
      ...(previous ? [{ text: SIGNAL_LABELS[previous.value], tone: SIGNAL_TONES[previous.value] }, { text: ' → ', tone: 'neutral' }] : []),
      { text: SIGNAL_LABELS[signal.value], tone: SIGNAL_TONES[signal.value] },
    ],
  };
}

function signalHeadlineParts(signal, previous, sourceInstrument) {
  const { updateLabel, updateParts } = signalUpdatePresentation(signal, previous, sourceInstrument);
  return [{ text: `${updateLabel}: `, tone: 'neutral' }, ...updateParts];
}

function typedAnalystSignal(event = {}) {
  const field = ['trade_signal', 'tracker_trade'].includes(event.eventType) ? 'trade'
    : ['trend_signal', 'risk_range', 'primary_risk_range'].includes(event.eventType) ? 'trend'
      : event.eventType === 'signal_change' && /(?:^|[.])(?:trade|trend)$/i.test(event.fieldPath || '') ? event.fieldPath.split('.').at(-1).toLowerCase() : null;
  if (!field) return null;
  if (field === 'trade') {
    // Legacy tracker imports mislabeled Trend copies as Trade. An event kind
    // alone is not directional evidence; use the same explicit source gate as
    // the canonical research projection, including subject-bound source prose.
    const published = publishedTradeFromEvent(event);
    return published ? { field, value: published.value } : null;
  }
  const raw = event.signalValue ?? event.value;
  const value = String(raw && typeof raw === 'object' ? raw[field] || '' : raw || '').toUpperCase();
  const normalized = ({ LONG: 'BULLISH', SHORT: 'BEARISH', FLAT: 'NEUTRAL' })[value] || value;
  return SIGNAL_LABELS[normalized] ? { field, value: normalized } : null;
}

function priorSignal(event, current, findings) {
  const candidates = [...findings.map(finding => (finding.payload || finding).event), event.previousEvent]
    .filter(previous => previous && previous.qualityStatus === 'validated' && previous.productKey
      && previous.productKey === event.productKey && previous.entityId
      && previous.entityId === event.entityId && previous.fieldPath
      && previous.fieldPath === event.fieldPath
      && Date.parse(previous.publishedAt) < Date.parse(event.publishedAt)
      && (previous.sourceMessageId || previous.sourceEventId || previous.eventKey))
    .map(previous => ({ signal: typedAnalystSignal(previous), time: Date.parse(previous.publishedAt) }))
    .filter(previous => previous.signal?.field === current.field)
    .sort((a, b) => b.time - a.time);
  const latest = candidates[0];
  if (!latest || latest.signal.value === current.value
      || candidates.some(previous => previous.time === latest.time && previous.signal.value !== latest.signal.value)) return null;
  return latest.signal;
}

function reportDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date) : null;
}

function publisherLabel(event, citation, sourceLabel) {
  try {
    const host = new URL(event.sourceUrl || citation?.sourceUri).hostname;
    if ((host === 'hedgeye.com' || host.endsWith('.hedgeye.com')) && !/^Hedgeye\b/i.test(sourceLabel)) return `Hedgeye ${sourceLabel}`;
  } catch { /* Retain the attributed product label when no URL is available. */ }
  return sourceLabel;
}

function currentPosition(payload, now) {
  const observedAt = Date.parse(payload.holdingsVerifiedAt);
  const age = Number(now) - observedAt;
  const verified = payload.holdingsVerified === true && typeof payload.quantity === 'number'
    && Number.isFinite(payload.quantity) && Number.isFinite(age) && age >= -30_000 && age <= 60_000;
  return verified
    ? { label: payload.quantity > 0 ? 'Long' : payload.quantity < 0 ? 'Short' : 'Closed', asOf: payload.holdingsVerifiedAt }
    : { label: 'Unavailable', asOf: null };
}

function currentPortfolioWeight(payload, position, now) {
  const holding = payload.currentHolding;
  const age = Number(now) - Date.parse(holding?.asOf);
  if (!position.asOf || !holding || holding.source !== 'ibkr'
      || holding.basis !== 'absolute_market_value_over_net_liquidation'
      || typeof holding.weightPct !== 'number' || !Number.isFinite(holding.weightPct) || holding.weightPct < 0
      || !Number.isFinite(age) || age < -30_000 || age > 60_000
      || Date.parse(holding.asOf) > Date.parse(position.asOf) + 30_000) return null;
  return { ...holding, label: `${holding.weightPct > 0 && holding.weightPct < 0.01 ? '<0.01' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(holding.weightPct)}%` };
}

// Describe the effect on the current holding. The exact source instruction stays
// in the linked evidence. A sell signal alone never means add to a short.
function positionSizeAction(payload, event, position, weight) {
  const side = position.label.toUpperCase();
  if (!['LONG', 'SHORT'].includes(side) || event.qualityStatus !== 'validated') return 'Unavailable';
  if (payload.alertContext?.kind === 'source-action') {
    const { action } = sourceActionEvidence(event);
    if (['TRIM', 'REDUCE', 'EXIT'].includes(action)
        || side === 'LONG' && ['SELL', 'SELL-SOME'].includes(action)
        || side === 'SHORT' && ['COVER', 'COVER-SOME'].includes(action)) return 'Reduce position size';
    if (['ADD', 'INCREASE'].includes(action)
        || side === 'LONG' && ['BUY', 'BUY-SOME'].includes(action)
        || side === 'SHORT' && ['SHORT', 'SELL-SHORT'].includes(action)) return 'Increase position size';
    if (['HOLD', 'NO-CHANGE', 'ROSTER-REMOVAL'].includes(action)
        || side === 'SHORT' && ['SELL', 'SELL-SOME'].includes(action)
        || side === 'LONG' && ['COVER', 'COVER-SOME'].includes(action)) return 'Neutral — no change';
    return 'Unavailable';
  }
  const rule = payload.rule;
  const latestEvent = payload.alertContext?.latestEvent || event;
  const latestSignal = latestEvent.qualityStatus === 'validated' ? typedAnalystSignal(latestEvent) : null;
  if (payload.alertContext?.kind !== 'signal-transition' || !rule
      || rule.holding !== (payload.symbol || event.entityId) || rule.heldSide !== side
      || latestEvent.entityId !== rule.holding || !latestSignal || rule[latestSignal.field] !== latestSignal.value
      || event.matchType === 'structured_membership' && event.matchedText !== event.entityId
      || latestEvent.matchType === 'structured_membership' && latestEvent.matchedText !== latestEvent.entityId) return 'Unavailable';
  if (rule.status === 'aligned') return 'Neutral — no change';
  if (rule.status !== 'conflict') return 'Unavailable';
  if (rule.action === 'EXIT' && rule.targetWeight === 0) return 'Reduce position size';
  if (rule.action === 'REDUCE' && weight && typeof rule.targetWeight === 'number'
      && Number.isFinite(rule.targetWeight) && rule.targetWeight >= 0 && rule.targetWeight < weight.weightPct) return 'Reduce position size';
  return 'Unavailable';
}

function sourceActionEvidence(event = {}) {
  if (event.qualityStatus !== 'validated') return { action: '', instruction: '' };
  let source = {};
  try {
    const parsed = JSON.parse(event.excerpt);
    if (parsed && !Array.isArray(parsed) && String(parsed.ticker || parsed.symbol || '').toUpperCase() === String(event.entityId || '').toUpperCase()) source = parsed;
  } catch { /* An unstructured excerpt remains accessible in source evidence. */ }
  let action = String(source.action || event.action || event.actionType || '').trim().toUpperCase().replace(/[ _]+/g, '-');
  const phrase = typeof source.signalPhrase === 'string' ? source.signalPhrase : '';
  const report = event.sourceReport;
  const reportDate = String(event.marketDate || event.publishedAt || '').slice(0, 10);
  const matchedReport = report && event.sourceMessageId && report.sourceMessageId === event.sourceMessageId
    && /^\d{4}-\d{2}-\d{2}$/.test(reportDate) && String(report.publicationDate || '').slice(0, 10) === reportDate
    && typeof report.contentHash === 'string' && report.contentHash.length > 0
    && (!report.entityId || report.entityId === event.entityId)
    && (!report.sourceContentSha256 || report.sourceContentSha256 === event.contentSha256);
  const title = matchedReport && typeof report.title === 'string' ? report.title : '';
  const body = matchedReport && typeof report.bodyText === 'string' ? report.bodyText.replace(/\s+/g, ' ').trim() : '';
  // Only a same-report instruction can qualify a generic headline action.
  // Do not interpret a stray partial-sale mention, negation, or coaching history.
  const directive = body.match(/\bPortfolio Managers should be (selling|covering)[\s-]+SOME\b[^.!?]*(?:[.!?]|$)/i)?.[0] || '';
  const partialSell = /\bsell(?:ing)?[\s-]+some\b/i;
  const partialCover = /\bcover(?:ing)?[\s-]+some\b/i;
  const affirmativeTitle = /\b(?:not|never|avoid|stop|don't|do not)\b/i.test(title) ? '' : title;
  if (action === 'SELL' && [phrase, affirmativeTitle, directive].some(text => partialSell.test(text))) action = 'SELL-SOME';
  if (action === 'COVER' && [phrase, affirmativeTitle, directive].some(text => partialCover.test(text))) action = 'COVER-SOME';
  const instruction = (action === 'SELL-SOME' && partialSell.test(directive) || action === 'COVER-SOME' && partialCover.test(directive))
    ? directive.replace(/\.{1,}$/, '').trim() : '';
  return { action, instruction, report: matchedReport ? report : null };
}

const REPORT_CONTEXT_WORDS = new Set(`AM PM EDT EST PDT PST UTC PT ET CT MT KM US USA USD RTA
  THE AND FOR OUR ALL YOU YOUR WITH FROM THAT THIS SOME MORE NOW CAN HAS HAD WAS ARE ITS
  AFTER BEFORE WHEN WHILE WHERE WHY HOW WHAT WHICH WHO INTO OVER UNDER ALSO ONLY THAN THEN
  NOT BUT OUT OFF DID GET GOT TOO VERY IF IN IS IT AS AT BY OF ON OR TO WE NO MY SO
  TRADE TRADES TREND TRENDS TAIL LONG SHORT SELL BUY COVER EXIT TRIM SIGNAL SIGNALS RISK
  BULLISH BEARISH NEUTRAL MACRO ETF ETFS`.split(/\s+/));
const REPORT_SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const REPORT_SENTENCE_MEMO = Symbol('captured-report-sentences');

function reportContextTickers(text, subject) {
  return [...new Set((text.match(/\$?\b[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z]{1,2})?\b/g) || [])
    .filter(ticker => ticker === subject || ticker.startsWith('$') || ticker.length > 1 && !REPORT_CONTEXT_WORDS.has(ticker))
    .map(ticker => ticker.replace(/^\$/, '')))];
}

function sourceReportContext(event, content, sentenceMemo) {
  const { report } = sourceActionEvidence(event);
  if (!report) return [];
  // These are extracts from this publication, not independent current signals.
  // Indexed email text retains summary paragraphs, bullets, and coaching notes.
  const sections = [report.summary, report.summaryText,
    ...(Array.isArray(report.bulletPoints) ? report.bulletPoints : []), report.bodyText];
  const subject = String(event.matchedText && event.matchType === 'structured_membership' ? event.matchedText : event.entityId || '').toUpperCase();
  const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const alreadyShown = [content.sourceSummary, content.detail, report.title].map(normalize).filter(Boolean);
  const seen = new Set();
  // A single attention scan may inspect one exact report for many holdings.
  // Share only sentence boundaries; subject relevance and provenance stay local.
  let sentences;
  if (sentenceMemo) {
    sentences = sentenceMemo.get(REPORT_SENTENCE_MEMO);
    if (!sentences) sentenceMemo.set(REPORT_SENTENCE_MEMO, sentences = new Map());
  }
  const segment = line => {
    if (sentences?.has(line)) return sentences.get(line);
    const values = [...REPORT_SENTENCES.segment(line)].map(item => item.segment);
    sentences?.set(line, values);
    return values;
  };
  const candidates = sections.filter(section => typeof section === 'string')
    .flatMap(section => section.split(/\r?\n+/))
    .flatMap(segment)
    .map(text => text.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/^\s*(?:summary|coaching notes|context|notes):\s*/i, '').replace(/\s+/g, ' ').trim())
    .filter(text => {
      const key = normalize(text);
      if (text.length > 320 || text.split(/\s+/).length < 6 || /https?:\/\/|\b(?:subscribe|unsubscribe|copyright)\b/i.test(text)
          || seen.has(key) || alreadyShown.some(existing => existing.includes(key) || key.includes(existing))) return false;
      seen.add(key);
      return true;
    })
    .map((text, order) => {
      const tickers = reportContextTickers(text, subject);
      const direct = tickers.includes(subject);
      const relationship = /\b(?:hedg(?:e|es|ed|ing)|exposure|correlat(?:ed|ion)|outperform\w*|underperform\w*|compared|versus|relative to)\b/i.test(text);
      const signal = /\b(?:bullish|bearish|neutral)\b.*\b(?:trade|trend|setup|signal)\b|\b(?:trade|trend|signal)\b.*\b(?:bullish|bearish|neutral|support|resistance|broke|broken|breaking|changed|unchanged)\b/i.test(text);
      const rationale = /\b(?:because|while|with|after|alongside|despite|due to|following)\b/i.test(text)
        && /\b(?:squeeze|bounc\w*|rall\w*|gains?|green|red|selloff|strength|weakness|earnings|growth|demand)\b/i.test(text);
      // A bare ticker roster or generic portfolio coaching does not explain this
      // alert. A specific market observation can supply its report-wide context.
      const relevant = tickers.length && (relationship || signal || rationale)
        && !(!direct && /\b(?:unrelated|separately|elsewhere|for example)\b/i.test(text));
      return { text, tickers, relevant, score: Number(direct) * 2 + Number(relationship), order };
    })
    .filter(candidate => candidate.relevant)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some(previous => candidate.tickers.every(ticker => previous.tickers.includes(ticker)))) continue;
    selected.push(candidate);
    if (selected.length === 2) break;
  }
  return selected.map(({ text }) => text);
}

function sourceActionPresentation(payload, event, sourceLabel) {
  const context = payload.alertContext;
  if (context?.kind !== 'source-action' || event.qualityStatus !== 'validated') return null;
  const { action, instruction } = sourceActionEvidence(event);
  const actions = {
    BUY: { label: 'Buy', tone: 'positive' },
    'BUY-SOME': { label: 'Buy some', tone: 'positive' },
    ADD: { label: 'Add to the position', tone: 'neutral' },
    INCREASE: { label: 'Increase the position', tone: 'neutral' },
    SHORT: { label: 'Add short exposure', tone: 'negative' },
    'SELL-SHORT': { label: 'Sell short', tone: 'negative' },
    HOLD: { label: 'Hold the position', tone: 'neutral' },
    'NO-CHANGE': { label: 'No change', tone: 'neutral' },
    SELL: { label: 'Sell', tone: 'negative' },
    'SELL-SOME': { label: 'Sell some', tone: 'negative' },
    COVER: { label: 'Close the short position', tone: 'neutral' },
    'COVER-SOME': { label: 'Close part of the short position', tone: 'neutral' },
    EXIT: { label: 'Exit the position', tone: 'neutral' },
    TRIM: { label: 'Reduce the position', tone: 'neutral' },
    REDUCE: { label: 'Reduce the position', tone: 'neutral' },
    'ROSTER-REMOVAL': { label: 'Removed from the source roster', tone: 'neutral' },
  };
  const description = actions[action];
  const attributedSource = publisherLabel(event, payload.citation, sourceLabel);
  const side = context.recordedPosition?.side;
  let detail = '';
  if (['LONG', 'SHORT'].includes(side)) {
    if (action === 'SELL-SOME' && side === 'SHORT') detail = 'Sell instruction applies to long positions.';
    else if (['COVER', 'COVER-SOME'].includes(action) && side === 'LONG') detail = 'Cover instruction applies to short positions.';
    else if (action === 'ROSTER-REMOVAL') detail = 'Removed from the source roster.';
  }
  if (action === 'SELL-SOME' && side === 'LONG' && /\bBullish\s+TRENDs?\b/i.test(instruction)) {
    detail = 'Trend remains bullish.';
  }
  const headlineParts = description
    ? [{ text: description.label, tone: description.tone }]
    : [{ text: 'Source action details unavailable', tone: 'neutral' }];
  return {
    headline: headlineParts.map(part => part.text).join(''),
    headlineParts,
    updateLabel: description ? 'Action' : 'Signal',
    updateParts: headlineParts,
    tone: description?.tone || 'neutral',
    detail,
    sourceSummary: instruction,
    sourceLabel: attributedSource,
    publicationDate: context.changedAt,
  };
}

function opposingTradeContext(finding, findings) {
  const payload = finding.payload || finding;
  const side = payload.alertContext?.recordedPosition?.side;
  if (!['LONG', 'SHORT'].includes(side)) return null;
  const symbol = finding.symbol || payload.symbol;
  const candidates = findings.filter(peer => (peer.symbol || peer.payload?.symbol) === symbol)
    .map(peer => peer.payload || peer)
    .filter(peer => peer.alertContext?.kind === 'signal-transition' && peer.alertContext.recordedPosition?.side === side)
    .map(peer => ({ payload: peer, event: peer.alertContext.latestEvent || peer.event }))
    .filter(peer => peer.event?.qualityStatus === 'validated' && peer.event.entityId === symbol && typedAnalystSignal(peer.event)?.field === 'trade' && Number.isFinite(Date.parse(peer.event.publishedAt)))
    .filter(peer => peer.event.matchType !== 'structured_membership' || !peer.event.matchedText || peer.event.matchedText === peer.event.entityId)
    .sort((a, b) => Date.parse(b.event.publishedAt) - Date.parse(a.event.publishedAt));
  const latest = candidates[0];
  const signal = latest && typedAnalystSignal(latest.event);
  if (!signal || signal.value === (side === 'LONG' ? 'BULLISH' : 'BEARISH')) return null;
  if (candidates.some(peer => Date.parse(peer.event.publishedAt) === Date.parse(latest.event.publishedAt) && typedAnalystSignal(peer.event).value !== signal.value)) return null;
  const date = reportDate(latest.event.publishedAt);
  return {
    detail: `${publisherLabel(latest.event, latest.payload.citation, latest.event.productLabel || 'The source')} reported ${SIGNAL_LABELS[signal.value]} Trade on ${date}. Your Trade rule takes priority over Trend sizing.`,
    link: { label: `${date} Trade source`, citation: latest.payload.alertContext.latestCitation || latest.payload.citation },
  };
}

function portfolioImplication(payload, signal, previous, sourceInstrument) {
  const position = payload.alertContext?.recordedPosition;
  if (!signal || !previous || !['LONG', 'SHORT'].includes(position?.side)) return '';
  const side = position.side.toLowerCase();
  const aligned = position.side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const alignedLabel = SIGNAL_LABELS[aligned];
  if (sourceInstrument) {
    const direction = signal.value === aligned ? 'now supports' : previous.value === aligned ? 'no longer supports'
      : signal.value === 'NEUTRAL' ? 'has moved less strongly against' : 'has moved further against';
    return `${sourceInstrument} ${direction} your ${side} position. This is an index proxy; check ${payload.symbol || payload.event.entityId}’s own Trade signal before changing size.`;
  }
  if (signal.field === 'trade') {
    if (signal.value === aligned) return `Trade supports your ${side} position again. Size still depends on Trend and your minimum/maximum limits.`;
    const rule = position.side === 'SHORT' ? 'cover' : 'exit';
    if (previous.value === aligned) return `Trade ${signal.value === 'NEUTRAL' ? 'no longer supports' : 'now opposes'} your ${side} position. A confirmed loss of Trade support triggers your ${rule} rule.`;
    return `${signal.value === 'NEUTRAL' ? 'Trade is less adverse but still does not support' : 'Trade has weakened further for'} your ${side} position. Your ${rule} rule is tied to the confirmed loss of Trade support, which was already absent in the earlier report.`;
  }
  if (signal.value === aligned) return `Trend now supports your ${side} position. Size still depends on ${alignedLabel} Trade and your minimum/maximum limits.`;
  if (previous.value === aligned) return `Your ${side} position lost Trend support. If Trade is ${alignedLabel}, your process calls for your minimum size.`;
  const direction = signal.value === 'NEUTRAL' ? 'Trend is less adverse' : 'Trend has weakened further';
  return `${direction} for your ${side} position. If Trade is ${alignedLabel}, both ${SIGNAL_LABELS[previous.value]} and ${SIGNAL_LABELS[signal.value]} Trend call for your minimum size.`;
}

function proxyAttribution(event, sourceInstrument) {
  if (!sourceInstrument) return null;
  let sourceName = null;
  const excerpt = String(event.excerpt || '').trim();
  // A source row can name the index behind a mapped holding. Only use its
  // structured name when that row explicitly identifies the signal instrument.
  const prefix = `${sourceInstrument}:`;
  try {
    const prefixed = excerpt.startsWith(prefix);
    const source = JSON.parse(prefixed ? excerpt.slice(prefix.length).trim() : excerpt);
    const ticker = String(source?.ticker || source?.symbol || '').toUpperCase();
    if ((prefixed || ticker === sourceInstrument) && typeof source?.originalName === 'string') {
      const name = source.originalName.trim().replace(/\s+/g, ' ');
      if (name && name.length <= 100) sourceName = name;
    }
  } catch { /* Retain the evidenced source symbol when its name is unavailable. */ }
  return { sourceSymbol: sourceInstrument, sourceName, holdingSymbol: event.entityId };
}

function transitionPresentation(payload, event, signal, previous, sourceLabel) {
  const context = payload.alertContext;
  if (context?.kind !== 'signal-transition' || !signal || !previous) return null;
  const sourceInstrument = event.matchType === 'structured_membership'
    && /^[A-Z0-9.^_-]{1,24}$/.test(event.matchedText || '') && event.matchedText !== event.entityId
    ? event.matchedText : null;
  const changed = reportDate(context.changedAt);
  const before = reportDate(context.previousAt);
  const latest = reportDate(context.lastConfirmedAt);
  const confirmedLater = context.lastConfirmedAt !== context.changedAt && latest !== changed;
  const headlineParts = signalHeadlineParts(signal, previous, sourceInstrument);
  return {
    headline: headlineParts.map(part => part.text).join(''),
    headlineParts,
    ...signalUpdatePresentation(signal, previous, sourceInstrument),
    ...(sourceInstrument ? { proxyAttribution: proxyAttribution(event, sourceInstrument) } : {}),
    changeSummary: `First reported ${changed}, after ${SIGNAL_LABELS[previous.value]} on ${before}.${confirmedLater ? ` Confirmed ${SIGNAL_LABELS[signal.value]} ${latest}.` : ''}`,
    detail: portfolioImplication(payload, signal, previous, sourceInstrument),
    sourceLabel: publisherLabel(event, payload.citation, sourceLabel),
    publicationDate: context.changedAt,
    sourceLinks: [
      { label: `${before} source`, citation: context.previousCitation },
      { label: `${changed} source`, citation: payload.citation },
      ...(confirmedLater ? [{ label: `${latest} source`, citation: context.latestCitation }] : []),
    ].filter(link => link.citation),
  };
}

// Findings are dated research observations. A current value alone is not evidence
// of a change, and acknowledgment/holdings state is not part of the alert copy.
function describeAnalystFinding(finding = {}, findings = [], now = Date.now(), sentenceMemo) {
  const payload = finding.payload || finding;
  const event = payload.event || {};
  const citation = payload.citation || {};
  const action = payload.action || finding.action;
  const signal = event.qualityStatus === 'validated' ? typedAnalystSignal(event) : null;
  const previous = signal ? priorSignal(event, signal, payload.alertContext?.kind === 'signal-transition' ? [] : findings) : null;
  const signalParts = signal ? signalHeadlineParts(signal, previous) : null;
  const signalLabel = signalParts?.map(part => part.text).join('');
  const content = {
    currentPosition: currentPosition(payload, now),
    headline: action === 'signal change' ? signalLabel || 'Signal details unavailable'
      : event.qualityStatus !== 'validated' ? 'Source action details unavailable' : ACTION_HEADLINES[action] || signalLabel || 'Research update',
    detail: '',
    sourceLabel: event.productLabel || citation.title || 'Research',
    publicationDate: event.marketDate || citation.publicationDate || event.publishedAt || payload.publicationTime || null,
    tone: action === 'signal change' && signal ? SIGNAL_TONES[signal.value] : 'neutral',
  };
  content.headlineParts = content.headline === signalLabel ? signalParts : [{ text: content.headline, tone: content.tone }];
  Object.assign(content, content.headline === signalLabel
    ? signalUpdatePresentation(signal, previous)
    : { updateLabel: event.qualityStatus === 'validated' && ACTION_HEADLINES[action] ? 'Action' : 'Signal', updateParts: content.headlineParts });
  const result = { ...content, ...transitionPresentation(payload, event, signal, previous, content.sourceLabel), ...sourceActionPresentation(payload, event, content.sourceLabel) };
  const trade = payload.alertContext?.kind === 'signal-transition' && signal?.field === 'trend' ? opposingTradeContext(finding, findings) : null;
  if (trade) {
    const lead = result.detail.split('. ')[0].replace(/\.$/, '');
    result.detail = `${lead ? `${lead}. ` : ''}${trade.detail}`;
    if (trade.link.citation) result.sourceLinks = [...(result.sourceLinks || []), trade.link];
  }
  const sourceContext = sourceReportContext(event, result, sentenceMemo);
  if (sourceContext.length) result.sourceContext = sourceContext;
  result.currentHolding = currentPortfolioWeight(payload, result.currentPosition, now);
  result.positionAction = positionSizeAction(payload, event, result.currentPosition, result.currentHolding);
  return result;
}

module.exports = { describeAnalystFinding, typedAnalystSignal, sourceActionEvidence };
const { publishedTradeFromEvent } = require('./publishedResearchSignals.cjs');
