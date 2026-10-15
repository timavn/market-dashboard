import {
  buildCanonicalResearchProductRows,
  buildResearchProductRows,
  historicalResearchDisplayRow,
} from './portfolioResearchRows';

const DATE = '2026-09-10';
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const product = (overrides = {}) => ({
  id: 'risk-ranges', label: 'Risk Ranges', status: 'indexed', marketDate: DATE,
  ...overrides,
});
const reference = (overrides = {}) => ({
  id: 'range-evidence', productId: 'risk-ranges', productLabel: 'Risk Ranges',
  marketDate: DATE, publishedAt: `${DATE}T13:00:00Z`, qualityStatus: 'indexed',
  kind: 'primary_risk_range', matchType: 'direct', matchedText: 'GLD',
  value: { lrr: 180, hrr: 200, trend: 'BULLISH' },
  excerpt: 'GLD LRR 180 – HRR 200; Trend BULLISH', sourceUrl: '/research/risk-ranges/current',
  ...overrides,
});
const canonical = (overrides = {}) => product({ status: 'available', fields: {}, ...overrides });

test('builds exact current indexed facts without mutating frozen references or product metadata', () => {
  const source = freeze(reference());
  const publication = freeze(product());
  const references = freeze([source]);
  const productsById = new Map([['risk-ranges', publication]]);
  const rows = buildResearchProductRows({
    references, productsById, symbol: ' gld ', marketDate: DATE,
    requireCurrentIndexed: true, includeEmptyProducts: true,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    key: 'risk-ranges', productId: 'risk-ranges', productLabel: 'Risk Ranges',
    marketDate: DATE, publishedAt: `${DATE}T13:00:00Z`, referenceCount: 1,
    state: 'available', status: 'indexed',
    factLines: ['GLD risk range is 180–200.', 'GLD trend is BULLISH.'],
    reference: {
      id: `${DATE}-risk-ranges-product-row`, sourceUrl: '/research/risk-ranges/current',
      direction: null, marketDate: DATE,
    },
  });
  expect(rows[0].references).toEqual([source]);
  expect(rows[0].references[0]).toBe(source);
  expect(rows[0].evidence[0].reference).toBe(source);
  expect(productsById.get('risk-ranges')).toBe(publication);
  expect(source.id).toBe('range-evidence');
});

test.each([
  ['indexed', 'empty'], ['not_due', 'empty'], ['missing', 'unavailable'], ['failed', 'unavailable'],
])('keeps an empty %s publication distinct from missing evidence as %s', (status, state) => {
  const rows = buildResearchProductRows({
    references: [], productsById: new Map([['risk-ranges', freeze(product({ status }))]]),
    marketDate: DATE, requireCurrentIndexed: true, includeEmptyProducts: true,
  });
  expect(rows[0]).toMatchObject({ state, status, referenceCount: 0, factLines: [], evidence: [] });
  expect(rows[0].reference).toMatchObject({ excerpt: null, sourceUrl: null });
});

test.each([
  { status: 'missing', marketDate: DATE },
  { status: 'failed', marketDate: DATE },
  { status: 'indexed', marketDate: '2026-09-09' },
])('does not attach current evidence to a non-current indexed publication %j', (publication) => {
  const rows = buildResearchProductRows({
    references: freeze([reference()]),
    productsById: new Map([['risk-ranges', freeze(product(publication))]]),
    marketDate: DATE, requireCurrentIndexed: true, includeEmptyProducts: true,
  });
  expect(rows[0]).toMatchObject({ state: 'unavailable', referenceCount: 0, references: [], factLines: [] });
  expect(rows[0].reference.sourceUrl).toBeNull();
});

