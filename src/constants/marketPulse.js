import marketBackdropCatalog from './marketBackdropCatalog.json';
import marketPulseSupplementalCatalog from './marketPulseSupplementalCatalog.json';
import { USD_METRICS } from './usdMarket';

export const PULSE_ROTATION_MS = 6000;

const normalizeSymbol = (value) => String(value || '').trim().replace(/^#/, '').toUpperCase();
const backdropRows = marketBackdropCatalog.flatMap((group) => group.rows);
const backdropBySymbol = new Map(backdropRows.map((row) => [row.symbol, row]));

// Exposure aliases are used only to prevent duplicates. They do not make an
// ETF quote interchangeable with the index, future, or asset it references.
const exposureAliases = new Map(Object.entries({
  SPY: 'SPX', SP500: 'SPX',
  QQQ: 'NDX', IWM: 'RUT', XLRE: 'VNQ',
  COMPQ: 'IXIC', NIKK: 'N225',
  WTI: 'CL', WTIC: 'CL', NATGAS: 'NG', BRENT: 'BZ',
  GOLD: 'GC', GLD: 'GC', AAAU: 'GC',
  SILVER: 'SI', SLV: 'SI', COPPER: 'HG',
  PLATINUM: 'PL', PPLT: 'PL', PALLADIUM: 'PA', PALL: 'PA',
  RBOB: 'RB', WHEAT: 'ZW', WEAT: 'ZW', CORN: 'ZC', SOYBEANS: 'ZS',
  DXY: 'USD', UUP: 'USD', '$USD': 'USD',
  BITCOIN: 'BTC', IBIT: 'BTC', ETHEREUM: 'ETH', ETHA: 'ETH', SOLANA: 'SOL',
}));

backdropRows.forEach((row) => {
  [row.provider?.yahooSymbol, row.provider?.ibkrSymbol].filter(Boolean).forEach((alias) => {
    exposureAliases.set(normalizeSymbol(alias), row.symbol);
  });
});

const canonicalExposure = (symbol) => {
  const normalized = normalizeSymbol(symbol);
  return exposureAliases.get(normalized) || normalized;
};

const displayedExposures = new Set([
  ...backdropRows.filter((row) => row.summary === true).map((row) => row.symbol),
  ...USD_METRICS.map((metric) => metric.symbol),
  // The Dollar benchmark is the matrix's reference axis, not a USD_METRICS row.
  'USD',
].map(canonicalExposure));

const instrument = (symbol, label, aliases = []) => {
  const row = backdropBySymbol.get(symbol);
  return Object.freeze({
    symbol,
    ticker: symbol,
    label: label || row?.label || symbol,
    aliases: Object.freeze([...new Set([
      ...aliases,
      row?.provider?.yahooSymbol,
      row?.provider?.ibkrSymbol,
    ].filter(Boolean))]),
    ...(row?.unit ? { unit: row.unit } : {}),
  });
};

const category = (id, label, marketKeys, instruments) => Object.freeze({
  id,
  label,
  marketKeys: Object.freeze(marketKeys),
  instruments: Object.freeze(instruments),
});

export const PULSE_CATEGORIES = Object.freeze([
  category('sectors', 'Sectors', ['sectors'], [
    instrument('XLY', 'Consumer discretionary ETF'),
    instrument('XLV', 'Health care ETF'),
    instrument('XLK', 'Technology ETF'),
    instrument('XLP', 'Consumer staples ETF'),
    instrument('XLI', 'Industrials ETF'),
    instrument('XLB', 'Materials ETF'),
    instrument('XLE', 'Energy ETF'),
    instrument('XLU', 'Utilities ETF'),
    instrument('XLC', 'Communication services ETF'),
  ]),
  category('credit', 'Credit & inflation', ['pulse'], marketPulseSupplementalCatalog.map((row) => (
    instrument(row.symbol, row.label, [row.provider?.yahooSymbol].filter(Boolean))
  ))),
  category('commodities', 'Commodity inputs', ['commodities'], [
    instrument('PL', 'Platinum futures', ['PLATINUM']),
    instrument('PA', 'Palladium futures', ['PALLADIUM']),
    instrument('RB', 'Gasoline futures', ['RBOB']),
  ]),
  category('global', 'Global markets', ['asia'], [
    instrument('SSEC', 'Shanghai Composite'),
    instrument('KLSE', 'Malaysia KLCI'),
  ]),
]);

export const resolvePulseInstrument = (row, pulseCategory) => {
  const symbol = normalizeSymbol(row?.symbol || row?.ticker);
  if (!symbol || displayedExposures.has(canonicalExposure(symbol))) return null;

  const candidate = pulseCategory?.instruments?.find((entry) => (
    [entry.symbol, entry.ticker, ...(entry.aliases || [])]
      .some((alias) => normalizeSymbol(alias) === symbol)
  ));
  if (!candidate || displayedExposures.has(canonicalExposure(candidate.symbol))) return null;
  return candidate;
};
