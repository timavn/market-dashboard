'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ISSUER_SAMPLE, CPI_REFERENCE, MACRO_SAMPLES, verifyIssuerPayload, verifyGdpPayload,
  parseCpiPayload, reconcileMacroSample, validateIndependentSources } = require('./sourceValidation.cjs');

// Small explicit fixtures exercise source parsing and fail-closed behavior.
// Production evidence is separately retrieved and content-addressed on disk.
const CPI = {
  2006: [198.3, 198.7, 199.8, 201.5, 202.5, 202.9, 203.5, 203.9, 202.9, 201.8, 201.5, 201.8],
  2007: [202.416, 203.499, 205.352, 206.686, 207.949, 208.352, 208.299, 207.917, 208.490, 208.936, 210.177, 210.036],
  2008: [211.080, 211.693, 213.528, 214.823, 216.632, 218.815, 219.964, 219.086, 218.783, 216.573, 212.425, 210.228],
};
const GDP = {
  '2007-Q2': [11507.9, 11412.6, 11306.7, 11238.7],
  '2007-Q3': [11630.7, 11520.1, 11336.7, 11306.7],
  '2007-Q4': [11677.4, 11658.9, 11395.5, 11336.7],
  '2008-Q4': [11599.4, 11712.4, 11620.7, 11625.7],
};
const cpiPayload = () => ({ retrievalMethod: 'web.run.open', sourceUrl: CPI_REFERENCE.url,
  extractedText: 'Consumer Price Index for all Urban Consumers (CPI-U), Not Seasonally Adjusted\n'
    + 'U.S. City Average All Items 1982-1984=100\n'
    + Object.entries(CPI).map(([year, months]) => `${year} | ${months.join(' | ')} | 0`).join('\n')
    + '\nPercent Change from 12 months ago\n2007 | 2 | 2\n' });
function gdpPayload(sample) {
  const [year, quarter] = sample.quarter.split('-Q').map(Number);
  const roman = ['I', 'II', 'III', 'IV'];
  const suffix = String(year % 100).padStart(2, '0');
  return `${sample.releaseText}\nTable 8.--Real Gross Domestic Product: Percent Change From Quarter One Year Ago\n`
    + `${roman[quarter - 2]} ${suffix} ${roman[quarter - 1]} ${suffix}\n`
    + `Gross domestic product (GDP).... ${sample.publishedPreviousYoy} ${sample.publishedCurrentYoy}\nTable 9.`;
}
function date(quarter, offset, month = 0) {
  const [year, number] = quarter.split('-Q').map(Number);
  return new Date(Date.UTC(year, (number - 1 + offset) * 3 + month)).toISOString().slice(0, 10);
}
function macroRows() {
  const cpi = parseCpiPayload(cpiPayload());
  return MACRO_SAMPLES.map(sample => {
    const values = GDP[sample.quarter];
    const gdp = Object.fromEntries([0, -1, -4, -5].map((offset, index) => [date(sample.quarter, offset), values[index]]));
    const inflation = offset => [0, 1, 2].reduce((sum, month) => sum
      + 100 * (cpi[date(sample.quarter, offset, month)] / cpi[date(sample.quarter, offset - 4, month)] - 1), 0) / 3;
    return { quarter: sample.quarter, releaseDate: sample.releaseDate, quad: sample.quad,
      sourceValues: { gdp, cpi }, growthAcceleration: 100 * (values[0] / values[2] - values[1] / values[3]),
      inflationAcceleration: inflation(0) - inflation(-1) };
  });
}
function issuerPayload() {
  return '<div data-id="performance-returns-cumulative-asof">Jun 30, 2026</div>'
    + '<tr data-id="performance.returns-row-marketPrice"><td class="_ws-threeMonth">0.33</td></tr>';
}
const conventionPayload = () => ({ mimeType: 'application/pdf', base64: 'RklYVFVSRSBPTkxZ',
  extractedText: 'Beginning August 10, 2020, market price returns for BlackRock and iShares ETFs are calculated using the closing price and account for distributions from the fund.' });
function options() {
  return { cutoff: '2026-Q2', quarterlyReturns: { SHY: { '2026-Q2': 0.003322333512242759 } }, macroRows: macroRows(),
    loadCachedRaw: async definition => ({ hash: 'a'.repeat(64), retrievedAt: '2026-09-09T00:00:00Z',
      payload: definition.kind === 'performance' ? issuerPayload() : definition.kind === 'convention' ? conventionPayload()
        : definition.kind === 'cpi' ? cpiPayload() : gdpPayload(definition) }) };
}

