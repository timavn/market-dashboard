const MONTHS = Object.freeze({
  JAN: { month: '01', code: 'F', label: 'Jan' },
  FEB: { month: '02', code: 'G', label: 'Feb' },
  MAR: { month: '03', code: 'H', label: 'Mar' },
  APR: { month: '04', code: 'J', label: 'Apr' },
  MAY: { month: '05', code: 'K', label: 'May' },
  JUN: { month: '06', code: 'M', label: 'Jun' },
  JUL: { month: '07', code: 'N', label: 'Jul' },
  AUG: { month: '08', code: 'Q', label: 'Aug' },
  SEP: { month: '09', code: 'U', label: 'Sep' },
  OCT: { month: '10', code: 'V', label: 'Oct' },
  NOV: { month: '11', code: 'X', label: 'Nov' },
  DEC: { month: '12', code: 'Z', label: 'Dec' },
});

const LONG_MONTHS = Object.freeze({
  JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04', MAY: '05', JUNE: '06',
  JULY: '07', AUGUST: '08', SEPTEMBER: '09', OCTOBER: '10', NOVEMBER: '11', DECEMBER: '12',
});

const QUARTERLY_MONTHS = new Set(['MAR', 'JUN', 'SEP', 'DEC']);

function identityError(message) {
  return Object.assign(new Error(message), { code: 'FORECASTEX_FNQ_IDENTITY_INVALID' });
}

function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isOfficialFnqTermsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'data.forecastex.com'
      && url.pathname.toLowerCase() === '/regulatory/fnqtermsandconditions.pdf'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash;
  } catch (_error) {
    return false;
  }
}

function validDate(value) {
  const match = String(value || '').match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString().slice(0, 10) === value;
}

function parseFnqResolverIdentity(question, { eventDate = null, strike = null } = {}) {
  const text = String(question || '').replace(/\s+/g, ' ').trim();
  const contract = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})\s+Nasdaq-?100\s+Index\s+Futures\b/i);
  const threshold = text.match(/\b(?:settle\s+above|exceed(?:ing)?)\s+\$?\s*([\d,]+(?:\.\d+)?)\b/i);
  const observedDate = text.match(/\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!contract || !threshold || !observedDate) {
    throw identityError('The official FNQ question does not name one exact dated Nasdaq-100 future, threshold, and measurement date.');
  }
  const monthKey = contract[1].slice(0, 3).toUpperCase();
  if (!QUARTERLY_MONTHS.has(monthKey)) {
    throw identityError('The official FNQ question names a non-quarterly NQ futures month.');
  }
  const month = MONTHS[monthKey];
  const year = 2000 + Number(contract[2]);
  const questionStrike = finiteNumber(threshold[1]);
  const questionDate = `${observedDate[3]}-${LONG_MONTHS[observedDate[1].toUpperCase()]}-${String(observedDate[2]).padStart(2, '0')}`;
  if (!validDate(questionDate)
    || (eventDate && questionDate !== String(eventDate).slice(0, 10))
    || (finiteNumber(strike) != null && finiteNumber(strike) !== questionStrike)) {
    throw identityError('The official FNQ question conflicts with the generation date or strike.');
  }
  const underlyingContractMonth = `${year}${month.month}`;
  const resolverSymbol = `NQ${month.code}${String(year).slice(-2)}`;
  return {
    productCode: 'FNQ',
    resolverSymbol,
    underlyingContractMonth,
    resolverMonthLabel: `${month.label}-${String(year).slice(-2)}`,
    questionStrike,
    questionEventDate: questionDate,
    instrument: {
      symbol: 'NQ',
      displaySymbol: resolverSymbol,
      ibkrSymbol: 'NQ',
      secType: 'FUT',
      exchange: 'CME',
      currency: 'USD',
      lastTradeDateOrContractMonth: underlyingContractMonth,
      tradingClass: 'NQ',
      multiplier: '20',
      provider: 'ibkr',
    },
  };
}

function validateFnqGeneration(lines = []) {
  if (!Array.isArray(lines) || !lines.length) throw identityError('An FNQ generation is required.');
  const identities = lines.map((line) => {
    const contractId = String(line?.contractId || '').trim().toUpperCase();
    const match = contractId.match(/^FNQ_(\d{2})(\d{2})(\d{2})_(-?\d+(?:\.\d+)?)$/);
    if (String(line?.productId || '').toUpperCase() !== 'FNQ' || !match) {
      throw identityError('The FNQ generation contains another product or an invalid contract id.');
    }
    if (!isOfficialFnqTermsUrl(line.rulesUrl || line.exchangeSpecUrl)) {
      throw identityError('The FNQ generation is not bound to the official ForecastEx terms.');
    }
    const eventDate = `20${match[3]}-${match[1]}-${match[2]}`;
    return {
      ...parseFnqResolverIdentity(line.question, { eventDate, strike: line.strike }),
      eventDate,
    };
  });
  const signatures = new Set(identities.map((identity) => [
    identity.resolverSymbol,
    identity.underlyingContractMonth,
    identity.questionEventDate,
  ].join('|')));
  const strikes = identities.map((identity) => String(identity.questionStrike));
  if (signatures.size !== 1 || new Set(strikes).size !== strikes.length) {
    throw identityError('The FNQ generation contains mixed resolver months or duplicate strikes.');
  }
  const first = identities[0];
  return {
    eventDate: first.eventDate,
    resolverSymbol: first.resolverSymbol,
    underlyingContractMonth: first.underlyingContractMonth,
    resolverMonthLabel: first.resolverMonthLabel,
    instrument: first.instrument,
  };
}

module.exports = {
  isOfficialFnqTermsUrl,
  parseFnqResolverIdentity,
  validateFnqGeneration,
};
