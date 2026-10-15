import { SECURITY_CATEGORY_MAPPING } from './securityCategoryMapping';
import { SECURITIES_LIST } from './securitiesList';
import { QUAD_EXPOSURE_REVIEW, QUAD_EXPOSURE_REVIEW_DATE } from './quadExposureReview';

export const EXPOSURE_CLASSIFICATION_VERSION = '2026-09-07';

export const EXPOSURE_DIMENSIONS = Object.freeze({
  assetClasses: Object.freeze({ id: 'asset-classes', label: 'Asset Classes' }),
  equitySectors: Object.freeze({ id: 'equity-sectors', label: 'Equity Sectors' }),
  equityStyleFactors: Object.freeze({ id: 'equity-style-factors', label: 'Equity Style Factors' }),
  fixedIncomeSectors: Object.freeze({ id: 'fixed-income-sectors', label: 'Fixed Income Sectors' }),
});

// This is the canonical structured form of the four best/worst lists displayed
// in expectedValuesData. Keep labels and order identical to that source.
export const QUAD_PLAYBOOK = Object.freeze({
  q1: Object.freeze({
    quad: 'Quad 1: Goldilocks',
    assetClasses: Object.freeze({
      best: Object.freeze(['Equities', 'Credit', 'Commodities', 'FX']),
      worst: Object.freeze(['Fixed Income', 'USD']),
    }),
    equitySectors: Object.freeze({
      best: Object.freeze(['Tech', 'Consumer Discretionary', 'Communication Services', 'Industrials', 'Materials', 'REITS']),
      worst: Object.freeze(['Utilities', 'Consumer Staples', 'Health Care']),
    }),
    equityStyleFactors: Object.freeze({
      best: Object.freeze(['High Beta', 'Momentum', 'Leverage', 'Secular Growth', 'Mid Caps']),
      worst: Object.freeze(['Low Beta', 'Defensives', 'Value', 'Dividend Yield', 'Small Caps']),
    }),
    fixedIncomeSectors: Object.freeze({
      best: Object.freeze(['BDCs', 'Convertibles', 'HY Credit', 'EM $ Debt', 'Leveraged Loans']),
      worst: Object.freeze(['TIPS', 'Short Duration Treasurys', 'MBS', 'Treasury Belly', 'Long Bond']),
    }),
  }),
  q2: Object.freeze({
    quad: 'Quad 2: Reflation',
    assetClasses: Object.freeze({
      best: Object.freeze(['Commodities', 'Equities', 'Credit', 'FX']),
      worst: Object.freeze(['Fixed Income', 'USD']),
    }),
    equitySectors: Object.freeze({
      best: Object.freeze(['Tech', 'Industrials', 'Financials', 'Energy', 'Consumer Discretionary']),
      worst: Object.freeze(['Utilities', 'Communication Services', 'Consumer Staples', 'REITS', 'Health Care']),
    }),
    equityStyleFactors: Object.freeze({
      best: Object.freeze(['Secular Growth', 'High Beta', 'Small Caps', 'Cyclical Growth', 'Momentum']),
      worst: Object.freeze(['Low Beta', 'Dividend Yield', 'Value', 'Defensives', 'Size']),
    }),
    fixedIncomeSectors: Object.freeze({
      best: Object.freeze(['Convertibles', 'BDCs', 'Preferreds', 'Leveraged Loans', 'HY Credit']),
      worst: Object.freeze(['Long Bond', 'Treasury Belly', 'Munis', 'MBS', 'IG Credit']),
    }),
  }),
  q3: Object.freeze({
    quad: 'Quad 3: Stagflation',
    assetClasses: Object.freeze({
      best: Object.freeze(['Gold', 'Commodities', 'Fixed Income']),
      worst: Object.freeze(['Credit']),
    }),
    equitySectors: Object.freeze({
      best: Object.freeze(['Utilities', 'Energy', 'REITS', 'Tech', 'Consumer Staples', 'Health Care']),
      worst: Object.freeze(['Communication Services', 'Financials', 'Consumer Discretionary', 'Industrials', 'Materials']),
    }),
    equityStyleFactors: Object.freeze({
      best: Object.freeze(['Secular Growth', 'Momentum', 'Mid Caps', 'Low Beta', 'Quality']),
      worst: Object.freeze(['Small Caps', 'Dividend Yield', 'Value', 'Defensives', 'Size']),
    }),
    fixedIncomeSectors: Object.freeze({
      best: Object.freeze(['Munis', 'EM $ Debt', 'Long Bond', 'TIPS', 'Treasury Belly']),
      worst: Object.freeze(['BDCs', 'Preferreds', 'Convertibles', 'Leveraged Loans', 'HY Credit']),
    }),
  }),
  q4: Object.freeze({
    quad: 'Quad 4: Deflation',
    assetClasses: Object.freeze({
      best: Object.freeze(['Fixed Income', 'Gold', 'USD']),
      worst: Object.freeze(['Commodities', 'Equities', 'Credit', 'FX']),
    }),
    equitySectors: Object.freeze({
      best: Object.freeze(['Consumer Staples', 'Health Care', 'Utilities']),
      worst: Object.freeze(['Energy', 'Tech', 'Financials', 'Industrials', 'Consumer Discretionary']),
    }),
    equityStyleFactors: Object.freeze({
      best: Object.freeze(['Low Beta', 'Dividend Yield', 'Quality', 'Defensives', 'Value']),
      worst: Object.freeze(['High Beta', 'Momentum', 'Leverage', 'Secular Growth', 'Cyclical Growth']),
    }),
    fixedIncomeSectors: Object.freeze({
      best: Object.freeze(['Long Bond', 'Treasury Belly', 'IG Credit', 'Munis', 'MBS']),
      worst: Object.freeze(['Preferreds', 'EM Local Currency', 'BDCs', 'Leveraged Loans', 'TIPS']),
    }),
  }),
});

