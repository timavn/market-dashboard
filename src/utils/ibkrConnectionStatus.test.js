import {
  getIbkrConnectionDisplay,
  getIbkrPortfolioStatusDot,
  getPreferredIbkrAccount,
  getPortfolioOfflinePanel,
  getPortfolioSidebarBanner,
  OFFLINE_SETUP_STEPS,
} from './ibkrConnectionStatus';

function currentDate() {
  return new Date().toLocaleDateString('en-CA');
}

function livePortfolio(overrides = {}) {
  return {
    dataSource: 'ibkr_api',
    accountSummary: {
      lastUpdated: new Date().toISOString(),
      netLiquidation: 100000,
      currency: 'USD',
    },
    holdings: [
      { symbol: 'LONG1', quantity: 10, marketValue: 1000 },
      { symbol: 'SHORT1', quantity: -5, marketValue: -500 },
    ],
    ...overrides,
  };
}

const livePredictionProvider = {
  providers: {
    ibkr: {
      status: 'connected',
      gateway: { ok: true },
      contracts_total: 7,
    },
  },
};

describe('getIbkrConnectionDisplay', () => {
  it('returns connected when ibkr.connected is true', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: true } },
      error: null,
    });
    expect(result.connected).toBe(true);
    expect(result.label).toBe('Live');
  });

  it('returns backend offline on network errors', () => {
    const result = getIbkrConnectionDisplay({
      status: null,
      error: 'Network Error',
    });
    expect(result.label).toBe('Backend offline');
    expect(result.kind).toBe('backend_offline');
  });

  it('returns sidecar offline when status is sidecar_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'sidecar_offline' } },
      error: null,
    });
    expect(result.label).toBe('Sidecar offline');
    expect(result.title).toMatch(/npm run ibkr-sidecar/);
  });

  it('returns sidecar wedged when status is sidecar_unresponsive', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'sidecar_unresponsive' } },
      error: null,
    });
    expect(result.label).toBe('Sidecar wedged');
    expect(result.title).toMatch(/restart/i);
  });

  it('returns gateway offline when status is tws_offline', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'tws_offline' } },
      error: null,
    });
    expect(result.label).toBe('Gateway offline');
    expect(result.title).toMatch(/Gateway/);
  });

  it('returns gateway timeout when status is gateway_timeout', () => {
    const result = getIbkrConnectionDisplay({
      status: { ibkr: { connected: false, status: 'gateway_timeout' } },
      error: null,
    });
    expect(result.label).toBe('Gateway timeout');
    expect(result.kind).toBe('gateway_timeout');
  });
});

describe('getPreferredIbkrAccount', () => {
  it('keeps an explicit saved account when it is available', () => {
    const result = getPreferredIbkrAccount(
      { ibkr: { accounts: ['U25465536', 'U25779973'] } },
      'U25465536',
    );
    expect(result).toBe('U25465536');
  });

  it('keeps an explicit saved account through a transient discovery gap', () => {
    const result = getPreferredIbkrAccount(
      { ibkr: { accounts: ['U25465536'] } },
      'U25779973',
    );
    expect(result).toBe('U25779973');
  });

  it('prefers the streamed portfolio account when there is no explicit saved selection', () => {
    const result = getPreferredIbkrAccount({
      ibkr: {
        accounts: ['U25465536', 'U25779973'],
        sidecar: { stream: { portfolio_account: 'U25779973' } },
      },
    });
    expect(result).toBe('U25779973');
  });
});

describe('OFFLINE_SETUP_STEPS', () => {
  it('lists gateway and sidecar steps only', () => {
    expect(OFFLINE_SETUP_STEPS).toHaveLength(2);
    expect(OFFLINE_SETUP_STEPS[0].label).toMatch(/Gateway/);
    expect(OFFLINE_SETUP_STEPS[1].label).toMatch(/sidecar/);
  });
});

