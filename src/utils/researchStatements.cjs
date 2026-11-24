'use strict';

// Signals Hedgeye states in prose: TRADE/TREND directions and Alpha Code
// levels, each bound to the instrument its clause opens with. A statement is
// kept only when the clause names that instrument first, nothing between the
// name and the claim names another instrument or someone else's view, and
// neither the lead-in, the words right after the claim, nor a neighbouring
// clause makes it conditional, negated, approaching, past or superseded.
// A signal named as missing, required, wanted or almost there ("failed to
// establish … a bullish TRADE", "unable to regain bullish trade and trend",
// "almost bullish trend") states no direction at all: not that one, and not its
// opposite (user-specified 2026-11-20).
// Everything else (methodology, hypotheticals, another market's signal) yields
// nothing: a missed statement is a gap, a wrong one becomes a false signal.

const instrumentCatalog = require('../constants/dashboardResearchCatalog.json');
const narrativeCatalog = require('../constants/dashboardNarrativeResearchCatalog.json');
const grammar = require('../constants/researchStatementGrammar.json');

const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DIRECTION = { bullish: 'BULLISH', bearish: 'BEARISH', neutral: 'NEUTRAL' };
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

const FORBIDDEN = new RegExp(grammar.forbidden, 'i');
const CLAIMS = grammar.claims.map((claim) => ({ ...claim, regex: new RegExp(claim.pattern, 'gi') }));
// Words right after a claim that make it conditional or past.
const QUALIFIED_TAIL = new RegExp(String.raw`^(?:\s+(?:signals?|durations?|breakouts?|signal\s+breakout))?[\s,;:(—–…-]*(?:if|unless|provided|as\s+long\s+as|so\s+long\s+as|assuming|barring|should|but\s+only|only\s+if|until|once|when|whenever|prior\s+to|as\s+recently\s+as|for\s+most\s+of|through\s+(?:${MONTHS})|in\s+Q[1-4]|in\s+20\d\d|on\s+(?:${MONTHS})\s+\d|as\s+of\s+(?:last|${WEEKDAYS})|then\s+(?:flipped|moved|went|turned|broke|fell|reversed)|(?:late\s+|early\s+)?last\s+(?:week|month|year|quarter|session|${WEEKDAYS})|this\s+past\s+(?:week|${WEEKDAYS})|on\s+(?:${WEEKDAYS})|yesterday|previously|before|earlier|(?:(?:about|roughly|around|nearly|almost|some|over|more\s+than)\s+)?(?:a|an|one|two|three|four|five|six|several|few|\d+)\s+(?:days?|weeks?|months?|sessions?|years?)\s+ago|ago|versus|vs\.?|back\s+in|during\s+(?!this\b)|at\s+the\s+(?:time|start|end)|intraday|together\s+(?:late\s+|early\s+)?last|in\s+(?:early|late|mid)?-?\s*(?:${MONTHS}))\b`, 'i');
// "… signal was invalidated / lost": the claim names a state that ended.
const ENDED_TAIL = /^\s+(?:signals?\s+)?(?:(?:was|were|has\s+been|had\s+been|got|is|has)\s+)?(?:invalidated|broken|lost|snapped|negated|reversed|ended|expired|failed|over)\b/i;
// A claim that is the state being left ("moved from bearish TREND", "lost its
// bullish TRADE", "broke Bullish TREND support") is not the current state.
const LEFT_BEFORE = /\b(?:from|lost|losing|loses|left|leaving|gave\s+up|giving\s+up|exited|exiting|exits|out\s+of|ended|ending|broke(?:\s+(?:below|under|through|down\s+from))?|breaks|breaking|broken|snapped|reversed|reversing|reverse|invalidated|briefly|momentarily|temporarily)\s+(?:(?:its|the|their|our|a|an|both|@?hedgeye|[a-z]+-term)\s+){0,2}$/i;
// A single-duration claim read as a noun phrase ("a bullish trade idea", "its
// bearish trend", "our favorite bullish trade") is not a signal.
const NOUN_AFTER = /^\s+(?:ideas?|setups?|opportunit(?:y|ies)|candidates?|targets?|levels?|lines?|ranges?|positions?|entr(?:y|ies)|exits?|triggers?|confirmations?|cross(?:es)?|tests?|support|resistance|headlines?|news|data|deals?|wars?|talks|polic(?:y|ies)|tensions|tariffs?|negotiations|desks?|flows?|balance|deficit)\b/i;
// "no bullish TRADE signal", "no confirmed Bearish TREND": the signal is named as missing.
const NEGATED_BEFORE = /\bno\s+(?:[a-z-]+\s+)?$/i;
const DETERMINER_BEFORE = /\b(?:a|an|its|our|your|their|his|her|the|favou?rite|best)\s+(?:[a-z-]+\s+)?$/i;
const SIGNAL_AFTER = /^\s+(?:(?:and\s+trend\s+)?signals?)\b/i;
const VERB_BEFORE = /\bto\s+$/i;
const MISMATCHED_DURATION = { trade: /(?:medium|intermediate|long)[- ]term\s+$/i, trend: /(?:immediate|short)[- ]term\s+$/i };
const BREADTH_BEFORE = /\d+\s*\/\s*\d+\s*=\s*$/;
// "Bearish TRADE and TREND remains Bullish": TREND has its own predicate.
const OWN_PREDICATE_AFTER = /^\s*(?:[:=]|-wise\b|(?:is|remains?|stays?|still|now|over(?:bought|sold)|bullish|bearish|neutral)\b)/i;
// "Bullish/Bearish TRADE/TREND": paired directions, one per duration.
const PAIRED_BEFORE = /\b(?:bullish|bearish|neutral)\s*\/\s*$/i;
const PAIRED_AFTER = /^\s*\/\s*(?:bullish|bearish|neutral)\b/i;
// A later claim in a past-tense relative clause is history, not this subject's state.
const PAST_RELATIVE = /\b(?:which|that|who)\s+(?:was|were|had)\b|\b(?:being|having\s+been)\b/i;
// Someone else's view, a new sentence subject, or a different grammatical
// subject after a comma splice ("…, cryptocurrencies remain bullish trend").
const ATTRIBUTION = /\b(?:according\s+to|consensus|the\s+street|sell[-\s]side|analysts?|strategists?|bulls|bears|says|said|thinks?|believes?)\b/i;
const NEW_SPEAKER = /[\w,]\s+(?:He|She|They|We)\s+[a-z]/;
// After a claim, Keith's own "he said" is Hedgeye; a named outside view is not.
const OUTSIDE_VIEW = /\b(?:according\s+to|consensus|the\s+street|sell[-\s]side|analysts?|strategists?)\b/i;
const UNCONFIRMED = /\b(?:needs?\s+to\s+(?:hold|confirm)|until\s+confirm\w*|unconfirmed|not\s+(?:yet\s+)?confirmed|keep\s+it\s+neutral)\b/i;
const COMMA_SPLICE = /,\s+(?:the\s+)?([a-z][\w-]*(?:\s+[a-z][\w-]*){0,2})\s+(?:remains?|is|are|stays?|was|were)\s+(?:in\s+|on\s+)?$/;
const ANAPHOR = /^(?:it|its|which|the\s+(?:stock|name|company|index|etf|fund)|shares|they)$/;
const LIST_BINDING = /\b(?:former|latter|respectively|except|exception|but\s+not|other\s+than|in\s+that\s+order)\b/i;
const LIST_BINDING_AFTER = /^[^.;]{0,60}\b(?:except|exception|only|in\s+that\s+order)\b|^\W*respectively\b/i;
const MAX_BRIDGE = 160;

