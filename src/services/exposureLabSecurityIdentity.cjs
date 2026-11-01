const DEFAULT_SEC_DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const DEFAULT_SEC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_YAHOO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONCURRENCY = 8;

const SEC_NAME_SOURCE = 'SEC company ticker directory';
const YAHOO_NAME_SOURCE = 'Yahoo Finance instrument metadata';
const CATALOG_NAME_SOURCE = 'Dashboard security catalog';
const AUDITED_ARCHIVE_NAME_SOURCE = 'Audited Hedgeye archive identity';

const EXPOSURE_LAB_YAHOO_SYMBOL_ALIASES = Object.freeze({
  BSE: '^BSESN',
  BTCUSD: 'BTC-USD',
  CAD: 'CADUSD=X',
  DOGE: 'DOGE-USD',
  EUR: 'EURUSD=X',
  GBP: 'GBPUSD=X',
  JPY: 'USDJPY=X',
  NIKKEI: '^N225',
  RTY: 'RTY=F',
  XMR: 'XMR-USD',
  ZEC: 'ZEC-USD',
  '5930.KR': '005930.KS',
  '660.KR': '000660.KS',
  'USD/JPY': 'USDJPY=X',
});

// These qualified symbols originate from an exact, manually audited archive
// correction. Candidate discovery status remains intact, but the identity may
// be checked with the provider instead of being left unnamed solely because a
// legacy source parser stripped the exchange suffix.
const VERIFIED_CANDIDATE_IDENTITY_TICKERS = new Set([
  'ATZ.TO',
  'BBAI',
  'CARG',
  'CFRUY',
  'EDR.SM',
  'GRGD.TO',
  'GRGDF',
  'IAF',
  'JEF',
  'KIE',
  'LTMC.MI',
  'MC.PA',
  'MNSO',
  'RPI.L',
  'SNXX',
  'THS',
  'TSLL',
  'USD/JPY',
  'XMR',
  'Z',
]);

// These catalog symbols overlap newer SEC-listed products. In this historical
// Hedgeye universe they retain the audited instrument meaning from the local
// security catalog rather than inheriting an unrelated current SEC identity.
const CATALOG_IDENTITY_PRECEDENCE_TICKERS = new Set([
  'BTC',
  'ETH',
  'GOLD',
  'XRP',
]);

// Names here describe the instrument at the archived mention date. Several
// symbols were later delisted, acquired, renamed, or reused, so a current SEC
// directory match would be missing or actively misleading.
const AUDITED_ARCHIVE_SECURITY_NAMES = Object.freeze({
  BBBY: 'Bed Bath & Beyond, Inc.',
  BYON: 'Beyond, Inc.',
  CFLT: 'Confluent, Inc.',
  DFS: 'Discover Financial Services',
  EWCZ: 'European Wax Center, Inc.',
  FI: 'Fiserv, Inc.',
  FL: 'Foot Locker, Inc.',
  FORD: 'Forward Industries, Inc.',
  GPS: 'Gap Inc.',
  'RPI.L': 'Raspberry Pi Holdings plc',
  SQ: 'Block, Inc.',
  STKL: 'SunOpta Inc.',
  TGNA: 'TEGNA Inc.',
  THS: 'TreeHouse Foods, Inc.',
  'USD/JPY': 'U.S. Dollar / Japanese Yen',
  VSCO: "Victoria's Secret & Co.",
  XAU: 'Gold Spot',
});

const SUPPORTED_YAHOO_INSTRUMENT_TYPES = new Set([
  'CRYPTOCURRENCY',
  'CURRENCY',
  'ECNQUOTE',
  'EQUITY',
  'ETF',
  'FUTURE',
  'INDEX',
  'MONEYMARKET',
  'MUTUALFUND',
]);

