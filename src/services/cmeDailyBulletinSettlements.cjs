const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');

const CME_BULLETIN_TIMEOUT_MS = 15_000;
const MAX_CME_BULLETIN_BYTES = 10 * 1024 * 1024;
const CME_BULLETINS = Object.freeze({
  GCQ26: Object.freeze({
    url: 'https://www.cmegroup.com/daily_bulletin/current/Section62_Metals_Futures_Products.pdf',
    productHeading: 'GC FUT',
    productDescription: 'COMEX GOLD FUTURES',
    contractMonth: 'AUG26',
    market: 'gold',
    productCode: 'METLG',
  }),
});

const ES_MONTHS = Object.freeze({ H: 'MAR', M: 'JUN', U: 'SEP', Z: 'DEC' });

function cmeBulletinConfigForSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (CME_BULLETINS[symbol]) return CME_BULLETINS[symbol];
  const es = symbol.match(/^ES([HMUZ])(\d{2})$/);
  if (!es) return null;
  return Object.freeze({
    url: 'https://www.cmegroup.com/daily_bulletin/current/Section11_Equity_And_Index_Futures.pdf',
    productHeading: 'EMINI S&P FUT',
    contractMonth: `${ES_MONTHS[es[1]]}${es[2]}`,
    market: 'sp500',
    productCode: 'FES',
  });
}

function sourceError(message, code) {
  return Object.assign(new Error(message), { code });
}

function finiteNumber(value) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function normalizedDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === raw ? raw : null;
}

function bulletinDate(items = []) {
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const dates = new Set();
  items.forEach((item) => {
    const match = String(item?.str || '').match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(20\d{2})/);
    if (!match) return;
    const candidate = `${match[3]}-${months[match[1]]}-${String(match[2]).padStart(2, '0')}`;
    if (normalizedDate(candidate)) dates.add(candidate);
  });
  return dates.size === 1 ? [...dates][0] : null;
}

function normalizePdfItem(item = {}) {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const x = Number(transform[4] ?? item.x);
  const y = Number(transform[5] ?? item.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { str: String(item.str || ''), x, y };
}

function parseFinalCmeBulletinPages(pages = [], { settlementSymbol, tradingDate } = {}) {
  const symbol = String(settlementSymbol || '').trim().toUpperCase();
  const config = cmeBulletinConfigForSymbol(symbol);
  const expectedDate = normalizedDate(tradingDate);
  if (!config || !expectedDate) {
    throw sourceError('An exact supported CME settlement symbol and trading date are required.', 'CME_BULLETIN_IDENTITY_INVALID');
  }
  const normalizedPages = (pages || []).map((page) => (page || []).map(normalizePdfItem).filter(Boolean));
  const productMatches = [];
  normalizedPages.forEach((items, pageIndex) => {
    items.forEach((item) => {
      if (item.str.trim() !== config.productHeading) return;
      const descriptionMatches = !config.productDescription
        || items.some((candidate) => (
          candidate.str.trim() === config.productDescription
          && Math.abs(candidate.y - item.y) <= 2
        ));
      if (descriptionMatches) productMatches.push({ pageIndex, item });
    });
  });
  if (productMatches.length !== 1) {
    throw sourceError('The CME bulletin contained an ambiguous or missing expected product.', 'CME_BULLETIN_PRODUCT_AMBIGUOUS');
  }
  const { pageIndex, item: heading } = productMatches[0];
  const page = normalizedPages[pageIndex];
  if (!page.some((item) => item.str.trim() === 'FINAL')) {
    throw sourceError('The CME bulletin was not marked FINAL.', 'CME_BULLETIN_NOT_FINAL');
  }
  if (config.productDescription && !page.some((item) => item.str.trim() === config.productDescription && Math.abs(item.y - heading.y) <= 2)) {
    throw sourceError('The CME bulletin product description did not match.', 'CME_BULLETIN_PRODUCT_AMBIGUOUS');
  }
  if (bulletinDate(page) !== expectedDate) {
    throw sourceError('The CME bulletin date did not match the contract event date.', 'CME_BULLETIN_DATE_MISMATCH');
  }
  const totalRows = page.filter((item) => item.str.trim() === `TOTAL  ${config.productHeading}` && item.y < heading.y);
  if (totalRows.length !== 1) {
    throw sourceError('The CME bulletin product table boundary was ambiguous.', 'CME_BULLETIN_PRODUCT_AMBIGUOUS');
  }
  const lowerBoundary = totalRows[0].y;
  const monthRows = page.filter((item) => (
    item.str.trim() === config.contractMonth
    && item.x < 40
    && item.y < heading.y
    && item.y > lowerBoundary
  ));
  if (monthRows.length !== 1) {
    throw sourceError('The CME bulletin contained an ambiguous or missing expected contract month.', 'CME_BULLETIN_CONTRACT_AMBIGUOUS');
  }
  const rowY = monthRows[0].y;
  const settlementItems = page.filter((item) => (
    Math.abs(item.y - rowY) <= 1.5
    && item.x >= 270
    && item.x <= 310
    && finiteNumber(item.str) != null
  ));
  if (settlementItems.length !== 1) {
    throw sourceError('The CME bulletin settlement cell was ambiguous or missing.', 'CME_BULLETIN_SETTLEMENT_AMBIGUOUS');
  }
  return {
    settlementSymbol: symbol,
    tradingDate: expectedDate,
    market: config.market,
    productCode: config.productCode,
    contractMonth: config.contractMonth,
    value: finiteNumber(settlementItems[0].str),
    pageNumber: pageIndex + 1,
  };
}

async function extractPdfPages(buffer, parser = pdfParse) {
  const result = await parser(buffer, {
    version: 'v1.10.100',
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      return JSON.stringify(content.items.map((item) => ({ str: item.str, transform: item.transform })));
    },
  });
  const pages = String(result?.text || '')
    .split(/\n\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        const parsed = JSON.parse(entry);
        return Array.isArray(parsed) ? parsed : null;
      } catch (_error) {
        return null;
      }
    });
  if (!pages.length || pages.some((page) => !page)) {
    throw sourceError('The CME bulletin PDF text could not be parsed safely.', 'CME_BULLETIN_PDF_INVALID');
  }
  return pages;
}

