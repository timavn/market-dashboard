import tickCatalog from './dashboardTickResearchCatalog.json';
import researchCatalog from './dashboardResearchCatalog.json';
import marketMappings from '../../data/research/hedgai/market-mappings.json';
import reviewedBook from '../../data/research/hedgai/2026-09-28-baseline.json';

test('keeps the established HedgAI market references consistent across overview and monitor surfaces', () => {
  Object.values(marketMappings).forEach((mapping) => {
    expect(tickCatalog.find((reference) => reference.marketId === mapping.marketId)).toMatchObject({
      sourceTicker: mapping.sourceTicker,
      instrumentId: mapping.instrumentId,
      matchType: mapping.fit,
      label: mapping.label,
    });
  });
});

// Two kinds of reference: an ETF proxy for an overview instrument, and a
// publisher reference where HedgAI itself lists an ETF under the instrument's own
// label (for example UST as "UST 10yr Yield"). Publisher references are always
// visibly identified as such; the ETF price and the instrument stay separate.
const isPublisherReference = (reference) => /publisher reference/.test(reference.basisRelationship);

test('every Tick reference names its published instrument and identifies its basis', () => {
  const publishedRows = new Map(reviewedBook.rows.map((row) => [row.instrumentId, row]));
  expect(new Set(tickCatalog.map((reference) => reference.symbol)).size).toBe(tickCatalog.length);
  tickCatalog.forEach((reference) => {
    expect(publishedRows.has(reference.instrumentId)).toBe(true);
    expect(reference.instrumentId).toBe(`hedgai:${reference.sourceTicker}`);
    expect(reference.matchType).toBe('proxy');
    expect(reference.sourceLabel).toBe(publishedRows.get(reference.instrumentId).sourceLabel);
    expect(reference.basisRelationship).toContain(reference.sourceTicker);
    expect(reference.basisLabel).toContain(reference.sourceTicker);
    expect(reference.label).toContain(reference.sourceTicker);
  });
});

test('ETF proxies map to overview instruments and say so', () => {
  const symbols = new Set(researchCatalog.map((entry) => entry.symbol));
  tickCatalog.filter((reference) => !isPublisherReference(reference)).forEach((reference) => {
    expect(symbols.has(reference.symbol)).toBe(true);
    expect(reference.basisRelationship).toContain(reference.symbol);
    expect(reference.basisLabel).toContain('proxy');
  });
});

test('publisher references keep the publisher label and are visibly source-listed', () => {
  tickCatalog.filter(isPublisherReference).forEach((reference) => {
    expect(reference.basisRelationship).toContain(`labeled ${reference.sourceLabel}`);
    expect(reference.label).toContain('source-listed');
  });
});

test('FX, Treasury price-ETF and different-index publications attach only as labeled publisher references', () => {
  const publisherOnly = ['FXB', 'FXC', 'ULE', 'YCS', 'SHY', 'UST', 'PFIX', 'CNYA', 'UJB'];
  tickCatalog.filter((reference) => publisherOnly.includes(reference.sourceTicker))
    .forEach((reference) => expect(isPublisherReference(reference)).toBe(true));
  // Reciprocal crosses and a different China index never receive a Tick.
  ['USDEUR', 'USDGBP', 'USDCAD', 'CSI300'].forEach((symbol) => {
    expect(tickCatalog.find((reference) => reference.symbol === symbol)).toBeUndefined();
  });
});