test('issuer parser requires the right dated cumulative market-price quarter', () => {
  assert.equal(verifyIssuerPayload(issuerPayload()), true);
  assert.equal(verifyIssuerPayload(issuerPayload().replace('Jun 30', 'Mar 31')), false);
  assert.equal(verifyIssuerPayload(issuerPayload().replace('marketPrice', 'nav')), false);
  assert.equal(verifyIssuerPayload(issuerPayload().replace('0.33', '0.34')), false);
});

test('original GDP table verifies release date, quarter column and rounded YoY pair', () => {
  for (const sample of MACRO_SAMPLES) assert.equal(verifyGdpPayload(gdpPayload(sample), sample), true);
  const sample = MACRO_SAMPLES[0];
  assert.equal(verifyGdpPayload(gdpPayload(sample).replace(sample.releaseText, 'OCTOBER 31, 2008'), sample), false);
  assert.equal(verifyGdpPayload(gdpPayload(sample).replace('III 07', 'IV 07'), sample), false);
  assert.equal(verifyGdpPayload(gdpPayload(sample).replace('1.9 2.6', '1.9 2.7'), sample), false);
});

test('CPI parsing requires named CPI-U NSA source and complete positive monthly rows', () => {
  assert.equal(Object.keys(parseCpiPayload(cpiPayload())).length, 36);
  assert.throws(() => parseCpiPayload({ ...cpiPayload(), sourceUrl: 'https://example.com' }));
  assert.throws(() => parseCpiPayload({ ...cpiPayload(), extractedText: cpiPayload().extractedText.replace('CPI-U', 'CPI-W') }));
  assert.throws(() => parseCpiPayload({ ...cpiPayload(), extractedText: cpiPayload().extractedText.replace('202.416', '.') }));
});

test('one original-release example per Quad reconciles source levels and calculations', () => {
  const cpi = parseCpiPayload(cpiPayload());
  for (const [index, row] of macroRows().entries()) {
    const evidence = reconcileMacroSample(row, MACRO_SAMPLES[index], cpi);
    assert.equal(evidence.status, 'verified');
    assert.equal(evidence.cpiMonthlyLevelsMatched, 12);
  }
});

test('macro verification rejects incorrect vintage, levels, averaging or Quad', () => {
  const cpi = parseCpiPayload(cpiPayload());
  const row = macroRows()[0];
  const sample = MACRO_SAMPLES[0];
  for (const changed of [
    { ...row, releaseDate: '2007-11-30' }, { ...row, quad: 2 },
    { ...row, inflationAcceleration: row.inflationAcceleration + 0.001 },
    { ...row, growthAcceleration: row.growthAcceleration + 0.001 },
    { ...row, sourceValues: { ...row.sourceValues, cpi: { ...row.sourceValues.cpi, '2007-07-01': 208.3 } } },
    { ...row, sourceValues: { ...row.sourceValues, gdp: { ...row.sourceValues.gdp, '2007-07-01': 12000 } } },
  ]) assert.throws(() => reconcileMacroSample(changed, sample, cpi));
});

test('combined verification requires issuer and all four macro examples with seven source hashes', async () => {
  const result = await validateIndependentSources(options());
  assert.equal(result.status, 'verified');
  assert.equal(result.issuer.status, 'verified');
  assert.equal(result.macro.status, 'verified');
  assert.deepEqual(result.macro.examples.map(row => row.quad), [1, 2, 3, 4]);
  assert.equal(result.sources.length, 7);
  assert.equal(result.sourceHashes.length, 7);
});

test('source reconciliation cannot pass on issuer-only evidence or duplicate macro examples', async () => {
  const input = options();
  for (const rows of [[], input.macroRows.slice(0, 3), [...input.macroRows, input.macroRows[0]]]) {
    const result = await validateIndependentSources({ ...input, macroRows: rows });
    assert.equal(result.status, 'failed');
    assert.equal(result.issuer.status, 'verified');
    assert.equal(result.macro.status, 'failed');
  }
});

test('outside issuer rounding tolerance, missing dates and unavailable source archives fail', async () => {
  const input = options();
  const mismatched = await validateIndependentSources({ ...input,
    quarterlyReturns: { SHY: { '2026-Q2': ISSUER_SAMPLE.reportedReturn + 0.000051 } } });
  assert.equal(mismatched.status, 'failed');
  assert.equal(mismatched.issuer.status, 'failed');
  assert.equal(mismatched.macro.status, 'verified');
  assert.equal((await validateIndependentSources({ ...input, cutoff: '2026-Q1' })).status, 'failed');
  const unavailable = await validateIndependentSources({ ...input, loadCachedRaw: async () => null,
    httpClient: { get: async () => { throw new Error('offline'); } } });
  assert.equal(unavailable.status, 'failed');
  assert.deepEqual(unavailable.sourceHashes, []);
});