function createCmeDailyBulletinLoader({
  fetchImpl = global.fetch,
  parser = pdfParse,
  now = () => new Date(),
  cacheTtlMs = 5 * 60 * 1000,
  failureCacheTtlMs = 30 * 1000,
} = {}) {
  const cache = new Map();
  const failures = new Map();
  const inFlight = new Map();

  async function loadPdf(config) {
    const cached = cache.get(config.url);
    if (cached && now().getTime() < cached.expiresAt) return cached.value;
    const failed = failures.get(config.url);
    if (failed && now().getTime() < failed.expiresAt) throw sourceError(failed.message, failed.code);
    if (inFlight.has(config.url)) return inFlight.get(config.url);

    const request = (async () => {
      if (typeof fetchImpl !== 'function') {
        throw sourceError('No HTTP client is available for CME bulletins.', 'CME_BULLETIN_FETCH_UNAVAILABLE');
      }
      const url = new URL(config.url);
      if (!/(^|\.)cmegroup\.com$/i.test(url.hostname)) {
        throw sourceError('The CME bulletin source was not authoritative.', 'CME_BULLETIN_SOURCE_UNVERIFIED');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CME_BULLETIN_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/pdf', 'user-agent': 'market-dashboard-settlement-verifier/1.0' },
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (error) {
        throw sourceError(
          'The CME daily bulletin is unavailable.',
          error?.name === 'AbortError' ? 'CME_BULLETIN_FETCH_TIMEOUT' : 'CME_BULLETIN_FETCH_UNAVAILABLE',
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response?.ok) throw sourceError('The CME daily bulletin returned an error.', 'CME_BULLETIN_FETCH_UNAVAILABLE');
      const responseUrl = new URL(response.url || url.toString());
      if (!/(^|\.)cmegroup\.com$/i.test(responseUrl.hostname)) {
        throw sourceError('The CME bulletin redirected outside CME Group.', 'CME_BULLETIN_SOURCE_UNVERIFIED');
      }
      const contentType = response.headers?.get?.('content-type');
      if (contentType && !/application\/pdf/i.test(contentType)) {
        throw sourceError('The CME daily bulletin response was not a PDF.', 'CME_BULLETIN_SOURCE_UNVERIFIED');
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_CME_BULLETIN_BYTES || buffer.slice(0, 4).toString() !== '%PDF') {
        throw sourceError('The CME daily bulletin PDF was empty, oversized, or invalid.', 'CME_BULLETIN_PDF_INVALID');
      }
      const value = {
        pages: await extractPdfPages(buffer, parser),
        sourceUrl: responseUrl.toString(),
        sourceHash: crypto.createHash('sha256').update(buffer).digest('hex'),
        observedAt: now().toISOString(),
      };
      failures.delete(config.url);
      cache.set(config.url, { value, expiresAt: now().getTime() + cacheTtlMs });
      return value;
    })();
    inFlight.set(config.url, request);
    try {
      return await request;
    } catch (error) {
      failures.set(config.url, {
        code: error?.code || 'CME_BULLETIN_FETCH_UNAVAILABLE',
        message: error?.message || 'The CME daily bulletin is unavailable.',
        expiresAt: now().getTime() + failureCacheTtlMs,
      });
      throw error;
    } finally {
      if (inFlight.get(config.url) === request) inFlight.delete(config.url);
    }
  }

  return async function loadCmeDailyBulletinSettlement({ settlementSymbol, tradingDate } = {}) {
    const symbol = String(settlementSymbol || '').trim().toUpperCase();
    const config = cmeBulletinConfigForSymbol(symbol);
    if (!config) {
      throw sourceError('The requested CME settlement symbol is not supported.', 'CME_BULLETIN_IDENTITY_INVALID');
    }
    const document = await loadPdf(config);
    const settlement = parseFinalCmeBulletinPages(document.pages, { settlementSymbol: symbol, tradingDate });
    return {
      role: 'resolver',
      availability: 'official_final',
      final: true,
      source: 'cme_daily_bulletin_final',
      sourceUrl: document.sourceUrl,
      sourceHash: document.sourceHash,
      asOf: document.observedAt,
      symbol,
      ...settlement,
    };
  };
}

module.exports = {
  CME_BULLETINS,
  CME_BULLETIN_TIMEOUT_MS,
  MAX_CME_BULLETIN_BYTES,
  cmeBulletinConfigForSymbol,
  createCmeDailyBulletinLoader,
  extractPdfPages,
  parseFinalCmeBulletinPages,
};
