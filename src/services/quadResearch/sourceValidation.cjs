'use strict';

// Reviewed issuer evidence is a limited independent sample reconciliation, not
// an assertion that every historical observation has an independent source.
const ISSUER_SAMPLE = Object.freeze({
  id: 'shy-2026-q2-market-close', symbol: 'SHY', quarter: '2026-Q2',
  startDate: '2026-03-31', endDate: '2026-06-30',
  reportedReturn: 0.0033, reportedPrecisionPercentagePoints: 0.01,
  tolerance: 0.00005, // Half of the issuer's displayed 0.01 percentage point unit.
  reviewedAt: '2026-09-09T04:39:52.938Z',
  convention: 'Issuer market-price performance uses exchange closing prices and accounts for fund distributions; this sample is after the August 10, 2020 convention change.',
  limitation: 'One independently published quarterly sample, within issuer display rounding. Yahoo backward distribution adjustment is not mathematically identical to cash-reinvestment accounting.',
  sources: Object.freeze([
    Object.freeze({
      source: 'BlackRock SHY published performance and distributions',
      url: 'https://www.blackrock.com/us/individual/products/239452/ishares-1-3-year-treasury-bond-etf',
      reviewedHash: 'dc03824876ac32ba69db65538f6e46e61ccf65a207f45e491a6909d2967c809a',
      kind: 'performance',
    }),
    Object.freeze({
      source: 'BlackRock published ETF market-price performance convention',
      url: 'https://www.ishares.com/us/literature/product-brief/balq-product-brief.pdf',
      reviewedHash: 'a0dee7b4382979aac5bf98a01aebc144e24adc150068dc318894146094284051',
      kind: 'convention',
    }),
  ]),
});

const CPI_REFERENCE = Object.freeze({
  source: 'BLS CPI-U independent table extraction',
  url: 'https://www.bls.gov/regions/northeast/data/consumerpriceindex_us_table.htm',
  reviewedHash: 'cc62524bb67e3651ba3b860d525ef0505d394b60b00dc283c58c5cd951659ef2',
  kind: 'cpi',
  limitation: 'Current BLS NSA historical table, read through the browser text tool because direct HTTP was denied. Exact sample monthly levels are reconciled with the GDP-release-date ALFRED vintage; this is not an independent archive of every monthly CPI release.',
});
const MACRO_SAMPLES = Object.freeze([
  { quad: 1, quarter: '2007-Q3', releaseDate: '2007-10-31', releaseText: 'OCTOBER 31, 2007',
    publishedPreviousYoy: 1.9, publishedCurrentYoy: 2.6,
    url: 'https://www.bea.gov/news/2007/gross-domestic-product-third-quarter-2007-advance-estimates',
    reviewedHash: 'ff83c9fc2ec551eb93baf48310109cbd79c0720ba701f81d18234a94585a9ddb' },
  { quad: 2, quarter: '2007-Q2', releaseDate: '2007-07-27', releaseText: 'JULY 27, 2007',
    publishedPreviousYoy: 1.5, publishedCurrentYoy: 1.8,
    url: 'https://www.bea.gov/news/2007/gross-domestic-product-second-quarter-2007-advance-estimates',
    reviewedHash: '799b6fd1a9f1c59f8382ad6e82108f94d33eb274fd9ca60891677cd0305fe32c' },
  { quad: 3, quarter: '2007-Q4', releaseDate: '2008-01-30', releaseText: 'JANUARY 30, 2008',
    publishedPreviousYoy: 2.8, publishedCurrentYoy: 2.5,
    url: 'https://www.bea.gov/sites/default/files/2019-11/gdp407a.txt',
    reviewedHash: '745a60d24dfbf033238dd463852713b4d3746f09384b84275757ed86ef255ab8' },
  { quad: 4, quarter: '2008-Q4', releaseDate: '2009-01-30', releaseText: 'JANUARY 30, 2009',
    publishedPreviousYoy: 0.7, publishedCurrentYoy: -0.2,
    url: 'https://www.bea.gov/sites/default/files/2019-11/gdp408a.txt',
    reviewedHash: '70bf2e623435d7d7ed32c06ea78691e0be4b836406b6d036dc24436aa56db484' },
].map(sample => Object.freeze({ ...sample, source: 'Original macro validation reference', kind: 'gdp' })));

function verifyGdpPayload(payload, sample) {
  if (typeof payload !== 'string') return false;
  const text = payload.replace(/<[^>]*>/g, ' ');
  if (!text.toUpperCase().replace(/\s+/g, ' ').includes(sample.releaseText)) return false;
  const table = text.slice(text.indexOf('Table 8.')).split('Table 9.')[0];
  if (!table.includes('Percent Change From Quarter One Year Ago')) return false;
  const headers = [...table.matchAll(/\b(IV|III|II|I)\s+(\d{2})\b/g)].map(match =>
    `${2000 + Number(match[2])}-Q${['I', 'II', 'III', 'IV'].indexOf(match[1]) + 1}`);
  const row = table.match(/Gross domestic product \(GDP\)([^\r\n]*)/)?.[1];
  const values = row?.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g)?.map(Number);
  return headers.at(-1) === sample.quarter && values?.length === headers.length
    && values.at(-2) === sample.publishedPreviousYoy && values.at(-1) === sample.publishedCurrentYoy;
}

