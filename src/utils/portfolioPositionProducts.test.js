import { portfolioPositionProducts } from './portfolioPositionProducts';

const row = { holding: 'ETHA', heldSide: 'LONG' };
const citation = (product, id = product) => ({ id: `cite_${id}`, product, publicationDate: '2026-10-08',
  sourceUri: `https://app.hedgeye.com/feed_items/${id}`, title: product });
const reading = (product, label, kind = 'source-position', extra = {}) => ({ product,
  productLabel: product === 'the-call' ? 'The Call' : 'ETF Pro', reading: label, kind,
  date: '2026-10-08', relation: 'direct', sourceTicker: 'ETHA', citations: [citation(product)], ...extra });

test('groups exact source position and partial actions by captured product, without inventing an entry rationale', () => {
  const brief = { holdings: [{ ...row, productReadings: [reading('the-call', 'Source Long position'),
    reading('etf-pro', 'Sell some', 'action'), reading('etf-pro', 'Source Long position')] }] };
  const original = JSON.parse(JSON.stringify(brief));
  const products = portfolioPositionProducts(brief.holdings[0], brief);
  expect(products.map(product => product.productLabel)).toEqual(['The Call', 'ETF Pro']);
  expect(products[1].readings.map(item => item.reading)).toEqual(['Source Long position', 'Sell some']);
  expect(products[1].citations).toEqual([citation('etf-pro')]);
  expect(brief).toEqual(original);
});

test('saved reviews use both supportive and opposing captured alignment evidence for the exact held side', () => {
  const brief = { dailyRollup: { sections: [{ id: 'position-contradictions', blocks: [{ type: 'table', rows: [
    { ...row, evidence: [reading('the-call', 'Source Long position'), reading('etf-pro', 'Sell some', 'action')] },
    { holding: 'ETHA', heldSide: 'SHORT', evidence: [reading('short-only', 'Source Short position')] },
    { holding: 'IBIT', heldSide: 'LONG', evidence: [reading('other-holding', 'Source Long position')] },
  ] }] }] } };
  expect(portfolioPositionProducts(row, brief).map(product => product.product)).toEqual(['the-call', 'etf-pro']);
  expect(portfolioPositionProducts({ ...row, holding: 'UNKNOWN' }, brief)).toEqual([]);
});

test('deduplicates unchanged labels but retains every original report citation and date', () => {
  const items = [reading('the-call', 'Source Long position', 'source-position', { date: '2026-10-07', citations: [{ ...citation('the-call', 'earlier'), publicationDate: '2026-10-07' }] }),
    reading('the-call', 'Source Long position'), reading('the-call', 'Source Long position')];
  const products = portfolioPositionProducts({ ...row, productReadings: items });
  expect(products).toHaveLength(1);
  expect(products[0].readings).toHaveLength(1);
  expect(products[0].readings[0].date).toBe('2026-10-08');
  expect(products[0].citations.map(source => source.id)).toEqual(['cite_earlier', 'cite_the-call']);
  expect(products[0].citations[0].publicationDate).toBe('2026-10-07');
});

test('keeps differing source instrument and explicit proxy relation beside its source reading', () => {
  const products = portfolioPositionProducts({ ...row, productReadings: [reading('risk-ranges', 'Bearish Trend', 'trend', {
    sourceTicker: 'ETH', relation: 'proxy', productLabel: 'Risk Ranges' })] });
  expect(products[0].readings[0]).toMatchObject({ sourceTicker: 'ETH', relation: 'proxy', reading: 'Bearish Trend' });
});

test('does not create products from bare ticker mentions, inferred exposure, undated labels or uncited data', () => {
  const invalid = [reading('mention', 'ETHA was mentioned', 'mention'), reading('inferred', 'Long', 'source-position', { relation: 'inferred' }),
    reading('undated', 'Long', 'source-position', { date: '' }), reading('uncited', 'Long', 'source-position', { citations: [] })];
  expect(portfolioPositionProducts({ ...row, productReadings: invalid })).toEqual([]);
  expect(portfolioPositionProducts({ ...row, trade: 'BULLISH', trend: 'BULLISH', heldSide: 'LONG',
    sources: { trade: { citation: citation('today') } } })).toEqual([]);
});

test('resolves only this immutable capture’s citation IDs', () => {
  const item = reading('the-call', 'Source Long position', 'source-position', { citations: [], citationIds: ['cite_saved'] });
  const brief = { citations: [citation('the-call', 'saved')], dailyRollup: { sections: [{ id: 'position-confirmations',
    blocks: [{ rows: [{ ...row, evidence: [item] }] }] }] } };
  expect(portfolioPositionProducts(row, brief)[0].citations).toEqual(brief.citations);
  expect(portfolioPositionProducts(row, { ...brief, citations: [] })).toEqual([]);
});