// Uppercase words in Hedgeye prose that are vocabulary, not tickers.
const VOCABULARY = new Set(['TRADE', 'TREND', 'TAIL', 'LRR', 'TRR', 'HRR', 'ATH', 'ATHS', 'AI', 'US', 'USA', 'ETF', 'ETFS', 'EDT',
  'EST', 'PDT', 'PST', 'ET', 'PT', 'PM', 'AM', 'MIN', 'MAX', 'BPS', 'BP', 'YOY', 'QOQ', 'MOM', 'YTD', 'MTD', 'QTD', 'WTD', 'EPS',
  'CEO', 'CFO', 'TL', 'DR', 'TLDR', 'I', 'A', 'OK', 'TV', 'CPI', 'PCE', 'PPI', 'GDP', 'FOMC', 'FED', 'ECB', 'BOJ', 'BOE', 'BLS',
  'QE', 'QT', 'RE', 'NOT', 'AND', 'THE', 'OF', 'IN', 'ON', 'TO', 'IS', 'IT', 'AT', 'OR', 'NO', 'SO', 'ALL', 'NEW', 'BUY', 'SELL',
  'LONG', 'SHORT', 'COVER', 'ADD', 'REMOVE', 'WAIT', 'HOLD', 'SIGNAL', 'SIGNALS', 'RISK', 'RISKS', 'RANGE', 'UPDATE', 'NOW', 'MY',
  'WE', 'OUR', 'THIS', 'THAT', 'THESE', 'THOSE', 'ITS', 'FOR', 'TODAY', 'WHEN', 'THEN', 'IF', 'WHAT', 'WHY', 'HOW', 'BIG', 'KEY',
  'TOP', 'UP', 'DOWN', 'BULLISH', 'BEARISH', 'NEUTRAL', 'EQUITIES', 'SOFTWARE', 'COMMODITIES', 'MARKET', 'MARKETS', 'RATES',
  'MACRO', 'QUAD', 'KM', 'RTA', 'SOME', 'BHL', 'BLH', 'LH', 'HL', 'LL', 'HH', 'OI', 'IPO', 'EV', 'AUM', 'NAV', 'SMPL', 'BOTTOM',
  'LINE', 'POSITION', 'CHANGE', 'NOTE', 'ALERT', 'SHOW', 'CALL', 'LOOK', 'EARLY', 'ALPHA', 'CODE', 'CODES', 'VOLUME', 'SUPPLY',
  'DEMAND', 'MOMENTUM', 'SUPPORT', 'RESISTANCE', 'PRO', 'BOND', 'BONDS', 'YIELD', 'YIELDS', 'UST', 'NEXT', 'LAST', 'WEEK',
  'MONTH', 'YEAR', 'FX', 'STOCKS', 'STOCK', 'HY', 'IG', 'EM', 'UK', 'EU', 'TECH', 'CASH', 'BACK', 'STILL', 'CHART', 'RPO', 'ISM',
  'PMI', 'NFP', 'JOLTS', 'STYLES', 'SEMIS', 'OIL', 'EUR', 'GBP', 'JPY', 'CAD', 'CHF', 'CNY', 'AUD', 'NZD', 'MXN', 'INR', 'KRW',
  'BRL', 'BEST', 'WORST', 'HIGH', 'LOW', 'BETA', 'MEGA', 'CAP', 'CAPS', 'GROWTH', 'VALUE', 'CYCLE', 'BOTH', 'ONLY', 'ALSO']);

// Words that name a market without being one of our subjects. A lead-in that
// mentions one is about something else, so its claim is not attributed.
const OTHER_MARKET_WORDS = ['Dollar', 'Yen', 'Euro', 'Pound', 'Sterling', 'Franc', 'Yuan', 'Peso', 'Bonds?', 'Treasur(?:y|ies)',
  'Yields?', 'Stocks', 'Equities', 'Tech', 'Semis', 'Semiconductors', 'Software', 'Oil', 'Crude', 'Gold', 'Silver', 'Copper',
  'Platinum', 'Palladium', 'Bitcoin', 'Ethereum', 'Crypto\\w*', 'Cryptocurrenc(?:y|ies)', 'Mega-?caps?', 'Small\\s+Caps',
  'Large\\s+Caps', 'Nasdaq', 'Russell', 'Dow', 'S&P', 'VIX', 'Volatility', 'Miners', 'Banks', 'Financials', 'Energy', 'Utilities',
  'Staples', 'Healthcare', 'Homebuilders', 'Housing', 'REITs', 'Nikkei', 'KOSPI', 'Natural\\s+Gas', 'Corn', 'Wheat', 'Soybeans',
  'Cocoa', 'Coffee'];
const OTHER_MARKET = new RegExp(`\\b(?:${OTHER_MARKET_WORDS.join('|')})\\b`, 'gi');

function instrumentEntries() {
  const entries = [];
  const add = (identity, text, { caseSensitive = false } = {}) => {
    if (!text) return;
    entries.push({ ...identity, text, caseSensitive });
  };
  instrumentCatalog.forEach((entry) => {
    const identity = { ticker: entry.symbol, kind: 'security' };
    (entry.aliases || []).filter((alias) => /^[$^]?[A-Z0-9][A-Z0-9./=^_-]*$/.test(alias))
      .forEach((alias) => add(identity, alias, { caseSensitive: true }));
    [...(entry.names || []), ...(entry.proseNames || [])].forEach((name) => add(identity, name));
    // "Oil" is WTI in Hedgeye's notes unless the sentence names Brent.
    const ambiguous = entry.ambiguousProseNames;
    (ambiguous?.names || []).forEach((name) => add({ ...identity, unlessMentioned: new RegExp(ambiguous.unlessMentioned, 'i') }, name));
    (entry.publishedReferences || []).filter((reference) => reference.symbol).forEach((reference) => {
      const referenceIdentity = {
        ticker: reference.symbol, kind: 'reference', sourceInstrument: reference.label,
        basisLabel: reference.basisLabel,
        basisRelationship: `Published ${reference.label} signal; ${entry.symbol} is the ${String(entry.names?.[0] || 'futures contract').toLowerCase()}.`,
      };
      add(referenceIdentity, reference.symbol, { caseSensitive: true });
      [...(reference.names || []), ...(reference.proseNames || [])].forEach((name) => add(referenceIdentity, name));
    });
  });
  narrativeCatalog.forEach((entry) => {
    const identity = entry.basisLabel
      ? { ticker: entry.sourceTicker, kind: 'reference', sourceInstrument: entry.sourceInstrument,
        basisLabel: entry.basisLabel, basisRelationship: entry.basisRelationship }
      : { ticker: entry.sourceTicker, kind: 'security', sourceInstrument: entry.sourceInstrument };
    entries.push({ ...identity, pattern: entry.subjectPattern, caseSensitive: false });
    if (entry.basisLabel) entries.push({ ...identity, text: entry.sourceTicker, caseSensitive: true });
  });
  return entries;
}