const DIMENSION_ID_PREFIX = Object.freeze({
  assetClasses: 'asset-class',
  equitySectors: 'equity-sector',
  equityStyleFactors: 'equity-style-factor',
  fixedIncomeSectors: 'fixed-income-sector',
});

const EXTRA_EXPOSURES = Object.freeze([
  Object.freeze({ dimension: 'assetClasses', label: 'Cash' }),
  Object.freeze({ dimension: 'assetClasses', label: 'Cryptocurrency' }),
  Object.freeze({ dimension: 'assetClasses', label: 'Managed Futures' }),
]);

const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\$/g, ' usd ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const exposureIdFor = (dimension, label) => `${DIMENSION_ID_PREFIX[dimension]}-${slugify(label)}`;

const buildExposureSeeds = () => {
  const seeds = [];
  const seen = new Set();

  Object.values(QUAD_PLAYBOOK).forEach((quad) => {
    Object.keys(EXPOSURE_DIMENSIONS).forEach((dimension) => {
      [...quad[dimension].best, ...quad[dimension].worst].forEach((label) => {
        const id = exposureIdFor(dimension, label);
        if (!seen.has(id)) {
          seen.add(id);
          seeds.push({ id, label, dimension });
        }
      });
    });
  });

  EXTRA_EXPOSURES.forEach(({ dimension, label }) => {
    const id = exposureIdFor(dimension, label);
    if (!seen.has(id)) {
      seen.add(id);
      seeds.push({ id, label, dimension });
    }
  });

  return seeds;
};

const fitFor = (label, dimension, quadKey) => {
  const lists = QUAD_PLAYBOOK[quadKey][dimension];
  const bestIndex = lists.best.indexOf(label);
  if (bestIndex >= 0) return Object.freeze({ status: 'best', rank: bestIndex + 1 });

  const worstIndex = lists.worst.indexOf(label);
  if (worstIndex >= 0) return Object.freeze({ status: 'worst', rank: worstIndex + 1 });

  return Object.freeze({ status: 'not-listed', rank: null });
};

const exposureDefinitions = buildExposureSeeds().reduce((catalog, seed) => {
  const quadFits = Object.keys(QUAD_PLAYBOOK).reduce((fits, quadKey) => {
    fits[quadKey] = fitFor(seed.label, seed.dimension, quadKey);
    return fits;
  }, {});

  catalog[seed.id] = Object.freeze({
    ...seed,
    quadFits: Object.freeze(quadFits),
  });
  return catalog;
}, {});

