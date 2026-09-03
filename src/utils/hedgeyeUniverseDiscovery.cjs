const POSITION_LIST_FIELDS = new Set([
  'longs',
  'shorts',
  'neutrals',
  'added',
  'removed',
  'fullBookLongs',
  'fullBookShorts',
  'addedLongs',
  'addedShorts',
  'removedLongs',
  'removedShorts',
  'tickers',
  'symbols',
]);

const THE_CALL_POSITION_FIELDS = new Set([
  'longs',
  'shorts',
  'neutrals',
]);

const TRUSTED_DATA_KEY_PARENTS = Object.freeze({
  'bitcoin-trend-tracker': new Set(['data.stocks', 'data.cryptos']),
  'early-look': new Set(['data']),
  'momo-tracker': new Set(['data']),
  'risk-ranges': new Set(['data']),
});

const NON_SECURITY_TOKENS = new Set([
  'ADD',
  'ALERT',
  'BUY',
  'CALL',
  'CLOSE',
  'CLOSED',
  'ETF',
  'ETFS',
  'FULL',
  'LONG',
  'NEUTRAL',
  'NEW',
  'NONE',
  'REMOVE',
  'SELL',
  'SHORT',
  'SIGNAL',
  'SPDR',
  'STOCK',
  'STOCKS',
  'TRADE',
  'TREND',
]);

const NAMED_MARKET_ALIASES = new Set([
  'BITCOIN',
  'BRENT',
  'CAD/USD',
  'COMPQ',
  'COPPER',
  'EUR/USD',
  'GBP/USD',
  'NATGAS',
  'SILVER',
  'USD/JPY',
  'USD/YEN',
  'UST10Y',
  'UST2Y',
  'UST30Y',
]);

const RESEARCH_LABEL_TOKENS = new Set([
  'CHANGE',
  'NEW',
  'NVIDIA',
  'PIMCO',
  'POSITION',
  'U.S',
  'US',
]);

// Archive corrections are evidence-scoped. A token is never globally renamed
// because the same letters may identify a valid security in another artifact.
const VERIFIED_EVIDENCE_TICKER_ALIASES = new Map([
  ['portfolio-solutions#2025-11-10#AQUA', 'AQWA'],
  ['the-call#2025-10-17#DLT', 'DLTR'],
  ['the-call#2025-11-10#DEER', 'DE'],
  ['the-call#2025-11-19#ABX', 'ABX.TO'],
  ['the-call#2025-12-04#TMICC', 'MICC'],
  ['the-call#2026-03-17#RPI', 'RPI.L'],
  ['the-call#2026-06-02#LTMC', 'LTMC.MI'],
  ['the-call#2026-06-03#LTMC', 'LTMC.MI'],
  ['the-call#2026-06-08#RPI', 'RPI.L'],
  ['the-call#2026-06-12#LTMC', 'LTMC.MI'],
  ['the-call#2026-06-30#ATZ', 'ATZ.TO'],
  ['the-call#2026-07-06#LTMC', 'LTMC.MI'],
  ['the-call#2026-07-09#LTMC', 'LTMC.MI'],
  ['the-call#2026-07-10#ATZ', 'ATZ.TO'],
  ['the-call#2026-07-10#GRGD', 'GRGD.TO'],
  ['the-call#2026-07-28#MC', 'MC.PA'],
  ['the-call#2026-08-19#DOL', 'DOL.TO'],
  ['the-call#2026-08-19#HTV', 'HVT'],
  ['the-macro-show#2025-07-31#LXD', 'LQD'],
  ['the-macro-show#2025-08-05#LXD', 'LQD'],
  ['the-macro-show#2025-11-18#LXD', 'LQD'],
  ['the-macro-show#2025-12-03#DXC', 'DXCM'],
  ['the-macro-show#2026-06-11#XLR', 'XAR'],
]);

