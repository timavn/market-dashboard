const GEOGRAPHY_MODEL_VERSION = 'exposure-lab-geography-v1';
const GEOGRAPHY_CONTROL_SYMBOL = 'ACWI';
const GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS = 120;

const GEOGRAPHY_PROXIES = Object.freeze([
  Object.freeze({ id: 'geo-us', label: 'US', symbol: 'SPY' }),
  Object.freeze({ id: 'geo-canada', label: 'Canada', symbol: 'EWC' }),
  Object.freeze({ id: 'geo-europe', label: 'Europe', symbol: 'VGK' }),
  Object.freeze({ id: 'geo-japan', label: 'Japan', symbol: 'EWJ' }),
  Object.freeze({ id: 'geo-asia-ex-japan', label: 'Asia ex-Japan', symbol: 'AAXJ' }),
  Object.freeze({ id: 'geo-china', label: 'China', symbol: 'MCHI' }),
  Object.freeze({ id: 'geo-india', label: 'India', symbol: 'INDA' }),
  Object.freeze({ id: 'geo-latam', label: 'Latin America', symbol: 'ILF' }),
  Object.freeze({ id: 'geo-em', label: 'Broad EM', symbol: 'EEM' }),
]);

const REGION_ORDER = Object.freeze([
  'North America',
  'Latin America & Caribbean',
  'Europe',
  'Asia Pacific',
  'Middle East & Africa',
  'Other',
  'Unknown',
]);

const REGION_COUNTRY_CODES = Object.freeze({
  'North America': Object.freeze(['BM', 'CA', 'GL', 'PM', 'US']),
  'Latin America & Caribbean': Object.freeze([
    'AG', 'AI', 'AR', 'AW', 'BB', 'BL', 'BO', 'BQ', 'BR', 'BS', 'BZ', 'CL',
    'CO', 'CR', 'CU', 'CW', 'DM', 'DO', 'EC', 'FK', 'GD', 'GF', 'GP', 'GT',
    'GY', 'HN', 'HT', 'JM', 'KN', 'KY', 'LC', 'MF', 'MQ', 'MS', 'MX', 'NI',
    'PA', 'PE', 'PR', 'PY', 'SR', 'SV', 'SX', 'TC', 'TT', 'UY', 'VC', 'VE',
    'VG', 'VI',
  ]),
  Europe: Object.freeze([
    'AD', 'AL', 'AT', 'AX', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE',
    'DK', 'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GG', 'GI', 'GR', 'HR', 'HU',
    'IE', 'IM', 'IS', 'IT', 'JE', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME',
    'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SJ',
    'SK', 'SM', 'UA', 'VA',
  ]),
  'Asia Pacific': Object.freeze([
    'AF', 'AS', 'AU', 'BD', 'BN', 'BT', 'CC', 'CK', 'CN', 'CX', 'FJ', 'FM',
    'GU', 'HK', 'ID', 'IN', 'IO', 'JP', 'KG', 'KH', 'KI', 'KP', 'KR', 'KZ',
    'LA', 'LK', 'MH', 'MM', 'MN', 'MO', 'MP', 'MV', 'MY', 'NC', 'NF', 'NP',
    'NR', 'NU', 'NZ', 'PF', 'PG', 'PH', 'PK', 'PN', 'PW', 'SB', 'SG', 'TH',
    'TJ', 'TK', 'TL', 'TM', 'TO', 'TV', 'TW', 'UM', 'UZ', 'VN', 'VU', 'WF',
    'WS',
  ]),
  'Middle East & Africa': Object.freeze([
    'AE', 'AM', 'AO', 'AZ', 'BF', 'BH', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG',
    'CI', 'CM', 'CV', 'DJ', 'DZ', 'EG', 'ER', 'ET', 'GA', 'GE', 'GH', 'GM',
    'GN', 'GQ', 'GW', 'IL', 'IQ', 'IR', 'JO', 'KE', 'KM', 'KW', 'LB', 'LR',
    'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG',
    'OM', 'PS', 'QA', 'RE', 'RW', 'SA', 'SC', 'SD', 'SH', 'SL', 'SN', 'SO',
    'SS', 'ST', 'SY', 'SZ', 'TD', 'TG', 'TN', 'TR', 'TZ', 'UG', 'EH', 'YE',
    'YT', 'ZA', 'ZM', 'ZW',
  ]),
  Other: Object.freeze(['AQ', 'BV', 'GS', 'HM', 'TF']),
});

const COUNTRY_TO_REGION = Object.freeze(Object.fromEntries(
  Object.entries(REGION_COUNTRY_CODES)
    .flatMap(([region, codes]) => codes.map((code) => [code, region])),
));
const SUPPORTED_COUNTRY_CODES = Object.freeze(Object.keys(COUNTRY_TO_REGION).sort());

function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return COUNTRY_TO_REGION[code] ? code : null;
}

function countryRegion(value) {
  const code = normalizeCountryCode(value);
  return code ? COUNTRY_TO_REGION[code] : 'Unknown';
}

function countryName(value) {
  const code = normalizeCountryCode(value);
  if (!code) return 'Unknown';
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const label = displayNames.of(code);
    return label && label !== code ? label : code;
  } catch (_error) {
    return code;
  }
}

function getExposureLabGeographyHistorySymbols() {
  return [
    GEOGRAPHY_CONTROL_SYMBOL,
    ...GEOGRAPHY_PROXIES.map((proxy) => proxy.symbol),
  ];
}

module.exports = {
  COUNTRY_TO_REGION,
  GEOGRAPHY_CONTROL_SYMBOL,
  GEOGRAPHY_HOLDINGS_MAX_AGE_DAYS,
  GEOGRAPHY_MODEL_VERSION,
  GEOGRAPHY_PROXIES,
  REGION_COUNTRY_CODES,
  REGION_ORDER,
  SUPPORTED_COUNTRY_CODES,
  countryName,
  countryRegion,
  getExposureLabGeographyHistorySymbols,
  normalizeCountryCode,
};