test('omits excluded and unsupported placeholders while allowing an explicitly referenced tracker', () => {
  const publications = freeze([
    product(),
    product({ id: 'momo-tracker', label: 'MOMO Tracker' }),
    product({ id: 'volume', label: 'Volume' }),
    product({ id: 'unknown', label: 'Unknown' }),
    product({ id: 'unsupported-feed', label: 'Unsupported', cadence: 'unsupported' }),
  ]);
  const productsById = new Map(publications.map((item) => [item.id, item]));
  const options = { productsById, marketDate: DATE, requireCurrentIndexed: true, includeEmptyProducts: true };
  expect(buildResearchProductRows({ ...options, references: [] }).map((row) => row.productId)).toEqual(['risk-ranges']);
  const rows = buildResearchProductRows({ ...options, references: freeze([
    reference({ productId: 'momo-tracker', productLabel: 'MOMO Tracker', kind: 'tracker_trade', value: 'BEARISH', excerpt: 'GLD tracker trade remains bearish.' }),
    reference({ productId: 'volume' }),
    reference({ productId: 'unknown' }),
    reference({ productId: 'the-call', marketDate: null }),
  ]) });
  expect(rows.map((row) => row.productId).sort()).toEqual(['momo-tracker', 'risk-ranges']);
  expect(rows.find((row) => row.productId === 'momo-tracker').factLines).toEqual(['GLD trade signal is BEARISH.']);
});

test('does not manufacture a source URL from the publication and prefers a real publication time over synthetic midnight', () => {
  const rows = buildResearchProductRows({
    references: freeze([reference({ sourceUrl: null, publishedAt: `${DATE}T00:00:00.000Z` })]),
    productsById: new Map([['risk-ranges', freeze(product({ sourceUrl: '/publication-only', publishedAt: `${DATE}T12:30:00Z` }))]]),
    symbol: 'GLD', marketDate: DATE, requireCurrentIndexed: true,
  });
  expect(rows[0].state).toBe('available');
  expect(rows[0].publishedAt).toBe(`${DATE}T12:30:00Z`);
  expect(rows[0].reference.sourceUrl).toBeNull();
  const boilerplate = buildResearchProductRows({
    references: freeze([reference({ kind: 'summary_mention', excerpt: 'Prepared exclusively for a subscriber. Unsubscribe here.', matchedText: null })]),
    productsById: new Map([['risk-ranges', product()]]), marketDate: DATE,
  });
  expect(boilerplate[0]).toMatchObject({ state: 'empty', evidence: [], factLines: [] });
});

test('groups historical references by date and product, then projects raw published detail rather than current fact sentences', () => {
  const references = freeze([
    reference({ id: 'old', marketDate: '2026-09-08', publishedAt: '2026-09-08T14:00:00Z' }),
    reference({ id: 'later-publication', productId: 'the-call', productLabel: 'The Call', marketDate: '2026-09-09', publishedAt: '2026-09-09T15:00:00Z', kind: 'summary_mention', value: null, excerpt: 'GLD discussion from The Call.' }),
    reference({ id: 'earlier-publication', marketDate: '2026-09-09', publishedAt: '2026-09-09T13:00:00Z' }),
  ]);
  const rows = buildResearchProductRows({ references, symbol: 'GLD', groupByDate: true });
  expect(rows.map((row) => row.key)).toEqual([
    '2026-09-09\u0000risk-ranges', '2026-09-09\u0000the-call', '2026-09-08\u0000risk-ranges',
  ]);
  const display = rows.map(historicalResearchDisplayRow);
  expect(display[0]).toEqual({
    key: '2026-09-09\u0000risk-ranges', productLabel: 'Risk Ranges', dateLabel: 'Sep 9',
    note: 'BULLISH · GLD LRR 180 – HRR 200; Trend BULLISH',
  });
  expect(display[0].note).not.toBe(rows[0].factLines.join(' '));
  expect(display[1].note).toBe('GLD discussion from The Call.');
  expect(references.map((item) => item.id)).toEqual(['old', 'later-publication', 'earlier-publication']);
});

test('does not invent historical text or dates when the supplied projection has no reference', () => {
  expect(historicalResearchDisplayRow(freeze({ key: 'empty', productLabel: 'The Call' }))).toEqual({
    key: 'empty', productLabel: 'The Call', dateLabel: 'Date unavailable', note: undefined,
  });
});