const DISCOVERY_PRODUCT_LABELS = new Set([
  'EARLY LOOK',
  'ETF PRO',
  'INVESTING IDEAS',
  'REAL-TIME ALERT',
  'RISK RANGES',
  'SIGNAL STRENGTH',
  'THE CALL',
  'THE MACRO SHOW',
]);

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(ticker) ? ticker : null;
}

function resolveExposureLabYahooSymbol(ticker, fallbackResolver = (value) => value) {
  const normalizedTicker = normalizeTicker(ticker);
  if (!normalizedTicker) return null;
  if (EXPOSURE_LAB_YAHOO_SYMBOL_ALIASES[normalizedTicker]) {
    return EXPOSURE_LAB_YAHOO_SYMBOL_ALIASES[normalizedTicker];
  }
  if (/^[A-Z0-9]+\.LN$/.test(normalizedTicker)) {
    return normalizedTicker.replace(/\.LN$/, '.L');
  }
  if (/^[A-Z0-9]+\.IM$/.test(normalizedTicker)) {
    return normalizedTicker.replace(/\.IM$/, '.MI');
  }
  if (/^[A-Z0-9]+\.SM$/.test(normalizedTicker)) {
    return normalizedTicker.replace(/\.SM$/, '.MC');
  }
  return fallbackResolver(normalizedTicker);
}

function normalizeSecurityName(value, ticker, { allowTickerName = false } = {}) {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 240 || /^\d+$/.test(name)) return null;
  const normalizedTicker = normalizeTicker(ticker);
  const upperName = name.toUpperCase();
  if (
    (!allowTickerName && upperName === normalizedTicker)
    || DISCOVERY_PRODUCT_LABELS.has(upperName)
  ) return null;
  return name;
}

function parseSecCompanyTickerDirectory(payload) {
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const tickerIndex = fields.indexOf('ticker');
  const nameIndex = fields.indexOf('name');
  const cikIndex = fields.indexOf('cik');
  const exchangeIndex = fields.indexOf('exchange');
  if (tickerIndex < 0 || nameIndex < 0) return new Map();

  const directory = new Map();
  rows.forEach((row) => {
    if (!Array.isArray(row)) return;
    const ticker = normalizeTicker(row[tickerIndex]);
    const name = normalizeSecurityName(row[nameIndex], ticker, { allowTickerName: true });
    if (!ticker || !name || directory.has(ticker)) return;
    directory.set(ticker, {
      ticker,
      name,
      nameSource: SEC_NAME_SOURCE,
      cik: cikIndex >= 0 && Number.isFinite(Number(row[cikIndex]))
        ? Number(row[cikIndex])
        : null,
      exchange: exchangeIndex >= 0 ? String(row[exchangeIndex] || '').trim() || null : null,
    });
  });
  return directory;
}

function parseYahooSecurityIdentity(ticker, yahooSymbol, payload) {
  const normalizedTicker = normalizeTicker(ticker);
  const expectedYahooSymbol = String(yahooSymbol || '').trim().toUpperCase();
  const chart = payload?.chart;
  const result = chart?.result?.[0];
  const meta = result?.meta;
  const returnedYahooSymbol = String(meta?.symbol || '').trim().toUpperCase();
  const instrumentType = String(meta?.instrumentType || '').trim().toUpperCase();
  if (
    !normalizedTicker
    || chart?.error
    || !meta
    || !expectedYahooSymbol
    || returnedYahooSymbol !== expectedYahooSymbol
    || !SUPPORTED_YAHOO_INSTRUMENT_TYPES.has(instrumentType)
  ) {
    return null;
  }
  const name = normalizeSecurityName(meta.longName || meta.shortName, normalizedTicker);
  if (!name) return null;
  return {
    ticker: normalizedTicker,
    name,
    nameSource: YAHOO_NAME_SOURCE,
    yahooSymbol: expectedYahooSymbol,
    instrumentType,
    exchange: String(meta.exchangeName || meta.fullExchangeName || '').trim() || null,
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) }, worker),
  );
  return output;
}

