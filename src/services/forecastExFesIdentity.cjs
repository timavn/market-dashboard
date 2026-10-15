const { formatInTimeZone } = require('date-fns-tz');

const FES_PRODUCT_CODE = 'FES';
const FES_TERMS_URL = 'https://data.forecastex.com/regulatory/FESTermsandConditions.pdf';
const CHICAGO_TIME_ZONE = 'America/Chicago';

const MONTHS = Object.freeze({
  JAN: { month: 1, code: 'F', bulletin: 'JAN' },
  FEB: { month: 2, code: 'G', bulletin: 'FEB' },
  MAR: { month: 3, code: 'H', bulletin: 'MAR' },
  APR: { month: 4, code: 'J', bulletin: 'APR' },
  MAY: { month: 5, code: 'K', bulletin: 'MAY' },
  JUN: { month: 6, code: 'M', bulletin: 'JUN' },
  JUL: { month: 7, code: 'N', bulletin: 'JUL' },
  AUG: { month: 8, code: 'Q', bulletin: 'AUG' },
  SEP: { month: 9, code: 'U', bulletin: 'SEP' },
  OCT: { month: 10, code: 'V', bulletin: 'OCT' },
  NOV: { month: 11, code: 'X', bulletin: 'NOV' },
  DEC: { month: 12, code: 'Z', bulletin: 'DEC' },
});

const ES_QUARTERLY_MONTHS = new Set(['MAR', 'JUN', 'SEP', 'DEC']);
const LONG_MONTHS = Object.freeze({
  JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04', MAY: '05', JUNE: '06',
  JULY: '07', AUGUST: '08', SEPTEMBER: '09', OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12',
});

function identityError(message, code = 'FORECASTEX_FES_RESOLVER_IDENTITY_INVALID') {
  return Object.assign(new Error(message), { code });
}

function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function validCalendarDate(value) {
  const match = String(value || '').match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

// A native FES ticker names the measurement event. IBKR may use that same day
// as its contract expiry or supply a later broker expiration. Neither supplies
// an exact venue resolution or payout time; those require the official schedule.
function parseFesContractIdentity(contractId, { eventDate = null, expirationDate = null } = {}) {
  const match = String(contractId || '').trim().toUpperCase()
    .match(/^FES_(\d{2})(\d{2})(\d{2})_(-?\d+(?:\.\d+)?)(?:_(YES|NO))?$/);
  if (!match) throw identityError('The native FES contract identity is invalid.');
  const measuredDate = `20${match[3]}-${match[1]}-${match[2]}`;
  if (!validCalendarDate(measuredDate)
    || (eventDate != null && eventDate !== measuredDate)
    || (expirationDate != null && (!validCalendarDate(expirationDate) || expirationDate < measuredDate))) {
    throw identityError('The FES event date or broker expiration conflicts with the native contract identity.');
  }
  return {
    productCode: FES_PRODUCT_CODE,
    eventContract: `FES_${match[1]}${match[2]}${match[3]}_${match[4]}`,
    eventDate: measuredDate,
    expirationDate,
    strike: finiteNumber(match[4]),
    contractSide: match[5] || null,
  };
}

function parseFesResolverIdentity(question, { eventDate = null, strike = null } = {}) {
  const raw = String(question || '').replace(/\s+/g, ' ').trim();
  const contract = raw.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})\s+S\s*&?\s*P\s*500\s+Index\s+Futures\b/i);
  const threshold = raw.match(/\bsettle\s+(?:above|exceed(?:ing)?)\s+\$?\s*([\d,]+(?:\.\d+)?)\b/i);
  const observedDate = raw.match(/\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!contract || !threshold || !observedDate) {
    throw identityError('The official FES question does not name one exact dated E-mini S&P 500 futures contract, threshold, and measurement date.');
  }
  const monthName = contract[1].slice(0, 3).toUpperCase();
  if (!ES_QUARTERLY_MONTHS.has(monthName)) {
    throw identityError('The official FES question names a non-quarterly ES futures month.');
  }
  const month = MONTHS[monthName];
  const year = 2000 + Number(contract[2]);
  const questionStrike = finiteNumber(threshold[1]);
  const namedDate = `${observedDate[3]}-${LONG_MONTHS[observedDate[1].toUpperCase()]}-${String(observedDate[2]).padStart(2, '0')}`;
  if (!validCalendarDate(namedDate)
    || (eventDate && namedDate !== String(eventDate).slice(0, 10))
    || (finiteNumber(strike) != null && questionStrike !== finiteNumber(strike))) {
    throw identityError('The official FES question conflicts with the contract event date or strike.');
  }
  const underlyingContractMonth = `${year}${String(month.month).padStart(2, '0')}`;
  return {
    productCode: FES_PRODUCT_CODE,
    resolverRoot: 'ES',
    resolverSymbol: `ES${month.code}${String(year).slice(-2)}`,
    underlyingContractMonth,
    resolverMonthLabel: `${monthName[0]}${monthName.slice(1).toLowerCase()}-${String(year).slice(-2)}`,
    cmeContractMonth: `${month.bulletin}${String(year).slice(-2)}`,
    questionStrike,
    questionEventDate: namedDate,
  };
}

function exactIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isOfficialFesTermsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'data.forecastex.com'
      && url.port === ''
      && url.pathname.toLowerCase() === '/regulatory/festermsandconditions.pdf'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch (_error) {
    return false;
  }
}

function centralSchedulePart(value) {
  const normalized = exactIso(value);
  if (!normalized) return null;
  const [date, time] = formatInTimeZone(new Date(normalized), CHICAGO_TIME_ZONE, 'yyyy-MM-dd|HH:mm:ss').split('|');
  return { normalized, date, time };
}

function matchesBrokerFesExpiration(eventDate, brokerExpirationDate, resolutionDate) {
  return brokerExpirationDate == null || (
    validCalendarDate(brokerExpirationDate)
    && brokerExpirationDate >= eventDate
    // The native event-day expiry is contract identity, not a claim about
    // the venue's later resolution date. A later broker date must agree.
    && (brokerExpirationDate === eventDate || brokerExpirationDate === resolutionDate)
  );
}

function matchesFesExpirationDate(identity, expirationAt) {
  const resolution = centralSchedulePart(expirationAt);
  return identity?.productCode === FES_PRODUCT_CODE
    && validCalendarDate(identity.eventDate)
    && resolution != null
    && resolution.date > identity.eventDate
    && matchesBrokerFesExpiration(identity.eventDate, identity.expirationDate, resolution.date);
}

function validateOfficialFesSchedule({ eventDate, lastTradeDate, expirationDate, payoutDate, brokerExpirationDate = null } = {}) {
  const lastTrade = centralSchedulePart(lastTradeDate);
  const resolution = centralSchedulePart(expirationDate);
  const payout = centralSchedulePart(payoutDate);
  if (!lastTrade || !resolution || !payout
    || lastTrade.date !== eventDate
    || lastTrade.time !== '15:00:00'
    || resolution.date <= eventDate
    || !matchesBrokerFesExpiration(eventDate, brokerExpirationDate, resolution.date)
    || Date.parse(lastTrade.normalized) >= Date.parse(resolution.normalized)
    || Date.parse(resolution.normalized) > Date.parse(payout.normalized)) {
    throw identityError(
      'The FES generation conflicts with the official 3:00 p.m. CT last-trade or its published chronological resolution and payout schedule.',
      'FORECASTEX_FES_GENERATION_INVALID',
    );
  }
  return {
    lastTradeDate: lastTrade.normalized,
    expirationDate: resolution.normalized,
    payoutDate: payout.normalized,
  };
}