test('keeps canonical Portfolio Solutions rank and four fact sentences ahead of derived trade and trend', () => {
  const facts = freeze([
    { sourceEventId: 'rank', kind: 'portfolio_solutions_rank', value: 4, excerpt: 'GLD ranked #4; Sizing 2% – 6%; Weekly ▲ 3', sourceUrl: '/research/portfolio-solutions', publishedAt: `${DATE}T14:26:00Z`, qualityStatus: 'indexed' },
    { sourceEventId: 'monthly', kind: 'portfolio_solutions_mover', value: 7, excerpt: 'GLD monthly rank change 7' },
  ]);
  const security = freeze({ symbol: ' gld ', products: {
    solutions: canonical({ id: 'portfolio-solutions', label: 'Portfolio Solutions', evidenceIds: ['rank', 'monthly'], fields: {
      rank: { value: 4 }, trade: { value: 'BULLISH' }, trend: { value: 'BULLISH' }, facts,
    } }),
  } });
  const [row] = buildCanonicalResearchProductRows({ security, marketDate: DATE });
  expect(row.factLines).toEqual([
    'GLD is ranked #4 today.', 'Recommended position sizing is 2% – 6%.',
    'Weekly rank change is +3.', 'Monthly rank change is +7.',
  ]);
  expect(row.reference).toMatchObject({ sourceEventId: 'rank', sourceUrl: '/research/portfolio-solutions', publishedAt: `${DATE}T14:26:00Z`, qualityStatus: 'indexed', matchType: 'direct' });
  expect(row.referenceCount).toBe(2);
  expect(row.evidence).toBe(facts);
});

test('uses a canonical rank fallback without making up source provenance', () => {
  const security = freeze({ symbol: 'IAK', products: {
    solutions: canonical({ id: 'portfolio-solutions', label: 'Portfolio Solutions', fields: { rank: { value: 9 } } }),
  } });
  const [row] = buildCanonicalResearchProductRows({ security, marketDate: DATE });
  expect(row.factLines).toEqual(['IAK is ranked #9 today.']);
  expect(row.reference).toMatchObject({ sourceUrl: null, sourceEventId: null, qualityStatus: null, publishedAt: null });
  expect(row.referenceCount).toBe(0);
});

test('normalizes structured canonical bias aliases while leaving narrative sentiment out of trade and trend', () => {
  const security = freeze({ symbol: 'GLD', products: {
    structured: canonical({ fields: { trade: { value: 'long' }, trend: { value: 'hold' }, bias: { value: 'negative' }, side: 'SHORT' } }),
    narrative: canonical({ id: 'the-call', label: 'The Call', fields: { trade: { value: 'optimism is improving' }, trend: { value: 'strong momentum' }, facts: [{ excerpt: 'Published GLD commentary.' }] } }),
  } });
  const rows = buildCanonicalResearchProductRows({ security, productOrder: new Map([['risk-ranges', 0], ['the-call', 1]]) });
  expect(rows[0].factLines).toEqual(['Trade BULLISH', 'Trend NEUTRAL', 'SHORT · Bias BEARISH']);
  expect(rows[1].factLines).toEqual(['Published GLD commentary.']);
});

test('preserves canonical non-available states without exposing populated fields and applies product exclusions', () => {
  const states = ['unavailable', 'conflict', 'not_due', 'not_listed'];
  const security = freeze({ symbol: 'GLD', products: Object.fromEntries([
    ...states.map((status, index) => [status, canonical({ id: `product-${index}`, label: `Product ${index}`, status, fields: { trade: { value: 'BULLISH' } } })]),
    ['excluded', canonical({ id: 'volume' })], ['reference-only-tracker', canonical({ id: 'momo-tracker' })],
  ]) });
  const rows = buildCanonicalResearchProductRows({ security });
  expect(rows.map((row) => row.state)).toEqual(states);
  rows.forEach((row) => {
    expect(row.factLines).toEqual([]);
    expect(row.reference.excerpt).toBeNull();
  });
});