describe('getPortfolioOfflinePanel', () => {
  it('shows sync hint when IBKR connected but portfolio offline', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: true, kind: 'connected' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.syncPending).toBe(true);
    expect(panel.steps).toBeNull();
    expect(panel.heading).toMatch(/refresh/i);
  });

  it('shows setup steps when sidecar offline', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: false, kind: 'sidecar_offline' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.syncPending).toBe(false);
    expect(panel.steps).toHaveLength(1);
    expect(panel.steps[0].label).toMatch(/npm run ibkr-sidecar/);
  });

  it('shows restart hint when sidecar is unresponsive', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: false, kind: 'sidecar_unresponsive' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.syncPending).toBe(false);
    expect(panel.heading).toMatch(/unresponsive/i);
    expect(panel.steps[0].label).toMatch(/pkill/);
  });

  it('marks sidecar done but gateway not done when gateway is offline', () => {
    const panel = getPortfolioOfflinePanel({
      connection: { connected: false, kind: 'gateway_offline' },
      portfolioData: { dataSource: 'ibkr_offline' },
    });
    expect(panel.steps).toHaveLength(2);
    expect(panel.steps[0].done).toBe(false);
    expect(panel.steps[1].done).toBe(true);
  });
});

describe('getPortfolioSidebarBanner', () => {
  it('returns null for ibkr_offline (setup card handles offline UI)', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_offline', empty: true },
      selectedAccount: 'U123',
    });
    expect(result).toBeNull();
  });

  it('returns empty banner for connected account with no positions', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: true, accountId: 'U25779973' },
      selectedAccount: 'U25779973',
    });
    expect(result?.type).toBe('empty');
    expect(result?.message).toMatch(/U25779973/);
    expect(result?.message).not.toMatch(/Connect IB Gateway/);
  });

  it('returns null when connected with holdings', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: false },
      selectedAccount: 'U25465536',
    });
    expect(result).toBeNull();
  });

  it('does not treat ibkr_api empty as offline', () => {
    const result = getPortfolioSidebarBanner({
      portfolioData: { dataSource: 'ibkr_api', empty: true },
      selectedAccount: 'U25779973',
    });
    expect(result?.type).toBe('empty');
  });
});

