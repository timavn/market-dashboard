import { act, renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import useQuadResearch, { normalizeQuadResearch } from './useQuadResearch';
import { EXCLUSIONS, GROUPS } from '../services/quadResearch/catalog.cjs';

jest.mock('axios', () => ({ get: jest.fn() }));
const benchmark = GROUPS.flatMap(group => group.benchmarks).find(item => item.symbol === 'GLD');
const cell = {
  exposureId: benchmark.exposureId, quad: 1, status: 'supported', classification: 'filled',
  rank: 3, peerCount: 5, meanReturn: 0.025, observations: 12, episodes: 4,
  rankInterval: [2, 4], sampleStart: '2007Q2', sampleEnd: '2026Q2', benchmark,
  diagnostics: { bootstrap: Object.fromEntries([2, 4, 8].map(blockLength => [blockLength, {
    blockLength, seed: 42, draws: 5000, validDraws: 4900, invalidDraws: 100,
    interval: { lower: 2, upper: 4 }, reason: null,
  }])) },
};
const snapshot = {
  schemaVersion: 1, source: 'independent-quad-research', historicalOnly: true,
  available: true, verified: true, version: 'b'.repeat(64), methodology: { version: 'quad-ranks-v1' },
  cutoff: '2026Q2', generatedAt: '2026-09-08T12:00:00.000Z',
  groups: GROUPS, cells: [cell], sourceHashes: ['a'.repeat(64)],
};

beforeEach(() => axios.get.mockReset());

test('accepts dated independent research and resolves benchmark definitions from the fixed catalog', () => {
  const normalized = normalizeQuadResearch(snapshot);
  expect(normalized.cells[0]).toMatchObject({ rank: 3, benchmark: { symbol: 'GLD', definition: benchmark.definition } });
  expect(normalized.historicalOnly).toBe(true);
  expect(normalizeQuadResearch({ ...snapshot, cutoff: '2026-Q2', cells: [{ ...cell, sampleStart: '2007-Q2', sampleEnd: '2026-Q2' }] })).not.toBeNull();
});

test('accepts individually stable block intervals even when their union spans four ranks', () => {
  const intervals = { 2: { lower: 1, upper: 3 }, 4: { lower: 2, upper: 4 }, 8: { lower: 3, upper: 5 } };
  const diagnostics = { bootstrap: Object.fromEntries([2, 4, 8].map(blockLength => [blockLength, {
    ...cell.diagnostics.bootstrap[blockLength], interval: intervals[blockLength],
  }])) };
  expect(normalizeQuadResearch({ ...snapshot, cells: [{ ...cell, rankInterval: [1, 5], diagnostics }] })).not.toBeNull();
});

test.each([
  null,
  { ...snapshot, available: false },
  { ...snapshot, source: 'mock' },
  { ...snapshot, schemaVersion: 2 },
  { ...snapshot, verified: false },
  { ...snapshot, version: 'unverified-edition' },
  { ...snapshot, sourceHashes: ['unverified-source'] },
  { ...snapshot, historicalOnly: false },
  { ...snapshot, generatedAt: null },
  { ...snapshot, sourceHashes: [] },
  { ...snapshot, cells: [cell, cell] },
  ...['mock', 'seed', 'seeded', 'synthetic', 'simulated', 'stale', 'cacheOnly', 'revoked'].map(flag => ({ ...snapshot, [flag]: true })),
  ...[
    { rank: 0 }, { rank: 6 }, { rank: '3' }, { peerCount: 14 }, { observations: 7 },
    { episodes: 2 }, { rankInterval: [1, 5] }, { rankInterval: [4, 4] },
    { meanReturn: null }, { sampleStart: null }, { sampleStart: '2026Q3' },
    { benchmark: { ...benchmark, symbol: 'SPY' } }, { source: 'portfolio-derived' }, { mock: true },
    { diagnostics: {} },
    { diagnostics: { bootstrap: { ...cell.diagnostics.bootstrap, 8: { ...cell.diagnostics.bootstrap[8], invalidDraws: 501, validDraws: 4499 } } } },
    { diagnostics: { bootstrap: { ...cell.diagnostics.bootstrap, 4: { ...cell.diagnostics.bootstrap[4], interval: { lower: 1, upper: 4 } } } } },
  ].map(patch => ({ ...snapshot, cells: [{ ...cell, ...patch }] })),
])('rejects malformed or unverified research %#', payload => {
  expect(normalizeQuadResearch(payload)).toBeNull();
});

test('excludes undefined factors and refuses to overwrite a published cell', () => {
  const malicious = [
    ...Object.keys(EXCLUSIONS).map(exposureId => ({ ...cell, exposureId })),
    { ...cell, quad: 3 },
  ];
  expect(normalizeQuadResearch({ ...snapshot, cells: malicious }).cells).toEqual([]);
});

test('loads the read-only research endpoint and exposes no prior data after a failed refresh', async () => {
  axios.get.mockResolvedValueOnce({ data: snapshot }).mockRejectedValueOnce(new Error('provider error details'));
  const { result } = renderHook(() => useQuadResearch());
  expect(result.current.estimates).toBeNull();
  await waitFor(() => expect(result.current.status).toBe('available'));
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/api/research/quad-ranks'), expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 40000 }));
  act(() => result.current.retry());
  expect(result.current.estimates).toBeNull();
  await waitFor(() => expect(result.current.status).toBe('unavailable'));
  expect(result.current.estimates).toBeNull();
});

test('clears estimates after a corrupt response and does not retain an omitted cell', async () => {
  axios.get.mockResolvedValueOnce({ data: snapshot })
    .mockResolvedValueOnce({ data: { ...snapshot, cells: [] } })
    .mockResolvedValueOnce({ data: { ...snapshot, historicalOnly: false } });
  const { result } = renderHook(() => useQuadResearch());
  await waitFor(() => expect(result.current.status).toBe('available'));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.estimates?.cells).toEqual([]));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.status).toBe('unavailable'));
  expect(result.current.estimates).toBeNull();
});

test('aborts inactive requests and ignores responses from a previous activation', async () => {
  let finish;
  axios.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ data: { ...snapshot, cells: [] } });
  const { result, rerender } = renderHook(({ active }) => useQuadResearch({ active }), { initialProps: { active: true } });
  const previousSignal = axios.get.mock.calls[0][1].signal;
  rerender({ active: false });
  expect(previousSignal.aborted).toBe(true);
  expect(result.current.estimates).toBeNull();
  rerender({ active: true });
  await waitFor(() => expect(result.current.estimates?.cells).toEqual([]));
  await act(async () => finish({ data: snapshot }));
  expect(result.current.estimates.cells).toEqual([]);
});
