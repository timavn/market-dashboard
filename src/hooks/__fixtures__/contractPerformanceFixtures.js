// Test-only adapter for existing layout fixtures authored as a combined envelope.
// The resource lifecycle tests exercise the two endpoints independently.
export function historyPayload(payload, account = 'U123', revision = 'history-v1') {
  if (!payload || payload.status === 'unavailable' || payload.tracker?.status === 'unavailable') return payload;
  const complete = payload.availability?.history?.complete
    ?? payload.consolidation?.historyComplete
    ?? payload.availability?.history?.status !== 'incomplete';
  return {
    ...payload, scope: 'account', selectedAccount: account, projectionRevision: revision,
    rows: (payload.rows || []).filter((row) => row.status === 'verified'), activeRows: [],
    availability: { ...payload.availability,
      history: { status: complete ? 'ready' : 'incomplete', complete, observedAt: '2026-09-01T12:00:00Z', source: 'authoritative_ledger' },
      current: { status: 'unavailable', complete: false, observedAt: null },
    },
  };
}

export function currentPayload(payload, account = 'U123', revision = 'history-v1') {
  if (!payload || payload.status === 'unavailable' || payload.tracker?.status === 'unavailable') return payload;
  const complete = payload.availability?.current?.status !== 'unavailable'
    && payload.tracker?.currentDataComplete !== false && payload.consolidation?.currentComplete !== false;
  const rows = (payload.rows || []).filter((row) => ['open', 'awaiting_resolution'].includes(row.status));
  return {
    ...payload, scope: 'account', selectedAccount: account, historyRevision: revision, rows, activeRows: rows,
    availability: { ...payload.availability, current: {
      status: complete ? 'ready' : 'unavailable', complete,
      observedAt: complete ? new Date().toISOString() : null,
    } },
  };
}

export function installSplitPerformanceFixtureMocks(service) {
  let firstRequest = null;
  let firstCurrent = true;
  const read = (account) => service.getPredictionMarketPerformance({
    account, scope: 'account', venue: 'all', market: 'all', sort: 'status', direction: 'asc',
  });
  service.getPredictionMarketPerformanceHistory.mockImplementation(({ account }) => {
    const request = Promise.resolve().then(() => read(account));
    firstRequest = request;
    return request.then((payload) => historyPayload(payload, account));
  });
  service.getPredictionMarketPerformanceCurrent.mockImplementation(({ account }) => {
    const request = firstCurrent && firstRequest ? firstRequest : Promise.resolve().then(() => read(account));
    firstCurrent = false;
    return request.then((payload) => currentPayload(payload, account));
  });
}
