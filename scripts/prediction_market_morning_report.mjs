#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const MARKET_ORDER = Object.freeze(['sp500', 'wti', 'nasdaq100', 'gold']);
const MARKET_LABELS = Object.freeze({
  sp500: 'S&P 500',
  wti: 'WTI',
  nasdaq100: 'Nasdaq 100',
  gold: 'Gold',
});

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function number(value, digits = 2) {
  if (!present(value) || !Number.isFinite(Number(value))) return 'unavailable';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function signed(value, digits = 2) {
  if (!present(value) || !Number.isFinite(Number(value))) return 'unavailable';
  const parsed = Number(value);
  return `${parsed > 0 ? '+' : ''}${parsed.toFixed(digits)}`;
}

function cents(value) {
  if (!present(value) || !Number.isFinite(Number(value))) return 'unavailable';
  return `${Math.round(Number(value) * 100)}¢`;
}

function timestamp(value) {
  return present(value) ? String(value) : 'timestamp unavailable';
}

function contractDescriptor(line) {
  if (present(line?.threshold)) {
    const comparator = String(line.comparator || '').toLowerCase();
    const prefix = comparator.includes('less') || comparator.includes('below') ? 'Below' : 'Above';
    return `${prefix} ${number(line.threshold)}`;
  }
  if (present(line?.lowerBound) || present(line?.upperBound)) {
    return `${number(line.lowerBound)}–${number(line.upperBound)}`;
  }
  return line?.ticker || 'Contract';
}

function unavailableReason(section, fallback) {
  return String(section?.reason || fallback);
}

function formatCatalogAndBook(market) {
  const catalog = market.catalog || {};
  const book = market.directBook || {};
  const output = [];
  if (catalog.status === 'available') {
    const event = catalog.event || {};
    output.push(
      `${event.title || event.ticker || 'Current event'} (${event.ticker || 'ticker unavailable'}), `
      + `closes ${timestamp(event.closeTime)}; ${number(catalog.contractCount, 0)} catalog contracts.`,
    );
  } else {
    output.push(unavailableReason(catalog, 'No current contract catalog is available.'));
  }

  if (book.status !== 'available') {
    output.push(`Current Yes/No pricing unavailable: ${unavailableReason(book, 'No verified direct native book is available.')}`);
    return output.join(' ');
  }

  output.push(
    `Verified direct native book from ${book.venueId || 'venue unavailable'} as of ${timestamp(book.asOf)}; `
    + `${number(book.lineCount, 0)} complete lines.`,
  );
  for (const line of book.focusLines || []) {
    const volume = present(line.volume24h) ? `; 24h volume ${number(line.volume24h, 0)}` : '';
    const openInterest = present(line.openInterest) ? `; open interest ${number(line.openInterest, 0)}` : '';
    output.push(
      `\n- ${line.ticker || 'ticker unavailable'} — ${contractDescriptor(line)}: `
      + `Yes ${cents(line.yesBid)}–${cents(line.yesAsk)}, No ${cents(line.noBid)}–${cents(line.noAsk)}`
      + `${volume}${openInterest}.`,
    );
  }
  return output.join(' ');
}

function formatRiskAndBias(market) {
  const risk = market.riskRange || {};
  if (risk.status !== 'available') {
    return `RR unavailable: ${unavailableReason(risk, 'Current Risk Range is unavailable.')} Trend unavailable.`;
  }
  return `Buy Trade ${number(risk.buyTrade ?? risk.lrr)} / Sell Trade ${number(risk.sellTrade ?? risk.hrr)}; Trend ${risk.trend || 'unavailable'}; RR date ${timestamp(risk.date || risk.asOf)}.`;
}

function formatLocation(market) {
  const location = market.rangePosition || market.rangeLocation || {};
  if (location.status !== 'available') return unavailableReason(location, 'Current range location is unavailable.');
  const label = location.referenceLabel || 'Reference';
  const percentile = present(location.positionPct) ? ` (${number(location.positionPct, 1)}% of range)` : '';
  return `${label} ${number(location.value)} is in the ${location.zone} zone${percentile}; distance to LRR ${signed(location.distanceToLrr)} and to HRR ${signed(location.distanceToHrr)}.`;
}

function formatUsd(market) {
  const usd = market.usdCorrelation || {};
  if (usd.status !== 'available') return unavailableReason(usd, 'Current exact USD correlation is unavailable.');
  return `r30 ${signed(usd.r30)}${present(usd.r15) ? `; r15 ${signed(usd.r15)}` : ''}${present(usd.r90) ? `; r90 ${signed(usd.r90)}` : ''}; as of ${timestamp(usd.asOf)}. Context only.`;
}

function formatCftc(market) {
  const cftc = market.cftcZScore || {};
  if (cftc.status !== 'available') return unavailableReason(cftc, 'Current verified CFTC z-score is unavailable.');
  return `1Y ${signed(cftc.zScore1Y)}${present(cftc.zScore3Y) ? `; 3Y ${signed(cftc.zScore3Y)}` : ''}; as of ${timestamp(cftc.asOf)}. Positioning context only.`;
}

function formatRead(market) {
  const setup = market.setup || {};
  const reasons = Array.isArray(setup.reasons) && setup.reasons.length
    ? setup.reasons.join(' ')
    : 'The required current setup is not present.';
  if (setup.rankEligible === true) {
    return `Rank-eligible research screen: ${setup.pattern}. No trade recommendation; Yes/No direction, entry, and sizing remain outside this report.`;
  }
  if (setup.researchQualified === true) {
    return `RR/bias research pattern matched (${setup.pattern}), but it is not rank-eligible. ${reasons}`;
  }
  return `No qualified setup. ${reasons}`;
}

function validateReport(report) {
  if (!report || report.reportType !== 'four_market_morning') {
    throw new Error('Dashboard response is not a four-market morning report.');
  }
  if (JSON.stringify(report.marketOrder) !== JSON.stringify(MARKET_ORDER)) {
    throw new Error('Dashboard report market order is invalid.');
  }
  const ids = Array.isArray(report.markets) ? report.markets.map((row) => row?.marketId) : [];
  if (JSON.stringify(ids) !== JSON.stringify(MARKET_ORDER)) {
    throw new Error('Dashboard report is missing one or more ordered market sections.');
  }
}

export function formatMorningReport(report, researchIndex = {}) {
  validateReport(report);
  const lines = [
    '# Four-Market Morning Report',
    '',
    `Current monitor as of ${timestamp(report.asOf || report.generatedAt)}. CPI is omitted because it is a monthly contract area.`,
  ];

  for (const market of report.markets) {
    lines.push(
      '',
      `## ${MARKET_LABELS[market.marketId]}`,
      '',
      `**Current contract:** ${formatCatalogAndBook(market)}`,
      '',
      `**Risk Range / Trend:** ${formatRiskAndBias(market)}`,
      '',
      `**Range location:** ${formatLocation(market)}`,
      '',
      `**Dollar correlation:** ${formatUsd(market)}`,
      '',
      `**CFTC z-score:** ${formatCftc(market)}`,
      '',
      `**Read:** ${formatRead(market)}`,
    );
  }

  const summary = report.summary || {};
  lines.push(
    '',
    '**Live data status**',
    '',
    `- Current monitor as of ${timestamp(report.asOf || report.generatedAt)}: ${number(summary.currentCatalogCount, 0)}/4 catalogs; ${number(summary.verifiedDirectBookCount, 0)}/4 verified direct books; ${number(summary.executionVerifiedCount, 0)}/4 execution-verified.`,
    '',
    `- Research screens: ${number(summary.matchedSetupCount, 0)} matched; ${number(summary.rankEligibleCount, 0)} rank-eligible; no trade recommendation.`,
    '',
    `- Research index: ${researchIndex.status || 'unavailable'}; last sync ${timestamp(researchIndex.lastSyncAt)}; latest Risk Ranges ${researchIndex.latestRiskRangesDate || 'unavailable'}; archival only, never used for current fields.${researchIndex.lastSyncError ? ` Error: ${researchIndex.lastSyncError}` : ''}`,
  );
  return `${lines.join('\n')}\n`;
}

async function fetchNoStoreJson(url, { allowErrorStatus = false } = {}) {
  const response = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!allowErrorStatus && !response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  if (!String(response.headers.get('cache-control') || '').toLowerCase().includes('no-store')) {
    throw new Error(`${url} did not return Cache-Control: no-store.`);
  }
  return response.json();
}

export async function runMorningReport({
  apiBase = process.env.MARKET_DASHBOARD_API_BASE || 'http://127.0.0.1:3001',
  analystBase = process.env.ANALYST_SIDECAR_URL || 'http://127.0.0.1:6951',
} = {}) {
  const report = await fetchNoStoreJson(`${apiBase.replace(/\/$/, '')}/api/prediction-market-test/morning-report`, {
    allowErrorStatus: true,
  });
  let researchIndex = { status: 'unavailable', lastSyncAt: null, latestRiskRangesDate: null };
  try {
    const health = await fetchNoStoreJson(`${analystBase.replace(/\/$/, '')}/healthz`);
    researchIndex = {
      status: health.status || 'unavailable',
      lastSyncAt: health.lastSyncAt || null,
      lastSyncError: health.lastSyncError || null,
      latestRiskRangesDate: health.latestRiskRangesDate || null,
    };
  } catch (error) {
    researchIndex.lastSyncError = `Analyst health unavailable: ${error.message}`;
  }
  return formatMorningReport(report, researchIndex);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMorningReport()
    .then((markdown) => process.stdout.write(markdown))
    .catch((error) => {
      process.stderr.write(`Four-market morning report unavailable: ${error.message}\n`);
      process.exitCode = 1;
    });
}
