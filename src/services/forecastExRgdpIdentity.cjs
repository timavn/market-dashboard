const { formatInTimeZone } = require('date-fns-tz');

const RGDP_TERMS_URL = 'https://data.forecastex.com/regulatory/RGDPTermsandConditions.pdf';
// Reviewed against the complete official RGDP terms on 2026-09-09. The
// measured quarter is part of the question; the third reading decides it.
const RGDP_RULES = Object.freeze({
  productCode: 'RGDP',
  metric: 'real_gdp',
  unit: 'qoq_saar_pct',
  settlementStage: 'third',
  releaseStage: 'third',
  comparator: '>',
  earlyResolution: false,
  sourceAgency: 'BEA',
  rulesUrl: RGDP_TERMS_URL,
  rulesVerifiedAt: '2026-09-09',
});

function identityError(message) {
  return Object.assign(new Error(message), { code: 'FORECASTEX_RGDP_IDENTITY_INVALID' });
}

function isOfficialRgdpTermsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.href === RGDP_TERMS_URL;
  } catch (_error) {
    return false;
  }
}

function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRgdpContractIdentity(line = {}, { measuredQuarter = null } = {}) {
  const match = String(line.contractId || '').match(/^RGDP_Q([1-4])(\d{2})_(-?\d+(?:\.\d+)?)$/);
  const question = String(line.question || '').replace(/\s+/g, ' ').trim().match(
    /^Will the annualized growth rate in US Real GDP exceed (-?\d+(?:\.\d+)?)% in Q([1-4]) (20\d{2})\?$/i,
  );
  if (line.productId !== 'RGDP' || !match || !question
    || !isOfficialRgdpTermsUrl(line.rulesUrl || line.exchangeSpecUrl)) {
    throw identityError('RGDP requires its official contract ID, quarter-specific real GDP question, and complete official terms.');
  }
  const quarter = `${2000 + Number(match[2])}-Q${match[1]}`;
  const strike = finiteNumber(line.strike);
  if (strike == null || strike !== Number(match[3]) || strike !== Number(question[1])
    || match[1] !== question[2] || 2000 + Number(match[2]) !== Number(question[3])
    || (measuredQuarter && measuredQuarter !== quarter)
    || (line.measuredQuarter && line.measuredQuarter !== quarter)
    || (line.metric && line.metric !== RGDP_RULES.metric)
    || (line.unit && line.unit !== RGDP_RULES.unit)
    || (line.comparator && line.comparator !== '>')
    || (line.releaseStage && line.releaseStage !== 'third')
    || (line.settlementStage && line.settlementStage !== 'third')
    || line.earlyResolution === true) {
    throw identityError('RGDP contract metadata conflicts with the measured quarter, threshold, or third-estimate rules.');
  }
  return { ...RGDP_RULES, measuredQuarter: quarter, generationKey: `RGDP_Q${match[1]}${match[2]}`, strike };
}

function schedulePart(value) {
  // The public-source parser converts the catalog's Chicago wall clock to UTC.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(value || ''))) return null;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return null;
  return {
    iso: new Date(millis).toISOString(),
    date: formatInTimeZone(new Date(millis), 'America/Chicago', 'yyyy-MM-dd'),
    time: formatInTimeZone(new Date(millis), 'America/Chicago', 'HH:mm:ss'),
  };
}

function validateRgdpGeneration(lines = [], { measuredQuarter = null, decidingReleaseAt = null } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw identityError('The RGDP generation is empty.');
  const normalized = lines.map((line) => {
    const identity = parseRgdpContractIdentity(line, { measuredQuarter });
    const lastTrade = schedulePart(line.lastTradeDate);
    const resolution = schedulePart(line.expirationDate);
    const payout = schedulePart(line.payoutDate);
    const [year, quarter] = identity.measuredQuarter.split('-Q').map(Number);
    const thirdReadingMonth = new Date(Date.UTC(year, quarter * 3 + 2, 1)).toISOString().slice(0, 7);
    const expectedRelease = decidingReleaseAt ? schedulePart(decidingReleaseAt) : null;
    if (!lastTrade || !resolution || !payout
      || lastTrade.iso !== resolution.iso
      || resolution.date.slice(0, 7) !== thirdReadingMonth
      || resolution.time !== '07:30:00'
      || Date.parse(payout.iso) < Date.parse(resolution.iso)
      || (decidingReleaseAt && (!expectedRelease || resolution.iso !== expectedRelease.iso))) {
      throw identityError('RGDP trading cutoff or resolution conflicts with the published third-estimate schedule.');
    }
    return { ...line, ...identity, lastTradeDate: lastTrade.iso, expirationDate: resolution.iso, payoutDate: payout.iso };
  });
  const fingerprints = new Set(normalized.map((line) => [line.generationKey, line.lastTradeDate, line.expirationDate, line.payoutDate].join('|')));
  if (fingerprints.size !== 1 || new Set(normalized.map((line) => line.strike)).size !== normalized.length) {
    throw identityError('RGDP contracts disagree on their generation, schedule, or unique thresholds.');
  }
  const first = normalized[0];
  return {
    ...RGDP_RULES,
    generationKey: first.generationKey,
    measuredQuarter: first.measuredQuarter,
    lastTradeAt: first.lastTradeDate,
    resolutionAt: first.expirationDate,
    payoutAt: first.payoutDate,
    lines: normalized.sort((left, right) => left.strike - right.strike),
  };
}

function rgdpYesOutcome(publishedReading, threshold) {
  const value = finiteNumber(publishedReading);
  const strike = finiteNumber(threshold);
  return value == null || strike == null ? null : value > strike;
}

module.exports = { RGDP_RULES, RGDP_TERMS_URL, isOfficialRgdpTermsUrl, parseRgdpContractIdentity, rgdpYesOutcome, validateRgdpGeneration };
