const crypto = require('node:crypto');

const OFFICIAL_MARGIN_RATE_URL = 'https://www.interactivebrokers.com/en/trading/margin-rates.php';
const FETCH_TIMEOUT_MS = 10_000;

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&le;|&#8804;|&#x2264;/gi, '≤')
    .replace(/&gt;|&#62;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html) {
  return [...String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decodeHtml(cell[1])))
    .filter((cells) => cells.length >= 4);
}

function parsePercent(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? Number((parsed / 100).toFixed(8))
    : null;
}

function parseUpperBound(value) {
  const normalized = String(value || '').replace(/,/g, '').trim();
  if (/^>\s*[0-9]+(?:\.\d+)?$/.test(normalized)) return null;
  const values = [...normalized.matchAll(/[0-9]+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]));
  return values.length >= 2 && Number.isFinite(values.at(-1))
    ? values.at(-1)
    : null;
}

function parseOfficialUsdMarginSchedule(html) {
  const rows = tableRows(html);
  const headerCount = rows.filter((cells) => (
    cells.some((cell) => /Rate Charged:\s*IBKR Pro/i.test(cell))
    && cells.some((cell) => /Rate Charged:\s*IBKR Lite/i.test(cell))
  )).length;
  if (headerCount !== 1) {
    const error = new Error('The official IBKR margin-rate table header was missing or ambiguous.');
    error.code = 'interest_official_rate_table_ambiguous';
    throw error;
  }

  const usdRows = [];
  let collecting = false;
  for (const cells of rows) {
    const currency = String(cells[0] || '').trim().toUpperCase();
    if (currency === 'USD') collecting = true;
    else if (collecting && currency) break;
    if (collecting) usdRows.push(cells);
  }
  if (usdRows.length !== 5) {
    const error = new Error('The official IBKR USD margin-rate schedule was missing or ambiguous.');
    error.code = 'interest_official_rate_schedule_ambiguous';
    throw error;
  }

  let priorUpper = 0;
  const proTiers = [];
  const liteRates = [];
  usdRows.forEach((cells, index) => {
    const tierText = cells[1];
    const annualRate = parsePercent(cells[2]);
    const liteAnnualRate = parsePercent(cells[3]);
    const upTo = parseUpperBound(tierText);
    const terminal = index === usdRows.length - 1;
    if (
      annualRate === null
      || liteAnnualRate === null
      || (terminal && upTo !== null)
      || (!terminal && (upTo === null || upTo <= priorUpper))
    ) {
      const error = new Error('The official IBKR USD margin-rate tiers did not reconcile.');
      error.code = 'interest_official_rate_schedule_ambiguous';
      throw error;
    }
    proTiers.push({
      label: `USD tier ${index + 1}`,
      upTo,
      annualRate,
    });
    liteRates.push(liteAnnualRate);
    if (upTo !== null) priorUpper = upTo;
  });
  if (new Set(liteRates.map((rate) => rate.toFixed(8))).size !== 1) {
    const error = new Error('The official IBKR Lite comparison rates were ambiguous.');
    error.code = 'interest_official_rate_schedule_ambiguous';
    throw error;
  }

  const scheduleHash = crypto.createHash('sha256').update(JSON.stringify({
    currency: 'USD',
    plan: 'IBKR Pro',
    tiers: proTiers,
    liteAnnualRate: liteRates[0],
  })).digest('hex');
  return {
    currency: 'USD',
    plan: 'IBKR Pro',
    tiers: proTiers,
    liteAnnualRate: liteRates[0],
    scheduleHash,
  };
}

async function fetchOfficialUsdProMarginSchedule({
  fetchImpl = global.fetch,
  now = () => new Date(),
  url = OFFICIAL_MARGIN_RATE_URL,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('No HTTP client is available for the official IBKR rate page.');
    error.code = 'interest_official_rate_fetch_unavailable';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    const wrapped = new Error('The current official IBKR margin-rate page is unavailable.');
    wrapped.code = error?.name === 'AbortError'
      ? 'interest_official_rate_fetch_timeout'
      : 'interest_official_rate_fetch_unavailable';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    const error = new Error('The current official IBKR margin-rate page returned an error.');
    error.code = 'interest_official_rate_fetch_unavailable';
    throw error;
  }
  const responseUrl = new URL(response.url || url);
  if (!/(^|\.)interactivebrokers\.com$/i.test(responseUrl.hostname)) {
    const error = new Error('The official IBKR margin-rate request redirected outside IBKR.');
    error.code = 'interest_official_rate_source_unverified';
    throw error;
  }
  const parsed = parseOfficialUsdMarginSchedule(await response.text());
  return {
    ...parsed,
    source: 'ibkr_official_margin_rates',
    url: responseUrl.toString(),
    fetchedAt: now().toISOString(),
    provisional: true,
  };
}

module.exports = {
  FETCH_TIMEOUT_MS,
  OFFICIAL_MARGIN_RATE_URL,
  fetchOfficialUsdProMarginSchedule,
  parseOfficialUsdMarginSchedule,
};
