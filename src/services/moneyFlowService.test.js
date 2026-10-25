/** @jest-environment node */
const { createMoneyFlowService } = require('./moneyFlowService.cjs');
const { moneyFlowVerdict } = require('../utils/moneyFlow.cjs');

const net = (regime, status = 'ok') => ({ status, latest: { regime, netLiquidity: 5800 } });
const part = (regime, status = 'ok') => ({ status, regime });

describe('money flow verdict', () => {
  test.each([
    ['expanding', 'accumulation', 'inflow'],
    ['contracting', 'distribution', 'outflow'],
    ['expanding', 'distribution', 'neutral'],
    ['mixed', 'accumulation', 'neutral'],
    ['contracting', 'balanced', 'neutral'],
  ])('supply %s with volume %s is %s', (supply, volume, verdict) => {
    expect(moneyFlowVerdict({ netLiquidity: net(supply), participation: part(volume) }).verdict).toBe(verdict);
  });

  test('refuses a verdict when either layer is missing or stale', () => {
    expect(moneyFlowVerdict({ netLiquidity: net('expanding', 'stale'), participation: part('accumulation') }))
      .toMatchObject({ verdict: 'unavailable', reasons: ['Fed net liquidity is stale.'] });
    expect(moneyFlowVerdict({ netLiquidity: net('expanding'), participation: part('unavailable', 'unavailable') }).verdict)
      .toBe('unavailable');
  });
});

describe('money flow service', () => {
  const NOW = new Date('2026-10-24T18:00:00Z');
  const dates = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];

  function makeService({ volumeStatus = 'current' } = {}) {
    const exchangeVolumeService = { fetchSnapshot: jest.fn(async () => ({
      meta: { status: volumeStatus },
      totalExchange: dates.slice(1).reverse().map((date) => ({ date, volume: 1e10 })),
    })) };
    const fetchPriceHistory = jest.fn(async () => ({
      bars: dates.map((date, index) => ({ date, rawClose: 100 + index })),
    }));
    const loadLiquidityModels = jest.fn(async () => ({
      models: { netLiquidity: net('expanding'), us: { latest: { date: '2026-09-01', regime: 'yellow', growth: { '3m': 0.04 }, stackToGdp: 1.02 } } },
    }));
    const httpClient = { get: jest.fn(async (url) => {
      if (url.includes('fredgraph')) return { data: 'observation_date,WRMFNS\n2026-08-24,3000\n2026-08-31,3034\n' };
      throw new Error('FINRA offline');
    }) };
    const service = createMoneyFlowService({
      exchangeVolumeService, loadLiquidityModels, fetchPriceHistory, httpClient, now: () => NOW,
    });
    return { service, exchangeVolumeService, fetchPriceHistory, loadLiquidityModels, httpClient };
  }

  test('combines the layers and keeps M2 as non-voting context', async () => {
    const { service, fetchPriceHistory } = makeService();
    const result = await service.getMoneyFlow();
    expect(fetchPriceHistory).toHaveBeenCalledWith(expect.objectContaining({ symbol: '^GSPC' }));
    expect(result.layers.usStack).toEqual({ date: '2026-09-01', regime: 'yellow', growth3m: 0.04, stackToGdp: 1.02 });
    expect(result.layers.participation.asOf).toBe('2026-10-23');
    // Three sessions cannot fill the 1M window, so no verdict is forced.
    expect(result.verdict).toBe('unavailable');
  });

  test('reports unverified Cboe volume instead of computing participation', async () => {
    const { service, fetchPriceHistory } = makeService({ volumeStatus: 'unavailable' });
    const result = await service.getMoneyFlow();
    expect(result.layers.participation).toMatchObject({ status: 'unavailable', reason: 'Cboe volume is unavailable.' });
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  test('adds margin and money fund context without letting a failed source block the card', async () => {
    const { service } = makeService();
    const result = await service.getMoneyFlow();
    expect(result.layers.margin).toMatchObject({ status: 'unavailable', reason: 'FINRA offline' });
    expect(result.layers.moneyFunds).toMatchObject({
      status: 'ok', source: 'FRED WRMFNS', latest: { date: '2026-08-31', retailMoneyFunds: 3034 },
    });
  });
});
