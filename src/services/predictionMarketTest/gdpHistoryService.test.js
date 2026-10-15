const { parseBeaVintages, parseGdpNowArchives, parseBeaComponents, sourceWorkbookLink } = require('./gdpHistoryService.cjs');
const { normalizeGdpRecord } = require('./gdpResearchRecords.cjs');
const { snapshotFromRecords } = require('./gdpResearchService.cjs');
const { createCardView } = require('./cardView.cjs');
const evidence = { sourceUrl: 'https://www.bea.gov/sites/default/files/2026-08/gdp-gdi-vintage-history.xlsx', verifiedAt: '2026-09-10T15:00:00Z' };
const reading = { quarter: '2026-Q2', stage: 'second', value: 1.5, releasedAt: '2026-08-26' };
const componentSheet = () => [{ sheet: 'T10102-Q', data: [
 ['Table 1.1.2. Contributions to Percent Change in Real Gross Domestic Product'], ['Seasonally adjusted at annual rates'], ['Data published August 26, 2026'],
 ['Line', null, null, '2026Q1', '2026Q2'], ['1', 'GDP', 'A191RL', 2.1, 1.5],
 ['2', 'PCE', 'DPCERY', 0.37, 2.31], ['8', 'Fixed investment', 'A007RY', 1.11, 1.2],
 ['14', 'Inventories', 'A014RY', 0.23, -0.72], ['15', 'Net exports', 'A019RY', -0.37, -1.14],
 ['22', 'Government', 'A822RY', 0.74, -0.16],
] }];

test('vintage parser selects real GDP, preserves Initial/Updated and skips GDI-only updates', () => {
 const sheets = [{ sheet: 'Vintage History', data: [
 ['Vintage History of Quarterly Gross Domestic Product (GDP) and Gross Domestic Income (GDI) Estimates'],
 ['2026Q2'], [null, null, 'GDP', 'GDI', 'Real GDP', 'Real GDI', 'Release Date'],
 [null, 'Second', '32486', '32245', '1.5', '2.2', 'Aug 26, 2026'], [null, 'Advance', '32475', '.....', '1.5', '.....', 'Jul 30, 2026 GDI not published'],
 ['2025Q3'], [null, 'Revised', '31098', '30789', '4.4', '3.5', 'Mar 13, 2026 GDP not open for revision'],
 [null, 'Updated', '31098', '30707', '4.4', '2.4', 'Jan 22, 2026'], [null, 'Initial', '31095', '30706', '4.3', '2.4', 'Dec 23, 2025'],
 ] }];
 const records = parseBeaVintages(sheets, evidence, '2025-Q2');
 expect(records.map((r) => [r.quarter, r.stage, r.value])).toEqual([['2026-Q2', 'second', 1.5], ['2026-Q2', 'advance', 1.5], ['2025-Q3', 'updated', 4.4], ['2025-Q3', 'initial', 4.3]]);
 expect(records[0].releasedAt).toBe('2026-08-26');
});

test('component table validates annualized metric, exact vintage, quarter column and headline', () => {
 const parsed = parseBeaComponents(componentSheet(), reading, evidence);
 expect(parsed).toMatchObject({ kind: 'components', unit: 'percentage_points', quarter: '2026-Q2', values: { consumption: 2.31, fixedInvestment: 1.2, inventories: -0.72, netExports: -1.14, government: -0.16 } });
 for (const patch of [{ quarter: '2026-Q1' }, { value: 4 }, { releasedAt: '2026-07-30' }]) expect(parseBeaComponents(componentSheet(), { ...reading, ...patch }, evidence)).toBeNull();
 const wrongUnits = componentSheet(); wrongUnits[0].data[1] = ['Billions of dollars'];
 expect(parseBeaComponents(wrongUnits, reading, evidence)).toBeNull();
 const missing = componentSheet(); missing[0].data[4][4] = null;
 expect(parseBeaComponents(missing, reading, evidence)).toBeNull();
 expect(() => normalizeGdpRecord({ ...parsed, unit: 'percent_qoq_saar' })).toThrow();
});

test('only original TrackingArchives forecasts load, never pseudo-real-time reconstructions or actuals', () => {
 const original = { sheet: 'TrackingArchives', data: [['Forecast Date', 'Quarter being forecasted', 'GDP Nowcast', 'Advance Estimate From BEA'], [new Date('2026-07-28'), new Date('2026-06-30'), 1.53997, 1.50049]] };
 const records = parseGdpNowArchives([original, { ...original, sheet: 'PseudoRTGDPCompForecasts' }], { ...evidence, sourceUrl: 'https://www.atlantafed.org/history.xlsx' }, '2025-Q2');
 expect(records).toHaveLength(1);
 expect(records[0]).toMatchObject({ value: 1.5, publishedAt: '2026-07-28', quarter: '2026-Q2', targetStage: 'advance' });
 expect(parseGdpNowArchives([{ ...original, sheet: 'PseudoRTGDPCompForecasts' }], evidence, '2025-Q2')).toEqual([]);
});

test('history and component records survive compact serialization independently of native quotes', () => {
 const component = parseBeaComponents(componentSheet(), reading, evidence);
 const record = normalizeGdpRecord({ ...reading, ...evidence, sourceId: 'bea', metric: 'U.S. real GDP', unit: 'percent_qoq_saar', kind: 'reading' });
 const gdp = snapshotFromRecords([record, component], '2026-Q3', { now: Date.parse(evidence.verifiedAt) });
 const compact = createCardView({ marketId: 'gdp', status: 'partial', gdp, contracts: { status: 'unavailable', lines: [] } });
 expect(compact.gdp.readingHistory).toEqual([record]);
 expect(compact.gdp.components).toEqual([component]);
 expect(compact.contracts.lines).toEqual([]);
});

test('workbook discovery only accepts the expected official HTTPS host', () => {
 expect(sourceWorkbookLink('<a href="https://evil.test/gdp-gdi-vintage-history.xlsx">History</a>', /vintage-history.xlsx/, 'https://www.bea.gov', 'www.bea.gov')).toBeNull();
});
