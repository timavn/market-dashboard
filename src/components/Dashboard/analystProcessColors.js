import { isReviewMarkdown } from './analystReviewMarkdown';
import { portfolioReviewTickers, portfolioTickerRanges, portfolioTopicTitle, portfolioNamedSecurityMentions, portfolioCompanyNameRanges } from '../../utils/portfolioReviewTypography';
import { presentAnalystReportDates } from '../../utils/analystReportDates';
import { analystReportHighlightRanges } from '../../utils/analystReportHighlights';

// Presentation of reported facts only. Eligibility still belongs to the
// process engine: Trade breaks EXIT; Trend breaks BENCH; missing inputs block
// actions. A bearish signal can support an aligned short position.
const STATES = {
  ready: 'positive', healthy: 'positive', verified: 'positive', live: 'positive',
  aligned: 'positive', qualified: 'positive',
  partial: 'caution', pending: 'caution', incomplete: 'caution', blocked: 'caution',
  withheld: 'caution', 'sizing withheld': 'caution', 'action blocked': 'caution',
  conflict: 'caution', watch: 'caution', 'no qualifying lines': 'caution',
  failed: 'negative', error: 'negative', unhealthy: 'negative',
  breached: 'negative', 'margin call': 'negative',
};
const MISSING = /\b(?:unavailable|missing|unverified|stale|offline|disconnected|cache[- ]only|cached[- ]disconnected|mock|seed(?:ed)?|not (?:supplied|verified|live|available))\b/i;
const WITHHELD = /\b(?:withheld|blocked)\b/i;
const SIGNAL_FIELD = /^(?:(?:tick|trade|trend)(?: signal| direction)?|trade (?:&|and|\/) trend|risk range, trade & trend|signal|direction|bias)$/;
const SHORTEST_SIGNAL_LABEL = /\b(?:Tick|HedgAI)\s*:/i;
const STATE_FIELD = /^(?:status|state|outcome|.* status|margin health|position marks|mark|native (?:book|order book)|live reference|independent .*cross-check|process action|conflict)$/;
const normalize = value => String(value || '').trim().toLowerCase().replaceAll('_', ' ').replace(/[.]$/, '');
const textOf = node => node.value ?? (node.children || []).map(textOf).join('');

const DIRECTION_TONES = { long: 'positive', bullish: 'positive', short: 'negative', bearish: 'negative', neutral: 'muted', wait: 'muted', 'risk on': 'positive', 'risk off': 'negative' };
const POSITION_FIELD = /\b(?:side|position|exposure|holding|bias|direction)\b/i;
const QUAD_CONTEXT = /\b(?:quad(?:[ \t]*[1-4]|(?:rants?)?s?)|regime|macro|growth|inflation|deflation|disinflation|reflation|stagflation|goldilocks)\b/i;
const ORDINARY_SIDE_SUFFIX = /^(?:[\s\u2010-\u2015-]+)(?:term|run|horizon|duration|dated|range|haul|cycle|time|summary|summaries|history|histories|report|reports|note|notes|list|lists|answer|answers|explanation|paragraph|sentence|story|stories|version|period|periods|way|ways|wait|while|ago|form|format|read|reads|of|enough)\b/i;
const POSITION_SUFFIX = /^(?:[\s\u2010-\u2015-]+)(?:positions?|positioning|exposure|book|bias|side|holdings?|inventory|allocation|sleeve|legs?|trades?|signals?|market value|sales?|selling|sellers?|interest|cover|thesis|setups?|candidates?|equities|stocks?|bonds?|ETFs?|futures|options?|dollars?|gold|silver|bitcoin|crypto|duration risk)\b/i;
const POSITION_PREFIX = /\b(?:held|hold|holding|holds|stay|stays|staying|remain|remains|remaining|currently|net|gross|existing|current|additional|open|opened|opening|establish|go|going|went|enter|entered|maintain|maintaining|favor|favors|cover|covered|covering|add|added|adding|reduce|reducing|trim|trimming|close|closed|closing|exit|exiting)\s+(?:(?:a|an|the|your|our|its|their)\s+)?$/i;

