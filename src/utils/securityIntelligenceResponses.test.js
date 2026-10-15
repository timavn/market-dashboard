import {
  canMergeSecurityIntelligenceHistory,
  mergeSecurityIntelligenceHistory,
  replaceSecurityIntelligenceCurrent,
  securityIntelligencePayload,
} from './securityIntelligenceResponses';

const snapshot = (entry = {}, envelope = {}) => ({
  schemaVersion: 1,
  marketDate: '2026-09-10',
  status: 'ready',
  generatedAt: '2026-09-10T15:00:00Z',
  bySymbol: { TEST: entry },
  ...envelope,
});
const history = [{ marketDate: '2026-09-09', directReferences: [{ id: 'prior-note' }] }];
const oldEntry = () => ({
  decision: { trade: { value: 'BULLISH' } },
  signals: { trend: 'BULLISH' },
  current: { references: [{ id: 'old-alias' }] },
  directReferences: [{ id: 'old-note' }],
  todayReferences: [{ id: 'old-today' }],
  inferredReferences: [{ id: 'old-proxy' }],
  supplementalRange: { lrr: 10, hrr: 20 },
  lastVerifiedDecision: { trade: { value: 'BULLISH', sourceDate: '2026-09-10' } },
  products: { 'risk-ranges': { status: 'available', facts: ['old fact'] } },
  history,
});

test('fresh current fields replace old evidence and omitted aliases without mutating either response', () => {
  const previous = snapshot(oldEntry(), { products: [{ id: 'old-product' }], _cache: { cached: true } });
  const incoming = snapshot({ decision: { trade: { value: 'BEARISH' } }, directReferences: [], history: [] }, {
    generatedAt: '2026-09-10T16:00:00Z', coverage: { state: 'partial' },
  });
  const before = JSON.stringify([previous, incoming]);
  const result = replaceSecurityIntelligenceCurrent(previous, incoming);
  expect(result).toEqual({ ...incoming, bySymbol: { TEST: { ...incoming.bySymbol.TEST, history } } });
  expect(result.bySymbol.TEST).not.toHaveProperty('signals');
  expect(result.bySymbol.TEST).not.toHaveProperty('lastVerifiedDecision');
  expect(result).not.toHaveProperty('_cache');
  expect(result).not.toHaveProperty('products');
  expect(JSON.stringify([previous, incoming])).toBe(before);
});

test.each(['unavailable', 'missing', 'conflict', 'stale', 'offline', 'cache-only', 'seed', 'mock'])(
  'preserves the incoming %s state and provenance instead of old available evidence', (status) => {
    const incoming = snapshot({
      decision: {}, directReferences: [], products: { 'risk-ranges': { status, facts: [] } },
    }, { status, coverage: { state: status }, provider: 'new-source', generatedAt: null });
    const result = replaceSecurityIntelligenceCurrent(snapshot(oldEntry()), incoming);
    expect(result).toEqual({ ...incoming, bySymbol: { TEST: { ...incoming.bySymbol.TEST, history } } });
  },
);

test.each([null, undefined, {}, { bySymbol: {} }, { data: { bySymbol: null } }])(
  'does not fall back to old current data for empty or malformed incoming %j', (incoming) => {
    expect(replaceSecurityIntelligenceCurrent(snapshot(oldEntry()), incoming)).toBe(incoming);
  },
);

test.each([{}, { TEST: null }, { OTHER: {} }])('keeps missing/null symbols missing: %j', (bySymbol) => {
  const incoming = snapshot({}, { bySymbol });
  expect(replaceSecurityIntelligenceCurrent(snapshot(oldEntry()), incoming).bySymbol).toEqual(bySymbol);
  expect(mergeSecurityIntelligenceHistory(incoming, snapshot(oldEntry())).bySymbol).toEqual(bySymbol);
});

test('history completion changes only the two explicit history fields', () => {
  const current = snapshot({ products: { 'risk-ranges': { status: 'conflict', facts: [] } } }, {
    status: 'partial', provider: 'current-source', coverage: { state: 'partial' },
  });
  const historicalReferences = [{ marketDate: '2026-09-08', id: 'older-note' }];
  const incomingHistory = snapshot({ ...oldEntry(), historicalReferences }, {
    generatedAt: '2026-09-10T12:00:00Z', provider: 'history-source',
    products: [{ id: 'old-product' }], coverage: { state: 'complete' },
  });
  const before = JSON.stringify([current, incomingHistory]);
  expect(mergeSecurityIntelligenceHistory(current, incomingHistory)).toEqual({
    ...current, bySymbol: { TEST: { ...current.bySymbol.TEST, history, historicalReferences } },
  });
  expect(JSON.stringify([current, incomingHistory])).toBe(before);
});

