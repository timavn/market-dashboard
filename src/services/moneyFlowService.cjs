const { fetchYahooAdjustedHistoryData } = require('./providers/yahooAdjustedHistory.cjs');
const { calculateParticipation, calculateVolumeTrend, VOLUME_TREND_BASELINE } = require('../utils/volumeParticipation.cjs');
const { buildMoneyFlow } = require('../utils/moneyFlow.cjs');
const { parseCsvSeries } = require('../utils/liquidityModel.cjs');
const { parseFinraMarginRows, summarizeMargin, summarizeMoneyFunds } = require('../utils/positioningFlows.cjs');
const readExcelFileModule = require('read-excel-file/universal');

const readExcelFile = readExcelFileModule.default || readExcelFileModule;
const FINRA_MARGIN_URL = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx';
const RETAIL_MMF_SERIES = 'WRMFNS';
const CONTEXT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PARTICIPATION_CACHE_TTL_MS = 20 * 60 * 1000;
// Calendar days of index history that safely cover the 3M window plus holidays.
const PRICE_LOOKBACK_DAYS = 130;
const PARTICIPATION_INDEX = '^GSPC';

async function fetchFinraMargin(httpClient) {
  const response = await httpClient.get(FINRA_MARGIN_URL, {
    responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const bytes = Buffer.from(response.data);
  const sheets = await readExcelFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return parseFinraMarginRows(Array.isArray(sheets[0]?.data) ? sheets[0].data : sheets);
}

async function fetchRetailMoneyFunds(httpClient) {
  const response = await httpClient.get('https://fred.stlouisfed.org/graph/fredgraph.csv', {
    params: { id: RETAIL_MMF_SERIES }, responseType: 'text', timeout: 20000,
  });
  return parseCsvSeries(String(response.data || ''), 'DATE', RETAIL_MMF_SERIES);
}

function createMoneyFlowService({
  exchangeVolumeService,
  loadLiquidityModels,
  fetchPriceHistory = fetchYahooAdjustedHistoryData,
  httpClient = require('axios'),
  now = () => new Date(),
}) {
  let cached = null;
  let pending = null;
  let contextCache = null;

  async function context({ refresh = false } = {}) {
    if (!refresh && contextCache && now().getTime() - contextCache.at < CONTEXT_CACHE_TTL_MS) return contextCache.value;
    const [margin, moneyFunds] = await Promise.allSettled([
      fetchFinraMargin(httpClient),
      fetchRetailMoneyFunds(httpClient),
    ]);
    const value = {
      margin: margin.status === 'fulfilled'
        ? { ...summarizeMargin(margin.value, now()), source: 'FINRA margin statistics' }
        : { status: 'unavailable', latest: null, reason: margin.reason?.message },
      moneyFunds: moneyFunds.status === 'fulfilled'
        ? { ...summarizeMoneyFunds(moneyFunds.value, now()), source: `FRED ${RETAIL_MMF_SERIES}` }
        : { status: 'unavailable', latest: null, reason: moneyFunds.reason?.message },
    };
    if (margin.status === 'fulfilled' && moneyFunds.status === 'fulfilled') contextCache = { at: now().getTime(), value };
    return value;
  }

  async function loadParticipation() {
    const period1 = String(Math.floor(now().getTime() / 1000) - PRICE_LOOKBACK_DAYS * 86400);
    const [volume, prices] = await Promise.all([
      // A year of sessions feeds the volume trend; participation reads the newest 3M.
      exchangeVolumeService.fetchSnapshot({ days: VOLUME_TREND_BASELINE + 5 }),
      fetchPriceHistory({ symbol: PARTICIPATION_INDEX, period1 }),
    ]);
    if (volume?.meta?.status !== 'current') {
      return { status: 'unavailable', regime: 'unavailable', reason: `Cboe volume is ${volume?.meta?.status || 'unavailable'}.` };
    }
    const closes = (prices?.bars || []).map((bar) => ({ date: bar.date, close: bar.rawClose }));
    return {
      ...calculateParticipation(volume.totalExchange, closes),
      volumeTrend: calculateVolumeTrend(volume.totalExchange),
      sources: { volume: 'Cboe Historical Market Volume', price: `S&P 500 (${PARTICIPATION_INDEX}) daily close` },
    };
  }

  async function participation({ refresh = false } = {}) {
    if (!refresh && cached && now().getTime() - cached.at < PARTICIPATION_CACHE_TTL_MS) return cached.value;
    if (pending) return pending;
    pending = loadParticipation()
      .catch((error) => ({ status: 'unavailable', regime: 'unavailable', reason: error.message }))
      .then((value) => {
        if (value.status === 'ok') cached = { at: now().getTime(), value };
        return value;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  async function getMoneyFlow({ refresh = false } = {}) {
    const [liquidity, participationResult, contextResult] = await Promise.all([
      loadLiquidityModels({ refresh }),
      participation({ refresh }),
      context({ refresh }),
    ]);
    return buildMoneyFlow({ liquidity, participation: participationResult, context: contextResult, now: now() });
  }

  return { getMoneyFlow };
}

module.exports = { createMoneyFlowService };