export const EXPOSURE_DEFINITIONS = Object.freeze(exposureDefinitions);
export const EXPOSURE_LIST = Object.freeze(Object.values(EXPOSURE_DEFINITIONS));
// The +EV table may show only labels that appear in a stored Hedgeye worksheet
// best/worst list. Other classifications remain available to describe holdings.
export const HEDGEYE_EXPOSURE_LIST = Object.freeze(EXPOSURE_LIST.filter(exposure => (
  Object.values(exposure.quadFits).some(fit => fit.status !== 'not-listed')
)));

const normalizeLookupValue = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\$/g, ' usd ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '');

const DIMENSION_ALIASES = Object.freeze({
  assetclasses: 'assetClasses',
  assetclass: 'assetClasses',
  equitysectors: 'equitySectors',
  equitysector: 'equitySectors',
  equitystylefactors: 'equityStyleFactors',
  equitystylefactor: 'equityStyleFactors',
  stylefactors: 'equityStyleFactors',
  stylefactor: 'equityStyleFactors',
  fixedincomesectors: 'fixedIncomeSectors',
  fixedincomesector: 'fixedIncomeSectors',
});

const normalizeDimensionKey = (value) => {
  if (Object.prototype.hasOwnProperty.call(EXPOSURE_DIMENSIONS, value)) return value;
  return DIMENSION_ALIASES[normalizeLookupValue(value)] || null;
};

const exposureLookup = EXPOSURE_LIST.reduce((lookup, definition) => {
  const keys = [
    definition.id,
    definition.label,
    definition.label === 'REITS' ? 'REITs' : null,
    definition.label === 'EM $ Debt' ? 'EM USD Debt' : null,
    definition.label === 'EM Local Currency' ? 'EM Local Currency Debt' : null,
  ].filter(Boolean);

  keys.forEach((key) => {
    const normalized = normalizeLookupValue(key);
    if (!lookup[normalized]) lookup[normalized] = [];
    lookup[normalized].push(definition);
  });
  return lookup;
}, {});

export const normalizeQuadKey = (value) => {
  if (Number.isInteger(value) && value >= 1 && value <= 4) return `q${value}`;

  const raw = typeof value === 'object' && value !== null
    ? value.quadKey ?? value.quad ?? value.id ?? value.key
    : value;
  const normalized = String(raw || '').trim().toLowerCase();
  if (/^[1-4]$/.test(normalized)) return `q${normalized}`;

  const match = normalized.match(/^(?:quad\s*|q\s*)([1-4])(?:\b|:)/);
  return match ? `q${match[1]}` : null;
};

export const normalizeQuad = normalizeQuadKey;

export const getExposureDefinition = (value, dimension) => {
  if (!value) return null;
  const candidate = typeof value === 'object' ? value.id ?? value.label : value;
  const requestedDimension = normalizeDimensionKey(
    dimension ?? (typeof value === 'object' ? value.dimension : null),
  );

  if (typeof candidate === 'string' && EXPOSURE_DEFINITIONS[candidate]) {
    const direct = EXPOSURE_DEFINITIONS[candidate];
    return requestedDimension && direct.dimension !== requestedDimension ? null : direct;
  }

  const matches = exposureLookup[normalizeLookupValue(candidate)] || [];
  if (requestedDimension) {
    return matches.find((definition) => definition.dimension === requestedDimension) || null;
  }
  return matches.length === 1 ? matches[0] : null;
};

export const resolveExposure = getExposureDefinition;

export const getExposureQuadFit = (exposure, quad, dimension) => {
  const definition = getExposureDefinition(exposure, dimension);
  const quadKey = normalizeQuadKey(quad);
  if (!definition || !quadKey) return null;
  return definition.quadFits[quadKey];
};

export const getExposureFit = getExposureQuadFit;

const requiredExposureId = (dimension, label) => {
  const definition = getExposureDefinition(label, dimension);
  if (!definition) {
    throw new Error(`Unknown +EV exposure configuration: ${dimension}/${label}`);
  }
  return definition.id;
};