test.each([{}, { history: [] }, { history: null }, { historicalReferences: [] }])(
  'history replacement clears prior historical fields rather than unioning them: %j', (entry) => {
    const current = snapshot({ ...oldEntry(), historicalReferences: history });
    const result = mergeSecurityIntelligenceHistory(current, snapshot(entry));
    const { history: ignored, ...currentFields } = oldEntry();
    expect(result.bySymbol.TEST).toEqual({ ...currentFields, ...entry });
  },
);

test('an omitted historical symbol clears its prior history but not its current fields', () => {
  const current = snapshot(oldEntry());
  const { history: ignored, ...currentFields } = oldEntry();
  expect(mergeSecurityIntelligenceHistory(current, snapshot({}, { bySymbol: {} })).bySymbol.TEST)
    .toEqual(currentFields);
});

test.each([
  ['different date', { marketDate: '2026-09-11' }],
  ['missing date', { marketDate: null }],
  ['invalid date', { marketDate: 'invalid' }],
  ['impossible date', { marketDate: '2026-02-30' }],
  ['different schema', { schemaVersion: 2 }],
  ['different map', { bySymbol: undefined, securities: { TEST: { history } } }],
])('refuses historical mixing across %s', (_label, changed) => {
  const current = snapshot({ history: [] });
  const other = snapshot(oldEntry(), changed);
  expect(canMergeSecurityIntelligenceHistory(current, other)).toBe(false);
  expect(mergeSecurityIntelligenceHistory(current, other)).toBe(current);
  expect(replaceSecurityIntelligenceCurrent(other, current)).toBe(current);
});

test.each([null, 'bad-date', '2026-02-30'])('matching invalid dates do not establish scope: %s', (marketDate) => {
  const current = snapshot({}, { marketDate });
  expect(canMergeSecurityIntelligenceHistory(current, snapshot(oldEntry(), { marketDate }))).toBe(false);
});

test.each([
  ['raw/raw', false, false], ['wrapped/raw', true, false],
  ['raw/wrapped', false, true], ['wrapped/wrapped', true, true],
])('%s preserves only current wrapper metadata', (_label, wrapCurrent, wrapHistory) => {
  const currentPayload = snapshot({ decision: {}, history: [] }, { schemaVersion: '1' });
  const historyPayload = snapshot(oldEntry());
  const current = wrapCurrent ? { requestId: 'fresh', data: currentPayload } : currentPayload;
  const previous = wrapHistory ? { requestId: 'old', transportStatus: 'cached', data: historyPayload } : historyPayload;
  const expectedPayload = { ...currentPayload, bySymbol: { TEST: { decision: {}, history } } };
  const expected = wrapCurrent ? { requestId: 'fresh', data: expectedPayload } : expectedPayload;
  expect(replaceSecurityIntelligenceCurrent(previous, current)).toEqual(expected);
  expect(mergeSecurityIntelligenceHistory(current, previous)).toEqual(expected);
  expect(securityIntelligencePayload(current)).toBe(currentPayload);
});

test('supports the legacy securities map without adding a bySymbol alias', () => {
  const current = snapshot({}, { bySymbol: undefined, securities: { TEST: { decision: {} } } });
  const previous = snapshot({}, { bySymbol: undefined, securities: { TEST: oldEntry() } });
  const result = replaceSecurityIntelligenceCurrent(previous, current);
  expect(result.securities.TEST).toEqual({ decision: {}, history });
  expect(result.bySymbol).toBeUndefined();
});

test('canonical v2 product conflicts and removed facts remain authoritative after history', () => {
  const previous = snapshot(oldEntry(), { schemaVersion: 2 });
  const current = snapshot({ products: { 'risk-ranges': { status: 'conflict', fields: {}, facts: [] } } }, {
    schemaVersion: 2, health: { status: 'conflict' },
  });
  const result = mergeSecurityIntelligenceHistory(replaceSecurityIntelligenceCurrent(previous, current), previous);
  expect(result).toEqual({ ...current, bySymbol: { TEST: { ...current.bySymbol.TEST, history } } });
});