test.each(['Buy', 'Short', 'Wait'])('keeps the exact captured HedgAI %s label independent of strategy qualification', position => {
  const source = citation('hedgai-signals');
  const tick = { status: 'published', position, matchType: 'exact', sourceTicker: 'ETHA',
    qualified: false, publishedAt: '2026-10-08', citationIds: [source.id] };
  expect(portfolioPositionProducts({ ...row, tick }, { citations: [source] })[0]).toMatchObject({
    productLabel: 'HedgAI Signals', readings: [{ reading: position, kind: 'tick', sourceTicker: 'ETHA', relation: 'direct' }],
  });
  expect(portfolioPositionProducts({ ...row, tick: { ...tick, sourceTicker: 'ETH' } }, { citations: [source] })).toEqual([]);
});

test('rejects malformed dates and fabricated source descriptors while allowing verified historical research', () => {
  for (const date of ['wrong', '2026-13-08', '2026-02-30', '2026-10-08T25:00:00Z']) {
    expect(portfolioPositionProducts({ ...row, productReadings: [reading('the-call', 'Source Long position', 'source-position', { date })] })).toEqual([]);
  }
  for (const flag of ['mock', 'seeded', 'fixture', 'synthetic', 'inferred']) {
    expect(portfolioPositionProducts({ ...row, productReadings: [reading('the-call', 'Source Long position', 'source-position', { [flag]: true })] })).toEqual([]);
    expect(portfolioPositionProducts({ ...row, productReadings: [reading('the-call', 'Source Long position', 'source-position', {
      citations: [{ ...citation('the-call'), [flag]: true }] })] })).toEqual([]);
  }
  expect(portfolioPositionProducts({ ...row, productReadings: [reading('the-call', 'Source Long position', 'source-position',
    { date: '2025-10-08', status: 'historical' })] })).toHaveLength(1);
});

test.each(['excluded', 'wait'])('keeps a verified legacy %s Tick with the original source date', status => {
  const source = citation('hedgai-signals');
  const tick = { status, position: status === 'wait' ? 'Wait' : 'Buy', qualified: false,
    matchType: 'exact', sourceTicker: 'ETHA', source: { publishedAt: '2026-10-08', citation: source } };
  expect(portfolioPositionProducts({ ...row, tick })[0].readings[0]).toMatchObject({ reading: tick.position, date: '2026-10-08' });
});

test('reads legacy full refresh evidence and hides superseded book labels while preserving all cited reports', () => {
  const short = citation('etf-pro', 'short');
  const long = citation('etf-pro', 'long');
  const rank = citation('portfolio-solutions', 'rank');
  const brief = { refreshReport: { citations: [short, long, rank], holdings: [{ ticker: 'ETHA', heldSide: 'LONG', evidence: [
    reading('etf-pro', 'Source Short position', 'source-position', { citations: [], citationIds: [short.id], date: '2026-09-22' }),
    reading('etf-pro', 'Source Long position', 'source-position', { citations: [], citationIds: [long.id], date: '2026-09-16', lastConfirmedAt: '2026-10-05' }),
    reading('portfolio-solutions', 'Published rank 8', 'rank', { citations: [], citationIds: [rank.id], relation: undefined, sourceTicker: undefined }),
  ] }] } };
  const products = portfolioPositionProducts(row, brief);
  expect(products[0].readings.map(item => item.reading)).toEqual(['Source Long position']);
  expect(products[0].citations).toEqual([short, long]);
  expect(products[1].readings[0]).toMatchObject({ relation: 'direct', sourceTicker: 'ETHA', reading: 'Published rank 8' });
});

test('keeps a captured Tick proxy only with its explicit verified instrument mapping', () => {
  const tick = { status: 'published', position: 'Buy', matchType: 'proxy', sourceTicker: 'ETH', publishedAt: '2026-10-08',
    source: { citation: citation('hedgai-signals') }, instrumentMapping: { heldTicker: 'ETHA', sourceTicker: 'ETH',
      relationship: 'proxy', verified: true, sourceUrl: 'https://issuer.example/mapping' } };
  expect(portfolioPositionProducts({ ...row, tick })[0].readings[0]).toMatchObject({ relation: 'proxy', sourceTicker: 'ETH', reading: 'Buy' });
  expect(portfolioPositionProducts({ ...row, tick: { ...tick, instrumentMapping: { ...tick.instrumentMapping, verified: false } } })).toEqual([]);
});