function isPositionDirection(text, match, context) {
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  if ((/^(?:long|short)$/i.test(match[0]) && ORDINARY_SIDE_SUFFIX.test(after)) || /\b(?:as|so|how|too|very)\s+$/i.test(before)) return false;
  if (/^\s*Last known (?:Long|Short)\s*$/i.test(text)) return true;
  if ([...text.matchAll(/\blong and short of\b/gi)].some(phrase => match.index >= phrase.index && match.index < phrase.index + phrase[0].length)) return false;
  if (/^(?:\s*(?:longs?|shorts?|bullish|bearish|neutral)[\s|,/→↔&—–-]*)+$/i.test(text)) return true;
  if (POSITION_SUFFIX.test(after) || POSITION_PREFIX.test(before)) return true;
  if (/^\s+(?:is|remains?|stays?)\s+(?:bullish|bearish|neutral|aligned)\b/i.test(after)) return true;
  if (/\b\$?[A-Z][A-Z\d.]{0,7}\s*\(\s*(?:currently\s+)?$/.test(before)) return true;
  if (/\b\$?\^?[A-Z][A-Z\d]*(?:[./-][A-Z\d]+)*\s*,\s*$/.test(before)
    && /^\s+[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*:/.test(after)) return true;
  if (/^\s+(?:in\s+)?\$?[A-Z][A-Z\d.]{0,7}\b/.test(after)) return true;
  if (/\b(?:longs?|shorts?)\s*(?:to|→|↔|\/|versus|vs\.?|and|or)\s*$/i.test(before)
    || /^\s*(?:to|→|↔|\/|versus|vs\.?|and|or)\s*(?:longs?|shorts?)\b/i.test(after)) return true;
  if (SHORTEST_SIGNAL_LABEL.test(text)) return true;
  return POSITION_FIELD.test(context) || SIGNAL_FIELD.test(normalize(context)) || /^\s*(?:current position|side|position|exposure|holding|bias|direction)\s*:/i.test(text);
}

function isQuadAbbreviation(text, match, context) {
  const before = text.slice(Math.max(0, match.index - 100), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 100);
  // Q1 also names a fiscal quarter. Only macro/regime evidence establishes a
  // quad; an earnings or calendar-quarter label must keep its ordinary text.
  if (/\b(?:fiscal|calendar|earnings|revenue|EPS|quarters?)\b/i.test(`${context} ${before}${after}`)
    || /\b(?:FY\s*\d{2,4}|(?:19|20)\d{2})\s*$/i.test(before)
    || /^\s*(?:FY\s*\d{2,4}|(?:19|20)\d{2}|earnings|revenue|results|EPS|quarter)\b/i.test(after)) return false;
  return QUAD_CONTEXT.test(context) || QUAD_CONTEXT.test(`${before}${after}`);
}

// Shared by Markdown reports and structured report fields. These spans label
// the author's explicit words only; they never establish a signal or quote.
export function analystSemanticRanges(value, context = '') {
  const text = String(value ?? '');
  const protectedRanges = [...text.matchAll(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+|`+[^`]*`+/gi)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
  return [...text.matchAll(/\b(?:bullish|bearish|neutral|wait|longs?|shorts?|risk[ \t\u00a0\u2010-\u2015-]+(?:on|off)|quad[ \t]*[1-4]|q[1-4])\b/gi)].flatMap(match => {
    const start = match.index;
    const end = start + match[0].length;
    if (protectedRanges.some(range => start < range.end && end > range.start)) return [];
    const word = match[0].toLowerCase().replace(/^(long|short)s$/, '$1').replace(/^risk[ \t\u00a0\u2010-\u2015-]+/, 'risk ');
    if (word === 'wait' && !/^\s*Wait(?:\s*[·,;]|\s*$)/.test(text)
      && !/^\s*Last known Wait\s*$/i.test(text)
      && !SHORTEST_SIGNAL_LABEL.test(text) && !POSITION_FIELD.test(context) && !SIGNAL_FIELD.test(normalize(context))) return [];
    if (/^(?:long|short)$/.test(word) && !isPositionDirection(text, match, context)) return [];
    if (/^q[1-4]$/.test(word) && !isQuadAbbreviation(text, match, context)) return [];
    if (/^q/.test(word) && /^[.,]\d/.test(text.slice(end))) return [];
    return [{ start, end, tone: DIRECTION_TONES[word] || `quad-${word.at(-1)}` }];
  });
}

function amountOf(value) {
  const text = String(value).trim();
  if (!/^(?:[+−-]?\$?|\$[+−-]?)[\d,]+(?:\.\d+)?%?$/.test(text)) return null;
  const number = Number(text.replace(/[$,%]/g, '').replace('−', '-'));
  return Number.isFinite(number) ? number : null;
}

export function analystFieldTone(label, value) {
  const field = normalize(label);
  const state = normalize(value);
  // Placeholders apply to any metric, including an unavailable dollar value.
  if (/^(?:(?:unavailable|unknown|not supplied|not available|n\/a)\b|—$)/.test(state)) return 'muted';
  if (STATE_FIELD.test(field) || SIGNAL_FIELD.test(field)) {
    if (WITHHELD.test(state)) return 'caution';
    if (MISSING.test(state) || /\bnot\b/.test(state)) return 'muted';
    if (STATES[state]) return STATES[state];
  }
  if (/^trade(?: signal)?$/.test(field) && state === 'broken') return 'negative';
  if (/^trend(?: signal)?$/.test(field) && state === 'broken') return 'caution';
  if (field === 'process action') {
    if (/^(?:exit|trim)(?:$| — )/.test(state)) return 'negative';
    if (/^(?:bench|reduce to bench|watch)(?:$| — )/.test(state)) return 'caution';
    if (/^(?:aligned|add|open)(?:$| — )/.test(state)) return 'positive';
  }
  if (field === 'conflict') {
    if (/\btrade (?:break|opposes held)\b/.test(state)) return 'negative';
    if (/\btrend (?:break|opposes held)\b/.test(state)) return 'caution';
  }
  if (field === 'position marks') {
    const coverage = state.match(/^(\d+) of (\d+) verified$/);
    if (coverage) {
      const [, verified, total] = coverage.map(Number);
      if (!total || verified > total) return 'muted';
      return verified === total ? 'positive' : 'caution';
    }
  }
  const amount = amountOf(value);
  if (amount !== null) {
    if (/^(?:daily|unrealized|realized)?\s*p&l$/.test(field)) return amount > 0 ? 'positive' : amount < 0 ? 'negative' : null;
    if (/^(?:code-computed )?trim requirement(?: to clear the no-borrow condition)?$/.test(field)) return amount > 0 ? 'positive' : amount < 0 ? 'negative' : null;
    if (/^(?:code-computed )?(?:add-long room|(?:policy-)?buffered room)$/.test(field)) return amount > 0 ? 'positive' : amount < 0 ? 'negative' : null;
  }
  return null;
}

function processRanges(text) {
  const fact = text.match(/^([^:\n]{1,100}):\s*([\s\S]+)$/);
  if (fact) {
    const [, label, value] = fact;
    const start = text.length - value.length;
    const tone = analystFieldTone(label, value);
    if (tone) {
      if (amountOf(value) !== null || /^\d+ of \d+ verified$/i.test(value.trim())) return [{ start, end: text.length, tone }];
      // Lifecycle and freshness retain their existing tones without painting
      // a whole explanation, or overriding a separately reported direction.
      return [...value.matchAll(/\b(?:sizing withheld|action blocked|no qualifying lines|not (?:supplied|verified|live|available|qualified)|cached[- ]disconnected|cache[- ]only|unavailable|unknown|missing|n\/a|unverified|stale|offline|disconnected|mock|seed(?:ed)?|withheld|blocked|partial|pending|incomplete|conflict|watch|ready|healthy|verified|live|aligned|qualified|failed|error|unhealthy|breached|margin call|broken|exit|trim|reduce to bench|bench|add|open)\b|—/gi)]
        .filter(match => match[0] !== '—' || value.trim() === '—')
        .map(match => ({ start: start + match.index, end: start + match.index + match[0].length, tone }));
    }
    return [];
  }
  const outcome = text.match(/^(Ready|Partial|Blocked)(?:\s*·\s*[A-Z]{3})?$/i);
  if (outcome) return [{ start: 0, end: outcome[1].length, tone: STATES[outcome[1].toLowerCase()] }];
  if (/^Sizing withheld[.]?$/i.test(text)) return [{ start: 0, end: text.length, tone: 'caution' }];
  return [];
}

function highlight(children, ranges, cursor = { offset: 0 }, companyNames = false) {
  return children.flatMap(node => {
    const start = cursor.offset;
    if (node.type === 'text') {
      cursor.offset += node.value.length;
      const pieces = [];
      let index = 0;
      for (const range of ranges) {
        const from = Math.max(0, range.start - start);
        const to = Math.min(node.value.length, range.end - start);
        if (from >= to) continue;
        if (from > index) pieces.push({ type: 'text', value: node.value.slice(index, from) });
        pieces.push({
          type: companyNames ? 'analystCompanyText' : 'analystProcessText',
          data: { hName: 'span', hProperties: { className: companyNames
            ? ['analyst-company-name', ...(companyNames === 'portfolio' ? ['analyst-portfolio-company'] : [])] : [`analyst-process--${range.tone}`],
            ...(companyNames ? { title: range.name } : {}) } },
          children: [{ type: 'text', value: node.value.slice(from, to) }],
        });
        index = to;
      }
      if (!pieces.length) return [node];
      if (index < node.value.length) pieces.push({ type: 'text', value: node.value.slice(index) });
      return pieces;
    }
    // Color visible link text while preserving its destination and citation
    // metadata. Code, raw HTML and source URLs remain untouched.
    if (node.children && ['strong', 'emphasis', 'delete', 'link', 'linkReference', 'analystProcessText'].includes(node.type)) {
      const children = highlight(node.children, ranges, cursor, companyNames);
      return children.every((child, index) => child === node.children[index]) && children.length === node.children.length
        ? [node] : [{ ...node, children }];
    }
    cursor.offset += textOf(node).length;
    return [node];
  });
}

function uncoveredRanges(range, claimed) {
  return claimed.reduce((pieces, occupied) => pieces.flatMap(piece => {
    if (piece.end <= occupied.start || piece.start >= occupied.end) return [piece];
    return [
      ...(piece.start < occupied.start ? [{ ...piece, end: occupied.start }] : []),
      ...(piece.end > occupied.end ? [{ ...piece, start: occupied.end }] : []),
    ];
  }), [range]);
}

function collectTableTickers(node, tickers) {
  if (node.type === 'table') {
    const headings = (node.children?.[0]?.children || []).map(textOf);
    const index = headings.findIndex(heading => /^(?:ticker|symbol|holding)$/i.test(heading.trim()));
    if (index >= 0) (node.children || []).slice(1).forEach(row => {
      const text = textOf(row.children?.[index] || {});
      portfolioTickerRanges(text, tickers, 'Ticker').forEach(range => tickers.add(text.slice(range.start, range.end).replace(/^\$/, '')));
    });
  } else if (!['code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) {
    (node.children || []).forEach(child => collectTableTickers(child, tickers));
  }
}

function addCapturedCompanyName(names, captured) {
  if (typeof captured?.name !== 'string') return;
  let name = captured.name.trim();
  const ticker = typeof captured.ticker === 'string' ? captured.ticker.trim() : '';
  // A captured label establishes typography only. Keep missing names and
  // ticker/contract metadata plain; never supply a current issuer name.
  if (!/\p{L}/u.test(name) || /^(?:n\/?a|unknown|unavailable)$/i.test(name)
    || /\b(?:name unavailable|name unknown|not supplied|not verified)\b/i.test(name) || name === ticker) return;
  if (ticker && name.endsWith(` (${ticker})`)) name = name.slice(0, -ticker.length - 3).trim();
  if (name.length > 1) names.add(name);
}

function collectTableCompanyNames(node, names) {
  if (node.type === 'table') {
    const headings = (node.children?.[0]?.children || []).map(textOf);
    const nameIndex = headings.findIndex(heading => /^(?:security|company|issuer)(?: name)?$/i.test(heading.trim()));
    const tickerIndex = headings.findIndex(heading => /^(?:ticker|symbol|holding)$/i.test(heading.trim()));
    if (nameIndex >= 0) (node.children || []).slice(1).forEach(row => {
      const name = textOf(row.children?.[nameIndex] || {}).trim();
      const ticker = tickerIndex >= 0 ? textOf(row.children?.[tickerIndex] || {}).trim() : '';
      addCapturedCompanyName(names, { name, ticker });
    });
  } else if (!['code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) {
    (node.children || []).forEach(child => collectTableCompanyNames(child, names));
  }
}

const PREDICTION_NON_TICKERS = new Set('AI API ATR BLS CEO CPI CME EBITDA EBIT EPS ET ETF ETFS FED FOMC FY GDP IBKR IPO LIVE NAV NLV NO PCA PCE PT Q1 Q2 Q3 Q4 SEC TTM UK US USA W L YES YOY YTD'.split(' '));
const SOURCE_LABEL = /^Sources?:\s/i;
const sourceLink = node => (node.type === 'link' && (/^citation:\/\//i.test(node.url || '') || /\bsources?\b/i.test(textOf(node))))
  || node.type === 'linkReference';

function tickerProtectedRanges(node, cursor = { offset: 0 }) {
  const start = cursor.offset;
  if (['code', 'inlineCode', 'html'].includes(node.type) || sourceLink(node)) {
    cursor.offset += textOf(node).length;
    return [{ start, end: cursor.offset }];
  }
  if (!node.children) {
    cursor.offset += textOf(node).length;
    return [];
  }
  return node.children.flatMap(child => tickerProtectedRanges(child, cursor));
}

function collectPortfolioCompanyNames(node, names, tickers) {
  if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
    const value = textOf(node);
    if (SOURCE_LABEL.test(value)) return;
    const protectedRanges = tickerProtectedRanges(node);
    portfolioNamedSecurityMentions(value).forEach(mention => {
      if (!protectedRanges.some(range => mention.start < range.end && mention.end > range.start)) {
        names.add(mention.name);
        tickers.add(mention.ticker);
      }
    });
  } else if (!['code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) {
    (node.children || []).forEach(child => collectPortfolioCompanyNames(child, names, tickers));
  }
}

function inlineSlice(children, from, to, cursor = { offset: 0 }) {
  return children.flatMap(node => {
    const start = cursor.offset;
    const end = start + textOf(node).length;
    cursor.offset = end;
    if (start >= to || end <= from) return [];
    if (from <= start && to >= end) return [node];
    if (node.type === 'text') return [{ ...node, value: node.value.slice(Math.max(0, from - start), Math.min(node.value.length, to - start)) }];
    if (node.children) return [{ ...node, children: inlineSlice(node.children, from, to, { offset: start }) }];
    return [node];
  });
}

function separatePortfolioTopics(node) {
  if (!node.children || ['table', 'blockquote', 'code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) return;
  node.children = node.children.flatMap(child => {
    if (child.type !== 'paragraph') {
      separatePortfolioTopics(child);
      return [child];
    }
    const value = textOf(child);
    const title = portfolioTopicTitle(value);
    const bodyStart = title.length + ' — '.length;
    if (!title || title.includes(':') || !value.slice(bodyStart).trim() || SOURCE_LABEL.test(value)
      || tickerProtectedRanges(child).some(range => range.start < title.length && range.end > 0)) return [child];
    // This changes the display of the legacy title/body join only. Inline
    // evidence links, source destinations and continuation paragraphs retain
    // their captured nodes and original order.
    return [{ type: 'heading', depth: 3,
      data: { hProperties: { className: ['analyst-portfolio-topic'] } },
      children: inlineSlice(child.children, 0, title.length),
    }, { ...child, children: inlineSlice(child.children, bodyStart, value.length) }];
  });
}

function predictionTableContext(headings, row, index) {
  return index > 0 && /^(?:metric|research|signal|reading)$/i.test(headings[0]?.trim())
    ? textOf(row.children?.[0] || {}) : headings[index];
}

function collectPredictionTickers(node, tickers, context = '') {
  if (['paragraph', 'tableCell'].includes(node.type)) {
    const value = textOf(node);
    if (SOURCE_LABEL.test(value)) return;
    const protectedRanges = tickerProtectedRanges(node);
    // Explicit symbol notation contributes typography only. Acronyms in dates,
    // provider labels and economic readings are not security identities.
    const candidates = [...value.matchAll(/\$([A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*)\b|\(([A-Z][A-Z0-9]*(?:[./-][A-Z0-9]+)*)\)/g)];
    if (/^Underlying\b/i.test(context) || /\bUnderlying(?: price)?:/i.test(value)) {
      candidates.push(...value.matchAll(/\b([A-Z]{1,3}[FGHJKMNQUVXZ]\d{1,2})\b/g));
    }
    candidates.forEach(match => {
      const ticker = match[1] || match[2];
      if (!PREDICTION_NON_TICKERS.has(ticker)
        && !protectedRanges.some(range => match.index < range.end && match.index + match[0].length > range.start)) tickers.add(ticker);
    });
  } else if (node.type === 'table') {
    const headings = (node.children?.[0]?.children || []).map(textOf);
    (node.children || []).slice(1).forEach(row => (row.children || []).forEach((cell, index) =>
      collectPredictionTickers(cell, tickers, predictionTableContext(headings, row, index))));
  } else if (!['code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) {
    (node.children || []).forEach(child => collectPredictionTickers(child, tickers, context));
  }
}

export function remarkAnalystProcessColors({ reviewKind, securityTickers = [], securityNames = [] } = {}) {
  return (tree, file) => {
    function presentDates(node, context = '') {
      if (node.type === 'text') node.value = presentAnalystReportDates(node.value);
      else if (node.type === 'inlineCode') {
        // Saved reports sometimes put the account identifier in backticks.
        // Preserve the code element and annotate only this bounded identifier.
        if (/^(?:[UFD]U?\d{5,}|Account\d+)$/.test(node.value) && /\baccount\b/i.test(context)) {
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ['analyst-process--key'] } };
        }
      } else if (!['code', 'html', 'footnoteDefinition'].includes(node.type)) {
        const local = ['paragraph', 'tableCell'].includes(node.type) ? textOf(node) : context;
        (node.children || []).forEach(child => presentDates(child, local));
      }
    }
    presentDates(tree);
    const review = isReviewMarkdown(file?.value) || /^## Review notes\s*$/m.test(String(file?.value));
    const portfolio = reviewKind ? reviewKind === 'portfolio-review'
      : /^#{1,2} Portfolio Review(?:[ \t]+[—–-][ \t]+(?:Ready|Partial|Blocked))?[ \t]*$/m.test(String(file?.value));
    const prediction = reviewKind === 'prediction-markets-review';
    const identities = prediction;
    const tickers = portfolio || identities ? portfolioReviewTickers(portfolio ? { rollup: { securityTickers } } : undefined) : null;
    const companyNames = new Set();
    if (tickers) collectTableTickers(tree, tickers);
    if (identities) collectPredictionTickers(tree, tickers);
    if (portfolio) {
      if (Array.isArray(securityNames)) securityNames.forEach(captured => addCapturedCompanyName(companyNames, captured));
      collectTableCompanyNames(tree, companyNames);
    }
    if (portfolio) {
      collectPortfolioCompanyNames(tree, companyNames, tickers);
      separatePortfolioTopics(tree);
    }
    function visit(node, context = '', allowProcess = review) {
      if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
        const text = textOf(node);
        const protectedRanges = tickerProtectedRanges(node);
        const names = portfolio && !SOURCE_LABEL.test(text)
          ? portfolioCompanyNameRanges(text, companyNames, context).filter(range =>
            !protectedRanges.some(protectedRange => range.start < protectedRange.end && range.end > protectedRange.start)) : [];
        const overlapsName = range => names.some(name => range.start < name.end && range.end > name.start);
        const ranges = analystSemanticRanges(text, context).filter(range => !overlapsName(range));
        if (allowProcess && node.type === 'paragraph') ranges.push(...processRanges(text));
        const outcome = allowProcess && node.type === 'heading' && text.match(/Review [—–-] (Ready|Partial|Blocked)$/i);
        if (outcome) ranges.push({ start: text.length - outcome[1].length, end: text.length, tone: STATES[outcome[1].toLowerCase()] });
        if (tickers) {
          const currencyOutcome = /^(?:Ready|Partial|Blocked)\s*·\s*[A-Z]{3}$/i.test(text);
          const protectedRanges = identities ? tickerProtectedRanges(node) : [];
          (currencyOutcome || (identities && SOURCE_LABEL.test(text)) ? [] : portfolioTickerRanges(text, tickers, context)).forEach(range => {
            if (!ranges.some(existing => range.start < existing.end && range.end > existing.start)
              && !protectedRanges.some(existing => range.start < existing.end && range.end > existing.start)) ranges.push(range);
          });
        }
        if (portfolio) {
          if (node.type === 'heading') {
            node.data = { ...node.data, hProperties: { ...node.data?.hProperties,
              className: [...(Array.isArray(node.data?.hProperties?.className) ? node.data.hProperties.className : []), 'analyst-portfolio-title'],
            } };
            if (node.data.hProperties.className.includes('analyst-portfolio-topic')) {
              ranges.push(...uncoveredRanges({ start: 0, end: text.length, tone: 'title' }, [...ranges, ...names]));
            }
          } else if (node.type === 'paragraph') {
            const title = portfolioTopicTitle(text);
            if (title && !title.includes(':')) ranges.push(...uncoveredRanges({ start: 0, end: title.length, tone: 'title' }, ranges));
          }
        }
        analystReportHighlightRanges(text, context).forEach(range => {
          if (!overlapsName(range) && !ranges.some(existing => range.start < existing.end && range.end > existing.start)) ranges.push(range);
        });
        if (names.length) node.children = highlight(node.children, names, { offset: 0 }, 'portfolio');
        if (ranges.length) node.children = highlight(node.children, ranges.sort((a, b) => a.start - b.start));
      } else if (node.type === 'table') {
        const headings = (node.children?.[0]?.children || []).map(textOf);
        (node.children || []).forEach(row => (row.children || []).forEach((cell, index) =>
          visit(cell, prediction ? predictionTableContext(headings, row, index) : headings[index])));
      } else if (!['code', 'inlineCode', 'html', 'footnoteDefinition'].includes(node.type)) {
        let sectionContext = context;
        (node.children || []).forEach(child => {
          if (child.type === 'heading') sectionContext = textOf(child);
          visit(child, sectionContext, allowProcess && node.type !== 'blockquote');
        });
      }
    }
    visit(tree);
  };
}