const normalizeSymbol = (value) => String(value || '').trim().toUpperCase();
const normalizeConid = (value) => String(value ?? '').trim();

const makeReviewedProfile = (symbol, primary, secondary = []) => {
  const primaryExposureId = requiredExposureId(primary[0], primary[1]);
  const secondaryExposureIds = [...new Set(
    secondary.map(([dimension, label]) => requiredExposureId(dimension, label)),
  )].filter((id) => id !== primaryExposureId);

  return Object.freeze({
    symbol: normalizeSymbol(symbol),
    primaryExposureId,
    secondaryExposureIds: Object.freeze(secondaryExposureIds),
    classificationStatus: 'reviewed',
    classificationSource: 'curated',
    classificationVersion: EXPOSURE_CLASSIFICATION_VERSION,
  });
};

const makeUnclassifiedProfile = (symbol) => Object.freeze({
  symbol: normalizeSymbol(symbol),
  primaryExposureId: null,
  secondaryExposureIds: Object.freeze([]),
  classificationStatus: 'unclassified',
  classificationSource: 'unmapped',
  classificationVersion: EXPOSURE_CLASSIFICATION_VERSION,
});

const CREDIT_SECTOR_LABELS = new Set([
  'BDCs',
  'Convertibles',
  'EM $ Debt',
  'HY Credit',
  'IG Credit',
  'Leveraged Loans',
  'Preferreds',
]);

const profileFromSecurityMapping = (security) => {
  const symbol = normalizeSymbol(security?.ticker);
  const mapping = SECURITY_CATEGORY_MAPPING[symbol];
  if (!mapping || !getExposureDefinition(mapping.category, mapping.type)) {
    return makeUnclassifiedProfile(symbol);
  }

  const secondary = [];
  if (mapping.type === 'equitySectors' || mapping.type === 'equityStyleFactors') {
    secondary.push(['assetClasses', 'Equities']);
  }
  if (mapping.type === 'fixedIncomeSectors') {
    secondary.push(['assetClasses', 'Fixed Income']);
    if (CREDIT_SECTOR_LABELS.has(mapping.category)) {
      secondary.push(['assetClasses', 'Credit']);
    }
  }

  return makeReviewedProfile(symbol, [mapping.type, mapping.category], secondary);
};

