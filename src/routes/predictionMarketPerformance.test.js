const express = require('express');
const http = require('http');
const {
  buildSettlementProviders,
  createPredictionMarketPerformanceRoutes,
} = require('./predictionMarketPerformance');

class MemoryDocumentClient {
  constructor(items = []) {
    this.items = new Map(items.map((item) => [this.key(item.accountId, item.recordKey), JSON.parse(JSON.stringify(item))]));
  }

  key(accountId, recordKey) {
    return `${accountId}\u0000${recordKey}`;
  }

  query(params) {
    return { promise: async () => ({
      Items: [...this.items.values()].filter((item) => item.accountId === params.ExpressionAttributeValues[':accountId']),
    }) };
  }

  get(params) {
    return { promise: async () => ({ Item: this.items.get(this.key(params.Key.accountId, params.Key.recordKey)) }) };
  }

  put(params) {
    return { promise: async () => {
      this.items.set(this.key(params.Item.accountId, params.Item.recordKey), JSON.parse(JSON.stringify(params.Item)));
      return {};
    } };
  }

  update() {
    return { promise: async () => ({}) };
  }

  transactWrite(params) {
    return { promise: async () => {
      for (const operation of params.TransactItems) {
        const put = operation.Put;
        const key = this.key(put.Item.accountId, put.Item.recordKey);
        const current = this.items.get(key);
        if (put.ConditionExpression?.includes('attribute_not_exists') && current) {
          throw Object.assign(new Error('conditional create failed'), { code: 'TransactionCanceledException' });
        }
        if (put.ConditionExpression === '#version = :expectedVersion'
          && Number(current?.version) !== Number(put.ExpressionAttributeValues[':expectedVersion'])) {
          throw Object.assign(new Error('version conflict'), { code: 'TransactionCanceledException' });
        }
      }
      params.TransactItems.forEach(({ Put }) => {
        this.items.set(this.key(Put.Item.accountId, Put.Item.recordKey), JSON.parse(JSON.stringify(Put.Item)));
      });
      return {};
    } };
  }
}