function validateFesGeneration(lines = []) {
  if (!Array.isArray(lines) || !lines.length) {
    throw identityError('The FES generation is empty.', 'FORECASTEX_FES_GENERATION_INVALID');
  }
  const normalized = lines.map((line) => {
    if (String(line?.productId || '').toUpperCase() !== FES_PRODUCT_CODE) {
      throw identityError('The FES generation contains another product.', 'FORECASTEX_FES_GENERATION_INVALID');
    }
    const contractId = String(line.contractId || '').trim().toUpperCase();
    if (!/^FES_\d{6}_-?\d+(?:\.\d+)?$/.test(contractId)) {
      throw identityError('The FES generation contains an invalid contract identity.', 'FORECASTEX_FES_GENERATION_INVALID');
    }
    const { eventDate } = parseFesContractIdentity(contractId);
    const resolver = parseFesResolverIdentity(line.question, { eventDate, strike: line.strike });
    if (!isOfficialFesTermsUrl(line.rulesUrl || line.exchangeSpecUrl)) {
      throw identityError('The FES generation is not bound to the official FES terms.', 'FORECASTEX_FES_GENERATION_INVALID');
    }
    const schedule = validateOfficialFesSchedule({
      eventDate,
      lastTradeDate: line.lastTradeDate || line.closeAt,
      expirationDate: line.expirationDate,
      payoutDate: line.payoutDate,
    });
    const { lastTradeDate, expirationDate, payoutDate } = schedule;
    return { ...line, ...resolver, eventDate, lastTradeDate, expirationDate, payoutDate };
  });
  const contractIds = normalized.map((line) => String(line.contractId).trim().toUpperCase());
  const strikes = normalized.map((line) => String(line.questionStrike));
  if (new Set(contractIds).size !== normalized.length || new Set(strikes).size !== normalized.length) {
    throw identityError('The FES generation contains duplicate or ambiguous strikes.', 'FORECASTEX_FES_GENERATION_AMBIGUOUS');
  }
  const fingerprints = new Set(normalized.map((line) => [
    line.resolverSymbol,
    line.underlyingContractMonth,
    line.lastTradeDate,
    line.expirationDate,
    line.payoutDate,
  ].join('|')));
  if (fingerprints.size !== 1) {
    throw identityError('The FES generation contains mixed resolver months or schedules.', 'FORECASTEX_FES_GENERATION_AMBIGUOUS');
  }
  const first = normalized[0];
  return {
    generationKey: first.contractId.replace(/_(-?\d+(?:\.\d+)?)$/, ''),
    eventDate: first.eventDate,
    resolverSymbol: first.resolverSymbol,
    underlyingContractMonth: first.underlyingContractMonth,
    resolverMonthLabel: first.resolverMonthLabel,
    cmeContractMonth: first.cmeContractMonth,
    rulesUrl: FES_TERMS_URL,
    lastTradeAt: first.lastTradeDate,
    resolutionAt: first.expirationDate,
    payoutAt: first.payoutDate,
    lines: normalized,
  };
}

function buildExactEsFutureInstrument(identity = {}) {
  const symbol = String(identity.resolverSymbol || '').trim().toUpperCase();
  const contractMonth = String(identity.underlyingContractMonth || '').trim();
  const symbolMatch = symbol.match(/^ES([HMUZ])(\d{2})$/);
  const monthByCode = { H: '03', M: '06', U: '09', Z: '12' };
  if (!symbolMatch || !/^20\d{4}$/.test(contractMonth)
    || contractMonth.slice(2, 4) !== symbolMatch[2]
    || contractMonth.slice(4, 6) !== monthByCode[symbolMatch[1]]) return null;
  return {
    symbol: 'ES',
    displaySymbol: symbol,
    ibkrSymbol: 'ES',
    secType: 'FUT',
    exchange: 'CME',
    currency: 'USD',
    lastTradeDateOrContractMonth: contractMonth,
    tradingClass: 'ES',
    multiplier: '50',
    provider: 'ibkr',
  };
}

module.exports = {
  ES_QUARTERLY_MONTHS,
  FES_PRODUCT_CODE,
  FES_TERMS_URL,
  MONTHS,
  buildExactEsFutureInstrument,
  isOfficialFesTermsUrl,
  parseFesContractIdentity,
  matchesFesExpirationDate,
  parseFesResolverIdentity,
  validateFesGeneration,
  validateOfficialFesSchedule,
};