// One alternation per case mode, longest names first, so "UST 2yr Yield"
// wins over the UST ETF and "Copper Spot Price" over "Copper".
function compileLexicon(entries) {
  const source = (entry) => entry.pattern || escape(entry.text).replace(/ /g, '\\s+');
  const byLength = (left, right) => source(right).length - source(left).length;
  const build = (items, flags) => {
    const sorted = [...items].sort(byLength);
    return { items: sorted, regex: new RegExp(`^(?:[Tt]he\\s+)?(?:${sorted.map((item, index) => `(?<i${index}>${source(item)})`).join('|')})`, flags) };
  };
  return {
    sensitive: build(entries.filter((entry) => entry.caseSensitive), ''),
    insensitive: build(entries.filter((entry) => !entry.caseSensitive), 'i'),
  };
}
const ENTRIES = instrumentEntries();
const LEXICON = compileLexicon(ENTRIES);
const LEXICON_ANYWHERE = new RegExp(`(?<![\\w$])(?:${[...new Set(ENTRIES.filter((entry) => !entry.caseSensitive)
  .map((entry) => entry.pattern || escape(entry.text).replace(/ /g, '\\s+')))].sort((a, b) => b.length - a.length).join('|')})(?![\\w])`, 'gi');
const ALIAS_ANYWHERE = new Set(ENTRIES.filter((entry) => entry.caseSensitive).map((entry) => entry.text));