function applyExposureLabSecurityNames(universe, {
  secDirectory = new Map(),
  yahooDirectory = new Map(),
} = {}) {
  const rows = (Array.isArray(universe?.rows) ? universe.rows : []).map((row) => {
    const ticker = normalizeTicker(row.ticker);
    const isTextOnlyCandidate = row.discoveryState === 'candidate'
      && Array.isArray(row.confidenceKinds)
      && row.confidenceKinds.length > 0
      && row.confidenceKinds.every((kind) => kind === 'text_explicit');
    const providerIdentityAllowed = !isTextOnlyCandidate
      || VERIFIED_CANDIDATE_IDENTITY_TICKERS.has(ticker);
    const secIdentity = providerIdentityAllowed && ticker ? secDirectory.get(ticker) : null;
    const yahooIdentity = providerIdentityAllowed && ticker ? yahooDirectory.get(ticker) : null;
    const catalogName = normalizeSecurityName(
      row.catalogName || (row.existingUniverse ? row.name : null),
      ticker,
    );
    const catalogIdentity = catalogName ? {
      ticker,
      name: catalogName,
      nameSource: CATALOG_NAME_SOURCE,
    } : null;
    const archiveName = normalizeSecurityName(AUDITED_ARCHIVE_SECURITY_NAMES[ticker], ticker);
    const archiveIdentity = archiveName ? {
      ticker,
      name: archiveName,
      nameSource: AUDITED_ARCHIVE_NAME_SOURCE,
    } : null;
    const identity = CATALOG_IDENTITY_PRECEDENCE_TICKERS.has(ticker)
      ? catalogIdentity || secIdentity || yahooIdentity
      : archiveIdentity || secIdentity || yahooIdentity || catalogIdentity;
    const providerIdentitySelected = identity === secIdentity || identity === yahooIdentity;
    return {
      ...row,
      name: identity?.name || null,
      nameSource: identity?.nameSource || null,
      nameVerified: Boolean(identity && providerIdentitySelected),
      ...(identity?.cik != null ? { cik: identity.cik } : {}),
      ...(identity?.exchange ? { exchange: identity.exchange } : {}),
      ...(identity?.yahooSymbol ? { yahooSymbol: identity.yahooSymbol } : {}),
      ...(identity?.instrumentType ? { providerInstrumentType: identity.instrumentType } : {}),
    };
  });
  const nameSourceCounts = rows.reduce((counts, row) => {
    if (row.nameSource) counts[row.nameSource] = (counts[row.nameSource] || 0) + 1;
    return counts;
  }, {});
  const resolvedNameCount = rows.filter((row) => row.name).length;
  return {
    ...universe,
    rows,
    meta: {
      ...(universe?.meta || {}),
      resolvedNameCount,
      unresolvedNameCount: rows.length - resolvedNameCount,
      nameSourceCounts,
    },
  };
}

