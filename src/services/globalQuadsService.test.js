const { verifiedGlobalQuads, loadGlobalQuads } = require('./globalQuadsService.cjs');
const id = 'a'.repeat(64);
const item = () => ({ schemaVersion:1, source:'hedgeye-published-global-quads', data:{ sources:{ [id]: {
  id, asOf:'2026-08-27',publishedAt:'2026-08-31T14:22:14Z',gmailMessageId:'abc',s3Key:`hedgeye-email/assets/global-quads/${id}.png`,
} }, groups:{ g20:{ group:'g20',asOf:'2026-08-27',sourceId:id, columns:[{id:'2026-Q3',label:'3Q26E',kind:'estimate'}],
  currentCountries:['United States'],rows:[{country:'United States',values:{'2026-Q3':{quad:4,kind:'estimate',sourceId:id}}}],
} } } });
test('returns only sourced dated research and private source links', () => {
  const snapshot=verifiedGlobalQuads(item());
  expect(snapshot.date).toBe('2026-08-27');expect(snapshot.data.sources[id].imageUrl).toContain('/api/hedgeye/global-quads/source/');
  expect(snapshot.data.sources[id].s3Key).toBeUndefined();
});
test.each(['mock','seed','inferred','portfolio-derived'])('rejects %s source', source => {
  expect(verifiedGlobalQuads({...item(),source})).toBeNull();
});
test('rejects absent provenance and invalid cells', () => {
  const record=item();record.data.sources={};expect(verifiedGlobalQuads(record)).toBeNull();
  const invalid=item();invalid.data.groups.g20.rows[0].values['2026-Q3'].quad=8;expect(verifiedGlobalQuads(invalid)).toBeNull();
});
test('retains dated research when ingestion requires attention', async () => {
  const db={get:jest.fn(({Key})=>({promise:async()=>({Item:Key.snapshotType==='global-quads'?item():{issues:{abc:{publishedAt:'2026-09-01'}}}})}))};
  const snapshot=await loadGlobalQuads(db);expect(snapshot.available).toBe(true);expect(snapshot.ingestion.status).toBe('attention');
});
test('provider read failure rejects rather than inventing a snapshot', async () => {
  const db={get:()=>({promise:async()=>{throw new Error('offline');}})};
  await expect(loadGlobalQuads(db)).rejects.toThrow('offline');
});
test('health read failure does not hide verified dated research', async () => {
  const db={get:({Key})=>({promise:async()=>{
    if(Key.snapshotType.endsWith('-health')) throw new Error('health offline');
    return {Item:item()};
  }})};
  const snapshot=await loadGlobalQuads(db);
  expect(snapshot.available).toBe(true);expect(snapshot.ingestion.status).toBe('unavailable');
});
test('rejects impossible source dates and mismatched quarter designations', () => {
  const invalid=item();invalid.data.sources[id].asOf='2026-02-30';
  expect(verifiedGlobalQuads(invalid)).toBeNull();
  const mismatch=item();mismatch.data.groups.g20.columns[0].kind='actual';
  expect(verifiedGlobalQuads(mismatch)).toBeNull();
});
test('accepts a reviewed screenshot without inventing an email or publication time', () => {
  const record=item();const source=record.data.sources[id];
  source.sourceType='reviewed-screenshot';source.publishedAt=null;delete source.gmailMessageId;
  source.verification={method:'visual-source-comparison',reviewedBy:'Codex',reviewedAt:'2026-09-09T00:00:00Z',contentHash:'b'.repeat(64)};
  record.data.groups.g20.contentHash='b'.repeat(64);
  const result=verifiedGlobalQuads(record);
  expect(result.data.sources[id].sourceUrl).toBeNull();expect(result.data.sources[id].publishedAt).toBeNull();
  source.verification.contentHash='c'.repeat(64);expect(verifiedGlobalQuads(record)).toBeNull();
  delete source.verification;expect(verifiedGlobalQuads(record)).toBeNull();
});
test('inactive email extraction issues are retained outside screenshot feed health', async () => {
  const db={get:({Key})=>({promise:async()=>({Item:Key.snapshotType==='global-quads'?item():{mode:'reviewed-screenshot',issues:{abc:{publishedAt:'2026-09-01'}}}})})};
  const result=await loadGlobalQuads(db);
  expect(result.ingestion.status).toBe('ok');expect(result.ingestion.mode).toBe('reviewed-screenshot');expect(result.ingestion.issues).toEqual([]);
});
