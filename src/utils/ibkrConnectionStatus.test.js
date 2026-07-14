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
        expect.objectContaining({ text: 'RTA stale; latest stored RTA is 2026-06-18' }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'rta')?.detailRows).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/count mismatch/i) }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'rta')?.detail).toBe('Error');
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'ETF Pro stale; latest stored ETF Pro is 2026-06-18' }),
        expect.objectContaining({ text: 'ETF Pro data quality: warning' }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detailRows).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/count mismatch/i) }),
      ]),
    );
    expect(status.sources.find((source) => source.id === 'etf-pro')?.detail).toBe('Error');
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