function request(server, { method = 'GET', path, body = null, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: payload == null ? {} : { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw ? JSON.parse(raw) : null,
      }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function capturingHealth(accountId, observedAt = new Date().toISOString()) {
  return {
    accountId,
    recordKey: 'health#capture',
    itemType: 'health',
    status: 'capturing',
    lastSuccessfulCaptureAt: observedAt,
    observedAt,
    updatedAt: observedAt,
  };
}

describe('prediction market performance automatic tracking', () => {
  test('saved history reads and execution details make no provider or ledger calls and survive current outages', async () => {
    const final = {
      accountId: 'U123', recordKey: 'lifecycle#1#1', lifecycleId: 'final', itemType: 'lifecycle',
      conId: 1, market: 'wti', exchange: 'KALSHI', contractLabel: 'WTI 80 YES',
      status: 'verified', verification: 'verified_settlement', resolutionType: 'expiry',
      resolvedDate: '2026-08-21', openedAt: '2026-08-20T15:00:00Z', entryCost: 5, paid: 10,
      performanceComplete: true, entryQuantity: 10, remainingQuantity: 0,
    };
    const client = new MemoryDocumentClient([final]);
    const query = jest.spyOn(client, 'query');
    const live = jest.fn(async () => { throw new Error('Gateway offline'); });
    const history = jest.fn(async () => ({ complete: true, status: 'ready', fromDate: '2026-01-01', toDate: '2026-09-10', snapshotId: 'report-one' }));
    let allowed = ['U123'];
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: client, getExpectedAccounts: () => allowed, getManagedAccounts: live,
      readHistoricalExecutions: history, sidecarRequest: jest.fn(), logger: { warn: jest.fn() },
    });
    await routes.historyService.warm();
    expect(routes.historyService.get('U123').payload.rows).toHaveLength(1);
    query.mockClear(); history.mockClear(); live.mockClear();
    const app = express();
    app.use('/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const first = await request(server, { path: '/performance/history?account=U123' });
      expect(first.status).toBe(200);
      expect(first.body.summary.realizedPnl).toBe(5);
      expect(first.body.availability.history.complete).toBe(true);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const read = await request(server, { path: '/performance/history?account=U123' });
        expect(read.body.projectionRevision).toBe(first.body.projectionRevision);
      }
      const detail = await request(server, { path: `/performance/final/executions?account=U123&revision=${first.body.projectionRevision}` });
      expect(detail.status).toBe(200);
      expect(query).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); expect(live).not.toHaveBeenCalled();
      const current = await request(server, { path: '/performance/current?account=U123' });
      expect(current.status).toBe(200);
      expect(current.body.availability.current.status).toBe('unavailable');
      expect(current.body.historyRevision).toBe(first.body.projectionRevision);
      expect((await request(server, { path: '/performance/history?account=U123' })).body).toEqual(first.body);
      let releaseAuthorization; let authorizationStarted;
      const entered = new Promise((resolve) => { authorizationStarted = resolve; });
      const deferred = new Promise((resolve) => { releaseAuthorization = resolve; });
      jest.spyOn(routes.historyService, 'authorize').mockImplementationOnce(async () => {
        authorizationStarted(); await deferred; return 'U123';
      });
      const pendingDetail = request(server, { path: `/performance/final/executions?account=U123&revision=${first.body.projectionRevision}` });
      await entered;
      client.items.get(client.key('U123', final.recordKey)).paid = 12;
      const newer = await routes.historyService.publish('U123');
      releaseAuthorization();
      const replaced = await pendingDetail;
      expect(replaced.status).toBe(409);
      expect(replaced.body.projectionRevision).toBe(newer.projectionRevision);
      let rejectProvider; let providerStarted;
      const providerEntered = new Promise((resolve) => { providerStarted = resolve; });
      live.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectProvider = reject; providerStarted();
      }));
      const revokedCurrent = request(server, { path: '/performance/current?account=U123' });
      await providerEntered;
      allowed = ['U456'];
      rejectProvider(new Error('Gateway disconnected during authorization change'));
      const revoked = await revokedCurrent;
      expect(revoked.status).toBe(403);
      expect(revoked.body.historyRevision).toBeUndefined();
      expect(revoked.body.availability).toBeUndefined();
      expect(revoked.body.selectedAccount).toBeUndefined();
      expect((await request(server, { path: '/performance/history?account=U123' })).status).toBe(403);
      expect((await request(server, { path: '/performance/final/executions?account=U123' })).status).toBe(403);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  test('history preparation is explicit and never launches work from a list request', async () => {
    const query = jest.fn(); const history = jest.fn(); const live = jest.fn();
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: { query }, getExpectedAccounts: () => ['U123'],
      getManagedAccounts: live, readHistoricalExecutions: history,
    });
    const app = express(); app.use('/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const result = await request(server, { path: '/performance/history?account=U123' });
      expect(result.status).toBe(503); expect(result.body.code).toBe('HISTORY_PREPARING');
      const detail = await request(server, { path: '/performance/final/executions?account=U123&revision=previous-server' });
      expect(detail.status).toBe(503); expect(detail.body.code).toBe('HISTORY_PREPARING');
      expect(query).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled(); expect(live).not.toHaveBeenCalled();
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  test.each(['capture_write', 'capture_expired'])('current rows are withdrawn when %s happens during slow enrichment', async (reason) => {
    const now = Date.now();
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#slow-current#1', lifecycleId: 'slow-current', itemType: 'lifecycle',
      status: 'open', version: 1, market: 'wti', exchange: 'KALSHI', conId: 9001,
      contractKey: 'KXWTID-26AUG24-T80-YES', eventTicker: 'KXWTID-26AUG24-T80',
      contractLabel: 'WTI above $80 YES', contractSide: 'YES', contractRule: 'above', strike: 80,
      entryQuantity: 10, netQuantity: 10, remainingQuantity: 10, entryCost: 4.3, risked: 4.3,
      paid: 0, openedAt: '2026-08-22T16:00:00.000Z', expiration: '20260824',
      performanceComplete: true, basisStatus: 'complete', valuationStatus: 'pending',
    };
    let markStarted; let releaseMark;
    const entered = new Promise((resolve) => { markStarted = resolve; });
    const mark = jest.fn(() => new Promise((resolve) => { releaseMark = resolve; markStarted(); }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([lifecycle, capturingHealth('U123', new Date(now).toISOString())]),
      getExpectedAccounts: () => ['U123'], getManagedAccounts: async () => ['U123'],
      sidecarRequest: async () => ({ ok: false, status: 'offline' }),
      markProviders: { kalshi: mark }, readEnrichmentTimeoutMs: 1000,
      logger: { warn: jest.fn() },
    });
    const app = express(); app.use('/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    let clock;
    try {
      const pending = request(server, { path: '/performance/current?account=U123' });
      await entered;
      if (reason === 'capture_write') await routes.reconciler.reconcileAccount('U123');
      else clock = jest.spyOn(Date, 'now').mockReturnValue(now + 190_000);
      releaseMark({ price: 0.6, state: 'live_bid', source: 'kalshi_direct_bid', observedAt: new Date(now).toISOString() });
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body.rows).toEqual([]);
      expect(response.body.availability.current).toMatchObject({ status: 'unavailable', complete: false });
    } finally {
      clock?.mockRestore();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('current requests starting inside an unfinished capture cannot reuse the prior fresh capture', async () => {
    const client = new MemoryDocumentClient([capturingHealth('U123')]);
    let releaseWrite; let writeStarted;
    const entered = new Promise((resolve) => { writeStarted = resolve; });
    const deferred = new Promise((resolve) => { releaseWrite = resolve; });
    const put = client.put.bind(client);
    jest.spyOn(client, 'put').mockImplementationOnce((params) => ({ promise: async () => {
      writeStarted(); await deferred; return put(params).promise();
    } }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: client, getExpectedAccounts: () => ['U123'], getManagedAccounts: async () => ['U123'],
      sidecarRequest: async () => ({ ok: false, status: 'offline' }), logger: { warn: jest.fn() },
    });
    const app = express(); app.use('/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const capture = routes.reconciler.reconcileAccount('U123');
    try {
      await entered;
      const current = await request(server, { path: '/performance/current?account=U123' });
      expect(current.status).toBe(200);
      expect(current.body.rows).toEqual([]);
      expect(current.body.availability.current.complete).toBe(false);
    } finally {
      releaseWrite(); await capture;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('retains independent settled evidence during an outage, excludes disputed records, and restores live coverage', async () => {
    const final = {
      accountId: 'U123', recordKey: 'lifecycle#1#1', lifecycleId: 'final', itemType: 'lifecycle',
      conId: 1, market: 'wti', exchange: 'KALSHI', contractLabel: 'WTI 80 YES',
      status: 'verified', verification: 'verified_settlement', resolutionType: 'expiry',
      resolvedDate: '2026-08-21', entryCost: 5, paid: 10, performanceComplete: true,
      entryQuantity: 10, remainingQuantity: 0,
    };
    let connected = true;
    const history = { status: 'conflict', complete: false, conflicts: [{ existing: { conId: 2 }, incoming: { conId: 2 } }] };
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([
        final,
        { ...final, recordKey: 'lifecycle#2#1', lifecycleId: 'disputed', conId: 2 },
        { ...final, recordKey: 'lifecycle#3#1', lifecycleId: 'unsupported', conId: 3, verification: 'user_confirmed' },
        { ...final, recordKey: 'lifecycle#4#1', lifecycleId: 'missing-basis', conId: 4, entryCost: null, performanceComplete: false },
        { ...final, recordKey: 'lifecycle#5#1', lifecycleId: 'active', conId: 5, status: 'open', verification: 'ibkr_live_execution', netQuantity: 10 },
        capturingHealth('U123'),
      ]),
      getExpectedAccounts: async () => ['U123'],
      getManagedAccounts: async () => { if (!connected) throw new Error('offline'); return ['U123']; },
      readHistoricalExecutions: async () => history,
      sidecarRequest: jest.fn(), logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const read = () => request(server, { path: '/api/prediction-markets/performance?account=U123' });
    try {
      const live = await read();
      expect(live.body.rows.map((row) => row.id).sort()).toEqual(['active', 'final']);
      connected = false;
      const offline = await read();
      expect(offline.status).toBe(200);
      expect(offline.body.rows.map((row) => row.id)).toEqual(['final']);
      expect(offline.body.activeRows).toEqual([]);
      expect(offline.body.summary).toMatchObject({ realizedPnl: 5, pnl: null, openPnl: null, realizedScope: 'verified_records' });
      expect(offline.body.availability).toMatchObject({
        history: { status: 'incomplete', source: 'authoritative_ledger', verifiedRecordCount: 1 },
        current: { status: 'unavailable', observedAt: null },
      });
      connected = true;
      const recovered = await read();
      expect(recovered.body.rows.map((row) => row.id).sort()).toEqual(['active', 'final']);
      expect(recovered.body.availability.current.status).toBe('ready');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
  test('withholds period totals when source coverage is complete but ledger evidence is quarantined', async () => {
    const final = {
      accountId: 'U123', recordKey: 'lifecycle#1#1', lifecycleId: 'final', itemType: 'lifecycle',
      conId: 1, market: 'wti', exchange: 'KALSHI', status: 'verified', verification: 'verified_settlement',
      resolutionType: 'expiry', resolvedDate: '2026-08-21', entryCost: 5, paid: 10,
      performanceComplete: true, entryQuantity: 10, remainingQuantity: 0,
    };
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([
        final, { ...final, recordKey: 'lifecycle#2#1', lifecycleId: 'incomplete', conId: 2, status: 'review' },
        capturingHealth('U123'),
      ]),
      getManagedAccounts: async () => ['U123'],
      readHistoricalExecutions: async () => ({ status: 'ready', complete: true, trades: [] }),
      sidecarRequest: jest.fn(), logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await request(server, { path: '/api/prediction-markets/performance?account=U123' });
      expect(response.body.summary).toMatchObject({ realizedPnl: 5, realizedScope: 'verified_records', pnl: null, complete: false });
      expect(response.body.availability.history).toMatchObject({ status: 'incomplete', verifiedRecordCount: 1 });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  test('returns verified ForecastEx settlement marks in one no-store batch', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      url: `https://www.forecastex.com/api/download?date=${dataDate.replaceAll('-', '')}`,
      sha256: 'a'.repeat(64),
      fetchedAt: '2026-08-25T16:00:00.000Z',
      rows: [
        {
          eventContract: 'FES_082426_7675',
          subtype: 'YES',
          expirationDate: '2026-08-25T10:00:00-05:00',
          settlementPrice: 0,
        },
        {
          eventContract: 'FES_082426_7675',
          subtype: 'NO',
          expirationDate: '2026-08-25T10:00:00-05:00',
          settlementPrice: 1,
        },
      ],
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient(),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      loadOfficialForecastExPrices,
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await request(server, {
        method: 'POST',
        path: '/api/prediction-markets/performance/settlement-marks',
        body: {
          positions: [{
            localSymbol: 'FES_082426_7675_YES',
            contractKey: 'FES_082426_7675_YES',
            contractSide: 'YES',
            exchange: 'FORECASTX',
            expiration: '20260825',
            conId: 7675,
          }],
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.body).toMatchObject({
        status: 'available',
        historicalOnly: true,
        executable: false,
        coverage: {
          requestedCount: 1,
          verifiedSettlementCount: 1,
          awaitingSettlementCount: 0,
          unavailableCount: 0,
        },
        rows: [{
          localSymbol: 'FES_082426_7675_YES',
          status: 'verified_settlement',
          settlementPrice: 0,
          settlementSource: 'forecastex_verified_settlement',
        }],
      });
      expect(loadOfficialForecastExPrices).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('returns the ledger fail-closed when an applicable optional mark read stalls', async () => {
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#slow-read#1', lifecycleId: 'slow-read', itemType: 'lifecycle',
      status: 'open', version: 1, market: 'wti', exchange: 'KALSHI', conId: 9001,
      contractKey: 'KXWTID-26AUG24-T80-YES', eventTicker: 'KXWTID-26AUG24-T80',
      contractLabel: 'WTI above $80 YES', contractSide: 'YES', contractRule: 'above', strike: 80,
      entryQuantity: 10, netQuantity: 10, remainingQuantity: 10, entryCost: 4.3, risked: 4.3,
      paid: 0, openedAt: '2026-08-22T16:00:00.000Z', expiration: '20260824',
      performanceComplete: true, basisStatus: 'complete', valuationStatus: 'pending',
      updatedAt: '2026-08-22T16:00:00.000Z',
    };
    const never = () => new Promise(() => {});
    const getResolverSettlements = jest.fn(never);
    const kalshiMark = jest.fn(never);
    const logger = { warn: jest.fn() };
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([lifecycle, capturingHealth('U123')]),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      getResolverSettlements,
      markProviders: { kalshi: kalshiMark },
      readEnrichmentTimeoutMs: 20,
      logger,
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const startedAt = Date.now();
      const response = await request(server, { path: '/api/prediction-markets/performance?account=U123' });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(response.status).toBe(200);
      expect(response.body.rows).toEqual([
        expect.objectContaining({
          id: 'slow-read', displayState: 'OPEN', markState: 'unavailable',
          currentValue: null, pnl: null, roi: null, settlementValue: null,
        }),
      ]);
      expect(response.body.tracker).toMatchObject({ status: 'ready', trackingCount: 1 });
      expect(getResolverSettlements).not.toHaveBeenCalled();
      expect(kalshiMark).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('returning active rows without a mark'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('serves settled history without waiting on optional resolver reads', async () => {
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#settled-fast#1', lifecycleId: 'settled-fast', itemType: 'lifecycle',
      status: 'verified', verification: 'verified_settlement', version: 1, market: 'sp500', exchange: 'FORECASTX', conId: 9002,
      contractKey: 'FES_082126_7700_YES', eventTicker: 'FES_082126_7700',
      contractLabel: 'Above 7,700 YES', contractSide: 'YES', contractRule: 'above', strike: 7700,
      entryQuantity: 10, netQuantity: 0, remainingQuantity: 0, entryCost: 4.3, risked: 4.3,
      paid: 10, pnl: 5.7, resolvedDate: '2026-08-24', resolutionType: 'expiry',
      performanceComplete: true, basisStatus: 'complete',
      settlementSymbol: 'ESU26',
      settlementEvidence: { source: 'forecastex_official_prices', payoutPerContract: 1 },
      updatedAt: '2026-08-24T22:00:00.000Z',
    };
    const getResolverSettlements = jest.fn(() => new Promise(() => {}));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([lifecycle]),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      getResolverSettlements,
      readEnrichmentTimeoutMs: 2_500,
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const startedAt = Date.now();
      const response = await request(server, { path: '/api/prediction-markets/performance?account=U123&market=sp500' });
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(response.status).toBe(200);
      expect(response.body.rows).toEqual([
        expect.objectContaining({ id: 'settled-fast', displayState: 'SETTLED', pnl: 5.7 }),
      ]);
      expect(getResolverSettlements).not.toHaveBeenCalled();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('reuses one fresh authoritative ledger projection across asset filters', async () => {
    const lifecycle = (market, conId, pnl) => ({
      accountId: 'U123', recordKey: `lifecycle#${conId}#1`, lifecycleId: `${market}-${conId}`, itemType: 'lifecycle',
      status: 'verified', verification: 'verified_settlement', version: 1, market, exchange: 'FORECASTX', conId,
      contractKey: `${market === 'wti' ? 'COMCO' : 'METLG'}_082126_${conId}_YES`,
      eventTicker: `${market === 'wti' ? 'COMCO' : 'METLG'}_082126_${conId}`,
      contractLabel: `Above ${conId} YES`, contractSide: 'YES', contractRule: 'above', strike: conId,
      entryQuantity: 10, remainingQuantity: 0, entryCost: 5, risked: 5,
      paid: 5 + pnl, pnl, roi: pnl / 5, resolutionType: 'expiry', resolvedDate: '2026-08-21',
      performanceComplete: true, settlementEvidence: { payoutPerContract: pnl > 0 ? 1 : 0 },
    });
    const dynamodb = new MemoryDocumentClient([
      lifecycle('wti', 80, 5),
      lifecycle('gold', 2500, -5),
    ]);
    dynamodb.query = jest.fn(dynamodb.query.bind(dynamodb));
    const getKnownAccounts = jest.fn(async () => ['U123']);
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      getKnownAccounts,
      performanceProjectionMaxAgeMs: 10_000,
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const first = await request(server, { path: '/api/prediction-markets/performance?account=U123&market=wti' });
      const queryCount = dynamodb.query.mock.calls.length;
      const second = await request(server, { path: '/api/prediction-markets/performance?account=U123&market=gold' });

      expect(first.status).toBe(200);
      expect(first.headers['x-data-cache']).toBe('dynamodb');
      expect(first.body.rows).toEqual([expect.objectContaining({ market: 'wti', pnl: 5 })]);
      expect(second.status).toBe(200);
      expect(second.headers['x-data-cache']).toBe('authoritative-ledger-projection');
      expect(second.body.rows).toEqual([expect.objectContaining({ market: 'gold', pnl: -5 })]);
      // The account catalog is intentionally refreshed independently of the
      // cached ledger projection so live coverage changes are never hidden.
      expect(dynamodb.query).toHaveBeenCalledTimes(queryCount + 1);
      expect(getKnownAccounts).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('defaults to all accounts and excludes incomplete activity coverage from consolidated totals', async () => {
    const lifecycle = (accountId, conId, pnl) => ({
      accountId, recordKey: `lifecycle#${conId}#1`, lifecycleId: `${accountId}-${conId}`, itemType: 'lifecycle',
      status: 'verified', verification: 'verified_settlement', version: 1, market: 'sp500', exchange: 'FORECASTX', conId,
      contractKey: `FES_082126_${conId}_YES`, eventTicker: `FES_082126_${conId}`,
      contractLabel: `Above ${conId} YES`, contractSide: 'YES', contractRule: 'above', strike: conId,
      entryQuantity: 100, remainingQuantity: 0, entryCost: 50, risked: 50,
      paid: 50 + pnl, pnl, roi: pnl / 50, resolutionType: 'expiry', resolvedDate: '2026-08-21',
      performanceComplete: true, settlementEvidence: { payoutPerContract: pnl > 0 ? 1 : 0 },
    });
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([
        lifecycle('U111', 7700, 50),
        lifecycle('U222', 7750, -50),
        capturingHealth('U111'),
        capturingHealth('U222'),
      ]),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U111', 'U222'],
      readHistoricalExecutions: async (accountId) => accountId === 'U111'
        ? { status: 'ready', complete: true, trades: [], fromDate: '2026-01-01', toDate: '2026-08-25' }
        : { status: 'disabled', complete: false, trades: [] },
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await request(server, { path: '/api/prediction-markets/performance' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        scope: 'all',
        selectedVenue: 'all',
        summary: { count: 1, pnl: null, realizedPnl: 50, complete: false },
        tracker: { status: 'incomplete', incompleteAccountCount: 1 },
        consolidation: {
          complete: false,
          includedAccounts: ['U111'],
          excludedAccounts: [{ accountId: 'U222', reason: 'Historical activity source not configured.' }],
        },
      });
      expect(response.body.rows).toHaveLength(2);
      expect(response.body.rows.find((row) => row.accountId === 'U222')).toMatchObject({
        consolidationEligible: false,
        coverageMessage: 'Historical activity source not configured.',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('uses the configured Contract P&L allowlist and rejects retained Roth history', async () => {
    const rothSettled = {
      accountId: 'U25465536', recordKey: 'lifecycle#roth-settled#1', lifecycleId: 'shared-lifecycle', itemType: 'lifecycle',
      status: 'verified', version: 1, market: 'gold', exchange: 'FORECASTX', conId: 4328,
      contractKey: 'METLG_090126_4325_YES', eventTicker: 'METLG_090126_4325',
      contractLabel: 'Gold 4,325 YES', contractSide: 'YES', contractRule: 'above', strike: 4325,
      entryQuantity: 10, netQuantity: 0, remainingQuantity: 0, entryCost: 4.5, risked: 4.5,
      paid: 10, pnl: 5.5, roi: 5.5 / 4.5, resolutionType: 'expiry', resolvedDate: '2026-09-01',
      performanceComplete: true, settlementEvidence: { source: 'forecastex_official_prices', payoutPerContract: 1 },
      updatedAt: '2026-09-01T22:30:00.000Z',
    };
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([rothSettled, capturingHealth('U25779973')]),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U25779973'],
      getKnownAccounts: async () => ['U25779973', 'U25465536'],
      getExpectedAccounts: async () => ['U25779973'],
      readHistoricalExecutions: async (accountId) => ({
        status: 'ready',
        complete: true,
        accountId,
        trades: [],
        fromDate: '2026-01-01',
        toDate: '2026-09-01',
      }),
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const individual = await request(server, {
        path: '/api/prediction-markets/performance?scope=account&account=U25779973',
      });
      expect(individual.status).toBe(200);
      expect(individual.body.rows).toEqual([]);
      expect(individual.body.availableAccounts).toEqual([
        expect.objectContaining({ accountId: 'U25779973', liveStatus: 'connected' }),
      ]);
      expect(individual.body.accountCoverage).toMatchObject({
        status: 'complete',
        complete: true,
        expectedAccountIds: ['U25779973'],
        connectedAccountIds: ['U25779973'],
        missingLiveAccountIds: [],
      });

      const consolidated = await request(server, {
        path: '/api/prediction-markets/performance?scope=all',
      });
      expect(consolidated.status).toBe(200);
      expect(consolidated.body.accounts.map((account) => account.accountId)).toEqual(['U25779973']);
      expect(consolidated.body.rows).toEqual([]);

      const roth = await request(server, {
        path: '/api/prediction-markets/performance?scope=account&account=U25465536',
      });
      expect(roth.status).toBe(403);
      expect(roth.body).toEqual({
        error: 'The requested IBKR account is not managed by this dashboard.',
        code: 'ACCOUNT_NOT_MANAGED',
      });

      const unknown = await request(server, {
        path: '/api/prediction-markets/performance?scope=account&account=U99999999',
      });
      expect(unknown.status).toBe(403);
      expect(unknown.body).toEqual({
        error: 'The requested IBKR account is not managed by this dashboard.',
        code: 'ACCOUNT_NOT_MANAGED',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('deduplicates live and Flex executions by account plus broker execution ID', async () => {
    const accountId = 'U25779973';
    const fetchedAt = new Date().toISOString();
    const baseExecution = {
      accountId,
      execId: 'BROKER-EXEC-1',
      conId: 9001,
      symbol: 'KXWTID',
      localSymbol: 'KXWTID-26SEP02-T80-YES',
      exchange: 'KALSHI',
      secType: 'OPT',
      expiration: '20260902',
      strike: 80,
      contractSide: 'YES',
      side: 'BOT',
      quantity: 2,
      price: 0.4,
      executionTime: fetchedAt,
    };
    const livePayload = {
      ok: true,
      status: 'live',
      source: 'ibkr_live',
      complete: true,
      coverageComplete: true,
      partial: false,
      account: accountId,
      snapshotId: 'live-dedupe-snapshot',
      fetchedAt,
    };
    const dynamodb = new MemoryDocumentClient();
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      getManagedAccounts: async () => [accountId],
      sidecarRequest: async () => ({
        ...livePayload,
        positions: [{
          account: accountId,
          conId: 9001,
          symbol: 'KXWTID',
          localSymbol: 'KXWTID-26SEP02-T80-YES',
          exchange: 'KALSHI',
          secType: 'OPT',
          expiration: '20260902',
          strike: 80,
          contractSide: 'YES',
          position: 2,
          avgCost: 0.4,
        }],
        executions: [{ ...baseExecution, commission: 0 }],
        positionsPayload: livePayload,
        executionsPayload: livePayload,
      }),
      readHistoricalExecutions: async () => ({
        status: 'ready',
        complete: true,
        fromDate: '2026-01-01',
        toDate: '2026-09-01',
        trades: [{
          ...baseExecution,
          commission: 0.1,
          commissionCurrency: 'USD',
          tax: 0,
          source: 'ibkr_flex_import',
          rawFingerprint: 'flex-broker-exec-1',
        }],
      }),
      logger: { warn: jest.fn() },
    });

    await expect(routes.reconciler.reconcileAccount(accountId)).resolves.toMatchObject({ status: 'captured' });
    const executions = [...dynamodb.items.values()].filter((item) => (
      item.accountId === accountId && item.itemType === 'execution'
    ));
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      execId: 'BROKER-EXEC-1',
      source: 'ibkr_live_execution',
      feeEvidenceSource: 'ibkr_flex_import',
      commissionMicros: 100000,
    });
  });

  test('serves expandable economic transactions with their nested raw execution legs', async () => {
    const lifecycle = {
      accountId: 'U123', recordKey: 'lifecycle#1#1', lifecycleId: 'aug21-7700', itemType: 'lifecycle',
      status: 'awaiting_resolution', contractKey: 'FES_082126_7700_YES', eventTicker: 'FES_082126_7700',
      contractLabel: 'Above 7,700 YES', contractSide: 'YES', contractRule: 'above', strike: 7700,
      conId: 1, entryQuantity: 2, exitedQuantity: 1, remainingQuantity: 1, netQuantity: 1,
      entryCost: 0.62, risked: 0.62, exitFees: 0.01, netExitProceeds: 0.31,
      ledgerModelVersion: 'forecast_ex_economic_v2', economicRole: 'original_contract', economicBundleStatus: 'verified',
      executionIds: ['entry-1', 'offset-1', 'held-pair', 'offset-pair'],
      economicTransactions: {
        entries: [{ id: 'entry#entry-1', quantity: 2, price: 0.3, totalCost: 0.62, rawLegs: [{ execId: 'entry-1', role: 'original_entry' }] }],
        cashOuts: [{ id: 'cashout#1', quantity: 1, netProceeds: 0.31, rawLegs: [
          { execId: 'offset-1', role: 'opposite_purchase' },
          { execId: 'held-pair', role: 'held_conversion_leg' },
          { execId: 'offset-pair', role: 'offset_conversion_leg' },
        ] }],
      },
      version: 2,
    };
    const executions = lifecycle.executionIds.map((execId, index) => ({
      accountId: 'U123', recordKey: `execution#${execId}`, itemType: 'execution', execId,
      lifecycleRecordKey: lifecycle.recordKey, conId: index === 0 || index === 2 ? 1 : 2,
      contractKey: index === 0 || index === 2 ? 'FES_082126_7700_YES' : 'FES_082126_7700_NO',
      eventTicker: 'FES_082126_7700', contractSide: index === 0 || index === 2 ? 'YES' : 'NO',
      direction: index < 2 ? 'BUY' : 'SELL', shares: index === 0 ? 2 : 1,
      price: index === 1 ? 0.68 : (index >= 2 ? 0.5 : 0.3), executionTime: `2026-08-21T19:00:0${index}Z`,
      source: 'ibkr_live_execution',
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient([lifecycle, ...executions]),
      sidecarRequest: jest.fn(), getManagedAccounts: async () => ['U123'], logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await request(server, { path: '/api/prediction-markets/performance/aug21-7700/executions?account=U123' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 'aug21-7700', ledgerModelVersion: 'forecast_ex_economic_v2',
        economicEntries: [{ rawLegs: [{ execId: 'entry-1', role: 'original_entry' }] }],
        cashOuts: [{ rawLegs: expect.arrayContaining([
          expect.objectContaining({ execId: 'offset-1', role: 'opposite_purchase' }),
          expect.objectContaining({ execId: 'held-pair', role: 'held_conversion_leg' }),
        ]) }],
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('serves versioned read-only SP500 research windows for a managed account', async () => {
    const getResearch = jest.fn(async ({ accountId, window }) => ({
      schemaVersion: 1,
      researchVersion: 'spx-fes-poker-ledger-v1',
      accountId,
      window,
      scope: { venue: 'ForecastEx', productCode: 'FES', informationalOnly: true },
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb: new MemoryDocumentClient(),
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      researchService: { enrichCaptureResult: jest.fn(), getResearch },
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const ready = await request(server, { path: '/api/prediction-markets/performance/research/sp500?account=U123&window=90d' });
      expect(ready).toMatchObject({
        status: 200,
        body: { schemaVersion: 1, accountId: 'U123', window: '90d', scope: { venue: 'ForecastEx', productCode: 'FES', informationalOnly: true } },
      });
      expect(getResearch).toHaveBeenCalledWith({ accountId: 'U123', window: '90d' });

      const defaultWindow = await request(server, { path: '/api/prediction-markets/performance/research/sp500?account=U123' });
      expect(defaultWindow).toMatchObject({ status: 200, body: { accountId: 'U123', window: 'all' } });

      const invalid = await request(server, { path: '/api/prediction-markets/performance/research/sp500?account=U123&window=ytd' });
      expect(invalid).toMatchObject({ status: 400, body: { code: 'RESEARCH_WINDOW_INVALID' } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('settlement providers match exact venue dates and contract outcomes', async () => {
    const providers = buildSettlementProviders({
      getRecentSettledWtiSessions: jest.fn(async () => ({ ok: true, historicalOnly: true, snapshotType: 'settled_outcome', sessions: [{ eventDate: '2026-08-13', settlementValue: 82, eventTicker: 'KXWTID-26AUG13', snapshotType: 'settled_outcome' }] })),
      getRecentSettledSpxCloseSessions: jest.fn(async () => ({ ok: true, historicalOnly: true, snapshotType: 'settled_outcome', sessions: [{ closeTime: '2026-08-13T20:00:00Z', closeValue: 7765, eventTicker: 'KXINXU-26AUG13H1600', snapshotType: 'settled_outcome' }] })),
      loadOfficialCpiFinals: jest.fn(async () => ({ finals: [{ id: '2026-07', value: 3.3, source: 'bls_official' }] })),
    });
    await expect(providers.wti({ market: 'wti', contractSide: 'YES', contractRule: 'above', strike: 81.49, expiration: '20260813', eventTicker: 'KXWTID-26AUG13', netQuantity: 10, paid: 0 })).resolves.toMatchObject({
      matched: true,
      paid: 10,
      evidence: { settlementDate: '2026-08-13', settlementValue: 82 },
    });
    await expect(providers.sp500({ market: 'sp500', contractSide: 'NO', contractRule: 'above', strike: 7760, expiration: '20260813', contractKey: 'KXINXU-26AUG13H1600-T7760_NO', netQuantity: 5, paid: 0 })).resolves.toMatchObject({
      matched: true,
      paid: 0,
      evidence: { settlementDate: '2026-08-13', settlementValue: 7765 },
    });
    await expect(providers.cpi({ market: 'cpi', contractSide: 'YES', contractRule: 'above', cpiMeasurement: 'headline_yoy', cpiSeriesId: 'CUUR0000SA0', cpiRoundingDecimals: 1, strike: 3.2, expiration: '20260812', eventTicker: 'KXCPIYOY-26JUL', netQuantity: 3, paid: 0 })).resolves.toMatchObject({
      matched: true,
      paid: 3,
      evidence: { settlementDate: '2026-08-12', settlementValue: 3.3 },
    });
  });

  test('resolves exact ForecastEx COMCO contracts only from official binary settlement rows', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      url: `https://www.forecastex.com/api/download?type=prices&date=${dataDate.replaceAll('-', '')}`,
      sha256: 'official-file-hash',
      rows: [
        { eventContract: 'COMCO_081326_82', subtype: 'YES', settlementPrice: 0 },
        { eventContract: 'COMCO_081326_82', subtype: 'NO', settlementPrice: 1 },
      ],
    }));
    const providers = buildSettlementProviders({ loadOfficialForecastExPrices });
    await expect(providers.wti({
      market: 'wti',
      exchange: 'FORECASTX',
      contractKey: 'COMCO_081326_82_NO',
      eventTicker: 'COMCO_081326_82',
      expiration: '20260813',
      contractSide: 'NO',
      contractRule: 'above',
      strike: 82,
      netQuantity: 1056,
      paid: 0,
    })).resolves.toMatchObject({
      matched: true,
      paid: 1056,
      resolvedDate: '2026-08-13',
      evidence: {
        source: 'forecastex_official_prices',
        eventContract: 'COMCO_081326_82',
        settlementPayout: 1,
      },
    });
    expect(loadOfficialForecastExPrices).toHaveBeenCalledWith({ dataDate: '2026-08-13' });

    const unsettled = buildSettlementProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true,
        source: 'forecastex_official_prices',
        snapshotType: 'settled_outcome_candidates',
        dataDate,
        rows: [
          { eventContract: 'COMCO_081326_82', subtype: 'YES', settlementPrice: 0.16 },
          { eventContract: 'COMCO_081326_82', subtype: 'NO', settlementPrice: 0.84 },
        ],
      }),
    });
    await expect(unsettled.wti({
      market: 'wti', exchange: 'FORECASTX', contractKey: 'COMCO_081326_82_NO',
      expiration: '20260813', contractSide: 'NO', contractRule: 'above', strike: 82,
      netQuantity: 1056, paid: 0,
    })).resolves.toEqual({ matched: false });
  });

  test.each([
    {
      provider: 'gold', market: 'gold', productCode: 'METLG',
      contractKey: 'METLG_081426_4400_YES', eventContract: 'METLG_081426_4400',
      side: 'YES', strike: 4400, payout: 1,
      settlementDate: '2026-08-14', expirationDate: '2026-08-14T23:55:00-05:00',
      expectedResolverEvidence: {},
    },
    {
      provider: 'sp500', market: 'sp500', productCode: 'FES',
      contractKey: 'FES_081426_7800_NO', eventContract: 'FES_081426_7800',
      side: 'NO', strike: 7800, payout: 1,
      settlementDate: '2026-08-17', expirationDate: '2026-08-17T10:00:00-05:00',
      expectedResolverEvidence: {
        underlyingSettlementValue: 7802.5,
        underlyingSettlementSource: 'cme_daily_bulletin_final',
        underlyingSettlementStatus: 'official_final',
        underlyingSettlementSymbol: 'ESU26',
        underlyingSettlementObservedAt: '2026-08-14T23:10:00.000Z',
        underlyingSettlementSourceUrl: 'https://www.cmegroup.com/daily_bulletin/current/Section11_Equity_And_Index_Futures.pdf',
        underlyingSettlementSourceHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  ])('settles exact $productCode contracts from a delayed complementary binary pair', async (contract) => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      url: `https://www.forecastex.com/api/download?date=${dataDate.replaceAll('-', '')}`,
      sha256: 'official-file-hash',
      rows: dataDate === '2026-08-16' ? [
        { eventContract: contract.eventContract, subtype: 'YES', expirationDate: contract.expirationDate, settlementPrice: contract.side === 'YES' ? 1 : 0 },
        { eventContract: contract.eventContract, subtype: 'NO', expirationDate: contract.expirationDate, settlementPrice: contract.side === 'NO' ? 1 : 0 },
      ] : [
        { eventContract: contract.eventContract, subtype: 'YES', expirationDate: contract.expirationDate, settlementPrice: 0.4 },
        { eventContract: contract.eventContract, subtype: 'NO', expirationDate: contract.expirationDate, settlementPrice: 0.6 },
      ],
    }));
    const getResolverSettlements = jest.fn(async () => [{
      role: 'resolver',
      availability: 'official_final',
      final: true,
      source: 'cme_daily_bulletin_final',
      sourceUrl: 'https://www.cmegroup.com/daily_bulletin/current/Section11_Equity_And_Index_Futures.pdf',
      sourceHash: 'a'.repeat(64),
      productCode: 'FES',
      market: 'sp500',
      eventDate: '2026-08-14',
      tradingDate: '2026-08-14',
      value: 7802.5,
      symbol: 'ESU26',
      asOf: '2026-08-14T23:10:00Z',
    }]);
    const providers = buildSettlementProviders({ loadOfficialForecastExPrices, getResolverSettlements });
    const result = await providers[contract.provider]({
      market: contract.market,
      exchange: 'FORECASTX',
      contractKey: contract.contractKey,
      eventTicker: contract.eventContract,
      expiration: contract.market === 'sp500' ? '20260817' : '20260814',
      contractSide: contract.side,
      contractRule: 'above',
      strike: contract.strike,
      netQuantity: 5,
      paid: 1,
    });
    expect(result).toMatchObject({
      matched: true,
      paid: 1 + 5 * contract.payout,
      resolvedDate: contract.settlementDate,
      evidence: {
        source: 'forecastex_official_prices',
        productCode: contract.productCode,
        eventContract: contract.eventContract,
        settlementPayout: contract.payout,
        settlementDate: contract.settlementDate,
        dataDate: '2026-08-16',
      },
    });
    expect(Object.fromEntries(Object.entries(result.evidence)
      .filter(([key]) => key.startsWith('underlyingSettlement'))))
      .toEqual(contract.expectedResolverEvidence);
    expect(loadOfficialForecastExPrices.mock.calls.map(([argument]) => argument.dataDate))
      .toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
  });

  test('does not settle Gold from binary rows for a different METLG identity', async () => {
    const providers = buildSettlementProviders({
      loadOfficialForecastExPrices: async ({ dataDate }) => ({
        ok: true,
        source: 'forecastex_official_prices',
        snapshotType: 'settled_outcome_candidates',
        dataDate,
        rows: [
          { eventContract: 'METLG_081426_4425', subtype: 'YES', settlementPrice: 1 },
          { eventContract: 'METLG_081426_4425', subtype: 'NO', settlementPrice: 0 },
        ],
      }),
    });
    await expect(providers.gold({
      market: 'gold', exchange: 'FORECASTX', contractKey: 'METLG_081426_4400_YES',
      expiration: '20260814', contractSide: 'YES', contractRule: 'above', strike: 4400,
      netQuantity: 2, paid: 0,
    })).resolves.toEqual({ matched: false });
  });

  test('requires exact settlement identity instead of matching only by date', async () => {
    const providers = buildSettlementProviders({
      getRecentSettledWtiSessions: jest.fn(async () => ({
        ok: true,
        historicalOnly: true,
        snapshotType: 'settled_outcome',
        sessions: [{ eventDate: '2026-08-13', settlementValue: 82, eventTicker: 'KXWTID-26AUG14', snapshotType: 'settled_outcome' }],
      })),
    });
    await expect(providers.wti({
      market: 'wti',
      contractSide: 'YES',
      contractRule: 'above',
      strike: 81.49,
      expiration: '20260813',
      eventTicker: 'KXWTID-26AUG13',
      netQuantity: 10,
      paid: 0,
    })).resolves.toEqual({ matched: false });
  });

  test('accepts an exact finalized Kalshi result published the day after IBKR expiration', async () => {
    const kalshiFetch = jest.fn(async () => ({
      market: {
        ticker: 'KXWTI-26AUG1314-T81.49',
        status: 'finalized',
        result: 'no',
        expiration_value: '81.25',
        settlement_ts: '2026-08-14T15:01:14.410928Z',
        custom_strike: { front_month_contract: 'WBS 26U-ICE' },
      },
    }));
    const providers = buildSettlementProviders({ kalshiFetch });
    await expect(providers.wti({
      market: 'wti',
      contractKey: 'KXWTI-26AUG1314-T81.49_NO',
      eventTicker: 'KXWTI-26AUG1314',
      expiration: '20260813',
      contractSide: 'NO',
      contractRule: 'above',
      strike: 81.49,
      netQuantity: 999.73,
      paid: 0,
    })).resolves.toMatchObject({
      matched: true,
      paid: 999.73,
      resolvedDate: '2026-08-14',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        outcome: 'NO',
        payoutPerContract: 1,
        settlementValue: 81.25,
        settlementSymbol: 'WBS 26U-ICE',
      },
    });
    expect(kalshiFetch).toHaveBeenCalledWith('/markets/KXWTI-26AUG1314-T81.49');
  });

  test('settles an exact finalized Kalshi ticker even when market classification is other', async () => {
    const kalshiFetch = jest.fn(async () => ({
      market: {
        ticker: 'KXBRENTD-26AUG2417-T91',
        status: 'finalized',
        result: 'no',
        expiration_value: '90.38',
        settlement_ts: '2026-08-24T22:00:57.09524Z',
        settlement_value_dollars: '0.0000',
      },
    }));
    const providers = buildSettlementProviders({ kalshiFetch });
    await expect(providers.exactKalshi({
      market: 'other',
      contractKey: 'KXBRENTD-26AUG2417-T91_YES',
      eventTicker: 'KXBRENTD-26AUG2417',
      contractSide: 'YES',
      strike: 91,
      netQuantity: 2000,
      paid: 0,
    })).resolves.toMatchObject({
      matched: true,
      paid: 0,
      resolvedDate: '2026-08-24',
      evidence: {
        eventTicker: 'KXBRENTD-26AUG2417-T91',
        outcome: 'NO',
        payoutPerContract: 0,
        settlementValue: 90.38,
      },
    });
  });

  test('settles an archived June CPI position from its exact Kalshi ticker and percent resolver value', async () => {
    const kalshiFetch = jest.fn(async () => ({
      market: {
        ticker: 'KXCPIYOY-26JUN-T4.0',
        status: 'finalized',
        result: 'no',
        expiration_value: '3.5%',
        settlement_ts: '2026-07-14T12:50:09.502878Z',
      },
    }));
    const providers = buildSettlementProviders({ kalshiFetch });
    await expect(providers.cpi({
      market: 'cpi',
      contractKey: 'KXCPIYOY',
      eventTicker: 'KXCPIYOY-26JUN',
      positionSnapshotEvidence: { description: 'KXCPIYOY-26JUN-T4.0_NO' },
      expiration: '20260714',
      contractSide: 'NO',
      contractRule: 'above',
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
      strike: 4,
      netQuantity: 927.27,
      paid: 0,
    })).resolves.toMatchObject({
      matched: true,
      paid: 927.27,
      resolvedDate: '2026-07-14',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        eventTicker: 'KXCPIYOY-26JUN-T4.0',
        outcome: 'NO',
        payoutPerContract: 1,
        settlementValue: 3.5,
      },
    });
    expect(kalshiFetch).toHaveBeenCalledWith('/markets/KXCPIYOY-26JUN-T4.0');
  });

  test('does not replace an unavailable exact Kalshi CPI result with a generic BLS calculation', async () => {
    const loadOfficialCpiFinals = jest.fn(async () => ({
      source: 'bls_official',
      finals: [{ id: '2026-06', value: 3.5, source: 'bls_official' }],
    }));
    const providers = buildSettlementProviders({
      kalshiFetch: async () => ({
        market: {
          ticker: 'KXCPIYOY-26JUN-T4.0',
          status: 'closed',
          result: '',
          expiration_value: '',
          settlement_ts: null,
        },
      }),
      loadOfficialCpiFinals,
    });
    await expect(providers.cpi({
      market: 'cpi',
      contractKey: 'KXCPIYOY',
      eventTicker: 'KXCPIYOY-26JUN',
      positionSnapshotEvidence: { description: 'KXCPIYOY-26JUN-T4.0_NO' },
      expiration: '20260714',
      contractSide: 'NO',
      contractRule: 'above',
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
      strike: 4,
      netQuantity: 927.27,
      paid: 0,
    })).resolves.toEqual({ matched: false });
    expect(loadOfficialCpiFinals).not.toHaveBeenCalled();
  });

  test('settles an archived native ForecastEx CPI contract only from its exact binary pair', async () => {
    const loadOfficialForecastExPrices = jest.fn(async ({ dataDate }) => ({
      ok: true,
      source: 'forecastex_official_prices',
      snapshotType: 'settled_outcome_candidates',
      dataDate,
      url: `https://www.forecastex.com/api/download?type=prices&date=${dataDate.replaceAll('-', '')}`,
      sha256: 'official-cpi-file-hash',
      fetchedAt: '2026-07-14T13:00:00Z',
      rows: [
        { eventContract: 'CPIY_0626_3.8', subtype: 'YES', expirationDate: '2026-07-14T07:30:00-05:00', settlementPrice: 0 },
        { eventContract: 'CPIY_0626_3.8', subtype: 'NO', expirationDate: '2026-07-14T07:30:00-05:00', settlementPrice: 1 },
      ],
    }));
    const providers = buildSettlementProviders({ loadOfficialForecastExPrices });
    await expect(providers.cpi({
      market: 'cpi',
      exchange: 'FORECASTX',
      contractKey: 'CPIY_0626_3.8_YES',
      eventTicker: 'CPIY_0626_3.8',
      expiration: '20260714',
      contractSide: 'YES',
      contractRule: 'above',
      strike: 3.8,
      netQuantity: 63,
      paid: 0,
    })).resolves.toMatchObject({
      matched: true,
      paid: 0,
      resolvedDate: '2026-07-14',
      evidence: {
        source: 'forecastex_official_prices',
        eventContract: 'CPIY_0626_3.8',
        outcome: 'NO',
        settlementPayout: 0,
      },
    });
    expect(loadOfficialForecastExPrices).toHaveBeenCalledWith({ dataDate: '2026-07-14' });
  });

  test('repairs multiple archived Kalshi CPI rows independently and re-verifies prior historical settlements', async () => {
    const dynamodb = new MemoryDocumentClient();
    const loadContractSchedule = jest.fn(async (record) => {
      const ticker = record.positionSnapshotEvidence.description.replace(/_(?:YES|NO)$/, '');
      return {
        ok: true,
        venue: 'Kalshi',
        source: 'kalshi_exact_market',
        eventTicker: ticker,
        lastTradeAt: '2026-07-14T12:29:00Z',
        resolutionAt: '2026-07-14T12:50:09.502Z',
        payoutAt: '2026-07-14T12:50:09.502Z',
        sourceUrl: `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`,
        sourceHash: 'a'.repeat(64),
        observedAt: '2026-08-15T04:30:00Z',
      };
    });
    const settlement = jest.fn(async (record) => ({
      matched: true,
      paid: record.strike === 4 ? record.entryQuantity : 0,
      resolvedDate: '2026-07-14',
      resolutionType: 'expiry',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        eventTicker: record.positionSnapshotEvidence.description.replace(/_(?:YES|NO)$/, ''),
        outcome: 'NO',
        payoutPerContract: record.contractSide === 'NO' ? 1 : 0,
        settlementValue: 3.5,
      },
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest: jest.fn(),
      loadContractSchedule,
      settlementProviders: { cpi: settlement },
      getManagedAccounts: async () => ['U123'],
      logger: { warn: jest.fn() },
    });
    const base = {
      accountId: 'U123',
      itemType: 'lifecycle',
      status: 'review',
      reviewReason: 'contract_schedule_evidence_conflict',
      version: 3,
      verification: 'verified_settlement',
      historicalImportId: 'cpi-history-test',
      market: 'cpi',
      contractRule: 'above',
      cpiMeasurement: 'headline_yoy',
      cpiSeriesId: 'CUUR0000SA0',
      cpiRoundingDecimals: 1,
      contractKey: 'KXCPIYOY',
      eventTicker: 'KXCPIYOY-26JUN',
      expiration: '20260714',
      feesComplete: false,
      costBasisComplete: true,
      performanceComplete: true,
      fees: null,
      resolvedDate: '2026-07-14',
      resolutionType: 'expiry',
    };
    const records = [
      {
        ...base,
        recordKey: 'lifecycle#1#1', lifecycleId: 'historical-1', conId: 1,
        contractLabel: 'CPI 3.8% YES', contractSide: 'YES', strike: 3.8,
        entryQuantity: 3000, netQuantity: 0, entryPrincipal: null, risked: null, paid: 0,
        costBasisComplete: false, performanceComplete: false,
        positionSnapshotEvidence: { description: 'KXCPIYOY-26JUN-T3.8_YES' },
      },
      {
        ...base,
        recordKey: 'lifecycle#2#1', lifecycleId: 'historical-2', conId: 2,
        contractLabel: 'CPI 4% NO', contractSide: 'NO', strike: 4,
        entryQuantity: 927.27, netQuantity: 0, entryPrincipal: 765.623611,
        risked: 765.623611, paid: 927.27,
        positionSnapshotEvidence: { description: 'KXCPIYOY-26JUN-T4.0_NO' },
      },
    ];
    await routes.store.transactSave(records.map((item) => ({ item, createOnly: true })));
    await routes.resolveSettlements({ accountId: 'U123', records: await routes.store.queryAccount('U123') });

    const repaired = (await routes.store.queryAccount('U123')).filter((record) => record.itemType === 'lifecycle');
    expect(repaired).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordKey: 'lifecycle#1#1', status: 'verified', reviewReason: null,
        performanceComplete: false,
        settlementEvidence: expect.objectContaining({ eventTicker: 'KXCPIYOY-26JUN-T3.8', outcome: 'NO' }),
      }),
      expect.objectContaining({
        recordKey: 'lifecycle#2#1', status: 'verified', reviewReason: null,
        paid: 927.27,
        settlementEvidence: expect.objectContaining({ eventTicker: 'KXCPIYOY-26JUN-T4.0', outcome: 'NO' }),
      }),
    ]));
    const incomplete = repaired.find((record) => record.recordKey === 'lifecycle#1#1');
    expect(incomplete.risked ?? null).toBeNull();
    expect(incomplete.pnl ?? null).toBeNull();
    expect(repaired.find((record) => record.recordKey === 'lifecycle#2#1').pnl)
      .toBeCloseTo(161.646389, 6);
    expect(loadContractSchedule).toHaveBeenCalledTimes(2);
    expect(settlement).toHaveBeenCalledTimes(2);
  });

  test('automatically repairs a legacy schedule-review row and settles it exactly once', async () => {
    const dynamodb = new MemoryDocumentClient();
    let snapshot = 0;
    let validSchedule = false;
    const observedAt = new Date().toISOString();
    const evidence = {
      ok: true,
      status: 'live',
      source: 'ibkr_live',
      complete: true,
      coverageComplete: true,
      partial: false,
      fetchedAt: observedAt,
    };
    const sidecarRequest = jest.fn(async () => {
      snapshot += 1;
      const currentEvidence = { ...evidence, snapshotId: `review-repair-${snapshot}` };
      return {
        ...currentEvidence,
        executions: [{
          accountId: 'U123', execId: 'wti-8199', conId: 910427734,
          symbol: 'KXWTI', localSymbol: 'KXWTI-26AUG1314-T81.99_NO', tradingClass: 'KXWTI',
          exchange: 'FORECASTX', secType: 'OPT', expiration: '20260813', strike: 81.99,
          contractSide: 'P', contractRule: 'above', direction: 'BUY', shares: 1000,
          price: 0.55, commission: 5, tax: 0, executionTime: '2026-08-13T17:00:00Z',
        }],
        positions: [{
          account: 'U123', conId: 910427734, symbol: 'KXWTI',
          localSymbol: 'KXWTI-26AUG1314-T81.99_NO', tradingClass: 'KXWTI',
          exchange: 'FORECASTX', secType: 'OPT', expiration: '20260813', strike: 81.99,
          contractSide: 'P', contractRule: 'above', position: 1000, avgCost: 0.555,
        }],
        positionsPayload: currentEvidence,
        executionsPayload: currentEvidence,
      };
    });
    const loadContractSchedule = jest.fn(async () => ({
      ok: true,
      venue: 'Kalshi',
      source: 'kalshi_exact_market',
      eventTicker: 'KXWTI-26AUG1314-T81.99',
      lastTradeAt: '2026-08-13T18:30:00Z',
      resolutionAt: '2026-08-13T18:30:00Z',
      payoutAt: '2026-08-14T15:01:14.410Z',
      settlementSymbol: 'WBS 26U-ICE',
      sourceUrl: 'https://external-api.kalshi.com/trade-api/v2/markets/KXWTI-26AUG1314-T81.99',
      sourceHash: validSchedule ? 'd'.repeat(64) : '',
      observedAt,
    }));
    const settlement = jest.fn(async () => ({
      matched: true,
      paid: 1000,
      resolvedDate: '2026-08-14',
      resolutionType: 'expiry',
      evidence: {
        source: 'kalshi_exact_finalized_market',
        eventTicker: 'KXWTI-26AUG1314-T81.99',
        outcome: 'NO',
        payoutPerContract: 1,
        settlementValue: 81.25,
        settlementSymbol: 'WBS 26U-ICE',
        observedAt,
      },
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest,
      loadContractSchedule,
      settlementProviders: { wti: settlement },
      getManagedAccounts: async () => ['U123'],
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      await routes.reconciler.runOnce(async () => ['U123']);
      const inReview = await request(server, { path: '/api/prediction-markets/performance?account=U123' });
      expect(inReview.body.review).toEqual([]);
      expect(inReview.body.rows).toEqual([]);
      expect(inReview.body.tracker.quarantinedEvidenceCount).toBe(1);
      expect(settlement).not.toHaveBeenCalled();

      validSchedule = true;
      await routes.reconciler.runOnce(async () => ['U123']);
      const settled = await request(server, { path: '/api/prediction-markets/performance?account=U123' });
      expect(settled.body.review).toEqual([]);
      expect(settled.body.rows).toEqual([
        expect.objectContaining({
          contractLabel: 'WTI $81.99 NO',
          displayState: 'SETTLED',
          outcome: 'NO',
          payoutPerContract: 1,
          settlementSymbol: 'WBS 26U-ICE',
          settlementValue: 81.25,
        }),
      ]);
      expect(settlement).toHaveBeenCalledTimes(1);

      await routes.reconciler.runOnce(async () => ['U123']);
      expect(settlement).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('automatically logs a contract only after its final settlement is available', async () => {
    const dynamodb = new MemoryDocumentClient();
    const observedAt = new Date().toISOString();
    const execution = {
      accountId: 'U123',
      execId: 'E-1',
      conId: 9001,
      symbol: 'KXWTID-26AUG13-T81.49-YES',
      localSymbol: 'KXWTID-26AUG13-T81.49-YES',
      exchange: 'FORECASTX',
      secType: 'OPT',
      direction: 'BUY',
      shares: 10,
      price: 0.42,
      commission: 0.1,
      tax: 0,
      executionTime: observedAt,
      expiration: '20260813',
      contractRule: 'above',
    };
    const position = {
      conId: 9001,
      symbol: execution.symbol,
      localSymbol: execution.localSymbol,
      exchange: 'FORECASTX',
      secType: 'OPT',
      position: 10,
      quantity: 10,
      avgCost: 0.43,
      expiration: '20260813',
      contractRule: 'above',
    };
    let snapshot = 0;
    let accountLookupAvailable = true;
    const sidecarRequest = jest.fn(async () => {
      snapshot += 1;
      const evidence = {
        ok: true,
        status: 'live',
        source: 'ibkr_live',
        complete: true,
        coverageComplete: true,
        partial: false,
        snapshotId: `snapshot-${snapshot}`,
        fetchedAt: new Date().toISOString(),
      };
      return {
        ...evidence,
        positions: snapshot === 1 ? [position] : [],
        executions: [execution],
        positionsPayload: evidence,
        executionsPayload: evidence,
      };
    });
    let settlementAvailable = false;
    const settlement = jest.fn(async () => (settlementAvailable ? {
      matched: true,
      paid: 10,
      resolvedDate: '2026-08-13',
      resolutionType: 'expiry',
      evidence: { source: 'kalshi_settled_wti', eventTicker: 'KXWTID-26AUG13' },
    } : { matched: false }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest,
      settlementProviders: { wti: settlement },
      markProviders: {
        kalshi: async () => ({
          price: 0.6,
          state: 'live_bid',
          source: 'kalshi_direct_bid',
          observedAt: new Date().toISOString(),
        }),
      },
      getManagedAccounts: async () => {
        if (!accountLookupAvailable) throw new Error('gateway offline');
        return ['U123'];
      },
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      await expect(routes.reconciler.runOnce(async () => ['U123'])).resolves.toMatchObject({
        status: 'complete',
        results: { U123: { status: 'captured' } },
      });
      const whileOpen = await request(server, {
        path: '/api/prediction-markets/performance?account=U123',
      });
      expect(whileOpen.status).toBe(200);
      expect(whileOpen.body.rows).toEqual([
        expect.objectContaining({
          contractLabel: 'WTI $81.49 YES',
          openedAt: observedAt,
          status: 'open',
          risked: 4.3,
          currentValue: 6,
          pnl: 1.7,
          markState: 'live_bid',
        }),
      ]);
      expect(whileOpen.body.summary).toMatchObject({
        count: 1,
        openCount: 1,
        openPnl: 1.7,
        realizedCount: 0,
        realizedPnl: 0,
        pnl: null,
      });
      expect(whileOpen.body.tracker).toMatchObject({ openCount: 1, awaitingSettlementCount: 0, trackingCount: 1 });
      expect(settlement).toHaveBeenCalledTimes(1);
      const openedLifecycleId = whileOpen.body.rows[0].id;

      settlementAvailable = true;
      await expect(routes.reconciler.runOnce(async () => ['U123'])).resolves.toMatchObject({
        status: 'complete',
        results: { U123: { status: 'captured' } },
      });
      const settled = await request(server, {
        path: '/api/prediction-markets/performance?account=U123',
      });
      expect(settled.status).toBe(200);
      expect(settled.body.rows).toEqual([
        expect.objectContaining({
          id: openedLifecycleId,
          contractLabel: 'WTI $81.49 YES',
          openedAt: observedAt,
          status: 'verified',
          verification: 'verified_settlement',
          risked: 4.3,
          paid: 10,
          pnl: 5.7,
        }),
      ]);
      expect(settled.body.summary).toMatchObject({ count: 1, risked: null, paid: null, pnl: null, realizedPnl: 5.7, realizedScope: 'verified_records' });
      expect(settled.body.tracker).toMatchObject({ openCount: 0, awaitingSettlementCount: 0, trackingCount: 0 });
      expect(settlement).toHaveBeenCalledTimes(2);
      await expect(routes.reconciler.runOnce(async () => ['U123'])).resolves.toMatchObject({ status: 'complete' });
      expect(settlement).toHaveBeenCalledTimes(2);
      const settledAgain = await request(server, {
        path: '/api/prediction-markets/performance?account=U123',
      });
      expect(settledAgain.body.rows[0]).toMatchObject({ paid: 10, pnl: 5.7 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('moves post-cutoff Gold and FES contracts to awaiting result from exact official schedules', async () => {
    const dynamodb = new MemoryDocumentClient();
    const observedAt = new Date().toISOString();
    const contracts = [
      {
        conId: 910876662, execId: 'gold-live', symbol: 'METLG', localSymbol: 'METLG_081426_4400_YES',
        tradingClass: 'METLG', secType: 'OPT', contractSide: 'C', strike: 4400,
        quantity: 2000, price: 0.234, commission: 10, avgCost: 0.239, market: 'gold',
        eventTicker: 'METLG_081426_4400', expiration: '20260814',
      },
      {
        conId: 910875945, execId: 'sp500-live', symbol: 'ES', localSymbol: 'FES_081426_7775_NO',
        tradingClass: 'FES', secType: 'FOP', contractSide: 'P', strike: 7775,
        quantity: 5000, price: 0.05, commission: 50, avgCost: 0.06, market: 'sp500',
        eventTicker: 'FES_081426_7775', expiration: '20260817',
      },
    ];
    const evidence = {
      ok: true,
      status: 'live',
      source: 'ibkr_live',
      complete: true,
      coverageComplete: true,
      partial: false,
      snapshotId: 'forecast-ex-live',
      fetchedAt: observedAt,
    };
    const sidecarRequest = jest.fn(async () => ({
      ...evidence,
      executions: contracts.map((contract) => ({
        accountId: 'U123', execId: contract.execId, conId: contract.conId,
        symbol: contract.symbol, localSymbol: contract.localSymbol, tradingClass: contract.tradingClass,
        exchange: 'FORECASTX', secType: contract.secType, expiration: contract.expiration,
        strike: contract.strike, contractSide: contract.contractSide, direction: 'BUY',
        shares: contract.quantity, price: contract.price, commission: contract.commission,
        executionTime: observedAt,
      })),
      positions: contracts.map((contract) => ({
        account: 'U123', conId: contract.conId, symbol: contract.symbol, localSymbol: contract.localSymbol,
        tradingClass: contract.tradingClass, exchange: '', secType: contract.secType,
        expiration: contract.expiration, strike: contract.strike, contractSide: contract.contractSide,
        position: contract.quantity, avgCost: contract.avgCost,
      })),
      positionsPayload: evidence,
      executionsPayload: evidence,
    }));
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest,
      loadContractSchedule: async (record) => {
        const gold = record.market === 'gold';
        return {
          ok: true,
          venue: 'ForecastEx',
          source: 'forecastex_official_contract_api',
          eventTicker: record.eventTicker,
          lastTradeAt: gold ? '2026-08-14T17:30:00Z' : '2026-08-14T20:00:00Z',
          resolutionAt: gold ? '2026-08-15T04:55:00Z' : '2026-08-17T15:00:00Z',
          payoutAt: gold ? '2026-08-15T06:55:00Z' : '2026-08-17T17:00:00Z',
          settlementSymbol: gold ? 'GCQ26' : 'ESU26',
          sourceUrl: `https://www.forecastex.com/api/contracts?productId=${gold ? 'METLG' : 'FES'}`,
          sourceHash: 'a'.repeat(64),
          observedAt,
        };
      },
      getManagedAccounts: async () => ['U123'],
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      await expect(routes.reconciler.runOnce(async () => ['U123'])).resolves.toMatchObject({ status: 'complete' });
      const response = await request(server, {
        path: '/api/prediction-markets/performance?account=U123&market=all&sort=status&direction=asc',
      });
      expect(response.status).toBe(200);
      expect(response.body.review).toEqual([]);
      expect(response.body.activeRows).toEqual([
        expect.objectContaining({
          market: 'gold',
          eventTicker: 'METLG_081426_4400',
          contractKey: 'METLG_081426_4400_YES',
          status: 'awaiting_resolution',
          displayState: 'AWAITING_RESULT',
          settlementSymbol: 'GCQ26',
          quantity: 2000,
          markState: 'unavailable',
          pnl: null,
        }),
        expect.objectContaining({
          market: 'sp500',
          eventTicker: 'FES_081426_7775',
          contractKey: 'FES_081426_7775_NO',
          status: 'awaiting_resolution',
          displayState: 'AWAITING_RESULT',
          reviewReason: null,
          settlementSymbol: 'ESU26',
          quantity: 5000,
          markState: 'unavailable',
          pnl: null,
        }),
      ]);
      expect(response.body.rows.map((row) => row.contractKey)).toEqual([
        'METLG_081426_4400_YES',
        'FES_081426_7775_NO',
      ]);
      expect(response.body.summaries.gold).toMatchObject({ openCount: 0, awaitingCount: 1 });
      expect(response.body.summaries.sp500).toMatchObject({ openCount: 0, awaitingCount: 1 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejects manual P&L confirmation so only broker evidence can publish results', async () => {
    const lifecycle = {
      accountId: 'U123',
      recordKey: 'lifecycle#9001#1',
      itemType: 'lifecycle',
      lifecycleId: 'review-1',
      version: 3,
      status: 'review',
      market: 'wti',
      contractLabel: 'WTI $82 NO',
      contractSide: 'NO',
      strike: 82,
      entryQuantity: 10,
      netQuantity: 10,
      entryPrincipal: 4.8,
      fees: 0.2,
      paid: 0,
    };
    const dynamodb = new MemoryDocumentClient([lifecycle]);
    const routes = createPredictionMarketPerformanceRoutes({
      dynamodb,
      sidecarRequest: jest.fn(),
      getManagedAccounts: async () => ['U123'],
      logger: { warn: jest.fn() },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/prediction-markets/performance', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const confirmed = await request(server, {
        method: 'PATCH',
        path: '/api/prediction-markets/performance/review-1?account=U123',
        body: {
          expectedVersion: 3,
          market: 'wti',
          contractLabel: 'WTI $82 NO',
          contractSide: 'NO',
          strike: 82,
          quantity: 10,
          entryPrincipal: 4.8,
          fees: 0.2,
          paid: 10,
          resolvedDate: '2026-08-13',
          resolutionType: 'expiry',
        },
      });
      expect(confirmed.status).toBe(405);
      expect(confirmed.body).toEqual({
        error: 'Manual P&L confirmation is disabled. Only authoritative broker evidence can publish performance.',
        code: 'PERFORMANCE_MANUAL_REVIEW_DISABLED',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