describe('getIbkrPortfolioStatusDot dependency aggregation', () => {
  it('stays blue while the first portfolio snapshot is loading after connection discovery', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: null,
      loading: true,
      rtaPositions: null,
      etfProSnapshot: null,
      predictionMarketProviderStatus: null,
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🔵');
    expect(status.sources).toEqual([
      expect.objectContaining({
        id: 'ibkr',
        detail: 'Checking connection…',
      }),
    ]);
  });

  it('returns red after loading settles with a real offline response', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: false, kind: 'gateway_offline' },
      portfolioData: { dataSource: 'ibkr_offline' },
      loading: false,
      rtaPositions: null,
      etfProSnapshot: null,
      predictionMarketProviderStatus: null,
    });

    expect(status.status).toBe('inactive');
    expect(status.emoji).toBe('🔴');
  });

  it('adds only the exact current interest validation state to portfolio status', () => {
    const now = Date.now();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      interestValidation: {
        source: 'ibkr_interest_validation',
        available: true,
        accountMatched: true,
        requestedAccount: 'U25779973',
        generatedAt: new Date(now).toISOString(),
        modelStatus: 'learning',
      },
      selectedAccount: 'U25779973',
      now,
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources.find((source) => source.id === 'interest-validation'))
      .toEqual(expect.objectContaining({
        label: 'Interest validation',
        stateLabel: 'Learning',
        detail: 'Learning',
        detailRows: [],
        status: 'stale',
      }));
  });

  it('fails stale, wrong-account, and unavailable validation status closed', () => {
    const now = Date.now();
    const base = {
      source: 'ibkr_interest_validation',
      available: true,
      accountMatched: true,
      requestedAccount: 'U25779973',
      generatedAt: new Date(now).toISOString(),
      modelStatus: 'validated',
    };

    for (const interestValidation of [
      { ...base, requestedAccount: 'U00000000' },
      { ...base, generatedAt: new Date(now - (3 * 60 * 1000)).toISOString() },
      { ...base, available: false },
    ]) {
      const status = getIbkrPortfolioStatusDot({
        connection: { connected: true, kind: 'connected' },
        portfolioData: livePortfolio(),
        loading: false,
        interestValidation,
        selectedAccount: 'U25779973',
        now,
      });
      expect(status.sources.find((source) => source.id === 'interest-validation'))
        .toEqual(expect.objectContaining({
          stateLabel: 'Unavailable',
          detailRows: [],
          status: 'defective',
        }));
      expect(status.status).toBe('inactive');
      expect(status.emoji).toBe('🔴');
    }
  });

  it('shows checking only when no current validation snapshot exists', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      interestValidation: null,
      interestValidationLoading: true,
      selectedAccount: 'U25779973',
      now: Date.now(),
    });

    expect(status.sources.find((source) => source.id === 'interest-validation'))
      .toEqual(expect.objectContaining({
        stateLabel: 'Checking',
        detailRows: [],
        status: 'loading',
      }));
  });

  it('ignores fresh RTA and ETF Pro count differences for readiness status', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 3,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Long' },
          { ticker: 'C', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    expect(status.status).toBe('active');
    expect(status.emoji).toBe('🟢');
    expect(status.sources.find((source) => source.id === 'rta')?.detail).toBe('Current 3/1');
    expect(status.sources.find((source) => source.id === 'rta')?.detailRows).toEqual([]);
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detail).toBe('Current 2/1');
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detailRows).toEqual([]);
  });

  it('turns yellow when RTA and ETF Pro are stale or degraded while portfolio is live', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: '2026-06-18T19:39:03Z',
        longCount: 7,
        shortCount: 0,
      },
      etfProSnapshot: {
        meta: { snapshotDate: '2026-06-18' },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Long' },
          { ticker: 'C', call: 'Short' },
        ],
        dataQuality: { status: 'warning', warnings: ['ETF Pro Gmail ingestion is stale.'] },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources[0]?.id).toBe('portfolio');
    expect(status.sources.some((source) => source.id === 'ibkr')).toBe(false);
    expect(status.sources.find((source) => source.id === 'rta')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Last known RTA positions are from 2026-06-18.' }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'rta')?.detailRows).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/count mismatch/i) }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'rta')?.detail).toBe('Stale 7/0');
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Last known ETF Pro positions are from 2026-06-18 (3 positions).' }),
        expect.objectContaining({ text: 'ETF Pro data quality: warning' }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detailRows).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/count mismatch/i) }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detail).toBe('Warning 2/1');
  });

  it('shows portfolio reference closes as yellow dated valuations rather than an error', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio({
        holdings: [
          {
            symbol: 'FAB',
            quantity: 10,
            marketValue: 1000,
            priceState: 'historical_close',
            marketValueState: 'historical_close',
            priceSessionDate: '2026-07-24',
          },
          {
            symbol: 'URI',
            quantity: 5,
            marketValue: 500,
            priceState: 'historical_close',
            marketValueState: 'historical_close',
            referenceCloseSessionDate: '2026-07-24',
          },
        ],
        dataQuality: {
          status: 'stale',
          markState: 'reference',
          liveMarkCount: 0,
          historicalMarkCount: 2,
          missingMarketValueCount: 0,
          markFailureCount: 0,
          warnings: ['Live market values were unavailable for two positions.'],
        },
      }),
      loading: false,
    });

    const portfolio = status.sources.find((source) => source.id === 'portfolio');
    expect(status).toMatchObject({ status: 'stale', emoji: '🟡' });
    expect(portfolio).toMatchObject({
      detail: 'Reference closes (2 as of 2026-07-24)',
      status: 'stale',
      acknowledgeableStatus: false,
    });
    expect(portfolio.detailRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringMatching(/positions are live, but those valuations are reference data/i),
      }),
      expect.objectContaining({
        text: 'Live market values were unavailable for two positions.',
      }),
    ]));
  });

  it('shows a cold reference-mark warmup as yellow progress rather than missing-value errors', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio({
        holdings: [
          {
            symbol: 'FAB',
            quantity: 10,
            marketValue: 1000,
            priceState: 'historical_close',
            marketValueState: 'historical_close',
            priceSessionDate: '2026-07-24',
          },
          {
            symbol: 'URI',
            quantity: 5,
            marketValue: null,
            priceState: 'unavailable',
            marketValueState: 'unavailable',
            markPending: true,
            markWarmState: 'warming',
          },
        ],
        referenceMarks: {
          status: 'warming',
          warming: true,
          warmingCount: 38,
          requestedCount: 49,
          progress: {
            state: 'warming',
            requestedCount: 49,
            completedCount: 11,
            pendingCount: 38,
          },
        },
        dataQuality: {
          status: 'stale',
          markState: 'warming',
          historicalMarkCount: 11,
          missingMarketValueCount: 38,
          unavailableMarketValueCount: 0,
          warmingMarkCount: 38,
          markFailureCount: 0,
          markProgress: {
            state: 'warming',
            requestedCount: 49,
            completedCount: 11,
            pendingCount: 38,
          },
        },
      }),
      loading: false,
    });

    const portfolio = status.sources.find((source) => source.id === 'portfolio');
    expect(status).toMatchObject({ status: 'stale', emoji: '🟡' });
    expect(portfolio).toMatchObject({
      detail: 'Reference closes warming (11/49 complete; 38 pending)',
      status: 'stale',
      acknowledgeableStatus: false,
    });
    expect(portfolio.detailRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'IBKR is warming completed daily closes in the background (11/49 complete; 38 pending).',
      }),
    ]));
    expect(portfolio.detailRows.map((row) => row.text).join(' ')).not.toMatch(/missing tickers/i);
  });

  it('keeps genuinely unavailable portfolio marks explicit and does not call them reference closes', () => {
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio({
        dataQuality: {
          status: 'partial',
          markState: 'unavailable',
          historicalMarkCount: 0,
          missingMarketValueCount: 1,
          missingMarketValueSymbols: ['FAB'],
          markFailures: [{
            symbol: 'FAB',
            errorCode: 'REFERENCE_MARK_HISTORY_MISSING',
            message: 'IBKR returned no completed daily close.',
          }],
        },
      }),
      loading: false,
    });

    const portfolio = status.sources.find((source) => source.id === 'portfolio');
    expect(status).toMatchObject({ status: 'inactive', emoji: '🔴' });
    expect(portfolio).toMatchObject({
      status: 'defective',
      acknowledgeableStatus: false,
    });
    expect(portfolio.detail).toBe('Partial marks (1 missing market values)');
    expect(portfolio.detail).not.toMatch(/reference closes/i);
    expect(portfolio.detailRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Missing tickers: FAB' }),
      expect.objectContaining({
        text: 'FAB (REFERENCE_MARK_HISTORY_MISSING): IBKR returned no completed daily close.',
      }),
    ]));
  });

  it('shows the exact Gmail cause for last-known RTA data', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: '2026-07-17T15:04:18.000Z',
        longCount: 2,
        shortCount: 3,
        dataAvailability: {
          current: false,
          referenceOnly: true,
          contentDate: '2026-07-17',
          errorCode: 'GMAIL_AUTH_REQUIRED',
          reason: 'Gmail OAuth authorization requires attention.',
        },
      },
      etfProSnapshot: {
        available: true,
        current: true,
        dataAvailability: { current: true, ingestionStatus: 'healthy' },
        meta: { snapshotDate: today },
        rows: [{ ticker: 'SPY', call: 'Long' }],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    const rta = status.sources.find((source) => source.id === 'rta');
    expect(rta).toMatchObject({ detail: 'Stale 2/3', status: 'stale' });
    expect(rta.detailRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Last known RTA positions are from 2026-07-17.' }),
      expect.objectContaining({
        text: 'Gmail ingestion (GMAIL_AUTH_REQUIRED): Gmail OAuth authorization requires attention.',
      }),
    ]));
  });

  it('replaces a raw heartbeat IAM denial with a concise policy repair', () => {
    const rawReason = 'User: arn:aws:iam::915328198276:user/market-dashboard-local '
      + 'is not authorized to perform: dynamodb:Query on resource: '
      + 'arn:aws:dynamodb:us-west-1:915328198276:table/MarketDashboardServiceHeartbeats';
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: '2026-07-17T15:04:18.000Z',
        longCount: 2,
        shortCount: 3,
        dataAvailability: {
          current: false,
          referenceOnly: true,
          contentDate: '2026-07-17',
          errorCode: 'SERVICE_HEARTBEAT_ACCESS_DENIED',
          reason: rawReason,
        },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    const rta = status.sources.find((source) => source.id === 'rta');
    expect(rta.detailRows.map((row) => row.text)).toEqual(expect.arrayContaining([
      'Gmail ingestion (SERVICE_HEARTBEAT_ACCESS_DENIED): '
        + 'market-dashboard-local cannot query MarketDashboardServiceHeartbeats. '
        + 'Admin fix: apply infra/iam/local-readiness-catalog-policy.json with '
        + 'infra/scripts/install_local_principal_policies.sh.',
    ]));
    expect(rta.detailRows.map((row) => row.text).join(' ')).not.toContain('arn:aws:iam');
  });

  it('surfaces an archival ETF Pro book as stale with its date, count, and upstream cause', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        current: true,
        dataAvailability: { current: true, ingestionStatus: 'healthy' },
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 0,
      },
      etfProSnapshot: {
        available: false,
        current: false,
        rows: [],
        dataAvailability: {
          current: false,
          referenceOnly: true,
          errorCode: 'GMAIL_POLL_STALE',
          reason: 'The last Gmail service heartbeat is older than 45 minutes.',
        },
        lastKnownGood: {
          available: true,
          meta: { snapshotDate: '2026-07-17' },
          rows: [
            { ticker: 'SPY', call: 'Long' },
            { ticker: 'TLT', call: 'Short' },
          ],
          dataQuality: { status: 'ok', warnings: [] },
        },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    const etf = status.sources.find((source) => source.id === 'etf-pro');
    expect(etf).toMatchObject({ detail: 'Stale 1/1', status: 'stale' });
    expect(etf.detailRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'Last known ETF Pro positions are from 2026-07-17 (2 positions).',
      }),
      expect.objectContaining({
        text: 'Gmail ingestion (GMAIL_POLL_STALE): The last Gmail service heartbeat is older than 45 minutes.',
      }),
    ]));
  });

  it('turns yellow when CPI provider is positions-only while portfolio and signals are otherwise live', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected_positions_only',
            message: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
            gateway: { ok: true },
          },
        },
      },
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Prediction markets: IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
        }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detail).toBe('Error');
  });

  it('turns red and replaces a raw prediction catalog IAM denial with an actionable repair', () => {
    const today = currentDate();
    const rawError = 'User: arn:aws:iam::915328198276:user/market-dashboard-local is not authorized to perform: dynamodb:Query on resource: arn:aws:dynamodb:us-west-1:915328198276:table/PredictionMarketCatalogV2 because no identity-based policy allows the dynamodb:Query action';
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        current: true,
        dataAvailability: { current: true, ingestionStatus: 'healthy' },
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 0,
      },
      etfProSnapshot: {
        available: true,
        current: true,
        dataAvailability: { current: true, ingestionStatus: 'healthy' },
        meta: { snapshotDate: today },
        rows: [{ ticker: 'SPY', call: 'Long' }],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'catalog_unavailable',
            errorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
            message: rawError,
          },
        },
      },
    });

    const prediction = status.sources.find((source) => source.id === 'prediction-markets');
    expect(status).toMatchObject({ status: 'inactive', emoji: '🔴' });
    expect(prediction).toMatchObject({ detail: 'Error', status: 'defective' });
    expect(prediction.detailRows.map((row) => row.text)).toEqual([
      'Code: PREDICTION_CATALOG_ACCESS_DENIED',
      'market-dashboard-local lacks dynamodb:Query and dynamodb:TransactWriteItems on PredictionMarketCatalogV2.',
      'Admin fix: attach infra/iam/local-readiness-catalog-policy.json using infra/scripts/install_local_principal_policies.sh.',
    ]);
    expect(prediction.detailRows.map((row) => row.text).join(' ')).not.toContain('arn:aws:iam');
  });

  it('keeps portfolio status green when CPI positions-only has complete combined strike coverage', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected_positions_only',
            message: 'IBKR connected; CPI positions loaded from portfolio, Kalshi covers the full target ladder',
            gateway: { ok: true },
            contracts_total: 4,
            portfolio_seed_count: 4,
            portfolio_cpi_positions: 4,
            cpi_discovery: {
              targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
              foundStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
              missingStrikes: [],
              contracts_total: 7,
            },
          },
        },
      },
    });

    expect(status.status).toBe('active');
    expect(status.emoji).toBe('🟢');
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detail).toBe('Live');
  });

  it('turns yellow when CPI provider is connected without discovered contract counts', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected',
            gateway: { ok: true },
          },
        },
      },
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Prediction markets: no executable CPI contracts discovered',
        }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detail).toBe('Error');
  });

  it('turns yellow when CPI provider reports connected with an incomplete contract catalog', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: {
        providers: {
          ibkr: {
            status: 'connected',
            gateway: { ok: true },
            contracts_total: 4,
            portfolio_seed_count: 4,
            cpi_discovery: {
              targetStrikes: [3.6, 3.7, 3.8, 3.9, 4, 4.1, 4.2],
              foundStrikes: [3.8, 4, 4.1, 4.2],
              missingStrikes: [3.6, 3.7, 3.9],
            },
          },
        },
      },
    });

    expect(status.status).toBe('stale');
    expect(status.emoji).toBe('🟡');
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Prediction markets: CPI contract catalog incomplete; missing strikes 3.6%, 3.7%, 3.9%',
        }),
        expect.objectContaining({
          text: 'Prediction markets: discovered 4 of 7 target CPI contracts',
        }),
        expect.objectContaining({
          text: 'Prediction markets: only portfolio-seeded CPI contracts are available; executable contract catalog is incomplete',
        }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detail).toBe('Error');
  });

  it('uses a simple live detail when CPI contracts are current', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: true, kind: 'connected' },
      portfolioData: livePortfolio(),
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    expect(status.status).toBe('active');
    expect(status.emoji).toBe('🟢');
    expect(status.sources.map((source) => source.id)).toEqual([
      'portfolio',
      'rta',
      'etf-pro',
      'prediction-markets',
    ]);
    expect(status.sources.find((source) => source.id === 'prediction-markets')?.detail).toBe('Live');
  });

  it('stays red when Gateway or portfolio live data is unavailable even if dependent sources exist', () => {
    const today = currentDate();
    const status = getIbkrPortfolioStatusDot({
      connection: { connected: false, kind: 'gateway_offline' },
      portfolioData: { ...livePortfolio(), dataSource: 'ibkr_offline' },
      loading: false,
      rtaPositions: {
        available: true,
        lastUpdated: `${today}T16:00:00Z`,
        longCount: 1,
        shortCount: 1,
      },
      etfProSnapshot: {
        meta: { snapshotDate: today },
        rows: [
          { ticker: 'A', call: 'Long' },
          { ticker: 'B', call: 'Short' },
        ],
        dataQuality: { status: 'ok', warnings: [] },
      },
      predictionMarketProviderStatus: livePredictionProvider,
    });

    expect(status.status).toBe('inactive');
    expect(status.emoji).toBe('🔴');
  });
});