// High-signal overlap lenses for the static 119-security dashboard universe.
const UNIVERSE_PROFILE_OVERRIDES = Object.freeze({
  AAAU: makeReviewedProfile('AAAU', ['assetClasses', 'Gold']),
  GLD: makeReviewedProfile('GLD', ['assetClasses', 'Gold']),
  GOLD: makeReviewedProfile('GOLD', ['assetClasses', 'Gold']),
  GDX: makeReviewedProfile('GDX', ['equitySectors', 'Materials'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Gold'],
  ]),
  IWM: makeReviewedProfile('IWM', ['assetClasses', 'Equities'], [
    ['equityStyleFactors', 'Small Caps'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  MLPX: makeReviewedProfile('MLPX', ['equitySectors', 'Energy'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Commodities'],
  ]),
  MTUM: makeReviewedProfile('MTUM', ['equityStyleFactors', 'Momentum'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  QQQ: makeReviewedProfile('QQQ', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
    ['equityStyleFactors', 'High Beta'],
    ['equityStyleFactors', 'Momentum'],
  ]),
  RSP: makeReviewedProfile('RSP', ['assetClasses', 'Equities'], [
    ['equityStyleFactors', 'Value'],
    ['equityStyleFactors', 'Size'],
  ]),
  RUT: makeReviewedProfile('RUT', ['assetClasses', 'Equities'], [
    ['equityStyleFactors', 'Small Caps'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  URA: makeReviewedProfile('URA', ['equitySectors', 'Energy'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Commodities'],
  ]),
  USD: makeReviewedProfile('USD', ['assetClasses', 'USD'], [
    ['assetClasses', 'FX'],
  ]),
  'USD/YEN': makeReviewedProfile('USD/YEN', ['assetClasses', 'FX'], [
    ['assetClasses', 'USD'],
  ]),
  USMV: makeReviewedProfile('USMV', ['equityStyleFactors', 'Low Beta'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Defensives'],
    ['equityStyleFactors', 'Quality'],
  ]),
  UUP: makeReviewedProfile('UUP', ['assetClasses', 'USD'], [
    ['assetClasses', 'FX'],
  ]),
  VYMI: makeReviewedProfile('VYMI', ['equityStyleFactors', 'Dividend Yield'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Value'],
  ]),
  XME: makeReviewedProfile('XME', ['equitySectors', 'Materials'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Commodities'],
    ['assetClasses', 'Gold'],
  ]),
  XOP: makeReviewedProfile('XOP', ['equitySectors', 'Energy'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Commodities'],
  ]),
  BLOK: makeReviewedProfile('BLOK', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  BMNR: makeReviewedProfile('BMNR', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  COIN: makeReviewedProfile('COIN', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equitySectors', 'Tech'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  CRCL: makeReviewedProfile('CRCL', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  MARA: makeReviewedProfile('MARA', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  MSTR: makeReviewedProfile('MSTR', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  RIOT: makeReviewedProfile('RIOT', ['assetClasses', 'Cryptocurrency'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
  ]),
});

// Explicit review set for the 49-symbol live book observed on 2026-07-26.
export const LIVE_BOOK_SECURITY_PROFILES = Object.freeze({
  FAB: makeReviewedProfile('FAB', ['equityStyleFactors', 'Value'], [
    ['assetClasses', 'Equities'],
  ]),
  // Country-fund sector tags below are Boolean material-overlap lenses,
  // reviewed against issuer holdings as of 2026-07-26; they are not
  // proportional look-through weights and should be reviewed quarterly.
  QAT: makeReviewedProfile('QAT', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Financials'],
  ]),
  URI: makeReviewedProfile('URI', ['equitySectors', 'Industrials'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Cyclical Growth'],
  ]),
  VOOG: makeReviewedProfile('VOOG', ['equityStyleFactors', 'Secular Growth'], [
    ['assetClasses', 'Equities'],
  ]),
  RSP: makeReviewedProfile('RSP', ['assetClasses', 'Equities'], [
    ['equityStyleFactors', 'Value'],
    ['equityStyleFactors', 'Size'],
  ]),
  CLOX: makeReviewedProfile('CLOX', ['fixedIncomeSectors', 'IG Credit'], [
    ['assetClasses', 'Fixed Income'],
    ['assetClasses', 'Credit'],
    ['fixedIncomeSectors', 'Leveraged Loans'],
  ]),
  DDS: makeReviewedProfile('DDS', ['equitySectors', 'Consumer Discretionary'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Value'],
  ]),
  PTF: makeReviewedProfile('PTF', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Momentum'],
    ['equityStyleFactors', 'Secular Growth'],
  ]),
  // Nasdaq conid 880601785 is Suja Life, Inc.; do not confuse it with the
  // London-listed iShares Japan SRI UCITS share class using the same ticker.
  SUJA: makeReviewedProfile('SUJA', ['equitySectors', 'Consumer Staples'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
  ]),
  BRKR: makeReviewedProfile('BRKR', ['equitySectors', 'Health Care'], [
    ['assetClasses', 'Equities'],
  ]),
  HCA: makeReviewedProfile('HCA', ['equitySectors', 'Health Care'], [
    ['assetClasses', 'Equities'],
  ]),
  ENZL: makeReviewedProfile('ENZL', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Health Care'],
  ]),
  CPER: makeReviewedProfile('CPER', ['assetClasses', 'Commodities']),
  CZR: makeReviewedProfile('CZR', ['equitySectors', 'Consumer Discretionary'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'High Beta'],
    ['equityStyleFactors', 'Cyclical Growth'],
  ]),
  FISV: makeReviewedProfile('FISV', ['equitySectors', 'Financials'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Quality'],
  ]),
  HSY: makeReviewedProfile('HSY', ['equitySectors', 'Consumer Staples'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Defensives'],
    ['equityStyleFactors', 'Low Beta'],
  ]),
  WMT: makeReviewedProfile('WMT', ['equitySectors', 'Consumer Staples'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Defensives'],
    ['equityStyleFactors', 'Quality'],
  ]),
  NOBL: makeReviewedProfile('NOBL', ['equityStyleFactors', 'Dividend Yield'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Quality'],
    ['equityStyleFactors', 'Value'],
  ]),
  EWZ: makeReviewedProfile('EWZ', ['assetClasses', 'Equities'], [
    ['assetClasses', 'Commodities'],
    ['equitySectors', 'Financials'],
  ]),
  DESK: makeReviewedProfile('DESK', ['equitySectors', 'REITS'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Dividend Yield'],
  ]),
  EWY: makeReviewedProfile('EWY', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Tech'],
  ]),
  MEME: makeReviewedProfile('MEME', ['equityStyleFactors', 'High Beta'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Momentum'],
  ]),
  CLOZ: makeReviewedProfile('CLOZ', ['fixedIncomeSectors', 'HY Credit'], [
    ['assetClasses', 'Fixed Income'],
    ['assetClasses', 'Credit'],
    ['fixedIncomeSectors', 'IG Credit'],
    ['fixedIncomeSectors', 'Leveraged Loans'],
  ]),
  DDOG: makeReviewedProfile('DDOG', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  EWH: makeReviewedProfile('EWH', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Financials'],
  ]),
  XLU: makeReviewedProfile('XLU', ['equitySectors', 'Utilities'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Low Beta'],
    ['equityStyleFactors', 'Defensives'],
  ]),
  EIS: makeReviewedProfile('EIS', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Financials'],
    ['equitySectors', 'Tech'],
  ]),
  EWQ: makeReviewedProfile('EWQ', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Industrials'],
  ]),
  XLV: makeReviewedProfile('XLV', ['equitySectors', 'Health Care'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Low Beta'],
    ['equityStyleFactors', 'Defensives'],
  ]),
  XLK: makeReviewedProfile('XLK', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
    ['equityStyleFactors', 'Momentum'],
  ]),
  COLO: makeReviewedProfile('COLO', ['assetClasses', 'Equities'], [
    ['assetClasses', 'Commodities'],
    ['equitySectors', 'Financials'],
  ]),
  VTIP: makeReviewedProfile('VTIP', ['fixedIncomeSectors', 'TIPS'], [
    ['assetClasses', 'Fixed Income'],
    ['fixedIncomeSectors', 'Short Duration Treasurys'],
  ]),
  BUG: makeReviewedProfile('BUG', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
  ]),
  XLE: makeReviewedProfile('XLE', ['equitySectors', 'Energy'], [
    ['assetClasses', 'Equities'],
    ['assetClasses', 'Commodities'],
  ]),
  EWG: makeReviewedProfile('EWG', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Industrials'],
  ]),
  LLY: makeReviewedProfile('LLY', ['equitySectors', 'Health Care'], [
    ['assetClasses', 'Equities'],
  ]),
  VYM: makeReviewedProfile('VYM', ['equityStyleFactors', 'Dividend Yield'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Value'],
  ]),
  UNH: makeReviewedProfile('UNH', ['equitySectors', 'Health Care'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Defensives'],
    ['equityStyleFactors', 'Quality'],
  ]),
  EWUS: makeReviewedProfile('EWUS', ['equityStyleFactors', 'Small Caps'], [
    ['assetClasses', 'Equities'],
  ]),
  INDA: makeReviewedProfile('INDA', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Financials'],
  ]),
  IAK: makeReviewedProfile('IAK', ['equitySectors', 'Financials'], [
    ['assetClasses', 'Equities'],
  ]),
  EPHE: makeReviewedProfile('EPHE', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Industrials'],
  ]),
  XLRE: makeReviewedProfile('XLRE', ['equitySectors', 'REITS'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Dividend Yield'],
  ]),
  IDX: makeReviewedProfile('IDX', ['assetClasses', 'Equities'], [
    ['equitySectors', 'Financials'],
    ['assetClasses', 'Commodities'],
  ]),
  PSKY: makeReviewedProfile('PSKY', ['equitySectors', 'Communication Services'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Value'],
  ]),
  CRWD: makeReviewedProfile('CRWD', ['equitySectors', 'Tech'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
    ['equityStyleFactors', 'High Beta'],
  ]),
  KTB: makeReviewedProfile('KTB', ['equitySectors', 'Consumer Discretionary'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Value'],
    ['equityStyleFactors', 'Dividend Yield'],
  ]),
  EQRR: makeReviewedProfile('EQRR', ['assetClasses', 'Equities'], [
    ['equityStyleFactors', 'Value'],
    ['equityStyleFactors', 'Cyclical Growth'],
  ]),
  // Amplify's industry allocation is predominantly payments/transaction
  // processing and consumer finance; software is a small minority.
  IPAY: makeReviewedProfile('IPAY', ['equitySectors', 'Financials'], [
    ['assetClasses', 'Equities'],
    ['equityStyleFactors', 'Secular Growth'],
  ]),
});