// After an instrument's name: a word that makes it a different market
// ("S&P 500 futures", "Bitcoin dominance", "Euro area", "Gold Miners").
const CONTINUES_NAME = /^(?:[\w&=]|-\w|\/\w|\s+\d|\s+&\s)/;
const MODIFIER_AFTER = /^\s+(?:futures|transports|area|zone|dominance|related|linked|sensitive|services|vol|volatility|miners|stocks|equities|names|sectors?|producers|complex|etfs?|options|implied|positioning|sentiment|bulls|bears|reserves|demand|supply|inventor(?:y|ies))\b/i;
const NEXT_WORD_ALLOWED = /^\s+(?:TRADE|TREND|Trade|Trend|Alpha|Signal|Index|Yield|Spot|Price|Fractal|Risk\s+Range|Bullish|Bearish|Neutral|BULLISH|BEARISH|NEUTRAL|Hedgeye|@Hedgeye)\b/;
const differentMarketAfter = (rest) => {
  if (CONTINUES_NAME.test(rest)) return true;
  // "Bitcoin’s dominance" is not Bitcoin.
  const next = rest.replace(/^['’]s\b/, '');
  return MODIFIER_AFTER.test(next) || (/^\s+[A-Z]/.test(next) && !NEXT_WORD_ALLOWED.test(next));
};

const IDENTITY_FIELDS = ['ticker', 'kind', 'sourceInstrument', 'basisLabel', 'basisRelationship', 'unlessMentioned'];
const identityOf = (item) => Object.fromEntries(IDENTITY_FIELDS.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));

function lexiconMatch(text) {
  let best = null;
  for (const { regex, items } of [LEXICON.sensitive, LEXICON.insensitive]) {
    const match = regex.exec(text);
    if (!match) continue;
    const index = Object.entries(match.groups).findIndex(([, value]) => value !== undefined);
    const item = items[Number(Object.keys(match.groups)[index].slice(1))];
    // An all-caps word ("DOW", "DRAM") is a ticker, not a prose name ("Dow").
    if (!item.caseSensitive && /^[A-Z]{2,6}$/.test(match[0]) && match[0] !== item.text) continue;
    if (!best || match[0].length > best.length) best = { length: match[0].length, item: { ...identityOf(item), caseSensitive: item.caseSensitive } };
  }
  if (!best || differentMarketAfter(text.slice(best.length))) return null;
  return best;
}
// The catalog identity of a printed code ("WTI" is CL, "GOLD" the gold spot
// reference), else the code itself as a listed security.
function codeIdentity(code) {
  const known = lexiconMatch(code);
  return known?.item.caseSensitive && known.length === code.length ? { ...identityOf(known.item), catalog: true } : { ticker: code, kind: 'security' };
}

// "SpaceX (SPCX)", "Netflix, Inc. (NFLX)", "(NFLX) :", "$TSLA", "MSFT" — an
// uppercase ticker the clause opens with. Vocabulary, lone letters and a name
// that opens with a conditional ("WHEN US Equity Beta (SPY)") are not subjects.
const TICKER = /^(?:((?:[A-Z0-9][\w&.'’-]*(?:,(?=\s+(?:Inc|Corp|Corporation|Ltd|LLC|plc|Co|Company|Holdings|Group)\b))?\s+){0,6})\(\$?([A-Z][A-Z0-9]{0,5}(?:[./][A-Z]{1,2})?)\)|\$?([A-Z][A-Z0-9]{0,5}(?:[./][A-Z]{1,2})?))(?=$|[\s:=,;(’'])/;
const CONDITIONAL_NAME = /\b(?:when|whenever|if|once|while|as|after|before|since|unless)\b/i;
function tickerMatch(text) {
  const match = TICKER.exec(text.replace(/^[Tt]he\s+(?=[A-Z$(])/, ''));
  if (!match) return null;
  const offset = text.length - text.replace(/^[Tt]he\s+(?=[A-Z$(])/, '').length;
  const ticker = match[2] || match[3];
  if (match[1] && CONDITIONAL_NAME.test(match[1])) return null;
  if (VOCABULARY.has(ticker) || ticker.length < 2 && !match[2]) return null;
  const { catalog, ...identity } = codeIdentity(ticker);
  // A parenthetical code after a fund or company name is that listed security.
  const item = match[2] && match[1] && identity.kind === 'reference' ? { ticker, kind: 'security' } : identity;
  if (!match[2] && differentMarketAfter(text.slice(offset + match[0].length))) return null;
  return { length: offset + match[0].length, item };
}

// A possessive or a parenthetical code after the name ("Oil’s (WTI)"). The
// printed code is the instrument unless the catalog names it the same one:
// "Russell 2000 (IWM)" is the ETF, "Gold Spot Price (GOLD)" the spot reference.
const SUBJECT_TAIL = /^(?:['’]s)?(?:\s*\(([A-Z][A-Z0-9./=^-]{0,10})\))?(?:\s*:)?/;
function subjectAt(text) {
  const named = lexiconMatch(text);
  if (named) {
    const tail = SUBJECT_TAIL.exec(text.slice(named.length));
    let identity = identityOf(named.item);
    if (tail[1] && !VOCABULARY.has(tail[1])) {
      const { catalog, ...coded } = codeIdentity(tail[1]);
      if (coded.ticker !== identity.ticker || coded.kind !== identity.kind) {
        // A listed ETF or stock code is the printed instrument; two different
        // catalog instruments ("Yen (USDJPY)", "Corn (ZC)") cannot be told apart.
        if (catalog) return null;
        identity = coded;
      }
    }
    return { length: named.length + tail[0].length, identity };
  }
  const ticker = tickerMatch(text);
  if (!ticker) return null;
  return { length: ticker.length + SUBJECT_TAIL.exec(text.slice(ticker.length))[0].length, identity: ticker.item };
}

// "SPY and QQQ", "Gold, Silver and Copper": every listed instrument shares the claim.
function subjectsAt(text) {
  const first = subjectAt(text);
  if (!first) return null;
  const subjects = [first.identity];
  let offset = first.length;
  for (;;) {
    const joiner = /^\s*(?:,\s*(?:and\s+|&\s+)?|\s+(?:and|&)\s+)/.exec(text.slice(offset));
    if (!joiner) break;
    const next = subjectAt(text.slice(offset + joiner[0].length));
    if (!next) break;
    subjects.push(next.identity);
    offset += joiner[0].length + next.length;
  }
  return { subjects, length: offset };
}

// Discourse openers that leave the clause's subject in place.
const LEAD = new RegExp([
  String.raw`^[•*·▪]\s*`,
  String.raw`^\(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?\)\s*`,
  String.raw`^\d{1,2}\.?\)\s+|^\d{1,2}\.\s+|^[A-H]\)\s+`,
  String.raw`^(?:Real-Time\s+Alert|RTA|UPDATE|POSITION\s+CHANGE|POSITIONING\s+SHIFT|BOTTOM\s+LINE|NOTE)\s*:\s*`,
  String.raw`^(?:And|But|So|Also|Meanwhile|Now|Again|Plus|Still|Then|Yet|Globally|Evidently|Separately|Elsewhere|Overall|Currently|Internationally|Notably|Later|Obviously),?\s+`,
  String.raw`^On\s+the\s+[\w-]+\s+side,?\s+`,
  String.raw`^(?:He|She|Keith|McCullough|Hedgeye|The\s+desk|the\s+desk)\s+(?:(?:also|again|explicitly|further)\s+)?(?:said|noted|added|stressed|reiterated|highlighted|explained|pointed\s+out|confirmed|stated|identified|described|cited)(?:\s+that)?\s+`,
  String.raw`^[Bb]oth\s+(?=[A-Z$(])`,
  String.raw`^[Oo]ur\s+(?=[A-Z$(])`,
].join('|'));
function stripLead(text) {
  let current = text;
  for (let guard = 0; guard < 5; guard += 1) {
    const match = LEAD.exec(current);
    if (!match || !match[0]) break;
    current = current.slice(match[0].length);
  }
  return current;
}

const ABBREVIATIONS = /(?:\b(?:Inc|Corp|Co|Cos|Ltd|Bros|Hldgs|Grp|Intl|Mfg|vs|etc|Dr|Mr|Mrs|Ms|Jr|Sr|St|No|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e)|\b(?:[A-Z]\.){1,3}[A-Z]?)\.$/;
/** Sentences, kept whole across "Inc.", "vs." and "U.S." and across a hard line wrap. */
function sentences(text) {
  // A line that does not end a sentence continues on a next line that opens in lowercase.
  const lines = String(text || '').replace(/\r/g, '').split('\n').reduce((joined, line) => {
    const previous = joined.at(-1);
    const wrapped = !/[.!?:;…”"'’)\]]\s*$/.test(previous || '') && /^\s*[a-z]/.test(line);
    if (previous !== undefined && previous.trim() && (wrapped || ABBREVIATIONS.test(previous.trim()))) {
      joined[joined.length - 1] = `${previous} ${line.trim()}`;
    } else joined.push(line);
    return joined;
  }, []);
  const result = [];
  for (const line of lines) {
    let start = 0;
    const boundary = /[.!?…]["”’)]*\s+(?=[A-Z0-9(#$@“"‘•*₿–—-])/g;
    let match;
    while ((match = boundary.exec(line))) {
      const candidate = line.slice(start, match.index + 1);
      if (ABBREVIATIONS.test(candidate.trim())) continue;
      result.push(line.slice(start, match.index + match[0].trimEnd().length));
      start = match.index + match[0].length;
    }
    result.push(line.slice(start));
  }
  return result.map((sentence) => sentence.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
/** Clauses of a sentence: semicolons, spaced dashes, pipes, bullets and lettered items separate statements. */
const CLAUSE_BREAK = /(\s*;\s*|\s+[–—|]\s+|\s+-{1,2}\s+|\s+[•▪]\s+|,?\s+(?:and\s+)?(?=[A-H]\)\s))/;
// "…, while the S&P itself is bearish trade and trend": a while-clause that opens with a
// market is that market's own statement. "Bearish TRADE while bullish TREND" stays whole.
const WHILE = /,?\s+while\s+/g;
function whileClauses(part) {
  const result = [];
  let start = 0;
  for (const match of part.text.matchAll(WHILE)) {
    const rest = part.text.slice(match.index + match[0].length);
    if (!subjectsAt(rest)) continue;
    result.push({ text: part.text.slice(start, match.index).trim(), after: result.length ? 'while' : part.after });
    start = match.index + match[0].length;
  }
  result.push({ text: part.text.slice(start).trim(), after: result.length ? 'while' : part.after });
  return result.filter((clause) => clause.text);
}
function clauses(sentence) {
  const parts = sentence.split(CLAUSE_BREAK);
  const result = [];
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index].trim();
    if (text) result.push(...whileClauses({ text, after: (parts[index - 1] || '').trim() }));
  }
  return result;
}
// A neighbouring clause that makes this one conditional ("If the Fed cuts –
// Gold is bullish TRADE", "Gold is bearish TRADE – unless it holds $2,400").
// A semicolon joins independent statements, so only a dash carries a condition forward.
const CONDITIONAL_NEXT = /^(?:if|unless|provided|until|as\s+long\s+as|once|when|whenever)\b/i;
const CONDITIONAL_PREVIOUS = /^(?:if|unless|provided|assuming|whenever|when|once|should|in\s+(?:a|an|the)\s+[^,]{0,60}\bscenario)\b/i;

function claimsIn(text) {
  const found = [];
  CLAIMS.forEach((claim, order) => {
    claim.regex.lastIndex = 0;
    let match;
    while ((match = claim.regex.exec(text))) {
      const fields = {};
      const direction = (group) => { const word = match[group].toLowerCase(); return DIRECTION[claim.values?.[word] || word]; };
      if (claim.trade) fields.trade = direction(claim.trade);
      if (claim.trend) fields.trend = direction(claim.trend);
      found.push({ start: match.index, end: match.index + match[0].length, fields, order, form: claim.form, text: match[0] });
    }
  });
  found.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start) || left.order - right.order);
  const taken = [];
  for (const claim of found) if (!taken.some((other) => claim.start < other.end && other.start < claim.end)) taken.push(claim);
  return taken.sort((left, right) => left.start - right.start);
}

// A lead-in names another market when a catalog name, a market word or an
// uppercase ticker that is not the subject's own appears in it.
function namesOtherInstrument(text, subjects) {
  const own = new Set(subjects.map((subject) => subject.ticker));
  for (const named of [...text.matchAll(LEXICON_ANYWHERE), ...text.matchAll(OTHER_MARKET)]) {
    const identity = lexiconMatch(named[0]);
    if (!identity || !own.has(identity.item.ticker)) return true;
  }
  for (const token of text.match(/(?<![\w$])\$?[A-Z][A-Z0-9]{1,5}(?![\w])/g) || []) {
    const ticker = token.replace(/^\$/, '');
    if (VOCABULARY.has(ticker) || own.has(codeIdentity(ticker).ticker)) continue;
    if (ALIAS_ANYWHERE.has(ticker) || /^[A-Z]{2,5}$/.test(ticker)) return true;
  }
  return [...text.matchAll(/\(\$?([A-Z]{1,6})\)/g)].some((match) => !own.has(codeIdentity(match[1]).ticker));
}
// The words after "for|on|in" open with another market ("bullish TREND for Gold").
function namesMarketFirst(text, subjects) {
  const own = new Set(subjects.map((subject) => subject.ticker));
  const named = lexiconMatch(text);
  if (named) return !own.has(named.item.ticker);
  if (new RegExp(`^(?:${OTHER_MARKET_WORDS.join('|')})\\b`, 'i').test(text)) return true;
  const ticker = /^\$?([A-Z][A-Z0-9]{1,5})\b/.exec(text)?.[1];
  return Boolean(ticker && !VOCABULARY.has(ticker) && !own.has(codeIdentity(ticker).ticker));
}
// The lead-in hands the claim to someone or something else.
function handsOff(bridge) {
  if (ATTRIBUTION.test(bridge) || NEW_SPEAKER.test(bridge)) return true;
  const splice = COMMA_SPLICE.exec(bridge);
  return Boolean(splice && !ANAPHOR.test(splice[1]));
}

// The listed subjects a lead-in names again ("Solana and Ethereum … with
// Ethereum described as bearish"): the claim is only about those.
function renamedSubjects(text, subjects) {
  const own = new Set(subjects.map((subject) => subject.ticker));
  const named = new Set();
  for (const match of text.matchAll(LEXICON_ANYWHERE)) {
    const identity = lexiconMatch(match[0]);
    if (identity && own.has(identity.item.ticker)) named.add(identity.item.ticker);
  }
  for (const token of text.match(/(?<![\w$])\$?[A-Z][A-Z0-9]{1,5}(?![\w])/g) || []) {
    const ticker = codeIdentity(token.replace(/^\$/, '')).ticker;
    if (own.has(ticker)) named.add(ticker);
  }
  return named;
}

function acceptable(body, claim, subjects) {
  const before = body.slice(0, claim.start);
  const after = body.slice(claim.end);
  const fields = Object.keys(claim.fields);
  if (QUALIFIED_TAIL.test(after) || ENDED_TAIL.test(after) || LEFT_BEFORE.test(before) || NEGATED_BEFORE.test(before) || BREADTH_BEFORE.test(before)) return false;
  if (fields.some((field) => MISMATCHED_DURATION[field].test(before))) return false;
  if (PAIRED_BEFORE.test(before) || PAIRED_AFTER.test(after)) return false;
  const single = fields.length === 1;
  if (!single && OWN_PREDICATE_AFTER.test(after)) return false;
  // Someone else's view, an unconfirmed signal, or a signal "for" another market, after the claim.
  if (OUTSIDE_VIEW.test(after.slice(0, 60)) || UNCONFIRMED.test(after)) return false;
  const object = /^\s+(?:signals?\s+)?(?:for|on|in)\s+(?:the\s+)?(.{1,40})/.exec(after);
  if (object && namesMarketFirst(object[1], subjects)) return false;
  // "a bullish trade and trend signal" is a signal; "a bullish trade idea" is not.
  if (NOUN_AFTER.test(after) && (single || !SIGNAL_AFTER.test(after))) return false;
  // Lowercase "its bearish trend" is chart talk; Hedgeye's "within its Bearish TREND" is the signal.
  if (single && /\b(?:trade|trend)\b/.test(claim.text) && DETERMINER_BEFORE.test(before) && !SIGNAL_AFTER.test(after)) return false;
  // "continues to trade bearish" uses trade as a verb.
  if (/^(?:trade|trend)-is$/.test(claim.form) && /^[a-z]/.test(claim.text) && VERB_BEFORE.test(before)) return false;
  return true;
}

function statementClaims(clause, subjects, start) {
  const body = clause.slice(start);
  const claims = claimsIn(body);
  if (!claims.length) return null;
  const bridge = body.slice(0, claims[0].start);
  if (bridge.length > MAX_BRIDGE || FORBIDDEN.test(clause.slice(0, start + claims[0].end))
    || namesOtherInstrument(bridge, subjects) || handsOff(bridge)) return null;
  const kept = [];
  let end = start;
  for (const claim of claims) {
    // A later claim that changes a field already stated ("briefly moved back to
    // bullish trend, then flipped back to bearish trend") voids the statement,
    // even when that later claim is itself qualified.
    const changes = kept.some((earlier) => Object.entries(claim.fields).some(([field, value]) => earlier.fields[field] && earlier.fields[field] !== value));
    if (kept.length) {
      // A later claim is still this subject's only while nothing between
      // names another market or qualifies it.
      const gap = body.slice(kept.at(-1).end, claim.start);
      // Another market's claim ("…, while the yen moved back to bearish trend") ends this statement.
      if (namesOtherInstrument(gap, subjects) || handsOff(gap)) break;
      if (gap.length > 60 || FORBIDDEN.test(gap) || PAST_RELATIVE.test(gap)) {
        if (changes && gap.length <= 60) return null;
        break;
      }
    }
    if (!acceptable(body, claim, subjects)) {
      if (!kept.length || changes) return null;
      break;
    }
    kept.push(claim);
    end = start + claim.end;
  }
  // Claims that disagree are a change of state ("broke down to Bearish TRADE
  // and TREND, but is back to Bullish TRADE"): no field of it is current.
  const values = {};
  for (const field of ['trade', 'trend']) {
    const stated = new Set(kept.map((claim) => claim.fields[field]).filter(Boolean));
    if (stated.size > 1) return null;
    if (stated.size === 1) values[field] = [...stated][0];
  }
  if (!Object.keys(values).length) return null;
  let only = null;
  if (subjects.length > 1) {
    if (LIST_BINDING.test(body.slice(0, kept.at(-1).end)) || LIST_BINDING_AFTER.test(body.slice(kept.at(-1).end))) return null;
    const renamed = renamedSubjects(body.slice(0, kept.at(-1).end), subjects);
    // Members named again with claims of their own ("Gold bullish TRADE,
    // Silver bullish TREND") cannot be paired safely.
    if (renamed.size && kept.length > 1) return null;
    if (renamed.size && renamed.size < subjects.length) {
      if (renamed.size > 1) return null;
      only = renamed;
    }
  }
  return { values, end, only };
}

// Alpha Codes: "Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)",
// "205/207" (TRADE first), "81/75 (81k = TRADE, 75k = TREND)", "an alpha code
// of 222 on the trade and 211 on the trend", "trade/trend levels of $91/$87",
// and printed single levels ("with TREND = 4.91%", "TREND Signal Support = 91").
// A bare "TREND at 4.75%" is where the price is, not a level, and a label inside
// a direction claim ("Bullish on both TRADE and TREND at 4.12%") is not a level.
const NUMBER = String.raw`\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?[kKmM]\b)?%?`;
// A number written as a price: a dollar sign, thousands, a k/m scale, or three digits.
const PRICE = String.raw`(?:\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$\s?\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?[kKmM]\b|\d{3,}(?:\.\d+)?)%?`;
const NOT_A_LEVEL = String.raw`(?!\s*(?:x\b|w(?:ee)?ks?\b|mos?\b|months?|days?|yrs?\b|years?|bps|basis|-?\s*\d))`;
const ALPHA_CODE = new RegExp(String.raw`\bAlpha\s+Code\s*(?:=|:|is\s+now|now|is|of|at|was)?\s*(?:given\s+as\s+)?(?:roughly\s+|approximately\s+|about\s+|around\s+|~\s*)?(${NUMBER}(?:\s*\/\s*${NUMBER})?)(?![-–]\s*\d)`, 'gi');
const PAIR_LABEL = new RegExp(String.raw`\btrade\s*(?:\/|and|&)\s*trend\s+(?:signal\s+)?(?:levels?|support|resistance)?\s*(?:=|:|of|at|are|were)\s*(${NUMBER})\s*(?:\/|and|&)\s*(${NUMBER})`, 'gi');
const ON_THE = new RegExp(String.raw`(${NUMBER})\s+on\s+the\s+trade\s+and\s+(${NUMBER})\s+on\s+the\s+trend`, 'gi');
// A number that is itself another label's value ("TRADE = $97, TREND …") is not a legend.
const LEGEND = (label) => new RegExp(String.raw`(?<![=:]\s*)(?<![\d$.,])(?<!\d\s*(?:to|-|–)\s*)(?:(${NUMBER})\s*=\s*|(?:approximately\s+|about\s+|~)?(${PRICE})\s+)${label}\b(?!\s+signals\b)`, 'gi');
const LEVEL_NOUN = String.raw`(?:\s+(?:Momentum|Signal))*\s+(?:Support|Supports|Resistance|Level|Levels|level|levels|line)(?:\s+(?:Signal|intact|is|was|has\s+moved\s+to|moved\s+to|now))*\s*(?:=|:|at|of|is|to)?`;
// The label is not the second half of "trade/trend" or "TRADE and TREND".
const LEVEL = (label) => new RegExp(String.raw`(?<!\/\s*)(?<!\btrade\s*(?:and|&)\s*)\b${label}\b(?:(?:\s+(?:Momentum|Signal))*\s*[=:]\s*|(?:\s+(?:Momentum|Signal))*\s+(?=\$)|${LEVEL_NOUN}\s*)(${NUMBER})${NOT_A_LEVEL}`, 'gi');
// "oil put TRADE and TREND at $83": both levels at one price, never the first of two numbers.
const BOTH_LEVEL = new RegExp(String.raw`\bTRADE\s+and\s+TREND\s+(?:at|=|of)\s*(${NUMBER})${NOT_A_LEVEL}(?!\s*(?:and|&|\/|,)\s*\$?\d)`, 'gi');
const TRADE_LEVEL = LEVEL('TRADE');
const TREND_LEVEL = LEVEL('TREND');
const TRADE_LEGEND = LEGEND('TRADE');
const TREND_LEGEND = LEGEND('TREND');
const BROKEN_LEVEL = /\b(?:broke|breaking|broken|lost|losing|breached|violated)\b/i;
const SAME_SESSION = /\b(?:this\s+morning|today|overnight|pre-?market)\b/i;
function level(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[$,%\s]/g, '');
  const scale = /[mM]$/.test(cleaned) ? 1e6 : /[kK]$/.test(cleaned) ? 1e3 : 1;
  const value = Number(cleaned.replace(/[kKmM]$/, '')) * scale;
  return Number.isFinite(value) ? value : null;
}
const unitOf = (...texts) => texts.some((text) => /%/.test(text || '')) ? '%' : texts.some((text) => /\$/.test(text || '')) ? '$' : null;
const SCALES = [1, 1e3, 1e6];
// The scale at which a printed level equals the code's number ("81/75" with "81k = TRADE").
const scaleOf = (code, printed) => SCALES.find((scale) => Math.abs(code * scale - printed) < 1e-9) ?? null;
const digits = (value) => String(value).replace(/\.0+$/, '');

// A code's printed expansion closes its statement ("… = 9792 (TRADE = 97, TREND = 92) and, after
// breaking …"): levels after the parenthesis belong to the next thought.
function closedAtExpansion(text) {
  const code = new RegExp(ALPHA_CODE.source, 'i').exec(text);
  if (!code) return text;
  const expansion = /^\s*\([^)]*\)/.exec(text.slice(code.index + code[0].length));
  return expansion ? text.slice(0, code.index + code[0].length + expansion[0].length) : text;
}

function alphaLevels(clause, subjects, start) {
  const whole = clause.slice(start);
  const body = closedAtExpansion(whole);
  // A label inside a direction claim is part of that claim. A claim about a level ("back above
  // TRADE Signal Level of 5.10%") still prints that level.
  const claims = claimsIn(body).filter((claim) => !/-level$/.test(claim.form));
  const free = (match, offset = 0) => !claims.some((claim) => match.index + offset >= claim.start && match.index + offset < claim.end);
  const all = (regex) => [...body.matchAll(regex)].filter((match) => free(match));
  const matches = { codes: all(ALPHA_CODE), pair: all(PAIR_LABEL), onThe: all(ON_THE),
    tradeLegend: all(TRADE_LEGEND), trendLegend: all(TREND_LEGEND), both: all(BOTH_LEVEL),
    tradeLevel: all(TRADE_LEVEL), trendLevel: all(TREND_LEVEL) };
  const found = Object.values(matches).flat();
  if (!found.length) return null;
  const first = Math.min(...found.map((match) => match.index));
  const last = Math.max(...found.map((match) => match.index + match[0].length));
  const span = body.slice(0, last);
  // Everything up to the last level is this subject's, unqualified, and not a past break.
  if (first > MAX_BRIDGE || FORBIDDEN.test(clause.slice(0, start + last)) || namesOtherInstrument(span.replace(/\bAlpha\s+Codes?\b/gi, ''), subjects)
    || handsOff(span) || QUALIFIED_TAIL.test(whole.slice(last)) || (BROKEN_LEVEL.test(span) && !SAME_SESSION.test(clause))) return null;
  // Two different codes in one clause ("was 80/82, is now 83/86") cannot both be current.
  const codes = new Set(matches.codes.map((match) => match[1].replace(/\s+/g, '')));
  const code = matches.codes[0];
  const replaced = code && /\b(?:is\s+now|now|changed\s+to|updated\s+to|raised\s+to|lowered\s+to)\s+\$?\d/i.test(body.slice(code.index + code[0].length));
  if (codes.size > 1 || replaced) return null;
  // "an alpha code of 222 on the trade and 211 on the trend": the code is the labelled pair.
  const labelled = [...matches.pair, ...matches.onThe].find((match) => code && code.index + code[0].length > match.index);
  const raw = code && !labelled ? code[1].trim() : null;
  const legend = (match) => match[1] || match[2];
  const printedText = {
    trade: [...matches.pair.map((m) => m[1]), ...matches.onThe.map((m) => m[1]), ...matches.tradeLegend.map(legend), ...matches.both.map((m) => m[1]), ...matches.tradeLevel.map((m) => m[1])],
    trend: [...matches.pair.map((m) => m[2]), ...matches.onThe.map((m) => m[2]), ...matches.trendLegend.map(legend), ...matches.both.map((m) => m[1]), ...matches.trendLevel.map((m) => m[1])],
  };
  const printed = Object.fromEntries(Object.entries(printedText).map(([field, texts]) => [field, texts.map(level).filter((value) => value !== null)]));
  // Two different printed values for one level make the reading unusable.
  if (['trade', 'trend'].some((field) => new Set(printed[field]).size > 1)) return null;
  let trade = printed.trade[0] ?? null;
  let trend = printed.trend[0] ?? null;
  let basis = trade !== null || trend !== null ? 'printed-levels' : null;
  if (raw && raw.includes('/')) {
    // Hedgeye prints a slash code TRADE first, then TREND; a printed side sets the scale of both.
    const [left, right] = raw.split('/').map(level);
    const scales = [trade !== null ? scaleOf(left, trade) : undefined, trend !== null ? scaleOf(right, trend) : undefined].filter((scale) => scale !== undefined);
    if (scales.some((scale) => scale === null) || new Set(scales).size > 1) return null;
    const scale = scales[0] ?? 1;
    if (trade === null && trend === null) basis = 'trade-then-trend-code';
    trade ??= left * scale;
    trend ??= right * scale;
  } else if (raw && (trade !== null || trend !== null)) {
    // A run-together code is the printed levels written side by side.
    const code = raw.replace(/[$,%\s]/g, '');
    const fits = SCALES.some((scale) => (trade === null || code.startsWith(digits(trade / scale)))
      && (trend === null || code.endsWith(digits(trend / scale)))
      && (trade === null || trend === null || code === `${digits(trade / scale)}${digits(trend / scale)}`));
    if (!fits) return null;
  }
  if (trade === null && trend === null && !raw) return null;
  return { levels: { raw, trade, trend, unit: unitOf(raw, ...printedText.trade, ...printedText.trend), basis }, end: start + last };
}

// "Alpha Code for KOSPI = 6265/7051", "The Alpha Code for WTI is now 9792": the
// market is named after the phrase, so the clause is read with it first.
const ALPHA_CODE_LEAD = /^(?:(?:the|our|my)\s+)?(?:(?:@?hedgeye|ai)\s+)*alpha\s+code\s+(?:for|on|in)\s+/i;
function subjectFirst(clause) {
  const lead = ALPHA_CODE_LEAD.exec(clause);
  if (!lead) return clause;
  const rest = clause.slice(lead[0].length);
  const subject = subjectsAt(rest);
  return subject ? `${rest.slice(0, subject.length).trim()} Alpha Code ${rest.slice(subject.length).trim()}` : clause;
}
// "SPX – Alpha Code = 77037639": a bare market name, then its code after a dash.
function withDetachedSubjects(parts) {
  const joined = [];
  for (const part of parts) {
    const previous = joined.at(-1);
    const bare = previous && subjectsAt(stripLead(previous.text));
    if (bare && bare.length === stripLead(previous.text).length && /^alpha\s+code\b/i.test(part.text)) {
      previous.text = `${previous.text} ${part.text}`;
    } else joined.push({ ...part });
  }
  return joined;
}
// "… the Alpha Codes are:" (or "TRADE first") opens a roster of "TSLA 370375" lines. Each
// row is read as the statement it abbreviates, so it can be re-read without the roster.
const ROSTER_OPEN = /\balpha\s+codes\s+(?:are\s*)?[:=]?\s*$|\bTRADE\s+first\b/i;
const ROSTER_ROW = /^\$?([A-Z][A-Z0-9]{1,5})(?:\s*[=:])?\s+(\d{4,}|\d[\d,.]*\s*\/\s*\d[\d,.]*)$/;
const ROSTER_LINES = 12;
function withRosterRows(list) {
  let until = -1;
  return list.map((sentence, index) => {
    const row = index <= until && ROSTER_ROW.exec(sentence);
    if (ROSTER_OPEN.test(sentence)) until = index + ROSTER_LINES;
    return row && !VOCABULARY.has(row[1]) ? `${row[1]} Alpha Code = ${row[2]}` : sentence;
  });
}

// The SPX gamma flip line: "Tier1 Alpha Gamma Flip Line = 7726", "gamma flip level near
// 7,713", "SPX gamma flip line at 7,726". A sentence about another index, or one that dates
// the level in the past, states nothing current. A conditional is fine: Hedgeye writes "if SPX
// breaks out (or fails) at the Flip Line".
const FLIP_LINE = /\b(gamma\s+flip(?:\s+(?:line|level|point))?|flip\s*line)\b\s*(?:(?:=|:|is(?:\s+now)?|at|of|near|around|about|~)\s*){0,3}(\d{1,3}(?:,\d{3})+|\d{4,6})(?![\d.,]*\d)/gi;
const OTHER_INDEX = /\b(?:NDX|Nasdaq|QQQ|IWM|Russell|RUT|Dow|DJI|DIA)\b/i;
const SPX_NAMED = /\b(?:SPX|S&P|SP500|SPY)\b/i;
const FLIP_PAST = /\b(?:was|were|previously|prior|last\s+(?:week|month|session)|yesterday)\b[^,;]*$/i;
function flipLines(sentence) {
  if (OTHER_INDEX.test(sentence) && !SPX_NAMED.test(sentence)) return [];
  const found = [];
  for (const match of sentence.matchAll(FLIP_LINE)) {
    // A bare "flip line" needs gamma or the index beside it to mean this level.
    if (/^flip/i.test(match[1]) && !/\bgamma\b/i.test(sentence) && !SPX_NAMED.test(sentence)) continue;
    if (FLIP_PAST.test(sentence.slice(0, match.index + match[1].length))) continue;
    const value = Number(match[2].replace(/,/g, ''));
    if (value < 1000 || value > 100_000) continue;
    found.push({ field: 'flipLine', ticker: 'SPX', kind: 'security',
      levels: { raw: match[2], trade: null, trend: null, unit: null, basis: 'flip-line', level: value },
      approximate: /\b(?:near|around|about)\b|~/i.test(match[0]), sourceText: sentence, statement: sentence });
  }
  return found;
}

// A sentence printing an Alpha Code that nothing below could read: a gap for Systems.
const CODE_MENTION = /\balpha\s+codes?\b[^.;]{0,60}?\d{2,}/i;
const CODE_METHOD = /\bfirst\b|\bwhat\s+the\s+machine\s+reads\b/i;
function unreadAlphaCodes(text) {
  const read = new Set(researchStatements(text).filter((item) => item.field === 'alphaCode').map((item) => item.statement));
  return [...new Set(sentences(text))].filter((sentence) => CODE_MENTION.test(sentence) && !CODE_METHOD.test(sentence) && !read.has(sentence));
}

// "Brent Oil (we’re long BNO) continues to signal …": our own position, said in passing, is
// not another market's signal.
const POSITION_ASIDE = /\s*\((?:we|I)(?:['’](?:re|m)|\s+are|\s+am|\s+remain)\s+(?:still\s+)?(?:long|short)(?:\s+of)?\s+[^()]{1,40}\)/g;
// "Treasury yields remain bullish on both trade and trend signals across the 2-year, 10-year,
// and 30-year maturities": the claim is each named maturity's. Read with those yields first;
// a maturity we do not track leaves the sentence unread.
const MATURITY = String.raw`(?:\d{1,2}|two|five|ten|twenty|thirty)[-\s]?(?:year|yr)`;
const ACROSS_MATURITIES = new RegExp(String.raw`^(?:U\.?S\.?\s+)?Treasury\s+yields\s+(.+?)\s+across\s+the\s+(${MATURITY}(?:(?:,\s*(?:and\s+)?|\s+and\s+)${MATURITY})*)(?:\s+(?:maturities|tenors|yields|points))?\.?$`, 'i');
const MATURITY_YEARS = { two: 2, five: 5, ten: 10, twenty: 20, thirty: 30 };
function maturitiesFirst(clause) {
  const match = ACROSS_MATURITIES.exec(clause);
  if (!match) return clause;
  const names = match[2].match(new RegExp(MATURITY, 'gi')).map((name) => {
    const years = /^[a-z\d]+/i.exec(name)[0].toLowerCase();
    return `${MATURITY_YEARS[years] || years}-Year Yield`;
  });
  const listed = subjectsAt(names.join(', '));
  if (!listed || listed.subjects.length !== names.length) return clause;
  return `${names.join(', ')} ${match[1]}`;
}

/**
 * Every subject-bound statement in a text: { field: 'trade' | 'trend', value }
 * or { field: 'alphaCode', levels }, with the instrument identity, the exact
 * clause span that states it (sourceText) and its whole sentence. The SPX gamma
 * flip line comes as { field: 'flipLine', levels: { level } }.
 */
function researchStatements(text) {
  const result = [];
  for (const sentence of withRosterRows(sentences(text))) {
    if (sentence.length > 1200) continue;
    result.push(...flipLines(sentence));
    // A question states nothing.
    const parts = withDetachedSubjects(clauses(sentence));
    parts.forEach(({ text: raw, after }, index) => {
      const previous = parts[index - 1];
      const next = parts[index + 1];
      if (/\?/.test(raw) || (next && next.after !== ';' && CONDITIONAL_NEXT.test(next.text))
        || (previous && after !== ';' && CONDITIONAL_PREVIOUS.test(stripLead(previous.text)))) return;
      const printed = stripLead(raw);
      const clause = maturitiesFirst(subjectFirst(printed.replace(POSITION_ASIDE, '')));
      // The span quoted as the source is always the printed words.
      const printedSpan = (end) => {
        if (clause === printed) return clause.slice(0, end).trim();
        const closing = clause.slice(0, end).slice(-24);
        const at = ACROSS_MATURITIES.test(printed) ? -1 : printed.lastIndexOf(closing);
        return (at < 0 ? printed : printed.slice(0, at + closing.length)).trim();
      };
      const subject = subjectsAt(clause);
      if (!subject) return;
      const claims = /\b(?:trade|trend)\b/i.test(clause) ? statementClaims(clause, subject.subjects, subject.length) : null;
      // One instrument's levels; a list of instruments never shares a code.
      const alpha = subject.subjects.length === 1 && /\b(?:alpha\s+code|trade|trend)\b/i.test(clause)
        ? alphaLevels(clause, subject.subjects, subject.length) : null;
      for (const { unlessMentioned, ...identity } of subject.subjects) {
        if (unlessMentioned?.test(sentence)) continue;
        if (claims && (!claims.only || claims.only.has(identity.ticker))) {
          const sourceText = printedSpan(claims.end);
          for (const [field, value] of Object.entries(claims.values)) {
            result.push({ field, value, ...identity, sourceText, statement: sentence });
          }
        }
        if (alpha) {
          result.push({ field: 'alphaCode', levels: alpha.levels, ...identity,
            sourceText: clause === printed ? clause.slice(0, alpha.end).trim() : printed.trim(), statement: sentence });
        }
      }
    });
  }
  return [...new Map(result.map((item) => [`${item.ticker}:${item.field}:${item.value || JSON.stringify(item.levels)}:${item.sourceText}`, item])).values()];
}

/** The direction a TRADE/TREND claim in this text gives a field, by the shared claim patterns. */
function claimedValues(text, field) {
  return [...new Set(claimsIn(String(text || '')).map((claim) => claim.fields[field]).filter(Boolean))];
}

module.exports = { researchStatements, unreadAlphaCodes, claimedValues, sentences, clauses, FORBIDDEN };