function consolidateQualifiedIdentityAliases(universe) {
  const sourceRows = Array.isArray(universe?.rows) ? universe.rows : [];
  const productsFor = (row) => new Set(
    (Array.isArray(row?.products) ? row.products : []).map((product) => product.product),
  );
  const removals = new Map();

  sourceRows.forEach((source) => {
    if (
      source.name
      || source.discoveryState !== 'candidate'
      || !Array.isArray(source.confidenceKinds)
      || source.confidenceKinds.length === 0
      || !source.confidenceKinds.every((kind) => kind === 'structured_list')
    ) return;
    const sourceProducts = productsFor(source);
    if (sourceProducts.size === 0) return;
    const matches = sourceRows.filter((target) => {
      if (
        target.nameVerified !== true
        || target.discoveryState !== 'structured'
        || !target.ticker.startsWith(`${source.ticker}.`)
      ) return false;
      const suffix = target.ticker.slice(source.ticker.length + 1);
      if (!/^[A-Z]{1,3}$/.test(suffix)) return false;
      const targetProducts = productsFor(target);
      return [...sourceProducts].every((product) => targetProducts.has(product));
    });
    if (matches.length === 1) removals.set(source.ticker, matches[0].ticker);
  });

  if (removals.size === 0) return universe;
  const aliasesByTarget = new Map();
  removals.forEach((targetTicker, sourceTicker) => {
    const aliases = aliasesByTarget.get(targetTicker) || [];
    aliases.push(sourceRows.find((row) => row.ticker === sourceTicker));
    aliasesByTarget.set(targetTicker, aliases.filter(Boolean));
  });
  const rows = sourceRows
    .filter((row) => !removals.has(row.ticker))
    .map((row) => {
      const aliases = aliasesByTarget.get(row.ticker) || [];
      if (aliases.length === 0) return row;
      const products = new Map(
        (row.products || []).map((product) => [product.product, { ...product }]),
      );
      let firstSeen = row.firstSeen;
      let lastSeen = row.lastSeen;
      let mentionCount = Number(row.mentionCount) || 0;
      let pullCount = Number(row.pullCount) || 0;
      const confidenceKinds = new Set(row.confidenceKinds || []);
      const evidence = [...(row.evidence || [])];

      aliases.forEach((alias) => {
        const rangesAreDisjoint = Boolean(
          (alias.lastSeen && firstSeen && alias.lastSeen < firstSeen)
          || (lastSeen && alias.firstSeen && lastSeen < alias.firstSeen),
        );
        mentionCount += Number(alias.mentionCount) || 0;
        pullCount = rangesAreDisjoint
          ? pullCount + (Number(alias.pullCount) || 0)
          : Math.max(pullCount, Number(alias.pullCount) || 0);
        if (alias.firstSeen && (!firstSeen || alias.firstSeen < firstSeen)) firstSeen = alias.firstSeen;
        if (alias.lastSeen && (!lastSeen || alias.lastSeen > lastSeen)) lastSeen = alias.lastSeen;
        (alias.confidenceKinds || []).forEach((kind) => confidenceKinds.add(kind));
        (alias.products || []).forEach((sourceProduct) => {
          const targetProduct = products.get(sourceProduct.product) || {
            product: sourceProduct.product,
            mentionCount: 0,
            firstSeen: null,
            lastSeen: null,
          };
          targetProduct.mentionCount += Number(sourceProduct.mentionCount) || 0;
          if (
            sourceProduct.firstSeen
            && (!targetProduct.firstSeen || sourceProduct.firstSeen < targetProduct.firstSeen)
          ) targetProduct.firstSeen = sourceProduct.firstSeen;
          if (
            sourceProduct.lastSeen
            && (!targetProduct.lastSeen || sourceProduct.lastSeen > targetProduct.lastSeen)
          ) targetProduct.lastSeen = sourceProduct.lastSeen;
          products.set(sourceProduct.product, targetProduct);
        });
        evidence.push(...(alias.evidence || []).map((item) => ({
          ...item,
          path: `consolidated:${alias.ticker}:${item.path}`,
        })));
      });

      return {
        ...row,
        mentionCount,
        pullCount,
        firstSeen,
        lastSeen,
        confidenceKinds: [...confidenceKinds].sort(),
        products: [...products.values()]
          .sort((left, right) => right.mentionCount - left.mentionCount
            || left.product.localeCompare(right.product)),
        evidence: evidence.slice(0, 24),
        consolidatedAliases: aliases.map((alias) => alias.ticker).sort(),
      };
    });
  const stateCounts = rows.reduce((counts, row) => {
    counts[row.discoveryState] = (counts[row.discoveryState] || 0) + 1;
    return counts;
  }, {});

  return {
    ...universe,
    rows,
    meta: {
      ...(universe?.meta || {}),
      universeCount: rows.length,
      stateCounts,
      resolvedNameCount: rows.filter((row) => row.name).length,
      unresolvedNameCount: rows.filter((row) => !row.name).length,
      consolidatedAliasCount: removals.size,
    },
  };
}

