import { createContractPerformanceHistoryStore } from './contractPerformanceHistoryStore';
import { historyPayload } from '../hooks/__fixtures__/contractPerformanceFixtures';

const saved = (revision = 'v1', id = 'final') => historyPayload({ rows: [{ id, status: 'verified', displayState: 'SETTLED', pnl: 5 }] }, 'U123', revision);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

describe('account history session owner', () => {
  test('single-flights initial loading and accepts the first current revision without restarting it', async () => {
    const pending = deferred(); const load = jest.fn(() => pending.promise); const store = createContractPerformanceHistoryStore(load);
    const first = store.refresh('U123');
    expect(store.refresh('U123', { revision: 'v1' })).toBe(first);
    pending.resolve(saved()); await first;
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot('U123').data).toEqual(saved());
    await store.refresh('U123'); expect(load).toHaveBeenCalledTimes(1);
  });
  test('replaces a known revision atomically and never unions removed rows', async () => {
    const pending = deferred(); const load = jest.fn().mockResolvedValueOnce(saved()).mockReturnValueOnce(pending.promise);
    const store = createContractPerformanceHistoryStore(load); await store.refresh('U123');
    const next = store.refresh('U123', { revision: 'v2' });
    expect(store.getSnapshot('U123').data).toBeNull();
    pending.resolve(saved('v2', 'corrected')); await next;
    expect(store.getSnapshot('U123').data.rows.map((row) => row.id)).toEqual(['corrected']);
  });
  test('discards a pending prior revision and retries once, without looping on an old server revision', async () => {
    const pending = deferred(); const load = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(saved('v1'));
    const store = createContractPerformanceHistoryStore(load);
    store.refresh('U123'); store.refresh('U123', { revision: 'v2' });
    pending.resolve(saved()); await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot('U123').data).toBeNull();
  });
  test('retains original history/provenance on a refresh failure but revokes it on authorization denial', async () => {
    const payload = saved(); const load = jest.fn().mockResolvedValueOnce(payload).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce({ response: { status: 403 } });
    const store = createContractPerformanceHistoryStore(load); await store.refresh('U123');
    await store.refresh('U123', { force: true }); expect(store.getSnapshot('U123').data).toBe(payload);
    await store.refresh('U123', { force: true }); expect(store.getSnapshot('U123').data).toBeNull();
  });
  test.each(['fromCache', 'stale', 'isMock', 'isSeeded', 'cacheOnly'])('rejects %s history', async (flag) => {
    const store = createContractPerformanceHistoryStore(jest.fn().mockResolvedValue({ ...saved(), [flag]: true }));
    await store.refresh('U123'); expect(store.getSnapshot('U123').data).toBeNull();
  });
  test('rejects wrong-account and active records from historical storage', async () => {
    const load = jest.fn().mockResolvedValueOnce({ ...saved(), selectedAccount: 'U456' }).mockResolvedValueOnce({ ...saved(), rows: [{ status: 'open' }] });
    const store = createContractPerformanceHistoryStore(load);
    await store.refresh('U123'); expect(store.getSnapshot('U123').data).toBeNull();
    await store.refresh('U123'); expect(store.getSnapshot('U123').data).toBeNull();
  });
  test('malformed refreshes cannot erase previously accepted accounting evidence', async () => {
    const payload = saved(); const load = jest.fn().mockResolvedValueOnce(payload).mockResolvedValueOnce({ rows: [], fromCache: true });
    const store = createContractPerformanceHistoryStore(load); await store.refresh('U123');
    await store.refresh('U123', { force: true });
    expect(store.getSnapshot('U123').data).toBe(payload);
    expect(store.getSnapshot('U123').status).toBe('ready');
  });
  test('invalidates an account without losing subscribers or allowing a pending reply to restore it', async () => {
    const pending = deferred(); const load = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(saved());
    const store = createContractPerformanceHistoryStore(load); const listener = jest.fn(); store.subscribe('U123', listener);
    const request = store.refresh('U123'); store.invalidate('U123'); pending.resolve(saved()); await request;
    expect(store.getSnapshot('U123').data).toBeNull(); expect(load).toHaveBeenCalledTimes(1);
    const calls = listener.mock.calls.length; await store.refresh('U123');
    expect(listener.mock.calls.length).toBeGreaterThan(calls); expect(store.getSnapshot('U123').data).not.toBeNull();
  });
  test('session teardown discards late history and never starts a replacement read', async () => {
    const pending = deferred(); const load = jest.fn(() => pending.promise); const store = createContractPerformanceHistoryStore(load);
    const request = store.refresh('U123'); store.clear(); pending.resolve(saved()); await request;
    expect(store.getSnapshot('U123').data).toBeNull(); expect(load).toHaveBeenCalledTimes(1);
  });
});
