const PRODUCT_IDENTITIES = Object.freeze({
  METLG: Object.freeze({
    assetPattern: '(?:COMEX\\s+)?(?:GOLD|GC)',
    root: 'GC',
    exchange: 'COMEX',
    tradingClass: 'GC',
    multiplier: '100',
  }),
  METLS: Object.freeze({
    assetPattern: '(?:COMEX\\s+)?(?:SILVER|SI)',
    root: 'SI',
    exchange: 'COMEX',
    tradingClass: 'SI',
    multiplier: '5000',
  }),
  COMCO: Object.freeze({
    assetPattern: '(?:(?:ICE|NYMEX|CME)\\s+)?(?:WTI|CRUDE\\s+OIL|WBS|CL)',
    root: 'WTI',
    exchange: 'IPE',
    tradingClass: 'WBS',
    multiplier: '1000',
  }),
});

const MONTHS = Object.freeze({
  JAN: [1, 'F', 'January'], JANUARY: [1, 'F', 'January'],
  FEB: [2, 'G', 'February'], FEBRUARY: [2, 'G', 'February'],
  MAR: [3, 'H', 'March'], MARCH: [3, 'H', 'March'],
  APR: [4, 'J', 'April'], APRIL: [4, 'J', 'April'],
  MAY: [5, 'K', 'May'],
  JUN: [6, 'M', 'June'], JUNE: [6, 'M', 'June'],
  JUL: [7, 'N', 'July'], JULY: [7, 'N', 'July'],
  AUG: [8, 'Q', 'August'], AUGUST: [8, 'Q', 'August'],
  SEP: [9, 'U', 'September'], SEPT: [9, 'U', 'September'], SEPTEMBER: [9, 'U', 'September'],
  OCT: [10, 'V', 'October'], OCTOBER: [10, 'V', 'October'],
  NOV: [11, 'X', 'November'], NOVEMBER: [11, 'X', 'November'],
  DEC: [12, 'Z', 'December'], DECEMBER: [12, 'Z', 'December'],
});

const MONTH_PATTERN = Object.keys(MONTHS).sort((left, right) => right.length - left.length).join('|');

function identityError(message) {
  return Object.assign(new Error(message), { code: 'FORECASTEX_COMMODITY_IDENTITY_INVALID' });
}

function officialTermsUrl(value, productCode) {
  try {
    const url = new URL(String(value || ''));
    return /(^|\.)forecastex\.com$/i.test(url.hostname)
      && new RegExp(productCode, 'i').test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function normalizedYear(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  const year = String(value).length === 2 ? 2000 + number : number;
  return year >= 2020 && year <= 2099 ? year : null;
}

function monthIdentity(token, yearToken) {
  const month = MONTHS[String(token || '').toUpperCase()];
  const year = normalizedYear(yearToken);
  if (!month || !year) return null;
  return {
    month: month[0],
    monthCode: month[1],
    monthName: month[2],
    year,
  };
}

function parseForecastCommodityQuestion(question, { productCode } = {}) {
  const product = PRODUCT_IDENTITIES[String(productCode || '').toUpperCase()];
  const text = String(question || '').replace(/\s+/g, ' ').trim();
  if (!product || !text || !new RegExp(product.assetPattern, 'i').test(text)) return null;
  const patterns = [
    new RegExp(`\\b(${MONTH_PATTERN})[\\s-]*(20\\d{2}|\\d{2})\\b(?=[^?]{0,45}\\b(?:contract|future|futures|settlement|settle)\\b)`, 'i'),
    new RegExp(`\\b(?:contract|future|futures)\\b[^?]{0,35}\\b(${MONTH_PATTERN})[\\s-]*(20\\d{2}|\\d{2})\\b`, 'i'),
    new RegExp(`\\b${product.root}([FGHJKMNQUVXZ])(\\d{1,2})\\b`, 'i'),
  ];
  let month = null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    if (/^[FGHJKMNQUVXZ]$/i.test(match[1])) {
      const monthEntry = Object.values(MONTHS).find((entry) => entry[1] === match[1].toUpperCase());
      const year = normalizedYear(match[2]);
      if (monthEntry && year) month = { month: monthEntry[0], monthCode: monthEntry[1], monthName: monthEntry[2], year };
    } else {
      month = monthIdentity(match[1], match[2]);
    }
    if (month) break;
  }
  if (!month) return null;
  const root = String(productCode).toUpperCase() === 'COMCO' && /\b(?:NYMEX|CME|CL[FGHJKMNQUVXZ]\d{1,2})\b/i.test(text)
    ? 'CL'
    : product.root;
  const exchange = root === 'CL' ? 'NYMEX' : product.exchange;
  const tradingClass = root === 'CL' ? 'CL' : product.tradingClass;
  const contractMonth = `${month.year}${String(month.month).padStart(2, '0')}`;
  return {
    resolverSymbol: `${root}${month.monthCode}${String(month.year).slice(-2)}`,
    underlyingContractMonth: contractMonth,
    resolverMonthLabel: `${month.monthName} ${month.year}`,
    instrument: {
      symbol: root,
      displaySymbol: `${root}${month.monthCode}${String(month.year).slice(-2)}`,
      ibkrSymbol: root,
      secType: 'FUT',
      exchange,
      currency: 'USD',
      lastTradeDateOrContractMonth: contractMonth,
      tradingClass,
      multiplier: product.multiplier,
      provider: 'ibkr',
    },
  };
}

function validateForecastCommodityGeneration(lines = [], productCode) {
  const normalizedProduct = String(productCode || '').toUpperCase();
  if (!PRODUCT_IDENTITIES[normalizedProduct] || !Array.isArray(lines) || !lines.length) {
    throw identityError('A supported ForecastEx commodity generation is required.');
  }
  const identities = lines.map((line) => {
    if (String(line?.productId || '').toUpperCase() !== normalizedProduct
      || !officialTermsUrl(line?.rulesUrl, normalizedProduct)) {
      throw identityError('ForecastEx commodity terms are missing or unverified.');
    }
    const identity = parseForecastCommodityQuestion(line?.question, { productCode: normalizedProduct });
    if (!identity) throw identityError('The dated commodity resolver was not explicit in the ForecastEx question.');
    return identity;
  });
  const signature = JSON.stringify(identities[0]);
  if (identities.some((identity) => JSON.stringify(identity) !== signature)) {
    throw identityError('ForecastEx commodity strikes disagree on the resolver contract.');
  }
  const schedule = (field) => [...new Set(lines.map((line) => String(line?.[field] || '')))].filter(Boolean);
  const expiration = schedule('expirationDate');
  const payout = schedule('payoutDate');
  if (expiration.length > 1 || payout.length > 1) {
    throw identityError('ForecastEx commodity strikes disagree on the resolution schedule.');
  }
  return {
    ...identities[0],
    resolutionAt: expiration[0] || null,
    payoutAt: payout[0] || null,
  };
}

function buildExactForecastCommodityInstrument(identity = {}) {
  const instrument = identity?.instrument;
  const expectedMonth = String(identity?.underlyingContractMonth || '');
  if (!instrument || !/^20\d{4}$/.test(expectedMonth)
    || instrument.lastTradeDateOrContractMonth !== expectedMonth
    || String(instrument.displaySymbol || '') !== String(identity?.resolverSymbol || '')) return null;
  return { ...instrument };
}

module.exports = {
  PRODUCT_IDENTITIES,
  buildExactForecastCommodityInstrument,
  parseForecastCommodityQuestion,
  validateForecastCommodityGeneration,
};