// Every entry below was checked against its original archive context. Keeping
// product and date in the key prevents a prose acronym from blacklisting a
// legitimate security with the same symbol in a different source.
const AUDITED_FALSE_MENTION_SOURCES = Object.freeze({
  A: ['the-call#2026-06-12', 'the-call#2026-07-30'],
  ACA: ['the-call#2025-11-10'],
  AI: ['early-look#2025-10-14', 'the-macro-show#2025-12-11'],
  ARK: ['the-macro-show#2026-07-13', 'the-macro-show#2026-07-15'],
  BIS: ['the-call#2025-09-02'],
  BNMR: ['the-macro-show#2025-11-20'],
  BZ: ['the-call#2026-06-01'],
  CA: ['early-look#2025-11-14'],
  CIT: ['the-call#2025-07-31'],
  CLO: [
    'the-macro-show#2025-08-27',
    'the-macro-show#2026-06-11',
    'the-macro-show#2026-08-13',
  ],
  CNBC: ['early-look#2025-10-08'],
  CORV: ['the-call#2025-11-21'],
  CPI: [
    'early-look#2025-08-08',
    'early-look#2025-09-04',
    'early-look#2025-11-13',
    'early-look#2026-08-14',
  ],
  DEC: ['early-look#2025-11-18'],
  DISCUS: ['the-call#2025-10-07'],
  EHS: ['the-call#2025-09-26'],
  EXIT: ['the-macro-show#2025-10-08'],
  FDFX: ['the-call#2026-06-01'],
  FX: ['the-macro-show#2025-08-26'],
  GGR: ['the-call#2025-11-03'],
  GIP: [
    'etf-pro#2025-08-12',
    'etf-pro#2025-10-08',
    'etf-pro#2025-11-04',
    'etf-pro#2025-12-01',
    'etf-pro#2026-08-10',
  ],
  GLOBE: ['the-call#2025-09-26'],
  GSP: ['early-look#2026-07-31'],
  GVZ: ['the-macro-show#2025-10-23'],
  HAM: ['early-look#2025-10-08', 'early-look#2025-11-20'],
  HATH: ['early-look#2025-08-01'],
  HK: ['the-call#2026-06-16'],
  IDR: ['the-call#2026-07-22'],
  IEEPA: ['the-call#2025-07-31'],
  IG: ['the-macro-show#2025-08-19', 'the-macro-show#2026-07-07'],
  IMAGE: ['signal-strength#2026-07-10'],
  JB: ['the-macro-show#2025-12-10'],
  JGB: ['the-macro-show#2025-09-19'],
  JP: ['the-macro-show#2025-12-11'],
  KS: ['the-call#2026-06-01', 'the-call#2026-06-24'],
  LARGER: ['signal-strength#2026-07-10'],
  LN: ['the-call#2026-03-17'],
  LRR: [
    'early-look#2025-10-31',
    'early-look#2025-12-10',
    'investing-ideas#2026-08-03',
  ],
  MFN: ['early-look#2025-11-20'],
  MI: ['the-call#2026-06-02', 'the-call#2026-06-03', 'the-call#2026-07-09'],
  MOVE: [
    'the-macro-show#2025-07-28',
    'the-macro-show#2025-08-08',
    'the-macro-show#2025-09-04',
    'the-macro-show#2025-09-08',
    'the-macro-show#2025-10-08',
    'the-macro-show#2025-10-30',
    'the-macro-show#2025-11-06',
  ],
  NASDAQ: ['the-macro-show#2025-12-04'],
  NDAA: ['the-call#2025-11-21'],
  NOAA: ['the-call#2025-09-25'],
  NTM: ['the-macro-show#2025-08-15'],
  PLT: ['the-macro-show#2025-10-31'],
  POC: ['the-macro-show#2025-11-20'],
  Q3: ['the-macro-show#2025-09-16'],
  Q4: ['the-macro-show#2025-08-15', 'the-macro-show#2025-09-16'],
  RCS: ['the-call#2025-08-08'],
  REDUCE: ['the-macro-show#2025-10-08'],
  RIN: ['the-call#2025-09-11'],
  RVX: [
    'the-macro-show#2025-08-19',
    'the-macro-show#2025-11-14',
    'the-macro-show#2025-11-19',
    'the-macro-show#2025-11-25',
    'early-look#2025-12-04',
    'the-macro-show#2025-12-04',
    'the-macro-show#2025-12-05',
    'the-macro-show#2025-12-11',
  ],
  SEP: ['early-look#2025-09-11'],
  SIZE: ['the-macro-show#2025-09-26'],
  SRE: ['the-call#2025-08-15'],
  SSP: ['the-call#2025-09-26'],
  TOP: ['the-call#2025-12-10'],
  TO: ['the-call#2026-06-30'],
  TRR: [
    'early-look#2025-10-31',
    'early-look#2025-12-10',
    'the-macro-show#2025-12-03',
    'investing-ideas#2026-08-03',
  ],
  TW: ['the-call#2026-07-13'],
  UK: ['the-macro-show#2025-11-18'],
  USA: ['the-macro-show#2025-09-24'],
  VEU: ['the-call#2025-09-02'],
  VIEW: ['signal-strength#2026-07-10'],
  VXN: [
    'the-macro-show#2025-08-20',
    'the-macro-show#2025-08-22',
    'the-macro-show#2025-10-08',
    'the-macro-show#2025-11-20',
    'the-call#2025-11-21',
    'the-macro-show#2025-11-24',
    'early-look#2025-12-04',
    'the-macro-show#2025-12-04',
  ],
});