function createExposureLabSecurityIdentityResolver({
  httpClient,
  resolveYahooSymbol = (ticker) => ticker,
  now = () => Date.now(),
  secDirectoryUrl = DEFAULT_SEC_DIRECTORY_URL,
  secUserAgent = 'market-dashboard/1.0 (local research operator)',
  secRequestTimeoutMs = 30000,
  secCacheTtlMs = DEFAULT_SEC_CACHE_TTL_MS,
  yahooCacheTtlMs = DEFAULT_YAHOO_CACHE_TTL_MS,
  failureCacheTtlMs = DEFAULT_FAILURE_CACHE_TTL_MS,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  if (!httpClient || typeof httpClient.get !== 'function') {
    throw new Error('httpClient.get is required');
  }
  let secCache = null;
  const yahooCache = new Map();

  async function loadSecDirectory({ forceRefresh = false } = {}) {
    const currentTime = now();
    if (
      !forceRefresh
      && secCache
      && currentTime - secCache.timestamp < secCacheTtlMs
    ) {
      return { ...secCache.result, cacheStatus: 'hit' };
    }
    secCache = null;
    try {
      const response = await httpClient.get(secDirectoryUrl, {
        timeout: secRequestTimeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': secUserAgent,
        },
      });
      const directory = parseSecCompanyTickerDirectory(response?.data);
      if (directory.size === 0) throw new Error('SEC ticker directory was empty or malformed');
      const result = {
        status: 'available',
        directory,
        fetchedAt: new Date(currentTime).toISOString(),
        source: SEC_NAME_SOURCE,
      };
      secCache = { timestamp: currentTime, result };
      return { ...result, cacheStatus: 'miss' };
    } catch (error) {
      return {
        status: 'unavailable',
        directory: new Map(),
        fetchedAt: null,
        source: SEC_NAME_SOURCE,
        cacheStatus: 'miss',
        reason: error?.code || error?.message || 'sec_directory_unavailable',
      };
    }
  }

  async function loadYahooIdentity(ticker, { forceRefresh = false, exactTicker = false } = {}) {
    const currentTime = now();
    // Descriptive fund identity must use the held ticker, while research
    // discovery can still use established index, currency and futures aliases.
    const yahooSymbol = String(exactTicker ? ticker : resolveYahooSymbol(ticker) || '').trim();
    const cacheKey = `${ticker}:${yahooSymbol}`;
    const cached = yahooCache.get(cacheKey);
    const cachedTtl = cached?.result?.status === 'unavailable'
      ? failureCacheTtlMs
      : yahooCacheTtlMs;
    if (!forceRefresh && cached && currentTime - cached.timestamp < cachedTtl) {
      return { ...cached.result, cacheStatus: 'hit' };
    }
    yahooCache.delete(cacheKey);

    if (!yahooSymbol) {
      const result = { status: 'not_supported', identity: null, yahooSymbol: null };
      yahooCache.set(cacheKey, { timestamp: currentTime, result });
      return { ...result, cacheStatus: 'miss' };
    }
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`;
    try {
      const response = await httpClient.get(url, {
        params: {
          range: '5d',
          interval: '1d',
          includePrePost: 'false',
        },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const identity = parseYahooSecurityIdentity(ticker, yahooSymbol, response?.data);
      const result = {
        status: identity ? 'available' : 'not_found',
        identity,
        yahooSymbol,
        fetchedAt: new Date(currentTime).toISOString(),
      };
      yahooCache.set(cacheKey, { timestamp: currentTime, result });
      return { ...result, cacheStatus: 'miss' };
    } catch (error) {
      const notFound = Number(error?.response?.status) === 404;
      const result = {
        status: notFound ? 'not_found' : 'unavailable',
        identity: null,
        yahooSymbol,
        reason: notFound ? null : error?.code || error?.message || 'yahoo_identity_unavailable',
      };
      yahooCache.set(cacheKey, { timestamp: currentTime, result });
      return { ...result, cacheStatus: 'miss' };
    }
  }

  async function resolve(universe, { forceRefresh = false } = {}) {
    const sec = await loadSecDirectory({ forceRefresh });
    if (sec.status !== 'available') {
      const namedUniverse = consolidateQualifiedIdentityAliases(
        applyExposureLabSecurityNames(universe),
      );
      return {
        ...namedUniverse,
        identityDirectory: {
          status: 'unavailable',
          reason: sec.reason,
          sources: {
            sec: {
              status: 'unavailable',
              source: SEC_NAME_SOURCE,
              reason: sec.reason,
            },
            yahoo: {
              status: 'not_attempted',
              source: YAHOO_NAME_SOURCE,
              reason: 'sec_directory_unavailable',
            },
          },
        },
      };
    }

    const yahooTargets = (Array.isArray(universe?.rows) ? universe.rows : [])
      .filter((row) => (
        (row.discoveryState === 'structured'
          || VERIFIED_CANDIDATE_IDENTITY_TICKERS.has(row.ticker))
        && !row.existingUniverse
        && !sec.directory.has(row.ticker)
      ))
      .map((row) => row.ticker);
    const yahooResults = await mapWithConcurrency(
      yahooTargets,
      concurrency,
      (ticker) => loadYahooIdentity(ticker, { forceRefresh }),
    );
    const yahooDirectory = new Map(
      yahooResults
        .filter((result) => result.identity)
        .map((result) => [result.identity.ticker, result.identity]),
    );
    const yahooUnavailableCount = yahooResults
      .filter((result) => result.status === 'unavailable').length;
    const yahooNotFoundCount = yahooResults
      .filter((result) => ['not_found', 'not_supported'].includes(result.status)).length;
    const namedUniverse = consolidateQualifiedIdentityAliases(
      applyExposureLabSecurityNames(universe, {
        secDirectory: sec.directory,
        yahooDirectory,
      }),
    );
    return {
      ...namedUniverse,
      identityDirectory: {
        status: yahooUnavailableCount > 0 ? 'partial' : 'available',
        reason: yahooUnavailableCount > 0 ? 'yahoo_identity_partial' : null,
        sources: {
          sec: {
            status: 'available',
            source: SEC_NAME_SOURCE,
            fetchedAt: sec.fetchedAt,
            cacheStatus: sec.cacheStatus,
            directoryCount: sec.directory.size,
            matchedCount: namedUniverse.rows
              .filter((row) => row.nameSource === SEC_NAME_SOURCE).length,
          },
          yahoo: {
            status: yahooUnavailableCount > 0
              ? 'partial'
              : yahooTargets.length > 0 ? 'available' : 'not_needed',
            source: YAHOO_NAME_SOURCE,
            attemptedCount: yahooTargets.length,
            matchedCount: yahooDirectory.size,
            notFoundCount: yahooNotFoundCount,
            unavailableCount: yahooUnavailableCount,
          },
        },
      },
    };
  }

  return {
    loadSecDirectory,
    loadYahooIdentity,
    resolve,
  };
}

module.exports = {
  AUDITED_ARCHIVE_NAME_SOURCE,
  AUDITED_ARCHIVE_SECURITY_NAMES,
  CATALOG_IDENTITY_PRECEDENCE_TICKERS,
  CATALOG_NAME_SOURCE,
  DEFAULT_SEC_DIRECTORY_URL,
  EXPOSURE_LAB_YAHOO_SYMBOL_ALIASES,
  SEC_NAME_SOURCE,
  VERIFIED_CANDIDATE_IDENTITY_TICKERS,
  YAHOO_NAME_SOURCE,
  applyExposureLabSecurityNames,
  consolidateQualifiedIdentityAliases,
  createExposureLabSecurityIdentityResolver,
  normalizeSecurityName,
  parseSecCompanyTickerDirectory,
  parseYahooSecurityIdentity,
  resolveExposureLabYahooSymbol,
};
