import { analystWorkspaceApi } from './analystClient';
import {
  analystSourceDay,
  analystSourceRefreshDelay,
  loadAnalystSourceReadiness,
  normalizeAnalystSourceReadiness,
} from './analystSourceReadiness';

jest.mock('./analystClient', () => ({ analystWorkspaceApi: { request: jest.fn() } }));

const now = Date.parse('2026-09-14T17:00:00Z');
const source = {
  id: 'risk-ranges', label: 'Risk Ranges', publicationDate: '2026-09-14',
  observedAt: '2026-09-14T12:00:00Z', indexedAt: '2026-09-14T12:01:00Z',
  updatedAt: '2026-09-14T12:01:00Z', usableForDay: true, status: 'ready',
  sourceUri: 'gmail://message/source-1', sourceIds: ['source-1'], evidenceHash: 'verified-content-hash',
};
const payload = (overrides = {}) => ({
  date: '2026-09-14', checkedAt: '2026-09-14T17:00:00Z', automatedSources: [source], ...overrides,
});

test('loads the established daily endpoint and retains actual source update time', async () => {
  analystWorkspaceApi.request.mockResolvedValue(payload());
  expect(await loadAnalystSourceReadiness()).toEqual(payload());
  expect(analystWorkspaceApi.request).toHaveBeenCalledWith('/daily');
  expect(normalizeAnalystSourceReadiness(payload(), now)).toMatchObject({
    available: true, rows: [{ label: 'Risk Ranges', updatedAt: source.updatedAt, usableForDay: true }],
  });
});

test.each([
  { checkedAt: null },
  { checkedAt: 'not a timestamp' },
  { checkedAt: '2026-09-14T16:57:00Z' },
  { checkedAt: '2026-09-14T17:02:00Z' },
  { date: '2026-09-13' },
  { stale: true },
  { cacheOnly: true },
  { mock: true },
  { seeded: true },
  { connected: false },
  { status: 'offline' },
])('clears usability and update readings for invalid freshness %j', (overrides) => {
  expect(normalizeAnalystSourceReadiness(payload(overrides), now)).toMatchObject({
    available: false, checkedAt: null, rows: [{ updatedAt: null, usableForDay: false }],
  });
});

test.each([
  { publicationDate: '2026-09-13' },
  { usableForDay: false },
  { status: 'unavailable' },
  { observedAt: null },
  { indexedAt: null },
  { updatedAt: '2026-09-14T19:00:00Z' },
  { evidenceHash: null },
  { sourceUri: null, sourceIds: [] },
  { stale: true },
  { cacheOnly: true },
  { mock: true },
  { seeded: true },
])('never infers usable sources from incomplete or invalid evidence %j', (overrides) => {
  const result = normalizeAnalystSourceReadiness(payload({ automatedSources: [{ ...source, ...overrides }] }), now);
  expect(result.rows[0].usableForDay).toBe(false);
});

test('never substitutes general review readiness for automated source evidence', () => {
  const result = normalizeAnalystSourceReadiness(payload({ automatedSources: undefined, ready: true, required: [{ ...source, ready: true }] }), now);
  expect(result).toMatchObject({ available: false, rows: [] });
});

test('expires readiness at the Eastern publication-day boundary', () => {
  const beforeMidnight = Date.parse('2026-09-15T03:59:55Z');
  const old = payload({ checkedAt: '2026-09-15T03:59:55Z' });
  expect(analystSourceDay(beforeMidnight)).toBe('2026-09-14');
  expect(analystSourceRefreshDelay(beforeMidnight)).toBe(5000);
  expect(normalizeAnalystSourceReadiness(old, beforeMidnight).rows[0].usableForDay).toBe(true);
  expect(normalizeAnalystSourceReadiness(old, beforeMidnight + 5000)).toMatchObject({ available: false, rows: [{ usableForDay: false }] });
  expect(analystSourceRefreshDelay(now)).toBe(60_000);
});