const AUDITED_FALSE_MENTIONS = new Set(
  Object.entries(AUDITED_FALSE_MENTION_SOURCES)
    .flatMap(([ticker, sources]) => sources.map((source) => `${source}#${ticker}`)),
);

const CONFIDENCE_RANK = Object.freeze({
  text_explicit: 1,
  structured_list: 2,
  declared_position: 3,
  structured_field: 3,
  structured_key: 3,
  risk_range_row: 3,
  catalog_seed: 4,
});

function normalizeDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function validDirectTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (
    !ticker
    || NON_SECURITY_TOKENS.has(ticker)
    || /\.(?:PNG|JPE?G|GIF|WEBP|PDF|CSV)$/.test(ticker)
  ) return false;
  return NAMED_MARKET_ALIASES.has(ticker)
    || /^[A-Z][A-Z0-9]{0,5}$/.test(ticker)
    || /^[A-Z][A-Z0-9]{0,5}\.[A-Z]{1,3}$/.test(ticker)
    || /^[0-9]{1,6}\.[A-Z]{1,3}$/.test(ticker)
    || /^[A-Z]{3}\/[A-Z]{3}$/.test(ticker);
}

function normalizeTickerCandidates(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return [];

  const candidates = [];
  for (const match of text.matchAll(/\(([A-Z][A-Z0-9./-]{0,14})\)/g)) {
    candidates.push(match[1]);
  }
  for (const match of text.matchAll(/\$([A-Z0-9][A-Z0-9.-]{0,9})\b/g)) {
    candidates.push(match[1]);
  }
  if (validDirectTicker(text)) candidates.push(text);
  if (!text.includes(' ') && text.includes('/')) candidates.push(text);

  const expanded = [];
  for (const candidate of candidates) {
    if (
      candidate.includes('/')
      && !NAMED_MARKET_ALIASES.has(candidate)
    ) {
      expanded.push(...candidate.split('/'));
    } else {
      expanded.push(candidate);
    }
  }

  return [...new Set(
    expanded
      .map((candidate) => String(candidate || '').trim().toUpperCase())
      .filter(validDirectTicker),
  )];
}

