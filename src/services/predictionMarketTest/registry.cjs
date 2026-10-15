const SOURCE_ROLES = Object.freeze({
  RESOLVER: 'resolver',
  PROXY: 'proxy',
  RESEARCH: 'research',
  VENUE_QUOTE: 'venue_quote',
});

const AVAILABILITY_STATES = Object.freeze([
  'not_configured',
  'starting',
  'live_exact',
  'live_proxy',
  'official_preliminary',
  'official_final',
  'pending_release',
  'market_closed',
  'stale',
  'unavailable',
]);

const CONTRACT_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'wti',
    displayName: 'WTI Oil',
    measuredPeriod: 'Aug 14, 2026',
    resolutionDate: '2026-08-14',
    contractShape: 'threshold',
    comparator: '>',
    precision: 2,
    unit: 'USD/bbl',
    closeAt: '2026-08-14T18:30:00.000Z',
    resolver: Object.freeze({
      literal: 'ICE Futures Europe WTI September 2026 official daily settlement',
      exchange: 'ICE Futures Europe',
      mic: 'IFEU',
      contractSymbol: 'WBS 26U-ICE',
      priceType: 'official_daily_settlement',
      rulesUrl: 'https://assets.kalshi.com/regulatory/product-certifications/COMMODITYSETTLE.pdf',
      sourceUrl: 'https://www.ice.com/products/213/WTI-Crude-Futures',
      warning: 'The resolver is ICE WBS September 2026. CME WTI, spot WTI, and continuous CL do not resolve this contract.',
    }),
    feed: Object.freeze({
      provider: 'ibkr',
      dataset: 'IBKR TWS API live L1',
      symbol: 'CLU6',
      displaySymbol: 'CLU26',
      role: SOURCE_ROLES.PROXY,
      exact: false,
      instrument: Object.freeze({
        symbol: 'CLU26',
        ibkrSymbol: 'CL',
        secType: 'FUT',
        exchange: 'NYMEX',
        currency: 'USD',
        provider: 'ibkr',
        lastTradeDateOrContractMonth: '202609',
        tradingClass: 'CL',
        multiplier: '1000',
      }),
      expectedLocalSymbols: Object.freeze(['CLU6', 'CLU26']),
      expectedExpirationStart: '2026-08-15T00:00:00.000Z',
      expectedExpirationEnd: '2026-08-25T23:59:59.999Z',
      warning: 'CME PROXY — DOES NOT RESOLVE CONTRACT',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'Kalshi',
        productCode: 'KXWTI',
        eventTicker: 'KXWTI-26AUG1414',
        closeAt: '2026-08-14T18:30:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      ticker: 'WTIC',
      label: 'WTI Risk Range',
      fit: 'calibration',
      warning: 'Directional research only; it is not the ICE WBS settlement or a contract-month settlement range.',
    }),
  }),
  Object.freeze({
    id: 'gold',
    displayName: 'Gold',
    measuredPeriod: 'Aug 14, 2026',
    resolutionDate: '2026-08-14',
    contractShape: 'threshold',
    comparator: '>',
    precision: 1,
    unit: 'USD/oz',
    closeAt: '2026-08-14T17:30:00.000Z',
    resolver: Object.freeze({
      literal: 'COMEX Gold August 2026 official daily settlement',
      exchange: 'COMEX',
      mic: 'XCEC',
      contractSymbol: 'GCQ26',
      priceType: 'official_daily_settlement',
      rulesUrl: 'https://data.forecastex.com/regulatory/METLGTermsandConditions.pdf',
      sourceUrl: 'https://www.cmegroup.com/content/dam/cmegroup/notices/ser/2025/12/ser-9637.pdf',
      warning: 'The resolver is dated August 2026 Gold, not spot gold, GC=F, October, or December Gold.',
    }),
    feed: Object.freeze({
      provider: 'ibkr',
      dataset: 'IBKR TWS API live L1',
      symbol: 'GCQ6',
      displaySymbol: 'GCQ26',
      role: SOURCE_ROLES.RESOLVER,
      exact: true,
      instrument: Object.freeze({
        symbol: 'GCQ26',
        ibkrSymbol: 'GC',
        secType: 'FUT',
        exchange: 'COMEX',
        currency: 'USD',
        provider: 'ibkr',
        lastTradeDateOrContractMonth: '202608',
        tradingClass: 'GC',
        multiplier: '100',
      }),
      expectedLocalSymbols: Object.freeze(['GCQ6', 'GCQ26']),
      expectedExpirationStart: '2026-08-20T00:00:00.000Z',
      expectedExpirationEnd: '2026-09-01T23:59:59.999Z',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'ForecastEx',
        productCode: 'METLG',
        contractPrefix: 'METLG_081426_',
        closeAt: '2026-08-14T17:30:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      ticker: 'GLD',
      label: 'Gold Risk Range',
      fit: 'strong_proxy',
      warning: 'Hedgeye labels this Gold; it is research, not a GLD ETF quote or the GCQ26 official settlement.',
    }),
  }),
  Object.freeze({
    id: 'sp500',
    displayName: 'S&P 500 Futures',
    measuredPeriod: 'Aug 14, 2026',
    resolutionDate: '2026-08-14',
    contractShape: 'threshold',
    comparator: '>',
    precision: 2,
    unit: 'index points',
    closeAt: '2026-08-14T20:00:00.000Z',
    resolver: Object.freeze({
      literal: 'September 2026 E-mini S&P 500 futures official daily settlement',
      exchange: 'CME',
      mic: 'XCME',
      contractSymbol: 'ESU26',
      priceType: 'official_daily_settlement',
      rulesUrl: 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf',
      sourceUrl: 'https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.html',
      warning: 'The resolver is the dated ESU26 settlement, not cash SPX or a continuous ES contract.',
    }),
    feed: Object.freeze({
      provider: 'ibkr',
      dataset: 'IBKR TWS API live L1',
      symbol: 'ESU6',
      displaySymbol: 'ESU26',
      role: SOURCE_ROLES.RESOLVER,
      exact: true,
      instrument: Object.freeze({
        symbol: 'ESU26',
        ibkrSymbol: 'ES',
        secType: 'FUT',
        exchange: 'CME',
        currency: 'USD',
        provider: 'ibkr',
        lastTradeDateOrContractMonth: '202609',
        tradingClass: 'ES',
        multiplier: '50',
      }),
      expectedLocalSymbols: Object.freeze(['ESU6', 'ESU26']),
      expectedExpirationStart: '2026-09-15T00:00:00.000Z',
      expectedExpirationEnd: '2026-09-21T23:59:59.999Z',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'ForecastEx',
        productCode: 'FES',
        contractPrefix: 'FES_081426_',
        closeAt: '2026-08-14T20:00:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      ticker: 'SPX',
      label: 'SPX Risk Range',
      fit: 'strong_proxy',
      warning: 'Cash SPX differs from ES futures because of rates, dividends, and settlement methodology.',
    }),
  }),
  Object.freeze({
    id: 'nasdaq100',
    displayName: 'Nasdaq-100 Futures',
    measuredPeriod: 'Aug 14, 2026',
    resolutionDate: '2026-08-14',
    contractShape: 'threshold',
    comparator: '>',
    precision: 2,
    unit: 'index points',
    closeAt: '2026-08-14T20:00:00.000Z',
    resolver: Object.freeze({
      literal: 'September 2026 E-mini Nasdaq-100 futures official daily settlement',
      exchange: 'CME',
      mic: 'XCME',
      contractSymbol: 'NQU26',
      priceType: 'official_daily_settlement',
      rulesUrl: 'https://data.forecastex.com/regulatory/FNQTermsandConditions.pdf',
      sourceUrl: 'https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.html',
      warning: 'The resolver is the dated NQU26 settlement, not COMPQ, NDX spot, or a continuous NQ contract.',
    }),
    feed: Object.freeze({
      provider: 'ibkr',
      dataset: 'IBKR TWS API live L1',
      symbol: 'NQU6',
      displaySymbol: 'NQU26',
      role: SOURCE_ROLES.RESOLVER,
      exact: true,
      instrument: Object.freeze({
        symbol: 'NQU26',
        ibkrSymbol: 'NQ',
        secType: 'FUT',
        exchange: 'CME',
        currency: 'USD',
        provider: 'ibkr',
        lastTradeDateOrContractMonth: '202609',
        tradingClass: 'NQ',
        multiplier: '20',
      }),
      expectedLocalSymbols: Object.freeze(['NQU6', 'NQU26']),
      expectedExpirationStart: '2026-09-15T00:00:00.000Z',
      expectedExpirationEnd: '2026-09-21T23:59:59.999Z',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'ForecastEx',
        productCode: 'FNQ',
        contractPrefix: 'FNQ_081426_',
        closeAt: '2026-08-14T20:00:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      ticker: 'COMPQ',
      label: 'Nasdaq Composite Risk Range',
      fit: 'related_only',
      warning: 'RELATED INDEX ONLY — Nasdaq Composite is not Nasdaq-100 and must not be used as an NQ range.',
    }),
  }),
  Object.freeze({
    id: 'bitcoin',
    displayName: 'Bitcoin Range',
    measuredPeriod: 'Aug 14, 2026 · 5:00 PM ET',
    resolutionDate: '2026-08-14',
    contractShape: 'range',
    comparator: 'inclusive_range',
    precision: 2,
    unit: 'USD/BTC',
    closeAt: '2026-08-14T21:00:00.000Z',
    resolver: Object.freeze({
      literal: 'Simple average of the CF Bitcoin Real-Time Index (BRTI) during the 300 seconds before 5:00 PM ET, excluding the highest and lowest 20% of values',
      exchange: 'CF Benchmarks',
      mic: null,
      contractSymbol: 'BRTI · 300s trimmed average',
      priceType: 'five_minute_trimmed_simple_average',
      rulesUrl: 'https://assets.kalshi.com/regulatory/product-certifications/BTC.pdf',
      sourceUrl: 'https://www.cfbenchmarks.com/data/indices/BRTI',
      warning: 'A current BRTI tick is an exact input, not the completed five-minute trimmed average. Kalshi’s published expiration value is final.',
    }),
    proxyFeed: Object.freeze({
      provider: 'coinbase_exchange',
      symbol: 'BTC-USD',
      displaySymbol: 'Coinbase BTC-USD',
      role: SOURCE_ROLES.PROXY,
      exact: false,
      warning: 'COINBASE SPOT PROXY — DOES NOT RESOLVE CONTRACT',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'Kalshi',
        productCode: 'KXBTC',
        eventTicker: 'KXBTC-26AUG1417',
        closeAt: '2026-08-14T21:00:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      sourceType: 'bitcoin-trend-tracker',
      ticker: 'BTC',
      label: 'Bitcoin Tracker — BTC',
      fit: 'strong_directional',
      requiredDate: '2026-08-14',
      warning: 'Same asset and useful calibration, but a daily Hedgeye research level is not BRTI or the five-minute trimmed resolver.',
    }),
  }),
  Object.freeze({
    id: 'ethereum',
    displayName: 'Ethereum Range',
    measuredPeriod: 'Aug 14, 2026 · 5:00 PM ET',
    resolutionDate: '2026-08-14',
    contractShape: 'range',
    comparator: 'inclusive_range',
    precision: 2,
    unit: 'USD/ETH',
    closeAt: '2026-08-14T21:00:00.000Z',
    resolver: Object.freeze({
      literal: 'Simple average of the CF Ethereum Real-Time Index (ERTI/ETHUSD_RTI) during the 300 seconds before 5:00 PM ET, excluding the highest and lowest 20% of values',
      exchange: 'CF Benchmarks',
      mic: null,
      contractSymbol: 'ETHUSD_RTI · 300s trimmed average',
      priceType: 'five_minute_trimmed_simple_average',
      rulesUrl: 'https://assets.kalshi.com/regulatory/product-certifications/ETH.pdf',
      sourceUrl: 'https://www.cfbenchmarks.com/data/indices/ETHUSD_RTI',
      warning: 'A current ETHUSD_RTI tick is an exact input, not the completed five-minute trimmed average. Kalshi’s published expiration value is final.',
    }),
    proxyFeed: Object.freeze({
      provider: 'coinbase_exchange',
      symbol: 'ETH-USD',
      displaySymbol: 'Coinbase ETH-USD',
      role: SOURCE_ROLES.PROXY,
      exact: false,
      warning: 'COINBASE SPOT PROXY — DOES NOT RESOLVE CONTRACT',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'Kalshi',
        productCode: 'KXETH',
        eventTicker: 'KXETH-26AUG1417',
        closeAt: '2026-08-14T21:00:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      sourceType: 'bitcoin-trend-tracker',
      ticker: 'ETH',
      label: 'Bitcoin Tracker — ETH',
      fit: 'strong_directional',
      requiredDate: '2026-08-14',
      warning: 'Same asset and useful calibration, but a daily Hedgeye research level is not ETHUSD_RTI or the five-minute trimmed resolver.',
    }),
  }),
  Object.freeze({
    id: 'cpi',
    displayName: 'US CPI YoY',
    measuredPeriod: 'Aug 2026',
    resolutionDate: '2026-08',
    contractShape: 'threshold',
    releaseAt: '2026-09-11T12:30:00.000Z',
    comparator: '>',
    precision: 1,
    unit: '% YoY',
    closeAt: '2026-09-11T12:29:00.000Z',
    resolver: Object.freeze({
      literal: 'Initial BLS all-items CPI-U, U.S. city average, not seasonally adjusted, 12-month percent change for August 2026',
      exchange: 'Bureau of Labor Statistics',
      mic: null,
      contractSymbol: 'CUUR0000SA0',
      priceType: 'initial_release_one_decimal',
      rulesUrl: 'https://assets.kalshi.com/regulatory/product-certifications/YOYCPI.pdf',
      secondaryRulesUrl: 'https://data.forecastex.com/regulatory/CPIYTermsandConditions.pdf',
      sourceUrl: 'https://www.bls.gov/news.release/cpi.nr0.htm',
      warning: 'Use the initial August 2026 CPI-U NSA YoY release rounded to one decimal; later revisions do not replace it.',
    }),
    bls: Object.freeze({
      seriesId: 'CUUR0000SA0',
      reportMonth: '2026-08',
      reportMonthLabel: 'August 2026',
      priorYearMonth: '2025-08',
    }),
    venues: Object.freeze([
      Object.freeze({
        venue: 'Kalshi',
        productCode: 'KXCPIYOY',
        eventTicker: 'KXCPIYOY-26AUG',
        closeAt: '2026-09-11T12:29:00.000Z',
      }),
      Object.freeze({
        venue: 'ForecastEx',
        productCode: 'CPIY',
        contractPrefix: 'CPIY_0826_',
        closeAt: '2026-09-11T12:30:00.000Z',
      }),
    ]),
    hedgeye: Object.freeze({
      ticker: null,
      label: 'Monthly Inflation Nowcast — Headline CPI YoY',
      fit: 'forecast_exact_metric',
      requiredMonth: '2026-08',
      warning: 'Forecast research only. If the August 2026 nowcast is not published, no older month is substituted.',
    }),
  }),
]);