export const CURRENT_BOOK_SECURITY_PROFILES = Object.freeze(Object.fromEntries(
  QUAD_EXPOSURE_REVIEW.flatMap(review => review.symbols.map(symbol => [symbol, Object.freeze({
    ...makeReviewedProfile(symbol, review.primary, review.secondary),
    classificationNote: review.note,
    classificationSources: Object.freeze(review.sources),
    reviewedAt: QUAD_EXPOSURE_REVIEW_DATE,
  })])),
));

const buildSecurityProfiles = () => {
  const profiles = SECURITIES_LIST.reduce((catalog, security) => {
    const symbol = normalizeSymbol(security.ticker);
    catalog[symbol] = profileFromSecurityMapping(security);
    return catalog;
  }, {});

  Object.entries(UNIVERSE_PROFILE_OVERRIDES).forEach(([symbol, profile]) => {
    if (profile) profiles[symbol] = profile;
  });
  Object.assign(profiles, LIVE_BOOK_SECURITY_PROFILES);
  Object.assign(profiles, CURRENT_BOOK_SECURITY_PROFILES);
  return profiles;
};

export const SECURITY_EXPOSURE_PROFILES = Object.freeze(buildSecurityProfiles());
export const SECURITY_PROFILES = SECURITY_EXPOSURE_PROFILES;

