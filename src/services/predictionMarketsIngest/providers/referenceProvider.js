const { setProviderStatus } = require('../cache');

const REFERENCE_SYMBOLS = {
  SPY: { source: 'yahoo', ticker: 'SPY' },
  SPX: { source: 'yahoo', ticker: '^GSPC' },
  QQQ: { source: 'yahoo', ticker: 'QQQ' },
  DIA: { source: 'yahoo', ticker: 'DIA' },
  IWM: { source: 'yahoo', ticker: 'IWM' },
  VIX: { source: 'yahoo', ticker: '^VIX' },
  GOLD: { source: 'yahoo', ticker: 'GC=F' },
  OIL: { source: 'yahoo', ticker: 'CL=F' },
  DXY: { source: 'yahoo', ticker: 'DX-Y.NYB' },
  BTC: { source: 'yahoo', ticker: 'BTC-USD' },
};

const FRED_MACRO = {
  CPI: 'CPIAUCSL',
  UNRATE: 'UNRATE',
  GDP: 'GDP',
  DGS10: 'DGS10',
  DGS2: 'DGS2',
};

async function fetchYahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'market-dashboard/1.0' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return {
    price: meta.regularMarketPrice,
    change_pct: meta.regularMarketChangePercent,
    source: 'yahoo',
    ticker,
  };
}

async function fetchFredLatest(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const obs = json?.observations?.[0];
  if (!obs || obs.value === '.') return null;
  return { latest: parseFloat(obs.value), date: obs.date, source: 'fred', series: seriesId };
}

async function fetchTreasuryYieldCurve() {
  const url =
    'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page[size]=5';
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return { rows: json?.data || [], source: 'treasury.gov' };
}

async function fetchReferenceMarketData(options = {}) {
  const reference = {};

  await Promise.all(
    Object.entries(REFERENCE_SYMBOLS).map(async ([key, cfg]) => {
      try {
        reference[key] = await fetchYahooQuote(cfg.ticker);
      } catch (err) {
        console.warn(`[Reference] Yahoo ${key}:`, err.message);
      }
    })
  );

  await Promise.all(
    Object.entries(FRED_MACRO).map(async ([key, seriesId]) => {
      try {
        const row = await fetchFredLatest(seriesId);
        if (row) reference[key] = row;
      } catch (err) {
        console.warn(`[Reference] FRED ${key}:`, err.message);
      }
    })
  );

  try {
    reference.TREASURY_YIELD_CURVE = await fetchTreasuryYieldCurve();
  } catch (err) {
    console.warn('[Reference] Treasury:', err.message);
  }

  if (process.env.BLS_API_KEY) {
    try {
      reference.BLS_NOTE = {
        message: 'Configure BLS series IDs in referenceProvider.js for release-day context',
        source: 'bls',
      };
    } catch (err) {
      console.warn('[Reference] BLS:', err.message);
    }
  }

  setProviderStatus('reference', {
    status: 'connected',
    last_success_at: new Date().toISOString(),
    message: null,
  });

  return reference;
}

module.exports = { fetchReferenceMarketData, REFERENCE_SYMBOLS };