function registryError(message) {
  return Object.assign(new Error(message), { code: 'PM_TEST_REGISTRY_INVALID' });
}

function isContinuousSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return /=F$/.test(normalized)
    || /^(?:GC|ES|NQ|CL)(?:1!|\.C|_CONT|CONT)$/i.test(normalized)
    || /CONTINUOUS/i.test(normalized);
}

function validateContractRegistry(registry = CONTRACT_REGISTRY) {
  if (!Array.isArray(registry) || registry.length === 0) {
    throw registryError('The resolver registry must contain at least one product.');
  }
  const ids = new Set();
  const feedSymbols = new Set();
  for (const product of registry) {
    if (!product?.id || ids.has(product.id)) throw registryError(`Duplicate or missing product id: ${product?.id || 'unknown'}`);
    ids.add(product.id);
    const contractShape = product.contractShape || 'threshold';
    if (!['threshold', 'range'].includes(contractShape)) throw registryError(`${product.id} has an invalid contract shape.`);
    if (contractShape === 'threshold' && product.comparator !== '>') throw registryError(`${product.id} must use the strict > comparator.`);
    if (contractShape === 'range' && product.comparator !== 'inclusive_range') throw registryError(`${product.id} must use inclusive range buckets.`);
    if (!Number.isInteger(product.precision) || product.precision < 0 || product.precision > 6) {
      throw registryError(`${product.id} has an invalid display precision.`);
    }
    if (!product.resolver?.literal || !product.resolver?.priceType || !product.resolver?.rulesUrl) {
      throw registryError(`${product.id} is missing resolver provenance.`);
    }
    if (!Array.isArray(product.venues) || product.venues.length === 0) {
      throw registryError(`${product.id} has no venue selectors.`);
    }
    for (const [feedName, feed] of [['feed', product.feed], ['proxyFeed', product.proxyFeed]]) {
      if (!feed) continue;
      const symbol = String(feed.symbol || '').trim().toUpperCase();
      if (!symbol || isContinuousSymbol(symbol)) throw registryError(`${product.id} uses a forbidden continuous or missing ${feedName} symbol.`);
      const feedIdentity = `${feed.provider || 'unknown'}:${symbol}`;
      if (feedSymbols.has(feedIdentity)) throw registryError(`Duplicate feed symbol: ${feedIdentity}`);
      feedSymbols.add(feedIdentity);
      if (!['resolver', 'proxy'].includes(feed.role)) throw registryError(`${product.id} has an invalid ${feedName} role.`);
      if (feed.exact !== (feed.role === SOURCE_ROLES.RESOLVER)) {
        throw registryError(`${product.id} has inconsistent ${feedName} exactness.`);
      }
      if (feed.provider !== 'ibkr') continue;
      const start = Date.parse(feed.expectedExpirationStart || '');
      const end = Date.parse(feed.expectedExpirationEnd || '');
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw registryError(`${product.id} has an invalid expected maturity window.`);
      }
      const instrument = feed.instrument;
      if (
        instrument?.provider !== 'ibkr'
        || instrument?.secType !== 'FUT'
        || !instrument?.ibkrSymbol
        || !/^20\d{4}$/.test(String(instrument.lastTradeDateOrContractMonth || ''))
        || !Array.isArray(feed.expectedLocalSymbols)
        || feed.expectedLocalSymbols.length === 0
      ) {
        throw registryError(`${product.id} is missing an exact IBKR futures identity.`);
      }
    }
  }
  return true;
}

validateContractRegistry(CONTRACT_REGISTRY);

const CONTRACT_BY_ID = Object.freeze(Object.fromEntries(CONTRACT_REGISTRY.map((product) => [product.id, product])));
const CONTRACT_BY_FEED_SYMBOL = Object.freeze(Object.fromEntries(
  CONTRACT_REGISTRY.filter((product) => product.feed?.provider === 'ibkr').map((product) => [product.feed.symbol, product]),
));

module.exports = {
  AVAILABILITY_STATES,
  CONTRACT_BY_FEED_SYMBOL,
  CONTRACT_BY_ID,
  CONTRACT_REGISTRY,
  SOURCE_ROLES,
  isContinuousSymbol,
  validateContractRegistry,
};