function normalizeDeclaredPositionEntry(value) {
  const text = String(value || '').trim().toUpperCase();
  const directionTagged = /^\$?([A-Z][A-Z0-9.]{0,5})-(?:LON|LONG|SHO|SHORT)$/.exec(text);
  if (directionTagged) return normalizeTickerCandidates(directionTagged[1]);
  const slashSeparated = text.split(/\s*\/\s*/);
  if (
    slashSeparated.length > 1
    && slashSeparated.every((candidate) => /^\$?[A-Z][A-Z0-9.]{0,9}$/.test(candidate))
  ) {
    return [...new Set(slashSeparated.flatMap((candidate) => normalizeTickerCandidates(candidate)))];
  }
  const candidates = normalizeTickerCandidates(text);
  if (candidates.length > 0) return candidates;
  const leadingTicker = /^\$?([A-Z][A-Z0-9.]{0,9})(?=\s|\()/.exec(text);
  return leadingTicker ? normalizeTickerCandidates(leadingTicker[1]) : [];
}

function normalizeResearchPositionEntry(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const candidates = [];

  for (const match of text.matchAll(/\$([A-Z0-9][A-Z0-9.-]{0,9})\b/g)) {
    candidates.push(match[1]);
  }
  if (
    !/\s/.test(text)
    && text === text.toUpperCase()
    && (validDirectTicker(text) || text.includes('/'))
  ) candidates.push(text);
  for (const parenthetical of text.matchAll(/\(([^)]{1,80})\)/g)) {
    for (const segment of parenthetical[1].split(/[,;]/)) {
      const rawCandidate = segment.trim().replace(/^E\.G\.\s*/i, '');
      const candidate = rawCandidate.toUpperCase();
      if (
        rawCandidate === candidate
        && (validDirectTicker(candidate) || (!candidate.includes(' ') && candidate.includes('/')))
      ) {
        candidates.push(candidate);
      }
    }
  }
  const uppercasePair = /^([A-Z][A-Z0-9.]{1,9})\s*&\s*([A-Z][A-Z0-9.]{1,9})(?:\s|\(|$)/.exec(text);
  if (uppercasePair) candidates.push(uppercasePair[1], uppercasePair[2]);
  if (candidates.length === 0) {
    const leadingTicker = /^\$?([A-Z][A-Z0-9.]{0,9})(?=$|\s*(?:\(|\/))/.exec(text);
    if (leadingTicker) candidates.push(leadingTicker[1]);
  }

  return [...new Set(
    candidates
      .filter((candidate) => !RESEARCH_LABEL_TOKENS.has(String(candidate).toUpperCase()))
      .flatMap((candidate) => normalizeDeclaredPositionEntry(candidate))
      .filter(Boolean),
  )];
}

function parseTheCallDeclaredPositions(rawBodyText) {
  const bodyText = String(rawBodyText || '');
  const markerMatch = /\b(?:HEDGEYE\s+POSITIONS|TICKERS\s+DISCUSSED|SECTOR\s+POSITION\s+MONITOR)\b/i.exec(bodyText);
  if (!markerMatch) return null;

  // The archived article is the auditable source for The Call's actual book.
  // Some legacy parser rows let the neutral list run into the article prose.
  // Normalize inline labels as well as line-separated labels, then read only
  // the explicit LONGS / SHORTS / NEUTRAL declarations following the marker.
  const section = bodyText
    .slice(markerMatch.index, markerMatch.index + 4000)
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+(?=(?:LONGS?|SHORTS?|NEUTRALS?)\s*:)/gi, '\n');
  const positions = {};
  const linePattern = /(?:^|\n)\s*(LONGS?|SHORTS?|NEUTRALS?)\s*:\s*([^\n]*)/gim;
  for (const match of section.matchAll(linePattern)) {
    const label = match[1].toLowerCase();
    const field = label.startsWith('long')
      ? 'longs'
      : label.startsWith('short') ? 'shorts' : 'neutrals';
    if (Object.prototype.hasOwnProperty.call(positions, field)) continue;
    positions[field] = [...new Set(
      match[2]
        .split(/[,;|]/)
        .flatMap((entry) => normalizeDeclaredPositionEntry(entry)),
    )];
  }

  return Object.keys(positions).length > 0 ? positions : null;
}

function parseMacroShowDeclaredPositions(snapshot) {
  const bodyText = String(snapshot?.article?.bodyText || '');
  const markerMatch = /TL;DR\s*[-–—]\s*POSITIONS\s+MENTIONED/i.exec(bodyText);
  const positions = {};

  if (markerMatch) {
    const section = bodyText
      .slice(markerMatch.index, markerMatch.index + 4000)
      .replace(/\r/g, '\n')
      .replace(/[^\S\n]+(?=(?:BULLISH|BEARISH|NEUTRALS?)\s*:)/gi, '\n');
    const linePattern = /(?:^|\n)\s*(BULLISH|BEARISH|NEUTRALS?)\s*:\s*([^\n]*)/gim;
    for (const match of section.matchAll(linePattern)) {
      const label = match[1].toLowerCase();
      const field = label === 'bullish'
        ? 'longs'
        : label === 'bearish' ? 'shorts' : 'neutrals';
      if (Object.prototype.hasOwnProperty.call(positions, field)) continue;
      positions[field] = [...new Set(
        match[2]
          .split(/[,;|]/)
          .flatMap((entry) => normalizeResearchPositionEntry(entry)),
      )];
    }
  }

  const rawFields = {
    longs: snapshot?.data?.rawLongsText,
    shorts: snapshot?.data?.rawShortsText,
    neutrals: snapshot?.data?.rawNeutralText,
  };
  Object.entries(rawFields).forEach(([field, rawText]) => {
    if (Object.prototype.hasOwnProperty.call(positions, field)) return;
    if (typeof rawText !== 'string') return;
    const declaredParagraph = rawText.split(/\n\s*\n/)[0];
    positions[field] = [...new Set(
      declaredParagraph
        .split(/[,;|]/)
        .flatMap((entry) => normalizeResearchPositionEntry(entry)),
    )];
  });

  return Object.keys(positions).length > 0 ? positions : null;
}

function parseSeedSecurities(sourceText) {
  const text = String(sourceText || '');
  const rows = [];
  const rowPattern = /\{\s*ticker:\s*['"]([^'"]+)['"]\s*,\s*name:\s*['"]([^'"]*)['"]\s*,\s*assetClass:\s*['"]([^'"]*)['"]/g;
  for (const match of text.matchAll(rowPattern)) {
    rows.push({
      ticker: match[1].trim().toUpperCase(),
      name: match[2].trim() || null,
      assetClass: match[3].trim() || null,
    });
  }
  return rows;
}

function createRecord(ticker) {
  return {
    ticker,
    catalogName: null,
    mentionCount: 0,
    pullKeys: new Set(),
    firstSeen: null,
    lastSeen: null,
    confidenceRank: 0,
    confidenceKinds: new Set(),
    products: new Map(),
    evidence: new Map(),
    existingUniverse: false,
    seedAssetClass: null,
  };
}

function updateDateBounds(record, date) {
  if (!date) return;
  if (!record.firstSeen || date < record.firstSeen) record.firstSeen = date;
  if (!record.lastSeen || date > record.lastSeen) record.lastSeen = date;
}

function addMention(records, rawValue, context = {}) {
  const candidates = normalizeTickerCandidates(rawValue);
  const date = normalizeDate(context.date);
  const product = String(context.product || 'unknown').trim() || 'unknown';
  const kind = String(context.kind || 'structured_list');
  const path = String(context.path || 'unknown');
  for (const sourceTicker of candidates) {
    const evidenceIdentity = `${product}#${date || 'undated'}#${sourceTicker}`;
    const isSensexRegionLabel = product === 'early-look'
      && kind === 'structured_key'
      && sourceTicker === 'INDIA'
      && path === 'data.BSE SENSEX (INDIA)';
    if (AUDITED_FALSE_MENTIONS.has(evidenceIdentity) || isSensexRegionLabel) continue;
    const ticker = VERIFIED_EVIDENCE_TICKER_ALIASES.get(evidenceIdentity) || sourceTicker;
    const record = records.get(ticker) || createRecord(ticker);
    const confidenceRank = CONFIDENCE_RANK[kind] || 1;
    const pullKey = `${product}#${date || 'undated'}`;
    const evidenceKey = `${product}#${kind}#${path}`;

    record.mentionCount += 1;
    record.pullKeys.add(pullKey);
    record.confidenceRank = Math.max(record.confidenceRank, confidenceRank);
    record.confidenceKinds.add(kind);
    updateDateBounds(record, date);
    const productEvidence = record.products.get(product) || {
      product,
      mentionCount: 0,
      firstSeen: null,
      lastSeen: null,
    };
    productEvidence.mentionCount += 1;
    if (date && (!productEvidence.firstSeen || date < productEvidence.firstSeen)) {
      productEvidence.firstSeen = date;
    }
    if (date && (!productEvidence.lastSeen || date > productEvidence.lastSeen)) {
      productEvidence.lastSeen = date;
    }
    record.products.set(product, productEvidence);

    const evidence = record.evidence.get(evidenceKey) || {
      product,
      kind,
      path,
      ...(ticker !== sourceTicker ? { sourceTicker } : {}),
      mentionCount: 0,
      firstSeen: null,
      lastSeen: null,
    };
    evidence.mentionCount += 1;
    if (date && (!evidence.firstSeen || date < evidence.firstSeen)) evidence.firstSeen = date;
    if (date && (!evidence.lastSeen || date > evidence.lastSeen)) evidence.lastSeen = date;
    record.evidence.set(evidenceKey, evidence);

    records.set(ticker, record);
  }
}

function walkStructuredFields(records, snapshot, value, path = '', options = {}) {
  if (value == null) return;
  if (Array.isArray(value)) {
    const field = path.split('.').pop();
    value.forEach((entry, index) => {
      if (
        typeof entry === 'string'
        && POSITION_LIST_FIELDS.has(field)
        && !options.suppressedListPaths?.has(path)
      ) {
        addMention(records, entry, {
          product: snapshot.snapshotType,
          date: snapshot.date,
          path: `${path}[${index}]`,
          kind: 'structured_list',
        });
      }
      walkStructuredFields(records, snapshot, entry, `${path}[${index}]`, options);
    });
    return;
  }
  if (typeof value !== 'object') return;

  const trustedParents = TRUSTED_DATA_KEY_PARENTS[snapshot.snapshotType] || new Set();
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (['ticker', 'symbol'].includes(key) && typeof child === 'string') {
      addMention(records, child, {
        product: snapshot.snapshotType,
        date: snapshot.date,
        path: childPath,
        kind: 'structured_field',
      });
    }
    if (
      trustedParents.has(path)
      && child
      && typeof child === 'object'
      && !Array.isArray(child)
    ) {
      addMention(records, key, {
        product: snapshot.snapshotType,
        date: snapshot.date,
        path: childPath,
        kind: 'structured_key',
      });
    }
    walkStructuredFields(records, snapshot, child, childPath, options);
  }
}

function collectExplicitTextMentions(records, snapshot) {
  const textFields = [
    ['article.bodyText', snapshot.article?.bodyText],
    ['article.headline', snapshot.article?.headline],
    ['article.teaser', snapshot.article?.teaser],
    ['data.headline', snapshot.data?.headline],
    ['data.rawLongsText', snapshot.data?.rawLongsText],
    ['data.rawShortsText', snapshot.data?.rawShortsText],
    ['data.rawNeutralText', snapshot.data?.rawNeutralText],
  ];
  for (const [path, rawText] of textFields) {
    if (typeof rawText !== 'string' || !rawText.trim()) continue;
    const matches = [
      ...rawText.matchAll(/\$([A-Z0-9][A-Z0-9.-]{0,9})\b/g),
      ...rawText.matchAll(/\(([A-Z][A-Z0-9./-]{0,14})\)/g),
    ].filter((match) => {
      // Product/model families such as Nvidia's `(B30/B40)` are not ticker
      // declarations. Retain ordinary slash-separated share-class symbols.
      const candidate = String(match[1] || '').toUpperCase();
      return !/^[A-Z]+\d+(?:\/[A-Z]+\d+)+$/.test(candidate);
    });
    matches.forEach((match, index) => addMention(records, match[1], {
      product: snapshot.snapshotType,
      date: snapshot.date,
      path: `${path}#explicit-${index}`,
      kind: 'text_explicit',
    }));
  }
}

function collectSnapshotMentions(records, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const normalizedSnapshot = {
    ...snapshot,
    snapshotType: String(snapshot.snapshotType || 'unknown').trim() || 'unknown',
    date: normalizeDate(snapshot.date),
  };
  const declaredPositions = normalizedSnapshot.snapshotType === 'the-call'
    ? parseTheCallDeclaredPositions(normalizedSnapshot.article?.bodyText)
    : normalizedSnapshot.snapshotType === 'the-macro-show'
      ? parseMacroShowDeclaredPositions(normalizedSnapshot)
      : null;
  const suppressedListPaths = new Set(
    Object.keys(declaredPositions || {})
      .filter((field) => THE_CALL_POSITION_FIELDS.has(field))
      .map((field) => `data.${field}`),
  );
  walkStructuredFields(
    records,
    normalizedSnapshot,
    normalizedSnapshot,
    '',
    { suppressedListPaths },
  );
  Object.entries(declaredPositions || {}).forEach(([field, tickers]) => {
    tickers.forEach((ticker, index) => addMention(records, ticker, {
      product: normalizedSnapshot.snapshotType,
      date: normalizedSnapshot.date,
      path: `declared-positions.${field}[${index}]`,
      kind: 'declared_position',
    }));
  });
  collectExplicitTextMentions(records, normalizedSnapshot);
}

function collectRiskRangeRowMentions(records, row) {
  if (!row || typeof row !== 'object') return;
  addMention(records, row.ticker, {
    product: 'risk-ranges-table',
    date: row.date,
    path: 'ticker',
    kind: 'risk_range_row',
  });
}

function collectSeedMentions(records, seed) {
  if (!seed || typeof seed !== 'object') return;
  const tickers = normalizeTickerCandidates(seed.ticker);
  tickers.forEach((ticker) => {
    addMention(records, ticker, {
      product: 'dashboard-security-universe',
      path: 'SECURITIES_LIST',
      kind: 'catalog_seed',
    });
    const record = records.get(ticker);
    record.existingUniverse = true;
    record.seedAssetClass = seed.assetClass || null;
    record.catalogName = String(seed.name || '').trim() || null;
  });
}

function serializeRecord(record) {
  const products = [...record.products.values()]
    .sort((left, right) => right.mentionCount - left.mentionCount || left.product.localeCompare(right.product));
  const evidence = [...record.evidence.values()]
    .sort((left, right) => right.mentionCount - left.mentionCount || left.path.localeCompare(right.path))
    .slice(0, 24);
  const discoveryState = record.existingUniverse
    ? 'catalogued'
    : record.confidenceRank >= CONFIDENCE_RANK.structured_field
      ? 'structured'
      : 'candidate';

  return {
    ticker: record.ticker,
    name: record.catalogName,
    catalogName: record.catalogName,
    nameSource: record.catalogName ? 'Dashboard security catalog' : null,
    assetClass: record.seedAssetClass,
    discoveryState,
    confidence: record.confidenceRank >= CONFIDENCE_RANK.structured_field
      ? 'high'
      : record.confidenceRank >= CONFIDENCE_RANK.structured_list
        ? 'medium'
        : 'low',
    confidenceKinds: [...record.confidenceKinds].sort(),
    existingUniverse: record.existingUniverse,
    mentionCount: record.mentionCount,
    pullCount: record.pullKeys.size,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    products,
    evidence,
    identityStatus: 'unverified',
    reviewStatus: 'unreviewed',
    analysisEligible: false,
    hedgeEligible: false,
  };
}

function buildHedgeyeSecurityUniverse({
  snapshots = [],
  riskRangeRows = [],
  seedSecurities = [],
} = {}) {
  const records = new Map();
  const sourcePullCounts = new Map();
  let latestSourceDate = null;

  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const product = String(snapshot.snapshotType || 'unknown').trim() || 'unknown';
    sourcePullCounts.set(product, (sourcePullCounts.get(product) || 0) + 1);
    const date = normalizeDate(snapshot.date);
    if (date && (!latestSourceDate || date > latestSourceDate)) latestSourceDate = date;
    collectSnapshotMentions(records, snapshot);
  }
  for (const row of Array.isArray(riskRangeRows) ? riskRangeRows : []) {
    collectRiskRangeRowMentions(records, row);
    const date = normalizeDate(row?.date);
    if (date && (!latestSourceDate || date > latestSourceDate)) latestSourceDate = date;
  }
  for (const seed of Array.isArray(seedSecurities) ? seedSecurities : []) {
    collectSeedMentions(records, seed);
  }

  const rows = [...records.values()]
    .map(serializeRecord)
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
  const stateCounts = rows.reduce((counts, row) => {
    counts[row.discoveryState] = (counts[row.discoveryState] || 0) + 1;
    return counts;
  }, {});

  return {
    status: 'available',
    historicalOnly: true,
    executable: false,
    rows,
    meta: {
      generatedAt: new Date().toISOString(),
      latestSourceDate,
      snapshotCount: Array.isArray(snapshots) ? snapshots.length : 0,
      riskRangeRowCount: Array.isArray(riskRangeRows) ? riskRangeRows.length : 0,
      seedCount: Array.isArray(seedSecurities) ? seedSecurities.length : 0,
      universeCount: rows.length,
      stateCounts,
      sourcePullCounts: Object.fromEntries([...sourcePullCounts].sort((a, b) => a[0].localeCompare(b[0]))),
      methodology: 'The Call and The Macro Show use their explicit source position sections instead of contaminated legacy parser lists when available. Other structured Hedgeye snapshot/risk-range mentions are retained; fallback parser-list and explicit-text candidates remain ineligible until instrument identity and factor review are complete.',
    },
  };
}

module.exports = {
  AUDITED_FALSE_MENTIONS,
  CONFIDENCE_RANK,
  NAMED_MARKET_ALIASES,
  NON_SECURITY_TOKENS,
  POSITION_LIST_FIELDS,
  RESEARCH_LABEL_TOKENS,
  THE_CALL_POSITION_FIELDS,
  VERIFIED_EVIDENCE_TICKER_ALIASES,
  buildHedgeyeSecurityUniverse,
  normalizeDeclaredPositionEntry,
  normalizeResearchPositionEntry,
  normalizeTickerCandidates,
  parseMacroShowDeclaredPositions,
  parseTheCallDeclaredPositions,
  parseSeedSecurities,
  validDirectTicker,
};