// Contract-specific reviews disambiguate ticker collisions without weakening
// the symbol-level review used by the dashboard universe.
export const CONID_SECURITY_PROFILE_OVERRIDES = Object.freeze({
  880601785: LIVE_BOOK_SECURITY_PROFILES.SUJA,
});
export const SECURITY_EXPOSURE_PROFILES_BY_CONID = CONID_SECURITY_PROFILE_OVERRIDES;

export const resolveSecurityExposureProfile = (symbolOrPosition, optionalConid) => {
  const position = typeof symbolOrPosition === 'object' && symbolOrPosition !== null
    ? symbolOrPosition
    : null;
  const symbol = normalizeSymbol(
    position?.symbol
      ?? position?.ticker
      ?? position?.localSymbol
      ?? symbolOrPosition,
  );
  const conid = normalizeConid(
    position?.conid
      ?? position?.conId
      ?? position?.contractId
      ?? optionalConid,
  );

  if (conid && CONID_SECURITY_PROFILE_OVERRIDES[conid]) {
    return CONID_SECURITY_PROFILE_OVERRIDES[conid];
  }
  return SECURITY_EXPOSURE_PROFILES[symbol] || makeUnclassifiedProfile(symbol);
};

export const resolveSecurityProfile = resolveSecurityExposureProfile;

const quadExposureCatalog = {
  EXPOSURE_CLASSIFICATION_VERSION,
  EXPOSURE_DIMENSIONS,
  QUAD_PLAYBOOK,
  EXPOSURE_DEFINITIONS,
  EXPOSURE_LIST,
  HEDGEYE_EXPOSURE_LIST,
  LIVE_BOOK_SECURITY_PROFILES,
  CURRENT_BOOK_SECURITY_PROFILES,
  SECURITY_EXPOSURE_PROFILES,
  CONID_SECURITY_PROFILE_OVERRIDES,
  normalizeQuadKey,
  normalizeQuad,
  getExposureDefinition,
  resolveExposure,
  getExposureQuadFit,
  getExposureFit,
  resolveSecurityExposureProfile,
  resolveSecurityProfile,
};

export default quadExposureCatalog;
