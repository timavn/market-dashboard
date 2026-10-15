import { finalContractRow, forbiddenContractPayload } from './contractPerformancePresentation';

// Only immutable, account-authorized settled history is retained in memory.
// No current marks or browser persistence belong to this owner.
export function createContractPerformanceHistoryStore(load) {
  const accounts = new Map();
  const entryFor = (account) => {
    if (!accounts.has(account)) accounts.set(account, {
      snapshot: { data: null, status: 'idle', error: null }, listeners: new Set(), request: null,
      epoch: 0, expectedRevision: null, retryAfterRequest: false,
    });
    return accounts.get(account);
  };
  const publish = (entry, patch) => {
    entry.snapshot = { ...entry.snapshot, ...patch };
    entry.listeners.forEach((listener) => listener());
  };
  function refresh(account, { revision = null, force = false } = {}) {
    if (!account) return Promise.resolve(null);
    const entry = entryFor(account);
    if (revision && entry.expectedRevision !== revision && entry.snapshot.data?.projectionRevision !== revision) {
      const replacesKnownRevision = Boolean(entry.expectedRevision || entry.snapshot.data);
      entry.expectedRevision = revision;
      if (replacesKnownRevision) {
        entry.epoch += 1;
        entry.retryAfterRequest = Boolean(entry.request);
      }
      publish(entry, { data: null, error: null, status: 'loading' });
    }
    if (entry.request) return entry.request;
    if (!force && entry.snapshot.data) return Promise.resolve(entry.snapshot.data);
    const epoch = entry.epoch;
    const requestedRevision = entry.expectedRevision;
    publish(entry, { status: entry.snapshot.data ? 'refreshing' : 'loading', error: null });
    const promise = Promise.resolve().then(() => load({ account })).then((payload) => {
      if (epoch !== entry.epoch) return null;
      const valid = !forbiddenContractPayload(payload) && Array.isArray(payload.rows)
        && payload.selectedAccount === account && payload.scope === 'account'
        && ['ready', 'incomplete'].includes(payload.availability?.history?.status)
        && typeof payload.projectionRevision === 'string' && payload.projectionRevision.length > 0
        && payload.rows.every((row) => finalContractRow(row) && !forbiddenContractPayload(row)
          && (!row.accountId || row.accountId === account));
      if (!valid || (entry.expectedRevision && payload.projectionRevision !== entry.expectedRevision)) {
        entry.retryAfterRequest = valid && requestedRevision !== entry.expectedRevision;
        publish(entry, {
          status: entry.snapshot.data ? 'ready' : 'unavailable',
          error: 'Verified history could not be refreshed.',
        });
        return null;
      }
      publish(entry, { data: payload, status: 'ready', error: null });
      entry.expectedRevision = null;
      return payload;
    }).catch((error) => {
      if (epoch !== entry.epoch) return null;
      const denied = [401, 403].includes(error?.response?.status);
      publish(entry, {
        data: denied ? null : entry.snapshot.data,
        status: entry.snapshot.data && !denied ? 'ready' : 'unavailable',
        error: error?.response?.data?.code === 'HISTORY_PREPARING' ? 'Saved history is being prepared.' : 'History could not be refreshed.',
      });
      return null;
    }).finally(() => {
      if (entry.request === promise) entry.request = null;
      if (accounts.get(account) === entry && entry.retryAfterRequest) {
        entry.retryAfterRequest = false;
        refresh(account);
      }
    });
    entry.request = promise;
    return promise;
  }
  return {
    refresh,
    invalidate: (account) => {
      const entry = entryFor(account);
      entry.epoch += 1;
      entry.expectedRevision = null;
      entry.retryAfterRequest = false;
      publish(entry, { data: null, status: 'unavailable', error: 'Account history is unavailable.' });
    },
    getSnapshot: (account) => entryFor(account).snapshot,
    subscribe: (account, listener) => {
      const entry = entryFor(account); entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    clear: () => {
      accounts.forEach((entry) => { entry.epoch += 1; entry.listeners.clear(); });
      accounts.clear();
    },
  };
}
