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

test('every overview Tick reference names its published instrument and preserves proxy identity', () => {
  const symbols = new Set(researchCatalog.map((entry) => entry.symbol));
  const publishedIds = new Set(reviewedBook.rows.map((row) => row.instrumentId));
  expect(new Set(tickCatalog.map((reference) => reference.symbol)).size).toBe(tickCatalog.length);
  tickCatalog.forEach((reference) => {
    expect(symbols.has(reference.symbol)).toBe(true);
    expect(publishedIds.has(reference.instrumentId)).toBe(true);
    expect(reference.instrumentId).toBe(`hedgai:${reference.sourceTicker}`);
    expect(reference.matchType).toBe('proxy');
    expect(reference.sourceLabel).toBe(reviewedBook.rows.find((row) => row.instrumentId === reference.instrumentId).sourceLabel);
    expect(reference.basisRelationship).toContain(reference.sourceTicker);
    expect(reference.basisRelationship).toContain(reference.symbol);
    expect(reference.basisLabel).toContain(reference.sourceTicker);
    expect(reference.basisLabel).toContain('proxy');
    expect(reference.label).toContain(reference.sourceTicker);
  });
});

test('does not attach inverse FX, bond-price or a different-index publication to overview instruments', () => {
  const unmapped = ['FXB', 'FXC', 'ULE', 'YCS', 'SHY', 'UST', 'PFIX', 'CNYA'];
  expect(tickCatalog.filter((reference) => unmapped.includes(reference.sourceTicker))).toEqual([]);
});