function parseCpiPayload(payload) {
  if (payload?.retrievalMethod !== 'web.run.open' || payload.sourceUrl !== CPI_REFERENCE.url
    || typeof payload.extractedText !== 'string') throw new Error('BLS primary extraction is absent.');
  const text = payload.extractedText.split('Consumer Price Index for all Urban Consumers (CPI-U), Not Seasonally Adjusted')[1]
    ?.split('Percent Change from 12 months ago')[0];
  if (!text?.includes('U.S. City Average All Items 1982-1984=100')) throw new Error('BLS series identity is absent.');
  const values = {};
  for (const year of [2006, 2007, 2008]) {
    const row = text.match(new RegExp(`(?:^|\\n)(?:L\\d+: )?${year}\\s+\\|([^\\n]+)`))?.[1];
    const months = row?.split('|').slice(0, 12).map(value => Number(value.trim()));
    if (months?.length !== 12 || months.some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error('BLS monthly sample is incomplete.');
    }
    months.forEach((value, month) => { values[`${year}-${String(month + 1).padStart(2, '0')}-01`] = value; });
  }
  return values;
}

function quarterDate(quarter, offset = 0, month = 0) {
  const [year, number] = quarter.split('-Q').map(Number);
  return new Date(Date.UTC(year, (number - 1 + offset) * 3 + month, 1)).toISOString().slice(0, 10);
}
function reconcileMacroSample(row, sample, cpi) {
  if (row?.quarter !== sample.quarter || row.quad !== sample.quad || row.releaseDate !== sample.releaseDate) {
    throw new Error('Original quarter, release date or Quad does not match.');
  }
  const gdp = row.sourceValues?.gdp || {};
  const gdpLevels = [0, -1, -4, -5].map(offset => gdp[quarterDate(sample.quarter, offset)]);
  if (gdpLevels.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('GDP sample levels are absent.');
  const currentYoy = 100 * (gdpLevels[0] / gdpLevels[2] - 1);
  const previousYoy = 100 * (gdpLevels[1] / gdpLevels[3] - 1);
  // Table 8 rounds each reported YoY rate to 0.1 pp: half-unit per rate,
  // at most 0.1 pp on their difference. These are display-precision bounds.
  if (Math.abs(currentYoy - sample.publishedCurrentYoy) > 0.05
    || Math.abs(previousYoy - sample.publishedPreviousYoy) > 0.05
    || !Number.isFinite(row.growthAcceleration)
    || Math.abs(currentYoy - previousYoy - row.growthAcceleration) > 1e-9) {
    throw new Error('Original GDP YoY rates do not reconcile within published precision.');
  }
  for (const offset of [0, -1, -4, -5]) {
    for (let month = 0; month < 3; month++) {
      const date = quarterDate(sample.quarter, offset, month);
      if (!Number.isFinite(cpi[date]) || row.sourceValues?.cpi?.[date] !== cpi[date]) {
        throw new Error('Original-vintage CPI monthly level differs from the BLS reference.');
      }
    }
  }
  const inflation = offset => [0, 1, 2].reduce((sum, month) => sum
    + 100 * (cpi[quarterDate(sample.quarter, offset, month)] / cpi[quarterDate(sample.quarter, offset - 4, month)] - 1), 0) / 3;
  const inflationAcceleration = inflation(0) - inflation(-1);
  const growthAcceleration = currentYoy - previousYoy;
  const quad = growthAcceleration > 0 ? (inflationAcceleration > 0 ? 2 : 1) : (inflationAcceleration > 0 ? 3 : 4);
  if (!Number.isFinite(row.inflationAcceleration) || Math.abs(inflationAcceleration - row.inflationAcceleration) > 1e-9
    || quad !== sample.quad) throw new Error('Monthly CPI YoY mean or Quad does not reconcile.');
  return { ...sample, status: 'verified', currentYoy, previousYoy, growthAcceleration, inflationAcceleration,
    gdpYoyTolerancePp: 0.05, gdpAccelerationDisplayBoundPp: 0.1, numericalTolerancePp: 1e-9,
    cpiMonthlyLevelsMatched: 12, sourceValues: row.sourceValues };
}

function verifyIssuerPayload(payload) {
  if (typeof payload !== 'string') return false;
  const cumulativeAsOf = /data-id="performance-returns-cumulative-asof"[\s\S]{0,500}?>Jun 30, 2026<\/div>/.test(payload);
  const marketRows = payload.match(/<tr data-id="performance\.returns-row-marketPrice">[\s\S]*?<\/tr>/g) || [];
  const quarterRow = marketRows.find(row => row.includes('_ws-threeMonth'));
  const value = quarterRow?.match(/_ws-threeMonth"[^>]*>(-?\d+(?:\.\d+)?)<\/td>/)?.[1];
  return cumulativeAsOf && value !== undefined && Number(value) / 100 === ISSUER_SAMPLE.reportedReturn;
}

function verifyConventionPayload(payload) {
  const text = payload?.extractedText?.replace(/\s+/g, ' ') || '';
  return payload?.mimeType === 'application/pdf' && typeof payload.base64 === 'string'
    && text.includes('Beginning August 10, 2020, market price returns for BlackRock and iShares ETFs are calculated using the closing price and account for distributions from the fund.');
}

async function validateIndependentSources({ archiveRaw, loadCachedRaw, httpClient = require('axios'),
  now = new Date(), cutoff, quarterlyReturns = {}, macroRows = [] } = {}) {
  const sources = [];
  const sourceHashes = [];
  const issues = [];
  const computedReturn = quarterlyReturns[ISSUER_SAMPLE.symbol]?.[ISSUER_SAMPLE.quarter];
  const issuer = {
    ...ISSUER_SAMPLE, computedReturn: Number.isFinite(computedReturn) ? computedReturn : null,
    difference: Number.isFinite(computedReturn) ? computedReturn - ISSUER_SAMPLE.reportedReturn : null,
    scope: 'independent quarterly sample; all-cohort corporate-action verification is separate',
  };
  const macro = { status: 'failed', examples: [], cpiReference: CPI_REFERENCE,
    scope: 'One original BEA advance release per Quad, with BLS monthly CPI-U NSA levels matched to the same ALFRED GDP-release-date vintage.' };
  async function source(definition) {
      const cached = loadCachedRaw ? await loadCachedRaw(definition) : null;
      let payload = cached?.payload;
      let hash = cached?.hash;
      let retrievedAt = cached?.retrievedAt || new Date(now).toISOString();
      if (!payload) {
        if (definition.kind === 'cpi') throw new Error('Reviewed BLS tool extraction must be archived before publication.');
        const response = await httpClient.get(definition.url, {
          timeout: 20000, ...(definition.kind === 'convention' ? { responseType: 'arraybuffer' } : {}),
        });
        if (definition.kind === 'convention') {
          const binary = Buffer.from(response.data);
          const parsed = await require('pdf-parse')(binary);
          payload = { mimeType: 'application/pdf', base64: binary.toString('base64'), extractedText: parsed.text };
        } else payload = response.data;
        if (!archiveRaw) throw new Error('Source archive is required for independent validation.');
        hash = await archiveRaw({ source: definition.source, url: definition.url, payload, retrievedAt });
      }
      const verified = definition.kind === 'performance' ? verifyIssuerPayload(payload)
        : definition.kind === 'convention' ? verifyConventionPayload(payload)
          : definition.kind === 'gdp' ? verifyGdpPayload(payload, definition) : Boolean(parseCpiPayload(payload));
      if (!verified || !/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('Independent primary evidence did not verify.');
      sources.push({ source: definition.source, url: definition.url, hash, retrievedAt });
      sourceHashes.push(hash);
      return payload;
  }
  try {
    if (!cutoff || cutoff < ISSUER_SAMPLE.quarter || !Number.isFinite(computedReturn)) throw new Error('Sample is absent.');
    for (const definition of ISSUER_SAMPLE.sources) await source(definition);
    if (Math.abs(issuer.difference) > ISSUER_SAMPLE.tolerance) issues.push({
      code: 'independent_issuer_return_mismatch', symbol: ISSUER_SAMPLE.symbol, quarter: ISSUER_SAMPLE.quarter,
      difference: issuer.difference, tolerance: ISSUER_SAMPLE.tolerance,
    });
  } catch {
    issues.push({ code: 'independent_issuer_evidence_unavailable' });
  }
  issuer.status = issues.length ? 'failed' : 'verified';
  try {
    const cpi = parseCpiPayload(await source(CPI_REFERENCE));
    for (const sample of MACRO_SAMPLES) {
      await source(sample);
      const matches = macroRows.filter(row => row.quarter === sample.quarter);
      if (matches.length !== 1) throw new Error('Original macro example is absent or duplicated.');
      macro.examples.push(reconcileMacroSample(matches[0], sample, cpi));
    }
    macro.status = 'verified';
  } catch (error) {
    issues.push({ code: 'independent_original_macro_evidence_unavailable', detail: error.message });
  }
  return { status: issues.length ? 'failed' : 'verified', issuer, macro, issues, sourceHashes, sources };
}

module.exports = { ISSUER_SAMPLE, CPI_REFERENCE, MACRO_SAMPLES, verifyIssuerPayload, verifyConventionPayload,
  verifyGdpPayload, parseCpiPayload, reconcileMacroSample, validateIndependentSources };
